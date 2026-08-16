import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import { inkStyle } from './ink-style.js';

// Same fallback view screens/Map.tsx uses (roughly the middle of
// Karlsruhe's bounding box, Section 6.2) - there is no user location to
// centre on until a pin is actually placed.
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

  useEffect(() => {
    const protocol = new Protocol();
    maplibregl.addProtocol('pmtiles', protocol.tile);

    const map = new maplibregl.Map({
      container: containerRef.current as HTMLDivElement,
      style: inkStyle,
      center: INITIAL_CENTER,
      zoom: INITIAL_ZOOM,
      attributionControl: false,
    });
    setMapInstance(map);

    return () => {
      setMapInstance(null);
      map.remove();
      maplibregl.removeProtocol('pmtiles');
    };
  }, []);

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
      <p className="map-picker__status" role="status">
        {value
          ? `Pin placed at ${value.lat.toFixed(5)}, ${value.lon.toFixed(5)}.`
          : "No pin placed yet — tap the map to choose the bar's location."}
      </p>
    </div>
  );
}
