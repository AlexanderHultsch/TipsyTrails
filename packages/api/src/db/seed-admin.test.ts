import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { verifyPassword } from '../auth/password.js';
import { createSession } from '../auth/session.js';
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

// Sessions are counted, never listed: a session id is a bearer credential and
// has no business in a test's output (Section 4.3 — nothing on this path may
// print a password, a hash or a session id).
function sessionsCount(): number {
  return (
    db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM sessions').get()?.count ?? 0
  );
}

function sessionsCountFor(userId: number): number {
  return (
    db
      .prepare<[number], { count: number }>(
        'SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?',
      )
      .get(userId)?.count ?? 0
  );
}

// An ordinary player, so every assertion below can say whose sessions ended
// and whose did not. Rotation is scoped to one account, and "it deleted the
// right rows" and "it deleted every row" look identical with only one user in
// the table.
function insertPlayer(username: string): number {
  const now = Math.floor(Date.now() / 1000);
  const result = db
    .prepare(
      `INSERT INTO users
        (username, password_hash, security_question, security_answer_hash, avatar_seed, age_confirmed_at, created_at)
       VALUES (?, 'not-a-real-hash', 'First pet?', 'not-a-real-hash', ?, ?, ?)`,
    )
    .run(username, randomUUID(), now, now);
  return Number(result.lastInsertRowid);
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

  it('never ends a session, however many times the container restarts', async () => {
    // The second half of the same safety property. Rotation revokes; boot
    // calls this function, and if the revocation could be reached from here
    // the admin would be signed out on every restart and every rebuild — on
    // top of having their password reverted.
    const env = loadEnv({ ...baseEnv, ADMIN_USER: 'admin', ADMIN_PASSWORD: 'correct-horse' });
    await seedAdmin(db, env);
    const adminId = getAdmin().id;
    const playerId = insertPlayer('trailwalker');
    createSession(db, adminId);
    createSession(db, playerId);

    const rotatingEnv = loadEnv({
      ...baseEnv,
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: 'the-newly-rotated-shared-password',
    });
    for (let restart = 0; restart < 3; restart += 1) {
      expect(await seedAdmin(db, rotatingEnv)).toBe('exists');
    }

    expect(sessionsCountFor(adminId)).toBe(1);
    expect(sessionsCountFor(playerId)).toBe(1);
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

  it("ends every session the admin held, and no other account's", async () => {
    // A session opened under the old password would otherwise stay valid for
    // the rest of its 90-day sliding expiry (Section 5.4), which is the whole
    // of the difference between hygiene and a response to a leak.
    const env = loadEnv({ ...baseEnv, ADMIN_USER: 'admin', ADMIN_PASSWORD: 'correct-horse' });
    await seedAdmin(db, env);
    const adminId = getAdmin().id;
    const playerId = insertPlayer('trailwalker');
    // Two, because an operator's phone and laptop are the ordinary case and
    // "deleted one" must not read as "deleted them all".
    createSession(db, adminId);
    createSession(db, adminId);
    createSession(db, playerId);
    expect(sessionsCount()).toBe(3);

    const rotatedEnv = loadEnv({
      ...baseEnv,
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: 'the-newly-rotated-shared-password',
    });
    const result = await seedAdminRotatingPassword(db, rotatedEnv);

    expect(result).toBe('rotated');
    expect(sessionsCountFor(adminId)).toBe(0);
    // Rotating one account's credential is not a reason to sign the city out.
    expect(sessionsCountFor(playerId)).toBe(1);
    expect(sessionsCount()).toBe(1);
  });

  it('ends no session when it creates the account rather than rotating one', async () => {
    // 'seeded' is not a rotation. The account is new, so it can hold nothing
    // to revoke, and a delete here would only be a no-op that implies
    // something happened. Everyone else's sessions are equally not its
    // business.
    const playerId = insertPlayer('trailwalker');
    createSession(db, playerId);

    const env = loadEnv({ ...baseEnv, ADMIN_USER: 'admin', ADMIN_PASSWORD: 'correct-horse' });
    const result = await seedAdminRotatingPassword(db, env);

    expect(result).toBe('seeded');
    expect(sessionsCountFor(playerId)).toBe(1);
    expect(sessionsCount()).toBe(1);
  });

  it('ends no session when the credentials are absent', async () => {
    const playerId = insertPlayer('trailwalker');
    createSession(db, playerId);

    const result = await seedAdminRotatingPassword(
      db,
      loadEnv({ ...baseEnv, ADMIN_USER: 'admin' }),
    );

    expect(result).toBe('no-credentials');
    expect(sessionsCount()).toBe(1);
    expect(sessionsCountFor(playerId)).toBe(1);
  });

  it('writes the hash and ends the sessions in one transaction, or neither', async () => {
    // The two halves must not be able to half-happen: a hash written without
    // the revocation leaves the old password's sessions alive while the
    // operator is told they are gone, and a revocation without the hash signs
    // the admin out and hands them back the old password to sign in with.
    // A trigger that refuses the DELETE is the cheapest way to fail the second
    // write after the first has already been made, and it fails inside the
    // transaction exactly as a locked database or a disk error would.
    const env = loadEnv({ ...baseEnv, ADMIN_USER: 'admin', ADMIN_PASSWORD: 'correct-horse' });
    await seedAdmin(db, env);
    const adminId = getAdmin().id;
    createSession(db, adminId);
    const hashBefore = getAdmin().password_hash;

    db.exec(
      `CREATE TRIGGER refuse_session_delete BEFORE DELETE ON sessions
         BEGIN SELECT RAISE(ABORT, 'session delete refused by test'); END`,
    );
    const rotatedEnv = loadEnv({
      ...baseEnv,
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: 'the-newly-rotated-shared-password',
    });

    try {
      await expect(seedAdminRotatingPassword(db, rotatedEnv)).rejects.toThrow(
        /session delete refused by test/,
      );
    } finally {
      db.exec('DROP TRIGGER refuse_session_delete');
    }

    // Rolled back: the password the operator was never told about is not left
    // standing, and the session is still the one it was.
    expect(getAdmin().password_hash).toBe(hashBefore);
    expect(await verifyPassword(getAdmin().password_hash, 'correct-horse')).toBe(true);
    expect(sessionsCountFor(adminId)).toBe(1);
  });
});

// The claim the operator is being sold is not "a row was deleted", it is "the
// cookie in the hands of whoever had the old password no longer opens
// anything". That is only provable against the running app, so this block
// signs in for real, over HTTP, and asks the server afterwards.
describe('seedAdminRotatingPassword against a live session', () => {
  // Private to this describe: buildApp's resolveVapidConfig (Section 5.9)
  // generates a key file next to DATABASE_PATH, and a path shared with
  // another test file would mean sharing that key file too.
  let vapidDir: string;
  let app: FastifyInstance;

  const origin = baseEnv.PUBLIC_ORIGIN;

  function cookieFrom(response: LightMyRequestResponse): string {
    const setCookie = response.headers['set-cookie'];
    const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (!header) {
      throw new Error('expected a Set-Cookie header');
    }
    // Only the `name=value` pair, exactly as a browser would send it back.
    return header.split(';')[0];
  }

  function login(password: string): Promise<LightMyRequestResponse> {
    // The CSRF Origin check (Section 10.1) runs in front of this route, so
    // the header is the one a same-origin request from the SPA would carry.
    return app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin },
      payload: { username: 'admin', password },
    });
  }

  beforeEach(() => {
    vapidDir = join(tmpdir(), `tipsytrails-seed-admin-app-test-${randomUUID()}`);
    app = buildApp(
      loadEnv({ ...baseEnv, NODE_ENV: 'test', DATABASE_PATH: join(vapidDir, 'tipsytrails.db') }),
      db,
    );
  });

  afterEach(() => {
    rmSync(vapidDir, { recursive: true, force: true });
  });

  it('leaves a session minted under the old password unable to authenticate', async () => {
    const env = loadEnv({ ...baseEnv, ADMIN_USER: 'admin', ADMIN_PASSWORD: 'correct-horse' });
    await seedAdmin(db, env);
    const adminId = getAdmin().id;

    const signedIn = await login('correct-horse');
    expect(signedIn.statusCode).toBe(200);
    const oldCookie = cookieFrom(signedIn);
    expect(sessionsCountFor(adminId)).toBe(1);

    // It works before the rotation, or the assertion after it proves nothing.
    const before = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: oldCookie },
    });
    expect(before.statusCode).toBe(200);

    const rotatedEnv = loadEnv({
      ...baseEnv,
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: 'the-newly-rotated-shared-password',
    });
    expect(await seedAdminRotatingPassword(db, rotatedEnv)).toBe('rotated');

    // The table, and then the app: the row is gone, and the cookie that row
    // backed is now worth nothing to a real request.
    expect(sessionsCountFor(adminId)).toBe(0);
    const after = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: oldCookie },
    });
    expect(after.statusCode).toBe(401);

    // And the rotation itself landed: the old password is dead at the door,
    // the new one opens it, and the session it opens is a new row.
    expect((await login('correct-horse')).statusCode).toBe(401);
    const signedInAgain = await login('the-newly-rotated-shared-password');
    expect(signedInAgain.statusCode).toBe(200);
    expect(cookieFrom(signedInAgain)).not.toBe(oldCookie);
    expect(sessionsCountFor(adminId)).toBe(1);
  });

  it('leaves a signed-in player exactly where they were', async () => {
    // The operator rotating the admin credential is not a reason to sign the
    // city out, and `deleteSessionsForUser` is scoped to one account for
    // precisely that reason.
    const env = loadEnv({ ...baseEnv, ADMIN_USER: 'admin', ADMIN_PASSWORD: 'correct-horse' });
    await seedAdmin(db, env);

    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { origin },
      payload: {
        username: 'trailwalker',
        password: 'correct horse battery staple',
        securityQuestion: 'First pet?',
        securityAnswer: 'Rex',
        ageConfirmed: true,
      },
    });
    expect(registered.statusCode).toBe(201);
    const playerCookie = cookieFrom(registered);

    const rotatedEnv = loadEnv({
      ...baseEnv,
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: 'the-newly-rotated-shared-password',
    });
    expect(await seedAdminRotatingPassword(db, rotatedEnv)).toBe('rotated');

    const stillSignedIn = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: playerCookie },
    });
    expect(stillSignedIn.statusCode).toBe(200);
    expect(stillSignedIn.json().username).toBe('trailwalker');
  });
});
