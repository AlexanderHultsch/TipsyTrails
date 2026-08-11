import { ACTIVE_CITY_SLUG } from './city.js';
import type { BoundaryFeatureCollection } from './geo-types.js';
import type {
  Bar,
  BarsResponse,
  CityMeta,
  FogMaskResponse,
  FogProgress,
  PendingVisitsResponse,
  Sample,
  SamplesResponse,
  User,
  VapidPublicKeyResponse,
  VisitSummary,
} from './types.js';

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

export function postSamples(samples: Sample[]): Promise<SamplesResponse> {
  return request<SamplesResponse>('/api/samples', {
    method: 'POST',
    body: JSON.stringify({ samples }),
  });
}

// Section 9.2: active city metadata + grid parameters. The fog layer
// (map/fog/) needs grid_width/grid_height to interpret the raw mask from
// getFogMask below as a 2D texture - GET /api/fog carries no dimensions of
// its own.
export function getCity(): Promise<CityMeta> {
  return request<CityMeta>('/api/city');
}

// GET /api/fog's body is the raw bitmask, `application/octet-stream`
// (Section 9.2), not JSON - request() above always parses its response
// text as JSON, so this route is fetched directly instead. The
// per-district counts travel in the `X-Fog-Progress` header
// (packages/api/src/routes/fog.ts) precisely so the body can stay exactly
// the raw mask.
export async function getFogMask(): Promise<FogMaskResponse> {
  let response: Response;
  try {
    response = await fetch('/api/fog', { credentials: 'include' });
  } catch {
    throw new ApiError('network_error', NETWORK_ERROR_MESSAGE, 0);
  }

  if (!response.ok) {
    // Same text()-then-parse approach as request() above, rather than
    // response.json() - it tolerates an empty error body the same way.
    let body: ApiErrorBody = {};
    try {
      const text = await response.text();
      body = text ? (JSON.parse(text) as ApiErrorBody) : {};
    } catch {
      // No parseable JSON body - fall through to the generic message below.
    }
    throw new ApiError(
      body.code ?? 'unknown_error',
      body.message ?? UNKNOWN_ERROR_MESSAGE,
      response.status,
    );
  }

  const header = response.headers.get('X-Fog-Progress');
  let progress: FogProgress = { revealedCells: 0, playableCells: 0, districts: [] };
  if (header) {
    try {
      progress = JSON.parse(header) as FogProgress;
    } catch {
      // Malformed header - the mask itself is still usable, so this is not
      // fatal; the caller just sees zeroed progress.
    }
  }

  const buffer = await response.arrayBuffer();
  return { mask: new Uint8Array(buffer), progress };
}

// GET /api/bars (Section 9.2): bars discovered by the current user only
// (Section 7.4) - the API never sends anything else, so there is nothing
// further to filter here.
export function getBars(): Promise<BarsResponse> {
  return request<BarsResponse>('/api/bars');
}

// GET /api/bars/:id (Section 9.5): an identical 404 for "does not exist" and
// "not discovered by you" - the caller renders whatever ApiError.message
// comes back rather than distinguishing the two.
export function getBar(id: string): Promise<Bar> {
  return request<Bar>(`/api/bars/${encodeURIComponent(id)}`);
}

// POST /api/visits (Section 9.2/7.5 step 2): creates the pending visit, or
// returns the existing one if this bar already has one open (Section 5.7) -
// the caller renders whatever VisitSummary comes back either way.
export function checkIn(input: { barId: number }): Promise<VisitSummary> {
  return request<VisitSummary>('/api/visits', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

// GET /api/visits/pending (Section 9.2): the caller's active pending
// visits, for the persistent banner (Section 7.5).
export function getPendingVisits(): Promise<PendingVisitsResponse> {
  return request<PendingVisitsResponse>('/api/visits/pending');
}

// GET /api/push/vapid-public-key (Section 9.2/Phase 5 step 5): the key
// tracking/usePushSubscription.ts needs to call `pushManager.subscribe()` -
// null when the server has no VAPID_* configuration.
export function getVapidPublicKey(): Promise<VapidPublicKeyResponse> {
  return request<VapidPublicKeyResponse>('/api/push/vapid-public-key');
}

// POST /api/push/subscribe (Section 5.9/9.2): stores or updates the
// caller's push subscription; re-subscribing with an endpoint that already
// exists must not error (task Section B), so this is always safe to call
// again with the same PushSubscription.
export function subscribePush(input: {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}): Promise<{ ok: true }> {
  return request<{ ok: true }>('/api/push/subscribe', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

// DELETE /api/push/subscribe (Section 5.9/9.2).
export function unsubscribePush(input: { endpoint: string }): Promise<{ ok: true }> {
  return request<{ ok: true }>('/api/push/subscribe', {
    method: 'DELETE',
    body: JSON.stringify(input),
  });
}

export function updateSettings(input: { isAnonymous: boolean }): Promise<User> {
  return request<User>('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function deleteAccount(input: { password: string }): Promise<{ ok: true }> {
  return request<{ ok: true }>('/api/account', {
    method: 'DELETE',
    body: JSON.stringify(input),
  });
}

// Served by packages/api/src/routes/static-data.ts at
// /static/<slug>/<filename>.geojson, one-day cache (Section 4.1). Plain
// GETs against a public, unauthenticated path - request() is reused because
// its JSON parsing and ApiError mapping are exactly what these screens need
// too, not because the route requires a session.
export function getCityBoundary(): Promise<BoundaryFeatureCollection> {
  return request<BoundaryFeatureCollection>(`/static/${ACTIVE_CITY_SLUG}/city.geojson`);
}

export function getDistrictBoundaries(): Promise<BoundaryFeatureCollection> {
  return request<BoundaryFeatureCollection>(`/static/${ACTIVE_CITY_SLUG}/districts.geojson`);
}

export function getNeighbourBoundaries(): Promise<BoundaryFeatureCollection> {
  return request<BoundaryFeatureCollection>(`/static/${ACTIVE_CITY_SLUG}/neighbours.geojson`);
}
