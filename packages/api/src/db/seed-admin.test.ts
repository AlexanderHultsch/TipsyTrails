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
import { seedAdmin, seedAdminRotatingPassword } from './seed-admin.js';

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

interface AdminRow {
  id: number;
  username: string;
  password_hash: string;
  security_question: string;
  security_answer_hash: string;
  avatar_seed: string;
  is_admin: number;
  must_change_password: number;
  excluded_from_rankings: number;
  age_confirmed_at: number;
  created_at: number;
}

// Every column of the row, because the rotate path's contract is as much
// about what it leaves alone as about what it writes.
function getAdmin(username = 'admin'): AdminRow {
  const row = db
    .prepare<[string], AdminRow>(
      `SELECT id, username, password_hash, security_question, security_answer_hash, avatar_seed,
              is_admin, must_change_password, excluded_from_rankings, age_confirmed_at, created_at
         FROM users WHERE username = ?`,
    )
    .get(username);
  if (!row) {
    throw new Error('expected admin row to exist');
  }
  return row;
}

describe('seedAdmin', () => {
  it('seeds a single admin user with is_admin set and must_change_password clear', async () => {
    const env = loadEnv({ ...baseEnv, ADMIN_USER: 'admin', ADMIN_PASSWORD: 'correct-horse' });

    const result = await seedAdmin(db, env);

    expect(result).toBe('seeded');
    expect(usersCount()).toBe(1);

    const row = getAdmin();
    expect(row.is_admin).toBe(1);
    expect(row.must_change_password).toBe(0);
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

  it("is a no-op on a second run and says 'exists', not the absent-credentials answer", async () => {
    const env = loadEnv({ ...baseEnv, ADMIN_USER: 'admin', ADMIN_PASSWORD: 'correct-horse' });

    await seedAdmin(db, env);
    const hashBefore = getAdmin().password_hash;

    const secondResult = await seedAdmin(db, env);

    expect(secondResult).toBe('exists');
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

    expect(result).toBe('exists');
    expect(getAdmin().password_hash).toBe(hashBefore);
  });

  it('leaves must_change_password at 0 once the admin has changed it', async () => {
    const env = loadEnv({ ...baseEnv, ADMIN_USER: 'admin', ADMIN_PASSWORD: 'correct-horse' });
    await seedAdmin(db, env);

    db.prepare("UPDATE users SET must_change_password = 0 WHERE username = 'admin'").run();

    await seedAdmin(db, env);

    expect(getAdmin().must_change_password).toBe(0);
  });

  it("creates no user when ADMIN_PASSWORD is absent, and says so as 'no-credentials'", async () => {
    const env = loadEnv({ ...baseEnv, ADMIN_USER: 'admin' });

    const result = await seedAdmin(db, env);

    expect(result).toBe('no-credentials');
    expect(usersCount()).toBe(0);
  });

  it("creates no user when ADMIN_USER is absent, and says so as 'no-credentials'", async () => {
    const env = loadEnv({ ...baseEnv, ADMIN_PASSWORD: 'correct-horse' });

    const result = await seedAdmin(db, env);

    expect(result).toBe('no-credentials');
    expect(usersCount()).toBe(0);
  });

  it('ignores the retired ADMIN_USERNAME name and skips when only it is set', async () => {
    const env = loadEnv({
      ...baseEnv,
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'correct-horse',
    });

    const result = await seedAdmin(db, env);

    expect(result).toBe('no-credentials');
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

    expect(result).toBe('exists');
    expect(usersCount()).toBe(1);
  });

  it('never rotates, whatever the environment says, because boot calls it', async () => {
    // startup.ts runs this on every container start. If it could be talked
    // into a rotation, every restart would revert the admin's own password.
    const env = loadEnv({ ...baseEnv, ADMIN_USER: 'admin', ADMIN_PASSWORD: 'correct-horse' });
    await seedAdmin(db, env);
    db.prepare(
      "UPDATE users SET password_hash = 'self-chosen-hash' WHERE username = 'admin'",
    ).run();

    const rotatingEnv = loadEnv({
      ...baseEnv,
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: 'the-newly-rotated-shared-password',
    });
    const results = [
      await seedAdmin(db, rotatingEnv),
      await seedAdmin(db, rotatingEnv),
      await seedAdmin(db, rotatingEnv),
    ];

    expect(results).toEqual(['exists', 'exists', 'exists']);
    expect(getAdmin().password_hash).toBe('self-chosen-hash');
  });
});

describe('seedAdminRotatingPassword', () => {
  it('creates the account on a fresh database, exactly as seedAdmin would', async () => {
    const env = loadEnv({ ...baseEnv, ADMIN_USER: 'admin', ADMIN_PASSWORD: 'correct-horse' });

    const result = await seedAdminRotatingPassword(db, env);

    expect(result).toBe('seeded');
    expect(usersCount()).toBe(1);
    const row = getAdmin();
    expect(row.is_admin).toBe(1);
    expect(row.must_change_password).toBe(0);
    expect(await verifyPassword(row.password_hash, 'correct-horse')).toBe(true);
  });

  it('rewrites the stored hash from ADMIN_PASSWORD when the account exists', async () => {
    const firstEnv = loadEnv({ ...baseEnv, ADMIN_USER: 'admin', ADMIN_PASSWORD: 'correct-horse' });
    await seedAdmin(db, firstEnv);

    const rotatedEnv = loadEnv({
      ...baseEnv,
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: 'the-newly-rotated-shared-password',
    });
    const result = await seedAdminRotatingPassword(db, rotatedEnv);

    expect(result).toBe('rotated');
    expect(usersCount()).toBe(1);
    const { password_hash: hash } = getAdmin();
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'the-newly-rotated-shared-password')).toBe(true);
    expect(await verifyPassword(hash, 'correct-horse')).toBe(false);
  });

  it('overwrites a password the admin set themselves - that is what it is for', async () => {
    // The case "update only when it differs from ADMIN_PASSWORD" would also
    // hit, which is why that rule was rejected: it cannot tell this apart from
    // an operator's rotation. Here the overwrite was asked for explicitly.
    const env = loadEnv({ ...baseEnv, ADMIN_USER: 'admin', ADMIN_PASSWORD: 'correct-horse' });
    await seedAdmin(db, env);
    db.prepare(
      "UPDATE users SET password_hash = 'self-chosen-hash' WHERE username = 'admin'",
    ).run();

    const result = await seedAdminRotatingPassword(db, env);

    expect(result).toBe('rotated');
    expect(await verifyPassword(getAdmin().password_hash, 'correct-horse')).toBe(true);
  });

  it('writes password_hash and no other column', async () => {
    const firstEnv = loadEnv({ ...baseEnv, ADMIN_USER: 'admin', ADMIN_PASSWORD: 'correct-horse' });
    await seedAdmin(db, firstEnv);
    // Nothing the seeder set is the platform's to move afterwards, and
    // must_change_password in particular is 0 on purpose (Section 5.3).
    db.prepare("UPDATE users SET excluded_from_rankings = 1 WHERE username = 'admin'").run();
    const before = getAdmin();

    const rotatedEnv = loadEnv({
      ...baseEnv,
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: 'the-newly-rotated-shared-password',
    });
    await seedAdminRotatingPassword(db, rotatedEnv);

    const after = getAdmin();
    expect(after.password_hash).not.toBe(before.password_hash);
    const untouched = (row: AdminRow): Omit<AdminRow, 'password_hash'> => ({
      id: row.id,
      username: row.username,
      security_question: row.security_question,
      security_answer_hash: row.security_answer_hash,
      avatar_seed: row.avatar_seed,
      is_admin: row.is_admin,
      must_change_password: row.must_change_password,
      excluded_from_rankings: row.excluded_from_rankings,
      age_confirmed_at: row.age_confirmed_at,
      created_at: row.created_at,
    });
    expect(untouched(after)).toEqual(untouched(before));
    expect(after.must_change_password).toBe(0);
    expect(after.is_admin).toBe(1);
    // The seeded security answer is 32 random bytes nobody holds, which is
    // what keeps the recovery flow closed for this account.
    expect(after.security_answer_hash).toBe(before.security_answer_hash);
  });

  it('rotates the case-insensitively matching row rather than creating a second one', async () => {
    const seededEnv = loadEnv({ ...baseEnv, ADMIN_USER: 'Admin', ADMIN_PASSWORD: 'correct-horse' });
    await seedAdmin(db, seededEnv);

    const clashingEnv = loadEnv({
      ...baseEnv,
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: 'the-newly-rotated-shared-password',
    });
    const result = await seedAdminRotatingPassword(db, clashingEnv);

    expect(result).toBe('rotated');
    expect(usersCount()).toBe(1);
    const row = getAdmin('Admin');
    expect(row.username).toBe('Admin');
    expect(await verifyPassword(row.password_hash, 'the-newly-rotated-shared-password')).toBe(true);
  });

  it('creates and updates nothing when the credentials are absent', async () => {
    const env = loadEnv({ ...baseEnv, ADMIN_USER: 'admin' });

    const result = await seedAdminRotatingPassword(db, env);

    expect(result).toBe('no-credentials');
    expect(usersCount()).toBe(0);
  });
});
