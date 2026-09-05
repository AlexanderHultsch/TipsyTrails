// ios/SPEC.md Section 7.3: the tracker's state machine, its start sequence
// and its profile table; Section 7.4: the queue's flush - the timer, the
// post, the outcome handling and the backoff; Section 7.7: the four
// notifications, built in `notifications.ts` (substep B7) and hooked in
// here at every point Sections 7.3/7.4/7.6 create or remove a pending visit,
// or lose the session. `index.ts` is not wired to any of this yet - Section
// 12's Step B7 is where the global surface is wired, in one atomic change
// after every substep of Step B lands.
//
// This module follows `queue.ts`'s and `visits.ts`'s own idiom: a mutable
// structure (`Internal`) plus functions over it, no class - and Section
// 4.4's process model is why "one flush in flight" below is a boolean on
// `Internal` rather than a lock: the shell runs the tracker on one serial
// queue, so two calls into this module never interleave, and the boolean
// exists only to refuse a second flush attempt while one is still awaiting
// its response.
import { CONFIG } from '@tipsytrails/shared';
import type { LatLon } from '@tipsytrails/shared';
import { getBar, getMe, getPendingVisits, postSamples } from './api.js';
import type { ApiResult } from './api.js';
import { createCounters } from './counters.js';
import type { Counters } from './counters.js';
import type {
  AccuracyAuthorization,
  AuthorizationStatus,
  Bar,
  BlockedReason,
  Sample,
  SamplesResponse,
  SessionLostEvent,
  TrackerProfile,
  TrackingEvent,
  VisitSummary,
} from './events.js';
import type { Host, LocationProfile } from './host.js';
import {
  buildDiscoveredNotification,
  buildMasteredNotification,
  buildReminderNotification,
  buildSignedOutNotification,
  reminderId,
} from './notifications.js';
import {
  computeBehindDepth,
  createQueue,
  depth,
  dropStale,
  enqueue,
  peekBatch,
  removeSent,
} from './queue.js';
import type { SampleQueue } from './queue.js';
import {
  addPendingVisit,
  applyVisitUpdates,
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
  // ios/SPEC.md 7.7: the discovery-notifications switch, device-local
  // `UserDefaults` the shell owns (decision (a) - a preference, not a
  // position, so it does not widen `LocalNotification` the way tagging every
  // notification with a kind would). The tracker only mirrors it.
  discoveryNotifications: boolean;
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
  // ios/SPEC.md 7.7: the one addition to this surface beyond B5's - it
  // exists only because the discovery-notifications preference is the
  // shell's, and the tracker has no way to learn a later change to it
  // except being told (there is no setter for `backgroundTrackingConsentedAt`
  // for the same reason, 5.4/7.3, but that field is re-read on the next
  // `start`; this one is not, because it need not wait for one).
  setDiscoveryNotifications(on: boolean): void;
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
  // ios/SPEC.md 7.4: the flush timer's id, or `null` when none is running -
  // `startFlushTimer`/`stopFlushTimer` below hold the one invariant that
  // `host.clearTimeout` needs an id to stop the right thing, and this is
  // also how each is made idempotent (starting an already-running timer, or
  // stopping one that never started, is a no-op).
  flushTimerId: number | null;
  // Section 7.4's "one request in flight at a time", as a boolean rather
  // than a lock (Section 4.4 - see the header comment on why a lock has no
  // work to do here). Set for the duration of the `postSamples` call only.
  flushInFlight: boolean;
  // Section 7.4's backoff: the number of flushes that have failed in a row,
  // reset to 0 by a success and by a 429 (whose own `Retry-After` wait is
  // not itself backoff). `computeBackoffDelayMs` below turns this into a
  // delay.
  consecutiveFailures: number;
  // ios/SPEC.md 7.7: the discovery-notifications preference, mirrored from
  // the shell (decision (a) - see `StartInput`/`Tracker.setDiscoveryNotifications`
  // above). Set by every `start` and by `setDiscoveryNotifications`; the
  // tracker never decides its value.
  discoveryNotifications: boolean;
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
    flushTimerId: null,
    flushInFlight: false,
    consecutiveFailures: 0,
    discoveryNotifications: false,
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

// Applies a state change unconditionally: sets `state`/`reason`, bumps
// `state.transitions[newState]`/`state.lastTransitionAtMs`, and starts or
// stops the flush timer (Section 7.4: started on entering `tracking`,
// stopped on leaving it - `idle`, `blocked` and `signedOut`, which is `idle`
// under another name). Emission is a separate concern (`maybeEmitTracking`
// above) - every caller below invokes both. `start` and `signedOut` always
// represent a real transition by their own rules and call this directly;
// `transitionIfChanged` is what guards the callers that do not.
function transition(
  t: Internal,
  newState: 'idle' | 'tracking' | 'blocked',
  reason: BlockedReason | undefined,
): void {
  t.state = newState;
  t.reason = reason;
  t.counters.state.transitions[newState] += 1;
  t.counters.state.lastTransitionAtMs = t.host.now();
  if (newState === 'tracking') {
    startFlushTimer(t);
  } else {
    stopFlushTimer(t);
  }
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

// ios/SPEC.md Section 7.7: the four notifications, wired at the hook points
// B5/B6 left open. `notifications.ts` builds the `LocalNotification`
// payload and its id; every function below does exactly one of two things -
// call `host.scheduleNotification` and mirror it as the `notification` event
// of Section 7.5 ("mirrored to the web app for its own display, if it wants
// one"), or call `host.cancelNotification` with nothing to mirror, because a
// cancellation carries no payload for the web app to show.
function scheduleReminder(t: Internal, visit: VisitSummary): void {
  const notification = buildReminderNotification(visit);
  t.host.scheduleNotification(notification);
  t.host.emit({ ...notification, type: 'notification' });
}

function cancelReminder(t: Internal, visitId: number): void {
  t.host.cancelNotification(reminderId(visitId));
}

function scheduleMasteredNotification(t: Internal, visit: VisitSummary): void {
  const notification = buildMasteredNotification(visit, t.host.now());
  t.host.scheduleNotification(notification);
  t.host.emit({ ...notification, type: 'notification' });
}

function scheduleDiscoveredNotification(t: Internal, bars: Bar[]): void {
  const notification = buildDiscoveredNotification(bars, t.host.now());
  t.host.scheduleNotification(notification);
  t.host.emit({ ...notification, type: 'notification' });
}

// Schedules the one notification that tells the player "once" that they
// were signed out - `loseSession` below is its only caller.
function scheduleSignedOutNotification(t: Internal): void {
  const notification = buildSignedOutNotification(t.host.now());
  t.host.scheduleNotification(notification);
  t.host.emit({ ...notification, type: 'notification' });
}

// ios/SPEC.md 5.2/7.7: the one path every REAL session loss takes - a
// cookie vanishing (`signedOut()`), and the two flush outcomes that mean the
// same thing server-side (`handleFlushFailure`'s `unauthenticated` and
// `passwordChangeRequired`). In order: cancel the reminder of every
// still-pending visit (7.7's own reason - a signed-out player must not be
// reminded of a visit they can no longer complete, whichever of the three
// causes cost them the session), schedule the signed-out notification, move
// the matching `session.sessionLostByCause` counter, emit `sessionLost`,
// transition to `idle`, and emit the tracking snapshot that follows. One
// function is what stops this order drifting between the three call sites
// (the same reason B5 made `tracking` a snapshot and B6 made the flush's
// success path one function).
//
// `start`'s own 401 (Step 2) deliberately does NOT call this - nothing has
// been scheduled yet when it fires (the visit seed is Step 6, later), so
// there is nothing to sweep, and 5.2's notification is "once": the shell
// learning there was never a session to lose is not a player losing one.
function loseSession(t: Internal, cause: SessionLostEvent['cause']): void {
  for (const visitId of t.visits.pending.keys()) {
    cancelReminder(t, visitId);
  }
  scheduleSignedOutNotification(t);
  if (cause === 'password_change_required') {
    t.counters.session.sessionLostByCause.passwordChangeRequired += 1;
  } else {
    t.counters.session.sessionLostByCause[cause] += 1;
  }
  t.host.emit({ type: 'sessionLost', cause });
  transition(t, 'idle', undefined);
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
  t.discoveryNotifications = input.discoveryNotifications;

  // Step 1: no cookie.
  if (!input.hasCookie) {
    transition(t, 'idle', undefined);
    maybeEmitTracking(t);
    return;
  }

  // Step 2: GET /api/auth/me. Deliberately NOT `loseSession` (ios/SPEC.md
  // 5.2/7.7): nothing has been scheduled yet this early in `start` - the
  // visit seed is Step 6, below - so there is no reminder to sweep, and this
  // is the shell learning there was never a session to lose, not a player
  // losing one, so it gets no signed-out notification.
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

  // Step 6: GET /api/visits/pending -> seedPending. ios/SPEC.md 7.7: every
  // visit this seed lists just entered the tracker's memory for this
  // process, so every one gets a reminder scheduled; every id `seedPending`
  // reports removed left the set with no flush to say so, so its reminder
  // is cancelled here instead.
  const pending = await getPendingVisits(t.host);
  if (pending.outcome === 'ok') {
    const removedIds = seedPending(t.visits, pending.value.visits);
    for (const removedId of removedIds) {
      cancelReminder(t, removedId);
    }
    for (const seededVisit of pending.value.visits) {
      scheduleReminder(t, seededVisit);
    }
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

// ios/SPEC.md 7.4: "there is no other clock for flushes" - `startFlushTimer`
// is the only place `host.setTimeout` is called for this purpose, and it is
// idempotent (a second call while a timer is already running does nothing)
// because `transition` (above) calls it on every entry into `tracking`,
// including one that follows another without the timer ever having
// stopped - Section 7.3's `rederiveState` can re-derive `tracking` while
// already `tracking` (a profile-only change), and `transitionIfChanged`
// already guards most of that, but `start` calls `transition` directly and
// can do so more than once across a process's life.
function startFlushTimer(t: Internal): void {
  if (t.flushTimerId !== null) {
    return;
  }
  scheduleFlushTick(t, CONFIG.SAMPLE_MIN_INTERVAL_MS);
}

function stopFlushTimer(t: Internal): void {
  if (t.flushTimerId === null) {
    return;
  }
  t.host.clearTimeout(t.flushTimerId);
  t.flushTimerId = null;
}

// Schedules the next tick at `delayMs` - the ordinary cadence on an empty
// queue or a success, the exact `Retry-After` wait on a 429, or the backoff
// delay on an ordinary failure (Section 7.4, Part 3). The id is held on
// `Internal` so `stopFlushTimer` can cancel it, and is cleared before the
// tick's own work runs so a tick that lands after the tracker has already
// left `tracking` (e.g. a `sessionLost` from a *different* in-flight
// request) finds nothing left to cancel.
function scheduleFlushTick(t: Internal, delayMs: number): void {
  t.flushTimerId = t.host.setTimeout(() => {
    t.flushTimerId = null;
    void runFlushTick(t);
  }, delayMs);
}

// Runs one flush and, only while still `tracking`, schedules the next tick
// at the delay that flush produced. A flush that leaves `tracking` (a
// `sessionLost` outcome) has already stopped the timer through `transition`;
// re-scheduling here regardless of that would resurrect a timer this
// process no longer wants running.
async function runFlushTick(t: Internal): Promise<void> {
  const nextDelayMs = await oneFlush(t);
  if (t.state === 'tracking') {
    scheduleFlushTick(t, nextDelayMs);
  }
}

// ios/SPEC.md 7.4's backoff: `TRACKER_FLUSH_BACKOFF_BASE_MS` doubled per
// consecutive failure, capped at `TRACKER_FLUSH_BACKOFF_MAX_MS`. Every
// number here is `CONFIG`'s own - CLAUDE.md forbids inlining a rate limit,
// radius, threshold or timeout at a call site.
function computeBackoffDelayMs(consecutiveFailures: number): number {
  const delayMs = CONFIG.TRACKER_FLUSH_BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1);
  return Math.min(delayMs, CONFIG.TRACKER_FLUSH_BACKOFF_MAX_MS);
}

// The bookkeeping every ordinary failure shares (httpError, notFound-as-404,
// invalidResponse, transportError - Section 7.4, Part 3): bump the streak,
// compute the delay it now implies, and record that delay as the backoff
// currently in force (Section 7.8) so the diagnostic report shows it live.
function ordinaryFailureDelay(t: Internal): number {
  t.consecutiveFailures += 1;
  const delayMs = computeBackoffDelayMs(t.consecutiveFailures);
  t.counters.flushes.backoffCurrentlyInForceMs = delayMs;
  return delayMs;
}

// Section 7.8's `other` bucket exists precisely because `Host.fetch` follows
// no redirect and returns every status as a response (Section 7.2), so a
// 3xx has nowhere else to be counted; this is the one place that bucketing
// happens.
function statusClass(status: number): '4xx' | '5xx' | 'other' {
  if (status >= 400 && status < 500) {
    return '4xx';
  }
  if (status >= 500 && status < 600) {
    return '5xx';
  }
  return 'other';
}

// ios/SPEC.md 7.4/7.5/7.6/7.7/7.8: the success path, kept as one readable
// function per the task brief, with Section 7.7's notification scheduling
// hooked in at the bottom. In order: remove exactly the samples this batch
// sent (by identity - `removeSent`'s own comment says
// why position is not safe here), emit `queue` with the depth that removal
// just produced (7.5's `queue`/`visit`/`flush` ordering - `queue` first),
// move every counter Section 7.8 names for a success, apply the visit
// updates and emit `visit` for each one (7.5's amendment: this is the one
// place `visit` fires), emit `flush`, seed the position of every bar this
// batch discovered (7.6: a bar a batch just discovered may be one a visit is
// about to name, and this saves the fetch - and does so BEFORE the profile
// is recomputed below, because `newBars` and a `pending` `visitUpdates`
// entry for the same bar can arrive in the same response: a player who
// checks in the moment a bar stamps onto the map must reach `dwelling` from
// this very flush, not from the next fix), and recompute the profile (a
// completed or expired visit can end the dwelling profile; a newly
// positioned one, just seeded, can start it).
function handleFlushSuccess(
  t: Internal,
  batch: Sample[],
  response: SamplesResponse,
  queuedAtAttempt: number,
): void {
  removeSent(t.queue, batch, t.counters);

  const behind = computeBehindDepth(queuedAtAttempt, batch.length);
  t.counters.queue.currentBehind = behind;
  const queued = depth(t.queue);
  t.host.emit({ type: 'queue', queued, behind });

  t.counters.flushes.succeeded += 1;
  t.counters.samples.sent += batch.length;
  t.counters.samples.rejected.accuracy += response.rejected.accuracy;
  t.counters.samples.rejected.future += response.rejected.future;
  t.counters.samples.rejected.stale += response.rejected.stale;
  t.counters.samples.rejected.outsideCity += response.rejected.outsideCity;
  t.counters.samples.rejected.tooFast += response.rejected.tooFast;
  t.counters.results.newCells += response.newCells;
  t.counters.results.barsDiscovered += response.newBars.length;
  if (response.tooFastToReveal) {
    t.counters.results.tooFastToRevealBatches += 1;
  }
  t.consecutiveFailures = 0;
  t.counters.flushes.backoffCurrentlyInForceMs = 0;

  const { entered, left } = applyVisitUpdates(t.visits, response.visitUpdates, t.counters);
  for (const update of response.visitUpdates) {
    t.host.emit({ ...update, type: 'visit' });
  }

  t.host.emit({ ...response, type: 'flush', sent: batch.length, behind, queued });

  for (const bar of response.newBars) {
    setBarPosition(t.visits, bar.id, { lat: bar.lat, lon: bar.lon });
  }

  recomputeProfile(t);
  maybeEmitTracking(t);

  // ios/SPEC.md 7.7: the reminder, cancelled for every visit this flush's
  // `visitUpdates` reported left the set and scheduled for every one it
  // reported entered.
  for (const leftId of left) {
    cancelReminder(t, leftId);
  }
  for (const enteredVisit of entered) {
    scheduleReminder(t, enteredVisit);
  }

  // Bar mastered: one per `completed` entry, straight off this response -
  // `entered`/`left` above answer a different question (did the id newly
  // join or leave the pending set) and a `completed` entry always leaves it,
  // but only the response itself still carries the bar name a `left` id no
  // longer does.
  for (const update of response.visitUpdates) {
    if (update.status === 'completed') {
      scheduleMasteredNotification(t, update);
    }
  }

  // ios/SPEC.md 7.7's first rule: nothing announces revealed ground -
  // `newCells` is counted above (results.newCells) and never spoken. Do not
  // add a notification for it here.
  if (response.newBars.length > 0 && t.discoveryNotifications) {
    scheduleDiscoveredNotification(t, response.newBars);
  }
}

// ios/SPEC.md 7.4, Part 3: every failure outcome. The batch is never touched
// here - it stays at the front of the queue for the next tick to retry,
// exactly as `peekBatch`'s own comment promises. Returns the delay the next
// tick should use.
function handleFlushFailure(
  t: Internal,
  result: Exclude<ApiResult<SamplesResponse>, { outcome: 'ok' }>,
  queuedAtAttempt: number,
): number {
  let nextDelayMs: number;

  switch (result.outcome) {
    // 5.2: a 401 from any tracker request means the session has ended
    // elsewhere. No retry - the shell has to see a cookie again before this
    // tracker posts anything else. Unlike `start`'s own 401 (Step 2), a
    // session was actually lost here, so `loseSession` runs in full.
    case 'unauthenticated':
      loseSession(t, 'unauthenticated');
      nextDelayMs = CONFIG.SAMPLE_MIN_INTERVAL_MS;
      break;
    // The web app has to be opened to clear this - no retry here either.
    case 'passwordChangeRequired':
      loseSession(t, 'password_change_required');
      nextDelayMs = CONFIG.SAMPLE_MIN_INTERVAL_MS;
      break;
    // `retryAfterMs` already carries `TRACKER_FLUSH_BACKOFF_BASE_MS`'s floor
    // (api.ts). The failure streak resets so the tick after this wait is
    // back on the ordinary cadence rather than compounding into a further
    // backoff.
    case 'rateLimited':
      t.counters.flushes.failedByStatusClass['4xx'] += 1;
      t.consecutiveFailures = 0;
      t.counters.flushes.backoffCurrentlyInForceMs = 0;
      nextDelayMs = result.retryAfterMs;
      break;
    case 'httpError':
      t.counters.flushes.failedByStatusClass[statusClass(result.status)] += 1;
      nextDelayMs = ordinaryFailureDelay(t);
      break;
    // Section 7.6's route is the only caller that gives `notFound` a
    // meaning of its own; on the samples route a 404 means the API has
    // moved out from under the app, and it is an ordinary 4xx failure.
    case 'notFound':
      t.counters.flushes.failedByStatusClass['4xx'] += 1;
      nextDelayMs = ordinaryFailureDelay(t);
      break;
    // 7.4's last paragraph: a response the guard rejects is an ordinary
    // failure too - not an HTTP failure, but not nothing, so it goes to
    // `other` rather than going uncounted.
    case 'invalidResponse':
      t.counters.flushes.failedByStatusClass.other += 1;
      nextDelayMs = ordinaryFailureDelay(t);
      break;
    // 7.4: no reachability watching - the failed request is the signal.
    case 'transportError':
      t.counters.flushes.transportFailures += 1;
      nextDelayMs = ordinaryFailureDelay(t);
      break;
  }

  const behind = computeBehindDepth(queuedAtAttempt, 0);
  t.counters.queue.currentBehind = behind;
  t.host.emit({ type: 'queue', queued: depth(t.queue), behind });

  return nextDelayMs;
}

// ios/SPEC.md 7.4: one flush, in order - not tracking or already in flight,
// do nothing; drop what went stale while queued; peek a batch, done if
// there is none; remember the depth before the post (what makes `behind`
// measurable); post; branch on the outcome. Returns the delay the caller
// should schedule the next tick at.
async function oneFlush(t: Internal): Promise<number> {
  if (t.state !== 'tracking' || t.flushInFlight) {
    return CONFIG.SAMPLE_MIN_INTERVAL_MS;
  }

  dropStale(t.queue, t.host.now(), t.counters);
  const batch = peekBatch(t.queue);
  if (batch.length === 0) {
    return CONFIG.SAMPLE_MIN_INTERVAL_MS;
  }

  const queuedAtAttempt = depth(t.queue);
  t.counters.flushes.attempted += 1;
  t.flushInFlight = true;
  const result = await postSamples(t.host, batch);
  t.flushInFlight = false;

  if (result.outcome === 'ok') {
    handleFlushSuccess(t, batch, result.value, queuedAtAttempt);
    return CONFIG.SAMPLE_MIN_INTERVAL_MS;
  }
  return handleFlushFailure(t, result, queuedAtAttempt);
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
// substep B6's. Section 7.7's reminder is scheduled/cancelled here
// regardless: a visit entering or leaving the set gets one whether the
// tracker or the web app learned of it first.
function visitStarted(t: Internal, visit: VisitSummary): void {
  addPendingVisit(t.visits, visit);
  scheduleReminder(t, visit);
  if (t.state === 'tracking') {
    recomputeProfile(t);
    maybeEmitTracking(t);
  }
}

function visitEnded(t: Internal, visitId: number): void {
  const wasPresent = removeVisit(t.visits, visitId);
  if (wasPresent) {
    cancelReminder(t, visitId);
  }
  if (t.state === 'tracking') {
    recomputeProfile(t);
    maybeEmitTracking(t);
  }
}

function signedOut(t: Internal): void {
  loseSession(t, 'cookie');
}

function requestState(t: Internal): void {
  t.host.emit(buildTrackingEvent(t));
}

function snapshotCounters(t: Internal): Counters {
  return t.counters;
}

// ios/SPEC.md 7.7/decision (a): the tracker has no opinion on this switch -
// it only mirrors what the shell's `UserDefaults` says, whenever the shell
// says it changed. Takes effect at the next flush; nothing needs recomputing
// (the discovered notification is a flush-time decision, not a live state).
function setDiscoveryNotifications(t: Internal, on: boolean): void {
  t.discoveryNotifications = on;
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
    setDiscoveryNotifications: (on) => setDiscoveryNotifications(t, on),
  };
}
