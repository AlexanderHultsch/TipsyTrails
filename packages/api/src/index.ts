import type BetterSqlite3 from 'better-sqlite3';

// The package entry point (`packages/api/package.json`'s `exports`), and the
// whole of what `@tipsytrails/api` is as a package other packages import.
//
// **Nothing here may run on import.** Every line below is a re-export, and
// `src/server.ts` — the entry that listens on a port — is deliberately not one
// of them. `src/package-entry.test.ts` states the rule and the three ways it
// can regress; the reason is the one consumer: `ios/SPEC.md` 13.2's replay
// harness imports this package to build an app it drives through `app.inject`,
// and an import that started a server would have it racing a listening socket
// it never asked for.
export { buildApp } from './app.js';
export { loadEnv } from './env.js';

// `ios/SPEC.md` 13.2's harness opens a temporary SQLite file, runs
// `packages/api/migrations` against it, and calls `buildApp(env, db)` with what
// it opened. Those first two steps had no export, so the harness could not take
// them: `packages/tracker` may not depend on `better-sqlite3` itself
// (`ios/SPEC.md` I7), which leaves opening and migrating a database something
// only this package can do for it.
//
// They are exported as they are, and not behind one wrapper that opens and
// migrates together: `src/startup.ts` already composes them in the order a
// server wants, and a second composition here would be a third place that
// decides what "an opened database" means.
export { openDatabase } from './db/index.js';
export { runMigrations } from './db/migrate.js';

// What `openDatabase` answers with, what `runMigrations` and `buildApp` take,
// and so the one type a caller of all three has to be able to name. Re-exported
// rather than left to an `import type Database from 'better-sqlite3'` on the
// caller's side, for the reason the two functions above are exported at all: a
// consumer that may not depend on `better-sqlite3` (`ios/SPEC.md` I7) cannot
// write that import, and a database it can hold only as an inferred local
// cannot be passed across a function boundary in its own code.
export type SqliteDatabase = BetterSqlite3.Database;
