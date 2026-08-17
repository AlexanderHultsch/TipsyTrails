import { CONFIG } from '@tipsytrails/shared';
import Database from 'better-sqlite3';

// Changing the journal mode needs an exclusive lock and, unlike ordinary
// statements, does not go through SQLite's busy handler, so the connection's
// busy timeout does not cover it: two processes opening the same brand-new
// file at once (the booting server and `npm run seed:admin` on a first-ever
// deploy) would otherwise leave one of them with SQLITE_BUSY. WAL is required
// by SPEC.md Section 4, so once the budget is spent the only correct outcome
// is to fail loudly rather than run in another journal mode.
function enableWalMode(db: Database.Database, path: string): void {
  const deadline = Date.now() + CONFIG.DB_WAL_RETRY_BUDGET_MS;
  let lastReason: string | undefined;

  for (;;) {
    try {
      const mode = db.pragma('journal_mode = WAL', { simple: true });
      if (mode === 'wal') {
        return;
      }
      lastReason = `journal_mode is ${String(mode)}`;
    } catch (error) {
      if ((error as { code?: string }).code !== 'SQLITE_BUSY') {
        throw error;
      }
      lastReason = 'SQLITE_BUSY';
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Could not put the database into WAL mode within ${CONFIG.DB_WAL_RETRY_BUDGET_MS} ms (${lastReason ?? 'unknown'}): ${path}`,
      );
    }

    // openDatabase is synchronous and every caller depends on that, so the
    // wait between attempts blocks rather than yielding.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, CONFIG.DB_WAL_RETRY_INTERVAL_MS);
  }
}

export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  enableWalMode(db, path);
  db.pragma('foreign_keys = ON');
  return db;
}
