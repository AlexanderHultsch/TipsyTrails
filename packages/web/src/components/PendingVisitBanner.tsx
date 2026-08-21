import { useState } from 'react';
import type { VisitSummary } from '../api/types.js';

function formatDuration(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

// Section 7.5's transparency requirements: an active pending visit is shown
// persistently at the top of the screen with bar name, confirmed time and
// remaining time.
//
// Both figures are the server's - `confirmedS` (the elapsed time between
// check-in and the most recent accepted on-site sample, Section 5.7) and the
// `remainingS` the server derives from it - rendered exactly as they arrive.
// There is deliberately no clock in this component: this banner used to
// compute `nowS - startedAt` from a 1 s interval, which is the wall-clock
// time since check-in and not the confirmed presence at all. The two agree
// only while the player is standing at the bar with the app open and diverge
// the moment they walk away, at which point the wall clock asserts a presence
// that never happened - a visit checked into two hours ago and abandoned read
// "Confirmed 120:21 - 0:00 remaining", a complete visit that could never
// complete.
//
// The figure still moves while the player is at the bar, and does so without
// a timer here: `confirmed_s` is recomputed on every accepted on-site sample
// (Section 7.5 step 3), POST /api/samples returns the touched visits in its
// `visitUpdates`, and tracking/useVisits.ts merges those into the very
// objects rendered below. So it *steps* once per accepted sample, holds
// between samples, and stops at the last confirmed value once the player is
// out of range - which is exactly what Section 7.5 asks for and what
// interpolating between confirmed values would break.
//
// Multiple simultaneous pending visits (Section 7.5) render as a list, and
// everything that is per visit - the guidance, the out-of-range message and
// the cancel control - lives inside the item rather than under the whole
// list.
export function PendingVisitBanner({
  visits,
  outOfRangeVisitIds,
  cancellingVisitId,
  cancelError,
  onCancel,
}: {
  visits: VisitSummary[];
  outOfRangeVisitIds: ReadonlySet<number>;
  cancellingVisitId: number | null;
  cancelError: string | null;
  onCancel: (visitId: number) => void;
}) {
  // Section 7.5: cancelling is "behind a confirmation", because it throws
  // away whatever confirmed time the visit has accumulated and there is no
  // route back to it. Two taps in the banner, with the second naming the
  // bar - not `window.confirm`, which cannot be styled to match this app's
  // own surfaces and cannot be exercised in a test the way a rendered
  // dialog can. One id rather than a set: confirming one visit closes any
  // confirmation open on another, so two "are you sure?" prompts can never
  // be on screen at once.
  const [confirmingVisitId, setConfirmingVisitId] = useState<number | null>(null);

  if (visits.length === 0) {
    return null;
  }

  return (
    <div className="pending-visit-banner" role="status">
      <ul className="pending-visit-banner__list">
        {visits.map((visit) => {
          const outOfRange = outOfRangeVisitIds.has(visit.id);
          const confirming = confirmingVisitId === visit.id;
          return (
            <li key={visit.id} className="pending-visit-banner__item">
              <p className="pending-visit-banner__bar">{visit.barName}</p>
              <p className="pending-visit-banner__time">
                Confirmed {formatDuration(visit.confirmedS)} - {formatDuration(visit.remainingS)}{' '}
                remaining
              </p>
              {/* Section 7.5: "the on-site wording is replaced by it rather
                  than shown alongside it". A banner that says the player has
                  moved away and, directly beneath, tells them to stay where
                  they are is not guidance; it is two sentences that cannot
                  both be true. Which of the two applies is a fact about this
                  one visit, so the choice is made here, per item. */}
              {outOfRange ? (
                <>
                  <p className="pending-visit-banner__out-of-range error-message">
                    You&apos;ve moved away from {visit.barName} — your visit is still pending
                  </p>
                  <p className="pending-visit-banner__guidance">
                    Go back to {visit.barName} and open Tipsy Trails there to finish this visit.
                  </p>
                </>
              ) : (
                <p className="pending-visit-banner__guidance">
                  Open Tipsy Trails again while you&apos;re still here to complete this visit.
                </p>
              )}
              {confirming ? (
                <div
                  className="pending-visit-banner__confirm"
                  role="group"
                  aria-label={`Cancel your visit to ${visit.barName}?`}
                >
                  <p className="pending-visit-banner__confirm-question">
                    Cancel your visit to {visit.barName}? The {formatDuration(visit.confirmedS)}{' '}
                    confirmed so far is lost and cannot be restored.
                  </p>
                  <div className="pending-visit-banner__confirm-actions">
                    <button
                      type="button"
                      className="button button--primary pending-visit-banner__confirm-cancel"
                      disabled={cancellingVisitId === visit.id}
                      onClick={() => {
                        setConfirmingVisitId(null);
                        onCancel(visit.id);
                      }}
                    >
                      Cancel visit to {visit.barName}
                    </button>
                    <button
                      type="button"
                      className="button button--secondary pending-visit-banner__keep"
                      onClick={() => setConfirmingVisitId(null)}
                    >
                      Keep it
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="button button--secondary pending-visit-banner__cancel"
                  disabled={cancellingVisitId === visit.id}
                  onClick={() => setConfirmingVisitId(visit.id)}
                >
                  Cancel this visit
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {cancelError !== null && (
        <p className="pending-visit-banner__error error-message" role="alert">
          {cancelError}
        </p>
      )}
    </div>
  );
}
