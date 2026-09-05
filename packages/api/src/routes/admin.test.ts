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

// A directory private to this file rather than a literal shared path —
// DATABASE_PATH is also where resolveVapidConfig (SPEC.md Section 5.9)
// looks for/generates the persisted VAPID key file, and a path shared
// across test files would mean this suite's own app builds silently
// generate/read the same key file as every other route test file.
const vapidTestDir = join(tmpdir(), `tipsytrails-admin-test-vapid-${randomUUID()}`);

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

function adminPatchUser(
  cookie: string,
  userId: number,
  body: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return injectWithOrigin({
    method: 'PATCH',
    url: `/api/admin/users/${userId}`,
    headers: { cookie },
    payload: body,
  });
}

function userIdByName(name: string): number {
  return db.prepare<[string], { id: number }>('SELECT id FROM users WHERE username = ?').get(name)!
    .id;
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
  rmSync(vapidTestDir, { recursive: true, force: true });
});

describe('admin guard', () => {
  const requests: { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; url: string }[] = [
    { method: 'GET', url: '/api/admin/bars' },
    { method: 'POST', url: '/api/admin/bars' },
    { method: 'PATCH', url: '/api/admin/bars/1' },
    { method: 'DELETE', url: '/api/admin/bars/1' },
    { method: 'GET', url: '/api/admin/users' },
    { method: 'PATCH', url: '/api/admin/users/1' },
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

  // SPEC.md Section 9.3: the list is ordered by name. The fixture names are
  // deliberately not ASCII-only - "Bärenstüble" and "Änderungsbar" are the
  // cases that tell German collation apart from SQLite's NOCASE, which folds
  // ASCII A-Z and otherwise compares by code point, filing every umlaut after
  // "Z"; "apfel" is the case that tells it apart from a bare code-point sort,
  // which files every lower-case name after every upper-case one. Both query
  // paths are checked: they are two statements, and an ordering applied to
  // one of them only is exactly the regression this pins down.
  const COLLATION_FIXTURE = ['Zeta Bar', 'Bärenstüble', 'apfel', 'Änderungsbar', 'Bergbräustube'];
  const COLLATION_FIXTURE_ORDERED = [
    'Änderungsbar',
    'apfel',
    'Bärenstüble',
    'Bergbräustube',
    'Zeta Bar',
  ];

  async function createCollationFixture(cookie: string): Promise<void> {
    for (const [index, name] of COLLATION_FIXTURE.entries()) {
      const response = await adminCreateBar(cookie, {
        name,
        address: null,
        ...offsetMeters(SCHLOSS, (index + 1) * 60, 0),
      });
      expect(response.statusCode).toBe(201);
    }
  }

  it('orders bars by name, umlauts and lower-case names included', async () => {
    const cookie = await registerAdmin('boss');
    await createCollationFixture(cookie);

    const response = await adminGetBars(cookie);

    expect(response.statusCode).toBe(200);
    const names = response.json().bars.map((bar: { name: string }) => bar.name);
    // The seeded OSM bar sorts last of the six, after "Zeta Bar".
    expect(names).toEqual([...COLLATION_FIXTURE_ORDERED, 'Zum Schlossgarten']);
  });

  it('orders bars by name on the source-filtered path too', async () => {
    const cookie = await registerAdmin('boss');
    await createCollationFixture(cookie);

    const response = await adminGetBars(cookie, '?source=admin');

    expect(response.statusCode).toBe(200);
    const names = response.json().bars.map((bar: { name: string }) => bar.name);
    expect(names).toEqual(COLLATION_FIXTURE_ORDERED);
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

  // SPEC.md Sections 7.8/9.3: an invisible switch that changes who wins is
  // worse than no switch, so the flag has to be readable on the list the
  // admin already looks at, not only writable through the PATCH below.
  it('reports excludedFromRankings for every user, defaulting to false', async () => {
    const adminCookie = await registerAdmin('boss');
    await registerUser('walker');
    db.prepare('UPDATE users SET excluded_from_rankings = 1 WHERE username = ?').run('boss');

    const users = (await adminGetUsers(adminCookie)).json().users;

    expect(
      users.find((user: { username: string }) => user.username === 'boss').excludedFromRankings,
    ).toBe(true);
    expect(
      users.find((user: { username: string }) => user.username === 'walker').excludedFromRankings,
    ).toBe(false);
  });

  // SPEC.md Section 5.3 and ios/SPEC.md 9.2: the background-tracking consent
  // timestamp is not shown on the admin user list, which has no reason to
  // know. Asserted with the column set, so the absence is the shape refusing
  // to carry a value rather than the value happening to be NULL.
  it('never carries backgroundTrackingConsentedAt, even for an account that has consented', async () => {
    const adminCookie = await registerAdmin('boss');
    await registerUser('walker');
    db.prepare(
      'UPDATE users SET background_tracking_consented_at = 1700000000 WHERE username = ?',
    ).run('walker');

    const users = (await adminGetUsers(adminCookie)).json().users;

    for (const user of users) {
      expect(user).not.toHaveProperty('backgroundTrackingConsentedAt');
      expect(user).not.toHaveProperty('background_tracking_consented_at');
    }
  });

  it('never carries it on PATCH /api/admin/users/:id either, which answers with the same shape', async () => {
    const adminCookie = await registerAdmin('boss');
    const walkerId = (await adminGetUsers(adminCookie)).json().users[0].id as number;
    db.prepare('UPDATE users SET background_tracking_consented_at = 1700000000 WHERE id = ?').run(
      walkerId,
    );

    const response = await injectWithOrigin({
      method: 'PATCH',
      url: `/api/admin/users/${walkerId}`,
      headers: { cookie: adminCookie },
      payload: { excludedFromRankings: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).not.toHaveProperty('backgroundTrackingConsentedAt');
  });
});

// SPEC.md Sections 7.8, 9.3: the only thing an admin may change about a
// user. Shaped like PATCH /api/admin/bars/:id — optional fields, omitted
// means unchanged, the full updated object in the response.
describe('PATCH /api/admin/users/:id', () => {
  it('sets and clears excludedFromRankings, answering with the updated user', async () => {
    const adminCookie = await registerAdmin('boss');
    await registerUser('walker');
    const walkerId = userIdByName('walker');

    const excluded = await adminPatchUser(adminCookie, walkerId, { excludedFromRankings: true });
    expect(excluded.statusCode).toBe(200);
    expect(excluded.json()).toMatchObject({
      id: walkerId,
      username: 'walker',
      excludedFromRankings: true,
    });

    const restored = await adminPatchUser(adminCookie, walkerId, { excludedFromRankings: false });
    expect(restored.json().excludedFromRankings).toBe(false);
  });

  it('persists the change, so the list agrees with the response', async () => {
    const adminCookie = await registerAdmin('boss');
    await registerUser('walker');
    const walkerId = userIdByName('walker');

    await adminPatchUser(adminCookie, walkerId, { excludedFromRankings: true });

    const users = (await adminGetUsers(adminCookie)).json().users;
    expect(users.find((user: { id: number }) => user.id === walkerId).excludedFromRankings).toBe(
      true,
    );
  });

  it('answers with the same shape GET /api/admin/users sends for the same user', async () => {
    const adminCookie = await registerAdmin('boss');
    await registerUser('walker');
    const walkerId = userIdByName('walker');

    const patched = await adminPatchUser(adminCookie, walkerId, {});
    const listed = (await adminGetUsers(adminCookie))
      .json()
      .users.find((user: { id: number }) => user.id === walkerId);

    expect(patched.json()).toEqual(listed);
  });

  it('leaves a user untouched when the body names no field', async () => {
    const adminCookie = await registerAdmin('boss');
    await registerUser('walker');
    const walkerId = userIdByName('walker');
    await adminPatchUser(adminCookie, walkerId, { excludedFromRankings: true });

    const response = await adminPatchUser(adminCookie, walkerId, {});

    expect(response.json().excludedFromRankings).toBe(true);
  });

  it('never sends a password or security-answer hash', async () => {
    const adminCookie = await registerAdmin('boss');
    await registerUser('walker');

    const body = (
      await adminPatchUser(adminCookie, userIdByName('walker'), { excludedFromRankings: true })
    ).json();

    expect(body).not.toHaveProperty('passwordHash');
    expect(body).not.toHaveProperty('password_hash');
    expect(body).not.toHaveProperty('securityAnswerHash');
    expect(body).not.toHaveProperty('security_answer_hash');
  });

  it('rejects a non-boolean excludedFromRankings with 400', async () => {
    const adminCookie = await registerAdmin('boss');
    await registerUser('walker');

    const response = await adminPatchUser(adminCookie, userIdByName('walker'), {
      excludedFromRankings: 'yes',
    });

    expect(response.statusCode).toBe(400);
  });

  // What it deliberately does not offer: this is one flag, not a general
  // user editor. `is_admin` is not a field of `patchUserSchema`, so zod
  // strips it and the row is unchanged — the alternative would be a route
  // that can promote accounts, which is a power Section 13.4's admin story
  // does not grant.
  it('ignores fields it does not define, including isAdmin', async () => {
    const adminCookie = await registerAdmin('boss');
    await registerUser('walker');
    const walkerId = userIdByName('walker');

    const response = await adminPatchUser(adminCookie, walkerId, {
      isAdmin: true,
      username: 'usurper',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ username: 'walker', isAdmin: false });
    const row = db
      .prepare<[number], { is_admin: number; username: string }>(
        'SELECT is_admin, username FROM users WHERE id = ?',
      )
      .get(walkerId);
    expect(row).toMatchObject({ is_admin: 0, username: 'walker' });
  });

  it.each([
    ['an unknown id', '999999'],
    ['a non-numeric id', 'abc'],
  ])('answers 404 for %s', async (_label, id) => {
    const adminCookie = await registerAdmin('boss');

    const response = await injectWithOrigin({
      method: 'PATCH',
      url: `/api/admin/users/${id}`,
      headers: { cookie: adminCookie },
      payload: { excludedFromRankings: true },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('user_not_found');
  });

  // SPEC.md Section 7.7: "Badges already awarded are a permanent record ...
  // and are never revoked." Excluding an account decides future evaluations
  // and present listings; it does not reach into the past.
  it('revokes no badge already awarded', async () => {
    const adminCookie = await registerAdmin('boss');
    await registerUser('walker');
    const walkerId = userIdByName('walker');
    db.prepare(
      `INSERT INTO badges (user_id, kind, period, period_key, value, awarded_at)
       VALUES (?, 'barfly', 'week', '2026-W32', 3, 0)`,
    ).run(walkerId);

    await adminPatchUser(adminCookie, walkerId, { excludedFromRankings: true });

    const count = db
      .prepare<[number], { count: number }>(
        'SELECT COUNT(*) AS count FROM badges WHERE user_id = ?',
      )
      .get(walkerId);
    expect(count?.count).toBe(1);
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
