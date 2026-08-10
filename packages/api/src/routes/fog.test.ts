import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '@tipsytrails/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { openDatabase } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { seedCity } from '../db/seed-city.js';
import { loadEnv } from '../env.js';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

// The real committed data/seed/karlsruhe tree, four levels up from this
// file's own directory to the repository root — the same style
// routes/city.test.ts and routes/static-data.test.ts use.
const REAL_SEED_DIR = fileURLToPath(new URL('../../../../data/seed', import.meta.url));

const baseEnv = {
  NODE_ENV: 'test',
  PUBLIC_ORIGIN: 'https://tipsytrails.ahultsch.com',
  DATABASE_PATH: '/tmp/test.db',
  SESSION_SECRET: '0123456789012345678901234567890123',
  SEED_DIR: REAL_SEED_DIR,
};

const validRegisterBody = {
  username: 'trailwalker',
  password: 'correct horse battery staple',
  securityQuestion: 'First pet?',
  securityAnswer: 'Rex',
  ageConfirmed: true,
};

// Karlsruhe Schloss (SPEC.md's own worked example city). Well inside the
// bounding box, and — verified once against the committed grid.bin/
// grid-meta.json — its 100 m reveal circle lands entirely inside a single
// district ("Innenstadt-West"), which keeps the percentage tests below from
// having to handle a reveal straddling a district border.
const SCHLOSS = { lat: 49.0135, lon: 8.4044 };

// Northeast of Bruchsal, well outside Karlsruhe's bounding box
// (48.9400–49.0950 N, 8.2750–8.5600 E — SPEC.md Section 6.2).
const OUTSIDE_BBOX = { lat: 0, lon: 0 };

let dbPath: string;
let db: Database.Database;
let app: FastifyInstance;

function injectWithOrigin(options: InjectOptions): Promise<LightMyRequestResponse> {
  return app.inject({
    ...options,
    headers: { origin: baseEnv.PUBLIC_ORIGIN, ...options.headers },
  });
}

function extractSessionCookie(response: LightMyRequestResponse): string {
  const setCookie = response.headers['set-cookie'];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!cookieHeader) {
    throw new Error('expected a Set-Cookie header');
  }
  return cookieHeader.split(';')[0];
}

async function registerUser(username = validRegisterBody.username): Promise<string> {
  const response = await injectWithOrigin({
    method: 'POST',
    url: '/api/auth/register',
    payload: { ...validRegisterBody, username },
  });
  return extractSessionCookie(response);
}

function goodSample(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    lat: SCHLOSS.lat,
    lon: SCHLOSS.lon,
    accuracy: 10,
    speed: 0,
    timestamp: Date.now(),
    ...overrides,
  };
}

function postSamples(cookie: string, samples: unknown[]): Promise<LightMyRequestResponse> {
  return injectWithOrigin({
    method: 'POST',
    url: '/api/samples',
    headers: { cookie },
    payload: { samples },
  });
}

beforeEach(() => {
  dbPath = join(tmpdir(), `tipsytrails-fog-test-${randomUUID()}.db`);
  db = openDatabase(dbPath);
  runMigrations(db, migrationsDir);
  const env = loadEnv(baseEnv);
  seedCity(db, env);
  app = buildApp(env, db);
});

afterEach(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${dbPath}${suffix}`;
    if (existsSync(file)) {
      rmSync(file);
    }
  }
});

describe('POST /api/samples', () => {
  it('requires a session', async () => {
    const response = await postSamplesUnauthenticated();
    expect(response.statusCode).toBe(401);

    function postSamplesUnauthenticated() {
      return injectWithOrigin({
        method: 'POST',
        url: '/api/samples',
        payload: { samples: [goodSample()] },
      });
    }
  });

  it('reveals roughly a 100 m radius (~13 cells at 50 m, SPEC.md Section 7.3)', async () => {
    const cookie = await registerUser();

    const response = await postSamples(cookie, [goodSample()]);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual({ newCells: expect.any(Number), newBars: [] });
    expect(body.newCells).toBeGreaterThanOrEqual(9);
    expect(body.newCells).toBeLessThanOrEqual(17);
  });

  it('reveals nothing for a sample above FOG_MAX_SPEED_KMH', async () => {
    const cookie = await registerUser();
    // 10 m/s = 36 km/h, above CONFIG.FOG_MAX_SPEED_KMH (30).
    expect(10 * 3.6).toBeGreaterThan(CONFIG.FOG_MAX_SPEED_KMH);

    const response = await postSamples(cookie, [goodSample({ speed: 10 })]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ newCells: 0, newBars: [] });
  });

  it('discards a sample with accuracy worse than FOG_MAX_ACCURACY_M entirely', async () => {
    const cookie = await registerUser();
    const badAccuracy = CONFIG.FOG_MAX_ACCURACY_M + 1;

    const response = await postSamples(cookie, [goodSample({ accuracy: badAccuracy })]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ newCells: 0, newBars: [] });
  });

  it('discards a sample outside the active city bounding box', async () => {
    const cookie = await registerUser();

    const response = await postSamples(cookie, [
      goodSample({ lat: OUTSIDE_BBOX.lat, lon: OUTSIDE_BBOX.lon }),
    ]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ newCells: 0, newBars: [] });
  });

  it('rejects a teleport between two accepted samples', async () => {
    const cookie = await registerUser();
    const first = goodSample({ timestamp: Date.now() });
    const firstResponse = await postSamples(cookie, [first]);
    expect(firstResponse.json().newCells).toBeGreaterThan(0);

    // ~1.4 km from Schloss, posted immediately after — far above
    // SAMPLE_TELEPORT_SPEED_KMH (300) for any realistic elapsed wall time.
    const teleported = goodSample({ lat: 49.02, lon: 8.42, timestamp: Date.now() });
    const secondResponse = await postSamples(cookie, [teleported]);

    expect(secondResponse.statusCode).toBe(200);
    expect(secondResponse.json()).toEqual({ newCells: 0, newBars: [] });
  });

  it('does not double-count revealing the same cell twice', async () => {
    const cookie = await registerUser();

    const first = await postSamples(cookie, [goodSample()]);
    const firstNewCells = first.json().newCells;
    expect(firstNewCells).toBeGreaterThan(0);

    const second = await postSamples(cookie, [goodSample({ timestamp: Date.now() })]);
    expect(second.json()).toEqual({ newCells: 0, newBars: [] });

    const fogResponse = await injectWithOrigin({
      method: 'GET',
      url: '/api/fog',
      headers: { cookie },
    });
    const progress = JSON.parse(fogResponse.headers['x-fog-progress'] as string);
    expect(progress.revealedCells).toBe(firstNewCells);
  });

  it('caps a batch over SAMPLE_MAX_BATCH with a 400', async () => {
    const cookie = await registerUser();
    const samples = Array.from({ length: CONFIG.SAMPLE_MAX_BATCH + 1 }, () => goodSample());

    const response = await postSamples(cookie, samples);

    expect(response.statusCode).toBe(400);
  });

  it('returns 429 once the samples rate limit is exceeded', async () => {
    const cookie = await registerUser();
    const limit = CONFIG.RATE_LIMITS.samples.limit;

    for (let i = 0; i < limit; i++) {
      await postSamples(cookie, []);
    }
    const blocked = await postSamples(cookie, []);

    expect(blocked.statusCode).toBe(429);
  });

  it('fog_daily_progress sums to fog_state.revealed_cells for the user', async () => {
    const cookie = await registerUser();
    await postSamples(cookie, [goodSample()]);

    const userId = db
      .prepare<[string], { id: number }>('SELECT id FROM users WHERE username = ?')
      .get(validRegisterBody.username)!.id;

    const fogState = db
      .prepare<[number], { revealed_cells: number }>(
        'SELECT revealed_cells FROM fog_state WHERE user_id = ?',
      )
      .get(userId)!;

    const dailySum = db
      .prepare<[number], { total: number | null }>(
        'SELECT SUM(revealed_cells) AS total FROM fog_daily_progress WHERE user_id = ?',
      )
      .get(userId)!;

    expect(dailySum.total).toBe(fogState.revealed_cells);
  });

  it('never stores anything resembling the submitted raw coordinates', async () => {
    const cookie = await registerUser();
    await postSamples(cookie, [goodSample(), goodSample({ lat: 49.014, lon: 8.405 })]);

    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all();

    const suspects = [SCHLOSS.lat, SCHLOSS.lon, 49.014, 8.405];

    for (const table of tables) {
      const rows = db.prepare(`SELECT * FROM "${table.name}"`).all() as Record<string, unknown>[];
      for (const row of rows) {
        for (const [column, value] of Object.entries(row)) {
          if (typeof value === 'number') {
            for (const suspect of suspects) {
              expect(
                Math.abs(value - suspect) < 1e-6,
                `${table.name}.${column} = ${value} looks like a raw coordinate (${suspect})`,
              ).toBe(false);
            }
          }
          if (typeof value === 'string') {
            for (const suspect of suspects) {
              expect(
                value.includes(String(suspect)),
                `${table.name}.${column} contains a raw coordinate substring (${suspect})`,
              ).toBe(false);
            }
          }
        }
      }
    }
  });
});

describe('GET /api/fog', () => {
  it('requires a session', async () => {
    const response = await injectWithOrigin({ method: 'GET', url: '/api/fog' });
    expect(response.statusCode).toBe(401);
  });

  it('returns an all-zero mask of the right size for a user who never walked', async () => {
    const cookie = await registerUser();

    const response = await injectWithOrigin({
      method: 'GET',
      url: '/api/fog',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/octet-stream');
    // 417 x 343 cells (SPEC.md Section 6.2), one bit per cell.
    expect(response.rawPayload.length).toBe(Math.ceil((417 * 343) / 8));
    expect(response.rawPayload.every((byte: number) => byte === 0)).toBe(true);

    const progress = JSON.parse(response.headers['x-fog-progress'] as string);
    expect(progress.revealedCells).toBe(0);
    expect(progress.districts).toHaveLength(27);
  });

  it('carries the no-store cache header like every other /api response', async () => {
    const cookie = await registerUser();
    const response = await injectWithOrigin({
      method: 'GET',
      url: '/api/fog',
      headers: { cookie },
    });
    expect(response.headers['cache-control']).toBe('private, no-store');
  });

  it('the mask survives across a fresh app instance on the same database', async () => {
    const cookie = await registerUser();
    const postResponse = await postSamples(cookie, [goodSample()]);
    const revealed = postResponse.json().newCells;
    expect(revealed).toBeGreaterThan(0);

    const env = loadEnv(baseEnv);
    const app2 = buildApp(env, db);
    const response = await app2.inject({
      method: 'GET',
      url: '/api/fog',
      headers: { cookie, origin: baseEnv.PUBLIC_ORIGIN },
    });

    expect(response.statusCode).toBe(200);
    const progress = JSON.parse(response.headers['x-fog-progress'] as string);
    expect(progress.revealedCells).toBe(revealed);
  });
});

describe('GET /api/progress', () => {
  it('requires a session', async () => {
    const response = await injectWithOrigin({ method: 'GET', url: '/api/progress' });
    expect(response.statusCode).toBe(401);
  });

  it('percentages match a hand-computed reference from grid-meta.json', async () => {
    const cookie = await registerUser();
    const postResponse = await postSamples(cookie, [goodSample()]);
    const newCells: number = postResponse.json().newCells;
    expect(newCells).toBeGreaterThan(0);

    const cityResponse = await injectWithOrigin({
      method: 'GET',
      url: '/api/city',
      headers: { cookie },
    });
    const city = cityResponse.json();

    const gridMeta = JSON.parse(
      readFileSync(join(REAL_SEED_DIR, 'karlsruhe', 'grid-meta.json'), 'utf-8'),
    ) as {
      playable_cells: number;
      districts: { name: string; playable_cells: number }[];
    };

    const fogResponse = await injectWithOrigin({
      method: 'GET',
      url: '/api/fog',
      headers: { cookie },
    });
    const fogProgress = JSON.parse(fogResponse.headers['x-fog-progress'] as string) as {
      revealedCells: number;
      districts: { id: number; revealedCells: number }[];
    };
    expect(fogProgress.revealedCells).toBe(newCells);

    const touchedDistrict = fogProgress.districts.find((d) => d.revealedCells > 0);
    expect(touchedDistrict).toBeDefined();
    const districtInCity = city.districts.find((d: { id: number }) => d.id === touchedDistrict!.id);
    expect(districtInCity).toBeDefined();
    const districtMeta = gridMeta.districts.find((d) => d.name === districtInCity.name);
    expect(districtMeta).toBeDefined();

    // Every revealed cell landed in this one district — SCHLOSS's reveal
    // circle is verified (see the SCHLOSS comment above) to fall entirely
    // inside a single district.
    expect(touchedDistrict!.revealedCells).toBe(newCells);

    const expectedCityPercent = (newCells / gridMeta.playable_cells) * 100;
    const expectedDistrictPercent = (newCells / districtMeta!.playable_cells) * 100;

    const progressResponse = await injectWithOrigin({
      method: 'GET',
      url: '/api/progress',
      headers: { cookie },
    });
    const progress = progressResponse.json();

    expect(progress.city.revealedCells).toBe(newCells);
    expect(progress.city.playableCells).toBe(gridMeta.playable_cells);
    expect(progress.city.percent).toBeCloseTo(expectedCityPercent, 10);

    const progressDistrict = progress.districts.find(
      (d: { id: number }) => d.id === touchedDistrict!.id,
    );
    expect(progressDistrict.revealedCells).toBe(newCells);
    expect(progressDistrict.playableCells).toBe(districtMeta!.playable_cells);
    expect(progressDistrict.percent).toBeCloseTo(expectedDistrictPercent, 10);
  });

  it('carries the no-store cache header like every other /api response', async () => {
    const cookie = await registerUser();
    const response = await injectWithOrigin({
      method: 'GET',
      url: '/api/progress',
      headers: { cookie },
    });
    expect(response.headers['cache-control']).toBe('private, no-store');
  });
});
