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

describe('CONFIG.BADGE_THRESHOLDS', () => {
  it('matches the spec values for explorer', () => {
    expect(CONFIG.BADGE_THRESHOLDS.explorer.week).toBe(0.1);
    expect(CONFIG.BADGE_THRESHOLDS.explorer.month).toBe(0.3);
    expect(CONFIG.BADGE_THRESHOLDS.explorer.year).toBe(2.0);
  });

  it('matches the spec values for barfly', () => {
    expect(CONFIG.BADGE_THRESHOLDS.barfly.week).toBe(1);
    expect(CONFIG.BADGE_THRESHOLDS.barfly.month).toBe(2);
    expect(CONFIG.BADGE_THRESHOLDS.barfly.year).toBe(3);
  });

  it('never demands more of a shorter period than a longer one', () => {
    for (const badge of [CONFIG.BADGE_THRESHOLDS.explorer, CONFIG.BADGE_THRESHOLDS.barfly]) {
      expect(badge.week).toBeLessThanOrEqual(badge.month);
      expect(badge.month).toBeLessThanOrEqual(badge.year);
    }
  });
});

describe('CONFIG radii', () => {
  it('keeps the on-site radius within the discovery radius', () => {
    expect(CONFIG.BAR_ONSITE_RADIUS_M).toBeLessThanOrEqual(CONFIG.BAR_DISCOVERY_RADIUS_M);
  });

  // SPEC.md Section 7.5 step 1. Pinned to the values the spec states, the
  // same way BADGE_THRESHOLDS above is: the pair is the product decision —
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
