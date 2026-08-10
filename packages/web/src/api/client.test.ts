import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, getCity, getFogMask } from './client.js';

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

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
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
