import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NO_DISTRICT } from '@tipsytrails/shared';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ACTIVE_CITY_SLUG } from '../active-city.js';
import type { Env } from '../env.js';
import { loadDistrictIdByGridIndex } from '../fog/district-index.js';
import { resolveSeedDir } from '../routes/static-data.js';

// Seeds (or updates) the `bars` table from `data/seed/<slug>/bars.json`
// (SPEC.md Sections 5.6, 11.1) — the file `scripts/import-osm-bars.ts`
// writes, one `Bar` (packages/shared/src/bars.ts) per entry.
//
// The file does not exist yet in this repository (the real OSM export is
// still to come, per the phase brief), so its absence is treated the same
// way `app.ts` treats a missing `grid.bin`: log it and continue rather than
// fail the boot.
//
// Like `seedCity`, this is not "insert once, skip forever": a bar is matched
// by `(city_id, osm_id)` — the identity `bars.json` itself carries — and an
// existing match is UPDATEd in place rather than re-inserted, so the id
// never changes for a bar that survives a reseed. That is what keeps
// `bar_discoveries` (and later `visits`) safe to reference it by foreign
// key. `status` is deliberately left untouched on an UPDATE: it defaults to
// 'active' only for a bar inserted for the first time, so a bar an admin
// later hides (Section 9.3) is not silently reactivated by a reseed.

const barSchema = z.object({
  osm_id: z.string().min(1),
  name: z.string().min(1),
  address: z.string().nullable(),
  lat: z.number(),
  lon: z.number(),
  cell_index: z.number().int().nonnegative(),
  source: z.literal('osm'),
});

const barsFileSchema = z.array(barSchema);

type SeedBar = z.infer<typeof barSchema>;

interface CityIdRow {
  id: number;
}

// Mirrors `app.ts`'s `loadGrid` verbatim (SPEC.md Section 5.2's `grid.bin`
// format). Reimplemented rather than imported: `app.ts` is the top-level
// wiring file that assembles routes onto a `FastifyInstance`, and nothing
// else in the `db/` layer depends on it — importing from it here would
// point that dependency backwards for the sake of one eight-line helper.
function loadGrid(gridPath: string): Uint16Array {
  const fileBuffer = readFileSync(gridPath);
  const copy = fileBuffer.buffer.slice(
    fileBuffer.byteOffset,
    fileBuffer.byteOffset + fileBuffer.byteLength,
  );
  return new Uint16Array(copy);
}

function districtIdForCell(
  cellIndex: number,
  grid: Uint16Array | null,
  districtIdByGridIndex: Map<number, number> | null,
): number | null {
  if (!grid || !districtIdByGridIndex) {
    return null;
  }
  const districtIndex = grid[cellIndex];
  if (districtIndex === undefined || districtIndex === NO_DISTRICT) {
    return null;
  }
  return districtIdByGridIndex.get(districtIndex) ?? null;
}

export function seedBars(db: Database.Database, env: Env): void {
  const seedDir = resolveSeedDir(env);
  const barsPath = join(seedDir, ACTIVE_CITY_SLUG, 'bars.json');

  if (!existsSync(barsPath)) {
    console.log(
      `No bars.json found at ${barsPath}; skipping bar seeding. Generate one with ` +
        `scripts/import-osm-bars.ts --city=${ACTIVE_CITY_SLUG} once the real export is available.`,
    );
    return;
  }

  const bars: SeedBar[] = barsFileSchema.parse(JSON.parse(readFileSync(barsPath, 'utf-8')));

  const city = db
    .prepare<[string], CityIdRow>('SELECT id FROM cities WHERE slug = ?')
    .get(ACTIVE_CITY_SLUG);
  if (!city) {
    throw new Error(
      `seedBars: no "cities" row for slug "${ACTIVE_CITY_SLUG}" — seedCity must run before seedBars.`,
    );
  }

  // Same grid.bin the app decorates its Fastify instance with at boot
  // (app.ts): a bar's cell_index is denormalized against the identical grid
  // (SPEC.md Section 5.6), so this is the one place that maps it to a
  // district row id, left NULL (as Section 5.6 allows) when the grid is
  // unavailable or the cell belongs to no district.
  const gridPath = join(seedDir, ACTIVE_CITY_SLUG, 'grid.bin');
  let grid: Uint16Array | null = null;
  let districtIdByGridIndex: Map<number, number> | null = null;
  if (existsSync(gridPath)) {
    grid = loadGrid(gridPath);
    districtIdByGridIndex = loadDistrictIdByGridIndex(db, seedDir, ACTIVE_CITY_SLUG);
  }

  const run = db.transaction((): void => {
    const findExisting = db.prepare<[number, string], { id: number }>(
      'SELECT id FROM bars WHERE city_id = ? AND osm_id = ?',
    );
    const insertBar = db.prepare(
      `INSERT INTO bars
         (city_id, district_id, name, address, lat, lon, cell_index, source, osm_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'osm', ?, 'active', ?)`,
    );
    const updateBar = db.prepare(
      `UPDATE bars SET district_id = ?, name = ?, address = ?, lat = ?, lon = ?, cell_index = ?
       WHERE id = ?`,
    );

    const now = Math.floor(Date.now() / 1000);
    for (const bar of bars) {
      const districtId = districtIdForCell(bar.cell_index, grid, districtIdByGridIndex);
      const existing = findExisting.get(city.id, bar.osm_id);
      if (existing) {
        updateBar.run(
          districtId,
          bar.name,
          bar.address,
          bar.lat,
          bar.lon,
          bar.cell_index,
          existing.id,
        );
      } else {
        insertBar.run(
          city.id,
          districtId,
          bar.name,
          bar.address,
          bar.lat,
          bar.lon,
          bar.cell_index,
          bar.osm_id,
          now,
        );
      }
    }
  });

  run();
}
