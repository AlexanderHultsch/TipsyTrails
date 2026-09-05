import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import type { ShellBridge } from './shell/bridge.js';
import { getShellBridge } from './shell/bridge.js';
import { attachSettingsUpdateHandler } from './shell/useShellSettingsUpdate.js';

// ios/SPEC.md 8.1 and 8.2, and 12's row 3 of "The list for `main`": the shell
// module's detection, and the page side of `requestSettingsUpdate`.
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

// The shell's injected object as 8.1 defines it, minus the members this block
// deliberately does not implement (`dispatch` and `addListener`, which are the
// event path of 8.2 and belong with the tracking hook's shell driver). What is
// here is what the shell injects and what the page attaches to.
function injectShell(): ShellBridge {
  const bridge: ShellBridge = {
    platform: 'ios',
    shellVersion: '1.0.0',
    trackerVersion: '1.0.0',
  };
  window.__tipsyTrails = bridge;
  return bridge;
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
  delete window.__tipsyTrails;
});

describe('the shell bridge (ios/SPEC.md 8.1)', () => {
  it('detects the shell by the presence of the injected object, and by nothing else', () => {
    expect(getShellBridge()).toBeNull();
    const bridge = injectShell();
    expect(getShellBridge()).toBe(bridge);
  });

  it('attaches requestSettingsUpdate to the injected object once the app has mounted', async () => {
    const bridge = injectShell();
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
    const bridge = injectShell();

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
