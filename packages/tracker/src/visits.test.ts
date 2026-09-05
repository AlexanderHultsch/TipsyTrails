import { describe, expect, it } from 'vitest';
import { CONFIG, haversineDistanceM } from '@tipsytrails/shared';
import type { LatLon } from '@tipsytrails/shared';
import { createCounters } from './counters.js';
import type { Counters } from './counters.js';
import type { VisitSummary } from './events.js';
import {
  addPendingVisit,
  applyVisitUpdates,
  barsNeedingPosition,
  createVisitSet,
  isDwelling,
  removeVisit,
  seedPending,
  setBarPosition,
} from './visits.js';

const BASE_STARTED_AT = 1_700_000_000;

function visit(overrides: Partial<VisitSummary> = {}): VisitSummary {
  return {
    id: 1,
    barId: 1,
    barName: 'Test Bar',
    startedAt: BASE_STARTED_AT,
    lastSampleAt: BASE_STARTED_AT,
    onsiteSamples: 1,
    confirmedS: 0,
    remainingS: CONFIG.BAR_DISCOVERY_RADIUS_M, // unread by this module; any number
    status: 'pending',
    ...overrides,
  };
}

// counters.test.ts's/queue.test.ts's own habit: assert the whole counters
// shape moved as expected, not one field in isolation.
function countersWith(patch: (counters: Counters) => void): Counters {
  const counters = createCounters();
  patch(counters);
  return counters;
}

// Two points a known distance apart, derived with haversineDistanceM itself
// rather than a magic number, and placed either side of
// CONFIG.BAR_DISCOVERY_RADIUS_M. A pure change of latitude (same longitude)
// makes haversine's own formula exact - distance = earthRadius * dLatRadians
// - so the offset below places each point close to the radius, and the
// assertions immediately below prove the fixture landed on the intended
// side rather than assuming it did.
const BAR_POSITION: LatLon = { lat: 49.0135, lon: 8.4044 };
const EARTH_RADIUS_M_APPROX = 6371000;
const RADIUS_MARGIN_M = 5;

function pointAtLatOffsetM(base: LatLon, offsetM: number): LatLon {
  const dLatRad = offsetM / EARTH_RADIUS_M_APPROX;
  return { lat: base.lat + (dLatRad * 180) / Math.PI, lon: base.lon };
}

const INSIDE_POSITION = pointAtLatOffsetM(
  BAR_POSITION,
  CONFIG.BAR_DISCOVERY_RADIUS_M - RADIUS_MARGIN_M,
);
const OUTSIDE_POSITION = pointAtLatOffsetM(
  BAR_POSITION,
  CONFIG.BAR_DISCOVERY_RADIUS_M + RADIUS_MARGIN_M,
);

describe('fixture geometry', () => {
  it('places INSIDE_POSITION and OUTSIDE_POSITION either side of BAR_DISCOVERY_RADIUS_M', () => {
    expect(haversineDistanceM(INSIDE_POSITION, BAR_POSITION)).toBeLessThan(
      CONFIG.BAR_DISCOVERY_RADIUS_M,
    );
    expect(haversineDistanceM(OUTSIDE_POSITION, BAR_POSITION)).toBeGreaterThan(
      CONFIG.BAR_DISCOVERY_RADIUS_M,
    );
  });
});

describe('seedPending', () => {
  it('replaces the pending map rather than merging into it, returning nothing removed on a fresh set', () => {
    const set = createVisitSet();
    const removed1 = seedPending(set, [visit({ id: 1, barId: 10 }), visit({ id: 2, barId: 20 })]);
    expect(removed1).toEqual([]);

    // Visit 1 is not in the new seed - it is gone, not merged alongside it,
    // and its id comes back as removed.
    const removed2 = seedPending(set, [visit({ id: 2, barId: 20 })]);

    expect([...set.pending.keys()]).toEqual([2]);
    expect(removed2).toEqual([1]);
  });

  it('preserves barPositions across a replacement', () => {
    const set = createVisitSet();
    setBarPosition(set, 10, BAR_POSITION);
    setBarPosition(set, 20, null);
    seedPending(set, [visit({ id: 1, barId: 10 })]);

    const removed = seedPending(set, [visit({ id: 2, barId: 30 })]);

    expect(set.barPositions.get(10)).toEqual(BAR_POSITION);
    expect(set.barPositions.get(20)).toBeNull();
    expect(removed).toEqual([1]);
  });

  it('returns every id absent from the new seed, in no particular guaranteed order beyond the map’s own', () => {
    const set = createVisitSet();
    seedPending(set, [visit({ id: 1 }), visit({ id: 2 }), visit({ id: 3 })]);

    const removed = seedPending(set, []);

    expect(removed.sort()).toEqual([1, 2, 3]);
  });
});

describe('applyVisitUpdates', () => {
  it('adds a pending update to the set, and reports it entered', () => {
    const set = createVisitSet();
    const counters = createCounters();
    const v = visit({ id: 1, status: 'pending' });

    const result = applyVisitUpdates(set, [v], counters);

    expect(set.pending.get(1)).toEqual(v);
    expect(counters).toEqual(createCounters());
    expect(result).toEqual({ entered: [v], left: [] });
  });

  it('refreshes an existing pending entry rather than duplicating it, and does not report it entered', () => {
    const set = createVisitSet();
    const counters = createCounters();
    seedPending(set, [visit({ id: 1, confirmedS: 0 })]);

    const refreshed = visit({ id: 1, confirmedS: 300, status: 'pending' });
    const result = applyVisitUpdates(set, [refreshed], counters);

    expect(set.pending.size).toBe(1);
    expect(set.pending.get(1)?.confirmedS).toBe(300);
    expect(result).toEqual({ entered: [], left: [] });
  });

  it('removes a completed visit, increments visitsCompleted by exactly one, and reports it left', () => {
    const set = createVisitSet();
    const counters = createCounters();
    seedPending(set, [visit({ id: 1 })]);

    const result = applyVisitUpdates(set, [visit({ id: 1, status: 'completed' })], counters);

    expect(set.pending.has(1)).toBe(false);
    expect(counters).toEqual(
      countersWith((c) => {
        c.results.visitsCompleted = 1;
      }),
    );
    expect(result).toEqual({ entered: [], left: [1] });
  });

  it('removes an expired visit without incrementing visitsCompleted, and reports it left', () => {
    const set = createVisitSet();
    const counters = createCounters();
    seedPending(set, [visit({ id: 1 })]);

    const result = applyVisitUpdates(set, [visit({ id: 1, status: 'expired' })], counters);

    expect(set.pending.has(1)).toBe(false);
    expect(counters).toEqual(createCounters());
    expect(result).toEqual({ entered: [], left: [1] });
  });

  it('removes a cancelled visit without incrementing visitsCompleted, and reports it left', () => {
    const set = createVisitSet();
    const counters = createCounters();
    seedPending(set, [visit({ id: 1 })]);

    const result = applyVisitUpdates(set, [visit({ id: 1, status: 'cancelled' })], counters);

    expect(set.pending.has(1)).toBe(false);
    expect(counters).toEqual(createCounters());
    expect(result).toEqual({ entered: [], left: [1] });
  });

  it('increments visitsCompleted once per completed entry, for several entries, and reports every one left', () => {
    const set = createVisitSet();
    const counters = createCounters();
    seedPending(set, [visit({ id: 1 }), visit({ id: 2 }), visit({ id: 3 })]);

    const result = applyVisitUpdates(
      set,
      [
        visit({ id: 1, status: 'completed' }),
        visit({ id: 2, status: 'completed' }),
        visit({ id: 3, status: 'expired' }),
      ],
      counters,
    );

    expect(counters.results.visitsCompleted).toBe(2);
    expect(result).toEqual({ entered: [], left: [1, 2, 3] });
  });

  it('does not report an id as left when a non-pending update names one the set never held', () => {
    const set = createVisitSet();
    const counters = createCounters();

    const result = applyVisitUpdates(set, [visit({ id: 99, status: 'completed' })], counters);

    expect(result).toEqual({ entered: [], left: [] });
  });
});

describe('addPendingVisit / removeVisit', () => {
  it('addPendingVisit adds a visit the caller supplies directly', () => {
    const set = createVisitSet();
    const v = visit({ id: 5 });

    addPendingVisit(set, v);

    expect(set.pending.get(5)).toEqual(v);
  });

  it('removeVisit removes a visit by id and reports it was present', () => {
    const set = createVisitSet();
    addPendingVisit(set, visit({ id: 5 }));

    const wasPresent = removeVisit(set, 5);

    expect(wasPresent).toBe(true);
    expect(set.pending.has(5)).toBe(false);
  });

  it('removeVisit on an id not present is a no-op and reports it was not present', () => {
    const set = createVisitSet();
    addPendingVisit(set, visit({ id: 5 }));

    const wasPresent = removeVisit(set, 999);

    expect(wasPresent).toBe(false);
    expect(set.pending.has(5)).toBe(true);
  });
});

describe('barsNeedingPosition', () => {
  it('returns the bar id of a pending visit with no barPositions entry at all', () => {
    const set = createVisitSet();
    addPendingVisit(set, visit({ id: 1, barId: 10 }));

    expect(barsNeedingPosition(set)).toEqual([10]);
  });

  it('excludes a bar id whose position is known', () => {
    const set = createVisitSet();
    addPendingVisit(set, visit({ id: 1, barId: 10 }));
    setBarPosition(set, 10, BAR_POSITION);

    expect(barsNeedingPosition(set)).toEqual([]);
  });

  it('excludes a bar id recorded null - already asked, the server would not say', () => {
    const set = createVisitSet();
    addPendingVisit(set, visit({ id: 1, barId: 10 }));
    setBarPosition(set, 10, null);

    expect(barsNeedingPosition(set)).toEqual([]);
  });

  it('returns each bar id once even if two visits name it', () => {
    const set = createVisitSet();
    addPendingVisit(set, visit({ id: 1, barId: 10 }));
    addPendingVisit(set, visit({ id: 2, barId: 10 }));

    expect(barsNeedingPosition(set)).toEqual([10]);
  });
});

describe('isDwelling', () => {
  it('is true inside BAR_DISCOVERY_RADIUS_M of a pending visit’s bar with a known position', () => {
    const set = createVisitSet();
    addPendingVisit(set, visit({ id: 1, barId: 10 }));
    setBarPosition(set, 10, BAR_POSITION);

    expect(isDwelling(set, INSIDE_POSITION)).toBe(true);
  });

  it('is false outside BAR_DISCOVERY_RADIUS_M', () => {
    const set = createVisitSet();
    addPendingVisit(set, visit({ id: 1, barId: 10 }));
    setBarPosition(set, 10, BAR_POSITION);

    expect(isDwelling(set, OUTSIDE_POSITION)).toBe(false);
  });

  it('is false for a null position - no fix yet', () => {
    const set = createVisitSet();
    addPendingVisit(set, visit({ id: 1, barId: 10 }));
    setBarPosition(set, 10, BAR_POSITION);

    expect(isDwelling(set, null)).toBe(false);
  });

  it('is false when the pending visit’s bar position is unknown (not yet asked)', () => {
    const set = createVisitSet();
    addPendingVisit(set, visit({ id: 1, barId: 10 }));

    expect(isDwelling(set, INSIDE_POSITION)).toBe(false);
  });

  it('is false when the pending visit’s bar position was recorded null (asked, server would not say)', () => {
    const set = createVisitSet();
    addPendingVisit(set, visit({ id: 1, barId: 10 }));
    setBarPosition(set, 10, null);

    expect(isDwelling(set, INSIDE_POSITION)).toBe(false);
  });

  it('is true for two pending visits where only one bar’s position is known, by that one', () => {
    const set = createVisitSet();
    addPendingVisit(set, visit({ id: 1, barId: 10 }));
    addPendingVisit(set, visit({ id: 2, barId: 20 }));
    setBarPosition(set, 20, BAR_POSITION);
    // Bar 10 stays unknown - never asked.

    expect(isDwelling(set, INSIDE_POSITION)).toBe(true);
  });
});
