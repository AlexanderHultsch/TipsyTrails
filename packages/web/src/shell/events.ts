// What the tracker emits, page side (`ios/SPEC.md` 7.5).
//
// The shell forwards every `TrackerEvent` to the web view verbatim as JSON and
// hands it to this page's listeners through `dispatch` (8.2, bridge.ts). This
// file is that union as the page receives it, and it is the page's own
// declaration of a wire shape rather than an import: `packages/web` does not
// depend on `packages/tracker` and must not start, so the tracker's
// `src/events.ts` and this file are two statements of one protocol, kept in
// step by hand.
//
// The duplication is bounded on purpose. Four of the shapes 7.5 carries -
// `Sample`, `SamplesResponse`, `VisitSummary` and `Bar` - are the server's wire
// shapes, and this package already mirrors all four in `api/types.ts` (that
// file explains why a hand-kept mirror of the server is deliberate). They are
// imported from there rather than written a second time, so the only new
// declarations below are the ones the tracker adds on top: the event envelopes
// and the two iOS vocabularies they carry. A `position` event that disagreed
// with `Sample` would be a bug this package could not see; sharing the type
// makes it a compile error instead.
import type { Sample, SamplesResponse, VisitSummary } from '../api/types.js';

// 7.3's three profiles and 6.2's authorization ladder. Written out rather than
// left as `string` for the reason `api/types.ts` gives for `BarSource` and
// `VisitStatus`: the tracker can only ever send one of these, and a `string`
// here would let a screen compare against a value that never arrives and get a
// silent `false` instead of a compile error.
export type TrackerProfile = 'foreground' | 'walking' | 'dwelling';
export type BlockedReason = 'reducedAccuracy' | 'denied' | 'restricted' | 'servicesOff';
export type AuthorizationStatus =
  'notDetermined' | 'denied' | 'restricted' | 'authorizedWhenInUse' | 'authorizedAlways';
export type AccuracyAuthorization = 'fullAccuracy' | 'reducedAccuracy';

// 7.5: whenever the snapshot changes, and on request. `profile` is present
// while the state is `tracking`, `reason` while it is `blocked`; both are
// optional here because 7.5's table declares them so, and the reader that
// branches on one is 8.3's third icon, which has an answer for their absence.
export interface TrackingEvent {
  type: 'tracking';
  state: 'idle' | 'tracking' | 'blocked';
  profile?: TrackerProfile;
  reason?: BlockedReason;
  background: boolean;
  authorization: {
    status: AuthorizationStatus;
    accuracy: AccuracyAuthorization;
  };
  lowPower: boolean;
}

// 7.5: every sample enqueued. The web app never receives a fix the tracker
// refused, so this already carries an accuracy the server would accept
// (7.5) - and `receivedAt` is what `computeGpsStatus`'s staleness rule reads,
// which is why it rides along rather than being taken from the page's clock.
export interface PositionEvent extends Sample {
  type: 'position';
  receivedAt: number;
}

// 7.4/7.5: every successful flush, carrying the server's own answer plus what
// the attempt found. `behind` is computed by the tracker "exactly as
// `useSampleTracking` computes it", which is what lets one
// `computeConnectionStatus` serve both drivers (8.3).
export interface FlushEvent extends SamplesResponse {
  type: 'flush';
  sent: number;
  behind: number;
  queued: number;
}

// 7.5: every enqueue and every drop, so the indicator's queued count is live
// between flushes.
export interface QueueEvent {
  type: 'queue';
  queued: number;
  behind: number;
}

// 7.5: a flush's `visitUpdates` entry - the tracker learning something the page
// does not already know. It is deliberately *not* an echo of the page's own
// `visitStarted`/`visitEnded` messages (7.5, messages.ts).
export interface VisitEvent extends VisitSummary {
  type: 'visit';
}

// 7.5/5.2: once per loss. The shell reloads the web view to its login screen on
// this (5.2), so the page's own handling of it is not this union's business.
export interface SessionLostEvent {
  type: 'sessionLost';
  cause: 'cookie' | 'unauthenticated' | 'password_change_required';
}

// 7.5/7.7: a local notification the tracker scheduled, mirrored to the web app
// "for its own display, if it wants one". Nothing in this package wants one
// today; the event is declared because the union is the protocol and a member
// left out would arrive as an unhandled `type` at every subscriber.
export interface NotificationEvent {
  type: 'notification';
  id: string;
  atMs: number;
  title: string;
  body: string;
}

export type TrackerEvent =
  | TrackingEvent
  | PositionEvent
  | FlushEvent
  | QueueEvent
  | VisitEvent
  | SessionLostEvent
  | NotificationEvent;

// The four event types 8.2 has the injected object cache and replay to a
// listener that registers late. It is the shell's set and not this page's
// choice: `latest` in the injected script is keyed by exactly these, so an
// event of any other type is only ever delivered live.
//
// A tuple rather than a `Set` so the type below can be derived from it, and so
// a fifth cached type on the shell's side is one edit here.
export const REPLAYABLE_EVENT_TYPES = ['tracking', 'position', 'queue', 'flush'] as const;

export type ReplayableEventType = (typeof REPLAYABLE_EVENT_TYPES)[number];

export function isReplayableEventType(type: TrackerEvent['type']): type is ReplayableEventType {
  return (REPLAYABLE_EVENT_TYPES as readonly string[]).includes(type);
}
