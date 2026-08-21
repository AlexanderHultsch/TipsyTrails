// Wires Section 8.1/8.3's own-position marker into a map: mounts an
// OwnPositionMarker instance once the map exists, matching
// map/bars/useBarMarkers.ts's mount-once-per-map-instance pattern, and
// keeps it in sync with `position`. On the map screen that is the last
// accepted sample from tracking/useSampleTracking.ts (that file's own
// header comment explains why this reads that state rather than opening a
// second watchPosition); on map/MapPicker.tsx it is the stored or one-shot
// fix that screen holds instead.
import { useEffect, useRef } from 'react';
import type { Map as MaplibreMap } from 'maplibre-gl';
import { OwnPositionMarker } from './own-position-marker.js';
import type { OwnPositionMarkerPosition } from './own-position-marker.js';

export function useOwnPositionMarker(
  map: MaplibreMap | null,
  position: OwnPositionMarkerPosition | null,
): void {
  const markerRef = useRef<OwnPositionMarker | null>(null);

  useEffect(() => {
    if (!map) {
      return;
    }
    const marker = new OwnPositionMarker({ map });
    markerRef.current = marker;

    return () => {
      marker.destroy();
      markerRef.current = null;
    };
    // Mount-only per map instance, matching useBarMarkers.ts's own
    // mount-only effect - a new `map` means a fresh OwnPositionMarker, not
    // an update.
  }, [map]);

  // `map` belongs in the dependencies beside `position`, not because this
  // effect reads it, but because the marker it writes to is the one the
  // effect above builds from it: a position already known when that marker
  // is created has not changed since, so on `position` alone this would not
  // run and the fresh marker would stay empty. The map screen never sees
  // that - its first fix always arrives after the map - but the picker
  // opens with the stored position already in hand.
  useEffect(() => {
    markerRef.current?.setPosition(position);
  }, [map, position]);
}
