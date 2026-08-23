// Section 7.5's check-in and mastering mechanic, client side: the check-in
// affordance's candidates (step 1), the persistent pending banner and its
// out-of-range message (the transparency requirements), and the mastering
// message (step 4) all derive from the same two lists - discovered bars
// (for position and name lookups; VisitSummary itself carries neither,
// passed in from screens/Map.tsx's useDiscoveredBars.ts rather than fetched
// again here - see that file for why) and the caller's pending visits.
// `onsiteCandidates`/`isOnSite`/`onsiteRadiusM` are the shared rule from
// Section 7.5 step 1 (packages/shared/src/visits.ts) and must not be
// reimplemented here.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isOnSite, onsiteCandidates, onsiteRadiusM } from '@tipsytrails/shared';
import type { OnsiteCandidate } from '@tipsytrails/shared';
import {
  ApiError,
  cancelVisit as postCancelVisit,
  checkIn as postCheckIn,
  getPendingVisits,
} from '../api/client.js';
import type { Bar, VisitSummary } from '../api/types.js';
import type { LastAcceptedPosition } from './useSampleTracking.js';

export interface UseVisitsResult {
  pendingVisits: VisitSummary[];
  checkInCandidates: OnsiteCandidate<Bar>[];
  outOfRangeVisits: VisitSummary[];
  justMastered: string[];
  checkingIn: boolean;
  checkInError: string | null;
  checkIn: (barId: number) => Promise<boolean>;
  clearCheckInError: () => void;
  // Section 7.5's "A pending visit can be cancelled". The id of the visit a
  // cancel request is currently in flight for, so the banner can disable
  // that one visit's control without touching the others - the banner is a
  // list, and a second pending visit must stay cancellable meanwhile.
  cancellingVisitId: number | null;
  cancelError: string | null;
  cancelVisit: (visitId: number) => Promise<boolean>;
}

/**
 * Whether an error from a visit endpoint means "you have no pending visit
 * with that id" (SPEC.md Sections 7.5, 9.5).
 *
 * `POST /api/visits/:id/cancel` answers one deliberately identical 404 for
 * every case in which the caller has no pending visit with that id — another
 * user's, already completed, already expired, already cancelled, never
 * existed (packages/api/src/routes/visits.ts). Every one of those means the
 * visit is not pending, which is exactly the state the caller was asking
 * for, so a 404 is a success and never a failure to report.
 *
 * Decided on `status` rather than on `code`: a 404 on this path means "not
 * pending" whoever produced it, including a proxy or an offline shell that
 * never reached the route and so carries no `code` of ours at all. Every
 * other failure — a network error, a 500, a 403 — genuinely changed nothing
 * on the server, so the row stays and the failure is reported.
 *
 * Exported because `screens/Admin.tsx` calls the same endpoint (its escape
 * hatch for a stuck visit) and must not draw the opposite conclusion from
 * the same answer.
 */
export function isVisitAlreadyGone(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

export function useVisits(
  bars: Bar[],
  visitUpdates: VisitSummary[],
  visitVersion: number,
  position: LastAcceptedPosition | null,
): UseVisitsResult {
  const [pendingVisits, setPendingVisits] = useState<VisitSummary[]>([]);
  const [justMastered, setJustMastered] = useState<string[]>([]);
  const [checkingIn, setCheckingIn] = useState(false);
  const [checkInError, setCheckInError] = useState<string | null>(null);
  const [cancellingVisitId, setCancellingVisitId] = useState<number | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);

  // Bumped by every change to `pendingVisits` that came from somewhere other
  // than a refetch: a check-in, a cancel, and the sample-driven merge below.
  // A refetch that was already in flight when one of those landed is
  // answering a question about an older state, so its result is dropped
  // rather than applied over the newer one - otherwise a cancel could be
  // undone on screen by a response that left the server before it.
  const localChangeSeqRef = useRef(0);
  // Which refetch is the current one, so an earlier slow response can never
  // overwrite a later fast one.
  const refreshSeqRef = useRef(0);

  // GET /api/visits/pending (Section 9.2): the server's own list of what is
  // still pending, and the only thing that can tell this hook a visit has
  // ended for a reason the client never saw.
  const refreshPendingVisits = useCallback(() => {
    const localChangeAtStart = localChangeSeqRef.current;
    const refreshId = ++refreshSeqRef.current;
    getPendingVisits()
      .then((result) => {
        if (refreshId !== refreshSeqRef.current) {
          return;
        }
        if (localChangeAtStart !== localChangeSeqRef.current) {
          return;
        }
        setPendingVisits(result.visits);
      })
      .catch(() => {
        // Same posture as the bars fetch - the banner keeps whatever it has
        // rather than blocking the map or emptying itself on a flaky
        // connection.
      });
  }, []);

  // Section 7.5's persistent banner, and Open Item O14: this endpoint
  // expires stale visits lazily on read (Section 7.9) and returns only live
  // ones, so it is the client's only way to learn that a visit ended while
  // it was not looking. Fetched once per mount it was a snapshot, and a
  // banner that has been on screen for hours could go on asserting a state
  // the server abandoned long ago.
  //
  // `visibilitychange` is the event that matches the failure: an installed
  // PWA is not unmounted when the player leaves it, it is backgrounded, so
  // "I closed Safari, came back, and was still checked in" is a screen that
  // never remounted and therefore never asked again. Coming back to the
  // foreground is also exactly when the answer is most likely to have
  // changed and most likely to be wanted.
  //
  // Deliberately no interval alongside it. While the screen is visible the
  // figures in the banner only move when a sample is accepted, and
  // POST /api/samples already returns the visits it touched (the merge
  // below), so a timer would add nothing there. The one state it could
  // catch that this does not is a visit expiring under a screen that stays
  // continuously visible for the whole of VISIT_EXPIRY_MS - six hours of an
  // unlocked, foregrounded, out-of-range phone - and buying that costs every
  // open client a repeating authenticated request, forever, against a
  // Raspberry Pi, for a transition that happens at most once per visit. See
  // the report and O14 for what that leaves open.
  useEffect(() => {
    refreshPendingVisits();

    function handleVisibilityChange(): void {
      if (document.visibilityState === 'visible') {
        refreshPendingVisits();
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [refreshPendingVisits]);

  // Section 7.5 steps 3-4: merges the latest batch of visitUpdates into the
  // pending list - updated in place for 'pending', dropped (and its name
  // remembered for the mastering message) for 'completed'. routes/fog.ts's
  // applyVisitUpdates never reports 'expired' here, only writes it, so
  // there is no third case to handle. Keyed on visitVersion
  // (useSampleTracking.ts), not visitUpdates itself, so a later post that
  // touches nothing does not re-run this.
  useEffect(() => {
    if (visitVersion === 0) {
      return;
    }
    // Computed directly from visitUpdates, not accumulated inside the
    // setPendingVisits updater below - a functional updater is not
    // guaranteed to run synchronously, so mutating a closed-over array from
    // inside it and reading that array right after is unreliable.
    const completedNames = visitUpdates
      .filter((update) => update.status === 'completed')
      .map((update) => update.barName);
    localChangeSeqRef.current++;
    setPendingVisits((current) => {
      const byId = new Map(current.map((visit) => [visit.id, visit]));
      for (const update of visitUpdates) {
        if (update.status === 'completed') {
          byId.delete(update.id);
        } else {
          byId.set(update.id, update);
        }
      }
      return Array.from(byId.values());
    });
    if (completedNames.length > 0) {
      setJustMastered(completedNames);
    }
    // Deliberately keyed on visitVersion only - see the comment above.
  }, [visitVersion]);

  const checkInCandidates = useMemo<OnsiteCandidate<Bar>[]>(() => {
    if (!position) {
      return [];
    }
    return onsiteCandidates(position, position.accuracy, bars);
  }, [position, bars]);

  const outOfRangeVisits = useMemo<VisitSummary[]>(() => {
    if (!position) {
      return [];
    }
    const barsById = new Map(bars.map((bar) => [bar.id, bar]));
    const radiusM = onsiteRadiusM(position.accuracy);
    return pendingVisits.filter((visit) => {
      const bar = barsById.get(visit.barId);
      return bar != null && !isOnSite(position, bar, radiusM);
    });
  }, [position, bars, pendingVisits]);

  async function checkIn(barId: number): Promise<boolean> {
    setCheckingIn(true);
    setCheckInError(null);
    try {
      const visit = await postCheckIn({ barId });
      localChangeSeqRef.current++;
      setPendingVisits((current) => [...current.filter((v) => v.id !== visit.id), visit]);
      return true;
    } catch (err) {
      setCheckInError(
        err instanceof ApiError ? err.message : 'Something went wrong. Please try again.',
      );
      return false;
    } finally {
      setCheckingIn(false);
    }
  }

  // Section 7.5: the player's own way out of a pending visit. The visit
  // leaves the banner only once the server has actually moved it to
  // `cancelled` (Section 5.7) - dropping it optimistically would show a
  // player who is still checked in a screen saying they are not, and the
  // next GET /api/visits/pending would put it back.
  //
  // A 404 is the exception, and it is not an optimistic drop: it is the
  // server stating that this visit is not pending (isVisitAlreadyGone
  // above). The banner must not be able to hold a visit the server does not
  // agree is pending, so that answer removes the row and reports nothing -
  // the player asked for the visit to stop being pending, and it is not
  // pending.
  //
  // This is a robustness rule and not the fix for the field report that
  // prompted it. That was a 400 and not a 404: api/client.ts declared a JSON
  // body on this bodyless request and Fastify rejected it before the route
  // ran (see the note on `request` there). This rule covers the remaining
  // ways the same symptom could reappear - a visit expired, cancelled on
  // another device, or already terminal - none of which the player can tell
  // apart from a cancel button that does nothing.
  async function cancelVisit(visitId: number): Promise<boolean> {
    setCancellingVisitId(visitId);
    setCancelError(null);
    try {
      await postCancelVisit(visitId);
      localChangeSeqRef.current++;
      setPendingVisits((current) => current.filter((visit) => visit.id !== visitId));
      return true;
    } catch (err) {
      if (isVisitAlreadyGone(err)) {
        localChangeSeqRef.current++;
        setPendingVisits((current) => current.filter((visit) => visit.id !== visitId));
        return true;
      }
      setCancelError(
        err instanceof ApiError ? err.message : 'Something went wrong. Please try again.',
      );
      return false;
    } finally {
      setCancellingVisitId(null);
    }
  }

  // The error belongs to the attempt that produced it, and since Section 7.5
  // the attempt is made at one named bar (components/BarSheet.tsx). Opening
  // or closing that surface clears it, so a failure at one bar is never shown
  // against another.
  function clearCheckInError(): void {
    setCheckInError(null);
  }

  return {
    pendingVisits,
    checkInCandidates,
    outOfRangeVisits,
    justMastered,
    checkingIn,
    checkInError,
    checkIn,
    clearCheckInError,
    cancellingVisitId,
    cancelError,
    cancelVisit,
  };
}
