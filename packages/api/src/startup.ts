import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { openDatabase } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { seedAdmin } from './db/seed-admin.js';
import { seedBars } from './db/seed-bars.js';
import { seedCity } from './db/seed-city.js';
import type { Env } from './env.js';

const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));

export async function initialiseDatabase(env: Env): Promise<Database.Database> {
  mkdirSync(dirname(env.DATABASE_PATH), { recursive: true });

  const db = openDatabase(env.DATABASE_PATH);
  runMigrations(db, migrationsDir);
  // Create-only, and it has to stay that way: this runs on every container
  // start, so a boot that could rotate would revert the admin's password every
  // time the Pi restarts or `deploy.sh` rebuilds. `seedAdmin` takes no option
  // that would let it — rotating means calling `seedAdminRotatingPassword` by
  // name, which only `db/seed-admin-cli.ts` does, only under
  // `--rotate-password` (SPEC.md Section 4.3). Do not import that here.
  await seedAdmin(db, env);
  seedCity(db, env);
  seedBars(db, env);

  return db;
}
