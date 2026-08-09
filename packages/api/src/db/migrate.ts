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
    const applyMigration = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (filename, applied_at) VALUES (?, ?)').run(
        file,
        Math.floor(Date.now() / 1000),
      );
    });
    applyMigration();
    appliedNow.push(file);
  }

  return appliedNow;
}
