// @vitest-environment node

import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// SPEC.md Section 7.7's third clause - the badge floors are not in the code
// the browser downloads - and Phase 2's app-shell budget (Section 12). Both
// are properties of the *build* rather than of the source tree, and this is
// the only test in this repository that can hold either.
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

// Phase 2's Definition of Done: "App shell < 150 KB gzipped, excluding the
// map chunk". The number lives here, in the only test that reads it, and not
// in packages/shared/src/config.ts: `config.ts` holds the constants the
// running application is built out of, every one of them imported by code
// that ships, and it is itself bundled into the browser. A build budget is
// imported by nothing at runtime, would add bytes to the very bundle it
// measures, and is not one of the values Section 7.1 defines - it is a
// property of this test, in the way the 100_000-byte floor below is.
//
// 150 * 1000 rather than 150 * 1024: the DoD's "KB" is not qualified, Vite's
// own build report counts in decimal kB, and the smaller of the two readings
// is the one that cannot be accused of buying headroom by reinterpretation.
const SHELL_BUDGET_BYTES = 150 * 1000;

interface OutputChunk {
  type: 'chunk';
  fileName: string;
  code: string;
  isEntry: boolean;
  isDynamicEntry: boolean;
  imports: readonly string[];
  dynamicImports: readonly string[];
  // Vite hangs the stylesheets a chunk pulls in off the chunk itself; the
  // CSS is emitted as a separate asset, so there is no other edge from a
  // chunk to its own stylesheet in the rollup output.
  viteMetadata?: { importedCss?: Iterable<string> };
}

interface OutputAsset {
  type: 'asset';
  fileName: string;
  source: string | Uint8Array;
}

type OutputItem = OutputChunk | OutputAsset;

// Every byte the browser would be served: JS chunks and emitted assets alike.
let bundle = '';
// The same build, unflattened. The badge-floor assertions want one string to
// grep; the size assertions want the graph - names, entry flags and the two
// kinds of import edge - because "the app shell" is a reachability question
// and not a filename one.
let chunks: OutputChunk[] = [];
let assetsByFileName = new Map<string, OutputAsset>();

function gzipBytes(content: string | Uint8Array): number {
  return gzipSync(typeof content === 'string' ? Buffer.from(content) : Buffer.from(content)).length;
}

function assetText(asset: OutputAsset): string {
  return typeof asset.source === 'string' ? asset.source : '';
}

function kB(bytes: number): string {
  return `${(bytes / 1000).toFixed(1)} kB`;
}

// NODE_ENV, and it decides which application this file measures. Vitest sets
// NODE_ENV=test, and Vite's `isProduction` is
// `(process.env.NODE_ENV || mode) === 'production'` - so an unqualified
// `build()` from inside a test builds React's *development* bundle, with
// `jsxDEV` and every invariant message still in it: 138.1 kB gzipped in the
// shell where `pnpm build` emits 82.0 kB. That is a different program from the
// one the Pi serves, and a budget measured against it would be measuring the
// wrong thing (at v1.57 the badge-floor greps below were reading that
// development bundle too, which is harmless for a grep and wrong for a size).
// Stubbing NODE_ENV for the length of the build reproduces `pnpm build`
// exactly - same chunk contents, same content hashes.
async function buildAsProduction(): Promise<unknown> {
  vi.stubEnv('NODE_ENV', 'production');
  try {
    return await build({
      root: webRoot,
      logLevel: 'silent',
      build: { write: false },
    });
  } finally {
    vi.unstubAllEnvs();
  }
}

beforeAll(async () => {
  const result = await buildAsProduction();

  const outputs = (Array.isArray(result) ? result : [result]) as {
    output: readonly OutputItem[];
  }[];
  const items = outputs.flatMap((out) => out.output);

  chunks = items.filter((item): item is OutputChunk => item.type === 'chunk');
  assetsByFileName = new Map(
    items.filter((item): item is OutputAsset => item.type === 'asset').map((a) => [a.fileName, a]),
  );

  bundle = items.map((item) => (item.type === 'chunk' ? item.code : assetText(item))).join('\n');
}, 180_000);

// The eagerly loaded set: the entry chunk plus everything reachable from it
// through *static* imports, transitively. A chunk reached only across a
// `dynamicImports` edge - a lazily imported route, and everything that route
// alone pulls in - is a separate download the browser makes later, and is not
// part of the shell.
//
// Derived rather than listed, because every file name in this build carries a
// content hash and changes whenever its contents do.
function eagerChunks(): OutputChunk[] {
  const byFileName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const reached = new Set<string>();
  const queue = chunks.filter((chunk) => chunk.isEntry).map((chunk) => chunk.fileName);

  while (queue.length > 0) {
    const fileName = queue.pop()!;
    if (reached.has(fileName)) {
      continue;
    }
    reached.add(fileName);
    const chunk = byFileName.get(fileName);
    if (chunk) {
      queue.push(...chunk.imports.filter((imported) => byFileName.has(imported)));
    }
  }

  return chunks.filter((chunk) => reached.has(chunk.fileName));
}

// The stylesheets those chunks bring with them. They are part of what the
// browser has to fetch before the shell renders, so they are part of what the
// budget is about; the map's own 9 kB of MapLibre CSS hangs off the map chunk
// and is excluded with it, exactly as the DoD says.
function importedCssAssets(shell: readonly OutputChunk[]): OutputAsset[] {
  const fileNames = new Set<string>();
  for (const chunk of shell) {
    for (const cssFileName of chunk.viteMetadata?.importedCss ?? []) {
      fileNames.add(cssFileName);
    }
  }
  return [...fileNames]
    .map((fileName) => assetsByFileName.get(fileName))
    .filter((asset): asset is OutputAsset => asset !== undefined);
}

// The map chunk, found by what is in it rather than by what it is called:
// MapLibre is the bulk of it and names itself throughout its own source. The
// chunk holding it is currently emitted under the name of the first module
// that reaches it, which is neither `Map` nor anything else a reader would
// guess - one more reason not to match on names.
function mapLibreChunks(): OutputChunk[] {
  return chunks.filter((chunk) => /maplibre/i.test(chunk.code));
}

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

  // Phase 2's Definition of Done, first clause. It was ticked at v1.53 on a
  // measurement taken by hand from one build (82.7 kB gzipped against a
  // 150 KB budget) and nothing held it afterwards, which is a lot of
  // headroom for a regression to hide in for a year.
  //
  // The measured figures go in the failure message on purpose: a budget test
  // that fails with "expected true to be false" is an afternoon of bisecting,
  // and one that says how far over it went, and which chunks it counted, is
  // a fixed bug.
  it('keeps the eagerly loaded app shell inside its gzipped budget', () => {
    const shell = eagerChunks();
    expect(shell.length).toBeGreaterThan(0);

    const jsBytes = shell.reduce((total, chunk) => total + gzipBytes(chunk.code), 0);
    const cssAssets = importedCssAssets(shell);
    const cssBytes = cssAssets.reduce((total, asset) => total + gzipBytes(asset.source), 0);
    const shellBytes = jsBytes + cssBytes;

    const breakdown = [
      ...shell.map((chunk) => `${chunk.fileName} ${kB(gzipBytes(chunk.code))}`),
      ...cssAssets.map((asset) => `${asset.fileName} ${kB(gzipBytes(asset.source))}`),
    ].join(', ');

    expect(
      shellBytes,
      `app shell is ${kB(shellBytes)} gzipped (JS ${kB(jsBytes)} in ${shell.length} chunks, ` +
        `CSS ${kB(cssBytes)}), budget is ${kB(SHELL_BUDGET_BYTES)}: ${breakdown}`,
    ).toBeLessThan(SHELL_BUDGET_BYTES);
  });

  // Phase 2's Definition of Done, second clause: the map chunk is code-split
  // and loaded only on map routes. The size assertion above does not cover
  // this on its own - a build that inlined MapLibre into the entry would blow
  // the budget and fail there, but a build that split it into its own chunk
  // and *also* imported that chunk statically from the shell would still
  // download it on the start screen, and could stay under 150 KB while doing
  // it if MapLibre ever shrank. What has to be true is the reachability: the
  // map is behind a dynamic import and nothing else.
  //
  // No upper bound is asserted on the map chunk itself. The DoD says
  // "~250 KB gzipped", which is a description of what MapLibre and PMTiles
  // weigh and not a limit anyone chose; a number invented here would be a
  // budget this repository never agreed to, and the clause that matters -
  // that those bytes are not in the shell - is already held above.
  it('reaches the MapLibre chunk only through a dynamic import', () => {
    const mapChunks = mapLibreChunks();
    // The positive control again: if MapLibre stopped being identifiable in
    // the output this test would otherwise pass by finding nothing.
    expect(mapChunks.length).toBeGreaterThan(0);

    const shellFileNames = new Set(eagerChunks().map((chunk) => chunk.fileName));
    for (const chunk of mapChunks) {
      expect(
        shellFileNames.has(chunk.fileName),
        `${chunk.fileName} carries MapLibre and is statically reachable from the entry chunk ` +
          `(${kB(gzipBytes(chunk.code))} gzipped)`,
      ).toBe(false);
    }

    // And it is genuinely reachable - split out, not dropped. Every chunk
    // named by a `dynamicImports` edge, plus whatever those chunks import
    // statically.
    const byFileName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
    const lazy = new Set<string>();
    const queue = chunks.flatMap((chunk) => [...chunk.dynamicImports]);
    while (queue.length > 0) {
      const fileName = queue.pop()!;
      if (lazy.has(fileName)) {
        continue;
      }
      lazy.add(fileName);
      const chunk = byFileName.get(fileName);
      if (chunk) {
        queue.push(...chunk.imports, ...chunk.dynamicImports);
      }
    }
    for (const chunk of mapChunks) {
      expect(lazy.has(chunk.fileName), `${chunk.fileName} is reachable from no route`).toBe(true);
    }
  });
});
