import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import type { VisitSummary } from './api/types.js';
import type { ShellBridge, ShellEventSubscriber } from './shell/bridge.js';
import { getShellBridge, subscribeToShellEvents } from './shell/bridge.js';
import type { TrackerEvent } from './shell/events.js';
import {
  SHELL_MESSAGE_TYPES,
  postShellOpenConsent,
  postShellOpenExternal,
  postShellReady,
  postShellRequestNotifications,
  postShellSignedIn,
  postShellSignedOut,
  postShellVisitEnded,
  postShellVisitStarted,
} from './shell/messages.js';
import { attachSettingsUpdateHandler } from './shell/useShellSettingsUpdate.js';
import { useVisits } from './tracking/useVisits.js';

// ios/SPEC.md 8.1 and 8.2, and 12's row 3 of "The list for `main`": the shell
// module's detection, the page side of `requestSettingsUpdate`, the Shell ->
// page event subscription with its `isReplay` rule, and the eight Page -> shell
// messages.
//
// **The property that matters most here is the one a passing suite does not
// show: in a browser, none of this happens.** Every one of these calls sits on
// a path every player walks - mounting the app, signing in, signing out,
// checking in, cancelling - so each group below ends with a test that asserts
// nothing was posted and nothing was subscribed to outside the shell, rather
// than leaving that to the absence of a failure elsewhere.
//
// The one thing these tests exist to prove is small and easy to get wrong in a
// way nothing else would notice: the native Consent screen's checkbox has to
// reach `PATCH /api/settings` as `{ backgroundTracking }` and nothing else. A
// body that also carried `isAnonymous` would have a consent screen assert a
// value for a setting it never asked the player about (9.2), and the suite
// would stay green, because the request would still succeed. So the assertion
// below is on the body's *keys*, not on the field it contains.
//
// A separate file from App.privacy.test.tsx and the rest, following the same
// per-topic precedent those files set. Its fetch harness is the same trimmed
// copy of theirs, minus the map mock: no test here renders a map route.

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

function stubSignedInUser(overrides: Record<string, unknown> = {}) {
  return jsonResponse(200, {
    id: 1,
    username: 'alice',
    avatarSeed: 'seed',
    isAdmin: false,
    isAnonymous: false,
    mustChangePassword: false,
    backgroundTrackingConsentedAt: null,
    ...overrides,
  });
}

interface ShellDouble {
  bridge: ShellBridge;
  // What the shell's `WebViewController.dispatch` does: serialise the event and
  // evaluate `window.__tipsyTrails.dispatch("<json>")`.
  dispatch: (event: TrackerEvent) => void;
  // How many listeners the injected object is holding. There is no way to
  // remove one, which is the whole reason `shell/bridge.ts` fans out from a
  // single registration of its own, so this is what proves it registers once.
  listenerCount: () => number;
}

// The shell's injected object (8.1, 8.2) - a port of the script the shell
// actually injects, `userScriptSource` in
// `ios/TipsyTrails/Web/WebViewController.swift`, and not a convenient stand-in
// for it. Three of its properties are the ones this page could otherwise get
// wrong with nothing failing, so they are reproduced exactly:
//
//  - `dispatch` takes a **JSON string** and parses it; a payload that does not
//    parse is dropped and no listener hears of it.
//  - it caches the latest payload of the four replayable types only, and
//    `addListener` replays that cache to the registering listener alone,
//    synchronously, with `isReplay` true.
//  - `addListener` returns nothing. A listener cannot be removed.
function injectShell(): ShellDouble {
  const listeners: ((event: TrackerEvent, isReplay: boolean) => void)[] = [];
  const latest = new Map<string, TrackerEvent>();
  const replayable = ['tracking', 'position', 'queue', 'flush'];

  const bridge: ShellBridge = {
    platform: 'ios',
    shellVersion: '1.0.0',
    trackerVersion: '1.0.0',
    dispatch(json: string) {
      let event: TrackerEvent;
      try {
        event = JSON.parse(json) as TrackerEvent;
      } catch {
        return;
      }
      if (replayable.includes(event.type)) {
        latest.set(event.type, event);
      }
      for (const listener of [...listeners]) {
        listener(event, false);
      }
    },
    addListener(listener) {
      listeners.push(listener);
      for (const event of latest.values()) {
        listener(event, true);
      }
    },
  };
  window.__tipsyTrails = bridge;

  return {
    bridge,
    dispatch: (event) => {
      bridge.dispatch?.(JSON.stringify(event));
    },
    listenerCount: () => listeners.length,
  };
}

// The other half of the shell's web view configuration: the named script
// message handler the eight Page -> shell messages are posted to (8.2).
// Installed separately from the injected object so that a test can have one
// without the other, which is what the browser-path assertions need.
function installMessageHandler(): unknown[] {
  const posted: unknown[] = [];
  window.webkit = {
    messageHandlers: {
      tipsyTrails: {
        postMessage: (message: unknown) => {
          posted.push(message);
        },
      },
    },
  };
  return posted;
}

function postedTypes(posted: unknown[]): string[] {
  return posted.map((message) => (message as { type: string }).type);
}

// The subscriptions a test opened, torn down after it. A leaked subscriber
// would go on receiving events in the next test in this file, which is exactly
// the kind of cross-test coupling the counters of 8.3 would then be blamed for.
const openSubscriptions: (() => void)[] = [];

function subscribe(subscriber: ShellEventSubscriber): () => void {
  const unsubscribe = subscribeToShellEvents(subscriber);
  openSubscriptions.push(unsubscribe);
  return unsubscribe;
}

// A recording subscriber, which is the shape the assertions want: what arrived,
// and down which of the two callbacks. Nothing here merges the two lists - the
// point of every test below is which list a payload landed in.
function recorder() {
  const live: TrackerEvent[] = [];
  const replayed: TrackerEvent[] = [];
  return {
    live,
    replayed,
    subscriber: {
      onEvent: (event: TrackerEvent) => {
        live.push(event);
      },
      onReplay: (event: TrackerEvent) => {
        replayed.push(event);
      },
    } satisfies ShellEventSubscriber,
  };
}

const QUEUE_EVENT: TrackerEvent = { type: 'queue', queued: 3, behind: 1 };
const POSITION_EVENT: TrackerEvent = {
  type: 'position',
  lat: 49.01,
  lon: 8.4,
  accuracy: 12,
  speed: null,
  timestamp: 1_757_000_000_000,
  receivedAt: 1_757_000_000_100,
};
const SESSION_LOST_EVENT: TrackerEvent = { type: 'sessionLost', cause: 'cookie' };

const PENDING_VISIT: VisitSummary = {
  id: 7,
  barId: 42,
  barName: 'Anchor Bar',
  startedAt: 1_757_000_000,
  lastSampleAt: 1_757_000_060,
  onsiteSamples: 2,
  confirmedS: 60,
  remainingS: 1140,
  status: 'pending',
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

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// The requests that are not the one under test. Every test here renders a
// screen that fetches the current user and nothing else.
function settingsCalls(mock: ReturnType<typeof stubFetch>) {
  return mock.mock.calls.filter(([input]) => String(input) === '/api/settings');
}

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
  vi.restoreAllMocks();
  while (openSubscriptions.length > 0) {
    openSubscriptions.pop()?.();
  }
  delete window.__tipsyTrails;
  delete window.webkit;
});

describe('the shell bridge (ios/SPEC.md 8.1)', () => {
  it('detects the shell by the presence of the injected object, and by nothing else', () => {
    expect(getShellBridge()).toBeNull();
    const { bridge } = injectShell();
    expect(getShellBridge()).toBe(bridge);
  });

  it('attaches requestSettingsUpdate to the injected object once the app has mounted', async () => {
    const { bridge } = injectShell();
    expect(bridge.requestSettingsUpdate).toBeUndefined();

    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/privacy');

    expect(typeof window.__tipsyTrails?.requestSettingsUpdate).toBe('function');
  });

  // The mutation this guards: attaching the handler without asking whether
  // there is a shell. It cannot be done without the page creating
  // `window.__tipsyTrails` itself, which is the object detection is supposed to
  // detect - so the assertion is that the global is still absent after a full
  // mount, not merely that no request was made.
  it('creates nothing and attaches nothing in a browser', async () => {
    const fetchMock = stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/privacy');

    expect(window.__tipsyTrails).toBeUndefined();
    expect(settingsCalls(fetchMock)).toHaveLength(0);
  });

  // 8.2 does not say when the page attaches its handler, so this is the reading
  // taken: attached for as long as the app is mounted, last attach wins, and a
  // detach removes only the handler it installed. Without the identity check a
  // StrictMode double-mount's first cleanup would tear off the second mount's
  // live handler, and the app would stop answering the shell with no symptom at
  // all.
  it('lets a second attach replace the first, and a stale detach removes nothing', () => {
    const { bridge } = injectShell();

    const detachFirst = attachSettingsUpdateHandler();
    const first = bridge.requestSettingsUpdate;
    const detachSecond = attachSettingsUpdateHandler();
    const second = bridge.requestSettingsUpdate;

    expect(typeof first).toBe('function');
    expect(second).not.toBe(first);

    detachFirst();
    expect(bridge.requestSettingsUpdate).toBe(second);

    detachSecond();
    expect(bridge.requestSettingsUpdate).toBeUndefined();
  });

  it('attaches nothing when there is no shell, and its detach is a no-op', () => {
    const detach = attachSettingsUpdateHandler();
    expect(window.__tipsyTrails).toBeUndefined();
    expect(() => {
      detach();
    }).not.toThrow();
  });
});

describe('requestSettingsUpdate (ios/SPEC.md 8.2)', () => {
  it('sends exactly one PATCH /api/settings whose body is exactly { backgroundTracking: true }', async () => {
    injectShell();
    const fetchMock = stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url === '/api/settings') {
        return stubSignedInUser({ backgroundTrackingConsentedAt: 1_757_000_000 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/privacy');

    act(() => {
      window.__tipsyTrails?.requestSettingsUpdate?.(true);
    });
    await flush();

    const calls = settingsCalls(fetchMock);
    expect(calls).toHaveLength(1);
    const init = calls[0][1];
    expect(init?.method).toBe('PATCH');
    const body: unknown = JSON.parse(String(init?.body));
    // The keys, not just the field. An extra `isAnonymous` would be a consent
    // screen asserting an anonymity value nobody chose (9.2), and every
    // assertion that only looked for `backgroundTracking` would still pass.
    expect(Object.keys(body as Record<string, unknown>)).toEqual(['backgroundTracking']);
    expect(body).toEqual({ backgroundTracking: true });
  });

  it('sends exactly one PATCH /api/settings whose body is exactly { backgroundTracking: false } on withdrawal', async () => {
    injectShell();
    const fetchMock = stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url === '/api/settings') {
        return stubSignedInUser();
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/privacy');

    act(() => {
      window.__tipsyTrails?.requestSettingsUpdate?.(false);
    });
    await flush();

    const calls = settingsCalls(fetchMock);
    expect(calls).toHaveLength(1);
    const body: unknown = JSON.parse(String(calls[0][1]?.body));
    expect(Object.keys(body as Record<string, unknown>)).toEqual(['backgroundTracking']);
    expect(body).toEqual({ backgroundTracking: false });
  });

  // The shell calls this through `evaluateJavaScript` and reads no reply
  // (8.2), so an exception here is the shell's problem and not the page's, and
  // a rejection nobody catches is nobody's. Both are therefore contained, and
  // the failure is reported to the console instead - the web view's console is
  // attached to Safari's Web Inspector, which is where a developer can find
  // it. This is the whole of the failure path: a return value, a callback or a
  // new message would each be a change to the bridge protocol.
  it('does not throw out of the handler when the PATCH fails, and reports the failure', async () => {
    injectShell();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url === '/api/settings') {
        return jsonResponse(401, { code: 'unauthenticated', message: 'Authentication required.' });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/privacy');

    expect(() => {
      window.__tipsyTrails?.requestSettingsUpdate?.(true);
    }).not.toThrow();
    await flush();

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0][0])).toContain('PATCH /api/settings failed');
  });

  it('reports a network failure the same way rather than leaving an unhandled rejection', async () => {
    injectShell();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      throw new Error('network down');
    });

    await renderApp('/privacy');

    expect(() => {
      window.__tipsyTrails?.requestSettingsUpdate?.(true);
    }).not.toThrow();
    await flush();

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0][0])).toContain('Could not reach the server');
  });
});

describe('the Shell -> page subscription (ios/SPEC.md 8.2)', () => {
  it('replays the injected object’s cached payloads once each, synchronously, as replays', () => {
    const shell = injectShell();
    shell.dispatch(QUEUE_EVENT);
    shell.dispatch(POSITION_EVENT);

    const first = recorder();
    subscribe(first.subscriber);

    // Synchronously: the assertion is made with no `await` and no timer in
    // between, which is 8.2's word for it and is what lets a screen render its
    // first frame with the tracker's current state rather than an empty one.
    expect(first.replayed).toEqual([QUEUE_EVENT, POSITION_EVENT]);
    expect(first.live).toEqual([]);
  });

  // The rule the whole flag exists for (8.3): a replayed payload seeds, and
  // never advances a counter. This page cannot enforce what a subscriber does
  // with it - the counters are `useSampleTracking`'s - but it can guarantee
  // that the two never arrive down the same callback, which is what makes the
  // subscriber's own guard possible at all.
  it('never delivers a replayed payload as a live one', () => {
    const shell = injectShell();
    shell.dispatch(QUEUE_EVENT);

    const listener = recorder();
    subscribe(listener.subscriber);
    shell.dispatch(POSITION_EVENT);

    expect(listener.replayed).toEqual([QUEUE_EVENT]);
    expect(listener.live).toEqual([POSITION_EVENT]);
  });

  // A `sessionLost` is not one of the four types the injected object caches, so
  // it is only ever live - and a subscriber registering afterwards must not be
  // handed it as a replay by this module's own cache either.
  it('caches only the four replayable types', () => {
    const shell = injectShell();
    shell.dispatch(SESSION_LOST_EVENT);

    const listener = recorder();
    subscribe(listener.subscriber);

    expect(listener.replayed).toEqual([]);
    expect(listener.live).toEqual([]);
  });

  // The reason this module keeps a cache at all. The injected object replays
  // only to the listener registering with it, and this module registers once,
  // so without a cache of its own the second subscriber - the map screen
  // remounting while the tracker runs on - would see nothing until the next
  // event.
  it('replays to a subscriber that arrives after the first, from its own cache', () => {
    const shell = injectShell();

    const first = recorder();
    subscribe(first.subscriber);
    shell.dispatch(QUEUE_EVENT);

    const second = recorder();
    subscribe(second.subscriber);

    expect(second.replayed).toEqual([QUEUE_EVENT]);
    expect(second.live).toEqual([]);
    // And the late arrival did not make the early one hear it twice.
    expect(first.replayed).toEqual([]);
    expect(first.live).toEqual([QUEUE_EVENT]);
  });

  // `addListener` returns nothing and the injected script has no way to remove
  // a listener (it is the shell's script, shipped in the app binary). So a
  // subscription that registered with the shell per subscriber would leave a
  // dead listener behind on every unmount of the map screen.
  it('registers exactly one listener with the injected object, however many subscribers there are', () => {
    const shell = injectShell();

    const first = recorder();
    const unsubscribeFirst = subscribe(first.subscriber);
    subscribe(recorder().subscriber);
    subscribe(recorder().subscriber);

    expect(shell.listenerCount()).toBe(1);

    unsubscribeFirst();
    shell.dispatch(QUEUE_EVENT);
    expect(first.live).toEqual([]);
    expect(shell.listenerCount()).toBe(1);
  });

  it('stops delivering to a subscriber that has unsubscribed, and to no other', () => {
    const shell = injectShell();
    const staying = recorder();
    const leaving = recorder();
    subscribe(staying.subscriber);
    const unsubscribe = subscribe(leaving.subscriber);

    unsubscribe();
    shell.dispatch(QUEUE_EVENT);

    expect(leaving.live).toEqual([]);
    expect(staying.live).toEqual([QUEUE_EVENT]);
  });

  // A hook is allowed to tear itself down on the very event it was handed - a
  // `sessionLost` unmounting the screen that subscribed, say - and iterating
  // the live set while it is edited is how that becomes a failure that only
  // happens sometimes.
  it('lets a subscriber unsubscribe from inside its own callback', () => {
    const shell = injectShell();
    const later = recorder();
    let unsubscribe = () => {};
    const selfRemoving = {
      onEvent: () => {
        unsubscribe();
      },
      onReplay: () => {},
    };
    unsubscribe = subscribe(selfRemoving);
    subscribe(later.subscriber);

    expect(() => {
      shell.dispatch(QUEUE_EVENT);
    }).not.toThrow();
    expect(later.live).toEqual([QUEUE_EVENT]);
  });

  // The fan-out runs inside the shell's `evaluateJavaScript`, where an
  // exception is the shell's problem and the page has no way to learn it caused
  // one - and where it would deprive every later subscriber of an event with
  // nothing on screen saying so.
  it('does not let one subscriber’s exception stop the others', () => {
    const shell = injectShell();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const later = recorder();
    subscribe({
      onEvent: () => {
        throw new Error('subscriber failed');
      },
      onReplay: () => {},
    });
    subscribe(later.subscriber);

    expect(() => {
      shell.dispatch(QUEUE_EVENT);
    }).not.toThrow();
    expect(later.live).toEqual([QUEUE_EVENT]);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  // The page is served over the network and the shell is installed from
  // TestFlight, so a page can be newer than the shell it runs in. An injected
  // object without `addListener` is that case, and it must be a no-op rather
  // than a TypeError thrown out of whatever mounted the subscription.
  it('is a no-op against an older shell that injects no addListener', () => {
    window.__tipsyTrails = { platform: 'ios', shellVersion: '0.9.0', trackerVersion: '0.9.0' };
    const listener = recorder();

    let unsubscribe = () => {};
    expect(() => {
      unsubscribe = subscribe(listener.subscriber);
    }).not.toThrow();
    expect(() => {
      unsubscribe();
    }).not.toThrow();
    expect(listener.live).toEqual([]);
    expect(listener.replayed).toEqual([]);
  });

  it('subscribes to nothing and creates nothing in a browser', () => {
    const listener = recorder();
    const unsubscribe = subscribe(listener.subscriber);

    expect(window.__tipsyTrails).toBeUndefined();
    expect(listener.live).toEqual([]);
    expect(listener.replayed).toEqual([]);
    expect(() => {
      unsubscribe();
    }).not.toThrow();

    // And a shell that arrives afterwards does not find a page already
    // subscribed to it: the browser call registered nothing to be woken.
    const shell = injectShell();
    shell.dispatch(QUEUE_EVENT);
    expect(listener.live).toEqual([]);
  });
});

describe('the Page -> shell messages (ios/SPEC.md 8.2)', () => {
  // 8.2's table has seven rows and eight types: `visitStarted` and `visitEnded`
  // share a row there, and share a `case` in the shell's own message handler.
  // The count is asserted because "the seven message types" is written down in
  // 12's row 3 for `main`, and a reader counting rows will build seven.
  it('carries eight message types, not the seven 8.2’s table has rows for', () => {
    expect(SHELL_MESSAGE_TYPES).toEqual([
      'ready',
      'signedIn',
      'signedOut',
      'visitStarted',
      'visitEnded',
      'openExternal',
      'requestNotifications',
      'openConsent',
    ]);
  });

  it('posts the five that carry nothing beyond their type', () => {
    injectShell();
    const posted = installMessageHandler();

    postShellReady();
    postShellSignedIn();
    postShellSignedOut();
    postShellRequestNotifications();
    postShellOpenConsent();

    expect(posted).toEqual([
      { type: 'ready' },
      { type: 'signedIn' },
      { type: 'signedOut' },
      { type: 'requestNotifications' },
      { type: 'openConsent' },
    ]);
  });

  it('posts openExternal with the URL to open in Safari', () => {
    injectShell();
    const posted = installMessageHandler();

    postShellOpenExternal('https://www.openstreetmap.org/copyright');

    expect(posted).toEqual([
      { type: 'openExternal', url: 'https://www.openstreetmap.org/copyright' },
    ]);
  });

  // 8.2: the full VisitSummary flattened to JSON, every field, because the
  // dwelling profile needs them all to seed the tracker's pending set (7.6).
  // Asserted field by field rather than with `toEqual` on the source object, so
  // that a field dropped on the way through fails here.
  it('posts visitStarted with all nine fields of the VisitSummary', () => {
    injectShell();
    const posted = installMessageHandler();

    postShellVisitStarted(PENDING_VISIT);

    expect(posted).toEqual([{ type: 'visitStarted', visit: PENDING_VISIT }]);
    const visit = (posted[0] as { visit: Record<string, unknown> }).visit;
    expect(Object.keys(visit).sort()).toEqual(
      [
        'barId',
        'barName',
        'confirmedS',
        'id',
        'lastSampleAt',
        'onsiteSamples',
        'remainingS',
        'startedAt',
        'status',
      ].sort(),
    );
  });

  // 8.2 and 7.5: an id and nothing else. A VisitSummary echoed here would carry
  // a stale `status` - the pending one, since that is all either side still has
  // - rather than the true reason the visit ended, and the tracker would seed
  // its pending set from it. So the keys are asserted, not just the id.
  it('posts visitEnded with an id and nothing else', () => {
    injectShell();
    const posted = installMessageHandler();

    postShellVisitEnded(PENDING_VISIT.id);

    expect(posted).toEqual([{ type: 'visitEnded', id: 7 }]);
    expect(Object.keys(posted[0] as Record<string, unknown>)).toEqual(['type', 'id']);
  });

  // The channel can be gone while the document lives - the shell removes its
  // message handler in the web view controller's `deinit` - and a message the
  // shell will not read is not worth an exception on a screen.
  it('does not throw out of a post when the message handler rejects it', () => {
    injectShell();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    window.webkit = {
      messageHandlers: {
        tipsyTrails: {
          postMessage: () => {
            throw new Error('handler removed');
          },
        },
      },
    };

    expect(() => {
      postShellReady();
    }).not.toThrow();
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  // The single most important assertion in this file. Every one of the eight is
  // called with a message handler installed and listening, and no shell
  // detected - and none of them posts. Section 8's own rule is that every
  // change in it is behind one detection (8.1) and a no-op outside it, so a
  // `window.webkit` that belongs to some other WKWebView is not this shell and
  // is not posted to.
  it('posts nothing at all when there is no shell, even with a message handler listening', () => {
    const posted = installMessageHandler();

    postShellReady();
    postShellSignedIn();
    postShellSignedOut();
    postShellVisitStarted(PENDING_VISIT);
    postShellVisitEnded(PENDING_VISIT.id);
    postShellOpenExternal('https://example.com/');
    postShellRequestNotifications();
    postShellOpenConsent();

    expect(posted).toEqual([]);
    expect(window.__tipsyTrails).toBeUndefined();
  });
});

// React's controlled inputs track the last value they set, so assigning
// `input.value` directly is seen as a no-op change; going through the native
// prototype setter is what real typing does. The same helper App.test.tsx uses,
// for the same reason.
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  'value',
)?.set;

function setInputValue(input: HTMLInputElement, value: string) {
  nativeInputValueSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function submit(button: Element) {
  await act(async () => {
    (button as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// `useVisits` is where two of the eight messages have their moment - a check-in
// and a cancel - and neither needs the map screen the hook is normally read
// from. The harness renders the hook and nothing else, so what is asserted is
// the hook's own behaviour at the moment the request succeeds rather than a
// journey through a surface these messages are not a property of.
let visits: ReturnType<typeof useVisits> | null = null;

function VisitsHarness() {
  visits = useVisits([], [], 0, null);
  return null;
}

async function renderVisits() {
  await act(async () => {
    root.render(<VisitsHarness />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('the messages at the moments 8.2 fixes', () => {
  it('posts ready once the web app has mounted', async () => {
    injectShell();
    const posted = installMessageHandler();
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/privacy');

    expect(postedTypes(posted)).toEqual(['ready']);
  });

  it('posts signedIn after a login succeeds, and not after one that fails', async () => {
    injectShell();
    const posted = installMessageHandler();
    stubFetch((url, init) => {
      if (url.startsWith('/api/auth/me')) {
        return jsonResponse(401, { code: 'unauthenticated', message: 'Authentication required.' });
      }
      if (url === '/api/auth/login') {
        const body = JSON.parse(String(init?.body)) as { password: string };
        if (body.password === 'right') {
          return stubSignedInUser();
        }
        return jsonResponse(401, {
          code: 'invalid_credentials',
          message: 'Invalid username or password.',
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/login');
    act(() => {
      setInputValue(container.querySelector('#login-username') as HTMLInputElement, 'alice');
      setInputValue(container.querySelector('#login-password') as HTMLInputElement, 'wrong');
    });
    await submit(container.querySelector('button[type="submit"]') as HTMLButtonElement);

    expect(postedTypes(posted)).toEqual(['ready']);

    act(() => {
      setInputValue(container.querySelector('#login-password') as HTMLInputElement, 'right');
    });
    await submit(container.querySelector('button[type="submit"]') as HTMLButtonElement);

    expect(postedTypes(posted)).toEqual(['ready', 'signedIn']);
  });

  it('posts signedIn after a registration succeeds', async () => {
    injectShell();
    const posted = installMessageHandler();
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return jsonResponse(401, { code: 'unauthenticated', message: 'Authentication required.' });
      }
      if (url === '/api/auth/register') {
        return stubSignedInUser();
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/register');
    act(() => {
      setInputValue(container.querySelector('#register-username') as HTMLInputElement, 'alice');
      setInputValue(container.querySelector('#register-password') as HTMLInputElement, 'secret123');
      setInputValue(
        container.querySelector('#register-security-question') as HTMLInputElement,
        'First pet?',
      );
      setInputValue(
        container.querySelector('#register-security-answer') as HTMLInputElement,
        'Rex',
      );
      (container.querySelector('#register-age-confirmed') as HTMLInputElement).click();
    });
    await submit(container.querySelector('button[type="submit"]') as HTMLButtonElement);

    expect(postedTypes(posted)).toEqual(['ready', 'signedIn']);
  });

  // **Asserted by order, not by both having happened.** 8.2: the shell answers
  // `signedOut` by telling the tracker `sessionLost('cookie')` "so no sample is
  // posted against a cookie about to be deleted". A message posted after the
  // request leaves a window in which the tracker's next flush - it posts from a
  // pocket every few seconds - carries a cookie the server has just
  // invalidated. One recording sequence, two writers, and the assertion is on
  // their order.
  it('posts signedOut before the logout request, not merely alongside it', async () => {
    injectShell();
    const sequence: string[] = [];
    window.webkit = {
      messageHandlers: {
        tipsyTrails: {
          postMessage: (message: unknown) => {
            sequence.push(`message:${(message as { type: string }).type}`);
          },
        },
      },
    };
    stubFetch((url, init) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url === '/api/auth/logout' && init?.method === 'POST') {
        sequence.push('request:/api/auth/logout');
        return jsonResponse(200, { ok: true });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/privacy');
    act(() => {
      (container.querySelector('.bottom-nav button') as HTMLButtonElement).click();
    });
    await act(async () => {
      (container.querySelector('.more-sheet__logout') as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(sequence).toEqual(['message:ready', 'message:signedOut', 'request:/api/auth/logout']);
  });

  it('posts visitStarted when POST /api/visits succeeds, with the visit the server answered', async () => {
    injectShell();
    const posted = installMessageHandler();
    stubFetch((url, init) => {
      if (url === '/api/visits/pending') {
        return jsonResponse(200, { visits: [] });
      }
      if (url === '/api/visits' && init?.method === 'POST') {
        return jsonResponse(200, PENDING_VISIT);
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderVisits();
    await act(async () => {
      await visits?.checkIn(PENDING_VISIT.barId);
    });

    expect(posted).toEqual([{ type: 'visitStarted', visit: PENDING_VISIT }]);
  });

  it('posts visitEnded when the cancel succeeds, including on the 404 that means it is already gone', async () => {
    injectShell();
    const posted = installMessageHandler();
    stubFetch((url) => {
      if (url === '/api/visits/pending') {
        return jsonResponse(200, { visits: [] });
      }
      if (url === '/api/visits/7/cancel') {
        return jsonResponse(200, { ...PENDING_VISIT, status: 'cancelled' });
      }
      if (url === '/api/visits/8/cancel') {
        return jsonResponse(404, { code: 'not_found', message: 'No pending visit.' });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderVisits();
    await act(async () => {
      await visits?.cancelVisit(7);
    });
    await act(async () => {
      await visits?.cancelVisit(8);
    });

    expect(posted).toEqual([
      { type: 'visitEnded', id: 7 },
      { type: 'visitEnded', id: 8 },
    ]);
  });

  // The same journeys with no shell injected and the message handler listening.
  // These are the paths every player in a browser walks, and the assertion is
  // that they post nothing - not that the suite stayed green.
  it('posts nothing on any of those journeys in a browser', async () => {
    const posted = installMessageHandler();
    stubFetch((url, init) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url === '/api/auth/logout' && init?.method === 'POST') {
        return jsonResponse(200, { ok: true });
      }
      if (url === '/api/visits/pending') {
        return jsonResponse(200, { visits: [] });
      }
      if (url === '/api/visits' && init?.method === 'POST') {
        return jsonResponse(200, PENDING_VISIT);
      }
      if (url === '/api/visits/7/cancel') {
        return jsonResponse(200, { ...PENDING_VISIT, status: 'cancelled' });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/privacy');
    act(() => {
      (container.querySelector('.bottom-nav button') as HTMLButtonElement).click();
    });
    await act(async () => {
      (container.querySelector('.more-sheet__logout') as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await renderVisits();
    await act(async () => {
      await visits?.checkIn(PENDING_VISIT.barId);
    });
    await act(async () => {
      await visits?.cancelVisit(7);
    });

    expect(posted).toEqual([]);
    expect(window.__tipsyTrails).toBeUndefined();
  });
});
