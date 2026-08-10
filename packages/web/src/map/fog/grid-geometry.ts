// The mercator-space quad the fog texture is painted onto (SPEC.md Section
// 7.3: "a single full-screen quad"). "Full-screen" here means the quad
// spans the whole playable grid, not literally the viewport - one quad for
// the entire city rather than one per cell (there are ~143k cells for
// Karlsruhe, Section 6.2), with the fog texture's UV 0..1 landing exactly
// on the grid's texel 0..1, cell-for-cell.
//
// `maplibregl.MercatorCoordinate` is only reachable through the library's
// default export at runtime (its .d.ts advertises a named export, but the
// built ESM only attaches it to `default`) - matching the `import
// maplibregl from 'maplibre-gl'` already used in screens/Map.tsx.
import maplibregl from 'maplibre-gl';
import { cellCenterXY } from '@tipsytrails/shared';
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
 * The four corners of the grid's bounding quad, in mercator space, paired
 * with the fog-texture UV each corner corresponds to.
 *
 * `cellCenterXY(x, y, grid)` returns the *centre* of cell `(x, y)`
 * (SPEC.md Section 6.1); passing half-integer coordinates one cell short of
 * each edge (`-0.5`, `grid_width - 0.5`, ...) lands exactly on the grid's
 * outer boundary instead, without duplicating the projection formula here.
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
  const sw = cellCenterXY(-0.5, -0.5, grid);
  const se = cellCenterXY(grid.grid_width - 0.5, -0.5, grid);
  const nw = cellCenterXY(-0.5, grid.grid_height - 0.5, grid);
  const ne = cellCenterXY(grid.grid_width - 0.5, grid.grid_height - 0.5, grid);

  // sw, se, nw, ne - a valid gl.TRIANGLE_STRIP winding for a rectangle.
  return [
    { merc: toMercator(sw), u: 0, v: 0 },
    { merc: toMercator(se), u: 1, v: 0 },
    { merc: toMercator(nw), u: 0, v: 1 },
    { merc: toMercator(ne), u: 1, v: 1 },
  ];
}
