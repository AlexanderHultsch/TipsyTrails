// Section 8.3's city and district overview screens draw schematic polygons
// as inline SVG rather than pulling MapLibre into the shell chunk (Section
// 12, Phase 2 budget: the shell must stay under 150 KB gzipped, and MapLibre
// alone is ~230 KB gzipped). This module is the whole of that projection: a
// plain equirectangular fit of a lon/lat bounding box into a pixel
// viewport, with longitude scaled by the cosine of the box's centre
// latitude so the shape is not stretched east-west - the same idea Section
// 6.1's toCell uses, evaluated once here for the same reason. It has no DOM
// dependency, so it is tested as plain data in, data out.

export interface LonLat {
  readonly lon: number;
  readonly lat: number;
}

export interface BoundingBox {
  readonly minLon: number;
  readonly minLat: number;
  readonly maxLon: number;
  readonly maxLat: number;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
  /** Empty margin kept on every side, in the same units as width/height. */
  readonly padding?: number;
}

export type Project = (point: LonLat) => readonly [number, number];

export function computeBoundingBox(points: readonly LonLat[]): BoundingBox {
  if (points.length === 0) {
    throw new Error('computeBoundingBox requires at least one point');
  }
  let minLon = points[0].lon;
  let maxLon = points[0].lon;
  let minLat = points[0].lat;
  let maxLat = points[0].lat;
  for (const { lon, lat } of points) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return { minLon, minLat, maxLon, maxLat };
}

/**
 * Builds a projector that fits `bbox` into `viewport`, preserving aspect
 * ratio ("contain" behaviour: scaled to fit without cropping, centred on
 * both axes, like CSS `object-fit: contain`). Longitude is scaled by the
 * cosine of the bounding box's centre latitude before fitting, so a
 * geographically square area does not come out visually stretched.
 */
export function createProjector(bbox: BoundingBox, viewport: Viewport): Project {
  const padding = viewport.padding ?? 0;
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const lonScale = Math.cos((centerLat * Math.PI) / 180);

  const spanLon = (bbox.maxLon - bbox.minLon) * lonScale;
  const spanLat = bbox.maxLat - bbox.minLat;

  const availableWidth = Math.max(viewport.width - 2 * padding, 0);
  const availableHeight = Math.max(viewport.height - 2 * padding, 0);

  const widthScale = spanLon > 0 ? availableWidth / spanLon : Infinity;
  const heightScale = spanLat > 0 ? availableHeight / spanLat : Infinity;
  // Both spans zero means a single point - fall back to an arbitrary finite
  // scale so the arithmetic below stays 0 * finite = 0 instead of 0 * Infinity.
  const scale = spanLon > 0 || spanLat > 0 ? Math.min(widthScale, heightScale) : 1;

  const usedWidth = spanLon * scale;
  const usedHeight = spanLat * scale;
  const offsetX = padding + (availableWidth - usedWidth) / 2;
  const offsetY = padding + (availableHeight - usedHeight) / 2;

  return ({ lon, lat }) => [
    offsetX + (lon - bbox.minLon) * lonScale * scale,
    // SVG y grows downward; latitude grows north (up), so the box's north
    // edge (maxLat) is what maps to y = offsetY (the top).
    offsetY + (bbox.maxLat - lat) * scale,
  ];
}
