// Re-applies Section 11.1's duplicate collapse to an already-committed
// `data/seed/<slug>/bars.json`, offline (SPEC.md Section 11.1).
//
// Usage:
//   node scripts/collapse-seed-duplicates.ts --city=karlsruhe
//   node scripts/collapse-seed-duplicates.ts --city=karlsruhe --dry-run
//
// `scripts/import-osm-bars.ts` already collapses duplicates, inside
// `osmElementsToBars`, so a *fresh* import never needs this. What needs it is
// a seed file that is already committed and no longer agrees with the rule:
// the seed predates the rule (which is how this script came to exist), or
// `IMPORT_DUPLICATE_RADIUS_M` / `SUGGEST_NAME_SIMILARITY` moved under it, or a
// curated row was added by hand next to one that was already there. In every
// one of those cases re-running the import would work, and would also be
// wrong: it needs Overpass, and it would drag in months of unrelated OSM
// churn along with the one record actually in question.
//
// This is a sibling script rather than a flag on `import-osm-bars.ts`
// deliberately. That script's whole spine is Overpass → `parseBarsPayload` →
// `osmElementsToBars`: a query built from the city config, a response shape
// validated, tags read into addresses, ways reduced to centroids, coordinates
// projected onto the grid. None of that applies to `bars.json`, which is
// already `Bar[]` — its `--input` flag takes an Overpass or GeoJSON payload,
// not this file. A flag that skipped every one of those steps would be a
// second program sharing a filename with the first. What the two do share —
// the collapse itself, the file's validation, its serialisation and the
// report naming each merged pair — they share by calling the same functions
// in `@tipsytrails/shared`, which is where the rule lives.
//
// **Build `@tipsytrails/shared` before running this**, exactly as
// `import-osm-bars.ts` needs (`pnpm install` does it; so do `pnpm test` and
// `pnpm typecheck`). `packages/shared/src/bars.ts` has relative value imports
// of its own, so it cannot be run as raw source the way `build-grid.ts` runs
// `city.ts`.
//
// This script only ever rewrites the seed file. It never touches the live
// database — applying a change to a running app is a manual admin decision
// (SPEC.md Section 11.2), and dropping a bar there would take its discoveries
// and visits with it (Section 5.6).

import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { citySeedDir } from '../packages/shared/dist/city.js';
import {
  collapseDuplicateBars,
  parseBarsFile,
  type Bar,
  type CollapsedDuplicate,
} from '../packages/shared/dist/bars.js';

interface CliArgs {
  city: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let city: string | undefined;
  let dryRun = false;

  for (const arg of argv) {
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg.startsWith('--city=')) {
      city = arg.slice('--city='.length);
    } else {
      throw new Error(`Unrecognised argument "${arg}". Expected --city=<slug> [--dry-run].`);
    }
  }

  if (!city) {
    throw new Error('Missing required --city=<slug> argument.');
  }

  return { city, dryRun };
}

// Shape-checked rather than cast, for the same reason `import-osm-bars.ts`
// shape-checks it: this file is committed, hand-curated through the admin
// interface's exports and hand-edited, and `collapseDuplicateBars` takes
// `readonly Bar[]` on trust.
function loadBars(path: string): Bar[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new Error(
      `No seed file found at "${path}". Expected a committed bars.json — check the --city slug.`,
      { cause: err },
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `"${path}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      {
        cause: err,
      },
    );
  }

  return parseBarsFile(json, path);
}

// The same listing `import-osm-bars.ts` prints, for the same reason: a
// collapse is the one thing either script does that silently removes a real
// OSM object, so every merged pair is named rather than only counted, and if
// the rule ever merges two genuinely different bars this is where it shows.
function printCollapseReport(collapsed: CollapsedDuplicate[]): void {
  console.log(`--- ${collapsed.length} duplicate venue(s) collapsed ---`);
  for (const pair of collapsed) {
    console.log(
      `    ${pair.kept.name} (${pair.kept.osm_id}) absorbed ${pair.dropped.name} ` +
        `(${pair.dropped.osm_id}), ${pair.distanceM.toFixed(2)} m apart`,
    );
  }
}

function writeAtomic(targetPath: string, contents: string): number {
  const tmpPath = `${targetPath}.tmp-${randomBytes(6).toString('hex')}`;
  writeFileSync(tmpPath, contents, 'utf-8');
  renameSync(tmpPath, targetPath);
  return Buffer.byteLength(contents, 'utf-8');
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const barsPath = join(repoRoot, citySeedDir(args.city), 'bars.json');

  const bars = loadBars(barsPath);
  console.log(`Read ${bars.length} bar(s) from ${barsPath}.`);

  const result = collapseDuplicateBars(bars);
  printCollapseReport(result.collapsed);

  if (result.collapsed.length === 0) {
    console.log('Nothing to do — the seed already satisfies Section 11.1. Left untouched.');
    return;
  }

  // Byte-identical to what `import-osm-bars.ts` writes, so a seed collapsed
  // here and a seed collapsed by a re-import are the same file rather than
  // the same records under two formatters.
  const contents = JSON.stringify(result.bars, null, 2);

  if (args.dryRun) {
    console.log(`Would write ${result.bars.length} bar(s) to ${barsPath} (nothing written).`);
    return;
  }

  const bytes = writeAtomic(barsPath, contents);
  console.log(`Wrote ${result.bars.length} bar(s)  ${bytes} bytes  (${barsPath})`);
  console.log(
    'Nothing was written to the live database — only the seed file above. Applying this removal ' +
      'to the running app is a manual admin decision (SPEC.md Section 11.2).',
  );
}

try {
  main();
} catch (err: unknown) {
  console.error(`collapse-seed-duplicates: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
