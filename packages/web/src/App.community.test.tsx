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
    setMaxBounds = vi.fn();
    jumpTo = vi.fn();
    flyTo = vi.fn();
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
    mastered: false,
    ...overrides,
  };
}

// GET /api/fog's body is the raw bitmask and its progress rides in a header
// (api/client.ts), so it cannot be jsonResponse. Same shape as
// App.test.tsx's own fogResponse helper - there is no shared test-utils
// module to import one from.
function fogResponse(mask: Uint8Array, progress: unknown) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'X-Fog-Progress': JSON.stringify(progress) }),
    arrayBuffer: async () => mask.buffer.slice(mask.byteOffset, mask.byteOffset + mask.byteLength),
  } as unknown as Response;
}

// A 3x3 grid, which is one byte of mask plus a bit. Small on purpose: no
// test here reads a cell, only whether the fog layer was built at all.
const pickerCityMeta = {
  slug: 'karlsruhe',
  name: 'Karlsruhe',
  originLat: 48.94,
  originLon: 8.275,
  gridWidth: 3,
  gridHeight: 3,
  cellSizeM: 50,
  playableCells: 9,
  districts: [],
};

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

  // The other half of Section 9.3's opt-in, and the half that is easy to
  // lose: the fog and the bar markers belong to the admin's teleport picker
  // and to nothing else. This screen shares the component with it, so a flag
  // defaulted the wrong way, or hooks called unconditionally inside
  // MapPicker, would put a bar marker on the exact spot someone is trying to
  // point at and hide the streets they are pointing by.
  //
  // The proof is the fetches, not the DOM: `useDiscoveredBars` and
  // `useFogLayer` both fetch the moment they are called and both swallow
  // their own failures, so a version of this that mounted them anyway would
  // draw nothing here and still be wrong. The stub answers neither route, so
  // asking for either is an unexpected request; the assertions below name
  // the failure rather than leaving it to a silent catch.
  it("draws neither the fog nor any bar marker - those are the admin picker's", async () => {
    const fetchMock = stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/suggest');
    await flushLazyScreen();
    await flushLazyScreen();

    const requested = fetchMock.mock.calls.map(([input]) => input);
    expect(requested).not.toContain('/api/fog');
    expect(requested).not.toContain('/api/bars');
    const mapContainer = mapInstances[mapInstances.length - 1].container;
    expect(mapContainer.querySelector('canvas.fog-canvas-fallback')).toBeNull();
    expect(mapContainer.querySelector('.bar-markers')).toBeNull();
    expect(mapContainer.querySelector('.bar-marker')).toBeNull();
    // ...and the picker itself is unchanged and still usable.
    expect(container.querySelector('.map-picker')).not.toBeNull();
    act(() => {
      mapInstances[mapInstances.length - 1].fire('click', { lngLat: { lat: 49.011, lng: 8.4045 } });
    });
    expect(container.querySelector('.map-picker__status')?.textContent).toContain('Pin placed');
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
              mastered: false,
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
    // Section 11.3's community distinction stays a *description*; Section
    // 5.7's mastered state is what joins the accessible name
    // (map/bars/bar-markers.ts).
    expect(communityMarker.getAttribute('aria-label')).toBe('Community Bar - not mastered yet');
    const describedById = communityMarker.getAttribute('aria-describedby');
    expect(describedById).not.toBeNull();
    expect(communityMarker.querySelector(`#${describedById}`)?.textContent).toBe(
      'Added by the community',
    );

    const osmMarker = Array.from(markers.querySelectorAll('button.bar-marker')).find(
      (button) => button.getAttribute('aria-label') === 'OSM Bar - not mastered yet',
    );
    expect(osmMarker).not.toBeUndefined();
    expect(osmMarker?.classList.contains('bar-marker--community')).toBe(false);
    expect(osmMarker?.hasAttribute('aria-describedby')).toBe(false);
  });
});

describe('admin menu visibility', () => {
  it('hides the Admin entry from the More sheet for a non-admin user', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser({ isAdmin: false });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/settings');
    const moreButton = container.querySelector('.bottom-nav button') as HTMLButtonElement;
    act(() => {
      moreButton.click();
    });

    const links = Array.from(container.querySelectorAll('.more-sheet__panel a')).map(
      (link) => link.textContent,
    );
    expect(links).not.toContain('Admin');
  });

  it('shows the Admin entry in the More sheet for an admin user', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser({ isAdmin: true });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/settings');
    const moreButton = container.querySelector('.bottom-nav button') as HTMLButtonElement;
    act(() => {
      moreButton.click();
    });

    const links = Array.from(container.querySelectorAll('.more-sheet__panel a')).map(
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
      if (url === '/api/visits/pending') {
        return jsonResponse(200, { visits: [] });
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
      if (url === '/api/visits/pending') {
        return jsonResponse(200, { visits: [] });
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

// SPEC.md Section 7.5's cancel endpoint, reached from the admin screen. The
// escape hatch for the state the owner's field test ended in: pending visits
// he could not clear from the map's banner. It is the caller's own visits and
// nobody else's - GET /api/visits/pending and POST /api/visits/:id/cancel
// both scope themselves to the session's user server-side - so no admin route
// was added for it.
describe('admin pending-visit escape hatch', () => {
  function visitRows(): HTMLElement[] {
    return Array.from(container.querySelectorAll('.admin-visit-row'));
  }

  function pendingVisit(overrides: Record<string, unknown> = {}) {
    const nowS = Math.floor(Date.now() / 1000);
    return {
      id: 77,
      barId: 10,
      barName: 'The Fox',
      startedAt: nowS,
      lastSampleAt: nowS,
      onsiteSamples: 1,
      confirmedS: 0,
      remainingS: 1200,
      status: 'pending',
      ...overrides,
    };
  }

  it("lists the signed-in admin's own pending visits and cancels the one whose control was tapped", async () => {
    let visits = [
      pendingVisit({ id: 77, barId: 10, barName: 'The Fox' }),
      pendingVisit({ id: 88, barId: 11, barName: 'The Hound' }),
    ];
    const cancelPaths: string[] = [];
    stubFetch((url, init) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser({ isAdmin: true });
      }
      if (url === '/api/admin/bars' && init?.method === undefined) {
        return jsonResponse(200, { bars: [] });
      }
      if (url === '/api/admin/users') {
        return jsonResponse(200, { users: [] });
      }
      if (url === '/api/visits/pending') {
        return jsonResponse(200, { visits });
      }
      if (url.endsWith('/cancel') && init?.method === 'POST') {
        cancelPaths.push(url);
        visits = visits.filter((visit) => !url.includes(String(visit.id)));
        return jsonResponse(200, pendingVisit({ id: 88, status: 'cancelled' }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const confirmSpy = vi.spyOn(window, 'confirm');

    await renderApp('/admin');

    expect(
      visitRows().map((row) => row.querySelector('.admin-visit-row__bar')?.textContent),
    ).toEqual(['The Fox', 'The Hound']);

    // Deliberately the second row, so a control reaching for `visits[0]`
    // would end the wrong visit and this would catch it.
    const houndCancel = visitRows()[1].querySelector(
      '.admin-visit-row__cancel',
    ) as HTMLButtonElement;

    confirmSpy.mockReturnValueOnce(false);
    await click(houndCancel);
    expect(confirmSpy).toHaveBeenCalledWith(
      'Cancel your pending visit to "The Hound"? This cannot be undone.',
    );
    expect(cancelPaths).toEqual([]);
    expect(visitRows()).toHaveLength(2);

    confirmSpy.mockReturnValueOnce(true);
    await click(houndCancel);

    expect(cancelPaths).toEqual(['/api/visits/88/cancel']);
    expect(
      visitRows().map((row) => row.querySelector('.admin-visit-row__bar')?.textContent),
    ).toEqual(['The Fox']);
  });

  // Sections 7.5 and 9.5: the same 404-means-gone rule the banner follows,
  // from the same helper - a visit the server says is not pending must leave
  // this list too, or the escape hatch has the very defect it exists for.
  it('removes a visit that answers 404, the same way the banner does', async () => {
    stubFetch((url, init) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser({ isAdmin: true });
      }
      if (url === '/api/admin/bars' && init?.method === undefined) {
        return jsonResponse(200, { bars: [] });
      }
      if (url === '/api/admin/users') {
        return jsonResponse(200, { users: [] });
      }
      if (url === '/api/visits/pending') {
        return jsonResponse(200, { visits: [pendingVisit({ id: 77 })] });
      }
      if (url === '/api/visits/77/cancel' && init?.method === 'POST') {
        return jsonResponse(404, {
          code: 'visit_not_found',
          message: 'You have no pending visit with that id.',
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    vi.spyOn(window, 'confirm').mockReturnValue(true);

    await renderApp('/admin');

    expect(visitRows()).toHaveLength(1);
    await click(visitRows()[0].querySelector('.admin-visit-row__cancel') as HTMLButtonElement);

    expect(visitRows()).toHaveLength(0);
    expect(container.querySelector('.admin__section .error-message')).toBeNull();
  });
});

// SPEC.md Section 9.3: the admin bar list is ordered by name. The server
// sends it that way, but this screen edits the list in place afterwards -
// appending a created bar and replacing an edited one - so the order has to
// survive both without a reload. "Änderungsbar" is the fixture name in both
// tests on purpose: it sorts first under the shared comparator and last under
// a code-point sort, so a list that merely looks sorted in ASCII cannot pass.
describe('admin bar list ordering', () => {
  function listedBarNames(): string[] {
    return Array.from(container.querySelectorAll('.admin-bar-row__name')).map(
      (element) => element.textContent ?? '',
    );
  }

  it('puts a newly created bar in its alphabetical place, not at the bottom', async () => {
    const bars = [
      adminBar({ id: 10, name: 'Bergbräustube' }),
      adminBar({ id: 11, name: 'Zeta Bar' }),
    ];
    stubFetch((url, init) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser({ isAdmin: true });
      }
      if (url === '/api/admin/bars' && init?.method === 'POST') {
        return jsonResponse(201, adminBar({ id: 12, name: 'Änderungsbar', source: 'admin' }));
      }
      if (url === '/api/admin/bars' && init?.method === undefined) {
        return jsonResponse(200, { bars });
      }
      if (url === '/api/admin/users') {
        return jsonResponse(200, { users: [] });
      }
      if (url === '/api/visits/pending') {
        return jsonResponse(200, { visits: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/admin');

    expect(listedBarNames()).toEqual(['Bergbräustube', 'Zeta Bar']);

    setInputValue(
      container.querySelector('#admin-create-name') as HTMLInputElement,
      'Änderungsbar',
    );
    setInputValue(container.querySelector('#admin-create-lat') as HTMLInputElement, '49.0135');
    setInputValue(container.querySelector('#admin-create-lon') as HTMLInputElement, '8.4044');
    await click(
      Array.from(container.querySelectorAll('.admin-create-form button')).find(
        (button) => button.textContent === 'Create bar',
      ) as HTMLButtonElement,
    );

    expect(listedBarNames()).toEqual(['Änderungsbar', 'Bergbräustube', 'Zeta Bar']);
  });

  it('moves a renamed bar to its new place in the list', async () => {
    const bars = [
      adminBar({ id: 10, name: 'Bergbräustube' }),
      adminBar({ id: 11, name: 'Zeta Bar' }),
    ];
    stubFetch((url, init) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser({ isAdmin: true });
      }
      if (url === '/api/admin/bars/11' && init?.method === 'PATCH') {
        const body = JSON.parse((init.body as string) ?? '{}') as { name?: string };
        return jsonResponse(200, adminBar({ id: 11, name: body.name }));
      }
      if (url === '/api/admin/bars' && init?.method === undefined) {
        return jsonResponse(200, { bars });
      }
      if (url === '/api/admin/users') {
        return jsonResponse(200, { users: [] });
      }
      if (url === '/api/visits/pending') {
        return jsonResponse(200, { visits: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/admin');

    expect(listedBarNames()).toEqual(['Bergbräustube', 'Zeta Bar']);

    const editButton = Array.from(container.querySelectorAll('.admin-bar-row'))[1]?.querySelector(
      '.admin-bar-row__actions button',
    ) as HTMLButtonElement;
    expect(editButton.textContent).toBe('Edit');
    await click(editButton);

    setInputValue(
      container.querySelector('#admin-edit-name-11') as HTMLInputElement,
      'Änderungsbar',
    );
    await click(
      Array.from(container.querySelectorAll('.admin-bar-row__edit-form button')).find(
        (button) => button.textContent === 'Save',
      ) as HTMLButtonElement,
    );

    expect(listedBarNames()).toEqual(['Änderungsbar', 'Bergbräustube']);
  });
});

function adminUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    username: 'walker',
    isAdmin: false,
    isAnonymous: false,
    mustChangePassword: false,
    excludedFromRankings: false,
    createdAt: 1_700_000_000,
    lastSeenAt: null,
    areaRevealedCells: 0,
    areaPercent: 0,
    barsMastered: 0,
    badgeCount: 0,
    ...overrides,
  };
}

// SPEC.md Section 7.8/9.3: the ranking exclusion, on the screen. The flag
// decides who can win a badge, so an admin has to be able to see which
// accounts carry it as well as set it — an invisible switch that changes who
// wins is worse than no switch.
describe('admin ranking exclusion', () => {
  function stubAdminScreen(
    users: Record<string, unknown>[],
    onPatch?: (id: string, body: unknown) => Response,
  ) {
    return stubFetch((url, init) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser({ isAdmin: true });
      }
      if (url === '/api/admin/bars' && init?.method === undefined) {
        return jsonResponse(200, { bars: [] });
      }
      if (url === '/api/admin/users' && init?.method === undefined) {
        return jsonResponse(200, { users });
      }
      if (url.startsWith('/api/admin/users/') && init?.method === 'PATCH') {
        const id = url.slice('/api/admin/users/'.length);
        return (onPatch ?? (() => jsonResponse(500, {})))(id, JSON.parse(init.body as string));
      }
      if (url === '/api/visits/pending') {
        return jsonResponse(200, { visits: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
  }

  function toggleFor(username: string): HTMLButtonElement {
    const row = Array.from(container.querySelectorAll('.admin-user-row')).find((element) =>
      element.querySelector('.admin-user-row__name')?.textContent?.startsWith(username),
    );
    if (!row) {
      throw new Error(`no row for ${username}`);
    }
    return row.querySelector('.admin-user-row__toggle') as HTMLButtonElement;
  }

  it('marks an excluded account in the list and leaves an included one unmarked', async () => {
    stubAdminScreen([
      adminUser({ id: 7, username: 'walker' }),
      adminUser({ id: 8, username: 'tester', excludedFromRankings: true }),
    ]);

    await renderApp('/admin');

    const tags = Array.from(container.querySelectorAll('.admin-user-row')).map((row) =>
      Array.from(row.querySelectorAll('.admin-bar-row__tag')).map((tag) => tag.textContent),
    );
    expect(tags).toEqual([[], ['Not ranked']]);
  });

  it('excludes an account and reflects the server response in the row', async () => {
    let user = adminUser({ id: 7, username: 'walker' });
    stubAdminScreen([user], (id, body) => {
      expect(id).toBe('7');
      expect(body).toEqual({ excludedFromRankings: true });
      user = { ...user, excludedFromRankings: true };
      return jsonResponse(200, user);
    });

    await renderApp('/admin');
    expect(toggleFor('walker').textContent).toBe('Exclude from rankings');

    await click(toggleFor('walker'));

    expect(toggleFor('walker').textContent).toBe('Include in rankings');
    expect(toggleFor('walker').getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('.admin-bar-row__tag--hidden')?.textContent).toBe('Not ranked');
  });

  it('puts an account back and asks the server for exactly that', async () => {
    let user = adminUser({ id: 7, username: 'walker', excludedFromRankings: true });
    stubAdminScreen([user], (_id, body) => {
      expect(body).toEqual({ excludedFromRankings: false });
      user = { ...user, excludedFromRankings: false };
      return jsonResponse(200, user);
    });

    await renderApp('/admin');
    await click(toggleFor('walker'));

    expect(toggleFor('walker').textContent).toBe('Exclude from rankings');
    expect(container.querySelector('.admin-bar-row__tag--hidden')).toBeNull();
  });

  it("surfaces the server's message when the change is refused, leaving the row alone", async () => {
    stubAdminScreen([adminUser({ id: 7, username: 'walker' })], () =>
      jsonResponse(403, { code: 'forbidden', message: 'Administrator access required.' }),
    );

    await renderApp('/admin');
    await click(toggleFor('walker'));

    expect(container.querySelector('.error-message')?.textContent).toBe(
      'Administrator access required.',
    );
    expect(toggleFor('walker').textContent).toBe('Exclude from rankings');
  });
});

// SPEC.md Sections 9.3/10.1: the teleport panel. Nothing here is a security
// control — every gate is server-side — so these tests are about the panel
// carrying the server's answer honestly, including the answer "this server
// does not have that route".
describe('admin teleport', () => {
  function stubAdminScreen(onTeleport: (body: unknown) => Response) {
    return stubFetch((url, init) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser({ isAdmin: true });
      }
      if (url === '/api/admin/bars' && init?.method === undefined) {
        return jsonResponse(200, { bars: [] });
      }
      if (url === '/api/admin/users' && init?.method === undefined) {
        return jsonResponse(200, { users: [] });
      }
      if (url === '/api/visits/pending') {
        return jsonResponse(200, { visits: [] });
      }
      if (url === '/api/city') {
        return jsonResponse(200, pickerCityMeta);
      }
      // Section 9.3: the two the teleport picker adds to the picker Suggest
      // a bar mounts. They are answered here rather than left to throw
      // because the picker now genuinely asks for them - the suggest side of
      // that opt-in is proved in its own describe above, where a request for
      // either is still an unexpected one.
      if (url === '/api/fog') {
        return fogResponse(new Uint8Array(2), {
          revealedCells: 0,
          playableCells: 9,
          districts: [],
        });
      }
      if (url === '/api/bars') {
        return jsonResponse(200, { bars: [communityBar({ id: 7, name: 'The Hidden Cellar' })] });
      }
      if (url === '/api/admin/teleport' && init?.method === 'POST') {
        return onTeleport(JSON.parse(init.body as string));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
  }

  function openPicker(): void {
    const open = Array.from(container.querySelectorAll('.admin__section button')).find(
      (button) => button.textContent === 'Choose a point on the map',
    ) as HTMLButtonElement;
    act(() => {
      open.click();
    });
  }

  function moveButton(): HTMLButtonElement {
    return Array.from(container.querySelectorAll('.admin__section button')).find(
      (button) => button.textContent === 'Move here',
    ) as HTMLButtonElement;
  }

  // The map is a MapLibre instance; it is not built until it is asked for,
  // so the admin screen does not pay for a WebGL context it usually does not
  // need. GET /api/city is the picker's own request, which is why the stub
  // above answers it and why no test that never opens the picker sees it.
  it('mounts no map picker until the admin asks for one', async () => {
    stubAdminScreen(() => jsonResponse(200, {}));

    await renderApp('/admin');

    expect(container.querySelector('.map-picker')).toBeNull();

    openPicker();

    expect(container.querySelector('.map-picker')).not.toBeNull();
  });

  it('sends the picked point and reports what the server did', async () => {
    let sent: unknown = null;
    stubAdminScreen((body) => {
      sent = body;
      return jsonResponse(200, {
        newCells: 12,
        newBars: [communityBar()],
        visitUpdates: [],
        tooFastToReveal: false,
        rejected: { accuracy: 0, future: 0, stale: 0, outsideCity: 0, tooFast: 0 },
      });
    });

    await renderApp('/admin');
    openPicker();

    expect(moveButton().disabled).toBe(true);

    act(() => {
      mapInstances[mapInstances.length - 1].fire('click', {
        lngLat: { lat: 49.0135, lng: 8.4044 },
      });
    });

    expect(moveButton().disabled).toBe(false);
    await click(moveButton());

    expect(sent).toEqual({ lat: 49.0135, lon: 8.4044 });
    const status = Array.from(container.querySelectorAll('[role="status"]')).map(
      (element) => element.textContent,
    );
    expect(status.join(' ')).toContain('12 new cells revealed, 1 bars discovered');
  });

  // A 404 here is the environment variable being unset (app.ts never
  // registers the route), and Fastify's own not-found body carries no `code`
  // and a message naming the route. The panel answers in words instead.
  it('says the feature is off when the route does not exist, without showing the raw 404', async () => {
    stubAdminScreen(() =>
      jsonResponse(404, {
        message: 'Route POST:/api/admin/teleport not found',
        error: 'Not Found',
        statusCode: 404,
      }),
    );

    await renderApp('/admin');
    openPicker();
    act(() => {
      mapInstances[mapInstances.length - 1].fire('click', {
        lngLat: { lat: 49.0135, lng: 8.4044 },
      });
    });
    await click(moveButton());

    const text = container.querySelector('.admin__section:last-of-type')?.textContent ?? '';
    expect(text).toContain('Teleport is not enabled on this server');
    expect(text).toContain('ADMIN_TELEPORT_ENABLED');
    expect(text).not.toContain('Route POST');
    expect(container.querySelector('.map-picker')).toBeNull();
  });

  // Gate 3 refused it. The server's own wording names the reason and the
  // fix, so the panel shows it rather than inventing its own sentence.
  it("shows the server's reason when the account is still in the rankings", async () => {
    stubAdminScreen(() =>
      jsonResponse(422, {
        code: 'not_excluded_from_rankings',
        message:
          'Teleport is refused for an account that still counts in the rankings. ' +
          'Exclude this account from the leaderboard and badges first, in Admin → Users.',
      }),
    );

    await renderApp('/admin');
    openPicker();
    act(() => {
      mapInstances[mapInstances.length - 1].fire('click', {
        lngLat: { lat: 49.0135, lng: 8.4044 },
      });
    });
    await click(moveButton());

    expect(container.querySelector('.error-message')?.textContent).toContain(
      'still counts in the rankings',
    );
    // Still usable: this is a state the admin can fix and retry from.
    expect(container.querySelector('.map-picker')).not.toBeNull();
  });

  // SPEC.md Section 9.3, the owner's own words: "I still want to see the
  // fog, known area and known bars … how should I teleport close to a bar if
  // I don't see it on the map". The picker used to draw the ink style and
  // nothing else, so an admin was asked to aim at bars that were not there.
  //
  // WHAT THESE THREE CAN AND CANNOT SHOW. jsdom has no WebGL2 and lays
  // nothing out. The fog assertion is behavioural in the narrow sense that
  // the mask is really fetched and a real FogController really mounts — but
  // it mounts the Section 7.3 *fallback*, and its 2D context is null under
  // jsdom, so not one pixel of fog is drawn or could be checked here. The
  // marker assertions are behavioural for the fetch and for the elements
  // that appear; that the markers cannot swallow a tap is a stylesheet fact
  // and is asserted in stylesheet.test.ts, since nothing here applies
  // index.css or hit-tests anything.
  describe('the picker draws the fog and the discovered bars (SPEC.md Section 9.3)', () => {
    async function openPickerAndSettle() {
      openPicker();
      // GET /api/city + GET /api/fog land together, GET /api/bars beside
      // them, and the fog controller mounts a turn after its pair resolves.
      await flushLazyScreen();
      await flushLazyScreen();
      return mapInstances[mapInstances.length - 1].container;
    }

    it('fetches the mask and mounts the fog layer on the picker map', async () => {
      const fetchMock = stubAdminScreen(() => jsonResponse(200, {}));

      await renderApp('/admin');
      const mapContainer = await openPickerAndSettle();

      expect(fetchMock.mock.calls.map(([input]) => input)).toContain('/api/fog');
      // The Section 7.3 fallback, because jsdom has no WebGL2 - the same
      // path App.test.tsx asserts on the map screen, and the same reason.
      expect(mapContainer.querySelector('canvas.fog-canvas-fallback')).not.toBeNull();
    });

    it("draws the admin's discovered bars on it", async () => {
      const fetchMock = stubAdminScreen(() => jsonResponse(200, {}));

      await renderApp('/admin');
      const mapContainer = await openPickerAndSettle();

      expect(fetchMock.mock.calls.map(([input]) => input)).toContain('/api/bars');
      const markers = mapContainer.querySelectorAll('.bar-marker');
      expect(markers).toHaveLength(1);
      // The existing marker system with its existing marks, not a second
      // drawing of a bar: this one is a community bar and still carries
      // Section 11.3's dot.
      expect(mapContainer.querySelector('.bar-marker--community')).not.toBeNull();
      expect(mapContainer.querySelector('.bar-marker svg.cocktail-glass')).not.toBeNull();
    });

    // THE ONE THAT DECIDES WHETHER ANY OF THIS IS USABLE. A marker is 44px
    // of tap target sitting exactly on its bar, and the picker exists to
    // drop the pin exactly on a bar. Interactive markers would eat the tap
    // at precisely the spot the admin most needs, so in this picker they are
    // not controls at all.
    it('draws them as decoration, so they are neither tappable, focusable nor announced', async () => {
      stubAdminScreen(() => jsonResponse(200, {}));

      await renderApp('/admin');
      const mapContainer = await openPickerAndSettle();

      // Not a button, so there is nothing to tab to and nothing that
      // announces itself as a control. A `<button>` with a no-op handler
      // would fail here, and rightly: it would still take focus, still be
      // announced, and still swallow the tap.
      expect(mapContainer.querySelectorAll('button.bar-marker')).toHaveLength(0);
      const marker = mapContainer.querySelector('.bar-marker') as HTMLElement;
      expect(marker.tagName).toBe('SPAN');
      expect(marker.classList.contains('bar-marker--decorative')).toBe(true);
      expect(marker.hasAttribute('aria-label')).toBe(false);
      expect(marker.hasAttribute('aria-describedby')).toBe(false);
      // Hidden as one set rather than attribute by attribute, so a marker
      // added by a later fetch cannot arrive announced.
      expect(mapContainer.querySelector('.bar-markers')?.getAttribute('aria-hidden')).toBe('true');
    });

    // The tap still reaches the map, which is the whole reason the markers
    // gave up their interactivity.
    it('still places the pin where the map was tapped', async () => {
      stubAdminScreen(() => jsonResponse(200, {}));

      await renderApp('/admin');
      await openPickerAndSettle();

      act(() => {
        mapInstances[mapInstances.length - 1].fire('click', {
          lngLat: { lat: 49.0135, lng: 8.4044 },
        });
      });

      expect(container.querySelector('.map-picker__status')?.textContent).toContain(
        'Pin placed at 49.01350, 8.40440',
      );
      expect(moveButton().disabled).toBe(false);
    });
  });
});
