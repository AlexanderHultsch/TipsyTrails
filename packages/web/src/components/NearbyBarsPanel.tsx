import type { OnsiteCandidate } from '@tipsytrails/shared';
import type { Bar } from '../api/types.js';

// Section 7.5 step 1 / Section 8.3's "nearby-bars panel (names the bars in
// range, carries no check-in)". This was CheckInPanel and carried a "Check in
// at <bar>" button per candidate; it is renamed because that is no longer
// what it is. It names the bars currently in range, sorted by distance, and
// tells the player to tap one on the map - the check-in itself lives on the
// bar's own marker (components/BarSheet.tsx), which is what makes two bars
// next door to each other separable.
//
// It must therefore render no button and be unable to check in: a suggestion
// derived from a position that cannot tell two neighbouring bars apart is
// exactly the control Section 7.5 removed. `role="status"` is what it is now
// - a statement of what is in range, not an affordance.
//
// `candidates` comes from `onsiteCandidates` (packages/shared/src/visits.ts)
// already sorted by ascending distance, so this component only renders it.
// Nothing renders when candidates is empty.
export function NearbyBarsPanel({ candidates }: { candidates: OnsiteCandidate<Bar>[] }) {
  if (candidates.length === 0) {
    return null;
  }

  return (
    <div className="nearby-bars-panel" role="status">
      <p className="nearby-bars-panel__title">In range right now</p>
      <ul className="nearby-bars-panel__list">
        {candidates.map(({ bar }) => (
          <li key={bar.id} className="nearby-bars-panel__bar">
            {bar.name}
          </li>
        ))}
      </ul>
      <p className="nearby-bars-panel__hint">
        Tap a bar&apos;s marker on the map to check in there.
      </p>
    </div>
  );
}
