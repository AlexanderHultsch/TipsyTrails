import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CONFIG, toCell } from '@tipsytrails/shared';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useCurrentUser } from '../auth/CurrentUserContext.js';
import { BurgerMenu } from '../components/BurgerMenu.js';
import { CheckInPanel } from '../components/CheckInPanel.js';
import { PendingVisitBanner } from '../components/PendingVisitBanner.js';
import { TrackingIndicator } from '../components/TrackingIndicator.js';
import { useBarMarkers } from '../map/bars/useBarMarkers.js';
import { useDiscoveredBars } from '../map/bars/useDiscoveredBars.js';
import { useFogLayer } from '../map/fog/useFogLayer.js';
import { inkStyle } from '../map/ink-style.js';
import { useCityMaxBounds } from '../map/useCityMaxBounds.js';
import { useOwnPositionMarker } from '../map/position/useOwnPositionMarker.js';
import {
  hasSeenMasteringExplainer,
  markMasteringExplainerSeen,
} from '../tracking/masteringExplainer.js';
import { useSampleTracking } from '../tracking/useSampleTracking.js';
import { useVisits } from '../tracking/useVisits.js';

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
//
// The absent case has to be rejected before the values are converted, not
// after: `params.get` answers null for a missing key, `Number(null)` is 0,
// and `Number.isFinite(0)` is true - so a plain visit to /map returned
// [0, 0] and centred the map on Null Island, five thousand kilometres from
// any tile this extract contains. MapLibre then requested no tiles at all
// (correctly - none cover that point), reported no error, and drew the
// paper background, which is indistinguishable from a fully fogged city.
// The empty string coerces to 0 the same way, so blank values are rejected
// too. The range check is here for the same reason: any centre outside the
// extract fails this silently, and a wrong-but-finite coordinate in a URL
// should fall back to the city rather than reproduce that.
function centerFromSearchParams(params: URLSearchParams): [number, number] | null {
  const rawLat = params.get('lat')?.trim();
  const rawLon = params.get('lon')?.trim();
  if (!rawLat || !rawLon) {
    return null;
  }
  const lat = Number(rawLat);
  const lon = Number(rawLon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return null;
  }
  return [lon, lat];
}

export function MapScreen() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [tilesUnavailable, setTilesUnavailable] = useState(false);
  // MapLibre reports a failed style, source or tile load through its own
  // `error` event and nowhere else - it does not throw, and it does not
  // render anything to say so. Without this the map fails to exactly what
  // an empty map looks like: the paper background and no features, which
  // is indistinguishable from a fully fogged city. The first error is kept
  // rather than the last, because later ones are usually consequences of
  // it (every subsequent tile request against a source that never loaded).
  const [mapError, setMapError] = useState<string | null>(null);
  // A state, not a ref: Section 7.3's fog layer (useFogLayer below) needs a
  // render to see the map instance once the mount effect creates it - a
  // ref update alone would not schedule one.
  const [mapInstance, setMapInstance] = useState<maplibregl.Map | null>(null);
  const [searchParams] = useSearchParams();
  // Read once at mount, for the same reason centerFromSearchParams itself
  // is (see its comment): the map is built from it in a mount-only effect,
  // and the one-time centring below has to answer "did the URL carry a
  // district centre?" long after that, without re-reading a query that may
  // have changed underneath it.
  const urlCenterRef = useRef(centerFromSearchParams(searchParams));
  // Whether the map has already been centred on the player. A ref, not
  // state: this is a latch the effect below reads and sets, and a re-render
  // on flipping it would buy nothing.
  const centredOnPlayerRef = useRef(false);
  const navigate = useNavigate();
  const { user } = useCurrentUser();
  const trackingState = useSampleTracking();
  // Phase 8 task brief, part B (reviewer finding): the fog cache is keyed
  // per user (map/fog/fog-cache.ts) - this screen is RequireAuth-guarded,
  // so `user` is already resolved by the time it mounts, but the `null`
  // fallback keeps useFogLayer's own contract honest for the type.
  useFogLayer(mapInstance, trackingState.revealVersion, user?.id ?? null);
  const city = useCityMaxBounds(mapInstance);
  const discoveredBars = useDiscoveredBars(trackingState.discoveryVersion);
  // Section 8.3: "opening a marker leads to the [bar] detail" screen.
  useBarMarkers(mapInstance, discoveredBars, (bar) => navigate(`/bars/${bar.id}`));
  useOwnPositionMarker(mapInstance, trackingState.lastPosition);
  const visits = useVisits(
    discoveredBars,
    trackingState.visitUpdates,
    trackingState.visitVersion,
    trackingState.lastPosition,
  );
  const outOfRangeVisitIds = new Set(visits.outOfRangeVisits.map((visit) => visit.id));

  // Section 7.5: the new pending visit appears in the banner immediately
  // (useVisits.ts's own state update), and the explainer is shown once,
  // automatically, right after the first successful check-in
  // (tracking/masteringExplainer.ts) - not on a failed one.
  async function handleCheckIn(barId: number) {
    const success = await visits.checkIn(barId);
    if (success && !hasSeenMasteringExplainer()) {
      markMasteringExplainerSeen();
      navigate('/how-it-works');
    }
  }

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
      center: urlCenterRef.current ?? INITIAL_CENTER,
      zoom: INITIAL_ZOOM,
      minZoom: CONFIG.MAP_MIN_ZOOM,
      maxZoom: CONFIG.MAP_MAX_ZOOM,
      attributionControl: false,
    });
    map.on('error', (event) => {
      const message = event.error?.message ?? String(event.error ?? 'unknown error');
      setMapError((previous) => previous ?? message);
    });
    setMapInstance(map);

    return () => {
      cancelled = true;
      setMapInstance(null);
      map.remove();
      maplibregl.removeProtocol('pmtiles');
    };
    // Deliberately mount-only (Section 8.3's "tap to zoom in" is a one-time
    // initial centre, not a live-recentre feature) - see the comment on
    // centerFromSearchParams above.
  }, []);

  // Section 8.3: the map opens on the city, then moves to the player once
  // their device has produced a fix - once per mount, so it never fights
  // whoever is panning the map afterwards. jumpTo rather than flyTo: the
  // screen has just opened and an animation away from the city centre reads
  // as a glitch rather than as help. The zoom is left alone.
  //
  // Only for a player who is actually inside the playable grid. Centring on
  // one who is not shows them an empty map - the extract covers nothing
  // there, MapLibre requests no tiles and reports no error, and the result
  // is indistinguishable from a fully fogged city (the same failure
  // centerFromSearchParams's own comment above describes).
  //
  // The city metadata and the first fix arrive independently and in either
  // order, so this waits for both rather than assuming one comes first. The
  // first fix that can be judged decides, and consumes the latch whether or
  // not it moved the map: someone opening the app on a train approaching the
  // city would otherwise have the map yanked out from under them minutes
  // later, mid-pan, which is what "never automatically again" rules out. The
  // "to my location" control below covers the arriving player as an explicit
  // action instead.
  useEffect(() => {
    const position = trackingState.lastPosition;
    if (!mapInstance || !city || !position) {
      return;
    }
    if (centredOnPlayerRef.current || urlCenterRef.current !== null) {
      return;
    }
    centredOnPlayerRef.current = true;
    const cell = toCell(position.lat, position.lon, {
      origin_lat: city.originLat,
      origin_lon: city.originLon,
      grid_width: city.gridWidth,
      grid_height: city.gridHeight,
      cell_size_m: city.cellSizeM,
    });
    if (cell === null) {
      return;
    }
    mapInstance.jumpTo({ center: [position.lon, position.lat] });
  }, [mapInstance, city, trackingState.lastPosition]);

  // Section 8.3's "to my location" control. flyTo, not jumpTo: unlike the
  // automatic centring above this is an explicit request, so the animation
  // is what tells the player where they were taken from. It honours a
  // position outside the grid for the same reason - the pan limit
  // (useCityMaxBounds) then simply stops the map at the city's edge.
  function handleGoToMyLocation() {
    const position = trackingState.lastPosition;
    if (!mapInstance || !position) {
      return;
    }
    mapInstance.flyTo({ center: [position.lon, position.lat] });
  }

  return (
    <main className="screen screen--map">
      <BurgerMenu />
      <TrackingIndicator state={trackingState} />
      <div ref={containerRef} className="map-container" />
      {/* Disabled rather than hidden while there is no fix yet: a control
          that appears and disappears is harder to find than one that is
          visibly inert. */}
      <button
        type="button"
        className="map-locate"
        aria-label="Go to my location"
        disabled={trackingState.lastPosition === null}
        onClick={handleGoToMyLocation}
      >
        <span aria-hidden="true">&#9678;</span>
      </button>
      <PendingVisitBanner visits={visits.pendingVisits} outOfRangeVisitIds={outOfRangeVisitIds} />
      <CheckInPanel
        candidates={visits.checkInCandidates}
        onCheckIn={(barId) => void handleCheckIn(barId)}
        checkingIn={visits.checkingIn}
        checkInError={visits.checkInError}
      />
      {tilesUnavailable && (
        <div className="map-notice" role="status">
          <p>
            Map tiles aren&apos;t installed on this server yet. The rest of Tipsy Trails works
            normally - only the map is affected.
          </p>
        </div>
      )}
      {/* Only when the extract is installed: a 503 from /tiles/ produces
          both states at once, and the notice above is the one that names
          the actual cause. The raw MapLibre message is shown rather than
          hidden - a blank map is not diagnosable without it, and this is
          the only place it is ever visible outside a browser console. */}
      {!tilesUnavailable && mapError !== null && (
        <div className="map-notice" role="alert">
          <p>The map could not be loaded.</p>
          <p className="map-notice__detail">{mapError}</p>
        </div>
      )}
      {/* Phase 8 task brief, part C: a new account's first view of the map
          is otherwise just fog and no markers, with nothing telling them
          what to do next. Gone for good once the first bar is discovered -
          discoveredBars only ever grows. */}
      {discoveredBars.length === 0 && (
        <div className="map-toast" role="status">
          <p>No bars discovered yet - walk toward one to reveal it here.</p>
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
      {visits.justMastered.length > 0 && (
        <div className="map-toast map-toast--mastered" role="status">
          <p>{visits.justMastered.join(', ')} mastered.</p>
          <p>Mastering is permanent - it stays even if a later visit expires.</p>
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
