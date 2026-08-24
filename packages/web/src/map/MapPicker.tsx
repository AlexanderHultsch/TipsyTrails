import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { CONFIG, toCell } from '@tipsytrails/shared';
import 'maplibre-gl/dist/maplibre-gl.css';
import { LocateButton } from '../components/LocateButton.js';
import { getLastKnownPosition } from '../tracking/lastKnownPosition.js';
import { inkStyle } from './ink-style.js';
import { useOwnPositionMarker } from './position/useOwnPositionMarker.js';
import { useCityMaxBounds } from './useCityMaxBounds.js';

// Same fallback view screens/Map.tsx uses (roughly the middle of
// Karlsruhe's bounding box, Section 6.2), for when this session has no
// known position to open at - see tracking/lastKnownPosition.ts.
const INITIAL_CENTER: [number, number] = [8.4037, 49.0069];
const INITIAL_ZOOM = 14;

const PIN_SVG_PATH =
  'M12 2C7.6 2 4 5.6 4 10c0 6 8 12 8 12s8-6 8-12c0-4.4-3.6-8-8-8zm0 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6z';

export interface PickedPosition {
  lat: number;
  lon: number;
}

interface MapPickerProps {
  value: PickedPosition | null;
  onPick: (position: PickedPosition) => void;
}

// SPEC.md Section 11.3: "a map picker to place the pin (mandatory - this is
// how position is set, not geocoding)". Mounts its own MapLibre instance -
// the same ink style and pmtiles protocol registration screens/Map.tsx
// uses - and reports whatever position the user taps. The pin itself is a
// positioned DOM element reprojected via map.project on 'move', the same
// approach map/bars/bar-markers.ts takes for bar markers rather than
// maplibregl.Marker, for the same testability reason that file states.
export function MapPicker({ value, onPick }: MapPickerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [mapInstance, setMapInstance] = useState<maplibregl.Map | null>(null);
  const [pinPoint, setPinPoint] = useState<{ x: number; y: number } | null>(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  // Whoever is suggesting a bar is usually standing in front of it. The
  // position the map screen last accepted this session is the instant
  // answer when there is one - already granted, no permission round-trip -
  // so it is read once at mount, the same one-time read screens/Map.tsx
  // makes of its URL centre, and serves both as the map's initial centre
  // and as the position the control below starts out with.
  const storedPositionRef = useRef(getLastKnownPosition());
  const [ownPosition, setOwnPosition] = useState<PickedPosition | null>(() => {
    const stored = storedPositionRef.current;
    return stored === null ? null : { lat: stored.lat, lon: stored.lon };
  });
  // Whether the map has already been centred on the player - the same latch
  // screens/Map.tsx keeps, and for the same reason. Already spent when the
  // map was built at the stored position: it is on that position, and
  // nothing should move it again.
  const centredOnPositionRef = useRef(storedPositionRef.current !== null);

  const city = useCityMaxBounds(mapInstance);
  // The same marker the map screen shows (map/position/own-position-marker.ts),
  // not a second treatment: centring on yourself is only half an answer if you
  // cannot see where "yourself" is. It stays clearly apart from the pin below -
  // accent red against ink, a haloed dot against a teardrop, centred on its
  // point rather than hanging above it - and it takes no taps, so the spot
  // under it is still selectable.
  useOwnPositionMarker(mapInstance, ownPosition);

  useEffect(() => {
    const protocol = new Protocol();
    maplibregl.addProtocol('pmtiles', protocol.tile);

    const stored = storedPositionRef.current;
    const map = new maplibregl.Map({
      container: containerRef.current as HTMLDivElement,
      style: inkStyle,
      center: stored ? [stored.lon, stored.lat] : INITIAL_CENTER,
      zoom: INITIAL_ZOOM,
      minZoom: CONFIG.MAP_MIN_ZOOM,
      maxZoom: CONFIG.MAP_MAX_ZOOM,
      // Section 8.3: the same four options screens/Map.tsx sets, and for the
      // same reasons - see the comment there for what each one closes. This
      // map has its own reason to want them beyond matching: the pin is a DOM
      // element positioned from map.project (reposition below), and a tilted
      // camera would place it correctly while the tap that set it landed on
      // ground the player had judged by eye at a different angle. A picker is
      // for pointing at a spot, so the camera stays overhead.
      pitch: 0,
      maxPitch: 0,
      touchPitch: false,
      pitchWithRotate: false,
      attributionControl: false,
    });
    setMapInstance(map);

    return () => {
      setMapInstance(null);
      map.remove();
      maplibregl.removeProtocol('pmtiles');
    };
  }, []);

  // tracking/lastKnownPosition.ts is only ever written by the map screen, so
  // opening /suggest directly - or after a reload - finds it empty and the
  // picker opened on the city centre instead of where the player is
  // standing. It therefore asks for a fix itself when there is nothing
  // stored: one shot, deliberately not watchPosition, and deliberately not
  // tracking/useSampleTracking.ts - that hook watches continuously *and*
  // POSTs samples, neither of which may happen from this screen. The fix
  // lives in this component's state and nowhere else (constraint C4 /
  // Section 10.2: raw positions are never persisted).
  useEffect(() => {
    if (storedPositionRef.current !== null || !('geolocation' in navigator)) {
      return;
    }
    let cancelled = false;
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (cancelled) {
          return;
        }
        setOwnPosition({ lat: position.coords.latitude, lon: position.coords.longitude });
      },
      () => {
        // Denied, unavailable, or no fix in time: the picker stays on the
        // city centre it opened at and the control below stays disabled.
        // There is nothing more useful to say here.
      },
      { enableHighAccuracy: true },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // A fix that arrives after the map is already built centres it, once,
  // exactly the way screens/Map.tsx does: jumpTo rather than flyTo (the
  // screen has just opened, an animation reads as a glitch), and only for a
  // position inside the playable grid. Outside it the map stays on the city
  // - the tile extract covers nothing there, so centring would show an empty
  // map, which is indistinguishable from a failure.
  useEffect(() => {
    if (!mapInstance || !city || !ownPosition || centredOnPositionRef.current) {
      return;
    }
    centredOnPositionRef.current = true;
    const cell = toCell(ownPosition.lat, ownPosition.lon, {
      origin_lat: city.originLat,
      origin_lon: city.originLon,
      grid_width: city.gridWidth,
      grid_height: city.gridHeight,
      cell_size_m: city.cellSizeM,
    });
    if (cell === null) {
      return;
    }
    mapInstance.jumpTo({ center: [ownPosition.lon, ownPosition.lat] });
  }, [mapInstance, city, ownPosition]);

  useEffect(() => {
    if (!mapInstance) {
      return;
    }
    function handleClick(event: maplibregl.MapMouseEvent) {
      onPickRef.current({ lat: event.lngLat.lat, lon: event.lngLat.lng });
    }
    mapInstance.on('click', handleClick);
    return () => {
      mapInstance.off('click', handleClick);
    };
  }, [mapInstance]);

  useEffect(() => {
    if (!mapInstance) {
      return;
    }
    const map = mapInstance;
    function reposition() {
      if (!value) {
        setPinPoint(null);
        return;
      }
      const point = map.project([value.lon, value.lat]);
      setPinPoint({ x: point.x, y: point.y });
    }
    reposition();
    map.on('move', reposition);
    return () => {
      map.off('move', reposition);
    };
  }, [mapInstance, value]);

  function handleGoToMyLocation() {
    if (!mapInstance || !ownPosition) {
      return;
    }
    mapInstance.flyTo({ center: [ownPosition.lon, ownPosition.lat] });
  }

  return (
    <div className="map-picker">
      <div ref={containerRef} className="map-picker__map" />
      {pinPoint && (
        <svg
          className="map-picker__pin"
          viewBox="0 0 24 24"
          aria-hidden="true"
          focusable="false"
          style={{ left: `${pinPoint.x}px`, top: `${pinPoint.y}px` }}
        >
          <path d={PIN_SVG_PATH} />
        </svg>
      )}
      <LocateButton disabled={ownPosition === null} onClick={handleGoToMyLocation} />
      <p className="map-picker__status" role="status">
        {value
          ? `Pin placed at ${value.lat.toFixed(5)}, ${value.lon.toFixed(5)}.`
          : "No pin placed yet — tap the map to choose the bar's location."}
      </p>
    </div>
  );
}
