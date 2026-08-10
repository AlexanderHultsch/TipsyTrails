// Grid projection and district assignment for the fog-of-war cell grid
// (SPEC.md Section 6, `scripts/build-grid.ts`).
//
// This module is pure and side-effect free — no network, no file system —
// so the projection, the point-in-polygon test and the district assignment
// can be unit-tested without touching the seed GeoJSON, and
// `scripts/build-grid.ts` stays a thin CLI wrapper (arg parsing, reading the
// city config and districts.geojson, atomic writes) around it.
//
// The point-in-polygon ray-casting test mirrors the one already proven out
// in `overpass.ts`'s district-leaf filtering; it is reimplemented here
// rather than imported so this module has no dependency on the Overpass
// pipeline, only on the plain GeoJSON position/polygon shapes it shares
// with it.

import type { CityBoundingBox } from './city.js';

// ---------------------------------------------------------------------------
// Projection (SPEC.md Section 6.1 — normative).
// ---------------------------------------------------------------------------

export const M_PER_DEG_LAT = 110574;

export function mPerDegLon(lat: number): number {
  return 111320 * Math.cos((lat * Math.PI) / 180);
}

/**
 * The grid parameters a city row (Section 5.1) carries: the SW-corner
 * origin, the grid dimensions, and the cell size. Distinct from
 * `CityConfig` (Section 11.4), which carries a bounding box instead —
 * `computeGridDimensions` is what turns one into the other.
 */
export interface GridParams {
  origin_lat: number;
  origin_lon: number;
  grid_width: number;
  grid_height: number;
  cell_size_m: number;
}

/**
 * `toCell` from SPEC.md Section 6.1, verbatim. The longitude scale is
 * evaluated once at `grid.origin_lat`, not per sample — do not "fix" that by
 * evaluating at the sample latitude (see the spec for why).
 */
export function toCell(lat: number, lon: number, grid: GridParams): number | null {
  const x = Math.floor(((lon - grid.origin_lon) * mPerDegLon(grid.origin_lat)) / grid.cell_size_m);
  const y = Math.floor(((lat - grid.origin_lat) * M_PER_DEG_LAT) / grid.cell_size_m);
  if (x < 0 || y < 0 || x >= grid.grid_width || y >= grid.grid_height) return null;
  return y * grid.grid_width + x;
}

export interface LatLon {
  lat: number;
  lon: number;
}

// Mean Earth radius in metres, the standard constant for the haversine
// formula (SPEC.md Section 6.1: "Distances use the haversine formula").
// Distinct from M_PER_DEG_LAT above, which is a local equirectangular
// approximation used only for grid projection, not for general distances.
const EARTH_RADIUS_M = 6371000;

/** Great-circle distance between two points, in metres (SPEC.md Section 6.1). */
export function haversineDistanceM(a: LatLon, b: LatLon): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** The centre coordinate of cell (x, y) — the inverse of `toCell`. */
export function cellCenterXY(x: number, y: number, grid: GridParams): LatLon {
  const lon = grid.origin_lon + ((x + 0.5) * grid.cell_size_m) / mPerDegLon(grid.origin_lat);
  const lat = grid.origin_lat + ((y + 0.5) * grid.cell_size_m) / M_PER_DEG_LAT;
  return { lat, lon };
}

/** The centre coordinate of a cell given its packed index (`y * grid_width + x`). */
export function cellCenter(index: number, grid: GridParams): LatLon {
  const x = index % grid.grid_width;
  const y = Math.floor(index / grid.grid_width);
  return cellCenterXY(x, y, grid);
}

/**
 * Grid dimensions covering a city's bounding box at the given cell size —
 * "however many whole cells cover the configured bounding box" (SPEC.md
 * Section 6.1/6.2). The origin is the box's SW corner, so the longitude
 * scale is evaluated at `box.south`, consistent with `origin_lat` in the
 * `cities` row this produces.
 */
export function computeGridDimensions(
  box: CityBoundingBox,
  cellSizeM: number,
): { grid_width: number; grid_height: number } {
  const grid_width = Math.ceil(((box.east - box.west) * mPerDegLon(box.south)) / cellSizeM);
  const grid_height = Math.ceil(((box.north - box.south) * M_PER_DEG_LAT) / cellSizeM);
  return { grid_width, grid_height };
}

// ---------------------------------------------------------------------------
// Minimal GeoJSON position/polygon shapes, matching overpass.ts.
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

export type GeoJsonPolygonal = GeoJsonPolygon | GeoJsonMultiPolygon;

function polygonsOf(geometry: GeoJsonPolygonal): GeoJsonPosition[][][] {
  return geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
}

// ---------------------------------------------------------------------------
// Point-in-polygon (ray casting), with hole support.
// ---------------------------------------------------------------------------

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

/** True when `point` ([lon, lat]) lies inside `geometry`, honouring holes. */
export function polygonContainsPoint(geometry: GeoJsonPolygonal, point: GeoJsonPosition): boolean {
  return polygonsOf(geometry).some(([outer, ...holes]) => {
    return pointInRing(point, outer) && !holes.some((hole) => pointInRing(point, hole));
  });
}

export interface LonLatBox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

/** The lon/lat bounding box of a polygon or multipolygon, for a cheap prefilter. */
export function geometryBoundingBox(geometry: GeoJsonPolygonal): LonLatBox {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const polygon of polygonsOf(geometry)) {
    for (const ring of polygon) {
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
  }
  return { minLon, minLat, maxLon, maxLat };
}

function boxContains(box: LonLatBox, lon: number, lat: number): boolean {
  return lon >= box.minLon && lon <= box.maxLon && lat >= box.minLat && lat <= box.maxLat;
}

// ---------------------------------------------------------------------------
// Polygon area, in the same equirectangular projection as the grid — used to
// sanity-check the playable cell count against an independent estimate
// (SPEC.md's `build-grid.ts` correctness checks).
// ---------------------------------------------------------------------------

function ringAreaM2(ring: GeoJsonPosition[], originLat: number): number {
  const lonScale = mPerDegLon(originLat);
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const x1 = ring[i][0] * lonScale;
    const y1 = ring[i][1] * M_PER_DEG_LAT;
    const x2 = ring[i + 1][0] * lonScale;
    const y2 = ring[i + 1][1] * M_PER_DEG_LAT;
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/** Polygon area in square metres, projected the same way the grid is. */
export function polygonAreaM2(geometry: GeoJsonPolygonal, originLat: number): number {
  let total = 0;
  for (const [outer, ...holes] of polygonsOf(geometry)) {
    total += ringAreaM2(outer, originLat);
    for (const hole of holes) total -= ringAreaM2(hole, originLat);
  }
  return total;
}

/**
 * How far the playable cell count may differ from the area-based estimate
 * before `build-grid.ts` refuses to write (see its correctness checks).
 * Not a spec-defined runtime constant (SPEC.md says only "a few percent"),
 * so it lives here rather than in `config.ts`, alongside the check it
 * belongs to.
 */
export const AREA_ESTIMATE_TOLERANCE_PERCENT = 5;

/**
 * Throws if `actualCells` differs from `estimatedCells` by more than
 * `tolerancePercent`.
 */
export function checkAreaEstimate(
  actualCells: number,
  estimatedCells: number,
  tolerancePercent: number = AREA_ESTIMATE_TOLERANCE_PERCENT,
): void {
  const diffPercent = (Math.abs(actualCells - estimatedCells) / estimatedCells) * 100;
  if (diffPercent > tolerancePercent) {
    throw new Error(
      `Playable cell count (${actualCells}) differs from the area-based estimate ` +
        `(${estimatedCells.toFixed(0)}) by ${diffPercent.toFixed(1)}%, more than the ` +
        `${tolerancePercent}% tolerance. This usually means the projection, the bounding box, ` +
        `or a district polygon is wrong.`,
    );
  }
}

// ---------------------------------------------------------------------------
// District assignment.
// ---------------------------------------------------------------------------

export interface DistrictInput {
  name: string;
  geometry: GeoJsonPolygonal;
}

export interface DistrictAssignment {
  name: string;
  index: number;
  playableCells: number;
}

export interface GridAssignmentResult {
  grid: Uint16Array;
  districts: DistrictAssignment[];
  playableCells: number;
}

/** Sentinel cell value meaning "in no district" (SPEC.md Section 5.2). */
export const NO_DISTRICT = 0xffff;

export class GridOverlapError extends Error {}

/**
 * Assigns every cell in `params` to at most one district, by testing
 * whether the cell's centre lies inside each district's polygon (SPEC.md
 * Section 6.3 — the centre rule, not any overlap). A per-district bounding
 * box prefilter skips the point-in-polygon test for districts nowhere near
 * a given cell, which is what keeps this fast (Karlsruhe: ~143k cells x 27
 * districts naive, trivial with the prefilter).
 *
 * Throws `GridOverlapError` if a cell's centre lies inside more than one
 * district's polygon — the districts are expected to tile the city without
 * overlap, so this means the point-in-polygon test or the input polygons
 * are wrong, not that overlap is a legitimate outcome to encode.
 */
export function assignGrid(params: GridParams, districts: DistrictInput[]): GridAssignmentResult {
  if (districts.length >= NO_DISTRICT) {
    throw new Error(
      `${districts.length} districts given; the sentinel 0xFFFF requires fewer than ${NO_DISTRICT}.`,
    );
  }

  const boxes = districts.map((d) => geometryBoundingBox(d.geometry));
  const grid = new Uint16Array(params.grid_width * params.grid_height).fill(NO_DISTRICT);
  const counts = new Array<number>(districts.length).fill(0);

  for (let y = 0; y < params.grid_height; y++) {
    for (let x = 0; x < params.grid_width; x++) {
      const { lat, lon } = cellCenterXY(x, y, params);
      const point: GeoJsonPosition = [lon, lat];

      const matches: number[] = [];
      for (let d = 0; d < districts.length; d++) {
        if (!boxContains(boxes[d], lon, lat)) continue;
        if (polygonContainsPoint(districts[d].geometry, point)) matches.push(d);
      }

      if (matches.length > 1) {
        throw new GridOverlapError(
          `Cell (x=${x}, y=${y}) centre lies inside ${matches.length} districts: ` +
            `${matches.map((i) => districts[i].name).join(', ')}. Districts must tile without overlap.`,
        );
      }
      if (matches.length === 1) {
        const index = y * params.grid_width + x;
        grid[index] = matches[0];
        counts[matches[0]]++;
      }
    }
  }

  const playableCells = counts.reduce((a, b) => a + b, 0);
  return {
    grid,
    districts: districts.map((d, i) => ({ name: d.name, index: i, playableCells: counts[i] })),
    playableCells,
  };
}

/** Names of districts that received zero cells — always a bug, never valid output. */
export function districtsWithNoCells(districts: DistrictAssignment[]): string[] {
  return districts.filter((d) => d.playableCells === 0).map((d) => d.name);
}
