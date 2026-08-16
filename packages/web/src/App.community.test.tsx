import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';

// SPEC.md Sections 8.3/9.3/11.3 (Phase 7 step 3): suggest-a-bar with its
// mandatory map picker and duplicate-name rejection, the community marker
// distinguishing a community-submitted bar from an OSM one, and the admin
// area (menu visibility, hiding a bar, and the delete confirmation). A
// separate file from App.checkin.test.tsx / App.leaderboard.test.tsx rather
// than another describe block in either, following the same per-phase-step
// precedent - this one needs its own MockMap, since map/MapPicker.tsx
// depends on a functional 'click' listener neither of those two files'
// stand-ins implement.

const { MockMap, addProtocolMock, removeProtocolMock, mapInstances } = vi.hoisted(() => {
  const instances: {
    container: HTMLDivElement;
    fire: (event: string, payload?: unknown) => void;
  }[] = [];
  class MockMap {
    listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    remove = vi.fn();
    addLayer = vi.fn();
    removeLayer = vi.fn();
    getLayer = vi.fn();
    loaded = vi.fn(() => true);
    project = vi.fn(() => ({ x: 0, y: 0 }));
    container = document.createElement('div');
    getContainer = () => this.container;
    on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!this.listeners.has(event)) {
        this.listeners.set(event, new Set());
      }
      this.listeners.get(event)?.add(handler);
    });
    off = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      this.listeners.get(event)?.delete(handler);
    });
    fire = (event: string, payload?: unknown) => {
      for (const handler of this.listeners.get(event) ?? []) {
        handler(payload);
      }
    };
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

// Same native-setter trick App.test.tsx uses: assigning `.value` directly
// goes through React's wrapped setter and the following `input` event is
// seen as a no-op change, so this bypasses it the way real typing does.
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  'value',
)?.set;

function setInputValue(input: HTMLInputElement, value: string) {
  nativeInputValueSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function click(element: Element) {
  await act(async () => {
    (element as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function flushLazyScreen() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
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
  await flushLazyScreen();
  await flushLazyScreen();
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

function communityBar(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    districtId: null,
    name: 'The Hidden Cellar',
    address: 'Kaiserstraße 99',
    lat: 49.011,
    lon: 8.4045,
    source: 'community',
    discoveredAt: 1_700_000_000,
    ...overrides,
  };
}

function adminBar(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    cityId: 1,
    districtId: null,
    name: 'The Fox',
    address: 'Kaiserstraße 1',
    lat: 49.0,
    lon: 8.4,
    source: 'osm',
    submittedBy: null,
    status: 'active',
    createdAt: 1_700_000_000,
    ...overrides,
  };
}

beforeAll(async () => {
  await import('./screens/Map.js');
  await import('./screens/SuggestBar.js');
  await import('./screens/Admin.js');
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mapInstances.length = 0;
  addProtocolMock.mockClear();
  removeProtocolMock.mockClear();
  // Phase 8: map/fog/fog-cache.ts writes to localStorage on a successful
  // fog fetch - cleared here for the same cross-test-leakage reason
  // App.checkin.test.tsx and App.test.tsx clear it (see the latter's own
  // comment).
  window.localStorage.clear();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('suggest a bar', () => {
  it('submitting a bar with a picked pin succeeds and the bar appears as discovered', async () => {
    stubFetch((url, init) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url === '/api/bars/suggest' && init?.method === 'POST') {
        return jsonResponse(201, communityBar());
      }
      // GET /api/bars/:id returns an identical 404 for "does not exist" and
      // "not discovered by you" (Section 9.5) - succeeding here is what
      // proves the submitter's own submission is already discovered.
      if (url === '/api/bars/42') {
        return jsonResponse(200, communityBar());
      }
      if (url === '/api/city') {
        return jsonResponse(200, { districts: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/suggest');

    expect(container.querySelector('.map-picker__status')?.textContent).toContain('No pin placed');

    act(() => {
      mapInstances[0].fire('click', { lngLat: { lat: 49.011, lng: 8.4045 } });
    });

    expect(container.querySelector('.map-picker__status')?.textContent).toContain('Pin placed');

    const nameInput = container.querySelector('#suggest-bar-name') as HTMLInputElement;
    act(() => {
      setInputValue(nameInput, 'The Hidden Cellar');
    });

    const submitButton = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submitButton.disabled).toBe(false);
    await click(submitButton);

    expect(container.querySelector('h1')?.textContent).toBe('The Hidden Cellar');
    expect(container.querySelector('.bar-detail__tag')?.textContent).toBe('Added by the community');
  });

  it("a duplicate rejection surfaces the server's message naming the conflict", async () => {
    stubFetch((url, init) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url === '/api/bars/suggest' && init?.method === 'POST') {
        return jsonResponse(409, {
          code: 'duplicate_bar',
          message: 'A bar named "The Fox" already exists nearby.',
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/suggest');

    act(() => {
      mapInstances[0].fire('click', { lngLat: { lat: 49.011, lng: 8.4045 } });
    });

    const nameInput = container.querySelector('#suggest-bar-name') as HTMLInputElement;
    act(() => {
      setInputValue(nameInput, 'The Fox Annex');
    });

    const submitButton = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    await click(submitButton);

    expect(container.querySelector('.error-message')?.textContent).toBe(
      'A bar named "The Fox" already exists nearby.',
    );
    // Still on the suggest screen - a rejection must not navigate away.
    expect(container.querySelector('.map-picker')).not.toBeNull();
  });
});

describe('community marker', () => {
  it('shows a community bar marker distinctly from an OSM bar marker', async () => {
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
            {
              id: 1,
              districtId: null,
              name: 'OSM Bar',
              address: null,
              lat: 49.0,
              lon: 8.4,
              source: 'osm',
              discoveredAt: 1,
            },
            communityBar({ id: 2, name: 'Community Bar' }),
          ],
        });
      }
      if (url === '/api/visits/pending') {
        return jsonResponse(200, { visits: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/map');

    // Bar markers are appended to map.getContainer() (map/bars/bar-markers.ts) -
    // MockMap's own `container` field, a detached div standing in for the
    // real MapLibre-owned DOM MapLibre would otherwise create, not part of
    // the React tree itself. Same approach App.test.tsx's own
    // markerContainer() helper takes.
    const markers = mapInstances[0].container;

    const communityMarker = markers.querySelector(
      'button.bar-marker--community',
    ) as HTMLButtonElement;
    expect(communityMarker).not.toBeNull();
    expect(communityMarker.getAttribute('aria-label')).toBe('Community Bar');
    const describedById = communityMarker.getAttribute('aria-describedby');
    expect(describedById).not.toBeNull();
    expect(communityMarker.querySelector(`#${describedById}`)?.textContent).toBe(
      'Added by the community',
    );

    const osmMarker = Array.from(markers.querySelectorAll('button.bar-marker')).find(
      (button) => button.getAttribute('aria-label') === 'OSM Bar',
    );
    expect(osmMarker).not.toBeUndefined();
    expect(osmMarker?.classList.contains('bar-marker--community')).toBe(false);
    expect(osmMarker?.hasAttribute('aria-describedby')).toBe(false);
  });
});

describe('admin menu visibility', () => {
  it('hides the Admin entry from the burger menu for a non-admin user', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser({ isAdmin: false });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/settings');
    const menuButton = container.querySelector('.burger-menu__button') as HTMLButtonElement;
    act(() => {
      menuButton.click();
    });

    const links = Array.from(container.querySelectorAll('.burger-menu__panel a')).map(
      (link) => link.textContent,
    );
    expect(links).not.toContain('Admin');
  });

  it('shows the Admin entry in the burger menu for an admin user', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser({ isAdmin: true });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/settings');
    const menuButton = container.querySelector('.burger-menu__button') as HTMLButtonElement;
    act(() => {
      menuButton.click();
    });

    const links = Array.from(container.querySelectorAll('.burger-menu__panel a')).map(
      (link) => link.textContent,
    );
    expect(links).toContain('Admin');
  });
});

describe('admin bar management', () => {
  it('hides a bar and reflects it in the list', async () => {
    let bar = adminBar();
    stubFetch((url, init) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser({ isAdmin: true });
      }
      if (url === '/api/admin/bars/10' && init?.method === 'PATCH') {
        const body = JSON.parse((init.body as string) ?? '{}') as { status?: string };
        bar = { ...bar, status: body.status ?? bar.status };
        return jsonResponse(200, bar);
      }
      if (url === '/api/admin/bars' && init?.method === undefined) {
        return jsonResponse(200, { bars: [bar] });
      }
      if (url === '/api/admin/users') {
        return jsonResponse(200, { users: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/admin');

    expect(container.querySelector('.admin-bar-row__tag--hidden')).toBeNull();

    const hideButton = Array.from(
      container.querySelectorAll('.admin-bar-row__actions button'),
    ).find((button) => button.textContent === 'Hide') as HTMLButtonElement;
    await click(hideButton);

    expect(container.querySelector('.admin-bar-row__tag--hidden')?.textContent).toBe('Hidden');
  });

  it('asks for confirmation naming the bar before deleting, and does not call the API if dismissed', async () => {
    let bars = [adminBar({ id: 20, name: 'The Fox' })];
    const deleteCalls = vi.fn();
    stubFetch((url, init) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser({ isAdmin: true });
      }
      if (url === '/api/admin/bars/20' && init?.method === 'DELETE') {
        deleteCalls();
        bars = [];
        return jsonResponse(200, { ok: true });
      }
      if (url === '/api/admin/bars' && init?.method === undefined) {
        return jsonResponse(200, { bars });
      }
      if (url === '/api/admin/users') {
        return jsonResponse(200, { users: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const confirmSpy = vi.spyOn(window, 'confirm');

    await renderApp('/admin');

    const deleteButton = Array.from(
      container.querySelectorAll('.admin-bar-row__actions button'),
    ).find((button) => button.textContent === 'Delete') as HTMLButtonElement;

    confirmSpy.mockReturnValueOnce(false);
    await click(deleteButton);

    expect(confirmSpy).toHaveBeenCalledWith('Delete "The Fox"? This cannot be undone.');
    expect(deleteCalls).not.toHaveBeenCalled();
    expect(container.querySelector('.admin-bar-row')).not.toBeNull();

    confirmSpy.mockReturnValueOnce(true);
    await click(deleteButton);

    expect(deleteCalls).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.admin-bar-row')).toBeNull();
  });
});
