import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '@tipsytrails/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { openDatabase } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, type Env } from '../env.js';
import { createRateLimiter } from './rate-limit.js';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

// A directory private to this file rather than a literal shared path —
// DATABASE_PATH is also where resolveVapidConfig (SPEC.md Section 5.9)
// looks for/generates the persisted VAPID key file, and a path shared
// across test files would mean this suite's own app builds silently
// generate/read the same key file as every other route test file.
const vapidTestDir = join(tmpdir(), `tipsytrails-ratelimit-test-vapid-${randomUUID()}`);

const baseEnv = {
  NODE_ENV: 'test',
  PUBLIC_ORIGIN: 'https://tipsytrails.ahultsch.com',
  DATABASE_PATH: join(vapidTestDir, 'tipsytrails.db'),
  SESSION_SECRET: '0123456789012345678901234567890123',
};

let dbPath: string;
let db: Database.Database;

beforeAll(() => {
  dbPath = join(tmpdir(), `tipsytrails-ratelimit-test-${randomUUID()}.db`);
  db = openDatabase(dbPath);
  runMigrations(db, migrationsDir);
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

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function buildTestApp(env: Env = loadEnv(baseEnv)): FastifyInstance {
  const app = buildApp(env, db);
  app.get('/test/global-limited', { preHandler: createRateLimiter('authGlobal') }, async () => {
    return { ok: true };
  });
  app.get('/test/register-limited', { preHandler: createRateLimiter('register') }, async () => {
    return { ok: true };
  });
  app.get(
    '/test/username-limited',
    {
      preHandler: createRateLimiter('loginByUser', {
        getUsername: (request) => String((request.query as { username?: unknown }).username ?? ''),
      }),
    },
    async () => {
      return { ok: true };
    },
  );
  return app;
}

const globalLimit = CONFIG.RATE_LIMITS.authGlobal;
const usernameLimit = CONFIG.RATE_LIMITS.loginByUser;

describe('createRateLimiter (by: global)', () => {
  it('allows requests up to the limit and rejects the next with 429', async () => {
    const app = buildTestApp();

    for (let i = 0; i < globalLimit.limit; i++) {
      const response = await app.inject({ method: 'GET', url: '/test/global-limited' });
      expect(response.statusCode).toBe(200);
    }

    const blocked = await app.inject({ method: 'GET', url: '/test/global-limited' });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toHaveProperty('code');
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('allows requests again after the window elapses', async () => {
    const app = buildTestApp();

    for (let i = 0; i < globalLimit.limit; i++) {
      await app.inject({ method: 'GET', url: '/test/global-limited' });
    }
    const blocked = await app.inject({ method: 'GET', url: '/test/global-limited' });
    expect(blocked.statusCode).toBe(429);

    vi.advanceTimersByTime(globalLimit.windowMs);

    const afterWindow = await app.inject({ method: 'GET', url: '/test/global-limited' });
    expect(afterWindow.statusCode).toBe(200);
  });

  it('puts every caller in one bucket whatever address the request appears to come from', async () => {
    const app = buildTestApp();

    for (let i = 0; i < globalLimit.limit; i++) {
      const response = await app.inject({
        method: 'GET',
        url: '/test/global-limited',
        headers: { 'x-forwarded-for': '203.0.113.7' },
      });
      expect(response.statusCode).toBe(200);
    }

    // A global ceiling that a second address could walk around would not be a
    // ceiling. This is the accepted cost recorded in SPEC.md Section 9.4:
    // exhaustible on purpose, and set high enough that nobody honest meets it.
    const otherAddress = await app.inject({
      method: 'GET',
      url: '/test/global-limited',
      headers: { 'x-forwarded-for': '198.51.100.4' },
    });
    expect(otherAddress.statusCode).toBe(429);
  });
});

describe('createRateLimiter (by: username)', () => {
  it('gives two different usernames independent buckets', async () => {
    const app = buildTestApp();

    for (let i = 0; i < usernameLimit.limit; i++) {
      const response = await app.inject({
        method: 'GET',
        url: '/test/username-limited?username=hunted',
      });
      expect(response.statusCode).toBe(200);
    }
    const blocked = await app.inject({
      method: 'GET',
      url: '/test/username-limited?username=hunted',
    });
    expect(blocked.statusCode).toBe(429);

    const other = await app.inject({
      method: 'GET',
      url: '/test/username-limited?username=bystander',
    });
    expect(other.statusCode).toBe(200);
  });

  it('folds case and surrounding whitespace into the one bucket the account has', async () => {
    const app = buildTestApp();

    for (let i = 0; i < usernameLimit.limit; i++) {
      const response = await app.inject({
        method: 'GET',
        url: '/test/username-limited?username=hunted',
      });
      expect(response.statusCode).toBe(200);
    }

    // `users.username` is UNIQUE COLLATE NOCASE, so these name the account
    // `hunted` already spent its bucket on. Normalising here rather than at
    // the call sites is what makes that true of every `by: 'username'` limit.
    for (const spelling of ['HUNTED', 'hUnTeD', encodeURIComponent('  hunted  ')]) {
      const blocked = await app.inject({
        method: 'GET',
        url: `/test/username-limited?username=${spelling}`,
      });
      expect(blocked.statusCode, `spelling ${spelling} got its own bucket`).toBe(429);
    }
  });

  it('keeps one bucket per username however many addresses the requests claim to come from', async () => {
    const app = buildTestApp();

    for (let i = 0; i < usernameLimit.limit; i++) {
      const response = await app.inject({
        method: 'GET',
        url: '/test/username-limited?username=hunted',
        headers: { 'x-forwarded-for': `203.0.113.${i}` },
      });
      expect(response.statusCode).toBe(200);
    }

    // Rotating source addresses is exactly what automated guessing does, and
    // it is the reason the login limit is keyed on the account instead.
    const blocked = await app.inject({
      method: 'GET',
      url: '/test/username-limited?username=hunted',
      headers: { 'x-forwarded-for': '198.51.100.4' },
    });
    expect(blocked.statusCode).toBe(429);
  });
});

describe('createRateLimiter — separate named limits', () => {
  it('exhausting one limit leaves a route guarded by another limit unaffected', async () => {
    const app = buildTestApp();

    for (let i = 0; i < globalLimit.limit; i++) {
      await app.inject({ method: 'GET', url: '/test/global-limited' });
    }
    const blocked = await app.inject({ method: 'GET', url: '/test/global-limited' });
    expect(blocked.statusCode).toBe(429);

    // Both limits are `by: 'global'` and so resolve to the same identity; the
    // limiter's name in the bucket key is the only thing keeping them apart.
    const stillWorks = await app.inject({ method: 'GET', url: '/test/register-limited' });
    expect(stillWorks.statusCode).toBe(200);
  });
});
