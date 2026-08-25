import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '@tipsytrails/shared';
import { App } from './App.js';
import { ACTIVE_CITY_SLUG } from './api/city.js';

// SPEC.md Sections 8.1/8.2/8.3: the wordmark on every main screen, and the
// start screen it is most prominent on. A file of its own rather than another
// describe block in App.test.tsx, following the precedent App.privacy.test.tsx
// and App.a11y.test.tsx set for a block of work - and for one concrete reason
// beyond tidiness: the contrast assertions at the bottom read index.css as
// text, which belongs with the other stylesheet-derived checks rather than in
// among the render tests.

const here = import.meta.url;
const CSS_PATH = fileURLToPath(new URL('./index.css', here));
const SRC_DIR = fileURLToPath(new URL('.', here));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// MapLibre needs a real WebGL context, which jsdom does not provide - the same
// stand-in App.test.tsx uses, cut down to what the map screen touches while
// rendering its overlay rows.
const { MockMap, addProtocolMock, removeProtocolMock } = vi.hoisted(() => {
  class MockMap {
    remove = vi.fn();
    on = vi.fn();
    off = vi.fn();
    addLayer = vi.fn();
    removeLayer = vi.fn();
    getLayer = vi.fn();
    addSource = vi.fn();
    getSource = vi.fn();
    removeSource = vi.fn();
    loaded = vi.fn(() => true);
    setMaxBounds = vi.fn();
    project = vi.fn(() => ({ x: 0, y: 0 }));
    getBearing = vi.fn(() => 0);
    container = document.createElement('div');
    getContainer = () => this.container;
  }
  return { MockMap, addProtocolMock: vi.fn(), removeProtocolMock: vi.fn() };
});

vi.mock('maplibre-gl', () => ({
  default: { Map: MockMap, addProtocol: addProtocolMock, removeProtocol: removeProtocolMock },
}));

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

function signedInUser(overrides: Record<string, unknown> = {}) {
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

function bar(id: number, mastered: boolean) {
  return {
    id,
    districtId: null,
    name: `Bar ${id}`,
    address: null,
    lat: 49,
    lon: 8.4,
    source: 'osm',
    discoveredAt: 0,
    mastered,
  };
}

function squareAt(west: number, osmId: number) {
  return {
    type: 'Feature',
    properties: { osm_id: osmId, name: `Part ${osmId}` },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [west, 48.95],
          [west + 0.1, 48.95],
          [west + 0.1, 49.05],
          [west, 49.05],
          [west, 48.95],
        ],
      ],
    },
  };
}

// A city boundary the projector can actually work on, with squares for
// geometry so that a rendered `d` is countable and nothing about the real
// Karlsruhe fixture can make an assertion here pass or fail by accident.
//
// TWO features, so that "every feature of the collection is drawn" is a
// statement this fixture can falsify: a one-feature collection cannot tell a
// path built from the whole city apart from one built from the first shape it
// found. A single-feature fixture let exactly that mutation through on the
// first attempt at this test.
const SQUARE_CITY = {
  type: 'FeatureCollection',
  features: [squareAt(8.3, 1), squareAt(8.5, 2)],
};

// Two more squares, inside the city's bounding box because real districts are
// inside their city - which is what lets the backdrop project both with one
// projector fitted to the city alone.
const SQUARE_DISTRICTS = {
  type: 'FeatureCollection',
  features: [squareAt(8.35, 3), squareAt(8.45, 4)],
};

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

// The map route is behind React.lazy, which settles over an extra turn beyond
// the one renderApp waits out.
async function flushLazyMapScreen() {
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
  window.localStorage.clear();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function wordmarks(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.wordmark'));
}

function textOf(selector: string): string | null {
  return container.querySelector(selector)?.textContent?.trim() ?? null;
}

/**
 * The bounding box a rendered `d` occupies in its own viewBox, read back out
 * of the path. Every command geo/geojson-path.ts emits is an absolute M or L
 * with an explicit pair, so the vertices are the whole of the geometry and
 * there is nothing implicit to reconstruct.
 */
function projectedBox(d: string): { minX: number; maxX: number; minY: number; maxY: number } {
  const points = [...d.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map((match) => ({
    x: Number(match[1]),
    y: Number(match[2]),
  }));
  if (points.length === 0) {
    throw new Error(`no M/L vertices in "${d}"`);
  }
  return {
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
}

// The start screen every authenticated entry path lands on (Login, Register,
// ChangePassword and the route guards all redirect to /app).
describe('the start screen (SPEC.md Section 8.3)', () => {
  function stubStartScreen(
    options: {
      bars?: ReturnType<typeof bar>[];
      percent?: number;
      boundaryFails?: boolean;
      districtsFail?: boolean;
      statsFail?: boolean;
    } = {},
  ): FetchHandler {
    return (url) => {
      if (url.startsWith('/api/auth/me')) {
        return signedInUser();
      }
      if (url === `/static/${ACTIVE_CITY_SLUG}/city.geojson`) {
        if (options.boundaryFails) {
          throw new Error('network down');
        }
        return jsonResponse(200, SQUARE_CITY);
      }
      if (url === `/static/${ACTIVE_CITY_SLUG}/districts.geojson`) {
        if (options.districtsFail) {
          throw new Error('network down');
        }
        return jsonResponse(200, SQUARE_DISTRICTS);
      }
      if (url === '/api/progress') {
        if (options.statsFail) {
          throw new Error('network down');
        }
        return jsonResponse(200, {
          city: { revealedCells: 1, playableCells: 10, percent: options.percent ?? 18.4 },
          districts: [],
        });
      }
      if (url === '/api/bars') {
        if (options.statsFail) {
          throw new Error('network down');
        }
        return jsonResponse(200, { bars: options.bars ?? [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    };
  }

  it('leads with the wordmark as its own heading, says the line, and opens the map', async () => {
    stubFetch(stubStartScreen());
    await renderApp('/app');

    const headings = Array.from(container.querySelectorAll('h1'));
    expect(headings).toHaveLength(1);
    expect(headings[0].classList.contains('wordmark')).toBe(true);
    expect(headings[0].classList.contains('wordmark--hero')).toBe(true);
    expect(headings[0].textContent).toBe('Tipsy Trails');

    expect(textOf('.home__tagline')).toBe('Karlsruhe is waiting.');

    // The one action on this screen, and the only reason it is not a tab: it
    // exists to be walked through. A button that led anywhere else - back to
    // /app, to the city overview, to a route that does not exist - would still
    // look exactly like this in every other assertion here.
    const action = container.querySelector('.screen__actions a') as HTMLAnchorElement | null;
    expect(action?.getAttribute('href')).toBe('/map');
    expect(action?.textContent).toBe('Open the map');
  });

  // Section 5.7's `mastered` flag is per requesting user, and the percent is
  // this session's own progress - so the three numbers are three statements
  // about the signed-in player and about nobody else. A screen that showed a
  // constant, or another player's figures, would be indistinguishable from a
  // working one on any assertion that did not pin the actual values.
  it('counts this player’s own bars and this player’s own progress', async () => {
    stubFetch(
      stubStartScreen({
        bars: [bar(1, true), bar(2, false), bar(3, true), bar(4, false), bar(5, false)],
        percent: 18.4,
      }),
    );
    await renderApp('/app');

    const stats = Array.from(container.querySelectorAll('.home__stats-list li')).map(
      (item) => item.textContent,
    );
    expect(stats).toEqual(['5 bars discovered', '2 bars mastered', '18.4% of Karlsruhe explored']);
  });

  it('says "1 bar" rather than "1 bars"', async () => {
    stubFetch(stubStartScreen({ bars: [bar(1, true)], percent: 0.5 }));
    await renderApp('/app');

    const stats = Array.from(container.querySelectorAll('.home__stats-list li')).map(
      (item) => item.textContent,
    );
    expect(stats).toEqual(['1 bar discovered', '1 bar mastered', '0.5% of Karlsruhe explored']);
  });

  it('draws the real city outline behind the words, out of the flow and unannounced', async () => {
    stubFetch(stubStartScreen());
    await renderApp('/app');

    const backdrop = container.querySelector('.home-backdrop');
    expect(backdrop).not.toBeNull();
    // Decoration: it must not be announced as a map, and it must not be
    // reachable by keyboard or tap.
    expect(backdrop?.getAttribute('aria-hidden')).toBe('true');
    expect(backdrop?.getAttribute('role')).toBeNull();

    const cityPath = container.querySelector('.home-backdrop__city');
    expect(cityPath?.getAttribute('fill-rule')).toBe('evenodd');
    // Both squares' four corners plus their closing points - proof this is the
    // projected boundary of every feature of the collection and not an empty,
    // truncated or hard-coded `d`.
    expect((cityPath?.getAttribute('d') ?? '').match(/[ML]/g)).toHaveLength(10);
  });

  // Fault two of three in the report this screen was rebuilt from: a single
  // flat fill reads as an administrative silhouette, and the owner asked for a
  // fogged detail *of the map*. The district edges are what carry the
  // difference, and they are only drawable at all because the fill is now
  // opaque (screens/AppHome.tsx, and the contrast block at the foot of this
  // file). Without this test the layer can be deleted and every other
  // assertion here still passes.
  it('draws the district edges over the city fill, as a second layer', async () => {
    stubFetch(stubStartScreen());
    await renderApp('/app');

    const districts = container.querySelector('.home-backdrop__districts');
    expect(
      districts,
      'the backdrop is drawing the city fill alone again, which is the silhouette this ' +
        'layer exists to break up',
    ).not.toBeNull();
    // Both district squares, same proof as the city path above.
    expect((districts?.getAttribute('d') ?? '').match(/[ML]/g)).toHaveLength(10);

    // Over the fill, not under it: an edge painted first and then covered by
    // the city is an edge nobody sees, and in this document order it is the
    // one thing that cannot be checked by looking at the paths themselves.
    const layers = Array.from(container.querySelectorAll('.home-backdrop path')).map((path) =>
      path.getAttribute('class'),
    );
    expect(layers).toEqual(['home-backdrop__city', 'home-backdrop__districts']);
  });

  // Fault one of three, and the root cause of the rest: the drawing was fitted
  // to a SQUARE viewBox and then covered a 9:19.5 phone with
  // preserveAspectRatio="slice", which scales to cover - so the city came out
  // at 2.6x with more than half its width cropped away. A shapeless grey mass
  // bleeding off all four edges is what the owner was looking at.
  //
  // What is asserted is the geometry that cannot produce that, rather than the
  // numbers that happen to be in the file today: a box taller than it is wide,
  // so `slice` on a phone crops a little of one axis instead of magnifying a
  // square into a tall one, and a city sitting in the upper part of it, so the
  // action and the 0.875rem row of figures at the bottom of the screen have
  // paper under them rather than the busiest part of a map.
  it('frames the city in a tall box, in the half of it the words are not in', async () => {
    stubFetch(stubStartScreen());
    await renderApp('/app');

    const backdrop = container.querySelector('.home-backdrop');
    const [, , width, height] = (backdrop?.getAttribute('viewBox') ?? '')
      .split(/[\s,]+/)
      .map(Number);
    expect(
      height / width,
      'the backdrop viewBox is square or landscape again. Under ' +
        'preserveAspectRatio="slice" on a portrait phone that is a magnified fragment ' +
        'of the city rather than a crop of it - the defect this framing replaced.',
    ).toBeGreaterThanOrEqual(1.5);
    expect(backdrop?.getAttribute('preserveAspectRatio')).toBe('xMidYMid slice');

    const drawn = projectedBox(
      container.querySelector('.home-backdrop__city')?.getAttribute('d') ?? '',
    );

    expect(
      (drawn.minY + drawn.maxY) / 2 / height,
      'the city is centred in the whole box again. It is fitted into a band across the ' +
        'top of it on purpose: .screen__actions and .home__stats sit in the bottom ' +
        'half of this screen, and the smallest text in the application should not have ' +
        'the densest part of a map behind it.',
    ).toBeLessThanOrEqual(0.45);
    expect(drawn.maxY / height).toBeLessThanOrEqual(0.65);
  });

  // ONE PROJECTOR, FITTED TO THE CITY, AND THE DISTRICTS DRAWN THROUGH IT.
  // Two projectors is the mutation this is written against, and it is an easy
  // one to write: fitting each collection to the box on its own stretches the
  // districts to fill the frame, so the edges land nowhere near the fill they
  // are supposed to be inside. The fixture's districts occupy the middle of
  // the city's longitude span and the whole of its latitude span, so under one
  // projector they must come out strictly inside the city horizontally and
  // flush with it vertically - and under two, they fill the frame on both
  // axes.
  //
  // Fitting to the union of both collections is a third possibility and this
  // cannot see it: the shipped districts.geojson tiles Karlsruhe exactly, so
  // the two bounding boxes are the same to the last decimal and the union
  // changes nothing. It is still the city's box the code fits to, because that
  // is a property of the code rather than of this month's GeoJSON - the
  // districts arrive on a second, later response, and a frame that depended on
  // them would move the drawing after the first paint the day they stop
  // tiling it exactly.
  it('draws the district edges through the city’s own projector, not one of their own', async () => {
    stubFetch(stubStartScreen());
    await renderApp('/app');

    const city = projectedBox(
      container.querySelector('.home-backdrop__city')?.getAttribute('d') ?? '',
    );
    const districts = projectedBox(
      container.querySelector('.home-backdrop__districts')?.getAttribute('d') ?? '',
    );

    expect(districts.minX).toBeGreaterThan(city.minX);
    expect(districts.maxX).toBeLessThan(city.maxX);
    expect(districts.minY).toBeCloseTo(city.minY, 1);
    expect(districts.maxY).toBeCloseTo(city.maxY, 1);
  });

  // The district edges are a decoration on a decoration, and they fail on
  // their own network request. Losing them may not cost the backdrop - which
  // is why the two boundaries are two fetches and not one Promise.all
  // (screens/AppHome.tsx).
  it('keeps the city fill when the district edges never arrive', async () => {
    stubFetch(stubStartScreen({ districtsFail: true, bars: [bar(1, false)] }));
    await renderApp('/app');

    expect(container.querySelector('.home-backdrop__city')).not.toBeNull();
    expect(container.querySelector('.home-backdrop__districts')).toBeNull();

    // And the screen is otherwise untouched: no message, and the three figures
    // are not collateral of a decoration's failed fetch.
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('.error-message')).toBeNull();
    expect(Array.from(container.querySelectorAll('.home__stats-list li'))).toHaveLength(3);
  });

  // The brief's rule for this screen: degrade to something, never to nothing.
  // The backdrop is a network fetch of a public static file and it can fail;
  // when it does, what is left has to be a complete screen rather than a
  // damaged one.
  it('is a complete screen when the city outline never arrives', async () => {
    stubFetch(stubStartScreen({ boundaryFails: true, bars: [bar(1, false)] }));
    await renderApp('/app');

    expect(container.querySelector('.home-backdrop')).toBeNull();

    // Everything that makes this a screen is still here.
    expect(textOf('h1.wordmark')).toBe('Tipsy Trails');
    expect(textOf('.home__tagline')).toBe('Karlsruhe is waiting.');
    expect(container.querySelector('.screen__actions a')?.getAttribute('href')).toBe('/map');
    expect(Array.from(container.querySelectorAll('.home__stats-list li'))).toHaveLength(3);

    // And nothing tells the player about it. A failed decoration is not an
    // error a player can act on, and the entry screen is the worst place in
    // the application to put one.
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('.error-message')).toBeNull();
  });

  it('drops the three numbers entirely, rather than half of them, when they cannot be fetched', async () => {
    stubFetch(stubStartScreen({ statsFail: true }));
    await renderApp('/app');

    expect(container.querySelector('.home__stats-list')).toBeNull();
    // The row itself stays, so the action above it does not jump when the
    // numbers do arrive on a slower connection.
    expect(container.querySelector('.home__stats')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(textOf('h1.wordmark')).toBe('Tipsy Trails');
  });
});

// The owner's warning, in translation: do not simply add a big Tipsy Trails
// header everywhere. On the map it should be small and elegant; on the start
// screen, very prominent.
describe('the wordmark on every main screen (SPEC.md Section 8.1)', () => {
  it('is small on the map, never the start screen’s hero, and leads the top row', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return signedInUser();
      }
      if (url.startsWith('/tiles/')) {
        return jsonResponse(206, {});
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/map');
    await flushLazyMapScreen();

    const marks = wordmarks();
    expect(marks).toHaveLength(1);
    expect(marks[0].classList.contains('wordmark--chrome')).toBe(true);
    expect(marks[0].classList.contains('wordmark--hero')).toBe(false);
    // Chrome, not the subject: the map is about the map, and a screen reader
    // navigating by heading must not be told the name of the application.
    // An anchor since v1.38 - it leads to the start screen - but still never
    // a heading.
    expect(marks[0].tagName).toBe('A');
    expect(marks[0].closest('h1')).toBeNull();

    // A member of the overlay grid (Section 8.3), in the row that already
    // exists, and FIRST in it since v1.38. That order is the whole of the
    // fix: the row is `justify-content: space-between`, so the second child
    // takes the right-hand end - and while the wordmark was second, the mark
    // sat right on the map and left on every other screen. Swapping them puts
    // the mark where .wordmark--chrome puts it everywhere else and moves the
    // status icons to the opposite corner, which the owner accepted.
    const row = container.querySelector('.map-overlays__controls--top');
    expect(row?.contains(marks[0])).toBe(true);
    expect(
      Array.from(row?.children ?? []).indexOf(marks[0]),
      'the wordmark is not the first child of the map’s top row, so space-between is ' +
        'putting it at the right-hand end again - the one screen in the application ' +
        'where the signature does not sit where it sits on the other four',
    ).toBe(0);
    expect(row?.lastElementChild?.classList.contains('tracking-indicator')).toBe(true);
  });

  // The owner: "I would like that we can press the logo and get to the start
  // screen", and - in the same breath - "when we click the logo we should not
  // be logged out, just land at the same page". Everything below is those two
  // sentences: where the mark leads, and the two places it must not lead
  // anywhere at all.
  //
  // What none of this can see is the tap target. Section 8.2 wants 44 px
  // around a mark that is 0.75rem tall, and jsdom lays nothing out - the
  // declaration is scanned in stylesheet.test.ts and believed, and whether it
  // is comfortable on a phone still needs a phone.
  it('leads to the start screen from every screen it signs, and is an ordinary link', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return signedInUser();
      }
      if (url.startsWith('/static/')) {
        return jsonResponse(200, SQUARE_CITY);
      }
      if (url === '/api/progress') {
        return jsonResponse(200, {
          city: { revealedCells: 1, playableCells: 10, percent: 1 },
          districts: [],
        });
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

    for (const path of ['/city', '/leaderboard']) {
      act(() => {
        root.unmount();
      });
      root = createRoot(container);
      await renderApp(path);

      const mark = wordmarks()[0] as HTMLAnchorElement;
      expect(mark.tagName).toBe('A');
      expect(mark.getAttribute('href')).toBe('/app');
      // The accessible name is the ordinary name of the application and
      // carries no explanatory suffix: a wordmark that leads home needs no
      // instructions read out with it. What separates it from the inert mark
      // for a screen reader is the role, not the name - "Tipsy Trails, link"
      // against "Tipsy Trails".
      expect(mark.textContent).toBe('Tipsy Trails');
      expect(mark.getAttribute('aria-label')).toBeNull();
      // It leads to the start screen and to nothing that could end a session:
      // no target, no download, no logout.
      expect(mark.getAttribute('target')).toBeNull();
    }
  });

  // The half of the owner's request that is easy to lose, and the expensive
  // one to get wrong. `/app` is behind RequireAuth, which sends a reader with
  // no session to /login - so a linked wordmark on the signed-out landing
  // screen would deliver exactly the "logged out" outcome he ruled out, by
  // way of the tap he asked for.
  it('is inert on the signed-out landing screen, where a link would bounce to /login', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return jsonResponse(401, { code: 'unauthenticated', message: 'Authentication required.' });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/');

    const mark = wordmarks()[0];
    expect(mark.tagName).toBe('H1');
    expect(container.querySelector('.wordmark a')).toBeNull();
    expect(container.querySelector('a.wordmark')).toBeNull();
    // Nothing in the mark leads anywhere; the two ways in are the buttons
    // below it, and they are unchanged.
    expect(
      Array.from(container.querySelectorAll('a')).map((link) => link.getAttribute('href')),
    ).toEqual(['/login', '/register']);
  });

  // A control that visibly does nothing is worse than plain text, and
  // navigating to the route you are standing on is visibly nothing.
  it('is inert on the start screen it leads to', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return signedInUser();
      }
      if (url.startsWith('/static/')) {
        return jsonResponse(200, SQUARE_CITY);
      }
      if (url === '/api/progress') {
        return jsonResponse(200, {
          city: { revealedCells: 1, playableCells: 10, percent: 1 },
          districts: [],
        });
      }
      if (url === '/api/bars') {
        return jsonResponse(200, { bars: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    await renderApp('/app');

    const mark = wordmarks()[0];
    expect(mark.tagName).toBe('H1');
    expect(container.querySelector('a.wordmark')).toBeNull();
    expect(container.querySelector('.wordmark a')).toBeNull();
  });

  it.each([
    ['/city', 'Karlsruhe'],
    ['/leaderboard', 'Ranks'],
  ])('signs %s without taking its heading', async (path, heading) => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return signedInUser();
      }
      if (url.startsWith('/static/')) {
        return jsonResponse(200, SQUARE_CITY);
      }
      if (url === '/api/progress') {
        return jsonResponse(200, {
          city: { revealedCells: 1, playableCells: 10, percent: 1 },
          districts: [],
        });
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

    await renderApp(path);

    const marks = wordmarks();
    expect(marks).toHaveLength(1);
    expect(marks[0].classList.contains('wordmark--chrome')).toBe(true);
    // An anchor, not a heading: it leads to the start screen (below) and it
    // still must not retitle the page it is signing.
    expect(marks[0].tagName).toBe('A');

    // Exactly one <h1>, and it is the screen's own subject rather than the
    // application's name. This is the assertion that stops the wordmark being
    // promoted to a heading "for consistency" and quietly retitling every page
    // in the app.
    const headings = Array.from(container.querySelectorAll('h1'));
    expect(headings).toHaveLength(1);
    expect(headings[0].textContent).toBe(heading);
    expect(headings[0].classList.contains('wordmark')).toBe(false);
  });

  it('is the heading on the landing screen, where it is what the screen is about', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return jsonResponse(401, { code: 'unauthenticated', message: 'Authentication required.' });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/');

    const headings = Array.from(container.querySelectorAll('h1'));
    expect(headings).toHaveLength(1);
    expect(headings[0].classList.contains('wordmark--hero')).toBe(true);
    expect(headings[0].textContent).toBe('Tipsy Trails');
  });

  // The drift this component exists to stop, checked at its source. Two
  // screens carried a bare <h1>Tipsy Trails</h1> before it existed, and two
  // screens spelling the mark themselves is how "immer dieselbe Typografie"
  // stops being true - silently, one screen at a time, in a way no render test
  // that only looks at the screens it happens to know about would catch.
  //
  // Matched as an element's entire content (`>Tipsy Trails<`) rather than as a
  // substring, so the several places that legitimately name the application
  // inside a sentence - the privacy notice, the check-in guidance, the map's
  // tracking explanation - are untouched by this rule.
  it('is spelt in exactly one place in the source', () => {
    const offenders: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory)) {
        const path = `${directory}/${entry}`;
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) {
          continue;
        }
        if (readFileSync(path, 'utf-8').includes('>Tipsy Trails<')) {
          offenders.push(path.slice(SRC_DIR.length));
        }
      }
    };
    walk(SRC_DIR);

    expect(
      offenders,
      'the wordmark is one component used at two prominences (components/Wordmark.tsx). ' +
        'A screen that writes the name out as its own element gets its own typography ' +
        'the moment either side changes, which is exactly the drift the owner asked for ' +
        'this block to remove.',
    ).toEqual([]);
  });
});

// The same relative-luminance arithmetic App.a11y.test.tsx uses, kept local
// there and local here for the same reason: nothing outside the test suite
// needs it, and the app's colours live only as CSS.
function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const [lighter, darker] =
    relativeLuminance(a) > relativeLuminance(b)
      ? [relativeLuminance(a), relativeLuminance(b)]
      : [relativeLuminance(b), relativeLuminance(a)];
  return (lighter + 0.05) / (darker + 0.05);
}

function blend(
  foreground: [number, number, number],
  alpha: number,
  background: [number, number, number],
): [number, number, number] {
  return [0, 1, 2].map((index) =>
    Math.round(foreground[index] * alpha + background[index] * (1 - alpha)),
  ) as [number, number, number];
}

function cssRuleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.#]/g, (character) => `\\${character}`);
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) {
    throw new Error(`No CSS rule found for ${selector}`);
  }
  return match[1];
}

function cssToken(css: string, name: string): [number, number, number] {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match) {
    throw new Error(`--${name} not found in index.css`);
  }
  return hexToRgb(match[1]);
}

/** The opaque `#rrggbb` a rule paints one property with. */
function hexOf(body: string, property: string): [number, number, number] {
  // The property name is anchored on its left so that `stroke` cannot be
  // answered by `stroke-width`, and on its right by the colon.
  const match = body.match(new RegExp(`(?:^|[;\\s])${property}:\\s*(#[0-9a-fA-F]{6})\\b`));
  if (!match) {
    throw new Error(`no opaque hex ${property} found in "${body.trim()}"`);
  }
  return hexToRgb(match[1]);
}

/**
 * The ratio at which `tone` is `ink` composited over `paper`, or null if it is
 * not a point on that line at all. Solved per channel from the composite
 * itself - tone = ink*a + paper*(1-a) - and the three answers have to agree,
 * which is what makes "some grey that happens to look right" fail while every
 * genuine blend of the two palette tokens passes. The tolerance is the largest
 * disagreement 8-bit rounding can produce: half a level over the narrowest of
 * the three channel gaps.
 */
function inkRatioOf(
  tone: [number, number, number],
  ink: [number, number, number],
  paper: [number, number, number],
): number | null {
  const ratios = [0, 1, 2].map(
    (index) => (paper[index] - tone[index]) / (paper[index] - ink[index]),
  );
  const tolerance = 0.5 / Math.min(...[0, 1, 2].map((index) => paper[index] - ink[index]));
  if (Math.max(...ratios) - Math.min(...ratios) > 2 * tolerance) {
    return null;
  }
  return (ratios[0] + ratios[1] + ratios[2]) / 3;
}

/** The single `rgba(r, g, b, a)` a rule paints with. */
function rgbaOf(body: string, property: string): { rgb: [number, number, number]; alpha: number } {
  const match = body.match(
    new RegExp(`${property}:\\s*rgba\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)\\)`),
  );
  if (!match) {
    throw new Error(`no rgba ${property} found in "${body.trim()}"`);
  }
  return {
    rgb: [Number(match[1]), Number(match[2]), Number(match[3])],
    alpha: Number(match[4]),
  };
}

// SPEC.md Section 8.1: "Body text and interactive labels meet 4.5:1 against
// their background." The wordmark and the start screen put text over two
// grounds this application did not previously have - the fogged city backdrop,
// and the map itself - so both are measured here, from the declarations
// themselves rather than from numbers copied into this file. Fogging the
// backdrop less, or thinning the plate on the map, then fails the suite rather
// than the eye.
describe('text over the new grounds clears 4.5:1 (SPEC.md Section 8.1)', () => {
  const css = readFileSync(CSS_PATH, 'utf-8');
  const paper = cssToken(css, 'color-paper');
  const ink = cssToken(css, 'color-ink');
  const BODY_TEXT_MIN = 4.5;

  // THE BACKDROP'S PAINT MODEL, AND WHY THIS BLOCK CHANGED SHAPE. It used to
  // be one translucent fill, and it had to be: translucent paint compounds
  // where it overlaps, so a second layer would have produced a darker grey
  // than anyone had computed, and the only defensible drawing was one path
  // painted once. It is now the same colour pre-composited and painted opaque
  // - not one pixel of the screen changed value - and opaque paint does not
  // compound, which is the entire reason the district edges can exist.
  //
  // So the three checks are the three halves of that bargain: the tones are
  // still ink over paper and nothing else (Section 8.1), they are still
  // opaque, and the darkest of them still clears the floor. Reading the ratio
  // back out of the composite rather than out of an `rgba()` is strictly
  // stronger than the version this replaced - a hand-picked grey that is not
  // on the ink/paper line now fails, where before any alpha at all was
  // accepted and only the outcome was measured.
  const backdropTones = (): { name: string; rgb: [number, number, number] }[] => [
    {
      name: '.home-backdrop__city fill',
      rgb: hexOf(cssRuleBody(css, '.home-backdrop__city'), 'fill'),
    },
    {
      name: '.home-backdrop__districts stroke',
      rgb: hexOf(cssRuleBody(css, '.home-backdrop__districts'), 'stroke'),
    },
  ];

  it('paints every tone of the backdrop as the ink composited over the paper', () => {
    for (const tone of backdropTones()) {
      const ratio = inkRatioOf(tone.rgb, ink, paper);
      expect(
        ratio,
        `${tone.name} is not --color-ink over --color-paper at any single ratio. Section ` +
          '8.1 gives this screen the ink and the paper and nothing else; a grey mixed by ' +
          'eye is a third colour in a two-colour palette.',
      ).not.toBeNull();
      expect(ratio).toBeGreaterThan(0);
      expect(ratio).toBeLessThan(1);
    }
  });

  it('paints them opaque, which is what lets the backdrop have layers at all', () => {
    for (const selector of ['.home-backdrop__city', '.home-backdrop__districts']) {
      const body = cssRuleBody(css, selector);
      expect(
        /rgba|\bopacity\s*:|#[0-9a-fA-F]{8}\b/.test(body),
        `${selector} paints translucently again. Translucent paint compounds where it ` +
          'overlaps - the city fill under a district edge, two districts sharing a ' +
          'border - so the darkest pixel of this screen would be an accident rather ' +
          'than a decision, and the floor measured below would not be the real one.',
      ).toBe(false);
    }
  });

  it('clears the floor against the darkest of them, which is the district edges', () => {
    const tones = backdropTones();
    const darkest = tones.reduce((worst, tone) =>
      relativeLuminance(tone.rgb) < relativeLuminance(worst.rgb) ? tone : worst,
    );
    expect(darkest.name).toBe('.home-backdrop__districts stroke');

    // Opaque paint, so this is the whole story: every pixel of the backdrop is
    // one of these two declared colours, and the edge mask on .home-backdrop
    // can only move a pixel from its colour towards the paper behind it, never
    // past it. There is no compounding case left to measure separately.
    expect(contrastRatio(ink, darkest.rgb)).toBeGreaterThanOrEqual(BODY_TEXT_MIN);
  });

  // Fault three of the report: the backdrop terminated as a crisp boundary,
  // which reads as a grey cutout laid on the page rather than as fog. The mask
  // is what dissolves it, and it has to reach full transparency - a gradient
  // that only fades to a lighter grey still ends in an edge, it just ends in a
  // fainter one. index.css says why this is a CSS mask and not an SVG <mask>.
  it('dissolves the backdrop at its edges instead of ending it', () => {
    const body = cssRuleBody(css, '.home-backdrop');

    const mask = body.match(/mask-image:\s*([^;]+)/);
    expect(mask, '.home-backdrop declares no mask-image, so the fog has a border').not.toBeNull();
    expect(mask?.[1]).toMatch(/gradient\(/);
    expect(
      /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)|\btransparent\b/.test(mask?.[1] ?? ''),
      'the mask never reaches zero, so the drawing still terminates somewhere - the ' +
        'edge is softer but it is still an edge',
    ).toBe(true);
  });

  // THE TWO PLATES THE MAP CARRIES TEXT ON, and since v1.40 they are measured
  // against the ground that decides them rather than against the one that is
  // merely easy to name. Section 8.3 (the wordmark's) and Section 10.5 (the
  // attribution's, where legibility is a licence obligation and not a
  // preference).
  const MAP_PLATES = ['.map-overlays .wordmark', '.map-attribution'];
  const plateOf = (selector: string) => rgbaOf(cssRuleBody(css, selector), 'background');

  // The map's own ink, read out of the style that paints the map rather than
  // copied into this file. map/ink-style.ts holds PAPER and INK as literals
  // kept in sync with these two tokens by hand - a MapLibre style is plain
  // JSON and cannot read a custom property - so reading it back here is also
  // the only check anywhere that the hand has kept up.
  const mapInk = (): [number, number, number] => {
    const source = readFileSync(fileURLToPath(new URL('./map/ink-style.ts', here)), 'utf-8');
    const match = source.match(/const INK = '(#[0-9a-fA-F]{6})'/);
    if (!match) {
      throw new Error('map/ink-style.ts no longer declares INK as a hex literal');
    }
    return hexToRgb(match[1]);
  };

  // THE BINDING GROUND, AND WHY IT IS THIS ONE. Every layer in
  // map/ink-style.ts paints that one INK over the paper at some opacity, so no
  // stack of them - a motorway over a primary over a minor street over a
  // building outline - is ever darker than the ink itself, and ink text on a
  // paper plate loses contrast monotonically as the ground darkens. The
  // darkest ground the map can produce is therefore solid ink, and a plate
  // that clears the floor there clears it over every pixel of the map.
  //
  // The fog case below is kept and is not this one: over the densest fog the
  // text clears the floor with no plate at all, which is exactly why thinning
  // these plates cannot be argued from it.
  it('holds both of the map’s plates to 4.5:1 over the darkest ground the ink style can produce', () => {
    expect(
      mapInk(),
      'map/ink-style.ts and --color-ink have drifted apart, so "the darkest ground the ' +
        'map can produce" is no longer the colour this measures against',
    ).toEqual(ink);

    for (const selector of MAP_PLATES) {
      const plate = plateOf(selector);
      expect(
        contrastRatio(ink, blend(plate.rgb, plate.alpha, mapInk())),
        `${selector} no longer keeps its text legible where the map is at its darkest. ` +
          'This is the case the plate exists for: on revealed ground the text falls on ' +
          'road lines and building edges, not on paper.',
      ).toBeGreaterThanOrEqual(BODY_TEXT_MIN);
    }
  });

  // The other half of the owner's instruction, and it needs a test of its own
  // because contrast alone is satisfied by making the plates heavier: "the
  // background of the logo and the OpenStreetMap contributors is too much.
  // Maybe more transparency? ... the logo needs to be visible but I think it
  // can be done with less." Both plates were rgba(244, 239, 230, 0.85) until
  // v1.40, which is a card; a value at or above that again is the defect
  // coming back.
  it('keeps both plates lighter than the card the owner objected to', () => {
    const alphas = MAP_PLATES.map((selector) => plateOf(selector).alpha);
    for (const [index, alpha] of alphas.entries()) {
      expect(alpha, `${MAP_PLATES[index]} is a card again`).toBeLessThanOrEqual(0.6);
    }
    expect(
      alphas[1],
      'the attribution is the quieter of the two - Section 10.5 asks for legible, which ' +
        'it keeps above, and the owner asked for quiet',
    ).toBeLessThanOrEqual(alphas[0]);
  });

  it('clears the floor on both plates over the densest fog the map produces too', () => {
    // The same worst case App.a11y.test.tsx measures the status icons
    // against: the fog layer's own colour at FOG_MAX_OPACITY over paper. No
    // patch of fog is ever denser, so no *fogged* ground is darker.
    // FOG_COLOR is not exported from map/fog/webgl-fog-layer.ts, so it is
    // mirrored here by hand exactly as it is there.
    const FOG_COLOR: [number, number, number] = [0.78 * 255, 0.76 * 255, 0.71 * 255];
    const foggedGround = blend(FOG_COLOR, CONFIG.FOG_MAX_OPACITY, paper);

    for (const selector of MAP_PLATES) {
      const plate = plateOf(selector);
      expect(
        contrastRatio(ink, blend(plate.rgb, plate.alpha, foggedGround)),
      ).toBeGreaterThanOrEqual(BODY_TEXT_MIN);
    }
  });
});
