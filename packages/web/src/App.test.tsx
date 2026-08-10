import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';

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
});
