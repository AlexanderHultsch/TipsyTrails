import { describe, expect, it } from 'vitest';
import { CONFIG } from '@tipsytrails/shared';
import { getBar, getMe, getPendingVisits, postSamples } from './api.js';
import type { Sample, SamplesResponse, VisitSummary } from './events.js';
import type { Host, HostRequest, HostResponse } from './host.js';

// A fixed instant rather than Date.now() - ios/SPEC.md Section 7.2's
// Host.now() is what feeds production code, and these tests never actually
// read it (api.ts takes no clock argument), so it exists only to build a
// fake Host that type-checks against the full interface.
const BASE_NOW_MS = 1_700_000_000_000;

// Section 7.2's fake Host, built here rather than added as a helper to
// host.ts (types.test.ts already shows the shape a bare stub takes). Every
// method not under test is a no-op; `fetch` is the one this file drives.
function fakeHost(fetchImpl: (input: HostRequest) => Promise<HostResponse>): {
  host: Host;
  requests: HostRequest[];
} {
  const requests: HostRequest[] = [];
  const host: Host = {
    now: () => BASE_NOW_MS,
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch: async (input) => {
      requests.push(input);
      return fetchImpl(input);
    },
    configureLocation: () => {},
    requestSignificantChanges: () => {},
    scheduleNotification: () => {},
    cancelNotification: () => {},
    emit: () => {},
    log: () => {},
  };
  return { host, requests };
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HostResponse {
  return { status, headers, body: JSON.stringify(body) };
}

function withField(base: unknown, path: (string | number)[], value: unknown): unknown {
  const clone = structuredClone(base) as Record<string | number, unknown>;
  let cur = clone as Record<string | number, unknown>;
  for (let i = 0; i < path.length - 1; i += 1) {
    cur = cur[path[i]] as Record<string | number, unknown>;
  }
  cur[path[path.length - 1]] = value;
  return clone;
}

function withoutField(base: unknown, path: (string | number)[]): unknown {
  const clone = structuredClone(base) as Record<string | number, unknown>;
  let cur = clone as Record<string | number, unknown>;
  for (let i = 0; i < path.length - 1; i += 1) {
    cur = cur[path[i]] as Record<string | number, unknown>;
  }
  delete cur[path[path.length - 1]];
  return clone;
}

const validUser = {
  id: 1,
  username: 'alex',
  avatarSeed: 'seed',
  isAdmin: false,
  isAnonymous: false,
  mustChangePassword: false,
  backgroundTrackingConsentedAt: 1_699_000_000,
};

const validVisit: VisitSummary = {
  id: 5,
  barId: 2,
  barName: 'Vogelbräu',
  startedAt: BASE_NOW_MS,
  lastSampleAt: BASE_NOW_MS,
  onsiteSamples: 1,
  confirmedS: 0,
  remainingS: 1200,
  status: 'pending',
};

const validPendingVisits = { visits: [validVisit] };

const validSamplesResponse: SamplesResponse = {
  newCells: 3,
  newBars: [
    {
      id: 10,
      districtId: null,
      name: 'Vogelbräu',
      address: null,
      lat: 49.0135,
      lon: 8.4044,
      source: 'osm',
      discoveredAt: BASE_NOW_MS,
      mastered: false,
    },
  ],
  visitUpdates: [validVisit],
  tooFastToReveal: false,
  rejected: { accuracy: 0, future: 0, stale: 0, outsideCity: 0, tooFast: 0 },
};

const validBar = {
  id: 10,
  districtId: null,
  name: 'Vogelbräu',
  address: null,
  lat: 49.0135,
  lon: 8.4044,
  source: 'osm',
  discoveredAt: BASE_NOW_MS,
  mastered: false,
};

const sample: Sample = {
  lat: 49.0135,
  lon: 8.4044,
  accuracy: 10,
  speed: null,
  timestamp: BASE_NOW_MS,
};

describe('getMe', () => {
  it('returns ok with the parsed User on the happy path, requesting GET /api/auth/me', async () => {
    const { host, requests } = fakeHost(async () => jsonResponse(200, validUser));

    const result = await getMe(host);

    expect(result).toEqual({ outcome: 'ok', value: validUser });
    expect(requests).toEqual([{ method: 'GET', path: '/api/auth/me' }]);
  });

  it('returns unauthenticated on 401', async () => {
    const { host } = fakeHost(async () =>
      jsonResponse(401, { code: 'unauthenticated', message: 'nope' }),
    );

    expect(await getMe(host)).toEqual({ outcome: 'unauthenticated' });
  });

  it('returns passwordChangeRequired on 403 with that code', async () => {
    const { host } = fakeHost(async () =>
      jsonResponse(403, { code: 'password_change_required', message: 'change it' }),
    );

    expect(await getMe(host)).toEqual({ outcome: 'passwordChangeRequired' });
  });

  it('returns httpError on 403 with a different code', async () => {
    const { host } = fakeHost(async () => jsonResponse(403, { code: 'forbidden', message: 'no' }));

    expect(await getMe(host)).toEqual({ outcome: 'httpError', status: 403 });
  });

  it('returns rateLimited with the Retry-After header converted to milliseconds', async () => {
    const { host } = fakeHost(async () =>
      jsonResponse(429, { code: 'rate_limited', message: 'slow down' }, { 'Retry-After': '7' }),
    );

    expect(await getMe(host)).toEqual({ outcome: 'rateLimited', retryAfterMs: 7000 });
  });

  it('falls back to TRACKER_FLUSH_BACKOFF_BASE_MS when Retry-After is missing', async () => {
    const { host } = fakeHost(async () =>
      jsonResponse(429, { code: 'rate_limited', message: 'slow down' }),
    );

    expect(await getMe(host)).toEqual({
      outcome: 'rateLimited',
      retryAfterMs: CONFIG.TRACKER_FLUSH_BACKOFF_BASE_MS,
    });
  });

  it('falls back to TRACKER_FLUSH_BACKOFF_BASE_MS when Retry-After is malformed, never NaN', async () => {
    const { host } = fakeHost(async () =>
      jsonResponse(429, { code: 'rate_limited', message: 'slow down' }, { 'Retry-After': 'soon' }),
    );

    const result = await getMe(host);
    expect(result).toEqual({
      outcome: 'rateLimited',
      retryAfterMs: CONFIG.TRACKER_FLUSH_BACKOFF_BASE_MS,
    });
    if (result.outcome === 'rateLimited') {
      expect(Number.isNaN(result.retryAfterMs)).toBe(false);
    }
  });

  // Number('') is 0, not NaN, so an empty header would otherwise pass the
  // finite/non-negative check and hand back 0 ms - a hot loop against a
  // 429, which rate limiting exists to make unprofitable.
  it('floors to TRACKER_FLUSH_BACKOFF_BASE_MS when Retry-After is empty', async () => {
    const { host } = fakeHost(async () =>
      jsonResponse(429, { code: 'rate_limited', message: 'slow down' }, { 'Retry-After': '' }),
    );

    expect(await getMe(host)).toEqual({
      outcome: 'rateLimited',
      retryAfterMs: CONFIG.TRACKER_FLUSH_BACKOFF_BASE_MS,
    });
  });

  // A literal `Retry-After: 0` is finite and non-negative, so it is not the
  // missing/malformed fallback above - it is the floor's own case: a
  // server-sent wait too short to be a real answer must not become the
  // client's retry interval verbatim.
  it('floors to TRACKER_FLUSH_BACKOFF_BASE_MS when Retry-After is 0', async () => {
    const { host } = fakeHost(async () =>
      jsonResponse(429, { code: 'rate_limited', message: 'slow down' }, { 'Retry-After': '0' }),
    );

    expect(await getMe(host)).toEqual({
      outcome: 'rateLimited',
      retryAfterMs: CONFIG.TRACKER_FLUSH_BACKOFF_BASE_MS,
    });
  });

  it('returns httpError for an ordinary non-2xx, non-special status', async () => {
    const { host } = fakeHost(async () =>
      jsonResponse(500, { code: 'unknown_error', message: 'oops' }),
    );

    expect(await getMe(host)).toEqual({ outcome: 'httpError', status: 500 });
  });

  it('returns transportError when Host.fetch throws', async () => {
    const { host } = fakeHost(async () => {
      throw new Error('no connectivity');
    });

    const result = await getMe(host);
    expect(result.outcome).toBe('transportError');
    if (result.outcome === 'transportError') {
      expect(result.detail).toContain('no connectivity');
    }
  });

  it('returns invalidResponse when the body is not JSON at all', async () => {
    const { host } = fakeHost(async () => ({ status: 200, headers: {}, body: 'not json' }));

    expect((await getMe(host)).outcome).toBe('invalidResponse');
  });

  it('returns invalidResponse when backgroundTrackingConsentedAt is missing', async () => {
    const body = withoutField(validUser, ['backgroundTrackingConsentedAt']);
    const { host } = fakeHost(async () => jsonResponse(200, body));

    expect((await getMe(host)).outcome).toBe('invalidResponse');
  });

  it('returns invalidResponse when backgroundTrackingConsentedAt is the wrong type', async () => {
    const body = withField(validUser, ['backgroundTrackingConsentedAt'], 'not-a-number');
    const { host } = fakeHost(async () => jsonResponse(200, body));

    expect((await getMe(host)).outcome).toBe('invalidResponse');
  });

  it('accepts backgroundTrackingConsentedAt: null', async () => {
    const body = withField(validUser, ['backgroundTrackingConsentedAt'], null);
    const { host } = fakeHost(async () => jsonResponse(200, body));

    expect((await getMe(host)).outcome).toBe('ok');
  });
});

describe('getPendingVisits', () => {
  it('returns ok with the parsed visits on the happy path, requesting GET /api/visits/pending', async () => {
    const { host, requests } = fakeHost(async () => jsonResponse(200, validPendingVisits));

    const result = await getPendingVisits(host);

    expect(result).toEqual({ outcome: 'ok', value: validPendingVisits });
    expect(requests).toEqual([{ method: 'GET', path: '/api/visits/pending' }]);
  });

  it.each([
    ['visits[0].id missing', ['visits', 0, 'id']],
    ['visits[0].barId missing', ['visits', 0, 'barId']],
    ['visits[0].startedAt missing', ['visits', 0, 'startedAt']],
    ['visits[0].status missing', ['visits', 0, 'status']],
  ])('returns invalidResponse when %s', async (_label, path) => {
    const body = withoutField(validPendingVisits, path as (string | number)[]);
    const { host } = fakeHost(async () => jsonResponse(200, body));

    expect((await getPendingVisits(host)).outcome).toBe('invalidResponse');
  });

  it.each([
    ['visits[0].id', ['visits', 0, 'id'], 'not-a-number'],
    ['visits[0].barId', ['visits', 0, 'barId'], 'not-a-number'],
    ['visits[0].startedAt', ['visits', 0, 'startedAt'], 'not-a-number'],
    ['visits[0].status', ['visits', 0, 'status'], 'unknown-status'],
  ])('returns invalidResponse when %s is the wrong type', async (_label, path, badValue) => {
    const body = withField(validPendingVisits, path as (string | number)[], badValue);
    const { host } = fakeHost(async () => jsonResponse(200, body));

    expect((await getPendingVisits(host)).outcome).toBe('invalidResponse');
  });
});

describe('postSamples', () => {
  it('returns ok with the parsed response on the happy path, requesting POST /api/samples with the body', async () => {
    const { host, requests } = fakeHost(async () => jsonResponse(200, validSamplesResponse));

    const result = await postSamples(host, [sample]);

    expect(result).toEqual({ outcome: 'ok', value: validSamplesResponse });
    expect(requests).toEqual([
      { method: 'POST', path: '/api/samples', body: JSON.stringify({ samples: [sample] }) },
    ]);
  });

  it('returns passwordChangeRequired on 403 with that code, for a body-bearing request too', async () => {
    const { host } = fakeHost(async () =>
      jsonResponse(403, { code: 'password_change_required', message: 'change it' }),
    );

    expect(await postSamples(host, [sample])).toEqual({ outcome: 'passwordChangeRequired' });
  });

  it.each([
    ['newCells', ['newCells']],
    ['tooFastToReveal', ['tooFastToReveal']],
    ['rejected.accuracy', ['rejected', 'accuracy']],
    ['rejected.future', ['rejected', 'future']],
    ['rejected.stale', ['rejected', 'stale']],
    ['rejected.outsideCity', ['rejected', 'outsideCity']],
    ['rejected.tooFast', ['rejected', 'tooFast']],
    ['newBars[0].id', ['newBars', 0, 'id']],
    ['newBars[0].lat', ['newBars', 0, 'lat']],
    ['newBars[0].lon', ['newBars', 0, 'lon']],
    ['visitUpdates[0].id', ['visitUpdates', 0, 'id']],
    ['visitUpdates[0].barId', ['visitUpdates', 0, 'barId']],
    ['visitUpdates[0].startedAt', ['visitUpdates', 0, 'startedAt']],
    ['visitUpdates[0].status', ['visitUpdates', 0, 'status']],
  ])('returns invalidResponse when %s is missing', async (_label, path) => {
    const body = withoutField(validSamplesResponse, path as (string | number)[]);
    const { host } = fakeHost(async () => jsonResponse(200, body));

    expect((await postSamples(host, [sample])).outcome).toBe('invalidResponse');
  });

  it.each([
    ['newCells', ['newCells'], 'not-a-number'],
    ['tooFastToReveal', ['tooFastToReveal'], 'not-a-boolean'],
    ['rejected.accuracy', ['rejected', 'accuracy'], 'x'],
    ['rejected.future', ['rejected', 'future'], 'x'],
    ['rejected.stale', ['rejected', 'stale'], 'x'],
    ['rejected.outsideCity', ['rejected', 'outsideCity'], 'x'],
    ['rejected.tooFast', ['rejected', 'tooFast'], 'x'],
    ['newBars[0].id', ['newBars', 0, 'id'], 'x'],
    ['newBars[0].lat', ['newBars', 0, 'lat'], 'x'],
    ['newBars[0].lon', ['newBars', 0, 'lon'], 'x'],
    ['visitUpdates[0].id', ['visitUpdates', 0, 'id'], 'x'],
    ['visitUpdates[0].barId', ['visitUpdates', 0, 'barId'], 'x'],
    ['visitUpdates[0].startedAt', ['visitUpdates', 0, 'startedAt'], 'x'],
    ['visitUpdates[0].status', ['visitUpdates', 0, 'status'], 'unknown-status'],
  ])('returns invalidResponse when %s is the wrong type', async (_label, path, badValue) => {
    const body = withField(validSamplesResponse, path as (string | number)[], badValue);
    const { host } = fakeHost(async () => jsonResponse(200, body));

    expect((await postSamples(host, [sample])).outcome).toBe('invalidResponse');
  });

  it('accepts newCells: 0 and an empty newBars/visitUpdates', async () => {
    const body: SamplesResponse = {
      ...validSamplesResponse,
      newCells: 0,
      newBars: [],
      visitUpdates: [],
    };
    const { host } = fakeHost(async () => jsonResponse(200, body));

    expect((await postSamples(host, [sample])).outcome).toBe('ok');
  });
});

describe('getBar', () => {
  it('returns ok with the parsed Bar on the happy path, requesting GET /api/bars/:id', async () => {
    const { host, requests } = fakeHost(async () => jsonResponse(200, validBar));

    const result = await getBar(host, 10);

    expect(result).toEqual({ outcome: 'ok', value: validBar });
    expect(requests).toEqual([{ method: 'GET', path: '/api/bars/10' }]);
  });

  it('returns notFound on 404 - the identical answer for "does not exist" and "not discovered by you"', async () => {
    const { host } = fakeHost(async () =>
      jsonResponse(404, { code: 'bar_not_found', message: 'not found' }),
    );

    expect(await getBar(host, 999)).toEqual({ outcome: 'notFound' });
  });

  it.each([
    ['id missing', ['id']],
    ['lat missing', ['lat']],
    ['lon missing', ['lon']],
  ])('returns invalidResponse when %s', async (_label, path) => {
    const body = withoutField(validBar, path as (string | number)[]);
    const { host } = fakeHost(async () => jsonResponse(200, body));

    expect((await getBar(host, 10)).outcome).toBe('invalidResponse');
  });

  it.each([
    ['id', ['id'], 'x'],
    ['lat', ['lat'], 'x'],
    ['lon', ['lon'], 'x'],
  ])('returns invalidResponse when %s is the wrong type', async (_label, path, badValue) => {
    const body = withField(validBar, path as (string | number)[], badValue);
    const { host } = fakeHost(async () => jsonResponse(200, body));

    expect((await getBar(host, 10)).outcome).toBe('invalidResponse');
  });
});
