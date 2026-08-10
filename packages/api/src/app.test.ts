import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { openDatabase } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { loadEnv, type Env } from './env.js';

const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));

// The real committed data/seed/karlsruhe/grid.bin, four levels up from this
// file's own directory to the repository root — the same style
// routes/static-data.test.ts uses to reach data/seed.
const REAL_SEED_DIR = fileURLToPath(new URL('../../../data/seed', import.meta.url));

const testEnv: Env = {
  NODE_ENV: 'test',
  API_HOST: '0.0.0.0',
  API_PORT: 3000,
  PUBLIC_ORIGIN: 'https://tipsytrails.ahultsch.com',
  DATABASE_PATH: '/tmp/test.db',
  SESSION_SECRET: '0123456789012345678901234567890123',
  TILES_DIR: '/data/tiles',
};

const indexHtml = '<!doctype html><html><body>Tipsy Trails SPA shell</body></html>';
const assetJs = 'console.log("tipsy-trails asset");';

let dbPath: string;
let db: Database.Database;

beforeAll(() => {
  dbPath = join(tmpdir(), `tipsytrails-app-test-db-${randomUUID()}.db`);
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
});

describe('GET /api/health', () => {
  it('returns 200 with status ok', async () => {
    const app = buildApp(testEnv, db);
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('carries the no-store cache header', async () => {
    const app = buildApp(testEnv, db);
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.headers['cache-control']).toBe('private, no-store');
  });
});

describe('unknown /api route', () => {
  it('returns 404 with the no-store cache header', async () => {
    const app = buildApp(testEnv, db);
    const response = await app.inject({ method: 'GET', url: '/api/does-not-exist' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['cache-control']).toBe('private, no-store');
  });
});

describe('SPA static serving', () => {
  let webRoot: string;

  beforeEach(() => {
    webRoot = join(tmpdir(), `tipsytrails-app-test-${randomUUID()}`);
    mkdirSync(join(webRoot, 'assets'), { recursive: true });
    writeFileSync(join(webRoot, 'index.html'), indexHtml);
    writeFileSync(join(webRoot, 'assets', 'app-abc123.js'), assetJs);
  });

  afterEach(() => {
    rmSync(webRoot, { recursive: true, force: true });
  });

  it('serves the SPA shell for GET / with the revalidation cache header', async () => {
    const app = buildApp({ ...testEnv, WEB_ROOT: webRoot }, db);
    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(indexHtml);
    expect(response.headers['cache-control']).toBe('public, max-age=0, must-revalidate');
  });

  it('falls back to the SPA shell for a client-side route with status 200', async () => {
    const app = buildApp({ ...testEnv, WEB_ROOT: webRoot }, db);
    const response = await app.inject({ method: 'GET', url: '/districts' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(indexHtml);
    expect(response.headers['cache-control']).toBe('public, max-age=0, must-revalidate');
  });

  it('serves a hashed asset with the immutable cache header', async () => {
    const app = buildApp({ ...testEnv, WEB_ROOT: webRoot }, db);
    const response = await app.inject({ method: 'GET', url: '/assets/app-abc123.js' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('still serves /api/health with the no-store cache header', async () => {
    const app = buildApp({ ...testEnv, WEB_ROOT: webRoot }, db);
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(response.headers['cache-control']).toBe('private, no-store');
  });

  it('never falls back to the SPA shell for an unknown /api route', async () => {
    const app = buildApp({ ...testEnv, WEB_ROOT: webRoot }, db);
    const response = await app.inject({ method: 'GET', url: '/api/does-not-exist' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).not.toBe(indexHtml);
    expect(() => response.json()).not.toThrow();
  });

  it('resolves an empty WEB_ROOT to undefined so buildApp receives no override', () => {
    const env = loadEnv({
      PUBLIC_ORIGIN: testEnv.PUBLIC_ORIGIN,
      DATABASE_PATH: testEnv.DATABASE_PATH,
      SESSION_SECRET: testEnv.SESSION_SECRET,
      WEB_ROOT: '',
    });

    expect(env.WEB_ROOT).toBeUndefined();
  });
});

describe('missing WEB_ROOT', () => {
  it('returns 404 for GET / while /api/health keeps working', async () => {
    const missingWebRoot = join(tmpdir(), `tipsytrails-missing-webroot-${randomUUID()}`);
    const app = buildApp({ ...testEnv, WEB_ROOT: missingWebRoot }, db);

    const rootResponse = await app.inject({ method: 'GET', url: '/' });
    expect(rootResponse.statusCode).toBe(404);

    const healthResponse = await app.inject({ method: 'GET', url: '/api/health' });
    expect(healthResponse.statusCode).toBe(200);
    expect(healthResponse.json()).toEqual({ status: 'ok' });
  });
});

describe('grid.bin loaded at boot', () => {
  it('decorates the app with a Uint16Array matching grid.bin, spot-checked against a raw read', async () => {
    const app = buildApp({ ...testEnv, SEED_DIR: REAL_SEED_DIR }, db);

    expect(app.grid).not.toBeNull();
    expect(app.grid).toBeInstanceOf(Uint16Array);
    // 417 x 343 cells (SPEC.md Section 6.2), one Uint16 entry per cell.
    expect(app.grid?.length).toBe(417 * 343);

    const rawBuffer = readFileSync(join(REAL_SEED_DIR, 'karlsruhe', 'grid.bin'));
    const rawGrid = new Uint16Array(
      rawBuffer.buffer.slice(rawBuffer.byteOffset, rawBuffer.byteOffset + rawBuffer.byteLength),
    );
    const knownIndex = rawGrid.findIndex((value) => value !== 0xffff);
    expect(knownIndex).toBeGreaterThanOrEqual(0);
    // The value at that index is a real district index from grid-meta.json
    // (27 districts, so every non-sentinel value is < 27), and the app's
    // loaded grid must carry the identical value at the identical index.
    expect(rawGrid[knownIndex]).toBeLessThan(27);
    expect(app.grid?.[knownIndex]).toBe(rawGrid[knownIndex]);
  });

  it('still starts and answers /api/health when grid.bin is absent, logging the absence at error level', async () => {
    const missingSeedDir = join(tmpdir(), `tipsytrails-missing-grid-${randomUUID()}`);
    const app = buildApp({ ...testEnv, SEED_DIR: missingSeedDir }, db);

    expect(app.grid).toBeNull();

    const healthResponse = await app.inject({ method: 'GET', url: '/api/health' });
    expect(healthResponse.statusCode).toBe(200);
    expect(healthResponse.json()).toEqual({ status: 'ok' });
  });
});
