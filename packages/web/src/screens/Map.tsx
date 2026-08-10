import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { useSearchParams } from 'react-router-dom';
import { CONFIG } from '@tipsytrails/shared';
import 'maplibre-gl/dist/maplibre-gl.css';
import { BurgerMenu } from '../components/BurgerMenu.js';
import { TrackingIndicator } from '../components/TrackingIndicator.js';
import { inkStyle } from '../map/ink-style.js';
import { useSampleTracking } from '../tracking/useSampleTracking.js';

const TILES_URL = `/tiles/${CONFIG.TILES_FILENAME}`;

// Roughly the middle of Karlsruhe's bounding box (Section 6.2). There is no
// city-metadata endpoint wired up in this phase (that is /api/city -
// Section 9.2), so this is a fixed fallback view rather than one derived
// from server data. Used whenever the URL doesn't carry a district centre
// (see centerFromSearchParams below).
const INITIAL_CENTER: [number, number] = [8.4037, 49.0069];
const INITIAL_ZOOM = 12;

// Section 13.2: the tile extract may simply not be installed on this
// server, in which case /tiles/<filename> answers 503 with
// code: "tiles_unavailable". MapLibre's own tile-loading error events don't
// carry that response body, so this is a separate, deliberately minimal
// probe whose only job is to notice that specific state and say so in
// plain language - independent of whatever the map itself does with a
// source it can't load.
async function checkTilesAvailable(): Promise<boolean> {
  const response = await fetch(TILES_URL, { headers: { Range: 'bytes=0-0' } });
  return response.status !== 503;
}

// Section 8.3: "tap to zoom in" from the district overview. There is no
// shared app state layer in this phase to carry the tapped district's
// position to this route any other way, so screens/DistrictOverview.tsx
// passes it through the URL instead. Read once at mount, same as
// INITIAL_CENTER below - this route has no in-place "recentre" affordance,
// so a stale value if the query changes without a remount is out of scope.
function centerFromSearchParams(params: URLSearchParams): [number, number] | null {
  const lat = Number(params.get('lat'));
  const lon = Number(params.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  return [lon, lat];
}

export function MapScreen() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [tilesUnavailable, setTilesUnavailable] = useState(false);
  const [searchParams] = useSearchParams();
  const trackingState = useSampleTracking();

  useEffect(() => {
    let cancelled = false;

    checkTilesAvailable()
      .then((available) => {
        if (!cancelled && !available) {
          setTilesUnavailable(true);
        }
      })
      .catch(() => {
        // A network failure surfaces through the map's own tile-loading
        // errors; there is nothing more specific to say here.
      });

    const protocol = new Protocol();
    maplibregl.addProtocol('pmtiles', protocol.tile);

    const map = new maplibregl.Map({
      container: containerRef.current as HTMLDivElement,
      style: inkStyle,
      center: centerFromSearchParams(searchParams) ?? INITIAL_CENTER,
      zoom: INITIAL_ZOOM,
      attributionControl: false,
    });
    mapRef.current = map;

    return () => {
      cancelled = true;
      mapRef.current = null;
      map.remove();
      maplibregl.removeProtocol('pmtiles');
    };
    // Deliberately mount-only (Section 8.3's "tap to zoom in" is a one-time
    // initial centre, not a live-recentre feature) - see the comment on
    // centerFromSearchParams above.
  }, []);

  return (
    <main className="screen screen--map">
      <BurgerMenu />
      <TrackingIndicator state={trackingState} />
      <div ref={containerRef} className="map-container" />
      {tilesUnavailable && (
        <div className="map-notice" role="status">
          <p>
            Map tiles aren&apos;t installed on this server yet. The rest of Tipsy Trails works
            normally - only the map is affected.
          </p>
        </div>
      )}
      {trackingState.lastNewCells !== null && trackingState.lastNewCells > 0 && (
        <div className="map-toast" role="status">
          <p>
            Revealed {trackingState.lastNewCells} new area
            {trackingState.lastNewCells === 1 ? '' : 's'}.
          </p>
        </div>
      )}
      <a
        className="map-attribution"
        href="https://www.openstreetmap.org/copyright"
        target="_blank"
        rel="noopener noreferrer"
      >
        © OpenStreetMap contributors
      </a>
    </main>
  );
}
