import { randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { hashPassword } from '../auth/password.js';
import type { Env } from '../env.js';

const SEEDED_ADMIN_SECURITY_QUESTION =
  'Password recovery is not available for the seeded admin account.';

export async function seedAdmin(db: Database.Database, env: Env): Promise<'seeded' | 'skipped'> {
  if (!env.ADMIN_USER || !env.ADMIN_PASSWORD) {
    return 'skipped';
  }

  const existing = db
    .prepare<[string], { id: number }>('SELECT id FROM users WHERE username = ?')
    .get(env.ADMIN_USER);
  if (existing) {
    return 'skipped';
  }

  const passwordHash = await hashPassword(env.ADMIN_PASSWORD);
  const securityAnswerHash = await hashPassword(randomBytes(32).toString('hex'));
  const now = Math.floor(Date.now() / 1000);

  // The two literals in VALUES are is_admin = 1 and must_change_password = 0,
  // in that order. The flag stays clear because the platform supplies and
  // rotates this credential (SPEC.md Section 5.3): forcing a change at first
  // sign-in would invalidate the only managed way in.
  db.prepare(
    `INSERT INTO users
      (username, password_hash, security_question, security_answer_hash, avatar_seed, is_admin, must_change_password, age_confirmed_at, created_at)
     VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)`,
  ).run(
    env.ADMIN_USER,
    passwordHash,
    SEEDED_ADMIN_SECURITY_QUESTION,
    securityAnswerHash,
    randomUUID(),
    now,
    now,
  );

  return 'seeded';
}
