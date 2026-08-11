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
  it('adds the accuracy in full when it is under the tolerance', () => {
    expect(onsiteRadiusM(20)).toBe(CONFIG.BAR_ONSITE_RADIUS_M + 20);
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
    const far = eastOf(SCHLOSS, 40);
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
