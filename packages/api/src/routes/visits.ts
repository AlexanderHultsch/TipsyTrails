import { CONFIG, DERIVED, isOnSite, isVisitExpired, onsiteRadiusM } from '@tipsytrails/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/cookie.js';
import { sendBarNotFound } from './bars.js';
import type { AcceptedPosition } from './fog.js';

// SPEC.md Sections 5.7, 7.5, 9.2: check-in (`POST /api/visits`), the
// pending-visit banner (`GET /api/visits/pending`) and the deliberate way
// out of a pending visit (`POST /api/visits/:id/cancel`). The sample
// handler's visit updates and the maintenance tick are separate work and
// read/write the same `visits` rows through the same `@tipsytrails/shared`
// `visits.ts` rules this file uses.

interface VisitRow {
  id: number;
  bar_id: number;
  bar_name: string;
  started_at: number;
  last_sample_at: number;
  onsite_samples: number;
  confirmed_s: number;
  status: string;
}

// The client-facing shape of a visit: enough for Section 7.5's persistent
// banner (bar name, elapsed confirmed time, remaining time) without a
// second request. Camel-cased like `BarSummary` (routes/bars.ts).
export interface VisitSummary {
  id: number;
  barId: number;
  barName: string;
  startedAt: number;
  lastSampleAt: number;
  onsiteSamples: number;
  confirmedS: number;
  remainingS: number;
  status: string;
}

export function toVisitSummary(row: VisitRow): VisitSummary {
  return {
    id: row.id,
    barId: row.bar_id,
    barName: row.bar_name,
    startedAt: row.started_at,
    lastSampleAt: row.last_sample_at,
    onsiteSamples: row.onsite_samples,
    confirmedS: row.confirmed_s,
    remainingS: Math.max(0, DERIVED.VISIT_REQUIRED_S - row.confirmed_s),
    status: row.status,
  };
}

function sendUnauthenticated(reply: FastifyReply): void {
  reply.code(401).send({ code: 'unauthenticated', message: 'Authentication required.' });
}

function sendInvalidRequest(reply: FastifyReply): void {
  reply.code(400).send({ code: 'invalid_request', message: 'The request body is invalid.' });
}

// No last accepted sample on record for this user (never sampled this
// process, or the API restarted and lost its in-memory map — Section
// 10.2/routes/fog.ts).
function sendNoRecentSample(reply: FastifyReply): void {
  reply.code(422).send({
    code: 'no_recent_sample',
    message: 'No recent position on record. Move around with the app open, then try again.',
  });
}

// The caller's last accepted sample exists but is not within the bar's
// on-site radius.
function sendNotOnsite(reply: FastifyReply): void {
  reply.code(422).send({
    code: 'not_onsite',
    message: 'You do not appear to be at this bar right now.',
  });
}

// SPEC.md Section 9.5, reasoned out from its `GET /api/bars/:id` row rather
// than copied from it: one identical 404 for every visit the caller may not
// act on — another user's, one that is already completed, expired or
// cancelled, an id that never existed, and an id that is not a number at
// all. `visits.id` is a global sequence, so a response that told those
// cases apart would turn this route into an oracle for other players'
// visits, exactly the way a 403 on a bar would confirm that bar's
// existence. It is not `sendBarNotFound` (the helper that precedent lives
// in): that body names a bar, and this route's subject is a visit. The
// message is written to be true in all five cases at once, so the wording
// leaks nothing the status code does not.
function sendVisitNotFound(reply: FastifyReply): void {
  reply
    .code(404)
    .send({ code: 'visit_not_found', message: 'You have no pending visit with that id.' });
}

const checkInSchema = z.object({
  barId: z.number().int().positive(),
});

const VISIT_COLUMNS = `visits.id AS id, visits.bar_id AS bar_id, bars.name AS bar_name,
  visits.started_at AS started_at, visits.last_sample_at AS last_sample_at,
  visits.onsite_samples AS onsite_samples, visits.confirmed_s AS confirmed_s,
  visits.status AS status`;

interface CheckInBarRow {
  id: number;
  name: string;
  lat: number;
  lon: number;
}

// SPEC.md Section 7.5 step 5 / Section 7.9: persists the pending -> expired
// transition. Shared by both routes below so the UPDATE is written once —
// `POST /api/visits`'s existing-pending lookup and `GET /api/visits/pending`'s
// sweep both call `isVisitExpired` (the rule itself, from
// `@tipsytrails/shared`) to decide *whether*, and this only to record it.
function expireVisit(db: Database.Database, visitId: number): void {
  db.prepare(`UPDATE visits SET status = 'expired' WHERE id = ?`).run(visitId);
}

// SPEC.md Section 7.5 step 2, most-generous-radius reading: the position
// held in `lastAccepted` (routes/fog.ts) carries no accuracy, so the
// tolerance is applied in full rather than capped by a real sample's
// accuracy — the largest radius a client could have legitimately offered
// check-in at, so the server never rejects a check-in the client correctly
// offered.
const LAST_ACCEPTED_ONSITE_RADIUS_M = onsiteRadiusM(CONFIG.BAR_ACCURACY_TOLERANCE_M);

export function visitsRoutes(lastAccepted: ReadonlyMap<number, AcceptedPosition>) {
  return async function visitsRoutesPlugin(app: FastifyInstance): Promise<void> {
    app.post('/api/visits', { preHandler: requireAuth }, async (request, reply) => {
      if (request.userId == null) {
        sendUnauthenticated(reply);
        return;
      }

      const parsed = checkInSchema.safeParse(request.body);
      if (!parsed.success) {
        sendInvalidRequest(reply);
        return;
      }

      const db = request.server.db;
      const userId = request.userId;
      const { barId } = parsed.data;

      const bar = db
        .prepare<[number, number], CheckInBarRow>(
          `SELECT bars.id AS id, bars.name AS name, bars.lat AS lat, bars.lon AS lon
           FROM bar_discoveries
           JOIN bars ON bars.id = bar_discoveries.bar_id
           WHERE bar_discoveries.user_id = ? AND bars.id = ? AND bars.status = 'active'`,
        )
        .get(userId, barId);
      if (!bar) {
        sendBarNotFound(reply);
        return;
      }

      const nowS = Math.floor(Date.now() / 1000);

      // SPEC.md Section 5.7: a pending visit at this bar already exists ->
      // return it rather than creating a second one or erroring. The
      // partial unique index `idx_visits_one_pending` is what makes a
      // second pending row impossible; this SELECT-before-INSERT is what
      // keeps that from ever surfacing as a thrown constraint error.
      //
      // Section 7.9: evaluated lazily here too, the same as
      // `GET /api/visits/pending` — a row that is stale by time but not yet
      // swept must not be handed back as if still live (it can never reach
      // `VISIT_REQUIRED_S` from its own `started_at` again). Expiring it and
      // falling through to the create path below is what lets "the user can
      // immediately check in again" (SPEC.md Section 12) hold on a first
      // call, not just after a `GET /api/visits/pending` happens to run
      // first.
      const existing = db
        .prepare<[number, number], VisitRow>(
          `SELECT ${VISIT_COLUMNS}
           FROM visits
           JOIN bars ON bars.id = visits.bar_id
           WHERE visits.user_id = ? AND visits.bar_id = ? AND visits.status = 'pending'`,
        )
        .get(userId, barId);
      if (existing) {
        if (!isVisitExpired(nowS, existing.last_sample_at)) {
          return toVisitSummary(existing);
        }
        expireVisit(db, existing.id);
      }

      const lastSample = lastAccepted.get(userId);
      if (!lastSample) {
        sendNoRecentSample(reply);
        return;
      }
      if (!isOnSite(lastSample, bar, LAST_ACCEPTED_ONSITE_RADIUS_M)) {
        sendNotOnsite(reply);
        return;
      }

      const result = db
        .prepare(
          `INSERT INTO visits (user_id, bar_id, started_at, last_sample_at, onsite_samples, confirmed_s, status)
           VALUES (?, ?, ?, ?, 1, 0, 'pending')`,
        )
        .run(userId, barId, nowS, nowS);

      const created: VisitRow = {
        id: Number(result.lastInsertRowid),
        bar_id: barId,
        bar_name: bar.name,
        started_at: nowS,
        last_sample_at: nowS,
        onsite_samples: 1,
        confirmed_s: 0,
        status: 'pending',
      };
      return toVisitSummary(created);
    });

    // SPEC.md Sections 5.7, 7.5 ("A pending visit can be cancelled") and
    // 9.2. Auth, validation and rate limiting are exactly what
    // `POST /api/visits` above does and no more: `requireAuth`, a rejection
    // of anything that is not a positive integer id, and no rate limiter —
    // there is no `RATE_LIMITS` entry for visits (packages/shared/src/config.ts)
    // and inventing one here would be a constant at a call site.
    //
    // Not a `DELETE`, and no `DELETE FROM`: the row is kept as the record of
    // what happened, the same reason an expired one is kept.
    app.post('/api/visits/:id/cancel', { preHandler: requireAuth }, async (request, reply) => {
      if (request.userId == null) {
        sendUnauthenticated(reply);
        return;
      }

      // The same params handling `GET /api/bars/:id` (routes/bars.ts) and
      // the admin bar routes use: an unparseable id is answered with the
      // route's own not-found rather than a second, distinguishable code.
      const { id } = request.params as { id: string };
      const visitId = Number(id);
      if (!Number.isInteger(visitId)) {
        sendVisitNotFound(reply);
        return;
      }

      const db = request.server.db;
      const userId = request.userId;
      const nowS = Math.floor(Date.now() / 1000);

      // `user_id = ?` and `status = 'pending'` are both in the WHERE clause
      // rather than checked afterwards: "acts only on a pending visit
      // belonging to the caller" is then a property of the query, and there
      // is no branch in which a row that fails either test is in hand at
      // all.
      const row = db
        .prepare<[number, number], VisitRow>(
          `SELECT ${VISIT_COLUMNS}
           FROM visits
           JOIN bars ON bars.id = visits.bar_id
           WHERE visits.id = ? AND visits.user_id = ? AND visits.status = 'pending'`,
        )
        .get(visitId, userId);
      if (!row) {
        sendVisitNotFound(reply);
        return;
      }

      // SPEC.md Section 7.9's lazy evaluation on read, the same as the two
      // routes above: a row that is stale by time is already over, and the
      // status that records how it ended is `expired`, not `cancelled` —
      // the player is not choosing to end something the six-hour rule
      // already ended. Persisted here rather than merely refused, so the
      // sweep has nothing left to do either.
      if (isVisitExpired(nowS, row.last_sample_at)) {
        expireVisit(db, row.id);
        sendVisitNotFound(reply);
        return;
      }

      // SPEC.md Section 5.7: cancelling takes the row out of `pending` and
      // so releases the partial unique index `idx_visits_one_pending`,
      // which is what lets the player check in at the same bar again
      // straight away. `completed_at` stays NULL — nothing was completed —
      // and `confirmed_s` is left exactly as it stood, because the row is a
      // record of what happened rather than a reset.
      db.prepare(`UPDATE visits SET status = 'cancelled' WHERE id = ?`).run(row.id);

      return toVisitSummary({ ...row, status: 'cancelled' });
    });

    app.get('/api/visits/pending', { preHandler: requireAuth }, async (request, reply) => {
      if (request.userId == null) {
        sendUnauthenticated(reply);
        return;
      }

      const db = request.server.db;
      const userId = request.userId;
      const nowS = Math.floor(Date.now() / 1000);

      const rows = db
        .prepare<[number], VisitRow>(
          `SELECT ${VISIT_COLUMNS}
           FROM visits
           JOIN bars ON bars.id = visits.bar_id
           WHERE visits.user_id = ? AND visits.status = 'pending'
           ORDER BY visits.started_at, visits.id`,
        )
        .all(userId);

      // SPEC.md Section 7.9: expiry is evaluated lazily on read, so a visit
      // that should already have expired is never returned even if the
      // maintenance tick has not run yet — and the transition is persisted
      // here, not merely filtered out of the response.
      const active: VisitRow[] = [];
      const expiredIds: number[] = [];
      for (const row of rows) {
        if (isVisitExpired(nowS, row.last_sample_at)) {
          expiredIds.push(row.id);
        } else {
          active.push(row);
        }
      }
      if (expiredIds.length > 0) {
        const expireStale = db.transaction((ids: number[]) => {
          for (const id of ids) {
            expireVisit(db, id);
          }
        });
        expireStale(expiredIds);
      }

      return { visits: active.map(toVisitSummary) };
    });
  };
}
