import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { openDatabase } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv } from '../env.js';
import { requireAuth } from './cookie.js';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

// A directory private to this file rather than a literal shared path —
// DATABASE_PATH is also where resolveVapidConfig (SPEC.md Section 5.9)
// looks for/generates the persisted VAPID key file, and a path shared
// across test files would mean this suite's own app builds silently
// generate/read the same key file as every other route test file.
const vapidTestDir = join(tmpdir(), `tipsytrails-password-gate-test-vapid-${randomUUID()}`);

const baseEnv = {
  NODE_ENV: 'test',
  PUBLIC_ORIGIN: 'https://tipsytrails.ahultsch.com',
  DATABASE_PATH: join(vapidTestDir, 'tipsytrails.db'),
  SESSION_SECRET: '0123456789012345678901234567890123',
};

const validRegisterBody = {
  username: 'gatewalker',
  password: 'correct horse battery staple',
  securityQuestion: 'First pet?',
  securityAnswer: 'Rex',
  ageConfirmed: true,
};

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

// SPEC.md Section 5.3's gate applies to "every endpoint except
// /api/auth/me, /api/auth/change-password and /api/auth/logout" — but at
// this phase those three are the only authenticated endpoints that exist,
// and all three are exempt. There is no real non-exempt authenticated route
// yet to assert the gate against, so — as authorised by the task — this
// registers a throwaway authenticated route on the built app instance, the
// same way ../auth/cookie.test.ts already does for requireAuth itself
// (see its `/test/protected` route).
async function buildAppWithGuardedTestRoute(): Promise<FastifyInstance> {
  const built = buildApp(loadEnv(baseEnv), db);
  built.get('/api/__test/guarded', { preHandler: requireAuth }, async () => ({ ok: true }));
  await built.ready();
  return built;
}

beforeEach(async () => {
  dbPath = join(tmpdir(), `tipsytrails-password-gate-test-${randomUUID()}.db`);
  db = openDatabase(dbPath);
  runMigrations(db, migrationsDir);
  app = await buildAppWithGuardedTestRoute();
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

async function registerAndFlagUser(): Promise<string> {
  const registerResponse = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { origin: baseEnv.PUBLIC_ORIGIN },
    payload: validRegisterBody,
  });
  const cookie = extractSessionCookie(registerResponse);

  db.prepare('UPDATE users SET must_change_password = 1 WHERE username = ?').run(
    validRegisterBody.username,
  );

  return cookie;
}

describe('must_change_password gate', () => {
  it('returns 403 with code password_change_required on a normal authenticated endpoint', async () => {
    const cookie = await registerAndFlagUser();

    const response = await app.inject({
      method: 'GET',
      url: '/api/__test/guarded',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'password_change_required' });
  });

  it('still allows GET /api/auth/me while the flag is set', async () => {
    const cookie = await registerAndFlagUser();

    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().mustChangePassword).toBe(true);
  });

  it('still allows POST /api/auth/change-password while the flag is set', async () => {
    const cookie = await registerAndFlagUser();

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie, origin: baseEnv.PUBLIC_ORIGIN },
      payload: { currentPassword: validRegisterBody.password, newPassword: 'brandnewpassword1' },
    });

    expect(response.statusCode).toBe(200);
  });

  it('still allows POST /api/auth/logout while the flag is set', async () => {
    const cookie = await registerAndFlagUser();

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie, origin: baseEnv.PUBLIC_ORIGIN },
    });

    expect(response.statusCode).toBe(200);
  });

  it('lets the previously blocked endpoint through after the password is changed', async () => {
    const cookie = await registerAndFlagUser();

    const changeResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie, origin: baseEnv.PUBLIC_ORIGIN },
      payload: { currentPassword: validRegisterBody.password, newPassword: 'brandnewpassword1' },
    });
    expect(changeResponse.statusCode).toBe(200);

    const response = await app.inject({
      method: 'GET',
      url: '/api/__test/guarded',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it('returns 401, not 403, for an unauthenticated request to an authenticated endpoint', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/__test/guarded' });

    expect(response.statusCode).toBe(401);
  });

  it('leaves GET /api/health reachable while the flag is set, with the flagged user attached', async () => {
    const cookie = await registerAndFlagUser();

    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('leaves GET /api/health reachable with no session at all', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});
