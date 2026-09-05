import { describe, expect, it } from 'vitest';
import { CONFIG, haversineDistanceM } from '@tipsytrails/shared';
import type { LatLon } from '@tipsytrails/shared';
import { createCounters } from './counters.js';
import type { Counters } from './counters.js';
import type { Sample, TrackerEvent, TrackingEvent, VisitSummary } from './events.js';
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

// A router keyed by "METHOD path" for /api/auth/me and /api/visits/pending,
// and by method + path prefix for /api/bars/:id. Defaults are the happy
// path (consented, no pending visits); a test overrides only what it needs.
interface Scripted {
  me?: HostResponse;
  pendingVisits?: HostResponse;
  bars?: Record<number, HostResponse>;
}

function fakeHost(scripted: Scripted = {}): {
  host: Host;
  requests: HostRequest[];
  emitted: TrackerEvent[];
  configureLocationCalls: LocationProfile[];
  significantChangesCalls: boolean[];
  setNow: (ms: number) => void;
} {
  let nowMs = BASE_NOW_MS;
  const requests: HostRequest[] = [];
  const emitted: TrackerEvent[] = [];
  const configureLocationCalls: LocationProfile[] = [];
  const significantChangesCalls: boolean[] = [];

  // `scripted`'s fields are read fresh on every fetch, not captured once -
  // so a test can mutate `scripted.me` between two `start` calls on the
  // same host to script a second answer (a consent withdrawal, say)
  // without recreating the tracker.
  const host: Host = {
    now: () => nowMs,
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch: async (input) => {
      requests.push(input);
      if (input.method === 'GET' && input.path === '/api/auth/me') {
        return scripted.me ?? jsonResponse(200, validUser(BASE_NOW_MS));
      }
      if (input.method === 'GET' && input.path === '/api/visits/pending') {
        return scripted.pendingVisits ?? jsonResponse(200, { visits: [] });
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
