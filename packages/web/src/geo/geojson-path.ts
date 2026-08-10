import type { BoundaryGeometry } from '../api/geo-types.js';
import { computeBoundingBox } from './project.js';
import type { LonLat, Project } from './project.js';

function ringsOf(geometry: BoundaryGeometry): number[][][] {
  return geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates.flat();
}

/** Every vertex of every ring, flattened - what a bounding box is built from. */
export function pointsOfGeometry(geometry: BoundaryGeometry): LonLat[] {
  const points: LonLat[] = [];
  for (const ring of ringsOf(geometry)) {
    for (const [lon, lat] of ring) {
      points.push({ lon, lat });
    }
  }
  return points;
}

function ringPath(ring: number[][], project: Project): string {
  const segments = ring.map(([lon, lat], index) => {
    const [x, y] = project({ lon, lat });
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
  });
  return `${segments.join(' ')} Z`;
}

/**
 * Builds an SVG path `d` string for a Polygon or MultiPolygon boundary.
 * Consumers must render it with `fill-rule="evenodd"` - that makes ring
 * winding order irrelevant, so interior rings (holes) subtract correctly
 * without this function having to inspect winding itself.
 */
export function svgPathOfGeometry(geometry: BoundaryGeometry, project: Project): string {
  return ringsOf(geometry)
    .map((ring) => ringPath(ring, project))
    .join(' ');
}

/**
 * Bounding-box centre of a boundary - enough to point a map view at a
 * district (Section 8.3's "tap to zoom in"). Not an area centroid; the area
 * math that would require belongs to Section 6.3's playable_cells, not this
 * schematic screen.
 */
export function centerOfGeometry(geometry: BoundaryGeometry): LonLat {
  const bbox = computeBoundingBox(pointsOfGeometry(geometry));
  return { lon: (bbox.minLon + bbox.maxLon) / 2, lat: (bbox.minLat + bbox.maxLat) / 2 };
}
