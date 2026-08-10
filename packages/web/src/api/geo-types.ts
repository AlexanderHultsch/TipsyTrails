// Shape of data/seed/<slug>/{city,districts,neighbours}.geojson (Section
// 11.4), as fetch-boundaries.ts writes it and packages/api/src/routes/
// static-data.ts serves it unchanged. All three files share this shape -
// a FeatureCollection of Polygon/MultiPolygon boundaries with the same
// property set - so one type covers all three.

export interface BoundaryFeatureProperties {
  osm_id: number;
  name: string;
  admin_level: number;
}

export interface PolygonGeometry {
  type: 'Polygon';
  coordinates: number[][][];
}

export interface MultiPolygonGeometry {
  type: 'MultiPolygon';
  coordinates: number[][][][];
}

export type BoundaryGeometry = PolygonGeometry | MultiPolygonGeometry;

export interface BoundaryFeature {
  type: 'Feature';
  properties: BoundaryFeatureProperties;
  geometry: BoundaryGeometry;
}

export interface BoundaryFeatureCollection {
  type: 'FeatureCollection';
  features: BoundaryFeature[];
}
