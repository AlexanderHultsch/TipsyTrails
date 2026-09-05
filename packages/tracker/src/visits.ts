// ios/SPEC.md Section 7.6: the tracker's set of pending visits, and the
// question it exists to answer - is the player standing at a bar they have
// checked into. This is substep B4: the structure and its rules only. It
// holds no `Host` and calls no API - a structure that fetches is a
// structure that cannot be tested without a fake network, and everything
// here is decidable from its own state. B5 builds the state machine that
// reads `isDwelling` and calls `getBar` (`api.ts`) for the bar ids
// `barsNeedingPosition` names; B6 builds the flush that feeds
// `applyVisitUpdates`. This file follows `queue.ts`'s own idiom: a mutable
// structure plus functions over it, no class.
import { CONFIG, isOnSite } from '@tipsytrails/shared';
import type { LatLon } from '@tipsytrails/shared';
import type { Counters } from './counters.js';
import type { VisitSummary } from './events.js';

/**
 * Two maps, and the separation between them is the design.
 *
 * `barPositions` is deliberately three-valued and the third value is the
 * point:
 * - a bar id ABSENT from the map means "not asked yet" - B5 will fetch it
 *   with `getBar`;
 * - a bar id present with a `LatLon` means known;
 * - a bar id present with `null` means asked, and the server would not say
 *   (`SPEC.md` 9.5 gives `GET /api/bars/:id` one deliberately identical 404
 *   for "no such bar" and "not discovered by you"; the realistic cause is
 *   an admin hiding the bar). That is an answer, not a failure, and
 *   recording it stops the tracker asking again on every start for a bar
 *   the server will never describe.
 */
export interface VisitSet {
  pending: Map<number, VisitSummary>;
  barPositions: Map<number, LatLon | null>;
}

export function createVisitSet(): VisitSet {
  return { pending: new Map(), barPositions: new Map() };
}

/**
 * `GET /api/visits/pending`'s answer (ios/SPEC.md 7.3/7.6). This REPLACES
 * the pending map rather than merging into it: that endpoint is the only
 * source that can say a visit ended for a reason no client saw, so a visit
 * it does not list is a visit that is over. It PRESERVES `barPositions` - a
 * bar does not move, and re-fetching a position the tracker already holds
 * would waste the one request this design exists to avoid.
 *
 * Returns the ids that were pending before this call and are not in the new
 * seed - ios/SPEC.md 7.7 needs these to cancel their reminders, since a
 * visit this endpoint stops listing is a visit that ended for a reason no
 * flush ever reported.
 */
export function seedPending(set: VisitSet, visits: VisitSummary[]): number[] {
  const seededIds = new Set(visits.map((visit) => visit.id));
  const removedIds = [...set.pending.keys()].filter((id) => !seededIds.has(id));
  set.pending = new Map(visits.map((visit) => [visit.id, visit]));
  return removedIds;
}

/**
 * A flush's `visitUpdates` (ios/SPEC.md 7.4/7.6): `pending` adds or
 * refreshes, and `completed`, `expired` and `cancelled` remove. Increments
 * `counters.results.visitsCompleted` once per entry whose status is
 * `completed` - not once per call.
 *
 * Returns what left and entered the set, for ios/SPEC.md 7.7's reminder:
 * `entered` is every `pending` update for an id not already in the set
 * (a refresh of an id already pending is neither), and `left` is the id of
 * every non-`pending` update for an id that WAS in the set - an update
 * naming an id this set never held is not something leaving it.
 */
export function applyVisitUpdates(
  set: VisitSet,
  updates: VisitSummary[],
  counters: Counters,
): { entered: VisitSummary[]; left: number[] } {
  const entered: VisitSummary[] = [];
  const left: number[] = [];
  for (const update of updates) {
    if (update.status === 'pending') {
      if (!set.pending.has(update.id)) {
        entered.push(update);
      }
      set.pending.set(update.id, update);
      continue;
    }
    if (set.pending.has(update.id)) {
      left.push(update.id);
    }
    set.pending.delete(update.id);
    if (update.status === 'completed') {
      counters.results.visitsCompleted += 1;
    }
  }
  return { entered, left };
}

/**
 * The web app's `visitStarted` (ios/SPEC.md 8.2) - so the profile changes
 * the moment the player taps "Check in" rather than a flush later.
 */
export function addPendingVisit(set: VisitSet, visit: VisitSummary): void {
  set.pending.set(visit.id, visit);
}

/**
 * The web app's `visitEnded` (ios/SPEC.md 8.2), for the same reason.
 * Returns whether the visit was present - ios/SPEC.md 7.7's reminder is
 * cancelled only then.
 */
export function removeVisit(set: VisitSet, visitId: number): boolean {
  return set.pending.delete(visitId);
}

/**
 * The bar ids of pending visits with no entry in `barPositions` - not
 * those recorded `null`, which have already been asked. Each id is
 * returned once even if two visits somehow name it.
 */
export function barsNeedingPosition(set: VisitSet): number[] {
  const needed = new Set<number>();
  for (const visit of set.pending.values()) {
    if (!set.barPositions.has(visit.barId)) {
      needed.add(visit.barId);
    }
  }
  return [...needed];
}

export function setBarPosition(set: VisitSet, barId: number, position: LatLon | null): void {
  set.barPositions.set(barId, position);
}

/**
 * Whether the dwelling profile applies (ios/SPEC.md 7.3/7.6): true when
 * some pending visit's bar has a known position and `position` is on site
 * of it by `BAR_DISCOVERY_RADIUS_M` - the constant reused rather than
 * invented, per 7.6's closing sentence. `position` being `null` (no fix
 * yet) is false, and so is a pending visit whose bar position is unknown
 * (absent from the map) or recorded `null`: the tracker cannot claim the
 * player is somewhere it cannot locate. The consequence is the walking
 * profile, which is the safe direction - a visit may then need the app
 * opened to complete, exactly as it does in the browser today, and nothing
 * is broken by it.
 */
export function isDwelling(set: VisitSet, position: LatLon | null): boolean {
  if (position === null) {
    return false;
  }
  for (const visit of set.pending.values()) {
    const barPosition = set.barPositions.get(visit.barId);
    if (barPosition != null && isOnSite(position, barPosition, CONFIG.BAR_DISCOVERY_RADIUS_M)) {
      return true;
    }
  }
  return false;
}
