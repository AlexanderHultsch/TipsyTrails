// Overpass query construction and OSM→GeoJSON conversion for the city
// boundary pipeline (SPEC.md Section 11.4, `scripts/fetch-boundaries.ts`).
//
// This module is pure and side-effect free — no network, no file system —
// so the query builders and the geometry conversion can be unit-tested
// without touching Overpass, and `scripts/fetch-boundaries.ts` stays a thin
// CLI wrapper (arg parsing, the actual HTTP call, atomic writes) around it.
//
// `packages/shared` has no runtime dependencies (see city.ts), so the small
// slice of GeoJSON and Overpass JSON shapes used here are hand-written types
// rather than pulled in from a library.

import type { CityConfig } from './city.js';

export const DEFAULT_OVERPASS_TIMEOUT_S = 180;

// ---------------------------------------------------------------------------
// Minimal GeoJSON types (RFC 7946) — only what this pipeline produces.
// ---------------------------------------------------------------------------

export type GeoJsonPosition = [number, number];

export interface GeoJsonPolygon {
  type: 'Polygon';
  coordinates: GeoJsonPosition[][];
}

export interface GeoJsonMultiPolygon {
  type: 'MultiPolygon';
  coordinates: GeoJsonPosition[][][];
}

export interface GeoJsonFeature {
  type: 'Feature';
  properties: Record<string, unknown>;
  geometry: GeoJsonPolygon | GeoJsonMultiPolygon;
}

export interface GeoJsonFeatureCollection {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
}

export function toFeatureCollection(features: GeoJsonFeature[]): GeoJsonFeatureCollection {
  return { type: 'FeatureCollection', features };
}

// ---------------------------------------------------------------------------
// Minimal Overpass `out geom` response types.
// ---------------------------------------------------------------------------

export interface OverpassLatLon {
  lat: number;
  lon: number;
}

export interface OverpassWayMember {
  type: 'way';
  ref: number;
  role: string;
  geometry?: OverpassLatLon[];
}

export interface OverpassRelation {
  type: 'relation';
  id: number;
  tags?: Record<string, string>;
  members: OverpassWayMember[];
  /**
   * Present only when this relation was derived from a GeoJSON input
   * (see below) — the geometry overpass-turbo already computed, carried
   * through as-is. When set, relationToGeometry returns it directly instead
   * of chaining `members` into rings.
   */
  geometry?: GeoJsonPolygon | GeoJsonMultiPolygon;
}

export type OverpassElement = OverpassRelation | { type: 'node' | 'way'; id: number };

export interface OverpassResponse {
  version?: number;
  generator?: string;
  elements: OverpassElement[];
}

export class OverpassResponseError extends Error {}

// ---------------------------------------------------------------------------
// GeoJSON input — an alternative shape for --input-city / --input-neighbours
// (SPEC.md 11.4). A human exporting boundaries from overpass-turbo naturally
// produces a GeoJSON FeatureCollection, not the raw Overpass "out geom" JSON
// this pipeline otherwise expects. Detected by payload shape and converted
// to an OverpassResponse right here, at parse time, so every downstream step
// — the city/district/neighbour lookups, the filtering rules, and
// relationToFeature — runs identically for either input format. There is no
// separate, forked pipeline for GeoJSON input.
// ---------------------------------------------------------------------------

interface RawGeoJsonFeature {
  type: 'Feature';
  id?: string | number;
  properties?: Record<string, unknown> | null;
  geometry?: { type: string; coordinates: unknown } | null;
}

interface RawGeoJsonFeatureCollection {
  type: 'FeatureCollection';
  features: RawGeoJsonFeature[];
}

function isGeoJsonFeatureCollection(value: unknown): value is RawGeoJsonFeatureCollection {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'FeatureCollection' &&
    Array.isArray((value as { features?: unknown }).features)
  );
}

/** Extracts the numeric OSM id from a GeoJSON feature's `id` (e.g. "relation/62518"). */
function osmIdFromGeoJsonFeature(feature: RawGeoJsonFeature): number {
  const id = feature.id;
  if (typeof id === 'number') return id;
  const match = typeof id === 'string' ? id.match(/(\d+)$/) : null;
  if (!match) {
    const name = feature.properties?.name;
    throw new OverpassResponseError(
      `GeoJSON feature${typeof name === 'string' ? ` "${name}"` : ''} has no usable "id" field ` +
        `to derive an OSM id from.`,
    );
  }
  return Number(match[1]);
}

function geoJsonPolygonGeometry(
  geometry: RawGeoJsonFeature['geometry'],
): GeoJsonPolygon | GeoJsonMultiPolygon | undefined {
  if (geometry && (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon')) {
    return geometry as GeoJsonPolygon | GeoJsonMultiPolygon;
  }
  return undefined;
}

/**
 * Converts a GeoJSON FeatureCollection into an OverpassResponse. Drops every
 * non-polygon feature — the overpass-turbo export contains Point features
 * (OSM admin_centre/label nodes), which are not boundaries and carry no
 * usable geometry. Tags come straight from `properties` (already the OSM
 * tags, exactly as overpass-turbo exports them); the geometry is carried
 * through as-is.
 */
function geoJsonToOverpassResponse(collection: RawGeoJsonFeatureCollection): OverpassResponse {
  const elements: OverpassRelation[] = [];
  for (const feature of collection.features) {
    const geometry = geoJsonPolygonGeometry(feature.geometry);
    if (!geometry) continue;

    const tags: Record<string, string> = {};
    for (const [key, value] of Object.entries(feature.properties ?? {})) {
      if (typeof value === 'string') tags[key] = value;
    }

    elements.push({
      type: 'relation',
      id: osmIdFromGeoJsonFeature(feature),
      tags,
      members: [],
      geometry,
    });
  }
  return { elements };
}

// ---------------------------------------------------------------------------
// Query construction — pure functions of the city config, per SPEC.md 11.4:
// "The Overpass query is built from the config, never hard-coded."
// ---------------------------------------------------------------------------

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
 * The city relation itself plus every district relation inside it, in one
 * request. Mirrors the query worked out by hand in HANDOVER.md Section 4.1:
 * match `.city` first, turn it into an area, then find district-level
 * relations inside that area. The city relation is included because the
 * city overview (Section 8.3) needs its outline too.
 */
export function buildCityAndDistrictsQuery(
  config: CityConfig,
  timeoutS: number = DEFAULT_OVERPASS_TIMEOUT_S,
): string {
  const filter = config.osm_admin_filter;
  const cityLevels = adminLevelRegex(filter.city_admin_levels);
  const districtLevels = adminLevelRegex(filter.district_admin_levels);
  const name = escapeOverpassString(filter.name);
  const regionalKey = regionalKeyClause(filter.regional_key_prefix);

  return [
    `[out:json][timeout:${timeoutS}];`,
    `rel["boundary"="administrative"]["admin_level"~"${cityLevels}"]["name"="${name}"]${regionalKey}->.city;`,
    `.city map_to_area->.cityArea;`,
    `(`,
    `  .city;`,
    `  rel(area.cityArea)["boundary"="administrative"]["admin_level"~"${districtLevels}"];`,
    `);`,
    `out geom;`,
  ].join('\n');
}

/**
 * Neighbouring municipalities for the greyed-out context Section 8.3 asks
 * for: administrative boundaries at the city's own admin level, inside the
 * configured bounding box, with the city itself subtracted back out.
 *
 * The city is re-derived by the same name/admin-level/regional-key filter
 * used in `buildCityAndDistrictsQuery` rather than by a numeric OSM id
 * supplied at call time, so this stays a pure function of the config alone
 * and can be reviewed with `--dry-run` before any network call has told us
 * what that id even is.
 */
export function buildNeighboursQuery(
  config: CityConfig,
  timeoutS: number = DEFAULT_OVERPASS_TIMEOUT_S,
): string {
  const filter = config.osm_admin_filter;
  const box = config.bounding_box;
  const cityLevels = adminLevelRegex(filter.city_admin_levels);
  const name = escapeOverpassString(filter.name);
  const regionalKey = regionalKeyClause(filter.regional_key_prefix);
  const bbox = `(${box.south},${box.west},${box.north},${box.east})`;

  return [
    `[out:json][timeout:${timeoutS}];`,
    `rel["boundary"="administrative"]["admin_level"~"${cityLevels}"]["name"="${name}"]${regionalKey}->.city;`,
    `(`,
    `  rel["boundary"="administrative"]["admin_level"~"${cityLevels}"]${bbox};`,
    `  - .city;`,
    `);`,
    `out geom;`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Response validation — "fail loudly" (SPEC.md 11.4).
// ---------------------------------------------------------------------------

/**
 * Validates a raw Overpass HTTP response body before anything downstream
 * touches it. Overpass answers 200 with an HTML error page when overloaded,
 * so this checks the content type *and* the shape of the payload, not just
 * whether `JSON.parse` happens to succeed.
 */
export function parseOverpassPayload(
  raw: string,
  contentType: string | undefined,
): OverpassResponse {
  const looksLikeHtml =
    /^\s*(<!doctype html|<html)/i.test(raw) || Boolean(contentType?.includes('text/html'));
  if (looksLikeHtml) {
    throw new OverpassResponseError(
      `Expected a JSON response from Overpass but received HTML ` +
        `(content-type: ${contentType ?? 'unknown'}). This usually means Overpass is overloaded ` +
        `or rate-limiting; first 200 characters of the body: ${raw.slice(0, 200)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new OverpassResponseError(
      `Expected a JSON response from Overpass but the body did not parse as JSON: ` +
        `${err instanceof Error ? err.message : String(err)}. First 200 characters: ${raw.slice(0, 200)}`,
    );
  }

  if (isGeoJsonFeatureCollection(parsed)) {
    if (parsed.features.length === 0) {
      throw new OverpassResponseError(
        `Expected a GeoJSON FeatureCollection with at least one feature, got zero. This usually ` +
          `means the overpass-turbo export was run against the wrong query.`,
      );
    }
    return geoJsonToOverpassResponse(parsed);
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as { elements?: unknown }).elements)
  ) {
    throw new OverpassResponseError(
      `Expected an Overpass response with an "elements" array, or a GeoJSON FeatureCollection, ` +
        `got: ${raw.slice(0, 200)}`,
    );
  }

  const response = parsed as OverpassResponse;
  if (response.elements.length === 0) {
    throw new OverpassResponseError(
      `Overpass returned zero elements. Expected at least the city relation; ` +
        `this usually means the osm_admin_filter in the city config does not match anything.`,
    );
  }

  return response;
}

function isAdministrativeRelation(el: OverpassElement): el is OverpassRelation {
  return el.type === 'relation' && (el as OverpassRelation).tags?.boundary === 'administrative';
}

/**
 * The single relation matching the city's own name and admin level. Throws
 * a descriptive error if none, or more than one, is found — an empty or
 * ambiguous match must never fall through to an empty or wrong city.geojson.
 */
export function findCityRelation(response: OverpassResponse, config: CityConfig): OverpassRelation {
  const cityLevels = new Set(config.osm_admin_filter.city_admin_levels.map(String));
  const candidates = response.elements.filter(
    (el): el is OverpassRelation =>
      isAdministrativeRelation(el) &&
      el.tags?.name === config.osm_admin_filter.name &&
      cityLevels.has(el.tags?.admin_level ?? ''),
  );

  if (candidates.length === 0) {
    throw new OverpassResponseError(
      `Expected exactly one city relation named "${config.osm_admin_filter.name}" with admin_level in ` +
        `[${config.osm_admin_filter.city_admin_levels.join(', ')}], but found none among ` +
        `${response.elements.length} element(s). Check osm_admin_filter in the city config.`,
    );
  }
  if (candidates.length > 1) {
    throw new OverpassResponseError(
      `Expected exactly one city relation named "${config.osm_admin_filter.name}", but found ` +
        `${candidates.length}: OSM id(s) ${candidates.map((c) => c.id).join(', ')}. Narrow ` +
        `osm_admin_filter (e.g. regional_key_prefix) to disambiguate.`,
    );
  }
  return candidates[0];
}

/** District relations inside the city, keyed by district_admin_levels and excluding the city itself. */
export function findDistrictRelations(
  response: OverpassResponse,
  config: CityConfig,
  cityId: number,
): OverpassRelation[] {
  const districtLevels = new Set(config.osm_admin_filter.district_admin_levels.map(String));
  return response.elements.filter(
    (el): el is OverpassRelation =>
      isAdministrativeRelation(el) &&
      el.id !== cityId &&
      districtLevels.has(el.tags?.admin_level ?? ''),
  );
}

/** Every administrative relation in the response other than the city itself. */
export function findNeighbourRelations(
  response: OverpassResponse,
  cityId: number,
): OverpassRelation[] {
  return response.elements.filter(
    (el): el is OverpassRelation => isAdministrativeRelation(el) && el.id !== cityId,
  );
}

// ---------------------------------------------------------------------------
// OSM multipolygon → GeoJSON conversion.
//
// This is the "genuinely fiddly" part flagged in the task. What follows is
// deliberately the straightforward case, not a general-purpose OSM
// multipolygon assembler:
//
//  - Way endpoints are compared for exact equality (same decimal-degree
//    pair), which holds because adjacent ways in an OSM boundary relation
//    share the same node. No tolerance-based matching, no gap-filling or
//    repair of dangling ends — a relation whose outer ways cannot be fully
//    chained end-to-end throws rather than silently emitting a wrong shape.
//  - Inner (hole) rings are assigned to the single outer ring when there is
//    exactly one, which covers ordinary city/district/neighbour polygons.
//    For a relation with genuinely disjoint outer rings (a true exclave),
//    each hole is assigned to the first outer ring whose boundary contains
//    the hole's first point, via a plain ray-casting point-in-polygon test.
//    A hole matching no outer ring is dropped. Nested multipolygons
//    (an island inside a lake inside the city, etc.) are not handled.
//  - Winding order is normalised (outer rings counter-clockwise, holes
//    clockwise) via the shoelace formula, per the GeoJSON right-hand rule.
// ---------------------------------------------------------------------------

function samePoint(a: GeoJsonPosition, b: GeoJsonPosition): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function wayGeometryToLine(geometry: OverpassLatLon[]): GeoJsonPosition[] {
  return geometry.map((pt): GeoJsonPosition => [pt.lon, pt.lat]);
}

function isRingClosed(ring: GeoJsonPosition[]): boolean {
  return ring.length > 0 && samePoint(ring[0], ring[ring.length - 1]);
}

function closeRing(ring: GeoJsonPosition[]): GeoJsonPosition[] {
  return isRingClosed(ring) ? ring : [...ring, ring[0]];
}

/**
 * Chains way segments sharing endpoints into one or more closed rings.
 * Segments already closed on their own (a single way that is itself a
 * complete boundary) come back unchanged.
 */
function assembleRings(segments: GeoJsonPosition[][]): GeoJsonPosition[][] {
  const remaining = segments.map((s) => [...s]);
  const rings: GeoJsonPosition[][] = [];

  while (remaining.length > 0) {
    let chain = remaining.shift()!;
    let extended = true;
    while (!isRingClosed(chain) && extended) {
      extended = false;
      for (let i = 0; i < remaining.length; i++) {
        const seg = remaining[i];
        const chainEnd = chain[chain.length - 1];
        if (samePoint(chainEnd, seg[0])) {
          chain = chain.concat(seg.slice(1));
          remaining.splice(i, 1);
          extended = true;
          break;
        }
        if (samePoint(chainEnd, seg[seg.length - 1])) {
          chain = chain.concat([...seg].reverse().slice(1));
          remaining.splice(i, 1);
          extended = true;
          break;
        }
      }
    }
    if (!isRingClosed(chain)) {
      throw new Error(
        `Could not chain way segments into a closed ring (dangling end at ` +
          `[${chain[chain.length - 1].join(', ')}]). The relation's outer/inner ways may be incomplete.`,
      );
    }
    rings.push(chain);
  }
  return rings;
}

function signedArea(ring: GeoJsonPosition[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

function withWinding(ring: GeoJsonPosition[], clockwise: boolean): GeoJsonPosition[] {
  const isClockwise = signedArea(ring) < 0;
  return isClockwise === clockwise ? ring : [...ring].reverse();
}

function pointInRing(point: GeoJsonPosition, ring: GeoJsonPosition[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses = yi > point[1] !== yj > point[1];
    if (crosses && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function relationToGeometry(
  relation: OverpassRelation,
): GeoJsonPolygon | GeoJsonMultiPolygon {
  if (relation.geometry) {
    return relation.geometry;
  }

  const outerSegments = relation.members
    .filter((m) => m.role === 'outer' && m.geometry && m.geometry.length >= 2)
    .map((m) => wayGeometryToLine(m.geometry!));
  const innerSegments = relation.members
    .filter((m) => m.role === 'inner' && m.geometry && m.geometry.length >= 2)
    .map((m) => wayGeometryToLine(m.geometry!));

  if (outerSegments.length === 0) {
    throw new Error(
      `Relation ${relation.id} has no "outer" way members with geometry; cannot build a polygon.`,
    );
  }

  const outerRings = assembleRings(outerSegments).map((r) => closeRing(withWinding(r, false)));
  const innerRings = assembleRings(innerSegments).map((r) => closeRing(withWinding(r, true)));

  if (outerRings.length === 1) {
    return { type: 'Polygon', coordinates: [outerRings[0], ...innerRings] };
  }

  const polygons: GeoJsonPosition[][][] = outerRings.map((r) => [r]);
  for (const hole of innerRings) {
    const idx = outerRings.findIndex((r) => pointInRing(hole[0], r));
    if (idx >= 0) polygons[idx].push(hole);
  }
  return { type: 'MultiPolygon', coordinates: polygons };
}

export function relationToFeature(relation: OverpassRelation): GeoJsonFeature {
  return {
    type: 'Feature',
    properties: {
      osm_id: relation.id,
      name: relation.tags?.name ?? null,
      admin_level: relation.tags?.admin_level ? Number(relation.tags.admin_level) : null,
    },
    geometry: relationToGeometry(relation),
  };
}

// ---------------------------------------------------------------------------
// Filtering rules that fix real defects in the raw admin data (SPEC.md
// 11.4), applied after findDistrictRelations / findNeighbourRelations and
// before writing. These apply identically regardless of input format, since
// both formats have already been normalised to OverpassRelation by this
// point.
// ---------------------------------------------------------------------------

function outerRingsOf(geometry: GeoJsonPolygon | GeoJsonMultiPolygon): GeoJsonPosition[][] {
  return geometry.type === 'Polygon'
    ? [geometry.coordinates[0]]
    : geometry.coordinates.map((polygon) => polygon[0]);
}

function ringCentroid(ring: GeoJsonPosition[]): GeoJsonPosition {
  const points = isRingClosed(ring) ? ring.slice(0, -1) : ring;
  let sumX = 0;
  let sumY = 0;
  for (const [x, y] of points) {
    sumX += x;
    sumY += y;
  }
  return [sumX / points.length, sumY / points.length];
}

/**
 * A single point representing a polygon's location, for the district leaf
 * containment test below: the centroid of its largest outer ring.
 * Administrative boundaries are close enough to convex that this lands
 * inside the shape in practice.
 */
function representativePoint(geometry: GeoJsonPolygon | GeoJsonMultiPolygon): GeoJsonPosition {
  const rings = outerRingsOf(geometry);
  const largest = rings.reduce((best, ring) =>
    Math.abs(signedArea(ring)) > Math.abs(signedArea(best)) ? ring : best,
  );
  return ringCentroid(largest);
}

function polygonContainsPoint(
  geometry: GeoJsonPolygon | GeoJsonMultiPolygon,
  point: GeoJsonPosition,
): boolean {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polygons.some(([outer, ...holes]) => {
    return pointInRing(point, outer) && !holes.some((hole) => pointInRing(point, hole));
  });
}

/**
 * Keeps only the leaves of the district admin-level hierarchy. Karlsruhe's
 * export has relations at both admin_level 9 and 10, and some level-9 areas
 * (e.g. Wettersbach) geometrically contain level-10 areas (Grünwettersbach,
 * Palmbach) — treating both as districts would count that area twice and
 * corrupt the percentages Sections 6.3 and 7.6 compute. A relation is
 * dropped when some other relation at a strictly higher configured admin
 * level has its representative point inside it; relations at the highest
 * configured level are always kept.
 */
export function filterLeafDistrictRelations(
  relations: OverpassRelation[],
  districtAdminLevels: number[],
): OverpassRelation[] {
  const maxLevel = Math.max(...districtAdminLevels);
  return relations.filter((relation) => {
    const level = Number(relation.tags?.admin_level);
    if (level === maxLevel) return true;

    const geometry = relationToGeometry(relation);
    return !relations.some((other) => {
      if (other === relation) return false;
      const otherLevel = Number(other.tags?.admin_level);
      if (otherLevel <= level) return false;
      return polygonContainsPoint(geometry, representativePoint(relationToGeometry(other)));
    });
  });
}

/**
 * Restricts neighbouring-municipality relations to the highest (numerically
 * largest) admin level present in the city's own city_admin_levels — for
 * Karlsruhe that is 8. The neighbours query also picks up county-level
 * (Landkreis) relations at a lower admin level, which are not municipalities
 * and are not what Section 8.3's greyed-out neighbour outlines are for.
 */
export function filterMunicipalityNeighbourRelations(
  relations: OverpassRelation[],
  cityAdminLevels: number[],
): OverpassRelation[] {
  const municipalityLevel = Math.max(...cityAdminLevels);
  return relations.filter((relation) => Number(relation.tags?.admin_level) === municipalityLevel);
}
