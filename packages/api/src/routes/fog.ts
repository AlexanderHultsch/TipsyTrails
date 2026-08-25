import {
  berlinDateString,
  CONFIG,
  haversineDistanceM,
  isOnSite,
  isVisitComplete,
  isVisitExpired,
  NO_DISTRICT,
  onsiteRadiusM,
  toCell,
} from '@tipsytrails/shared';
import type { GridParams, LatLon } from '@tipsytrails/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/cookie.js';
import { loadActiveCity, toGridParams } from '../city-grid.js';
import { cellsWithinRevealRadius } from '../fog/reveal.js';
import { isBitSet, maskByteLength, setBit } from '../fog/mask.js';
import {
  sendCityNotFound,
  sendGridUnavailable,
  sendInvalidRequestBody,
  sendUnauthenticated,
} from '../http/errors.js';
import { createRateLimiter } from '../http/rate-limit.js';
import type { AcceptedPosition } from '../last-accepted.js';
import {
  bindMasteredUserId,
  DISCOVERED_BAR_COLUMNS,
  toBarSummary,
  type BarSummary,
  type DiscoveredBarRow,
} from './bars.js';
import { toVisitSummary, type VisitSummary } from './visits.js';

// SPEC.md Section 5.5/7.3/7.6/9.2: fog-of-war state (GET /api/fog,
// POST /api/samples) and the progress it derives (GET /api/progress). Kept
// together because all three read and write the same `fog_state` /
// `fog_district_progress` / `fog_daily_progress` triple and share the
// active-city/grid lookups below — one coherent unit, per the phase brief.

interface FogStateRow {
  mask: Buffer;
  revealed_cells: number;
}

/** Reads the existing `fog_state` row, if any — never creates one. */
function readFogRow(
  db: Database.Database,
  userId: number,
  cityId: number,
): { mask: Buffer; revealedCells: number } | null {
  const row = db
    .prepare<[number, number], FogStateRow>(
      'SELECT mask, revealed_cells FROM fog_state WHERE user_id = ? AND city_id = ?',
    )
    .get(userId, cityId);
  if (!row) {
    return null;
  }
  return { mask: Buffer.from(row.mask), revealedCells: row.revealed_cells };
}

/**
 * Reads the `fog_state` row, creating a blank one if it does not exist yet
 * (SPEC.md Section 5.5: "created lazily on first `GET /api/fog` or first
 * accepted sample"). Only `GET /api/fog` calls this — `POST /api/samples`
 * uses `readFogRow` instead and writes only when a bit actually changes, per
 * "a sample batch that reveals nothing must not produce a write."
 */
function ensureFogRow(
  db: Database.Database,
  userId: number,
  cityId: number,
  grid: GridParams,
): { mask: Buffer; revealedCells: number } {
  const existing = readFogRow(db, userId, cityId);
  if (existing) {
    return existing;
  }
  const mask = Buffer.alloc(maskByteLength(grid));
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    'INSERT INTO fog_state (user_id, city_id, mask, revealed_cells, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(userId, cityId, mask, 0, now);
  return { mask, revealedCells: 0 };
}

const sampleSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  accuracy: z.number().nonnegative(),
  // The Geolocation API reports speed in metres/second, or null when
  // unavailable — CONFIG's speed thresholds are km/h (Section 7.1), so this
  // route converts at the point of comparison, never ahead of time.
  speed: z.number().nullable().optional(),
  timestamp: z.number(),
});

const samplesBodySchema = z.object({
  samples: z.array(sampleSchema).max(CONFIG.SAMPLE_MAX_BATCH),
});

interface ActiveBarRow {
  id: number;
  lat: number;
  lon: number;
}

interface PendingVisitRow {
  id: number;
  bar_id: number;
  bar_name: string;
  bar_lat: number;
  bar_lon: number;
  started_at: number;
  last_sample_at: number;
  onsite_samples: number;
  confirmed_s: number;
}

// SPEC.md Section 7.5 steps 3-4: one entry per pending visit this request
// touched, accumulated across the sample loop and written to `visits` (and
// reported in `visitUpdates`) once, after the loop — the same
// accumulate-then-write shape `applyDiscoveries`/`applyReveal` use below.
interface VisitProgress {
  id: number;
  barId: number;
  barName: string;
  bar: LatLon;
  startedAt: number;
  lastSampleAt: number;
  onsiteSamples: number;
  confirmedS: number;
  status: 'pending' | 'completed' | 'expired';
  completedAt: number | null;
  touched: boolean;
}

// SPEC.md Section 7.2's teleport guard, as a speed: the distance from the
// previous accepted sample over the time between the two, in km/h. A batch
// whose timestamps do not advance yields Infinity if it also moved, so a
// zero-time jump is caught by the same threshold as any other.
function impliedSpeedKmh(previous: AcceptedPosition, next: LatLon & { timestamp: number }): number {
  const distanceM = haversineDistanceM(previous, next);
  const dtS = (next.timestamp - previous.atMs) / 1000;
  if (dtS <= 0) {
    return distanceM > 0 ? Infinity : 0;
  }
  return (distanceM / dtS) * 3.6;
}

// The three write steps `POST /api/samples` ends with, and the load its
// visit step starts from. Each is exactly one transaction, and the handler
// decides whether to run it — a batch that discovered nothing, touched no
// visit or revealed no cell opens no transaction at all (SPEC.md Section
// 5.5). The sample loop between the load and the writes stays inline in the
// handler: its accumulators are genuinely intertwined, and reading that part
// in place is the point of it.

// SPEC.md Section 7.5 steps 3-4: the caller's own open pending visits,
// loaded once per request the same way `activeBars` is. Keyed by bar id,
// since `idx_visits_one_pending` allows at most one pending visit per
// (user, bar).
function loadPendingVisitProgress(
  db: Database.Database,
  userId: number,
): Map<number, VisitProgress> {
  const rows = db
    .prepare<[number], PendingVisitRow>(
      `SELECT visits.id AS id, visits.bar_id AS bar_id, bars.name AS bar_name,
              bars.lat AS bar_lat, bars.lon AS bar_lon,
              visits.started_at AS started_at, visits.last_sample_at AS last_sample_at,
              visits.onsite_samples AS onsite_samples, visits.confirmed_s AS confirmed_s
       FROM visits
       JOIN bars ON bars.id = visits.bar_id
       WHERE visits.user_id = ? AND visits.status = 'pending'`,
    )
    .all(userId);
  return new Map<number, VisitProgress>(
    rows.map((row) => [
      row.bar_id,
      {
        id: row.id,
        barId: row.bar_id,
        barName: row.bar_name,
        bar: { lat: row.bar_lat, lon: row.bar_lon },
        startedAt: row.started_at,
        lastSampleAt: row.last_sample_at,
        onsiteSamples: row.onsite_samples,
        confirmedS: row.confirmed_s,
        status: 'pending',
        completedAt: null,
        touched: false,
      },
    ]),
  );
}

// SPEC.md Section 7.4: discovery is permanent and independent of fog state,
// so this runs (and is returned) whether or not the batch revealed any fog
// at all — never gated behind `revealCandidates`. The caller gates only on
// there being a candidate at all, so a batch that passed no bar opens no
// transaction.
function applyDiscoveries(
  db: Database.Database,
  userId: number,
  candidateBarIds: ReadonlySet<number>,
  nowS: number,
): BarSummary[] {
  return db.transaction((): BarSummary[] => {
    const insertDiscovery = db.prepare(
      'INSERT OR IGNORE INTO bar_discoveries (user_id, bar_id, discovered_at) VALUES (?, ?, ?)',
    );
    const newlyDiscoveredIds: number[] = [];
    for (const barId of candidateBarIds) {
      const result = insertDiscovery.run(userId, barId, nowS);
      if (result.changes > 0) {
        newlyDiscoveredIds.push(barId);
      }
    }
    if (newlyDiscoveredIds.length === 0) {
      return [];
    }
    const placeholders = newlyDiscoveredIds.map(() => '?').join(', ');
    // routes/bars.ts's own column list, not a second copy of it — the same
    // reason `toBarSummary` is shared: `newBars` is one of the three
    // surfaces a `bars` row reaches the client through (SPEC.md Section
    // 9.2), and a field selected in two of them and forgotten in the third
    // is exactly the drift that sharing prevents. Section 5.7's `mastered`
    // rides along with it. It binds by name, so the anonymous parameters
    // below are unaffected by it and stay the id list followed by the user
    // id.
    //
    // A bar in this list was discovered by the INSERT a few lines up, so in
    // practice it cannot be mastered yet — a completed visit needs a
    // check-in, and a check-in needs the bar to be discovered. The flag is
    // still selected rather than assumed: `newBars` is a `Bar` like the
    // other two surfaces' and has to answer the same way they would, and an
    // assumption here is one more thing that could come to disagree with
    // them.
    const rows = db
      .prepare<unknown[], DiscoveredBarRow>(
        `SELECT ${DISCOVERED_BAR_COLUMNS}
         FROM bars
         JOIN bar_discoveries ON bar_discoveries.bar_id = bars.id
         WHERE bars.id IN (${placeholders}) AND bar_discoveries.user_id = ?`,
      )
      .all(...newlyDiscoveredIds, userId, bindMasteredUserId(userId));
    return rows.map(toBarSummary);
  })();
}

// SPEC.md Section 7.5 steps 3-4: persists every pending visit the batch
// touched — updated, completed, or (a late sample on an already-stale
// visit) expired — in one transaction. A visit that expires here is written
// but, like `GET /api/visits/pending`'s own lazily-expired rows, not
// reported back as a "visit update".
function applyVisitUpdates(
  db: Database.Database,
  visitProgressByBarId: ReadonlyMap<number, VisitProgress>,
): VisitSummary[] {
  return db.transaction((): VisitSummary[] => {
    const updates: VisitSummary[] = [];
    for (const visit of visitProgressByBarId.values()) {
      if (!visit.touched) {
        continue;
      }
      if (visit.status === 'expired') {
        db.prepare(`UPDATE visits SET status = 'expired' WHERE id = ?`).run(visit.id);
        continue;
      }
      db.prepare(
        `UPDATE visits SET last_sample_at = ?, onsite_samples = ?, confirmed_s = ?, status = ?, completed_at = ?
         WHERE id = ?`,
      ).run(
        visit.lastSampleAt,
        visit.onsiteSamples,
        visit.confirmedS,
        visit.status,
        visit.completedAt,
        visit.id,
      );
      updates.push(
        toVisitSummary({
          id: visit.id,
          bar_id: visit.barId,
          bar_name: visit.barName,
          started_at: visit.startedAt,
          last_sample_at: visit.lastSampleAt,
          onsite_samples: visit.onsiteSamples,
          confirmed_s: visit.confirmedS,
          status: visit.status,
        }),
      );
    }
    return updates;
  })();
}

// SPEC.md Section 5.5: sets the bits the batch earned and updates the three
// counters that hang off them (`fog_state`, `fog_district_progress`,
// `fog_daily_progress`) in one transaction, returning how many cells were
// actually new.
//
// The parameter list is wide because the work needs all of it: the district
// grid and its id lookup are two separate server-instance fields, and the
// mask's length comes from the grid params while its row comes from the city
// id. Passed rather than closed over, so the one place fog bits are written
// states what it depends on.
function applyReveal(
  db: Database.Database,
  userId: number,
  cityId: number,
  grid: GridParams,
  districtGrid: Uint16Array,
  districtIdByGridIndex: Map<number, number>,
  revealCandidates: ReadonlySet<number>,
  nowMs: number,
): number {
  return db.transaction((): number => {
    const existing = readFogRow(db, userId, cityId);
    const mask = existing ? existing.mask : Buffer.alloc(maskByteLength(grid));
    const baselineRevealed = existing ? existing.revealedCells : 0;

    let newCellsCount = 0;
    const perDistrictIncrements = new Map<number, number>();

    for (const index of revealCandidates) {
      if (isBitSet(mask, index)) {
        continue;
      }
      setBit(mask, index);
      newCellsCount++;

      const districtIndex = districtGrid[index];
      if (districtIndex !== NO_DISTRICT) {
        const districtId = districtIdByGridIndex.get(districtIndex);
        if (districtId != null) {
          perDistrictIncrements.set(districtId, (perDistrictIncrements.get(districtId) ?? 0) + 1);
        }
      }
    }

    // "A batch that reveals nothing must not write at all" (SPEC.md Section
    // 5.5) — including the case where every candidate cell was already
    // revealed.
    if (newCellsCount === 0) {
      return 0;
    }

    const nowS = Math.floor(nowMs / 1000);
    db.prepare(
      `INSERT INTO fog_state (user_id, city_id, mask, revealed_cells, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, city_id) DO UPDATE SET
         mask = excluded.mask,
         revealed_cells = excluded.revealed_cells,
         updated_at = excluded.updated_at`,
    ).run(userId, cityId, mask, baselineRevealed + newCellsCount, nowS);

    const upsertDistrict = db.prepare(
      `INSERT INTO fog_district_progress (user_id, district_id, revealed_cells)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, district_id) DO UPDATE SET
         revealed_cells = revealed_cells + excluded.revealed_cells`,
    );
    for (const [districtId, increment] of perDistrictIncrements) {
      upsertDistrict.run(userId, districtId, increment);
    }

    const day = berlinDateString(nowMs);
    db.prepare(
      `INSERT INTO fog_daily_progress (user_id, city_id, day, revealed_cells)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, city_id, day) DO UPDATE SET
         revealed_cells = revealed_cells + excluded.revealed_cells`,
    ).run(userId, cityId, day, newCellsCount);

    return newCellsCount;
  })();
}

// SPEC.md Section 7.2's teleport guard and Section 10.2's data-minimisation
// rule: "the previous accepted position lives in memory only ... discarded
// on restart." A plain in-memory Map, created once per `buildApp` call (a
// restart is a fresh process and a fresh Map) and passed in rather than
// created here, so routes/visits.ts can share the exact same instance
// instead of a second one that would never see fog.ts's writes.
export function fogRoutes(lastAccepted: Map<number, AcceptedPosition>) {
  return async function fogRoutesPlugin(app: FastifyInstance): Promise<void> {
    const samplesRateLimit = createRateLimiter('samples');

    app.get('/api/fog', { preHandler: requireAuth }, async (request, reply) => {
      if (request.userId == null) {
        sendUnauthenticated(reply);
        return;
      }

      const db = request.server.db;
      const city = loadActiveCity(db);
      if (!city) {
        sendCityNotFound(reply);
        return;
      }

      const grid = toGridParams(city);
      const userId = request.userId;
      const fog = db.transaction(() => ensureFogRow(db, userId, city.id, grid))();

      const districts = db
        .prepare<[number, number], { id: number; revealed_cells: number }>(
          `SELECT districts.id AS id, COALESCE(fog_district_progress.revealed_cells, 0) AS revealed_cells
         FROM districts
         LEFT JOIN fog_district_progress
           ON fog_district_progress.district_id = districts.id
          AND fog_district_progress.user_id = ?
         WHERE districts.city_id = ?
         ORDER BY districts.id`,
        )
        .all(userId, city.id);

      // Section 9.2: the mask is application/octet-stream and nothing else is
      // mixed into that body (transport encoding is the proxy's job, not
      // ours). The per-district counts this endpoint also has to return
      // (Section 9.2) travel in a response header instead, so the body stays
      // exactly the raw mask.
      reply.header('Content-Type', 'application/octet-stream');
      reply.header(
        'X-Fog-Progress',
        JSON.stringify({
          revealedCells: fog.revealedCells,
          playableCells: city.playable_cells,
          districts: districts.map((d) => ({ id: d.id, revealedCells: d.revealed_cells })),
        }),
      );
      reply.send(fog.mask);
    });

    app.post(
      '/api/samples',
      { preHandler: [requireAuth, samplesRateLimit] },
      async (request, reply) => {
        if (request.userId == null) {
          sendUnauthenticated(reply);
          return;
        }

        const parsed = samplesBodySchema.safeParse(request.body);
        if (!parsed.success) {
          sendInvalidRequestBody(reply);
          return;
        }

        const db = request.server.db;
        const city = loadActiveCity(db);
        if (!city) {
          sendCityNotFound(reply);
          return;
        }
        if (!request.server.grid || !request.server.districtIdByGridIndex) {
          sendGridUnavailable(reply);
          return;
        }
        const districtGrid = request.server.grid;
        const districtIdByGridIndex = request.server.districtIdByGridIndex;

        const grid = toGridParams(city);
        const userId = request.userId;
        const nowMs = Date.now();
        const nowS = Math.floor(nowMs / 1000);

        // "Ordering within a batch is by client timestamp" (Section 7.2 step 2).
        const sorted = [...parsed.data.samples].sort((a, b) => a.timestamp - b.timestamp);

        let previous = lastAccepted.get(userId) ?? null;
        const revealCandidates = new Set<number>();

        // SPEC.md Section 7.3, "what the player is told": whether the sample
        // that ends this batch was refused a reveal because of its speed.
        //
        // The last accepted sample decides, and that is the whole rule for a
        // mixed batch. The client renders this as a present-tense banner, and
        // the last accepted sample is the most recent thing known about where
        // the player is now — a batch that starts on a moving train and ends
        // on the platform reports `false`, because by the end of it the
        // player was walking. `false` for a batch with no accepted samples at
        // all, for the same reason: nothing in it was refused for speed, and
        // a banner is not entitled to assert a speed no sample established.
        //
        // Deliberately server-side and not derived from `position.speed` in
        // the browser: the rule that decides is this one, including the case
        // the client cannot reproduce — a sample carrying no speed, where the
        // server derives it from the previous accepted sample, which the
        // client does not keep.
        let tooFastToReveal = false;

        // SPEC.md Section 7.4: discovery is checked against every accepted
        // sample, independent of the reveal-speed gate below — a sample too
        // fast to reveal fog still discovers a bar it passes. Loaded once per
        // request rather than per sample; a city's active bar count is small
        // enough that this beats a spatial query per sample.
        const activeBars = db
          .prepare<[number], ActiveBarRow>(
            `SELECT id, lat, lon FROM bars WHERE city_id = ? AND status = 'active'`,
          )
          .all(city.id);
        const discoveryCandidateIds = new Set<number>();

        const visitProgressByBarId = loadPendingVisitProgress(db, userId);

        for (const sample of sorted) {
          // 1. accuracy
          if (sample.accuracy > CONFIG.FOG_MAX_ACCURACY_M) {
            continue;
          }
          // 2. clock skew / staleness, against server time
          const skewMs = sample.timestamp - nowMs;
          if (skewMs > CONFIG.SAMPLE_MAX_CLOCK_SKEW_MS) {
            continue;
          }
          if (nowMs - sample.timestamp > CONFIG.SAMPLE_MAX_AGE_MS) {
            continue;
          }
          // 3. inside the active city's bounding box (Section 5.1: the box is
          // derived from origin/grid/cell_size via toCell, never stored).
          if (toCell(sample.lat, sample.lon, grid) === null) {
            continue;
          }
          // 4. teleport guard against the previous accepted sample
          let derivedSpeedKmh: number | null = null;
          if (previous) {
            derivedSpeedKmh = impliedSpeedKmh(previous, sample);
            if (derivedSpeedKmh > CONFIG.SAMPLE_TELEPORT_SPEED_KMH) {
              continue;
            }
          }

          // 5. accepted.
          previous = { lat: sample.lat, lon: sample.lon, atMs: sample.timestamp };

          for (const bar of activeBars) {
            if (haversineDistanceM(sample, bar) <= CONFIG.BAR_DISCOVERY_RADIUS_M) {
              discoveryCandidateIds.add(bar.id);
            }
          }

          // SPEC.md Section 7.5 steps 3-4: like discovery above, and unlike
          // the reveal-speed gate below, this runs for every accepted sample
          // regardless of speed — someone standing still at a bar produces
          // samples with no meaningful speed. The radius uses this sample's
          // own accuracy (`onsiteRadiusM`), not `LAST_ACCEPTED_ONSITE_RADIUS_M`
          // (routes/visits.ts's separate, no-accuracy case).
          const sampleOnsiteRadiusM = onsiteRadiusM(sample.accuracy);
          for (const visit of visitProgressByBarId.values()) {
            if (visit.status !== 'pending') {
              continue;
            }
            if (!isOnSite(sample, visit.bar, sampleOnsiteRadiusM)) {
              continue;
            }
            if (isVisitExpired(nowS, visit.lastSampleAt)) {
              visit.status = 'expired';
              visit.touched = true;
              continue;
            }
            visit.onsiteSamples += 1;
            visit.lastSampleAt = nowS;
            visit.confirmedS = nowS - visit.startedAt;
            visit.touched = true;
            if (isVisitComplete(visit.confirmedS, visit.onsiteSamples)) {
              visit.status = 'completed';
              visit.completedAt = nowS;
            }
          }

          // Reveal speed: from the sample where present (Geolocation API
          // speed is m/s), otherwise derived from the previous accepted
          // sample; neither available -> the sample reveals (Section 7.3).
          //
          // One expression drives both the reveal and what the client is
          // told, so the banner cannot come to disagree with the rule it is
          // reporting on — that disagreement is exactly what a second,
          // client-side copy of this test would have introduced.
          const revealSpeedKmh = sample.speed != null ? sample.speed * 3.6 : derivedSpeedKmh;
          tooFastToReveal = revealSpeedKmh !== null && revealSpeedKmh >= CONFIG.FOG_MAX_SPEED_KMH;
          if (!tooFastToReveal) {
            for (const index of cellsWithinRevealRadius(sample, grid)) {
              revealCandidates.add(index);
            }
          }
        }

        if (previous) {
          lastAccepted.set(userId, previous);
        }

        const newBars =
          discoveryCandidateIds.size > 0
            ? applyDiscoveries(db, userId, discoveryCandidateIds, nowS)
            : [];

        const anyVisitTouched = Array.from(visitProgressByBarId.values()).some((v) => v.touched);
        const visitUpdates = anyVisitTouched ? applyVisitUpdates(db, visitProgressByBarId) : [];

        if (revealCandidates.size === 0) {
          return { newCells: 0, newBars, visitUpdates, tooFastToReveal };
        }

        const newCells = applyReveal(
          db,
          userId,
          city.id,
          grid,
          districtGrid,
          districtIdByGridIndex,
          revealCandidates,
          nowMs,
        );
        return { newCells, newBars, visitUpdates, tooFastToReveal };
      },
    );

    app.get('/api/progress', { preHandler: requireAuth }, async (request, reply) => {
      if (request.userId == null) {
        sendUnauthenticated(reply);
        return;
      }

      const db = request.server.db;
      const city = loadActiveCity(db);
      if (!city) {
        sendCityNotFound(reply);
        return;
      }

      const userId = request.userId;
      const fogRow = db
        .prepare<[number, number], { revealed_cells: number }>(
          'SELECT revealed_cells FROM fog_state WHERE user_id = ? AND city_id = ?',
        )
        .get(userId, city.id);
      const cityRevealedCells = fogRow?.revealed_cells ?? 0;

      const districts = db
        .prepare<
          [number, number],
          { id: number; name: string; playable_cells: number; revealed_cells: number }
        >(
          `SELECT districts.id AS id, districts.name AS name, districts.playable_cells AS playable_cells,
                COALESCE(fog_district_progress.revealed_cells, 0) AS revealed_cells
         FROM districts
         LEFT JOIN fog_district_progress
           ON fog_district_progress.district_id = districts.id
          AND fog_district_progress.user_id = ?
         WHERE districts.city_id = ?
         ORDER BY districts.id`,
        )
        .all(userId, city.id);

      return {
        city: {
          revealedCells: cityRevealedCells,
          playableCells: city.playable_cells,
          percent: city.playable_cells > 0 ? (cityRevealedCells / city.playable_cells) * 100 : 0,
        },
        districts: districts.map((district) => ({
          id: district.id,
          name: district.name,
          revealedCells: district.revealed_cells,
          playableCells: district.playable_cells,
          percent:
            district.playable_cells > 0
              ? (district.revealed_cells / district.playable_cells) * 100
              : 0,
        })),
        // Section 7.6 also defines "bars mastered" here; mastering depends on
        // visits (Phase 5), not built yet, so the field is omitted rather
        // than sent as a fabricated zero.
      };
    });
  };
}
