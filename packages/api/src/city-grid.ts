import { NO_DISTRICT, toCell } from '@tipsytrails/shared';
import type { GridParams } from '@tipsytrails/shared';
import type Database from 'better-sqlite3';

// The active city's row and the grid projection derived from it (SPEC.md
// Sections 5.1, 5.2) — what every surface that turns a latitude/longitude
// into a cell and a district needs.
//
// Not in routes/, for the same reason http/errors.ts is not: badges.ts is
// not a route module and uses `loadActiveCity` too, so a home under routes/
// would invert the layering for it. Beside active-city.ts, which is the
// other thing here that knows what "the active city" means.

export interface CityRow {
  id: number;
  origin_lat: number;
  origin_lon: number;
  grid_width: number;
  grid_height: number;
  cell_size_m: number;
  playable_cells: number;
}

const CITY_COLUMNS = `id, origin_lat, origin_lon, grid_width, grid_height, cell_size_m, playable_cells`;

// v1 has exactly one active city (ACTIVE_CITY_SLUG, active-city.ts), so
// "the active city" is a single row and this is the one query that finds it.
// Callers that want only `id`/`playable_cells` (badges.ts,
// routes/leaderboard.ts, routes/profile.ts) read the two they want rather
// than running a narrower query of their own: the extra columns cost nothing
// on a one-row table, and a second copy of this SELECT is a thing that can
// come to disagree with this one about which city is active.
export function loadActiveCity(db: Database.Database): CityRow | null {
  return (
    db
      .prepare<[], CityRow>(`SELECT ${CITY_COLUMNS} FROM cities WHERE is_active = 1 LIMIT 1`)
      .get() ?? null
  );
}

// Used by routes/admin.ts's move-a-bar handler (SPEC.md Section 9.3) so it
// recomputes against the city a bar actually belongs to, rather than
// assuming that is the active one — the same CityRow shape loadActiveCity
// returns.
export function loadCityById(db: Database.Database, cityId: number): CityRow | null {
  return (
    db.prepare<[number], CityRow>(`SELECT ${CITY_COLUMNS} FROM cities WHERE id = ?`).get(cityId) ??
    null
  );
}

export function toGridParams(city: CityRow): GridParams {
  return {
    origin_lat: city.origin_lat,
    origin_lon: city.origin_lon,
    grid_width: city.grid_width,
    grid_height: city.grid_height,
    cell_size_m: city.cell_size_m,
  };
}

// The union itself is internal - every call site switches on `status` on the
// value the function hands back, and none of them writes the name down.
type CellDistrictResult =
  | { status: 'ok'; cellIndex: number; districtId: number | null }
  | { status: 'outside_city' }
  | { status: 'grid_unavailable' };

// One computation shared by the suggest handler (routes/bars.ts) and the
// create/move-bar handlers (routes/admin.ts), rather than three copies of
// it. POST /api/samples (routes/fog.ts) resolves a cell the same way
// (`toCell`) but does not call this: it runs per accepted sample in a batch
// and only needs the cell index there, resolving districts once in bulk
// afterwards over the revealed cells (routes/fog.ts's own `applyReveal`)
// rather than per sample. Order matters and is the order the original had:
// outside-city is checked before grid availability, since a position
// outside the grid never needs the district lookup at all.
export function resolveCellAndDistrict(
  grid: GridParams,
  districtGrid: Uint16Array | null,
  districtIdByGridIndex: Map<number, number> | null,
  lat: number,
  lon: number,
): CellDistrictResult {
  const cellIndex = toCell(lat, lon, grid);
  if (cellIndex === null) {
    return { status: 'outside_city' };
  }
  if (!districtGrid || !districtIdByGridIndex) {
    return { status: 'grid_unavailable' };
  }
  const districtIndex = districtGrid[cellIndex];
  const districtId =
    districtIndex !== NO_DISTRICT ? (districtIdByGridIndex.get(districtIndex) ?? null) : null;
  return { status: 'ok', cellIndex, districtId };
}
