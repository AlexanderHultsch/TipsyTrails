import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG, toCell, type GridParams } from '@tipsytrails/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { openDatabase } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { seedBars } from '../db/seed-bars.js';
import { seedCity } from '../db/seed-city.js';
import { loadEnv } from '../env.js';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

// Same real committed trees fog.test.ts and seed-city.test.ts reach, copied
// into a temp directory per test so a synthetic bars.json can be dropped
// alongside the real grid.bin/grid-meta.json without ever writing
// data/seed/karlsruhe/bars.json itself.
const REAL_DATA_DIR = fileURLToPath(new URL('../../../../data', import.meta.url));
const REAL_SEED_DIR = join(REAL_DATA_DIR, 'seed');
const REAL_CITIES_DIR = join(REAL_DATA_DIR, 'cities');

const REAL_CITY_CONFIG = JSON.parse(
  readFileSync(join(REAL_CITIES_DIR, 'karlsruhe.json'), 'utf-8'),
) as { cell_size_m: number; bounding_box: { south: number; west: number } };
const REAL_GRID_META = JSON.parse(
  readFileSync(join(REAL_SEED_DIR, 'karlsruhe', 'grid-meta.json'), 'utf-8'),
) as { grid_width: number; grid_height: number };

const GRID_PARAMS: GridParams = {
  origin_lat: REAL_CITY_CONFIG.bounding_box.south,
  origin_lon: REAL_CITY_CONFIG.bounding_box.west,
  grid_width: REAL_GRID_META.grid_width,
  grid_height: REAL_GRID_META.grid_height,
  cell_size_m: REAL_CITY_CONFIG.cell_size_m,
};

// Karlsruhe Schloss (SPEC.md's own worked example, also used by
// routes/fog.test.ts): well inside the bounding box, in a single district.
const SCHLOSS = { lat: 49.0135, lon: 8.4044 };
const SCHLOSS_CELL_INDEX = toCell(SCHLOSS.lat, SCHLOSS.lon, GRID_PARAMS);
if (SCHLOSS_CELL_INDEX === null) {
  throw new Error('SCHLOSS is expected to fall inside the committed Karlsruhe grid');
}

// Local reimplementation of SPEC.md Section 6.1's projection constants
// (mirrored, with the same values, in packages/shared/src/grid.ts — not
// exported from the package's public entry point, so a fixture-only offset
// helper reimplements it here rather than reaching past that boundary).
// Used to place samples a precise number of metres from SCHLOSS along a
// diagonal bearing, so a wrong-radius or a mis-scaled-longitude bug in the
// discovery check would show up as a wrong pass/fail, not just a
// latitude-only check would.
const M_PER_DEG_LAT = 110574;
function mPerDegLon(lat: number): number {
  return 111320 * Math.cos((lat * Math.PI) / 180);
}
function offsetMeters(
  base: { lat: number; lon: number },
  northM: number,
  eastM: number,
): { lat: number; lon: number } {
  return {
    lat: base.lat + northM / M_PER_DEG_LAT,
    lon: base.lon + eastM / mPerDegLon(base.lat),
  };
}
function diagonalOffset(base: { lat: number; lon: number }, distanceM: number) {
  const component = distanceM / Math.SQRT2;
  return offsetMeters(base, component, component);
}

const baseEnv = {
  NODE_ENV: 'test',
  PUBLIC_ORIGIN: 'https://tipsytrails.ahultsch.com',
  DATABASE_PATH: '/tmp/test.db',
  SESSION_SECRET: '0123456789012345678901234567890123',
};

const validRegisterBody = {
  password: 'correct horse battery staple',
  securityQuestion: 'First pet?',
  securityAnswer: 'Rex',
  ageConfirmed: true,
};

let dbPath: string;
let db: Database.Database;
let app: FastifyInstance;
let tempRoot: string;
let tempSeedDir: string;

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

async function registerUser(username: string): Promise<string> {
  const response = await injectWithOrigin({
    method: 'POST',
    url: '/api/auth/register',
    payload: { ...validRegisterBody, username },
  });
  return extractSessionCookie(response);
}

function sample(overrides: Partial<Record<string, unknown>> = {}) {
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

function writeBarsFixture(
  bars: { osm_id: string; name: string; lat: number; lon: number }[],
): void {
  writeFileSync(
    join(tempSeedDir, 'karlsruhe', 'bars.json'),
    JSON.stringify(
      bars.map((bar) => ({
        osm_id: bar.osm_id,
        name: bar.name,
        address: null,
        lat: bar.lat,
        lon: bar.lon,
        cell_index: SCHLOSS_CELL_INDEX,
        source: 'osm',
      })),
    ),
  );
}

function insertHiddenBar(): number {
  const cityId = db.prepare<[], { id: number }>('SELECT id FROM cities LIMIT 1').get()!.id;
  const now = Math.floor(Date.now() / 1000);
  const result = db
    .prepare(
      `INSERT INTO bars (city_id, district_id, name, address, lat, lon, cell_index, source, osm_id, status, created_at)
       VALUES (?, NULL, ?, NULL, ?, ?, ?, 'osm', ?, 'hidden', ?)`,
    )
    .run(
      cityId,
      'Hidden Dive Bar',
      SCHLOSS.lat,
      SCHLOSS.lon,
      SCHLOSS_CELL_INDEX,
      'node/hidden',
      now,
    );
  return Number(result.lastInsertRowid);
}

beforeEach(() => {
  tempRoot = join(tmpdir(), `tipsytrails-bars-test-fixture-${randomUUID()}`);
  cpSync(REAL_CITIES_DIR, join(tempRoot, 'cities'), { recursive: true });
  cpSync(join(REAL_SEED_DIR, 'karlsruhe'), join(tempRoot, 'seed', 'karlsruhe'), {
    recursive: true,
  });
  tempSeedDir = join(tempRoot, 'seed');
  writeBarsFixture([{ osm_id: 'node/1', name: 'Zum Schlossgarten', ...SCHLOSS }]);

  dbPath = join(tmpdir(), `tipsytrails-bars-test-${randomUUID()}.db`);
  db = openDatabase(dbPath);
  runMigrations(db, migrationsDir);
  const env = loadEnv({ ...baseEnv, SEED_DIR: tempSeedDir });
  seedCity(db, env);
  seedBars(db, env);
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
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('bar discovery via POST /api/samples', () => {
  it('creates a discovery and reports it in newBars for a sample within BAR_DISCOVERY_RADIUS_M', async () => {
    const cookie = await registerUser('walker');
    const within = diagonalOffset(SCHLOSS, 95);
    expect(95).toBeLessThan(CONFIG.BAR_DISCOVERY_RADIUS_M);

    const response = await postSamples(cookie, [sample({ ...within })]);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.newBars).toHaveLength(1);
    expect(body.newBars[0]).toMatchObject({ name: 'Zum Schlossgarten', source: 'osm' });

    const userId = db
      .prepare<[string], { id: number }>('SELECT id FROM users WHERE username = ?')
      .get('walker')!.id;
    const discoveries = db
      .prepare<[number], { bar_id: number }>('SELECT bar_id FROM bar_discoveries WHERE user_id = ?')
      .all(userId);
    expect(discoveries).toHaveLength(1);
  });

  it('reports no bar again once already discovered', async () => {
    const cookie = await registerUser('walker');
    const within = diagonalOffset(SCHLOSS, 95);

    const first = await postSamples(cookie, [sample({ ...within })]);
    expect(first.json().newBars).toHaveLength(1);

    const second = await postSamples(cookie, [sample({ ...within, timestamp: Date.now() })]);
    expect(second.json().newBars).toEqual([]);
  });

  it('discovers nothing for a sample just outside BAR_DISCOVERY_RADIUS_M', async () => {
    const cookie = await registerUser('walker');
    const outside = diagonalOffset(SCHLOSS, 105);
    expect(105).toBeGreaterThan(CONFIG.BAR_DISCOVERY_RADIUS_M);

    const response = await postSamples(cookie, [sample({ ...outside })]);

    expect(response.statusCode).toBe(200);
    expect(response.json().newBars).toEqual([]);

    const discoveries = db
      .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM bar_discoveries')
      .get();
    expect(discoveries?.count).toBe(0);
  });

  it('discovers a bar in a cell the user has never revealed (independent of fog state)', async () => {
    const cookie = await registerUser('walker');
    // 20 m/s = 72 km/h, above CONFIG.FOG_MAX_SPEED_KMH (30): the sample is
    // still accepted (well under the teleport guard), but reveals no fog.
    expect(20 * 3.6).toBeGreaterThan(CONFIG.FOG_MAX_SPEED_KMH);

    const response = await postSamples(cookie, [sample({ speed: 20 })]);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.newCells).toBe(0);
    expect(body.newBars).toHaveLength(1);

    const fogRows = db
      .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM fog_state')
      .get();
    expect(fogRows?.count).toBe(0);

    const discoveries = db
      .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM bar_discoveries')
      .get();
    expect(discoveries?.count).toBe(1);
  });

  it('never discovers a hidden bar', async () => {
    insertHiddenBar();
    const cookie = await registerUser('walker');

    const response = await postSamples(cookie, [sample()]);

    expect(response.statusCode).toBe(200);
    // The only active bar (Zum Schlossgarten) is discovered; the hidden one is not.
    expect(response.json().newBars).toHaveLength(1);
    expect(response.json().newBars[0].name).toBe('Zum Schlossgarten');

    const discoveries = db
      .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM bar_discoveries')
      .get();
    expect(discoveries?.count).toBe(1);
  });
});

describe('GET /api/bars', () => {
  it('requires a session', async () => {
    const response = await injectWithOrigin({ method: 'GET', url: '/api/bars' });
    expect(response.statusCode).toBe(401);
  });

  it('returns only bars discovered by the requesting user, and a second user sees their own', async () => {
    const cookieA = await registerUser('alice');
    const cookieB = await registerUser('bob');

    await postSamples(cookieA, [sample()]);

    const aliceResponse = await injectWithOrigin({
      method: 'GET',
      url: '/api/bars',
      headers: { cookie: cookieA },
    });
    expect(aliceResponse.json().bars).toHaveLength(1);
    expect(aliceResponse.json().bars[0].name).toBe('Zum Schlossgarten');

    const bobResponseBefore = await injectWithOrigin({
      method: 'GET',
      url: '/api/bars',
      headers: { cookie: cookieB },
    });
    expect(bobResponseBefore.json().bars).toEqual([]);

    await postSamples(cookieB, [sample()]);
    const bobResponseAfter = await injectWithOrigin({
      method: 'GET',
      url: '/api/bars',
      headers: { cookie: cookieB },
    });
    expect(bobResponseAfter.json().bars).toHaveLength(1);
    expect(bobResponseAfter.json().bars[0].name).toBe('Zum Schlossgarten');
  });
});

describe('GET /api/bars/:id', () => {
  it('requires a session', async () => {
    const response = await injectWithOrigin({ method: 'GET', url: '/api/bars/1' });
    expect(response.statusCode).toBe(401);
  });

  it('returns the bar once discovered', async () => {
    const cookie = await registerUser('walker');
    await postSamples(cookie, [sample()]);

    const barId = db
      .prepare<[], { id: number }>("SELECT id FROM bars WHERE name = 'Zum Schlossgarten'")
      .get()!.id;

    const response = await injectWithOrigin({
      method: 'GET',
      url: `/api/bars/${barId}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: barId, name: 'Zum Schlossgarten', source: 'osm' });
  });

  it('returns a byte-identical 404 for an undiscovered bar and for a nonexistent id', async () => {
    const cookie = await registerUser('walker');

    const barId = db
      .prepare<[], { id: number }>("SELECT id FROM bars WHERE name = 'Zum Schlossgarten'")
      .get()!.id;

    const undiscovered = await injectWithOrigin({
      method: 'GET',
      url: `/api/bars/${barId}`,
      headers: { cookie },
    });
    const nonexistent = await injectWithOrigin({
      method: 'GET',
      url: '/api/bars/999999',
      headers: { cookie },
    });

    expect(undiscovered.statusCode).toBe(404);
    expect(nonexistent.statusCode).toBe(404);
    expect(undiscovered.body).toBe(nonexistent.body);
    expect(undiscovered.json()).toEqual(nonexistent.json());
  });
});
