import { CONFIG, isVisitExpired } from '@tipsytrails/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { purgeExpiredSessions } from './auth/session.js';

// SPEC.md Section 7.9's maintenance tick, Phase 5 step 3. Two of its three
// jobs: expiring stale pending visits and purging expired sessions. The
// third — the 21-minute Web Push reminder, keyed off `push_sent_at` — is
// Phase 5 step 5 and is not implemented here.

interface PendingVisitRow {
  id: number;
  last_sample_at: number;
}

export interface MaintenanceTickResult {
  expiredVisits: number;
  purgedSessions: number;
}

// A pass over current state, not a step forward from the last run: every
// pending visit and every session is re-evaluated against `nowS` on each
// call, so the tick is idempotent (a second call with the same or later
// `nowS` finds nothing left to do) and self-healing after any number of
// missed ticks (SPEC.md Section 7.9) — an eight-hour gap expires every
// visit that should be expired in this one pass, not one per tick.
//
// `nowS` is a parameter rather than `Math.floor(Date.now() / 1000)` read
// here, so a test can drive it across hours without faking timers.
export function runMaintenanceTick(db: Database.Database, nowS: number): MaintenanceTickResult {
  // SPEC.md Section 7.5 step 5 / Section 7.9: the same `isVisitExpired`
  // predicate `routes/visits.ts` and `routes/fog.ts` evaluate expiry with —
  // this only decides which rows to persist as `expired`, exactly as
  // `GET /api/visits/pending`'s lazy sweep does. `id` and `last_sample_at`
  // are both columns of `idx_visits_pending_sweep`, so this is a covering
  // index scan on `status = 'pending'`.
  const pending = db
    .prepare<[], PendingVisitRow>(`SELECT id, last_sample_at FROM visits WHERE status = 'pending'`)
    .all();
  const expiredIds = pending
    .filter((visit) => isVisitExpired(nowS, visit.last_sample_at))
    .map((visit) => visit.id);
  if (expiredIds.length > 0) {
    const placeholders = expiredIds.map(() => '?').join(', ');
    db.prepare(`UPDATE visits SET status = 'expired' WHERE id IN (${placeholders})`).run(
      ...expiredIds,
    );
  }

  const purgedSessions = purgeExpiredSessions(db, nowS);

  return { expiredVisits: expiredIds.length, purgedSessions };
}

// SPEC.md Section 7.9: everything periodic runs inside the API process, so
// this is a plain `setInterval`, not a cron container or external
// scheduler. `unref()`'d so the timer never holds the process open by
// itself, and a throw from one tick is caught and logged rather than
// killing the process or the schedule — a maintenance failure must not take
// the site down.
export function startMaintenanceScheduler(app: FastifyInstance): { stop(): void } {
  const timer = setInterval(() => {
    try {
      runMaintenanceTick(app.db, Math.floor(Date.now() / 1000));
    } catch (err) {
      app.log.error(err, 'maintenance tick failed');
    }
  }, CONFIG.MAINTENANCE_INTERVAL_MS);
  timer.unref();

  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
