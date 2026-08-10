import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

interface GridMetaDistrict {
  name: string;
  index: number;
}

interface DistrictRow {
  id: number;
  name: string;
}

/**
 * Maps `grid.bin`'s per-cell district *index* (0-based, matching
 * `grid-meta.json`'s `districts[].index` — SPEC.md Section 5.2) to the
 * `districts` table's database id.
 *
 * The two are seeded from the same `grid-meta.json` (`db/seed-city.ts`), but
 * a district row's id is assigned by SQLite on insert, not by the grid
 * index, so nothing else ties them together — this joins them by name, the
 * only key both sides share. Returns null if `grid-meta.json` is absent,
 * the same "this feature's data, not the whole site's" absence handling
 * `app.ts` already applies to `grid.bin` itself.
 */
export function loadDistrictIdByGridIndex(
  db: Database.Database,
  seedDir: string,
  citySlug: string,
): Map<number, number> | null {
  const metaPath = join(seedDir, citySlug, 'grid-meta.json');
  if (!existsSync(metaPath)) {
    return null;
  }

  const raw = JSON.parse(readFileSync(metaPath, 'utf-8')) as { districts: GridMetaDistrict[] };

  const rows = db
    .prepare<[string], DistrictRow>(
      `SELECT districts.id, districts.name
       FROM districts
       JOIN cities ON cities.id = districts.city_id
       WHERE cities.slug = ?`,
    )
    .all(citySlug);
  const idByName = new Map(rows.map((row) => [row.name, row.id]));

  const map = new Map<number, number>();
  for (const district of raw.districts) {
    const id = idByName.get(district.name);
    if (id != null) {
      map.set(district.index, id);
    }
  }
  return map;
}
