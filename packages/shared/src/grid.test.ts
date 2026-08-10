import { describe, expect, it } from 'vitest';
import {
  AREA_ESTIMATE_TOLERANCE_PERCENT,
  M_PER_DEG_LAT,
  assignGrid,
  cellCenter,
  checkAreaEstimate,
  computeGridDimensions,
  districtsWithNoCells,
  haversineDistanceM,
  mPerDegLon,
  polygonAreaM2,
  polygonContainsPoint,
  toCell,
  GridOverlapError,
  type DistrictInput,
  type GeoJsonPolygon,
  type GridParams,
} from './grid.js';

// The real Karlsruhe grid parameters (SPEC.md Section 6.2), for the
// projection round-trip tests.
const KARLSRUHE_GRID: GridParams = {
  origin_lat: 48.94,
  origin_lon: 8.275,
  grid_width: 417,
  grid_height: 343,
  cell_size_m: 50,
};

describe('toCell / cellCenter round-trip', () => {
  const indices = [
    0, // (0, 0) — SW corner
    KARLSRUHE_GRID.grid_width - 1, // (width-1, 0) — SE corner
    KARLSRUHE_GRID.grid_width * (KARLSRUHE_GRID.grid_height - 1), // (0, height-1) — NW corner
    KARLSRUHE_GRID.grid_width * KARLSRUHE_GRID.grid_height - 1, // NE corner
    KARLSRUHE_GRID.grid_width * 100 + 50, // an interior cell
    KARLSRUHE_GRID.grid_width * 200 + 300, // another interior cell
  ];

  it.each(indices)('cell %i converts to its centre and back to itself', (index) => {
    const { lat, lon } = cellCenter(index, KARLSRUHE_GRID);
    expect(toCell(lat, lon, KARLSRUHE_GRID)).toBe(index);
  });
});

describe('toCell out-of-bounds rejection', () => {
  it('rejects a point south of the bounding box', () => {
    expect(toCell(KARLSRUHE_GRID.origin_lat - 0.001, 8.4, KARLSRUHE_GRID)).toBeNull();
  });

  it('rejects a point west of the bounding box', () => {
    expect(toCell(48.95, KARLSRUHE_GRID.origin_lon - 0.001, KARLSRUHE_GRID)).toBeNull();
  });

  it('rejects a point just past the north edge', () => {
    const northEdgeLat =
      KARLSRUHE_GRID.origin_lat +
      (KARLSRUHE_GRID.grid_height * KARLSRUHE_GRID.cell_size_m) / M_PER_DEG_LAT;
    expect(toCell(northEdgeLat + 0.0001, 8.4, KARLSRUHE_GRID)).toBeNull();
  });

  it('rejects a point just past the east edge', () => {
    const eastEdgeLon =
      KARLSRUHE_GRID.origin_lon +
      (KARLSRUHE_GRID.grid_width * KARLSRUHE_GRID.cell_size_m) /
        mPerDegLon(KARLSRUHE_GRID.origin_lat);
    expect(toCell(48.95, eastEdgeLon + 0.0001, KARLSRUHE_GRID)).toBeNull();
  });

  it('accepts the SW corner itself', () => {
    expect(toCell(KARLSRUHE_GRID.origin_lat, KARLSRUHE_GRID.origin_lon, KARLSRUHE_GRID)).toBe(0);
  });
});

describe('computeGridDimensions', () => {
  it('matches the authoritative Karlsruhe grid size from SPEC.md Section 6.2', () => {
    const dims = computeGridDimensions(
      { south: 48.94, west: 8.275, north: 49.095, east: 8.56 },
      50,
    );
    expect(dims).toEqual({ grid_width: 417, grid_height: 343 });
  });
});

describe('polygonContainsPoint', () => {
  const square: GeoJsonPolygon = {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
    ],
  };

  it('accepts a point inside a square', () => {
    expect(polygonContainsPoint(square, [5, 5])).toBe(true);
  });

  it('rejects a point outside a square', () => {
    expect(polygonContainsPoint(square, [15, 5])).toBe(false);
  });

  // An L-shape: the union of [0,10]x[0,4] and [0,4]x[0,10], concave at (4, 4).
  const lShape: GeoJsonPolygon = {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [10, 0],
        [10, 4],
        [4, 4],
        [4, 10],
        [0, 10],
        [0, 0],
      ],
    ],
  };

  it('accepts a point in the horizontal arm of a concave shape', () => {
    expect(polygonContainsPoint(lShape, [8, 2])).toBe(true);
  });

  it('accepts a point in the vertical arm of a concave shape', () => {
    expect(polygonContainsPoint(lShape, [2, 8])).toBe(true);
  });

  it('rejects a point in the notch of a concave shape', () => {
    expect(polygonContainsPoint(lShape, [8, 8])).toBe(false);
  });

  // A square with a smaller square hole in the middle.
  const withHole: GeoJsonPolygon = {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
      [
        [3, 3],
        [3, 7],
        [7, 7],
        [7, 3],
        [3, 3],
      ],
    ],
  };

  it('accepts a point between the outer edge and the hole', () => {
    expect(polygonContainsPoint(withHole, [1, 1])).toBe(true);
  });

  it('rejects a point inside the hole', () => {
    expect(polygonContainsPoint(withHole, [5, 5])).toBe(false);
  });

  it('rejects a point outside the outer ring entirely', () => {
    expect(polygonContainsPoint(withHole, [11, 11])).toBe(false);
  });
});

describe('polygonAreaM2', () => {
  it('computes the area of a 100m x 100m square built in the grid projection', () => {
    const originLat = 0;
    const dLon = 100 / mPerDegLon(originLat);
    const dLat = 100 / M_PER_DEG_LAT;
    const square: GeoJsonPolygon = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [dLon, 0],
          [dLon, dLat],
          [0, dLat],
          [0, 0],
        ],
      ],
    };
    expect(polygonAreaM2(square, originLat)).toBeCloseTo(10000, 3);
  });
});

describe('checkAreaEstimate', () => {
  it('passes when within tolerance', () => {
    expect(() => checkAreaEstimate(1000, 1030)).not.toThrow();
  });

  it('throws when the difference exceeds the tolerance', () => {
    expect(() => checkAreaEstimate(1000, 1200)).toThrow(/differs from the area-based estimate/);
  });

  it('defaults to AREA_ESTIMATE_TOLERANCE_PERCENT', () => {
    const justOver = 1000 * (1 + (AREA_ESTIMATE_TOLERANCE_PERCENT + 1) / 100);
    expect(() => checkAreaEstimate(1000, justOver)).toThrow();
  });
});

describe('assignGrid', () => {
  // A 4x2 synthetic grid split into two adjacent 2x2 squares: district A
  // covers columns [0, 2), district B covers columns [2, 4).
  const grid: GridParams = {
    origin_lat: 0,
    origin_lon: 0,
    grid_width: 4,
    grid_height: 2,
    cell_size_m: 100,
  };
  const dLon = 100 / mPerDegLon(0);
  const dLat = 100 / M_PER_DEG_LAT;
  const lonAt = (x: number) => x * dLon;
  const latAt = (y: number) => y * dLat;

  function square(x0: number, x1: number, y0: number, y1: number): GeoJsonPolygon {
    return {
      type: 'Polygon',
      coordinates: [
        [
          [lonAt(x0), latAt(y0)],
          [lonAt(x1), latAt(y0)],
          [lonAt(x1), latAt(y1)],
          [lonAt(x0), latAt(y1)],
          [lonAt(x0), latAt(y0)],
        ],
      ],
    };
  }

  it('assigns each cell to exactly the district containing its centre, with correct counts', () => {
    const districts: DistrictInput[] = [
      { name: 'A', geometry: square(0, 2, 0, 2) },
      { name: 'B', geometry: square(2, 4, 0, 2) },
    ];
    const result = assignGrid(grid, districts);

    expect(result.playableCells).toBe(8);
    expect(result.districts).toEqual([
      { name: 'A', index: 0, playableCells: 4 },
      { name: 'B', index: 1, playableCells: 4 },
    ]);
    expect(Array.from(result.grid)).toEqual([0, 0, 1, 1, 0, 0, 1, 1]);
    expect(districtsWithNoCells(result.districts)).toEqual([]);
  });

  it('throws GridOverlapError when two districts share a cell centre', () => {
    const districts: DistrictInput[] = [
      { name: 'A', geometry: square(0, 3, 0, 2) },
      { name: 'B', geometry: square(2, 4, 0, 2) },
    ];
    expect(() => assignGrid(grid, districts)).toThrow(GridOverlapError);
  });

  it('reports districts with zero cells', () => {
    const districts: DistrictInput[] = [
      { name: 'A', geometry: square(0, 4, 0, 2) },
      { name: 'Empty', geometry: square(100, 101, 100, 101) },
    ];
    const result = assignGrid(grid, districts);
    expect(districtsWithNoCells(result.districts)).toEqual(['Empty']);
  });
});

describe('haversineDistanceM', () => {
  it('returns zero for identical points', () => {
    expect(haversineDistanceM({ lat: 49.0135, lon: 8.4044 }, { lat: 49.0135, lon: 8.4044 })).toBe(
      0,
    );
  });

  it('matches a known reference distance (one degree of latitude at the equator)', () => {
    // One degree of latitude is ~111.19 km everywhere, by construction of
    // the great-circle formula (it does not depend on longitude).
    const distance = haversineDistanceM({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
    expect(distance).toBeGreaterThan(111000);
    expect(distance).toBeLessThan(111300);
  });

  it('is symmetric', () => {
    const a = { lat: 49.0, lon: 8.4 };
    const b = { lat: 49.01, lon: 8.41 };
    expect(haversineDistanceM(a, b)).toBeCloseTo(haversineDistanceM(b, a), 9);
  });

  it('roughly agrees with the equirectangular cell size at Karlsruhe scale', () => {
    // Two adjacent cell centres, 50 m apart by construction of cellCenter.
    const a = cellCenter(0, KARLSRUHE_GRID);
    const b = cellCenter(1, KARLSRUHE_GRID);
    expect(haversineDistanceM(a, b)).toBeCloseTo(50, 0);
  });
});
