import { describe, expect, it } from 'vitest';
import { CONFIG, DERIVED } from './config.js';
import type { LatLon } from './grid.js';
import {
  isOnSite,
  isVisitComplete,
  isVisitExpired,
  onsiteCandidates,
  onsiteRadiusM,
} from './visits.js';

// Karlsruhe Schloss (SPEC.md's own worked example, also used by
// packages/api/src/routes/bars.test.ts), with a second point due east of it
// at a precisely known distance, computed the same way bars.test.ts's
// `offsetMeters` does — a local equirectangular approximation, adequate at
// this scale and independent of `haversineDistanceM`'s own implementation.
const SCHLOSS: LatLon = { lat: 49.0135, lon: 8.4044 };
function mPerDegLon(lat: number): number {
  return 111320 * Math.cos((lat * Math.PI) / 180);
}
function eastOf(base: LatLon, distanceM: number): LatLon {
  return { lat: base.lat, lon: base.lon + distanceM / mPerDegLon(base.lat) };
}

describe('onsiteRadiusM', () => {
  // 5 m, not 20: the tolerance is 20 since v1.26, so an accuracy of 20 is
  // the cap this asserts is *not* being applied and the case below already
  // covers it. The number has to stay strictly under BAR_ACCURACY_TOLERANCE_M
  // for this test to be about the uncapped branch at all.
  it('adds the accuracy in full when it is under the tolerance', () => {
    expect(5).toBeLessThan(CONFIG.BAR_ACCURACY_TOLERANCE_M);
    expect(onsiteRadiusM(5)).toBe(CONFIG.BAR_ONSITE_RADIUS_M + 5);
  });

  // SPEC.md Section 7.5 step 1: the tolerance keeps a poor fix from making
  // check-in impossible; it does not let one grow the radius without bound.
  // Section 7.4's discovery radius is the ceiling, so a bar close enough to
  // check into is always one the player could have discovered.
  it('never reaches the discovery radius, however bad the fix', () => {
    expect(onsiteRadiusM(Number.MAX_SAFE_INTEGER)).toBeLessThanOrEqual(
      CONFIG.BAR_DISCOVERY_RADIUS_M,
    );
  });

  it('caps the addition at BAR_ACCURACY_TOLERANCE_M for an accuracy above it', () => {
    expect(onsiteRadiusM(CONFIG.BAR_ACCURACY_TOLERANCE_M + 500)).toBe(
      CONFIG.BAR_ONSITE_RADIUS_M + CONFIG.BAR_ACCURACY_TOLERANCE_M,
    );
  });

  it('adds the full tolerance at exactly the tolerance', () => {
    expect(onsiteRadiusM(CONFIG.BAR_ACCURACY_TOLERANCE_M)).toBe(
      CONFIG.BAR_ONSITE_RADIUS_M + CONFIG.BAR_ACCURACY_TOLERANCE_M,
    );
  });
});

describe('isOnSite', () => {
  it('accepts a position at the radius boundary', () => {
    const bar = eastOf(SCHLOSS, 50);
    expect(isOnSite(SCHLOSS, bar, 50)).toBe(true);
  });

  it('rejects a position just past the radius boundary', () => {
    const bar = eastOf(SCHLOSS, 51);
    expect(isOnSite(SCHLOSS, bar, 50)).toBe(false);
  });
});

describe('onsiteCandidates', () => {
  it('returns candidates within the accuracy-derived radius, sorted by ascending distance', () => {
    const near = eastOf(SCHLOSS, 10);
    // 30 m, not the 40 this used to be: with the radii of v1.26 a 10 m fix
    // gives a 40 m radius, so the old fixture sat exactly on the boundary and
    // this test — which is about ordering, not about the boundary — would
    // have become hostage to whether `isOnSite` compares with `<=` or `<`.
    // The boundary has its own test above.
    const far = eastOf(SCHLOSS, 30);
    const outOfRange = eastOf(SCHLOSS, 200);

    const result = onsiteCandidates(SCHLOSS, 10, [
      { ...far, id: 'far' },
      { ...near, id: 'near' },
      { ...outOfRange, id: 'outOfRange' },
    ]);

    expect(result.map((c) => c.bar.id)).toEqual(['near', 'far']);
    expect(result[0].distanceM).toBeLessThan(result[1].distanceM);
  });

  it('returns nothing when no bar is within range', () => {
    const outOfRange = eastOf(SCHLOSS, 200);
    expect(onsiteCandidates(SCHLOSS, 10, [{ ...outOfRange, id: 'outOfRange' }])).toEqual([]);
  });
});

describe('isVisitComplete', () => {
  const minSamples = CONFIG.VISIT_MIN_ONSITE_SAMPLES;

  it('is false just below VISIT_REQUIRED_S', () => {
    expect(isVisitComplete(DERIVED.VISIT_REQUIRED_S - 1, minSamples)).toBe(false);
  });

  it('is true at exactly VISIT_REQUIRED_S with enough samples', () => {
    expect(isVisitComplete(DERIVED.VISIT_REQUIRED_S, minSamples)).toBe(true);
  });

  it('is false one sample short of VISIT_MIN_ONSITE_SAMPLES even with enough elapsed time', () => {
    expect(isVisitComplete(DERIVED.VISIT_REQUIRED_S, minSamples - 1)).toBe(false);
  });

  it('is true with more than enough time and samples', () => {
    expect(isVisitComplete(DERIVED.VISIT_REQUIRED_S + 60, minSamples + 1)).toBe(true);
  });
});

describe('isVisitExpired', () => {
  const startS = 1_000_000;

  it('is false just below VISIT_EXPIRY_S', () => {
    expect(isVisitExpired(startS + DERIVED.VISIT_EXPIRY_S - 1, startS)).toBe(false);
  });

  it('is true at exactly VISIT_EXPIRY_S', () => {
    expect(isVisitExpired(startS + DERIVED.VISIT_EXPIRY_S, startS)).toBe(true);
  });

  it('is true well past VISIT_EXPIRY_S', () => {
    expect(isVisitExpired(startS + DERIVED.VISIT_EXPIRY_S + 3600, startS)).toBe(true);
  });
});
