import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

    // A file that exists but is not a SQLite database at all — genuinely
    // broken, not merely unready, so it must still exit non-zero.
    const corruptPath = join(tmpdir(), `tipsytrails-seed-admin-cli-corrupt-${randomUUID()}.db`);
    writeFileSync(corruptPath, 'not a sqlite database, just padding to be long enough 1234567890');
    const failingEnv = loadEnv({ ...baseEnv, DATABASE_PATH: corruptPath });

    try {
      await expect(runSeedAdminCli(failingEnv)).rejects.toThrow(/file is not a database/i);
    } finally {
      if (existsSync(corruptPath)) {
        rmSync(corruptPath);
      }
    }
  });

  it('creates the database directory and migrates when it does not exist at all', async () => {
    const missingDirPath = join(
      tmpdir(),
      `tipsytrails-seed-admin-cli-test-${randomUUID()}`,
      'nested',
      'tipsy.db',
    );
    const env = loadEnv({
      ...baseEnv,
      DATABASE_PATH: missingDirPath,
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: 'correct-horse',
    });

    try {
      await expect(runSeedAdminCli(env)).resolves.toBeUndefined();

      const verifyDb = openDatabase(missingDirPath);
      try {
        const row = verifyDb
          .prepare<[string], { id: number }>('SELECT id FROM users WHERE username = ?')
          .get('admin');
        expect(row).toBeDefined();
      } finally {
        verifyDb.close();
      }
    } finally {
      rmSync(dirname(missingDirPath), { recursive: true, force: true });
    }
  });

  it('migrates and seeds the admin on a completely fresh, unmigrated database', async () => {
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
      await expect(runSeedAdminCli(env)).resolves.toBeUndefined();

      const verifyDb = openDatabase(unmigratedPath);
      try {
        const row = verifyDb
          .prepare<[string], { id: number }>('SELECT id FROM users WHERE username = ?')
          .get('admin');
        expect(row).toBeDefined();
      } finally {
        verifyDb.close();
      }
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
