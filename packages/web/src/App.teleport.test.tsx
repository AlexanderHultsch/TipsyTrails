import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG, TELEPORT_FIX } from '@tipsytrails/shared';
import { App } from './App.js';
import { clearLastKnownPosition, getLastKnownPosition } from './tracking/lastKnownPosition.js';

// SPEC.md Sections 7.2/8.3/9.3: teleport as a mode the map screen honours,
// rather than a one-shot the client never hears about.
//
// The half this file is about is the client's. `POST /api/admin/teleport`
// shipped moving the server's idea of the admin's position while the browser
// went on watching real GPS - so the marker, the nearby panel and the
// check-in offer all stayed at the phone, the check-in flow could not be
// reached at the destination at all, and every real sample was refused as a
// 300 km/h jump in silence.
//
// A file of its own rather than another block in App.test.tsx (already ~2400
// lines), following App.locate.test.tsx's and App.checkin.test.tsx's
// precedent; the harness below is a trimmed copy of the former's, since
// there is no shared test-utils module to import one from.

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

const cityMeta = {
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

// Both inside the committed Karlsruhe grid: where the phone really is, and
// where the admin teleported to. Far enough apart that no test can pass by
// confusing one for the other.
const REAL_FIX = { lat: 49.0069, lon: 8.4037 };
const TELEPORT_POINT = { lat: 49.0135, lon: 8.4044 };

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function stubSignedInUser(isAdmin: boolean) {
  return jsonResponse(200, {
    id: 1,
    username: 'alice',
    avatarSeed: 'seed',
    isAdmin,
    isAnonymous: false,
    mustChangePassword: false,
  });
}

type FetchHandler = (url: string, init: RequestInit | undefined) => Promise<Response> | Response;

function stubFetch(handler: FetchHandler) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return handler(url, init);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

interface MapStubOptions {
  isAdmin?: boolean;
  // What GET /api/admin/teleport answers. `undefined` means the route is not
  // answered at all, which the harness turns into a thrown "unexpected
  // request" - that is how the non-admin test proves the request is never
  // sent rather than merely not acted on.
  teleport?: () => Response;
  onClear?: () => Response;
}

function stubMapFetch(options: MapStubOptions = {}) {
  const isAdmin = options.isAdmin ?? true;
  return stubFetch((url, init) => {
    if (url.startsWith('/api/auth/me')) {
      return stubSignedInUser(isAdmin);
    }
    if (url.startsWith('/tiles/')) {
      return jsonResponse(206, {});
    }
    if (url === '/api/city') {
      return jsonResponse(200, cityMeta);
    }
    if (url === '/api/bars') {
      return jsonResponse(200, { bars: [] });
    }
    if (url === '/api/visits/pending') {
      return jsonResponse(200, { visits: [] });
    }
    if (url === '/api/samples') {
      return jsonResponse(200, { newCells: 0, newBars: [], visitUpdates: [] });
    }
    if (url === '/api/admin/teleport' && init?.method === 'DELETE') {
      return (options.onClear ?? (() => jsonResponse(200, { ok: true })))();
    }
    if (url === '/api/admin/teleport' && options.teleport) {
      return options.teleport();
    }
    throw new Error(`Unexpected request: ${url}`);
  });
}

function notTeleported() {
  return jsonResponse(200, { position: null });
}

function teleportedTo(position: { lat: number; lon: number }) {
  return jsonResponse(200, { position });
}

// The 404 a server started without ADMIN_TELEPORT_ENABLED answers: the route
// is not registered, so Fastify's own not-found body comes back with no
// `code` at all (Section 9.5's first documented exception).
function teleportRouteMissing() {
  return jsonResponse(404, {
    message: 'Route GET:/api/admin/teleport not found',
    error: 'Not Found',
    statusCode: 404,
  });
}

interface GeolocationStub {
  watchPosition: ReturnType<typeof vi.fn>;
  clearWatch: ReturnType<typeof vi.fn>;
  triggerPosition: (position?: { lat: number; lon: number }) => void;
}

function stubGeolocation(): GeolocationStub {
  let nextWatchId = 1;
  let successCallback: PositionCallback | null = null;
  const clearWatch = vi.fn();
  const watchPosition = vi.fn((success: PositionCallback) => {
    successCallback = success;
    return nextWatchId++;
  });
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: { watchPosition, clearWatch },
  });
  return {
    watchPosition,
    clearWatch,
    triggerPosition(position = REAL_FIX) {
      successCallback?.({
        coords: {
          latitude: position.lat,
          longitude: position.lon,
          accuracy: 10,
          speed: null,
          heading: null,
        },
        timestamp: Date.now(),
      } as GeolocationPosition);
    },
  };
}

function removeGeolocationStub() {
  delete (navigator as { geolocation?: unknown }).geolocation;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
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
  // The map route is behind React.lazy (Section 12's code-splitting
  // requirement), GET /api/city settles a turn after that, and
  // GET /api/admin/teleport a turn after that again.
  await flush();
  await flush();
}

// The same render, flushed through the fake timers a test installs before
// it - the sample cadence is a setInterval created by the mount effect, so
// the timers have to be fake before the screen mounts or the interval that
// matters is a real one this test can never advance.
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

function banner() {
  return container.querySelector('.map-teleport');
}

function leaveButton() {
  return container.querySelector('.map-teleport__leave') as HTMLButtonElement | null;
}

function sampleBodies(mock: ReturnType<typeof stubFetch>) {
  return mock.mock.calls
    .filter(([input]) => input === '/api/samples')
    .map(([, init]) => JSON.parse((init as RequestInit).body as string) as { samples: unknown[] });
}

function teleportCalls(mock: ReturnType<typeof stubFetch>, method?: string) {
  return mock.mock.calls.filter(
    ([input, init]) =>
      input === '/api/admin/teleport' && (init as RequestInit | undefined)?.method === method,
  );
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
  clearLastKnownPosition();
  window.localStorage.clear();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  removeGeolocationStub();
  clearLastKnownPosition();
  window.localStorage.clear();
});

describe('learning the teleport state (SPEC.md Section 9.3)', () => {
  // The rule that keeps the feature invisible to the people it is not for.
  // The map screen asks only when `useCurrentUser` says the account is an
  // admin - a non-admin sending a request that comes back 403 would both
  // fail for no reason and advertise a route they cannot use.
  it('never asks for it on a non-admin map screen', async () => {
    const geo = stubGeolocation();
    const fetchMock = stubMapFetch({ isAdmin: false });

    await renderMap();

    expect(fetchMock.mock.calls.map(([input]) => input)).not.toContain('/api/admin/teleport');
    // ...and that map watches GPS exactly as it always has.
    expect(geo.watchPosition).toHaveBeenCalled();
    expect(banner()).toBeNull();
  });

  it('asks once on an admin map screen, and watches GPS when the answer is null', async () => {
    const geo = stubGeolocation();
    const fetchMock = stubMapFetch({ teleport: notTeleported });

    await renderMap();

    expect(teleportCalls(fetchMock, undefined)).toHaveLength(1);
    expect(geo.watchPosition).toHaveBeenCalledTimes(1);
    expect(banner()).toBeNull();
  });

  // A server started without ADMIN_TELEPORT_ENABLED has no such route. That
  // is "not teleported", not a failure: nothing is shown, and the map
  // behaves exactly as it did before this feature existed.
  it('treats a 404 as not teleported rather than as an error', async () => {
    const geo = stubGeolocation();
    stubMapFetch({ teleport: teleportRouteMissing });

    await renderMap();

    expect(geo.watchPosition).toHaveBeenCalledTimes(1);
    expect(banner()).toBeNull();
    expect(container.querySelector('.error-message')).toBeNull();
  });

  // The same answer for a request that never came back at all. The app then
  // behaves as it did before the feature existed, which is the right way for
  // this particular request to fail.
  it('treats a network failure the same way', async () => {
    const geo = stubGeolocation();
    stubFetch((url) => {
      if (url === '/api/admin/teleport') {
        return Promise.reject(new Error('offline'));
      }
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser(true);
      }
      if (url.startsWith('/tiles/')) {
        return jsonResponse(206, {});
      }
      if (url === '/api/city') {
        return jsonResponse(200, cityMeta);
      }
      if (url === '/api/bars') {
        return jsonResponse(200, { bars: [] });
      }
      if (url === '/api/visits/pending') {
        return jsonResponse(200, { visits: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderMap();

    expect(geo.watchPosition).toHaveBeenCalledTimes(1);
    expect(banner()).toBeNull();
  });
});

describe('while a teleport stands (SPEC.md Sections 7.2, 9.3)', () => {
  it('does not watch GPS at all', async () => {
    const geo = stubGeolocation();
    stubMapFetch({ teleport: () => teleportedTo(TELEPORT_POINT) });

    await renderMap();

    // Not "starts one and clears it": a watch that runs at all is the
    // battery drain and the phantom position this mode exists to stop.
    expect(geo.watchPosition).not.toHaveBeenCalled();
  });

  // One value fixes the map marker, the nearby-bars panel and the check-in
  // offer together, because all three read `lastPosition` and nothing else.
  // `lastKnownPosition` is the same value for the suggest picker.
  it('reports the teleported point as the position, and centres the map on it', async () => {
    stubGeolocation();
    stubMapFetch({ teleport: () => teleportedTo(TELEPORT_POINT) });

    await renderMap();

    const map = mapInstances[mapInstances.length - 1];
    expect(map.jumpTo).toHaveBeenCalledWith({
      center: [TELEPORT_POINT.lon, TELEPORT_POINT.lat],
    });
    expect(map.container.querySelector('.own-position-marker')).not.toBeNull();
    expect(getLastKnownPosition()).toEqual({
      ...TELEPORT_POINT,
      accuracy: TELEPORT_FIX.accuracy,
      heading: null,
    });
  });

  // The samples that make Section 7.5's mastering reachable from a teleport:
  // a visit needs two on-site samples twenty minutes apart, so a mode that
  // posted nothing could never complete one.
  //
  // They go through POST /api/samples with every ordinary guard on and need
  // no bypass, which is the whole reason that route is untouched: the
  // server's `lastAccepted` is already at this point, so a sample from it
  // implies zero speed. The accuracy and speed are the server's own
  // TELEPORT_FIX rather than numbers chosen here, so a check-in the client
  // offers is one the server will accept.
  it('posts the teleported point on the ordinary cadence, with the fields the route synthesises', async () => {
    stubGeolocation();
    const fetchMock = stubMapFetch({ teleport: () => teleportedTo(TELEPORT_POINT) });

    vi.useFakeTimers();
    await renderMapWithFakeTimers();
    expect(sampleBodies(fetchMock)).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONFIG.SAMPLE_MIN_INTERVAL_MS);
    });

    const bodies = sampleBodies(fetchMock);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].samples).toHaveLength(1);
    const sample = bodies[0].samples[0] as Record<string, unknown>;
    expect(sample.lat).toBe(TELEPORT_POINT.lat);
    expect(sample.lon).toBe(TELEPORT_POINT.lon);
    expect(sample.accuracy).toBe(TELEPORT_FIX.accuracy);
    expect(sample.speed).toBe(TELEPORT_FIX.speed);
    // Nothing else rides along - the same shape the public route has always
    // taken, no flag asking to be checked less (Section 10.1).
    expect(Object.keys(sample).sort()).toEqual(['accuracy', 'lat', 'lon', 'speed', 'timestamp']);
  });

  // An admin who forgets they are teleported files bugs against a phantom.
  it('says so on the map, and offers the way out beside it', async () => {
    stubGeolocation();
    stubMapFetch({ teleport: () => teleportedTo(TELEPORT_POINT) });

    await renderMap();

    expect(banner()).not.toBeNull();
    expect(banner()?.textContent).toContain('Teleported');
    expect(banner()?.textContent).toContain('not your GPS');
    expect(leaveButton()).not.toBeNull();
    expect(leaveButton()?.disabled).toBe(false);
    // The locate control is not that way out and keeps its own job: leaving
    // teleport is a server round-trip that can fail, recentring is a camera
    // move that cannot.
    expect(container.querySelector('button[aria-label="Go to my location"]')).not.toBeNull();
  });
});

describe('leaving the mode (SPEC.md Section 9.3)', () => {
  async function renderTeleportedMap(options: MapStubOptions = {}) {
    const geo = stubGeolocation();
    const fetchMock = stubMapFetch({
      teleport: () => teleportedTo(TELEPORT_POINT),
      ...options,
    });
    await renderMap();
    return { geo, fetchMock };
  }

  // A request, not a local flag: the server has to drop both the teleported
  // position and its `lastAccepted` entry, or the first real fix after this
  // is refused as a jump and the app stops working in silence.
  it('sends the DELETE, drops the banner and starts watching GPS again', async () => {
    const { geo, fetchMock } = await renderTeleportedMap();
    expect(geo.watchPosition).not.toHaveBeenCalled();

    await act(async () => {
      leaveButton()?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();

    expect(teleportCalls(fetchMock, 'DELETE')).toHaveLength(1);
    expect(banner()).toBeNull();
    expect(geo.watchPosition).toHaveBeenCalledTimes(1);
  });

  // Nothing may go on claiming the teleported point once neither side
  // believes it: the marker is gone until a real fix replaces it.
  it('forgets the teleported position rather than leaving it on the map', async () => {
    await renderTeleportedMap();
    const map = mapInstances[mapInstances.length - 1];

    await act(async () => {
      leaveButton()?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();

    expect(map.container.querySelector('.own-position-marker')).toBeNull();
    expect(getLastKnownPosition()).toBeNull();
  });

  // The owner's own words for this control: "the button to zoom back on the
  // actual position". There is nothing to zoom to at the moment of the tap,
  // so the first real fix afterwards is what the map goes to - by the same
  // move the locate control makes, at the same zoom.
  it('zooms back on the real position as soon as one arrives', async () => {
    const { geo } = await renderTeleportedMap();
    const map = mapInstances[mapInstances.length - 1];
    map.flyTo.mockClear();

    await act(async () => {
      leaveButton()?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();
    expect(map.flyTo).not.toHaveBeenCalled();

    act(() => {
      geo.triggerPosition(REAL_FIX);
    });
    await flush();

    expect(map.flyTo).toHaveBeenCalledTimes(1);
    expect(map.flyTo).toHaveBeenCalledWith({
      center: [REAL_FIX.lon, REAL_FIX.lat],
      zoom: CONFIG.MAP_DEFAULT_ZOOM,
    });
  });

  it('centres only once, however many further fixes arrive', async () => {
    const { geo } = await renderTeleportedMap();
    const map = mapInstances[mapInstances.length - 1];
    map.flyTo.mockClear();

    await act(async () => {
      leaveButton()?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();
    act(() => {
      geo.triggerPosition(REAL_FIX);
    });
    await flush();
    act(() => {
      geo.triggerPosition({ lat: REAL_FIX.lat + 0.002, lon: REAL_FIX.lon + 0.002 });
    });
    await flush();

    expect(map.flyTo).toHaveBeenCalledTimes(1);
  });

  // An admin told they were back while the server still had them teleported
  // would be in exactly the state this feature exists to end, so a failed
  // clear keeps the mode and says why.
  it('keeps the mode and shows the reason when the clear fails', async () => {
    const { geo } = await renderTeleportedMap({
      onClear: () => jsonResponse(500, { code: 'unknown_error', message: 'Server on fire.' }),
    });

    await act(async () => {
      leaveButton()?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();

    expect(banner()).not.toBeNull();
    expect(banner()?.textContent).toContain('Server on fire.');
    expect(geo.watchPosition).not.toHaveBeenCalled();
  });
});
