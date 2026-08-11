import { randomBytes } from 'node:crypto';
import { DERIVED } from '@tipsytrails/shared';
import type Database from 'better-sqlite3';

interface SessionRow {
  user_id: number;
  expires_at: number;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function createSession(
  db: Database.Database,
  userId: number,
): { id: string; expiresAt: number } {
  const id = randomBytes(32).toString('base64url');
  const createdAt = nowSeconds();
  const expiresAt = createdAt + DERIVED.SESSION_TTL_S;

  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    id,
    userId,
    createdAt,
    expiresAt,
  );

  return { id, expiresAt };
}

export function getSession(
  db: Database.Database,
  id: string,
): { userId: number; expiresAt: number } | null {
  const row = db
    .prepare<[string], SessionRow>('SELECT user_id, expires_at FROM sessions WHERE id = ?')
    .get(id);
  if (!row) {
    return null;
  }

  const now = nowSeconds();
  if (row.expires_at <= now) {
    return null;
  }

  let expiresAt = row.expires_at;
  if (row.expires_at - now < DERIVED.SESSION_REFRESH_THRESHOLD_S) {
    expiresAt = now + DERIVED.SESSION_TTL_S;
    db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(expiresAt, id);
  }

  return { userId: row.user_id, expiresAt };
}

export function deleteSession(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

export function deleteSessionsForUser(db: Database.Database, userId: number): void {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function deleteOtherSessionsForUser(
  db: Database.Database,
  userId: number,
  exceptSessionId: string,
): void {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(userId, exceptSessionId);
}

export function purgeExpiredSessions(db: Database.Database, nowS: number): number {
  const result = db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowS);
  return result.changes;
}
