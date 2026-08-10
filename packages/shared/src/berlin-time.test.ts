import { describe, expect, it } from 'vitest';
import { berlinDateString } from './berlin-time.js';

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
