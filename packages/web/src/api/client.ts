import type { User } from './types.js';

// Thrown for both API-reported failures (server JSON with a stable `code`)
// and network failures (fetch itself rejecting). Callers render `message`
// and never a raw exception.
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const NETWORK_ERROR_MESSAGE = 'Could not reach the server. Check your connection and try again.';
const UNKNOWN_ERROR_MESSAGE = 'Something went wrong. Please try again.';

interface ApiErrorBody {
  code?: string;
  message?: string;
}

// Same-origin fetch with credentials so the session cookie is sent. Ordinary
// same-origin requests from the SPA already carry an Origin header set by
// the browser itself — it cannot and must not be set from script here.
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError('network_error', NETWORK_ERROR_MESSAGE, 0);
  }

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    const errorBody = (body ?? {}) as ApiErrorBody;
    throw new ApiError(
      errorBody.code ?? 'unknown_error',
      errorBody.message ?? UNKNOWN_ERROR_MESSAGE,
      response.status,
    );
  }

  return body as T;
}

// A 401 here is the normal signed-out state, not a failure — resolve to
// null rather than throwing. Any other failure (network error, 5xx, ...)
// also resolves to null: there is no screen at boot time to show it on, and
// the app must not get stuck before the landing page even renders.
export async function getCurrentUser(): Promise<User | null> {
  try {
    return await request<User>('/api/auth/me');
  } catch {
    return null;
  }
}

export function register(input: {
  username: string;
  password: string;
  securityQuestion: string;
  securityAnswer: string;
  ageConfirmed: boolean;
}): Promise<User> {
  return request<User>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function login(input: { username: string; password: string }): Promise<User> {
  return request<User>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function logout(): Promise<{ ok: true }> {
  return request<{ ok: true }>('/api/auth/logout', { method: 'POST' });
}

export function getResetQuestion(username: string): Promise<{ question: string }> {
  return request<{ question: string }>(
    `/api/auth/reset/question?username=${encodeURIComponent(username)}`,
  );
}

export function resetPassword(input: {
  username: string;
  securityAnswer: string;
  newPassword: string;
}): Promise<{ ok: true }> {
  return request<{ ok: true }>('/api/auth/reset', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function changePassword(input: {
  currentPassword: string;
  newPassword: string;
}): Promise<{ ok: true }> {
  return request<{ ok: true }>('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
