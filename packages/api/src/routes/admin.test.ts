import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toCell, type GridParams } from '@tipsytrails/shared';
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

// Same real committed trees routes/bars.test.ts and routes/visits.test.ts
// reach, copied into a temp directory per test.
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
// routes/bars.test.ts, routes/fog.test.ts, routes/visits.test.ts).
const SCHLOSS = { lat: 49.0135, lon: 8.4044 };
const SCHLOSS_CELL_INDEX = toCell(SCHLOSS.lat, SCHLOSS.lon, GRID_PARAMS);
if (SCHLOSS_CELL_INDEX === null) {
  throw new Error('SCHLOSS is expected to fall inside the committed Karlsruhe grid');
}

// Local reimplementation of SPEC.md Section 6.1's projection constants
// (mirrored, with the same values, in packages/shared/src/grid.ts — not
// exported from the package's public entry point; the same choice
// routes/bars.test.ts and routes/visits.test.ts make).
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

// 300 m north of SCHLOSS: well inside the bounding box, but far enough that
// its cell index differs from SCHLOSS's (cell_size_m is 50).
const MOVE_TARGET = offsetMeters(SCHLOSS, 300, 0);
const MOVE_TARGET_CELL_INDEX = toCell(MOVE_TARGET.lat, MOVE_TARGET.lon, GRID_PARAMS);
if (MOVE_TARGET_CELL_INDEX === null || MOVE_TARGET_CELL_INDEX === SCHLOSS_CELL_INDEX) {
  throw new Error('MOVE_TARGET is expected to fall inside the grid, in a different cell');
}

// Nowhere near Karlsruhe's bounding box (SPEC.md Section 6.2).
const OUTSIDE_CITY = { lat: 0, lon: 0 };

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

function promoteToAdmin(username: string): void {
  db.prepare('UPDATE users SET is_admin = 1 WHERE username = ?').run(username);
}

async function registerAdmin(username: string): Promise<string> {
  const cookie = await registerUser(username);
  promoteToAdmin(username);
  return cookie;
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

function checkIn(cookie: string, barId: number): Promise<LightMyRequestResponse> {
  return injectWithOrigin({
    method: 'POST',
    url: '/api/visits',
    headers: { cookie },
    payload: { barId },
  });
}

function barIdByName(name: string): number {
  return db.prepare<[string], { id: number }>('SELECT id FROM bars WHERE name = ?').get(name)!.id;
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

function adminGetBars(cookie: string, query = ''): Promise<LightMyRequestResponse> {
  return injectWithOrigin({
    method: 'GET',
    url: `/api/admin/bars${query}`,
    headers: { cookie },
  });
}

function adminCreateBar(
  cookie: string,
  body: { name: string; address: string | null; lat: number; lon: number },
): Promise<LightMyRequestResponse> {
  return injectWithOrigin({
    method: 'POST',
    url: '/api/admin/bars',
    headers: { cookie },
    payload: body,
  });
}

function adminPatchBar(
  cookie: string,
  barId: number,
  body: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return injectWithOrigin({
    method: 'PATCH',
    url: `/api/admin/bars/${barId}`,
    headers: { cookie },
    payload: body,
  });
}

function adminDeleteBar(cookie: string, barId: number): Promise<LightMyRequestResponse> {
  return injectWithOrigin({
    method: 'DELETE',
    url: `/api/admin/bars/${barId}`,
    headers: { cookie },
  });
}

function adminGetUsers(cookie: string): Promise<LightMyRequestResponse> {
  return injectWithOrigin({
    method: 'GET',
    url: '/api/admin/users',
    headers: { cookie },
  });
}

beforeEach(() => {
  tempRoot = join(tmpdir(), `tipsytrails-admin-test-fixture-${randomUUID()}`);
  cpSync(REAL_CITIES_DIR, join(tempRoot, 'cities'), { recursive: true });
  cpSync(join(REAL_SEED_DIR, 'karlsruhe'), join(tempRoot, 'seed', 'karlsruhe'), {
    recursive: true,
  });
  tempSeedDir = join(tempRoot, 'seed');
  writeBarsFixture([{ osm_id: 'node/1', name: 'Zum Schlossgarten', ...SCHLOSS }]);

  dbPath = join(tmpdir(), `tipsytrails-admin-test-${randomUUID()}.db`);
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

describe('admin guard', () => {
  const requests: { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; url: string }[] = [
    { method: 'GET', url: '/api/admin/bars' },
    { method: 'POST', url: '/api/admin/bars' },
    { method: 'PATCH', url: '/api/admin/bars/1' },
    { method: 'DELETE', url: '/api/admin/bars/1' },
    { method: 'GET', url: '/api/admin/users' },
  ];

  it.each(requests)('returns 401 unauthenticated for $method $url', async ({ method, url }) => {
    const response = await injectWithOrigin({ method, url, payload: {} });
    expect(response.statusCode).toBe(401);
  });

  it.each(requests)(
    'returns 403 for a logged-in non-admin at $method $url',
    async ({ method, url }) => {
      const cookie = await registerUser('regular');
      const response = await injectWithOrigin({
        method,
        url,
        headers: { cookie },
        payload: {},
      });
      expect(response.statusCode).toBe(403);
    },
  );

  it('admits an admin at every endpoint (no 401/403)', async () => {
    const cookie = await registerAdmin('boss');
    const barId = barIdByName('Zum Schlossgarten');

    const responses = await Promise.all([
      adminGetBars(cookie),
      adminGetUsers(cookie),
      adminPatchBar(cookie, barId, { status: 'active' }),
    ]);
    for (const response of responses) {
      expect(response.statusCode).not.toBe(401);
      expect(response.statusCode).not.toBe(403);
    }
  });
});

describe('POST /api/admin/bars', () => {
  it('creates a bar directly, active, source=admin, submitted by the admin', async () => {
    const cookie = await registerAdmin('boss');
    const target = offsetMeters(SCHLOSS, 50, 50);

    const response = await adminCreateBar(cookie, {
      name: 'Admin Added Bar',
      address: 'Kaiserstraße 99',
      ...target,
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({ name: 'Admin Added Bar', source: 'admin', status: 'active' });

    const adminId = db
      .prepare<[string], { id: number }>('SELECT id FROM users WHERE username = ?')
      .get('boss')!.id;
    const row = db
      .prepare<[number], { source: string; status: string; submitted_by: number }>(
        'SELECT source, status, submitted_by FROM bars WHERE id = ?',
      )
      .get(body.id);
    expect(row).toMatchObject({ source: 'admin', status: 'active', submitted_by: adminId });
  });

  it('rejects a position outside the active city', async () => {
    const cookie = await registerAdmin('boss');

    const response = await adminCreateBar(cookie, {
      name: 'Nowhere',
      address: null,
      ...OUTSIDE_CITY,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe('outside_city');
  });
});

describe('PATCH /api/admin/bars/:id', () => {
  it('edits name, address, and status', async () => {
    const cookie = await registerAdmin('boss');
    const barId = barIdByName('Zum Schlossgarten');

    const response = await adminPatchBar(cookie, barId, {
      name: 'Renamed Bar',
      address: 'New Address 1',
      status: 'hidden',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      name: 'Renamed Bar',
      address: 'New Address 1',
      status: 'hidden',
    });

    const row = db
      .prepare<[number], { name: string; address: string; status: string }>(
        'SELECT name, address, status FROM bars WHERE id = ?',
      )
      .get(barId);
    expect(row).toMatchObject({ name: 'Renamed Bar', address: 'New Address 1', status: 'hidden' });
  });

  it('recomputes cell_index and district_id to the values the projection gives for the new position', async () => {
    const adminCookie = await registerAdmin('boss');
    const barId = barIdByName('Zum Schlossgarten');

    // Independently establishes what district a bar at MOVE_TARGET should
    // land in, via the already-tested suggest handler's own computation —
    // a second, independent caller of the same underlying grid data.
    const suggesterCookie = await registerUser('suggester');
    const suggestResponse = await injectWithOrigin({
      method: 'POST',
      url: '/api/bars/suggest',
      headers: { cookie: suggesterCookie },
      payload: { name: 'Reference Point Bar', address: null, ...MOVE_TARGET },
    });
    expect(suggestResponse.statusCode).toBe(201);
    const referenceBarId = suggestResponse.json().id as number;
    const reference = db
      .prepare<[number], { cell_index: number; district_id: number | null }>(
        'SELECT cell_index, district_id FROM bars WHERE id = ?',
      )
      .get(referenceBarId)!;
    expect(reference.cell_index).toBe(MOVE_TARGET_CELL_INDEX);

    const response = await adminPatchBar(adminCookie, barId, { ...MOVE_TARGET });
    expect(response.statusCode).toBe(200);

    const moved = db
      .prepare<[number], { cell_index: number; district_id: number | null }>(
        'SELECT cell_index, district_id FROM bars WHERE id = ?',
      )
      .get(barId)!;
    expect(moved.cell_index).toBe(MOVE_TARGET_CELL_INDEX);
    expect(moved.district_id).toBe(reference.district_id);
  });

  it('does not revoke existing discoveries when a bar is moved', async () => {
    const adminCookie = await registerAdmin('boss');
    const playerCookie = await registerUser('walker');
    await postSamples(playerCookie, [sample()]);
    const barId = barIdByName('Zum Schlossgarten');

    const playerId = db
      .prepare<[string], { id: number }>('SELECT id FROM users WHERE username = ?')
      .get('walker')!.id;
    const before = db
      .prepare<[number, number], { bar_id: number }>(
        'SELECT bar_id FROM bar_discoveries WHERE user_id = ? AND bar_id = ?',
      )
      .get(playerId, barId);
    expect(before).toBeDefined();

    const response = await adminPatchBar(adminCookie, barId, { ...MOVE_TARGET });
    expect(response.statusCode).toBe(200);

    const after = db
      .prepare<[number, number], { bar_id: number }>(
        'SELECT bar_id FROM bar_discoveries WHERE user_id = ? AND bar_id = ?',
      )
      .get(playerId, barId);
    expect(after).toBeDefined();
  });

  it('returns 404 for a nonexistent bar', async () => {
    const cookie = await registerAdmin('boss');
    const response = await adminPatchBar(cookie, 999999, { status: 'hidden' });
    expect(response.statusCode).toBe(404);
  });
});

describe('DELETE /api/admin/bars/:id', () => {
  it('deletes a bar with discoveries and visits, cascading both away', async () => {
    const adminCookie = await registerAdmin('boss');
    const playerCookie = await registerUser('walker');
    await postSamples(playerCookie, [sample()]);
    const barId = barIdByName('Zum Schlossgarten');
    const checkInResponse = await checkIn(playerCookie, barId);
    expect(checkInResponse.statusCode).toBe(200);

    const discoveriesBefore = db
      .prepare<[number], { count: number }>(
        'SELECT COUNT(*) AS count FROM bar_discoveries WHERE bar_id = ?',
      )
      .get(barId);
    const visitsBefore = db
      .prepare<[number], { count: number }>('SELECT COUNT(*) AS count FROM visits WHERE bar_id = ?')
      .get(barId);
    expect(discoveriesBefore?.count).toBeGreaterThan(0);
    expect(visitsBefore?.count).toBeGreaterThan(0);

    const response = await adminDeleteBar(adminCookie, barId);
    expect(response.statusCode).toBe(200);

    const barRow = db
      .prepare<[number], { id: number }>('SELECT id FROM bars WHERE id = ?')
      .get(barId);
    expect(barRow).toBeUndefined();

    const discoveriesAfter = db
      .prepare<[number], { count: number }>(
        'SELECT COUNT(*) AS count FROM bar_discoveries WHERE bar_id = ?',
      )
      .get(barId);
    const visitsAfter = db
      .prepare<[number], { count: number }>('SELECT COUNT(*) AS count FROM visits WHERE bar_id = ?')
      .get(barId);
    expect(discoveriesAfter?.count).toBe(0);
    expect(visitsAfter?.count).toBe(0);
  });

  it('returns 404 for a nonexistent bar', async () => {
    const cookie = await registerAdmin('boss');
    const response = await adminDeleteBar(cookie, 999999);
    expect(response.statusCode).toBe(404);
  });
});

describe('GET /api/admin/bars', () => {
  it('includes hidden bars', async () => {
    const cookie = await registerAdmin('boss');
    const barId = barIdByName('Zum Schlossgarten');
    await adminPatchBar(cookie, barId, { status: 'hidden' });

    const response = await adminGetBars(cookie);

    expect(response.statusCode).toBe(200);
    const bars = response.json().bars;
    const hidden = bars.find((bar: { id: number }) => bar.id === barId);
    expect(hidden).toMatchObject({ status: 'hidden' });
  });

  it('filters by source', async () => {
    const cookie = await registerAdmin('boss');
    await adminCreateBar(cookie, {
      name: 'Admin Only Bar',
      address: null,
      ...offsetMeters(SCHLOSS, 80, 80),
    });

    const response = await adminGetBars(cookie, '?source=admin');

    expect(response.statusCode).toBe(200);
    const bars = response.json().bars;
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) {
      expect(bar.source).toBe('admin');
    }
    expect(bars.some((bar: { name: string }) => bar.name === 'Admin Only Bar')).toBe(true);
    expect(bars.some((bar: { name: string }) => bar.name === 'Zum Schlossgarten')).toBe(false);
  });
});

describe('GET /api/admin/users', () => {
  it('returns a user list with stats and no password or security-answer hashes', async () => {
    const adminCookie = await registerAdmin('boss');
    await registerUser('walker');

    const response = await adminGetUsers(adminCookie);

    expect(response.statusCode).toBe(200);
    const users = response.json().users;
    expect(users.length).toBe(2);

    for (const user of users) {
      expect(user).not.toHaveProperty('password_hash');
      expect(user).not.toHaveProperty('passwordHash');
      expect(user).not.toHaveProperty('security_answer_hash');
      expect(user).not.toHaveProperty('securityAnswerHash');
    }

    const walker = users.find((user: { username: string }) => user.username === 'walker');
    expect(walker).toMatchObject({
      isAdmin: false,
      areaRevealedCells: 0,
      barsMastered: 0,
      badgeCount: 0,
    });
  });

  it('shows a real username for an anonymous user rather than the masked handle', async () => {
    const adminCookie = await registerAdmin('boss');
    const playerCookie = await registerUser('shy');
    const patchResponse = await injectWithOrigin({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie: playerCookie },
      payload: { isAnonymous: true },
    });
    expect(patchResponse.statusCode).toBe(200);

    const response = await adminGetUsers(adminCookie);
    const shy = response.json().users.find((user: { username: string }) => user.username === 'shy');
    expect(shy).toMatchObject({ username: 'shy', isAnonymous: true });
  });
});

describe('hiding a bar and player-facing endpoints', () => {
  it('a hidden bar vanishes from GET /api/bars for a player who had discovered it', async () => {
    const adminCookie = await registerAdmin('boss');
    const playerCookie = await registerUser('walker');
    await postSamples(playerCookie, [sample()]);
    const barId = barIdByName('Zum Schlossgarten');

    const before = await injectWithOrigin({
      method: 'GET',
      url: '/api/bars',
      headers: { cookie: playerCookie },
    });
    expect(before.json().bars.map((bar: { id: number }) => bar.id)).toContain(barId);

    const hideResponse = await adminPatchBar(adminCookie, barId, { status: 'hidden' });
    expect(hideResponse.statusCode).toBe(200);

    const after = await injectWithOrigin({
      method: 'GET',
      url: '/api/bars',
      headers: { cookie: playerCookie },
    });
    expect(after.statusCode).toBe(200);
    expect(after.json().bars.map((bar: { id: number }) => bar.id)).not.toContain(barId);

    const detailResponse = await injectWithOrigin({
      method: 'GET',
      url: `/api/bars/${barId}`,
      headers: { cookie: playerCookie },
    });
    expect(detailResponse.statusCode).toBe(404);

    // The row itself is not deleted — hiding is not deleting (SPEC.md
    // Section 9.3).
    const row = db.prepare<[number], { id: number }>('SELECT id FROM bars WHERE id = ?').get(barId);
    expect(row).toBeDefined();
  });
});
