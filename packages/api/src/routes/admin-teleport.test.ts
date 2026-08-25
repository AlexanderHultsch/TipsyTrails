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

// SPEC.md Sections 9.3, 10.1: `POST /api/admin/teleport`.
//
// This file is the evidence for the four gates in routes/admin-teleport.ts's
// header, and each gate has a test that fails on its own if that gate is
// removed. It also pins the thing the feature must NOT do — the last
// describe block puts guard-shaped fields into `POST /api/samples` and
// requires that the public route go on refusing exactly what it refused
// before them.

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

// The same real committed trees routes/admin.test.ts, routes/bars.test.ts
// and routes/fog.test.ts reach, copied into a temp directory per test — the
// teleport writes real fog, so it needs the real grid rather than a stub.
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

// Karlsruhe Schloss (SPEC.md's own worked example, as in the other route
// suites).
const SCHLOSS = { lat: 49.0135, lon: 8.4044 };

const M_PER_DEG_LAT = 110574;
function offsetMeters(base: { lat: number; lon: number }, northM: number): { lat: number } {
  return { lat: base.lat + northM / M_PER_DEG_LAT };
}

// 3 km north of the Schloss: still inside the committed grid, and far enough
// that a jump between the two in the same instant implies a speed no
// terrestrial guard would accept. Two teleports to these two points are the
// bypass, stated as a distance.
const FAR_POINT = { ...SCHLOSS, ...offsetMeters(SCHLOSS, 3000) };

// 300 m short of it, which is more than BAR_DISCOVERY_RADIUS_M and more than
// FOG_REVEAL_RADIUS_M: a teleport here leaves the far point's bar
// undiscovered and its fog unrevealed, so a later sample AT the far point
// has something new to report.
const NEAR_FAR_POINT = { ...SCHLOSS, ...offsetMeters(SCHLOSS, 2700) };

for (const [label, point] of [
  ['SCHLOSS', SCHLOSS],
  ['FAR_POINT', FAR_POINT],
  ['NEAR_FAR_POINT', NEAR_FAR_POINT],
] as const) {
  if (toCell(point.lat, point.lon, GRID_PARAMS) === null) {
    throw new Error(`${label} is expected to fall inside the committed Karlsruhe grid`);
  }
}

// Nowhere near Karlsruhe's bounding box (SPEC.md Section 6.2).
const OUTSIDE_CITY = { lat: 0, lon: 0 };

// A directory private to this file rather than a literal shared path —
// DATABASE_PATH is also where resolveVapidConfig (SPEC.md Section 5.9)
// looks for/generates the persisted VAPID key file, and a path shared
// across test files would mean this suite's own app builds silently
// generate/read the same key file as every other route test file.
const vapidTestDir = join(tmpdir(), `tipsytrails-teleport-test-vapid-${randomUUID()}`);

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

// Gate 2, as a switch this suite can throw: the whole difference between an
// app that has the route and an app that does not is this one variable.
function startApp(teleport: 'true' | 'false' | 'absent'): void {
  const env = loadEnv({
    ...baseEnv,
    SEED_DIR: tempSeedDir,
    ...(teleport === 'absent' ? {} : { ADMIN_TELEPORT_ENABLED: teleport }),
  });
  app = buildApp(env, db);
}

async function registerUser(username: string): Promise<string> {
  const response = await injectWithOrigin({
    method: 'POST',
    url: '/api/auth/register',
    payload: { ...validRegisterBody, username },
  });
  return extractSessionCookie(response);
}

async function registerAdmin(username: string): Promise<string> {
  const cookie = await registerUser(username);
  db.prepare('UPDATE users SET is_admin = 1 WHERE username = ?').run(username);
  return cookie;
}

// Gate 3's precondition, applied the way the admin screen applies it —
// through the flag on `users`, not through anything the teleport request
// carries.
function excludeFromRankings(username: string): void {
  db.prepare('UPDATE users SET excluded_from_rankings = 1 WHERE username = ?').run(username);
}

/** An admin that has been taken out of the rankings — teleport's only caller. */
async function registerExcludedAdmin(username: string): Promise<string> {
  const cookie = await registerAdmin(username);
  excludeFromRankings(username);
  return cookie;
}

function teleport(
  cookie: string | undefined,
  body: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return injectWithOrigin({
    method: 'POST',
    url: '/api/admin/teleport',
    ...(cookie === undefined ? {} : { headers: { cookie } }),
    payload: body,
  });
}

function postSamples(cookie: string, samples: unknown[]): Promise<LightMyRequestResponse> {
  return injectWithOrigin({
    method: 'POST',
    url: '/api/samples',
    headers: { cookie },
    payload: { samples },
  });
}

function goodSample(overrides: Record<string, unknown> = {}) {
  return {
    lat: SCHLOSS.lat,
    lon: SCHLOSS.lon,
    accuracy: 10,
    speed: 0,
    timestamp: Date.now(),
    ...overrides,
  };
}

function userIdOf(username: string): number {
  return db
    .prepare<[string], { id: number }>('SELECT id FROM users WHERE username = ?')
    .get(username)!.id;
}

function revealedCellsOf(username: string): number {
  const row = db
    .prepare<[number], { revealed_cells: number }>(
      'SELECT revealed_cells FROM fog_state WHERE user_id = ?',
    )
    .get(userIdOf(username));
  return row?.revealed_cells ?? 0;
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
        cell_index: toCell(bar.lat, bar.lon, GRID_PARAMS),
        source: 'osm',
      })),
    ),
  );
}

beforeEach(() => {
  tempRoot = join(tmpdir(), `tipsytrails-teleport-test-fixture-${randomUUID()}`);
  cpSync(REAL_CITIES_DIR, join(tempRoot, 'cities'), { recursive: true });
  cpSync(join(REAL_SEED_DIR, 'karlsruhe'), join(tempRoot, 'seed', 'karlsruhe'), {
    recursive: true,
  });
  tempSeedDir = join(tempRoot, 'seed');
  // One bar at the far point, so a teleport there can be shown to discover
  // it — Section 7.4 is one of the three things a teleport has to run.
  writeBarsFixture([{ osm_id: 'node/1', name: 'Zum Fernen Stern', ...FAR_POINT }]);

  dbPath = join(tmpdir(), `tipsytrails-teleport-test-${randomUUID()}.db`);
  db = openDatabase(dbPath);
  runMigrations(db, migrationsDir);
  const env = loadEnv({ ...baseEnv, SEED_DIR: tempSeedDir });
  seedCity(db, env);
  seedBars(db, env);
  startApp('true');
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

// ── Gate 2 ──────────────────────────────────────────────────────────────
// The environment variable, and the fact that its absence is a 404 rather
// than a 403. A 403 would say "this exists and you may not use it", which is
// exactly the sentence a stolen admin session is looking for.
describe('gate 2 — the route does not exist without ADMIN_TELEPORT_ENABLED', () => {
  it.each([
    ['absent', 'absent'],
    ['explicitly false', 'false'],
  ] as const)('answers 404, not 403, when the variable is %s', async (_label, value) => {
    startApp(value);
    const cookie = await registerExcludedAdmin('boss');

    const response = await teleport(cookie, SCHLOSS);

    expect(response.statusCode).toBe(404);
    expect(revealedCellsOf('boss')).toBe(0);
  });

  it('answers 404 for a non-admin and for an anonymous caller too, with the same status', async () => {
    startApp('absent');
    const plain = await registerUser('regular');

    const anonymous = await teleport(undefined, SCHLOSS);
    const nonAdmin = await teleport(plain, SCHLOSS);

    expect(anonymous.statusCode).toBe(404);
    expect(nonAdmin.statusCode).toBe(404);
  });

  it('registers the route when the variable is exactly true', async () => {
    startApp('true');
    const cookie = await registerExcludedAdmin('boss');

    const response = await teleport(cookie, SCHLOSS);

    expect(response.statusCode).toBe(200);
  });
});

// ── Gate 1 ──────────────────────────────────────────────────────────────
describe('gate 1 — requireAdmin', () => {
  it('answers 401 for an unauthenticated caller', async () => {
    const response = await teleport(undefined, SCHLOSS);

    expect(response.statusCode).toBe(401);
  });

  it('answers 403 for a signed-in non-admin, and writes nothing for them', async () => {
    const cookie = await registerUser('regular');
    // Excluded from the rankings, so gate 3 could not be what refuses this:
    // the only thing standing between this user and a teleport is that they
    // are not an admin.
    excludeFromRankings('regular');

    const response = await teleport(cookie, SCHLOSS);

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('forbidden');
    expect(revealedCellsOf('regular')).toBe(0);
  });
});

// ── Gate 3 ──────────────────────────────────────────────────────────────
// The gate that makes the feature safe rather than merely gated: an account
// that can still win something can never teleport, so nothing a teleport
// writes can ever become a badge or a leaderboard place.
describe('gate 3 — the caller must already be excluded from the rankings', () => {
  it('refuses an admin who still counts in the rankings, naming the reason', async () => {
    const cookie = await registerAdmin('boss');

    const response = await teleport(cookie, SCHLOSS);

    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe('not_excluded_from_rankings');
    expect(response.json().message).toMatch(/rankings/i);
  });

  it('writes no fog, no discovery and no last-accepted position when it refuses', async () => {
    const cookie = await registerAdmin('boss');

    await teleport(cookie, FAR_POINT);

    expect(revealedCellsOf('boss')).toBe(0);
    const discoveries = db
      .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM bar_discoveries')
      .get();
    expect(discoveries?.count).toBe(0);
    // If the refused teleport had reached `lastAccepted`, check-in would now
    // answer something other than "no recent sample".
    const barId = db.prepare<[], { id: number }>('SELECT id FROM bars LIMIT 1').get()!.id;
    const checkIn = await injectWithOrigin({
      method: 'POST',
      url: '/api/visits',
      headers: { cookie },
      payload: { barId },
    });
    expect(checkIn.json().code).not.toBe('not_onsite');
  });

  it('admits the same admin as soon as the flag is set, and refuses again once it is cleared', async () => {
    const cookie = await registerAdmin('boss');

    expect((await teleport(cookie, SCHLOSS)).statusCode).toBe(422);

    excludeFromRankings('boss');
    expect((await teleport(cookie, SCHLOSS)).statusCode).toBe(200);

    db.prepare('UPDATE users SET excluded_from_rankings = 0 WHERE username = ?').run('boss');
    expect((await teleport(cookie, SCHLOSS)).statusCode).toBe(422);
  });
});

// ── What it actually does ───────────────────────────────────────────────
describe('POST /api/admin/teleport — the move itself', () => {
  it('reveals fog at the chosen point, exactly as an accepted sample would', async () => {
    const cookie = await registerExcludedAdmin('boss');

    const response = await teleport(cookie, SCHLOSS);

    expect(response.statusCode).toBe(200);
    expect(response.json().newCells).toBeGreaterThan(0);
    expect(revealedCellsOf('boss')).toBe(response.json().newCells);
  });

  it('discovers a bar it lands on (Section 7.4), returning it as newBars', async () => {
    const cookie = await registerExcludedAdmin('boss');

    const response = await teleport(cookie, FAR_POINT);

    expect(response.json().newBars).toHaveLength(1);
    expect(response.json().newBars[0].name).toBe('Zum Fernen Stern');
    const discoveries = db
      .prepare<[number], { count: number }>(
        'SELECT COUNT(*) AS count FROM bar_discoveries WHERE user_id = ?',
      )
      .get(userIdOf('boss'));
    expect(discoveries?.count).toBe(1);
  });

  it('reports tooFastToReveal as false — with the gate off, nothing was refused', async () => {
    const cookie = await registerExcludedAdmin('boss');

    await teleport(cookie, SCHLOSS);
    const second = await teleport(cookie, FAR_POINT);

    expect(second.json().tooFastToReveal).toBe(false);
  });

  it('answers with the same body shape POST /api/samples answers with', async () => {
    const cookie = await registerExcludedAdmin('boss');

    const response = await teleport(cookie, SCHLOSS);

    expect(Object.keys(response.json()).sort()).toEqual([
      'newBars',
      'newCells',
      'tooFastToReveal',
      'visitUpdates',
    ]);
  });

  it('rejects a body that is not a lat/lon pair', async () => {
    const cookie = await registerExcludedAdmin('boss');

    for (const body of [{}, { lat: SCHLOSS.lat }, { lat: 'x', lon: 'y' }, { lat: 91, lon: 0 }]) {
      const response = await teleport(cookie, body);
      expect(response.statusCode).toBe(400);
    }
  });
});

// ── The bypass, and its exact extent ────────────────────────────────────
describe('the speed guards are off for teleport and on for everyone else', () => {
  // 3 km in the same instant is an implied speed of Infinity, an order of
  // magnitude past SAMPLE_TELEPORT_SPEED_KMH. Both teleports land.
  it('accepts two teleports 3 km apart in immediate succession', async () => {
    const cookie = await registerExcludedAdmin('boss');

    const first = await teleport(cookie, SCHLOSS);
    const second = await teleport(cookie, FAR_POINT);

    expect(first.json().newCells).toBeGreaterThan(0);
    expect(second.json().newCells).toBeGreaterThan(0);
  });

  // The same movement offered as ordinary samples by the same admin. This is
  // the control for the test above: if it ever starts passing, the bypass has
  // leaked onto the public path.
  it('still refuses the identical jump when it arrives as a sample batch', async () => {
    const cookie = await registerExcludedAdmin('boss');
    const now = Date.now();

    const response = await postSamples(cookie, [
      goodSample({ timestamp: now - 1000 }),
      goodSample({ ...FAR_POINT, timestamp: now }),
    ]);

    // The second sample implies 10 800 km/h and is dropped, so only the
    // Schloss reveals — the far point's bar is never discovered.
    expect(response.json().newBars).toHaveLength(0);
  });

  it('reveals fog at walking pace and above it, since FOG_MAX_SPEED_KMH is off too', async () => {
    const cookie = await registerExcludedAdmin('boss');

    // A sample of the same shape the teleport synthesises, but travelling
    // fast, is refused a reveal on the public path...
    const sampleResponse = await postSamples(cookie, [
      goodSample({ speed: (CONFIG.FOG_MAX_SPEED_KMH / 3.6) * 2 }),
    ]);
    expect(sampleResponse.json().tooFastToReveal).toBe(true);
    expect(sampleResponse.json().newCells).toBe(0);

    // ...while the teleport, which cannot be travelling at all, reveals.
    const teleportResponse = await teleport(cookie, FAR_POINT);
    expect(teleportResponse.json().newCells).toBeGreaterThan(0);
  });
});

// ── The bounding box is NOT bypassed ────────────────────────────────────
describe('the active city bounding box still applies', () => {
  it('refuses a point outside it with 422 outside_city rather than a silent 200', async () => {
    const cookie = await registerExcludedAdmin('boss');

    const response = await teleport(cookie, OUTSIDE_CITY);

    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe('outside_city');
    expect(revealedCellsOf('boss')).toBe(0);
  });
});

// ── lastAccepted ────────────────────────────────────────────────────────
// SPEC.md Section 10.2's in-memory previous position. A teleport that left it
// stale would make the admin's next genuine sample look like a 300 km/h jump
// from wherever they were before, and the guard would drop it — the feature
// would break the ordinary sampling it exists to exercise.
describe('lastAccepted after a teleport', () => {
  it('holds the teleport destination: the next genuine sample there is accepted', async () => {
    const cookie = await registerExcludedAdmin('boss');

    await teleport(cookie, SCHLOSS);
    await teleport(cookie, NEAR_FAR_POINT);

    // A genuine sample 300 m further on, ten seconds later. Measured from
    // where the teleport actually left the player that is 108 km/h — fast,
    // but well inside SAMPLE_TELEPORT_SPEED_KMH — so it is accepted and
    // discovers the bar standing there. Measured from the Schloss instead,
    // which is what a teleport that failed to update `lastAccepted` would
    // leave behind, the very same sample implies 972 km/h, is dropped at
    // step 4, and discovers nothing.
    const response = await postSamples(cookie, [
      goodSample({ ...FAR_POINT, timestamp: Date.now() + 10_000 }),
    ]);

    expect(response.json().newBars).toHaveLength(1);
    expect(response.json().newBars[0].name).toBe('Zum Fernen Stern');
  });

  it('is what makes check-in work at the teleport destination', async () => {
    const cookie = await registerExcludedAdmin('boss');

    const moved = await teleport(cookie, FAR_POINT);
    const barId = moved.json().newBars[0].id as number;

    const checkIn = await injectWithOrigin({
      method: 'POST',
      url: '/api/visits',
      headers: { cookie },
      payload: { barId },
    });

    expect(checkIn.statusCode).toBe(200);
    expect(checkIn.json().status).toBe('pending');
  });
});

// ── The rule this whole feature is built around ─────────────────────────
// SPEC.md Section 10.1: the public sample route keeps exactly the validation
// it had. A request cannot ask to be checked less, whoever sends it.
describe('POST /api/samples cannot ask for the bypass', () => {
  it.each([
    ['a top-level flag', { skipGuards: true }],
    ['a differently named top-level flag', { teleport: true }],
    ['a top-level flag matching the server field', { skipSpeedGuards: true }],
  ])('refuses the same impossible jump with %s in the body', async (_label, extra) => {
    const cookie = await registerExcludedAdmin('boss');
    const now = Date.now();

    const response = await injectWithOrigin({
      method: 'POST',
      url: '/api/samples',
      headers: { cookie },
      payload: {
        ...extra,
        samples: [
          goodSample({ timestamp: now - 1000 }),
          goodSample({ ...FAR_POINT, timestamp: now }),
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().newBars).toHaveLength(0);
  });

  it.each([
    ['skipGuards', { skipGuards: true }],
    ['teleport', { teleport: true }],
    ['skipSpeedGuards', { skipSpeedGuards: true }],
  ])('refuses it with %s on the sample itself', async (_label, extra) => {
    const cookie = await registerExcludedAdmin('boss');
    const now = Date.now();

    const response = await postSamples(cookie, [
      goodSample({ timestamp: now - 1000 }),
      goodSample({ ...FAR_POINT, ...extra, timestamp: now }),
    ]);

    expect(response.json().newBars).toHaveLength(0);
  });

  it('keeps the reveal-speed gate for a fast sample however the body is dressed', async () => {
    const cookie = await registerExcludedAdmin('boss');

    const response = await injectWithOrigin({
      method: 'POST',
      url: '/api/samples',
      headers: { cookie },
      payload: {
        skipSpeedGuards: true,
        samples: [goodSample({ speed: (CONFIG.FOG_MAX_SPEED_KMH / 3.6) * 2 })],
      },
    });

    expect(response.json().tooFastToReveal).toBe(true);
    expect(response.json().newCells).toBe(0);
  });
});
