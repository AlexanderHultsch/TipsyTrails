import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '@tipsytrails/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { verifyPassword } from '../auth/password.js';
import { openDatabase } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv } from '../env.js';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

// A directory private to this file rather than a literal shared path —
// DATABASE_PATH is also where resolveVapidConfig (SPEC.md Section 5.9)
// looks for/generates the persisted VAPID key file, and a path shared
// across test files would mean this suite's own app builds silently
// generate/read the same key file as every other route test file.
const vapidTestDir = join(tmpdir(), `tipsytrails-auth-test-vapid-${randomUUID()}`);

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

let dbPath: string;
let db: Database.Database;
let app: FastifyInstance;

function caseVariants(name: string): string[] {
  return [
    name.toLowerCase(),
    name.toUpperCase(),
    name[0].toUpperCase() + name.slice(1).toLowerCase(),
  ];
}

// Every spelling an attacker could submit for the same underlying username:
// the case variants above, plus a space-padded form. Registration's username
// schema rejects anything outside [a-zA-Z0-9_-], so a stored username never
// contains whitespace — the padded form must still resolve to the same
// account (or the same decoy) as the others.
function spellingVariants(name: string): string[] {
  return [...caseVariants(name), `  ${name}  `];
}

function extractSessionCookie(response: LightMyRequestResponse): string {
  const setCookie = response.headers['set-cookie'];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!cookieHeader) {
    throw new Error('expected a Set-Cookie header');
  }
  return cookieHeader.split(';')[0];
}

// The CSRF Origin check (Section 10.1) now runs in front of every route
// exercised here. A real browser always sends this header on these methods
// (see http/csrf.ts), so every call below carries the correct one by
// default, exactly like a genuine same-origin request from the SPA would.
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
  rmSync(vapidTestDir, { recursive: true, force: true });
});

describe('POST /api/auth/register', () => {
  it('succeeds, sets a session cookie, and creates exactly one user row', async () => {
    const response = await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/register',
      payload: validRegisterBody,
    });

    expect(response.statusCode).toBe(201);
    expect(extractSessionCookie(response)).toMatch(/^tt_session=/);
    expect(usersCount()).toBe(1);
  });

  it('stores argon2id hashes for the password and security answer, and the plain security question', async () => {
    await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/register',
      payload: validRegisterBody,
    });

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
    await injectWithOrigin({
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
    const response = await injectWithOrigin({
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
    const response = await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/register',
      payload: { ...validRegisterBody, ageConfirmed: false },
    });

    expect(response.statusCode).toBe(400);
    expect(usersCount()).toBe(0);
  });

  it('rejects a username shorter than the minimum length', async () => {
    const response = await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/register',
      payload: { ...validRegisterBody, username: 'ab' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects a username longer than the maximum length', async () => {
    const response = await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/register',
      payload: { ...validRegisterBody, username: 'a'.repeat(21) },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects a username with characters outside the allowed set', async () => {
    const response = await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/register',
      payload: { ...validRegisterBody, username: 'bad name!' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects a username differing only in case from an existing one with 409', async () => {
    await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/register',
      payload: validRegisterBody,
    });

    const response = await injectWithOrigin({
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
    await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/register',
      payload: validRegisterBody,
    });
  });

  it('succeeds with correct credentials and sets a cookie', async () => {
    const response = await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: validRegisterBody.username, password: validRegisterBody.password },
    });

    expect(response.statusCode).toBe(200);
    expect(extractSessionCookie(response)).toMatch(/^tt_session=/);
  });

  it('returns the same status and body for a wrong password and an unknown username', async () => {
    const wrongPassword = await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: validRegisterBody.username, password: 'not-the-password' },
    });
    const unknownUsername = await injectWithOrigin({
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
    const registerResponse = await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/register',
      payload: validRegisterBody,
    });
    const cookie = extractSessionCookie(registerResponse);
    expect(sessionsCount()).toBe(1);

    const logoutResponse = await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });
    expect(logoutResponse.statusCode).toBe(200);
    expect(sessionsCount()).toBe(0);

    const meResponse = await injectWithOrigin({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });
    expect(meResponse.statusCode).toBe(401);
  });

  it('answers the same way whether or not a valid session was present', async () => {
    const registerResponse = await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/register',
      payload: validRegisterBody,
    });
    const cookie = extractSessionCookie(registerResponse);

    const withSession = await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });
    const withoutSession = await injectWithOrigin({ method: 'POST', url: '/api/auth/logout' });

    expect(withSession.statusCode).toBe(withoutSession.statusCode);
    expect(withSession.json()).toEqual(withoutSession.json());
  });
});

describe('GET /api/auth/me', () => {
  it('returns 401 without a cookie', async () => {
    const response = await injectWithOrigin({ method: 'GET', url: '/api/auth/me' });

    expect(response.statusCode).toBe(401);
  });

  it('returns the current user without any hash field or the security question', async () => {
    const registerResponse = await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/register',
      payload: validRegisterBody,
    });
    const cookie = extractSessionCookie(registerResponse);

    const response = await injectWithOrigin({
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
      await injectWithOrigin({ method: 'POST', url: '/api/auth/login', payload });
    }

    const blocked = await injectWithOrigin({ method: 'POST', url: '/api/auth/login', payload });

    expect(blocked.statusCode).toBe(429);
  });
});

describe('GET /api/auth/reset/question', () => {
  it('returns the real question for a real user', async () => {
    await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/register',
      payload: validRegisterBody,
    });

    const response = await injectWithOrigin({
      method: 'GET',
      url: `/api/auth/reset/question?username=${validRegisterBody.username}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ question: validRegisterBody.securityQuestion });
  });

  it('returns 200 with the same body shape and a non-empty question for an unknown username', async () => {
    const response = await injectWithOrigin({
      method: 'GET',
      url: '/api/auth/reset/question?username=no-such-user',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Object.keys(body)).toEqual(['question']);
    expect(typeof body.question).toBe('string');
    expect(body.question.length).toBeGreaterThan(0);
  });

  it('returns a stable decoy for the same unknown username across requests', async () => {
    const first = await injectWithOrigin({
      method: 'GET',
      url: '/api/auth/reset/question?username=nobody-here',
    });
    const second = await injectWithOrigin({
      method: 'GET',
      url: '/api/auth/reset/question?username=nobody-here',
    });

    expect(first.json().question).toBe(second.json().question);
  });

  it('returns different decoys for different unknown usernames', async () => {
    const usernames = [
      'ghost1',
      'ghost2',
      'ghost3',
      'ghost4',
      'ghost5',
      'ghost6',
      'ghost7',
      'ghost8',
    ];
    const questions: string[] = [];

    for (const username of usernames) {
      const response = await injectWithOrigin({
        method: 'GET',
        url: `/api/auth/reset/question?username=${username}`,
      });
      questions.push(response.json().question);
    }

    expect(new Set(questions).size).toBeGreaterThan(1);
  });

  it('does not depend on whether other users exist', async () => {
    const before = await injectWithOrigin({
      method: 'GET',
      url: '/api/auth/reset/question?username=still-unknown',
    });

    await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/register',
      payload: validRegisterBody,
    });

    const after = await injectWithOrigin({
      method: 'GET',
      url: '/api/auth/reset/question?username=still-unknown',
    });

    expect(before.json().question).toBe(after.json().question);
  });

  it('returns the identical decoy for an unknown username across different casings', async () => {
    const questions: string[] = [];

    for (const username of caseVariants('ghostwriter')) {
      const response = await injectWithOrigin({
        method: 'GET',
        url: `/api/auth/reset/question?username=${username}`,
      });
      questions.push(response.json().question);
    }

    expect(new Set(questions).size).toBe(1);
  });

  it('returns the identical decoy for an unknown username regardless of surrounding whitespace', async () => {
    const bare = await injectWithOrigin({
      method: 'GET',
      url: '/api/auth/reset/question?username=nobody-here',
    });
    const padded = await injectWithOrigin({
      method: 'GET',
      url: `/api/auth/reset/question?username=${encodeURIComponent('  nobody-here  ')}`,
    });

    expect(padded.json().question).toBe(bare.json().question);
  });

  it('returns the identical real question across the same casings that keep an unknown username indistinguishable', async () => {
    await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/register',
      payload: validRegisterBody,
    });

    const questions: string[] = [];

    for (const username of caseVariants(validRegisterBody.username)) {
      const response = await injectWithOrigin({
        method: 'GET',
        url: `/api/auth/reset/question?username=${username}`,
      });
      questions.push(response.json().question);
    }

    expect(new Set(questions).size).toBe(1);
    expect(questions[0]).toBe(validRegisterBody.securityQuestion);
  });

  it('returns the same real question for every spelling of a real username, including space-padded', async () => {
    await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/register',
      payload: validRegisterBody,
    });

    const questions: string[] = [];

    for (const username of spellingVariants(validRegisterBody.username)) {
      const response = await injectWithOrigin({
        method: 'GET',
        url: `/api/auth/reset/question?username=${encodeURIComponent(username)}`,
      });
      questions.push(response.json().question);
    }

    expect(new Set(questions).size).toBe(1);
    expect(questions[0]).toBe(validRegisterBody.securityQuestion);
  });

  it('returns the same decoy for every spelling of an unknown username, including space-padded', async () => {
    const questions: string[] = [];

    for (const username of spellingVariants('nobody-here')) {
      const response = await injectWithOrigin({
        method: 'GET',
        url: `/api/auth/reset/question?username=${encodeURIComponent(username)}`,
      });
      questions.push(response.json().question);
    }

    expect(new Set(questions).size).toBe(1);
  });
});

describe('POST /api/auth/reset', () => {
  it('resets the password and invalidates every existing session for that user', async () => {
    const registerResponse = await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/register',
      payload: validRegisterBody,
    });
    const cookie1 = extractSessionCookie(registerResponse);

    const loginResponse = await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: validRegisterBody.username, password: validRegisterBody.password },
    });
    const cookie2 = extractSessionCookie(loginResponse);

    expect(sessionsCount()).toBe(2);

    const newPassword = 'brand-new-password-1';
    const resetResponse = await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/reset',
      payload: {
        username: validRegisterBody.username,
        securityAnswer: validRegisterBody.securityAnswer,
        newPassword,
      },
    });

    expect(resetResponse.statusCode).toBe(200);
    expect(sessionsCount()).toBe(0);

    const meWithCookie1 = await injectWithOrigin({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: cookie1 },
    });
    expect(meWithCookie1.statusCode).toBe(401);

    const meWithCookie2 = await injectWithOrigin({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: cookie2 },
    });
    expect(meWithCookie2.statusCode).toBe(401);

    const loginWithNewPassword = await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: validRegisterBody.username, password: newPassword },
    });
    expect(loginWithNewPassword.statusCode).toBe(200);

    const loginWithOldPassword = await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: validRegisterBody.username, password: validRegisterBody.password },
    });
    expect(loginWithOldPassword.statusCode).toBe(401);
  });

  it('matches the answer case-insensitively and ignoring surrounding whitespace', async () => {
    await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/register',
      payload: validRegisterBody,
    });

    const newPassword = 'another-new-password-1';
    const resetResponse = await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/reset',
      payload: {
        username: validRegisterBody.username,
        securityAnswer: `  ${validRegisterBody.securityAnswer.toUpperCase()}  `,
        newPassword,
      },
    });

    expect(resetResponse.statusCode).toBe(200);

    const loginResponse = await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: validRegisterBody.username, password: newPassword },
    });
    expect(loginResponse.statusCode).toBe(200);
  });

  it('returns byte-identical responses for a wrong answer and an unknown username', async () => {
    await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/register',
      payload: validRegisterBody,
    });

    const wrongAnswer = await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/reset',
      payload: {
        username: validRegisterBody.username,
        securityAnswer: 'not-the-answer',
        newPassword: 'some-new-password-1',
      },
    });
    const unknownUsername = await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/reset',
      payload: {
        username: 'no-such-user',
        securityAnswer: 'whatever',
        newPassword: 'some-new-password-1',
      },
    });

    expect(wrongAnswer.statusCode).toBe(unknownUsername.statusCode);
    expect(wrongAnswer.json()).toEqual(unknownUsername.json());
  });
});

describe('POST /api/auth/change-password', () => {
  it('requires authentication', async () => {
    const response = await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/change-password',
      payload: { currentPassword: validRegisterBody.password, newPassword: 'brandnewpassword1' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects a wrong current password', async () => {
    const registerResponse = await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/register',
      payload: validRegisterBody,
    });
    const cookie = extractSessionCookie(registerResponse);

    const response = await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie },
      payload: { currentPassword: 'not-the-password', newPassword: 'brandnewpassword1' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('succeeds, clears must_change_password, keeps the calling session working, and invalidates other sessions', async () => {
    const registerResponse = await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/register',
      payload: validRegisterBody,
    });
    const cookie1 = extractSessionCookie(registerResponse);

    db.prepare('UPDATE users SET must_change_password = 1 WHERE username = ?').run(
      validRegisterBody.username,
    );

    const loginResponse = await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: validRegisterBody.username, password: validRegisterBody.password },
    });
    const cookie2 = extractSessionCookie(loginResponse);

    expect(sessionsCount()).toBe(2);

    const newPassword = 'brandnewpassword1';
    const changeResponse = await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie: cookie1 },
      payload: { currentPassword: validRegisterBody.password, newPassword },
    });
    expect(changeResponse.statusCode).toBe(200);

    const meWithCallingSession = await injectWithOrigin({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: cookie1 },
    });
    expect(meWithCallingSession.statusCode).toBe(200);
    expect(meWithCallingSession.json().mustChangePassword).toBe(false);

    const meWithOtherSession = await injectWithOrigin({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: cookie2 },
    });
    expect(meWithOtherSession.statusCode).toBe(401);

    expect(sessionsCount()).toBe(1);

    const loginWithNewPassword = await injectWithOrigin({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: validRegisterBody.username, password: newPassword },
    });
    expect(loginWithNewPassword.statusCode).toBe(200);
  });
});
