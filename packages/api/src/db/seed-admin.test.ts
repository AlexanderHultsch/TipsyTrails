import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyPassword } from '../auth/password.js';
import { loadEnv } from '../env.js';
import { openDatabase } from './index.js';
import { runMigrations } from './migrate.js';
import { seedAdmin } from './seed-admin.js';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

const baseEnv = {
  PUBLIC_ORIGIN: 'https://tipsytrails.ahultsch.com',
  DATABASE_PATH: '/data/tipsytrails.db',
  SESSION_SECRET: '01234567890123456789012345678901',
};

let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  dbPath = join(tmpdir(), `tipsytrails-seed-admin-test-${randomUUID()}.db`);
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

function getAdmin(): {
  password_hash: string;
  is_admin: number;
  must_change_password: number;
} {
  const row = db
    .prepare<[string], { password_hash: string; is_admin: number; must_change_password: number }>(
      'SELECT password_hash, is_admin, must_change_password FROM users WHERE username = ?',
    )
    .get('admin');
  if (!row) {
    throw new Error('expected admin row to exist');
  }
  return row;
}

describe('seedAdmin', () => {
  it('seeds a single admin user with is_admin and must_change_password set', async () => {
    const env = loadEnv({ ...baseEnv, ADMIN_USER: 'admin', ADMIN_PASSWORD: 'correct-horse' });

    const result = await seedAdmin(db, env);

    expect(result).toBe('seeded');
    expect(usersCount()).toBe(1);

    const row = getAdmin();
    expect(row.is_admin).toBe(1);
    expect(row.must_change_password).toBe(1);
  });

  it('stores an argon2id password hash', async () => {
    const env = loadEnv({ ...baseEnv, ADMIN_USER: 'admin', ADMIN_PASSWORD: 'correct-horse' });

    await seedAdmin(db, env);

    expect(getAdmin().password_hash.startsWith('$argon2id$')).toBe(true);
  });

  it('hashes the seeded password so it can be verified and wrong passwords are rejected', async () => {
    const env = loadEnv({ ...baseEnv, ADMIN_USER: 'admin', ADMIN_PASSWORD: 'correct-horse' });

    await seedAdmin(db, env);

    const { password_hash: hash } = getAdmin();
    expect(await verifyPassword(hash, 'correct-horse')).toBe(true);
    expect(await verifyPassword(hash, 'wrong-password')).toBe(false);
  });

  it('is a no-op and returns skipped on a second run', async () => {
    const env = loadEnv({ ...baseEnv, ADMIN_USER: 'admin', ADMIN_PASSWORD: 'correct-horse' });

    await seedAdmin(db, env);
    const hashBefore = getAdmin().password_hash;

    const secondResult = await seedAdmin(db, env);

    expect(secondResult).toBe('skipped');
    expect(usersCount()).toBe(1);
    expect(getAdmin().password_hash).toBe(hashBefore);
  });

  it('does not re-hash and overwrite the stored hash when ADMIN_PASSWORD has since changed', async () => {
    const firstEnv = loadEnv({
      ...baseEnv,
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: 'correct-horse',
    });
    await seedAdmin(db, firstEnv);
    const hashBefore = getAdmin().password_hash;

    const secondEnv = loadEnv({
      ...baseEnv,
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: 'a-different-password',
    });
    const result = await seedAdmin(db, secondEnv);

    expect(result).toBe('skipped');
    expect(getAdmin().password_hash).toBe(hashBefore);
  });

  it('leaves must_change_password at 0 once the admin has changed it', async () => {
    const env = loadEnv({ ...baseEnv, ADMIN_USER: 'admin', ADMIN_PASSWORD: 'correct-horse' });
    await seedAdmin(db, env);

    db.prepare("UPDATE users SET must_change_password = 0 WHERE username = 'admin'").run();

    await seedAdmin(db, env);

    expect(getAdmin().must_change_password).toBe(0);
  });

  it('skips and creates no user when ADMIN_PASSWORD is absent', async () => {
    const env = loadEnv({ ...baseEnv, ADMIN_USER: 'admin' });

    const result = await seedAdmin(db, env);

    expect(result).toBe('skipped');
    expect(usersCount()).toBe(0);
  });

  it('skips and creates no user when ADMIN_USER is absent', async () => {
    const env = loadEnv({ ...baseEnv, ADMIN_PASSWORD: 'correct-horse' });

    const result = await seedAdmin(db, env);

    expect(result).toBe('skipped');
    expect(usersCount()).toBe(0);
  });

  it('ignores the retired ADMIN_USERNAME name and skips when only it is set', async () => {
    const env = loadEnv({
      ...baseEnv,
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'correct-horse',
    });

    const result = await seedAdmin(db, env);

    expect(result).toBe('skipped');
    expect(usersCount()).toBe(0);
  });

  it('treats a username differing only in case as already existing', async () => {
    const env = loadEnv({ ...baseEnv, ADMIN_USER: 'Admin', ADMIN_PASSWORD: 'correct-horse' });
    await seedAdmin(db, env);
    expect(usersCount()).toBe(1);

    const clashingEnv = loadEnv({
      ...baseEnv,
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: 'correct-horse',
    });
    const result = await seedAdmin(db, clashingEnv);

    expect(result).toBe('skipped');
    expect(usersCount()).toBe(1);
  });
});
