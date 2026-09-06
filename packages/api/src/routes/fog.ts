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
import { loadActiveCity, toGridParams, type CityRow } from '../city-grid.js';
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
  MASTERED_BAR_CONDITION,
  toBarSummary,
  type BarSummary,
  type DiscoveredBarRow,
  type MasteredUserIdBinding,
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

// SPEC.md Section 7.5 steps 3-5: one entry per pending visit this request
// touched, accumulated across the sample loop and the expiry sweep that
// follows it, and written to `visits` (and reported in `visitUpdates`) once,
// after both — the same accumulate-then-write shape
// `applyDiscoveries`/`applyReveal` use below.
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

// SPEC.md Section 7.5 steps 3-5: persists every pending visit the batch
// touched — updated, completed, or expired (by the sweep in
// `processSampleBatch`, or by a late sample on an already-stale visit) — in
// one transaction, and reports every one of them back as a "visit update".
//
// An expiry is reported like the other two, and this is the half of Open
// Item O14 (closed in v1.51) that the sweep alone does not answer. It used
// to be written and deliberately kept back, by analogy with the
// lazily-expired rows of `GET /api/visits/pending`, and that analogy was
// wrong: that endpoint answers with the pending list itself, so a visit it
// expires is already absent from its answer and the client learns of it by
// that absence. This response is a list of *changes*, where absence means
// "nothing happened to it" — so silence about an expiry left the banner
// asserting a visit the server had just ended, which is the state Section
// 7.5 says it must never be able to hold. An expired row is still the
// caller's own visit and carries no field the other two do not (Section
// 10.2).
//
// The expiry UPDATE stays narrow — only `status` — because nothing else
// about the row changed: `last_sample_at`, `onsite_samples` and
// `confirmed_s` are the record of what actually happened, and the summary
// reports them exactly as they stand.
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
      } else {
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
      }
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

/** One position sample, exactly as `sampleSchema` above accepts it. */
export type SampleInput = z.infer<typeof sampleSchema>;

/**
 * SPEC.md Section 9.6 and `ios/SPEC.md` 9.1: one count per gate of Section
 * 7.2, in that section's order and naming, for the samples of THIS REQUEST
 * only. A batch of sixty in which fifty-eight were accepted answers with
 * counts summing to two.
 *
 * Section 7.2's second gate is two tests and therefore two counts. A sample
 * dated too far ahead of the server (`future`) and one dated too far behind
 * it (`stale`) are refused by neighbouring `if`s for opposite reasons, and
 * a client that could not tell them apart could not tell a phone whose
 * clock is wrong from a phone whose network is: exactly the distinction the
 * counts exist to make (`ios/SPEC.md` 13.2 scenario 3 reads `stale` alone).
 *
 * Nothing is stored. These are computed in the loop that already decides
 * each sample's fate and are gone with the request, which is why they are
 * on the result and not in a table: they describe one batch, and the caller
 * is the only party that knows which samples it sent.
 */
export interface RejectedSampleCounts {
  accuracy: number;
  future: number;
  stale: number;
  outsideCity: number;
  tooFast: number;
}

/** What a processed batch produces — `POST /api/samples`'s response body. */
export interface SampleBatchResult {
  newCells: number;
  newBars: BarSummary[];
  visitUpdates: VisitSummary[];
  tooFastToReveal: boolean;
  rejected: RejectedSampleCounts;
}

export interface SampleBatchInput {
  db: Database.Database;
  userId: number;
  city: CityRow;
  districtGrid: Uint16Array;
  districtIdByGridIndex: Map<number, number>;
  // The one shared `lastAccepted` map (app.ts). Written by this function,
  // read here and by routes/visits.ts's check-in proximity test.
  lastAccepted: Map<number, AcceptedPosition>;
  samples: SampleInput[];
  nowMs: number;
  // SPEC.md Section 7.2's teleport guard and Section 7.3's reveal-speed
  // gate, both off for this batch.
  //
  // This is a parameter of the FUNCTION and never a field of a sample, and
  // that distinction is the whole security design of the admin teleport
  // (routes/admin-teleport.ts). A check the caller can switch off is not a
  // check: if this rode in on the request body, every guard on the public
  // path would depend on what the request asked for. `POST /api/samples`
  // below therefore passes `false` as a literal, with nothing between the
  // request and this field, and the only caller that passes `true` is a
  // route the server admits on the strength of the session alone.
  skipSpeedGuards: boolean;
}

// SPEC.md Section 7.2's per-sample gates and Sections 7.3/7.4/7.5's three
// write steps, as one function rather than as the body of one handler,
// because two routes now have to run all of it: `POST /api/samples` below
// and the admin teleport (routes/admin-teleport.ts). A second copy of this
// loop would be a second place for Section 7.5's rules to drift, which is
// the thing this module has been careful about since the visit steps were
// written — the same reason `toVisitSummary` and `DISCOVERED_BAR_COLUMNS`
// are imported from the routes that own them rather than restated here.
//
// `skipSpeedGuards` is the ONLY difference between the two callers. Every
// other gate — accuracy, clock skew, staleness, the bounding box — applies
// to both, and so does every write. The teleport does not get a cheaper
// pipeline; it gets the same one with two speed tests turned off.
//
// The loop's accumulators are genuinely intertwined, which is why it stays
// one function rather than four: `previous` feeds the next iteration's
// guard, the discovery set and the visit map are built across iterations,
// and the reveal candidates are the union over the accepted samples.
export function processSampleBatch(input: SampleBatchInput): SampleBatchResult {
  const {
    db,
    userId,
    city,
    districtGrid,
    districtIdByGridIndex,
    lastAccepted,
    samples,
    nowMs,
    skipSpeedGuards,
  } = input;

  const grid = toGridParams(city);
  const nowS = Math.floor(nowMs / 1000);

  // "Ordering within a batch is by client timestamp" (Section 7.2 step 2).
  const sorted = [...samples].sort((a, b) => a.timestamp - b.timestamp);

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
  // `false` for a teleport batch too, and for that same reason once more:
  // with the gate off, nothing was refused.
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

  // SPEC.md Section 9.6's `rejected`. One counter per `continue` below, and
  // that is the whole implementation: a count incremented anywhere but on
  // the branch that refuses the sample would be a second reading of a rule
  // this loop already applies, free to disagree with it — the mistake
  // `tooFastToReveal` above is written the way it is to avoid.
  const rejected: RejectedSampleCounts = {
    accuracy: 0,
    future: 0,
    stale: 0,
    outsideCity: 0,
    tooFast: 0,
  };

  for (const sample of sorted) {
    // 1. accuracy
    if (sample.accuracy > CONFIG.FOG_MAX_ACCURACY_M) {
      rejected.accuracy += 1;
      continue;
    }
    // 2. clock skew / staleness, against server time
    const skewMs = sample.timestamp - nowMs;
    if (skewMs > CONFIG.SAMPLE_MAX_CLOCK_SKEW_MS) {
      rejected.future += 1;
      continue;
    }
    if (nowMs - sample.timestamp > CONFIG.SAMPLE_MAX_AGE_MS) {
      rejected.stale += 1;
      continue;
    }
    // 3. inside the active city's bounding box (Section 5.1: the box is
    // derived from origin/grid/cell_size via toCell, never stored). Not
    // skippable by anything: a teleport outside the box would land on
    // ground that has no fog grid, no cells and no districts, so there is
    // nothing there to test against and nothing to write.
    if (toCell(sample.lat, sample.lon, grid) === null) {
      rejected.outsideCity += 1;
      continue;
    }
    // 4. teleport guard against the previous accepted sample
    let derivedSpeedKmh: number | null = null;
    if (previous) {
      derivedSpeedKmh = impliedSpeedKmh(previous, sample);
      if (!skipSpeedGuards && derivedSpeedKmh > CONFIG.SAMPLE_TELEPORT_SPEED_KMH) {
        rejected.tooFast += 1;
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
    tooFastToReveal =
      !skipSpeedGuards && revealSpeedKmh !== null && revealSpeedKmh >= CONFIG.FOG_MAX_SPEED_KMH;
    if (!tooFastToReveal) {
      for (const index of cellsWithinRevealRadius(sample, grid)) {
        revealCandidates.add(index);
      }
    }
  }

  // SPEC.md Section 7.2/10.2: what the NEXT sample is compared against.
  // A teleport writes here exactly like a walk does, and has to: leaving
  // the pre-teleport position in place would make the admin's next genuine
  // sample look like a 300 km/h jump from it and be refused by the guard
  // at step 4 — the feature would break the ordinary sampling that is the
  // whole point of testing with it. Clearing the entry instead would break
  // check-in, which reads this map and answers `no_recent_sample` when it
  // is empty (routes/visits.ts).
  if (previous) {
    lastAccepted.set(userId, previous);
  }

  const newBars =
    discoveryCandidateIds.size > 0 ? applyDiscoveries(db, userId, discoveryCandidateIds, nowS) : [];

  // SPEC.md Section 7.5 step 5: every pending visit the caller has is judged
  // for expiry once per request, whether or not a sample in this batch came
  // near its bar. The test inside the loop above is reachable only through
  // the on-site branch, so a visit the player has walked away from — the one
  // case step 5 exists for — was never examined at all, and a client whose
  // screen stayed visible went on showing it in the banner for as long as
  // the app was open.
  //
  // After the loop and not inside it: `loadPendingVisitProgress` already
  // holds every open pending visit, so this is a pass over values and not a
  // query, but a pass per sample would repeat it up to `SAMPLE_MAX_BATCH`
  // times for an answer that cannot change between samples — `nowS` is one
  // value for the whole request. It runs for a batch in which every sample
  // was rejected too, deliberately: it reads nothing from any sample, and a
  // player standing still with a poor fix (whose samples fail the accuracy
  // gate) is exactly the player whose visit is quietly running out.
  //
  // The clock is `nowS`, the server's, which is the clock this function
  // already keeps visits on: the in-loop test is `isVisitExpired(nowS, ...)`
  // and `lastSampleAt` is written from `nowS`, so both sides of the
  // comparison come from the same source. A client timestamp would put a
  // value Section 7.2 treats as adversarial input on one side of it and a
  // stored server second on the other, and the batch's newest accepted
  // timestamp additionally does not exist for a batch that accepted nothing.
  //
  // The in-loop test is not made redundant by this one and stays where it
  // is: it is what stops a late on-site sample extending a visit that was
  // already stale when the batch arrived, which this sweep could not catch
  // afterwards because `lastSampleAt` would by then be `nowS`.
  for (const visit of visitProgressByBarId.values()) {
    if (visit.status !== 'pending') {
      continue;
    }
    if (isVisitExpired(nowS, visit.lastSampleAt)) {
      visit.status = 'expired';
      visit.touched = true;
    }
  }

  const anyVisitTouched = Array.from(visitProgressByBarId.values()).some((v) => v.touched);
  const visitUpdates = anyVisitTouched ? applyVisitUpdates(db, visitProgressByBarId) : [];

  if (revealCandidates.size === 0) {
    return { newCells: 0, newBars, visitUpdates, tooFastToReveal, rejected };
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
  return { newCells, newBars, visitUpdates, tooFastToReveal, rejected };
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
        // `skipSpeedGuards: false`, written here as a literal and reachable
        // from nowhere else. SPEC.md Section 10.1: this route's validation is
        // exactly what it has always been, and no field of `request.body`
        // has any say over which checks run — the parsed body reaches
        // `processSampleBatch` as `samples` and as nothing else. The admin
        // teleport (routes/admin-teleport.ts) is a separate route the server
        // admits on the strength of the session, which is the only way a
        // bypass can exist without the caller choosing it.
        return processSampleBatch({
          db,
          userId: request.userId,
          city,
          districtGrid: request.server.grid,
          districtIdByGridIndex: request.server.districtIdByGridIndex,
          lastAccepted,
          samples: parsed.data.samples,
          nowMs: Date.now(),
          skipSpeedGuards: false,
        });
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

      // SPEC.md Section 7.6's two bar figures, city-wide and for this caller
      // alone, as two aggregates over one scan rather than as rows. The
      // start screen (Section 8.3) wants exactly these two integers and used
      // to buy them by fetching every discovered bar; a count the server
      // computed by loading those same rows would have moved the cost rather
      // than removed it, so this deliberately selects no `bars` row at all.
      //
      // `MASTERED_BAR_CONDITION` is routes/bars.ts's own expression — the
      // one `GET /api/bars` flags each bar with — so "mastered" is defined
      // in one place and counted here from that definition. `SUM` over it
      // rather than a second `COUNT` with a second `WHERE`, because two
      // aggregates over one row set is one statement; `COALESCE` because
      // `SUM` of no rows is NULL where `COUNT` of no rows is 0.
      //
      // Three scopes, and each one is load-bearing:
      //
      //   - `bar_discoveries.user_id` — the caller's own discoveries, the
      //     same join every bar query in this codebase makes. Without it
      //     these are the whole server's figures.
      //   - `bars.city_id` — the active city, matching the area figures
      //     beside them. Section 5.1 keeps the schema multi-city ready, and
      //     a count that ignored the column would silently start reporting
      //     two cities as one the day a second is seeded. `GET /api/bars`
      //     scopes itself by discovery and status but not by city, so the
      //     two agree exactly while v1 has one city and this route is the
      //     stricter of the two if that ever stops being true.
      //   - `bars.status = 'active'` — the same filter `GET /api/bars` and
      //     the discovery query apply (Section 5.7), so the discovered
      //     figure counts the bars the map actually draws. It bounds the
      //     mastered figure too, which is deliberate and is what the start
      //     screen showed before this route answered it: mastering is not
      //     revoked anywhere it is *earned* — the leaderboard, the badges
      //     and `GET /api/profile/:handle` still count a hidden bar
      //     (Section 5.7's asymmetry) — but a figure sitting beside "bars
      //     discovered" has to be drawn from the same set of bars as it is.
      const barCounts = db
        .prepare<[number, number, MasteredUserIdBinding], { discovered: number; mastered: number }>(
          `SELECT COUNT(*) AS discovered,
                COALESCE(SUM(${MASTERED_BAR_CONDITION}), 0) AS mastered
         FROM bar_discoveries
         JOIN bars ON bars.id = bar_discoveries.bar_id
         WHERE bar_discoveries.user_id = ? AND bars.city_id = ? AND bars.status = 'active'`,
        )
        .get(userId, city.id, bindMasteredUserId(userId));

      return {
        city: {
          revealedCells: cityRevealedCells,
          playableCells: city.playable_cells,
          percent: city.playable_cells > 0 ? (cityRevealedCells / city.playable_cells) * 100 : 0,
          // Under `city` rather than as a `bars` sibling of `city` and
          // `districts`, because these are city-wide figures about the
          // caller and `city` is where this response keeps those. Section
          // 7.6 defines both bar figures "city-wide and per district", so
          // the per-district half — which this route does not yet answer —
          // belongs in each `districts` entry beside its own area numbers;
          // a `bars` sibling would have had to hold a districts array of
          // its own, and the response would then state the same
          // city/district split twice. `barsMastered` is also already the
          // name this figure has in `GET /api/profile/:handle` and
          // `GET /api/admin/users` (Section 9.6).
          barsDiscovered: barCounts?.discovered ?? 0,
          barsMastered: barCounts?.mastered ?? 0,
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
      };
    });
  };
}
