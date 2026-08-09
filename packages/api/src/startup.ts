import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { openDatabase } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { seedAdmin } from './db/seed-admin.js';
import type { Env } from './env.js';

const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));

export async function initialiseDatabase(env: Env): Promise<Database.Database> {
  mkdirSync(dirname(env.DATABASE_PATH), { recursive: true });

  const db = openDatabase(env.DATABASE_PATH);
  runMigrations(db, migrationsDir);
  await seedAdmin(db, env);

  return db;
}
