import type { OnsiteCandidate } from '@tipsytrails/shared';
import type { Bar } from '../api/types.js';

// Section 7.5 step 1: a "Check in" affordance for every discovered bar
// within onsiteRadiusM(accuracy) of the current position. `candidates`
// comes from `onsiteCandidates` (packages/shared/src/visits.ts), already
// sorted by ascending distance, so this component only renders it -
// several qualifying bars become a list to pick from, and exactly one
// still names the bar explicitly rather than showing a bare "Check in"
// button (Section 7.5: "bars sit close together ... check-in is an
// explicit user action"). Nothing renders when candidates is empty.
export function CheckInPanel({
  candidates,
  onCheckIn,
  checkingIn,
  checkInError,
}: {
  candidates: OnsiteCandidate<Bar>[];
  onCheckIn: (barId: number) => void;
  checkingIn: boolean;
  checkInError: string | null;
}) {
  if (candidates.length === 0) {
    return null;
  }

  return (
    <div className="check-in-panel" role="status">
      <ul className="check-in-panel__list">
        {candidates.map(({ bar }) => (
          <li key={bar.id}>
            <button
              type="button"
              className="button button--primary check-in-panel__button"
              onClick={() => onCheckIn(bar.id)}
              disabled={checkingIn}
            >
              Check in at {bar.name}
            </button>
          </li>
        ))}
      </ul>
      {checkInError && (
        <p className="error-message" role="alert">
          {checkInError}
        </p>
      )}
    </div>
  );
}
