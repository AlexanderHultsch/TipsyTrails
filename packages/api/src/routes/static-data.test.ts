import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { openDatabase } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import type { Env } from '../env.js';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

// The real committed seed data (data/seed/karlsruhe), four levels up from
// this file's own directory to the repository root — the same style
// packages/shared/src/city.test.ts uses to reach data/cities/karlsruhe.json.
const REAL_SEED_DIR = fileURLToPath(new URL('../../../../data/seed', import.meta.url));

const baseEnv: Env = {
  NODE_ENV: 'test',
  API_HOST: '0.0.0.0',
  API_PORT: 3000,
  PUBLIC_ORIGIN: 'https://tipsytrails.ahultsch.com',
  DATABASE_PATH: '/tmp/test.db',
  SESSION_SECRET: '0123456789012345678901234567890123',
  TILES_DIR: '/data/tiles',
};

const CITY_GEOJSON = JSON.stringify({
  type: 'FeatureCollection',
  features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } }],
});
const DISTRICTS_GEOJSON = JSON.stringify({ type: 'FeatureCollection', features: [] });
const NEIGHBOURS_GEOJSON = JSON.stringify({ type: 'FeatureCollection', features: [] });

let dbPath: string;
let db: Database.Database;

beforeAll(() => {
  dbPath = join(tmpdir(), `tipsytrails-static-data-test-db-${randomUUID()}.db`);
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

describe('GET /static/:slug/:filename with a fixture seed directory', () => {
  let seedDir: string;
  let app: FastifyInstance;

  beforeEach(() => {
    seedDir = join(tmpdir(), `tipsytrails-static-data-${randomUUID()}`);
    mkdirSync(join(seedDir, 'karlsruhe'), { recursive: true });
    writeFileSync(join(seedDir, 'karlsruhe', 'city.geojson'), CITY_GEOJSON);
    writeFileSync(join(seedDir, 'karlsruhe', 'districts.geojson'), DISTRICTS_GEOJSON);
    writeFileSync(join(seedDir, 'karlsruhe', 'neighbours.geojson'), NEIGHBOURS_GEOJSON);
    app = buildApp({ ...baseEnv, SEED_DIR: seedDir }, db);
  });

  afterEach(() => {
    rmSync(seedDir, { recursive: true, force: true });
  });

  it.each(['city.geojson', 'districts.geojson', 'neighbours.geojson'])(
    'serves %s with the day-long cache header and an ETag',
    async (filename) => {
      const response = await app.inject({ method: 'GET', url: `/static/karlsruhe/${filename}` });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('public, max-age=86400');
      expect(response.headers.etag).toBeTruthy();
    },
  );

  it('returns 304 for a conditional request carrying the current ETag', async () => {
    const first = await app.inject({ method: 'GET', url: '/static/karlsruhe/city.geojson' });
    const etag = first.headers.etag as string;

    const conditional = await app.inject({
      method: 'GET',
      url: '/static/karlsruhe/city.geojson',
      headers: { 'if-none-match': etag },
    });

    expect(conditional.statusCode).toBe(304);
  });

  it('refuses a filename outside the allowlist', async () => {
    const response = await app.inject({ method: 'GET', url: '/static/karlsruhe/other.json' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'static_file_not_found' });
  });

  it('cannot escape the seed directory via a .. segment in the filename', async () => {
    const outsideDir = join(tmpdir(), `tipsytrails-static-data-outside-${randomUUID()}`);
    mkdirSync(outsideDir, { recursive: true });
    const secretPath = join(outsideDir, 'secret.txt');
    writeFileSync(secretPath, 'do not serve me');

    try {
      // Encoded as a single path segment (%2F for the slash), matching how
      // routes/tiles.test.ts exercises the exact-match guard: the traversal
      // string reaches the handler as the literal filename param.
      const traversal = relative(join(seedDir, 'karlsruhe'), secretPath);
      const response = await app.inject({
        method: 'GET',
        url: `/static/karlsruhe/${encodeURIComponent(traversal)}`,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: 'static_file_not_found' });
      expect(response.body).not.toContain('do not serve me');
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('cannot escape the seed directory via a .. segment in the slug', async () => {
    // A bare ".." segment is normalised away by URL resolution before
    // routing ever sees it, landing on an unrelated (also 404) route, so it
    // would not actually exercise SLUG_PATTERN. A slug that embeds ".." plus
    // an encoded slash (%2F, as routes/tiles.test.ts uses for the same
    // reason) survives as one literal :slug segment and reaches the guard.
    const outsideDir = join(tmpdir(), `tipsytrails-static-data-outside-slug-${randomUUID()}`);
    mkdirSync(outsideDir, { recursive: true });
    const secretPath = join(outsideDir, 'secret.txt');
    writeFileSync(secretPath, 'do not serve me');

    try {
      const traversal = relative(join(seedDir, 'karlsruhe'), outsideDir);
      const response = await app.inject({
        method: 'GET',
        url: `/static/${encodeURIComponent(traversal)}/city.geojson`,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: 'static_file_not_found' });
      expect(response.body).not.toContain('do not serve me');
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe('GET /static/:slug/:filename with no seed directory present', () => {
  let missingSeedDir: string;
  let app: FastifyInstance;

  beforeEach(() => {
    missingSeedDir = join(tmpdir(), `tipsytrails-static-data-missing-${randomUUID()}`);
    app = buildApp({ ...baseEnv, SEED_DIR: missingSeedDir }, db);
  });

  it('does not prevent the app from starting or /api/health from working', async () => {
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok' });
  });

  it('answers 404 rather than crashing for a request under /static', async () => {
    const response = await app.inject({ method: 'GET', url: '/static/karlsruhe/city.geojson' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'static_file_not_found' });
  });
});

describe('GET /static/:slug/:filename against the real committed seed data', () => {
  let app: FastifyInstance;

  beforeAll(() => {
    app = buildApp({ ...baseEnv, SEED_DIR: REAL_SEED_DIR }, db);
  });

  it('serves data/seed/karlsruhe/districts.geojson with exactly 27 features', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/static/karlsruhe/districts.geojson',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=86400');
    expect(response.headers.etag).toBeTruthy();

    const body = response.json();
    expect(body.type).toBe('FeatureCollection');
    expect(body.features).toHaveLength(27);
  });
});
