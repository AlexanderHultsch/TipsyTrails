import { describe, expect, it } from 'vitest';
import {
  badgePeriodBoundaries,
  badgePeriodDays,
  badgePeriodKey,
  berlinDateString,
  mostRecentlyClosedBadgePeriodKey,
} from './berlin-time.js';

describe('berlinDateString', () => {
  it('formats a UTC midday timestamp as the same calendar day in Berlin (CET, UTC+1)', () => {
    // 2026-01-15T12:00:00Z — well clear of local midnight either way.
    expect(berlinDateString(Date.UTC(2026, 0, 15, 12, 0, 0))).toBe('2026-01-15');
  });

  it('rolls a late-UTC timestamp into the next Berlin day during CEST (UTC+2)', () => {
    // 2026-07-01T22:30:00Z is 2026-07-02T00:30 in Berlin during summer time.
    expect(berlinDateString(Date.UTC(2026, 6, 1, 22, 30, 0))).toBe('2026-07-02');
  });

  it('defaults to the current time when called with no argument', () => {
    expect(berlinDateString()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('badgePeriodKey', () => {
  it('formats week keys zero-padded, not "2026-W5"', () => {
    // 2026-02-02 is a Monday, ISO week 6 of 2026.
    expect(badgePeriodKey('week', Date.UTC(2026, 1, 2, 12, 0, 0))).toBe('2026-W06');
  });

  it('formats month keys zero-padded, not "2026-8"', () => {
    expect(badgePeriodKey('month', Date.UTC(2026, 7, 12, 12, 0, 0))).toBe('2026-08');
  });

  it('formats year keys as the plain calendar year', () => {
    expect(badgePeriodKey('year', Date.UTC(2026, 7, 12, 12, 0, 0))).toBe('2026');
  });

  it('assigns 2027-01-01 to week 53 of the 2026 week-year, not week 1 of 2027', () => {
    // 2027-01-01 is a Friday; the ISO week-year lags the calendar year here.
    expect(badgePeriodKey('week', Date.UTC(2027, 0, 1, 12, 0, 0))).toBe('2026-W53');
  });

  it('assigns 2029-12-31 to week 1 of the 2030 week-year, not week 53 of 2029', () => {
    // 2029-12-31 is a Monday; the ISO week-year leads the calendar year here.
    expect(badgePeriodKey('week', Date.UTC(2029, 11, 31, 12, 0, 0))).toBe('2030-W01');
  });
});

describe('badgePeriodBoundaries', () => {
  it('places Europe/Berlin local midnight at 23:00 UTC in winter (CET, UTC+1)', () => {
    const { startS } = badgePeriodBoundaries('month', '2026-01');
    expect(new Date(startS * 1000).toISOString()).toBe('2025-12-31T23:00:00.000Z');
  });

  it('places Europe/Berlin local midnight at 22:00 UTC in summer (CEST, UTC+2)', () => {
    const { startS } = badgePeriodBoundaries('month', '2026-07');
    expect(new Date(startS * 1000).toISOString()).toBe('2026-06-30T22:00:00.000Z');
  });

  it('spans a week crossing the March DST transition as fewer than 168 hours', () => {
    // ISO week 13 of 2026 is 2026-03-23 to 2026-03-30 — it contains the
    // last-Sunday-of-March transition, so it is 167h, not 168h.
    const { startS, endS } = badgePeriodBoundaries('week', '2026-W13');
    expect(endS - startS).toBe(167 * 3600);
  });

  it('spans a week crossing the October DST transition as more than 168 hours', () => {
    // ISO week 43 of 2026 is 2026-10-19 to 2026-10-26 — it contains the
    // last-Sunday-of-October transition, so it is 169h, not 168h.
    const { startS, endS } = badgePeriodBoundaries('week', '2026-W43');
    expect(endS - startS).toBe(169 * 3600);
  });

  it('round-trips a period key through its own boundaries', () => {
    for (const [period, key] of [
      ['week', '2026-W32'],
      ['month', '2026-08'],
      ['year', '2026'],
    ] as const) {
      const { startS, endS } = badgePeriodBoundaries(period, key);
      expect(badgePeriodKey(period, startS * 1000)).toBe(key);
      expect(badgePeriodKey(period, endS * 1000)).not.toBe(key);
    }
  });
});

describe('badgePeriodDays', () => {
  it('lists every Berlin calendar day of an ordinary month', () => {
    const days = badgePeriodDays('month', '2026-06');
    expect(days).toHaveLength(30);
    expect(days[0]).toBe('2026-06-01');
    expect(days[days.length - 1]).toBe('2026-06-30');
  });

  it('lists 29 days for a leap February', () => {
    // 2028 is a leap year.
    const days = badgePeriodDays('month', '2028-02');
    expect(days).toHaveLength(29);
    expect(days[days.length - 1]).toBe('2028-02-29');
  });

  it('lists 28 days for a non-leap February', () => {
    expect(badgePeriodDays('month', '2026-02')).toHaveLength(28);
  });

  it('lists exactly 7 days for a week, DST transition or not', () => {
    expect(badgePeriodDays('week', '2026-W13')).toHaveLength(7);
    expect(badgePeriodDays('week', '2026-W32')).toHaveLength(7);
  });

  it('lists 365 days for a non-leap year and 366 for a leap year', () => {
    expect(badgePeriodDays('year', '2026')).toHaveLength(365);
    expect(badgePeriodDays('year', '2028')).toHaveLength(366);
  });
});

describe('mostRecentlyClosedBadgePeriodKey', () => {
  it('returns the previous week at the first instant of a new week', () => {
    const { startS } = badgePeriodBoundaries('week', '2026-W32');
    expect(mostRecentlyClosedBadgePeriodKey('week', startS * 1000)).toBe('2026-W31');
  });

  it('returns the previous month at the first instant of a new month, across a year boundary', () => {
    const { startS } = badgePeriodBoundaries('month', '2027-01');
    expect(mostRecentlyClosedBadgePeriodKey('month', startS * 1000)).toBe('2026-12');
  });

  it('returns the previous year at the first instant of a new year', () => {
    const { startS } = badgePeriodBoundaries('year', '2027');
    expect(mostRecentlyClosedBadgePeriodKey('year', startS * 1000)).toBe('2026');
  });

  it('returns the previous ISO week-year at a week-year boundary', () => {
    const { startS } = badgePeriodBoundaries('week', '2030-W01');
    expect(mostRecentlyClosedBadgePeriodKey('week', startS * 1000)).toBe('2029-W52');
  });

  it('resolves an instant one millisecond before a boundary to the period still running there', () => {
    const { startS, endS } = badgePeriodBoundaries('week', '2026-W32');
    // One ms before week 32 starts is still within week 31, so the closed period is week 30.
    expect(mostRecentlyClosedBadgePeriodKey('week', startS * 1000 - 1)).toBe('2026-W30');
    // One ms before week 32 ends is still within week 32, so the closed period is week 31.
    expect(mostRecentlyClosedBadgePeriodKey('week', endS * 1000 - 1)).toBe('2026-W31');
  });
});
