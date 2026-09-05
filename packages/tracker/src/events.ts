// ios/SPEC.md Section 7.5 (and Section 8.3's cross-check of every member
// against the parent SPEC.md, which is more specific and the later,
// more-considered text where the two differ). `TrackerEvent` is the union
// the tracker hands to `Host.emit` (host.ts); the shell forwards each member
// to the web view verbatim as JSON (Section 8.2).
//
// `packages/tracker` depends on `@tipsytrails/shared` and nothing else in
// the workspace - it cannot import `packages/web`. So `Sample`,
// `SamplesResponse`, `VisitSummary` and `Bar` below are a THIRD hand-kept
// mirror of the same wire shapes `packages/web/src/api/types.ts` already
// mirrors from the server (that file's own comment explains why a second
// copy is deliberate there; this is the same deliberate choice made again,
// because this package cannot reach the first mirror either). Keep the
// three in step by hand; nothing here may move into `@tipsytrails/shared`,
// and nothing here should grow a dependency to avoid the duplication.
import type { LocalNotification } from './host.js';

// Section 6.6: what a `CLLocation` becomes. Mirrors
// packages/web/src/api/types.ts's `Sample`.
export interface Sample {
  lat: number;
  lon: number;
  accuracy: number;
  speed: number | null;
  timestamp: number;
}

// The closed vocabularies `Bar` and `VisitSummary` carry, mirroring
// packages/web/src/api/types.ts's own `BarSource` and `VisitStatus`, which in
// turn mirror the server's `BarSource`/`VisitStatus` (see that file's
// comment for why each is written out rather than left as `string`).
export type BarSource = 'osm' | 'community' | 'admin';
export type VisitStatus = 'pending' | 'completed' | 'expired' | 'cancelled';

// Mirrors packages/web/src/api/types.ts's `Bar` - the shape GET /api/bars,
// GET /api/bars/:id and a flush's `newBars` all share.
export interface Bar {
  id: number;
  districtId: number | null;
  name: string;
  address: string | null;
  lat: number;
  lon: number;
  source: BarSource;
  discoveredAt: number;
  mastered: boolean;
}

// Mirrors packages/web/src/api/types.ts's `VisitSummary`.
export interface VisitSummary {
  id: number;
  barId: number;
  barName: string;
  startedAt: number;
  lastSampleAt: number;
  onsiteSamples: number;
  confirmedS: number;
  remainingS: number;
  status: VisitStatus;
}

// POST /api/samples response shape. Mirrors
// packages/web/src/api/types.ts's `SamplesResponse`, widened by
// `SPEC.md` Section 9.6 (this spec's own Section 9.1) to carry `rejected` -
// one count per gate, for this request's samples only. The web mirror does
// not yet carry this field because no web screen reads it; the tracker's
// guard does (Section 9.1).
export interface SamplesResponse {
  newCells: number;
  newBars: Bar[];
  visitUpdates: VisitSummary[];
  tooFastToReveal: boolean;
  rejected: {
    accuracy: number;
    future: number;
    stale: number;
    outsideCity: number;
    tooFast: number;
  };
}

// Section 7.3's three profiles and Section 6.2's authorization ladder. The
// dot-prefixed spelling in Section 6.2's table (`.notDetermined`, and so on)
// is `CLAuthorizationStatus`/`CLAccuracyAuthorization`'s own Swift shorthand
// for naming an enum case, not part of the identifier; every other TS-side
// vocabulary this section already writes out (the `tracking` state, the
// blocked reasons below) drops it, and these two follow the same precedent.
export type TrackerProfile = 'foreground' | 'walking' | 'dwelling';
export type BlockedReason = 'reducedAccuracy' | 'denied' | 'restricted' | 'servicesOff';
export type AuthorizationStatus =
  'notDetermined' | 'denied' | 'restricted' | 'authorizedWhenInUse' | 'authorizedAlways';
export type AccuracyAuthorization = 'fullAccuracy' | 'reducedAccuracy';

// Section 7.3: every transition, and on request.
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

// Section 7.5: every sample enqueued, whether or not it is later dropped
// from the queue by the cap.
export interface PositionEvent extends Sample {
  type: 'position';
  receivedAt: number;
}

// Section 7.4/7.5: every successful flush. `sent`, `behind` and `queued` are
// computed exactly as `useSampleTracking` computes them (Section 7.4).
export interface FlushEvent extends SamplesResponse {
  type: 'flush';
  sent: number;
  behind: number;
  queued: number;
}

// Section 7.5: every enqueue and every drop, so the indicator's queued count
// is live even between flushes.
export interface QueueEvent {
  type: 'queue';
  queued: number;
  behind: number;
}

// Section 7.5/7.6: a visit entering or leaving the tracker's set, whichever
// side learned of it first.
export interface VisitEvent extends VisitSummary {
  type: 'visit';
}

// Section 7.5/5.2: once per loss.
export interface SessionLostEvent {
  type: 'sessionLost';
  cause: 'cookie' | 'unauthenticated' | 'password_change_required';
}

// Section 7.5/7.7: mirrored to the web app for its own display, if it wants
// one. `host.ts` (Step B1) already declares `LocalNotification` for
// `Host.scheduleNotification`; this event carries the same shape and is not
// declared a second time.
export interface NotificationEvent extends LocalNotification {
  type: 'notification';
}

export type TrackerEvent =
  | TrackingEvent
  | PositionEvent
  | FlushEvent
  | QueueEvent
  | VisitEvent
  | SessionLostEvent
  | NotificationEvent;
