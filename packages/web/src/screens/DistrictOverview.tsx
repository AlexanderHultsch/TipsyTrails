import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { errorMessage, getDistrictBoundaries, getProgress } from '../api/client.js';
import type { BoundaryFeature, BoundaryFeatureCollection } from '../api/geo-types.js';
import { BottomNav } from '../components/BottomNav.js';
import { centerOfGeometry, pointsOfGeometry, svgPathOfGeometry } from '../geo/geojson-path.js';
import { computeBoundingBox, createProjector } from '../geo/project.js';

const VIEWPORT_WIDTH = 320;
const VIEWPORT_HEIGHT = 320;
const VIEWPORT_PADDING = 12;

// Six decimal places is about 0.1 m at this latitude - far finer than
// anything a district boundary is surveyed to, and the same precision the
// centre has always been written at.
const URL_COORDINATE_DIGITS = 6;

function mapLinkFor(feature: BoundaryFeature): string {
  // Section 8.3: "tap to zoom in." There is no shared app state carrying
  // the pick from here to the map route, so the tapped district travels
  // through the URL instead - the map route reads it back in
  // screens/Map.tsx.
  //
  // The bounding box is what answers the link's own promise. The centre
  // alone could only say "put the camera here", and the map then opened at
  // MAP_DEFAULT_ZOOM - street level, which is right for "where am I" and
  // wrong for "show me this district": an unexplored district arrived as a
  // few streets of fog with none of its shape. A box says how much to show
  // as well as where, so a large district and a small one both arrive
  // framed.
  //
  // The centre is still sent beside it, and not as a redundancy: it is what
  // an older link carries, and it is what screens/Map.tsx falls back to if
  // it rejects the box.
  const center = centerOfGeometry(feature.geometry);
  const bbox = computeBoundingBox(pointsOfGeometry(feature.geometry));
  const params = new URLSearchParams({
    district: feature.properties.name,
    lat: center.lat.toFixed(URL_COORDINATE_DIGITS),
    lon: center.lon.toFixed(URL_COORDINATE_DIGITS),
    // "minLon,minLat,maxLon,maxLat" - GeoJSON's own bbox order, and the same
    // lon-before-lat pairing as the two parameters above.
    bbox: [bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat]
      .map((value) => value.toFixed(URL_COORDINATE_DIGITS))
      .join(','),
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
        setError(errorMessage(err));
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
      <BottomNav />
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
                scrollbar and the map's own width. See index.css.

                The hint is rendered in both states for the same reason one
                level further down. Reserving the row was not enough: the hint
                wraps to two lines on a phone and a district name never does,
                so the row itself was two lines tall before the first tap and
                one line tall after it. Kept in the flow and hidden rather than
                swapped out, it is the row's own measure of its tallest state -
                which is what makes this survive a longer name, a larger font
                and a narrower screen, where a hard-coded height would not.

                aria-hidden as well as the stylesheet's `visibility: hidden`,
                which already takes it out of the accessibility tree: this
                panel is a `role="status"` live region, and the instruction
                must not be read out again behind the selection it is
                reserving space for. */}
            <div className="district-overview__detail-row district-overview__detail-row--primary">
              <span
                className={
                  selected
                    ? 'district-overview__detail-hint district-overview__detail-hint--reserved'
                    : 'district-overview__detail-hint'
                }
                aria-hidden={selected ? true : undefined}
              >
                Tap a district on the map to see its progress.
              </span>
              {selected && (
                <span className="district-overview__detail-selection">
                  <span className="district-overview__detail-name">{selected.properties.name}</span>
                  <span className="district-overview__detail-percent">
                    {(percentByName.get(selected.properties.name) ?? 0).toFixed(1)}%
                  </span>
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
