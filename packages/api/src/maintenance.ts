import { CONFIG, DERIVED, isVisitExpired } from '@tipsytrails/shared';
import type Database from 'better-sqlite3';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { purgeExpiredSessions } from './auth/session.js';
import type { PushSender } from './push/sender.js';

// SPEC.md Section 7.9's maintenance tick, Phase 5 steps 3 and 5: expiring
// stale pending visits, dispatching the 21-minute Web Push reminder, and
// purging expired sessions — in that order, because SPEC.md's own bullet
// order is also the race-safety order (see dispatchPushReminders below).

interface PendingVisitRow {
  id: number;
  last_sample_at: number;
}

// Internal: what `runMaintenanceTick` resolves to, read inline by the
// scheduler below and by every test rather than named anywhere.
interface MaintenanceTickResult {
  expiredVisits: number;
  purgedSessions: number;
  // Pending visits for which `push_sent_at` was set this tick — set whether
  // or not delivery to any of the user's subscriptions actually succeeded
  // (SPEC.md Section 5.9/7.9), so this counts dispatch attempts, not
  // confirmed deliveries; the sandbox this runs in cannot confirm delivery
  // at all (task Section E).
  pushDispatched: number;
}

interface PushCandidateRow {
  id: number;
  user_id: number;
  bar_name: string;
}

interface SubscriptionRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

// Internal for the same reason: `runMaintenanceTick`'s third argument is
// always written as an object literal at the call site and contextually
// typed from here.
interface MaintenanceOptions {
  // null (the default) means push is disabled — app.ts resolves this once
  // at boot from the VAPID_* env vars (push/config.ts) and only ever hands
  // a non-null sender to the real scheduler below; tests hand in a fake
  // implementing the same seam (task Section E) instead of a real
  // web-push-backed one.
  pushSender?: PushSender | null;
  log?: FastifyBaseLogger;
}

// SPEC.md Section 7.5's transparency requirement, as a push payload: says
// what it is for (the visit is close to done) and what to do (reopen the
// app while still there) — the notification's whole reason to exist per the
// task brief.
function buildReminderPayload(barName: string): string {
  return JSON.stringify({
    title: 'Almost there',
    body: `Your visit to ${barName} is nearly complete. Open Tipsy Trails again while you're still there to finish it.`,
  });
}

// SPEC.md Section 7.9's push bullet, Section 5.9's 404/410 rule. Split out
// of runMaintenanceTick only for readability — it shares that function's db
// handle and is never called from anywhere else.
//
// Race safety: the SELECT below and the `push_sent_at` UPDATE that follows
// it are both synchronous better-sqlite3 calls with no `await` between
// them, so nothing else on the event loop — a sample batch completing this
// same visit, or a later tick — can run in that gap. Every visit this tick
// will ever push for is therefore selected, and marked as pushed, entirely
// before the first `await` (the actual network send) — "only while still
// pending" and "at most once" both come from that ordering, not from
// anything the (genuinely concurrent) send loop below does.
async function dispatchPushReminders(
  db: Database.Database,
  nowS: number,
  pushSender: PushSender | null | undefined,
  log: FastifyBaseLogger | undefined,
): Promise<number> {
  if (!pushSender) {
    return 0;
  }

  const candidates = db
    .prepare<[number, number], PushCandidateRow>(
      `SELECT visits.id AS id, visits.user_id AS user_id, bars.name AS bar_name
       FROM visits
       JOIN bars ON bars.id = visits.bar_id
       WHERE visits.status = 'pending'
         AND visits.push_sent_at IS NULL
         AND (? - visits.started_at) >= ?`,
    )
    .all(nowS, DERIVED.VISIT_PUSH_AFTER_S);
  if (candidates.length === 0) {
    return 0;
  }

  const placeholders = candidates.map(() => '?').join(', ');
  db.prepare(`UPDATE visits SET push_sent_at = ? WHERE id IN (${placeholders})`).run(
    nowS,
    ...candidates.map((candidate) => candidate.id),
  );

  const getSubscriptions = db.prepare<[number], SubscriptionRow>(
    `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?`,
  );
  const deleteSubscription = db.prepare(`DELETE FROM push_subscriptions WHERE id = ?`);

  const sends = candidates.flatMap((candidate) => {
    const payload = buildReminderPayload(candidate.bar_name);
    return getSubscriptions.all(candidate.user_id).map(async (subscription) => {
      // A `PushSender` is not expected to reject — the real one
      // (push/sender.ts) always resolves to a `PushSendOutcome` — but this
      // is caught anyway: one misbehaving sender or subscription must never
      // take down the whole dispatch pass (task Section C), and this `try`
      // is what makes that true even for an implementation that does not
      // hold up its end of the contract, not only for the real one.
      let outcome: Awaited<ReturnType<PushSender['send']>>;
      try {
        outcome = await pushSender.send(subscription, payload);
      } catch (err) {
        log?.warn(
          { err, subscriptionId: subscription.id },
          'push delivery threw; leaving the subscription in place',
        );
        return;
      }
      if (outcome.delivered) {
        return;
      }
      // SPEC.md Section 5.9: 404/410 mean the subscription is permanently
      // gone and is deleted immediately; any other failure (including no
      // status code at all, e.g. a network error) is logged and the
      // subscription is left in place — one dead endpoint must not stop the
      // others in this same pass, which is exactly what collecting these
      // into `sends` and awaiting them together with Promise.allSettled
      // below (rather than awaiting each one in a loop) guarantees.
      if (outcome.statusCode === 404 || outcome.statusCode === 410) {
        deleteSubscription.run(subscription.id);
      } else {
        log?.warn(
          { statusCode: outcome.statusCode, subscriptionId: subscription.id },
          'push delivery failed; leaving the subscription in place',
        );
      }
    });
  });
  await Promise.allSettled(sends);

  return candidates.length;
}

// A pass over current state, not a step forward from the last run: every
// pending visit and every session is re-evaluated against `nowS` on each
// call, so the tick is idempotent (a second call with the same or later
// `nowS` finds nothing left to do) and self-healing after any number of
// missed ticks (SPEC.md Section 7.9) — an eight-hour gap expires every
// visit that should be expired in this one pass, not one per tick.
//
// `nowS` is a parameter rather than `Math.floor(Date.now() / 1000)` read
// here, so a test can drive it across hours without faking timers. Sending
// a push is I/O, so unlike the rest of this function's SQLite calls it
// cannot be synchronous — this function is `async` (returning
// `Promise<MaintenanceTickResult>`) for that reason alone, and every caller
// (startMaintenanceScheduler below, and every test) awaits it; nothing
// about the `db`/`nowS` contract above changed.
export async function runMaintenanceTick(
  db: Database.Database,
  nowS: number,
  options: MaintenanceOptions = {},
): Promise<MaintenanceTickResult> {
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

  // Runs after the expiry UPDATE above and before the session purge below,
  // matching SPEC.md Section 7.9's own bullet order — a visit this same
  // tick just expired is no longer `status = 'pending'` by the time
  // dispatchPushReminders' SELECT runs, so it can never be selected as a
  // push candidate.
  const pushDispatched = await dispatchPushReminders(db, nowS, options.pushSender, options.log);

  const purgedSessions = purgeExpiredSessions(db, nowS);

  return { expiredVisits: expiredIds.length, purgedSessions, pushDispatched };
}

// SPEC.md Section 7.9: everything periodic runs inside the API process, so
// this is a plain `setInterval`, not a cron container or external
// scheduler. `unref()`'d so the timer never holds the process open by
// itself, and a rejection from one tick is caught and logged rather than
// killing the process or the schedule — a maintenance failure must not take
// the site down. `app.pushSender` is resolved once at boot (app.ts, from
// the VAPID_* env vars) — null there means push is disabled and this tick's
// dispatch step is a no-op, the same as it is in every test that omits it.
export function startMaintenanceScheduler(app: FastifyInstance): { stop(): void } {
  const timer = setInterval(() => {
    runMaintenanceTick(app.db, Math.floor(Date.now() / 1000), {
      pushSender: app.pushSender,
      log: app.log,
    }).catch((err: unknown) => {
      app.log.error(err, 'maintenance tick failed');
    });
  }, CONFIG.MAINTENANCE_INTERVAL_MS);
  timer.unref();

  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
