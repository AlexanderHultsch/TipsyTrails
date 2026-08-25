import {
  badgePeriodBoundaries,
  badgePeriodDays,
  badgePeriodKey,
  CONFIG,
  mostRecentlyClosedBadgePeriodKey,
} from '@tipsytrails/shared';
import type { BadgePeriod } from '@tipsytrails/shared';
import type Database from 'better-sqlite3';
import { loadActiveCity } from './city-grid.js';
import { excludedFromRankingsUserIds } from './rankings.js';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

// SPEC.md Section 7.7's badge evaluation job, structured like maintenance.ts's
// tick for the same reasons: `evaluateBadges` is a pure pass over current
// state for one explicit period key (never today's clock), the catch-up
// entry point re-runs it for whichever period key is most recently closed,
// and a scheduler wraps that catch-up in a `setInterval` the same way
// `startMaintenanceScheduler` wraps `runMaintenanceTick`.

export type BadgeKind = keyof typeof CONFIG.BADGE_THRESHOLDS;

const BADGE_PERIODS: readonly BadgePeriod[] = ['week', 'month', 'year'];

// Both internal: they only ever appear as what `evaluateBadges` and
// `runBadgeCatchUp` return, and every caller (the scheduler below, the
// startup catch-up, the tests) reads that result inline rather than naming
// its type.
interface BadgeAward {
  userId: number;
  kind: BadgeKind;
  value: number;
}

interface BadgeEvaluationResult {
  period: BadgePeriod;
  periodKey: string;
  awarded: BadgeAward[];
}

export interface BadgeProgress {
  kind: BadgeKind;
  value: number;
}

// Section 7.8's leaderboard and profile need the same per-user value this
// module already computes for badges, plus the instant that value was
// reached — the "earliest achievement" leaderboard tie-break. Kept as one
// richer return type on the existing value functions below rather than a
// second query, so a ranked read can never disagree with what the badge job
// itself scored a user at.
export interface MetricStanding {
  value: number;
  achievedAtS: number;
}

export interface BadgeSummary {
  kind: BadgeKind;
  period: BadgePeriod;
  periodKey: string;
  value: number;
  awardedAt: number;
}

interface ExplorerRow {
  user_id: number;
  cells: number;
  achieved_day: string;
}

// Section 7.7: `explorer` is the percent of playable city area newly
// revealed within the period, summed from `fog_daily_progress` over the
// period's days (`badgePeriodDays` — the calendar is derived once, in
// packages/shared, and never re-derived here) and divided by
// `cities.playable_cells`. A user with no rows for any of these days (never
// moved) is simply absent from the result map, i.e. implicitly 0%.
//
// Exported for Section 7.8's leaderboard (routes/leaderboard.ts) and
// profile (routes/profile.ts), which read this exact computation rather
// than re-querying `fog_daily_progress` themselves, so those surfaces can
// never disagree with a user's badge value. `achieved_day` is the latest of
// the summed days, which is always a day the user actually progressed on —
// every `fog_daily_progress` row is written only with `revealed_cells > 0`
// (routes/fog.ts's `applyReveal`) — i.e. the day this user's period total
// was reached, Section 7.8's "earliest achievement" tie-break instant.
export function explorerValuesByUser(
  db: Database.Database,
  cityId: number,
  playableCells: number,
  days: string[],
): Map<number, MetricStanding> {
  const values = new Map<number, MetricStanding>();
  if (playableCells <= 0 || days.length === 0) {
    return values;
  }
  const placeholders = days.map(() => '?').join(', ');
  const rows = db
    .prepare<unknown[], ExplorerRow>(
      `SELECT user_id, SUM(revealed_cells) AS cells, MAX(day) AS achieved_day
       FROM fog_daily_progress WHERE city_id = ? AND day IN (${placeholders}) GROUP BY user_id`,
    )
    .all(cityId, ...days);
  for (const row of rows) {
    values.set(row.user_id, {
      value: (row.cells / playableCells) * 100,
      achievedAtS: Math.floor(Date.parse(`${row.achieved_day}T00:00:00Z`) / 1000),
    });
  }
  return values;
}

interface BarflyRow {
  user_id: number;
  mastered: number;
  achieved_at_s: number;
}

// Section 7.7: `barfly` counts bars whose *earliest* completed visit falls
// inside the period — "a second completed visit at an already-mastered bar
// counts for nothing." The inner query finds each (user, bar)'s earliest
// completion across all time (not scoped to the period), and only that
// earliest instant is tested against the period boundary — a later repeat
// completion at the same bar never appears here at all.
//
// Exported for the same reason and by the same callers as
// `explorerValuesByUser` above. `achieved_at_s` is the latest of the
// contributing `first_completed_at` instants — the completion that pushed
// this user's in-scope count to its current total, Section 7.8's
// "earliest achievement" tie-break instant for the bars metric.
export function barflyValuesByUser(
  db: Database.Database,
  startS: number,
  endS: number,
): Map<number, MetricStanding> {
  const values = new Map<number, MetricStanding>();
  const rows = db
    .prepare<[number, number], BarflyRow>(
      `SELECT user_id, COUNT(*) AS mastered, MAX(first_completed_at) AS achieved_at_s FROM (
         SELECT user_id, bar_id, MIN(completed_at) AS first_completed_at
         FROM visits
         WHERE status = 'completed'
         GROUP BY user_id, bar_id
       )
       WHERE first_completed_at >= ? AND first_completed_at < ?
       GROUP BY user_id`,
    )
    .all(startS, endS);
  for (const row of rows) {
    values.set(row.user_id, { value: row.mastered, achievedAtS: row.achieved_at_s });
  }
  return values;
}

// Section 7.8: "All-time bars is the count of distinct mastered bars" — no
// period filter at all, which is exactly `barflyValuesByUser` with bounds
// wide enough to include every `completed_at` there will ever be. Kept as
// its own export rather than a magic `(0, Number.MAX_SAFE_INTEGER)` at each
// call site.
export function allTimeBarflyValuesByUser(db: Database.Database): Map<number, MetricStanding> {
  return barflyValuesByUser(db, 0, Number.MAX_SAFE_INTEGER);
}

interface InsertedRow {
  user_id: number;
}

// Section 7.7's competition: the threshold is a floor, not a target, so the
// candidates are everyone at or above it — minus the accounts Section 7.8's
// exclusion flag takes out of the competition entirely (rankings.ts) — and
// among those, only the highest value wins the period. Everyone tied at that
// top value wins; the
// `achievedAtS` tie-break belongs to Section 7.8's leaderboard ordering and
// is deliberately not used to break a tie into a single winner here.
// Equality is compared exactly: both metrics derive every user's value from
// integer counts by one identical computation, so two genuinely equal users
// produce bit-identical floats and a tolerance would only turn near-misses
// into ties.
//
// Section 7.7's stated idempotency mechanism: the `UNIQUE (user_id, kind,
// period, period_key)` constraint plus `INSERT ... ON CONFLICT DO NOTHING`,
// not a SELECT-then-INSERT check — the constraint is what does the work.
// `RETURNING` tells us which rows this call actually inserted (as opposed to
// ones that conflicted), which is how the result below reports only genuine
// new awards on a second run.
//
// The exclusion is applied HERE, and that placement is the whole of it.
// Both kinds' candidate sets pass through this one function, so `explorer`
// and `barfly` are covered by construction rather than by two filters that
// could come to disagree. It is deliberately not applied inside
// `explorerValuesByUser`/`barflyValuesByUser` above: those two are shared
// with routes/leaderboard.ts and routes/profile.ts, and Section 7.8 is
// explicit that an excluded player still reads their own figures on their
// own profile — filtering at the source would have taken those away too.
//
// Filtering before `topValue` is computed, not after, is what makes the
// guarantee two-sided: an excluded account can neither win a badge nor be
// the high scorer that denies one to somebody who is still competing.
function awardCandidates(
  db: Database.Database,
  kind: BadgeKind,
  period: BadgePeriod,
  periodKey: string,
  awardedAt: number,
  values: Map<number, MetricStanding>,
  excluded: ReadonlySet<number>,
): BadgeAward[] {
  const threshold: number = CONFIG.BADGE_THRESHOLDS[kind][period];
  const candidates = [...values].filter(
    ([userId, standing]) => !excluded.has(userId) && standing.value >= threshold,
  );
  if (candidates.length === 0) {
    return [];
  }
  let topValue = candidates[0][1].value;
  for (const [, standing] of candidates) {
    if (standing.value > topValue) {
      topValue = standing.value;
    }
  }
  const insert = db.prepare<[number, string, string, string, number, number], InsertedRow>(
    `INSERT INTO badges (user_id, kind, period, period_key, value, awarded_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, kind, period, period_key) DO NOTHING
     RETURNING user_id`,
  );
  const awarded: BadgeAward[] = [];
  for (const [userId, standing] of candidates) {
    if (standing.value !== topValue) {
      continue;
    }
    const row = insert.get(userId, kind, period, periodKey, standing.value, awardedAt);
    if (row) {
      awarded.push({ userId, kind, value: standing.value });
    }
  }
  return awarded;
}

// One evaluation of one (period, periodKey) — Section 7.7's job. Takes the
// period key explicitly, as the spec requires so "a missed period can be
// re-run by hand", and reads no clock of its own: `awarded_at` is the
// period's own close instant (`endS` from `badgePeriodBoundaries`), which is
// deterministic from `periodKey` alone and makes two evaluations of the same
// period, run at different wall-clock times, write identical rows.
export function evaluateBadges(
  db: Database.Database,
  period: BadgePeriod,
  periodKey: string,
): BadgeEvaluationResult {
  const { startS, endS } = badgePeriodBoundaries(period, periodKey);
  const awarded: BadgeAward[] = [];

  // Section 7.8's exclusion, read once for the whole evaluation and handed
  // to both kinds — the flag cannot change halfway through a single pass,
  // and two reads would only give the two kinds two chances to see it
  // differently.
  const excluded = excludedFromRankingsUserIds(db);

  const city = loadActiveCity(db);
  if (city) {
    const days = badgePeriodDays(period, periodKey);
    const explorerValues = explorerValuesByUser(db, city.id, city.playable_cells, days);
    awarded.push(
      ...awardCandidates(db, 'explorer', period, periodKey, endS, explorerValues, excluded),
    );
  }

  const barflyValues = barflyValuesByUser(db, startS, endS);
  awarded.push(...awardCandidates(db, 'barfly', period, periodKey, endS, barflyValues, excluded));

  return { period, periodKey, awarded };
}

// Section 7.9's boot catch-up: for each of the three periods, evaluate the
// period that most recently closed. Calling `evaluateBadges` again for a
// period it already covered is exactly as cheap and safe as calling it the
// first time — idempotency comes from the constraint inside
// `awardCandidates`, not from a check here — so this needs no separate
// "was this already evaluated" bookkeeping (Section 7.7's own idempotency
// mechanism, applied the same way `startBadgeScheduler` below relies on it
// to make "run periodically" and "run once, precisely at each boundary"
// equivalent).
export function runBadgeCatchUp(db: Database.Database, nowMs: number): BadgeEvaluationResult[] {
  return BADGE_PERIODS.map((period) => {
    const periodKey = mostRecentlyClosedBadgePeriodKey(period, nowMs);
    return evaluateBadges(db, period, periodKey);
  });
}

// Section 7.7's last-but-two paragraph: the player's own value for the
// running period, computed by this same module's per-user value functions so
// it can never disagree with the award value those same functions produce
// inside `evaluateBadges`. The threshold is deliberately absent — Section 7.7
// keeps the floor on the server, and neither it nor any standing against
// other players leaves this function. Unlike `evaluateBadges`, this reads the
// clock (via `nowMs`) because "the current period" is inherently a live,
// moving target, not a fixed key a caller already knows.
export function currentBadgeProgress(
  db: Database.Database,
  userId: number,
  period: BadgePeriod,
  nowMs: number = Date.now(),
): BadgeProgress[] {
  const periodKey = badgePeriodKey(period, nowMs);
  const { startS, endS } = badgePeriodBoundaries(period, periodKey);

  const city = loadActiveCity(db);
  const explorerValue = city
    ? (explorerValuesByUser(
        db,
        city.id,
        city.playable_cells,
        badgePeriodDays(period, periodKey),
      ).get(userId)?.value ?? 0)
    : 0;
  const barflyValue = barflyValuesByUser(db, startS, endS).get(userId)?.value ?? 0;

  return [
    { kind: 'explorer', value: explorerValue },
    { kind: 'barfly', value: barflyValue },
  ];
}

// `kind` and `period` are the closed vocabularies 001_init.sql documents
// beside those columns (`-- 'explorer' | 'barfly'`, `-- 'week' | 'month' |
// 'year'`) and `awardCandidates` above is the only writer of either — it
// takes them as `BadgeKind` and `BadgePeriod`, so nothing else can ever get
// into the table. Declared as those unions here rather than as `string` plus
// an `as` cast in the mapper below: `db.prepare<…, BadgeQueryRow>` is an
// unchecked assertion about every column anyway, so the cast bought no
// safety and only hid where the claim was being made.
interface BadgeQueryRow {
  user_id: number;
  kind: BadgeKind;
  period: BadgePeriod;
  period_key: string;
  value: number;
  awarded_at: number;
}

// Section 7.7's badge shelf and inline leaderboard icons: every badge one or
// more users have ever been awarded, in one query rather than one per row —
// routes/leaderboard.ts's page of rows and routes/profile.ts's single row
// both call this instead of querying `badges` themselves.
export function badgesByUser(
  db: Database.Database,
  userIds: number[],
): Map<number, BadgeSummary[]> {
  const result = new Map<number, BadgeSummary[]>();
  if (userIds.length === 0) {
    return result;
  }
  const placeholders = userIds.map(() => '?').join(', ');
  const rows = db
    .prepare<unknown[], BadgeQueryRow>(
      `SELECT user_id, kind, period, period_key, value, awarded_at FROM badges
       WHERE user_id IN (${placeholders})
       ORDER BY awarded_at, id`,
    )
    .all(...userIds);
  for (const row of rows) {
    const list = result.get(row.user_id) ?? [];
    list.push({
      kind: row.kind,
      period: row.period,
      periodKey: row.period_key,
      value: row.value,
      awardedAt: row.awarded_at,
    });
    result.set(row.user_id, list);
  }
  return result;
}

function runCatchUpSafely(db: Database.Database, log: FastifyBaseLogger | undefined): void {
  try {
    runBadgeCatchUp(db, Date.now());
  } catch (err) {
    log?.error(err, 'badge evaluation failed');
  }
}

// SPEC.md Section 7.9: everything periodic runs inside the API process.
// Mirrors `startMaintenanceScheduler`: an immediate run (so "a Pi that was
// off at 04:00 still awards badges" as soon as it boots, not up to an hour
// later) followed by a plain `setInterval`, `unref()`'d so the timer never
// holds the process open by itself, with a throw from one run logged rather
// than allowed to kill the schedule.
export function startBadgeScheduler(app: FastifyInstance): { stop(): void } {
  runCatchUpSafely(app.db, app.log);
  const timer = setInterval(() => {
    runCatchUpSafely(app.db, app.log);
  }, CONFIG.BADGE_EVAL_INTERVAL_MS);
  timer.unref();

  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
