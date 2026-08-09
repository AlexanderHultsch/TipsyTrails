import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from './index.js';
import { runMigrations } from './migrate.js';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

const expectedTables = [
  'badges',
  'bar_discoveries',
  'bars',
  'cities',
  'districts',
  'fog_daily_progress',
  'fog_district_progress',
  'fog_state',
  'push_subscriptions',
  'schema_migrations',
  'sessions',
  'users',
  'visits',
].sort();

let dbPath: string;

beforeEach(() => {
  dbPath = join(tmpdir(), `tipsytrails-migrate-test-${randomUUID()}.db`);
});

afterEach(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${dbPath}${suffix}`;
    if (existsSync(file)) {
      rmSync(file);
    }
  }
});

describe('runMigrations', () => {
  it('creates exactly the tables defined in the schema', () => {
    const db = openDatabase(dbPath);
    runMigrations(db, migrationsDir);

    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all()
      .map((row) => row.name)
      .sort();

    expect(tables).toEqual(expectedTables);
    db.close();
  });

  it('applies the migration once and is a no-op on rerun', () => {
    const db = openDatabase(dbPath);

    const firstRun = runMigrations(db, migrationsDir);
    expect(firstRun).toEqual(['001_init.sql']);

    const secondRun = runMigrations(db, migrationsDir);
    expect(secondRun).toEqual([]);

    const row = db
      .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM schema_migrations')
      .get();
    expect(row?.count).toBe(1);

    db.close();
  });

  it('enables foreign key enforcement', () => {
    const db = openDatabase(dbPath);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('cascades user deletion to sessions', () => {
    const db = openDatabase(dbPath);
    runMigrations(db, migrationsDir);

    db.prepare(
      `INSERT INTO users
        (id, username, password_hash, security_question, security_answer_hash, avatar_seed, age_confirmed_at, created_at)
       VALUES (1, 'alex', 'hash', 'question', 'answer-hash', 'seed', 0, 0)`,
    ).run();
    db.prepare(
      "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ('session-1', 1, 0, 1000)",
    ).run();

    db.prepare('DELETE FROM users WHERE id = 1').run();

    const remaining = db.prepare('SELECT * FROM sessions WHERE id = ?').get('session-1');
    expect(remaining).toBeUndefined();

    db.close();
  });

  it('enforces the partial unique index on pending visits', () => {
    const db = openDatabase(dbPath);
    runMigrations(db, migrationsDir);

    db.prepare(
      `INSERT INTO cities
        (id, slug, name, origin_lat, origin_lon, grid_width, grid_height, cell_size_m, playable_cells)
       VALUES (1, 'karlsruhe', 'Karlsruhe', 49.0, 8.4, 10, 10, 50, 100)`,
    ).run();
    db.prepare(
      "INSERT INTO districts (id, city_id, name, playable_cells) VALUES (1, 1, 'Innenstadt', 50)",
    ).run();
    db.prepare(
      `INSERT INTO users
        (id, username, password_hash, security_question, security_answer_hash, avatar_seed, age_confirmed_at, created_at)
       VALUES (1, 'alex', 'hash', 'question', 'answer-hash', 'seed', 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO bars
        (id, city_id, district_id, name, lat, lon, cell_index, source, status, created_at)
       VALUES (1, 1, 1, 'Testbar', 49.0, 8.4, 0, 'osm', 'active', 0)`,
    ).run();

    db.prepare(
      "INSERT INTO visits (user_id, bar_id, started_at, last_sample_at, status) VALUES (1, 1, 0, 0, 'pending')",
    ).run();

    expect(() =>
      db
        .prepare(
          "INSERT INTO visits (user_id, bar_id, started_at, last_sample_at, status) VALUES (1, 1, 0, 0, 'pending')",
        )
        .run(),
    ).toThrow();

    expect(() =>
      db
        .prepare(
          "INSERT INTO visits (user_id, bar_id, started_at, last_sample_at, status) VALUES (1, 1, 0, 0, 'expired')",
        )
        .run(),
    ).not.toThrow();

    db.close();
  });
});
