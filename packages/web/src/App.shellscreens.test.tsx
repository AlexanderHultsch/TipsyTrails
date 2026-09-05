import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CurrentUserProvider } from './auth/CurrentUserContext.js';
import { TrackingIndicator } from './components/TrackingIndicator.js';
import { HowMasteringWorks } from './screens/HowMasteringWorks.js';
import { Settings } from './screens/Settings.js';
import type { ShellBridge } from './shell/bridge.js';
import type { BlockedReason, TrackerEvent, TrackingEvent } from './shell/events.js';
import { toShellTrackingState } from './shell/useShellTracking.js';
import type { SampleTrackingState } from './tracking/useSampleTracking.js';

// The three screen changes of `ios/SPEC.md` 8.3 (the indicator's four states),
// 8.4 (the push offer) and 8.6 (the Settings row) — rows 5, 6 and 7 of that
// document's "list for `main`", and the second half of Step D's D3 and D4.
//
// **Every test here has a Safari twin**, and that pairing is the file's shape
// rather than a habit. Section 8's opening rule is that every change in it "is
// behind one detection and is a no-op outside it", and a no-op is a property to
// assert rather than one to infer from having written an `if`: the browser
// assertions below run the same component with no injected object and require
// the words, the button and the row that Safari had before this block to be
// exactly what it has after it.
//
// The components are rendered directly rather than through `App` and a route.
// The three changes are each one component's, none of them needs the map, and
// App.shell.test.tsx and App.shelltracking.test.tsx already carry the whole-app
// renders for the bridge itself. The injected shell double below is the same
// port of `userScriptSource` in `ios/TipsyTrails/Web/WebViewController.swift`
// those two files use.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

interface ShellDouble {
  dispatch: (event: TrackerEvent) => void;
}

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
    dispatch: (event) => {
      bridge.dispatch?.(JSON.stringify(event));
    },
  };
}

// The named script message handler the Page -> shell messages are posted to
// (8.2). Installed separately from the injected object, so a browser test can
// have one without the other — which is what makes "posts nothing in Safari" an
// assertion about the detection rather than about a missing handler.
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

function trackingEvent(overrides: {
  state?: 'idle' | 'tracking' | 'blocked';
  background?: boolean;
  reason?: BlockedReason;
  status?: 'notDetermined' | 'denied' | 'authorizedWhenInUse' | 'authorizedAlways';
}): TrackingEvent {
  return {
    type: 'tracking',
    state: overrides.state ?? 'tracking',
    background: overrides.background ?? false,
    ...(overrides.reason ? { reason: overrides.reason } : {}),
    authorization: {
      status: overrides.status ?? 'authorizedWhenInUse',
      accuracy: 'fullAccuracy',
    },
    lowPower: false,
  };
}

// A `SampleTrackingState` at values no assertion below depends on, except
// `trackingActive`, which every indicator test sets deliberately: it is the
// member the four shell states must *not* be read from.
function sampleState(overrides: Partial<SampleTrackingState> = {}): SampleTrackingState {
  return {
    gpsStatus: 'good',
    connectionStatus: 'online',
    trackingActive: false,
    queueDepth: 0,
    tooFastToReveal: false,
    postError: null,
    revealVersion: 0,
    discoveryVersion: 0,
    newBars: [],
    newBarsVersion: 0,
    visitUpdates: [],
    visitVersion: 0,
    lastPosition: null,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function stubUserFetch(backgroundTrackingConsentedAt: number | null) {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/auth/me')) {
      return jsonResponse(200, {
        id: 1,
        username: 'alice',
        avatarSeed: 'seed',
        isAdmin: false,
        isAnonymous: false,
        mustChangePassword: false,
        backgroundTrackingConsentedAt,
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

// jsdom implements no Push API, which is also what a `WKWebView` presents
// (`ios/SPEC.md` 8.4), so `usePushSubscription` reports `unsupported` by
// default here and the browser's offer is hidden. The browser tests that want
// to see that offer have to build the stack first — which is the honest way
// round: the shell's case needs no stub because the shell's case is the absence
// of one.
function stubPushSupport() {
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: async () => undefined, register: async () => undefined },
  });
  vi.stubGlobal('PushManager', class {});
  vi.stubGlobal('Notification', {
    permission: 'default',
    requestPermission: async () => 'default',
  });
}

function removePushSupport() {
  delete (navigator as { serviceWorker?: unknown }).serviceWorker;
}

function renderTree(node: React.ReactNode) {
  act(() => {
    root.render(node);
  });
}

async function renderTreeAsync(node: React.ReactNode) {
  await act(async () => {
    root.render(node);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function statusIcon(name: 'gps' | 'connection' | 'tracking'): Element {
  const icon = container.querySelector(`.tracking-indicator__icon--${name}`);
  if (!icon) {
    throw new Error(`No ${name} status icon rendered`);
  }
  return icon;
}

function statusLabel(name: 'gps' | 'connection' | 'tracking'): string | null {
  return statusIcon(name).getAttribute('aria-label');
}

function statusLevel(name: 'gps' | 'connection' | 'tracking'): string | undefined {
  const icon = statusIcon(name);
  return ['ok', 'degraded', 'bad'].find((level) =>
    icon.classList.contains(`tracking-indicator__icon--${level}`),
  );
}

function openPanel() {
  const button = container.querySelector('.tracking-indicator__button') as HTMLButtonElement;
  act(() => {
    button.click();
  });
}

function panelText(): string {
  return container.querySelector('.tracking-indicator__panel')?.textContent ?? '';
}

// The panel's third definition — the tracking one — as its term and its
// "Right now" line, which is where SPEC.md 8.6's words live.
function trackingDefinition(): { term: string; current: string; body: string } {
  const panel = container.querySelector('.tracking-indicator__panel');
  const terms = [...(panel?.querySelectorAll('dt') ?? [])];
  const term = terms[2];
  const definition = term?.nextElementSibling;
  return {
    term: term?.textContent ?? '',
    current: definition?.querySelector('.tracking-indicator__current')?.textContent ?? '',
    body: definition?.textContent ?? '',
  };
}

function buttonWithText(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(
    (element) => element.textContent === text,
  ) as HTMLButtonElement | undefined;
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
  removePushSupport();
  delete window.__tipsyTrails;
  delete window.webkit;
});

// ---------------------------------------------------------------------------
// Row 5 — the indicator's four shell states
// ---------------------------------------------------------------------------

describe('the third icon under the shell (ios/SPEC.md 8.3, SPEC.md 8.6)', () => {
  // The mapping on its own, with no React tree around it, because it is the
  // whole of the derivation: three of the four states are a field of the event
  // and the fourth asks a second question of it.
  describe('the event reduced to a state (shell/useShellTracking.ts)', () => {
    it('reads "on in the background" from the event’s own background flag', () => {
      expect(toShellTrackingState(trackingEvent({ background: true }))).toEqual({
        kind: 'background',
      });
    });

    // The two ways to be tracking without the background, and they are told
    // apart by the authorization rather than by the account: 7.3 keeps
    // `background` false whatever the ladder says until consent is on the
    // account, so `authorizedAlways` with no background can only be consent.
    it('tells When In Use from a missing consent by the authorization status', () => {
      expect(toShellTrackingState(trackingEvent({ status: 'authorizedWhenInUse' }))).toEqual({
        kind: 'foregroundOnly',
        because: 'whenInUse',
      });
      expect(toShellTrackingState(trackingEvent({ status: 'authorizedAlways' }))).toEqual({
        kind: 'foregroundOnly',
        because: 'consent',
      });
    });

    it('carries the blocked reason through, and answers null when the event omits it', () => {
      expect(
        toShellTrackingState(trackingEvent({ state: 'blocked', reason: 'servicesOff' })),
      ).toEqual({ kind: 'blocked', reason: 'servicesOff' });
      expect(toShellTrackingState(trackingEvent({ state: 'blocked' }))).toEqual({
        kind: 'blocked',
        reason: null,
      });
    });

    it('reads idle as idle whatever else the event carries', () => {
      expect(toShellTrackingState(trackingEvent({ state: 'idle', background: true }))).toEqual({
        kind: 'idle',
      });
    });
  });

  // SPEC.md 8.6's four states with their severities: ok, degraded, bad, bad.
  it('shows the four states with the levels SPEC.md 8.6 gives them', () => {
    const shell = injectShell();
    renderTree(<TrackingIndicator state={sampleState()} />);

    act(() => {
      shell.dispatch(trackingEvent({ background: true }));
    });
    expect(statusLevel('tracking')).toBe('ok');
    expect(statusLabel('tracking')).toBe('Tracking: on in the background');

    act(() => {
      shell.dispatch(trackingEvent({ background: false }));
    });
    expect(statusLevel('tracking')).toBe('degraded');
    expect(statusLabel('tracking')).toBe('Tracking: on while open only');

    act(() => {
      shell.dispatch(trackingEvent({ state: 'blocked', reason: 'denied' }));
    });
    expect(statusLevel('tracking')).toBe('bad');
    expect(statusLabel('tracking')).toBe('Tracking: blocked - location access denied');

    act(() => {
      shell.dispatch(trackingEvent({ state: 'idle' }));
    });
    expect(statusLevel('tracking')).toBe('bad');
    expect(statusLabel('tracking')).toBe('Tracking: not signed in');
  });

  // **The assertion this whole row turns on.** 8.3 keeps `SampleTrackingState`
  // at thirteen members by having these four states reach the component from
  // the shell module instead, and the two readings are of the same event — so a
  // component that had quietly gone on reading `trackingActive` would still
  // look right in every test that set the two consistently. These set them
  // against each other: the boolean says one thing, the event says another, and
  // the icon must follow the event.
  it('takes the four states from the shell module and not from trackingActive', () => {
    const shell = injectShell();
    renderTree(<TrackingIndicator state={sampleState({ trackingActive: true })} />);

    // `trackingActive` true — which is what the shell driver reports for a
    // `tracking` state — while the event says the authorization is blocked.
    act(() => {
      shell.dispatch(trackingEvent({ state: 'blocked', reason: 'reducedAccuracy' }));
    });
    expect(statusLevel('tracking')).toBe('bad');
    expect(statusLabel('tracking')).toBe('Tracking: blocked - Precise Location is off');

    // And the other way: the boolean says paused, the event says the phone is
    // recording in the background, and the icon is ok.
    act(() => {
      root.render(<TrackingIndicator state={sampleState({ trackingActive: false })} />);
      shell.dispatch(trackingEvent({ background: true }));
    });
    expect(statusLevel('tracking')).toBe('ok');
    expect(statusLabel('tracking')).toBe('Tracking: on in the background');
  });

  // SPEC.md 8.6: "Their shape never changes ... The shape is the one this
  // section fixes for every state on every platform; only the words in the
  // panel and the number of states differ by where the app is running." Read
  // out of the DOM for all four states plus both browser states, so a state
  // that grew its own mark fails here.
  it('keeps one shape across all four shell states and both browser states', () => {
    const shapes = new Set<string>();
    const record = () => {
      shapes.add(statusIcon('tracking').innerHTML);
    };

    renderTree(<TrackingIndicator state={sampleState({ trackingActive: true })} />);
    record();
    renderTree(<TrackingIndicator state={sampleState({ trackingActive: false })} />);
    record();

    act(() => {
      root.unmount();
    });
    root = createRoot(container);
    const shell = injectShell();
    renderTree(<TrackingIndicator state={sampleState()} />);
    for (const event of [
      trackingEvent({ background: true }),
      trackingEvent({ background: false }),
      trackingEvent({ state: 'blocked', reason: 'servicesOff' }),
      trackingEvent({ state: 'idle' }),
    ]) {
      act(() => {
        shell.dispatch(event);
      });
      record();
    }

    expect(shapes.size).toBe(1);
  });

  // SPEC.md 8.6: "an accessible name that states its state in words rather than
  // naming the icon". Not the icon's name, not a fixed string — the state, for
  // every state the app can be in, blocked reasons included. WCAG 2.5.3.
  it('states the state in every accessible name, blocked reasons included', () => {
    const shell = injectShell();
    renderTree(<TrackingIndicator state={sampleState()} />);

    const reasons: [BlockedReason, string][] = [
      ['reducedAccuracy', 'Tracking: blocked - Precise Location is off'],
      ['denied', 'Tracking: blocked - location access denied'],
      ['restricted', 'Tracking: blocked - location access restricted'],
      ['servicesOff', 'Tracking: blocked - Location Services is off'],
    ];
    for (const [reason, name] of reasons) {
      act(() => {
        shell.dispatch(trackingEvent({ state: 'blocked', reason }));
      });
      expect(statusLabel('tracking')).toBe(name);
    }

    // A `blocked` event with no reason — 7.5 declares the field optional, and
    // 8.3 says this reader has an answer for its absence. The name still states
    // the state; it just names no cause it was not given.
    act(() => {
      shell.dispatch(trackingEvent({ state: 'blocked' }));
    });
    expect(statusLabel('tracking')).toBe('Tracking: blocked');

    // The other two icons keep the pattern they had. This is what makes the
    // above an extension of the existing scheme rather than a second one.
    expect(statusLabel('gps')).toBe('GPS signal: good');
    expect(statusLabel('connection')).toBe('Connection: online');
  });

  it('names the panel’s third definition "Tracking", with the state in words', () => {
    const shell = injectShell();
    renderTree(<TrackingIndicator state={sampleState()} />);
    act(() => {
      shell.dispatch(trackingEvent({ background: true }));
    });
    openPanel();

    expect(trackingDefinition().term).toBe('Tracking');
    expect(trackingDefinition().current).toBe('Right now: On in the background');
    // The browser's sentence is gone, and 8.4 is the reason: it is true of the
    // browser and of nothing else, so the app must not repeat it.
    expect(panelText()).not.toContain('phones don');
  });

  // 8.3: the degraded state's panel says *which* of the two it is and offers
  // the way to grant it. Two different sentences, because the two have
  // different ways out.
  it('says which kind of foreground-only it is, and offers openConsent', () => {
    const shell = injectShell();
    const posted = installMessageHandler();
    renderTree(<TrackingIndicator state={sampleState()} />);

    act(() => {
      shell.dispatch(trackingEvent({ status: 'authorizedWhenInUse' }));
    });
    openPanel();
    expect(trackingDefinition().body).toContain('only while the app is open');
    expect(trackingDefinition().body).toContain('"Always" permission');

    act(() => {
      shell.dispatch(trackingEvent({ status: 'authorizedAlways' }));
    });
    expect(trackingDefinition().body).toContain("haven't turned background tracking on");

    const consentButton = buttonWithText('Background tracking settings');
    expect(consentButton).toBeDefined();
    act(() => {
      consentButton?.click();
    });
    expect(posted).toEqual([{ type: 'openConsent' }]);
  });

  // 6.5: "the shell's words name the global switch rather than the app's",
  // because iOS reports a refusal and a device-wide switch identically and this
  // sentence is the only place the difference is ever visible to a player.
  it('names Location Services in the blocked panel when the switch is the cause', () => {
    const shell = injectShell();
    renderTree(<TrackingIndicator state={sampleState()} />);
    act(() => {
      shell.dispatch(trackingEvent({ state: 'blocked', reason: 'servicesOff' }));
    });
    openPanel();

    expect(trackingDefinition().current).toBe('Right now: Blocked - Location Services is off');
    expect(trackingDefinition().body).toContain('Location Services is off');
    // Blocked offers no way out from here: the way out is iOS's own Settings
    // app, which the shell deep-links to from its Consent screen (6.2).
    expect(buttonWithText('Background tracking settings')).toBeUndefined();
  });

  it('says "not signed in" on idle', () => {
    const shell = injectShell();
    renderTree(<TrackingIndicator state={sampleState({ trackingActive: true })} />);
    act(() => {
      shell.dispatch(trackingEvent({ state: 'idle' }));
    });
    openPanel();

    expect(trackingDefinition().current).toBe('Right now: Not signed in');
    expect(statusLevel('tracking')).toBe('bad');
  });

  // THE SAFARI TWIN. Same component, no injected object, and everything about
  // the third icon is what it was before this block: the icon's name, the
  // panel's term, the "Right now" line and the sentence about the foreground.
  it('is untouched in Safari: the two states, the words and the pause sentence', () => {
    renderTree(<TrackingIndicator state={sampleState({ trackingActive: true })} />);
    expect(statusLabel('tracking')).toBe('Foreground tracking: active');
    expect(statusLevel('tracking')).toBe('ok');

    renderTree(<TrackingIndicator state={sampleState({ trackingActive: false })} />);
    expect(statusLabel('tracking')).toBe('Foreground tracking: paused');
    expect(statusLevel('tracking')).toBe('degraded');

    openPanel();
    expect(trackingDefinition().term).toBe('Foreground tracking');
    expect(trackingDefinition().current).toBe('Right now: Paused');
    expect(panelText()).toContain("phones don't let apps track location in the background");
    expect(buttonWithText('Background tracking settings')).toBeUndefined();
  });

  // A `WKWebView` that is not this shell defines `window.webkit` too (8.1), and
  // an event dispatched with no injected object reaches nothing. Both are the
  // same rule: the detection is the injected object and nothing else.
  it('ignores a message handler with no injected object', () => {
    installMessageHandler();
    renderTree(<TrackingIndicator state={sampleState({ trackingActive: true })} />);

    expect(statusLabel('tracking')).toBe('Foreground tracking: active');
  });
});

// ---------------------------------------------------------------------------
// Row 6 — the push offer
// ---------------------------------------------------------------------------

describe('the push offer under the shell (ios/SPEC.md 8.4)', () => {
  // The screen carries the tab bar, which reads the current user, so the
  // provider comes with it and answers one request. Everything the push path
  // would do is a request too — `GET /api/push/vapid-public-key` first — so
  // "no other request" below is what proves it did nothing.
  async function renderScreen() {
    const fetchMock = stubUserFetch(null);
    await renderTreeAsync(
      <MemoryRouter>
        <CurrentUserProvider>
          <HowMasteringWorks />
        </CurrentUserProvider>
      </MemoryRouter>,
    );
    return fetchMock;
  }

  function otherCalls(mock: ReturnType<typeof stubUserFetch>) {
    return mock.mock.calls.filter(([input]) => !String(input).startsWith('/api/auth/me'));
  }

  // 8.4: "the hook reports `unsupported` there, which it already does when the
  // Push API is absent, so the change is the button's destination and not the
  // hook". This is that claim, asserted rather than assumed: a `WKWebView`
  // exposes no `PushManager`, which is the environment this test runs in, and
  // the offer that renders is the shell's rather than the browser's.
  it('leaves the hook reporting unsupported, and replaces the offer instead', async () => {
    injectShell();
    const fetchMock = await renderScreen();

    // The browser's offer is the one gated on `permission !== 'unsupported'`,
    // and none of its three controls is here.
    expect(buttonWithText('Turn off notifications')).toBeUndefined();
    expect(container.textContent).not.toContain('Notifications are blocked for this site');
    // The hook made no request either: `getVapidPublicKey` is `enable()`'s
    // first call and nothing reached it.
    expect(otherCalls(fetchMock)).toHaveLength(0);

    expect(buttonWithText('Enable notifications')).toBeDefined();
  });

  it('posts requestNotifications instead of subscribing', async () => {
    injectShell();
    const posted = installMessageHandler();
    const fetchMock = await renderScreen();

    act(() => {
      buttonWithText('Enable notifications')?.click();
    });

    expect(posted).toEqual([{ type: 'requestNotifications' }]);
    // Nothing else happens: there is no VAPID key to fetch, no service worker
    // to register and no subscription to post. The shell owns all of it on its
    // Consent screen (11.2).
    expect(otherCalls(fetchMock)).toHaveLength(0);
  });

  // THE SAFARI TWIN. The same screen with the Push API present and no injected
  // object: the browser's offer, the same button and the same words, and it
  // posts nothing to a message handler that is listening.
  it('is untouched in Safari: the same button, the same words, no message', async () => {
    stubPushSupport();
    const posted = installMessageHandler();
    await renderScreen();

    const button = buttonWithText('Enable notifications');
    expect(button).toBeDefined();
    expect(container.textContent).toContain(
      'Tipsy Trails can notify you once a pending visit is nearly complete',
    );

    act(() => {
      button?.click();
    });
    expect(posted).toEqual([]);
  });

  // And with no Push API and no shell — an older browser — the offer is absent
  // altogether, exactly as it was before this block.
  it('offers nothing in a browser without the Push API', async () => {
    await renderScreen();

    expect(buttonWithText('Enable notifications')).toBeUndefined();
    expect(container.textContent).not.toContain('Tipsy Trails can notify you');
  });
});

// ---------------------------------------------------------------------------
// Row 7 — the Settings row
// ---------------------------------------------------------------------------

describe('the Settings row (ios/SPEC.md 8.6)', () => {
  async function renderSettings(consentedAt: number | null) {
    const fetchMock = stubUserFetch(consentedAt);
    await renderTreeAsync(
      <MemoryRouter>
        <CurrentUserProvider>
          <Settings />
        </CurrentUserProvider>
      </MemoryRouter>,
    );
    return fetchMock;
  }

  function settingsCalls(mock: ReturnType<typeof stubUserFetch>) {
    return mock.mock.calls.filter(([input]) => String(input) === '/api/settings');
  }

  it('renders under the shell, showing the consent state from the account', async () => {
    injectShell();
    await renderSettings(null);

    expect(container.textContent).toContain('Background tracking');
    expect(container.textContent).toContain('Right now: Off');
  });

  it('shows it as on when the account carries a consent timestamp', async () => {
    injectShell();
    await renderSettings(1_757_000_000);

    expect(container.textContent).toContain('Right now: On');
  });

  it('opens the Consent screen with openConsent', async () => {
    injectShell();
    const posted = installMessageHandler();
    const fetchMock = await renderSettings(null);

    act(() => {
      buttonWithText('Background tracking settings')?.click();
    });

    expect(posted).toEqual([{ type: 'openConsent' }]);
    // **And writes nothing.** 5.4 has one client write settings and one path
    // into this column: the shell's Consent screen calling
    // `requestSettingsUpdate`, which this page answers with `PATCH
    // /api/settings` (8.2). A row that also wrote would be a second way in,
    // racing the native screen and iOS's own Always prompt.
    expect(settingsCalls(fetchMock)).toHaveLength(0);
  });

  // THE SAFARI TWIN, and 8.6's own sentence: "The row does not render in
  // Safari, where it would describe a feature the browser does not have."
  it('does not render in Safari', async () => {
    await renderSettings(1_757_000_000);

    expect(container.textContent).not.toContain('Background tracking');
    expect(buttonWithText('Background tracking settings')).toBeUndefined();
    // The rest of the screen is untouched, so this is the row's absence and
    // not the screen failing to render.
    expect(container.textContent).toContain('Play anonymously');
    expect(container.textContent).toContain('Delete account');
  });
});
