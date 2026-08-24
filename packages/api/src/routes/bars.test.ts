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
import {
  bindMasteredUserId,
  DISCOVERED_BAR_COLUMNS,
  type DiscoveredBarRow,
  type MasteredUserIdBinding,
} from './bars.js';

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

// A directory private to this file rather than a literal shared path —
// DATABASE_PATH is also where resolveVapidConfig (SPEC.md Section 5.9)
// looks for/generates the persisted VAPID key file, and a path shared
// across test files would mean this suite's own app builds silently
// generate/read the same key file as every other route test file.
const vapidTestDir = join(tmpdir(), `tipsytrails-bars-test-vapid-${randomUUID()}`);

const baseEnv = {
  NODE_ENV: 'test',
  PUBLIC_ORIGIN: 'https://tipsytrails.ahultsch.com',
  DATABASE_PATH: join(vapidTestDir, 'tipsytrails.db'),
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
  rmSync(vapidTestDir, { recursive: true, force: true });
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

// SPEC.md Section 5.7: "A bar is mastered by a user if at least one `visits`
// row exists with `status='completed'`. Mastering is permanent and cannot be
// lost." Section 9.2's three bar-shaped surfaces — GET /api/bars, GET
// /api/bars/:id and POST /api/samples's `newBars` — all answer through
// `toBarSummary`, so all three have to carry it and carry it identically.
describe('the mastered flag (SPEC.md Sections 5.7, 9.2)', () => {
  function userIdOf(username: string): number {
    return db
      .prepare<[string], { id: number }>('SELECT id FROM users WHERE username = ?')
      .get(username)!.id;
  }

  function schlossgartenId(): number {
    return db
      .prepare<[], { id: number }>("SELECT id FROM bars WHERE name = 'Zum Schlossgarten'")
      .get()!.id;
  }

  // Written straight into `visits` rather than driven through a real
  // check-in: this suite is about how the flag is *read*, and Section 7.5's
  // path to a completed visit (two accepted on-site samples 20 minutes
  // apart) is routes/visits.test.ts's subject. Writing the row is also the
  // only way to produce the terminal states below at all.
  function insertVisit(username: string, barId: number, status: string): void {
    const nowS = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO visits (user_id, bar_id, started_at, last_sample_at, onsite_samples, confirmed_s, status, completed_at)
       VALUES (?, ?, ?, ?, 2, ?, ?, ?)`,
    ).run(
      userIdOf(username),
      barId,
      nowS - CONFIG.VISIT_REQUIRED_MS / 1000,
      nowS,
      CONFIG.VISIT_REQUIRED_MS / 1000,
      status,
      status === 'completed' ? nowS : null,
    );
  }

  function getBars(cookie: string): Promise<LightMyRequestResponse> {
    return injectWithOrigin({ method: 'GET', url: '/api/bars', headers: { cookie } });
  }

  it('is false for a discovered bar with no completed visit, and true once there is one', async () => {
    const cookie = await registerUser('walker');
    await postSamples(cookie, [sample()]);
    const barId = schlossgartenId();

    const before = await getBars(cookie);
    expect(before.json().bars[0]).toMatchObject({ id: barId, mastered: false });

    insertVisit('walker', barId, 'completed');

    const after = await getBars(cookie);
    expect(after.json().bars[0]).toMatchObject({ id: barId, mastered: true });
  });

  // The one this suite exists for. A flag that is computed per *bar* rather
  // than per *user* passes every single-user test there is: it needs two
  // users with different mastery of the same bar to fail.
  it('answers per user: one user’s completed visit never masters the bar for another', async () => {
    const aliceCookie = await registerUser('alice');
    const bobCookie = await registerUser('bob');
    await postSamples(aliceCookie, [sample()]);
    await postSamples(bobCookie, [sample()]);
    const barId = schlossgartenId();

    insertVisit('alice', barId, 'completed');

    const alice = await getBars(aliceCookie);
    const bob = await getBars(bobCookie);

    expect(alice.json().bars).toHaveLength(1);
    expect(bob.json().bars).toHaveLength(1);
    expect(alice.json().bars[0]).toMatchObject({ id: barId, mastered: true });
    expect(bob.json().bars[0]).toMatchObject({ id: barId, mastered: false });

    // And the same answer from the detail route, which is a different query
    // over the same shared column list.
    const aliceDetail = await injectWithOrigin({
      method: 'GET',
      url: `/api/bars/${barId}`,
      headers: { cookie: aliceCookie },
    });
    const bobDetail = await injectWithOrigin({
      method: 'GET',
      url: `/api/bars/${barId}`,
      headers: { cookie: bobCookie },
    });
    expect(aliceDetail.json().mastered).toBe(true);
    expect(bobDetail.json().mastered).toBe(false);
  });

  // Section 5.7: 'pending', 'expired' and 'cancelled' master nothing —
  // 'completed' is the only status that does.
  it.each(['pending', 'expired', 'cancelled'])(
    'does not treat a %s visit as mastering',
    async (status) => {
      const cookie = await registerUser('walker');
      await postSamples(cookie, [sample()]);
      const barId = schlossgartenId();

      insertVisit('walker', barId, status);

      const response = await getBars(cookie);
      expect(response.json().bars[0]).toMatchObject({ id: barId, mastered: false });
    },
  );

  // Section 5.7: "Mastering is permanent and cannot be lost." A later visit
  // that expires or is cancelled is a new row beside the completed one, and
  // the completed one is still there.
  it('stays mastered after a later visit expires or is cancelled', async () => {
    const cookie = await registerUser('walker');
    await postSamples(cookie, [sample()]);
    const barId = schlossgartenId();

    insertVisit('walker', barId, 'completed');
    insertVisit('walker', barId, 'expired');
    insertVisit('walker', barId, 'cancelled');

    const response = await getBars(cookie);
    expect(response.json().bars[0]).toMatchObject({ id: barId, mastered: true });
  });

  // Section 9.2: `newBars` is the third surface, and it goes through the
  // same mapper and now the same SELECT list — so it carries the field
  // rather than being the one place a client finds it missing.
  it('carries the field on POST /api/samples’s newBars', async () => {
    const cookie = await registerUser('walker');

    const response = await postSamples(cookie, [sample()]);

    expect(response.json().newBars).toHaveLength(1);
    expect(response.json().newBars[0]).toMatchObject({
      name: 'Zum Schlossgarten',
      mastered: false,
    });
    expect(response.json().newBars[0]).toHaveProperty('mastered');
  });

  it('carries the field on POST /api/bars/suggest’s created bar', async () => {
    const cookie = await registerUser('submitter');
    const spot = diagonalOffset(SCHLOSS, 200);

    const response = await injectWithOrigin({
      method: 'POST',
      url: '/api/bars/suggest',
      headers: { cookie },
      payload: { name: 'Neue Bar', address: null, lat: spot.lat, lon: spot.lon },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ source: 'community', mastered: false });
  });

  // The three surfaces have to agree field for field, which is the property
  // `toBarSummary` and the shared column list exist to guarantee — a
  // `mastered` that reached two of them and not the third is exactly the
  // drift they are there to prevent.
  it('returns the same field set from all three surfaces', async () => {
    const cookie = await registerUser('walker');

    const samplesResponse = await postSamples(cookie, [sample()]);
    const fromNewBars = samplesResponse.json().newBars[0];
    const barId = fromNewBars.id;

    const listResponse = await getBars(cookie);
    const fromList = listResponse.json().bars[0];
    const detailResponse = await injectWithOrigin({
      method: 'GET',
      url: `/api/bars/${barId}`,
      headers: { cookie },
    });
    const fromDetail = detailResponse.json();

    expect(Object.keys(fromList).sort()).toEqual(Object.keys(fromNewBars).sort());
    expect(Object.keys(fromDetail).sort()).toEqual(Object.keys(fromNewBars).sort());
    expect(fromList).toEqual(fromNewBars);
    expect(fromDetail).toEqual(fromNewBars);
    expect(fromList).toHaveProperty('mastered');
  });

  // SQLite answers an EXISTS/comparison with an integer, and a `mastered: 1`
  // on the wire is a value `types.ts` declares as a boolean and a client
  // would branch on by accident rather than by contract.
  it('is a JSON boolean, not SQLite’s 0/1', async () => {
    const masteredCookie = await registerUser('walker');
    const plainCookie = await registerUser('other');
    await postSamples(masteredCookie, [sample()]);
    await postSamples(plainCookie, [sample()]);
    insertVisit('walker', schlossgartenId(), 'completed');

    const masteredBody = (await getBars(masteredCookie)).body;
    expect(masteredBody).toContain('"mastered":true');
    expect(masteredBody).not.toContain('"mastered":1');

    const plainBody = (await getBars(plainCookie)).body;
    expect(plainBody).toContain('"mastered":false');
    expect(plainBody).not.toContain('"mastered":0');
  });

  // DISCOVERED_BAR_COLUMNS states a guarantee about itself that no route can
  // exercise: because every query in routes/bars.ts and routes/fog.ts already
  // scopes its discoveries to one user, `bar_discoveries.user_id =
  // @masteredUserId` is true for every row those routes return, and deleting
  // that conjunct leaves the whole suite green. The conjunct is not there for
  // today's callers, though — it is there so that a future one binding the
  // wrong id degrades to `false` rather than reporting a stranger's mastery.
  //
  // So the column list is exercised directly, with the binding deliberately
  // mismatched: discoveries scoped to Alice, `@masteredUserId` bound to Bob,
  // and Bob the one who has mastered the bar. Without the conjunct the
  // subquery answers about Bob and Alice's row comes back mastered — which is
  // the leak, and it is only visible from here.
  it('reports false, never a stranger’s mastery, when the binding does not match the discoveries', async () => {
    const aliceCookie = await registerUser('alice');
    const bobCookie = await registerUser('bob');
    await postSamples(aliceCookie, [sample()]);
    await postSamples(bobCookie, [sample()]);
    const barId = schlossgartenId();

    // Bob has mastered it; Alice has not.
    insertVisit('bob', barId, 'completed');

    const selectForUser = (
      discoveriesOf: number,
      masteredBinding: number,
    ): DiscoveredBarRow | undefined =>
      db
        .prepare<[number, MasteredUserIdBinding], DiscoveredBarRow>(
          `SELECT ${DISCOVERED_BAR_COLUMNS}
           FROM bar_discoveries
           JOIN bars ON bars.id = bar_discoveries.bar_id
           WHERE bar_discoveries.user_id = ?`,
        )
        .get(discoveriesOf, bindMasteredUserId(masteredBinding));

    const alice = userIdOf('alice');
    const bob = userIdOf('bob');

    // The correct binding: each user's own answer, as the routes get it.
    expect(selectForUser(alice, alice)?.mastered).toBe(0);
    expect(selectForUser(bob, bob)?.mastered).toBe(1);

    // The mismatched binding: Alice's discovery row, Bob's id. Bob's mastery
    // must not appear here.
    expect(selectForUser(alice, bob)?.id).toBe(barId);
    expect(selectForUser(alice, bob)?.mastered).toBe(0);
  });
});

describe('POST /api/bars/suggest', () => {
  // Well outside SUGGEST_DUPLICATE_RADIUS_M (25 m) from SCHLOSS but still a
  // short, plausible walk — used whenever a test needs "a different spot,
  // not a duplicate collision by position alone".
  const NEARBY_NOT_DUPLICATE = diagonalOffset(SCHLOSS, 30);
  if (30 <= CONFIG.SUGGEST_DUPLICATE_RADIUS_M) {
    throw new Error('NEARBY_NOT_DUPLICATE is expected to fall outside SUGGEST_DUPLICATE_RADIUS_M');
  }

  // Nowhere near Karlsruhe's bounding box (SPEC.md Section 6.2:
  // 48.9400-49.0950 N, 8.2750-8.5600 E).
  const OUTSIDE_CITY = { lat: 0, lon: 0 };

  function suggestBar(
    cookie: string,
    body: { name: string; address: string | null; lat: number; lon: number },
  ): Promise<LightMyRequestResponse> {
    return injectWithOrigin({
      method: 'POST',
      url: '/api/bars/suggest',
      headers: { cookie },
      payload: body,
    });
  }

  it('creates a community bar that appears immediately in GET /api/bars for the submitter, discovered', async () => {
    const cookie = await registerUser('suggester');

    const response = await suggestBar(cookie, {
      name: 'Irish Pub Karlsruhe',
      address: 'Kaiserstraße 1',
      ...NEARBY_NOT_DUPLICATE,
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({ name: 'Irish Pub Karlsruhe', source: 'community' });
    expect(typeof body.discoveredAt).toBe('number');

    const barsResponse = await injectWithOrigin({
      method: 'GET',
      url: '/api/bars',
      headers: { cookie },
    });
    const names = barsResponse.json().bars.map((b: { name: string }) => b.name);
    expect(names).toContain('Irish Pub Karlsruhe');

    const userId = db
      .prepare<[string], { id: number }>('SELECT id FROM users WHERE username = ?')
      .get('suggester')!.id;
    const discovery = db
      .prepare<[number, number], { discovered_at: number }>(
        'SELECT discovered_at FROM bar_discoveries WHERE user_id = ? AND bar_id = ?',
      )
      .get(userId, body.id);
    expect(discovery).toBeDefined();

    const barRow = db
      .prepare<[number], { source: string; status: string; submitted_by: number }>(
        'SELECT source, status, submitted_by FROM bars WHERE id = ?',
      )
      .get(body.id);
    expect(barRow).toMatchObject({ source: 'community', status: 'active', submitted_by: userId });
  });

  it('is discovered by a second, unrelated user who later walks within BAR_DISCOVERY_RADIUS_M of it', async () => {
    // Far enough from SCHLOSS that this position cannot itself trigger a
    // duplicate match or a stray discovery of the seeded 'Zum Schlossgarten'
    // bar, keeping this test about one thing: a fresh community bar reaching
    // a second, unrelated user through the ordinary discovery path.
    const suggestedPosition = offsetMeters(SCHLOSS, 500, 500);

    const suggesterCookie = await registerUser('suggester');
    const suggestResponse = await suggestBar(suggesterCookie, {
      name: 'Second User Test Bar',
      address: null,
      ...suggestedPosition,
    });
    expect(suggestResponse.statusCode).toBe(201);
    const barId = suggestResponse.json().id as number;

    const walkerCookie = await registerUser('walker');
    const within = diagonalOffset(suggestedPosition, 95);
    expect(95).toBeLessThan(CONFIG.BAR_DISCOVERY_RADIUS_M);

    const samplesResponse = await postSamples(walkerCookie, [sample({ ...within })]);
    expect(samplesResponse.statusCode).toBe(200);
    const newBars = samplesResponse.json().newBars;
    expect(newBars).toHaveLength(1);
    expect(newBars[0]).toMatchObject({
      id: barId,
      name: 'Second User Test Bar',
      source: 'community',
    });

    const barsResponse = await injectWithOrigin({
      method: 'GET',
      url: '/api/bars',
      headers: { cookie: walkerCookie },
    });
    const names = barsResponse.json().bars.map((b: { name: string }) => b.name);
    expect(names).toContain('Second User Test Bar');
  });

  it('rejects a near-duplicate within SUGGEST_DUPLICATE_RADIUS_M, naming the conflicting bar', async () => {
    const cookie = await registerUser('suggester');
    const closeBy = diagonalOffset(SCHLOSS, 10);
    expect(10).toBeLessThan(CONFIG.SUGGEST_DUPLICATE_RADIUS_M);

    const response = await suggestBar(cookie, {
      name: 'zum SCHLOSSGARTEN',
      address: null,
      ...closeBy,
    });

    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.code).toBe('duplicate_bar');
    expect(body.message).toContain('Zum Schlossgarten');

    const communityBars = db
      .prepare<[], { count: number }>(
        "SELECT COUNT(*) AS count FROM bars WHERE source = 'community'",
      )
      .get();
    expect(communityBars?.count).toBe(0);
  });

  it('accepts the same name outside SUGGEST_DUPLICATE_RADIUS_M', async () => {
    const cookie = await registerUser('suggester');

    const response = await suggestBar(cookie, {
      name: 'Zum Schlossgarten',
      address: null,
      ...NEARBY_NOT_DUPLICATE,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ name: 'Zum Schlossgarten', source: 'community' });
  });

  it('accepts a different name inside SUGGEST_DUPLICATE_RADIUS_M', async () => {
    const cookie = await registerUser('suggester');
    const closeBy = diagonalOffset(SCHLOSS, 10);

    const response = await suggestBar(cookie, {
      name: 'Irish Pub Karlsruhe',
      address: null,
      ...closeBy,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ name: 'Irish Pub Karlsruhe', source: 'community' });
  });

  it('rejects a position outside the active city', async () => {
    const cookie = await registerUser('suggester');

    const response = await suggestBar(cookie, {
      name: 'Somewhere Else',
      address: null,
      ...OUTSIDE_CITY,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe('outside_city');

    const count = db
      .prepare<[], { count: number }>(
        "SELECT COUNT(*) AS count FROM bars WHERE source = 'community'",
      )
      .get();
    expect(count?.count).toBe(0);
  });

  it('enforces the suggest rate limit', async () => {
    const cookie = await registerUser('suggester');
    const limit = CONFIG.RATE_LIMITS.suggest.limit;

    for (let i = 0; i < limit; i++) {
      const response = await suggestBar(cookie, {
        name: `Suggested Bar ${i}`,
        address: null,
        ...offsetMeters(SCHLOSS, i * 200, i * 200),
      });
      expect(response.statusCode).toBe(201);
    }

    const limited = await suggestBar(cookie, {
      name: 'One Too Many',
      address: null,
      ...offsetMeters(SCHLOSS, limit * 200, limit * 200),
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe('rate_limited');
  });
});
