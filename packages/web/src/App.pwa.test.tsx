import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '@tipsytrails/shared';
import { App } from './App.js';

// SPEC.md Section 12, Phase 8 step 1: the PWA shell - manifest and install
// meta tags, a single reconciled service worker, the offline indicator, and
// what "queued samples survive going offline" actually covers. A separate
// file from App.checkin.test.tsx / App.community.test.tsx / App.test.tsx,
// following the same per-phase-step precedent; the map harness below is the
// same trimmed copy of App.test.tsx's own (MockMap stand-in, stubFetch,
// geolocation stub) those two files already use.

const here = import.meta.url;
const WEB_ROOT = fileURLToPath(new URL('..', here));

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

function fogResponse(mask: Uint8Array, progress: unknown) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'X-Fog-Progress': JSON.stringify(progress) }),
    arrayBuffer: async () => mask.buffer.slice(mask.byteOffset, mask.byteOffset + mask.byteLength),
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

function stubSignedInUser(overrides: Record<string, unknown> = {}) {
  return jsonResponse(200, {
    id: 1,
    username: 'alice',
    avatarSeed: 'seed',
    isAdmin: false,
    isAnonymous: false,
    mustChangePassword: false,
    ...overrides,
  });
}

function cityFixture() {
  return jsonResponse(200, {
    slug: 'karlsruhe',
    name: 'Karlsruhe',
    originLat: 48.94,
    originLon: 8.275,
    gridWidth: 3,
    gridHeight: 3,
    cellSizeM: 50,
    playableCells: 9,
    districts: [],
  });
}

interface GeolocationStub {
  triggerPosition: (overrides?: { accuracy?: number }) => void;
}

function stubGeolocation(): GeolocationStub {
  let nextWatchId = 1;
  let successCallback: PositionCallback | null = null;
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: {
      watchPosition: vi.fn((success: PositionCallback) => {
        successCallback = success;
        return nextWatchId++;
      }),
      clearWatch: vi.fn(),
    },
  });
  return {
    triggerPosition(overrides = {}) {
      successCallback?.({
        coords: {
          latitude: 49.0069,
          longitude: 8.4037,
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
  Object.defineProperty(navigator, 'wakeLock', {
    configurable: true,
    value: {
      request: vi.fn().mockResolvedValue({ release: vi.fn().mockResolvedValue(undefined) }),
    },
  });
}

function removeWakeLockStub() {
  delete (navigator as { wakeLock?: unknown }).wakeLock;
}

function setOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: online });
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

async function remountMap() {
  act(() => {
    root.unmount();
  });
  container.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mapInstances.length = 0;
  await renderMap();
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

describe('manifest and install meta', () => {
  it('links the manifest and sets theme-color and the iOS install tags in index.html', () => {
    const html = readFileSync(`${WEB_ROOT}/index.html`, 'utf-8');
    expect(html).toMatch(/<link rel="manifest" href="\/manifest\.json" ?\/?>/);
    expect(html).toMatch(/<meta name="theme-color" content="#f4efe6" ?\/?>/);
    expect(html).toMatch(
      /<link rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png" ?\/?>/,
    );
    expect(html).toContain('apple-mobile-web-app-capable');
  });

  it('serves a valid, installable manifest.json whose icon files actually exist', () => {
    const manifestPath = `${WEB_ROOT}/public/manifest.json`;
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      name: string;
      short_name: string;
      start_url: string;
      display: string;
      theme_color: string;
      background_color: string;
      icons: { src: string; sizes: string }[];
    };

    expect(manifest.name).toBe('Tipsy Trails');
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toBe('#f4efe6');
    expect(manifest.background_color).toBe('#f4efe6');

    const sizes = manifest.icons.map((icon) => icon.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    for (const icon of manifest.icons) {
      expect(existsSync(`${WEB_ROOT}/public${icon.src}`)).toBe(true);
    }
  });
});

describe('a single service worker', () => {
  it('has no second, competing service worker file left behind', () => {
    expect(existsSync(`${WEB_ROOT}/public/sw.js`)).toBe(true);
    expect(existsSync(`${WEB_ROOT}/public/push-sw.js`)).toBe(false);
  });

  it("usePushSubscription registers against the offline shell's own shared URL, not a hardcoded second one", () => {
    const source = readFileSync(`${WEB_ROOT}/src/tracking/usePushSubscription.ts`, 'utf-8');
    expect(source).toContain("import { SERVICE_WORKER_URL } from '../sw/register.js'");
    expect(source).not.toMatch(/['"]\/push-sw\.js['"]/);
    expect(source).not.toMatch(/['"]\/sw\.js['"]/);
  });

  it('sw.js never intercepts /api/* - Section 4.1 marks it private, no-store', () => {
    const source = readFileSync(`${WEB_ROOT}/public/sw.js`, 'utf-8');
    expect(source).toContain("url.pathname.startsWith('/api/')");
  });
});

describe('registerServiceWorker', () => {
  it('registers the exact same URL usePushSubscription imports', async () => {
    const { SERVICE_WORKER_URL } = await import('./sw/register.js');
    expect(SERVICE_WORKER_URL).toBe('/sw.js');
  });
});

describe('offline indicator and queued samples', () => {
  it('shows the offline indicator while the browser reports offline, queues the sample instead of posting it, then posts and clears on reconnect', async () => {
    setOnline(false);
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
        return jsonResponse(200, { bars: [] });
      }
      if (url === '/api/visits/pending') {
        return jsonResponse(200, { visits: [] });
      }
      if (url === '/api/samples') {
        return jsonResponse(200, { newCells: 0, newBars: [], visitUpdates: [] });
      }
      throw new Error(`Unexpected request while offline: ${url}`);
    });

    vi.useFakeTimers();
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

    expect(container.querySelector('.tracking-indicator__button')?.textContent).toContain(
      'Offline',
    );

    act(() => {
      geo.triggerPosition({ accuracy: 10 });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONFIG.SAMPLE_MIN_INTERVAL_MS);
    });

    expect(fetchMock.mock.calls.some(([input]) => input === '/api/samples')).toBe(false);
    expect(container.querySelector('.tracking-indicator__button')?.textContent).toContain(
      'Offline (1 queued)',
    );

    setOnline(true);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(fetchMock.mock.calls.filter(([input]) => input === '/api/samples')).toHaveLength(1);
    expect(container.querySelector('.tracking-indicator__button')?.textContent).toContain('Online');
    expect(container.querySelector('.tracking-indicator__button')?.textContent).not.toContain(
      'queued',
    );
  });
});

describe('fog state offline', () => {
  it('falls back to the last cached fog mask when GET /api/city + GET /api/fog fail on a later mount, e.g. while offline', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url.startsWith('/tiles/')) {
        return jsonResponse(206, {});
      }
      if (url === '/api/city') {
        return cityFixture();
      }
      if (url === '/api/fog') {
        return fogResponse(new Uint8Array([0b0000_0011]), {
          revealedCells: 2,
          playableCells: 9,
          districts: [],
        });
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
    expect(mapInstances[0]?.container.querySelector('canvas.fog-canvas-fallback')).not.toBeNull();

    // Second mount, simulating a fresh page load while offline: /api/city
    // and /api/fog both fail, the same way a real network outage would
    // reject fetch() itself.
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url.startsWith('/tiles/')) {
        return jsonResponse(206, {});
      }
      if (url === '/api/city' || url === '/api/fog') {
        throw new Error('offline');
      }
      if (url === '/api/bars') {
        return jsonResponse(200, { bars: [] });
      }
      if (url === '/api/visits/pending') {
        return jsonResponse(200, { visits: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await remountMap();

    expect(mapInstances[0]?.container.querySelector('canvas.fog-canvas-fallback')).not.toBeNull();
  });

  it('shows no fog layer on a first-ever offline mount, with nothing cached yet', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url.startsWith('/tiles/')) {
        return jsonResponse(206, {});
      }
      if (url === '/api/city' || url === '/api/fog') {
        throw new Error('offline');
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

    expect(mapInstances[0]?.container.querySelector('canvas.fog-canvas-fallback')).toBeNull();
  });

  // Reviewer finding on the first pass: an unkeyed cache let a second
  // account, on the same device, see the first account's revealed-cells
  // mask before its own GET /api/fog succeeded. These two tests exercise
  // the real scenario end to end - not just fog-cache.ts's own unit tests
  // - through the full App, including the burger menu's actual "Log out".
  it("never shows one user's cached fog mask to a different account, even while that account is offline", async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser({ id: 1 });
      }
      if (url.startsWith('/tiles/')) {
        return jsonResponse(206, {});
      }
      if (url === '/api/city') {
        return cityFixture();
      }
      if (url === '/api/fog') {
        return fogResponse(new Uint8Array([0b0000_0011]), {
          revealedCells: 2,
          playableCells: 9,
          districts: [],
        });
      }
      if (url === '/api/bars') {
        return jsonResponse(200, { bars: [] });
      }
      if (url === '/api/visits/pending') {
        return jsonResponse(200, { visits: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    // User 1 explores; their mask is cached under their own id.
    await renderMap();
    expect(mapInstances[0]?.container.querySelector('canvas.fog-canvas-fallback')).not.toBeNull();

    // A different account (id 2) mounts next, offline - if the cache were
    // still keyed globally, this is exactly the moment it would render
    // user 1's mask instead of showing nothing.
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser({ id: 2 });
      }
      if (url.startsWith('/tiles/')) {
        return jsonResponse(206, {});
      }
      if (url === '/api/city' || url === '/api/fog') {
        throw new Error('offline');
      }
      if (url === '/api/bars') {
        return jsonResponse(200, { bars: [] });
      }
      if (url === '/api/visits/pending') {
        return jsonResponse(200, { visits: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await remountMap();

    expect(mapInstances[0]?.container.querySelector('canvas.fog-canvas-fallback')).toBeNull();
  });

  it("logging out via the burger menu clears that user's cached fog mask from localStorage", async () => {
    stubFetch((url, init) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser({ id: 1 });
      }
      if (url === '/api/auth/logout' && init?.method === 'POST') {
        return jsonResponse(200, { ok: true });
      }
      if (url.startsWith('/tiles/')) {
        return jsonResponse(206, {});
      }
      if (url === '/api/city') {
        return cityFixture();
      }
      if (url === '/api/fog') {
        return fogResponse(new Uint8Array([0b0000_0011]), {
          revealedCells: 2,
          playableCells: 9,
          districts: [],
        });
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
    expect(mapInstances[0]?.container.querySelector('canvas.fog-canvas-fallback')).not.toBeNull();
    expect(window.localStorage.getItem('tipsytrails:fog-cache:1')).not.toBeNull();

    const menuButton = container.querySelector('.burger-menu__button') as HTMLButtonElement;
    act(() => {
      menuButton.click();
    });
    const logoutButton = Array.from(container.querySelectorAll('.burger-menu__panel button')).find(
      (button) => button.textContent === 'Log out',
    ) as HTMLButtonElement;

    await act(async () => {
      logoutButton.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(window.localStorage.getItem('tipsytrails:fog-cache:1')).toBeNull();
  });
});
