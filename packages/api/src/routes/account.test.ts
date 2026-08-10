import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { openDatabase } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv } from '../env.js';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

const baseEnv = {
  NODE_ENV: 'test',
  PUBLIC_ORIGIN: 'https://tipsytrails.ahultsch.com',
  DATABASE_PATH: '/tmp/test.db',
  SESSION_SECRET: '0123456789012345678901234567890123',
};

const validRegisterBody = {
  username: 'trailwalker',
  password: 'correct horse battery staple',
  securityQuestion: 'First pet?',
  securityAnswer: 'Rex',
  ageConfirmed: true,
};

// Every table declared with a foreign key to users(id) ON DELETE CASCADE in
// 001_init.sql, verified against the migration rather than assumed. `bars`
// also references users(id) via submitted_by, but that column is nullable
// and not cascading — it is asserted separately below.
const REFERENCING_TABLES = [
  'sessions',
  'fog_state',
  'fog_district_progress',
  'fog_daily_progress',
  'bar_discoveries',
  'visits',
  'badges',
  'push_subscriptions',
];

let dbPath: string;
let db: Database.Database;
let app: FastifyInstance;

function extractSessionCookie(response: LightMyRequestResponse): string {
  const setCookie = response.headers['set-cookie'];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!cookieHeader) {
    throw new Error('expected a Set-Cookie header');
  }
  return cookieHeader.split(';')[0];
}

// The CSRF Origin check (Section 10.1) runs in front of every route exercised
// here. Both routes under test are state-changing, so every call below must
// carry the same Origin header a genuine same-origin request from the SPA
// would (see http/csrf.ts), exactly as in auth.test.ts.
function injectWithOrigin(options: InjectOptions): Promise<LightMyRequestResponse> {
  return app.inject({
    ...options,
    headers: { origin: baseEnv.PUBLIC_ORIGIN, ...options.headers },
  });
}

function usersCount(): number {
  return db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM users').get()?.count ?? 0;
}

function sessionsCount(): number {
  return (
    db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM sessions').get()?.count ?? 0
  );
}

function countForUser(table: string, userId: number): number {
  return (
    db
      .prepare<[number], { count: number }>(
        `SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`,
      )
      .get(userId)?.count ?? 0
  );
}

async function registerUser(): Promise<{ cookie: string; userId: number }> {
  const response = await injectWithOrigin({
    method: 'POST',
    url: '/api/auth/register',
    payload: validRegisterBody,
  });
  const cookie = extractSessionCookie(response);
  const userId = response.json().id as number;
  return { cookie, userId };
}

function seedCity(): number {
  const result = db
    .prepare(
      `INSERT INTO cities (slug, name, origin_lat, origin_lon, grid_width, grid_height, cell_size_m, playable_cells)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('karlsruhe', 'Karlsruhe', 49.0, 8.4, 100, 100, 50, 5000);
  return Number(result.lastInsertRowid);
}

function seedDistrict(cityId: number): number {
  const result = db
    .prepare('INSERT INTO districts (city_id, name, playable_cells) VALUES (?, ?, ?)')
    .run(cityId, 'Innenstadt', 500);
  return Number(result.lastInsertRowid);
}

function seedBar(cityId: number, districtId: number, submittedBy: number): number {
  const now = Math.floor(Date.now() / 1000);
  const result = db
    .prepare(
      `INSERT INTO bars
        (city_id, district_id, name, address, lat, lon, cell_index, source, submitted_by, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      cityId,
      districtId,
      'Test Bar',
      'Test Str. 1',
      49.01,
      8.41,
      42,
      'community',
      submittedBy,
      'active',
      now,
    );
  return Number(result.lastInsertRowid);
}

// Inserts one row per table in REFERENCING_TABLES for the given user, plus
// the `sessions` row already created by registration. `sessions` is covered
// by registerUser() and is not re-inserted here.
function seedReferencingRows(
  userId: number,
  cityId: number,
  districtId: number,
  barId: number,
): void {
  const now = Math.floor(Date.now() / 1000);

  db.prepare(
    'INSERT INTO fog_state (user_id, city_id, mask, revealed_cells, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(userId, cityId, Buffer.from([0]), 1, now);

  db.prepare(
    'INSERT INTO fog_district_progress (user_id, district_id, revealed_cells) VALUES (?, ?, ?)',
  ).run(userId, districtId, 1);

  db.prepare(
    'INSERT INTO fog_daily_progress (user_id, city_id, day, revealed_cells) VALUES (?, ?, ?, ?)',
  ).run(userId, cityId, '2026-08-10', 1);

  db.prepare('INSERT INTO bar_discoveries (user_id, bar_id, discovered_at) VALUES (?, ?, ?)').run(
    userId,
    barId,
    now,
  );

  db.prepare(
    `INSERT INTO visits (user_id, bar_id, started_at, last_sample_at, onsite_samples, confirmed_s, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(userId, barId, now, now, 1, 0, 'pending');

  db.prepare(
    `INSERT INTO badges (user_id, kind, period, period_key, value, awarded_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(userId, 'explorer', 'week', '2026-W32', 0.5, now);

  db.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(userId, 'https://push.example/endpoint', 'p256dh-key', 'auth-key', now);
}

beforeEach(() => {
  dbPath = join(tmpdir(), `tipsytrails-account-test-${randomUUID()}.db`);
  db = openDatabase(dbPath);
  runMigrations(db, migrationsDir);
  app = buildApp(loadEnv(baseEnv), db);
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

describe('PATCH /api/settings', () => {
  it('returns 401 without a session', async () => {
    const response = await injectWithOrigin({
      method: 'PATCH',
      url: '/api/settings',
      payload: { isAnonymous: true },
    });

    expect(response.statusCode).toBe(401);
  });

  it('toggles isAnonymous to true then back to false, persisting and reflecting in the response and /api/auth/me', async () => {
    const { cookie } = await registerUser();

    const toTrue = await injectWithOrigin({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { isAnonymous: true },
    });
    expect(toTrue.statusCode).toBe(200);
    expect(toTrue.json().isAnonymous).toBe(true);

    const meAfterTrue = await injectWithOrigin({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });
    expect(meAfterTrue.json().isAnonymous).toBe(true);

    const toFalse = await injectWithOrigin({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { isAnonymous: false },
    });
    expect(toFalse.statusCode).toBe(200);
    expect(toFalse.json().isAnonymous).toBe(false);

    const meAfterFalse = await injectWithOrigin({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });
    expect(meAfterFalse.json().isAnonymous).toBe(false);
  });
});

describe('DELETE /api/account', () => {
  it('returns 401 without a session', async () => {
    const response = await injectWithOrigin({
      method: 'DELETE',
      url: '/api/account',
      payload: { password: validRegisterBody.password },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects a wrong password without deleting, returning the same generic failure as login', async () => {
    const { cookie } = await registerUser();

    const response = await injectWithOrigin({
      method: 'DELETE',
      url: '/api/account',
      headers: { cookie },
      payload: { password: 'not-the-password' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      code: 'invalid_credentials',
      message: 'Invalid username or password.',
    });
    expect(usersCount()).toBe(1);
  });

  it('hard-deletes the user and cascades every referencing table, while shared catalogue data survives', async () => {
    const { cookie, userId } = await registerUser();
    const cityId = seedCity();
    const districtId = seedDistrict(cityId);
    const barId = seedBar(cityId, districtId, userId);
    seedReferencingRows(userId, cityId, districtId, barId);

    expect(sessionsCount()).toBeGreaterThan(0);
    for (const table of REFERENCING_TABLES) {
      expect(countForUser(table, userId)).toBeGreaterThan(0);
    }

    const response = await injectWithOrigin({
      method: 'DELETE',
      url: '/api/account',
      headers: { cookie },
      payload: { password: validRegisterBody.password },
    });

    expect(response.statusCode).toBe(200);
    expect(usersCount()).toBe(0);

    for (const table of REFERENCING_TABLES) {
      expect(countForUser(table, userId)).toBe(0);
    }

    const city = db.prepare('SELECT id FROM cities WHERE id = ?').get(cityId);
    expect(city).toBeDefined();

    const district = db.prepare('SELECT id FROM districts WHERE id = ?').get(districtId);
    expect(district).toBeDefined();

    const bar = db
      .prepare<[number], { submitted_by: number | null }>(
        'SELECT submitted_by FROM bars WHERE id = ?',
      )
      .get(barId);
    expect(bar).toBeDefined();
    expect(bar!.submitted_by).toBeNull();

    const meResponse = await injectWithOrigin({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });
    expect(meResponse.statusCode).toBe(401);
  });
});
