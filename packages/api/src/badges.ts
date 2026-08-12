import {
  badgePeriodBoundaries,
  badgePeriodDays,
  badgePeriodKey,
  CONFIG,
  mostRecentlyClosedBadgePeriodKey,
} from '@tipsytrails/shared';
import type { BadgePeriod } from '@tipsytrails/shared';
import type Database from 'better-sqlite3';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

// SPEC.md Section 7.7's badge evaluation job, structured like maintenance.ts's
// tick for the same reasons: `evaluateBadges` is a pure pass over current
// state for one explicit period key (never today's clock), the catch-up
// entry point re-runs it for whichever period key is most recently closed,
// and a scheduler wraps that catch-up in a `setInterval` the same way
// `startMaintenanceScheduler` wraps `runMaintenanceTick`.

export type BadgeKind = keyof typeof CONFIG.BADGE_THRESHOLDS;

const BADGE_PERIODS: readonly BadgePeriod[] = ['week', 'month', 'year'];

export interface BadgeAward {
  userId: number;
  kind: BadgeKind;
  value: number;
}

export interface BadgeEvaluationResult {
  period: BadgePeriod;
  periodKey: string;
  awarded: BadgeAward[];
}

export interface BadgeProgress {
  kind: BadgeKind;
  value: number;
  threshold: number;
}

interface CityRow {
  id: number;
  playable_cells: number;
}

// Same query fog.ts's loadActiveCity runs (v1 has exactly one active city,
// ACTIVE_CITY_SLUG) — duplicated here rather than imported since fog.ts
// does not export it, and this module only needs `id`/`playable_cells`.
function loadActiveCity(db: Database.Database): CityRow | null {
  return (
    db
      .prepare<[], CityRow>(`SELECT id, playable_cells FROM cities WHERE is_active = 1 LIMIT 1`)
      .get() ?? null
  );
}

interface ExplorerRow {
  user_id: number;
  cells: number;
}

// Section 7.7: `explorer` is the percent of playable city area newly
// revealed within the period, summed from `fog_daily_progress` over the
// period's days (`badgePeriodDays` — the calendar is derived once, in
// packages/shared, and never re-derived here) and divided by
// `cities.playable_cells`. A user with no rows for any of these days (never
// moved) is simply absent from the result map, i.e. implicitly 0%.
function explorerValuesByUser(
  db: Database.Database,
  cityId: number,
  playableCells: number,
  days: string[],
): Map<number, number> {
  const values = new Map<number, number>();
  if (playableCells <= 0 || days.length === 0) {
    return values;
  }
  const placeholders = days.map(() => '?').join(', ');
  const rows = db
    .prepare<unknown[], ExplorerRow>(
      `SELECT user_id, SUM(revealed_cells) AS cells FROM fog_daily_progress WHERE city_id = ? AND day IN (${placeholders}) GROUP BY user_id`,
    )
    .all(cityId, ...days);
  for (const row of rows) {
    values.set(row.user_id, (row.cells / playableCells) * 100);
  }
  return values;
}

interface BarflyRow {
  user_id: number;
  mastered: number;
}

// Section 7.7: `barfly` counts bars whose *earliest* completed visit falls
// inside the period — "a second completed visit at an already-mastered bar
// counts for nothing." The inner query finds each (user, bar)'s earliest
// completion across all time (not scoped to the period), and only that
// earliest instant is tested against the period boundary — a later repeat
// completion at the same bar never appears here at all.
function barflyValuesByUser(
  db: Database.Database,
  startS: number,
  endS: number,
): Map<number, number> {
  const values = new Map<number, number>();
  const rows = db
    .prepare<[number, number], BarflyRow>(
      `SELECT user_id, COUNT(*) AS mastered FROM (
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
    values.set(row.user_id, row.mastered);
  }
  return values;
}

interface InsertedRow {
  user_id: number;
}

// Section 7.7's stated idempotency mechanism: the `UNIQUE (user_id, kind,
// period, period_key)` constraint plus `INSERT ... ON CONFLICT DO NOTHING`,
// not a SELECT-then-INSERT check — the constraint is what does the work.
// `RETURNING` tells us which rows this call actually inserted (as opposed to
// ones that conflicted), which is how the result below reports only genuine
// new awards on a second run.
function awardCandidates(
  db: Database.Database,
  kind: BadgeKind,
  period: BadgePeriod,
  periodKey: string,
  awardedAt: number,
  values: Map<number, number>,
): BadgeAward[] {
  const threshold: number = CONFIG.BADGE_THRESHOLDS[kind][period];
  const insert = db.prepare<[number, string, string, string, number, number], InsertedRow>(
    `INSERT INTO badges (user_id, kind, period, period_key, value, awarded_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, kind, period, period_key) DO NOTHING
     RETURNING user_id`,
  );
  const awarded: BadgeAward[] = [];
  for (const [userId, value] of values) {
    if (value < threshold) {
      continue;
    }
    const row = insert.get(userId, kind, period, periodKey, value, awardedAt);
    if (row) {
      awarded.push({ userId, kind, value });
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

  const city = loadActiveCity(db);
  if (city) {
    const days = badgePeriodDays(period, periodKey);
    const explorerValues = explorerValuesByUser(db, city.id, city.playable_cells, days);
    awarded.push(...awardCandidates(db, 'explorer', period, periodKey, endS, explorerValues));
  }

  const barflyValues = barflyValuesByUser(db, startS, endS);
  awarded.push(...awardCandidates(db, 'barfly', period, periodKey, endS, barflyValues));

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

// Section 7.7's last-but-two paragraph: live "on track" progress against the
// current period's threshold, computed by this same module's per-user value
// functions so it can never disagree with the award value those same
// functions produce inside `evaluateBadges` — "a user shown 'on track' who
// then does not receive the badge is the bug this shares code to prevent."
// Unlike `evaluateBadges`, this reads the clock (via `nowMs`) because "the
// current period" is inherently a live, moving target, not a fixed key a
// caller already knows.
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
      ).get(userId) ?? 0)
    : 0;
  const barflyValue = barflyValuesByUser(db, startS, endS).get(userId) ?? 0;

  return [
    { kind: 'explorer', value: explorerValue, threshold: CONFIG.BADGE_THRESHOLDS.explorer[period] },
    { kind: 'barfly', value: barflyValue, threshold: CONFIG.BADGE_THRESHOLDS.barfly[period] },
  ];
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
