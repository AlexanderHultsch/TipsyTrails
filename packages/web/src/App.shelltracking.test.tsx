import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG, TELEPORT_FIX } from '@tipsytrails/shared';
import { App } from './App.js';
import type { Bar, SamplesResponse, VisitSummary } from './api/types.js';
import type { TrackerEvent } from './shell/events.js';
import type { ShellBridge } from './shell/bridge.js';
import { clearLastKnownPosition, getLastKnownPosition } from './tracking/lastKnownPosition.js';
import { useSampleTracking } from './tracking/useSampleTracking.js';
import type { SampleTrackingState, TeleportMode } from './tracking/useSampleTracking.js';

// ios/SPEC.md 8.3, and 12's row 4 of "The list for `main`": `useSampleTracking`
// gains a second driver, chosen once at mount, and inside the iPhone shell it
// is the one that runs.
//
// **What this file has to prove is mostly what does NOT happen.** Under the
// shell driver there is no `watchPosition`, no wake lock, no queue of the
// hook's own and no `POST /api/samples` - the tracker is the only sampler
// there (ios/SPEC.md I4) - and the four counters are never advanced by a
// payload the bridge replayed. None of that is visible in a browser, and the
// last of it is invisible on a phone too until a player walks back to the map
// and watches bars they found an hour ago announce themselves again. So every
// group below is a spy that must not be called, or a counter that must not
// move, with a live control beside it proving the assertion is not vacuous.
//
// A file of its own rather than another block in App.test.tsx (already ~3500
// lines), following App.teleport.test.tsx's and App.shell.test.tsx's
// precedent; the map harness below is a trimmed copy of the former's and the
// injected shell double is the latter's, since there is no shared test-utils
// module to import either from.
//
// **The Safari path is not re-tested here.** It is tested where it always
// was - App.test.tsx's `position sampling and the status indicator`,
// App.teleport.test.tsx, App.locate.test.tsx, App.checkin.test.tsx,
// App.pwa.test.tsx - and every one of those files is unedited by this change.
// That, and not anything in this file, is the evidence that a seam through the
// hook every screen reads left the browser alone.

const { MockMap, addProtocolMock, removeProtocolMock, mapInstances } = vi.hoisted(() => {
  interface MockMapOptions {
    center?: [number, number];
    zoom?: number;
  }
  const instances: {
    jumpTo: ReturnType<typeof vi.fn>;
    flyTo: ReturnType<typeof vi.fn>;
    project: ReturnType<typeof vi.fn>;
    container: HTMLDivElement;
    options: MockMapOptions;
  }[] = [];
  class MockMap {
    remove = vi.fn();
    on = vi.fn();
    off = vi.fn();
    addLayer = vi.fn();
    removeLayer = vi.fn();
    getLayer = vi.fn();
    loaded = vi.fn(() => true);
    setMaxBounds = vi.fn();
    jumpTo = vi.fn();
    flyTo = vi.fn();
    project = vi.fn(() => ({ x: 0, y: 0 }));
    container = document.createElement('div');
    getContainer = () => this.container;
    options: MockMapOptions;
    constructor(options: MockMapOptions = {}) {
      this.options = options;
      instances.push(this);
    }
  }
  return {
    MockMap,
    addProtocolMock: vi.fn(),
    removeProtocolMock: vi.fn(),
    mapInstances: instances,
  };
});

vi.mock('maplibre-gl', () => ({
  default: {
    Map: MockMap,
    addProtocol: addProtocolMock,
    removeProtocol: removeProtocolMock,
  },
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

// Both inside the committed Karlsruhe grid, and far enough apart that no test
// can pass by confusing one for the other.
const REAL_FIX = { lat: 49.0069, lon: 8.4037 };
const TELEPORT_POINT = { lat: 49.0135, lon: 8.4044 };

const NEW_BAR: Bar = {
  id: 9,
  districtId: null,
  name: 'New Find',
  address: null,
  lat: 49.007,
  lon: 8.404,
  source: 'osm',
  discoveredAt: 1_700_000_000,
  mastered: false,
};

const PENDING_VISIT: VisitSummary = {
  id: 7,
  barId: 9,
  barName: 'New Find',
  startedAt: 1_757_000_000,
  lastSampleAt: 1_757_000_060,
  onsiteSamples: 2,
  confirmedS: 60,
  remainingS: 1140,
  status: 'pending',
};

const COMPLETED_VISIT: VisitSummary = {
  ...PENDING_VISIT,
  status: 'completed',
  remainingS: 0,
};

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

// The committed Karlsruhe grid (SPEC.md 6.2), because the map screen's
// one-time centring only honours a position inside the playable grid - a
// three-cell fixture would put every fix in this file outside it and the
// centring would never be exercised at all.
const CITY_META = {
  slug: 'karlsruhe',
  name: 'Karlsruhe',
  originLat: 48.94,
  originLon: 8.275,
  gridWidth: 417,
  gridHeight: 343,
  cellSizeM: 50,
  playableCells: 143_031,
  districts: [],
};

function fogResponse() {
  const bytes = Math.ceil((CITY_META.gridWidth * CITY_META.gridHeight) / 8);
  return {
    ok: true,
    status: 200,
    headers: new Headers({
      'X-Fog-Progress': JSON.stringify({
        revealedCells: 0,
        playableCells: CITY_META.playableCells,
        districts: [],
      }),
    }),
    arrayBuffer: async () => new ArrayBuffer(bytes),
  } as unknown as Response;
}

function stubSignedInUser() {
  return jsonResponse(200, {
    id: 1,
    username: 'alice',
    avatarSeed: 'seed',
    isAdmin: false,
    isAnonymous: false,
    mustChangePassword: false,
    backgroundTrackingConsentedAt: null,
  });
}

// A handler answers `SKIP` for a request it does not want to take over, and
// `stubMapFetch`'s own defaults answer it instead.
const SKIP = Symbol('not this handler’s request');

type ResponseHandler = (url: string, init: RequestInit | undefined) => Promise<Response> | Response;

type FetchHandler = (
  url: string,
  init: RequestInit | undefined,
) => Promise<Response> | Response | typeof SKIP;

function stubFetch(handler: ResponseHandler) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return handler(url, init);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

// Everything the map screen asks for on mount. `POST /api/samples` is
// deliberately NOT answered: under the shell driver the hook must never send
// one, so an unanswered route turns that into a thrown "unexpected request"
// rather than a silent pass.
function stubMapFetch(handler?: FetchHandler) {
  return stubFetch((url, init) => {
    // The caller's handler is asked first, so a test can replace one of the
    // defaults below rather than only add to them.
    if (handler) {
      const answer = handler(url, init);
      if (answer !== SKIP) {
        return answer;
      }
    }
    if (url.startsWith('/api/auth/me')) {
      return stubSignedInUser();
    }
    if (url.startsWith('/tiles/')) {
      return jsonResponse(206, {});
    }
    if (url === '/api/city') {
      return jsonResponse(200, CITY_META);
    }
    if (url === '/api/fog') {
      return fogResponse();
    }
    if (url === '/api/bars') {
      return jsonResponse(200, { bars: [] });
    }
    if (url === '/api/visits/pending') {
      return jsonResponse(200, { visits: [] });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
}

function callsTo(mock: ReturnType<typeof stubFetch>, url: string) {
  return mock.mock.calls.filter(([input]) => String(input) === url);
}

interface ShellDouble {
  bridge: ShellBridge;
  dispatch: (event: TrackerEvent) => void;
}

// The shell's injected object (ios/SPEC.md 8.1, 8.2) - the same port of
// `userScriptSource` in `ios/TipsyTrails/Web/WebViewController.swift` that
// App.shell.test.tsx uses, and for the same reason: `dispatch` takes a JSON
// **string**, the object caches the latest payload of the four replayable
// types only, and `addListener` replays that cache to the registering listener
// alone, synchronously, with `isReplay` true. The replay is the whole subject
// of this file's most important test, so it is reproduced rather than
// approximated.
function injectShell(): ShellDouble {
  const listeners: ((event: TrackerEvent, isReplay: boolean) => void)[] = [];
  const latest = new Map<string, TrackerEvent>();
  const replayable = ['tracking', 'position', 'queue', 'flush'];

  const bridge: ShellBridge = {
    platform: 'ios',
    shellVersion: '1.0.0',
    trackerVersion: '1.0.0',
    dispatch(json: string) {
      let event: TrackerEvent;
      try {
        event = JSON.parse(json) as TrackerEvent;
      } catch {
        return;
      }
      if (replayable.includes(event.type)) {
        latest.set(event.type, event);
      }
      for (const listener of [...listeners]) {
        listener(event, false);
      }
    },
    addListener(listener) {
      listeners.push(listener);
      for (const event of latest.values()) {
        listener(event, true);
      }
    },
  };
  window.__tipsyTrails = bridge;

  return {
    bridge,
    dispatch: (event) => {
      bridge.dispatch?.(JSON.stringify(event));
    },
  };
}

// 7.5's events, at their inert values, so a fixture names only what its test
// is about. `flushEvent` fills in all five fields of `SamplesResponse`
// (Section 9.6) plus the three the tracker adds, because a `FlushEvent` is a
// `SamplesResponse` and a fixture that omitted one would be a payload no
// tracker could send.
function trackingEvent(
  state: 'idle' | 'tracking' | 'blocked',
  // `background` is the one field of this fixture a test outside 8.3's table
  // has a reason to set: since D3 the third icon reads it (`SPEC.md` 8.6's
  // "on in the background" against "on while open only"), so a test that
  // wants the icon's ok level has to say which of the two it means.
  overrides: { background?: boolean } = {},
): TrackerEvent {
  return {
    type: 'tracking',
    state,
    background: overrides.background ?? false,
    authorization: { status: 'authorizedWhenInUse', accuracy: 'fullAccuracy' },
    lowPower: false,
  };
}

function positionEvent(
  overrides: { lat?: number; lon?: number; accuracy?: number; receivedAt?: number } = {},
): TrackerEvent {
  const receivedAt = overrides.receivedAt ?? Date.now();
  return {
    type: 'position',
    lat: overrides.lat ?? REAL_FIX.lat,
    lon: overrides.lon ?? REAL_FIX.lon,
    accuracy: overrides.accuracy ?? CONFIG.GPS_ACCURACY_GOOD_M,
    speed: null,
    timestamp: receivedAt,
    receivedAt,
  };
}

function queueEvent(queued: number, behind: number): TrackerEvent {
  return { type: 'queue', queued, behind };
}

function flushEvent(
  fields: Partial<SamplesResponse> & { sent?: number; behind?: number; queued?: number } = {},
): TrackerEvent {
  return {
    type: 'flush',
    sent: 1,
    behind: 0,
    queued: 0,
    newCells: 0,
    newBars: [],
    visitUpdates: [],
    tooFastToReveal: false,
    rejected: { accuracy: 0, future: 0, stale: 0, outsideCity: 0, tooFast: 0 },
    ...fields,
  };
}

interface GeolocationStub {
  watchPosition: ReturnType<typeof vi.fn>;
  clearWatch: ReturnType<typeof vi.fn>;
}

function stubGeolocation(): GeolocationStub {
  const clearWatch = vi.fn();
  const watchPosition = vi.fn(() => 1);
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: { watchPosition, clearWatch },
  });
  return { watchPosition, clearWatch };
}

function removeGeolocationStub() {
  delete (navigator as { geolocation?: unknown }).geolocation;
}

function stubWakeLock() {
  const release = vi.fn().mockResolvedValue(undefined);
  const request = vi.fn().mockResolvedValue({ release });
  Object.defineProperty(navigator, 'wakeLock', {
    configurable: true,
    value: { request },
  });
  return { request, release };
}

function removeWakeLockStub() {
  delete (navigator as { wakeLock?: unknown }).wakeLock;
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  document.dispatchEvent(new Event('visibilitychange'));
}

function setOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: online });
  window.dispatchEvent(new Event(online ? 'online' : 'offline'));
}

// The hook on its own, which is where twelve of the thirteen rows of 8.3's
// table are read most directly. The map screen is where the thirteenth - and
// the consumers the counters exist for - are exercised, further down.
let trackingState: SampleTrackingState | null = null;

function TrackingHarness({ teleport }: { teleport: TeleportMode }) {
  trackingState = useSampleTracking(teleport);
  return null;
}

function state(): SampleTrackingState {
  if (!trackingState) {
    throw new Error('The tracking harness has not rendered');
  }
  return trackingState;
}

async function renderTracking(teleport: TeleportMode = { status: 'off' }) {
  await act(async () => {
    root.render(<TrackingHarness teleport={teleport} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function dispatchAll(shell: ShellDouble, ...events: TrackerEvent[]) {
  act(() => {
    for (const event of events) {
      shell.dispatch(event);
    }
  });
}

async function renderMap() {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/map']}>
        <App />
      </MemoryRouter>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// The same render flushed through fake timers, which have to be installed
// before the screen mounts: the cadence is a setInterval created by the mount
// effect, so a real one is an interval no test can advance.
async function renderMapWithFakeTimers() {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/map']}>
        <App />
      </MemoryRouter>,
    );
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

function mapContainer(): HTMLElement {
  return mapInstances[0].container;
}

beforeAll(async () => {
  await import('./screens/Map.js');
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mapInstances.length = 0;
  addProtocolMock.mockClear();
  removeProtocolMock.mockClear();
  trackingState = null;
  clearLastKnownPosition();
  window.localStorage.clear();
  setVisibility('visible');
  setOnline(true);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  removeGeolocationStub();
  removeWakeLockStub();
  clearLastKnownPosition();
  window.localStorage.clear();
  delete window.__tipsyTrails;
  delete window.webkit;
});

// ---------------------------------------------------------------------------
// The seam itself
// ---------------------------------------------------------------------------

describe('the driver seam (ios/SPEC.md 8.3)', () => {
  // The three spies of Step D's Definition of Done, in one test, because they
  // are one claim: inside the shell this hook is a reader of the tracker's
  // events and nothing else (I4, "one sampler"). The routes the map needs are
  // stubbed and `/api/samples` deliberately is not, so a post would throw
  // rather than pass unnoticed.
  it('starts no watch, takes no wake lock and posts no sample under the shell driver', async () => {
    const shell = injectShell();
    const geo = stubGeolocation();
    const wakeLock = stubWakeLock();
    const fetchMock = stubMapFetch();

    vi.useFakeTimers();
    await renderMapWithFakeTimers();

    dispatchAll(
      shell,
      trackingEvent('tracking'),
      positionEvent(),
      queueEvent(3, 0),
      flushEvent({ sent: 3, queued: 0, newCells: 2 }),
    );

    // Several cadence ticks: the interval is still running under this driver
    // (a teleport would need it), and it must find nothing to send.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONFIG.SAMPLE_MIN_INTERVAL_MS * 5);
    });

    expect(geo.watchPosition).not.toHaveBeenCalled();
    expect(wakeLock.request).not.toHaveBeenCalled();
    expect(callsTo(fetchMock, '/api/samples')).toHaveLength(0);
  });

  // The watch is not merely unstarted at mount: no path into one is left
  // registered either. `visibilitychange` is the Safari driver's own event and
  // is not listened for under the shell, so the tab going away and coming back
  // - the moment a player switches apps, which is most of the app's life -
  // starts nothing.
  it('registers no visibility listener, so returning to the page starts no watch', async () => {
    injectShell();
    const geo = stubGeolocation();
    const wakeLock = stubWakeLock();
    stubMapFetch();

    await renderMap();

    act(() => {
      setVisibility('hidden');
    });
    act(() => {
      setVisibility('visible');
    });

    expect(geo.watchPosition).not.toHaveBeenCalled();
    expect(wakeLock.request).not.toHaveBeenCalled();
  });

  // "Chosen once at mount", and this is the direction that matters: a page
  // mounted in a browser stays the browser's whatever arrives afterwards. The
  // control is that the Safari driver did what it always does.
  it('keeps the browser driver for a hook that mounted before a shell appeared', async () => {
    const geo = stubGeolocation();
    stubWakeLock();
    await renderTracking();

    expect(geo.watchPosition).toHaveBeenCalledTimes(1);

    const shell = injectShell();
    dispatchAll(shell, trackingEvent('tracking'), positionEvent({ lat: 1, lon: 2 }));

    expect(state().trackingActive).toBe(true);
    expect(state().lastPosition).toBeNull();
  });

  it('subscribes to nothing in a browser, so a later dispatch reaches no member', async () => {
    stubGeolocation();
    stubWakeLock();
    await renderTracking();

    expect(window.__tipsyTrails).toBeUndefined();
    expect(state().queueDepth).toBe(0);
    expect(state().newBars).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The interface, which does not widen
// ---------------------------------------------------------------------------

// ios/SPEC.md 8.3: "`SampleTrackingState`'s thirteen members are exactly the
// thirteen it has today". Both halves are asserted, because they fail
// differently: the type-level `Missing` below stops a fourteenth member being
// declared at all, and the runtime count stops one being declared and left
// unproduced by a driver.
const SAMPLE_TRACKING_MEMBERS = [
  'gpsStatus',
  'connectionStatus',
  'trackingActive',
  'queueDepth',
  'tooFastToReveal',
  'postError',
  'revealVersion',
  'discoveryVersion',
  'newBars',
  'newBarsVersion',
  'visitUpdates',
  'visitVersion',
  'lastPosition',
] as const satisfies readonly (keyof SampleTrackingState)[];

// A member on the interface that this list does not name makes `Missing`
// something other than `never`, and this line stops compiling. `pnpm
// typecheck` is where a fourteenth member fails first; the test below is where
// it fails if it is declared and never produced.
type Missing = Exclude<keyof SampleTrackingState, (typeof SAMPLE_TRACKING_MEMBERS)[number]>;
const NO_MEMBER_MISSING: Missing extends never ? true : never = true;

describe('SampleTrackingState still has thirteen members (ios/SPEC.md 8.3)', () => {
  it('has exactly the thirteen, under both drivers, and no fourteenth', async () => {
    expect(NO_MEMBER_MISSING).toBe(true);
    expect(SAMPLE_TRACKING_MEMBERS).toHaveLength(13);

    stubGeolocation();
    stubWakeLock();
    await renderTracking();
    expect(Object.keys(state()).sort()).toEqual([...SAMPLE_TRACKING_MEMBERS].sort());

    act(() => {
      root.unmount();
    });
    injectShell();
    root = createRoot(container);
    await renderTracking();
    expect(Object.keys(state()).sort()).toEqual([...SAMPLE_TRACKING_MEMBERS].sort());
  });
});

// ---------------------------------------------------------------------------
// One test per row of 8.3's table
// ---------------------------------------------------------------------------

describe('every row of 8.3’s table, under the shell driver', () => {
  async function mountedShell(teleport: TeleportMode = { status: 'off' }) {
    const shell = injectShell();
    stubGeolocation();
    stubWakeLock();
    await renderTracking(teleport);
    return shell;
  }

  // Row 1. `computeGpsStatus` over the latest `position` event - its sample's
  // accuracy and its `receivedAt` - so SPEC.md 8.6's three states mean what
  // they mean in Safari. The boundaries are the same constants, never a
  // number here.
  it('row 1, gpsStatus: the three states at the configured accuracy boundaries', async () => {
    const shell = await mountedShell();

    dispatchAll(shell, positionEvent({ accuracy: CONFIG.GPS_ACCURACY_GOOD_M }));
    expect(state().gpsStatus).toBe('good');

    dispatchAll(shell, positionEvent({ accuracy: CONFIG.GPS_ACCURACY_FAIR_M }));
    expect(state().gpsStatus).toBe('fair');

    dispatchAll(shell, positionEvent({ accuracy: CONFIG.GPS_ACCURACY_FAIR_M + 1 }));
    expect(state().gpsStatus).toBe('poor');
  });

  // Row 1, second half: the staleness rule, with the timer restarted on each
  // event. 8.3 records that a fix the tracker dropped arrives as *no* event at
  // all, so this is how the shell reaches `poor` for a bad fix - up to
  // GPS_STALE_MS later than Safari reaches it through accuracy, both ending in
  // the same state. That divergence is accepted, not fixed, and this test is
  // where it is written down as behaviour.
  it('row 1, gpsStatus: poor after GPS_STALE_MS with no further position event', async () => {
    vi.useFakeTimers();
    const shell = injectShell();
    stubGeolocation();
    stubWakeLock();
    await act(async () => {
      root.render(<TrackingHarness teleport={{ status: 'off' }} />);
      await vi.advanceTimersByTimeAsync(0);
    });

    dispatchAll(shell, positionEvent({ accuracy: CONFIG.GPS_ACCURACY_GOOD_M }));
    expect(state().gpsStatus).toBe('good');

    // A second event restarts the timer rather than letting the first one's
    // deadline stand.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONFIG.GPS_STALE_MS - 1);
    });
    dispatchAll(shell, positionEvent({ accuracy: CONFIG.GPS_ACCURACY_GOOD_M }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONFIG.GPS_STALE_MS - 1);
    });
    expect(state().gpsStatus).toBe('good');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(state().gpsStatus).toBe('poor');
  });

  // Row 2. The same `computeConnectionStatus(navigator.onLine, behindDepth)`
  // call the hook makes in Safari, over an internal `behindDepth` the driver
  // now feeds from the `behind` of `queue` and `flush`. `behindDepth` is not a
  // member of the interface - no screen can see it - so the connection status
  // is the only place it is observable, which is what this asserts.
  it('row 2, connectionStatus: syncing from the behind of a queue event, online when it clears', async () => {
    const shell = await mountedShell();
    expect(state().connectionStatus).toBe('online');

    dispatchAll(shell, queueEvent(5, 2));
    expect(state().connectionStatus).toBe('syncing');

    dispatchAll(shell, flushEvent({ sent: 5, queued: 0, behind: 0 }));
    expect(state().connectionStatus).toBe('online');
  });

  it('row 2, connectionStatus: offline outranks a clear queue, from navigator.onLine', async () => {
    const shell = await mountedShell();
    dispatchAll(shell, queueEvent(0, 0));
    expect(state().connectionStatus).toBe('online');

    act(() => {
      setOnline(false);
    });
    expect(state().connectionStatus).toBe('offline');

    act(() => {
      setOnline(true);
    });
    expect(state().connectionStatus).toBe('online');
  });

  // Row 3. The tracker's state, across all three of 7.3's - and explicitly
  // NOT the web view's visibility, which is the mutation this test exists to
  // kill. A phone in a pocket with the map unmounted is recording, and that is
  // the entire point of the app.
  it('row 3, trackingActive: true on tracking, false on blocked and idle', async () => {
    const shell = await mountedShell();
    expect(state().trackingActive).toBe(false);

    dispatchAll(shell, trackingEvent('tracking'));
    expect(state().trackingActive).toBe(true);

    dispatchAll(shell, trackingEvent('blocked'));
    expect(state().trackingActive).toBe(false);

    dispatchAll(shell, trackingEvent('tracking'));
    expect(state().trackingActive).toBe(true);

    dispatchAll(shell, trackingEvent('idle'));
    expect(state().trackingActive).toBe(false);
  });

  it('row 3, trackingActive: unmoved by the web view being hidden and shown again', async () => {
    const shell = await mountedShell();
    dispatchAll(shell, trackingEvent('tracking'));

    act(() => {
      setVisibility('hidden');
    });
    expect(state().trackingActive).toBe(true);

    act(() => {
      setVisibility('visible');
    });
    expect(state().trackingActive).toBe(true);
  });

  // Row 4. The tracker's queue is the only queue there is under this driver
  // (7.4), and both events carry its depth.
  it('row 4, queueDepth: the queued of the latest queue or flush event', async () => {
    const shell = await mountedShell();
    expect(state().queueDepth).toBe(0);

    dispatchAll(shell, queueEvent(4, 0));
    expect(state().queueDepth).toBe(4);

    dispatchAll(shell, flushEvent({ sent: 4, queued: 1, behind: 1 }));
    expect(state().queueDepth).toBe(1);

    dispatchAll(shell, queueEvent(2, 1));
    expect(state().queueDepth).toBe(2);
  });

  // Row 5. Replaced by every flush including one that says `false`, exactly as
  // a successful post replaces it in Safari - that is what makes the map's
  // message clear itself once the player slows down.
  it('row 5, tooFastToReveal: replaced by every flush, including with false', async () => {
    const shell = await mountedShell();
    expect(state().tooFastToReveal).toBe(false);

    dispatchAll(shell, flushEvent({ tooFastToReveal: true }));
    expect(state().tooFastToReveal).toBe(true);

    dispatchAll(shell, flushEvent({ tooFastToReveal: false }));
    expect(state().tooFastToReveal).toBe(false);
  });

  // Row 5, the other half of the hook's own rule: a failed flush emits
  // nothing, so the last thing the server said stands. Modelled the way the
  // tracker actually behaves - 7.5 emits `flush` on success only, so a failing
  // run is `queue` events with `behind` rising and no flush at all.
  it('row 5, tooFastToReveal: left standing through a run of failed flushes', async () => {
    const shell = await mountedShell();
    dispatchAll(shell, flushEvent({ tooFastToReveal: true }));

    dispatchAll(shell, queueEvent(6, 3), queueEvent(9, 6), queueEvent(12, 9));

    expect(state().tooFastToReveal).toBe(true);
    expect(state().connectionStatus).toBe('syncing');
  });

  // Row 6. Null, deliberately and permanently. The tracker's failures are not
  // forwarded: a flush that fails is retried with backoff, so by the time a
  // screen exists to show anything the message would describe a state that has
  // usually passed. What the player gets instead is live and self-clearing -
  // `behind` rises and the connection icon says `syncing`, which the previous
  // test asserts happens at the same moment this one asserts nothing is said.
  it('row 6, postError: null through a run in which the tracker’s flushes fail', async () => {
    const shell = await mountedShell();
    expect(state().postError).toBeNull();

    dispatchAll(
      shell,
      trackingEvent('tracking'),
      positionEvent(),
      queueEvent(2, 0),
      queueEvent(4, 2),
      queueEvent(6, 4),
      // The two failures that are not transient are not this member's either:
      // a lost session reloads the web view to its login screen (5.2), and a
      // blocked authorization is the third icon's own state.
      { type: 'sessionLost', cause: 'unauthenticated' },
      trackingEvent('blocked'),
    );

    expect(state().postError).toBeNull();
    expect(state().connectionStatus).toBe('syncing');
  });

  // Rows 7-12, the four counters and the two arrays beside them. Each counter
  // has its own predicate and they are deliberately independent of each other
  // (the interface's own comments say why), so each is asserted moving alone.
  it('row 7, revealVersion: +1 per flush with newCells > 0, and not otherwise', async () => {
    const shell = await mountedShell();
    expect(state().revealVersion).toBe(0);

    dispatchAll(shell, flushEvent({ newCells: 0 }));
    expect(state().revealVersion).toBe(0);

    dispatchAll(shell, flushEvent({ newCells: 3 }));
    expect(state().revealVersion).toBe(1);

    dispatchAll(shell, flushEvent({ newCells: 1 }));
    expect(state().revealVersion).toBe(2);
  });

  it('row 8, discoveryVersion: +1 for a new bar OR a completed visit, and for nothing else', async () => {
    const shell = await mountedShell();
    expect(state().discoveryVersion).toBe(0);

    // A reveal alone is not a change to what the bar list would say.
    dispatchAll(shell, flushEvent({ newCells: 5 }));
    expect(state().discoveryVersion).toBe(0);

    dispatchAll(shell, flushEvent({ newBars: [NEW_BAR] }));
    expect(state().discoveryVersion).toBe(1);

    // A visit that is still pending changes no bar's glass.
    dispatchAll(shell, flushEvent({ visitUpdates: [PENDING_VISIT] }));
    expect(state().discoveryVersion).toBe(1);

    // Mastering does - Section 5.7 - and it is the second of the two reasons.
    dispatchAll(shell, flushEvent({ visitUpdates: [COMPLETED_VISIT] }));
    expect(state().discoveryVersion).toBe(2);
  });

  it('row 9, newBars: replaced by every flush, including with an empty array', async () => {
    const shell = await mountedShell();
    expect(state().newBars).toEqual([]);

    dispatchAll(shell, flushEvent({ newBars: [NEW_BAR] }));
    expect(state().newBars).toEqual([NEW_BAR]);

    dispatchAll(shell, flushEvent({ newBars: [] }));
    expect(state().newBars).toEqual([]);
  });

  it('row 10, newBarsVersion: +1 per flush with a non-empty newBars', async () => {
    const shell = await mountedShell();
    expect(state().newBarsVersion).toBe(0);

    dispatchAll(shell, flushEvent({ newBars: [] }));
    expect(state().newBarsVersion).toBe(0);

    dispatchAll(shell, flushEvent({ newBars: [NEW_BAR] }));
    expect(state().newBarsVersion).toBe(1);

    // Mastering a bar is not discovering one, so this stays where it is while
    // discoveryVersion moves.
    dispatchAll(shell, flushEvent({ visitUpdates: [COMPLETED_VISIT] }));
    expect(state().newBarsVersion).toBe(1);
    expect(state().discoveryVersion).toBe(2);
  });

  it('row 11, visitUpdates: replaced by every flush, including with an empty array', async () => {
    const shell = await mountedShell();
    expect(state().visitUpdates).toEqual([]);

    dispatchAll(shell, flushEvent({ visitUpdates: [PENDING_VISIT] }));
    expect(state().visitUpdates).toEqual([PENDING_VISIT]);

    dispatchAll(shell, flushEvent({ visitUpdates: [] }));
    expect(state().visitUpdates).toEqual([]);
  });

  it('row 12, visitVersion: +1 per flush with a non-empty visitUpdates', async () => {
    const shell = await mountedShell();
    expect(state().visitVersion).toBe(0);

    dispatchAll(shell, flushEvent({ visitUpdates: [] }));
    expect(state().visitVersion).toBe(0);

    dispatchAll(shell, flushEvent({ visitUpdates: [PENDING_VISIT] }));
    expect(state().visitVersion).toBe(1);

    dispatchAll(shell, flushEvent({ visitUpdates: [COMPLETED_VISIT] }));
    expect(state().visitVersion).toBe(2);
  });

  // Row 13. lat, lon and accuracy as sent; heading always null (6.6, O-I3 -
  // the direction cone is absent under the shell rather than pointed the wrong
  // way). The out-of-band holder map/MapPicker.tsx reads is filled from the
  // same value, as it is in Safari.
  it('row 13, lastPosition: the latest position event’s sample, with heading null', async () => {
    const shell = await mountedShell();
    expect(state().lastPosition).toBeNull();

    dispatchAll(shell, positionEvent({ accuracy: 17 }));

    expect(state().lastPosition).toEqual({
      lat: REAL_FIX.lat,
      lon: REAL_FIX.lon,
      accuracy: 17,
      heading: null,
    });
    expect(getLastKnownPosition()).toEqual(state().lastPosition);

    dispatchAll(shell, positionEvent({ lat: TELEPORT_POINT.lat, lon: TELEPORT_POINT.lon }));
    expect(state().lastPosition?.lat).toBe(TELEPORT_POINT.lat);
  });
});

// ---------------------------------------------------------------------------
// The counters, and the replay that must never advance them
// ---------------------------------------------------------------------------

describe('the four counters (ios/SPEC.md 8.2, 8.3)', () => {
  // The bridge already holds a flush when the hook mounts - the tracker has
  // been running in the player's pocket, and the map screen is only now being
  // opened. This is the state a phone is in every single time the map is
  // reopened, and there is no equivalent of it in a browser at all.
  function shellHoldingAFlush(): ShellDouble {
    const shell = injectShell();
    shell.dispatch(
      flushEvent({
        sent: 4,
        queued: 2,
        behind: 1,
        newCells: 6,
        newBars: [NEW_BAR],
        visitUpdates: [COMPLETED_VISIT],
        tooFastToReveal: true,
      }),
    );
    shell.dispatch(trackingEvent('tracking'));
    shell.dispatch(positionEvent({ accuracy: 12 }));
    shell.dispatch(queueEvent(2, 1));
    return shell;
  }

  // The rule in one assertion: the replayed payload SEEDS every
  // replaced-on-every-post member and ADVANCES nothing. Both halves matter -
  // seeding nothing would be a screen that renders empty until the next event,
  // and advancing would be the defect below.
  it('start at nought on mount, seeded but not advanced by the bridge’s replay', async () => {
    shellHoldingAFlush();
    stubGeolocation();
    stubWakeLock();

    await renderTracking();

    expect(state().newBars).toEqual([NEW_BAR]);
    expect(state().visitUpdates).toEqual([COMPLETED_VISIT]);
    expect(state().tooFastToReveal).toBe(true);
    expect(state().queueDepth).toBe(2);
    expect(state().trackingActive).toBe(true);
    expect(state().lastPosition?.accuracy).toBe(12);
    expect(state().connectionStatus).toBe('syncing');

    expect(state().revealVersion).toBe(0);
    expect(state().discoveryVersion).toBe(0);
    expect(state().newBarsVersion).toBe(0);
    expect(state().visitVersion).toBe(0);
  });

  // The control. The identical payload arriving live advances all four, so the
  // test above is asserting a rule and not an accident of the fixture.
  it('are advanced by the same payload arriving live', async () => {
    const shell = injectShell();
    stubGeolocation();
    stubWakeLock();
    await renderTracking();

    dispatchAll(
      shell,
      flushEvent({
        newCells: 6,
        newBars: [NEW_BAR],
        visitUpdates: [COMPLETED_VISIT],
      }),
    );

    expect(state().revealVersion).toBe(1);
    expect(state().discoveryVersion).toBe(1);
    expect(state().newBarsVersion).toBe(1);
    expect(state().visitVersion).toBe(1);
  });

  // The map screen mounts and unmounts freely while the tracker runs on (8.2),
  // and every remount replays the same cached flush. A counter advanced by a
  // replay would therefore fire again on every return to the map, for the rest
  // of the app's life.
  it('stay at nought across a remount that replays the same flush again', async () => {
    shellHoldingAFlush();
    stubGeolocation();
    stubWakeLock();

    await renderTracking();
    act(() => {
      root.unmount();
    });
    root = createRoot(container);
    await renderTracking();

    expect(state().newBars).toEqual([NEW_BAR]);
    expect(state().revealVersion).toBe(0);
    expect(state().discoveryVersion).toBe(0);
    expect(state().newBarsVersion).toBe(0);
    expect(state().visitVersion).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The defect the isReplay mechanism exists to prevent
// ---------------------------------------------------------------------------

describe('a late-mounting map against a bridge that already holds a payload', () => {
  // Step D's second Definition-of-Done item, and the one that matters most:
  // `useBarStamps` and `useVisits` read `version === 0` as "nothing has
  // happened yet in this mount", so a replayed flush that advanced the
  // counters would re-stamp a bar discovered before the map existed and
  // re-announce a bar mastered while the phone was in a pocket - every time
  // the player walked back to the map.
  //
  // It is asserted through the real map screen rather than through the two
  // hooks in isolation, because "stamps nothing, refetches nothing,
  // re-reconciles nothing" is three different observations - the DOM, the
  // fetch mock, and the mastering toast - and the screen is where all three
  // are visible at once.
  function shellHoldingADiscovery(): ShellDouble {
    const shell = injectShell();
    shell.dispatch(
      flushEvent({
        sent: 3,
        queued: 0,
        behind: 0,
        newCells: 4,
        newBars: [NEW_BAR],
        visitUpdates: [COMPLETED_VISIT],
      }),
    );
    return shell;
  }

  it('seeds the arrays and stamps nothing, refetches nothing, re-reconciles nothing', async () => {
    shellHoldingADiscovery();
    stubGeolocation();
    stubWakeLock();
    const fetchMock = stubMapFetch();

    vi.useFakeTimers();
    await renderMapWithFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        CONFIG.FOG_REVEAL_ANIMATION_MS + CONFIG.BAR_STAMP_DURATION_MS,
      );
    });

    // Nothing was stamped: no announcement, no stamp, no scrim.
    expect(mapContainer().querySelector('.bar-stamps__announcement')?.textContent ?? '').toBe('');
    expect(mapContainer().querySelector('.bar-stamp')).toBeNull();
    expect(mapContainer().querySelector('.bar-stamp-scrim')).toBeNull();

    // Nothing was refetched: one GET /api/bars and one GET /api/fog, both the
    // mount's own. A counter advanced by the replay would have made each two.
    expect(callsTo(fetchMock, '/api/bars')).toHaveLength(1);
    expect(callsTo(fetchMock, '/api/fog')).toHaveLength(1);

    // Nothing was re-reconciled: the completed visit did not reach useVisits'
    // merge, so no bar re-announces itself as mastered. GET /api/visits/pending
    // is the mount's own single call.
    expect(container.querySelector('.map-toast--mastered')).toBeNull();
    expect(callsTo(fetchMock, '/api/visits/pending')).toHaveLength(1);

    // And the payload did reach the members it is supposed to seed, which is
    // what makes the four assertions above a rule about counters rather than
    // an event that was dropped on the floor.
    expect(callsTo(fetchMock, '/api/samples')).toHaveLength(0);
  });

  // The control, and the proof that the screen would have reacted: the same
  // payload dispatched live, after the map has mounted, stamps the bar,
  // refetches both lists and announces the mastering.
  it('does all three when the same payload arrives live instead', async () => {
    const shell = injectShell();
    stubGeolocation();
    stubWakeLock();
    let barsCallCount = 0;
    const fetchMock = stubMapFetch((url) => {
      if (url === '/api/bars') {
        barsCallCount++;
        return jsonResponse(200, { bars: barsCallCount === 1 ? [] : [NEW_BAR] });
      }
      return SKIP;
    });

    vi.useFakeTimers();
    await renderMapWithFakeTimers();

    await act(async () => {
      shell.dispatch(
        flushEvent({
          sent: 3,
          newCells: 4,
          newBars: [NEW_BAR],
          visitUpdates: [COMPLETED_VISIT],
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONFIG.FOG_REVEAL_ANIMATION_MS);
    });

    expect(mapContainer().querySelector('.bar-stamps__announcement')?.textContent).toBe(
      'Bar discovered: New Find.',
    );
    expect(mapContainer().querySelector('.bar-stamp')).not.toBeNull();
    expect(callsTo(fetchMock, '/api/bars')).toHaveLength(2);
    expect(callsTo(fetchMock, '/api/fog')).toHaveLength(2);
    expect(container.querySelector('.map-toast--mastered')?.textContent).toContain(
      'New Find mastered.',
    );
  });
});

// ---------------------------------------------------------------------------
// The screens, re-run against the shell driver
// ---------------------------------------------------------------------------

describe('the existing screens, driven by the tracker’s events instead of a watch', () => {
  const STATUS_LEVELS = ['ok', 'degraded', 'bad'];

  function statusLevel(name: 'gps' | 'connection' | 'tracking'): string | undefined {
    const icon = container.querySelector(`.tracking-indicator__icon--${name}`);
    if (!icon) {
      throw new Error(`No ${name} status icon rendered`);
    }
    return STATUS_LEVELS.find((level) =>
      icon.classList.contains(`tracking-indicator__icon--${level}`),
    );
  }

  // SPEC.md 8.6's three icons, unchanged in shape and reading the same three
  // members, from events rather than from a watch. The third icon's four shell
  // states are D3's work and are asserted in App.shellscreens.test.tsx, not
  // here: this block is about the icons still moving at all under the new
  // driver. The one mark D3 left on this test is `background: true` below -
  // before it, any `tracking` event made the icon ok, and now only the state
  // `SPEC.md` 8.6 calls "on in the background" does.
  it('moves all three status icons from tracker events', async () => {
    const shell = injectShell();
    stubGeolocation();
    stubWakeLock();
    stubMapFetch();

    await renderMap();

    expect(statusLevel('gps')).toBe('bad');
    expect(statusLevel('tracking')).toBe('degraded');

    await act(async () => {
      shell.dispatch(positionEvent({ accuracy: CONFIG.GPS_ACCURACY_GOOD_M }));
      shell.dispatch(trackingEvent('tracking', { background: true }));
      shell.dispatch(queueEvent(5, 3));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(statusLevel('gps')).toBe('ok');
    expect(statusLevel('tracking')).toBe('ok');
    expect(statusLevel('connection')).toBe('degraded');
  });

  // The map's own automatic centring, the locate control and the own-position
  // marker all read `lastPosition` and nothing else, so one position event is
  // what proves the screen still has a position at all.
  it('centres the map and enables the locate control from a position event', async () => {
    const shell = injectShell();
    stubGeolocation();
    stubWakeLock();
    stubMapFetch();

    await renderMap();

    expect((container.querySelector('.map-locate') as HTMLButtonElement).disabled).toBe(true);
    expect(mapInstances[0].jumpTo).not.toHaveBeenCalled();

    await act(async () => {
      shell.dispatch(positionEvent());
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect((container.querySelector('.map-locate') as HTMLButtonElement).disabled).toBe(false);
    expect(mapInstances[0].jumpTo).toHaveBeenCalledWith({
      center: [REAL_FIX.lon, REAL_FIX.lat],
    });
  });

  // Section 7.3's speed message, which reads `tooFastToReveal` off the
  // server's own answer - and the answer is the server's whichever side posted
  // the batch, which is why a `flush` event still feeds it.
  it('shows and clears the too-fast message from the flush event’s answer', async () => {
    const shell = injectShell();
    stubGeolocation();
    stubWakeLock();
    stubMapFetch();

    await renderMap();
    expect(container.querySelector('.map-toast--speed')).toBeNull();

    await act(async () => {
      shell.dispatch(flushEvent({ tooFastToReveal: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('.map-toast--speed')).not.toBeNull();

    await act(async () => {
      shell.dispatch(flushEvent({ tooFastToReveal: false }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('.map-toast--speed')).toBeNull();
  });

  // Section 7.5 step 1: the nearby-bars panel and the check-in offer are
  // derived from `lastPosition` through the shared on-site rule, so a position
  // event is what makes a discovered bar reachable for a check-in inside the
  // app.
  it('offers a nearby bar for check-in once a position event puts the player at it', async () => {
    const shell = injectShell();
    stubGeolocation();
    stubWakeLock();
    stubMapFetch((url) => {
      if (url === '/api/bars') {
        return jsonResponse(200, { bars: [{ ...NEW_BAR, lat: REAL_FIX.lat, lon: REAL_FIX.lon }] });
      }
      return SKIP;
    });

    await renderMap();
    expect(container.querySelector('.nearby-bars-panel')).toBeNull();

    await act(async () => {
      shell.dispatch(positionEvent({ accuracy: 5 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector('.nearby-bars-panel')?.textContent).toContain('New Find');
  });
});

// ---------------------------------------------------------------------------
// The teleport, which keeps its own path under both drivers
// ---------------------------------------------------------------------------

describe('a standing teleport under the shell driver (ios/SPEC.md 8.3, O-I8)', () => {
  it('asserts the teleported point, ignores the shell’s fixes for it, and keeps posting', async () => {
    vi.useFakeTimers();
    const shell = injectShell();
    const geo = stubGeolocation();
    const wakeLock = stubWakeLock();
    const fetchMock = stubFetch((url) => {
      if (url === '/api/samples') {
        return jsonResponse(200, {
          newCells: 0,
          newBars: [],
          visitUpdates: [],
          tooFastToReveal: false,
          rejected: { accuracy: 0, future: 0, stale: 0, outsideCity: 0, tooFast: 0 },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await act(async () => {
      root.render(
        <TrackingHarness
          teleport={{ status: 'on', lat: TELEPORT_POINT.lat, lon: TELEPORT_POINT.lon }}
        />,
      );
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(state().lastPosition).toEqual({
      lat: TELEPORT_POINT.lat,
      lon: TELEPORT_POINT.lon,
      accuracy: TELEPORT_FIX.accuracy,
      heading: null,
    });

    // The shell's fixes are the real position, which is the position the mode
    // exists to override.
    dispatchAll(shell, positionEvent({ lat: REAL_FIX.lat, lon: REAL_FIX.lon }));
    expect(state().lastPosition?.lat).toBe(TELEPORT_POINT.lat);

    // The tracker's own queue is not this path's, so it does not write over
    // the counts the teleport's posts produce.
    dispatchAll(shell, queueEvent(11, 7));
    expect(state().queueDepth).toBe(0);
    expect(state().connectionStatus).toBe('online');

    // And the point is posted on the ordinary cadence, through the ordinary
    // route, with no bypass - the one thing this hook still sends under the
    // shell driver (O-I8 records what it costs).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONFIG.SAMPLE_MIN_INTERVAL_MS);
    });
    const posted = callsTo(fetchMock, '/api/samples');
    expect(posted).toHaveLength(1);
    const body = JSON.parse(String((posted[0][1] as RequestInit).body)) as {
      samples: { lat: number; lon: number }[];
    };
    expect(body.samples).toEqual([
      {
        lat: TELEPORT_POINT.lat,
        lon: TELEPORT_POINT.lon,
        accuracy: TELEPORT_FIX.accuracy,
        speed: TELEPORT_FIX.speed,
        timestamp: expect.any(Number) as unknown as number,
      },
    ]);

    // Still no watch and still no wake lock: the teleport is the one exception
    // to "posts nothing", and not an exception to anything else.
    expect(geo.watchPosition).not.toHaveBeenCalled();
    expect(wakeLock.request).not.toHaveBeenCalled();
  });
});
