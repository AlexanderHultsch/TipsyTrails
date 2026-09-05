import { describe, expect, it } from 'vitest';
import { CONFIG, haversineDistanceM } from '@tipsytrails/shared';
import type { LatLon } from '@tipsytrails/shared';
import { createCounters } from './counters.js';
import type { Counters } from './counters.js';
import type {
  Bar,
  FlushEvent,
  Sample,
  SamplesResponse,
  TrackerEvent,
  TrackingEvent,
  VisitSummary,
} from './events.js';
import type { Host, HostRequest, HostResponse, LocationProfile } from './host.js';
import type { Authorization, AppState, StartInput } from './tracker.js';
import { createTracker, selectProfile } from './tracker.js';

const BASE_NOW_MS = 1_700_000_000_000;

// ios/SPEC.md 6.1's formula, used the same way visits.test.ts uses it: two
// points a known distance apart, placed either side of
// CONFIG.BAR_DISCOVERY_RADIUS_M by a pure change of latitude, so haversine's
// formula is exact and the fixture's own geometry is provable rather than
// assumed.
const BAR_POSITION: LatLon = { lat: 49.0135, lon: 8.4044 };
const EARTH_RADIUS_M_APPROX = 6371000;
const RADIUS_MARGIN_M = 5;

function pointAtLatOffsetM(base: LatLon, offsetM: number): LatLon {
  const dLatRad = offsetM / EARTH_RADIUS_M_APPROX;
  return { lat: base.lat + (dLatRad * 180) / Math.PI, lon: base.lon };
}

const INSIDE_POSITION = pointAtLatOffsetM(
  BAR_POSITION,
  CONFIG.BAR_DISCOVERY_RADIUS_M - RADIUS_MARGIN_M,
);
const OUTSIDE_POSITION = pointAtLatOffsetM(
  BAR_POSITION,
  CONFIG.BAR_DISCOVERY_RADIUS_M + RADIUS_MARGIN_M,
);

describe('fixture geometry', () => {
  it('places INSIDE_POSITION and OUTSIDE_POSITION either side of BAR_DISCOVERY_RADIUS_M', () => {
    expect(haversineDistanceM(INSIDE_POSITION, BAR_POSITION)).toBeLessThan(
      CONFIG.BAR_DISCOVERY_RADIUS_M,
    );
    expect(haversineDistanceM(OUTSIDE_POSITION, BAR_POSITION)).toBeGreaterThan(
      CONFIG.BAR_DISCOVERY_RADIUS_M,
    );
  });
});

function sample(overrides: Partial<Sample> = {}): Sample {
  return {
    lat: INSIDE_POSITION.lat,
    lon: INSIDE_POSITION.lon,
    accuracy: 10,
    speed: null,
    timestamp: BASE_NOW_MS,
    ...overrides,
  };
}

function visit(overrides: Partial<VisitSummary> = {}): VisitSummary {
  return {
    id: 1,
    barId: 10,
    barName: 'Test Bar',
    startedAt: BASE_NOW_MS,
    lastSampleAt: BASE_NOW_MS,
    onsiteSamples: 1,
    confirmedS: 0,
    remainingS: CONFIG.VISIT_EXPIRY_MS,
    status: 'pending',
    ...overrides,
  };
}

function fullyAuthorized(): Authorization {
  return { status: 'authorizedAlways', accuracy: 'fullAccuracy', servicesEnabled: true };
}

function jsonResponse(status: number, body: unknown): HostResponse {
  return { status, headers: {}, body: JSON.stringify(body) };
}

const validUser = (consentedAt: number | null) => ({
  id: 1,
  username: 'alex',
  avatarSeed: 'seed',
  isAdmin: false,
  isAnonymous: false,
  mustChangePassword: false,
  backgroundTrackingConsentedAt: consentedAt,
});

const validBar = (id: number, position: LatLon) => ({
  id,
  districtId: null,
  name: `Bar ${id}`,
  address: null,
  lat: position.lat,
  lon: position.lon,
  source: 'osm',
  discoveredAt: BASE_NOW_MS,
  mastered: false,
});

function validSamplesResponse(overrides: Partial<SamplesResponse> = {}): SamplesResponse {
  return {
    newCells: 0,
    newBars: [],
    visitUpdates: [],
    tooFastToReveal: false,
    rejected: { accuracy: 0, future: 0, stale: 0, outsideCity: 0, tooFast: 0 },
    ...overrides,
  };
}

// A real macrotask, used after firing a fake timer's callback (Part 4 below)
// to let the promise chain it kicks off (postSamples -> the guard -> the
// success/failure handling) settle: Node drains every pending microtask
// before running a macrotask callback, so one `setTimeout` here is enough
// regardless of how many `await`s sit between the tick firing and the
// tracker's own state settling.
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// A router keyed by "METHOD path" for /api/auth/me and /api/visits/pending,
// and by method + path prefix for /api/bars/:id. Defaults are the happy
// path (consented, no pending visits); a test overrides only what it needs.
interface Scripted {
  me?: HostResponse;
  pendingVisits?: HostResponse;
  bars?: Record<number, HostResponse>;
  samples?: HostResponse;
}

// One of Section 7.2's `Host.setTimeout` calls, as this fake records it -
// `fn` is wrapped so that firing it (by any of the means below) removes it
// from the pending set first, matching a real `setTimeout` callback's own
// one-shot nature.
interface FakeTimer {
  id: number;
  delayMs: number;
  fn: () => void;
}

function fakeHost(scripted: Scripted = {}): {
  host: Host;
  requests: HostRequest[];
  emitted: TrackerEvent[];
  configureLocationCalls: LocationProfile[];
  significantChangesCalls: boolean[];
  setNow: (ms: number) => void;
  // Every timer this host has scheduled and not yet fired or cleared, in
  // the order `setTimeout` was called - Section 7.4 schedules at most one
  // flush timer at a time, so index 0 is "the" timer for every ordinary
  // test; a test provoking two ticks in flight at once keeps its own
  // reference instead of re-reading this after the first.
  pendingTimers: () => FakeTimer[];
  clearedTimerIds: number[];
  fireNextTimer: () => void;
} {
  let nowMs = BASE_NOW_MS;
  const requests: HostRequest[] = [];
  const emitted: TrackerEvent[] = [];
  const configureLocationCalls: LocationProfile[] = [];
  const significantChangesCalls: boolean[] = [];
  let nextTimerId = 1;
  const timers = new Map<number, FakeTimer>();
  const clearedTimerIds: number[] = [];

  // `scripted`'s fields are read fresh on every fetch, not captured once -
  // so a test can mutate `scripted.me` (or `scripted.samples`, for a flush)
  // between two calls on the same host to script a second answer without
  // recreating the tracker.
  const host: Host = {
    now: () => nowMs,
    setTimeout: (fn, ms) => {
      const id = nextTimerId;
      nextTimerId += 1;
      const wrapped = () => {
        timers.delete(id);
        fn();
      };
      timers.set(id, { id, delayMs: ms, fn: wrapped });
      return id;
    },
    clearTimeout: (id) => {
      clearedTimerIds.push(id);
      timers.delete(id);
    },
    fetch: async (input) => {
      requests.push(input);
      if (input.method === 'GET' && input.path === '/api/auth/me') {
        return scripted.me ?? jsonResponse(200, validUser(BASE_NOW_MS));
      }
      if (input.method === 'GET' && input.path === '/api/visits/pending') {
        return scripted.pendingVisits ?? jsonResponse(200, { visits: [] });
      }
      if (input.method === 'POST' && input.path === '/api/samples') {
        return scripted.samples ?? jsonResponse(200, validSamplesResponse());
      }
      const barMatch = /^\/api\/bars\/(\d+)$/.exec(input.path);
      if (input.method === 'GET' && barMatch) {
        const id = Number(barMatch[1]);
        const response = scripted.bars?.[id];
        if (response) {
          return response;
        }
        return jsonResponse(404, { code: 'bar_not_found', message: 'not found' });
      }
      throw new Error(`unscripted request: ${input.method} ${input.path}`);
    },
    configureLocation: (profile) => configureLocationCalls.push(profile),
    requestSignificantChanges: (on) => significantChangesCalls.push(on),
    scheduleNotification: () => {},
    cancelNotification: () => {},
    emit: (event) => emitted.push(event),
    log: () => {},
  };

  return {
    host,
    requests,
    emitted,
    configureLocationCalls,
    significantChangesCalls,
    setNow: (ms) => {
      nowMs = ms;
    },
    pendingTimers: () => [...timers.values()],
    clearedTimerIds,
    fireNextTimer: () => {
      const next = [...timers.values()][0];
      if (!next) {
        throw new Error('no pending timer to fire');
      }
      next.fn();
    },
  };
}

function startInput(overrides: Partial<StartInput> = {}): StartInput {
  return {
    appState: 'foreground',
    cause: 'user',
    hasCookie: true,
    authorization: fullyAuthorized(),
    lowPower: false,
    ...overrides,
  };
}

function lastTrackingEvent(emitted: TrackerEvent[]): TrackingEvent {
  const events = emitted.filter((e): e is TrackingEvent => e.type === 'tracking');
  const last = events.at(-1);
  if (!last) {
    throw new Error('no tracking event was emitted');
  }
  return last;
}

function countersWith(patch: (counters: Counters) => void): Counters {
  const counters = createCounters();
  patch(counters);
  return counters;
}

describe('selectProfile', () => {
  it('is foreground whenever the app is visible, whatever dwelling says', () => {
    expect(selectProfile('foreground', false, true)).toEqual({
      profile: 'foreground',
      location: {
        desiredAccuracyM: CONFIG.TRACKER_DESIRED_ACCURACY_M,
        distanceFilterM: CONFIG.TRACKER_FOREGROUND_DISTANCE_FILTER_M,
        background: true,
      },
    });
    expect(selectProfile('foreground', true, true)).toEqual({
      profile: 'foreground',
      location: {
        desiredAccuracyM: CONFIG.TRACKER_DESIRED_ACCURACY_M,
        distanceFilterM: CONFIG.TRACKER_FOREGROUND_DISTANCE_FILTER_M,
        background: true,
      },
    });
  });

  it.each<AppState>(['background', 'launchedHeadless'])(
    'is dwelling when not visible (%s) and isDwelling is true',
    (appState) => {
      expect(selectProfile(appState, true, true)).toEqual({
        profile: 'dwelling',
        location: {
          desiredAccuracyM: CONFIG.TRACKER_DESIRED_ACCURACY_M,
          distanceFilterM: CONFIG.TRACKER_DWELLING_DISTANCE_FILTER_M,
          background: true,
        },
      });
    },
  );

  it.each<AppState>(['background', 'launchedHeadless'])(
    'is walking when not visible (%s) and isDwelling is false',
    (appState) => {
      expect(selectProfile(appState, false, true)).toEqual({
        profile: 'walking',
        location: {
          desiredAccuracyM: CONFIG.TRACKER_DESIRED_ACCURACY_M,
          distanceFilterM: CONFIG.TRACKER_WALKING_DISTANCE_FILTER_M,
          background: true,
        },
      });
    },
  );

  it('carries backgroundAllowed through as `background` on every row', () => {
    expect(selectProfile('foreground', false, false).location.background).toBe(false);
    expect(selectProfile('background', false, false).location.background).toBe(false);
    expect(selectProfile('background', true, false).location.background).toBe(false);
  });
});

describe('start - the sequence, ending where each numbered step should', () => {
  it('step 1: no cookie makes no request at all, and goes idle', async () => {
    const { host, requests, emitted } = fakeHost();
    const tracker = createTracker(host);

    await tracker.start(startInput({ hasCookie: false }));

    expect(requests).toEqual([]);
    expect(lastTrackingEvent(emitted).state).toBe('idle');
  });

  it('step 2: unauthenticated on GET /api/auth/me emits sessionLost and goes idle', async () => {
    const { host, requests, emitted } = fakeHost({
      me: jsonResponse(401, { code: 'unauthenticated', message: 'nope' }),
    });
    const tracker = createTracker(host);

    await tracker.start(startInput());

    expect(requests).toEqual([{ method: 'GET', path: '/api/auth/me' }]);
    expect(emitted).toContainEqual({ type: 'sessionLost', cause: 'unauthenticated' });
    expect(lastTrackingEvent(emitted).state).toBe('idle');
    expect(tracker.snapshotCounters().session.sessionLostByCause.unauthenticated).toBe(1);
  });

  it('step 2: any other non-ok outcome goes idle with no sessionLost and no retry', async () => {
    const { host, requests, emitted } = fakeHost({
      me: jsonResponse(500, { code: 'unknown_error', message: 'oops' }),
    });
    const tracker = createTracker(host);

    await tracker.start(startInput());

    expect(requests).toEqual([{ method: 'GET', path: '/api/auth/me' }]);
    expect(emitted.filter((e) => e.type === 'sessionLost')).toEqual([]);
    expect(lastTrackingEvent(emitted).state).toBe('idle');
  });

  it('step 3: consent null keeps background false whatever the authorization', async () => {
    const { host, emitted } = fakeHost({ me: jsonResponse(200, validUser(null)) });
    const tracker = createTracker(host);

    await tracker.start(startInput({ appState: 'foreground' }));

    expect(lastTrackingEvent(emitted).background).toBe(false);
  });

  // Steps 4 and 5 both stop the sequence right after GET /api/auth/me and
  // so are deliberately indistinguishable by request count alone - both
  // make exactly one. What tells them apart is the emitted state: `blocked`
  // with a reason (step 4), against `idle` with none (step 5). A start
  // about to end in either case must not spend a second request
  // (GET /api/visits/pending) on a visit set it is about to discard.
  it('step 4: a blocking authorization makes exactly one request and stops before any other', async () => {
    const { host, requests, emitted } = fakeHost();
    const tracker = createTracker(host);

    await tracker.start(
      startInput({
        authorization: { status: 'denied', accuracy: 'fullAccuracy', servicesEnabled: true },
      }),
    );

    expect(requests).toEqual([{ method: 'GET', path: '/api/auth/me' }]);
    const event = lastTrackingEvent(emitted);
    expect(event.state).toBe('blocked');
    expect(event.reason).toBe('denied');
  });

  it('step 5: background-without-consent makes exactly one request and goes idle', async () => {
    const { host, requests, emitted } = fakeHost({ me: jsonResponse(200, validUser(null)) });
    const tracker = createTracker(host);

    await tracker.start(startInput({ appState: 'background' }));

    expect(requests).toEqual([{ method: 'GET', path: '/api/auth/me' }]);
    expect(lastTrackingEvent(emitted).state).toBe('idle');
  });

  it('step 5: a headless launch on an unconsented account does nothing beyond GET /api/auth/me', async () => {
    const { host, requests, emitted, configureLocationCalls, significantChangesCalls } = fakeHost({
      me: jsonResponse(200, validUser(null)),
    });
    const tracker = createTracker(host);

    await tracker.start(startInput({ appState: 'launchedHeadless', cause: 'location' }));

    expect(requests).toEqual([{ method: 'GET', path: '/api/auth/me' }]);
    expect(configureLocationCalls).toEqual([]);
    // Consent is withdrawn, so Step 3 disarms significant-change
    // monitoring - the one call this start does make beyond GET
    // /api/auth/me is not a request at all.
    expect(significantChangesCalls).toEqual([false]);
    expect(lastTrackingEvent(emitted).state).toBe('idle');
  });

  it('step 7: getBar ok records the position, notFound records null, any other outcome records nothing', async () => {
    const { host, requests } = fakeHost({
      pendingVisits: jsonResponse(200, {
        visits: [
          visit({ id: 1, barId: 10 }),
          visit({ id: 2, barId: 20 }),
          visit({ id: 3, barId: 30 }),
        ],
      }),
      bars: {
        10: jsonResponse(200, validBar(10, BAR_POSITION)),
        20: jsonResponse(404, { code: 'bar_not_found', message: 'not found' }),
        30: jsonResponse(500, { code: 'unknown_error', message: 'oops' }),
      },
    });
    const tracker = createTracker(host);

    await tracker.start(startInput({ appState: 'background' }));

    const barRequests = requests.filter((r) => r.path.startsWith('/api/bars/'));
    expect(barRequests.map((r) => r.path).sort()).toEqual([
      '/api/bars/10',
      '/api/bars/20',
      '/api/bars/30',
    ]);
  });

  it('step 8: chooses the profile, configures location, arms significant changes, and emits tracking', async () => {
    const { host, configureLocationCalls, significantChangesCalls, emitted } = fakeHost();
    const tracker = createTracker(host);

    await tracker.start(startInput({ appState: 'background' }));

    expect(configureLocationCalls).toEqual([
      {
        desiredAccuracyM: CONFIG.TRACKER_DESIRED_ACCURACY_M,
        distanceFilterM: CONFIG.TRACKER_WALKING_DISTANCE_FILTER_M,
        background: true,
      },
    ]);
    expect(significantChangesCalls).toEqual([true]);
    const event = lastTrackingEvent(emitted);
    expect(event).toEqual({
      type: 'tracking',
      state: 'tracking',
      profile: 'walking',
      background: true,
      authorization: { status: 'authorizedAlways', accuracy: 'fullAccuracy' },
      lowPower: false,
    });
  });

  it('withdrawing consent on a later start turns off significant-change monitoring, without a restart', async () => {
    const scripted: Scripted = { me: jsonResponse(200, validUser(BASE_NOW_MS)) };
    const { host, significantChangesCalls } = fakeHost(scripted);
    const tracker = createTracker(host);

    await tracker.start(startInput({ appState: 'background' }));
    expect(significantChangesCalls).toEqual([true]);

    // Same tracker, same process - only the server's answer changes.
    scripted.me = jsonResponse(200, validUser(null));
    await tracker.start(startInput({ appState: 'background' }));

    expect(significantChangesCalls).toEqual([true, false]);
  });

  it('counters.process.startsByCause moves by the cause given, on every start', async () => {
    const { host: hostUser } = fakeHost();
    const trackerUser = createTracker(hostUser);
    await trackerUser.start(startInput({ cause: 'user' }));
    expect(trackerUser.snapshotCounters()).toEqual(
      countersWith((c) => {
        c.process.startsByCause.user = 1;
        c.state.transitions.tracking = 1;
        c.state.lastTransitionAtMs = BASE_NOW_MS;
        c.state.profileActivations.foreground = 1;
      }),
    );

    const { host: hostLocation } = fakeHost({ me: jsonResponse(200, validUser(null)) });
    const trackerLocation = createTracker(hostLocation);
    await trackerLocation.start(startInput({ cause: 'location', appState: 'background' }));
    expect(trackerLocation.snapshotCounters().process.startsByCause).toEqual({
      user: 0,
      location: 1,
      unknown: 0,
    });

    const { host: hostUnknown } = fakeHost();
    const trackerUnknown = createTracker(hostUnknown);
    await trackerUnknown.start(startInput({ cause: 'unknown', hasCookie: false }));
    expect(trackerUnknown.snapshotCounters().process.startsByCause).toEqual({
      user: 0,
      location: 0,
      unknown: 1,
    });
  });
});

describe('the profile table through the tracker, and configureLocation change-gating', () => {
  it('does not call configureLocation again when the recomputed profile is unchanged', async () => {
    const { host, configureLocationCalls } = fakeHost();
    const tracker = createTracker(host);
    await tracker.start(startInput({ appState: 'foreground' }));
    expect(configureLocationCalls).toHaveLength(1);

    // Same app state again: no change, so no second configureLocation call.
    tracker.setAppState('foreground');
    expect(configureLocationCalls).toHaveLength(1);
  });

  it('calls configureLocation again when the profile changes', async () => {
    const { host, configureLocationCalls } = fakeHost();
    const tracker = createTracker(host);
    await tracker.start(startInput({ appState: 'foreground' }));
    expect(configureLocationCalls).toHaveLength(1);

    tracker.setAppState('background');

    expect(configureLocationCalls).toHaveLength(2);
    expect(configureLocationCalls[1]).toEqual({
      desiredAccuracyM: CONFIG.TRACKER_DESIRED_ACCURACY_M,
      distanceFilterM: CONFIG.TRACKER_WALKING_DISTANCE_FILTER_M,
      background: true,
    });
  });

  it('a fix moving the player into a bar’s radius switches walking to dwelling, and back out again', async () => {
    const { host, configureLocationCalls } = fakeHost({
      pendingVisits: jsonResponse(200, { visits: [visit({ id: 1, barId: 10 })] }),
      bars: { 10: jsonResponse(200, validBar(10, BAR_POSITION)) },
    });
    const tracker = createTracker(host);
    await tracker.start(startInput({ appState: 'background' }));
    expect(configureLocationCalls.at(-1)?.distanceFilterM).toBe(
      CONFIG.TRACKER_WALKING_DISTANCE_FILTER_M,
    );

    tracker.submitFix(sample({ lat: INSIDE_POSITION.lat, lon: INSIDE_POSITION.lon }));
    expect(configureLocationCalls.at(-1)?.distanceFilterM).toBe(
      CONFIG.TRACKER_DWELLING_DISTANCE_FILTER_M,
    );

    tracker.submitFix(sample({ lat: OUTSIDE_POSITION.lat, lon: OUTSIDE_POSITION.lon }));
    expect(configureLocationCalls.at(-1)?.distanceFilterM).toBe(
      CONFIG.TRACKER_WALKING_DISTANCE_FILTER_M,
    );
  });

  it('visitStarted switches the profile without any flush, using an already-cached bar position', async () => {
    const { host, configureLocationCalls, requests } = fakeHost({
      pendingVisits: jsonResponse(200, { visits: [visit({ id: 1, barId: 10 })] }),
      bars: { 10: jsonResponse(200, validBar(10, BAR_POSITION)) },
    });
    const tracker = createTracker(host);
    await tracker.start(startInput({ appState: 'background' }));

    // Remove the visit that seeded the bar position - barPositions is
    // preserved across it (visits.ts), and nothing is pending any more.
    tracker.visitEnded(1);
    expect(configureLocationCalls.at(-1)?.distanceFilterM).toBe(
      CONFIG.TRACKER_WALKING_DISTANCE_FILTER_M,
    );

    // Already standing where that bar is, with no pending visit - walking.
    tracker.submitFix(sample({ lat: INSIDE_POSITION.lat, lon: INSIDE_POSITION.lon }));
    expect(configureLocationCalls.at(-1)?.distanceFilterM).toBe(
      CONFIG.TRACKER_WALKING_DISTANCE_FILTER_M,
    );
    const requestCountBeforeCheckIn = requests.length;

    // Checking in at the same bar flips the profile with no new request.
    tracker.visitStarted(visit({ id: 2, barId: 10 }));

    expect(requests).toHaveLength(requestCountBeforeCheckIn);
    expect(configureLocationCalls.at(-1)?.distanceFilterM).toBe(
      CONFIG.TRACKER_DWELLING_DISTANCE_FILTER_M,
    );
  });
});

describe('tracking is a snapshot - emitted whenever any of its fields change, not only on a state transition', () => {
  it('a profile change while the state stays tracking still emits tracking', async () => {
    const { host, emitted } = fakeHost();
    const tracker = createTracker(host);
    await tracker.start(startInput({ appState: 'foreground' }));
    const trackingEventsBefore = emitted.filter((e) => e.type === 'tracking').length;

    tracker.setAppState('background');

    const trackingEvents = emitted.filter((e) => e.type === 'tracking');
    expect(trackingEvents).toHaveLength(trackingEventsBefore + 1);
    const event = trackingEvents.at(-1);
    expect(event?.state).toBe('tracking');
    expect(event?.profile).toBe('walking');
  });

  it('low power coming on while tracking still emits tracking, with no state or profile change', async () => {
    const { host, emitted } = fakeHost();
    const tracker = createTracker(host);
    await tracker.start(startInput());
    const trackingEventsBefore = emitted.filter((e) => e.type === 'tracking').length;

    tracker.setLowPower(true);

    const trackingEvents = emitted.filter((e) => e.type === 'tracking');
    expect(trackingEvents).toHaveLength(trackingEventsBefore + 1);
    const event = trackingEvents.at(-1);
    expect(event?.state).toBe('tracking');
    expect(event?.lowPower).toBe(true);
  });

  it('does not emit tracking again when nothing about the snapshot changed', async () => {
    const { host, emitted } = fakeHost();
    const tracker = createTracker(host);
    await tracker.start(startInput({ appState: 'foreground' }));
    const trackingEventsBefore = emitted.filter((e) => e.type === 'tracking').length;

    tracker.setAppState('foreground');

    expect(emitted.filter((e) => e.type === 'tracking')).toHaveLength(trackingEventsBefore);
  });
});

describe('blocked', () => {
  it('makes no request and discards fixes, counting reducedAccuracy separately from every other reason', async () => {
    const { host, requests } = fakeHost();
    const tracker = createTracker(host);
    await tracker.start(startInput());
    const requestCountAfterStart = requests.length;

    tracker.setAuthorization({
      status: 'authorizedAlways',
      accuracy: 'reducedAccuracy',
      servicesEnabled: true,
    });
    tracker.submitFix(sample());

    expect(requests).toHaveLength(requestCountAfterStart);
    expect(tracker.snapshotCounters().fixes.received).toBe(1);
    expect(tracker.snapshotCounters().fixes.droppedReducedAccuracy).toBe(1);
  });

  it('counts only fixes.received for a blocked reason other than reducedAccuracy', async () => {
    const { host } = fakeHost();
    const tracker = createTracker(host);
    await tracker.start(startInput());

    tracker.setAuthorization({ status: 'denied', accuracy: 'fullAccuracy', servicesEnabled: true });
    tracker.submitFix(sample());

    expect(tracker.snapshotCounters().fixes.received).toBe(1);
    expect(tracker.snapshotCounters().fixes.droppedReducedAccuracy).toBe(0);
  });

  it('returns to tracking when the authorization lifts', async () => {
    const { host, emitted } = fakeHost();
    const tracker = createTracker(host);
    await tracker.start(startInput());

    tracker.setAuthorization({ status: 'denied', accuracy: 'fullAccuracy', servicesEnabled: true });
    expect(lastTrackingEvent(emitted).state).toBe('blocked');

    tracker.setAuthorization(fullyAuthorized());
    const event = lastTrackingEvent(emitted);
    expect(event.state).toBe('tracking');
    expect(event.profile).toBe('foreground');
  });

  it('denied with servicesEnabled false is servicesOff, and true is denied', async () => {
    const { host: hostOff, emitted: emittedOff } = fakeHost();
    const trackerOff = createTracker(hostOff);
    await trackerOff.start(
      startInput({
        authorization: { status: 'denied', accuracy: 'fullAccuracy', servicesEnabled: false },
      }),
    );
    expect(lastTrackingEvent(emittedOff).reason).toBe('servicesOff');

    const { host: hostOn, emitted: emittedOn } = fakeHost();
    const trackerOn = createTracker(hostOn);
    await trackerOn.start(
      startInput({
        authorization: { status: 'denied', accuracy: 'fullAccuracy', servicesEnabled: true },
      }),
    );
    expect(lastTrackingEvent(emittedOn).reason).toBe('denied');
  });
});

describe('setAppState / setAuthorization / setLowPower', () => {
  it('setLowPower(true) moves state.lowPowerActivations only on the false-to-true edge', async () => {
    const { host } = fakeHost();
    const tracker = createTracker(host);
    await tracker.start(startInput());

    tracker.setLowPower(true);
    tracker.setLowPower(true);
    tracker.setLowPower(false);
    tracker.setLowPower(true);

    expect(tracker.snapshotCounters().state.lowPowerActivations).toBe(2);
  });

  it('submitFix under low power also counts fixesUnderLowPower', async () => {
    const { host } = fakeHost();
    const tracker = createTracker(host);
    await tracker.start(startInput());
    tracker.setLowPower(true);

    tracker.submitFix(sample());

    expect(tracker.snapshotCounters().state.fixesUnderLowPower).toBe(1);
  });
});

describe('visitStarted / visitEnded do not emit visit, and idle/blocked leave the fix idle', () => {
  it('ignores a fix entirely while idle', async () => {
    const { host } = fakeHost({ me: jsonResponse(200, validUser(null)) });
    const tracker = createTracker(host);
    await tracker.start(startInput({ appState: 'background' }));
    expect(tracker.snapshotCounters()).toEqual(
      countersWith((c) => {
        c.process.startsByCause.user = 1;
        c.state.transitions.idle = 1;
        c.state.lastTransitionAtMs = BASE_NOW_MS;
      }),
    );

    tracker.submitFix(sample());

    expect(tracker.snapshotCounters()).toEqual(
      countersWith((c) => {
        c.process.startsByCause.user = 1;
        c.state.transitions.idle = 1;
        c.state.lastTransitionAtMs = BASE_NOW_MS;
      }),
    );
  });

  // Both are messages FROM the web app (8.2): it already knows what it just
  // told the tracker, so neither replies with a `visit` event. `visit` is
  // emitted only where the tracker learns something the web app does not
  // already know - a flush's `visitUpdates` entries (substep B6).
  it('visitStarted emits no visit event', async () => {
    const { host, emitted } = fakeHost();
    const tracker = createTracker(host);
    await tracker.start(startInput());

    tracker.visitStarted(visit({ id: 7, barId: 99 }));

    expect(emitted.filter((e) => e.type === 'visit')).toEqual([]);
  });

  it('visitEnded emits no visit event', async () => {
    const { host, emitted } = fakeHost();
    const tracker = createTracker(host);
    await tracker.start(startInput());
    tracker.visitStarted(visit({ id: 7, barId: 99 }));

    tracker.visitEnded(7);

    expect(emitted.filter((e) => e.type === 'visit')).toEqual([]);
  });
});

describe('signedOut', () => {
  it('emits sessionLost with cause cookie and goes idle', async () => {
    const { host, emitted } = fakeHost();
    const tracker = createTracker(host);
    await tracker.start(startInput());

    tracker.signedOut();

    expect(emitted).toContainEqual({ type: 'sessionLost', cause: 'cookie' });
    expect(lastTrackingEvent(emitted).state).toBe('idle');
    expect(tracker.snapshotCounters().session.sessionLostByCause.cookie).toBe(1);
  });
});

describe('requestState', () => {
  it('re-emits the current tracking event and changes nothing else', async () => {
    const { host, emitted, requests, configureLocationCalls } = fakeHost();
    const tracker = createTracker(host);
    await tracker.start(startInput());
    const beforeCounters = tracker.snapshotCounters();
    const beforeEvent = lastTrackingEvent(emitted);
    const trackingEventsBefore = emitted.filter((e) => e.type === 'tracking').length;
    const requestsBefore = requests.length;
    const configureLocationCallsBefore = configureLocationCalls.length;

    tracker.requestState();

    const trackingEventsAfter = emitted.filter((e) => e.type === 'tracking');
    expect(trackingEventsAfter).toHaveLength(trackingEventsBefore + 1);
    expect(trackingEventsAfter.at(-1)).toEqual(beforeEvent);
    expect(tracker.snapshotCounters()).toEqual(beforeCounters);
    expect(requests).toHaveLength(requestsBefore);
    expect(configureLocationCalls).toHaveLength(configureLocationCallsBefore);
  });
});

describe('the flush timer (7.4)', () => {
  it('starts on entering tracking, ticks at SAMPLE_MIN_INTERVAL_MS, and stops on signedOut (idle)', async () => {
    const fake = fakeHost();
    const tracker = createTracker(fake.host);
    await tracker.start(startInput());

    const timers = fake.pendingTimers();
    expect(timers).toHaveLength(1);
    expect(timers[0].delayMs).toBe(CONFIG.SAMPLE_MIN_INTERVAL_MS);
    const timerId = timers[0].id;

    tracker.signedOut();

    expect(fake.clearedTimerIds).toContain(timerId);
    expect(fake.pendingTimers()).toHaveLength(0);
  });

  it('stops on blocked and starts again when the authorization lifts the block', async () => {
    const fake = fakeHost();
    const tracker = createTracker(fake.host);
    await tracker.start(startInput());
    const firstTimerId = fake.pendingTimers()[0].id;

    tracker.setAuthorization({ status: 'denied', accuracy: 'fullAccuracy', servicesEnabled: true });

    expect(fake.clearedTimerIds).toContain(firstTimerId);
    expect(fake.pendingTimers()).toHaveLength(0);

    tracker.setAuthorization(fullyAuthorized());

    expect(fake.pendingTimers()).toHaveLength(1);
    expect(fake.pendingTimers()[0].delayMs).toBe(CONFIG.SAMPLE_MIN_INTERVAL_MS);
  });

  it('never starts while idle - no session, no timer', async () => {
    const fake = fakeHost();
    const tracker = createTracker(fake.host);

    await tracker.start(startInput({ hasCookie: false }));

    expect(fake.pendingTimers()).toHaveLength(0);
  });
});

describe('flush - the empty queue', () => {
  it('ticks without posting, and reschedules at the ordinary cadence', async () => {
    const fake = fakeHost();
    const tracker = createTracker(fake.host);
    await tracker.start(startInput());
    const requestsBeforeTick = fake.requests.length;

    fake.fireNextTimer();
    await flushMicrotasks();

    expect(fake.requests).toHaveLength(requestsBeforeTick);
    expect(tracker.snapshotCounters().flushes.attempted).toBe(0);
    expect(fake.pendingTimers()).toHaveLength(1);
    expect(fake.pendingTimers()[0].delayMs).toBe(CONFIG.SAMPLE_MIN_INTERVAL_MS);
  });
});

describe('flush - batching and behind', () => {
  it('posts exactly SAMPLE_MAX_BATCH samples, and behind after success is the remainder', async () => {
    const fake = fakeHost({ samples: jsonResponse(200, validSamplesResponse()) });
    const tracker = createTracker(fake.host);
    await tracker.start(startInput());

    const total = CONFIG.SAMPLE_MAX_BATCH + 10;
    for (let i = 0; i < total; i += 1) {
      tracker.submitFix(sample({ timestamp: BASE_NOW_MS }));
    }
    expect(tracker.snapshotCounters().queue.currentDepth).toBe(total);

    fake.fireNextTimer();
    await flushMicrotasks();

    const samplesRequests = fake.requests.filter((r) => r.path === '/api/samples');
    expect(samplesRequests).toHaveLength(1);
    const body = JSON.parse(samplesRequests[0].body ?? '{}') as { samples: unknown[] };
    expect(body.samples).toHaveLength(CONFIG.SAMPLE_MAX_BATCH);

    const flushEvent = fake.emitted.filter((e): e is FlushEvent => e.type === 'flush').at(-1);
    expect(flushEvent?.sent).toBe(CONFIG.SAMPLE_MAX_BATCH);
    // Matching useSampleTracking's own arithmetic: what was queued at
    // attempt start minus what the batch could carry.
    expect(flushEvent?.behind).toBe(10);
    expect(tracker.snapshotCounters().queue.currentDepth).toBe(10);
    expect(tracker.snapshotCounters().queue.currentBehind).toBe(10);
  });

  it('does not post again while a flush is already in flight', async () => {
    const fake = fakeHost();
    const tracker = createTracker(fake.host);
    await tracker.start(startInput());
    tracker.submitFix(sample());

    // A plain object rather than a reassigned `let`: TypeScript's control
    // flow narrowing does not follow an assignment made inside a callback
    // invoked later, so a `let` here type-narrows to `null` at the point of
    // use below even though the callback has by then run.
    const deferred: { resolve: ((value: HostResponse) => void) | null } = { resolve: null };
    const originalFetch = fake.host.fetch;
    fake.host.fetch = (input) => {
      if (input.method === 'POST' && input.path === '/api/samples') {
        fake.requests.push(input);
        return new Promise<HostResponse>((resolve) => {
          deferred.resolve = resolve;
        });
      }
      return originalFetch(input);
    };

    // Captured once, and fired twice below - simulating a tick landing
    // while the first tick's post is still awaiting a response, which the
    // ordinary self-rescheduling timer (Part 2) never produces on its own.
    const timer = fake.pendingTimers()[0];
    timer.fn();
    await flushMicrotasks();
    expect(fake.requests.filter((r) => r.path === '/api/samples')).toHaveLength(1);

    timer.fn();
    await flushMicrotasks();
    expect(fake.requests.filter((r) => r.path === '/api/samples')).toHaveLength(1);
    expect(tracker.snapshotCounters().flushes.attempted).toBe(1);

    deferred.resolve?.(jsonResponse(200, validSamplesResponse()));
    await flushMicrotasks();
  });
});

describe('flush - dropStale runs before the peek', () => {
  it('drops a sample gone stale while queued, before it can be peeked, counting to droppedStaleAtFlush', async () => {
    const fake = fakeHost({ samples: jsonResponse(200, validSamplesResponse()) });
    const tracker = createTracker(fake.host);
    await tracker.start(startInput());

    tracker.submitFix(sample({ timestamp: BASE_NOW_MS }));
    fake.setNow(BASE_NOW_MS + CONFIG.SAMPLE_MAX_AGE_MS + 1);

    fake.fireNextTimer();
    await flushMicrotasks();

    expect(tracker.snapshotCounters().fixes.droppedStaleAtFlush).toBe(1);
    expect(fake.requests.filter((r) => r.path === '/api/samples')).toHaveLength(0);
    expect(tracker.snapshotCounters().queue.currentDepth).toBe(0);
  });
});

describe('flush - the success path', () => {
  it('moves every counter, removes exactly the sent samples, emits queue then visit then flush, seeds bar positions, and recomputes the profile', async () => {
    const completedVisit = visit({ id: 1, barId: 10, status: 'completed' });
    const discoveredBar: Bar = { ...validBar(20, BAR_POSITION), source: 'osm' };
    const scriptedResponse = validSamplesResponse({
      newCells: 5,
      newBars: [discoveredBar],
      visitUpdates: [completedVisit],
      tooFastToReveal: true,
      rejected: { accuracy: 1, future: 2, stale: 3, outsideCity: 4, tooFast: 5 },
    });
    const fake = fakeHost({
      pendingVisits: jsonResponse(200, { visits: [visit({ id: 1, barId: 10 })] }),
      bars: { 10: jsonResponse(200, validBar(10, BAR_POSITION)) },
      samples: jsonResponse(200, scriptedResponse),
    });
    const tracker = createTracker(fake.host);
    await tracker.start(startInput({ appState: 'background' }));

    // Standing at the only pending visit's bar - the tracker is dwelling.
    tracker.submitFix(sample({ lat: INSIDE_POSITION.lat, lon: INSIDE_POSITION.lon }));
    expect(fake.configureLocationCalls.at(-1)?.distanceFilterM).toBe(
      CONFIG.TRACKER_DWELLING_DISTANCE_FILTER_M,
    );

    const emittedBefore = fake.emitted.length;

    fake.fireNextTimer();
    await flushMicrotasks();

    expect(tracker.snapshotCounters()).toEqual(
      countersWith((c) => {
        c.process.startsByCause.user = 1;
        c.state.transitions.tracking = 1;
        c.state.lastTransitionAtMs = BASE_NOW_MS;
        // Entered walking at start, dwelling on the fix that stood at the
        // visit's bar, and walking again once this flush's completed
        // visit drops the dwelling condition - two entries into walking,
        // one into dwelling.
        c.state.profileActivations.walking = 2;
        c.state.profileActivations.dwelling = 1;
        c.fixes.received = 1;
        c.queue.maxDepthSeen = 1;
        c.flushes.attempted = 1;
        c.flushes.succeeded = 1;
        c.samples.sent = 1;
        c.samples.rejected = { accuracy: 1, future: 2, stale: 3, outsideCity: 4, tooFast: 5 };
        c.results.newCells = 5;
        c.results.barsDiscovered = 1;
        c.results.visitsCompleted = 1;
        c.results.tooFastToRevealBatches = 1;
      }),
    );
    expect(tracker.snapshotCounters().queue.currentDepth).toBe(0);
    expect(tracker.snapshotCounters().queue.currentBehind).toBe(0);

    const emittedDuringFlush = fake.emitted.slice(emittedBefore);
    expect(emittedDuringFlush.map((e) => e.type)).toEqual(['queue', 'visit', 'flush', 'tracking']);
    expect(emittedDuringFlush[1]).toEqual({ ...completedVisit, type: 'visit' });
    const flushEvent = emittedDuringFlush[2] as FlushEvent;
    expect(flushEvent.sent).toBe(1);
    expect(flushEvent.behind).toBe(0);
    expect(flushEvent.newCells).toBe(5);

    // The completed visit was the only thing keeping the tracker dwelling -
    // it drops back to walking.
    expect(fake.configureLocationCalls.at(-1)?.distanceFilterM).toBe(
      CONFIG.TRACKER_WALKING_DISTANCE_FILTER_M,
    );
    expect(lastTrackingEvent(fake.emitted).profile).toBe('walking');

    // The newly discovered bar's position was seeded from `newBars`: a
    // visit starting at it dwells immediately (isDwelling needs a KNOWN bar
    // position - one never seeded would leave this on walking) - with no
    // GET /api/bars/20 to get it.
    const requestsBeforeCheckIn = fake.requests.length;
    tracker.visitStarted(visit({ id: 2, barId: 20 }));
    expect(fake.requests).toHaveLength(requestsBeforeCheckIn);
    expect(fake.configureLocationCalls.at(-1)?.distanceFilterM).toBe(
      CONFIG.TRACKER_DWELLING_DISTANCE_FILTER_M,
    );
  });
});

describe('flush - newBars and its own visitUpdates entry can name the same bar', () => {
  // Bar positions must be seeded from `newBars` BEFORE the profile is
  // recomputed, not after: a bar that stamps onto the map and a check-in at
  // it can share one flush's response (a `pending` visitUpdates entry with
  // no earlier GET /api/bars/:id to have located it). Reaching `dwelling`
  // only on the NEXT fix - correct with the wrong order, "self-correcting"
  // - is not what this test allows; it must be `dwelling` from this flush.
  it('reaches dwelling from this very flush, not from the next fix', async () => {
    const barId = 42;
    const newVisit = visit({ id: 5, barId, status: 'pending' });
    const discoveredBar: Bar = { ...validBar(barId, BAR_POSITION), source: 'osm' };
    const scriptedResponse = validSamplesResponse({
      newBars: [discoveredBar],
      visitUpdates: [newVisit],
    });
    const fake = fakeHost({ samples: jsonResponse(200, scriptedResponse) });
    const tracker = createTracker(fake.host);
    await tracker.start(startInput({ appState: 'background' }));

    // Standing where the bar will turn out to be, before either it or the
    // visit is known to the tracker - this fix alone cannot dwell.
    tracker.submitFix(sample({ lat: INSIDE_POSITION.lat, lon: INSIDE_POSITION.lon }));
    expect(fake.configureLocationCalls.at(-1)?.distanceFilterM).toBe(
      CONFIG.TRACKER_WALKING_DISTANCE_FILTER_M,
    );

    fake.fireNextTimer();
    await flushMicrotasks();

    expect(fake.configureLocationCalls.at(-1)?.distanceFilterM).toBe(
      CONFIG.TRACKER_DWELLING_DISTANCE_FILTER_M,
    );
    expect(lastTrackingEvent(fake.emitted).profile).toBe('dwelling');
  });
});

describe('flush - a failed batch stays queued and is retried', () => {
  it('leaves the batch at the front, behind equals queuedAtAttempt, and the same body is re-sent on the next tick', async () => {
    const scripted: Scripted = {
      samples: jsonResponse(500, { code: 'unknown_error', message: 'oops' }),
    };
    const fake = fakeHost(scripted);
    const tracker = createTracker(fake.host);
    await tracker.start(startInput());
    tracker.submitFix(sample({ timestamp: BASE_NOW_MS }));

    fake.fireNextTimer();
    await flushMicrotasks();

    expect(tracker.snapshotCounters().queue.currentDepth).toBe(1);
    expect(tracker.snapshotCounters().queue.currentBehind).toBe(1);
    expect(fake.emitted.filter((e) => e.type === 'flush')).toEqual([]);
    const firstBody = fake.requests.filter((r) => r.path === '/api/samples').at(-1)?.body;

    scripted.samples = jsonResponse(200, validSamplesResponse());
    fake.fireNextTimer();
    await flushMicrotasks();

    const secondBody = fake.requests.filter((r) => r.path === '/api/samples').at(-1)?.body;
    expect(secondBody).toEqual(firstBody);
    expect(tracker.snapshotCounters().queue.currentDepth).toBe(0);
  });
});

describe('flush - outcomes (7.4, Part 3)', () => {
  it('unauthenticated: sessionLost(unauthenticated), goes idle, stops the timer, no retry', async () => {
    const fake = fakeHost({
      samples: jsonResponse(401, { code: 'unauthenticated', message: 'nope' }),
    });
    const tracker = createTracker(fake.host);
    await tracker.start(startInput());
    tracker.submitFix(sample());

    fake.fireNextTimer();
    await flushMicrotasks();

    expect(tracker.snapshotCounters().session.sessionLostByCause.unauthenticated).toBe(1);
    expect(fake.emitted).toContainEqual({ type: 'sessionLost', cause: 'unauthenticated' });
    expect(lastTrackingEvent(fake.emitted).state).toBe('idle');
    // The tick that produced this outcome had already removed itself
    // (Section 7.4's timer fires once); what proves the timer stopped is
    // that going idle schedules no next one.
    expect(fake.pendingTimers()).toHaveLength(0);
  });

  it('passwordChangeRequired: sessionLost(password_change_required), goes idle, stops the timer, no retry', async () => {
    const fake = fakeHost({
      samples: jsonResponse(403, { code: 'password_change_required', message: 'change it' }),
    });
    const tracker = createTracker(fake.host);
    await tracker.start(startInput());
    tracker.submitFix(sample());

    fake.fireNextTimer();
    await flushMicrotasks();

    expect(tracker.snapshotCounters().session.sessionLostByCause.passwordChangeRequired).toBe(1);
    expect(fake.emitted).toContainEqual({
      type: 'sessionLost',
      cause: 'password_change_required',
    });
    expect(lastTrackingEvent(fake.emitted).state).toBe('idle');
    expect(fake.pendingTimers()).toHaveLength(0);
  });

  it('rateLimited: waits exactly Retry-After, counts 4xx, and resets the failure count', async () => {
    const fake = fakeHost({
      samples: { status: 429, headers: { 'Retry-After': '42' }, body: '{}' },
    });
    const tracker = createTracker(fake.host);
    await tracker.start(startInput());
    tracker.submitFix(sample());

    fake.fireNextTimer();
    await flushMicrotasks();

    expect(tracker.snapshotCounters().flushes.failedByStatusClass['4xx']).toBe(1);
    expect(tracker.snapshotCounters().flushes.backoffCurrentlyInForceMs).toBe(0);
    expect(fake.pendingTimers()[0].delayMs).toBe(42_000);
    // The queue stays put - a rate limit is not a rejection of the batch.
    expect(tracker.snapshotCounters().queue.currentDepth).toBe(1);
  });

  it('httpError 5xx: counts 5xx and backs off at TRACKER_FLUSH_BACKOFF_BASE_MS', async () => {
    const fake = fakeHost({
      samples: jsonResponse(500, { code: 'unknown_error', message: 'oops' }),
    });
    const tracker = createTracker(fake.host);
    await tracker.start(startInput());
    tracker.submitFix(sample());

    fake.fireNextTimer();
    await flushMicrotasks();

    expect(tracker.snapshotCounters().flushes.failedByStatusClass).toEqual({
      '4xx': 0,
      '5xx': 1,
      other: 0,
    });
    expect(tracker.snapshotCounters().flushes.backoffCurrentlyInForceMs).toBe(
      CONFIG.TRACKER_FLUSH_BACKOFF_BASE_MS,
    );
    expect(fake.pendingTimers()[0].delayMs).toBe(CONFIG.TRACKER_FLUSH_BACKOFF_BASE_MS);
  });

  it('httpError other (a 3xx Host.fetch follows no redirect for): counts other', async () => {
    const fake = fakeHost({
      samples: { status: 304, headers: {}, body: '' },
    });
    const tracker = createTracker(fake.host);
    await tracker.start(startInput());
    tracker.submitFix(sample());

    fake.fireNextTimer();
    await flushMicrotasks();

    expect(tracker.snapshotCounters().flushes.failedByStatusClass).toEqual({
      '4xx': 0,
      '5xx': 0,
      other: 1,
    });
  });

  it('notFound: treated as httpError status 404, a 4xx, with backoff', async () => {
    const fake = fakeHost({
      samples: jsonResponse(404, { code: 'not_found', message: 'gone' }),
    });
    const tracker = createTracker(fake.host);
    await tracker.start(startInput());
    tracker.submitFix(sample());

    fake.fireNextTimer();
    await flushMicrotasks();

    expect(tracker.snapshotCounters().flushes.failedByStatusClass).toEqual({
      '4xx': 1,
      '5xx': 0,
      other: 0,
    });
    expect(fake.pendingTimers()[0].delayMs).toBe(CONFIG.TRACKER_FLUSH_BACKOFF_BASE_MS);
  });

  it('invalidResponse: an ordinary failure, counted as other', async () => {
    const fake = fakeHost({
      samples: { status: 200, headers: {}, body: 'not json' },
    });
    const tracker = createTracker(fake.host);
    await tracker.start(startInput());
    tracker.submitFix(sample());

    fake.fireNextTimer();
    await flushMicrotasks();

    expect(tracker.snapshotCounters().flushes.failedByStatusClass).toEqual({
      '4xx': 0,
      '5xx': 0,
      other: 1,
    });
    expect(tracker.snapshotCounters().queue.currentDepth).toBe(1);
  });

  it('transportError: counts transportFailures, backs off, no reachability watching', async () => {
    const fake = fakeHost();
    const tracker = createTracker(fake.host);
    await tracker.start(startInput());
    tracker.submitFix(sample());

    const originalFetch = fake.host.fetch;
    fake.host.fetch = (input) => {
      if (input.method === 'POST' && input.path === '/api/samples') {
        fake.requests.push(input);
        return Promise.reject(new Error('no connectivity'));
      }
      return originalFetch(input);
    };

    fake.fireNextTimer();
    await flushMicrotasks();

    expect(tracker.snapshotCounters().flushes.transportFailures).toBe(1);
    expect(tracker.snapshotCounters().flushes.backoffCurrentlyInForceMs).toBe(
      CONFIG.TRACKER_FLUSH_BACKOFF_BASE_MS,
    );
  });

  it('the backoff doubles per consecutive failure and caps at TRACKER_FLUSH_BACKOFF_MAX_MS', async () => {
    const fake = fakeHost({
      samples: jsonResponse(500, { code: 'unknown_error', message: 'oops' }),
    });
    const tracker = createTracker(fake.host);
    await tracker.start(startInput());
    tracker.submitFix(sample());

    const observedDelays: number[] = [];
    const observedBackoffCounters: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      fake.fireNextTimer();
      await flushMicrotasks();
      observedDelays.push(fake.pendingTimers()[0].delayMs);
      observedBackoffCounters.push(tracker.snapshotCounters().flushes.backoffCurrentlyInForceMs);
    }

    const expectedDelays = Array.from({ length: 10 }, (_, i) =>
      Math.min(CONFIG.TRACKER_FLUSH_BACKOFF_BASE_MS * 2 ** i, CONFIG.TRACKER_FLUSH_BACKOFF_MAX_MS),
    );
    expect(observedDelays).toEqual(expectedDelays);
    expect(observedBackoffCounters).toEqual(expectedDelays);
  });

  it('a success resets consecutiveFailures and the backoff counter to 0', async () => {
    const scripted: Scripted = {
      samples: jsonResponse(500, { code: 'unknown_error', message: 'oops' }),
    };
    const fake = fakeHost(scripted);
    const tracker = createTracker(fake.host);
    await tracker.start(startInput());
    tracker.submitFix(sample());

    fake.fireNextTimer();
    await flushMicrotasks();
    fake.fireNextTimer();
    await flushMicrotasks();
    expect(tracker.snapshotCounters().flushes.backoffCurrentlyInForceMs).toBe(
      CONFIG.TRACKER_FLUSH_BACKOFF_BASE_MS * 2,
    );

    scripted.samples = jsonResponse(200, validSamplesResponse());
    fake.fireNextTimer();
    await flushMicrotasks();

    expect(tracker.snapshotCounters().flushes.backoffCurrentlyInForceMs).toBe(0);
    expect(fake.pendingTimers()[0].delayMs).toBe(CONFIG.SAMPLE_MIN_INTERVAL_MS);
  });
});

describe('flush - the cap-during-flight scenario, end to end', () => {
  // Part 1's defect, exercised through the whole tracker rather than
  // queue.ts alone: a queue at TRACKER_QUEUE_CAP, a batch in flight, and
  // fixes still arriving before that batch's outcome is known. The fixed
  // removeSent must remove only what was actually sent - never a sample
  // that arrived after the batch was posted and was never part of it.
  it('loses no unsent sample when the cap shifts in-flight samples off the front', async () => {
    const fake = fakeHost();
    const tracker = createTracker(fake.host);
    await tracker.start(startInput({ appState: 'background' }));

    for (let i = 0; i < CONFIG.TRACKER_QUEUE_CAP; i += 1) {
      tracker.submitFix(sample({ timestamp: BASE_NOW_MS + i }));
    }
    expect(tracker.snapshotCounters().queue.currentDepth).toBe(CONFIG.TRACKER_QUEUE_CAP);

    const deferred: { resolveFirstFetch: ((value: HostResponse) => void) | null } = {
      resolveFirstFetch: null,
    };
    const originalFetch = fake.host.fetch;
    fake.host.fetch = (input) => {
      if (
        input.method === 'POST' &&
        input.path === '/api/samples' &&
        deferred.resolveFirstFetch === null
      ) {
        fake.requests.push(input);
        return new Promise<HostResponse>((resolve) => {
          deferred.resolveFirstFetch = resolve;
        });
      }
      return originalFetch(input);
    };

    const firstTimer = fake.pendingTimers()[0];
    firstTimer.fn();
    await flushMicrotasks();

    const newFixesCount = 10;
    const newTimestamps: number[] = [];
    for (let i = 0; i < newFixesCount; i += 1) {
      const ts = BASE_NOW_MS + 10_000 + i;
      newTimestamps.push(ts);
      tracker.submitFix(sample({ timestamp: ts }));
    }
    expect(tracker.snapshotCounters().fixes.droppedByCap).toBe(newFixesCount);

    deferred.resolveFirstFetch?.(jsonResponse(200, validSamplesResponse()));
    await flushMicrotasks();

    // Of the batch (SAMPLE_MAX_BATCH samples), newFixesCount were evicted
    // by the cap before the batch's outcome was known - transmitted
    // already, so no loss - and the rest were removed by removeSent. What
    // must remain is everything else: the cap's ceiling, minus what the
    // batch actually removed.
    const expectedRemaining = CONFIG.TRACKER_QUEUE_CAP - (CONFIG.SAMPLE_MAX_BATCH - newFixesCount);
    expect(tracker.snapshotCounters().queue.currentDepth).toBe(expectedRemaining);

    // Drain the rest through the ordinary path, collecting every timestamp
    // this device posts from here on - the ten new fixes must show up
    // somewhere in there, proving they were never silently dropped.
    fake.host.fetch = originalFetch;
    const seenTimestamps: number[] = [];
    while (tracker.snapshotCounters().queue.currentDepth > 0) {
      fake.fireNextTimer();
      await flushMicrotasks();
      const request = fake.requests.at(-1);
      if (request?.method === 'POST' && request.path === '/api/samples') {
        const body = JSON.parse(request.body ?? '{}') as { samples: Sample[] };
        seenTimestamps.push(...body.samples.map((s) => s.timestamp));
      }
    }

    for (const ts of newTimestamps) {
      expect(seenTimestamps).toContain(ts);
    }
    expect(seenTimestamps).toHaveLength(expectedRemaining);
  });
});
