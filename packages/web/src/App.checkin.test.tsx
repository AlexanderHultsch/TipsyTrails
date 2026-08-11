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

function remainingSecondsFrom(text: string): number {
  const match = /(\d+):(\d{2}) remaining/.exec(text);
  if (!match) {
    throw new Error(`No remaining-time text found in: ${text}`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
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
  it('offers check-in only for discovered bars within range, sorted by distance when several qualify', async () => {
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
            bar({ id: 2, name: 'Mid Bar', lat: FIXED_LAT, lon: FIXED_LON + 0.00034 }),
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

    expect(container.querySelector('.check-in-panel')).toBeNull();

    act(() => {
      geo.triggerPosition({ accuracy: 10 });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const buttons = container.querySelectorAll('.check-in-panel__button');
    expect(Array.from(buttons).map((button) => button.textContent)).toEqual([
      'Check in at Near Bar',
      'Check in at Mid Bar',
    ]);
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

    const checkInButton = container.querySelector('.check-in-panel__button') as HTMLButtonElement;
    expect(checkInButton).not.toBeNull();

    await act(async () => {
      checkInButton.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector('.pending-visit-banner')).not.toBeNull();
    expect(container.querySelector('.pending-visit-banner__bar')?.textContent).toBe('The Fox');
  });

  it("counts the banner's remaining time down between posts, driven by the clock rather than the last server response", async () => {
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

    vi.useFakeTimers();
    await renderMapWithFakeTimers();

    const initialText = container.querySelector('.pending-visit-banner__time')?.textContent ?? '';
    expect(remainingSecondsFrom(initialText)).toBe(DERIVED.VISIT_REQUIRED_S);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(65_000);
    });

    const laterText = container.querySelector('.pending-visit-banner__time')?.textContent ?? '';
    expect(remainingSecondsFrom(laterText)).toBe(DERIVED.VISIT_REQUIRED_S - 65);
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

    const firstButton = Array.from(container.querySelectorAll('.check-in-panel__button')).find(
      (button) => button.textContent === 'Check in at The Fox',
    ) as HTMLButtonElement;
    await act(async () => {
      firstButton.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

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

    const secondButton = Array.from(container.querySelectorAll('.check-in-panel__button')).find(
      (button) => button.textContent === 'Check in at Anchor Bar',
    ) as HTMLButtonElement;
    await act(async () => {
      secondButton.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

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
