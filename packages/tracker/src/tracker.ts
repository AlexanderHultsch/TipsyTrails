// ios/SPEC.md Section 7.3: the tracker's state machine, its start sequence
// and its profile table. This is substep B5 - the states, the start
// sequence, the profile table, the visit hooks, and the authorization
// ladder's derivation into a `BlockedReason` - and it deliberately builds no
// flush: no timer, no `postSamples` call, no backoff, no handling of a
// flush's response. Substep B6 adds all of that to this file. `index.ts` is
// not wired to any of this yet - Section 12's Step B7 is where the global
// surface is wired, in one atomic change after every substep of Step B lands.
//
// This module follows `queue.ts`'s and `visits.ts`'s own idiom: a mutable
// structure (`Internal`) plus functions over it, no class - and Section
// 4.4's process model is why no lock or re-entrancy guard appears anywhere
// here: the shell runs the tracker on one serial queue, so two calls into
// this module never interleave.
import { CONFIG } from '@tipsytrails/shared';
import type { LatLon } from '@tipsytrails/shared';
import { getBar, getMe, getPendingVisits } from './api.js';
import { createCounters } from './counters.js';
import type { Counters } from './counters.js';
import type {
  AccuracyAuthorization,
  AuthorizationStatus,
  BlockedReason,
  Sample,
  TrackerProfile,
  TrackingEvent,
  VisitSummary,
} from './events.js';
import type { Host, LocationProfile } from './host.js';
import { createQueue, depth, enqueue } from './queue.js';
import type { SampleQueue } from './queue.js';
import {
  addPendingVisit,
  barsNeedingPosition,
  createVisitSet,
  isDwelling,
  removeVisit,
  seedPending,
  setBarPosition,
} from './visits.js';
import type { VisitSet } from './visits.js';

export type AppState = 'foreground' | 'background' | 'launchedHeadless';
export type StartCause = 'user' | 'location' | 'unknown';

// ios/SPEC.md 6.2's authorization ladder, widened by a third field. iOS
// reports both "the user refused" and "Location Services is off for the
// whole device" as `.denied` (6.2's table has no `AuthorizationStatus` value
// for the latter), and 6.5 says the shell's words must name the global
// switch rather than the app's - so the shell passes `servicesEnabled`
// alongside the pair, and `deriveBlockedReason` below is where `denied`
// becomes `servicesOff` when it is off.
export interface Authorization {
  status: AuthorizationStatus;
  accuracy: AccuracyAuthorization;
  servicesEnabled: boolean;
}

export interface StartInput {
  appState: AppState;
  cause: StartCause;
  hasCookie: boolean;
  authorization: Authorization;
  lowPower: boolean;
}

export interface Tracker {
  start(input: StartInput): Promise<void>;
  submitFix(sample: Sample): void;
  setAppState(appState: AppState): void;
  setAuthorization(auth: Authorization): void;
  setLowPower(on: boolean): void;
  visitStarted(visit: VisitSummary): void;
  visitEnded(visitId: number): void;
  signedOut(): void;
  requestState(): void;
  snapshotCounters(): Counters;
}

interface Internal {
  host: Host;
  counters: Counters;
  queue: SampleQueue;
  visits: VisitSet;
  state: 'idle' | 'tracking' | 'blocked';
  reason: BlockedReason | undefined;
  appState: AppState;
  authorization: Authorization;
  lowPower: boolean;
  // ios/SPEC.md 5.4/7.3: `backgroundTrackingConsentedAt` on the account,
  // learned from `GET /api/auth/me` at start and nowhere else - there is no
  // setter for it on `Tracker` (THE SURFACE), so a withdrawal reaches this
  // field only on a later `start`, exactly as 5.4 describes.
  backgroundAllowed: boolean;
  lastPosition: LatLon | null;
  profile: TrackerProfile | null;
  location: LocationProfile | null;
  // The last value passed to `Host.requestSignificantChanges`, or `null`
  // before it has ever been called - `syncSignificantChanges` below reads
  // this to call the host only when the value actually changes (6.4).
  significantChangesOn: boolean | null;
  // The last `tracking` snapshot actually emitted, or `null` before the
  // first one - `maybeEmitTracking` below reads this to emit only when the
  // snapshot changes (7.5).
  lastEmittedTracking: TrackingEvent | null;
}

function createInternal(host: Host): Internal {
  return {
    host,
    counters: createCounters(),
    queue: createQueue(),
    visits: createVisitSet(),
    state: 'idle',
    reason: undefined,
    appState: 'background',
    authorization: { status: 'notDetermined', accuracy: 'fullAccuracy', servicesEnabled: true },
    lowPower: false,
    backgroundAllowed: false,
    lastPosition: null,
    profile: null,
    location: null,
    significantChangesOn: null,
    lastEmittedTracking: null,
  };
}

// ios/SPEC.md 6.2's table: `reducedAccuracy` applies to any authorized
// status ("any authorized | .reducedAccuracy" - both `authorizedWhenInUse`
// and `authorizedAlways`); `denied` splits on `servicesEnabled` into
// `denied` or `servicesOff` per the comment on `Authorization` above;
// `restricted` is its own reason. `notDetermined` blocks nothing here - the
// Primer screen that asks is the shell's business (6.2), not this state
// machine's, and a tracker that has never been asked keeps tracking (Core
// Location simply delivers no fixes until it is).
function deriveBlockedReason(auth: Authorization): BlockedReason | null {
  if (
    auth.accuracy === 'reducedAccuracy' &&
    (auth.status === 'authorizedWhenInUse' || auth.status === 'authorizedAlways')
  ) {
    return 'reducedAccuracy';
  }
  if (auth.status === 'denied') {
    return auth.servicesEnabled ? 'denied' : 'servicesOff';
  }
  if (auth.status === 'restricted') {
    return 'restricted';
  }
  return null;
}

// ios/SPEC.md 7.3's profile table, exported as a pure function so it is
// testable with no tracker at all. `foreground` wins whenever the app is
// visible, whatever the visit set says; otherwise `dwelling` when `isDwelling`
// says so and `walking` when it does not. `background` on the returned
// `LocationProfile` is `backgroundAllowed` for every row - 7.3's "as
// consented" for the foreground row, and necessarily `true` for the other
// two by the time `Internal`'s state machine calls this, because its
// background-without-consent start step (7.3) has already sent an
// unconsented background start to `idle` before any profile is ever chosen.
export function selectProfile(
  appState: AppState,
  dwelling: boolean,
  backgroundAllowed: boolean,
): { profile: TrackerProfile; location: LocationProfile } {
  if (appState === 'foreground') {
    return {
      profile: 'foreground',
      location: {
        desiredAccuracyM: CONFIG.TRACKER_DESIRED_ACCURACY_M,
        distanceFilterM: CONFIG.TRACKER_FOREGROUND_DISTANCE_FILTER_M,
        background: backgroundAllowed,
      },
    };
  }
  if (dwelling) {
    return {
      profile: 'dwelling',
      location: {
        desiredAccuracyM: CONFIG.TRACKER_DESIRED_ACCURACY_M,
        distanceFilterM: CONFIG.TRACKER_DWELLING_DISTANCE_FILTER_M,
        background: backgroundAllowed,
      },
    };
  }
  return {
    profile: 'walking',
    location: {
      desiredAccuracyM: CONFIG.TRACKER_DESIRED_ACCURACY_M,
      distanceFilterM: CONFIG.TRACKER_WALKING_DISTANCE_FILTER_M,
      background: backgroundAllowed,
    },
  };
}

// Recomputes the profile from the current app state, visit set and last
// accepted position, and calls `configureLocation` (and bumps
// `state.profileActivations`) only when the result actually differs from
// what is already configured. Calling `configureLocation` on every fix
// instead would reconfigure `CLLocationManager` several times a second
// (Core Location is the only clock for fixes, and fixes are what move a
// player in or out of a bar's radius) - this comparison is what stops that.
// `profileActivations` counts entering a profile (`foreground`/`walking`/
// `dwelling`) specifically, so a `background`-only change to the same
// profile reconfigures the manager without counting as a fresh entry.
function recomputeProfile(t: Internal): void {
  const dwelling = isDwelling(t.visits, t.lastPosition);
  const { profile, location } = selectProfile(t.appState, dwelling, t.backgroundAllowed);
  const changed =
    t.profile !== profile ||
    t.location === null ||
    t.location.desiredAccuracyM !== location.desiredAccuracyM ||
    t.location.distanceFilterM !== location.distanceFilterM ||
    t.location.background !== location.background;
  if (!changed) {
    return;
  }
  if (t.profile !== profile) {
    t.counters.state.profileActivations[profile] += 1;
  }
  t.profile = profile;
  t.location = location;
  t.host.configureLocation(location);
}

// ios/SPEC.md 6.4: significant-change monitoring stays armed "whenever
// background tracking is on", i.e. whenever the account has consented -
// independent of a transient authorization block (Step 4 below), so a
// killed app can still relaunch and find its authorization has since
// improved. Consent can only change through a fresh `start` (there is no
// setter for it on `Tracker`, THE SURFACE), so this is called once, from
// Step 3 of `start`, on every call - which is also what turns the net off
// the next time `start` runs with consent withdrawn, with no restart of the
// process itself. Gated on the value actually changing, matching
// `configureLocation`'s own rule above.
function syncSignificantChanges(t: Internal, backgroundAllowed: boolean): void {
  if (t.significantChangesOn === backgroundAllowed) {
    return;
  }
  t.significantChangesOn = backgroundAllowed;
  t.host.requestSignificantChanges(backgroundAllowed);
}

// ios/SPEC.md 7.5: every transition, and on request. `profile` is present
// only for `tracking` and `reason` only for `blocked`, matching the diagram
// of 7.3 - the union has no state where both or neither of those two make
// sense.
function buildTrackingEvent(t: Internal): TrackingEvent {
  const event: TrackingEvent = {
    type: 'tracking',
    state: t.state,
    background: t.backgroundAllowed,
    authorization: { status: t.authorization.status, accuracy: t.authorization.accuracy },
    lowPower: t.lowPower,
  };
  if (t.state === 'tracking' && t.profile !== null) {
    event.profile = t.profile;
  }
  if (t.state === 'blocked' && t.reason !== undefined) {
    event.reason = t.reason;
  }
  return event;
}

function sameSnapshot(a: TrackingEvent, b: TrackingEvent): boolean {
  return (
    a.state === b.state &&
    a.profile === b.profile &&
    a.reason === b.reason &&
    a.background === b.background &&
    a.lowPower === b.lowPower &&
    a.authorization.status === b.authorization.status &&
    a.authorization.accuracy === b.authorization.accuracy
  );
}

// `tracking` is a snapshot of `state`/`profile`/`reason`/`background`/
// `authorization`/`lowPower` together, and this is the one place that emits
// it: called after anything that might have changed any of those six
// fields, it emits only when the built snapshot actually differs from the
// last one emitted. 7.3's own note that these events are idempotent is what
// makes this safe - a consumer that sees the same snapshot twice does
// nothing - and it is what lets a profile change or a low-power flag
// flipping while the overall state stays `tracking` still reach a listener,
// which a rule tied only to idle/tracking/blocked transitions would miss.
function maybeEmitTracking(t: Internal): void {
  const event = buildTrackingEvent(t);
  if (t.lastEmittedTracking !== null && sameSnapshot(t.lastEmittedTracking, event)) {
    return;
  }
  t.lastEmittedTracking = event;
  t.host.emit(event);
}

// Applies a state change unconditionally: sets `state`/`reason` and bumps
// `state.transitions[newState]`/`state.lastTransitionAtMs`. Emission is a
// separate concern (`maybeEmitTracking` above) - every caller below invokes
// both. `start` and `signedOut` always represent a real transition by their
// own rules and call this directly; `transitionIfChanged` is what guards
// the callers that do not.
function transition(
  t: Internal,
  newState: 'idle' | 'tracking' | 'blocked',
  reason: BlockedReason | undefined,
): void {
  t.state = newState;
  t.reason = reason;
  t.counters.state.transitions[newState] += 1;
  t.counters.state.lastTransitionAtMs = t.host.now();
}

function transitionIfChanged(
  t: Internal,
  newState: 'idle' | 'tracking' | 'blocked',
  reason: BlockedReason | undefined,
): void {
  if (t.state === newState && t.reason === reason) {
    return;
  }
  transition(t, newState, reason);
}

// The re-derivation `setAppState`/`setAuthorization`/`setLowPower` share:
// an authorization that lifts a block returns to `tracking`, one that
// imposes it goes to `blocked`, and the profile is recomputed for a
// tracking outcome - both before `maybeEmitTracking`'s own snapshot check,
// so a `tracking` state always carries the freshly computed profile. `idle`
// is left alone: nothing here can start a tracker with no session, and only
// `start` does that.
function rederiveState(t: Internal): void {
  if (t.state === 'idle') {
    return;
  }
  const reason = deriveBlockedReason(t.authorization);
  if (reason !== null) {
    transitionIfChanged(t, 'blocked', reason);
    maybeEmitTracking(t);
    return;
  }
  recomputeProfile(t);
  transitionIfChanged(t, 'tracking', undefined);
  maybeEmitTracking(t);
}

// ios/SPEC.md 7.3's start sequence, in order, stopping at the first step
// that ends it. Step 4 (a blocking authorization) and Step 5
// (background-without-consent) both make exactly one request when they
// stop the sequence - `GET /api/auth/me`, and nothing past it, because
// 7.3's idle "makes no request" rules out spending one on a visit set a
// headless relaunch (6.4) on an unconsented account is about to discard.
// The two are deliberately indistinguishable by request count alone; what
// tells them apart is the emitted state - `blocked` with a reason, against
// `idle`.
async function start(t: Internal, input: StartInput): Promise<void> {
  t.counters.process.startsByCause[input.cause] += 1;
  t.appState = input.appState;
  t.authorization = input.authorization;
  t.lowPower = input.lowPower;

  // Step 1: no cookie.
  if (!input.hasCookie) {
    transition(t, 'idle', undefined);
    maybeEmitTracking(t);
    return;
  }

  // Step 2: GET /api/auth/me.
  const me = await getMe(t.host);
  if (me.outcome === 'unauthenticated') {
    t.counters.session.sessionLostByCause.unauthenticated += 1;
    t.host.emit({ type: 'sessionLost', cause: 'unauthenticated' });
    transition(t, 'idle', undefined);
    maybeEmitTracking(t);
    return;
  }
  if (me.outcome !== 'ok') {
    // Any other non-ok outcome: idle and stop. B6 owns retrying; a start
    // that cannot reach the server has nothing to track with.
    transition(t, 'idle', undefined);
    maybeEmitTracking(t);
    return;
  }

  // Step 3: consent, and significant-change monitoring follows it (6.4) -
  // armed or disarmed by consent alone, independent of whatever Steps 4/5
  // decide, so a temporary authorization block does not disarm the one
  // thing that lets a killed app relaunch to find its authorization
  // improved.
  t.backgroundAllowed = me.value.backgroundTrackingConsentedAt !== null;
  syncSignificantChanges(t, t.backgroundAllowed);

  // Step 4: authorization. A blocked tracker makes no further request.
  const reason = deriveBlockedReason(input.authorization);
  if (reason !== null) {
    transition(t, 'blocked', reason);
    maybeEmitTracking(t);
    return;
  }

  // Step 5: background-without-consent, ahead of Step 6 - a start ending
  // here must not spend a request on a visit set it is about to discard.
  if (input.appState !== 'foreground' && !t.backgroundAllowed) {
    transition(t, 'idle', undefined);
    maybeEmitTracking(t);
    return;
  }

  // Step 6: GET /api/visits/pending -> seedPending.
  const pending = await getPendingVisits(t.host);
  if (pending.outcome === 'ok') {
    seedPending(t.visits, pending.value.visits);
  }

  // Step 7: a bar id present but unpositioned is asked for; `ok` records
  // the position, `notFound` records `null` (asked, the server would not
  // say), any other outcome records nothing so it is retried on a later
  // start.
  for (const barId of barsNeedingPosition(t.visits)) {
    const bar = await getBar(t.host, barId);
    if (bar.outcome === 'ok') {
      setBarPosition(t.visits, barId, { lat: bar.value.lat, lon: bar.value.lon });
    } else if (bar.outcome === 'notFound') {
      setBarPosition(t.visits, barId, null);
    }
  }

  // Step 8: choose the profile and emit tracking. Significant-change
  // monitoring was already armed or disarmed by consent in Step 3.
  recomputeProfile(t);
  transition(t, 'tracking', undefined);
  maybeEmitTracking(t);
}

function submitFix(t: Internal, sample: Sample): void {
  if (t.state === 'idle') {
    return;
  }
  if (t.state === 'blocked') {
    t.counters.fixes.received += 1;
    if (t.reason === 'reducedAccuracy') {
      t.counters.fixes.droppedReducedAccuracy += 1;
    }
    if (t.lowPower) {
      t.counters.state.fixesUnderLowPower += 1;
    }
    return;
  }

  const accepted = enqueue(t.queue, sample, t.host.now(), t.counters);
  if (t.lowPower) {
    t.counters.state.fixesUnderLowPower += 1;
  }
  if (accepted) {
    t.lastPosition = { lat: sample.lat, lon: sample.lon };
    t.host.emit({ ...sample, type: 'position', receivedAt: t.host.now() });
    t.host.emit({ type: 'queue', queued: depth(t.queue), behind: t.counters.queue.currentBehind });
  }
  // A fix is what moves the player in or out of a bar's radius.
  recomputeProfile(t);
  maybeEmitTracking(t);
}

function setAppState(t: Internal, appState: AppState): void {
  t.appState = appState;
  rederiveState(t);
}

function setAuthorization(t: Internal, auth: Authorization): void {
  t.authorization = auth;
  rederiveState(t);
}

function setLowPower(t: Internal, on: boolean): void {
  if (on && !t.lowPower) {
    t.counters.state.lowPowerActivations += 1;
  }
  t.lowPower = on;
  rederiveState(t);
}

// `visitStarted`/`visitEnded` are messages FROM the web app (ios/SPEC.md
// 8.2), which already knows what it just told the tracker - so neither
// emits a `visit` event in reply. For `visitEnded` that matters doubly: an
// id is all the tracker is given, so any `VisitSummary` it could echo back
// would carry a stale `status` (the pending one, since that is all the
// tracker still has on hand) rather than the true reason the visit ended.
// `visit` is emitted only where the tracker learns something the web app
// does not already know - a flush's `visitUpdates` entries - which is
// substep B6's.
function visitStarted(t: Internal, visit: VisitSummary): void {
  addPendingVisit(t.visits, visit);
  if (t.state === 'tracking') {
    recomputeProfile(t);
    maybeEmitTracking(t);
  }
}

function visitEnded(t: Internal, visitId: number): void {
  removeVisit(t.visits, visitId);
  if (t.state === 'tracking') {
    recomputeProfile(t);
    maybeEmitTracking(t);
  }
}

function signedOut(t: Internal): void {
  t.counters.session.sessionLostByCause.cookie += 1;
  t.host.emit({ type: 'sessionLost', cause: 'cookie' });
  transition(t, 'idle', undefined);
  maybeEmitTracking(t);
}

function requestState(t: Internal): void {
  t.host.emit(buildTrackingEvent(t));
}

function snapshotCounters(t: Internal): Counters {
  return t.counters;
}

export function createTracker(host: Host): Tracker {
  const t = createInternal(host);
  return {
    start: (input) => start(t, input),
    submitFix: (sample) => submitFix(t, sample),
    setAppState: (appState) => setAppState(t, appState),
    setAuthorization: (auth) => setAuthorization(t, auth),
    setLowPower: (on) => setLowPower(t, on),
    visitStarted: (visit) => visitStarted(t, visit),
    visitEnded: (visitId) => visitEnded(t, visitId),
    signedOut: () => signedOut(t),
    requestState: () => requestState(t),
    snapshotCounters: () => snapshotCounters(t),
  };
}
