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
