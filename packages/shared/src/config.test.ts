import { describe, expect, it } from 'vitest';
import { CONFIG, DERIVED } from './config.js';

describe('DERIVED', () => {
  it('converts VISIT_REQUIRED_MS to seconds', () => {
    expect(DERIVED.VISIT_REQUIRED_S).toBe(1200);
  });

  it('converts VISIT_EXPIRY_MS to seconds', () => {
    expect(DERIVED.VISIT_EXPIRY_S).toBe(21600);
  });

  it('converts VISIT_PUSH_AFTER_MS to seconds', () => {
    expect(DERIVED.VISIT_PUSH_AFTER_S).toBe(1260);
  });

  it('converts SESSION_TTL_DAYS to seconds', () => {
    expect(DERIVED.SESSION_TTL_S).toBe(7776000);
  });

  it('converts SESSION_REFRESH_THRESHOLD_DAYS to seconds', () => {
    expect(DERIVED.SESSION_REFRESH_THRESHOLD_S).toBe(2592000);
  });

  it('pushes the reminder after the visit could already have completed', () => {
    expect(DERIVED.VISIT_PUSH_AFTER_S).toBeGreaterThan(DERIVED.VISIT_REQUIRED_S);
  });
});

describe('CONFIG.BADGE_KINDS', () => {
  it('is the two kinds of Section 7.7, in the order a badge shelf draws', () => {
    expect(CONFIG.BADGE_KINDS).toEqual(['explorer', 'barfly']);
  });

  // SPEC.md Sections 7.1 and 7.7. The kinds are the whole of what
  // this file may say about badges: the floors behind them are numbers a
  // client may not be given, and they live in server-config.ts, which
  // packages/web cannot import. A floor put back here would be bundled into
  // the browser the same day - CONFIG is one object literal and the web
  // imports it as a value - which is the leak this split closed in v1.54.
  it('carries no floor, and neither does anything else in CONFIG', () => {
    expect(CONFIG).not.toHaveProperty('BADGE_THRESHOLDS');
    // A floor is a number keyed by a period. No client-safe constant is, so
    // this catches the floors coming back under any other name.
    expect(JSON.stringify(CONFIG)).not.toMatch(/"(week|month|year)":/);
  });
});

describe('CONFIG radii', () => {
  it('keeps the on-site radius within the discovery radius', () => {
    expect(CONFIG.BAR_ONSITE_RADIUS_M).toBeLessThanOrEqual(CONFIG.BAR_DISCOVERY_RADIUS_M);
  });

  // SPEC.md Section 7.5 step 1. Pinned to the values the spec states, the
  // same way server-config.ts's floors are: the pair is the product decision —
  // 30 m with a good fix, 50 m at worst — and it was 50 and 50, reaching
  // 100 m, which is a street of bars in Karlsruhe's centre.
  it('matches the spec values for the check-in radius and its accuracy tolerance', () => {
    expect(CONFIG.BAR_ONSITE_RADIUS_M).toBe(30);
    expect(CONFIG.BAR_ACCURACY_TOLERANCE_M).toBe(20);
  });

  // The tolerance exists so that a poor fix does not make check-in
  // impossible, not so that a poor fix buys a bigger bar. Section 7.5's
  // separability property is what this protects: two neighbours a few metres
  // apart stay separable however bad the fix is.
  it('cannot let the tolerance grow the radius past the discovery radius', () => {
    expect(CONFIG.BAR_ONSITE_RADIUS_M + CONFIG.BAR_ACCURACY_TOLERANCE_M).toBeLessThanOrEqual(
      CONFIG.BAR_DISCOVERY_RADIUS_M,
    );
  });
});

describe('CONFIG.FOG_REVEAL_ANIMATION_MS', () => {
  it('matches the spec value', () => {
    expect(CONFIG.FOG_REVEAL_ANIMATION_MS).toBe(600);
  });
});
