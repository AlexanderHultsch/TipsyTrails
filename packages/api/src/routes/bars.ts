import { findConflictingBar } from '@tipsytrails/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/cookie.js';
import { createRateLimiter } from '../http/rate-limit.js';
import { loadActiveCity, resolveCellAndDistrict, toGridParams } from './fog.js';

// SPEC.md Sections 5.7, 7.4, 9.2, 9.5: `GET /api/bars` and `GET /api/bars/:id`
// answer only from bars the requesting user has discovered — every query in
// this file joins through `bar_discoveries` filtered by `user_id`, so a bar
// that row does not cover cannot appear in a response no matter what its id
// or position is. `toBarSummary` (also used by `routes/fog.ts` for the
// `newBars` field of `POST /api/samples`) is the one place a `bars` row
// becomes client-facing JSON, so the two surfaces can never drift apart on
// what a "discovered bar" looks like.
//
// `POST /api/bars/suggest` (SPEC.md Section 11.3, Phase 7 step 1) lives here
// too rather than in a sibling module: it is squarely bar data, it returns
// through the same `toBarSummary`, and it is a single handler rather than a
// cluster of routes that would justify its own file the way `visits.ts`
// (three routes sharing `lastAccepted`) or `fog.ts` (the fog/sample/progress
// trio) do.

export interface DiscoveredBarRow {
  id: number;
  district_id: number | null;
  name: string;
  address: string | null;
  lat: number;
  lon: number;
  source: string;
  discovered_at: number;
  // SPEC.md Section 5.7: 1 when the discovering user has at least one
  // `visits` row at this bar with `status = 'completed'`, 0 otherwise —
  // SQLite's `EXISTS` yields exactly those two values. Required rather than
  // optional on purpose: every producer of this row is then forced by the
  // type checker to say what the flag is, which is what keeps the three
  // surfaces below from drifting apart.
  mastered: number;
}

export interface BarSummary {
  id: number;
  districtId: number | null;
  name: string;
  address: string | null;
  lat: number;
  lon: number;
  source: string;
  discoveredAt: number;
  // SPEC.md Section 5.7: "A bar is mastered by a user if at least one
  // `visits` row exists with `status='completed'`. Mastering is permanent
  // and cannot be lost." Per-user, therefore, and never a property of the
  // bar: the same bar is mastered in one caller's response and not in
  // another's, which is why it is computed from the discovery row's own
  // `user_id` (DISCOVERED_BAR_COLUMNS below) rather than from a parameter
  // a caller could pass the wrong value for.
  mastered: boolean;
}

export function toBarSummary(row: DiscoveredBarRow): BarSummary {
  return {
    id: row.id,
    districtId: row.district_id,
    name: row.name,
    address: row.address,
    lat: row.lat,
    lon: row.lon,
    source: row.source,
    discoveredAt: row.discovered_at,
    mastered: row.mastered === 1,
  };
}

// SPEC.md Section 9.5: identical for "does not exist" and "not discovered by
// you" — a 403 would confirm existence and defeat Section 7.4. Exported so
// routes/visits.ts can send the exact same body for the same reason
// (Sections 7.4, 9.5: a check-in attempt must not become an existence
// oracle either) rather than duplicating it.
export function sendBarNotFound(reply: FastifyReply): void {
  reply.code(404).send({ code: 'bar_not_found', message: 'That bar does not exist.' });
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

// SPEC.md Section 5.1: "Positions outside the active city's bounding box are
// silently ignored by all endpoints" describes read/derive endpoints like
// `POST /api/samples`; a submission is a write the user must be told about,
// so this route rejects rather than silently ignores.
function sendOutsideCity(reply: FastifyReply): void {
  reply.code(422).send({
    code: 'outside_city',
    message: 'That position is outside the playable area.',
  });
}

function sendGridUnavailable(reply: FastifyReply): void {
  reply.code(503).send({
    code: 'grid_unavailable',
    message: 'The district grid is not loaded on this server.',
  });
}

// 409, in the style of POST /api/auth/register's `username_taken` (also a
// "this already exists" conflict rather than a malformed-request 400).
function sendDuplicateBar(reply: FastifyReply, conflictName: string): void {
  reply.code(409).send({
    code: 'duplicate_bar',
    message: `A bar named "${conflictName}" already exists nearby.`,
  });
}

const suggestBarSchema = z.object({
  name: z.string().trim().min(1),
  address: z.string().trim().min(1).nullable(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});

interface ActiveBarForDuplicateCheck {
  id: number;
  name: string;
  lat: number;
  lon: number;
}

// The column list every query that feeds `toBarSummary` selects, exported so
// routes/fog.ts's `newBars` query uses this one rather than a second copy —
// a `bars` row becomes client-facing JSON through one mapper and now also
// through one SELECT list, so a field added here reaches all three surfaces
// at once (SPEC.md Section 9.2's GET /api/bars, GET /api/bars/:id and POST
// /api/samples).
//
// `mastered` is SPEC.md Section 5.7's definition verbatim — at least one
// `visits` row for this user and bar with `status = 'completed'` — and three
// things about how it is written here are deliberate.
//
//   - **It is bound by name (`@masteredUserId`), not positionally.** This
//     list is spliced into queries whose other parameters are anonymous `?`
//     (routes/fog.ts's `IN (...)` list), and a positional parameter inside
//     the SELECT list would make every one of those callers depend on where
//     the columns happen to sit in the statement. `bindMasteredUserId` below
//     is the only way to supply it.
//   - **The caller's own `bar_discoveries.user_id` is compared against that
//     same parameter, as part of the flag.** A wrong user id can then only
//     ever report `false`; it can never report another user's mastery, which
//     is the failure a single-user test suite cannot see. Every query here
//     already scopes itself to one user's discoveries, so the comparison is
//     true for every row that is returned at all and costs one integer
//     compare.
//   - **`IN (subquery)` rather than a correlated `EXISTS`.** They mean the
//     same thing and cost wildly different amounts. `EXISTS` correlated on
//     `bars.id` runs once per discovered bar, and `idx_visits_user_status`
//     (Section 5.7) is on `(user_id, status)` — it has no `bar_id`, so each
//     run walks every completed visit the user has: O(bars × completed
//     visits), measured at 15 ms for a player with 500 discovered bars and
//     600 completed visits against 0.4 ms without the flag. As an `IN` list
//     the same index answers the subquery once, per query rather than per
//     row, and SQLite probes the materialised result: 0.6 ms for that same
//     player, 0.16 ms for a typical one. No new index is needed, and none is
//     added — the existing one covers this shape exactly.
export const DISCOVERED_BAR_COLUMNS = `bars.id AS id, bars.district_id AS district_id, bars.name AS name,
  bars.address AS address, bars.lat AS lat, bars.lon AS lon, bars.source AS source,
  bar_discoveries.discovered_at AS discovered_at,
  (bar_discoveries.user_id = @masteredUserId
   AND bars.id IN (
     SELECT bar_id FROM visits
     WHERE user_id = @masteredUserId AND status = 'completed'
   )) AS mastered`;

export interface MasteredUserIdBinding {
  masteredUserId: number;
}

/**
 * The named binding `DISCOVERED_BAR_COLUMNS` needs, for the user whose
 * discoveries the query is scoped to. Pass it alongside the statement's
 * anonymous parameters — better-sqlite3 takes both, e.g.
 * `stmt.all(userId, bindMasteredUserId(userId))`.
 */
export function bindMasteredUserId(userId: number): MasteredUserIdBinding {
  return { masteredUserId: userId };
}

export async function barsRoutes(app: FastifyInstance): Promise<void> {
  const suggestRateLimit = createRateLimiter('suggest');

  app.get('/api/bars', { preHandler: requireAuth }, async (request, reply) => {
    if (request.userId == null) {
      sendUnauthenticated(reply);
      return;
    }

    const rows = request.server.db
      .prepare<[number, MasteredUserIdBinding], DiscoveredBarRow>(
        `SELECT ${DISCOVERED_BAR_COLUMNS}
         FROM bar_discoveries
         JOIN bars ON bars.id = bar_discoveries.bar_id
         WHERE bar_discoveries.user_id = ? AND bars.status = 'active'
         ORDER BY bar_discoveries.discovered_at, bars.id`,
      )
      .all(request.userId, bindMasteredUserId(request.userId));

    return { bars: rows.map(toBarSummary) };
  });

  app.get('/api/bars/:id', { preHandler: requireAuth }, async (request, reply) => {
    if (request.userId == null) {
      sendUnauthenticated(reply);
      return;
    }

    const { id } = request.params as { id: string };
    const barId = Number(id);
    if (!Number.isInteger(barId)) {
      sendBarNotFound(reply);
      return;
    }

    const row = request.server.db
      .prepare<[number, number, MasteredUserIdBinding], DiscoveredBarRow>(
        `SELECT ${DISCOVERED_BAR_COLUMNS}
         FROM bar_discoveries
         JOIN bars ON bars.id = bar_discoveries.bar_id
         WHERE bar_discoveries.user_id = ? AND bars.id = ? AND bars.status = 'active'`,
      )
      .get(request.userId, barId, bindMasteredUserId(request.userId));

    if (!row) {
      sendBarNotFound(reply);
      return;
    }

    return toBarSummary(row);
  });

  // SPEC.md Section 11.3, Section 9.2: community bar suggestions. Behaviour,
  // all from 11.3: rate-limited, position must fall inside the active
  // city's grid, a name-similarity duplicate within
  // SUGGEST_DUPLICATE_RADIUS_M is rejected naming the conflict, and on
  // success the bar goes live immediately (`source = 'community'`,
  // `status = 'active'`) with the submitter discovering their own
  // submission in the same transaction as the insert — "a bar that exists
  // but is undiscovered by its own submitter" is a state nothing else in
  // the system produces.
  app.post(
    '/api/bars/suggest',
    { preHandler: [requireAuth, suggestRateLimit] },
    async (request, reply) => {
      if (request.userId == null) {
        sendUnauthenticated(reply);
        return;
      }

      const parsed = suggestBarSchema.safeParse(request.body);
      if (!parsed.success) {
        sendInvalidRequest(reply);
        return;
      }
      const { name, address, lat, lon } = parsed.data;

      const db = request.server.db;
      const city = loadActiveCity(db);
      if (!city) {
        sendCityNotFound(reply);
        return;
      }

      // Same projection `POST /api/samples` uses (routes/fog.ts), not a
      // second copy of it.
      const grid = toGridParams(city);
      const cellResult = resolveCellAndDistrict(
        grid,
        request.server.grid,
        request.server.districtIdByGridIndex,
        lat,
        lon,
      );
      if (cellResult.status === 'outside_city') {
        sendOutsideCity(reply);
        return;
      }
      if (cellResult.status === 'grid_unavailable') {
        sendGridUnavailable(reply);
        return;
      }
      const { cellIndex, districtId } = cellResult;

      const activeBars = db
        .prepare<[number], ActiveBarForDuplicateCheck>(
          `SELECT id, name, lat, lon FROM bars WHERE city_id = ? AND status = 'active'`,
        )
        .all(city.id);

      const conflict = findConflictingBar(name, { lat, lon }, activeBars);
      if (conflict) {
        sendDuplicateBar(reply, conflict.name);
        return;
      }

      const userId = request.userId;
      const nowS = Math.floor(Date.now() / 1000);

      const created = db.transaction((): DiscoveredBarRow => {
        const result = db
          .prepare(
            `INSERT INTO bars
               (city_id, district_id, name, address, lat, lon, cell_index, source, submitted_by, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'community', ?, 'active', ?)`,
          )
          .run(city.id, districtId, name, address, lat, lon, cellIndex, userId, nowS);
        const barId = Number(result.lastInsertRowid);

        db.prepare(
          'INSERT INTO bar_discoveries (user_id, bar_id, discovered_at) VALUES (?, ?, ?)',
        ).run(userId, barId, nowS);

        return {
          id: barId,
          district_id: districtId,
          name,
          address,
          lat,
          lon,
          source: 'community',
          discovered_at: nowS,
          // The bar was created by the INSERT two statements up, so no
          // `visits` row can reference it yet and SPEC.md Section 5.7's
          // condition cannot hold. This is the one producer of a
          // DiscoveredBarRow that states the flag instead of selecting it,
          // and it can only because it also created the bar.
          mastered: 0,
        };
      })();

      reply.code(201);
      return toBarSummary(created);
    },
  );
}
