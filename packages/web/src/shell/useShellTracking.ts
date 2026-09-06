import { useEffect, useState } from 'react';
import { isShell, subscribeToShellEvents } from './bridge.js';
import type { BlockedReason, TrackerEvent, TrackingEvent } from './events.js';

// The third icon's four shell states (`ios/SPEC.md` 8.3's closing paragraph,
// `SPEC.md` 8.6's tracking bullet).
//
// **Why this is here and not on `SampleTrackingState`.** 8.3 keeps that
// interface at thirteen members and says where the fourteenth would have gone
// instead: "those four states reach `TrackingIndicator` from the shell module
// of 8.1, not from `SampleTrackingState`". A fourteenth member is one every
// screen inherits, every test re-runs against and every future driver has to
// produce, and exactly one component wants this. So the indicator subscribes to
// the bridge itself, beside the hook rather than through it.
//
// The two readings are of the same event and cannot disagree: `trackingActive`
// is `state === 'tracking'` (useSampleTracking's shell driver) and this is the
// same `state` with `background`, the authorization and the reason still
// attached. 8.3: "never wrong, only less specific".

/**
 * What the `tracking` event of 7.5 says, reduced to the four states `SPEC.md`
 * 8.6 draws the third icon from — plus the one case that is not a tracking
 * state at all, `unreported`, which is the shell not having said anything yet.
 *
 * `unreported` is deliberately not folded into one of the four. `idle` means
 * "not signed in" and `blocked` means the platform refused; neither is true of
 * a web view that has simply not been answered yet, and saying either would be
 * the indicator inventing a fact about the phone. It is short-lived in
 * practice — `useShellReady` posts `ready` at mount and the shell answers with
 * a `dispatch` of the current state (8.2), and `addListener` replays the cached
 * `tracking` payload synchronously to a listener that registers later — but a
 * shell older than this page might never emit one, and then this is the honest
 * thing to show for as long as that lasts.
 */
export type ShellTrackingState =
  // `state: 'tracking'` with `background` true: Always granted and consent
  // recorded, so the phone keeps recording in a pocket (7.3).
  | { kind: 'background' }
  // `state: 'tracking'` with `background` false. Two ways to get here and the
  // panel has to say which, because they have different ways out: When In Use
  // is an iOS authorization the Consent screen can upgrade, and a missing
  // consent is the account's own record (5.4) that the same screen writes.
  | { kind: 'foregroundOnly'; because: 'whenInUse' | 'consent' }
  // `state: 'blocked'`, with 7.3's reason. `reason` is optional on the event
  // (7.5's table declares it so) and this is the reader 8.3 says "has an answer
  // for their absence": `null`, and words that name no cause it cannot see.
  | { kind: 'blocked'; reason: BlockedReason | null }
  // `state: 'idle'`: no session. 8.3 notes that the screen showing this can
  // only be reached while signed in, so in practice it is a session ending
  // underneath the map.
  | { kind: 'idle' }
  | { kind: 'unreported' };

/**
 * The `tracking` event reduced to the state above. Exported for its own tests:
 * the mapping is four branches and one of them asks two questions, which is
 * worth pinning without a React tree around it.
 */
export function toShellTrackingState(event: TrackingEvent): ShellTrackingState {
  if (event.state === 'idle') {
    return { kind: 'idle' };
  }
  if (event.state === 'blocked') {
    return { kind: 'blocked', reason: event.reason ?? null };
  }
  if (event.background) {
    return { kind: 'background' };
  }
  // Tracking, but not in the background. `authorizedAlways` with background off
  // can only be an account that has not consented — 7.3 keeps `background`
  // false whatever the authorization until `GET /api/auth/me` says consent was
  // given (5.4) — and anything below Always on the ladder (6.2) is When In Use,
  // whatever the account says, because iOS is the one refusing.
  return {
    kind: 'foregroundOnly',
    because: event.authorization.status === 'authorizedAlways' ? 'consent' : 'whenInUse',
  };
}

/**
 * Subscribes to the tracker's `tracking` events and answers with the state
 * above, or `null` in every browser.
 *
 * `null` is "there is no shell", and it is decided once at mount from
 * `isShell()` — the same rule and the same reason as `useSampleTracking`'s
 * `shellDriven`: an injected object arriving after mount does not turn a
 * browser page into an app page half way through, and a component that changed
 * vocabulary underneath the player would be worse than one that waited for the
 * next mount. Outside the shell `subscribeToShellEvents` registers nothing, so
 * this costs a browser one `useState` and one empty effect.
 *
 * A replayed event and a live one are handled identically: this holds no
 * counter, and 8.2's `isReplay` flag exists for counters alone (8.3). A replay
 * is by definition "the latest such event", which is exactly what this wants.
 */
export function useShellTracking(): ShellTrackingState | null {
  const [inShell] = useState(isShell);
  const [event, setEvent] = useState<TrackingEvent | null>(null);

  useEffect(() => {
    // The union narrows on `type`, so nothing here casts: an event of any
    // other kind is not this component's business and is dropped.
    function receive(incoming: TrackerEvent): void {
      if (incoming.type === 'tracking') {
        setEvent(incoming);
      }
    }
    return subscribeToShellEvents({ onEvent: receive, onReplay: receive });
  }, []);

  if (!inShell) {
    return null;
  }
  return event ? toShellTrackingState(event) : { kind: 'unreported' };
}
