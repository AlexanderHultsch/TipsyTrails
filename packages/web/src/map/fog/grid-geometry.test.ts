import maplibregl from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import { CONFIG, cellCenterXY, gridMapBounds } from '@tipsytrails/shared';
import type { GridParams } from '@tipsytrails/shared';
import { gridQuadCorners } from './grid-geometry.js';

// A small synthetic grid - the real numbers (Karlsruhe's 417 x 343, Section
// 6.2) would make the expectations below no easier to read, only harder to
// hand-check. It is a few cells across on purpose: gridMapBounds pads the
// centre-to-centre span, so a grid of three cells or fewer per axis would
// pad by less than the half cell between the last centre and the grid's
// outer boundary, and the padding would land inside UV 0..1 rather than
// outside it. Every real city grid is hundreds of cells across.
const GRID: GridParams = {
  origin_lat: 48.94,
  origin_lon: 8.275,
  grid_width: 8,
  grid_height: 6,
  cell_size_m: 50,
};

// The UV of the padded bound on an axis of `cells` cells. gridMapBounds
// pads the span between the first and last cell *centres* - (cells - 1)
// cells - by MAP_BOUNDS_PADDING_RATIO; UV is measured from the grid's outer
// boundary, half a cell beyond that first centre, over a span of `cells`.
function paddedUv(cells: number): number {
  return (0.5 - CONFIG.MAP_BOUNDS_PADDING_RATIO * (cells - 1)) / cells;
}

function mercatorOf(lon: number, lat: number) {
  return maplibregl.MercatorCoordinate.fromLngLat({ lng: lon, lat });
}

describe('gridQuadCorners', () => {
  it('spans exactly the padded bounds the map is clamped to', () => {
    const [[west, south], [east, north]] = gridMapBounds(GRID);
    const [sw, se, nw, ne] = gridQuadCorners(GRID);

    const expected = [
      { corner: sw, lon: west, lat: south },
      { corner: se, lon: east, lat: south },
      { corner: nw, lon: west, lat: north },
      { corner: ne, lon: east, lat: north },
    ];
    for (const { corner, lon, lat } of expected) {
      const point = mercatorOf(lon, lat);
      expect(corner.merc.x).toBeCloseTo(point.x, 10);
      expect(corner.merc.y).toBeCloseTo(point.y, 10);
    }
  });

  it('reaches beyond the grid, whose outer boundary the old quad stopped at', () => {
    const [sw] = gridQuadCorners(GRID);
    const gridCorner = cellCenterXY(-0.5, -0.5, GRID);
    const gridMerc = mercatorOf(gridCorner.lon, gridCorner.lat);

    // West of the grid's west edge, and south of its south edge (mercator
    // y increases southward, so "south of" is a larger y).
    expect(sw.merc.x).toBeLessThan(gridMerc.x);
    expect(sw.merc.y).toBeGreaterThan(gridMerc.y);
  });

  it('keeps the grid at UV 0..1 and puts the padding outside it, symmetrically', () => {
    const [sw, se, nw, ne] = gridQuadCorners(GRID);

    const uWest = paddedUv(GRID.grid_width);
    const vSouth = paddedUv(GRID.grid_height);
    expect(uWest).toBeLessThan(0);
    expect(vSouth).toBeLessThan(0);

    expect(sw.u).toBeCloseTo(uWest, 12);
    expect(sw.v).toBeCloseTo(vSouth, 12);
    expect(se.u).toBeCloseTo(1 - uWest, 12);
    expect(se.v).toBeCloseTo(vSouth, 12);
    expect(nw.u).toBeCloseTo(uWest, 12);
    expect(nw.v).toBeCloseTo(1 - vSouth, 12);
    expect(ne.u).toBeCloseTo(1 - uWest, 12);
    expect(ne.v).toBeCloseTo(1 - vSouth, 12);

    // Symmetric about the grid's centre: as far outside 1 as it is below 0.
    expect(ne.u - 1).toBeCloseTo(0 - sw.u, 12);
    expect(ne.v - 1).toBeCloseTo(0 - sw.v, 12);
  });

  it('puts UV 0 and UV 1 exactly on the outer boundary of the grid', () => {
    const [[west, south], [east, north]] = gridMapBounds(GRID);
    const [sw, , , ne] = gridQuadCorners(GRID);

    // Longitude and latitude are linear in the quad's UV, so inverting that
    // map at u = 0 / u = 1 must land back on the grid's own boundary - half
    // a cell beyond the first and last cell centres (Section 6.1).
    const lonAt = (u: number) => west + ((u - sw.u) / (ne.u - sw.u)) * (east - west);
    const latAt = (v: number) => south + ((v - sw.v) / (ne.v - sw.v)) * (north - south);

    const gridSouthWest = cellCenterXY(-0.5, -0.5, GRID);
    const gridNorthEast = cellCenterXY(GRID.grid_width - 0.5, GRID.grid_height - 0.5, GRID);
    expect(lonAt(0)).toBeCloseTo(gridSouthWest.lon, 12);
    expect(latAt(0)).toBeCloseTo(gridSouthWest.lat, 12);
    expect(lonAt(1)).toBeCloseTo(gridNorthEast.lon, 12);
    expect(latAt(1)).toBeCloseTo(gridNorthEast.lat, 12);
  });

  it('gives the four corners a valid triangle-strip winding for a rectangle (sw, se, nw, ne)', () => {
    const [sw, se, nw, ne] = gridQuadCorners(GRID);
    expect(se.u).toBe(ne.u);
    expect(sw.u).toBe(nw.u);
    expect(sw.v).toBe(se.v);
    expect(nw.v).toBe(ne.v);

    // East is a larger mercator x than west; mercator y increases
    // southward, so the ("south") row with the smaller v must have the
    // larger merc.y.
    expect(se.merc.x).toBeGreaterThan(sw.merc.x);
    expect(sw.merc.y).toBeGreaterThan(nw.merc.y);
    expect(sw.v).toBeLessThan(nw.v);
  });
});
