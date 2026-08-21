import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG, DERIVED } from '@tipsytrails/shared';
import { App } from './App.js';
import { markMasteringExplainerSeen } from './tracking/masteringExplainer.js';

// Section 7.5 / Phase 5 step 4: the check-in affordance, the pending-visit
// banner, the out-of-range message, the mastering message and the
// explainer. A separate file from App.test.tsx (already ~1600 lines and
// covering Phases 0-4) rather than another describe block in it, so this
// phase's tests stay easy to find together; the harness below is a trimmed
// copy of App.test.tsx's own (MockMap stand-in, stubFetch, geolocation
// stub) since there is no shared test-utils module to import it from.

const { MockMap, addProtocolMock, removeProtocolMock, mapInstances } = vi.hoisted(() => {
  const instances: { remove: ReturnType<typeof vi.fn>; container: HTMLDivElement }[] = [];
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
    constructor() {
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

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
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

function parseBody(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>;
}

function stubSignedInUser() {
  return jsonResponse(200, {
    id: 1,
    username: 'alice',
    avatarSeed: 'seed',
    isAdmin: false,
    isAnonymous: false,
    mustChangePassword: false,
  });
}

// Fixed at the same coordinates useSampleTracking's geolocation stub reports
// by default - bars placed here are "in range", bars placed noticeably
// further away are not.
const FIXED_LAT = 49.0069;
const FIXED_LON = 8.4037;

function bar(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    districtId: null,
    name: 'The Fox',
    address: 'Kaiserstraße 1',
    lat: FIXED_LAT,
    lon: FIXED_LON,
    source: 'osm',
    discoveredAt: 1_700_000_000,
    ...overrides,
  };
}

interface GeolocationStub {
  watchPosition: ReturnType<typeof vi.fn>;
  clearWatch: ReturnType<typeof vi.fn>;
  triggerPosition: (overrides?: { lat?: number; lon?: number; accuracy?: number }) => void;
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
    triggerPosition(overrides = {}) {
      successCallback?.({
        coords: {
          latitude: overrides.lat ?? FIXED_LAT,
          longitude: overrides.lon ?? FIXED_LON,
          accuracy: overrides.accuracy ?? 10,
          speed: null,
        },
        timestamp: Date.now(),
      } as GeolocationPosition);
    },
  };
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

async function flushLazyMapScreen() {
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
  await flushLazyMapScreen();
  await flushLazyMapScreen();
}

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

// BarMarkers (map/bars/bar-markers.ts) appends its buttons to
// map.getContainer() - MockMap's own `container` field, a detached div that
// is never itself part of the React tree (it stands in for the DOM MapLibre
// would own). Reading markers back out means going through that field, the
// same way App.test.tsx's own marker tests do. The latest instance rather
// than the first: the explainer test below leaves the map screen and returns
// to it, which builds a second map.
function markerContainer(): HTMLElement {
  return mapInstances[mapInstances.length - 1].container;
}

function markerFor(name: string): HTMLButtonElement {
  const element = markerContainer().querySelector(`button.bar-marker[aria-label="${name}"]`);
  if (!element) {
    throw new Error(`No marker rendered for ${name}`);
  }
  return element as HTMLButtonElement;
}

// Section 7.5 step 1: the marker is the only route to a check-in, so every
// test that checks in goes through one.
async function tapMarker(name: string) {
  await act(async () => {
    markerFor(name).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function sheetCheckInButton(): HTMLButtonElement {
  const button = container.querySelector('.bar-sheet__check-in');
  if (!button) {
    throw new Error('The bar sheet is not showing a check-in action');
  }
  return button as HTMLButtonElement;
}

async function clickSheetCheckIn() {
  await act(async () => {
    sheetCheckInButton().click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function remainingSecondsFrom(text: string): number {
  const match = /(\d+):(\d{2}) remaining/.exec(text);
  if (!match) {
    throw new Error(`No remaining-time text found in: ${text}`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function confirmedSecondsFrom(text: string): number {
  const match = /Confirmed (\d+):(\d{2})/.exec(text);
  if (!match) {
    throw new Error(`No confirmed-time text found in: ${text}`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

const ON_SITE_GUIDANCE = "Open Tipsy Trails again while you're still here to complete this visit.";

function bannerText(): string {
  return container.querySelector('.pending-visit-banner')?.textContent ?? '';
}

function bannerItems(): HTMLElement[] {
  return Array.from(container.querySelectorAll('.pending-visit-banner__item'));
}

function itemFor(barName: string): HTMLElement {
  const item = bannerItems().find(
    (entry) => entry.querySelector('.pending-visit-banner__bar')?.textContent === barName,
  );
  if (!item) {
    throw new Error(`No banner item rendered for ${barName}`);
  }
  return item;
}

function pendingVisit(overrides: Record<string, unknown> = {}) {
  const nowS = Math.floor(Date.now() / 1000);
  return {
    id: 1,
    barId: 1,
    barName: 'The Fox',
    startedAt: nowS,
    lastSampleAt: nowS,
    onsiteSamples: 1,
    confirmedS: 0,
    remainingS: DERIVED.VISIT_REQUIRED_S,
    status: 'pending',
    ...overrides,
  };
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
  window.localStorage.clear();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  removeGeolocationStub();
  removeWakeLockStub();
  window.localStorage.clear();
});

describe('check-in and mastering', () => {
  // Section 7.5 step 1: the nearby panel "names the bars currently in range,
  // sorted by distance, and tells the player to tap one on the map. It
  // carries no button and performs no check-in."
  it('names the bars in range, sorted by distance, and tells the player to tap one on the map', async () => {
    const geo = stubGeolocation();
    stubWakeLock();
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url.startsWith('/tiles/')) {
        return jsonResponse(206, {});
      }
      if (url === '/api/bars') {
        return jsonResponse(200, {
          bars: [
            bar({ id: 1, name: 'Mid Bar', lat: FIXED_LAT, lon: FIXED_LON + 0.00034 }),
            bar({ id: 2, name: 'Near Bar', lat: FIXED_LAT, lon: FIXED_LON }),
            bar({ id: 3, name: 'Too Far Bar', lat: FIXED_LAT, lon: FIXED_LON + 0.0069 }),
          ],
        });
      }
      if (url === '/api/visits/pending') {
        return jsonResponse(200, { visits: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderMap();

    expect(container.querySelector('.nearby-bars-panel')).toBeNull();

    act(() => {
      geo.triggerPosition({ accuracy: 10 });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const names = container.querySelectorAll('.nearby-bars-panel__bar');
    expect(Array.from(names).map((name) => name.textContent)).toEqual(['Near Bar', 'Mid Bar']);
    expect(container.querySelector('.nearby-bars-panel__hint')?.textContent).toBe(
      "Tap a bar's marker on the map to check in there.",
    );
  });

  // The whole point of this change: the panel is a statement, not a control.
  // A suggestion made from a position that cannot tell two neighbouring bars
  // apart is exactly what Section 7.5 removed, so the panel must not be able
  // to check in at all - not merely refrain from doing so.
  it('the nearby panel is informational: it renders no control and cannot check in', async () => {
    const geo = stubGeolocation();
    stubWakeLock();
    const fetchMock = stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url.startsWith('/tiles/')) {
        return jsonResponse(206, {});
      }
      if (url === '/api/bars') {
        return jsonResponse(200, { bars: [bar({ id: 1, name: 'The Fox' })] });
      }
      if (url === '/api/visits/pending') {
        return jsonResponse(200, { visits: [] });
      }
      if (url === '/api/visits') {
        return jsonResponse(200, {});
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderMap();

    act(() => {
      geo.triggerPosition({ accuracy: 10 });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const panel = container.querySelector('.nearby-bars-panel');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute('role')).toBe('status');

    // Everything the panel renders is clicked, and no check-in may come of
    // it - the assertion that the panel cannot check in, rather than merely
    // that it currently shows no button. Done before the count below so a
    // panel that grew a control back is caught by both.
    await act(async () => {
      for (const element of Array.from(panel?.querySelectorAll('*') ?? [])) {
        (element as HTMLElement).click();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(fetchMock.mock.calls.some(([input]) => String(input) === '/api/visits')).toBe(false);

    const controls = Array.from(panel?.querySelectorAll('button, a, input') ?? []);
    expect(controls).toHaveLength(0);
  });

  it('opens a sheet for the tapped bar without leaving the map, and closes it again', async () => {
    const geo = stubGeolocation();
    stubWakeLock();
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url.startsWith('/tiles/')) {
        return jsonResponse(206, {});
      }
      if (url === '/api/bars') {
        return jsonResponse(200, {
          bars: [
            bar({ id: 1, name: 'The Fox', address: 'Kaiserstraße 1' }),
            bar({ id: 2, name: 'Anchor Bar', lat: FIXED_LAT, lon: FIXED_LON + 0.00034 }),
          ],
        });
      }
      if (url === '/api/visits/pending') {
        return jsonResponse(200, { visits: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderMap();

    act(() => {
      geo.triggerPosition({ accuracy: 10 });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector('.bar-sheet')).toBeNull();

    await tapMarker('Anchor Bar');

    expect(container.querySelector('.bar-sheet__name')?.textContent).toBe('Anchor Bar');
    // Section 7.5's separability property: the action names the bar it would
    // check into, and it is the tapped one - not the nearest one.
    expect(sheetCheckInButton().textContent).toBe('Check in at Anchor Bar');
    // The map screen is still mounted, so tracking never stopped.
    expect(container.querySelector('.map-container')).not.toBeNull();
    expect(container.querySelector('.bar-detail')).toBeNull();

    const close = container.querySelector('.bar-sheet__close') as HTMLButtonElement;
    expect(close.getAttribute('aria-label')).toBe('Close Anchor Bar');
    await act(async () => {
      close.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector('.bar-sheet')).toBeNull();
  });

  // Section 7.5 step 1: the action is "enabled only while the player is
  // within BAR_ONSITE_RADIUS_M + min(accuracy, BAR_ACCURACY_TOLERANCE_M)".
  // Disabled rather than hidden, with a sentence saying why.
  it('enables the sheet action only inside the on-site radius, and says why when it is off', async () => {
    const geo = stubGeolocation();
    stubWakeLock();
    const fetchMock = stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url.startsWith('/tiles/')) {
        return jsonResponse(206, {});
      }
      if (url === '/api/bars') {
        return jsonResponse(200, {
          bars: [
            bar({ id: 1, name: 'Near Bar', lat: FIXED_LAT, lon: FIXED_LON }),
            bar({ id: 2, name: 'Too Far Bar', lat: FIXED_LAT, lon: FIXED_LON + 0.0069 }),
          ],
        });
      }
      if (url === '/api/visits/pending') {
        return jsonResponse(200, { visits: [] });
      }
      if (url === '/api/visits') {
        return jsonResponse(200, {});
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderMap();

    act(() => {
      geo.triggerPosition({ accuracy: 10 });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await tapMarker('Too Far Bar');

    expect(sheetCheckInButton().disabled).toBe(true);
    expect(container.querySelector('.bar-sheet__reason')?.textContent).toContain(
      "You're too far away from Too Far Bar to check in",
    );

    await clickSheetCheckIn();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === '/api/visits')).toBe(false);

    await tapMarker('Near Bar');

    expect(sheetCheckInButton().disabled).toBe(false);
    expect(container.querySelector('.bar-sheet__reason')).toBeNull();
  });

  // Section 5.7: at most one pending visit per bar - POST /api/visits would
  // answer with the visit that is already open, so the sheet must reflect
  // that state rather than make the round trip.
  it('does not offer a second check-in at a bar that already has a pending visit', async () => {
    const geo = stubGeolocation();
    stubWakeLock();
    const fetchMock = stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url.startsWith('/tiles/')) {
        return jsonResponse(206, {});
      }
      if (url === '/api/bars') {
        return jsonResponse(200, { bars: [bar({ id: 1, name: 'The Fox' })] });
      }
      if (url === '/api/visits/pending') {
        const nowS = Math.floor(Date.now() / 1000);
        return jsonResponse(200, {
          visits: [
            {
              id: 77,
              barId: 1,
              barName: 'The Fox',
              startedAt: nowS,
              lastSampleAt: nowS,
              onsiteSamples: 1,
              confirmedS: 0,
              remainingS: DERIVED.VISIT_REQUIRED_S,
              status: 'pending',
            },
          ],
        });
      }
      if (url === '/api/visits') {
        return jsonResponse(200, {});
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderMap();

    act(() => {
      geo.triggerPosition({ accuracy: 10 });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await tapMarker('The Fox');

    expect(sheetCheckInButton().disabled).toBe(true);
    expect(container.querySelector('.bar-sheet__reason')?.textContent).toContain(
      "You're already checked in at The Fox",
    );

    await clickSheetCheckIn();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === '/api/visits')).toBe(false);
  });

  it('checks in at the bar whose marker was tapped, not at the nearest one', async () => {
    markMasteringExplainerSeen();
    const geo = stubGeolocation();
    stubWakeLock();
    const fetchMock = stubFetch((url, init) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url.startsWith('/tiles/')) {
        return jsonResponse(206, {});
      }
      if (url === '/api/bars') {
        return jsonResponse(200, {
          bars: [
            bar({ id: 1, name: 'Near Bar', lat: FIXED_LAT, lon: FIXED_LON }),
            bar({ id: 2, name: 'Mid Bar', lat: FIXED_LAT, lon: FIXED_LON + 0.00034 }),
          ],
        });
      }
      if (url === '/api/visits/pending') {
        return jsonResponse(200, { visits: [] });
      }
      if (url === '/api/visits' && init?.method === 'POST') {
        const { barId } = parseBody(init);
        const nowS = Math.floor(Date.now() / 1000);
        return jsonResponse(200, {
          id: 502,
          barId,
          barName: barId === 1 ? 'Near Bar' : 'Mid Bar',
          startedAt: nowS,
          lastSampleAt: nowS,
          onsiteSamples: 1,
          confirmedS: 0,
          remainingS: DERIVED.VISIT_REQUIRED_S,
          status: 'pending',
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderMap();

    act(() => {
      geo.triggerPosition({ accuracy: 10 });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Both bars are in range and Near Bar is the closer of the two, so a
    // check-in that followed the position rather than the tap would post
    // barId 1.
    await tapMarker('Mid Bar');
    await clickSheetCheckIn();

    const postCall = fetchMock.mock.calls.find(
      ([input, init]) => String(input) === '/api/visits' && init?.method === 'POST',
    );
    expect(postCall).not.toBeUndefined();
    expect(parseBody(postCall?.[1]).barId).toBe(2);
    expect(container.querySelector('.pending-visit-banner__bar')?.textContent).toBe('Mid Bar');
  });

  it('shows the banner immediately after checking in, without waiting for a sample post', async () => {
    // Not this test's concern (covered separately below) - marked seen so
    // the check-in below does not also navigate to the explainer.
    markMasteringExplainerSeen();
    const geo = stubGeolocation();
    stubWakeLock();
    stubFetch((url, init) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url.startsWith('/tiles/')) {
        return jsonResponse(206, {});
      }
      if (url === '/api/bars') {
        return jsonResponse(200, { bars: [bar({ id: 1, name: 'The Fox' })] });
      }
      if (url === '/api/visits/pending') {
        return jsonResponse(200, { visits: [] });
      }
      if (url === '/api/visits' && init?.method === 'POST') {
        const { barId } = parseBody(init);
        const nowS = Math.floor(Date.now() / 1000);
        return jsonResponse(200, {
          id: 501,
          barId,
          barName: 'The Fox',
          startedAt: nowS,
          lastSampleAt: nowS,
          onsiteSamples: 1,
          confirmedS: 0,
          remainingS: DERIVED.VISIT_REQUIRED_S,
          status: 'pending',
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderMap();

    act(() => {
      geo.triggerPosition({ accuracy: 10 });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector('.pending-visit-banner')).toBeNull();

    await tapMarker('The Fox');
    await clickSheetCheckIn();

    expect(container.querySelector('.pending-visit-banner')).not.toBeNull();
    expect(container.querySelector('.pending-visit-banner__bar')?.textContent).toBe('The Fox');
  });

  // Section 7.5: "The confirmed figure is the server's confirmed_s for that
  // visit ... It is not the wall-clock time since check-in." It steps
  // forward on each accepted on-site sample, holds between samples, and
  // stops at the last confirmed value once the player is out of range. This
  // replaces a test that asserted the figure advanced with the wall clock -
  // behaviour Section 7.5 now forbids, and which recorded only that a number
  // moved, not that it was true.
  it("follows the server's confirmed time: it steps on an accepted sample and holds still once out of range", async () => {
    // The player starts at the bar. One sample post reports the visit's new
    // confirmed_s; every later post reports nothing, standing in for a
    // player who has walked away and whose samples are no longer on site.
    let sampleCalls = 0;
    const geo = stubGeolocation();
    stubWakeLock();
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url.startsWith('/tiles/')) {
        return jsonResponse(206, {});
      }
      if (url === '/api/bars') {
        return jsonResponse(200, { bars: [bar({ id: 1, name: 'The Fox' })] });
      }
      if (url === '/api/visits/pending') {
        const nowS = Math.floor(Date.now() / 1000);
        return jsonResponse(200, {
          visits: [
            {
              id: 1,
              barId: 1,
              barName: 'The Fox',
              startedAt: nowS,
              lastSampleAt: nowS,
              onsiteSamples: 1,
              confirmedS: 0,
              remainingS: DERIVED.VISIT_REQUIRED_S,
              status: 'pending',
            },
          ],
        });
      }
      if (url === '/api/samples') {
        sampleCalls += 1;
        const nowS = Math.floor(Date.now() / 1000);
        return jsonResponse(200, {
          newCells: 0,
          newBars: [],
          visitUpdates:
            sampleCalls === 1
              ? [
                  {
                    id: 1,
                    barId: 1,
                    barName: 'The Fox',
                    startedAt: nowS - 600,
                    lastSampleAt: nowS,
                    onsiteSamples: 2,
                    confirmedS: 600,
                    remainingS: DERIVED.VISIT_REQUIRED_S - 600,
                    status: 'pending',
                  },
                ]
              : [],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    vi.useFakeTimers();
    await renderMapWithFakeTimers();

    // Straight off GET /api/visits/pending: nothing is confirmed yet.
    const initialText = container.querySelector('.pending-visit-banner__time')?.textContent ?? '';
    expect(confirmedSecondsFrom(initialText)).toBe(0);
    expect(remainingSecondsFrom(initialText)).toBe(DERIVED.VISIT_REQUIRED_S);

    // A fix at the bar, then a sample post that comes back with ten minutes
    // confirmed - the figure steps to what the server confirmed, in one go.
    act(() => {
      geo.triggerPosition({ accuracy: 10 });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONFIG.SAMPLE_MIN_INTERVAL_MS);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const steppedText = container.querySelector('.pending-visit-banner__time')?.textContent ?? '';
    expect(confirmedSecondsFrom(steppedText)).toBe(600);
    expect(remainingSecondsFrom(steppedText)).toBe(DERIVED.VISIT_REQUIRED_S - 600);

    // The player walks away: further samples are accepted but touch no
    // visit, and more than a minute of wall clock passes. The figure holds
    // at the last value the server confirmed - it neither ticks up nor
    // resets.
    act(() => {
      geo.triggerPosition({ lat: 49.05, accuracy: 10 });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(65_000);
    });

    expect(container.querySelector('.pending-visit-banner__out-of-range')).not.toBeNull();
    const heldText = container.querySelector('.pending-visit-banner__time')?.textContent ?? '';
    expect(confirmedSecondsFrom(heldText)).toBe(600);
    expect(remainingSecondsFrom(heldText)).toBe(DERIVED.VISIT_REQUIRED_S - 600);
    expect(sampleCalls).toBeGreaterThan(1);
  });

  it('shows the mastered message when POST /api/samples reports a completed visit', async () => {
    const geo = stubGeolocation();
    stubWakeLock();
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url.startsWith('/tiles/')) {
        return jsonResponse(206, {});
      }
      if (url === '/api/bars') {
        return jsonResponse(200, { bars: [] });
      }
      if (url === '/api/visits/pending') {
        return jsonResponse(200, { visits: [] });
      }
      if (url === '/api/samples') {
        return jsonResponse(200, {
          newCells: 0,
          newBars: [],
          visitUpdates: [
            {
              id: 1,
              barId: 1,
              barName: 'The Fox',
              startedAt: 1_700_000_000,
              lastSampleAt: 1_700_001_200,
              onsiteSamples: 2,
              confirmedS: DERIVED.VISIT_REQUIRED_S,
              remainingS: 0,
              status: 'completed',
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    vi.useFakeTimers();
    await renderMapWithFakeTimers();

    act(() => {
      geo.triggerPosition({ accuracy: 10 });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONFIG.SAMPLE_MIN_INTERVAL_MS);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(container.querySelector('.map-toast--mastered')?.textContent).toContain('The Fox');
    expect(container.querySelector('.map-toast--mastered')?.textContent).toContain('mastered');
    expect(container.querySelector('.map-toast--mastered')?.textContent).toContain('permanent');
  });

  it('shows the "still pending" message when the current position moves out of range, without hiding the banner', async () => {
    const geo = stubGeolocation();
    stubWakeLock();
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url.startsWith('/tiles/')) {
        return jsonResponse(206, {});
      }
      if (url === '/api/bars') {
        // A long way from FIXED_LAT/FIXED_LON, so the geolocation stub's
        // default fix (triggered below) is out of range once it arrives.
        return jsonResponse(200, { bars: [bar({ id: 1, name: 'The Fox', lat: 49.05 })] });
      }
      if (url === '/api/visits/pending') {
        const nowS = Math.floor(Date.now() / 1000);
        return jsonResponse(200, {
          visits: [
            {
              id: 1,
              barId: 1,
              barName: 'The Fox',
              startedAt: nowS,
              lastSampleAt: nowS,
              onsiteSamples: 1,
              confirmedS: 0,
              remainingS: DERIVED.VISIT_REQUIRED_S,
              status: 'pending',
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderMap();

    expect(container.querySelector('.pending-visit-banner')).not.toBeNull();
    expect(container.querySelector('.pending-visit-banner__out-of-range')).toBeNull();
    // No position yet, so nothing says the player has moved away: the
    // on-site guidance is what stands.
    expect(bannerText()).toContain(ON_SITE_GUIDANCE);

    act(() => {
      geo.triggerPosition({ accuracy: 10 });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector('.pending-visit-banner')).not.toBeNull();
    expect(container.querySelector('.pending-visit-banner__bar')?.textContent).toBe('The Fox');
    const message = container.querySelector('.pending-visit-banner__out-of-range')?.textContent;
    expect(message).toContain("You've moved away from The Fox");
    expect(message).toContain('still pending');

    // Section 7.5: the away wording *replaces* the on-site one. "You've
    // moved away" directly above "stay where you are and reopen the app" is
    // two sentences that cannot both be true, so the on-site sentence must
    // be gone from the banner entirely - not merely pushed further down it.
    expect(bannerText()).not.toContain(ON_SITE_GUIDANCE);
    expect(bannerText()).toContain(
      'Go back to The Fox and open Tipsy Trails there to finish this visit.',
    );
  });

  // Section 7.5: multiple simultaneous pending visits are allowed, so the
  // guidance belongs to a visit and not to the list. One line under the
  // whole banner cannot be right for two visits in different states, which
  // is the structural half of the defect above.
  it('gives each pending visit its own guidance when one bar is in range and another is not', async () => {
    const geo = stubGeolocation();
    stubWakeLock();
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url.startsWith('/tiles/')) {
        return jsonResponse(206, {});
      }
      if (url === '/api/bars') {
        return jsonResponse(200, {
          bars: [
            bar({ id: 1, name: 'Near Bar', lat: FIXED_LAT, lon: FIXED_LON }),
            bar({ id: 2, name: 'Far Bar', lat: 49.05, lon: FIXED_LON }),
          ],
        });
      }
      if (url === '/api/visits/pending') {
        return jsonResponse(200, {
          visits: [
            pendingVisit({ id: 1, barId: 1, barName: 'Near Bar' }),
            pendingVisit({ id: 2, barId: 2, barName: 'Far Bar' }),
          ],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderMap();

    act(() => {
      geo.triggerPosition({ accuracy: 10 });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const near = itemFor('Near Bar');
    expect(near.textContent).toContain(ON_SITE_GUIDANCE);
    expect(near.querySelector('.pending-visit-banner__out-of-range')).toBeNull();

    const far = itemFor('Far Bar');
    expect(far.textContent).toContain("You've moved away from Far Bar");
    expect(far.textContent).toContain(
      'Go back to Far Bar and open Tipsy Trails there to finish this visit.',
    );
    expect(far.textContent).not.toContain(ON_SITE_GUIDANCE);
  });

  // Section 7.5: the banner carries the cancel control "behind a
  // confirmation, because cancelling throws away whatever confirmed time the
  // visit has accumulated and there is no route back to it".
  it('cancels a pending visit only after a second confirmation that names the bar', async () => {
    const geo = stubGeolocation();
    stubWakeLock();
    const fetchMock = stubFetch((url, init) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url.startsWith('/tiles/')) {
        return jsonResponse(206, {});
      }
      if (url === '/api/bars') {
        return jsonResponse(200, { bars: [bar({ id: 1, name: 'The Fox' })] });
      }
      if (url === '/api/visits/pending') {
        return jsonResponse(200, { visits: [pendingVisit({ id: 77, confirmedS: 300 })] });
      }
      if (url === '/api/visits/77/cancel' && init?.method === 'POST') {
        return jsonResponse(200, pendingVisit({ id: 77, confirmedS: 300, status: 'cancelled' }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderMap();

    act(() => {
      geo.triggerPosition({ accuracy: 10 });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const cancelCalls = () =>
      fetchMock.mock.calls.filter(([input]) => String(input) === '/api/visits/77/cancel');

    // First tap: nothing is cancelled yet, and the confirmation names the
    // bar so it can never be answered about the wrong one.
    await act(async () => {
      (container.querySelector('.pending-visit-banner__cancel') as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(cancelCalls()).toHaveLength(0);
    const confirm = container.querySelector('.pending-visit-banner__confirm');
    expect(confirm?.textContent).toContain('Cancel your visit to The Fox?');
    const confirmButton = container.querySelector(
      '.pending-visit-banner__confirm-cancel',
    ) as HTMLButtonElement;
    expect(confirmButton.textContent).toContain('The Fox');

    // Second tap: now it goes, and the banner stops claiming a visit the
    // player has ended.
    await act(async () => {
      confirmButton.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(cancelCalls()).toHaveLength(1);
    expect(cancelCalls()[0][1]?.method).toBe('POST');
    expect(container.querySelector('.pending-visit-banner')).toBeNull();
  });

  // Section 7.5 allows several simultaneous pending visits at adjacent bars,
  // so the banner is a list and every cancel control in it looks identical.
  // Nothing above this test would notice a control that cancelled the first
  // visit in the list instead of its own - the single-visit tests pass either
  // way, because with one visit the two are the same row. That is the same
  // defect class the check-in tests already guard against on the map ("checks
  // in at the bar whose marker was tapped, not at the nearest one"), and it is
  // worse here: it ends something the player did not choose to end, and
  // cancelling has no route back.
  it('cancels the visit whose control was tapped, not the first one in the list', async () => {
    const geo = stubGeolocation();
    stubWakeLock();
    const fetchMock = stubFetch((url, init) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url.startsWith('/tiles/')) {
        return jsonResponse(206, {});
      }
      if (url === '/api/bars') {
        return jsonResponse(200, {
          bars: [bar({ id: 1, name: 'The Fox' }), bar({ id: 2, name: 'The Hound' })],
        });
      }
      if (url === '/api/visits/pending') {
        return jsonResponse(200, {
          visits: [
            pendingVisit({ id: 77, barId: 1, barName: 'The Fox' }),
            pendingVisit({ id: 88, barId: 2, barName: 'The Hound' }),
          ],
        });
      }
      if (url.endsWith('/cancel') && init?.method === 'POST') {
        return jsonResponse(200, pendingVisit({ id: 88, barId: 2, status: 'cancelled' }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderMap();

    act(() => {
      geo.triggerPosition({ accuracy: 10 });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Deliberately the second item, so a control that reached for
    // `visits[0]` would cancel The Fox and this would catch it.
    const hound = itemFor('The Hound');
    await act(async () => {
      (hound.querySelector('.pending-visit-banner__cancel') as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const confirmButton = itemFor('The Hound').querySelector(
      '.pending-visit-banner__confirm-cancel',
    ) as HTMLButtonElement;
    expect(confirmButton.textContent).toContain('The Hound');
    await act(async () => {
      confirmButton.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const cancelPaths = fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter((path) => path.endsWith('/cancel'));
    expect(cancelPaths).toEqual(['/api/visits/88/cancel']);
  });

  it('keeps the visit when the confirmation is dismissed', async () => {
    const geo = stubGeolocation();
    stubWakeLock();
    const fetchMock = stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url.startsWith('/tiles/')) {
        return jsonResponse(206, {});
      }
      if (url === '/api/bars') {
        return jsonResponse(200, { bars: [bar({ id: 1, name: 'The Fox' })] });
      }
      if (url === '/api/visits/pending') {
        return jsonResponse(200, { visits: [pendingVisit({ id: 77 })] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderMap();

    act(() => {
      geo.triggerPosition({ accuracy: 10 });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      (container.querySelector('.pending-visit-banner__cancel') as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      (container.querySelector('.pending-visit-banner__keep') as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/cancel'))).toBe(false);
    expect(container.querySelector('.pending-visit-banner__confirm')).toBeNull();
    expect(container.querySelector('.pending-visit-banner__bar')?.textContent).toBe('The Fox');
  });

  it('shows the explainer once, automatically, after the first check-in but not after a second', async () => {
    const geo = stubGeolocation();
    stubWakeLock();
    stubFetch((url, init) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url.startsWith('/tiles/')) {
        return jsonResponse(206, {});
      }
      if (url === '/api/bars') {
        return jsonResponse(200, {
          bars: [bar({ id: 1, name: 'The Fox' }), bar({ id: 2, name: 'Anchor Bar' })],
        });
      }
      if (url === '/api/visits/pending') {
        return jsonResponse(200, { visits: [] });
      }
      if (url === '/api/visits' && init?.method === 'POST') {
        const { barId } = parseBody(init);
        const nowS = Math.floor(Date.now() / 1000);
        return jsonResponse(200, {
          id: barId,
          barId,
          barName: barId === 1 ? 'The Fox' : 'Anchor Bar',
          startedAt: nowS,
          lastSampleAt: nowS,
          onsiteSamples: 1,
          confirmedS: 0,
          remainingS: DERIVED.VISIT_REQUIRED_S,
          status: 'pending',
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderMap();
    act(() => {
      geo.triggerPosition({ accuracy: 10 });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await tapMarker('The Fox');
    await clickSheetCheckIn();

    expect(container.querySelector('h1')?.textContent).toBe('How mastering works');

    const backLink = container.querySelector('a[href="/map"]') as HTMLAnchorElement;
    await act(async () => {
      backLink.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flushLazyMapScreen();
    await flushLazyMapScreen();

    act(() => {
      geo.triggerPosition({ accuracy: 10 });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await tapMarker('Anchor Bar');
    await clickSheetCheckIn();

    expect(container.querySelector('.map-container')).not.toBeNull();
    expect(container.querySelector('h1')?.textContent).not.toBe('How mastering works');
  });

  it('is reachable from the burger menu on the map screen regardless of check-in state', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url.startsWith('/tiles/')) {
        return jsonResponse(206, {});
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

    const menuButton = container.querySelector('.burger-menu__button') as HTMLButtonElement;
    act(() => {
      menuButton.click();
    });

    const explainerLink = Array.from(container.querySelectorAll('.burger-menu__panel a')).find(
      (entry) => entry.textContent === 'How mastering works',
    ) as HTMLAnchorElement;
    expect(explainerLink).not.toBeUndefined();

    await act(async () => {
      explainerLink.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector('h1')?.textContent).toBe('How mastering works');
  });
});
