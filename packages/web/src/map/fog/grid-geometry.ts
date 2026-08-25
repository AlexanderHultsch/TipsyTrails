// The mercator-space quad the fog texture is painted onto (SPEC.md Section
// 7.3: "a single full-screen quad"). "Full-screen" is meant literally: the
// quad spans the camera's current viewport, rebuilt every frame, with the
// fog texture's UV 0..1 landing exactly on the grid's texel 0..1,
// cell-for-cell. Still one quad for the whole city rather than one per cell
// (there are ~143k cells for Karlsruhe, Section 6.2) - only its extent
// follows the camera now.
//
// WHY IT FOLLOWS THE CAMERA. The quad used to be fixed at `gridMapBounds` -
// the grid plus `MAP_BOUNDS_PADDING_RATIO`, the same rectangle the map uses
// as `maxBounds` (`useCityMaxBounds.ts`). That reasoning holds only while
// the map is north-up: `maxBounds` constrains an *axis-aligned* viewport, so
// rotating the camera makes the viewport's corners sweep outside that
// rectangle. Where there is no quad there is no geometry, and where there is
// no geometry there is no fog - the corners of a rotated map showed bare,
// un-fogged ground. Neither map disables `dragRotate` or `touchZoomRotate`,
// so two fingers reach this on any phone.
//
// `maplibregl.MercatorCoordinate` is only reachable through the library's
// default export at runtime (its .d.ts advertises a named export, but the
// built ESM only attaches it to `default`) - matching the `import
// maplibregl from 'maplibre-gl'` already used in screens/Map.tsx.
import maplibregl from 'maplibre-gl';
import { CONFIG, cellCenterXY, gridMapBounds } from '@tipsytrails/shared';
import type { GridParams, LatLon } from '@tipsytrails/shared';

// Internal: mercator space is this module's own working space and nothing
// outside it holds a point in those units.
interface MercatorPoint {
  x: number;
  y: number;
}

// Internal: the elements of what `gridQuadCorners` returns, which its one
// caller (webgl-fog-layer.ts) reads field by field into a vertex buffer
// without naming the type.
interface GridQuadCorner {
  merc: MercatorPoint;
  u: number;
  v: number;
}

/** A lng/lat rectangle - the shape `MapLibre`'s `LngLatBounds` describes. */
export interface LngLatBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * The read side of `maplibregl.LngLatBounds`, named structurally so this
 * module needs no value import of the class and a test can hand it a plain
 * object.
 */
interface LngLatBoundsLike {
  getWest(): number;
  getSouth(): number;
  getEast(): number;
  getNorth(): number;
}

/** `map.getBounds()` as a plain box. */
export function lngLatBox(bounds: LngLatBoundsLike): LngLatBox {
  return {
    west: bounds.getWest(),
    south: bounds.getSouth(),
    east: bounds.getEast(),
    north: bounds.getNorth(),
  };
}

// The latitude at which Web Mercator's y reaches 0 and 1 - the inverse
// Gudermannian of pi - beyond which the projection runs off to infinity.
// Derived rather than written out so it is exact to the last bit; a rounded
// 85.051129 already lands a few nanometres of mercator past the edge. Not a
// tunable and not spec-defined, so it stays here beside the clamp that uses
// it, the same way `EARTH_RADIUS_M` lives beside the haversine formula in
// shared/grid.ts rather than in config.ts.
const MERCATOR_MAX_LATITUDE = (Math.atan(Math.sinh(Math.PI)) * 180) / Math.PI;

function toMercator(point: LatLon): MercatorPoint {
  const coord = maplibregl.MercatorCoordinate.fromLngLat({ lng: point.lon, lat: point.lat });
  return { x: coord.x, y: coord.y };
}

function clampLatitude(lat: number): number {
  return Math.min(MERCATOR_MAX_LATITUDE, Math.max(-MERCATOR_MAX_LATITUDE, lat));
}

function isUsable(box: LngLatBox | null | undefined): box is LngLatBox {
  return (
    box != null &&
    Number.isFinite(box.west) &&
    Number.isFinite(box.south) &&
    Number.isFinite(box.east) &&
    Number.isFinite(box.north) &&
    box.east > box.west &&
    box.north > box.south
  );
}

/**
 * The lng/lat rectangle the fog quad spans for a given camera.
 *
 * `viewport` is `map.getBounds()`: in maplibre-gl 4.7.1 that is the smallest
 * lng/lat box enclosing the four unprojected screen corners, so it already
 * accounts for bearing and for pitch. Covering it therefore covers the
 * visible ground: the visible region is the convex quadrilateral those four
 * corners span in mercator space, longitude is linear in mercator x and
 * latitude is monotone in mercator y, so the box's mercator rectangle
 * contains that quadrilateral whole.
 *
 * It is then padded by `CONFIG.FOG_VIEWPORT_PADDING_RATIO` per axis and the
 * latitudes clamped into the range Web Mercator is defined on, so the quad's
 * vertices are finite whatever the camera does.
 *
 * With no usable viewport - before the layer has a map, or if `getBounds()`
 * ever returns something non-finite or inside-out - this falls back to
 * `gridMapBounds`, the grid plus `MAP_BOUNDS_PADDING_RATIO`. That covers the
 * whole city, so a north-up map is still fully fogged; it is a floor to fall
 * back to, not the rule.
 */
export function fogQuadBox(grid: GridParams, viewport?: LngLatBox | null): LngLatBox {
  if (!isUsable(viewport)) {
    const [[west, south], [east, north]] = gridMapBounds(grid);
    return { west, south, east, north };
  }
  const lonPadding = (viewport.east - viewport.west) * CONFIG.FOG_VIEWPORT_PADDING_RATIO;
  const latPadding = (viewport.north - viewport.south) * CONFIG.FOG_VIEWPORT_PADDING_RATIO;
  return {
    west: viewport.west - lonPadding,
    south: clampLatitude(viewport.south - latPadding),
    east: viewport.east + lonPadding,
    north: clampLatitude(viewport.north + latPadding),
  };
}

/**
 * The four corners of the fog quad, in mercator space, paired with the
 * fog-texture UV each corner corresponds to.
 *
 * The extent comes from `fogQuadBox` above. The *grid* occupies UV 0..1
 * exactly, cell-for-cell, whatever that extent is, so everything outside the
 * grid - the padding ring, and all the ground a camera pointed at the city's
 * edge can see beyond it - falls outside that range. There are no cells out
 * there to reveal, and the fragment shader (`webgl-fog-layer.ts`) renders
 * anything outside 0..1 as unrevealed fog, so a quad that overshoots the
 * grid is already handled correctly.
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
export function gridQuadCorners(grid: GridParams, viewport?: LngLatBox | null): GridQuadCorner[] {
  const { west, south, east, north } = fogQuadBox(grid, viewport);
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
