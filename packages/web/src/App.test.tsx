import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { ACTIVE_CITY_SLUG } from './api/city.js';
import type { BoundaryFeatureCollection } from './api/geo-types.js';
import { Avatar } from './components/Avatar.js';

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

// MapLibre needs a real WebGL context, which jsdom does not provide, so the
// map route is exercised against a stand-in Map class rather than the real
// library. mapInstances lets tests reach the last constructed instance to
// assert on lifecycle calls such as remove().
const { MockMap, addProtocolMock, removeProtocolMock, mapInstances } = vi.hoisted(() => {
  const instances: { remove: ReturnType<typeof vi.fn> }[] = [];
  class MockMap {
    remove = vi.fn();
    on = vi.fn();
    off = vi.fn();
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

// React.lazy's dynamic import resolves over real module-transform time on
// its first call, not just a microtask tick - noticeably longer than the
// single setTimeout(0) flush used elsewhere in this file. Priming it once
// up front keeps every /map test's timing uniform.
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
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
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

  it('opens the burger menu with exactly the Phase 1 and Phase 2 destinations, and closes it on Escape', async () => {
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
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/app');

    const menuButton = container.querySelector('.burger-menu__button') as HTMLButtonElement;
    expect(menuButton).not.toBeNull();
    expect(container.querySelector('.burger-menu__panel')).toBeNull();

    act(() => {
      menuButton.click();
    });

    const entries = container.querySelectorAll('.burger-menu__panel a, .burger-menu__panel button');
    expect(Array.from(entries).map((entry) => entry.textContent)).toEqual([
      'Map',
      'City',
      'Districts',
      'Settings',
      'Log out',
    ]);

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(container.querySelector('.burger-menu__panel')).toBeNull();
  });

  it('does not render the burger menu on signed-out screens', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return jsonResponse(401, { code: 'unauthenticated', message: 'Authentication required.' });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/');

    expect(container.querySelector('.burger-menu')).toBeNull();
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

    const menuButton = container.querySelector('.burger-menu__button') as HTMLButtonElement;
    act(() => {
      menuButton.click();
    });
    const settingsLink = Array.from(container.querySelectorAll('.burger-menu__panel a')).find(
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
  });

  it('renders all 27 districts as a list with a name and a percentage each', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url === `/static/${ACTIVE_CITY_SLUG}/districts.geojson`) {
        return jsonResponse(200, districtsFixture);
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
      expect(item.querySelector('.district-list__percent')?.textContent).toMatch(/^\d+%$/);
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
});
