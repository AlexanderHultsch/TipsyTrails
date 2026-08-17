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
  app.get('/test/auth-limited', { preHandler: createRateLimiter('auth') }, async () => {
    return { ok: true };
  });
  app.get('/test/reset-ip-limited', { preHandler: createRateLimiter('resetByIp') }, async () => {
    return { ok: true };
  });
  return app;
}

const authLimit = CONFIG.RATE_LIMITS.auth;

describe('createRateLimiter (by: ip)', () => {
  it('allows requests up to the limit and rejects the next with 429', async () => {
    const app = buildTestApp();

    for (let i = 0; i < authLimit.limit; i++) {
      const response = await app.inject({ method: 'GET', url: '/test/auth-limited' });
      expect(response.statusCode).toBe(200);
    }

    const blocked = await app.inject({ method: 'GET', url: '/test/auth-limited' });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toHaveProperty('code');
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('allows requests again after the window elapses', async () => {
    const app = buildTestApp();

    for (let i = 0; i < authLimit.limit; i++) {
      await app.inject({ method: 'GET', url: '/test/auth-limited' });
    }
    const blocked = await app.inject({ method: 'GET', url: '/test/auth-limited' });
    expect(blocked.statusCode).toBe(429);

    vi.advanceTimersByTime(authLimit.windowMs);

    const afterWindow = await app.inject({ method: 'GET', url: '/test/auth-limited' });
    expect(afterWindow.statusCode).toBe(200);
  });

  it('gives two different client IPs independent buckets', async () => {
    const app = buildTestApp();

    for (let i = 0; i < authLimit.limit; i++) {
      const response = await app.inject({
        method: 'GET',
        url: '/test/auth-limited',
        headers: { 'x-forwarded-for': '203.0.113.7' },
      });
      expect(response.statusCode).toBe(200);
    }
    const blocked = await app.inject({
      method: 'GET',
      url: '/test/auth-limited',
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    expect(blocked.statusCode).toBe(429);

    const otherIp = await app.inject({
      method: 'GET',
      url: '/test/auth-limited',
      headers: { 'x-forwarded-for': '198.51.100.4' },
    });
    expect(otherIp.statusCode).toBe(200);
  });

  it('does not let a forged left-most X-Forwarded-For entry mint a fresh bucket per request', async () => {
    const app = buildTestApp();

    for (let i = 0; i < authLimit.limit; i++) {
      const response = await app.inject({
        method: 'GET',
        url: '/test/auth-limited',
        headers: { 'x-forwarded-for': `9.9.9.${i}, 203.0.113.7` },
      });
      expect(response.statusCode).toBe(200);
    }

    const blocked = await app.inject({
      method: 'GET',
      url: '/test/auth-limited',
      headers: { 'x-forwarded-for': `9.9.9.${authLimit.limit}, 203.0.113.7` },
    });
    expect(blocked.statusCode).toBe(429);
  });
});

describe('createRateLimiter — separate named limits', () => {
  it('exhausting one limit leaves a route guarded by another limit unaffected', async () => {
    const app = buildTestApp();

    for (let i = 0; i < authLimit.limit; i++) {
      await app.inject({ method: 'GET', url: '/test/auth-limited' });
    }
    const blocked = await app.inject({ method: 'GET', url: '/test/auth-limited' });
    expect(blocked.statusCode).toBe(429);

    const stillWorks = await app.inject({ method: 'GET', url: '/test/reset-ip-limited' });
    expect(stillWorks.statusCode).toBe(200);
  });
});
