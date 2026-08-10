import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, getDistrictBoundaries } from '../api/client.js';
import type { BoundaryFeature, BoundaryFeatureCollection } from '../api/geo-types.js';
import { BurgerMenu } from '../components/BurgerMenu.js';
import { centerOfGeometry, pointsOfGeometry, svgPathOfGeometry } from '../geo/geojson-path.js';
import { computeBoundingBox, createProjector } from '../geo/project.js';
import { PLACEHOLDER_PROGRESS_PERCENT } from './placeholder-progress.js';

const VIEWPORT_WIDTH = 320;
const VIEWPORT_HEIGHT = 320;
const VIEWPORT_PADDING = 12;

function mapLinkFor(feature: BoundaryFeature): string {
  // Section 8.3: "tap to zoom in." There is no shared app state carrying
  // the pick from here to the map route, so the tapped district's centre
  // travels through the URL instead - the map route reads it back in
  // screens/Map.tsx.
  const center = centerOfGeometry(feature.geometry);
  const params = new URLSearchParams({
    district: feature.properties.name,
    lat: center.lat.toFixed(6),
    lon: center.lon.toFixed(6),
  });
  return `/map?${params.toString()}`;
}

// Section 8.3: all 27 districts with individual progress percentages. The
// list is the primary interface (27 polygons on a phone screen fail
// Section 8.2's 44 px tap target minimum); the schematic map alongside it
// is secondary and purely illustrative, so it stays non-interactive rather
// than duplicating the list's tap targets at a size that would violate 8.2.
export function DistrictOverview() {
  const [districts, setDistricts] = useState<BoundaryFeatureCollection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getDistrictBoundaries()
      .then((data) => {
        if (!cancelled) setDistricts(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  let map = null;
  if (districts) {
    const allPoints = districts.features.flatMap((feature) => pointsOfGeometry(feature.geometry));
    const bbox = computeBoundingBox(allPoints);
    const project = createProjector(bbox, {
      width: VIEWPORT_WIDTH,
      height: VIEWPORT_HEIGHT,
      padding: VIEWPORT_PADDING,
    });

    map = (
      <svg
        className="district-overview__map"
        viewBox={`0 0 ${VIEWPORT_WIDTH} ${VIEWPORT_HEIGHT}`}
        role="img"
        aria-label="Schematic map of Karlsruhe's districts"
      >
        {districts.features.map((feature) => (
          <path
            key={feature.properties.osm_id}
            className="district-overview__district"
            d={svgPathOfGeometry(feature.geometry, project)}
            fillRule="evenodd"
            aria-hidden="true"
            style={{ pointerEvents: 'none', cursor: 'default' }}
          />
        ))}
      </svg>
    );
  }

  return (
    <main className="screen">
      <BurgerMenu />
      <div className="screen__content">
        <h1>Districts</h1>
        {loading && <p role="status">Loading districts…</p>}
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        {map}
        {districts && (
          <ul className="district-list">
            {districts.features.map((feature) => (
              <li key={feature.properties.osm_id}>
                <Link className="district-list__item" to={mapLinkFor(feature)}>
                  <span className="district-list__name">{feature.properties.name}</span>
                  <span className="district-list__percent">{PLACEHOLDER_PROGRESS_PERCENT}%</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
