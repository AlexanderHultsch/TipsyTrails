// OSM bar import: Overpass query construction and OSM/GeoJSON → bar record
// conversion (SPEC.md Section 11.1, `scripts/import-osm-bars.ts`).
//
// This module is pure and side-effect free — no network, no file system —
// so the query builder, the conversion and the diff logic can be
// unit-tested without touching Overpass, and `scripts/import-osm-bars.ts`
// stays a thin CLI wrapper (arg parsing, the actual HTTP call, atomic
// writes, the diff report) around it, the same split `overpass.ts` and
// `fetch-boundaries.ts` already establish.
//
// This is a separate module from `overpass.ts` rather than an extension of
// it: bars are points (nodes, or ways/relations reduced to a centroid via
// `out center`), not the administrative-boundary polygons `overpass.ts`
// assembles, so the response shapes and the GeoJSON conversion rules
// genuinely differ (every bar GeoJSON feature is a Point; `overpass.ts`'s
// GeoJSON conversion deliberately drops Point features, since those are
// admin_centre/label nodes for its Polygon/MultiPolygon boundaries).
//
// This module has no relative *value* imports from `city.ts`, `grid.ts` or
// `overpass.ts` — only type-only ones, which TypeScript erases completely.
// `scripts/import-osm-bars.ts` (like its siblings) imports this file by its
// literal `.ts` path and runs it as source with Node's native type
// stripping, no build step. That only resolves a relative NodeNext ".js"
// specifier (CLAUDE.md's required convention for `packages/shared`) back to
// its co-located ".ts" file when the import is type-only and erased before
// Node ever attempts to load it; a genuine *value* import written the same
// way has no ".js" file to resolve to on this unbuilt path. `grid.ts`
// already hit this shape of problem and reimplements rather than imports
// (its point-in-polygon test, "so this module has no dependency on the
// Overpass pipeline"); the query-string helpers, the Section 6.1
// projection and the Overpass timeout default below follow the same
// precedent. `bars.test.ts` cross-checks the projection copy against
// `grid.ts`'s own `toCell` for the same coordinates, so the two cannot
// silently drift apart.

import type { CityConfig } from './city.js';
import type { GridParams } from './grid.js';

/** Mirrors `overpass.ts`'s constant of the same name and value — see the note above. */
export const DEFAULT_OVERPASS_TIMEOUT_S = 180;

// ---------------------------------------------------------------------------
// Section 6.1 projection, verbatim (see the module note above for why this
// is a reimplementation rather than an import of grid.ts's toCell).
// ---------------------------------------------------------------------------

const M_PER_DEG_LAT = 110574;

function mPerDegLon(lat: number): number {
  return 111320 * Math.cos((lat * Math.PI) / 180);
}

function toCell(lat: number, lon: number, grid: GridParams): number | null {
  const x = Math.floor(((lon - grid.origin_lon) * mPerDegLon(grid.origin_lat)) / grid.cell_size_m);
  const y = Math.floor(((lat - grid.origin_lat) * M_PER_DEG_LAT) / grid.cell_size_m);
  if (x < 0 || y < 0 || x >= grid.grid_width || y >= grid.grid_height) return null;
  return y * grid.grid_width + x;
}

/** Grid dimensions from a bounding box, matching `grid.ts`'s `computeGridDimensions`. */
function computeGridDimensions(
  box: CityConfig['bounding_box'],
  cellSizeM: number,
): { grid_width: number; grid_height: number } {
  return {
    grid_width: Math.ceil(((box.east - box.west) * mPerDegLon(box.south)) / cellSizeM),
    grid_height: Math.ceil(((box.north - box.south) * M_PER_DEG_LAT) / cellSizeM),
  };
}

// ---------------------------------------------------------------------------
// Query construction — pure function of the city config, mirroring
// `buildCityAndDistrictsQuery` in `overpass.ts`: match the city relation,
// turn it into an area, then find drinking establishments inside it.
//
// The amenity list lives here, in the script's own module, rather than in
// the per-city config: SPEC.md Section 11.1 states it normatively for the
// product ("amenity in bar, pub, biergarten, nightclub"), the same way for
// every city, unlike `osm_admin_filter` or `bounding_box`, which are
// genuinely per-city facts. Section 11.4's config field table lists what
// each script reads from the config; the amenity list is not among them.
// The `bar=yes` criterion added to `buildBarsQuery` below is the same kind
// of normative, city-independent fact and lives the same way — inline in
// the query builder, not in `config.ts` or the per-city config.
// ---------------------------------------------------------------------------

export const BAR_AMENITY_VALUES = ['bar', 'pub', 'biergarten', 'nightclub'] as const;

function escapeOverpassString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function adminLevelRegex(levels: number[]): string {
  return `^(${levels.join('|')})$`;
}

function regionalKeyClause(prefix: string | undefined): string {
  return prefix ? `["de:regionalschluessel"~"^${escapeOverpassString(prefix)}"]` : '';
}

/**
 * Nodes, ways and relations tagged `amenity` in `BAR_AMENITY_VALUES`, OR
 * carrying `bar=yes` regardless of their `amenity` value, inside the city
 * boundary (SPEC.md Section 11.1). The `bar=yes` clause exists because OSM's
 * "one main tag" convention files a venue's primary business under
 * `amenity` — a restaurant that also runs a bar stays `amenity=restaurant`
 * — and puts the bar-ness as the secondary tag `bar=yes`; the amenity-only
 * clause above never sees those. Both clauses live in the same
 * `area.cityArea`-scoped union, so an element matching both (e.g. a
 * redundant `bar=yes` on an `amenity=bar` node) is not double-counted —
 * Overpass QL's union statement is true set semantics: it writes into its
 * result set "all objects that it has seen in one of the partial results",
 * not a concatenation of them, so the same (type, id) surviving more than
 * one branch of the union still appears once in `out`'s output. See the
 * module note above and the `buildBarsQuery` tests for the corresponding
 * regression guard.
 *
 * `out center` so ways and relations come back with a centroid — simpler
 * and more accurate than assembling rings to average one by hand, and
 * Section 11.1 only requires they end up reduced to a centroid, not how.
 */
export function buildBarsQuery(
  config: CityConfig,
  timeoutS: number = DEFAULT_OVERPASS_TIMEOUT_S,
): string {
  const filter = config.osm_admin_filter;
  const cityLevels = adminLevelRegex(filter.city_admin_levels);
  const name = escapeOverpassString(filter.name);
  const regionalKey = regionalKeyClause(filter.regional_key_prefix);
  const amenity = `^(${BAR_AMENITY_VALUES.join('|')})$`;

  return [
    `[out:json][timeout:${timeoutS}];`,
    `rel["boundary"="administrative"]["admin_level"~"${cityLevels}"]["name"="${name}"]${regionalKey}->.city;`,
    `.city map_to_area->.cityArea;`,
    `(`,
    `  node["amenity"~"${amenity}"](area.cityArea);`,
    `  way["amenity"~"${amenity}"](area.cityArea);`,
    `  relation["amenity"~"${amenity}"](area.cityArea);`,
    `  node["bar"="yes"](area.cityArea);`,
    `  way["bar"="yes"](area.cityArea);`,
    `  relation["bar"="yes"](area.cityArea);`,
    `);`,
    `out center;`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Minimal Overpass `out center` response types — only what this module
// reads. Distinct from `overpass.ts`'s `OverpassElement`, which only ever
// carries a bare `{ type, id }` for nodes and ways because that pipeline
// only needs way/relation geometry, never node coordinates or tags.
// ---------------------------------------------------------------------------

export interface OverpassBarNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

export interface OverpassBarWayOrRelation {
  type: 'way' | 'relation';
  id: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export type OverpassBarElement = OverpassBarNode | OverpassBarWayOrRelation;

export interface OverpassBarsResponse {
  elements: OverpassBarElement[];
}

export class OverpassBarsResponseError extends Error {}

// ---------------------------------------------------------------------------
// GeoJSON input — the shape overpass-turbo's "export as GeoJSON" produces
// for an `out center` query: every feature (node, or way/relation reduced
// to its centroid) is a Point. Detected by payload shape and converted to
// an `OverpassBarsResponse` right here, at parse time, so the rest of this
// module (name-discard, centroid handling, `cell_index`) runs identically
// for either input format.
// ---------------------------------------------------------------------------

interface RawGeoJsonPointFeature {
  type: 'Feature';
  id?: string | number;
  properties?: Record<string, unknown> | null;
  geometry?: { type: string; coordinates: unknown } | null;
}

interface RawGeoJsonFeatureCollection {
  type: 'FeatureCollection';
  features: RawGeoJsonPointFeature[];
}

function isGeoJsonFeatureCollection(value: unknown): value is RawGeoJsonFeatureCollection {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'FeatureCollection' &&
    Array.isArray((value as { features?: unknown }).features)
  );
}

/** Extracts the OSM type and id from a GeoJSON feature's `id` (e.g. "way/62518"). */
function osmTypeAndIdFromGeoJsonFeature(feature: RawGeoJsonPointFeature): {
  type: 'node' | 'way' | 'relation';
  id: number;
} {
  const id = feature.id;
  const asString = typeof id === 'number' ? String(id) : id;
  const match =
    typeof asString === 'string' ? asString.match(/^(node|way|relation)\/(\d+)$/) : null;
  if (!match) {
    const name = feature.properties?.name;
    throw new OverpassBarsResponseError(
      `GeoJSON feature${typeof name === 'string' ? ` "${name}"` : ''} has no usable "id" field ` +
        `(expected "node/<id>", "way/<id>" or "relation/<id>") to derive an OSM element from.`,
    );
  }
  return { type: match[1] as 'node' | 'way' | 'relation', id: Number(match[2]) };
}

function tagsFromGeoJsonProperties(
  properties: Record<string, unknown> | null | undefined,
): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(properties ?? {})) {
    if (typeof value === 'string') tags[key] = value;
  }
  return tags;
}

function geoJsonToBarsResponse(collection: RawGeoJsonFeatureCollection): OverpassBarsResponse {
  const elements: OverpassBarElement[] = [];
  for (const feature of collection.features) {
    const geometry = feature.geometry;
    if (!geometry || geometry.type !== 'Point') continue;

    const [lon, lat] = geometry.coordinates as [number, number];
    const { type, id } = osmTypeAndIdFromGeoJsonFeature(feature);
    const tags = tagsFromGeoJsonProperties(feature.properties);

    if (type === 'node') {
      elements.push({ type, id, lat, lon, tags });
    } else {
      elements.push({ type, id, center: { lat, lon }, tags });
    }
  }
  return { elements };
}

// ---------------------------------------------------------------------------
// Response validation — "fail loudly" (SPEC.md 11.4), mirroring
// `parseOverpassPayload` in `overpass.ts`.
// ---------------------------------------------------------------------------

export function parseBarsPayload(
  raw: string,
  contentType: string | undefined,
): OverpassBarsResponse {
  const looksLikeHtml =
    /^\s*(<!doctype html|<html)/i.test(raw) || Boolean(contentType?.includes('text/html'));
  if (looksLikeHtml) {
    throw new OverpassBarsResponseError(
      `Expected a JSON response from Overpass but received HTML ` +
        `(content-type: ${contentType ?? 'unknown'}). This usually means Overpass is overloaded ` +
        `or rate-limiting; first 200 characters of the body: ${raw.slice(0, 200)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new OverpassBarsResponseError(
      `Expected a JSON response from Overpass but the body did not parse as JSON: ` +
        `${err instanceof Error ? err.message : String(err)}. First 200 characters: ${raw.slice(0, 200)}`,
    );
  }

  if (isGeoJsonFeatureCollection(parsed)) {
    if (parsed.features.length === 0) {
      throw new OverpassBarsResponseError(
        `Expected a GeoJSON FeatureCollection with at least one feature, got zero. This usually ` +
          `means the overpass-turbo export was run against the wrong query.`,
      );
    }
    return geoJsonToBarsResponse(parsed);
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as { elements?: unknown }).elements)
  ) {
    throw new OverpassBarsResponseError(
      `Expected an Overpass response with an "elements" array, or a GeoJSON FeatureCollection, ` +
        `got: ${raw.slice(0, 200)}`,
    );
  }

  const response = parsed as OverpassBarsResponse;
  if (response.elements.length === 0) {
    throw new OverpassBarsResponseError(
      `Overpass returned zero elements. Expected at least one drinking establishment; this usually ` +
        `means the osm_admin_filter in the city config does not match anything, or there really are ` +
        `none in the query area.`,
    );
  }

  return response;
}

// ---------------------------------------------------------------------------
// OSM element → bar record conversion (SPEC.md Section 11.1, 5.6).
// ---------------------------------------------------------------------------

/** What Section 5.6's `bars` table needs at import time. `source` is always 'osm' here. */
export interface Bar {
  osm_id: string;
  name: string;
  address: string | null;
  lat: number;
  lon: number;
  cell_index: number;
  source: 'osm';
}

export interface OsmToBarsResult {
  bars: Bar[];
  discardedNoName: number;
  wayOrRelationCount: number;
}

/**
 * The grid a bar's coordinates are projected against, derived from the city
 * config the same way `scripts/build-grid.ts` derives it: the bounding
 * box's SW corner as origin, dimensions from `computeGridDimensions`. There
 * is no separate `grid_width`/`grid_height`/`origin_lat`/`origin_lon` source
 * at import time — `data/cities/<slug>.json` is the only one.
 */
export function gridParamsFromCityConfig(config: CityConfig): GridParams {
  const { grid_width, grid_height } = computeGridDimensions(
    config.bounding_box,
    config.cell_size_m,
  );
  return {
    origin_lat: config.bounding_box.south,
    origin_lon: config.bounding_box.west,
    grid_width,
    grid_height,
    cell_size_m: config.cell_size_m,
  };
}

function addressFromTags(tags: Record<string, string> | undefined): string | null {
  if (!tags) return null;
  const street = tags['addr:street'];
  const housenumber = tags['addr:housenumber'];
  const postcode = tags['addr:postcode'];
  const city = tags['addr:city'];

  const streetLine = [street, housenumber].filter(Boolean).join(' ');
  const cityLine = [postcode, city].filter(Boolean).join(' ');
  const address = [streetLine, cityLine].filter((part) => part.length > 0).join(', ');
  return address.length > 0 ? address : null;
}

/**
 * Converts Overpass `out center` elements into bar records. Entries without
 * a `name` tag are discarded and counted (SPEC.md Section 11.1) — not
 * thrown on, since this is expected and common for OSM drinking
 * establishments, unlike a bar with no usable position, which fails loudly
 * (a coordinate outside the configured grid means the city config or the
 * query area is wrong, not that the bar should be silently dropped).
 */
export function osmElementsToBars(
  response: OverpassBarsResponse,
  config: CityConfig,
): OsmToBarsResult {
  const grid = gridParamsFromCityConfig(config);
  const bars: Bar[] = [];
  let discardedNoName = 0;
  let wayOrRelationCount = 0;

  for (const el of response.elements) {
    const name = el.tags?.name;
    if (!name) {
      discardedNoName++;
      continue;
    }

    let lat: number;
    let lon: number;
    if (el.type === 'node') {
      lat = el.lat;
      lon = el.lon;
    } else {
      if (!el.center) {
        throw new Error(
          `OSM ${el.type} ${el.id} ("${name}") has no "center" — expected every way/relation result ` +
            `to carry one from "out center". The Overpass response may be malformed.`,
        );
      }
      lat = el.center.lat;
      lon = el.center.lon;
      wayOrRelationCount++;
    }

    const cellIndex = toCell(lat, lon, grid);
    if (cellIndex === null) {
      throw new Error(
        `OSM ${el.type} ${el.id} ("${name}") at (${lat}, ${lon}) falls outside the grid configured ` +
          `for "${config.name}" (bounding box ${JSON.stringify(config.bounding_box)}). This usually ` +
          `means the city config's bounding_box is wrong, or Overpass returned an element outside ` +
          `the queried area.`,
      );
    }

    bars.push({
      osm_id: `${el.type}/${el.id}`,
      name,
      address: addressFromTags(el.tags),
      lat,
      lon,
      cell_index: cellIndex,
      source: 'osm',
    });
  }

  return { bars, discardedNoName, wayOrRelationCount };
}

// ---------------------------------------------------------------------------
// Diff between two sets of bars (SPEC.md Section 11.2) — re-running the
// import must report what changed to stdout, never apply it anywhere but
// the seed file.
// ---------------------------------------------------------------------------

export interface ChangedBar {
  osm_id: string;
  before: Bar;
  after: Bar;
  changedFields: string[];
}

export interface BarDiff {
  added: Bar[];
  removed: Bar[];
  changed: ChangedBar[];
}

/** Compares two bar sets by `osm_id`, reporting additions, removals and field changes. */
export function diffBars(previous: Bar[], next: Bar[]): BarDiff {
  const previousById = new Map(previous.map((b) => [b.osm_id, b]));
  const nextById = new Map(next.map((b) => [b.osm_id, b]));

  const added = next.filter((b) => !previousById.has(b.osm_id));
  const removed = previous.filter((b) => !nextById.has(b.osm_id));

  const changed: ChangedBar[] = [];
  for (const [osmId, before] of previousById) {
    const after = nextById.get(osmId);
    if (!after) continue;

    const changedFields: string[] = [];
    if (before.name !== after.name) changedFields.push('name');
    if (before.address !== after.address) changedFields.push('address');
    if (before.lat !== after.lat || before.lon !== after.lon) changedFields.push('position');

    if (changedFields.length > 0) {
      changed.push({ osm_id: osmId, before, after, changedFields });
    }
  }

  return { added, removed, changed };
}
