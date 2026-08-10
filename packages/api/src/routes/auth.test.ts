import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '@tipsytrails/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { verifyPassword } from '../auth/password.js';
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

function usersCount(): number {
  return db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM users').get()?.count ?? 0;
}

function sessionsCount(): number {
  return (
    db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM sessions').get()?.count ?? 0
  );
}

beforeEach(() => {
  dbPath = join(tmpdir(), `tipsytrails-auth-test-${randomUUID()}.db`);
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

describe('POST /api/auth/register', () => {
  it('succeeds, sets a session cookie, and creates exactly one user row', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: validRegisterBody,
    });

    expect(response.statusCode).toBe(201);
    expect(extractSessionCookie(response)).toMatch(/^tt_session=/);
    expect(usersCount()).toBe(1);
  });

  it('stores argon2id hashes for the password and security answer, and the plain security question', async () => {
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: validRegisterBody });

    const row = db
      .prepare<
        [string],
        { password_hash: string; security_answer_hash: string; security_question: string }
      >(
        'SELECT password_hash, security_answer_hash, security_question FROM users WHERE username = ?',
      )
      .get(validRegisterBody.username);

    expect(row?.password_hash.startsWith('$argon2id$')).toBe(true);
    expect(row?.security_answer_hash.startsWith('$argon2id$')).toBe(true);
    expect(row?.security_question).toBe(validRegisterBody.securityQuestion);
  });

  it('matches the stored security answer hash against the lower-cased, trimmed submission', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { ...validRegisterBody, securityAnswer: '  ReX  ' },
    });

    const row = db
      .prepare<[string], { security_answer_hash: string }>(
        'SELECT security_answer_hash FROM users WHERE username = ?',
      )
      .get(validRegisterBody.username);

    expect(row).toBeDefined();
    expect(await verifyPassword(row!.security_answer_hash, 'rex')).toBe(true);
  });

  it('rejects registration when ageConfirmed is missing and creates no user', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        username: validRegisterBody.username,
        password: validRegisterBody.password,
        securityQuestion: validRegisterBody.securityQuestion,
        securityAnswer: validRegisterBody.securityAnswer,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(usersCount()).toBe(0);
  });

  it('rejects registration when ageConfirmed is false and creates no user', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { ...validRegisterBody, ageConfirmed: false },
    });

    expect(response.statusCode).toBe(400);
    expect(usersCount()).toBe(0);
  });

  it('rejects a username shorter than the minimum length', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { ...validRegisterBody, username: 'ab' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects a username longer than the maximum length', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { ...validRegisterBody, username: 'a'.repeat(21) },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects a username with characters outside the allowed set', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { ...validRegisterBody, username: 'bad name!' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects a username differing only in case from an existing one with 409', async () => {
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: validRegisterBody });

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { ...validRegisterBody, username: 'TrailWalker' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toHaveProperty('code');
    expect(usersCount()).toBe(1);
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(async () => {
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: validRegisterBody });
  });

  it('succeeds with correct credentials and sets a cookie', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: validRegisterBody.username, password: validRegisterBody.password },
    });

    expect(response.statusCode).toBe(200);
    expect(extractSessionCookie(response)).toMatch(/^tt_session=/);
  });

  it('returns the same status and body for a wrong password and an unknown username', async () => {
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: validRegisterBody.username, password: 'not-the-password' },
    });
    const unknownUsername = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'no-such-user', password: 'whatever12' },
    });

    expect(wrongPassword.statusCode).toBe(unknownUsername.statusCode);
    expect(wrongPassword.json()).toEqual(unknownUsername.json());
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the session so the cookie no longer works and removes the sessions row', async () => {
    const registerResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: validRegisterBody,
    });
    const cookie = extractSessionCookie(registerResponse);
    expect(sessionsCount()).toBe(1);

    const logoutResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });
    expect(logoutResponse.statusCode).toBe(200);
    expect(sessionsCount()).toBe(0);

    const meResponse = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });
    expect(meResponse.statusCode).toBe(401);
  });

  it('answers the same way whether or not a valid session was present', async () => {
    const registerResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: validRegisterBody,
    });
    const cookie = extractSessionCookie(registerResponse);

    const withSession = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });
    const withoutSession = await app.inject({ method: 'POST', url: '/api/auth/logout' });

    expect(withSession.statusCode).toBe(withoutSession.statusCode);
    expect(withSession.json()).toEqual(withoutSession.json());
  });
});

describe('GET /api/auth/me', () => {
  it('returns 401 without a cookie', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auth/me' });

    expect(response.statusCode).toBe(401);
  });

  it('returns the current user without any hash field or the security question', async () => {
    const registerResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: validRegisterBody,
    });
    const cookie = extractSessionCookie(registerResponse);

    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.username).toBe(validRegisterBody.username);
    expect(body).not.toHaveProperty('password_hash');
    expect(body).not.toHaveProperty('security_answer_hash');
    expect(body).not.toHaveProperty('security_question');
    expect(body).not.toHaveProperty('securityAnswerHash');
    expect(body).not.toHaveProperty('securityQuestion');
  });
});

describe('rate limiting on auth endpoints', () => {
  it('returns 429 after exceeding the auth limit on login', async () => {
    const authLimit = CONFIG.RATE_LIMITS.auth;
    const payload = { username: 'nobody', password: 'whatever12' };

    for (let i = 0; i < authLimit.limit; i++) {
      await app.inject({ method: 'POST', url: '/api/auth/login', payload });
    }

    const blocked = await app.inject({ method: 'POST', url: '/api/auth/login', payload });

    expect(blocked.statusCode).toBe(429);
  });
});
