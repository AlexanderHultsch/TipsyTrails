import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
// The self-reference: `@tipsytrails/api` from inside `@tipsytrails/api`,
// resolved by the `exports` block in its own package.json exactly as any
// other package in the workspace would resolve it. Deliberately not
// `./index.js` — a relative import would pass with no `exports` block, no
// `main`, and no emitted `dist/`, which is precisely the state this file
// exists to catch.
import { buildApp, loadEnv, openDatabase, runMigrations } from '@tipsytrails/api';
import type { SqliteDatabase } from '@tipsytrails/api';
import { describe, expect, it } from 'vitest';

// `packages/api` as a package other packages can IMPORT, rather than as a
// server this repository runs (SPEC.md Section 3).
//
// ── Why this matters, and what it was before ────────────────────────────
//
// `ios/SPEC.md` 13.2's replay harness runs the built tracker bundle against
// a real Fastify app on a real SQLite file, and reaches it by
// `import { buildApp } from '@tipsytrails/api'`. Until v1.60 that import
// could not work: `packages/api`'s manifest declared no `main` and no
// `exports`, so the workspace link resolved the package name to a directory
// with no entry point and Node answered `ERR_MODULE_NOT_FOUND` for
// `.../@tipsytrails/api/index.js`. It failed at RESOLUTION rather than at
// type-check, which is the reason a test rather than a compiler is what
// holds it: nothing in `pnpm typecheck` looks at a package's `exports`.
//
// Three things had to be true, and each of them can regress on its own:
//
//  1. `packages/tracker` declares the devDependency and `pnpm-lock.yaml`
//     carries the link, so the name resolves from that package at all.
//  2. `package.json` names an entry point, and it is `src/index.ts` — which
//     exports `buildApp`, `loadEnv`, `openDatabase` and `runMigrations`, and
//     calls nothing. `src/server.ts` is the entry that listens, and it is
//     deliberately NOT what the package resolves to: an entry point that
//     started a server on import would make importing this package a side
//     effect, and the harness would be racing a listening socket it never
//     asked for.
//  3. The build emits declarations (`declaration: true` in
//     tsconfig.build.json), so `types` in the `exports` block points at a
//     file that exists. Without it the import resolves at run time and is an
//     implicit `any` at compile time, which under `strict` is TS7016 —
//     a typed import of `buildApp` would fail `pnpm typecheck` while every
//     test here still passed, if this file did not itself import it typed.
//
// ── Why this file is in `packages/api` and not `packages/tracker` ───────
//
// `ios/SPEC.md` Section 1's I7 confines the `ios-app` branch to `ios/` and
// `packages/tracker/`, and `main` copies those two trees rather than
// authoring them. `packages/tracker/package.json` is the single exception
// row 11 of "the list for `main`" names, because a manifest and a lockfile
// are one change and the lockfile is a root file the branch cannot touch. A
// test file under `packages/tracker/src` would not be that exception: it
// would be `main` writing into a tree it does not own, and it would collide
// with Step E when `ios-app` writes the harness beside it.
//
// So the test lives with the thing it is about — the entry point is
// `packages/api`'s, and so is every one of the three failure modes above.
// The second case below covers what could be thought to need a file over
// there: it resolves the name FROM `packages/tracker`'s position in the
// workspace, which is the resolution the harness will perform, without
// putting a file in that package.
// The three calls `ios/SPEC.md` 13.2's harness makes, as types. The assertion
// is each annotation — `openDatabase` answers with the database `runMigrations`
// and `buildApp` take, and `SqliteDatabase` is the name the entry point gives
// that type — and it is made here rather than inline below because it is the
// compiler's and not a test body's.
//
// It is not covered by the runtime cases: the entry could export both functions
// and a `SqliteDatabase` that had drifted from their signatures, or stop
// emitting declarations altogether (failure 3 above), and every `typeof` check
// in this file would still pass. A consumer that may not depend on
// `better-sqlite3` itself (I7) has no second way to name this type, so the
// re-export is as much of the export surface as the functions are.
const openDatabaseSignature: (path: string) => SqliteDatabase = openDatabase;
const runMigrationsSignature: (db: SqliteDatabase, migrationsDir: string) => string[] =
  runMigrations;
// The return is `unknown` because what it is — Fastify's instance — is not this
// file's subject, and naming it here would make `fastify` a dependency of an
// assertion about an `exports` block. What is asserted is the second parameter.
const buildAppSignature: (env: ReturnType<typeof loadEnv>, db: SqliteDatabase) => unknown =
  buildApp;

describe('@tipsytrails/api as an importable package', () => {
  it('exposes buildApp through the package name', () => {
    expect(typeof buildApp).toBe('function');
  });

  // Row 14 of `ios/SPEC.md` 12's list for `main`. `buildApp(env, db)` takes an
  // already-open database, and the harness of 13.2 is what has to open and
  // migrate one: it opens a temporary SQLite file, runs `packages/api/migrations`
  // against it, and hands the result to `buildApp`. Neither step was exported,
  // and `packages/tracker` may not depend on `better-sqlite3` itself (I7), so
  // the harness could not take them at all.
  it('exposes openDatabase and runMigrations through the package name', () => {
    expect(typeof openDatabase).toBe('function');
    expect(typeof runMigrations).toBe('function');
  });

  // The identity is what makes the annotations above assertions about the
  // package and not about three local aliases: the functions the compiler
  // checked are the functions the package exports.
  it('names the type its callers need, and the pair keeps the signatures that type describes', () => {
    expect(openDatabaseSignature).toBe(openDatabase);
    expect(runMigrationsSignature).toBe(runMigrations);
    expect(buildAppSignature).toBe(buildApp);
  });

  // The workspace link itself: `packages/tracker`'s devDependency and its
  // `pnpm-lock.yaml` entry are what put `@tipsytrails/api` in that package's
  // `node_modules`, and this resolves the name from exactly there. It fails
  // if the devDependency is dropped, if the lockfile is regenerated without
  // it, or if the entry point goes away again — the three halves of row 11
  // in one assertion.
  //
  // `createRequire` against the tracker's own manifest path is what makes
  // the resolution start in that directory; the import above cannot, since
  // a static specifier is resolved relative to this file.
  it('resolves from packages/tracker, where the replay harness will import it', async () => {
    const requireFromTracker = createRequire(
      fileURLToPath(new URL('../../tracker/package.json', import.meta.url)),
    );

    const entry = requireFromTracker.resolve('@tipsytrails/api');
    expect(entry).toBe(fileURLToPath(new URL('../dist/index.js', import.meta.url)));

    const loaded: unknown = await import(pathToFileURL(entry).href);
    expect(typeof (loaded as { buildApp?: unknown }).buildApp).toBe('function');
    // The two of row 14, from the same position and through the same
    // resolution. Asserted here and not only above because the import at the
    // top of this file is resolved from `packages/api`, and a build that
    // emitted an entry point this package can reach and that one cannot is a
    // state the first case would not see.
    expect(typeof (loaded as { openDatabase?: unknown }).openDatabase).toBe('function');
    expect(typeof (loaded as { runMigrations?: unknown }).runMigrations).toBe('function');
  });

  // The entry point, counted. `src/index.ts` is a list of re-exports and is
  // meant to stay one, so what it exports is small enough to write down — and
  // writing it down is what makes an addition a decision rather than a drift.
  // `SqliteDatabase` is absent because a type is: nothing of it survives to
  // run time, which is the reason it is also checked by the annotations above.
  it('exports these four runtime values and nothing else', async () => {
    const loaded: unknown = await import('@tipsytrails/api');
    expect(Object.keys(loaded as Record<string, unknown>).sort()).toEqual([
      'buildApp',
      'loadEnv',
      'openDatabase',
      'runMigrations',
    ]);
  });
});
