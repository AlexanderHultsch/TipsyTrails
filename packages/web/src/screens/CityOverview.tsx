import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, getCityBoundary, getNeighbourBoundaries, getProgress } from '../api/client.js';
import type { BoundaryFeatureCollection } from '../api/geo-types.js';
import { BottomNav } from '../components/BottomNav.js';
import { pointsOfGeometry, svgPathOfGeometry } from '../geo/geojson-path.js';
import { computeBoundingBox, createProjector } from '../geo/project.js';

const VIEWPORT_WIDTH = 320;
const VIEWPORT_HEIGHT = 320;
const VIEWPORT_PADDING = 12;

// Section 8.3: Karlsruhe's outline, filled in the ink palette, with
// neighbouring municipalities drawn greyed out and non-interactive. Both
// come from packages/api/src/routes/static-data.ts, rendered as inline SVG
// rather than MapLibre (see the geo/project.ts module comment for why).
export function CityOverview() {
  const [city, setCity] = useState<BoundaryFeatureCollection | null>(null);
  const [neighbours, setNeighbours] = useState<BoundaryFeatureCollection | null>(null);
  const [cityPercent, setCityPercent] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([getCityBoundary(), getNeighbourBoundaries(), getProgress()])
      .then(([cityData, neighboursData, progress]) => {
        if (cancelled) return;
        setCity(cityData);
        setNeighbours(neighboursData);
        setCityPercent(progress.city.percent);
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

  let map: ReactNode = null;
  if (city) {
    const allPoints = [
      ...city.features.flatMap((feature) => pointsOfGeometry(feature.geometry)),
      ...(neighbours?.features.flatMap((feature) => pointsOfGeometry(feature.geometry)) ?? []),
    ];
    const bbox = computeBoundingBox(allPoints);
    const project = createProjector(bbox, {
      width: VIEWPORT_WIDTH,
      height: VIEWPORT_HEIGHT,
      padding: VIEWPORT_PADDING,
    });

    map = (
      <svg
        className="city-overview__map"
        viewBox={`0 0 ${VIEWPORT_WIDTH} ${VIEWPORT_HEIGHT}`}
        role="img"
        aria-label="Schematic map of Karlsruhe and its neighbouring municipalities"
      >
        {neighbours?.features.map((feature) => (
          <path
            key={feature.properties.osm_id}
            className="city-overview__neighbour"
            d={svgPathOfGeometry(feature.geometry, project)}
            fillRule="evenodd"
            aria-hidden="true"
            style={{ pointerEvents: 'none', cursor: 'default' }}
          />
        ))}
        {city.features.map((feature) => (
          <path
            key={feature.properties.osm_id}
            className="city-overview__city"
            d={svgPathOfGeometry(feature.geometry, project)}
            fillRule="evenodd"
          />
        ))}
      </svg>
    );
  }

  return (
    <main className="screen">
      <BottomNav />
      <div className="screen__content">
        <h1>Karlsruhe</h1>
        {loading && <p role="status">Loading the city outline…</p>}
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        {map}
        {city && <p className="city-overview__progress">{cityPercent.toFixed(1)}% explored</p>}
      </div>
      <div className="screen__actions">
        <Link className="button button--primary" to="/districts">
          View districts
        </Link>
      </div>
    </main>
  );
}
