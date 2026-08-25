// Shape of data/seed/<slug>/{city,districts,neighbours}.geojson (Section
// 11.4), as fetch-boundaries.ts writes it and packages/api/src/routes/
// static-data.ts serves it unchanged. All three files share this shape -
// a FeatureCollection of Polygon/MultiPolygon boundaries with the same
// property set - so one type covers all three.

// A type alias rather than an interface, and that is load-bearing rather
// than a style choice. MapLibre wants a `GeoJSON.FeatureCollection`, whose
// `properties` is `GeoJsonProperties` - an index-signature type. TypeScript
// gives an object *type alias* an implicit index signature but never gives
// an interface one, so declaring this as an interface is precisely what
// used to make `BoundaryFeatureCollection` structurally incompatible with
// GeoJSON and force a double cast at the one place that hands it to the map
// (map/districts/district-borders.ts). As an alias the collection satisfies
// `GeoJSON.FeatureCollection` on its own and the cast is gone.
type BoundaryFeatureProperties = {
  osm_id: number;
  name: string;
  admin_level: number;
};

// The two members of BoundaryGeometry below. Not exported: every consumer
// (geo/geojson-path.ts, the overview screens) works on the union and
// narrows it by `type`, so neither member is ever named on its own.
interface PolygonGeometry {
  type: 'Polygon';
  coordinates: number[][][];
}

interface MultiPolygonGeometry {
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
