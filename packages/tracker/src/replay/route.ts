// ios/SPEC.md Section 13.2: the synthetic route the replay harness walks -
// two seed bars about a kilometre apart, a straight-line walk between them
// at a fixed speed, one fix per second, accuracy jittered by a seeded
// generator, and the distance filter scenario 2 needs to apply Core
// Location's own throttle to the fixes before they reach the harness.
//
// Every duration here is milliseconds and every distance metres, matching
// `@tipsytrails/shared`'s `CONFIG` convention (CLAUDE.md), but the numbers
// below are NOT `config.ts` material: they are this harness's own fixture
// parameters - how far apart the two picked bars must be, and how wide the
// accuracy jitter is - not a threshold the tracker's own logic applies. They
// stay named consts in this module, the same way
// `packages/tracker/src/ios-swift.test.ts` keeps its own test-only
// tolerances (`RADIUS_MARGIN_M` and friends) out of `config.ts`.
import { readFileSync } from 'node:fs';
import { haversineDistanceM } from '@tipsytrails/shared';
import type { LatLon } from '@tipsytrails/shared';
import type { Sample } from '../events.js';

// A route is simply the samples that walk it.
export type RouteFix = Sample;

// One entry of data/seed/karlsruhe/bars.json - only the fields this module
// uses.
export interface SeedBar {
  osm_id: string;
  name: string;
  address: string | null;
  lat: number;
  lon: number;
  cell_index: number;
  source: string;
}

// 13.2's own words: "about a kilometre apart". These bounds pick the pair,
// they do not gate anything the tracker does.
const ROUTE_BAR_MIN_DISTANCE_M = 900;
const ROUTE_BAR_MAX_DISTANCE_M = 1100;

// 13.2: "a straight-line route between them at 1.3 m/s".
export const WALKING_SPEED_MPS = 1.3;

// 13.2: "a fix per second with accuracy jittered between 5 and 25 m".
const ACCURACY_JITTER_MIN_M = 5;
const ACCURACY_JITTER_MAX_M = 25;

// The same technique `packages/api/src/routes/static-data.test.ts` uses to
// reach `data/seed` from a package four directories below the repository
// root.
export function loadSeedBars(): SeedBar[] {
  const path = new URL('../../../../data/seed/karlsruhe/bars.json', import.meta.url);
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw) as SeedBar[];
}

// Deterministic and id-free: the first pair, in file order, whose distance
// falls in [ROUTE_BAR_MIN_DISTANCE_M, ROUTE_BAR_MAX_DISTANCE_M]. Two calls
// against the same array return the same pair, and nothing here depends on
// which two bars they happen to be.
export function pickRouteBars(bars: SeedBar[]): [SeedBar, SeedBar] {
  for (let i = 0; i < bars.length; i++) {
    for (let j = i + 1; j < bars.length; j++) {
      const distanceM = haversineDistanceM(bars[i], bars[j]);
      if (distanceM >= ROUTE_BAR_MIN_DISTANCE_M && distanceM <= ROUTE_BAR_MAX_DISTANCE_M) {
        return [bars[i], bars[j]];
      }
    }
  }
  throw new Error(
    `no pair of seed bars is between ${ROUTE_BAR_MIN_DISTANCE_M} and ${ROUTE_BAR_MAX_DISTANCE_M} metres apart`,
  );
}

// mulberry32. No precedent in this repository for a seeded PRNG; this is a
// small, well-known one, written out rather than pulled in as a dependency,
// with no consequence outside this replay harness.
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BuildRouteOptions {
  from: LatLon;
  to: LatLon;
  startMs: number;
  speedMps: number;
  seed: number;
}

// One fix per second at speedMps along the straight line from `from` to
// `to`, positions interpolated linearly in lat/lon (fine at this scale -
// 13.2's route is about a kilometre). Fix count is
// floor(distanceM / speedMps) + 1: that many one-second steps cover the
// distance at the given speed, plus the fix at time zero. The last fix
// (i === steps) always has t === 1, so it lands exactly on `to` whatever the
// remainder of the division was - the harness does not need a fix precisely
// every metre, only that the walk ends where 13.2 says it does.
export function buildRoute(options: BuildRouteOptions): Sample[] {
  const { from, to, startMs, speedMps, seed } = options;
  const distanceM = haversineDistanceM(from, to);
  const steps = Math.floor(distanceM / speedMps);
  const random = seededRandom(seed);
  const route: Sample[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 1 : i / steps;
    const accuracy =
      ACCURACY_JITTER_MIN_M + random() * (ACCURACY_JITTER_MAX_M - ACCURACY_JITTER_MIN_M);
    route.push({
      lat: from.lat + (to.lat - from.lat) * t,
      lon: from.lon + (to.lon - from.lon) * t,
      accuracy,
      speed: speedMps,
      timestamp: startMs + i * 1000,
    });
  }
  return route;
}

// 13.2 scenario 2: what Core Location's own `distanceFilter` would do to
// this route before it ever reaches the tracker - the first fix is always
// kept, and every fix after it is kept only once it is at least
// `distanceFilterM` from the last KEPT fix. `0` keeps every fix, because
// every distance is at least zero.
export function applyDistanceFilter(route: Sample[], distanceFilterM: number): Sample[] {
  if (route.length === 0) {
    return [];
  }
  const kept: Sample[] = [route[0]];
  let last = route[0];
  for (let i = 1; i < route.length; i++) {
    const fix = route[i];
    if (haversineDistanceM(last, fix) >= distanceFilterM) {
      kept.push(fix);
      last = fix;
    }
  }
  return kept;
}
