// Builds the fog-of-war cell grid from a city's districts.geojson
// (SPEC.md Sections 5.2, 6, 11.4).
//
// Offline and city-parameterised: no network access, everything comes from
// `data/cities/<slug>.json` and `data/seed/<slug>/districts.geojson`
// (already fetched by `scripts/fetch-boundaries.ts`). Writes
// `data/seed/<slug>/grid.bin` (a packed Uint16Array, one entry per cell,
// mapping the cell to its district's index or the sentinel 0xFFFF) and
// `data/seed/<slug>/grid-meta.json` (grid dimensions and per-district
// playable cell counts) — the seeding step's only source for those numbers.
//
// Usage:
//   node scripts/build-grid.ts --city=karlsruhe
//   node scripts/build-grid.ts --city=karlsruhe --dry-run
//
// `--dry-run` runs the full computation (there is no network call to skip)
// and prints the same summary a real run would, but writes nothing.
//
// Node 22 strips TypeScript types natively, so relative imports here use an
// explicit `.ts` extension and resolve straight to source with no build
// step — unlike `packages/api` and `packages/shared`, which are compiled by
// tsc and use NodeNext's `.js`-extension convention instead (CLAUDE.md).
// The projection, point-in-polygon test and district assignment logic
// itself lives in `packages/shared/src/grid.ts`, not here, so it is covered
// by the existing `pnpm test` / `pnpm typecheck` pipeline.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { citySeedDir, parseCityConfig, type CityConfig } from '../packages/shared/src/city.ts';
import {
  assignGrid,
  checkAreaEstimate,
  computeGridDimensions,
  districtsWithNoCells,
  polygonAreaM2,
  type DistrictAssignment,
  type DistrictInput,
  type GeoJsonMultiPolygon,
  type GeoJsonPolygon,
  type GridParams,
} from '../packages/shared/src/grid.ts';

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
      { cause: err },
    );
  }

  return parseCityConfig(json);
}

interface RawGeoJsonFeature {
  type: 'Feature';
  properties?: Record<string, unknown> | null;
  geometry?: { type: string } | null;
}

interface RawGeoJsonFeatureCollection {
  type: 'FeatureCollection';
  features: RawGeoJsonFeature[];
}

function loadGeoJsonFeatureCollection(path: string, label: string): RawGeoJsonFeatureCollection {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new Error(`No ${label} found at "${path}". Run scripts/fetch-boundaries.ts first.`, {
      cause: err,
    });
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `"${path}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (
    typeof json !== 'object' ||
    json === null ||
    (json as { type?: unknown }).type !== 'FeatureCollection' ||
    !Array.isArray((json as { features?: unknown }).features)
  ) {
    throw new Error(`"${path}" is not a GeoJSON FeatureCollection.`);
  }

  return json as RawGeoJsonFeatureCollection;
}

function districtInputsFrom(
  collection: RawGeoJsonFeatureCollection,
  path: string,
): DistrictInput[] {
  return collection.features.map((feature, index) => {
    const name = feature.properties?.name;
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`Feature ${index} in "${path}" has no usable "name" property.`);
    }
    const geometry = feature.geometry;
    if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) {
      throw new Error(
        `Feature ${index} ("${name}") in "${path}" has geometry type ` +
          `"${geometry?.type ?? 'missing'}", expected Polygon or MultiPolygon.`,
      );
    }
    return { name, geometry: geometry as GeoJsonPolygon | GeoJsonMultiPolygon };
  });
}

function cityGeometryFrom(
  collection: RawGeoJsonFeatureCollection,
  path: string,
): GeoJsonPolygon | GeoJsonMultiPolygon {
  if (collection.features.length !== 1) {
    throw new Error(
      `Expected exactly one feature in "${path}" (the city outline), found ${collection.features.length}.`,
    );
  }
  const geometry = collection.features[0].geometry;
  if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) {
    throw new Error(
      `The city feature in "${path}" has geometry type "${geometry?.type ?? 'missing'}", ` +
        `expected Polygon or MultiPolygon.`,
    );
  }
  return geometry as GeoJsonPolygon | GeoJsonMultiPolygon;
}

function writeAtomic(targetPath: string, contents: string | Buffer): number {
  const tmpPath = `${targetPath}.tmp-${randomBytes(6).toString('hex')}`;
  writeFileSync(tmpPath, contents);
  renameSync(tmpPath, targetPath);
  return Buffer.isBuffer(contents) ? contents.length : Buffer.byteLength(contents, 'utf-8');
}

function formatDistrictLine(d: DistrictAssignment): string {
  return `  ${d.name.padEnd(24)} ${String(d.playableCells).padStart(6)} cells`;
}

function printSummary(
  config: CityConfig,
  gridWidth: number,
  gridHeight: number,
  playableCells: number,
  districts: DistrictAssignment[],
): void {
  const totalCells = gridWidth * gridHeight;
  const percentPlayable = (playableCells / totalCells) * 100;

  const byCount = [...districts].sort((a, b) => b.playableCells - a.playableCells);
  const largest = byCount.slice(0, 5);
  const smallest = byCount.slice(-5).reverse();

  console.log(`${config.name}: grid ${gridWidth} x ${gridHeight} = ${totalCells} cells`);
  console.log(
    `  Playable cells: ${playableCells} (${percentPlayable.toFixed(2)}% of bounding box)`,
  );
  console.log(`  Districts: ${districts.length}`);
  console.log('  Largest 5 districts by cell count:');
  for (const d of largest) console.log(formatDistrictLine(d));
  console.log('  Smallest 5 districts by cell count:');
  for (const d of smallest) console.log(formatDistrictLine(d));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const config = loadCityConfig(repoRoot, args.city);

  const seedDir = join(repoRoot, citySeedDir(config.slug));
  const districtsPath = join(seedDir, 'districts.geojson');
  const cityPath = join(seedDir, 'city.geojson');
  const outputPaths = {
    grid: join(seedDir, 'grid.bin'),
    meta: join(seedDir, 'grid-meta.json'),
  };

  const districtsCollection = loadGeoJsonFeatureCollection(districtsPath, 'districts.geojson');
  const districtInputs = districtInputsFrom(districtsCollection, districtsPath);
  const cityCollection = loadGeoJsonFeatureCollection(cityPath, 'city.geojson');
  const cityGeometry = cityGeometryFrom(cityCollection, cityPath);

  const { grid_width, grid_height } = computeGridDimensions(
    config.bounding_box,
    config.cell_size_m,
  );
  const gridParams: GridParams = {
    origin_lat: config.bounding_box.south,
    origin_lon: config.bounding_box.west,
    grid_width,
    grid_height,
    cell_size_m: config.cell_size_m,
  };

  console.log(
    `Building grid for "${config.name}": ${grid_width} x ${grid_height} cells at ` +
      `${config.cell_size_m} m, origin (${gridParams.origin_lat}, ${gridParams.origin_lon}), ` +
      `${districtInputs.length} district(s).`,
  );

  const result = assignGrid(gridParams, districtInputs);

  const emptyDistricts = districtsWithNoCells(result.districts);
  if (emptyDistricts.length > 0) {
    throw new Error(
      `${emptyDistricts.length} district(s) received zero cells: ${emptyDistricts.join(', ')}. ` +
        `This means the projection, the bounding box, or a district polygon is wrong.`,
    );
  }

  const cityAreaM2 = polygonAreaM2(cityGeometry, gridParams.origin_lat);
  const estimatedCells = cityAreaM2 / (config.cell_size_m * config.cell_size_m);
  checkAreaEstimate(result.playableCells, estimatedCells);

  console.log(
    `Area sanity check: city polygon is ~${(cityAreaM2 / 1_000_000).toFixed(1)} km² ` +
      `(~${estimatedCells.toFixed(0)} cells at ${config.cell_size_m} m); grid gives ` +
      `${result.playableCells} playable cells.`,
  );

  printSummary(config, grid_width, grid_height, result.playableCells, result.districts);

  if (args.dryRun) {
    console.log('Dry run: nothing written.');
    console.log('Would write:');
    console.log(`  ${outputPaths.grid}`);
    console.log(`  ${outputPaths.meta}`);
    return;
  }

  const gridBuffer = Buffer.from(
    result.grid.buffer,
    result.grid.byteOffset,
    result.grid.byteLength,
  );
  const meta = {
    grid_width,
    grid_height,
    playable_cells: result.playableCells,
    districts: result.districts.map((d) => ({
      name: d.name,
      index: d.index,
      playable_cells: d.playableCells,
    })),
  };

  mkdirSync(seedDir, { recursive: true });
  const written = [
    { label: 'grid.bin', path: outputPaths.grid, contents: gridBuffer },
    { label: 'grid-meta.json', path: outputPaths.meta, contents: JSON.stringify(meta, null, 2) },
  ].map((file) => ({ ...file, bytes: writeAtomic(file.path, file.contents) }));

  console.log(`Wrote ${config.name}:`);
  for (const file of written) {
    console.log(`  ${file.label}  ${file.bytes} bytes  (${file.path})`);
  }
}

main().catch((err: unknown) => {
  console.error(`build-grid: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
