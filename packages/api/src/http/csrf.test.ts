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

const foreignOrigin = 'https://evil.example';

const registerBody = {
  username: 'originwalker',
  password: 'correct horse battery staple',
  securityQuestion: 'First pet?',
  securityAnswer: 'Rex',
  ageConfirmed: true,
};

let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  dbPath = join(tmpdir(), `tipsytrails-csrf-test-${randomUUID()}.db`);
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

describe('CSRF Origin check', () => {
  it('rejects a POST carrying an Origin header from another site with 403', async () => {
    const app = buildApp(loadEnv(baseEnv), db);

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { origin: foreignOrigin },
      payload: registerBody,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'origin_mismatch' });
  });

  it('accepts the same POST when the Origin header matches PUBLIC_ORIGIN', async () => {
    const app = buildApp(loadEnv(baseEnv), db);

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { origin: baseEnv.PUBLIC_ORIGIN },
      payload: registerBody,
    });

    expect(response.statusCode).toBe(201);
  });

  it('rejects a POST with no Origin header at all (fails closed on a missing header)', async () => {
    const app = buildApp(loadEnv(baseEnv), db);

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: registerBody,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'origin_mismatch' });
  });

  it('never rejects GET, even with a foreign Origin header', async () => {
    const app = buildApp(loadEnv(baseEnv), db);

    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: foreignOrigin },
    });

    expect(response.statusCode).toBe(200);
  });

  it('never rejects HEAD, even with a foreign Origin header', async () => {
    const app = buildApp(loadEnv(baseEnv), db);

    const response = await app.inject({
      method: 'HEAD',
      url: '/api/health',
      headers: { origin: foreignOrigin },
    });

    expect(response.statusCode).toBe(200);
  });
});
