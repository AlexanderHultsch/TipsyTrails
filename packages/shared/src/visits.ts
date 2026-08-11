// Check-in and mastering rules (SPEC.md Section 7.5).
//
// Pure and side-effect free, in the same spirit as `grid.ts` — no network,
// no database, no Fastify — so `routes/visits.ts` (Phase 5 step 1), the
// sample handler's visit updates (step 2) and the maintenance tick (step 3)
// can all share one implementation of what "on-site" and "complete" mean
// instead of drifting apart across three call sites.
//
// Every threshold comes from `CONFIG`/`DERIVED` (CLAUDE.md forbids inlining
// any of them), and every time value this module takes or returns is
// seconds, matching the database (CLAUDE.md's unit rule) — this module never
// converts milliseconds.

import { CONFIG, DERIVED } from './config.js';
import { haversineDistanceM, type LatLon } from './grid.js';

/**
 * The on-site radius for a sample of the given accuracy (SPEC.md Section
 * 7.5 step 1): the base radius plus the accuracy tolerance, capped by the
 * accuracy itself rather than added in full — a wildly inaccurate sample
 * does not buy a wildly larger radius.
 */
export function onsiteRadiusM(accuracyM: number): number {
  return CONFIG.BAR_ONSITE_RADIUS_M + Math.min(accuracyM, CONFIG.BAR_ACCURACY_TOLERANCE_M);
}

/** Whether `position` lies within `radiusM` of `bar`. */
export function isOnSite(position: LatLon, bar: LatLon, radiusM: number): boolean {
  return haversineDistanceM(position, bar) <= radiusM;
}

export interface OnsiteCandidate<T extends LatLon> {
  bar: T;
  distanceM: number;
}

/**
 * The candidate bars `position` is on-site for, given `accuracyM`, sorted
 * by ascending distance (SPEC.md Section 7.5 step 1: "if several qualify,
 * they are listed sorted by distance and the user picks one").
 */
export function onsiteCandidates<T extends LatLon>(
  position: LatLon,
  accuracyM: number,
  bars: readonly T[],
): OnsiteCandidate<T>[] {
  const radiusM = onsiteRadiusM(accuracyM);
  const candidates: OnsiteCandidate<T>[] = [];
  for (const bar of bars) {
    const distanceM = haversineDistanceM(position, bar);
    if (distanceM <= radiusM) {
      candidates.push({ bar, distanceM });
    }
  }
  return candidates.sort((a, b) => a.distanceM - b.distanceM);
}

/**
 * Whether a pending visit is complete (SPEC.md Section 7.5 step 4): both
 * the confirmed duration and the on-site sample count must have reached
 * their minimums.
 */
export function isVisitComplete(confirmedS: number, onsiteSamples: number): boolean {
  return confirmedS >= DERIVED.VISIT_REQUIRED_S && onsiteSamples >= CONFIG.VISIT_MIN_ONSITE_SAMPLES;
}

/**
 * Whether a pending visit has expired (SPEC.md Section 7.5 step 5): no
 * on-site sample for `VISIT_EXPIRY_S` since the last accepted one.
 */
export function isVisitExpired(nowS: number, lastSampleAtS: number): boolean {
  return nowS - lastSampleAtS >= DERIVED.VISIT_EXPIRY_S;
}
