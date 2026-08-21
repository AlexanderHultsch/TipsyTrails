import type { Bar } from '../api/types.js';

// Section 7.5 step 1: "a check-in starts at the bar's marker on the map, and
// nowhere else". Tapping a discovered bar's marker opens this sheet on the
// map screen itself - not the /bars/:id route, which would unmount
// screens/Map.tsx and with it useSampleTracking (the only place position
// tracking runs), stopping fog reveal and sample posting and leaving the
// check-in action with no live position to judge eligibility against. The
// player still names the bar they mean by pointing at it, which is the
// property Section 7.5 is after; /bars/:id keeps its job as the linkable
// detail page.
//
// The action is disabled rather than hidden when it cannot be used, with a
// sentence saying why - the same argument components/LocateButton.tsx makes
// for itself: a control that appears and disappears is harder to understand
// than one that is visibly inert. It always names the bar it would check
// into, so a bare "Check in" can never float over a map with two bars a few
// metres apart on it (the very ambiguity Section 7.5 exists to remove).
//
// `onSite` is decided by the caller from the shared radius rule in
// packages/shared/src/visits.ts; this component never measures a distance of
// its own, and never sees or stores a raw position (constraint C4).
export function BarSheet({
  bar,
  onSite,
  hasPendingVisit,
  checkingIn,
  checkInError,
  onCheckIn,
  onClose,
}: {
  bar: Bar;
  onSite: boolean;
  hasPendingVisit: boolean;
  checkingIn: boolean;
  checkInError: string | null;
  onCheckIn: (barId: number) => void;
  onClose: () => void;
}) {
  const headingId = `bar-sheet-name-${bar.id}`;

  return (
    <section className="bar-sheet" aria-labelledby={headingId}>
      <div className="bar-sheet__header">
        <h2 className="bar-sheet__name" id={headingId}>
          {bar.name}
        </h2>
        <button
          type="button"
          className="bar-sheet__close"
          aria-label={`Close ${bar.name}`}
          onClick={onClose}
        >
          <span aria-hidden="true">&times;</span>
        </button>
      </div>
      {bar.address !== null && <p className="bar-sheet__address">{bar.address}</p>}
      <button
        type="button"
        className="button button--primary bar-sheet__check-in"
        disabled={!onSite || hasPendingVisit || checkingIn}
        onClick={() => onCheckIn(bar.id)}
      >
        Check in at {bar.name}
      </button>
      {/* Section 5.7: at most one pending visit per bar - POST /api/visits
          would answer with the visit that is already open, so the sheet says
          so instead of making the round trip to find out. Checked before the
          range reason below: a player standing in the bar they are already
          checked into is on site, so "too far away" would be a plain lie. */}
      {hasPendingVisit ? (
        <p className="bar-sheet__reason">
          You&apos;re already checked in at {bar.name} - that visit is still pending.
        </p>
      ) : (
        !onSite && (
          <p className="bar-sheet__reason">
            You&apos;re too far away from {bar.name} to check in. Walk closer and this button turns
            on.
          </p>
        )
      )}
      {checkInError !== null && (
        <p className="error-message" role="alert">
          {checkInError}
        </p>
      )}
    </section>
  );
}
