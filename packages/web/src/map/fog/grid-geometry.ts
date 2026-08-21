// The mercator-space quad the fog texture is painted onto (SPEC.md Section
// 7.3: "a single full-screen quad"). "Full-screen" here means the quad
// spans everything the camera can be panned or zoomed to, not literally
// the viewport - one quad for the entire city rather than one per cell
// (there are ~143k cells for Karlsruhe, Section 6.2), with the fog
// texture's UV 0..1 landing exactly on the grid's texel 0..1,
// cell-for-cell.
//
// `maplibregl.MercatorCoordinate` is only reachable through the library's
// default export at runtime (its .d.ts advertises a named export, but the
// built ESM only attaches it to `default`) - matching the `import
// maplibregl from 'maplibre-gl'` already used in screens/Map.tsx.
import maplibregl from 'maplibre-gl';
import { cellCenterXY, gridMapBounds } from '@tipsytrails/shared';
import type { GridParams, LatLon } from '@tipsytrails/shared';

export interface MercatorPoint {
  x: number;
  y: number;
}

export interface GridQuadCorner {
  merc: MercatorPoint;
  u: number;
  v: number;
}

function toMercator(point: LatLon): MercatorPoint {
  const coord = maplibregl.MercatorCoordinate.fromLngLat({ lng: point.lon, lat: point.lat });
  return { x: coord.x, y: coord.y };
}

/**
 * The four corners of the fog quad, in mercator space, paired with the
 * fog-texture UV each corner corresponds to.
 *
 * The quad spans `gridMapBounds` - the grid extent plus
 * `CONFIG.MAP_BOUNDS_PADDING_RATIO`, which is also the map's `maxBounds`
 * (`useCityMaxBounds.ts`). It is taken from that same shared function
 * rather than recomputed here so the two can never drift: MapLibre clamps
 * zooming out at `maxBounds`, so a quad that stopped at the grid's own
 * outer boundary would leave the padding ring un-fogged at the furthest
 * zoom the user can reach.
 *
 * The *grid* still occupies UV 0..1 exactly, cell-for-cell, so the padding
 * ring falls outside that range - symmetrically, since the padding is a
 * ratio of each axis. There are no cells out there to reveal, and the
 * fragment shader (`webgl-fog-layer.ts`) renders anything outside 0..1 as
 * unrevealed fog.
 *
 * `cellCenterXY(x, y, grid)` returns the *centre* of cell `(x, y)`
 * (SPEC.md Section 6.1); passing half-integer coordinates one cell short of
 * each edge (`-0.5`, `grid_width - 0.5`, ...) lands exactly on the grid's
 * outer boundary instead, without duplicating the projection formula here.
 * That boundary is what UV 0 and UV 1 are measured against.
 *
 * Texel `v = 0` must be the grid's southern row: `texImage2D`'s default
 * (unflipped) unpack places the first row of the pixel array at `v = 0`,
 * and cell index `y = 0` (the first row written into that array,
 * `grid-texture.ts`) is `origin_lat` - the SW corner (Section 6.1). Mercator
 * `y` increases southward, the opposite sense, so the vertex order below
 * pairs mercator "south" with texel `v = 0` explicitly rather than by
 * coincidence.
 */
export function gridQuadCorners(grid: GridParams): GridQuadCorner[] {
  const [[west, south], [east, north]] = gridMapBounds(grid);
  const gridSouthWest = cellCenterXY(-0.5, -0.5, grid);
  const gridNorthEast = cellCenterXY(grid.grid_width - 0.5, grid.grid_height - 0.5, grid);

  const u = (lon: number) => (lon - gridSouthWest.lon) / (gridNorthEast.lon - gridSouthWest.lon);
  const v = (lat: number) => (lat - gridSouthWest.lat) / (gridNorthEast.lat - gridSouthWest.lat);

  const uWest = u(west);
  const uEast = u(east);
  const vSouth = v(south);
  const vNorth = v(north);

  // sw, se, nw, ne - a valid gl.TRIANGLE_STRIP winding for a rectangle.
  return [
    { merc: toMercator({ lat: south, lon: west }), u: uWest, v: vSouth },
    { merc: toMercator({ lat: south, lon: east }), u: uEast, v: vSouth },
    { merc: toMercator({ lat: north, lon: west }), u: uWest, v: vNorth },
    { merc: toMercator({ lat: north, lon: east }), u: uEast, v: vNorth },
  ];
}
