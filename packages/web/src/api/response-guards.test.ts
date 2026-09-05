import { describe, expect, it } from 'vitest';
import {
  isPendingVisitsResponse,
  isProgressResponse,
  isSamplesResponse,
  isVisitSummary,
} from './response-guards.js';
import type { SamplesResponse } from './types.js';

// `rejected` is REQUIRED on `SamplesResponse` (Section 9.6 states it
// unconditionally, for both routes that answer with this body), and nothing
// else in this package would notice if it stopped being. The guard below
// deliberately does not check it and no screen reads it, so relaxing the
// interface to `rejected?:` passes every test in the workspace and every
// `tsc --noEmit` with it - a required field that nothing consumes is a field
// whose required-ness has no witness.
//
// This is that witness, and it is a compile-time one because the property is:
// `@ts-expect-error` is itself an error (TS2578) when the error it expects
// does not occur, so the moment the field becomes optional this line fails
// `pnpm typecheck` instead of passing in silence. It is here rather than in a
// `it()` because there is nothing to run - the assertion is the assignment.
// @ts-expect-error - a SamplesResponse missing `rejected` must not typecheck
const withoutRejected: SamplesResponse = {
  newCells: 0,
  newBars: [],
  visitUpdates: [],
  tooFastToReveal: false,
};
void withoutRejected;

function visit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    barId: 2,
    barName: 'The Fox',
    startedAt: 1_700_000_000,
    lastSampleAt: 1_700_000_600,
    onsiteSamples: 2,
    confirmedS: 600,
    remainingS: 600,
    status: 'pending',
    ...overrides,
  };
}

function progress(city: Record<string, unknown>, districts: unknown = []): Record<string, unknown> {
  return {
    city: { revealedCells: 125, playableCells: 1000, percent: 12.5, ...city },
    districts,
  };
}

describe('isVisitSummary', () => {
  it('accepts the shape Section 9.6 documents', () => {
    expect(isVisitSummary(visit())).toBe(true);
  });

  it('rejects a status outside the closed vocabulary', () => {
    // The one that matters most: tracking/useVisits.ts drops any visit whose
    // status is not 'pending', so an unrecognised status silently empties
    // Section 7.5's banner rather than failing.
    expect(isVisitSummary(visit({ status: 'in_progress' }))).toBe(false);
    expect(isVisitSummary(visit({ status: undefined }))).toBe(false);
    expect(isVisitSummary(visit({ status: null }))).toBe(false);
  });

  it('rejects a NaN duration, which typeof would accept', () => {
    // `typeof NaN === 'number'`. PendingVisitBanner's formatDuration turns
    // this into "NaN:NaN" on screen, which is exactly the silent wrong
    // answer these predicates exist to stop.
    expect(isVisitSummary(visit({ confirmedS: Number.NaN }))).toBe(false);
    expect(isVisitSummary(visit({ remainingS: Number.NaN }))).toBe(false);
  });

  it('rejects an infinite duration, which typeof would also accept', () => {
    expect(isVisitSummary(visit({ confirmedS: Number.POSITIVE_INFINITY }))).toBe(false);
  });

  it('rejects null, undefined and missing identically', () => {
    expect(isVisitSummary(visit({ confirmedS: null }))).toBe(false);
    expect(isVisitSummary(visit({ confirmedS: undefined }))).toBe(false);
    const missing = visit();
    delete missing.confirmedS;
    expect(isVisitSummary(missing)).toBe(false);
  });

  it('rejects a numeric string where a number is required', () => {
    expect(isVisitSummary(visit({ remainingS: '600' }))).toBe(false);
  });

  it('ignores the three fields no screen reads', () => {
    // startedAt, lastSampleAt and onsiteSamples are declared in types.ts and
    // rendered nowhere since the banner stopped keeping its own clock, so a
    // wrong shape in them produces no answer to be wrong about. Pinned so
    // that widening the predicate is a deliberate act with a reader behind
    // it, not a drift towards copying the whole contract.
    expect(
      isVisitSummary(visit({ startedAt: null, lastSampleAt: null, onsiteSamples: null })),
    ).toBe(true);
  });

  it('rejects things that are not objects at all', () => {
    expect(isVisitSummary(null)).toBe(false);
    expect(isVisitSummary(undefined)).toBe(false);
    expect(isVisitSummary('pending')).toBe(false);
    expect(isVisitSummary([visit()])).toBe(false);
  });
});

describe('isPendingVisitsResponse', () => {
  it('accepts a list of well-formed visits, including an empty one', () => {
    expect(isPendingVisitsResponse({ visits: [] })).toBe(true);
    expect(isPendingVisitsResponse({ visits: [visit(), visit({ id: 2 })] })).toBe(true);
  });

  it('rejects the whole list when any one entry is malformed', () => {
    expect(isPendingVisitsResponse({ visits: [visit(), visit({ confirmedS: null })] })).toBe(false);
  });

  it('rejects a missing or non-array `visits`', () => {
    expect(isPendingVisitsResponse({})).toBe(false);
    expect(isPendingVisitsResponse({ visits: visit() })).toBe(false);
  });
});

describe('isSamplesResponse', () => {
  const ok = {
    newCells: 0,
    newBars: [],
    visitUpdates: [],
    tooFastToReveal: false,
    rejected: { accuracy: 0, future: 0, stale: 0, outsideCity: 0, tooFast: 0 },
  };

  it('accepts the five-field shape Section 9.6 documents', () => {
    expect(isSamplesResponse(ok)).toBe(true);
    expect(isSamplesResponse({ ...ok, visitUpdates: [visit()] })).toBe(true);
  });

  // `rejected` arrived in v1.60 and this guard was deliberately not extended
  // to cover it: the rule is that a response is checked where a wrong shape
  // would render as data, and no web screen reads the counts (Section 9.6;
  // `ios/SPEC.md` 9.1 states the same division, and the tracker's own guard
  // is what checks them). These two cases pin that decision from both sides,
  // so that "the guard ignores `rejected`" is a tested property rather than
  // an omission a later reader tidies up.
  it('accepts a body carrying rejected, and one without it', () => {
    const withoutRejected: Record<string, unknown> = { ...ok };
    delete withoutRejected.rejected;

    expect(isSamplesResponse(ok)).toBe(true);
    expect(isSamplesResponse(withoutRejected)).toBe(true);
  });

  it('does not look inside rejected', () => {
    expect(isSamplesResponse({ ...ok, rejected: 'not an object' })).toBe(true);
    expect(isSamplesResponse({ ...ok, rejected: { accuracy: Number.NaN } })).toBe(true);
  });

  it('rejects a missing field rather than reading it as an inert default', () => {
    // Each of these had a `?? []` or an `=== true` behind it in
    // tracking/useSampleTracking.ts, which is what made the drift silent:
    // no visits changed, no fog revealed, nobody moving too fast.
    // `rejected` is not in this list, and the case above says why.
    for (const field of ['newCells', 'newBars', 'visitUpdates', 'tooFastToReveal'] as const) {
      const body: Record<string, unknown> = { ...ok };
      delete body[field];
      expect(isSamplesResponse(body)).toBe(false);
    }
  });

  it('rejects a NaN newCells, which typeof would accept', () => {
    expect(isSamplesResponse({ ...ok, newCells: Number.NaN })).toBe(false);
  });

  it('rejects a malformed entry inside visitUpdates', () => {
    expect(isSamplesResponse({ ...ok, visitUpdates: [visit({ status: 'gone' })] })).toBe(false);
  });

  it('does not look inside newBars', () => {
    // A bar list, deliberately left to fail where it is drawn - see the
    // module comment. Only the array-ness is checked, because `.length` and
    // `.some()` are read off it directly.
    expect(isSamplesResponse({ ...ok, newBars: [{ nonsense: true }] })).toBe(true);
  });
});

describe('isProgressResponse', () => {
  it('accepts the shape Section 9.6 documents', () => {
    expect(
      isProgressResponse(
        progress({ barsDiscovered: 24, barsMastered: 7 }, [
          { id: 1, name: 'Innenstadt', percent: 3 },
        ]),
      ),
    ).toBe(true);
  });

  it('rejects a NaN percent, which typeof would accept', () => {
    // `.toFixed(1)` on a NaN is the string "NaN", and the start screen and
    // the city overview both render this figure that way.
    expect(
      isProgressResponse(progress({ percent: Number.NaN, barsDiscovered: 0, barsMastered: 0 })),
    ).toBe(false);
  });

  it('rejects an infinite percent, which JSON can actually carry as 1e999', () => {
    expect(
      isProgressResponse(
        progress({ percent: Number.POSITIVE_INFINITY, barsDiscovered: 0, barsMastered: 0 }),
      ),
    ).toBe(false);
  });

  it('rejects a missing bar count, whichever of the two it is', () => {
    expect(isProgressResponse(progress({ barsMastered: 0 }))).toBe(false);
    expect(isProgressResponse(progress({ barsDiscovered: 0 }))).toBe(false);
  });

  it('rejects a district without the name its percentage is looked up by', () => {
    // screens/DistrictOverview.tsx keys the percentages by name and falls
    // through a `?? 0`, so a nameless district reports 0.0% explored for a
    // district the player may have walked half of.
    expect(
      isProgressResponse(progress({ barsDiscovered: 0, barsMastered: 0 }, [{ id: 1, percent: 3 }])),
    ).toBe(false);
  });

  it('rejects a district with a NaN percent', () => {
    expect(
      isProgressResponse(
        progress({ barsDiscovered: 0, barsMastered: 0 }, [
          { id: 1, name: 'Innenstadt', percent: Number.NaN },
        ]),
      ),
    ).toBe(false);
  });

  it('rejects a missing city or districts block', () => {
    expect(isProgressResponse({ districts: [] })).toBe(false);
    expect(isProgressResponse({ city: { percent: 0, barsDiscovered: 0, barsMastered: 0 } })).toBe(
      false,
    );
  });

  it('ignores the cell counts no screen reads', () => {
    // Same rule as VisitSummary's three unread fields above: revealedCells,
    // playableCells and a district's id are declared in types.ts and read
    // nowhere in this package.
    expect(
      isProgressResponse({
        city: { percent: 12.5, barsDiscovered: 24, barsMastered: 7 },
        districts: [{ name: 'Innenstadt', percent: 3 }],
      }),
    ).toBe(true);
  });
});
