import { ACTIVE_CITY_SLUG } from './city.js';
import type { BoundaryFeatureCollection } from './geo-types.js';
import type {
  AdminBar,
  AdminBarsResponse,
  AdminUsersResponse,
  Bar,
  BarsResponse,
  CityMeta,
  FogMaskResponse,
  FogProgress,
  LeaderboardResponse,
  PendingVisitsResponse,
  ProfileResponse,
  ProgressResponse,
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
//
// `Content-Type: application/json` is sent only when there actually is a
// body, and that condition is load-bearing rather than tidy. Declaring that
// content type on a request that then sends zero bytes is not a harmless
// extra header: Fastify's JSON body parser rejects it outright with
// FST_ERR_CTP_EMPTY_JSON_BODY — a 400, "Body cannot be empty when
// content-type is set to 'application/json'" — before any route handler
// runs. Sent unconditionally, every bodyless state-changing call in this file
// failed on every attempt, for everyone, from the day it shipped:
// `POST /api/visits/:id/cancel`, `POST /api/auth/logout` and
// `DELETE /api/admin/bars/:id`. Calls that do send a body were unaffected,
// which is why check-in worked and cancelling never did.
//
// The caller's own `headers` still override, so a call that wants a
// different content type (or wants to state this one for a bodyless
// request) can still say so explicitly.
//
// This is checked from both ends: `client.test.ts` pins the header, and
// `packages/api/src/routes/visits.test.ts` puts a real Fastify instance
// behind a bodyless cancel. The second is the one that matters — every web
// test in this repository stubs `fetch`, so no amount of client-side testing
// could ever have seen a body parser reject anything.
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'include',
      headers: {
        ...(init?.body == null ? {} : { 'Content-Type': 'application/json' }),
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

// POST /api/bars/suggest (Section 11.3/9.2): the map-picked position, name
// and address a player submits. Rejects with `code: 'duplicate_bar'` and a
// message naming the conflicting bar (packages/api/src/routes/bars.ts) -
// the caller renders err.message exactly like every other ApiError here
// rather than special-casing the code, so the server's own wording reaches
// the user unchanged.
export function suggestBar(input: {
  name: string;
  address: string | null;
  lat: number;
  lon: number;
}): Promise<Bar> {
  return request<Bar>('/api/bars/suggest', {
    method: 'POST',
    body: JSON.stringify(input),
  });
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

// POST /api/visits/:id/cancel (Section 9.2/5.7/7.5): ends the caller's own
// pending visit and answers with it in its `cancelled` state. Not a DELETE,
// deliberately - the row survives as the record of what happened, so there
// is nothing here to mirror `deleteAdminBar` above. A visit the caller may
// not act on comes back as one indistinguishable 404 (Section 9.5), which
// this function surfaces as an ordinary ApiError like every other call.
//
// It carries no body, which is why it was the most visible casualty of the
// unconditional Content-Type header `request` used to send - see the note
// there. The id is in the path and there is nothing else to say.
export function cancelVisit(visitId: number): Promise<VisitSummary> {
  return request<VisitSummary>(`/api/visits/${visitId}/cancel`, { method: 'POST' });
}

// GET /api/visits/pending (Section 9.2): the caller's active pending
// visits, for the persistent banner (Section 7.5).
export function getPendingVisits(): Promise<PendingVisitsResponse> {
  return request<PendingVisitsResponse>('/api/visits/pending');
}

// GET /api/progress (Section 9.2/7.6): city-wide and per-district area
// explored, the real figures screens/CityOverview.tsx and
// screens/DistrictOverview.tsx show in place of Phase 2's placeholder.
export function getProgress(): Promise<ProgressResponse> {
  return request<ProgressResponse>('/api/progress');
}

// GET /api/leaderboard (Section 9.2/7.8): ranked standings for one
// metric/period/page. Query params are always sent explicitly - the server
// defaults them too (routes/leaderboard.ts's zod schema), but the screen
// always has a concrete metric/period/page in state by the time it fetches.
export function getLeaderboard(input: {
  metric: 'area' | 'bars';
  period: 'all' | 'week' | 'month';
  page: number;
}): Promise<LeaderboardResponse> {
  const params = new URLSearchParams({
    metric: input.metric,
    period: input.period,
    page: String(input.page),
  });
  return request<LeaderboardResponse>(`/api/leaderboard?${params.toString()}`);
}

// GET /api/profile/:handle (Section 9.2/9.5): accepts a username or a
// `player-{id}` handle - this function is agnostic between the two, exactly
// like the route itself, and returns the identical 404 body either way.
export function getProfile(handle: string): Promise<ProfileResponse> {
  return request<ProfileResponse>(`/api/profile/${encodeURIComponent(handle)}`);
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

// GET /api/admin/bars (Section 9.3): every bar including hidden ones,
// optionally filtered by source - mirrors the server's own optional query
// param rather than always sending it.
export function getAdminBars(input?: { source?: string }): Promise<AdminBarsResponse> {
  const query = input?.source ? `?source=${encodeURIComponent(input.source)}` : '';
  return request<AdminBarsResponse>(`/api/admin/bars${query}`);
}

// POST /api/admin/bars (Section 9.3): create a bar directly, source='admin'
// server-side.
export function createAdminBar(input: {
  name: string;
  address: string | null;
  lat: number;
  lon: number;
}): Promise<AdminBar> {
  return request<AdminBar>('/api/admin/bars', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

// PATCH /api/admin/bars/:id (Section 9.3): edit name, address, position, or
// status - moving a bar recomputes cell_index and district_id server-side.
export function updateAdminBar(
  id: number,
  input: Partial<{
    name: string;
    address: string | null;
    lat: number;
    lon: number;
    status: 'active' | 'hidden';
  }>,
): Promise<AdminBar> {
  return request<AdminBar>(`/api/admin/bars/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

// DELETE /api/admin/bars/:id (Section 9.3): cascades discoveries and visits
// server-side - irreversible, so every caller of this function must have
// already confirmed with the user naming the bar (Phase 7 task brief).
export function deleteAdminBar(id: number): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/admin/bars/${id}`, { method: 'DELETE' });
}

// GET /api/admin/users (Section 9.3): the user list with stats.
export function getAdminUsers(): Promise<AdminUsersResponse> {
  return request<AdminUsersResponse>('/api/admin/users');
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
