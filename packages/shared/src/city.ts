// Per-city configuration (SPEC.md Section 11.4).
//
// `data/cities/<slug>.json` is the single seam the city data pipeline scripts
// and the `cities` row (Section 5.1) both read. This module only validates
// what it is handed — no file system access, so it stays safe to import from
// the browser bundle too. Loading the JSON file is the caller's job.
//
// `packages/shared` has no dependencies, so validation is hand-written rather
// than pulled in via a schema library (that would be a dependency decision,
// not this module's to make). The config is small and flat enough that
// explicit field-by-field checks stay readable.

export interface CityBoundingBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface CityOsmAdminFilter {
  /** The name= tag on the city's own boundary relation. */
  name: string;
  /** admin_level values the city's own boundary relation may carry. */
  city_admin_levels: number[];
  /** admin_level values district relations inside the city may carry. */
  district_admin_levels: number[];
  /** Optional prefix match against the de:regionalschluessel tag. */
  regional_key_prefix?: string;
}

export interface CityConfig {
  slug: string;
  name: string;
  bounding_box: CityBoundingBox;
  cell_size_m: number;
  geofabrik_region: string;
  tiles_filename: string;
  osm_admin_filter: CityOsmAdminFilter;
}

function fail(field: string, reason: string): never {
  throw new Error(`Invalid city config: "${field}" ${reason}`);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(field, 'must be a non-empty string');
  }
  return value as string;
}

function requireOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, field);
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(field, 'must be a finite number');
  }
  return value as number;
}

function requirePositiveInteger(value: unknown, field: string): number {
  const n = requireFiniteNumber(value, field);
  if (!Number.isInteger(n) || n <= 0) {
    fail(field, 'must be a positive integer');
  }
  return n;
}

function requireAdminLevelList(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(field, 'must be a non-empty array of admin levels');
  }
  return (value as unknown[]).map((entry, index) =>
    requirePositiveInteger(entry, `${field}[${index}]`),
  );
}

function parseBoundingBox(value: unknown, field: string): CityBoundingBox {
  if (typeof value !== 'object' || value === null) {
    fail(field, 'must be an object with south, west, north, east');
  }
  const box = value as Record<string, unknown>;
  const south = requireFiniteNumber(box.south, `${field}.south`);
  const west = requireFiniteNumber(box.west, `${field}.west`);
  const north = requireFiniteNumber(box.north, `${field}.north`);
  const east = requireFiniteNumber(box.east, `${field}.east`);

  if (north <= south) {
    fail(`${field}.north`, 'must be greater than south');
  }
  if (east <= west) {
    fail(`${field}.east`, 'must be greater than west');
  }

  return { south, west, north, east };
}

function parseOsmAdminFilter(value: unknown, field: string): CityOsmAdminFilter {
  if (typeof value !== 'object' || value === null) {
    fail(field, 'must be an object');
  }
  const filter = value as Record<string, unknown>;

  return {
    name: requireString(filter.name, `${field}.name`),
    city_admin_levels: requireAdminLevelList(
      filter.city_admin_levels,
      `${field}.city_admin_levels`,
    ),
    district_admin_levels: requireAdminLevelList(
      filter.district_admin_levels,
      `${field}.district_admin_levels`,
    ),
    regional_key_prefix: requireOptionalString(
      filter.regional_key_prefix,
      `${field}.regional_key_prefix`,
    ),
  };
}

/**
 * Validates parsed JSON against the city config shape and returns a typed,
 * validated `CityConfig`. Throws an `Error` naming the offending field on
 * the first problem found.
 */
export function parseCityConfig(data: unknown): CityConfig {
  if (typeof data !== 'object' || data === null) {
    fail('$', 'must be an object');
  }
  const config = data as Record<string, unknown>;

  return {
    slug: requireString(config.slug, 'slug'),
    name: requireString(config.name, 'name'),
    bounding_box: parseBoundingBox(config.bounding_box, 'bounding_box'),
    cell_size_m: requirePositiveInteger(config.cell_size_m, 'cell_size_m'),
    geofabrik_region: requireString(config.geofabrik_region, 'geofabrik_region'),
    tiles_filename: requireString(config.tiles_filename, 'tiles_filename'),
    osm_admin_filter: parseOsmAdminFilter(config.osm_admin_filter, 'osm_admin_filter'),
  };
}

/**
 * Resolves a city's seed directory from its slug, so scripts and the API
 * agree on `data/seed/<slug>/` instead of each building the path themselves.
 */
export function citySeedDir(slug: string): string {
  return `data/seed/${slug}`;
}
