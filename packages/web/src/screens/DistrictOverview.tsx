import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, getDistrictBoundaries, getProgress } from '../api/client.js';
import type { BoundaryFeature, BoundaryFeatureCollection } from '../api/geo-types.js';
import { BurgerMenu } from '../components/BurgerMenu.js';
import { centerOfGeometry, pointsOfGeometry, svgPathOfGeometry } from '../geo/geojson-path.js';
import { computeBoundingBox, createProjector } from '../geo/project.js';

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

// Section 8.3: every district with its individual progress percentage. The
// schematic map is the primary picker - tapping a shape selects it and the
// panel beneath the map names it - but the shapes themselves cannot meet
// Section 8.2's 44 px tap target minimum (the smallest districts are a few
// pixels across in this viewBox). That constraint is not dropped, it is
// carried by the list: WCAG 2.1 SC 2.5.5's "Equivalent" exception allows a
// small target where "the function can be achieved through a different
// control on the same page that meets this criterion", and the full list -
// collapsed under a <details> but present and operable, with its 44 px rows
// and every function the map offers - is that control. It must stay that
// way rather than become decoration. The same bargain keeps the paths out
// of the tab order (aria-hidden inside a role="img" svg): one extra tab
// stop per district ahead of the list would make the keyboard path
// materially worse, and the list already covers every function.
export function DistrictOverview() {
  const [districts, setDistricts] = useState<BoundaryFeatureCollection | null>(null);
  const [percentByName, setPercentByName] = useState<Map<string, number>>(new Map());
  const [selectedOsmId, setSelectedOsmId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([getDistrictBoundaries(), getProgress()])
      .then(([data, progress]) => {
        if (cancelled) return;
        setDistricts(data);
        setPercentByName(new Map(progress.districts.map((d) => [d.name, d.percent])));
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

  const selected =
    districts?.features.find((feature) => feature.properties.osm_id === selectedOsmId) ?? null;

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
            className={
              feature.properties.osm_id === selectedOsmId
                ? 'district-overview__district district-overview__district--selected'
                : 'district-overview__district'
            }
            d={svgPathOfGeometry(feature.geometry, project)}
            fillRule="evenodd"
            aria-hidden="true"
            onClick={() => setSelectedOsmId(feature.properties.osm_id)}
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
          <div className="district-overview__detail" role="status">
            {/* Both rows are always rendered, selected or not: the panel sits
                directly under a `width: 100%` map, so a height that depended
                on the selection changed the page height, and with it the
                scrollbar and the map's own width. See index.css. */}
            <div className="district-overview__detail-row">
              {selected ? (
                <>
                  <span className="district-overview__detail-name">{selected.properties.name}</span>
                  <span className="district-overview__detail-percent">
                    {(percentByName.get(selected.properties.name) ?? 0).toFixed(1)}%
                  </span>
                </>
              ) : (
                <span className="district-overview__detail-hint">
                  Tap a district on the map to see its progress.
                </span>
              )}
            </div>
            <div className="district-overview__detail-row">
              {selected && (
                <Link className="district-overview__detail-link" to={mapLinkFor(selected)}>
                  Open on the map
                </Link>
              )}
            </div>
          </div>
        )}
        {districts && (
          <details className="district-overview__all">
            <summary>All districts</summary>
            <ul className="district-list">
              {districts.features.map((feature) => (
                <li key={feature.properties.osm_id}>
                  <Link className="district-list__item" to={mapLinkFor(feature)}>
                    <span className="district-list__name">{feature.properties.name}</span>
                    <span className="district-list__percent">
                      {(percentByName.get(feature.properties.name) ?? 0).toFixed(1)}%
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </main>
  );
}
