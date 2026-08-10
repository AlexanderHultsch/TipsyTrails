import maplibregl from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import { cellCenterXY } from '@tipsytrails/shared';
import type { GridParams } from '@tipsytrails/shared';
import { gridQuadCorners } from './grid-geometry.js';

// A small synthetic grid - the real numbers (Karlsruhe's 417 x 343, Section
// 6.2) would make the expectations below no easier to read, only harder to
// hand-check.
const GRID: GridParams = {
  origin_lat: 48.94,
  origin_lon: 8.275,
  grid_width: 4,
  grid_height: 3,
  cell_size_m: 50,
};

describe('gridQuadCorners', () => {
  it('places the SW corner UV (0,0) exactly at the city origin', () => {
    const [sw] = gridQuadCorners(GRID);
    expect(sw.u).toBe(0);
    expect(sw.v).toBe(0);
    const expected = maplibregl.MercatorCoordinate.fromLngLat({
      lng: GRID.origin_lon,
      lat: GRID.origin_lat,
    });
    expect(sw.merc.x).toBeCloseTo(expected.x, 10);
    expect(sw.merc.y).toBeCloseTo(expected.y, 10);
  });

  it('places the NE corner UV (1,1) at the far edge of the last cell, not its centre', () => {
    const corners = gridQuadCorners(GRID);
    const ne = corners.find((c) => c.u === 1 && c.v === 1);
    expect(ne).toBeDefined();

    // The far corner of the last cell is half a cell beyond that cell's
    // centre (Section 6.1's cellCenterXY), in both x and y.
    const lastCellCentre = cellCenterXY(GRID.grid_width - 1, GRID.grid_height - 1, GRID);
    const farCorner = cellCenterXY(GRID.grid_width - 0.5, GRID.grid_height - 0.5, GRID);
    expect(farCorner.lat).toBeGreaterThan(lastCellCentre.lat);
    expect(farCorner.lon).toBeGreaterThan(lastCellCentre.lon);

    const expected = maplibregl.MercatorCoordinate.fromLngLat({
      lng: farCorner.lon,
      lat: farCorner.lat,
    });
    expect(ne?.merc.x).toBeCloseTo(expected.x, 10);
    expect(ne?.merc.y).toBeCloseTo(expected.y, 10);
  });

  it('gives the four corners a valid triangle-strip winding for a rectangle (sw, se, nw, ne)', () => {
    const [sw, se, nw, ne] = gridQuadCorners(GRID);
    expect([sw.u, sw.v]).toEqual([0, 0]);
    expect([se.u, se.v]).toEqual([1, 0]);
    expect([nw.u, nw.v]).toEqual([0, 1]);
    expect([ne.u, ne.v]).toEqual([1, 1]);

    // East is a larger mercator x than west; mercator y increases
    // southward, so the (v=0, "south") row must have the larger merc.y.
    expect(se.merc.x).toBeGreaterThan(sw.merc.x);
    expect(sw.merc.y).toBeGreaterThan(nw.merc.y);
  });
});
