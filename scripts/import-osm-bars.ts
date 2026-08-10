// Fetches drinking establishments from Overpass and writes them as
// `data/seed/<slug>/bars.json` (SPEC.md Section 11.1, 11.4).
//
// Run once, locally, by the project owner — this sandbox has no route to
// Overpass. `--dry-run` is how the work is reviewed without network access:
// it prints the query and the target path and writes nothing.
//
// Usage:
//   node scripts/import-osm-bars.ts --city=karlsruhe
//   node scripts/import-osm-bars.ts --city=karlsruhe --dry-run
//   node scripts/import-osm-bars.ts --city=karlsruhe --overpass-url=https://overpass.example/api/interpreter
//   node scripts/import-osm-bars.ts --city=karlsruhe --input=./bars-export.json
//
// --input reads a previously saved response from disk instead of querying
// for it, so the query can be run by hand (e.g. in a browser, from a
// machine that *can* reach Overpass) and the conversion re-run here
// offline. The file may be either a raw Overpass "out center" JSON response
// or a GeoJSON FeatureCollection — the shape overpass-turbo's "export as
// GeoJSON" naturally produces — and the two are detected and handled by the
// same code path, not a separate, laxer one for local files.
//
// Re-running this script never touches the live database (SPEC.md Section
// 11.2): if `bars.json` already exists, the new bars are diffed against it
// and the diff is printed to stdout before the file itself is overwritten.
// Applying that diff to a running app is a manual admin decision.
//
// Node 22 strips TypeScript types natively, so relative imports here use an
// explicit `.ts` extension and resolve straight to source with no build
// step — unlike `packages/api` and `packages/shared`, which are compiled by
// tsc and use NodeNext's `.js`-extension convention instead (CLAUDE.md).
// The query-building and OSM→bar conversion logic itself lives in
// `packages/shared/src/bars.ts`, not here, so it is covered by the existing
// `pnpm test` / `pnpm typecheck` pipeline (see the report for why).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { citySeedDir, parseCityConfig, type CityConfig } from '../packages/shared/src/city.ts';
import {
  DEFAULT_OVERPASS_TIMEOUT_S,
  buildBarsQuery,
  diffBars,
  osmElementsToBars,
  parseBarsPayload,
  type Bar,
  type BarDiff,
  type OverpassBarsResponse,
} from '../packages/shared/src/bars.ts';

const DEFAULT_OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const USER_AGENT =
  'TipsyTrails-import-osm-bars/1.0 (+https://github.com/AlexanderHultsch/TipsyTrails)';

interface CliArgs {
  city: string;
  dryRun: boolean;
  overpassUrl: string;
  input?: string;
}

function parseArgs(argv: string[]): CliArgs {
  let city: string | undefined;
  let dryRun = false;
  let overpassUrl = DEFAULT_OVERPASS_URL;
  let input: string | undefined;

  for (const arg of argv) {
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg.startsWith('--city=')) {
      city = arg.slice('--city='.length);
    } else if (arg.startsWith('--overpass-url=')) {
      overpassUrl = arg.slice('--overpass-url='.length);
    } else if (arg.startsWith('--input=')) {
      input = arg.slice('--input='.length);
    } else {
      throw new Error(
        `Unrecognised argument "${arg}". Expected --city=<slug> [--dry-run] [--overpass-url=<url>] ` +
          `[--input=<path>].`,
      );
    }
  }

  if (!city) {
    throw new Error('Missing required --city=<slug> argument.');
  }

  return { city, dryRun, overpassUrl, input };
}

function loadCityConfig(repoRoot: string, slug: string): CityConfig {
  const configPath = join(repoRoot, 'data', 'cities', `${slug}.json`);
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (err) {
    throw new Error(
      `No city config found at "${configPath}". Expected data/cities/${slug}.json — check the --city ` +
        `slug and that the file exists.`,
      { cause: err },
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `"${configPath}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      {
        cause: err,
      },
    );
  }

  return parseCityConfig(json);
}

async function queryOverpass(
  overpassUrl: string,
  query: string,
  timeoutS: number,
): Promise<OverpassBarsResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutS * 1000);

  let response: Response;
  try {
    response = await fetch(overpassUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      `Overpass request to ${overpassUrl} failed with HTTP ${response.status} ${response.statusText}. ` +
        `First 200 characters of the body: ${body.slice(0, 200)}`,
    );
  }

  // A 200 with an HTML overload page is caught inside parseBarsPayload,
  // which checks content type and payload shape rather than trusting the
  // HTTP status code alone.
  return parseBarsPayload(body, response.headers.get('content-type') ?? undefined);
}

/**
 * Reads a previously saved bars response from disk and runs it through the
 * exact same `parseBarsPayload` validation and format detection as a
 * fetched response — the same HTML-error-page rejection, the same shape
 * check, whether the file holds a raw Overpass "out center" JSON response
 * or a GeoJSON FeatureCollection.
 */
function loadBarsResponseFromFile(path: string): OverpassBarsResponse {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new Error(
      `No file found at "${path}" (given via --input). Expected a saved Overpass "out center" JSON ` +
        `response or a GeoJSON FeatureCollection.`,
      { cause: err },
    );
  }

  try {
    return parseBarsPayload(raw, undefined);
  } catch (err) {
    throw new Error(
      `"${path}" (given via --input) does not contain a usable Overpass response: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

function loadPreviousBars(path: string): Bar[] | undefined {
  if (!existsSync(path)) return undefined;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new Error(`Could not read existing "${path}" to compute a diff: ${String(err)}`, {
      cause: err,
    });
  }

  try {
    return JSON.parse(raw) as Bar[];
  } catch (err) {
    throw new Error(
      `Existing "${path}" is not valid JSON, so no diff can be computed against it: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

function printDiffReport(diff: BarDiff): void {
  console.log('--- diff vs existing bars.json ---');
  console.log(`  ${diff.added.length} new:`);
  for (const bar of diff.added) console.log(`    + ${bar.name} (${bar.osm_id})`);
  console.log(`  ${diff.removed.length} disappeared:`);
  for (const bar of diff.removed) console.log(`    - ${bar.name} (${bar.osm_id})`);
  console.log(`  ${diff.changed.length} changed:`);
  for (const change of diff.changed) {
    console.log(
      `    * ${change.after.name} (${change.osm_id}): ${change.changedFields.join(', ')}`,
    );
  }
  console.log(
    '  This diff is informational only. Nothing has been applied anywhere but the seed file below ' +
      '— applying it to the running app is a manual admin decision (SPEC.md Section 11.2).',
  );
}

function writeAtomic(targetPath: string, contents: string): number {
  const tmpPath = `${targetPath}.tmp-${randomBytes(6).toString('hex')}`;
  writeFileSync(tmpPath, contents, 'utf-8');
  renameSync(tmpPath, targetPath);
  return Buffer.byteLength(contents, 'utf-8');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const config = loadCityConfig(repoRoot, args.city);

  const query = buildBarsQuery(config, DEFAULT_OVERPASS_TIMEOUT_S);
  const seedDir = join(repoRoot, citySeedDir(config.slug));
  const outputPath = join(seedDir, 'bars.json');

  if (args.dryRun) {
    console.log('--- bars query ---');
    console.log(query);
    console.log(
      args.input
        ? `Source: file ${args.input} (no network request)`
        : `Source: network query to ${args.overpassUrl}`,
    );
    console.log();
    console.log('Would write:');
    console.log(`  ${outputPath}`);
    return;
  }

  let response: OverpassBarsResponse;
  if (args.input) {
    console.log(`Reading bars response from ${args.input}...`);
    response = loadBarsResponseFromFile(args.input);
  } else {
    console.log(`Querying ${args.overpassUrl} for "${config.name}" (bars)...`);
    response = await queryOverpass(args.overpassUrl, query, DEFAULT_OVERPASS_TIMEOUT_S);
  }

  const result = osmElementsToBars(response, config);

  const previousBars = loadPreviousBars(outputPath);
  if (previousBars) {
    console.log(`Existing ${outputPath} found (${previousBars.length} bar(s)); computing diff...`);
    printDiffReport(diffBars(previousBars, result.bars));
  }

  mkdirSync(seedDir, { recursive: true });
  const contents = JSON.stringify(result.bars, null, 2);
  const bytes = writeAtomic(outputPath, contents);

  console.log(
    `Wrote ${config.name}: ${result.bars.length} bar(s), ${result.discardedNoName} discarded for ` +
      `missing a name tag, ${result.wayOrRelationCount} way(s)/relation(s) reduced to a centroid.`,
  );
  console.log(`  bars.json  ${bytes} bytes  (${outputPath})`);
  console.log(
    'Nothing was written to the live database — only the seed file above. Applying any diff to ' +
      'the running app is a manual admin decision (SPEC.md Section 11.2).',
  );
}

main().catch((err: unknown) => {
  console.error(`import-osm-bars: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
