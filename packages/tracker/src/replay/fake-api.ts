// This is NOT the real API. ios/SPEC.md 13.2's scenarios 1-5 assert against
// SQLite through the real Fastify app, reached with `app.inject` as the
// `Host`'s `fetch` - that half of the harness is not built here (blocked on
// row 14 of "The list for `main`", Section 12). This stub exists only for
// scenarios 6-8, whose assertions are entirely tracker-side (its own
// requests, state and events) and need no server, no database and no
// migration at all.
//
// The idiom below - a plain object read fresh on every call, so a scenario
// can change one field between two requests on the same run - is
// `packages/tracker/src/tracker.test.ts`'s `Scripted`/`fakeHost`, rebuilt
// here as a Vitest-free export; it must not be imported from that test
// file.
import type { Bar, SamplesResponse, VisitSummary } from '../events.js';
import type { HostRequest, HostResponse } from '../host.js';

export function jsonResponse(status: number, body: unknown): HostResponse {
  return { status, headers: {}, body: JSON.stringify(body) };
}

// A valid `packages/tracker/src/api.ts` `User` body - every field `isUser`'s
// guard does not read is a placeholder, matching that file's own "cast, not
// checked" rule for fields nothing in this package reads.
export function validUser(backgroundTrackingConsentedAt: number | null = null): unknown {
  return {
    id: 1,
    username: 'replay',
    avatarSeed: 'seed',
    isAdmin: false,
    isAnonymous: false,
    mustChangePassword: false,
    backgroundTrackingConsentedAt,
  };
}

// A valid `Bar`, as `GET /api/bars/:id` and a flush's `newBars` entries both
// require.
export function validBar(id: number, position: { lat: number; lon: number }): Bar {
  return {
    id,
    districtId: null,
    name: `Bar ${id}`,
    address: null,
    lat: position.lat,
    lon: position.lon,
    source: 'osm',
    discoveredAt: 0,
    mastered: false,
  };
}

// A valid `SamplesResponse` - `rejected` all zero and nothing discovered or
// updated, the shape every scenario overrides only the fields it needs of.
export function validSamplesResponse(overrides: Partial<SamplesResponse> = {}): SamplesResponse {
  return {
    newCells: 0,
    newBars: [],
    visitUpdates: [],
    tooFastToReveal: false,
    rejected: { accuracy: 0, future: 0, stale: 0, outsideCity: 0, tooFast: 0 },
    ...overrides,
  };
}

// A valid `GET /api/visits/pending` body.
export function validPendingVisitsResponse(visits: VisitSummary[] = []): unknown {
  return { visits };
}

// Every field is read fresh on each call (not captured once), so a scenario
// can script a second answer - a 401, a 429, a reduced-accuracy stretch's
// lack of any request at all - between two calls on the same `FakeApi`
// without recreating it.
export interface FakeApiScript {
  me?: HostResponse;
  pendingVisits?: HostResponse;
  bars?: Record<number, HostResponse>;
  samples?: HostResponse;
}

export interface FakeApi {
  fetch(input: HostRequest): Promise<HostResponse>;
}

// Answers the four calls `packages/tracker/src/api.ts` makes -
// `GET /api/auth/me`, `GET /api/visits/pending`, `POST /api/samples` and
// `GET /api/bars/:id` - with bodies that satisfy its guards exactly, unless
// `script` overrides one. An unscripted call to anything else throws, the
// same "unscripted request" rule `tracker.test.ts`'s own fake host applies.
export function createFakeApi(script: FakeApiScript = {}): FakeApi {
  return {
    fetch: async (input) => {
      if (input.method === 'GET' && input.path === '/api/auth/me') {
        return script.me ?? jsonResponse(200, validUser());
      }
      if (input.method === 'GET' && input.path === '/api/visits/pending') {
        return script.pendingVisits ?? jsonResponse(200, validPendingVisitsResponse());
      }
      if (input.method === 'POST' && input.path === '/api/samples') {
        return script.samples ?? jsonResponse(200, validSamplesResponse());
      }
      const barMatch = /^\/api\/bars\/(\d+)$/.exec(input.path);
      if (input.method === 'GET' && barMatch) {
        const id = Number(barMatch[1]);
        const response = script.bars?.[id];
        if (response) {
          return response;
        }
        return jsonResponse(404, { code: 'bar_not_found', message: 'not found' });
      }
      throw new Error(`unscripted request: ${input.method} ${input.path}`);
    },
  };
}
