import { describe, expect, it } from 'vitest';
import { computeBoundingBox, createProjector } from './project.js';

describe('computeBoundingBox', () => {
  it('finds the min/max lon/lat across a set of points', () => {
    const bbox = computeBoundingBox([
      { lon: 8.3, lat: 49.0 },
      { lon: 8.5, lat: 48.9 },
      { lon: 8.4, lat: 49.1 },
    ]);
    expect(bbox).toEqual({ minLon: 8.3, minLat: 48.9, maxLon: 8.5, maxLat: 49.1 });
  });

  it('throws on an empty point list rather than returning a bogus box', () => {
    expect(() => computeBoundingBox([])).toThrow();
  });
});

describe('createProjector', () => {
  it('maps a known coordinate pair to the expected SVG position, scaling longitude by the centre latitude cosine', () => {
    // Centre latitude 60 degrees: cos(60deg) halves the longitude span
    // before fitting, so the box (2deg lon x 2deg lat) is not square once
    // projected and the lon-driven scale differs from the lat-driven one -
    // exercising the cosine term rather than the identity case.
    const bbox = { minLon: 0, minLat: 59, maxLon: 2, maxLat: 61 };
    const project = createProjector(bbox, { width: 100, height: 100 });

    const [centerX, centerY] = project({ lon: 1, lat: 60 });
    expect(centerX).toBeCloseTo(50, 6);
    expect(centerY).toBeCloseTo(50, 6);

    // Without the cosine scale, width- and height-driven fits would tie and
    // this corner would land at x = 0 with no horizontal letterboxing. The
    // non-zero offset here is a direct check that longitude was scaled down
    // before the fit.
    const [cornerX, cornerY] = project({ lon: 0, lat: 61 });
    expect(cornerX).toBeCloseTo(25, 6);
    expect(cornerY).toBeCloseTo(0, 6);
  });

  it('lands a bounding-box corner exactly on a viewport corner when the projected aspect ratio already matches', () => {
    // Centre latitude 0 keeps the longitude scale exactly 1, so this square
    // bounding box fits the square viewport with no letterboxing at all.
    const bbox = { minLon: -1, minLat: -1, maxLon: 1, maxLat: 1 };
    const project = createProjector(bbox, { width: 100, height: 100 });

    expect(project({ lon: -1, lat: 1 })).toEqual([0, 0]);
    expect(project({ lon: 1, lat: -1 })).toEqual([100, 100]);
  });

  it('keeps every point inside the requested padding', () => {
    const bbox = { minLon: -1, minLat: -1, maxLon: 1, maxLat: 1 };
    const project = createProjector(bbox, { width: 100, height: 100, padding: 10 });

    expect(project({ lon: -1, lat: 1 })).toEqual([10, 10]);
    expect(project({ lon: 1, lat: -1 })).toEqual([90, 90]);
  });
});
