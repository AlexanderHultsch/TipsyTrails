import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG, DERIVED, gridMapBounds } from '@tipsytrails/shared';
import type { GridParams } from '@tipsytrails/shared';
import { App } from './App.js';
import { ACTIVE_CITY_SLUG } from './api/city.js';
import type { BoundaryFeatureCollection } from './api/geo-types.js';
import { Avatar } from './components/Avatar.js';
import { cocktailGlassPathData } from './components/cocktail-glass.js';

// The real committed seed data (data/seed/karlsruhe), three levels up from
// this file's own directory to the repository root - the same style
// packages/shared/src/city.test.ts and packages/api/src/routes/
// static-data.test.ts use to reach their own committed fixtures. The
// `import.meta.url` indirection through `here` (rather than passing it
// directly as `new URL(path, import.meta.url)`) matters here specifically:
// under this package's jsdom test environment, Vite's static analysis
// rewrites that exact literal pattern into a dev-server asset URL instead
// of leaving it as a file:// URL, and fileURLToPath then rejects it.
const here = import.meta.url;
const SEED_DIR = fileURLToPath(new URL('../../../data/seed/karlsruhe', here));

function loadFixture(filename: string): BoundaryFeatureCollection {
  return JSON.parse(readFileSync(`${SEED_DIR}/${filename}`, 'utf-8')) as BoundaryFeatureCollection;
}

const cityFixture = loadFixture('city.geojson');
const districtsFixture = loadFixture('districts.geojson');
const neighboursFixture = loadFixture('neighbours.geojson');

// One 'M' per ring is what geo/geojson-path.ts's svgPathOfGeometry emits
// (see its ringPath helper) - counting them is a cheap way to check the
// rendered path actually walks every ring of a real Polygon/MultiPolygon
// fixture, not just that some string got produced.
function ringCount(feature: BoundaryFeatureCollection['features'][number]): number {
  return feature.geometry.type === 'Polygon'
    ? feature.geometry.coordinates.length
    : feature.geometry.coordinates.reduce((sum, polygon) => sum + polygon.length, 0);
}

// A GET /api/city body, and the same grid as GridParams - what the map's
// pan limit is derived from (shared's gridMapBounds). The real Karlsruhe
// dimensions (SPEC.md Section 6.2), so the bounds this produces are the
// ones the deployed app computes.
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

const cityMetaGrid: GridParams = {
  origin_lat: cityMeta.originLat,
  origin_lon: cityMeta.originLon,
  grid_width: cityMeta.gridWidth,
  grid_height: cityMeta.gridHeight,
  cell_size_m: cityMeta.cellSizeM,
};

// MapLibre needs a real WebGL context, which jsdom does not provide, so the
// map route is exercised against a stand-in Map class rather than the real
// library. mapInstances lets tests reach the last constructed instance to
// assert on lifecycle calls such as remove().
const { MockMap, addProtocolMock, removeProtocolMock, mapInstances } = vi.hoisted(() => {
  // `on` is declared here as well as `remove` because the map screen's
  // MapLibre error handling can only be exercised by reaching into the
  // registered handlers: the stand-in never fires events by itself, so a
  // test pulls the 'error' listener back out of this mock and calls it.
  //
  // minZoom/maxZoom join center/zoom here because they are constructor
  // options too: the pan limit arrives later (map.setMaxBounds, once GET
  // /api/city answers) but the zoom limits need no metadata and are set
  // straight away.
  interface MockMapOptions {
    center?: [number, number];
    zoom?: number;
    minZoom?: number;
    maxZoom?: number;
  }
  const instances: {
    remove: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    setMaxBounds: ReturnType<typeof vi.fn>;
    addLayer: ReturnType<typeof vi.fn>;
    addSource: ReturnType<typeof vi.fn>;
    container: HTMLDivElement;
    options: MockMapOptions;
  }[] = [];
  // Section 7.3's fog layer (map/fog/) additionally needs loaded()/
  // getContainer() - loaded() true so FogController mounts synchronously
  // instead of waiting for a 'load' event this stand-in never fires, and
  // getContainer() a real element so its 2D canvas fallback (the only path
  // reachable here, since jsdom has no WebGL2 either) has somewhere to
  // attach to. addLayer/removeLayer/getLayer are stubbed too, defensively,
  // for whichever fog tests below force the WebGL2 detector on instead.
  class MockMap {
    remove = vi.fn();
    on = vi.fn();
    off = vi.fn();
    addLayer = vi.fn();
    removeLayer = vi.fn();
    getLayer = vi.fn();
    // Section 7.3's district borders (map/districts/) are the one layer here
    // that brings a source of its own - a GeoJSON one, built from
    // GET /static/<slug>/districts.geojson rather than from the vector tiles.
    addSource = vi.fn();
    getSource = vi.fn();
    removeSource = vi.fn();
    loaded = vi.fn(() => true);
    setMaxBounds = vi.fn();
    // map/bars/bar-markers.ts's only other dependency on the real map
    // beyond on/off/getContainer above - an arbitrary fixed point is fine
    // since these tests assert marker presence and behaviour, not screen
    // position (map/bars/bar-markers.test.ts covers real reprojection
    // against its own hand-built fake map).
    project = vi.fn(() => ({ x: 0, y: 0 }));
    // The own-position marker's direction cone is drawn at the course minus
    // this bearing (map/position/own-position-marker.ts), so a fix carrying
    // a course reaches for it. North-up here; the rotation itself is
    // asserted against a turned map in that file's own tests.
    getBearing = vi.fn(() => 0);
    container = document.createElement('div');
    getContainer = () => this.container;
    // Recorded so a test can assert which centre the screen actually asked
    // for - the difference between Karlsruhe and Null Island is invisible
    // to every other assertion here, and was a real shipped bug.
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

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

// GET /api/fog's shape (packages/api/src/routes/fog.ts, api/client.ts's
// getFogMask): a raw application/octet-stream body plus the per-district
// counts in an X-Fog-Progress header - jsonResponse above doesn't fit it.
function fogResponse(mask: Uint8Array, progress: unknown) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'X-Fog-Progress': JSON.stringify(progress) }),
    arrayBuffer: async () => mask.buffer.slice(mask.byteOffset, mask.byteOffset + mask.byteLength),
  } as unknown as Response;
}

// React wraps the native `value` setter on controlled inputs to track
// whether a change actually happened. Assigning `.value` directly goes
// through that wrapper and updates the tracker too, so the following
// `input` event is seen as a no-op change. Going through the native
// prototype setter bypasses the wrapper, the way real typing does.
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  'value',
)?.set;

function setInputValue(input: HTMLInputElement, value: string) {
  nativeInputValueSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
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

async function renderApp(initialPath: string) {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[initialPath]}>
        <App />
      </MemoryRouter>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function submit(button: Element) {
  await act(async () => {
    (button as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// The map route is behind React.lazy (Section 12's code-splitting
// requirement), which resolves over an extra microtask turn beyond the one
// tick renderApp already waits out - enough for ordinary async screens, not
// for a dynamic import settling and then its own effects running.
async function flushLazyMapScreen() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// Same shape as renderApp + flushLazyMapScreen, but flushed via the fake
// timers the tracking tests below install - jsdom has no real timers worth
// waiting on for the sample-batching throttle, per the task brief.
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
}

interface GeolocationStub {
  watchPosition: ReturnType<typeof vi.fn>;
  clearWatch: ReturnType<typeof vi.fn>;
  triggerPosition: (overrides?: {
    accuracy?: number;
    speed?: number | null;
    heading?: number | null;
  }) => void;
}

// jsdom implements no Geolocation API at all, so navigator.geolocation is
// defined fresh on the instance for each test that needs it, and removed
// again afterwards.
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
          latitude: 49.0069,
          longitude: 8.4037,
          accuracy: overrides.accuracy ?? 10,
          speed: overrides.speed ?? null,
          heading: overrides.heading ?? null,
        },
        timestamp: Date.now(),
      } as GeolocationPosition);
    },
  };
}

function removeGeolocationStub() {
  delete (navigator as { geolocation?: unknown }).geolocation;
}

// jsdom implements no Screen Wake Lock API either.
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

function setOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: online });
}

// React.lazy's dynamic import resolves over real module-transform time on
// its first call, not just a microtask tick - noticeably longer than the
// single setTimeout(0) flush used elsewhere in this file. Priming it once
// up front keeps every /map test's timing uniform.
beforeAll(async () => {
  await import('./screens/Map.js');
  await import('./screens/SuggestBar.js');
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mapInstances.length = 0;
  addProtocolMock.mockClear();
  removeProtocolMock.mockClear();
  // Phase 8: map/fog/fog-cache.ts now writes a fog snapshot to localStorage
  // on every successful GET /api/city + GET /api/fog pair. Without this,
  // the one test below that stubs both (the fog mask/canvas-fallback test)
  // would leave a cached mask that every later /map test in this file -
  // most of which never stub those two routes at all - would pick up
  // through useFogLayer's own offline fallback, rendering fog they never
  // asked for. Same clearing App.checkin.test.tsx already does for the
  // mastering-explainer flag, for the same cross-test-leakage reason.
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
  setOnline(true);
  window.localStorage.clear();
});

describe('App', () => {
  it('renders the landing page when signed out', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return jsonResponse(401, { code: 'unauthenticated', message: 'Authentication required.' });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/');

    expect(container.textContent).toContain('Tipsy Trails');
    expect(container.textContent).toContain('A location-based exploration game for Karlsruhe.');
    expect(container.querySelector('a[href="/login"]')).not.toBeNull();
    expect(container.querySelector('a[href="/register"]')).not.toBeNull();
  });

  it('does not submit the register form while the 18+ box is unchecked, and does once it is ticked', async () => {
    const fetchMock = stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return jsonResponse(401, { code: 'unauthenticated', message: 'Authentication required.' });
      }
      if (url === '/api/auth/register') {
        return jsonResponse(201, {
          id: 1,
          username: 'alice',
          avatarSeed: 'seed',
          isAdmin: false,
          isAnonymous: false,
          mustChangePassword: false,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/register');

    const usernameInput = container.querySelector('#register-username') as HTMLInputElement;
    const passwordInput = container.querySelector('#register-password') as HTMLInputElement;
    const questionInput = container.querySelector(
      '#register-security-question',
    ) as HTMLInputElement;
    const answerInput = container.querySelector('#register-security-answer') as HTMLInputElement;
    const checkbox = container.querySelector('#register-age-confirmed') as HTMLInputElement;
    const submitButton = container.querySelector('button[type="submit"]') as HTMLButtonElement;

    act(() => {
      setInputValue(usernameInput, 'alice');
      setInputValue(passwordInput, 'correct-horse-battery');
      setInputValue(questionInput, 'Favourite bar?');
      setInputValue(answerInput, 'This one');
    });

    expect(checkbox.checked).toBe(false);

    await submit(submitButton);

    expect(fetchMock.mock.calls.some(([input]) => input === '/api/auth/register')).toBe(false);
    expect(container.textContent).toContain('18 years of age or older');

    act(() => {
      checkbox.click();
    });
    expect(checkbox.checked).toBe(true);

    await submit(submitButton);

    const registerCall = fetchMock.mock.calls.find(([input]) => input === '/api/auth/register');
    expect(registerCall).toBeDefined();
    const body = JSON.parse((registerCall?.[1] as RequestInit).body as string);
    expect(body).toMatchObject({
      username: 'alice',
      password: 'correct-horse-battery',
      securityQuestion: 'Favourite bar?',
      securityAnswer: 'This one',
      ageConfirmed: true,
    });
  });

  it("renders the API's message on a failed login and keeps the entered username", async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return jsonResponse(401, { code: 'unauthenticated', message: 'Authentication required.' });
      }
      if (url === '/api/auth/login') {
        return jsonResponse(401, {
          code: 'invalid_credentials',
          message: 'Invalid username or password.',
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/login');

    const usernameInput = container.querySelector('#login-username') as HTMLInputElement;
    const passwordInput = container.querySelector('#login-password') as HTMLInputElement;
    const submitButton = container.querySelector('button[type="submit"]') as HTMLButtonElement;

    act(() => {
      setInputValue(usernameInput, 'alice');
      setInputValue(passwordInput, 'wrong-password');
    });

    await submit(submitButton);

    expect(container.textContent).toContain('Invalid username or password.');
    expect((container.querySelector('#login-username') as HTMLInputElement).value).toBe('alice');
  });

  it('redirects a user with mustChangePassword to /change-password from /app', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return jsonResponse(200, {
          id: 1,
          username: 'admin',
          avatarSeed: 'seed',
          isAdmin: true,
          isAnonymous: false,
          mustChangePassword: true,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/app');

    expect(container.querySelector('#change-current-password')).not.toBeNull();
    expect(container.querySelector('#change-new-password')).not.toBeNull();
  });

  it('sends a signed-out user visiting /app to /login', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return jsonResponse(401, { code: 'unauthenticated', message: 'Authentication required.' });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/app');

    expect(container.querySelector('#login-username')).not.toBeNull();
    expect(container.querySelector('#login-password')).not.toBeNull();
  });

  it('shows a message rather than failing silently on a network failure during login', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return jsonResponse(401, { code: 'unauthenticated', message: 'Authentication required.' });
      }
      if (url === '/api/auth/login') {
        throw new Error('network down');
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/login');

    const usernameInput = container.querySelector('#login-username') as HTMLInputElement;
    const passwordInput = container.querySelector('#login-password') as HTMLInputElement;
    const submitButton = container.querySelector('button[type="submit"]') as HTMLButtonElement;

    act(() => {
      setInputValue(usernameInput, 'alice');
      setInputValue(passwordInput, 'whatever');
    });

    await submit(submitButton);

    expect(container.textContent).toContain(
      'Could not reach the server. Check your connection and try again.',
    );
  });

  // Section 8.1's branding pass turned /app from a placeholder into the start
  // screen, and a start screen fetches: the city outline it draws its backdrop
  // from, and the one call behind its three figures - GET /api/progress, which
  // since v1.50 answers the percentage and both bar counts (Section 7.6), so
  // the bar list is not fetched here at all. They are stubbed in the two tests
  // below - which are about the tab bar and not about that screen - purely so
  // an unstubbed request is still the error this handler says it is. Both
  // tests pass without them, because every one of those fetches degrades to
  // silence by design (screens/AppHome.tsx), and that is exactly why leaving
  // them unstubbed would be the wrong kind of quiet.
  function stubStartScreenData(url: string): Response | null {
    if (url === `/static/${ACTIVE_CITY_SLUG}/city.geojson`) {
      return jsonResponse(200, cityFixture);
    }
    if (url === '/api/progress') {
      return jsonResponse(200, {
        city: {
          revealedCells: 0,
          playableCells: 1,
          percent: 0,
          barsDiscovered: 0,
          barsMastered: 0,
        },
        districts: [],
      });
    }
    return null;
  }

  it('shows exactly the five tabs of Section 8.4, with the More sheet carrying the rest and closing on Escape', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return jsonResponse(200, {
          id: 1,
          username: 'alice',
          avatarSeed: 'seed',
          isAdmin: false,
          isAnonymous: false,
          mustChangePassword: false,
        });
      }
      const startScreen = stubStartScreenData(url);
      if (startScreen) {
        return startScreen;
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/app');

    // Section 8.4 fixes the order as well as the set: Cities, Map, Ranks,
    // Profile, More, left to right, with Map in the middle carrying the
    // primary weight. Asserted as a list rather than as five separate
    // lookups, so a reordering fails here.
    const tabs = container.querySelectorAll('.bottom-nav__tab');
    expect(Array.from(tabs).map((tab) => tab.textContent)).toEqual([
      'Cities',
      'Map',
      'Ranks',
      'Profile',
      'More',
    ]);

    expect(container.querySelector('.more-sheet__panel')).toBeNull();
    const moreButton = container.querySelector('.bottom-nav button') as HTMLButtonElement;
    act(() => {
      moreButton.click();
    });

    // Matched as whole strings rather than loosened to substrings: this list
    // is the sheet's order and its contents, and text creeping back onto an
    // item is the kind of change it exists to catch. "Report a bug" carried
    // two lines until v1.40 - a "(opens a new tab)" suffix and a second line
    // about GitHub asking for an account - and the owner cut both from the
    // screen ("remove the rest of the text"). The new-tab warning did not
    // leave the item, it moved into the accessible name, which is asserted
    // where the rest of that item's contract is.
    const entries = container.querySelectorAll('.more-sheet__panel a, .more-sheet__panel button');
    expect(Array.from(entries).map((entry) => entry.textContent)).toEqual([
      'Suggest a bar',
      'How mastering works',
      'Settings',
      'Privacy',
      'Report a bug on GitHub',
      'Log out',
    ]);

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(container.querySelector('.more-sheet__panel')).toBeNull();
  });

  // Section 8.4's "Report a bug", and every part of it that can go wrong
  // silently. The repository root would render a README rather than anywhere a
  // player can type, `Tipsy-Trails` would work today because GitHub redirects
  // the old name (Section 4.3) and would stop the day the redirect does, and a
  // `target="_blank"` without `rel` hands the opened page a handle on this
  // one. None of the four is visible on the screen the item is tapped from.
  //
  // Run over two routes because the screen in the template must come from the
  // router: a hard-coded one passes on whichever route it was written against
  // and is wrong everywhere else, which is exactly the failure a template
  // exists to prevent.
  it.each([['/settings'], ['/how-it-works']])(
    'points "Report a bug" at the issue form, in a new tab, carrying %s as the screen',
    async (path) => {
      stubFetch((url) => {
        if (url.startsWith('/api/auth/me')) {
          return stubSignedInUser();
        }
        throw new Error(`Unexpected request: ${url}`);
      });

      await renderApp(path);
      const moreButton = container.querySelector('.bottom-nav button') as HTMLButtonElement;
      act(() => {
        moreButton.click();
      });

      const items = Array.from(
        container.querySelectorAll<HTMLAnchorElement>('.more-sheet__panel a'),
      );
      const report = items.find((item) => item.textContent?.startsWith('Report a bug'));
      expect(report, 'the More sheet offers no way to report a bug').not.toBeUndefined();

      // Placed with the navigation above the divider and not in the gap
      // below it, which belongs to Log out alone.
      expect(items.indexOf(report as HTMLAnchorElement)).toBe(
        items.findIndex((item) => item.textContent === 'Privacy') + 1,
      );

      const href = new URL(report?.getAttribute('href') as string);
      expect(href.host).toBe('github.com');
      expect(
        href.pathname,
        'the link must land on the issue form. The repository root is a README, ' +
          'which is not somewhere a player with a bug to report can type',
      ).toBe('/AlexanderHultsch/TipsyTrails/issues/new');

      const body = href.searchParams.get('body') as string;
      expect(body).toContain('What happened:');
      expect(body).toContain('What I expected:');
      expect(body).toContain(`Screen: ${path}`);
      // packages/web has no build-time version - its package.json is at
      // 0.0.0 - so a version line here would be a number that means nothing.
      expect(body).not.toMatch(/version/i);
    },
  );

  // Section 10.1: a GitHub issue is public and permanent, and this body is
  // prefilled rather than typed - so a player who never scrolls the field
  // would publish their own handle without having decided to. Which screen a
  // bug happened on is the diagnostic value; which profile is not. Reported
  // from a profile route because that is the only path in the application
  // carrying an identity, and it is the one a player is most likely to be
  // looking at when something looks wrong.
  it('reports the profile route without the handle in it', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url.startsWith('/api/profile/')) {
        throw new Error('profile fetch is irrelevant to the More sheet');
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/profile/silke');
    const moreButton = container.querySelector('.bottom-nav button') as HTMLButtonElement;
    act(() => {
      moreButton.click();
    });

    const report = Array.from(
      container.querySelectorAll<HTMLAnchorElement>('.more-sheet__panel a'),
    ).find((item) => item.textContent?.startsWith('Report a bug'));
    const body = new URL(report?.getAttribute('href') as string).searchParams.get('body') as string;

    expect(body).toContain('Screen: /profile/:handle');
    expect(
      body,
      'the prefilled body must not carry the handle the player happens to be looking at',
    ).not.toContain('silke');

    expect(report?.getAttribute('target')).toBe('_blank');
    expect(report?.getAttribute('rel')).toContain('noopener');
    expect(report?.getAttribute('rel')).toContain('noreferrer');

    // Since v1.40 the screen says five words and the accessible layer says
    // seven, and both halves of that are load-bearing.
    //
    // The visible label is exactly what the owner asked for, with nothing
    // trailing it: "Report a bug on GitHub (remove the rest of the text)".
    expect(report?.textContent).toBe('Report a bug on GitHub');
    expect(report?.textContent, 'the suffix the owner cut is back on the screen').not.toContain(
      'opens a new tab',
    );

    // The unexpected context change is still announced, because a tap that
    // swaps the app for a browser tab cannot be undone with the back gesture
    // and a screen reader user gets the least warning of it. WCAG 2.5.3
    // wants the visible label inside the accessible name, so the name is the
    // label plus the warning and in that order - a voice-control user saying
    // the words they can see still hits this item.
    const name = report?.getAttribute('aria-label') as string;
    expect(name).toBe('Report a bug on GitHub, opens a new tab');
    expect(
      name.startsWith(report?.textContent as string),
      'the accessible name no longer contains the visible label (WCAG 2.5.3)',
    ).toBe(true);
  });

  // Two things the tab list above cannot see, and both survived a mutation
  // until this test existed: which tab reports itself current, and where the
  // Profile tab actually points.
  //
  // /app belongs to no tab - it is not one of the four destinations - so the
  // honest answer here is "none", and that is what makes this test bite. A
  // derivation that fell back to a default (say, treating anything unmatched
  // as the Map tab) would light a tab the reader is not on, which is worse
  // than lighting none: it is a wrong answer to "where am I?" rather than a
  // missing one.
  it('marks no tab current on a screen that belongs to none, and points Profile at the signed-in user', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return jsonResponse(200, {
          id: 7,
          username: 'alice',
          avatarSeed: 'seed',
          isAdmin: false,
          isAnonymous: false,
          mustChangePassword: false,
        });
      }
      const startScreen = stubStartScreenData(url);
      if (startScreen) {
        return startScreen;
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/app');

    expect(container.querySelectorAll('.bottom-nav [aria-current]')).toHaveLength(0);

    // The handle is the signed-in user's own, not a fixed string: this tab is
    // "my profile", and pointing it at anyone else sends every player to the
    // same stranger.
    const profileTab = Array.from(container.querySelectorAll('.bottom-nav a')).find(
      (tab) => tab.textContent?.trim() === 'Profile',
    ) as HTMLAnchorElement;
    expect(profileTab.getAttribute('href')).toBe('/profile/player-7');
  });

  it('does not render the tab bar on signed-out screens', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return jsonResponse(401, { code: 'unauthenticated', message: 'Authentication required.' });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/');

    expect(container.querySelector('.bottom-nav')).toBeNull();
  });

  it('renders the avatar as an inline svg, with identical markup for the same seed across renders', async () => {
    await act(async () => {
      root.render(<Avatar seed="consistent-seed" />);
    });
    const firstSvg = container.querySelector('svg');
    expect(firstSvg).not.toBeNull();
    const firstMarkup = firstSvg?.outerHTML;

    await act(async () => {
      root.render(<Avatar seed="consistent-seed" />);
    });
    const secondSvg = container.querySelector('svg');
    expect(secondSvg?.outerHTML).toBe(firstMarkup);
  });

  it('toggles anonymous via PATCH /api/settings and reflects the returned state', async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url.startsWith('/api/auth/me')) {
        return jsonResponse(200, {
          id: 7,
          username: 'alice',
          avatarSeed: 'seed',
          isAdmin: false,
          isAnonymous: false,
          mustChangePassword: false,
        });
      }
      if (url === '/api/settings' && init?.method === 'PATCH') {
        return jsonResponse(200, {
          id: 7,
          username: 'alice',
          avatarSeed: 'seed',
          isAdmin: false,
          isAnonymous: true,
          mustChangePassword: false,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/settings');

    const checkbox = container.querySelector('#settings-anonymous') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    await act(async () => {
      checkbox.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const patchCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        input === '/api/settings' && (init as RequestInit | undefined)?.method === 'PATCH',
    );
    expect(patchCall).toBeDefined();
    expect(JSON.parse((patchCall?.[1] as RequestInit).body as string)).toEqual({
      isAnonymous: true,
    });
    expect(checkbox.checked).toBe(true);
  });

  it('requires a password to delete the account, and signs the user out at a public screen on success', async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url.startsWith('/api/auth/me')) {
        return jsonResponse(200, {
          id: 3,
          username: 'alice',
          avatarSeed: 'seed',
          isAdmin: false,
          isAnonymous: false,
          mustChangePassword: false,
        });
      }
      if (url === '/api/account' && init?.method === 'DELETE') {
        return jsonResponse(200, { ok: true });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/settings');

    const passwordInput = container.querySelector('#settings-delete-password') as HTMLInputElement;
    expect(passwordInput.required).toBe(true);

    act(() => {
      setInputValue(passwordInput, 'hunter2');
    });

    const submitButton = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    await submit(submitButton);

    const deleteCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        input === '/api/account' && (init as RequestInit | undefined)?.method === 'DELETE',
    );
    expect(deleteCall).toBeDefined();
    expect(JSON.parse((deleteCall?.[1] as RequestInit).body as string)).toEqual({
      password: 'hunter2',
    });

    expect(container.querySelector('#settings-delete-password')).toBeNull();
    expect(container.querySelector('#login-username')).not.toBeNull();
  });

  it("shows the API's message on a failed account deletion, without signing the user out", async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url.startsWith('/api/auth/me')) {
        return jsonResponse(200, {
          id: 4,
          username: 'alice',
          avatarSeed: 'seed',
          isAdmin: false,
          isAnonymous: false,
          mustChangePassword: false,
        });
      }
      if (url === '/api/account' && init?.method === 'DELETE') {
        return jsonResponse(401, {
          code: 'invalid_credentials',
          message: 'Invalid username or password.',
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/settings');

    const passwordInput = container.querySelector('#settings-delete-password') as HTMLInputElement;
    act(() => {
      setInputValue(passwordInput, 'wrong-password');
    });

    const submitButton = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    await submit(submitButton);

    expect(container.textContent).toContain('Invalid username or password.');
    expect(container.querySelector('#settings-anonymous')).not.toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => input === '/api/auth/logout')).toBe(false);
  });

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

  it('renders the map screen with an OSM attribution link to the copyright page', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url.startsWith('/tiles/')) {
        return jsonResponse(206, {});
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/map');
    await flushLazyMapScreen();

    const attribution = container.querySelector('.map-attribution') as HTMLAnchorElement | null;
    expect(attribution).not.toBeNull();
    expect(attribution?.getAttribute('href')).toBe('https://www.openstreetmap.org/copyright');
    expect(container.querySelector('.map-notice')).toBeNull();
  });

  it('still shows the OSM attribution when the tile availability check fails outright', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url.startsWith('/tiles/')) {
        throw new Error('network down');
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/map');
    await flushLazyMapScreen();

    const attribution = container.querySelector('.map-attribution') as HTMLAnchorElement | null;
    expect(attribution).not.toBeNull();
    expect(attribution?.getAttribute('href')).toBe('https://www.openstreetmap.org/copyright');
  });

  it('shows a plain-language message, not a blank screen, when the API reports tiles_unavailable', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url.startsWith('/tiles/')) {
        return jsonResponse(503, {
          code: 'tiles_unavailable',
          message: 'The map tile extract is not installed on this server.',
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/map');
    await flushLazyMapScreen();

    const notice = container.querySelector('.map-notice');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain("aren't installed on this server yet");
    expect(container.querySelector('.map-attribution')).not.toBeNull();
  });

  // A plain visit to /map, with no lat/lon in the query. This is the single
  // most common way anyone opens the map, and it shipped centring on
  // [0, 0]: `params.get` answers null for a missing key, `Number(null)` is
  // 0, and `Number.isFinite(0)` is true, so the guard never fired and the
  // `?? INITIAL_CENTER` fallback was unreachable. The map sat off the coast
  // of Africa, MapLibre correctly requested no tiles for a point the
  // extract does not cover, raised no error, and drew the paper background
  // - which looks exactly like a fully fogged city.
  it('centres on the city when the URL carries no coordinates', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url.startsWith('/tiles/')) {
        return jsonResponse(206, {});
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/map');
    await flushLazyMapScreen();

    const map = mapInstances[mapInstances.length - 1];
    expect(map.options.center).toEqual([8.4037, 49.0069]);
  });

  it('centres on the coordinates the district overview passes through the URL', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url.startsWith('/tiles/')) {
        return jsonResponse(206, {});
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/map?lat=49.0123&lon=8.4321');
    await flushLazyMapScreen();

    const map = mapInstances[mapInstances.length - 1];
    expect(map.options.center).toEqual([8.4321, 49.0123]);
  });

  // Blank and out-of-range values coerce to finite numbers just as null
  // does, and a centre outside the extract fails silently in exactly the
  // same way, so both fall back to the city rather than to nowhere.
  it.each([
    ['blank values', '/map?lat=&lon='],
    ['non-numeric values', '/map?lat=abc&lon=def'],
    ['out-of-range values', '/map?lat=999&lon=999'],
  ])('falls back to the city centre for %s', async (_label, path) => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url.startsWith('/tiles/')) {
        return jsonResponse(206, {});
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp(path);
    await flushLazyMapScreen();

    const map = mapInstances[mapInstances.length - 1];
    expect(map.options.center).toEqual([8.4037, 49.0069]);
  });

  // The extract is installed and /tiles/ answers, but MapLibre still cannot
  // build the map - a broken style, a source it cannot parse, a tile request
  // that fails. MapLibre reports that only through its own `error` event: it
  // does not throw, and it renders nothing to say so, so the failure looks
  // exactly like a fully fogged city. This is the case that left the first
  // real deployment with a blank map and no way to tell why from the device.
  it('surfaces a MapLibre load failure instead of leaving a blank map', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url.startsWith('/tiles/')) {
        return jsonResponse(206, {});
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/map');
    await flushLazyMapScreen();

    expect(container.querySelector('.map-notice')).toBeNull();

    const map = mapInstances[mapInstances.length - 1];
    const errorHandler = map.on.mock.calls.find((call) => call[0] === 'error')?.[1] as
      ((event: { error?: { message?: string } }) => void) | undefined;
    expect(errorHandler).toBeDefined();

    await act(async () => {
      errorHandler?.({ error: new Error('Unimplemented type: 3') });
    });

    const notice = container.querySelector('.map-notice');
    expect(notice).not.toBeNull();
    expect(notice?.getAttribute('role')).toBe('alert');
    expect(notice?.textContent).toContain('The map could not be loaded');
    // The raw message is shown, not swallowed: without it a blank map is not
    // diagnosable from a phone, which is the whole reason this exists.
    expect(notice?.textContent).toContain('Unimplemented type: 3');
  });

  it('destroys the map instance when navigating away from /map', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url.startsWith('/tiles/')) {
        return jsonResponse(206, {});
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/map');
    await flushLazyMapScreen();

    expect(mapInstances).toHaveLength(1);
    const mapInstance = mapInstances[0];
    expect(mapInstance.remove).not.toHaveBeenCalled();

    const menuButton = container.querySelector('.bottom-nav button') as HTMLButtonElement;
    act(() => {
      menuButton.click();
    });
    const settingsLink = Array.from(container.querySelectorAll('.more-sheet__panel a')).find(
      (entry) => entry.textContent === 'Settings',
    ) as HTMLAnchorElement;

    await act(async () => {
      settingsLink.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector('#settings-anonymous')).not.toBeNull();
    expect(mapInstance.remove).toHaveBeenCalledTimes(1);
    expect(removeProtocolMock).toHaveBeenCalledWith('pmtiles');
  });

  // Without these the map zoomed out to a world view and panned away from
  // the city entirely - past everything the tile extract covers, into an
  // empty grey plane with no way back but a reload.
  it('constrains the map screen to the configured zoom range and to the city grid once GET /api/city answers', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url.startsWith('/tiles/')) {
        return jsonResponse(206, {});
      }
      if (url === '/api/city') {
        return jsonResponse(200, cityMeta);
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/map');
    await flushLazyMapScreen();
    await flushLazyMapScreen();

    const map = mapInstances[mapInstances.length - 1];
    expect(map.options.minZoom).toBe(CONFIG.MAP_MIN_ZOOM);
    expect(map.options.maxZoom).toBe(CONFIG.MAP_MAX_ZOOM);
    expect(map.setMaxBounds).toHaveBeenCalledWith(gridMapBounds(cityMetaGrid));
  });

  it("constrains the suggest screen's map picker the same way", async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url === '/api/city') {
        return jsonResponse(200, cityMeta);
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/suggest');
    await flushLazyMapScreen();
    await flushLazyMapScreen();

    const map = mapInstances[mapInstances.length - 1];
    expect(map.options.minZoom).toBe(CONFIG.MAP_MIN_ZOOM);
    expect(map.options.maxZoom).toBe(CONFIG.MAP_MAX_ZOOM);
    expect(map.setMaxBounds).toHaveBeenCalledWith(gridMapBounds(cityMetaGrid));
  });

  // The map is built in a mount effect, before GET /api/city can possibly
  // have answered; the zoom limits need no metadata, so they must not wait
  // for it, and a failed fetch must still leave a usable map.
  it('still applies the zoom limits when GET /api/city never answers', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url.startsWith('/tiles/')) {
        return jsonResponse(206, {});
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/map');
    await flushLazyMapScreen();
    await flushLazyMapScreen();

    const map = mapInstances[mapInstances.length - 1];
    expect(map.options.minZoom).toBe(CONFIG.MAP_MIN_ZOOM);
    expect(map.options.maxZoom).toBe(CONFIG.MAP_MAX_ZOOM);
    expect(map.setMaxBounds).not.toHaveBeenCalled();
  });

  it('fetches the fog mask and grid on mount and renders the 2D canvas fallback (jsdom has no WebGL2)', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url.startsWith('/tiles/')) {
        return jsonResponse(206, {});
      }
      if (url === '/api/city') {
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
      if (url === '/api/fog') {
        return fogResponse(new Uint8Array(2), {
          revealedCells: 0,
          playableCells: 9,
          districts: [],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/map');
    await flushLazyMapScreen();
    await flushLazyMapScreen();

    expect(mapInstances).toHaveLength(1);
    const [mapInstance] = mapInstances;
    // No real WebGL2 in jsdom, so the fog controller's own (un-injected)
    // detector takes the Section 7.3 fallback path here - the same
    // selection logic is exercised directly, with a forced detector, in
    // map/fog/fog-controller.test.ts.
    expect(mapInstance.container.querySelector('canvas.fog-canvas-fallback')).not.toBeNull();
  });

  it('renders the city outline and the greyed-out, non-interactive neighbour shapes on /city', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url === `/static/${ACTIVE_CITY_SLUG}/city.geojson`) {
        return jsonResponse(200, cityFixture);
      }
      if (url === `/static/${ACTIVE_CITY_SLUG}/neighbours.geojson`) {
        return jsonResponse(200, neighboursFixture);
      }
      if (url === '/api/progress') {
        return jsonResponse(200, {
          city: { revealedCells: 125, playableCells: 1000, percent: 12.5 },
          districts: [],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/city');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const cityPaths = container.querySelectorAll('.city-overview__city');
    expect(cityPaths).toHaveLength(cityFixture.features.length);
    cityPaths.forEach((path, index) => {
      const d = path.getAttribute('d') ?? '';
      expect(d).toMatch(/^M/);
      expect(d.match(/M/g)).toHaveLength(ringCount(cityFixture.features[index]));
    });

    const neighbourPaths = container.querySelectorAll('.city-overview__neighbour');
    expect(neighbourPaths).toHaveLength(neighboursFixture.features.length);
    neighbourPaths.forEach((path, index) => {
      expect(path.getAttribute('aria-hidden')).toBe('true');
      expect((path as unknown as HTMLElement).style.pointerEvents).toBe('none');
      const d = path.getAttribute('d') ?? '';
      expect(d.match(/M/g)).toHaveLength(ringCount(neighboursFixture.features[index]));
    });

    expect(container.querySelector('.city-overview__progress')?.textContent).toBe('12.5% explored');
    expect(container.textContent).toContain('View districts');
  });

  it('shows a message rather than an empty screen when the city boundary fetch fails', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url === `/static/${ACTIVE_CITY_SLUG}/city.geojson`) {
        throw new Error('network down');
      }
      if (url === `/static/${ACTIVE_CITY_SLUG}/neighbours.geojson`) {
        return jsonResponse(200, neighboursFixture);
      }
      if (url === '/api/progress') {
        return jsonResponse(200, {
          city: { revealedCells: 0, playableCells: 1000, percent: 0 },
          districts: [],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/city');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain(
      'Could not reach the server. Check your connection and try again.',
    );
    expect(container.querySelector('.city-overview__map')).toBeNull();
    // The progress figure must not silently fall back to a bare 0% here -
    // `city` never gets set on this failure path, so the paragraph that
    // would show it must not render at all, distinguishing "the value never
    // arrived" from "the value arrived and reads 0%" (Section 7.6).
    expect(container.querySelector('.city-overview__progress')).toBeNull();
  });

  it('renders all 27 districts as a list with a name and a percentage each', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url === `/static/${ACTIVE_CITY_SLUG}/districts.geojson`) {
        return jsonResponse(200, districtsFixture);
      }
      if (url === '/api/progress') {
        return jsonResponse(200, {
          city: { revealedCells: 0, playableCells: 1000, percent: 0 },
          districts: districtsFixture.features.map((feature, index) => ({
            id: index + 1,
            name: feature.properties.name,
            revealedCells: index,
            playableCells: 100,
            percent: index,
          })),
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/districts');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const items = container.querySelectorAll('.district-list__item');
    expect(items).toHaveLength(27);
    expect(districtsFixture.features).toHaveLength(27);

    items.forEach((item, index) => {
      const name = districtsFixture.features[index].properties.name;
      expect(item.textContent).toContain(name);
      expect(item.querySelector('.district-list__percent')?.textContent).toBe(`${index}.0%`);
    });
  });

  it('navigates to the map when a district in the list is tapped', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url === `/static/${ACTIVE_CITY_SLUG}/districts.geojson`) {
        return jsonResponse(200, districtsFixture);
      }
      if (url === '/api/progress') {
        return jsonResponse(200, {
          city: { revealedCells: 0, playableCells: 1000, percent: 0 },
          districts: [],
        });
      }
      if (url.startsWith('/tiles/')) {
        return jsonResponse(206, {});
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/districts');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const firstDistrict = container.querySelector('.district-list__item') as HTMLAnchorElement;
    expect(firstDistrict).not.toBeNull();
    expect(firstDistrict.getAttribute('href')).toMatch(/^\/map\?/);

    await act(async () => {
      firstDistrict.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flushLazyMapScreen();

    expect(container.querySelector('.map-container')).not.toBeNull();
  });

  // Section 8.3: the schematic map is the district screen's primary picker.
  // The shapes are too small to be 44 px targets, so the list stays on the
  // page as WCAG 2.1 SC 2.5.5's equivalent control - collapsed, but present
  // and complete. Both halves of that bargain are pinned here.
  describe('picking a district on the schematic map', () => {
    async function renderDistricts() {
      stubFetch((url) => {
        if (url.startsWith('/api/auth/me')) {
          return stubSignedInUser();
        }
        if (url === `/static/${ACTIVE_CITY_SLUG}/districts.geojson`) {
          return jsonResponse(200, districtsFixture);
        }
        if (url === '/api/progress') {
          return jsonResponse(200, {
            city: { revealedCells: 0, playableCells: 1000, percent: 0 },
            districts: districtsFixture.features.map((feature, index) => ({
              id: index + 1,
              name: feature.properties.name,
              revealedCells: index,
              playableCells: 100,
              percent: index,
            })),
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      });

      await renderApp('/districts');
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    // The paths are deliberately not focusable, so there is no click() and
    // no keyboard route to them - a bubbling MouseEvent is what a real tap
    // on the shape delivers to React's root listener.
    async function tapDistrict(index: number) {
      const paths = container.querySelectorAll('.district-overview__district');
      await act(async () => {
        paths[index].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    }

    function panel(): HTMLElement {
      return container.querySelector('.district-overview__detail') as HTMLElement;
    }

    it('selects the tapped district and shows its name and percentage in the detail panel', async () => {
      await renderDistricts();
      await tapDistrict(1);

      expect(panel().getAttribute('role')).toBe('status');
      expect(panel().querySelector('.district-overview__detail-name')?.textContent).toBe(
        districtsFixture.features[1].properties.name,
      );
      expect(panel().querySelector('.district-overview__detail-percent')?.textContent).toBe('1.0%');

      const paths = container.querySelectorAll('.district-overview__district');
      expect(paths[1].classList.contains('district-overview__district--selected')).toBe(true);
      expect(paths[2].classList.contains('district-overview__district--selected')).toBe(false);
    });

    // The shapes stay out of the tab order: one extra tab stop per district
    // ahead of the list would make the keyboard path materially worse, and
    // the list already offers every function the map does.
    it('keeps the district shapes out of the tab order and out of the accessibility tree', async () => {
      await renderDistricts();

      const svg = container.querySelector('.district-overview__map');
      expect(svg?.getAttribute('role')).toBe('img');
      expect(svg?.getAttribute('aria-label')).toBeTruthy();
      container.querySelectorAll('.district-overview__district').forEach((path) => {
        expect(path.getAttribute('aria-hidden')).toBe('true');
        expect(path.getAttribute('tabindex')).toBeNull();
      });
    });

    it('replaces the panel content when a different district is tapped', async () => {
      await renderDistricts();
      await tapDistrict(1);
      await tapDistrict(2);

      expect(panel().querySelector('.district-overview__detail-name')?.textContent).toBe(
        districtsFixture.features[2].properties.name,
      );
      expect(panel().querySelector('.district-overview__detail-percent')?.textContent).toBe('2.0%');
      expect(panel().textContent).not.toContain(districtsFixture.features[1].properties.name);
    });

    it('shows an instruction rather than a district or a bare percentage before anything is tapped', async () => {
      await renderDistricts();

      expect(panel().textContent).toContain('Tap a district on the map');
      expect(panel().querySelector('.district-overview__detail-name')).toBeNull();
      expect(panel().querySelector('.district-overview__detail-link')).toBeNull();
      expect(panel().textContent).not.toContain('%');
    });

    it("points the panel's link at the same URL as that district's list item", async () => {
      await renderDistricts();
      await tapDistrict(3);

      const href = panel()
        .querySelector('.district-overview__detail-link')
        ?.getAttribute('href') as string;
      const listHref = container
        .querySelectorAll('.district-list__item')[3]
        .getAttribute('href') as string;

      expect(href).toMatch(/^\/map\?/);
      expect(href).toBe(listHref);
      expect(new URLSearchParams(href.slice(href.indexOf('?'))).get('district')).toBe(
        districtsFixture.features[3].properties.name,
      );
    });

    // Section 8.3: the link's job is "show me this district", and a centre
    // alone cannot express it - the map opened there at street level and an
    // unexplored district arrived as a few streets of fog with none of its
    // shape. The link therefore carries the district's bounding box, and
    // screens/Map.tsx frames it (App.locate.test.tsx covers that half).
    //
    // The expected box is computed here from the fixture's raw coordinates
    // rather than by calling the same helper the screen calls, so this
    // asserts the district's actual extent and not that one function agrees
    // with itself.
    it("carries the district's bounding box, and its centre, in the link", async () => {
      await renderDistricts();

      const index = 3;
      const feature = districtsFixture.features[index];
      const href = container
        .querySelectorAll('.district-list__item')
        [index].getAttribute('href') as string;
      const params = new URLSearchParams(href.slice(href.indexOf('?')));

      const positions: [number, number][] = [];
      const walk = (value: unknown) => {
        if (!Array.isArray(value)) return;
        if (typeof value[0] === 'number' && typeof value[1] === 'number') {
          positions.push([value[0] as number, value[1] as number]);
          return;
        }
        value.forEach(walk);
      };
      walk(feature.geometry.coordinates);
      expect(positions.length).toBeGreaterThan(0);

      const lons = positions.map(([lon]) => lon);
      const lats = positions.map(([, lat]) => lat);
      const expected = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];

      const bbox = (params.get('bbox') as string).split(',').map(Number);
      expect(bbox).toHaveLength(4);
      bbox.forEach((value, position) => {
        expect(value).toBeCloseTo(expected[position], 5);
      });

      // The centre stays beside it and is not replaced: it is what an older
      // link carries, and what the map falls back to if it rejects the box.
      // It has to lie inside the box it is sent with.
      const lat = Number(params.get('lat'));
      const lon = Number(params.get('lon'));
      expect(lon).toBeGreaterThanOrEqual(bbox[0]);
      expect(lon).toBeLessThanOrEqual(bbox[2]);
      expect(lat).toBeGreaterThanOrEqual(bbox[1]);
      expect(lat).toBeLessThanOrEqual(bbox[3]);
    });

    // The panel sits directly beneath a `width: 100%` map, so its height may
    // not depend on what is in it. It used to: one wrapping flex row held
    // the name, the percentage and the link, so a long name ("Weiherfeld-
    // Dammerstock") pushed the link onto a second line and a short one did
    // not. That changed the page height, hence whether the page scrolled,
    // hence the desktop scrollbar, hence the content width - and the map
    // resized. jsdom lays nothing out, so what is pinned here is the
    // structure that makes the height constant: the same two rows in every
    // state, with the link never sharing a row with the name.
    it('keeps the detail panel at the same two rows, selected or not and whatever the name is', async () => {
      const byLength = [...districtsFixture.features].sort(
        (a, b) => a.properties.name.length - b.properties.name.length,
      );
      const shortest = byLength[0].properties.name;
      const longest = byLength[byLength.length - 1].properties.name;
      const indexOf = (name: string) =>
        districtsFixture.features.findIndex((feature) => feature.properties.name === name);

      await renderDistricts();

      function rowClasses(): string[] {
        return Array.from(panel().children).map((child) => child.className);
      }

      const unselectedRows = rowClasses();
      expect(unselectedRows).toEqual([
        'district-overview__detail-row district-overview__detail-row--primary',
        'district-overview__detail-row',
      ]);
      // The hint is on the first row and the second is empty but present -
      // that reserved row is what stops the panel growing on selection.
      expect(panel().children[0].querySelector('.district-overview__detail-hint')).not.toBeNull();
      expect(panel().children[1].children).toHaveLength(0);

      for (const name of [shortest, longest]) {
        await tapDistrict(indexOf(name));

        expect(rowClasses()).toEqual(unselectedRows);
        expect(
          panel().children[0].querySelector('.district-overview__detail-name')?.textContent,
        ).toBe(name);
        expect(
          panel().children[0].querySelector('.district-overview__detail-percent'),
        ).not.toBeNull();
        expect(panel().children[0].querySelector('.district-overview__detail-link')).toBeNull();
        expect(panel().children[1].querySelector('.district-overview__detail-link')).not.toBeNull();
      }
    });

    // Reserving the two rows was not the whole of it, and this is the half
    // that was missing. What goes into the first row is not the same height
    // in both states: the hint is 46 characters and wraps to two lines on
    // every phone narrower than about 405 px, while a district name and a
    // percentage never wrap. So the row was two lines tall before the first
    // tap and one line tall after it, and the panel - and everything below
    // it - moved.
    //
    // The fix is to keep the hint in the flow and hide it, so the row is
    // always as tall as its tallest state without anyone writing that height
    // down. jsdom applies no stylesheet and lays nothing out, so this cannot
    // show the panel staying the same height on a screen; what it pins is the
    // structure the stylesheet needs in order to reserve it - the hint still
    // rendered while a district is selected, wearing the class that hides it -
    // and stylesheet.test.ts pins the declarations that do the hiding. The
    // height itself still needs eyes on a phone.
    it('keeps the hint rendered while a district is selected, so the row cannot lose a line', async () => {
      await renderDistricts();

      const hint = () =>
        panel().querySelector('.district-overview__detail-hint') as HTMLElement | null;

      expect(hint()).not.toBeNull();
      expect(hint()?.classList.contains('district-overview__detail-hint--reserved')).toBe(false);
      expect(hint()?.getAttribute('aria-hidden')).toBeNull();

      await tapDistrict(1);

      expect(
        hint(),
        "the hint is what measures the row's tallest state; removed on selection, the " +
          'row loses the second line it wraps to on a phone and the panel shrinks',
      ).not.toBeNull();
      expect(hint()?.classList.contains('district-overview__detail-hint--reserved')).toBe(true);
      // The panel is a role="status" live region. The reserved hint is there
      // to occupy space and must not be announced behind the selection.
      expect(hint()?.getAttribute('aria-hidden')).toBe('true');
    });

    it('keeps the full list, with every district and its percentage, inside a collapsed <details>', async () => {
      await renderDistricts();

      const details = container.querySelector('.district-overview__all') as HTMLDetailsElement;
      expect(details).not.toBeNull();
      expect(details.tagName).toBe('DETAILS');
      expect(details.open).toBe(false);
      expect(details.querySelector('summary')?.textContent).toBe('All districts');

      const items = details.querySelectorAll('.district-list__item');
      expect(items).toHaveLength(districtsFixture.features.length);
      items.forEach((item, index) => {
        expect(item.textContent).toContain(districtsFixture.features[index].properties.name);
        expect(item.querySelector('.district-list__percent')?.textContent).toBe(`${index}.0%`);
        expect(item.getAttribute('href')).toMatch(/^\/map\?/);
      });
    });
  });

  // Section 7.3: the owner asked for district borders visible on the main
  // map whether or not the ground is explored. The geometry is the boundary
  // file the district overview already draws, so this is that file put on the
  // map the player walks with - no new endpoint, no new seed data. Where the
  // layer lands relative to the fog, and that the ordering does not depend on
  // which response arrived first, is pinned in
  // map/districts/district-borders.test.ts; what is checked here is the
  // wiring: that the map screen fetches the boundaries at all and puts them
  // on the map.
  describe('district borders on the map (SPEC.md Section 7.3)', () => {
    it('fetches the district boundaries and draws them as a layer of their own', async () => {
      const fetchMock = stubFetch((url) => {
        if (url.startsWith('/api/auth/me')) {
          return stubSignedInUser();
        }
        if (url.startsWith('/tiles/')) {
          return jsonResponse(206, {});
        }
        if (url === `/static/${ACTIVE_CITY_SLUG}/districts.geojson`) {
          return jsonResponse(200, districtsFixture);
        }
        // Everything else the map screen loads in the background - the city
        // metadata, the fog mask, the bars - is deliberately left to fail
        // here: each is best-effort and none of them is what this test is
        // about.
        throw new Error(`Unexpected request: ${url}`);
      });

      await renderApp('/map');
      await flushLazyMapScreen();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(
        fetchMock.mock.calls.some(
          ([input]) => input === `/static/${ACTIVE_CITY_SLUG}/districts.geojson`,
        ),
      ).toBe(true);

      const map = mapInstances[mapInstances.length - 1];
      const [sourceId, source] = map.addSource.mock.calls[0] as [string, { type: string }];
      expect(source.type).toBe('geojson');

      const borderLayer = map.addLayer.mock.calls
        .map(([layer]) => layer as { id: string; type: string; source?: string })
        .find((layer) => layer.source === sourceId);
      expect(borderLayer).toBeDefined();
      expect(borderLayer?.type).toBe('line');
    });
  });

  describe('position sampling and the status indicator', () => {
    // Section 8.6: the indicator carries no words any more - the three
    // icons keep a fixed shape and say their state in colour, and the state
    // is readable as text only in the panel and in each icon's accessible
    // name. These read the two surfaces that replaced the button's text:
    // the per-state colour class (which is what a sighted player sees) and
    // the aria-label (which is what a screen reader hears).
    const STATUS_LEVELS = ['ok', 'degraded', 'bad'];

    function statusIcon(name: 'gps' | 'connection' | 'tracking') {
      const icon = container.querySelector(`.tracking-indicator__icon--${name}`);
      if (!icon) {
        throw new Error(`No ${name} status icon rendered`);
      }
      return icon;
    }

    function statusLevel(name: 'gps' | 'connection' | 'tracking'): string | undefined {
      return STATUS_LEVELS.find((level) =>
        statusIcon(name).classList.contains(`tracking-indicator__icon--${level}`),
      );
    }

    function statusLabel(name: 'gps' | 'connection' | 'tracking'): string | null {
      return statusIcon(name).getAttribute('aria-label');
    }

    // The panel is a disclosure, so opening it is a click on the same
    // button.
    function openStatusPanel(): void {
      const button = container.querySelector('.tracking-indicator__button') as HTMLButtonElement;
      act(() => {
        button.click();
      });
      if (!container.querySelector('.tracking-indicator__panel')) {
        throw new Error('The tracking status panel did not open');
      }
    }

    // The three "Right now: ..." lines in the open panel, in the panel's own
    // order (GPS, connection, foreground tracking). Read separately from the
    // definitions beside them, which name every state and would match any
    // assertion about the current one.
    function panelCurrentStates(): string[] {
      return Array.from(
        container.querySelectorAll('.tracking-indicator__panel .tracking-indicator__current'),
      ).map((line) => line.textContent ?? '');
    }

    function stubMapFetch(handler?: FetchHandler) {
      return stubFetch((url, init) => {
        if (url.startsWith('/api/auth/me')) {
          return stubSignedInUser();
        }
        if (url.startsWith('/tiles/')) {
          return jsonResponse(206, {});
        }
        if (handler) {
          return handler(url, init);
        }
        throw new Error(`Unexpected request: ${url}`);
      });
    }

    it('queues a sample from the stubbed watch and posts a batch once the throttle interval elapses, not before', async () => {
      const geo = stubGeolocation();
      stubWakeLock();
      const fetchMock = stubMapFetch((url) => {
        if (url === '/api/samples') {
          return jsonResponse(200, { newCells: 0 });
        }
        throw new Error(`Unexpected request: ${url}`);
      });

      vi.useFakeTimers();
      await renderMapWithFakeTimers();

      act(() => {
        geo.triggerPosition({ accuracy: 10 });
      });

      expect(fetchMock.mock.calls.some(([input]) => input === '/api/samples')).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONFIG.SAMPLE_MIN_INTERVAL_MS);
      });

      const sampleCalls = fetchMock.mock.calls.filter(([input]) => input === '/api/samples');
      expect(sampleCalls).toHaveLength(1);
      const body = JSON.parse((sampleCalls[0][1] as RequestInit).body as string);
      expect(body.samples).toHaveLength(1);
    });

    // Constraint C4 / Section 10.2: the GPS course turns the own-position
    // marker's direction cone on this device and goes nowhere else. It is
    // deliberately not a field of Sample (api/types.ts), and this is the
    // test that says so about the request that actually leaves the browser.
    it('keeps the reported course out of the posted sample', async () => {
      const geo = stubGeolocation();
      stubWakeLock();
      const fetchMock = stubMapFetch((url) => {
        if (url === '/api/samples') {
          return jsonResponse(200, { newCells: 0 });
        }
        throw new Error(`Unexpected request: ${url}`);
      });

      vi.useFakeTimers();
      await renderMapWithFakeTimers();

      act(() => {
        geo.triggerPosition({ accuracy: 10, heading: 90 });
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONFIG.SAMPLE_MIN_INTERVAL_MS);
      });

      const sampleCalls = fetchMock.mock.calls.filter(([input]) => input === '/api/samples');
      expect(sampleCalls).toHaveLength(1);
      const body = JSON.parse((sampleCalls[0][1] as RequestInit).body as string);
      expect(body.samples).toHaveLength(1);
      expect(Object.keys(body.samples[0]).sort()).toEqual([
        'accuracy',
        'lat',
        'lon',
        'speed',
        'timestamp',
      ]);
    });

    it('accumulates several samples into one batch rather than one request per position', async () => {
      const geo = stubGeolocation();
      stubWakeLock();
      const fetchMock = stubMapFetch((url) => {
        if (url === '/api/samples') {
          return jsonResponse(200, { newCells: 0 });
        }
        throw new Error(`Unexpected request: ${url}`);
      });

      vi.useFakeTimers();
      await renderMapWithFakeTimers();

      act(() => {
        geo.triggerPosition({ accuracy: 10 });
        geo.triggerPosition({ accuracy: 12 });
        geo.triggerPosition({ accuracy: 15 });
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONFIG.SAMPLE_MIN_INTERVAL_MS);
      });

      const sampleCalls = fetchMock.mock.calls.filter(([input]) => input === '/api/samples');
      expect(sampleCalls).toHaveLength(1);
      const body = JSON.parse((sampleCalls[0][1] as RequestInit).body as string);
      expect(body.samples).toHaveLength(3);
    });

    it('queues samples while offline without posting, then flushes and empties the queue on reconnect', async () => {
      setOnline(false);
      const geo = stubGeolocation();
      stubWakeLock();
      const fetchMock = stubMapFetch((url) => {
        if (url === '/api/samples') {
          return jsonResponse(200, { newCells: 2 });
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

      expect(fetchMock.mock.calls.some(([input]) => input === '/api/samples')).toBe(false);
      // Same behaviour, read through the surface that replaced the button's
      // text: the connection icon goes to the bad level and says so by
      // name, and the queue depth - which used to sit on the button - now
      // lives in the panel.
      expect(statusLevel('connection')).toBe('bad');
      expect(statusLabel('connection')).toBe('Connection: offline');
      openStatusPanel();
      expect(panelCurrentStates()[1]).toBe('Right now: Offline (1 queued)');

      setOnline(true);
      await act(async () => {
        window.dispatchEvent(new Event('online'));
        await vi.advanceTimersByTimeAsync(0);
      });

      const sampleCalls = fetchMock.mock.calls.filter(([input]) => input === '/api/samples');
      expect(sampleCalls).toHaveLength(1);
      expect(statusLevel('connection')).toBe('ok');
      expect(statusLabel('connection')).toBe('Connection: online');
      expect(panelCurrentStates()[1]).toBe('Right now: Online');
    });

    it('leaves a sample queued when posting it fails, rather than dropping it', async () => {
      const geo = stubGeolocation();
      stubWakeLock();
      const fetchMock = stubMapFetch((url) => {
        if (url === '/api/samples') {
          return jsonResponse(500, { code: 'internal_error', message: 'Sync failed.' });
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

      expect(fetchMock.mock.calls.filter(([input]) => input === '/api/samples')).toHaveLength(1);
      expect(statusLevel('connection')).toBe('degraded');
      expect(statusLabel('connection')).toBe('Connection: syncing');

      openStatusPanel();
      expect(panelCurrentStates()[1]).toBe('Right now: Syncing (1 queued)');
      expect(container.querySelector('.tracking-indicator__panel')?.textContent).toContain(
        'Sync failed.',
      );
    });

    // Section 8.6: `syncing` means this device is behind, not that a request
    // is in the air. Batching (Section 7.2) means the queue holds something
    // almost all the time on a phone with a good fix, so a status tied to the
    // queue's depth flapped online -> syncing -> online every few seconds and
    // reported a healthy device as a struggling one.
    it('stays online while samples are merely waiting for their batch and sending normally', async () => {
      const geo = stubGeolocation();
      stubWakeLock();
      // Held open so the assertion below lands while the request is genuinely
      // in flight, which is the state that used to read as a backlog.
      let resolvePost: ((response: Response) => void) | undefined;
      const postInFlight = new Promise<Response>((resolve) => {
        resolvePost = resolve;
      });
      const fetchMock = stubMapFetch((url) => {
        if (url === '/api/samples') {
          return postInFlight;
        }
        throw new Error(`Unexpected request: ${url}`);
      });

      vi.useFakeTimers();
      await renderMapWithFakeTimers();

      act(() => {
        geo.triggerPosition({ accuracy: 10 });
        geo.triggerPosition({ accuracy: 10 });
        geo.triggerPosition({ accuracy: 10 });
      });

      // Three samples queued, waiting for the flush tick: nothing has missed
      // a send cycle yet.
      expect(statusLevel('connection')).toBe('ok');
      expect(statusLabel('connection')).toBe('Connection: online');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONFIG.SAMPLE_MIN_INTERVAL_MS);
      });

      // The batch is now in the air and the queue still holds it.
      expect(fetchMock.mock.calls.filter(([input]) => input === '/api/samples')).toHaveLength(1);
      expect(statusLevel('connection')).toBe('ok');
      expect(statusLabel('connection')).toBe('Connection: online');

      await act(async () => {
        resolvePost?.(jsonResponse(200, { newCells: 0 }));
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(statusLevel('connection')).toBe('ok');
      openStatusPanel();
      expect(panelCurrentStates()[1]).toBe('Right now: Online');
    });

    // The other half of the same rule: a backlog that no single flush can
    // clear is exactly what `syncing` is for, and a threshold on the queue
    // depth would have hidden it behind the healthy case above.
    it('reports syncing for samples a full batch left behind, and counts every unsent one', async () => {
      const geo = stubGeolocation();
      stubWakeLock();
      const fetchMock = stubMapFetch((url) => {
        if (url === '/api/samples') {
          return jsonResponse(200, { newCells: 0 });
        }
        throw new Error(`Unexpected request: ${url}`);
      });

      vi.useFakeTimers();
      await renderMapWithFakeTimers();

      act(() => {
        for (let i = 0; i < CONFIG.SAMPLE_MAX_BATCH + 2; i++) {
          geo.triggerPosition({ accuracy: 10 });
        }
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONFIG.SAMPLE_MIN_INTERVAL_MS);
      });

      const sampleCalls = fetchMock.mock.calls.filter(([input]) => input === '/api/samples');
      expect(sampleCalls).toHaveLength(1);
      const body = JSON.parse((sampleCalls[0][1] as RequestInit).body as string);
      expect(body.samples).toHaveLength(CONFIG.SAMPLE_MAX_BATCH);

      expect(statusLevel('connection')).toBe('degraded');
      expect(statusLabel('connection')).toBe('Connection: syncing');
      openStatusPanel();
      expect(panelCurrentStates()[1]).toBe('Right now: Syncing (2 queued)');
    });

    it('maps GPS accuracy to good, fair and poor at the configured boundaries', async () => {
      const geo = stubGeolocation();
      stubWakeLock();
      stubMapFetch((url) => {
        if (url === '/api/samples') {
          return jsonResponse(200, { newCells: 0 });
        }
        throw new Error(`Unexpected request: ${url}`);
      });

      vi.useFakeTimers();
      await renderMapWithFakeTimers();

      // Section 8.6: the GPS icon's shape is the same mark at every
      // accuracy, so what has to move with the state is its level class and
      // its accessible name - and the three states share one scale with the
      // other two icons, so good is `ok`, fair `degraded`, poor `bad`.
      openStatusPanel();

      act(() => {
        geo.triggerPosition({ accuracy: CONFIG.GPS_ACCURACY_GOOD_M });
      });
      expect(statusLevel('gps')).toBe('ok');
      expect(statusLabel('gps')).toBe('GPS signal: good');
      expect(panelCurrentStates()[0]).toBe('Right now: Good');

      act(() => {
        geo.triggerPosition({ accuracy: CONFIG.GPS_ACCURACY_FAIR_M });
      });
      expect(statusLevel('gps')).toBe('degraded');
      expect(statusLabel('gps')).toBe('GPS signal: fair');
      expect(panelCurrentStates()[0]).toBe('Right now: Fair');

      act(() => {
        geo.triggerPosition({ accuracy: CONFIG.GPS_ACCURACY_FAIR_M + 1 });
      });
      expect(statusLevel('gps')).toBe('bad');
      expect(statusLabel('gps')).toBe('GPS signal: poor');
      expect(panelCurrentStates()[0]).toBe('Right now: Poor');
    });

    // The shape is fixed by decision (Section 8.6), so nothing but the
    // colour class may differ between two states of the same icon. This is
    // what stops a future edit from quietly reintroducing a per-state shape
    // and leaving the palette carrying nothing.
    it('draws the same GPS mark whatever the GPS is doing, and changes only its level class', async () => {
      const geo = stubGeolocation();
      stubWakeLock();
      stubMapFetch((url) => {
        if (url === '/api/samples') {
          return jsonResponse(200, { newCells: 0 });
        }
        throw new Error(`Unexpected request: ${url}`);
      });

      vi.useFakeTimers();
      await renderMapWithFakeTimers();

      act(() => {
        geo.triggerPosition({ accuracy: CONFIG.GPS_ACCURACY_GOOD_M });
      });
      const good = statusIcon('gps').innerHTML;

      act(() => {
        geo.triggerPosition({ accuracy: CONFIG.GPS_ACCURACY_FAIR_M + 1 });
      });
      expect(statusIcon('gps').innerHTML).toBe(good);
      expect(statusLevel('gps')).toBe('bad');
    });

    it('goes to GPS poor after GPS_STALE_MS with no further fix', async () => {
      const geo = stubGeolocation();
      stubWakeLock();
      stubMapFetch((url) => {
        if (url === '/api/samples') {
          return jsonResponse(200, { newCells: 0 });
        }
        throw new Error(`Unexpected request: ${url}`);
      });

      vi.useFakeTimers();
      await renderMapWithFakeTimers();

      openStatusPanel();

      act(() => {
        geo.triggerPosition({ accuracy: CONFIG.GPS_ACCURACY_GOOD_M });
      });
      expect(statusLevel('gps')).toBe('ok');
      expect(panelCurrentStates()[0]).toBe('Right now: Good');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONFIG.GPS_STALE_MS);
      });
      expect(statusLevel('gps')).toBe('bad');
      expect(statusLabel('gps')).toBe('GPS signal: poor');
      expect(panelCurrentStates()[0]).toBe('Right now: Poor');
    });

    // SPEC.md Section 7.3: the reveal is skipped above FOG_MAX_SPEED_KMH, and
    // until v1.26 it was skipped in silence - a map that does not clear looks
    // exactly like a map that is broken. The verdict is the server's
    // (`tooFastToReveal`), never derived from position.speed here, so these
    // tests drive it through the response and never through the fix.
    it('says why nothing is revealing while the server reports the batch was too fast', async () => {
      const geo = stubGeolocation();
      stubWakeLock();
      stubMapFetch((url) => {
        if (url === '/api/samples') {
          return jsonResponse(200, {
            newCells: 0,
            newBars: [],
            visitUpdates: [],
            tooFastToReveal: true,
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      });

      vi.useFakeTimers();
      await renderMapWithFakeTimers();

      // Nothing is claimed before a batch has been answered.
      expect(container.querySelector('.map-toast--speed')).toBeNull();

      act(() => {
        // A fix reporting no speed at all: the client has nothing to judge
        // this on, which is exactly why the server is asked.
        geo.triggerPosition({ accuracy: 10, speed: null });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONFIG.SAMPLE_MIN_INTERVAL_MS);
      });

      const notice = container.querySelector('.map-toast--speed');
      expect(notice).not.toBeNull();
      expect(notice?.textContent).toContain("You're moving too fast to reveal new ground.");
      // Section 7.3: it says what will happen when they slow down, not only
      // what is not happening.
      expect(notice?.textContent).toContain('Slow down and the map starts clearing again.');
      // Section 8.3: placed by the overlay layout, like every other overlay
      // on this screen.
      expect(notice?.closest('.map-overlays')).not.toBeNull();
    });

    it('takes the message away again on the first batch the player is slow enough for', async () => {
      const geo = stubGeolocation();
      stubWakeLock();
      let tooFast = true;
      stubMapFetch((url) => {
        if (url === '/api/samples') {
          return jsonResponse(200, {
            newCells: 0,
            newBars: [],
            visitUpdates: [],
            tooFastToReveal: tooFast,
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
      expect(container.querySelector('.map-toast--speed')).not.toBeNull();

      // The player got off the train. A message about it that outlives it is
      // the same class of lie as a banner claiming time never spent at a bar.
      tooFast = false;
      act(() => {
        geo.triggerPosition({ accuracy: 10 });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONFIG.SAMPLE_MIN_INTERVAL_MS);
      });

      expect(container.querySelector('.map-toast--speed')).toBeNull();
    });

    // The owner walked the city and was told "Revealed 1 new area" over and
    // over without finding a single bar, which is noise: the fog receding is
    // its own feedback, and a count of 50 m cells is not something a player
    // can act on. The message is gone, and this test is what makes that a
    // decision rather than an accident - it fails if anything puts a second
    // toast on the screen in response to a batch that cleared ground.
    //
    // Asserted as the whole set of toasts, not as the absence of a phrase: a
    // reworded return of the same idea has to fail here too.
    it('never announces revealed ground, however many cells a batch clears', async () => {
      const geo = stubGeolocation();
      stubWakeLock();
      stubMapFetch((url) => {
        if (url === '/api/samples') {
          return jsonResponse(200, {
            newCells: 7,
            newBars: [],
            visitUpdates: [],
            tooFastToReveal: false,
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

      const toasts = Array.from(container.querySelectorAll('.map-toast'));
      // The one toast this screen still shows a player who has found
      // nothing yet - and it is about a bar, not about the fog.
      expect(toasts.map((toast) => toast.textContent)).toEqual([
        'No bars discovered yet - walk toward one to reveal it here.',
      ]);
      expect(container.textContent).not.toContain('Revealed');
    });

    it('stops the geolocation watch and releases the wake lock when leaving the map screen', async () => {
      const geo = stubGeolocation();
      const wakeLock = stubWakeLock();
      stubMapFetch();

      vi.useFakeTimers();
      await renderMapWithFakeTimers();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(geo.watchPosition).toHaveBeenCalledTimes(1);
      expect(wakeLock.request).toHaveBeenCalledWith('screen');

      const menuButton = container.querySelector('.bottom-nav button') as HTMLButtonElement;
      act(() => {
        menuButton.click();
      });
      const settingsLink = Array.from(container.querySelectorAll('.more-sheet__panel a')).find(
        (entry) => entry.textContent === 'Settings',
      ) as HTMLAnchorElement;

      await act(async () => {
        settingsLink.click();
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(geo.clearWatch).toHaveBeenCalledTimes(1);
      expect(wakeLock.release).toHaveBeenCalledTimes(1);
    });

    it('does not throw when the Screen Wake Lock API is unavailable', async () => {
      stubGeolocation();
      stubMapFetch();

      vi.useFakeTimers();
      await renderMapWithFakeTimers();

      expect(container.querySelector('.tracking-indicator__button')).not.toBeNull();
      expect(statusLabel('tracking')).toBe('Foreground tracking: active');
    });

    it('opens the tracking status explanation when the indicator is tapped', async () => {
      stubMapFetch();

      await renderApp('/map');
      await flushLazyMapScreen();

      expect(container.querySelector('.tracking-indicator__panel')).toBeNull();

      const button = container.querySelector('.tracking-indicator__button') as HTMLButtonElement;
      act(() => {
        button.click();
      });

      const panel = container.querySelector('.tracking-indicator__panel');
      expect(panel).not.toBeNull();
      // The panel keeps the definitions - they are what makes an icon-only
      // indicator learnable - and now also says which state each of the
      // three is in (Section 8.6).
      expect(panel?.textContent).toContain('Foreground tracking');
      expect(panel?.textContent).toContain(`Good: within ${CONFIG.GPS_ACCURACY_GOOD_M} m`);
      // No geolocation stub on this render, so tracking never started -
      // the panel says so rather than claiming it is running.
      expect(panelCurrentStates()).toEqual([
        'Right now: Poor',
        'Right now: Online',
        'Right now: Paused',
      ]);
    });

    // Section 8.6: each icon states its state in words rather than naming
    // itself, for assistive technology. The button takes no aria-label of
    // its own, so its accessible name is computed from its contents - a
    // hidden lead-in saying what it opens, then the three states - and a
    // screen reader never reaches a bare "button".
    it('names the button from its contents: what it opens, then the three states', async () => {
      stubMapFetch();

      await renderApp('/map');
      await flushLazyMapScreen();

      const button = container.querySelector('.tracking-indicator__button') as HTMLButtonElement;
      expect(button.getAttribute('aria-label')).toBeNull();
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(button.querySelector('.visually-hidden')?.textContent).toBe('Tracking status.');
      expect(button.textContent).toBe('Tracking status.');
      expect([statusLabel('gps'), statusLabel('connection'), statusLabel('tracking')]).toEqual([
        'GPS signal: poor',
        'Connection: online',
        'Foreground tracking: paused',
      ]);
      // Paused is degraded, not bad: tracking stops when the app is not in
      // the foreground, which is how phones work and not a fault.
      expect(statusLevel('tracking')).toBe('degraded');
      for (const name of ['gps', 'connection', 'tracking'] as const) {
        expect(statusIcon(name).getAttribute('role')).toBe('img');
      }
    });
  });

  describe('bar markers and the bar detail screen', () => {
    function bar(overrides: Record<string, unknown> = {}) {
      return {
        id: 1,
        districtId: null,
        name: 'The Fox',
        address: 'Kaiserstraße 1',
        lat: 49.007,
        lon: 8.404,
        source: 'osm',
        discoveredAt: 1_700_000_000,
        mastered: false,
        ...overrides,
      };
    }

    function stubMapFetchWithBars(bars: unknown[], handler?: FetchHandler) {
      return stubFetch((url, init) => {
        if (url.startsWith('/api/auth/me')) {
          return stubSignedInUser();
        }
        if (url.startsWith('/tiles/')) {
          return jsonResponse(206, {});
        }
        if (url === '/api/bars') {
          return jsonResponse(200, { bars });
        }
        if (handler) {
          return handler(url, init);
        }
        throw new Error(`Unexpected request: ${url}`);
      });
    }

    // BarMarkers (map/bars/bar-markers.ts) appends its buttons to
    // map.getContainer() - MockMap's own `container` field, a detached div
    // that is never itself part of the React tree (it stands in for the
    // real MapLibre-owned DOM MapLibre would otherwise create). Reading
    // markers back out means going through that field, exactly as the
    // existing "renders the 2D canvas fallback" test above does for the fog
    // layer's canvas.
    function markerContainer(): HTMLElement {
      return mapInstances[0].container;
    }

    it('fetches discovered bars on entering the map and renders a marker for each', async () => {
      stubMapFetchWithBars([bar({ id: 1, name: 'The Fox' }), bar({ id: 2, name: 'Anchor Bar' })]);

      await renderApp('/map');
      await flushLazyMapScreen();
      await flushLazyMapScreen();

      const markers = markerContainer().querySelectorAll('button.bar-marker');
      expect(markers).toHaveLength(2);
      expect(
        markerContainer().querySelector(
          'button.bar-marker[aria-label="The Fox - not mastered yet"]',
        ),
      ).not.toBeNull();
      expect(
        markerContainer().querySelector(
          'button.bar-marker[aria-label="Anchor Bar - not mastered yet"]',
        ),
      ).not.toBeNull();
    });

    it('renders markers as real, keyboard-reachable 44px buttons', async () => {
      stubMapFetchWithBars([bar()]);

      await renderApp('/map');
      await flushLazyMapScreen();
      await flushLazyMapScreen();

      const marker = markerContainer().querySelector('button.bar-marker') as HTMLButtonElement;
      expect(marker).not.toBeNull();
      expect(marker.tagName).toBe('BUTTON');
      expect(marker.tabIndex).toBe(0);
      expect(marker.classList.contains('bar-marker')).toBe(true);
    });

    it('shows a bar newly reported by POST /api/samples without a reload', async () => {
      const newBar = bar({ id: 9, name: 'New Find', source: 'community' });
      let barsCallCount = 0;
      // GET /api/bars is stubbed directly (not via stubMapFetchWithBars,
      // whose own fixed-list branch would shadow this call-count logic) so
      // its second call - triggered by the reveal below - reflects the
      // server having recorded the discovery the first call predates.
      stubFetch((url) => {
        if (url.startsWith('/api/auth/me')) {
          return stubSignedInUser();
        }
        if (url.startsWith('/tiles/')) {
          return jsonResponse(206, {});
        }
        if (url === '/api/bars') {
          barsCallCount++;
          return jsonResponse(200, { bars: barsCallCount === 1 ? [] : [newBar] });
        }
        if (url === '/api/samples') {
          return jsonResponse(200, { newCells: 1, newBars: [newBar] });
        }
        throw new Error(`Unexpected request: ${url}`);
      });

      const geo = stubGeolocation();
      stubWakeLock();

      vi.useFakeTimers();
      await renderMapWithFakeTimers();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(markerContainer().querySelectorAll('button.bar-marker')).toHaveLength(0);

      act(() => {
        geo.triggerPosition({ accuracy: 10 });
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONFIG.SAMPLE_MIN_INTERVAL_MS);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(markerContainer().querySelectorAll('button.bar-marker')).toHaveLength(1);
      expect(
        markerContainer().querySelector(
          'button.bar-marker[aria-label="New Find - not mastered yet"]',
        ),
      ).not.toBeNull();
    });

    // Regression: a bar can be discovered inside fog the player has already
    // revealed (Section 7.4's discovery radius and reveal radius happen to
    // match today, but nothing guarantees that, and Phase 7's community
    // submissions will typically land in already-walked areas). Such a post
    // reports `newBars` with `newCells: 0` - the marker layer must still
    // refetch on that, not only on a reveal.
    it('shows a bar newly reported by POST /api/samples even when it reveals no new fog', async () => {
      const newBar = bar({ id: 9, name: 'New Find', source: 'community' });
      let barsCallCount = 0;
      stubFetch((url) => {
        if (url.startsWith('/api/auth/me')) {
          return stubSignedInUser();
        }
        if (url.startsWith('/tiles/')) {
          return jsonResponse(206, {});
        }
        if (url === '/api/bars') {
          barsCallCount++;
          return jsonResponse(200, { bars: barsCallCount === 1 ? [] : [newBar] });
        }
        if (url === '/api/samples') {
          return jsonResponse(200, { newCells: 0, newBars: [newBar] });
        }
        throw new Error(`Unexpected request: ${url}`);
      });

      const geo = stubGeolocation();
      stubWakeLock();

      vi.useFakeTimers();
      await renderMapWithFakeTimers();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(markerContainer().querySelectorAll('button.bar-marker')).toHaveLength(0);

      act(() => {
        geo.triggerPosition({ accuracy: 10 });
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONFIG.SAMPLE_MIN_INTERVAL_MS);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(markerContainer().querySelectorAll('button.bar-marker')).toHaveLength(1);
      expect(
        markerContainer().querySelector(
          'button.bar-marker[aria-label="New Find - not mastered yet"]',
        ),
      ).not.toBeNull();
    });

    // Section 8.3: "no map overlay may obscure another, and controls
    // anchored to an edge must yield to any bar occupying that edge". The
    // rule is enforced by the row layout in index.css, and stylesheet.test.ts
    // checks that no overlay positions itself against the map any more - but
    // that check is a text scan of a stylesheet and cannot see JSX. An
    // overlay rendered outside the container silently falls back to its base
    // positioning (the attribution, straight back onto the bottom bar) and the
    // stylesheet check still passes, which is exactly the hole a mutation
    // found: moving <BurgerMenu /> out of .map-overlays broke nothing.
    //
    // This is the other half. It asserts membership of the container, which
    // is what the CSS contract is written against; it does not assert
    // geometry, because jsdom computes none - every rect here is 0x0.
    //
    // The overlays that need state to appear (the pending-visit banner, the
    // bar sheet, the nearby panel) are covered by the same rule but not by
    // this render, so the sweep checks whatever is present and then requires
    // that the always-present four were among them - a mistyped selector
    // list then fails instead of iterating nothing and passing.
    it('renders every map overlay inside the layout container, not against the map', async () => {
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
        throw new Error(`Unexpected request: ${url}`);
      });
      stubGeolocation();
      stubWakeLock();

      vi.useFakeTimers();
      await renderMapWithFakeTimers();

      const overlaySelectors = [
        '.tracking-indicator',
        '.map-locate',
        '.map-attribution',
        '.pending-visit-banner',
        '.bar-sheet',
        '.nearby-bars-panel',
        '.map-toast',
        '.map-notice',
      ];
      const alwaysPresent = ['.tracking-indicator', '.map-locate', '.map-attribution'];

      const found: string[] = [];
      for (const selector of overlaySelectors) {
        for (const element of container.querySelectorAll(selector)) {
          found.push(selector);
          expect(
            element.closest('.map-overlays'),
            `${selector} is rendered outside .map-overlays, so index.css cannot place it`,
          ).not.toBeNull();
        }
      }

      for (const selector of alwaysPresent) {
        expect(
          found,
          `${selector} was not rendered, so this test proved nothing about it`,
        ).toContain(selector);
      }
    });

    // Section 7.5 step 1: tapping a marker leads to that bar, where the
    // check-in action is offered - and it does so without leaving the map,
    // because screens/Map.tsx is the only place position tracking runs
    // (components/BarSheet.tsx says why in full). It used to navigate to
    // /bars/:id; that route is still the linkable detail page, it is just no
    // longer where a marker tap goes.
    it('opens the bar sheet from a marker, without leaving the map screen', async () => {
      const discovered = bar({ id: 9, name: 'Navigate Bar', address: 'Somewhere 1' });
      stubFetch((url) => {
        if (url.startsWith('/api/auth/me')) {
          return stubSignedInUser();
        }
        if (url.startsWith('/tiles/')) {
          return jsonResponse(206, {});
        }
        if (url === '/api/bars') {
          return jsonResponse(200, { bars: [discovered] });
        }
        if (url === '/api/bars/9') {
          return jsonResponse(200, discovered);
        }
        if (url === '/api/city') {
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
        throw new Error(`Unexpected request: ${url}`);
      });

      await renderApp('/map');
      await flushLazyMapScreen();
      await flushLazyMapScreen();

      const marker = markerContainer().querySelector('button.bar-marker') as HTMLButtonElement;
      expect(marker).not.toBeNull();

      await act(async () => {
        marker.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(container.querySelector('.bar-sheet__name')?.textContent).toBe('Navigate Bar');
      expect(container.querySelector('.bar-sheet__address')?.textContent).toBe('Somewhere 1');
      expect(container.querySelector('.bar-sheet__check-in')?.textContent).toBe(
        'Check in at Navigate Bar',
      );
      expect(container.querySelector('.map-container')).not.toBeNull();
      expect(container.querySelector('.bar-detail')).toBeNull();
    });

    it('renders the bar detail screen with name, address and district from the response', async () => {
      stubFetch((url) => {
        if (url.startsWith('/api/auth/me')) {
          return stubSignedInUser();
        }
        if (url === '/api/bars/7') {
          return jsonResponse(
            200,
            bar({ id: 7, name: 'The Fox', address: 'Kaiserstraße 1', districtId: 3 }),
          );
        }
        if (url === '/api/city') {
          return jsonResponse(200, {
            slug: 'karlsruhe',
            name: 'Karlsruhe',
            originLat: 48.94,
            originLon: 8.275,
            gridWidth: 3,
            gridHeight: 3,
            cellSizeM: 50,
            playableCells: 9,
            districts: [{ id: 3, name: 'Innenstadt-West', playableCells: 100 }],
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      });

      await renderApp('/bars/7');
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(container.textContent).toContain('The Fox');
      expect(container.textContent).toContain('Kaiserstraße 1');
      expect(container.textContent).toContain('Innenstadt-West');
    });

    it('shows a sensible message, not a broken frame, for a bar that is undiscovered or does not exist', async () => {
      stubFetch((url) => {
        if (url.startsWith('/api/auth/me')) {
          return stubSignedInUser();
        }
        if (url === '/api/bars/99') {
          return jsonResponse(404, {
            code: 'bar_not_found',
            message: 'That bar does not exist.',
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      });

      await renderApp('/bars/99');
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(container.textContent).toContain('That bar does not exist.');
      expect(container.querySelector('.bar-detail h1')).toBeNull();
    });

    it('never renders a count of undiscovered bars anywhere on the map screen', async () => {
      stubMapFetchWithBars([bar({ id: 1, name: 'The Fox' }), bar({ id: 2, name: 'Anchor Bar' })]);

      await renderApp('/map');
      await flushLazyMapScreen();
      await flushLazyMapScreen();

      expect(markerContainer().querySelectorAll('button.bar-marker')).toHaveLength(2);
      expect(container.textContent).not.toMatch(/\d+\s*(of|\/)\s*\d+/i);
      expect(container.querySelector('.bar-count')).toBeNull();
    });

    // SPEC.md Sections 5.7, 8.1, 8.3: the cocktail glass is the app's mark
    // for a bar, and which of its two states is drawn comes from the
    // server's own per-user `mastered` field. These are end-to-end: a
    // response goes in and a shape comes out, so a flag that is computed
    // correctly but never reaches the mark - or a mark that ignores it -
    // fails here rather than passing two unit tests in isolation.
    describe('the mastered mark (SPEC.md Sections 5.7, 8.1, 8.3)', () => {
      function glassPathsOf(element: Element): string[] {
        return Array.from(element.querySelectorAll('svg.cocktail-glass path')).map(
          (path) => path.getAttribute('d') ?? '',
        );
      }

      it("draws each marker from its own bar's mastered flag", async () => {
        stubMapFetchWithBars([
          bar({ id: 1, name: 'The Fox', mastered: true }),
          bar({ id: 2, name: 'Anchor Bar', mastered: false }),
        ]);

        await renderApp('/map');
        await flushLazyMapScreen();
        await flushLazyMapScreen();

        const fox = markerContainer().querySelector(
          'button.bar-marker[aria-label="The Fox - mastered"]',
        ) as HTMLButtonElement;
        const anchor = markerContainer().querySelector(
          'button.bar-marker[aria-label="Anchor Bar - not mastered yet"]',
        ) as HTMLButtonElement;

        expect(fox).not.toBeNull();
        expect(anchor).not.toBeNull();
        expect(glassPathsOf(fox)).toEqual(cocktailGlassPathData(true));
        expect(glassPathsOf(anchor)).toEqual(cocktailGlassPathData(false));
        // The whole point of the mark: two bars on one map, told apart.
        expect(glassPathsOf(fox)).not.toEqual(glassPathsOf(anchor));
      });

      it('shows the mastered status on the bar detail screen, in words and in the glass', async () => {
        stubFetch((url) => {
          if (url.startsWith('/api/auth/me')) {
            return stubSignedInUser();
          }
          if (url === '/api/bars/7') {
            return jsonResponse(200, bar({ id: 7, name: 'The Fox', mastered: true }));
          }
          if (url === '/api/city') {
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
          throw new Error(`Unexpected request: ${url}`);
        });

        await renderApp('/bars/7');
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });

        const status = container.querySelector('.bar-detail__mastered') as HTMLElement;
        expect(status).not.toBeNull();
        expect(status.textContent).toContain('Mastered');
        expect(glassPathsOf(status)).toEqual(cocktailGlassPathData(true));
      });

      it('says so in words when the bar detail screen shows an unmastered bar', async () => {
        stubFetch((url) => {
          if (url.startsWith('/api/auth/me')) {
            return stubSignedInUser();
          }
          if (url === '/api/bars/7') {
            return jsonResponse(200, bar({ id: 7, name: 'The Fox', mastered: false }));
          }
          if (url === '/api/city') {
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
          throw new Error(`Unexpected request: ${url}`);
        });

        await renderApp('/bars/7');
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });

        const status = container.querySelector('.bar-detail__mastered') as HTMLElement;
        expect(status.textContent).toContain('Not mastered yet');
        expect(glassPathsOf(status)).toEqual(cocktailGlassPathData(false));
      });
    });
  });

  // The fog layer and the bar markers each refetch on their own signal now
  // (revealVersion vs. discoveryVersion in tracking/useSampleTracking.ts) -
  // these two tests cover the other halves of the split the regression test
  // above exercises: a reveal with no discovery still refetches the fog, and
  // a post with neither refetches nothing.
  describe('fog and bar marker refetch signals', () => {
    function cityFixtureResponse() {
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

    it('refetches the fog mask when a post reports newCells but no new bars', async () => {
      const geo = stubGeolocation();
      stubWakeLock();
      let fogCallCount = 0;
      stubFetch((url) => {
        if (url.startsWith('/api/auth/me')) {
          return stubSignedInUser();
        }
        if (url.startsWith('/tiles/')) {
          return jsonResponse(206, {});
        }
        if (url === '/api/city') {
          return cityFixtureResponse();
        }
        if (url === '/api/fog') {
          fogCallCount++;
          return fogResponse(new Uint8Array(2), {
            revealedCells: 0,
            playableCells: 9,
            districts: [],
          });
        }
        if (url === '/api/bars') {
          return jsonResponse(200, { bars: [] });
        }
        if (url === '/api/samples') {
          return jsonResponse(200, { newCells: 1, newBars: [] });
        }
        throw new Error(`Unexpected request: ${url}`);
      });

      vi.useFakeTimers();
      await renderMapWithFakeTimers();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(fogCallCount).toBe(1);

      act(() => {
        geo.triggerPosition({ accuracy: 10 });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONFIG.SAMPLE_MIN_INTERVAL_MS);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(fogCallCount).toBe(2);
    });

    it('refetches neither the fog mask nor the bar markers when a post reports nothing new', async () => {
      const geo = stubGeolocation();
      stubWakeLock();
      let fogCallCount = 0;
      let barsCallCount = 0;
      stubFetch((url) => {
        if (url.startsWith('/api/auth/me')) {
          return stubSignedInUser();
        }
        if (url.startsWith('/tiles/')) {
          return jsonResponse(206, {});
        }
        if (url === '/api/city') {
          return cityFixtureResponse();
        }
        if (url === '/api/fog') {
          fogCallCount++;
          return fogResponse(new Uint8Array(2), {
            revealedCells: 0,
            playableCells: 9,
            districts: [],
          });
        }
        if (url === '/api/bars') {
          barsCallCount++;
          return jsonResponse(200, { bars: [] });
        }
        if (url === '/api/samples') {
          return jsonResponse(200, { newCells: 0, newBars: [] });
        }
        throw new Error(`Unexpected request: ${url}`);
      });

      vi.useFakeTimers();
      await renderMapWithFakeTimers();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(fogCallCount).toBe(1);
      expect(barsCallCount).toBe(1);

      act(() => {
        geo.triggerPosition({ accuracy: 10 });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONFIG.SAMPLE_MIN_INTERVAL_MS);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(fogCallCount).toBe(1);
      expect(barsCallCount).toBe(1);
    });

    // SPEC.md Sections 5.7, 8.1: mastering a bar changes the glass its
    // marker draws, and the bar in question was discovered long before — so
    // `newBars` is empty and nothing else in the response would refetch the
    // list. Without this signal the marker keeps drawing the full glass
    // until the next discovery or the next time the map is opened, which is
    // the whole of the mark being inert at the one moment it means
    // something. End-to-end on purpose: the assertion is the drawn shape,
    // not the call count, because a refetch that does not reach the marker
    // is the same bug.
    it('refetches the bar markers when a post completes a visit, and the glass empties', async () => {
      const geo = stubGeolocation();
      stubWakeLock();
      let barsCallCount = 0;
      stubFetch((url) => {
        if (url.startsWith('/api/auth/me')) {
          return stubSignedInUser();
        }
        if (url.startsWith('/tiles/')) {
          return jsonResponse(206, {});
        }
        if (url === '/api/city') {
          return cityFixtureResponse();
        }
        if (url === '/api/fog') {
          return fogResponse(new Uint8Array(2), {
            revealedCells: 0,
            playableCells: 9,
            districts: [],
          });
        }
        if (url === '/api/bars') {
          barsCallCount++;
          // The server's answer changes between the two calls, because the
          // visit completing is what mastered it (Section 5.7).
          return jsonResponse(200, {
            bars: [
              {
                id: 1,
                districtId: null,
                name: 'The Fox',
                address: null,
                lat: 48.9405,
                lon: 8.2755,
                source: 'osm',
                discoveredAt: 1,
                mastered: barsCallCount > 1,
              },
            ],
          });
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
                id: 5,
                barId: 1,
                barName: 'The Fox',
                startedAt: 0,
                lastSampleAt: 0,
                onsiteSamples: 2,
                confirmedS: CONFIG.VISIT_REQUIRED_MS / 1000,
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
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(barsCallCount).toBe(1);
      const markers = () => mapInstances[0].container;
      const before = markers().querySelector(
        'button.bar-marker[aria-label="The Fox - not mastered yet"]',
      );
      expect(before).not.toBeNull();

      act(() => {
        geo.triggerPosition({ accuracy: 10 });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONFIG.SAMPLE_MIN_INTERVAL_MS);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(barsCallCount).toBe(2);
      const after = markers().querySelector(
        'button.bar-marker[aria-label="The Fox - mastered"]',
      ) as HTMLButtonElement;
      expect(after).not.toBeNull();
      expect(
        Array.from(after.querySelectorAll('svg.cocktail-glass path')).map((path) =>
          path.getAttribute('d'),
        ),
      ).toEqual(cocktailGlassPathData(true));
    });

    // The other side of that trade: `visitVersion` advances on every
    // accepted on-site sample, and refetching every bar at sample rate to
    // catch the one sample that completes a visit is the wrong way round.
    // Only `completed` masters a bar (Section 5.7), so only `completed`
    // refetches.
    it('does not refetch the bar markers for a visit update that is still pending', async () => {
      const geo = stubGeolocation();
      stubWakeLock();
      let barsCallCount = 0;
      stubFetch((url) => {
        if (url.startsWith('/api/auth/me')) {
          return stubSignedInUser();
        }
        if (url.startsWith('/tiles/')) {
          return jsonResponse(206, {});
        }
        if (url === '/api/city') {
          return cityFixtureResponse();
        }
        if (url === '/api/fog') {
          return fogResponse(new Uint8Array(2), {
            revealedCells: 0,
            playableCells: 9,
            districts: [],
          });
        }
        if (url === '/api/bars') {
          barsCallCount++;
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
                id: 5,
                barId: 1,
                barName: 'The Fox',
                startedAt: 0,
                lastSampleAt: 0,
                onsiteSamples: 1,
                confirmedS: 60,
                remainingS: 1140,
                status: 'pending',
              },
            ],
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      });

      vi.useFakeTimers();
      await renderMapWithFakeTimers();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(barsCallCount).toBe(1);

      act(() => {
        geo.triggerPosition({ accuracy: 10 });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONFIG.SAMPLE_MIN_INTERVAL_MS);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(barsCallCount).toBe(1);
    });
  });

  // SPEC.md Sections 7.4/8.3: walking into an unknown bar's radius is a
  // moment on the map. map/bars/bar-stamps.test.ts covers the moment itself
  // against a hand-built map; what is proved here is the wiring - that the
  // bars POST /api/samples reports reach the screen at all, and that nothing
  // else does.
  describe('the bar stamp (SPEC.md Sections 7.4, 8.3)', () => {
    function mapContainer(): HTMLElement {
      return mapInstances[0].container;
    }

    function stubMapFetch(handler: FetchHandler) {
      return stubFetch((url, init) => {
        if (url.startsWith('/api/auth/me')) {
          return stubSignedInUser();
        }
        if (url.startsWith('/tiles/')) {
          return jsonResponse(206, {});
        }
        if (url === '/api/visits/pending') {
          return jsonResponse(200, { visits: [] });
        }
        return handler(url, init);
      });
    }

    async function postASample(geo: GeolocationStub) {
      act(() => {
        geo.triggerPosition({ accuracy: 10 });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONFIG.SAMPLE_MIN_INTERVAL_MS);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    }

    it('stamps a newly discovered bar onto the map and hands over to its marker', async () => {
      const newBar = {
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
      const geo = stubGeolocation();
      stubWakeLock();
      let barsCallCount = 0;
      stubMapFetch((url) => {
        if (url === '/api/bars') {
          barsCallCount++;
          return jsonResponse(200, { bars: barsCallCount === 1 ? [] : [newBar] });
        }
        if (url === '/api/samples') {
          return jsonResponse(200, { newCells: 1, newBars: [newBar] });
        }
        throw new Error(`Unexpected request: ${url}`);
      });

      vi.useFakeTimers();
      await renderMapWithFakeTimers();
      await postASample(geo);

      // In words, once, and politely - the map's own toasts set that
      // precedent (map/bars/bar-stamps.ts says why it is not an alert).
      expect(mapContainer().querySelector('.bar-stamps__announcement')?.textContent).toBe(
        'Bar discovered: New Find.',
      );

      // The refetch the discovery triggered has already drawn this bar's
      // permanent marker - the race the hand-over exists for. It is held
      // back before the stamp is even drawn, so there is never a frame with
      // two identical glasses on one point.
      const marker = mapContainer().querySelector(
        'button.bar-marker[aria-label^="New Find - "]',
      ) as HTMLButtonElement;
      expect(marker).not.toBeNull();
      expect(marker.classList.contains('bar-marker--stamping')).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONFIG.FOG_REVEAL_ANIMATION_MS);
      });

      const stamp = mapContainer().querySelector('.bar-stamp');
      expect(stamp).not.toBeNull();
      expect(stamp?.querySelector('.bar-stamp__name')?.textContent).toBe('New Find');
      expect(mapContainer().querySelector('.bar-stamp-scrim')).not.toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONFIG.BAR_STAMP_DURATION_MS);
      });

      // It ends by itself, and the marker takes its ink back.
      expect(mapContainer().querySelector('.bar-stamp')).toBeNull();
      expect(mapContainer().querySelector('.bar-stamp-scrim')).toBeNull();
      expect(marker.classList.contains('bar-marker--stamping')).toBe(false);
    });

    // The trap this feature is one line away from at all times. Since v1.29
    // `discoveryVersion` also advances when a visit reaches `completed`,
    // because both mean "refetch GET /api/bars" - so a stamp keyed on that
    // signal would fire when a bar is *mastered*, which already has its own
    // message on this screen and is not a discovery at all.
    it('stamps nothing when a post masters a bar rather than discovering one', async () => {
      const geo = stubGeolocation();
      stubWakeLock();
      let barsCallCount = 0;
      stubMapFetch((url) => {
        if (url === '/api/bars') {
          barsCallCount++;
          return jsonResponse(200, {
            bars: [
              {
                id: 1,
                districtId: null,
                name: 'The Fox',
                address: null,
                lat: 49.007,
                lon: 8.404,
                source: 'osm',
                discoveredAt: 1,
                mastered: barsCallCount > 1,
              },
            ],
          });
        }
        if (url === '/api/samples') {
          return jsonResponse(200, {
            newCells: 0,
            newBars: [],
            visitUpdates: [
              {
                id: 5,
                barId: 1,
                barName: 'The Fox',
                startedAt: 0,
                lastSampleAt: 0,
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
      await postASample(geo);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(
          CONFIG.FOG_REVEAL_ANIMATION_MS + CONFIG.BAR_STAMP_DURATION_MS,
        );
      });

      // The bar list was refetched - that is what empties the glass - and
      // nothing was stamped, announced or dimmed.
      expect(barsCallCount).toBe(2);
      expect(mapContainer().querySelector('.bar-stamp')).toBeNull();
      expect(mapContainer().querySelector('.bar-stamp-scrim')).toBeNull();
      expect(mapContainer().querySelector('.bar-stamps__announcement')?.textContent).toBe('');
      expect(
        mapContainer()
          .querySelector('button.bar-marker')
          ?.classList.contains('bar-marker--stamping'),
      ).toBe(false);
      // The moment mastering does have is the one it already had.
      expect(container.querySelector('.map-toast--mastered')?.textContent).toContain('The Fox');
    });
  });
});
