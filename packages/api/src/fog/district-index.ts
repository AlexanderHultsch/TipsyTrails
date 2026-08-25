import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { loadGridMeta } from '../db/seed-city.js';

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
 *
 * A file that is *present but wrong* is a different case from an absent one
 * and is not degraded to null: it throws, through `loadGridMeta`'s message
 * naming the path and the offending field. Silently mapping nothing would
 * put every seeded bar and every revealed cell in no district at all, which
 * looks exactly like a city with no districts — the failure this refuses to
 * make quiet.
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

  const meta = loadGridMeta(seedDir, citySlug);

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
  for (const district of meta.districts) {
    const id = idByName.get(district.name);
    if (id != null) {
      map.set(district.index, id);
    }
  }
  return map;
}
