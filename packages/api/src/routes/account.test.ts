import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { openDatabase } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv } from '../env.js';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

// A directory private to this file rather than a literal shared path —
// DATABASE_PATH is also where resolveVapidConfig (SPEC.md Section 5.9)
// looks for/generates the persisted VAPID key file, and a path shared
// across test files would mean this suite's own app builds silently
// generate/read the same key file as every other route test file.
const vapidTestDir = join(tmpdir(), `tipsytrails-account-test-vapid-${randomUUID()}`);

const baseEnv = {
  NODE_ENV: 'test',
  PUBLIC_ORIGIN: 'https://tipsytrails.ahultsch.com',
  DATABASE_PATH: join(vapidTestDir, 'tipsytrails.db'),
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
  rmSync(vapidTestDir, { recursive: true, force: true });
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

// SPEC.md Section 9.2 and ios/SPEC.md 9.2, whose table is the contract: two
// optional booleans of which at least one must be present, an omitted key
// meaning unchanged. One test per row of that table, then what the column
// itself has to do.
//
// The two tests above this block are the older, required-key ones and are
// deliberately unedited: every body that answered 200 before answers 200 now,
// and a body that answered 400 before answers 400 now, which is what makes
// this a strict widening rather than a new route wearing the old name.
describe('PATCH /api/settings — the partial body', () => {
  function patchSettings(cookie: string, payload: unknown): Promise<LightMyRequestResponse> {
    return injectWithOrigin({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: payload as never,
    });
  }

  function consentOf(userId: number): number | null {
    const row = db
      .prepare<[number], { background_tracking_consented_at: number | null }>(
        'SELECT background_tracking_consented_at FROM users WHERE id = ?',
      )
      .get(userId);
    if (!row) {
      throw new Error(`expected a user row for ${userId}`);
    }
    return row.background_tracking_consented_at;
  }

  function anonymityOf(userId: number): number {
    const row = db
      .prepare<[number], { is_anonymous: number }>('SELECT is_anonymous FROM users WHERE id = ?')
      .get(userId);
    if (!row) {
      throw new Error(`expected a user row for ${userId}`);
    }
    return row.is_anonymous;
  }

  // Records the SQL of every statement the route prepares while `run` is in
  // flight, so "one UPDATE naming these columns" can be asserted directly
  // rather than inferred from the two values that happened to land.
  async function recordingPreparedSql<T>(
    run: () => Promise<T>,
  ): Promise<{ result: T; prepared: string[] }> {
    const original = db.prepare.bind(db);
    const prepared: string[] = [];
    const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      prepared.push(sql);
      return original(sql);
    }) as never);
    try {
      return { result: await run(), prepared };
    } finally {
      spy.mockRestore();
    }
  }

  function updateStatements(prepared: string[]): string[] {
    return prepared.filter((sql) => sql.trimStart().toUpperCase().startsWith('UPDATE'));
  }

  function expectInvalidRequestBody(response: LightMyRequestResponse): void {
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      code: 'invalid_request',
      message: 'The request body is invalid.',
    });
  }

  it('registers a new account with no consent recorded, and says so on every route that answers with a user', async () => {
    const registerResponse = await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/register',
      payload: validRegisterBody,
    });
    expect(registerResponse.statusCode).toBe(201);
    expect(registerResponse.json().backgroundTrackingConsentedAt).toBeNull();

    const cookie = extractSessionCookie(registerResponse);
    const me = await injectWithOrigin({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });
    expect(me.json().backgroundTrackingConsentedAt).toBeNull();

    const login = await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: validRegisterBody.username, password: validRegisterBody.password },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().backgroundTrackingConsentedAt).toBeNull();

    const patch = await patchSettings(cookie, { isAnonymous: true });
    expect(patch.json().backgroundTrackingConsentedAt).toBeNull();
  });

  it('{ isAnonymous } sets anonymity and leaves consent untouched', async () => {
    const { cookie, userId } = await registerUser();
    db.prepare('UPDATE users SET background_tracking_consented_at = ? WHERE id = ?').run(
      1_700_000_000,
      userId,
    );

    const response = await patchSettings(cookie, { isAnonymous: true });

    expect(response.statusCode).toBe(200);
    expect(response.json().isAnonymous).toBe(true);
    expect(response.json().backgroundTrackingConsentedAt).toBe(1_700_000_000);
    expect(consentOf(userId)).toBe(1_700_000_000);
  });

  it('{ backgroundTracking } sets consent and leaves anonymity untouched', async () => {
    const { cookie, userId } = await registerUser();
    const anonymise = await patchSettings(cookie, { isAnonymous: true });
    expect(anonymise.statusCode).toBe(200);

    const before = Math.floor(Date.now() / 1000);
    const response = await patchSettings(cookie, { backgroundTracking: true });
    const after = Math.floor(Date.now() / 1000);

    expect(response.statusCode).toBe(200);
    // Untouched means the value it already held, not the default it started
    // at: a consent screen must never assert an anonymity value, and this is
    // the assertion that says it did not.
    expect(response.json().isAnonymous).toBe(true);
    expect(anonymityOf(userId)).toBe(1);

    const consented = response.json().backgroundTrackingConsentedAt as number;
    expect(consented).toBe(consentOf(userId));
    // Seconds, not milliseconds (Section 0, rule 6). A millisecond value
    // would be about a thousand times this and fail both bounds.
    expect(consented).toBeGreaterThanOrEqual(before);
    expect(consented).toBeLessThanOrEqual(after);
    expect(Number.isInteger(consented)).toBe(true);
  });

  it('applies both keys in one UPDATE on one row', async () => {
    const { cookie, userId } = await registerUser();

    const { result: response, prepared } = await recordingPreparedSql(() =>
      patchSettings(cookie, { isAnonymous: true, backgroundTracking: true }),
    );

    expect(response.statusCode).toBe(200);
    expect(response.json().isAnonymous).toBe(true);
    expect(response.json().backgroundTrackingConsentedAt).not.toBeNull();
    expect(anonymityOf(userId)).toBe(1);
    expect(consentOf(userId)).toBe(response.json().backgroundTrackingConsentedAt);

    // Both columns are written by a single statement, so there is no order
    // between them and no window in which one has landed and the other has
    // not (ios/SPEC.md 9.2).
    const updates = updateStatements(prepared);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain('is_anonymous = ?');
    expect(updates[0]).toContain('background_tracking_consented_at = ?');
  });

  it('names only the columns the body named, so an unnamed column is not written at all', async () => {
    const { cookie } = await registerUser();

    const { result: response, prepared } = await recordingPreparedSql(() =>
      patchSettings(cookie, { backgroundTracking: true }),
    );

    expect(response.statusCode).toBe(200);
    const updates = updateStatements(prepared);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain('background_tracking_consented_at = ?');
    expect(updates[0]).not.toContain('is_anonymous');
  });

  it('{} is a 400 and changes nothing', async () => {
    const { cookie, userId } = await registerUser();

    const response = await patchSettings(cookie, {});

    expectInvalidRequestBody(response);
    expect(anonymityOf(userId)).toBe(0);
    expect(consentOf(userId)).toBeNull();
  });

  it('a body naming only an unknown key is the same 400, so a misspelt key is loud', async () => {
    const { cookie, userId } = await registerUser();

    // The schema is deliberately not `.strict()`, so this strips to `{}` and
    // the refine catches it. Without the refine it would be a 200 that
    // recorded nothing — a consent write answering success with no consent.
    const response = await patchSettings(cookie, { backgroundTrackng: true });

    expectInvalidRequestBody(response);
    expect(consentOf(userId)).toBeNull();
  });

  it('either key null is a 400 — the column is nullable, the wire field is not', async () => {
    const { cookie, userId } = await registerUser();

    expectInvalidRequestBody(await patchSettings(cookie, { isAnonymous: null }));
    expectInvalidRequestBody(await patchSettings(cookie, { backgroundTracking: null }));
    expectInvalidRequestBody(
      await patchSettings(cookie, { isAnonymous: true, backgroundTracking: null }),
    );

    expect(anonymityOf(userId)).toBe(0);
    expect(consentOf(userId)).toBeNull();
  });

  it('either key not a boolean is a 400', async () => {
    const { cookie, userId } = await registerUser();

    expectInvalidRequestBody(await patchSettings(cookie, { isAnonymous: 'true' }));
    expectInvalidRequestBody(await patchSettings(cookie, { backgroundTracking: 5 }));
    // The one body whose treatment changes: an unknown key used to be
    // stripped and this answered 200 (ios/SPEC.md 9.2).
    expectInvalidRequestBody(
      await patchSettings(cookie, { isAnonymous: true, backgroundTracking: 5 }),
    );

    expect(anonymityOf(userId)).toBe(0);
    expect(consentOf(userId)).toBeNull();
  });

  it('a body that is not an object is a 400, as before', async () => {
    const { cookie } = await registerUser();

    expectInvalidRequestBody(
      await injectWithOrigin({
        method: 'PATCH',
        url: '/api/settings',
        headers: { cookie, 'content-type': 'application/json' },
        payload: '"backgroundTracking"',
      }),
    );
    expectInvalidRequestBody(
      await injectWithOrigin({
        method: 'PATCH',
        url: '/api/settings',
        headers: { cookie, 'content-type': 'application/json' },
        payload: 'null',
      }),
    );
  });

  it('is 401 unauthenticated, whichever keys the body names', async () => {
    const withoutSession = (payload: unknown): Promise<LightMyRequestResponse> =>
      injectWithOrigin({
        method: 'PATCH',
        url: '/api/settings',
        payload: payload as never,
      });

    expect((await withoutSession({ backgroundTracking: true })).statusCode).toBe(401);
    expect((await withoutSession({ isAnonymous: true, backgroundTracking: true })).statusCode).toBe(
      401,
    );
    // Even a body the schema would refuse: `requireAuth` runs first.
    expect((await withoutSession({})).statusCode).toBe(401);
  });

  it('false withdraws by clearing the column back to NULL', async () => {
    const { cookie, userId } = await registerUser();

    const consent = await patchSettings(cookie, { backgroundTracking: true });
    expect(consent.json().backgroundTrackingConsentedAt).not.toBeNull();

    const withdraw = await patchSettings(cookie, { backgroundTracking: false });

    expect(withdraw.statusCode).toBe(200);
    expect(withdraw.json().backgroundTrackingConsentedAt).toBeNull();
    expect(consentOf(userId)).toBeNull();
  });

  it('a repeated true re-stamps, because the record is when the player last consented', async () => {
    const { cookie, userId } = await registerUser();

    const first = await patchSettings(cookie, { backgroundTracking: true });
    const firstAt = first.json().backgroundTrackingConsentedAt as number;
    expect(firstAt).not.toBeNull();

    // Move the stored value back rather than waiting a second: the assertion
    // is that the route writes the current second over whatever was there,
    // not that two calls a millisecond apart differ.
    db.prepare('UPDATE users SET background_tracking_consented_at = ? WHERE id = ?').run(
      firstAt - 3600,
      userId,
    );

    const second = await patchSettings(cookie, { backgroundTracking: true });

    expect(second.statusCode).toBe(200);
    expect(second.json().backgroundTrackingConsentedAt).toBeGreaterThan(firstAt - 3600);
    expect(consentOf(userId)).toBe(second.json().backgroundTrackingConsentedAt);
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

  // SPEC.md Section 10.6 and ios/SPEC.md 9.2/10.4: the consent record is a
  // column on `users`, so it goes with the row and needs no clause of its
  // own. That is already true of the DELETE above — this asserts it, because
  // "the consent timestamp is deleted with the account" is a claim the
  // privacy page makes and nothing else here checks.
  it('takes the background-tracking consent record with the row', async () => {
    const { cookie, userId } = await registerUser();

    const consent = await injectWithOrigin({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { backgroundTracking: true },
    });
    expect(consent.statusCode).toBe(200);
    expect(
      db
        .prepare<[number], { background_tracking_consented_at: number | null }>(
          'SELECT background_tracking_consented_at FROM users WHERE id = ?',
        )
        .get(userId)?.background_tracking_consented_at,
    ).not.toBeNull();

    const response = await injectWithOrigin({
      method: 'DELETE',
      url: '/api/account',
      headers: { cookie },
      payload: { password: validRegisterBody.password },
    });

    expect(response.statusCode).toBe(200);
    expect(usersCount()).toBe(0);
    expect(
      db
        .prepare<[], { count: number }>(
          'SELECT COUNT(*) AS count FROM users WHERE background_tracking_consented_at IS NOT NULL',
        )
        .get()?.count,
    ).toBe(0);
  });
});
