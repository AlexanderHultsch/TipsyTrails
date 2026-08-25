import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CONFIG, toCell } from '@tipsytrails/shared';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useCurrentUser } from '../auth/CurrentUserContext.js';
import { BarSheet } from '../components/BarSheet.js';
import { BottomNav } from '../components/BottomNav.js';
import { LocateButton } from '../components/LocateButton.js';
import { NearbyBarsPanel } from '../components/NearbyBarsPanel.js';
import { PendingVisitBanner } from '../components/PendingVisitBanner.js';
import { TrackingIndicator } from '../components/TrackingIndicator.js';
import { Wordmark } from '../components/Wordmark.js';
import { useBarMarkers } from '../map/bars/useBarMarkers.js';
import { useBarStamps } from '../map/bars/useBarStamps.js';
import { useDiscoveredBars } from '../map/bars/useDiscoveredBars.js';
import { useDistrictBorders } from '../map/districts/useDistrictBorders.js';
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
// from server data. Used whenever the URL carries neither a district centre
// nor a district bounding box (see centerFromSearchParams and
// boundsFromSearchParams below).
//
// There is no INITIAL_ZOOM beside it: the opening zoom is
// CONFIG.MAP_DEFAULT_ZOOM (Section 8.3, and Section 0 rule 3 - a zoom limit
// is a constant in config.ts and never a number at the call site), used
// where the map is built below.
const INITIAL_CENTER: [number, number] = [8.4037, 49.0069];

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

/** South-west then north-east corner, each [lon, lat] - MapLibre's own order. */
type UrlBounds = [[number, number], [number, number]];

// Section 8.3: "Open on the map" frames the whole district, so the link
// carries the district's bounding box as well as its centre
// (screens/DistrictOverview.tsx). One `bbox` parameter holds it, as
// "minLon,minLat,maxLon,maxLat" - the order GeoJSON and OGC both use, and
// the same pairing as the `lon`,`lat` above, so the two parameters cannot be
// read in opposite orders by mistake.
//
// The centre stays in the URL beside it and is not replaced: it is what an
// older link carries, and it is the fallback when a box is rejected here.
//
// Validated exactly as strictly as centerFromSearchParams above, and for the
// reason its comment records - a URL is not a trusted input, and a
// wrong-but-finite value in one put the map on Null Island once. So: absent
// and blank are rejected before conversion (`Number('')` is 0 and
// `Number.isFinite(0)` is true), non-finite values are rejected (which
// covers "abc" and an overflowing exponent alike), out-of-range latitudes
// and longitudes are rejected rather than clamped, and a box whose corners
// do not increase is rejected as well. That last check is not pedantry: an
// inverted box is a caller bug, and a degenerate one - the two corners equal
// - is a point rather than an area, which `fitBounds` frames at the maximum
// zoom, i.e. exactly the too-close view this parameter exists to prevent.
function boundsFromSearchParams(params: URLSearchParams): UrlBounds | null {
  const raw = params.get('bbox')?.trim();
  if (!raw) {
    return null;
  }
  const parts = raw.split(',');
  if (parts.length !== 4) {
    return null;
  }
  const values: number[] = [];
  for (const part of parts) {
    const text = part.trim();
    if (!text) {
      return null;
    }
    const value = Number(text);
    if (!Number.isFinite(value)) {
      return null;
    }
    values.push(value);
  }
  const [minLon, minLat, maxLon, maxLat] = values;
  if (Math.abs(minLat) > 90 || Math.abs(maxLat) > 90) {
    return null;
  }
  if (Math.abs(minLon) > 180 || Math.abs(maxLon) > 180) {
    return null;
  }
  if (minLon >= maxLon || minLat >= maxLat) {
    return null;
  }
  return [
    [minLon, minLat],
    [maxLon, maxLat],
  ];
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
  // Read once at mount for the same reason, and used at the same single
  // moment: the map is built framed on this box (Section 8.3's "Open on the
  // map shows the whole district") and nothing recentres it afterwards.
  const urlBoundsRef = useRef(boundsFromSearchParams(searchParams));
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
  // Section 7.3: the district borders, above the fog so they are visible in
  // ground the player has not explored - see map/districts/district-borders.ts
  // for why appending the layer is what makes that ordering deterministic.
  useDistrictBorders(mapInstance);
  const city = useCityMaxBounds(mapInstance);
  const discoveredBars = useDiscoveredBars(trackingState.discoveryVersion);
  // Sections 7.4/8.3: walking into an unknown bar's discovery radius stamps
  // the cocktail glass onto the map at that bar. Driven by what the sample
  // response actually discovered (newBars) and not by discoveryVersion,
  // which since v1.29 also advances when a visit completes - mastering a bar
  // has its own message further down and is not a discovery.
  //
  // It returns the bars it is currently stamping, which the marker layer
  // below needs: a discovery refetches the bar list, so the stamp and that
  // bar's permanent marker are about to be two identical glasses on one
  // point (map/bars/bar-stamps.ts explains the hand-over).
  const stampingBarIds = useBarStamps(
    mapInstance,
    trackingState.newBars,
    trackingState.newBarsVersion,
  );
  // Section 7.5 step 1: tapping a marker leads to that bar, where the
  // check-in action is offered - and it does so without leaving the map.
  // Navigating to /bars/:id would unmount this screen and with it
  // useSampleTracking above, the only place position tracking runs: fog
  // reveal and sample posting would stop while the player was on the bar
  // screen, and that screen would have no live position to judge on-site
  // eligibility against. So the marker opens a sheet here instead
  // (components/BarSheet.tsx). The bar is held by id rather than by value so
  // an updated discoveredBars list (a later GET /api/bars) cannot leave the
  // sheet showing a stale copy of the bar.
  const [selectedBarId, setSelectedBarId] = useState<number | null>(null);
  useOwnPositionMarker(mapInstance, trackingState.lastPosition);
  const visits = useVisits(
    discoveredBars,
    trackingState.visitUpdates,
    trackingState.visitVersion,
    trackingState.lastPosition,
  );
  // Declared after useVisits so the tap handler below can clear a check-in
  // error left over from a different bar - opening a bar's sheet should not
  // show the failure of the last attempt at another one.
  useBarMarkers(mapInstance, discoveredBars, stampingBarIds, (bar) => {
    setSelectedBarId(bar.id);
    visits.clearCheckInError();
  });
  const outOfRangeVisitIds = new Set(visits.outOfRangeVisits.map((visit) => visit.id));
  const selectedBar = discoveredBars.find((bar) => bar.id === selectedBarId) ?? null;
  // Eligibility for the sheet's action is exactly membership of the shared
  // on-site rule's result (onsiteCandidates, packages/shared/src/visits.ts,
  // via tracking/useVisits.ts) - the same list the nearby panel names, so
  // there is one distance rule on this screen and not two. The raw position
  // itself is never held here (constraint C4, Section 10.2).
  const selectedBarOnSite =
    selectedBar !== null &&
    visits.checkInCandidates.some((candidate) => candidate.bar.id === selectedBar.id);
  // Section 5.7: at most one pending visit per bar.
  const selectedBarHasPendingVisit =
    selectedBar !== null && visits.pendingVisits.some((visit) => visit.barId === selectedBar.id);

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

    // Section 8.3, and the one place the two opening views are chosen
    // between. Arriving from a district's "Open on the map" the question is
    // "show me this district", which is a *box* and not a point at a zoom:
    // the district centre at street level showed a handful of streets of an
    // unexplored district and nothing of its shape. Every other arrival -
    // including an older link carrying only a centre - is the ordinary
    // "where am I" view and opens at MAP_DEFAULT_ZOOM.
    //
    // The framing is done by the constructor's own `bounds`, not by a
    // fitBounds call after mount, and that is deliberate: MapLibre applies
    // it during construction with no animation, so there is exactly one
    // camera move on this path, and nothing races the one-time centring
    // effect below (which stands down for a URL that framed the map at all).
    //
    // MAP_MIN_ZOOM and MAP_MAX_ZOOM still bound the result. `fitBounds`
    // clamps into the camera's zoom range, so a district too large to fit at
    // MAP_MIN_ZOOM lands at MAP_MIN_ZOOM centred on its box - as much of it
    // as the map is allowed to show - rather than zooming out past the
    // extract's coverage.
    const initialView: Pick<
      maplibregl.MapOptions,
      'bounds' | 'fitBoundsOptions' | 'center' | 'zoom'
    > = urlBoundsRef.current
      ? {
          bounds: urlBoundsRef.current,
          // Section 8.3: a box fitted edge to edge puts the district's
          // border on the edge of the screen. The margin is a constant
          // (Section 0, rule 3), never a number here.
          fitBoundsOptions: { padding: CONFIG.MAP_FIT_PADDING_PX },
        }
      : {
          center: urlCenterRef.current ?? INITIAL_CENTER,
          // Section 8.3: "the map opens at street level" - a few blocks
          // across, the scale at which a bar marker, the player's own
          // position and the 50 m grain of the fog are all legible and a
          // player can act on what they see. It opened at 12 before, a city
          // overview: a whole city of fog with nothing in it to walk
          // towards, and the city already has a screen of its own (City
          // overview, Section 8.3). The same constant serves the "to my
          // location" control below, because both answer the question "show
          // me where I am, close enough to walk from".
          zoom: CONFIG.MAP_DEFAULT_ZOOM,
        };

    const map = new maplibregl.Map({
      container: containerRef.current as HTMLDivElement,
      style: inkStyle,
      ...initialView,
      minZoom: CONFIG.MAP_MIN_ZOOM,
      maxZoom: CONFIG.MAP_MAX_ZOOM,
      // Section 8.3: the map turns but never tilts. Three options, because
      // maplibre-gl 4.7.1 has three ways into a pitched camera and closing one
      // gesture leaves the others open:
      //
      // - maxPitch 0 is the camera constraint, and it is the one that matters.
      //   Transform's pitch setter clamps into [minPitch, maxPitch], so a
      //   tilted state is unreachable however it is asked for - the two
      //   handlers below, the keyboard's shift+up/down, an easeTo/jumpTo with
      //   a pitch in it, or a style that carries one. minPitch is already 0,
      //   so this is a valid range and not a rejected one.
      // - touchPitch false removes the two-finger vertical drag, which is the
      //   gesture the owner found by accident on a phone.
      // - pitchWithRotate false removes the pitch half of drag-to-rotate
      //   (right button, or ctrl held) without removing the rotate half.
      //
      // Rotation stays, deliberately: the fog quad follows a rotated viewport
      // (map/fog/grid-geometry.ts), the direction cone subtracts the bearing
      // (map/position/own-position-marker.ts) and the canvas fallback measures
      // a cell as a distance rather than an x offset - all three were built
      // for a turning map, and dragRotate/touchZoomRotate are left alone.
      pitch: 0,
      maxPitch: 0,
      touchPitch: false,
      pitchWithRotate: false,
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
  // as a glitch rather than as help. The zoom is left alone - it is already
  // CONFIG.MAP_DEFAULT_ZOOM from the mount above, so there is nothing this
  // move needs to correct, unlike the explicit control further down which
  // can be tapped from any zoom the player has since chosen.
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
    // A URL that framed the map - by centre, by bounding box, or by both -
    // is an explicit request and wins over this automatic one. Both are
    // checked, not only the centre: a link carrying a box alone would
    // otherwise be undone by the first fix that arrived.
    if (
      centredOnPlayerRef.current ||
      urlCenterRef.current !== null ||
      urlBoundsRef.current !== null
    ) {
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
  //
  // It sets the zoom as well as the centre, and Section 8.3 says why:
  // recentring while keeping whatever zoom the map happened to be on answers
  // the wrong question - a player zoomed far out taps it and gets their
  // position in the middle of a city-wide view they still cannot walk from.
  // The same constant as the opening view, because both mean "show me where
  // I am, close enough to walk from". The map picker on Suggest a bar
  // (map/MapPicker.tsx) deliberately does *not* do this: someone who zoomed
  // in to place a pin precisely would lose the precision they zoomed in for.
  function handleGoToMyLocation() {
    const position = trackingState.lastPosition;
    if (!mapInstance || !position) {
      return;
    }
    mapInstance.flyTo({
      center: [position.lon, position.lat],
      zoom: CONFIG.MAP_DEFAULT_ZOOM,
    });
  }

  return (
    <main className="screen screen--map">
      <div ref={containerRef} className="map-container" />
      {/* Section 8.3, "no map overlay may obscure another": every overlay on
          this screen sits in this one container, which lays them out as a
          grid of rows over the map (index.css, .map-overlays) instead of
          each of them being positioned against the map on its own. A row
          owns its band of the screen, so a corner control cannot land on a
          full-width bar - and an overlay added later goes into a row rather
          than on top of everything. Each row is a wrapper element that is
          always rendered, even when what it holds is not: the rows are what
          the grid places, and an empty one simply has no height.
          The nesting is load-bearing too - the container passes pointer
          events through so the map stays draggable, and the overlays take
          them back one level further in. */}
      <div className="map-overlays">
        <div className="map-overlays__top-bars">
          <PendingVisitBanner
            visits={visits.pendingVisits}
            outOfRangeVisitIds={outOfRangeVisitIds}
            cancellingVisitId={visits.cancellingVisitId}
            cancelError={visits.cancelError}
            onCancel={(visitId) => void visits.cancelVisit(visitId)}
          />
        </div>
        {/* The owner's specification for the tab bar, section 1: the status
            indicator cluster stays exactly where it is. It has the wordmark
            for company since Section 8.1's branding pass, and that costs it
            nothing: this row is `justify-content: space-between`, so a second
            child takes the opposite end and the indicator does not move a
            pixel from the corner it has always been in. Which is also why the
            wordmark is second in the markup and not first.
            The owner asked for it "small and elegant on the map" - the chrome
            prominence, a member of the overlay grid like everything else on
            this screen rather than something absolutely positioned on top of
            it (Section 8.3). It is a mark and never a control: index.css
            gives it back the pointer-events this row's children otherwise
            take, so it cannot eat a drag in the corner it sits in. */}
        <div className="map-overlays__controls map-overlays__controls--top">
          <TrackingIndicator state={trackingState} />
          <Wordmark prominence="chrome" />
        </div>
        <div className="map-overlays__middle">
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
          {/* Section 7.3: the reveal rule skips a sample taken at or above
              FOG_MAX_SPEED_KMH, and until now it did so in silence - the
              owner sat on a train watching a map that never cleared and was
              told nothing. The verdict comes from the server's own response
              (tooFastToReveal, packages/api/src/routes/fog.ts) rather than
              from position.speed here, because the server is what applies
              the rule and the only side that can derive a speed for a fix
              that carries none.

              First among the toasts, so the transient ones below can come
              and go beneath a message that stays for as long as its
              condition does. It clears itself: every successful post
              replaces the flag, so this disappears on the first batch the
              player is slow enough for. */}
          {trackingState.tooFastToReveal && (
            <div className="map-toast map-toast--speed" role="status">
              <p>You&apos;re moving too fast to reveal new ground.</p>
              <p>Slow down and the map starts clearing again.</p>
            </div>
          )}
          {/* Phase 8 task brief, part C: a new account's first view of the
              map is otherwise just fog and no markers, with nothing telling
              them what to do next. Gone for good once the first bar is
              discovered - discoveredBars only ever grows. */}
          {discoveredBars.length === 0 && (
            <div className="map-toast" role="status">
              <p>No bars discovered yet - walk toward one to reveal it here.</p>
            </div>
          )}
          {/* There is deliberately no "Revealed N new areas" message here,
              and its absence is a decision rather than an omission. It fired
              on every batch that cleared a cell, which on a walk is most of
              them, so a player got a running commentary on the one thing the
              map is already showing them: the fog receding is its own
              feedback, and Section 7.3's crisp edge exists to be exactly
              that. A count of 50 m cells is not a number anyone can act on
              either. What the map still announces is what a player cannot
              see happen for themselves - a bar coming into range, and the
              hint above for someone who has yet to find one. */}
          {visits.justMastered.length > 0 && (
            <div className="map-toast map-toast--mastered" role="status">
              <p>{visits.justMastered.join(', ')} mastered.</p>
              <p>Mastering is permanent - it stays even if a later visit expires.</p>
            </div>
          )}
        </div>
        <div className="map-overlays__controls map-overlays__controls--bottom">
          <LocateButton
            disabled={trackingState.lastPosition === null}
            onClick={handleGoToMyLocation}
          />
          <a
            className="map-attribution"
            href="https://www.openstreetmap.org/copyright"
            target="_blank"
            rel="noopener noreferrer"
          >
            © OpenStreetMap contributors
          </a>
        </div>
        <div className="map-overlays__bottom-bars">
          {selectedBar !== null && (
            <BarSheet
              bar={selectedBar}
              onSite={selectedBarOnSite}
              hasPendingVisit={selectedBarHasPendingVisit}
              checkingIn={visits.checkingIn}
              checkInError={visits.checkInError}
              onCheckIn={(barId) => void handleCheckIn(barId)}
              onClose={() => {
                setSelectedBarId(null);
                visits.clearCheckInError();
              }}
            />
          )}
          <NearbyBarsPanel candidates={visits.checkInCandidates} />
        </div>
      </div>
      {/* Deliberately outside .map-overlays, and it is the one element on
          this screen that is. The tab bar is not a map overlay: it is app
          chrome that every signed-in screen carries, and it sits below the
          overlay grid rather than in it. .map-overlays reserves its height
          (index.css, --bottom-nav-space), so row 4's attribution - Section
          10.5, which requires it persistently visible and legible - is above
          the bar rather than behind it. Put inside the grid instead, the bar
          would be a sixth row that only the map has, and it would move with
          the rows above it. */}
      <BottomNav />
    </main>
  );
}
