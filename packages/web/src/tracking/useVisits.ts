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
import { useEffect, useMemo, useState } from 'react';
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

  // GET /api/visits/pending (Section 9.2): the banner's starting state, for
  // visits that were already pending before this mount (e.g. a reload).
  useEffect(() => {
    let cancelled = false;
    getPendingVisits()
      .then((result) => {
        if (!cancelled) {
          setPendingVisits(result.visits);
        }
      })
      .catch(() => {
        // Same posture as the bars fetch above - the banner starts empty
        // rather than blocking the map.
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
  async function cancelVisit(visitId: number): Promise<boolean> {
    setCancellingVisitId(visitId);
    setCancelError(null);
    try {
      await postCancelVisit(visitId);
      setPendingVisits((current) => current.filter((visit) => visit.id !== visitId));
      return true;
    } catch (err) {
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
