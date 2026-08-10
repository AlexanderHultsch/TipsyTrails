import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
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

let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  dbPath = join(tmpdir(), `tipsytrails-security-headers-test-${randomUUID()}.db`);
  db = openDatabase(dbPath);
  runMigrations(db, migrationsDir);
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

describe('security headers', () => {
  it('carries the Section 10.1 baseline CSP, including worker-src blob:, on GET /api/health', async () => {
    const app = buildApp(loadEnv(baseEnv), db);
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    const csp = response.headers['content-security-policy'];
    expect(csp).toBeDefined();
    // This substring is the one that silently breaks the map later:
    // MapLibre GL instantiates its workers from blob URLs.
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toBe(
      "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; worker-src 'self' blob:; child-src 'self' blob:; style-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
  });

  it('carries X-Content-Type-Options, Referrer-Policy and X-Frame-Options', async () => {
    const app = buildApp(loadEnv(baseEnv), db);
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-frame-options']).toBe('DENY');
  });

  it("does not set Strict-Transport-Security (TLS termination is Cloudflare's business, not this container's)", async () => {
    const app = buildApp(loadEnv(baseEnv), db);
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.headers['strict-transport-security']).toBeUndefined();
  });
});
