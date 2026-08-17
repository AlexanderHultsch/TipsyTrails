import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { openDatabase } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, type Env } from '../env.js';
import { requireAuth, setSessionCookie } from './cookie.js';
import { createSession } from './session.js';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

// A directory private to this file rather than a literal shared path —
// DATABASE_PATH is also where resolveVapidConfig (SPEC.md Section 5.9)
// looks for/generates the persisted VAPID key file, and a path shared
// across test files would mean this suite's own app builds silently
// generate/read the same key file as every other route test file.
const vapidTestDir = join(tmpdir(), `tipsytrails-cookie-test-vapid-${randomUUID()}`);

const baseEnv = {
  NODE_ENV: 'test',
  DATABASE_PATH: join(vapidTestDir, 'tipsytrails.db'),
  SESSION_SECRET: '0123456789012345678901234567890123',
};

let dbPath: string;
let db: Database.Database;

beforeAll(() => {
  dbPath = join(tmpdir(), `tipsytrails-cookie-test-${randomUUID()}.db`);
  db = openDatabase(dbPath);
  runMigrations(db, migrationsDir);
  db.prepare(
    `INSERT INTO users
      (id, username, password_hash, security_question, security_answer_hash, avatar_seed, age_confirmed_at, created_at)
     VALUES (1, 'alex', 'hash', 'question', 'answer-hash', 'seed', 0, 0)`,
  ).run();
});

afterAll(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${dbPath}${suffix}`;
    if (existsSync(file)) {
      rmSync(file);
    }
  }
  rmSync(vapidTestDir, { recursive: true, force: true });
});

async function buildTestApp(env: Env) {
  const app = buildApp(env, db);
  app.get('/test/protected', { preHandler: requireAuth }, async (request) => {
    return { userId: request.userId };
  });
  app.get('/test/set-cookie', async (_request, reply) => {
    const session = createSession(db, 1);
    setSessionCookie(reply, env, session.id);
    return { ok: true };
  });
  await app.ready();
  return app;
}

describe('requireAuth', () => {
  it('returns 401 with a JSON error body when there is no cookie', async () => {
    const env = loadEnv({ ...baseEnv, PUBLIC_ORIGIN: 'https://tipsytrails.ahultsch.com' });
    const app = await buildTestApp(env);

    const response = await app.inject({ method: 'GET', url: '/test/protected' });

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.json()).toHaveProperty('code');
  });

  it('returns 401 for a syntactically valid but unknown session id', async () => {
    const env = loadEnv({ ...baseEnv, PUBLIC_ORIGIN: 'https://tipsytrails.ahultsch.com' });
    const app = await buildTestApp(env);
    const unknownId = randomBytes(32).toString('base64url');
    const signed = app.signCookie(unknownId);

    const response = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: { cookie: `tt_session=${signed}` },
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns 401 for a tampered signature', async () => {
    const env = loadEnv({ ...baseEnv, PUBLIC_ORIGIN: 'https://tipsytrails.ahultsch.com' });
    const app = await buildTestApp(env);
    const session = createSession(db, 1);
    const signed = app.signCookie(session.id);
    const tampered = `${signed.slice(0, -1)}${signed.at(-1) === 'a' ? 'b' : 'a'}`;

    const response = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: { cookie: `tt_session=${tampered}` },
    });

    expect(response.statusCode).toBe(401);
  });

  it('lets the route run and see the right user id for a valid session', async () => {
    const env = loadEnv({ ...baseEnv, PUBLIC_ORIGIN: 'https://tipsytrails.ahultsch.com' });
    const app = await buildTestApp(env);
    const session = createSession(db, 1);
    const signed = app.signCookie(session.id);

    const response = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: { cookie: `tt_session=${signed}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ userId: 1 });
  });
});

describe('setSessionCookie', () => {
  it('sets HttpOnly, SameSite=Lax, Path=/ and Secure when PUBLIC_ORIGIN is https', async () => {
    const env = loadEnv({ ...baseEnv, PUBLIC_ORIGIN: 'https://tipsytrails.ahultsch.com' });
    const app = await buildTestApp(env);

    const response = await app.inject({ method: 'GET', url: '/test/set-cookie' });

    const setCookie = response.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookieHeader).toBeDefined();
    expect(cookieHeader).toMatch(/HttpOnly/);
    expect(cookieHeader).toMatch(/SameSite=Lax/);
    expect(cookieHeader).toMatch(/Path=\//);
    expect(cookieHeader).toMatch(/Secure/);
  });

  it('does not set Secure when PUBLIC_ORIGIN is http', async () => {
    const env = loadEnv({ ...baseEnv, PUBLIC_ORIGIN: 'http://localhost:3000' });
    const app = await buildTestApp(env);

    const response = await app.inject({ method: 'GET', url: '/test/set-cookie' });

    const setCookie = response.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookieHeader).toBeDefined();
    expect(cookieHeader).not.toMatch(/Secure/);
  });
});
