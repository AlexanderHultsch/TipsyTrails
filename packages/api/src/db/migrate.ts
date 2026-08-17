import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

export function runMigrations(db: Database.Database, migrationsDir: string): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  // BEGIN IMMEDIATE takes the write lock before the applied-set is read, so a
  // second process starting at the same moment (the booting server and
  // `npm run seed:admin` on a first-ever deploy) blocks here rather than
  // deciding from a stale applied-set and replaying a migration.
  const applyPending = db.transaction((): string[] => {
    const applied = new Set(
      db
        .prepare<[], { filename: string }>('SELECT filename FROM schema_migrations')
        .all()
        .map((row) => row.filename),
    );

    const files = readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    const appliedNow: string[] = [];

    for (const file of files) {
      if (applied.has(file)) {
        continue;
      }

      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (filename, applied_at) VALUES (?, ?)').run(
        file,
        Math.floor(Date.now() / 1000),
      );
      appliedNow.push(file);
    }

    return appliedNow;
  });

  return applyPending.immediate();
}
