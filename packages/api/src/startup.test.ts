import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './db/index.js';
import { loadEnv } from './env.js';
import { initialiseDatabase } from './startup.js';

// The real committed seed tree (data/seed/karlsruhe and its sibling
// data/cities/karlsruhe.json), three levels up from this file's own
// directory to the repository root — the same style
// routes/static-data.test.ts uses to reach data/seed. City seeding
// (db/seed-city.ts) needs both on every boot, unlike admin seeding.
const REAL_SEED_DIR = fileURLToPath(new URL('../../../data/seed', import.meta.url));

const baseEnv = {
  PUBLIC_ORIGIN: 'https://tipsytrails.ahultsch.com',
  SESSION_SECRET: '01234567890123456789012345678901',
  SEED_DIR: REAL_SEED_DIR,
};

let dbPath: string;
let db: Database.Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${dbPath}${suffix}`;
    if (existsSync(file)) {
      rmSync(file);
    }
  }
});

function usersCount(): number {
  return (
    db?.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM users').get()?.count ?? 0
  );
}

describe('initialiseDatabase', () => {
  it('creates the database file and applies migrations', async () => {
    dbPath = join(tmpdir(), `tipsytrails-startup-test-${randomUUID()}.db`);
    const env = loadEnv({ ...baseEnv, DATABASE_PATH: dbPath });

    db = await initialiseDatabase(env);

    expect(existsSync(dbPath)).toBe(true);
    const migrations = db
      .prepare<[], { filename: string }>('SELECT filename FROM schema_migrations')
      .all();
    expect(migrations.map((row) => row.filename)).toEqual([
      '001_init.sql',
      '002_clear_admin_must_change_password.sql',
      '003_users_excluded_from_rankings.sql',
    ]);
  });

  it('is idempotent on a second call against the same path', async () => {
    dbPath = join(tmpdir(), `tipsytrails-startup-test-${randomUUID()}.db`);
    const env = loadEnv({ ...baseEnv, DATABASE_PATH: dbPath });

    const firstDb = await initialiseDatabase(env);
    const migrationRow = firstDb
      .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM schema_migrations')
      .get();
    expect(migrationRow?.count).toBe(3);
    const userRow = firstDb
      .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM users')
      .get();
    const usersBefore = userRow?.count ?? 0;
    firstDb.close();

    db = await initialiseDatabase(env);

    const migrationRowAfter = db
      .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM schema_migrations')
      .get();
    expect(migrationRowAfter?.count).toBe(3);
    expect(usersCount()).toBe(usersBefore);
  });

  it('seeds an admin when ADMIN_USER and ADMIN_PASSWORD are present', async () => {
    dbPath = join(tmpdir(), `tipsytrails-startup-test-${randomUUID()}.db`);
    const env = loadEnv({
      ...baseEnv,
      DATABASE_PATH: dbPath,
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: 'correct-horse',
    });

    db = await initialiseDatabase(env);

    const row = db
      .prepare<[string], { is_admin: number; must_change_password: number }>(
        'SELECT is_admin, must_change_password FROM users WHERE username = ?',
      )
      .get('admin');
    expect(row).toBeDefined();
    expect(row?.is_admin).toBe(1);
    expect(row?.must_change_password).toBe(0);
  });

  it('never rotates the admin password, however many times the container restarts', async () => {
    // This is the safety property the whole --rotate-password flag exists to
    // protect. initialiseDatabase runs on every boot; if it could rotate, an
    // admin who changed their own password would have it reverted to
    // ADMIN_PASSWORD by the next restart, silently. startup.ts imports
    // seedAdmin, which has no option and no code path that rotates.
    dbPath = join(tmpdir(), `tipsytrails-startup-test-${randomUUID()}.db`);
    const env = loadEnv({
      ...baseEnv,
      DATABASE_PATH: dbPath,
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: 'correct-horse',
    });

    const firstDb = await initialiseDatabase(env);
    firstDb
      .prepare("UPDATE users SET password_hash = 'self-chosen-hash' WHERE username = 'admin'")
      .run();
    firstDb.close();

    // The operator has since rotated the platform's shared credential. Only
    // `npm run seed:admin -- --rotate-password` may act on that; boot may not.
    const rotatedEnv = loadEnv({
      ...baseEnv,
      DATABASE_PATH: dbPath,
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: 'the-newly-rotated-shared-password',
    });
    for (let restart = 0; restart < 3; restart += 1) {
      const bootDb = await initialiseDatabase(rotatedEnv);
      bootDb.close();
    }

    db = openDatabase(dbPath);
    const row = db
      .prepare<[string], { password_hash: string }>(
        'SELECT password_hash FROM users WHERE username = ?',
      )
      .get('admin');
    expect(row?.password_hash).toBe('self-chosen-hash');
    expect(usersCount()).toBe(1);
  });

  it('leaves the user table empty when admin variables are absent', async () => {
    dbPath = join(tmpdir(), `tipsytrails-startup-test-${randomUUID()}.db`);
    const env = loadEnv({ ...baseEnv, DATABASE_PATH: dbPath });

    db = await initialiseDatabase(env);

    expect(existsSync(dbPath)).toBe(true);
    expect(usersCount()).toBe(0);
  });

  it('creates a missing parent directory for the database path', async () => {
    const rootDir = join(tmpdir(), `tipsytrails-startup-test-${randomUUID()}`);
    dbPath = join(rootDir, 'nested', 'deeper', 'tipsy.db');
    const env = loadEnv({ ...baseEnv, DATABASE_PATH: dbPath });

    db = await initialiseDatabase(env);

    expect(existsSync(dbPath)).toBe(true);

    db.close();
    db = undefined;
    rmSync(rootDir, { recursive: true, force: true });
  });
});
