import { randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { hashPassword } from '../auth/password.js';
import { deleteSessionsForUser } from '../auth/session.js';
import type { Env } from '../env.js';

const SEEDED_ADMIN_SECURITY_QUESTION =
  'Password recovery is not available for the seeded admin account.';

// The four things that can happen, kept distinct because the caller has to be
// able to tell them apart (SPEC.md Section 4.3). A single `'skipped'` covering
// both "no credentials in the environment" and "the account is already there"
// was the reason a silent no-op on the Pi cost a shell into the running
// container to diagnose: one is a misconfiguration worth a nonzero exit, the
// other is the normal outcome of every ordinary deploy.
export type SeedAdminOutcome =
  // The account did not exist and was created from ADMIN_USER/ADMIN_PASSWORD.
  | 'seeded'
  // The account existed, its password_hash was rewritten from ADMIN_PASSWORD
  // and every session it held was deleted. Only `seedAdminRotatingPassword`
  // can ever return this.
  | 'rotated'
  // The account existed and was left exactly as it was.
  | 'exists'
  // ADMIN_USER and/or ADMIN_PASSWORD are absent, so there is nothing to seed.
  | 'no-credentials';

// What the create-only entry point can return. `'rotated'` is excluded at the
// type level, not merely absent in practice: a caller of `seedAdmin` cannot
// even write code that handles a rotation, because one cannot happen.
export type SeedAdminCreateOnlyOutcome = Exclude<SeedAdminOutcome, 'rotated'>;

/**
 * Create the admin account if it does not exist, and otherwise change nothing.
 *
 * This is the boot-time entry point (`startup.ts`'s `initialiseDatabase`) and
 * the default for `npm run seed:admin`. It takes no options, deliberately:
 * `startup.ts` runs on every container start, so anything that let a rotation
 * be switched on here would revert the admin's password on every restart. The
 * only way to rotate is to call the other exported function by name, which
 * only `seed-admin-cli.ts` does and only when `--rotate-password` was passed.
 *
 * It never touches an existing row, and — since rotation gained the power to
 * end sessions (v1.45) — it must never touch the `sessions` table either. A
 * boot-time path that could revoke would sign the admin out on every container
 * restart and every rebuild, on top of reverting their password: two silent
 * failures where there was one. An admin who changes their own password in the
 * app (`POST /api/auth/change-password`) keeps it across every deploy — see
 * `seedAdminRotatingPassword` for why nothing in here may guess otherwise.
 */
export async function seedAdmin(
  db: Database.Database,
  env: Env,
): Promise<SeedAdminCreateOnlyOutcome> {
  if (!env.ADMIN_USER || !env.ADMIN_PASSWORD) {
    return 'no-credentials';
  }

  const existing = db
    .prepare<[string], { id: number }>('SELECT id FROM users WHERE username = ?')
    .get(env.ADMIN_USER);
  if (existing) {
    return 'exists';
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

/**
 * Create the admin account if it does not exist, and otherwise rewrite its
 * `password_hash` from `ADMIN_PASSWORD` and end every session it holds.
 *
 * This is an overwrite of a credential and it is deliberately something a
 * caller has to ask for by name. It exists for one caller only: `npm run
 * seed:admin -- --rotate-password`, which the Pi's `deploy.sh` runs from its
 * `--set-password` option, where the operator has just chosen a new shared
 * password and means every `admin: yes` site to take it (SPEC.md Section 4.3).
 *
 * Two alternatives were considered and rejected, and both look safer than they
 * are:
 *
 *   - Upserting on every run reverts an admin who changed their own password
 *     in the app, on the next deploy, without anyone asking for it.
 *   - "Rewrite only when the stored hash does not verify against
 *     ADMIN_PASSWORD" is the same bug in a disguise. After a self-change the
 *     stored hash *does* stop matching ADMIN_PASSWORD — that is exactly the
 *     state it would overwrite.
 *
 * Nothing inside the container can distinguish "the operator rotated
 * admin.env" from "the admin changed their own password"; the two look
 * identical from here. That is why the overwrite has to be an explicit act at
 * the call site rather than a condition this file evaluates.
 *
 * **It revokes.** Rewriting the hash alone would leave a session opened under
 * the *old* password valid for the rest of its 90-day sliding expiry (Section
 * 5.4) — acceptable for routine hygiene, useless when the rotation is
 * happening *because* the old password leaked, which is the case the operator
 * cannot afford to get wrong. So this deletes the account's sessions too.
 *
 * `deleteSessionsForUser`, not `deleteOtherSessionsForUser`, and the
 * difference is the whole reason both exist. `POST /api/auth/change-password`
 * keeps the caller's own session, because there a human is standing in a
 * browser tab and signing them out of it would be hostile. Here there is no
 * caller session to keep: this runs from a CLI inside a container, out of
 * `deploy.sh --set-password`, and the operator's stated intent is precisely
 * that the old credential stops working everywhere. Keeping "the current one"
 * would mean keeping an arbitrary one.
 */
export async function seedAdminRotatingPassword(
  db: Database.Database,
  env: Env,
): Promise<SeedAdminOutcome> {
  // Read into locals before delegating so the two are narrowed to `string`
  // for the UPDATE below. `seedAdmin` answers 'no-credentials' for the same
  // condition; this repeats the check rather than casting after it.
  const adminUser = env.ADMIN_USER;
  const adminPassword = env.ADMIN_PASSWORD;
  if (!adminUser || !adminPassword) {
    return 'no-credentials';
  }

  // Delegating means the create path is written once and the rotate path
  // cannot drift from it — and, the direction that matters, that `seedAdmin`
  // holds no branch a future edit could reach the rotation through.
  const created = await seedAdmin(db, env);
  if (created !== 'exists') {
    return created;
  }

  // Everything from here is the rotate path, and it is reached only from
  // `created === 'exists'` — an account that was already there. The three
  // other outcomes returned above, and none of them may revoke: 'seeded' has
  // just minted a user id no session can yet reference, so a delete there
  // would be a no-op implying something happened; 'exists' without the flag
  // never arrives here at all (it is `seedAdmin`'s answer to its own caller);
  // and 'no-credentials' wrote nothing to revoke against.
  //
  // `password_hash` and nothing else. Not `must_change_password` (Section 5.3:
  // it is 0 on purpose, and setting it would lock the platform out of the only
  // account it manages), not `is_admin`, not `avatar_seed`, and not the
  // security question or its answer hash — that answer is 32 random bytes
  // nobody holds, which is what keeps the recovery flow closed for this
  // account. Re-hashing it here would generate a fresh unanswerable secret for
  // no gain and a needless argon2 pass.
  //
  // Matched on `username` rather than on the id read above because
  // `users.username` is UNIQUE COLLATE NOCASE, so this is the same single row
  // `seedAdmin` just found, case-insensitively, in one statement. `RETURNING
  // id` then hands the delete below the id of the row this statement actually
  // wrote, rather than one re-derived from a second lookup that could in
  // principle answer differently.
  //
  // Argon2 runs before the transaction opens, not inside it: better-sqlite3
  // transactions are synchronous, and holding the write lock across a
  // deliberately slow hash would block the booting server's migrations for no
  // reason.
  const passwordHash = await hashPassword(adminPassword);

  // One transaction, because a half-done rotation is worse than either whole:
  // a hash written without the revocation leaves the leaked password's
  // sessions alive while the operator is told they are gone, and a revocation
  // without the hash signs the admin out and hands them back the old password
  // to sign in with. `db.transaction` is how the rest of this codebase groups
  // writes that must both land (`routes/account.ts`, `routes/fog.ts`,
  // `db/migrate.ts`), and it rolls back on a throw.
  const rotate = db.transaction((hash: string): void => {
    const updated = db
      .prepare<[string, string], { id: number }>(
        'UPDATE users SET password_hash = ? WHERE username = ? RETURNING id',
      )
      .get(hash, adminUser);
    if (!updated) {
      // The row `seedAdmin` found a moment ago is gone. Nothing in the deploy
      // flow can do that, so this is loud rather than quiet: the alternative
      // is reporting a rotation that wrote nothing, which is the exact silent
      // no-op this script was rebuilt to eliminate. Throwing here also rolls
      // the transaction back. No secret is named.
      throw new Error(
        'seed:admin: the admin account disappeared while its password was being rotated. ' +
          'Nothing was written and no session was ended.',
      );
    }
    deleteSessionsForUser(db, updated.id);
  });
  rotate(passwordHash);

  return 'rotated';
}
