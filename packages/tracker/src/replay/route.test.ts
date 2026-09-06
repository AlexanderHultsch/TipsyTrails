// @vitest-environment node
//
// ios/SPEC.md Section 13.2, Step E's substep E1 (Section 12). This file
// reads data/seed/karlsruhe/bars.json from disk (`loadSeedBars`), so it
// needs the node environment - the same reason index.test.ts declares it.
import { CONFIG, haversineDistanceM } from '@tipsytrails/shared';
import { describe, expect, it } from 'vitest';
import {
  applyDistanceFilter,
  buildRoute,
  loadSeedBars,
  pickRouteBars,
  seededRandom,
  WALKING_SPEED_MPS,
  type SeedBar,
} from './route.js';

describe('pickRouteBars', () => {
  it('picks two real seed bars 900-1100 m apart', () => {
    const bars = loadSeedBars();
    const [a, b] = pickRouteBars(bars);
    const distanceM = haversineDistanceM(a, b);
    expect(distanceM).toBeGreaterThanOrEqual(900);
    expect(distanceM).toBeLessThanOrEqual(1100);
  });

  it('is deterministic across two calls', () => {
    const bars = loadSeedBars();
    const [a1, b1] = pickRouteBars(bars);
    const [a2, b2] = pickRouteBars(bars);
    expect(a1).toEqual(a2);
    expect(b1).toEqual(b2);
  });

  it('throws a clear error when no pair qualifies', () => {
    const bars: SeedBar[] = [
      {
        osm_id: 'node/1',
        name: 'Only Bar',
        address: null,
        lat: 49.0,
        lon: 8.4,
        cell_index: 0,
        source: 'osm',
      },
    ];
    expect(() => pickRouteBars(bars)).toThrow(/no pair of seed bars/);
  });
});

describe('buildRoute', () => {
  const from = { lat: 49.0, lon: 8.4 };
  const to = { lat: 49.009, lon: 8.4 };
  const startMs = 1_700_000_000_000;

  it('produces floor(distance / speed) + 1 fixes', () => {
    const distanceM = haversineDistanceM(from, to);
    const expectedCount = Math.floor(distanceM / WALKING_SPEED_MPS) + 1;
    const route = buildRoute({ from, to, startMs, speedMps: WALKING_SPEED_MPS, seed: 1 });
    expect(route).toHaveLength(expectedCount);
  });

  it('starts at from and ends exactly at to', () => {
    const route = buildRoute({ from, to, startMs, speedMps: WALKING_SPEED_MPS, seed: 1 });
    expect(route[0].lat).toBeCloseTo(from.lat, 9);
    expect(route[0].lon).toBeCloseTo(from.lon, 9);
    const last = route.at(-1)!;
    expect(last.lat).toBeCloseTo(to.lat, 9);
    expect(last.lon).toBeCloseTo(to.lon, 9);
  });

  it('advances the timestamp by exactly 1000 ms per fix', () => {
    const route = buildRoute({ from, to, startMs, speedMps: WALKING_SPEED_MPS, seed: 1 });
    for (let i = 0; i < route.length; i++) {
      expect(route[i].timestamp).toBe(startMs + i * 1000);
    }
  });

  it('jitters every accuracy within [5, 25]', () => {
    const route = buildRoute({ from, to, startMs, speedMps: WALKING_SPEED_MPS, seed: 42 });
    for (const fix of route) {
      expect(fix.accuracy).toBeGreaterThanOrEqual(5);
      expect(fix.accuracy).toBeLessThan(25);
    }
  });

  it('is identical across two calls with the same seed', () => {
    const routeA = buildRoute({ from, to, startMs, speedMps: WALKING_SPEED_MPS, seed: 7 });
    const routeB = buildRoute({ from, to, startMs, speedMps: WALKING_SPEED_MPS, seed: 7 });
    expect(routeA).toEqual(routeB);
  });

  it('gives a different accuracy sequence for a different seed', () => {
    const routeA = buildRoute({ from, to, startMs, speedMps: WALKING_SPEED_MPS, seed: 1 });
    const routeB = buildRoute({ from, to, startMs, speedMps: WALKING_SPEED_MPS, seed: 2 });
    expect(routeA.map((fix) => fix.accuracy)).not.toEqual(routeB.map((fix) => fix.accuracy));
  });
});

describe('seededRandom', () => {
  it('produces values in [0, 1)', () => {
    const random = seededRandom(123);
    for (let i = 0; i < 100; i++) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('is deterministic for the same seed', () => {
    const a = seededRandom(9);
    const b = seededRandom(9);
    const seqA = Array.from({ length: 5 }, () => a());
    const seqB = Array.from({ length: 5 }, () => b());
    expect(seqA).toEqual(seqB);
  });
});

describe('applyDistanceFilter', () => {
  const from = { lat: 49.0, lon: 8.4 };
  const to = { lat: 49.009, lon: 8.4 };
  const startMs = 1_700_000_000_000;
  const route = buildRoute({ from, to, startMs, speedMps: WALKING_SPEED_MPS, seed: 5 });

  it('keeps every fix when the filter is 0', () => {
    const kept = applyDistanceFilter(route, 0);
    expect(kept).toEqual(route);
  });

  it('keeps the first fix and every kept pair at least distanceFilterM apart', () => {
    const filterM = CONFIG.TRACKER_WALKING_DISTANCE_FILTER_M;
    const kept = applyDistanceFilter(route, filterM);
    expect(kept[0]).toEqual(route[0]);
    for (let i = 1; i < kept.length; i++) {
      expect(haversineDistanceM(kept[i - 1], kept[i])).toBeGreaterThanOrEqual(filterM);
    }
  });
});
