import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import {
  clearLastKnownPosition,
  getLastKnownPosition,
  setLastKnownPosition,
} from './tracking/lastKnownPosition.js';

// Section 8.3, Block B: centring the map on the player - automatically on
// the first fix inside the city, on request via the "to my location"
// control, and the suggest screen's picker opening where they last were.
// A separate file from App.test.tsx (already ~1900 lines) rather than
// another describe block in it, following App.checkin.test.tsx's own
// precedent; the harness below is a trimmed copy of that file's, since
// there is no shared test-utils module to import it from.

const { MockMap, addProtocolMock, removeProtocolMock, mapInstances } = vi.hoisted(() => {
  // jumpTo/flyTo join the stand-in's methods because the two centring
  // behaviours differ only in which of them is called: jumpTo for the
  // automatic one (the map has just opened, an animation reads as a
  // glitch), flyTo for the button (the player asked for the move).
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

// The real Karlsruhe grid (SPEC.md Section 6.2), so "inside" and "outside"
// below mean what they mean in the deployed app: the grid runs from its
// SW origin to roughly 49.095 N, 8.560 E.
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

// Roughly the middle of the city - the same fixed fallback view the map
// screen and the picker open on when they have nothing better.
const CITY_CENTER: [number, number] = [8.4037, 49.0069];
const INSIDE_LAT = 49.0123;
const INSIDE_LON = 8.4321;
// Berlin: a real fix, and one no cell of this grid contains.
const OUTSIDE_LAT = 52.52;
const OUTSIDE_LON = 13.405;

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
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

type FetchHandler = (url: string, init: RequestInit | undefined) => Promise<Response> | Response;

function stubFetch(handler: FetchHandler) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return handler(url, init);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

// The routes the map screen touches beyond GET /api/city, answered so the
// tests below fail on what they are actually about rather than on an
// unexpected request.
function mapRoutes(url: string): Response | null {
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
  return null;
}

function stubMapFetch(city: () => Promise<Response> | Response) {
  return stubFetch((url) => {
    const response = mapRoutes(url);
    if (response) {
      return response;
    }
    if (url === '/api/city') {
      return city();
    }
    throw new Error(`Unexpected request: ${url}`);
  });
}

interface GeolocationStub {
  watchPosition: ReturnType<typeof vi.fn>;
  getCurrentPosition: ReturnType<typeof vi.fn>;
  triggerPosition: (position: { lat: number; lon: number }) => void;
  answerCurrentPosition: (position: { lat: number; lon: number }) => void;
  denyCurrentPosition: () => void;
}

function geolocationPosition(lat: number, lon: number): GeolocationPosition {
  return {
    coords: { latitude: lat, longitude: lon, accuracy: 10, speed: null },
    timestamp: Date.now(),
  } as GeolocationPosition;
}

function stubGeolocation(): GeolocationStub {
  let nextWatchId = 1;
  let successCallback: PositionCallback | null = null;
  const watchPosition = vi.fn((success: PositionCallback) => {
    successCallback = success;
    return nextWatchId++;
  });
  // The two calls are kept apart deliberately: the map screen watches, the
  // suggest screen's picker asks once. A test that answered both through
  // one callback could not tell the two behaviours apart, and "the picker
  // does not open a watch" is precisely what has to hold - a watch runs
  // continuously, and the hook that owns one also POSTs samples.
  let oneShotSuccess: PositionCallback | null = null;
  let oneShotError: PositionErrorCallback | null = null;
  const getCurrentPosition = vi.fn(
    (success: PositionCallback, error?: PositionErrorCallback | null) => {
      oneShotSuccess = success;
      oneShotError = error ?? null;
    },
  );
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: { watchPosition, getCurrentPosition, clearWatch: vi.fn() },
  });
  return {
    watchPosition,
    getCurrentPosition,
    triggerPosition({ lat, lon }) {
      successCallback?.(geolocationPosition(lat, lon));
    },
    answerCurrentPosition({ lat, lon }) {
      oneShotSuccess?.(geolocationPosition(lat, lon));
    },
    denyCurrentPosition() {
      oneShotError?.({ code: 1, message: 'User denied Geolocation' } as GeolocationPositionError);
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

async function renderAt(path: string) {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  // The map routes are behind React.lazy (Section 12's code-splitting
  // requirement), and GET /api/city settles a turn after that.
  await flush();
  await flush();
}

function lastMap() {
  return mapInstances[mapInstances.length - 1];
}

function locateButton() {
  return container.querySelector('button[aria-label="Go to my location"]') as HTMLButtonElement;
}

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
  // tracking/lastKnownPosition.ts is module-level state by design, so it
  // outlives a render the way localStorage does - cleared here for the
  // same cross-test-leakage reason App.test.tsx clears storage.
  clearLastKnownPosition();
  window.localStorage.clear();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  removeGeolocationStub();
  clearLastKnownPosition();
  window.localStorage.clear();
});

describe('centring the map on the player (SPEC.md Section 8.3)', () => {
  it('jumps to the first fix when it is inside the playable grid', async () => {
    const geo = stubGeolocation();
    stubMapFetch(() => jsonResponse(200, cityMeta));

    await renderAt('/map');
    const map = lastMap();
    expect(map.options.center).toEqual(CITY_CENTER);
    expect(map.jumpTo).not.toHaveBeenCalled();

    act(() => {
      geo.triggerPosition({ lat: INSIDE_LAT, lon: INSIDE_LON });
    });
    await flush();

    expect(map.jumpTo).toHaveBeenCalledTimes(1);
    expect(map.jumpTo).toHaveBeenCalledWith({ center: [INSIDE_LON, INSIDE_LAT] });
    // Not flyTo: the map has only just opened, and animating away from the
    // city centre reads as a glitch rather than as help.
    expect(map.flyTo).not.toHaveBeenCalled();
  });

  // The failure this whole condition exists to prevent: the extract covers
  // nothing outside the city, so MapLibre requests no tiles, reports no
  // error, and the screen looks exactly like a fully fogged city.
  it('leaves the map on the city when the fix is outside the playable grid', async () => {
    const geo = stubGeolocation();
    stubMapFetch(() => jsonResponse(200, cityMeta));

    await renderAt('/map');

    act(() => {
      geo.triggerPosition({ lat: OUTSIDE_LAT, lon: OUTSIDE_LON });
    });
    await flush();

    expect(lastMap().jumpTo).not.toHaveBeenCalled();
  });

  // The first fix decides, full stop: an out-of-grid one uses up the single
  // automatic centring for this mount. Someone opening the app on a train
  // approaching the city and panning around would otherwise have the map
  // yanked out from under them once they arrived. The "to my location"
  // control covers that case as an explicit action.
  it('never centres automatically after a first fix outside the grid, even once inside it', async () => {
    const geo = stubGeolocation();
    stubMapFetch(() => jsonResponse(200, cityMeta));

    await renderAt('/map');

    act(() => {
      geo.triggerPosition({ lat: OUTSIDE_LAT, lon: OUTSIDE_LON });
    });
    await flush();
    act(() => {
      geo.triggerPosition({ lat: INSIDE_LAT, lon: INSIDE_LON });
    });
    await flush();

    expect(lastMap().jumpTo).not.toHaveBeenCalled();
  });

  it('centres once only, however many further fixes arrive', async () => {
    const geo = stubGeolocation();
    stubMapFetch(() => jsonResponse(200, cityMeta));

    await renderAt('/map');

    act(() => {
      geo.triggerPosition({ lat: INSIDE_LAT, lon: INSIDE_LON });
    });
    await flush();
    act(() => {
      geo.triggerPosition({ lat: INSIDE_LAT + 0.002, lon: INSIDE_LON + 0.002 });
    });
    await flush();

    const map = lastMap();
    expect(map.jumpTo).toHaveBeenCalledTimes(1);
    expect(map.jumpTo).toHaveBeenCalledWith({ center: [INSIDE_LON, INSIDE_LAT] });
  });

  // Section 8.3's "tap to zoom in" from the district overview is an
  // explicit action and wins: the map stays where that link put it.
  it('ignores the player position when the URL carried a district centre', async () => {
    const geo = stubGeolocation();
    stubMapFetch(() => jsonResponse(200, cityMeta));

    await renderAt('/map?lat=49.0123&lon=8.4321');

    act(() => {
      geo.triggerPosition({ lat: INSIDE_LAT, lon: INSIDE_LON });
    });
    await flush();

    const map = lastMap();
    expect(map.options.center).toEqual([8.4321, 49.0123]);
    expect(map.jumpTo).not.toHaveBeenCalled();
  });

  // GET /api/city and the first fix are independent and race, so the
  // centring must work whichever lands first. The city-first order is what
  // every other test in this file exercises; this one holds the response
  // open until after the fix has already arrived.
  it('still centres when the city metadata arrives after the first fix', async () => {
    const geo = stubGeolocation();
    let resolveCity: ((response: Response) => void) | null = null;
    const cityResponse = new Promise<Response>((resolve) => {
      resolveCity = resolve;
    });
    stubMapFetch(() => cityResponse);

    await renderAt('/map');

    act(() => {
      geo.triggerPosition({ lat: INSIDE_LAT, lon: INSIDE_LON });
    });
    await flush();

    const map = lastMap();
    expect(map.jumpTo).not.toHaveBeenCalled();

    await act(async () => {
      resolveCity?.(jsonResponse(200, cityMeta));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(map.jumpTo).toHaveBeenCalledWith({ center: [INSIDE_LON, INSIDE_LAT] });
  });
});

describe('the "to my location" control (SPEC.md Section 8.3)', () => {
  it('is present but disabled while there is no known position', async () => {
    stubGeolocation();
    stubMapFetch(() => jsonResponse(200, cityMeta));

    await renderAt('/map');

    const button = locateButton();
    expect(button).not.toBeNull();
    expect(button.disabled).toBe(true);
  });

  it('flies to the last known position once one is available', async () => {
    const geo = stubGeolocation();
    stubMapFetch(() => jsonResponse(200, cityMeta));

    await renderAt('/map');

    act(() => {
      geo.triggerPosition({ lat: INSIDE_LAT, lon: INSIDE_LON });
    });
    await flush();

    const button = locateButton();
    expect(button.disabled).toBe(false);

    const map = lastMap();
    map.flyTo.mockClear();
    act(() => {
      button.click();
    });

    // flyTo, not jumpTo: unlike the automatic centring, this move is what
    // the player just asked for, so the animation is the point.
    expect(map.flyTo).toHaveBeenCalledTimes(1);
    expect(map.flyTo).toHaveBeenCalledWith({ center: [INSIDE_LON, INSIDE_LAT] });
  });

  // Unlike the automatic centring, an explicit request is honoured even
  // from outside the grid - the pan limit then stops the map at the city's
  // edge, which is as far as it can usefully go.
  it('honours a request from a position outside the grid', async () => {
    const geo = stubGeolocation();
    stubMapFetch(() => jsonResponse(200, cityMeta));

    await renderAt('/map');

    act(() => {
      geo.triggerPosition({ lat: OUTSIDE_LAT, lon: OUTSIDE_LON });
    });
    await flush();

    const map = lastMap();
    act(() => {
      locateButton().click();
    });

    expect(map.flyTo).toHaveBeenCalledWith({ center: [OUTSIDE_LON, OUTSIDE_LAT] });
    expect(map.jumpTo).not.toHaveBeenCalled();
  });
});

describe("the suggest screen's map picker (SPEC.md Section 11.3)", () => {
  // Everything the picker fetches: the auth guard, and the city metadata it
  // needs both for the pan limit and for judging whether a position is
  // inside the playable grid.
  function stubPickerFetch() {
    return stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url === '/api/city') {
        return jsonResponse(200, cityMeta);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
  }

  it('opens at the city centre when this session has no known position', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url === '/api/city') {
        return jsonResponse(200, cityMeta);
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderAt('/suggest');

    expect(lastMap().options.center).toEqual(CITY_CENTER);
  });

  it('opens at the last position the map screen accepted', async () => {
    const geo = stubGeolocation();
    stubFetch((url) => {
      const response = mapRoutes(url);
      if (response) {
        return response;
      }
      if (url === '/api/city') {
        return jsonResponse(200, cityMeta);
      }
      if (url === '/api/bars/suggest') {
        return jsonResponse(201, {});
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderAt('/map');
    act(() => {
      geo.triggerPosition({ lat: INSIDE_LAT, lon: INSIDE_LON });
    });
    await flush();

    const menuButton = container.querySelector('.burger-menu__button') as HTMLButtonElement;
    act(() => {
      menuButton.click();
    });
    const suggestLink = Array.from(container.querySelectorAll('.burger-menu__panel a')).find(
      (entry) => entry.textContent === 'Suggest a bar',
    ) as HTMLAnchorElement;
    await act(async () => {
      suggestLink.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();

    expect(container.querySelector('.map-picker')).not.toBeNull();
    expect(lastMap().options.center).toEqual([INSIDE_LON, INSIDE_LAT]);
  });

  // Section 10.2: the holder is in-memory and unkeyed, so signing out has
  // to empty it - the same reason auth/useLogout.ts clears the fog cache
  // rather than leaving one account's data behind for the next.
  it('forgets the position on sign-out', async () => {
    const geo = stubGeolocation();
    stubFetch((url, init) => {
      const response = mapRoutes(url);
      if (response) {
        return response;
      }
      if (url === '/api/city') {
        return jsonResponse(200, cityMeta);
      }
      if (url === '/api/auth/logout' && init?.method === 'POST') {
        return jsonResponse(200, { ok: true });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderAt('/map');
    act(() => {
      geo.triggerPosition({ lat: INSIDE_LAT, lon: INSIDE_LON });
    });
    await flush();

    expect(getLastKnownPosition()).not.toBeNull();

    const menuButton = container.querySelector('.burger-menu__button') as HTMLButtonElement;
    act(() => {
      menuButton.click();
    });
    const logoutButton = Array.from(container.querySelectorAll('.burger-menu__panel button')).find(
      (entry) => entry.textContent === 'Log out',
    ) as HTMLButtonElement;
    await act(async () => {
      logoutButton.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(getLastKnownPosition()).toBeNull();
  });

  // tracking/lastKnownPosition.ts is only ever written by the map screen, so
  // opening /suggest directly - from the menu on a fresh load, or after a
  // reload - finds it empty and the picker opened on the city centre rather
  // than where the player is standing, which is next to the bar they are
  // adding. The picker therefore asks for a fix itself in that case.
  describe('when this session has no stored position', () => {
    it('asks the browser once, and never opens a watch', async () => {
      const geo = stubGeolocation();
      stubPickerFetch();

      await renderAt('/suggest');

      expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1);
      // A watch would run continuously, and the hook that owns the app's
      // only other one (tracking/useSampleTracking.ts) POSTs samples as it
      // goes - neither may happen from this screen.
      expect(geo.watchPosition).not.toHaveBeenCalled();
    });

    it('centres on the answer when it is inside the playable grid', async () => {
      const geo = stubGeolocation();
      stubPickerFetch();

      await renderAt('/suggest');
      const map = lastMap();
      expect(map.options.center).toEqual(CITY_CENTER);

      act(() => {
        geo.answerCurrentPosition({ lat: INSIDE_LAT, lon: INSIDE_LON });
      });
      await flush();

      expect(map.jumpTo).toHaveBeenCalledTimes(1);
      expect(map.jumpTo).toHaveBeenCalledWith({ center: [INSIDE_LON, INSIDE_LAT] });
    });

    // The same guard the map screen makes: the extract covers nothing
    // outside the city, so centring there shows an empty map.
    it('stays on the city centre when the answer is outside the playable grid', async () => {
      const geo = stubGeolocation();
      stubPickerFetch();

      await renderAt('/suggest');

      act(() => {
        geo.answerCurrentPosition({ lat: OUTSIDE_LAT, lon: OUTSIDE_LON });
      });
      await flush();

      expect(lastMap().jumpTo).not.toHaveBeenCalled();
    });

    it('stays on the city centre when the request is denied', async () => {
      const geo = stubGeolocation();
      stubPickerFetch();

      await renderAt('/suggest');

      act(() => {
        geo.denyCurrentPosition();
      });
      await flush();

      const map = lastMap();
      expect(map.options.center).toEqual(CITY_CENTER);
      expect(map.jumpTo).not.toHaveBeenCalled();
      expect(locateButton().disabled).toBe(true);
    });

    it('stays on the city centre when the browser has no geolocation at all', async () => {
      removeGeolocationStub();
      stubPickerFetch();

      await renderAt('/suggest');

      expect(container.querySelector('.map-picker')).not.toBeNull();
      expect(lastMap().options.center).toEqual(CITY_CENTER);
      expect(lastMap().jumpTo).not.toHaveBeenCalled();
    });
  });

  // Instant, and no permission round-trip, so it wins over asking again.
  it('prefers the stored position and does not ask the browser at all', async () => {
    const geo = stubGeolocation();
    setLastKnownPosition({ lat: INSIDE_LAT, lon: INSIDE_LON, accuracy: 10 });
    stubPickerFetch();

    await renderAt('/suggest');

    const map = lastMap();
    expect(map.options.center).toEqual([INSIDE_LON, INSIDE_LAT]);
    expect(geo.getCurrentPosition).not.toHaveBeenCalled();
    // The map was built on that position - there is nothing to move.
    expect(map.jumpTo).not.toHaveBeenCalled();
  });

  // Centring on yourself is only half an answer while you cannot see where
  // "yourself" is, so the picker shows the same marker the map screen does
  // (map/position/own-position-marker.ts), mounted through the same hook.
  // The marker is appended to the map's own container, which is what these
  // tests query. That it does not swallow a tap is a stylesheet rule
  // (pointer-events: none) that jsdom never applies, so it is asserted in
  // stylesheet.test.ts instead; what is checked here is that the element on
  // screen is the one that rule targets.
  describe('the own-position marker', () => {
    it('shows nothing while this session has no position', async () => {
      stubGeolocation();
      stubPickerFetch();

      await renderAt('/suggest');

      expect(lastMap().container.querySelector('.own-position-marker')).toBeNull();
    });

    it('appears once a position is known', async () => {
      const geo = stubGeolocation();
      stubPickerFetch();

      await renderAt('/suggest');
      const map = lastMap();

      act(() => {
        geo.answerCurrentPosition({ lat: INSIDE_LAT, lon: INSIDE_LON });
      });
      await flush();

      expect(map.container.querySelector('.own-position-marker')).not.toBeNull();
      expect(map.project).toHaveBeenCalledWith([INSIDE_LON, INSIDE_LAT]);
    });

    it('appears straight away on the position the map screen last accepted', async () => {
      stubGeolocation();
      setLastKnownPosition({ lat: INSIDE_LAT, lon: INSIDE_LON, accuracy: 10 });
      stubPickerFetch();

      await renderAt('/suggest');

      expect(lastMap().container.querySelector('.own-position-marker')).not.toBeNull();
    });

    it('moves when the position changes', async () => {
      const geo = stubGeolocation();
      stubPickerFetch();

      await renderAt('/suggest');
      const map = lastMap();

      map.project.mockReturnValue({ x: 10, y: 20 });
      act(() => {
        geo.answerCurrentPosition({ lat: INSIDE_LAT, lon: INSIDE_LON });
      });
      await flush();

      const marker = map.container.querySelector('.own-position-marker') as HTMLElement;
      expect(marker.style.left).toBe('10px');
      expect(marker.style.top).toBe('20px');

      // A real browser answers a one-shot request once; firing it again is
      // simply how this test hands the picker a second position, since its
      // own fix is the only thing the marker follows.
      map.project.mockReturnValue({ x: 30, y: 40 });
      act(() => {
        geo.answerCurrentPosition({ lat: INSIDE_LAT + 0.002, lon: INSIDE_LON + 0.002 });
      });
      await flush();

      expect(map.project).toHaveBeenCalledWith([INSIDE_LON + 0.002, INSIDE_LAT + 0.002]);
      expect(marker.style.left).toBe('30px');
      expect(marker.style.top).toBe('40px');
    });
  });

  // The same control the map screen has, from the same component
  // (components/LocateButton.tsx) - hence the same accessible name, which is
  // what locateButton() finds it by here.
  it('offers a "go to my location" control, disabled until a position is known', async () => {
    const geo = stubGeolocation();
    stubPickerFetch();

    await renderAt('/suggest');
    expect(locateButton()).not.toBeNull();
    expect(locateButton().disabled).toBe(true);

    act(() => {
      geo.answerCurrentPosition({ lat: INSIDE_LAT, lon: INSIDE_LON });
    });
    await flush();

    const map = lastMap();
    expect(locateButton().disabled).toBe(false);

    map.flyTo.mockClear();
    act(() => {
      locateButton().click();
    });

    expect(map.flyTo).toHaveBeenCalledTimes(1);
    expect(map.flyTo).toHaveBeenCalledWith({ center: [INSIDE_LON, INSIDE_LAT] });
  });
});
