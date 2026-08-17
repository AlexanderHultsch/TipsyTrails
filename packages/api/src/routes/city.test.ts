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
import { seedCity } from '../db/seed-city.js';
import { loadEnv } from '../env.js';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

// The real committed data/seed/karlsruhe tree, four levels up from this
// file's own directory to the repository root — the same style
// routes/static-data.test.ts uses.
const REAL_SEED_DIR = fileURLToPath(new URL('../../../../data/seed', import.meta.url));

// A directory private to this file rather than a literal shared path —
// DATABASE_PATH is also where resolveVapidConfig (SPEC.md Section 5.9)
// looks for/generates the persisted VAPID key file, and a path shared
// across test files would mean this suite's own app builds silently
// generate/read the same key file as every other route test file.
const vapidTestDir = join(tmpdir(), `tipsytrails-city-test-vapid-${randomUUID()}`);

const baseEnv = {
  NODE_ENV: 'test',
  PUBLIC_ORIGIN: 'https://tipsytrails.ahultsch.com',
  DATABASE_PATH: join(vapidTestDir, 'tipsytrails.db'),
  SESSION_SECRET: '0123456789012345678901234567890123',
  SEED_DIR: REAL_SEED_DIR,
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

function injectWithOrigin(options: InjectOptions): Promise<LightMyRequestResponse> {
  return app.inject({
    ...options,
    headers: { origin: baseEnv.PUBLIC_ORIGIN, ...options.headers },
  });
}

function extractSessionCookie(response: LightMyRequestResponse): string {
  const setCookie = response.headers['set-cookie'];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!cookieHeader) {
    throw new Error('expected a Set-Cookie header');
  }
  return cookieHeader.split(';')[0];
}

async function registerUser(): Promise<string> {
  const response = await injectWithOrigin({
    method: 'POST',
    url: '/api/auth/register',
    payload: validRegisterBody,
  });
  return extractSessionCookie(response);
}

beforeEach(() => {
  dbPath = join(tmpdir(), `tipsytrails-city-test-${randomUUID()}.db`);
  db = openDatabase(dbPath);
  runMigrations(db, migrationsDir);
  const env = loadEnv(baseEnv);
  seedCity(db, env);
  app = buildApp(env, db);
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

describe('GET /api/city', () => {
  it('returns 401 without a session', async () => {
    const response = await injectWithOrigin({ method: 'GET', url: '/api/city' });

    expect(response.statusCode).toBe(401);
  });

  it('returns the active city and all 27 districts for an authenticated session', async () => {
    const cookie = await registerUser();

    const response = await injectWithOrigin({
      method: 'GET',
      url: '/api/city',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body).toMatchObject({
      slug: 'karlsruhe',
      name: 'Karlsruhe',
      cellSizeM: 50,
    });
    expect(typeof body.originLat).toBe('number');
    expect(typeof body.originLon).toBe('number');
    expect(typeof body.gridWidth).toBe('number');
    expect(typeof body.gridHeight).toBe('number');
    expect(typeof body.playableCells).toBe('number');

    expect(Array.isArray(body.districts)).toBe(true);
    expect(body.districts).toHaveLength(27);
    for (const district of body.districts) {
      expect(typeof district.id).toBe('number');
      expect(typeof district.name).toBe('string');
      expect(typeof district.playableCells).toBe('number');
    }

    const dbDistrictCount = db
      .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM districts')
      .get()?.count;
    expect(dbDistrictCount).toBe(27);
  });

  it('carries the no-store cache header like every other /api response', async () => {
    const cookie = await registerUser();

    const response = await injectWithOrigin({
      method: 'GET',
      url: '/api/city',
      headers: { cookie },
    });

    expect(response.headers['cache-control']).toBe('private, no-store');
  });
});
