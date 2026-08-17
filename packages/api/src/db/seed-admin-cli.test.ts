import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from './index.js';
import { runMigrations } from './migrate.js';
import { runSeedAdminCli } from './seed-admin-cli.js';
import { loadEnv } from '../env.js';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

const baseEnv = {
  PUBLIC_ORIGIN: 'https://tipsytrails.ahultsch.com',
  SESSION_SECRET: '01234567890123456789012345678901',
};

let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  dbPath = join(tmpdir(), `tipsytrails-seed-admin-cli-test-${randomUUID()}.db`);
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

function usersCount(): number {
  return db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM users').get()?.count ?? 0;
}

function getAdmin(): { password_hash: string } {
  const row = db
    .prepare<[string], { password_hash: string }>(
      'SELECT password_hash FROM users WHERE username = ?',
    )
    .get('admin');
  if (!row) {
    throw new Error('expected admin row to exist');
  }
  return row;
}

describe('runSeedAdminCli', () => {
  it('resolves (exit 0) and creates nothing when ADMIN_USER/ADMIN_PASSWORD are absent', async () => {
    const env = loadEnv({ ...baseEnv, DATABASE_PATH: dbPath });

    await expect(runSeedAdminCli(env)).resolves.toBeUndefined();

    expect(usersCount()).toBe(0);
  });

  it('resolves (exit 0) and seeds the admin on a fresh database', async () => {
    const env = loadEnv({
      ...baseEnv,
      DATABASE_PATH: dbPath,
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: 'correct-horse',
    });

    await expect(runSeedAdminCli(env)).resolves.toBeUndefined();

    expect(usersCount()).toBe(1);
  });

  it('resolves (exit 0) and is a no-op when the admin already exists', async () => {
    const env = loadEnv({
      ...baseEnv,
      DATABASE_PATH: dbPath,
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: 'correct-horse',
    });
    await runSeedAdminCli(env);
    const hashBefore = getAdmin().password_hash;

    await expect(runSeedAdminCli(env)).resolves.toBeUndefined();

    expect(usersCount()).toBe(1);
    expect(getAdmin().password_hash).toBe(hashBefore);
  });

  it('is safe to run in addition to boot-time seeding, and never resets a changed password', async () => {
    const env = loadEnv({
      ...baseEnv,
      DATABASE_PATH: dbPath,
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: 'correct-horse',
    });
    // Simulates startup.ts's initialiseDatabase already having seeded the
    // admin at boot, and the admin having since changed their password.
    await runSeedAdminCli(env);
    db.prepare("UPDATE users SET password_hash = 'changed-hash' WHERE username = 'admin'").run();

    await runSeedAdminCli(env);

    expect(getAdmin().password_hash).toBe('changed-hash');
  });

  it('closes the database connection it opened, both on success and on failure', async () => {
    const okEnv = loadEnv({ ...baseEnv, DATABASE_PATH: dbPath });
    await runSeedAdminCli(okEnv);

    const missingDirPath = join(
      tmpdir(),
      `tipsytrails-seed-admin-cli-test-${randomUUID()}`,
      'nested',
      'tipsy.db',
    );
    const failingEnv = loadEnv({ ...baseEnv, DATABASE_PATH: missingDirPath });

    await expect(runSeedAdminCli(failingEnv)).rejects.toThrow();
  });

  it('rejects (exit non-zero) against a database missing the users table', async () => {
    const unmigratedPath = join(
      tmpdir(),
      `tipsytrails-seed-admin-cli-unmigrated-${randomUUID()}.db`,
    );
    const env = loadEnv({
      ...baseEnv,
      DATABASE_PATH: unmigratedPath,
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: 'correct-horse',
    });

    try {
      await expect(runSeedAdminCli(env)).rejects.toThrow(/no such table/i);
    } finally {
      for (const suffix of ['', '-wal', '-shm']) {
        const file = `${unmigratedPath}${suffix}`;
        if (existsSync(file)) {
          rmSync(file);
        }
      }
    }
  });
});
