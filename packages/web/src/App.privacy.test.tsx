import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';

// SPEC.md Section 10.3/12 (Phase 8 task brief, step 2): the /privacy page,
// the "every network failure produces a message" audit, and the new empty
// states. A separate file from App.checkin.test.tsx / App.community.test.tsx
// / App.leaderboard.test.tsx / App.pwa.test.tsx rather than another describe
// block in any of them, following the same per-phase-step precedent - the
// map harness below (needed only for the "no bars discovered yet" empty
// state) is the same trimmed copy of App.pwa.test.tsx's own those files
// already use.

const { MockMap, addProtocolMock, removeProtocolMock } = vi.hoisted(() => {
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
  }
  return {
    MockMap,
    addProtocolMock: vi.fn(),
    removeProtocolMock: vi.fn(),
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

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeAll(async () => {
  await import('./screens/Map.js');
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe('/privacy', () => {
  it('renders while signed out, and states the trail claim and the daily reveal counters', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return jsonResponse(401, { code: 'unauthenticated', message: 'Authentication required.' });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/privacy');

    expect(container.querySelector('h1')?.textContent).toBe('Privacy');
    // Still on /privacy, not bounced to /login - it must be reachable
    // without a session.
    expect(container.querySelector('#login-username')).toBeNull();
    expect(container.textContent).toContain('never stored as a trail');
    expect(container.textContent).toContain('per-day reveal counters');
    expect(container.textContent).toContain('how much new area you uncovered');
  });

  // In the installed PWA there is no browser chrome, so a screen without the
  // burger menu is a dead end with no way back.
  it("renders the burger menu, the app's one way off this screen", async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/privacy');

    expect(container.querySelector('.burger-menu__button')).not.toBeNull();

    const menuButton = container.querySelector('.burger-menu__button') as HTMLButtonElement;
    act(() => {
      menuButton.click();
    });
    const mapLink = Array.from(container.querySelectorAll('.burger-menu__panel a')).find(
      (a) => a.getAttribute('href') === '/map',
    );
    expect(mapLink).not.toBeUndefined();
  });

  // This is the one screen the burger menu reaches a signed-out reader on, so
  // it is the one screen where "Log out" would be offered to someone with no
  // session to end.
  it('offers no "Log out" control in that menu while signed out', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return jsonResponse(401, { code: 'unauthenticated', message: 'Authentication required.' });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/privacy');

    const menuButton = container.querySelector('.burger-menu__button') as HTMLButtonElement;
    expect(menuButton).not.toBeNull();
    act(() => {
      menuButton.click();
    });
    expect(container.querySelector('.burger-menu__panel')).not.toBeNull();
    expect(
      Array.from(container.querySelectorAll('.burger-menu__panel button')).map(
        (button) => button.textContent,
      ),
    ).not.toContain('Log out');
  });

  it('offers the "Log out" control in that menu while signed in', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/privacy');

    const menuButton = container.querySelector('.burger-menu__button') as HTMLButtonElement;
    act(() => {
      menuButton.click();
    });
    expect(
      Array.from(container.querySelectorAll('.burger-menu__panel button')).map(
        (button) => button.textContent,
      ),
    ).toContain('Log out');
  });

  it('names Cloudflare and the browser push service rather than OpenStreetMap as the outside services that see traffic', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return jsonResponse(401, { code: 'unauthenticated', message: 'Authentication required.' });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/privacy');

    expect(container.textContent).toContain(
      'Tipsy Trails runs no third-party analytics, trackers or advertising',
    );
    expect(container.textContent).toContain('Cloudflare tunnels every request');
    expect(container.textContent).toContain("browser vendor's own push service");
    // Section 10.5: OSM is the source of the map data, not a service the
    // browser talks to - tiles are served from this app's own server.
    expect(container.textContent).toContain("served by this app's own server");
  });

  it('notes that routine server backups can outlive an account deletion', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return jsonResponse(401, { code: 'unauthenticated', message: 'Authentication required.' });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/privacy');

    expect(container.textContent).toContain('Routine server backups may still hold a copy');
  });

  it('links to the main site for its privacy policy and legal notice', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return jsonResponse(401, { code: 'unauthenticated', message: 'Authentication required.' });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/privacy');

    const links = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(links.some((href) => href?.startsWith('https://ahultsch.com/'))).toBe(true);
    expect(container.textContent).toContain('Privacy policy');
    expect(container.textContent).toContain('Legal notice');
  });

  it('is linked from the registration screen, where consent is given', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return jsonResponse(401, { code: 'unauthenticated', message: 'Authentication required.' });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/register');

    const registerLink = Array.from(container.querySelectorAll('a')).find(
      (a) => a.getAttribute('href') === '/privacy',
    );
    expect(registerLink).not.toBeUndefined();
  });

  it('is linked from the burger menu', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/settings');
    const menuButton = container.querySelector('.burger-menu__button') as HTMLButtonElement;
    act(() => {
      menuButton.click();
    });
    const menuLink = Array.from(container.querySelectorAll('.burger-menu__panel a')).find(
      (a) => a.getAttribute('href') === '/privacy',
    );
    expect(menuLink).not.toBeUndefined();
  });

  it('is linked from Settings, matching SPEC.md Section 8.3', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/settings');
    const settingsLink = Array.from(container.querySelectorAll('a')).find(
      (a) => a.getAttribute('href') === '/privacy',
    );
    expect(settingsLink).not.toBeUndefined();
  });
});

describe('network failures surface a message', () => {
  it('shows a message rather than an empty panel when the district overview fetch fails', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      throw new Error('network down');
    });

    await renderApp('/districts');
    await flush();

    expect(container.textContent).toContain(
      'Could not reach the server. Check your connection and try again.',
    );
    expect(container.querySelector('.district-list')).toBeNull();
  });
});

describe('empty states', () => {
  it('shows "No players yet." on an empty leaderboard rather than a blank panel', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url.startsWith('/api/leaderboard')) {
        return jsonResponse(200, {
          metric: 'area',
          period: 'all',
          page: 1,
          pageSize: 50,
          totalUsers: 0,
          totalPages: 1,
          entries: [],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/leaderboard');

    expect(container.textContent).toContain('No players yet.');
    expect(container.querySelector('.leaderboard__row')).toBeNull();
  });

  it("renders a new player's empty badge shelf with guidance instead of a blank shelf", async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url === '/api/profile/player-1') {
        return jsonResponse(200, {
          userId: 1,
          handle: 'player-1',
          displayName: 'alice',
          isAnonymous: false,
          avatarSeed: 'seed',
          areaPercent: 0,
          barsMastered: 0,
          badges: [],
          badgeProgress: {
            week: [],
            month: [],
            year: [],
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/profile/player-1');

    expect(container.querySelector('.badge-shelf__empty')?.textContent).toContain('No badges yet');
  });

  it('hints at exploring when the map has no discovered bars yet', async () => {
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
        return fogResponse(new Uint8Array([0b0000_0000]), {
          revealedCells: 0,
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

    await renderApp('/map');
    await flush();
    await flush();

    expect(container.textContent).toContain('No bars discovered yet');
  });
});
