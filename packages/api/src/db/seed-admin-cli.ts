import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { loadEnv } from '../env.js';
import { openDatabase } from './index.js';
import { seedAdmin } from './seed-admin.js';

// SPEC.md Section 4.3: `npm run seed:admin`, run by the Pi platform's
// `deploy.sh` after bringing containers up, under `set -euo pipefail` —
// a missing or failing script aborts every other site's rebuild on that
// Pi. This is a one-shot task against the already-migrated database
// `startup.ts`'s `initialiseDatabase` created at container start: it opens
// the database, calls the same `seedAdmin` insert boot already runs, and
// exits. It never starts the HTTP server or the schedulers (`server.ts`),
// and it never resets a password an admin has since changed — that
// property lives in `seedAdmin` itself (Section 13.4) and this script adds
// nothing on top of it.
//
// Succeeding with nothing to do (no ADMIN_USER/ADMIN_PASSWORD, or the
// admin already exists) is not a failure — only a genuine error (an
// unreadable database, a malformed environment) should exit non-zero, and
// that happens here simply by letting the error propagate uncaught.
export async function runSeedAdminCli(env = loadEnv()): Promise<void> {
  const db = openDatabase(env.DATABASE_PATH);
  try {
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
