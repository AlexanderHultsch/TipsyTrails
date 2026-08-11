import {
  berlinDateString,
  CONFIG,
  haversineDistanceM,
  NO_DISTRICT,
  toCell,
} from '@tipsytrails/shared';
import type { GridParams, LatLon } from '@tipsytrails/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/cookie.js';
import { cellsWithinRevealRadius } from '../fog/reveal.js';
import { isBitSet, maskByteLength, setBit } from '../fog/mask.js';
import { createRateLimiter } from '../http/rate-limit.js';
import { toBarSummary, type BarSummary, type DiscoveredBarRow } from './bars.js';

// SPEC.md Section 5.5/7.3/7.6/9.2: fog-of-war state (GET /api/fog,
// POST /api/samples) and the progress it derives (GET /api/progress). Kept
// together because all three read and write the same `fog_state` /
// `fog_district_progress` / `fog_daily_progress` triple and share the
// active-city/grid lookups below — one coherent unit, per the phase brief.

interface CityRow {
  id: number;
  origin_lat: number;
  origin_lon: number;
  grid_width: number;
  grid_height: number;
  cell_size_m: number;
  playable_cells: number;
}

function loadActiveCity(db: Database.Database): CityRow | null {
  return (
    db
      .prepare<[], CityRow>(
        `SELECT id, origin_lat, origin_lon, grid_width, grid_height, cell_size_m, playable_cells FROM cities WHERE is_active = 1 LIMIT 1`,
      )
      .get() ?? null
  );
}

function toGridParams(city: CityRow): GridParams {
  return {
    origin_lat: city.origin_lat,
    origin_lon: city.origin_lon,
    grid_width: city.grid_width,
    grid_height: city.grid_height,
    cell_size_m: city.cell_size_m,
  };
}

function sendUnauthenticated(reply: FastifyReply): void {
  reply.code(401).send({ code: 'unauthenticated', message: 'Authentication required.' });
}

function sendInvalidRequest(reply: FastifyReply): void {
  reply.code(400).send({ code: 'invalid_request', message: 'The request body is invalid.' });
}

function sendCityNotFound(reply: FastifyReply): void {
  reply.code(404).send({ code: 'city_not_found', message: 'No active city is configured.' });
}

function sendGridUnavailable(reply: FastifyReply): void {
  reply.code(503).send({
    code: 'grid_unavailable',
    message: 'The district grid is not loaded on this server.',
  });
}

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

// Exported so routes/visits.ts (Phase 5 step 1, Section 7.5 step 2) can read
// the same last-accepted-sample state this teleport guard maintains,
// without a second copy of it — Section 10.2 forbids persisting positions,
// so there must be exactly one instance of this map per running server.
export interface AcceptedPosition extends LatLon {
  atMs: number;
}

interface ActiveBarRow {
  id: number;
  lat: number;
  lon: number;
}

// SPEC.md Section 7.2's teleport guard and Section 10.2's data-minimisation
// rule: "the previous accepted position lives in memory only ... discarded
// on restart." A plain in-memory Map, recreated every time this plugin is
// registered (i.e. every `buildApp` call, exactly once per process — a
// restart is a fresh process and a fresh Map), never written to the
// database.
function impliedSpeedKmh(previous: AcceptedPosition, next: LatLon & { timestamp: number }): number {
  const distanceM = haversineDistanceM(previous, next);
  const dtS = (next.timestamp - previous.atMs) / 1000;
  if (dtS <= 0) {
    return distanceM > 0 ? Infinity : 0;
  }
  return (distanceM / dtS) * 3.6;
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
          sendInvalidRequest(reply);
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

        // "Ordering within a batch is by client timestamp" (Section 7.2 step 2).
        const sorted = [...parsed.data.samples].sort((a, b) => a.timestamp - b.timestamp);

        let previous = lastAccepted.get(userId) ?? null;
        const revealCandidates = new Set<number>();

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

          // Reveal speed: from the sample where present (Geolocation API
          // speed is m/s), otherwise derived from the previous accepted
          // sample; neither available -> the sample reveals (Section 7.3).
          const revealSpeedKmh = sample.speed != null ? sample.speed * 3.6 : derivedSpeedKmh;
          if (revealSpeedKmh === null || revealSpeedKmh < CONFIG.FOG_MAX_SPEED_KMH) {
            for (const index of cellsWithinRevealRadius(sample, grid)) {
              revealCandidates.add(index);
            }
          }
        }

        if (previous) {
          lastAccepted.set(userId, previous);
        }

        // SPEC.md Section 7.4: discovery is permanent and independent of fog
        // state, so it runs (and is returned) whether or not this batch
        // revealed any fog at all — never gated behind `revealCandidates`.
        const applyDiscoveries = db.transaction((): BarSummary[] => {
          const insertDiscovery = db.prepare(
            'INSERT OR IGNORE INTO bar_discoveries (user_id, bar_id, discovered_at) VALUES (?, ?, ?)',
          );
          const nowS = Math.floor(nowMs / 1000);
          const newlyDiscoveredIds: number[] = [];
          for (const barId of discoveryCandidateIds) {
            const result = insertDiscovery.run(userId, barId, nowS);
            if (result.changes > 0) {
              newlyDiscoveredIds.push(barId);
            }
          }
          if (newlyDiscoveredIds.length === 0) {
            return [];
          }
          const placeholders = newlyDiscoveredIds.map(() => '?').join(', ');
          const rows = db
            .prepare<unknown[], DiscoveredBarRow>(
              `SELECT bars.id AS id, bars.district_id AS district_id, bars.name AS name,
                    bars.address AS address, bars.lat AS lat, bars.lon AS lon, bars.source AS source,
                    bar_discoveries.discovered_at AS discovered_at
             FROM bars
             JOIN bar_discoveries ON bar_discoveries.bar_id = bars.id
             WHERE bars.id IN (${placeholders}) AND bar_discoveries.user_id = ?`,
            )
            .all(...newlyDiscoveredIds, userId);
          return rows.map(toBarSummary);
        });
        const newBars = discoveryCandidateIds.size > 0 ? applyDiscoveries() : [];

        if (revealCandidates.size === 0) {
          return { newCells: 0, newBars };
        }

        const applyReveal = db.transaction((): number => {
          const existing = readFogRow(db, userId, city.id);
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
                perDistrictIncrements.set(
                  districtId,
                  (perDistrictIncrements.get(districtId) ?? 0) + 1,
                );
              }
            }
          }

          // "A batch that reveals nothing must not write at all" (SPEC.md
          // Section 5.5) — including the case where every candidate cell was
          // already revealed.
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
          ).run(userId, city.id, mask, baselineRevealed + newCellsCount, nowS);

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
          ).run(userId, city.id, day, newCellsCount);

          return newCellsCount;
        });

        const newCells = applyReveal();
        // Section 9.2's full shape is { newCells, newBars, visitUpdates };
        // visitUpdates (Phase 5) is not built yet and is deliberately omitted
        // rather than sent as a fabricated value.
        return { newCells, newBars };
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
