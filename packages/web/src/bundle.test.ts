// @vitest-environment node

import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { beforeAll, describe, expect, it } from 'vitest';

// SPEC.md Section 7.7's third clause - the badge floors are not in the code
// the browser downloads - and the only test in this repository that can hold it.
//
// The leak was found by building the production bundle and reading
// `CONFIG.BADGE_THRESHOLDS` out of it. Every number in Section 7.1 that a
// client may not have is a property of the *build*, not of the import graph: a
// unit test asserting "no file under src/ imports the server module" would
// pass on a bundle that carried the numbers by some other route, and would
// fail on a source import that a tree-shake removed. So this builds what the
// Pi actually serves and greps that.
//
// It is the third and last of the guards named in
// packages/shared/src/server-config.ts, and the other two - the package's
// `exports` map, and the ESLint rule in eslint.config.js - exist so that this
// one is not the first thing an author hears about it. This is the one that
// cannot be argued with.
//
// **What runs it, and when.** `pnpm test`, on every run, because there is no
// CI in this repository (Section 14, O6) and the four root commands are the
// whole gate. It costs about 1.5 s - the same Vite build `pnpm build` runs,
// with `write: false` so nothing touches `dist/` - which is affordable against
// a suite this size and is the reason it is a test rather than a documented
// one-off that nobody would run.

const webRoot = fileURLToPath(new URL('..', import.meta.url));

// Every byte the browser would be served: JS chunks and emitted assets alike.
let bundle = '';

beforeAll(async () => {
  const result = await build({
    root: webRoot,
    logLevel: 'silent',
    build: { write: false },
  });

  const outputs = (Array.isArray(result) ? result : [result]) as {
    output: readonly (
      { type: 'chunk'; code: string } | { type: 'asset'; source: string | unknown }
    )[];
  }[];

  bundle = outputs
    .flatMap((out) => out.output)
    .map((item) =>
      item.type === 'chunk' ? item.code : typeof item.source === 'string' ? item.source : '',
    )
    .join('\n');
}, 180_000);

describe('the production web bundle', () => {
  // The positive control, and the reason the assertions below are not
  // vacuous. A build that silently produced nothing - a changed config, a
  // plugin failure swallowed by `logLevel: 'silent'` - would pass every
  // "does not contain" test in this file. This one fails instead.
  //
  // It also pins what the split deliberately KEEPS in the browser: the badge
  // kinds and the six names. Section 7.7's shelf of placeholders is drawn
  // client-side from `CONFIG.BADGE_KINDS`, so those names have to ship; it is
  // only the floors behind them that may not.
  it('contains the badge catalogue it is supposed to draw', () => {
    expect(bundle.length).toBeGreaterThan(100_000);
    expect(bundle).toContain('explorer');
    expect(bundle).toContain('barfly');
    expect(bundle).toContain('Bar Legend');
  });

  // The name the object had when it shipped. Property keys of a plain object
  // literal are not mangled by the minifier, so this is what a reader would
  // have grepped for at v1.53 and found.
  it('does not name the server-only thresholds record', () => {
    expect(bundle).not.toContain('BADGE_THRESHOLDS');
    expect(bundle).not.toContain('SERVER_CONFIG');
  });

  // The assertion that survives the object being renamed, and the one that
  // took some care to make falsifiable. Grepping for the six values as bare
  // numerals proves nothing at all - `1`, `2` and `3` are in any bundle by
  // the thousand. What is distinctive is a floor's *shape*: a badge period
  // used as a key, with a number behind it.
  //
  // At v1.53 that regex matched exactly six times, and the six were exactly
  // the thresholds: `week:.1`, `month:.3`, `year:2`, `week:1`, `month:2`,
  // `year:3`. It matches nothing legitimate, then or now - every other
  // `week`/`month`/`year` key in the bundle holds a string (the six badge
  // names, the period words, the "This week" leaderboard tabs, an SVG path),
  // a boolean or a null. So a threshold reintroduced under any other name,
  // in `CONFIG` or anywhere else, still fails here.
  it('binds no badge period to a number anywhere', () => {
    const floorShaped = /(?:^|[^A-Za-z0-9_$])["'`]?(?:week|month|year)["'`]?\s*:\s*-?[.\d]/g;
    expect(bundle.match(floorShaped) ?? []).toEqual([]);
  });
});
