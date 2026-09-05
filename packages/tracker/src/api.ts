// ios/SPEC.md Section 7.2 (`Host.fetch`'s error contract), 7.3 (what `start`
// calls and why `GET /api/auth/me` decides background consent) and 7.4 (the
// flush's success/failure branches and the guard it applies). This is
// substep B3: the four HTTP calls the tracker makes, each returning a
// discriminated result instead of throwing. B5 and B6 build the flush loop,
// the timer, the backoff and the state machine on top of these; nothing
// here decides when to call, only what a call answers.
//
// Three of the four calls are `SPEC.md` 9.2's own routes. The fourth,
// `GET /api/bars/:id`, is not yet in `ios/SPEC.md` - Section 7.6's dwelling
// profile needs a pending visit's bar position to know when the player has
// left, and no other call carries it (`VisitSummary` has `barId`/`barName`
// and no position; a flush's `newBars` covers only bars this batch
// discovered). The owner decided the tracker fetches it lazily, only when
// holding a pending visit whose bar it cannot already locate, so a start
// with no pending visit makes no extra request. A later commit records this
// in `ios/SPEC.md`; this file does not edit that spec.
//
// GUARD DEPTH. `SPEC.md` 9.6's rule - validate where a wrong shape produces
// a silently wrong answer rather than a visible failure - reaches further
// here than in `packages/web/src/api/response-guards.ts`, because almost
// everything this client reads feeds a counter or a profile decision rather
// than a screen. Every guard below checks exactly the fields Section 7 of
// `ios/SPEC.md` names as read, in that file's own idiom: hand-written
// narrowing predicates, `Number.isFinite` and never `typeof x === 'number'`
// (`NaN` is typed `number` and is exactly the value a missing field
// produces through arithmetic). A field nothing reads - `barName`,
// `remainingS`, `avatarSeed` and the rest - is cast, not checked.
//
// `User`, `Bar`, `VisitSummary` and `SamplesResponse` are the hand-kept wire
// mirrors `events.ts` already keeps for the same reason that file's own
// comment gives: `packages/tracker` cannot import `packages/web`, so a
// second copy is deliberate. `User` joins them here because this is its only
// caller in this package.
import { CONFIG } from '@tipsytrails/shared';
import type { Bar, Sample, SamplesResponse, VisitStatus, VisitSummary } from './events.js';
import type { Host, HostResponse } from './host.js';

// Mirrors packages/web/src/api/types.ts's `User`, widened by `SPEC.md` 9.6
// to carry `backgroundTrackingConsentedAt` - the field `ios/SPEC.md` 5.4 and
// 7.3 have the tracker read at start to decide whether background tracking
// is permitted on this account. The server has not built the field yet
// (Step C); the shape is declared now because `SPEC.md` 9.6 already
// declares it, and nothing here depends on the server having caught up.
export interface User {
  id: number;
  username: string;
  avatarSeed: string;
  isAdmin: boolean;
  isAnonymous: boolean;
  mustChangePassword: boolean;
  backgroundTrackingConsentedAt: number | null;
}

// Mirrors packages/web/src/api/types.ts's `PendingVisitsResponse`.
export interface PendingVisitsResponse {
  visits: VisitSummary[];
}

// Section 7.2's own words: `Host.fetch` resolves for every HTTP status and
// throws only when the request never completed. This is the one place that
// contract becomes something B5/B6 can branch on without a try/catch of
// their own - a caller that forgot one would turn a dead spot into a
// crashed tracker.
export type ApiResult<T> =
  | { outcome: 'ok'; value: T }
  | { outcome: 'unauthenticated' } // 401 - 7.4, 5.2
  | { outcome: 'passwordChangeRequired' } // 403 with code 'password_change_required'
  | { outcome: 'rateLimited'; retryAfterMs: number } // 429 - 7.4 waits exactly this
  | { outcome: 'notFound' } // 404 - only call 4 (GET /api/bars/:id) can mean it
  | { outcome: 'httpError'; status: number } // every other non-2xx
  | { outcome: 'invalidResponse'; detail: string } // the guard rejected the body
  | { outcome: 'transportError'; detail: string }; // Host.fetch threw

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

const VISIT_STATUSES: readonly VisitStatus[] = ['pending', 'completed', 'expired', 'cancelled'];

function isVisitStatus(value: unknown): value is VisitStatus {
  return typeof value === 'string' && (VISIT_STATUSES as readonly string[]).includes(value);
}

// `ios/SPEC.md` 7.6: `id`, `barId`, `startedAt` and `status` drive the visit
// set and therefore the location profile - `barName`, `lastSampleAt`,
// `onsiteSamples`, `confirmedS` and `remainingS` are read by no code in this
// package and so are cast, not checked. The same predicate guards a flush's
// `visitUpdates` and `GET /api/visits/pending`'s `visits`: both feed the one
// visit set (7.6), so a wrong shape in either is the same silent wrong
// answer.
function isTrackedVisitSummary(value: unknown): value is VisitSummary {
  return (
    isObject(value) &&
    isFiniteNumber(value.id) &&
    isFiniteNumber(value.barId) &&
    isFiniteNumber(value.startedAt) &&
    isVisitStatus(value.status)
  );
}

// `ios/SPEC.md` 7.6: `id`, `lat` and `lon` are what seeds the bar positions
// this package would otherwise have to fetch one at a time - `name`,
// `address`, `districtId`, `source`, `discoveredAt` and `mastered` are cast.
// The same predicate guards a flush's `newBars` entries and call 4's own
// response.
function isTrackedBar(value: unknown): value is Bar {
  return (
    isObject(value) &&
    isFiniteNumber(value.id) &&
    isFiniteNumber(value.lat) &&
    isFiniteNumber(value.lon)
  );
}

function isRejected(value: unknown): value is SamplesResponse['rejected'] {
  return (
    isObject(value) &&
    isFiniteNumber(value.accuracy) &&
    isFiniteNumber(value.future) &&
    isFiniteNumber(value.stale) &&
    isFiniteNumber(value.outsideCity) &&
    isFiniteNumber(value.tooFast)
  );
}

// `ios/SPEC.md` 7.1/7.8: `rejected`'s five counts feed
// `counters.samples.rejected` directly, `newCells` feeds a counter, and
// `tooFastToReveal` is both counted and forwarded (7.5's `flush` event) -
// all three are wrong answers if a missing field arrives as `undefined` and
// is added into a counter as `NaN`. `newBars` and `visitUpdates` are
// checked entry by entry because each entry seeds state of its own (above).
function isSamplesResponse(value: unknown): value is SamplesResponse {
  return (
    isObject(value) &&
    isFiniteNumber(value.newCells) &&
    Array.isArray(value.newBars) &&
    value.newBars.every(isTrackedBar) &&
    Array.isArray(value.visitUpdates) &&
    value.visitUpdates.every(isTrackedVisitSummary) &&
    typeof value.tooFastToReveal === 'boolean' &&
    isRejected(value.rejected)
  );
}

function isPendingVisitsResponse(value: unknown): value is PendingVisitsResponse {
  return (
    isObject(value) && Array.isArray(value.visits) && value.visits.every(isTrackedVisitSummary)
  );
}

// `ios/SPEC.md` 5.4/7.3: `backgroundTrackingConsentedAt` decides whether
// background tracking is permitted on this account - every other member of
// `User` is cast, unread by this package.
function isUser(value: unknown): value is User {
  if (!isObject(value)) {
    return false;
  }
  const consentedAt = value.backgroundTrackingConsentedAt;
  return consentedAt === null || isFiniteNumber(consentedAt);
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function findHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      return headers[key];
    }
  }
  return undefined;
}

// `Retry-After` is in seconds on the wire (HTTP semantics); every constant
// in this workspace, and every duration this function returns, is
// milliseconds (CLAUDE.md's unit rule) - this is the one conversion
// boundary for that header. A missing or malformed value must not produce
// `NaN` into a caller's `setTimeout`, so it falls back to the tracker's own
// backoff base, which is what a flush would have waited anyway on an
// ordinary failure.
//
// The result is never shorter than `TRACKER_FLUSH_BACKOFF_BASE_MS`, and that
// floor applies to a *parsed* value too, not only to the missing/malformed
// fallback above: `Number('')` is `0`, not `NaN`, so an empty header passes
// the finite/negative check below and a literal `Retry-After: 0` does the
// same either way - and 0 ms is a hot loop against a 429, which is the one
// response rate limiting exists to make unprofitable to hammer. This does
// not contradict `ios/SPEC.md` 7.4's "waits exactly the Retry-After the
// server sends": that word is there to stop the client substituting its own
// backoff for a number the server chose, because the server knows when its
// bucket refills and the client does not. A floor substitutes nothing - it
// binds only where the server's number is degenerate, and a degenerate wait
// is not a number the server meaningfully chose. `packages/api/src/http/
// rate-limit.ts` always sends a positive integer today, so this is defence
// against a proxy that mangles the header or a future server that stops
// being careful, not against the server as it stands.
function retryAfterMs(headers: Record<string, string>): number {
  const raw = findHeader(headers, 'Retry-After');
  const seconds = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return CONFIG.TRACKER_FLUSH_BACKOFF_BASE_MS;
  }
  return Math.max(seconds * 1000, CONFIG.TRACKER_FLUSH_BACKOFF_BASE_MS);
}

async function request<T>(
  host: Host,
  method: string,
  path: string,
  validate: (value: unknown) => value is T,
  body?: string,
): Promise<ApiResult<T>> {
  let response: HostResponse;
  try {
    response =
      body === undefined
        ? await host.fetch({ method, path })
        : await host.fetch({ method, path, body });
  } catch (err) {
    return { outcome: 'transportError', detail: err instanceof Error ? err.message : String(err) };
  }

  if (response.status === 401) {
    return { outcome: 'unauthenticated' };
  }

  if (response.status === 403) {
    const parsedError = parseJson(response.body);
    if (isObject(parsedError) && parsedError.code === 'password_change_required') {
      return { outcome: 'passwordChangeRequired' };
    }
    return { outcome: 'httpError', status: response.status };
  }

  if (response.status === 429) {
    return { outcome: 'rateLimited', retryAfterMs: retryAfterMs(response.headers) };
  }

  if (response.status === 404) {
    return { outcome: 'notFound' };
  }

  if (response.status < 200 || response.status >= 300) {
    return { outcome: 'httpError', status: response.status };
  }

  const parsedBody = parseJson(response.body);
  if (parsedBody === undefined) {
    return {
      outcome: 'invalidResponse',
      detail: `${method} ${path}: response body is not valid JSON`,
    };
  }
  if (!validate(parsedBody)) {
    return {
      outcome: 'invalidResponse',
      detail: `${method} ${path}: response body failed validation`,
    };
  }
  return { outcome: 'ok', value: parsedBody };
}

// `ios/SPEC.md` 7.3: called first on `start`; a 401 here is `sessionLost`
// before anything else is tried, and `backgroundTrackingConsentedAt` on the
// answer is what 5.4 has the tracker read to decide whether background is
// allowed on this account.
export function getMe(host: Host): Promise<ApiResult<User>> {
  return request(host, 'GET', '/api/auth/me', isUser);
}

// `ios/SPEC.md` 7.3/7.6: seeds the tracker's pending-visit set at start, and
// again on every return to the foreground.
export function getPendingVisits(host: Host): Promise<ApiResult<PendingVisitsResponse>> {
  return request(host, 'GET', '/api/visits/pending', isPendingVisitsResponse);
}

// `ios/SPEC.md` 7.4: the flush. `Content-Type` is the host's business where
// there is a body (7.2) - this passes the body and adds no header of its
// own, and adds neither `Origin` nor `Cookie`, which are the shell's (5.2,
// 5.3).
export function postSamples(host: Host, samples: Sample[]): Promise<ApiResult<SamplesResponse>> {
  return request(host, 'POST', '/api/samples', isSamplesResponse, JSON.stringify({ samples }));
}

// `ios/SPEC.md` 7.6: fetched lazily, only when the tracker holds a pending
// visit whose bar it cannot already locate. `SPEC.md` 9.5: a 404 here is one
// deliberately identical answer for "no such bar" and "not discovered by
// you" - a real outcome, most likely an admin having hidden the bar, and
// not an error to retry. The caller (B4/B5) decides what to do with
// `notFound`; this file only reports it distinctly.
export function getBar(host: Host, id: number): Promise<ApiResult<Bar>> {
  return request(host, 'GET', `/api/bars/${id}`, isTrackedBar);
}
