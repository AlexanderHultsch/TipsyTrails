import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '@tipsytrails/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { openDatabase } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import type { Env } from '../env.js';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

// A directory private to this file rather than a literal shared path —
// DATABASE_PATH is also where resolveVapidConfig (SPEC.md Section 5.9)
// looks for/generates the persisted VAPID key file, and a path shared
// across test files would mean this suite's own app builds silently
// generate/read the same key file as every other route test file.
const vapidTestDir = join(tmpdir(), `tipsytrails-tiles-test-vapid-${randomUUID()}`);

const baseEnv: Env = {
  NODE_ENV: 'test',
  API_HOST: '0.0.0.0',
  API_PORT: 3000,
  PUBLIC_ORIGIN: 'https://tipsytrails.ahultsch.com',
  DATABASE_PATH: join(vapidTestDir, 'tipsytrails.db'),
  SESSION_SECRET: '0123456789012345678901234567890123',
  TILES_DIR: '/data/tiles',
};

// Deterministic, non-repeating bytes: byte i is i % 256. A slice compare
// against this catches an implementation that returns the whole file with a
// 206 status, since every offset has a distinguishable value.
const TILE_BYTES = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256));

let dbPath: string;
let db: Database.Database;

beforeAll(() => {
  dbPath = join(tmpdir(), `tipsytrails-tiles-test-db-${randomUUID()}.db`);
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

describe('GET /tiles/:filename with a present extract', () => {
  let tilesDir: string;
  let app: FastifyInstance;

  beforeEach(() => {
    tilesDir = join(tmpdir(), `tipsytrails-tiles-${randomUUID()}`);
    mkdirSync(tilesDir, { recursive: true });
    writeFileSync(join(tilesDir, CONFIG.TILES_FILENAME), TILE_BYTES);
    app = buildApp({ ...baseEnv, TILES_DIR: tilesDir }, db);
  });

  afterEach(() => {
    rmSync(tilesDir, { recursive: true, force: true });
  });

  it('returns 200 with the full body for an unranged request', async () => {
    const response = await app.inject({ method: 'GET', url: `/tiles/${CONFIG.TILES_FILENAME}` });

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.length).toBe(TILE_BYTES.length);
    expect(response.rawPayload.equals(TILE_BYTES)).toBe(true);
  });

  it('returns 206 with the exact 100-byte slice for Range: bytes=0-99', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/tiles/${CONFIG.TILES_FILENAME}`,
      headers: { range: 'bytes=0-99' },
    });

    expect(response.statusCode).toBe(206);
    expect(response.headers['content-range']).toBe(`bytes 0-99/${TILE_BYTES.length}`);
    expect(response.rawPayload.length).toBe(100);
    expect(response.rawPayload.equals(TILE_BYTES.subarray(0, 100))).toBe(true);
  });

  it('returns the matching slice for a second, different range', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/tiles/${CONFIG.TILES_FILENAME}`,
      headers: { range: 'bytes=200-249' },
    });

    expect(response.statusCode).toBe(206);
    expect(response.headers['content-range']).toBe(`bytes 200-249/${TILE_BYTES.length}`);
    expect(response.rawPayload.length).toBe(50);
    expect(response.rawPayload.equals(TILE_BYTES.subarray(200, 250))).toBe(true);
  });

  it('carries the cacheable Cache-Control header, not no-store', async () => {
    const response = await app.inject({ method: 'GET', url: `/tiles/${CONFIG.TILES_FILENAME}` });

    expect(response.headers['cache-control']).toBe('public, max-age=2592000');
  });

  it('refuses a request for a filename other than the configured one', async () => {
    const response = await app.inject({ method: 'GET', url: '/tiles/other.pmtiles' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'tile_not_found' });
  });

  it('cannot escape the tiles directory via a .. segment', async () => {
    const outsideDir = join(tmpdir(), `tipsytrails-tiles-outside-${randomUUID()}`);
    mkdirSync(outsideDir, { recursive: true });
    const secretPath = join(outsideDir, 'secret.txt');
    writeFileSync(secretPath, 'do not serve me');

    try {
      // Encoded as a single path segment (%2F for the slash) so the request
      // reaches the /tiles/:filename handler with the traversal string as
      // the filename param, exercising the exact-match guard rather than
      // relying on the router rejecting a multi-segment URL outright.
      const traversal = relative(tilesDir, secretPath);
      const response = await app.inject({
        method: 'GET',
        url: `/tiles/${encodeURIComponent(traversal)}`,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: 'tile_not_found' });
      expect(response.body).not.toContain('do not serve me');
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe('GET /tiles/:filename with no extract present', () => {
  let tilesDir: string;
  let app: FastifyInstance;

  beforeEach(() => {
    tilesDir = join(tmpdir(), `tipsytrails-tiles-missing-${randomUUID()}`);
    mkdirSync(tilesDir, { recursive: true });
    app = buildApp({ ...baseEnv, TILES_DIR: tilesDir }, db);
  });

  afterEach(() => {
    rmSync(tilesDir, { recursive: true, force: true });
  });

  it('answers with a stable machine-readable error', async () => {
    const response = await app.inject({ method: 'GET', url: `/tiles/${CONFIG.TILES_FILENAME}` });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'tiles_unavailable' });
  });

  it('keeps GET /api/health working', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});
