import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  cancelVisit,
  deleteAdminBar,
  errorMessage,
  getBars,
  getCity,
  getFogMask,
  getLeaderboard,
  getPendingVisits,
  getProgress,
  getVapidPublicKey,
  logout,
  postSamples,
  subscribePush,
  unsubscribePush,
} from './client.js';

function stubFetchOnce(response: Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response),
  );
}

function octetResponse(
  status: number,
  body: Uint8Array,
  headers: Record<string, string>,
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    json: async () => JSON.parse(new TextDecoder().decode(body)),
  } as unknown as Response;
}

// `raw` overrides the serialisation for the one case JSON.stringify cannot
// produce: a number literal too large to round-trip, which the wire can
// legally carry and JSON.parse turns into Infinity.
function jsonResponse(status: number, body: unknown, raw?: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => raw ?? JSON.stringify(body),
  } as unknown as Response;
}

describe('getFogMask', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses the raw octet-stream body into a Uint8Array and the header into progress', () => {
    const mask = new Uint8Array([0b0000_0101, 0b1111_0000]);
    stubFetchOnce(
      octetResponse(200, mask, {
        'Content-Type': 'application/octet-stream',
        'X-Fog-Progress': JSON.stringify({
          revealedCells: 3,
          playableCells: 100,
          districts: [{ id: 1, revealedCells: 3 }],
        }),
      }),
    );

    return getFogMask().then((result) => {
      expect(Array.from(result.mask)).toEqual([0b0000_0101, 0b1111_0000]);
      expect(result.progress).toEqual({
        revealedCells: 3,
        playableCells: 100,
        districts: [{ id: 1, revealedCells: 3 }],
      });
    });
  });

  it('falls back to zeroed progress when the header is absent', async () => {
    const mask = new Uint8Array([0xff]);
    stubFetchOnce(octetResponse(200, mask, {}));

    const result = await getFogMask();
    expect(result.progress).toEqual({ revealedCells: 0, playableCells: 0, districts: [] });
  });

  it('surfaces a server error as an ApiError with the response code and message', async () => {
    stubFetchOnce(
      jsonResponse(503, { code: 'grid_unavailable', message: 'The district grid is not loaded.' }),
    );

    await expect(getFogMask()).rejects.toMatchObject({
      code: 'grid_unavailable',
      message: 'The district grid is not loaded.',
    });
  });

  it('wraps a network failure as an ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    await expect(getFogMask()).rejects.toBeInstanceOf(ApiError);
  });
});

describe('getCity', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses the JSON city metadata response', async () => {
    stubFetchOnce(
      jsonResponse(200, {
        slug: 'karlsruhe',
        name: 'Karlsruhe',
        originLat: 48.94,
        originLon: 8.275,
        gridWidth: 417,
        gridHeight: 343,
        cellSizeM: 50,
        playableCells: 100000,
        districts: [],
      }),
    );

    const city = await getCity();
    expect(city.gridWidth).toBe(417);
    expect(city.gridHeight).toBe(343);
  });
});

describe('getVapidPublicKey', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null when the server has push disabled', async () => {
    stubFetchOnce(jsonResponse(200, { publicKey: null }));

    expect(await getVapidPublicKey()).toEqual({ publicKey: null });
  });

  it('returns the configured public key', async () => {
    stubFetchOnce(jsonResponse(200, { publicKey: 'abc' }));

    expect(await getVapidPublicKey()).toEqual({ publicKey: 'abc' });
  });
});

describe('subscribePush / unsubscribePush', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the subscription payload to POST /api/push/subscribe', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await subscribePush({
      endpoint: 'https://push.example/abc',
      keys: { p256dh: 'p', auth: 'a' },
    });

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/push/subscribe');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      endpoint: 'https://push.example/abc',
      keys: { p256dh: 'p', auth: 'a' },
    });
  });

  it('sends the endpoint to DELETE /api/push/subscribe', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await unsubscribePush({ endpoint: 'https://push.example/abc' });

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/push/subscribe');
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(init.body as string)).toEqual({ endpoint: 'https://push.example/abc' });
  });
});

// The client-side half of the FST_ERR_CTP_EMPTY_JSON_BODY defect that made
// cancelling a visit fail on every attempt from the day it shipped.
// `request()` used to set `Content-Type: application/json` on every call
// regardless of whether it had anything to send, and Fastify's JSON body
// parser rejects a request that declares that content type and then sends
// zero bytes - a 400, before any route handler runs. Every bodyless
// state-changing call in this file was therefore dead on arrival, and the
// calls that do send a body were fine, which is why check-in worked and
// cancel never did.
//
// These tests pin the header. They are deliberately not the whole defence:
// they re-state the implementation and would pass against any parser at all.
// The test that would actually have caught this puts a real Fastify instance
// behind a bodyless cancel and lives in
// packages/api/src/routes/visits.test.ts - every test in this package stubs
// `fetch`, so no test here can ever see a body parser reject anything.
describe('request: Content-Type is sent only when there is a body', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubOk() {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function headersOf(fetchMock: ReturnType<typeof stubOk>): Record<string, string> {
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return (init.headers ?? {}) as Record<string, string>;
  }

  // Named one by one rather than looped, so a failure says which call broke.
  it('sends no Content-Type for POST /api/visits/:id/cancel', async () => {
    const fetchMock = stubOk();
    await cancelVisit(77);
    expect(headersOf(fetchMock)['Content-Type']).toBeUndefined();
  });

  it('sends no Content-Type for POST /api/auth/logout', async () => {
    const fetchMock = stubOk();
    await logout();
    expect(headersOf(fetchMock)['Content-Type']).toBeUndefined();
  });

  it('sends no Content-Type for DELETE /api/admin/bars/:id', async () => {
    const fetchMock = stubOk();
    await deleteAdminBar(10);
    expect(headersOf(fetchMock)['Content-Type']).toBeUndefined();
  });

  // The other side of the same condition: a call that does send a body must
  // still declare it, or every write in the app breaks instead.
  it('still sends Content-Type when there is a body', async () => {
    const fetchMock = stubOk();
    await subscribePush({ endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } });
    expect(headersOf(fetchMock)['Content-Type']).toBe('application/json');
  });
});

// SPEC.md Section 9.6 / Open Item O18. `request` takes an optional validator
// and four responses pass one; everything else is still cast, deliberately.
// These tests are about the mechanism - that a rejection is an ordinary
// ApiError, that it reaches `errorMessage`, and that nothing else moved. What
// the predicates themselves accept is response-guards.test.ts's subject, and
// what the *screens* then do is App.test.tsx's and App.checkin.test.tsx's.
describe('request: response validation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const goodProgress = {
    city: {
      revealedCells: 125,
      playableCells: 1000,
      percent: 12.5,
      barsDiscovered: 24,
      barsMastered: 7,
    },
    districts: [{ id: 1, name: 'Innenstadt', revealedCells: 3, playableCells: 100, percent: 3 }],
  };

  it('passes a well-formed response through unchanged', async () => {
    stubFetchOnce(jsonResponse(200, goodProgress));
    expect(await getProgress()).toEqual(goodProgress);
  });

  it('rejects a 200 whose body is missing a field a screen renders', async () => {
    const body = structuredClone(goodProgress) as { city: Record<string, unknown> };
    delete body.city.percent;
    stubFetchOnce(jsonResponse(200, body));

    await expect(getProgress()).rejects.toMatchObject({ code: 'invalid_response', status: 200 });
  });

  // The status is the response's own and not an invented 4xx: tracking/
  // useVisits.ts reads a 404 on the cancel path as "this visit is not pending
  // any more" and would draw exactly the wrong conclusion from a synthetic
  // one.
  it('fails as an ApiError, so every screen renders it through errorMessage', async () => {
    stubFetchOnce(jsonResponse(200, { city: {}, districts: [] }));

    const err = await getProgress().catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(ApiError);
    expect(errorMessage(err)).toContain('Close and reopen Tipsy Trails');
    // Not the generic fallback errorMessage uses for anything that is not an
    // ApiError - if this ever regressed to that, the wording above would be
    // the first thing to change.
    expect(errorMessage(err)).not.toBe('Something went wrong. Please try again.');
  });

  // THE MISTAKE THIS TEST EXISTS FOR: a validator written as
  // `typeof value === 'number'`. `1e999` is a JSON number literal - the wire
  // can carry it, `JSON.parse` turns it into `Infinity`, `typeof` says
  // 'number', and `(Infinity).toFixed(1)` renders "Infinity%" on the city
  // overview. Only `Number.isFinite` catches it. Its sibling `NaN` cannot be
  // written in JSON at all, so it is caught directly in
  // response-guards.test.ts rather than here.
  it('rejects a non-finite number that arrived as a legal JSON literal', async () => {
    stubFetchOnce(
      jsonResponse(
        200,
        undefined,
        '{"city":{"percent":1e999,"barsDiscovered":0,"barsMastered":0},"districts":[]}',
      ),
    );

    await expect(getProgress()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('rejects a pending-visit list carrying a status this build does not know', async () => {
    stubFetchOnce(
      jsonResponse(200, {
        visits: [
          {
            id: 1,
            barId: 1,
            barName: 'The Fox',
            startedAt: 0,
            lastSampleAt: 0,
            onsiteSamples: 1,
            confirmedS: 60,
            remainingS: 1140,
            status: 'in_progress',
          },
        ],
      }),
    );

    await expect(getPendingVisits()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('rejects a samples response whose visitUpdates went missing', async () => {
    stubFetchOnce(jsonResponse(200, { newCells: 0, newBars: [], tooFastToReveal: false }));

    await expect(postSamples([])).rejects.toMatchObject({ code: 'invalid_response' });
  });

  // The optional argument must not have changed anything for the routes that
  // did not opt in. These bodies are nonsense for their declared types and
  // must still resolve, exactly as `body as T` always let them - the whole
  // point of keeping the scope narrow is that the rest of the client is
  // untouched, not quietly stricter.
  it('leaves every route without a validator casting exactly as before', async () => {
    stubFetchOnce(jsonResponse(200, { nothing: 'like a BarsResponse' }));
    expect(await getBars()).toEqual({ nothing: 'like a BarsResponse' });

    stubFetchOnce(jsonResponse(200, { entries: 'not an array' }));
    expect(await getLeaderboard({ metric: 'area', period: 'all', page: 1 })).toEqual({
      entries: 'not an array',
    });

    // The same VisitSummary shape two validated calls check, on the one call
    // that discards it - see the note on cancelVisit in client.ts.
    stubFetchOnce(jsonResponse(200, {}));
    expect(await cancelVisit(7)).toEqual({});
  });
});
