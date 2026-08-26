import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from './index.js';
import { runMigrations } from './migrate.js';
import {
  ROTATE_PASSWORD_FLAG,
  describeSeedAdminOutcome,
  parseSeedAdminArgs,
  runSeedAdminCli,
} from './seed-admin-cli.js';
import { verifyPassword } from '../auth/password.js';
import { createSession } from '../auth/session.js';
import { loadEnv } from '../env.js';
import type { SeedAdminOutcome } from './seed-admin.js';

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

function getAdmin(): { id: number; password_hash: string } {
  const row = db
    .prepare<[string], { id: number; password_hash: string }>(
      'SELECT id, password_hash FROM users WHERE username = ?',
    )
    .get('admin');
  if (!row) {
    throw new Error('expected admin row to exist');
  }
  return row;
}

// Counted, never listed: a session id is a bearer credential and does not
// belong in test output any more than a password or a hash does.
function sessionsCountFor(userId: number): number {
  return (
    db
      .prepare<[number], { count: number }>(
        'SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?',
      )
      .get(userId)?.count ?? 0
  );
}

describe('runSeedAdminCli', () => {
  it('creates nothing and exits 1 when ADMIN_USER/ADMIN_PASSWORD are absent', async () => {
    // Not an error to throw on - the run did everything it could - but for a
    // site the platform registered `admin: yes` it is a misconfiguration, and
    // deploy.sh's `|| echo WARN` only fires on a nonzero exit (Section 4.3).
    const env = loadEnv({ ...baseEnv, DATABASE_PATH: dbPath });

    await expect(runSeedAdminCli(env, [])).resolves.toBe(1);

    expect(usersCount()).toBe(0);
  });

  it('resolves (exit 0) and seeds the admin on a fresh database', async () => {
    const env = loadEnv({
      ...baseEnv,
      DATABASE_PATH: dbPath,
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: 'correct-horse',
    });

    await expect(runSeedAdminCli(env, [])).resolves.toBe(0);

    expect(usersCount()).toBe(1);
  });

  it('resolves (exit 0) and is a no-op when the admin already exists', async () => {
    const env = loadEnv({
      ...baseEnv,
      DATABASE_PATH: dbPath,
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: 'correct-horse',
    });
    await runSeedAdminCli(env, []);
    const hashBefore = getAdmin().password_hash;

    await expect(runSeedAdminCli(env, [])).resolves.toBe(0);

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
    await runSeedAdminCli(env, []);
    db.prepare("UPDATE users SET password_hash = 'changed-hash' WHERE username = 'admin'").run();

    await runSeedAdminCli(env, []);

    expect(getAdmin().password_hash).toBe('changed-hash');
  });

  it('closes the database connection it opened, both on success and on failure', async () => {
    const okEnv = loadEnv({ ...baseEnv, DATABASE_PATH: dbPath });
    await runSeedAdminCli(okEnv, []);

    // A file that exists but is not a SQLite database at all — genuinely
    // broken, not merely unready, so it must still exit non-zero.
    const corruptPath = join(tmpdir(), `tipsytrails-seed-admin-cli-corrupt-${randomUUID()}.db`);
    writeFileSync(corruptPath, 'not a sqlite database, just padding to be long enough 1234567890');
    const failingEnv = loadEnv({ ...baseEnv, DATABASE_PATH: corruptPath });

    try {
      await expect(runSeedAdminCli(failingEnv, [])).rejects.toThrow(/file is not a database/i);
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
      await expect(runSeedAdminCli(env, [])).resolves.toBe(0);

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
      await expect(runSeedAdminCli(env, [])).resolves.toBe(0);

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

describe('parseSeedAdminArgs', () => {
  it('reports no rotation when nothing was passed', () => {
    expect(parseSeedAdminArgs([])).toEqual({ rotatePassword: false });
  });

  it('reports a rotation for --rotate-password, and that is the exact spelling', () => {
    expect(ROTATE_PASSWORD_FLAG).toBe('--rotate-password');
    expect(parseSeedAdminArgs([ROTATE_PASSWORD_FLAG])).toEqual({ rotatePassword: true });
  });

  it('ignores a bare `--`, which npm 6 forwards and npm 7 strips', () => {
    expect(parseSeedAdminArgs(['--', ROTATE_PASSWORD_FLAG])).toEqual({ rotatePassword: true });
    expect(parseSeedAdminArgs(['--'])).toEqual({ rotatePassword: false });
  });

  it('rejects a misspelled flag instead of quietly not rotating', () => {
    // The whole point of the flag is that a rotation the operator asked for
    // actually happens. Treating `--rotate-passwrod` as "no flag" would report
    // success for a password that was never written - the exact failure this
    // script was changed to eliminate.
    expect(() => parseSeedAdminArgs(['--rotate-passwrod'])).toThrow(/--rotate-passwrod/);
    expect(() => parseSeedAdminArgs(['--rotate-passwrod'])).toThrow(/--rotate-password/);
  });

  it('rejects any other argument, abbreviation or positional alike', () => {
    expect(() => parseSeedAdminArgs(['-r'])).toThrow(/unrecognised argument/i);
    expect(() => parseSeedAdminArgs(['--rotate-password=true'])).toThrow(/unrecognised argument/i);
    expect(() => parseSeedAdminArgs(['admin'])).toThrow(/unrecognised argument/i);
    expect(() => parseSeedAdminArgs([ROTATE_PASSWORD_FLAG, '--force'])).toThrow(
      /unrecognised argument/i,
    );
  });
});

describe('describeSeedAdminOutcome', () => {
  const outcomes: SeedAdminOutcome[] = ['seeded', 'rotated', 'exists', 'no-credentials'];

  it('gives each of the four outcomes its own message', () => {
    // The predecessor printed one sentence for two different outcomes and
    // diagnosing which had happened cost a shell into the running container.
    const messages = outcomes.map((outcome) => describeSeedAdminOutcome(outcome, 'admin').message);

    expect(new Set(messages).size).toBe(outcomes.length);
    for (const message of messages) {
      expect(message.startsWith('seed:admin: ')).toBe(true);
    }
  });

  it('exits non-zero only when the credentials are absent', () => {
    expect(describeSeedAdminOutcome('seeded', 'admin').exitCode).toBe(0);
    expect(describeSeedAdminOutcome('rotated', 'admin').exitCode).toBe(0);
    // Every ordinary deploy of a healthy site lands here. A warning on every
    // run is a warning nobody reads on the run that matters.
    expect(describeSeedAdminOutcome('exists', 'admin').exitCode).toBe(0);
    expect(describeSeedAdminOutcome('no-credentials', undefined).exitCode).toBe(1);
  });

  it('tells the operator how to rotate when it found the account already there', () => {
    expect(describeSeedAdminOutcome('exists', 'admin').message).toContain(ROTATE_PASSWORD_FLAG);
  });

  it('tells the operator, on the rotated line, that the existing sessions were ended', () => {
    // Both readers need it: after a leak, that the leaked sessions are
    // actually gone; after routine hygiene, why the admin was signed out.
    const { message } = describeSeedAdminOutcome('rotated', 'admin');

    expect(message).toMatch(/sessions/i);
    expect(message).toMatch(/ended/i);
    // One line, because it is read in a deploy log next to three others.
    expect(message).not.toContain('\n');
  });

  it('names neither the password nor a hash in any message', () => {
    for (const outcome of outcomes) {
      const { message } = describeSeedAdminOutcome(outcome, 'admin');
      expect(message).not.toContain('correct-horse');
      expect(message).not.toContain('$argon2id$');
    }
  });
});

describe('runSeedAdminCli --rotate-password', () => {
  it('rewrites the stored hash from ADMIN_PASSWORD and exits 0', async () => {
    const env = loadEnv({
      ...baseEnv,
      DATABASE_PATH: dbPath,
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: 'correct-horse',
    });
    await runSeedAdminCli(env, []);
    const hashBefore = getAdmin().password_hash;

    const rotatedEnv = loadEnv({
      ...baseEnv,
      DATABASE_PATH: dbPath,
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: 'the-newly-rotated-shared-password',
    });

    await expect(runSeedAdminCli(rotatedEnv, [ROTATE_PASSWORD_FLAG])).resolves.toBe(0);

    const hashAfter = getAdmin().password_hash;
    expect(hashAfter).not.toBe(hashBefore);
    expect(await verifyPassword(hashAfter, 'the-newly-rotated-shared-password')).toBe(true);
    expect(usersCount()).toBe(1);
  });

  it('creates the account on a fresh database, exactly as a run without the flag would', async () => {
    const env = loadEnv({
      ...baseEnv,
      DATABASE_PATH: dbPath,
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: 'correct-horse',
    });

    await expect(runSeedAdminCli(env, [ROTATE_PASSWORD_FLAG])).resolves.toBe(0);

    expect(usersCount()).toBe(1);
    expect(await verifyPassword(getAdmin().password_hash, 'correct-horse')).toBe(true);
  });

  it("ends the admin's existing sessions, through the flag and nothing else", async () => {
    const env = loadEnv({
      ...baseEnv,
      DATABASE_PATH: dbPath,
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: 'correct-horse',
    });
    await runSeedAdminCli(env, []);
    const adminId = getAdmin().id;
    createSession(db, adminId);

    // An ordinary run first: it finds the account, changes nothing, and must
    // leave the session alone — this is every deploy of a healthy site, and
    // it runs on every boot besides.
    await expect(runSeedAdminCli(env, [])).resolves.toBe(0);
    expect(sessionsCountFor(adminId)).toBe(1);

    const rotatedEnv = loadEnv({
      ...baseEnv,
      DATABASE_PATH: dbPath,
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: 'the-newly-rotated-shared-password',
    });

    await expect(runSeedAdminCli(rotatedEnv, [ROTATE_PASSWORD_FLAG])).resolves.toBe(0);

    expect(sessionsCountFor(adminId)).toBe(0);
  });

  it('still exits 1 with the flag when the credentials are absent', async () => {
    const env = loadEnv({ ...baseEnv, DATABASE_PATH: dbPath });

    await expect(runSeedAdminCli(env, [ROTATE_PASSWORD_FLAG])).resolves.toBe(1);

    expect(usersCount()).toBe(0);
  });

  it('rejects a mistyped flag before it opens the database at all', async () => {
    const untouchedPath = join(
      tmpdir(),
      `tipsytrails-seed-admin-cli-typo-${randomUUID()}`,
      'tipsy.db',
    );
    const env = loadEnv({
      ...baseEnv,
      DATABASE_PATH: untouchedPath,
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: 'correct-horse',
    });

    await expect(runSeedAdminCli(env, ['--rotate-passwrod'])).rejects.toThrow(
      /unrecognised argument/i,
    );

    // Not even the database directory: a run that cannot know what it was
    // asked to do does nothing at all.
    expect(existsSync(dirname(untouchedPath))).toBe(false);
  });
});
