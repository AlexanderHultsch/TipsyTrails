import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnv } from '../env.js';
import { openDatabase } from './index.js';
import { runMigrations } from './migrate.js';
import { seedAdmin } from './seed-admin.js';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

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
// same `seedAdmin` insert boot already runs, and exits. Both are idempotent
// (`schema_migrations` and `seedAdmin` are each no-ops once already
// applied), so running this concurrently with, or repeatedly after,
// boot-time seeding is safe. It never starts the HTTP server or the
// schedulers (`server.ts`), and it never resets a password an admin has
// since changed — that property lives in `seedAdmin` itself (Section 13.4)
// and this script adds nothing on top of it.
//
// Succeeding with nothing to do (no ADMIN_USER/ADMIN_PASSWORD, or the
// admin already exists) is not a failure — only a genuine error (an
// unreadable database, a malformed environment) should exit non-zero, and
// that happens here simply by letting the error propagate uncaught.
export async function runSeedAdminCli(env = loadEnv()): Promise<void> {
  mkdirSync(dirname(env.DATABASE_PATH), { recursive: true });
  const db = openDatabase(env.DATABASE_PATH);
  try {
    runMigrations(db, migrationsDir);
    const result = await seedAdmin(db, env);
    console.log(
      result === 'seeded'
        ? `seed:admin: created the admin account (${env.ADMIN_USER}).`
        : 'seed:admin: nothing to do (ADMIN_USER/ADMIN_PASSWORD not set, or the admin already exists).',
    );
  } finally {
    db.close();
  }
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  runSeedAdminCli().catch((err: unknown) => {
    console.error('seed:admin failed:', err);
    process.exitCode = 1;
  });
}
