import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseCityConfig } from '@tipsytrails/shared';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ACTIVE_CITY_SLUG } from '../active-city.js';
import type { Env } from '../env.js';
import { resolveSeedDir } from '../routes/static-data.js';

// `data/cities/` and `data/seed/` are siblings under `data/` (SPEC.md
// Section 4.2's repository tree), so the cities directory is derived from
// wherever the seed directory resolves to (`resolveSeedDir`, which already
// honours `env.SEED_DIR`) instead of introducing a second override env var
// for a path that never varies independently of it.
function resolveCitiesDir(env: Env): string {
  return join(dirname(resolveSeedDir(env)), 'cities');
}

const districtMetaSchema = z.object({
  name: z.string().min(1),
  index: z.number().int().nonnegative(),
  playable_cells: z.number().int().nonnegative(),
});

const gridMetaSchema = z.object({
  grid_width: z.number().int().positive(),
  grid_height: z.number().int().positive(),
  playable_cells: z.number().int().nonnegative(),
  districts: z.array(districtMetaSchema),
});

type GridMeta = z.infer<typeof gridMetaSchema>;

/**
 * The one reader of `data/seed/<slug>/grid-meta.json` in this package.
 * Exported for `fog/district-index.ts`, which reads the same file for its
 * own half of it (`districts[].index` -> `districts.id`) and used to cast
 * the parse result instead — a cast that turned a wrongly regenerated file
 * into `undefined is not iterable` a few lines later rather than a
 * diagnosis. Two readers of one file with one schema between them, so a
 * field this schema does not know about cannot reach either of them.
 *
 * Failure is an Error naming the path and what was wrong with it: the
 * operator regenerates this file with `scripts/build-grid.ts`, and a bare
 * ZodError (or a TypeError from downstream) names neither the file nor the
 * command that produces it.
 */
export function loadGridMeta(seedDir: string, slug: string): GridMeta {
  const path = join(seedDir, slug, 'grid-meta.json');
  const raw = readFileSync(path, 'utf-8');

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}. ` +
        `Regenerate it with scripts/build-grid.ts --city=${slug}.`,
      { cause: err },
    );
  }

  const parsed = gridMetaSchema.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(
      `${path} is not a valid grid-meta.json (${problems}). ` +
        `Regenerate it with scripts/build-grid.ts --city=${slug}.`,
    );
  }
  return parsed.data;
}

interface ExistingDistrictRow {
  id: number;
  name: string;
}

/**
 * Seeds (or updates) the `cities` row and its `districts` rows from
 * `data/cities/<slug>.json` and `data/seed/<slug>/grid-meta.json` (SPEC.md
 * Sections 5.1, 5.2, 11.4) — the seeding step never types these numbers by
 * hand.
 *
 * Unlike `seedAdmin`, this is not "insert once, skip forever": a city row is
 * matched by its unique `slug` and a district row by `(city_id, name)`, and
 * an existing match is UPDATEd in place rather than left stale, so a
 * regenerated grid's `playable_cells` (and, for the city, `grid_width` /
 * `grid_height`) reaches the database on the next boot. The id never
 * changes for a matched row, which is what keeps it safe: `fog_state`,
 * `fog_district_progress` and `bars` all reference these ids by foreign
 * key, and an UPDATE-in-place never invalidates them.
 *
 * A district name that existed in the database but is absent from the new
 * `grid-meta.json` (a rename, merge, or split in a regenerated grid) is not
 * handled automatically — silently deleting or renaming that row would
 * either break the foreign key or silently reassign a stable id to a
 * different district underneath any existing `fog_district_progress`.
 * Instead this throws, failing the boot loudly so the situation gets a
 * manual migration decision instead of silent data corruption.
 */
export function seedCity(db: Database.Database, env: Env): void {
  const citiesDir = resolveCitiesDir(env);
  const configPath = join(citiesDir, `${ACTIVE_CITY_SLUG}.json`);
  const cityConfig = parseCityConfig(JSON.parse(readFileSync(configPath, 'utf-8')));
  const gridMeta = loadGridMeta(resolveSeedDir(env), cityConfig.slug);

  const run = db.transaction(() => {
    const existingCity = db
      .prepare<[string], { id: number }>('SELECT id FROM cities WHERE slug = ?')
      .get(cityConfig.slug);

    let cityId: number;
    if (existingCity) {
      cityId = existingCity.id;
      db.prepare(
        `UPDATE cities
           SET name = ?, origin_lat = ?, origin_lon = ?, grid_width = ?, grid_height = ?,
               cell_size_m = ?, playable_cells = ?, is_active = 1
         WHERE id = ?`,
      ).run(
        cityConfig.name,
        cityConfig.bounding_box.south,
        cityConfig.bounding_box.west,
        gridMeta.grid_width,
        gridMeta.grid_height,
        cityConfig.cell_size_m,
        gridMeta.playable_cells,
        cityId,
      );
    } else {
      const inserted = db
        .prepare(
          `INSERT INTO cities
             (slug, name, origin_lat, origin_lon, grid_width, grid_height, cell_size_m, playable_cells, is_active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .run(
          cityConfig.slug,
          cityConfig.name,
          cityConfig.bounding_box.south,
          cityConfig.bounding_box.west,
          gridMeta.grid_width,
          gridMeta.grid_height,
          cityConfig.cell_size_m,
          gridMeta.playable_cells,
        );
      cityId = Number(inserted.lastInsertRowid);
    }

    const existingDistricts = db
      .prepare<[number], ExistingDistrictRow>('SELECT id, name FROM districts WHERE city_id = ?')
      .all(cityId);
    const existingByName = new Map(existingDistricts.map((row) => [row.name, row]));
    const incomingNames = new Set(gridMeta.districts.map((d) => d.name));

    const disappeared = existingDistricts.filter((row) => !incomingNames.has(row.name));
    if (disappeared.length > 0) {
      throw new Error(
        `${disappeared.length} district(s) previously seeded for "${cityConfig.slug}" are missing ` +
          `from the regenerated grid-meta.json: ${disappeared.map((row) => row.name).join(', ')}. ` +
          'Renaming, merging or dropping a district requires a manual migration of fog_district_progress ' +
          'and bars.district_id, not an automatic reassignment, so seeding refuses to continue.',
      );
    }

    const insertDistrict = db.prepare(
      'INSERT INTO districts (city_id, name, playable_cells) VALUES (?, ?, ?)',
    );
    const updateDistrict = db.prepare('UPDATE districts SET playable_cells = ? WHERE id = ?');

    for (const district of gridMeta.districts) {
      const existing = existingByName.get(district.name);
      if (existing) {
        updateDistrict.run(district.playable_cells, existing.id);
      } else {
        insertDistrict.run(cityId, district.name, district.playable_cells);
      }
    }
  });

  run();
}
