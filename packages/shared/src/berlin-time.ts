// Europe/Berlin local-day helper. SPEC.md Section 5.5 keys
// `fog_daily_progress.day` by the Europe/Berlin local calendar day, and
// Section 7.7 later needs the same timezone for badge period boundaries —
// "There is one helper for this in packages/shared; no route computes period
// boundaries itself." This is that helper's day-granularity building block.

/**
 * The Europe/Berlin local calendar day containing `atMs`, as 'YYYY-MM-DD'.
 * `Intl.DateTimeFormat('en-CA', ...)` formats dates as ISO-8601
 * (YYYY-MM-DD) by locale convention, which avoids hand-rolling timezone
 * arithmetic against the IANA database Node already ships with.
 */
export function berlinDateString(atMs: number = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date(atMs));
}

// ---------------------------------------------------------------------------
// Badge periods (SPEC.md Section 5.8, 7.7, 7.9).
//
// A period boundary is Europe/Berlin local midnight. Below that boundary,
// two kinds of arithmetic are kept strictly apart:
//
// - Finding *which instant* a local midnight falls on has to account for
//   DST, so it goes through `berlinOffsetMinutes`, which reads the offset
//   out of `Intl.DateTimeFormat` (the IANA database Node ships with) rather
//   than hand-rolling a transition table — the same precedent
//   `berlinDateString` sets.
// - Once a boundary is expressed as a plain (year, month, day) calendar
//   triple, walking to the next day/week/month/year is pure calendar
//   arithmetic and deliberately never touches a real timezone: it is done
//   on a UTC "vehicle" Date (`utcVehicleMs`/`fromUtcVehicleMs`) purely
//   because `Date.UTC` normalizes overflowing fields (day 32 rolls into
//   next month) without any DST to confuse it. A UTC day is always exactly
//   24h, which is what makes it safe to use as scratch space for calendar
//   math even though the Berlin day it represents may be 23 or 25 hours.
// ---------------------------------------------------------------------------

// The three periods, shortest first, and the union derived from the tuple
// rather than written twice. Section 7.7's "two kinds, three periods" needs a
// runtime list as well as a type - the badge catalogue (badges.ts) enumerates
// every period, and the profile lists the player's value for each - and a
// hand-written array beside a hand-written union is two places to add a
// fourth period, of which only one fails to compile. Ordering is load-bearing
// where the list is rendered: it ascends week -> month -> year.
export const BADGE_PERIODS = ['week', 'month', 'year'] as const;

export type BadgePeriod = (typeof BADGE_PERIODS)[number];

export interface BadgePeriodBoundaries {
  startS: number;
  endS: number;
}

interface CalendarDate {
  y: number;
  m: number; // 1-12
  d: number;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function utcVehicleMs(y: number, m: number, d: number): number {
  return Date.UTC(y, m - 1, d);
}

function fromUtcVehicleMs(ms: number): CalendarDate {
  const dt = new Date(ms);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function addDaysUtc(date: CalendarDate, days: number): CalendarDate {
  return fromUtcVehicleMs(utcVehicleMs(date.y, date.m, date.d) + days * 86400000);
}

/**
 * Europe/Berlin's UTC offset, in minutes, at `atMs` — read from
 * `Intl.DateTimeFormat`'s `shortOffset` (e.g. 'GMT+1', 'GMT+2') rather than
 * a hand-rolled DST table, following `berlinDateString`'s precedent.
 */
function berlinOffsetMinutes(atMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Berlin',
    timeZoneName: 'shortOffset',
  }).formatToParts(new Date(atMs));
  const offset = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+0';
  const match = /GMT([+-]\d+)/.exec(offset);
  return match ? Number(match[1]) * 60 : 0;
}

/**
 * The UTC instant, in milliseconds, of Europe/Berlin local midnight at the
 * start of calendar day (y, m, d). Berlin's offset only ever changes at
 * 01:00/02:00 UTC (never at UTC midnight itself), so the offset read at the
 * UTC-midnight guess already equals the offset in effect at the true
 * Berlin-midnight instant — one lookup is enough, no iteration needed.
 */
function berlinMidnightUtcMs(date: CalendarDate): number {
  const guessMs = utcVehicleMs(date.y, date.m, date.d);
  return guessMs - berlinOffsetMinutes(guessMs) * 60000;
}

/**
 * The ISO-8601 week-year and week number containing calendar day (y, m, d)
 * (SPEC.md Section 5.8: Monday-based weeks, week 1 contains the first
 * Thursday of the year). The week-year can differ from the calendar year at
 * both ends — e.g. 2027-01-01 is week 53 of 2026, 2029-12-31 is week 1 of
 * 2030 — which is why this returns its own `isoYear` rather than reusing
 * `y`. Standard algorithm: shift to the Thursday of the same week, then
 * count weeks from that Thursday's year's start.
 */
function isoWeekOf(y: number, m: number, d: number): { isoYear: number; isoWeek: number } {
  const date = new Date(utcVehicleMs(y, m, d));
  const dayNum = date.getUTCDay() || 7; // Monday = 1 ... Sunday = 7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const isoYear = date.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const isoWeek = Math.ceil(((date.getTime() - yearStart) / 86400000 + 1) / 7);
  return { isoYear, isoWeek };
}

/** The Monday (as a calendar date) that starts ISO week `isoWeek` of `isoYear`. */
function isoWeekMonday(isoYear: number, isoWeek: number): CalendarDate {
  const jan4 = new Date(utcVehicleMs(isoYear, 1, 4));
  const jan4DayNum = jan4.getUTCDay() || 7; // Monday = 1 ... Sunday = 7
  const week1Monday = addDaysUtc({ y: isoYear, m: 1, d: 4 }, -(jan4DayNum - 1));
  return addDaysUtc(week1Monday, (isoWeek - 1) * 7);
}

function parsePeriodKey(period: BadgePeriod, periodKey: string): CalendarDate {
  if (period === 'week') {
    const match = /^(\d{4})-W(\d{2})$/.exec(periodKey);
    if (!match) throw new Error(`Invalid week period key: '${periodKey}'`);
    return isoWeekMonday(Number(match[1]), Number(match[2]));
  }
  if (period === 'month') {
    const match = /^(\d{4})-(\d{2})$/.exec(periodKey);
    if (!match) throw new Error(`Invalid month period key: '${periodKey}'`);
    return { y: Number(match[1]), m: Number(match[2]), d: 1 };
  }
  const match = /^(\d{4})$/.exec(periodKey);
  if (!match) throw new Error(`Invalid year period key: '${periodKey}'`);
  return { y: Number(match[1]), m: 1, d: 1 };
}

/** The first calendar day of the period immediately after the one starting at `start`. */
function nextPeriodStart(period: BadgePeriod, start: CalendarDate): CalendarDate {
  if (period === 'week') return addDaysUtc(start, 7);
  if (period === 'month')
    return start.m === 12 ? { y: start.y + 1, m: 1, d: 1 } : { y: start.y, m: start.m + 1, d: 1 };
  return { y: start.y + 1, m: 1, d: 1 };
}

/**
 * The badge period key (SPEC.md Section 5.8's `badges.period_key` formats:
 * `'2026-W32'`, `'2026-08'`, `'2026'`) of the period containing `atMs`. Week
 * numbers and months are zero-padded to two digits, matching the spec's
 * examples exactly, since step 2 compares these keys for equality.
 */
export function badgePeriodKey(period: BadgePeriod, atMs: number = Date.now()): string {
  const [y, m, d] = berlinDateString(atMs).split('-').map(Number);
  if (period === 'week') {
    const { isoYear, isoWeek } = isoWeekOf(y, m, d);
    return `${isoYear}-W${pad2(isoWeek)}`;
  }
  if (period === 'month') return `${y}-${pad2(m)}`;
  return `${y}`;
}

/**
 * The boundaries of `periodKey`, as a half-open `[startS, endS)` range of
 * UTC seconds (the database's unit, CLAUDE.md's unit rule — this helper
 * never returns milliseconds). Half-open because it matches how the step 2
 * queries want to filter rows (`col >= startS AND col < endS`) and because
 * it composes cleanly: `endS` of one period is exactly `startS` of the
 * next, with no gap and no instant belonging to both.
 */
export function badgePeriodBoundaries(
  period: BadgePeriod,
  periodKey: string,
): BadgePeriodBoundaries {
  const start = parsePeriodKey(period, periodKey);
  const end = nextPeriodStart(period, start);
  return {
    startS: Math.floor(berlinMidnightUtcMs(start) / 1000),
    endS: Math.floor(berlinMidnightUtcMs(end) / 1000),
  };
}

/**
 * The Europe/Berlin local calendar days (`berlinDateString`'s 'YYYY-MM-DD'
 * format) that `periodKey` covers. Section 7.7's `explorer` badge sums
 * `fog_daily_progress` over exactly these days, so this lets step 2 look
 * them up without re-deriving the calendar itself.
 */
export function badgePeriodDays(period: BadgePeriod, periodKey: string): string[] {
  const { endS } = badgePeriodBoundaries(period, periodKey);
  const days: string[] = [];
  let day = parsePeriodKey(period, periodKey);
  while (Math.floor(berlinMidnightUtcMs(day) / 1000) < endS) {
    days.push(`${day.y}-${pad2(day.m)}-${pad2(day.d)}`);
    day = addDaysUtc(day, 1);
  }
  return days;
}

/**
 * The period key of the most recently *closed* period of `period` at
 * `atMs` — the period immediately before the one currently running.
 * Section 7.9's boot catch-up needs this to award badges for a period that
 * closed while the process was down. Computed by stepping one millisecond
 * before the current period's start rather than by decrementing week/month/
 * year fields directly, so the same logic handles every ISO week-year edge
 * case `badgePeriodKey`/`badgePeriodBoundaries` already handle.
 */
export function mostRecentlyClosedBadgePeriodKey(
  period: BadgePeriod,
  atMs: number = Date.now(),
): string {
  const currentKey = badgePeriodKey(period, atMs);
  const { startS } = badgePeriodBoundaries(period, currentKey);
  return badgePeriodKey(period, startS * 1000 - 1);
}
