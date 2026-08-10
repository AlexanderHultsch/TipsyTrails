import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DERIVED } from '@tipsytrails/shared';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import {
  createSession,
  deleteSession,
  deleteSessionsForUser,
  getSession,
  purgeExpiredSessions,
} from './session.js';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

let dbPath: string;
let db: Database.Database;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function insertUser(id: number, username: string): void {
  db.prepare(
    `INSERT INTO users
      (id, username, password_hash, security_question, security_answer_hash, avatar_seed, age_confirmed_at, created_at)
     VALUES (?, ?, 'hash', 'question', 'answer-hash', 'seed', 0, 0)`,
  ).run(id, username);
}

function getExpiresAt(id: string): number | undefined {
  return db
    .prepare<[string], { expires_at: number }>('SELECT expires_at FROM sessions WHERE id = ?')
    .get(id)?.expires_at;
}

beforeEach(() => {
  dbPath = join(tmpdir(), `tipsytrails-session-test-${randomUUID()}.db`);
  db = openDatabase(dbPath);
  runMigrations(db, migrationsDir);
  insertUser(1, 'alex');
  insertUser(2, 'sam');
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

describe('createSession', () => {
  it('writes a row with a 43-character base64url id and expires_at 90 days out', () => {
    const before = nowSeconds();
    const session = createSession(db, 1);
    const after = nowSeconds();

    expect(session.id).toHaveLength(43);
    expect(session.id).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const row = db
      .prepare<[string], { user_id: number; expires_at: number }>(
        'SELECT user_id, expires_at FROM sessions WHERE id = ?',
      )
      .get(session.id);
    expect(row).toBeDefined();
    expect(row?.user_id).toBe(1);
    expect(row?.expires_at).toBeGreaterThanOrEqual(before + DERIVED.SESSION_TTL_S);
    expect(row?.expires_at).toBeLessThanOrEqual(after + DERIVED.SESSION_TTL_S);
    expect(session.expiresAt).toBe(row?.expires_at);
  });

  it('produces different ids on two calls', () => {
    const first = createSession(db, 1);
    const second = createSession(db, 1);

    expect(first.id).not.toBe(second.id);
  });
});

describe('getSession', () => {
  it('returns the user id for a live session', () => {
    const session = createSession(db, 1);

    const result = getSession(db, session.id);

    expect(result?.userId).toBe(1);
  });

  it('returns null for an unknown id', () => {
    expect(getSession(db, 'does-not-exist')).toBeNull();
  });

  it('returns null when expires_at is in the past', () => {
    const session = createSession(db, 1);
    db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(
      nowSeconds() - 60,
      session.id,
    );

    expect(getSession(db, session.id)).toBeNull();
  });

  it('does not rewrite expires_at when more than the refresh threshold remains', () => {
    const session = createSession(db, 1);
    const farFuture = nowSeconds() + DERIVED.SESSION_REFRESH_THRESHOLD_S + 60 * 60;
    db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(farFuture, session.id);

    const result = getSession(db, session.id);

    expect(result?.expiresAt).toBe(farFuture);
    expect(getExpiresAt(session.id)).toBe(farFuture);
  });

  it('extends expires_at to roughly now plus the TTL when under the refresh threshold', () => {
    const session = createSession(db, 1);
    const soon = nowSeconds() + DERIVED.SESSION_REFRESH_THRESHOLD_S - 60;
    db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(soon, session.id);

    const before = nowSeconds();
    const result = getSession(db, session.id);
    const after = nowSeconds();

    expect(result?.expiresAt).toBeGreaterThanOrEqual(before + DERIVED.SESSION_TTL_S);
    expect(result?.expiresAt).toBeLessThanOrEqual(after + DERIVED.SESSION_TTL_S);
    expect(getExpiresAt(session.id)).toBe(result?.expiresAt);
  });
});

describe('deleteSession', () => {
  it('removes only that row', () => {
    const first = createSession(db, 1);
    const second = createSession(db, 1);

    deleteSession(db, first.id);

    expect(getSession(db, first.id)).toBeNull();
    expect(getSession(db, second.id)).not.toBeNull();
  });
});

describe('deleteSessionsForUser', () => {
  it('removes every session of that user and leaves another user untouched', () => {
    const userOneFirst = createSession(db, 1);
    const userOneSecond = createSession(db, 1);
    const userTwo = createSession(db, 2);

    deleteSessionsForUser(db, 1);

    expect(getSession(db, userOneFirst.id)).toBeNull();
    expect(getSession(db, userOneSecond.id)).toBeNull();
    expect(getSession(db, userTwo.id)).not.toBeNull();
  });
});

describe('purgeExpiredSessions', () => {
  it('removes only expired rows and returns the count', () => {
    const live = createSession(db, 1);
    const expiredA = createSession(db, 1);
    const expiredB = createSession(db, 2);
    db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(
      nowSeconds() - 60,
      expiredA.id,
    );
    db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(
      nowSeconds() - 60,
      expiredB.id,
    );

    const purged = purgeExpiredSessions(db);

    expect(purged).toBe(2);
    expect(getSession(db, live.id)).not.toBeNull();
    const remaining = db
      .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM sessions')
      .get();
    expect(remaining?.count).toBe(1);
  });
});

describe('cascade delete', () => {
  it('removes sessions when the owning user is deleted', () => {
    const session = createSession(db, 1);

    db.prepare('DELETE FROM users WHERE id = 1').run();

    const remaining = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id);
    expect(remaining).toBeUndefined();
  });
});
