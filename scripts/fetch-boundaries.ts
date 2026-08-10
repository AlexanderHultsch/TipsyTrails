// Fetches city, district, and neighbouring-municipality boundaries from
// Overpass and writes them as GeoJSON into `data/seed/<slug>/`
// (SPEC.md Section 11.4).
//
// Run once, locally, by the project owner — this sandbox has no route to
// Overpass. `--dry-run` is how the work is reviewed without network access:
// it prints the two queries and the three target paths and writes nothing.
//
// Usage:
//   node scripts/fetch-boundaries.ts --city=karlsruhe
//   node scripts/fetch-boundaries.ts --city=karlsruhe --dry-run
//   node scripts/fetch-boundaries.ts --city=karlsruhe --overpass-url=https://overpass.example/api/interpreter
//   node scripts/fetch-boundaries.ts --city=karlsruhe --input-city=./city.json --input-neighbours=./neighbours.json
//
// --input-city and --input-neighbours each read a previously saved Overpass
// JSON response from disk instead of querying for it, so the two queries can
// be run by hand (e.g. in a browser, from a machine that *can* reach
// Overpass) and the conversion re-run here offline. Either flag may be given
// on its own; whichever is omitted is still fetched over the network. When
// both are given, this script makes no network request at all. Saved
// responses go through the exact same validation and conversion as fetched
// ones — there is no separate, laxer path for local files.
//
// Node 22 strips TypeScript types natively, so relative imports here use an
// explicit `.ts` extension and resolve straight to source with no build
// step — unlike `packages/api` and `packages/shared`, which are compiled by
// tsc and use NodeNext's `.js`-extension convention instead (CLAUDE.md).
// The query-building and OSM→GeoJSON conversion logic itself lives in
// `packages/shared/src/overpass.ts`, not here, so it is covered by the
// existing `pnpm test` / `pnpm typecheck` pipeline (see the report for why).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { citySeedDir, parseCityConfig, type CityConfig } from '../packages/shared/src/city.ts';
import {
  DEFAULT_OVERPASS_TIMEOUT_S,
  buildCityAndDistrictsQuery,
  buildNeighboursQuery,
  findCityRelation,
  findDistrictRelations,
  findNeighbourRelations,
  parseOverpassPayload,
  relationToFeature,
  toFeatureCollection,
  type OverpassResponse,
} from '../packages/shared/src/overpass.ts';

const DEFAULT_OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const USER_AGENT =
  'TipsyTrails-fetch-boundaries/1.0 (+https://github.com/AlexanderHultsch/TipsyTrails)';

interface CliArgs {
  city: string;
  dryRun: boolean;
  overpassUrl: string;
  inputCity?: string;
  inputNeighbours?: string;
}

function parseArgs(argv: string[]): CliArgs {
  let city: string | undefined;
  let dryRun = false;
  let overpassUrl = DEFAULT_OVERPASS_URL;
  let inputCity: string | undefined;
  let inputNeighbours: string | undefined;

  for (const arg of argv) {
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg.startsWith('--city=')) {
      city = arg.slice('--city='.length);
    } else if (arg.startsWith('--overpass-url=')) {
      overpassUrl = arg.slice('--overpass-url='.length);
    } else if (arg.startsWith('--input-city=')) {
      inputCity = arg.slice('--input-city='.length);
    } else if (arg.startsWith('--input-neighbours=')) {
      inputNeighbours = arg.slice('--input-neighbours='.length);
    } else {
      throw new Error(
        `Unrecognised argument "${arg}". Expected --city=<slug> [--dry-run] [--overpass-url=<url>] ` +
          `[--input-city=<path>] [--input-neighbours=<path>].`,
      );
    }
  }

  if (!city) {
    throw new Error('Missing required --city=<slug> argument.');
  }

  return { city, dryRun, overpassUrl, inputCity, inputNeighbours };
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
): Promise<OverpassResponse> {
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

  // A 200 with an HTML overload page is caught inside parseOverpassPayload,
  // which checks content type and payload shape rather than trusting the
  // HTTP status code alone.
  return parseOverpassPayload(body, response.headers.get('content-type') ?? undefined);
}

/**
 * Reads a previously saved Overpass response from disk and runs it through
 * the exact same `parseOverpassPayload` validation as a fetched response —
 * the same HTML-error-page rejection, the same "elements" shape check.
 * There is no content type to pass (there is no HTTP response here), which
 * `parseOverpassPayload` already tolerates for the HTML check via the body
 * itself.
 */
function loadOverpassResponseFromFile(path: string, flagName: string): OverpassResponse {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new Error(
      `No file found at "${path}" (given via ${flagName}). Expected a saved Overpass "out geom" JSON ` +
        `response.`,
      { cause: err },
    );
  }

  try {
    return parseOverpassPayload(raw, undefined);
  } catch (err) {
    throw new Error(
      `"${path}" (given via ${flagName}) does not contain a usable Overpass response: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
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

  const cityDistrictsQuery = buildCityAndDistrictsQuery(config, DEFAULT_OVERPASS_TIMEOUT_S);
  const neighboursQuery = buildNeighboursQuery(config, DEFAULT_OVERPASS_TIMEOUT_S);

  const seedDir = join(repoRoot, citySeedDir(config.slug));
  const outputPaths = {
    city: join(seedDir, 'city.geojson'),
    districts: join(seedDir, 'districts.geojson'),
    neighbours: join(seedDir, 'neighbours.geojson'),
  };

  if (args.dryRun) {
    console.log('--- city + districts query ---');
    console.log(cityDistrictsQuery);
    console.log(
      args.inputCity
        ? `Source: file ${args.inputCity} (no network request)`
        : `Source: network query to ${args.overpassUrl}`,
    );
    console.log();
    console.log('--- neighbours query ---');
    console.log(neighboursQuery);
    console.log(
      args.inputNeighbours
        ? `Source: file ${args.inputNeighbours} (no network request)`
        : `Source: network query to ${args.overpassUrl}`,
    );
    console.log();
    console.log('Would write:');
    console.log(`  ${outputPaths.city}`);
    console.log(`  ${outputPaths.districts}`);
    console.log(`  ${outputPaths.neighbours}`);
    return;
  }

  let cityDistrictsResponse: OverpassResponse;
  if (args.inputCity) {
    console.log(`Reading city + districts response from ${args.inputCity}...`);
    cityDistrictsResponse = loadOverpassResponseFromFile(args.inputCity, '--input-city');
  } else {
    console.log(`Querying ${args.overpassUrl} for "${config.name}" (city + districts)...`);
    cityDistrictsResponse = await queryOverpass(
      args.overpassUrl,
      cityDistrictsQuery,
      DEFAULT_OVERPASS_TIMEOUT_S,
    );
  }
  const cityRelation = findCityRelation(cityDistrictsResponse, config);
  const districtRelations = findDistrictRelations(cityDistrictsResponse, config, cityRelation.id);

  let neighboursResponse: OverpassResponse;
  if (args.inputNeighbours) {
    console.log(`Reading neighbours response from ${args.inputNeighbours}...`);
    neighboursResponse = loadOverpassResponseFromFile(args.inputNeighbours, '--input-neighbours');
  } else {
    console.log(`Querying ${args.overpassUrl} for "${config.name}" (neighbours)...`);
    neighboursResponse = await queryOverpass(
      args.overpassUrl,
      neighboursQuery,
      DEFAULT_OVERPASS_TIMEOUT_S,
    );
  }
  const neighbourRelations = findNeighbourRelations(neighboursResponse, cityRelation.id);

  // Build every output document in memory first. Nothing is written until
  // all three have been converted successfully (SPEC.md 11.4: a failed run
  // must leave nothing half-written).
  const cityGeoJson = toFeatureCollection([relationToFeature(cityRelation)]);
  const districtsGeoJson = toFeatureCollection(districtRelations.map((r) => relationToFeature(r)));
  const neighboursGeoJson = toFeatureCollection(
    neighbourRelations.map((r) => relationToFeature(r)),
  );

  mkdirSync(seedDir, { recursive: true });
  const written = [
    { label: 'city.geojson', path: outputPaths.city, contents: JSON.stringify(cityGeoJson) },
    {
      label: 'districts.geojson',
      path: outputPaths.districts,
      contents: JSON.stringify(districtsGeoJson),
    },
    {
      label: 'neighbours.geojson',
      path: outputPaths.neighbours,
      contents: JSON.stringify(neighboursGeoJson),
    },
  ].map((file) => ({ ...file, bytes: writeAtomic(file.path, file.contents) }));

  console.log(
    `Wrote ${config.name}: ${districtRelations.length} district(s), ` +
      `${neighbourRelations.length} neighbouring municipalit${neighbourRelations.length === 1 ? 'y' : 'ies'}.`,
  );
  for (const file of written) {
    console.log(`  ${file.label}  ${file.bytes} bytes  (${file.path})`);
  }
}

main().catch((err: unknown) => {
  console.error(`fetch-boundaries: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
