import maplibregl from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import { CONFIG, cellCenterXY, gridMapBounds } from '@tipsytrails/shared';
import type { GridParams } from '@tipsytrails/shared';
import { fogQuadBox, gridQuadCorners, lngLatBox } from './grid-geometry.js';
import type { LngLatBox } from './grid-geometry.js';

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

interface MercXY {
  x: number;
  y: number;
}

/**
 * The four mercator corners of a viewport of `halfSpan` mercator units,
 * centred on `centre` and turned by `bearingDeg`, together with the lng/lat
 * box `map.getBounds()` reports for it.
 *
 * This mirrors what maplibre-gl 4.7.1 actually does: `Transform.getBounds`
 * unprojects the four screen corners and returns the smallest `LngLatBounds`
 * containing them ("when the bearing or pitch is non-zero, the visible region
 * is not an axis-aligned rectangle, and the result is the smallest bounds
 * that encompasses the visible region"). Rotating in mercator space and then
 * taking the min/max in lng/lat is the same box, because longitude is linear
 * in mercator x and latitude is monotone in mercator y.
 */
function rotatedViewport(
  centre: MercXY,
  halfSpan: number,
  bearingDeg: number,
): { corners: MercXY[]; box: LngLatBox } {
  const theta = (bearingDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const corners = [
    [-halfSpan, -halfSpan],
    [halfSpan, -halfSpan],
    [halfSpan, halfSpan],
    [-halfSpan, halfSpan],
  ].map(([dx, dy]) => ({
    x: centre.x + dx * cos - dy * sin,
    y: centre.y + dx * sin + dy * cos,
  }));

  const lngLats = corners.map((c) => new maplibregl.MercatorCoordinate(c.x, c.y, 0).toLngLat());
  return {
    corners,
    box: {
      west: Math.min(...lngLats.map((l) => l.lng)),
      south: Math.min(...lngLats.map((l) => l.lat)),
      east: Math.max(...lngLats.map((l) => l.lng)),
      north: Math.max(...lngLats.map((l) => l.lat)),
    },
  };
}

// A corner reaches the fog quad through mercator -> lng/lat (what
// `getBounds()` reports) -> mercator, and that round trip is not bit-exact:
// measured over the bearing sweep below it lands up to 5.6e-17 mercator units
// out, about 1.5 nanometres of ground. This tolerance is four orders of
// magnitude above that and eleven below one grid cell, so these tests fail
// for gaps in coverage and not for the last bit of a double.
const MERCATOR_EPSILON = 1e-12;

/** True when `point` lies inside the mercator rectangle the quad spans. */
function quadContains(quad: ReturnType<typeof gridQuadCorners>, point: MercXY): boolean {
  const xs = quad.map((c) => c.merc.x);
  const ys = quad.map((c) => c.merc.y);
  return (
    point.x >= Math.min(...xs) - MERCATOR_EPSILON &&
    point.x <= Math.max(...xs) + MERCATOR_EPSILON &&
    point.y >= Math.min(...ys) - MERCATOR_EPSILON &&
    point.y <= Math.max(...ys) + MERCATOR_EPSILON
  );
}

describe('gridQuadCorners with no viewport', () => {
  it('falls back to spanning exactly the padded bounds the map is clamped to', () => {
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

describe('gridQuadCorners under a rotated camera', () => {
  // A square viewport centred on the city, sized so that north-up it fits
  // inside the old fixed quad with room to spare. `gridMapBounds` is taller
  // than it is wide here only in cells; in mercator the narrower axis is what
  // the viewport has to clear, so take 90% of that half-extent.
  const fixedQuad = gridQuadCorners(GRID);
  const centre: MercXY = {
    x:
      (Math.min(...fixedQuad.map((c) => c.merc.x)) + Math.max(...fixedQuad.map((c) => c.merc.x))) /
      2,
    y:
      (Math.min(...fixedQuad.map((c) => c.merc.y)) + Math.max(...fixedQuad.map((c) => c.merc.y))) /
      2,
  };
  const halfSpan =
    0.9 *
    Math.min(
      (Math.max(...fixedQuad.map((c) => c.merc.x)) - Math.min(...fixedQuad.map((c) => c.merc.x))) /
        2,
      (Math.max(...fixedQuad.map((c) => c.merc.y)) - Math.min(...fixedQuad.map((c) => c.merc.y))) /
        2,
    );

  it('leaves a rotated viewport un-covered when the quad is fixed to the city, and covers it when it is not', () => {
    const northUp = rotatedViewport(centre, halfSpan, 0);
    const turned = rotatedViewport(centre, halfSpan, 40);

    // The defect the owner walked into: north-up, the fixed quad covers the
    // whole viewport - "most of the time". Turn the same viewport and its
    // corners sweep outside it, and where there is no quad there is no fog.
    expect(northUp.corners.every((corner) => quadContains(fixedQuad, corner))).toBe(true);
    expect(turned.corners.some((corner) => !quadContains(fixedQuad, corner))).toBe(true);

    // Built from the rotated viewport instead, the quad covers every corner.
    const followsCamera = gridQuadCorners(GRID, turned.box);
    for (const corner of turned.corners) {
      expect(quadContains(followsCamera, corner)).toBe(true);
    }
  });

  it('covers the corners at every bearing, not just the two the axes agree with', () => {
    for (let bearing = 0; bearing < 360; bearing += 17) {
      const { corners, box } = rotatedViewport(centre, halfSpan, bearing);
      const quad = gridQuadCorners(GRID, box);
      for (const corner of corners) {
        expect(quadContains(quad, corner)).toBe(true);
      }
    }
  });

  it('keeps the grid at UV 0..1 when the quad follows the camera', () => {
    const { box } = rotatedViewport(centre, halfSpan, 40);
    const span = fogQuadBox(GRID, box);
    const [sw, , , ne] = gridQuadCorners(GRID, box);

    // Longitude and latitude stay linear in the quad's UV whatever the quad
    // spans, so inverting that map at u = 0 / u = 1 must still land on the
    // grid's own outer boundary - half a cell beyond the first and last cell
    // centres (Section 6.1).
    const lonAt = (u: number) => span.west + ((u - sw.u) / (ne.u - sw.u)) * (span.east - span.west);
    const latAt = (v: number) =>
      span.south + ((v - sw.v) / (ne.v - sw.v)) * (span.north - span.south);

    const gridSouthWest = cellCenterXY(-0.5, -0.5, GRID);
    const gridNorthEast = cellCenterXY(GRID.grid_width - 0.5, GRID.grid_height - 0.5, GRID);
    expect(lonAt(0)).toBeCloseTo(gridSouthWest.lon, 12);
    expect(latAt(0)).toBeCloseTo(gridSouthWest.lat, 12);
    expect(lonAt(1)).toBeCloseTo(gridNorthEast.lon, 12);
    expect(latAt(1)).toBeCloseTo(gridNorthEast.lat, 12);
  });
});

describe('fogQuadBox', () => {
  const viewport: LngLatBox = { west: 8.28, south: 48.945, east: 8.29, north: 48.952 };

  it('pads the viewport outwards by FOG_VIEWPORT_PADDING_RATIO on each axis', () => {
    const box = fogQuadBox(GRID, viewport);

    // Strictly outside on all four sides: with no margin at all the quad
    // would end exactly at the pixels the camera can see.
    expect(box.west).toBeLessThan(viewport.west);
    expect(box.south).toBeLessThan(viewport.south);
    expect(box.east).toBeGreaterThan(viewport.east);
    expect(box.north).toBeGreaterThan(viewport.north);

    const grown = 1 + 2 * CONFIG.FOG_VIEWPORT_PADDING_RATIO;
    expect(box.east - box.west).toBeCloseTo((viewport.east - viewport.west) * grown, 12);
    expect(box.north - box.south).toBeCloseTo((viewport.north - viewport.south) * grown, 12);
  });

  it('uses its own margin, not the map pan limit that caused the defect', () => {
    expect(CONFIG.FOG_VIEWPORT_PADDING_RATIO).not.toBe(CONFIG.MAP_BOUNDS_PADDING_RATIO);
  });

  it('falls back to the city extent rather than emitting a non-finite vertex', () => {
    // A NaN corner would not shrink the quad, it would delete it - every
    // vertex fails the clip test and the fog disappears entirely. Anything
    // unusable therefore falls back to the extent that at least covers the
    // whole city.
    const fallback = fogQuadBox(GRID);
    const [[west, south], [east, north]] = gridMapBounds(GRID);
    expect(fallback).toEqual({ west, south, east, north });

    expect(fogQuadBox(GRID, null)).toEqual(fallback);
    expect(fogQuadBox(GRID, { ...viewport, north: Number.NaN })).toEqual(fallback);
    expect(fogQuadBox(GRID, { ...viewport, east: Number.POSITIVE_INFINITY })).toEqual(fallback);
    // Inside-out, which is what a degenerate camera would produce.
    expect(fogQuadBox(GRID, { ...viewport, east: viewport.west })).toEqual(fallback);
  });

  it('clamps a viewport running past the mercator limit so the quad stays finite', () => {
    const box = fogQuadBox(GRID, { west: -170, south: -89.9, east: 170, north: 89.9 });
    const sw = mercatorOf(box.west, box.south);
    const ne = mercatorOf(box.east, box.north);
    for (const value of [sw.x, sw.y, ne.x, ne.y]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    // Pinned to the mercator world's own top and bottom edge, to the last
    // bit a double carries - not run off past them.
    expect(ne.y).toBeCloseTo(0, 12);
    expect(sw.y).toBeCloseTo(1, 12);
    expect(box.north).toBeLessThan(89.9);
    expect(box.south).toBeGreaterThan(-89.9);
  });
});

describe('lngLatBox', () => {
  it('reads the four edges off a LngLatBounds', () => {
    const bounds = new maplibregl.LngLatBounds([8.28, 48.945], [8.29, 48.952]);
    expect(lngLatBox(bounds)).toEqual({
      west: 8.28,
      south: 48.945,
      east: 8.29,
      north: 48.952,
    });
  });
});
