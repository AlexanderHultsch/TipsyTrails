import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnv } from '../env.js';
import { openDatabase } from './index.js';
import { runMigrations } from './migrate.js';
import { seedAdmin, seedAdminRotatingPassword, type SeedAdminOutcome } from './seed-admin.js';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

// The one flag this script takes. Spelled out as a constant because both the
// parser and the message that tells an operator about it have to agree, and a
// typo in either is exactly the silent failure this script exists to stop.
export const ROTATE_PASSWORD_FLAG = '--rotate-password';

// SPEC.md Section 4.3: `npm run seed:admin`, run by the Pi platform's
// `deploy.sh` immediately after `docker compose up -d`, as
// `docker compose exec -T "${name}" npm run seed:admin || echo "WARN:
// seed:admin fehlgeschlagen"`. The `|| echo` is load-bearing and the reason
// this script has to get its own idempotency right rather than lean on
// deploy.sh to catch a mistake: it swallows a nonzero exit so `set -e` never
// fires, and a missing or failing `seed:admin` does not abort the deploy —
// the site comes up looking healthy, serving pages, with no working admin
// account, and nothing marks the difference but a German warning line in a
// log nobody may read. Silent is worse than loud here, which is exactly why
// this must not be allowed to fail for a reason within its own control.
//
// `up -d` returns once the container has started, not once `startup.ts`'s
// `initialiseDatabase` has finished creating the database directory,
// migrating, and seeding it, so this script cannot assume any of that
// already happened. It does the same setup itself first — create the
// database directory if absent, run the same migrations — then calls the
// same seeding path boot already runs, and exits. Both are idempotent
// (`schema_migrations` and `seedAdmin` are each no-ops once already
// applied), so running this concurrently with, or repeatedly after,
// boot-time seeding is safe. It never starts the HTTP server or the
// schedulers (`server.ts`).
//
// Without `--rotate-password` it never resets a password an admin has since
// changed — that property lives in `seedAdmin` itself (Section 13.4) and this
// script adds nothing on top of it. With the flag it deliberately does reset
// it, because the operator has just asked for exactly that through
// `deploy.sh --set-password`; see `seedAdminRotatingPassword`.

/**
 * Parse the script's arguments by hand. One flag, no values, no dependency.
 *
 * An unrecognised argument is a hard error rather than something ignored.
 * `npm run seed:admin -- --rotate-passwrod` is a rotation the operator asked
 * for and would not get, and a run that quietly behaves as though no flag were
 * passed is precisely the failure this whole script was changed to eliminate.
 * Better to abort loudly and rotate nothing than to report success for a
 * password that was never written.
 *
 * A bare `--` is accepted and ignored: npm 6 forwarded the separator into the
 * script's argv where npm 7 and later strip it, and which npm the Pi's
 * `node:22` image ships is not something this script should depend on.
 */
export function parseSeedAdminArgs(argv: readonly string[]): { rotatePassword: boolean } {
  let rotatePassword = false;

  for (const arg of argv) {
    if (arg === ROTATE_PASSWORD_FLAG) {
      rotatePassword = true;
    } else if (arg !== '--') {
      throw new Error(
        `seed:admin: unrecognised argument ${JSON.stringify(arg)}. ` +
          `The only argument is ${ROTATE_PASSWORD_FLAG}.`,
      );
    }
  }

  return { rotatePassword };
}

/**
 * The four outcomes, their exact messages and their exit codes, in one place.
 *
 * Only the absent-credentials case exits non-zero. For a site the platform has
 * registered `admin: yes` (Section 4.3) that is a real misconfiguration —
 * `deploy.sh` wrote the site's `.env` and it did not reach the process, so
 * `|| echo "  WARN: seed:admin fehlgeschlagen"` should fire and say so.
 *
 * "Already exists, not rotated" must keep exiting 0. It is the outcome of
 * every ordinary deploy of a healthy site; warning on it would put a warning
 * line in every single run, and an operator who sees that line every time
 * stops reading it — which costs the warning its meaning in the one run where
 * it matters.
 */
export function describeSeedAdminOutcome(
  outcome: SeedAdminOutcome,
  adminUser: string | undefined,
): { message: string; exitCode: 0 | 1 } {
  switch (outcome) {
    case 'seeded':
      return { message: `seed:admin: created the admin account (${adminUser}).`, exitCode: 0 };
    case 'rotated':
      return {
        message: `seed:admin: updated the password of the admin account (${adminUser}) from ADMIN_PASSWORD.`,
        exitCode: 0,
      };
    case 'exists':
      return {
        message:
          `seed:admin: the admin account (${adminUser}) already exists and its password was left unchanged. ` +
          `Re-run with ${ROTATE_PASSWORD_FLAG} to set it from ADMIN_PASSWORD.`,
        exitCode: 0,
      };
    case 'no-credentials':
      return {
        message:
          'seed:admin: ADMIN_USER and/or ADMIN_PASSWORD are not set, so no admin account was created or updated. ' +
          'For a site registered admin: yes this is a misconfiguration - check the env_file: line in the ' +
          "platform's docker-compose.yml and the site's .env.",
        exitCode: 1,
      };
  }
}

/**
 * Run the script. Resolves with the process exit code rather than setting
 * `process.exitCode` itself, so every one of the four decisions is a value a
 * test can read instead of a global it has to save and restore.
 */
export async function runSeedAdminCli(
  env = loadEnv(),
  argv: readonly string[] = process.argv.slice(2),
): Promise<0 | 1> {
  // Before anything opens a file: a mistyped flag must not do half a run.
  const { rotatePassword } = parseSeedAdminArgs(argv);

  mkdirSync(dirname(env.DATABASE_PATH), { recursive: true });
  const db = openDatabase(env.DATABASE_PATH);
  try {
    runMigrations(db, migrationsDir);
    // The rotating entry point is named here and only here in the whole
    // codebase, under a flag that cannot be set by an environment variable.
    // `startup.ts` calls `seedAdmin`, which has no way to reach a rotation.
    const outcome = rotatePassword
      ? await seedAdminRotatingPassword(db, env)
      : await seedAdmin(db, env);
    const { message, exitCode } = describeSeedAdminOutcome(outcome, env.ADMIN_USER);
    // Never the password and never the hash - only the username, which the
    // platform's own `admin.env` and this site's `.env` already carry in clear.
    if (exitCode === 0) {
      console.log(message);
    } else {
      console.error(message);
    }
    return exitCode;
  } finally {
    db.close();
  }
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  runSeedAdminCli()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((err: unknown) => {
      // A genuine error - an unreadable database, a malformed environment, an
      // unrecognised argument. Everything the script can decide for itself has
      // already returned its own exit code above.
      console.error('seed:admin failed:', err);
      process.exitCode = 1;
    });
}
