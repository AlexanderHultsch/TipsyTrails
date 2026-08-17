// Wires Section 8.1/8.3's own-position marker into the map screen: mounts
// an OwnPositionMarker instance once the map exists, matching
// map/bars/useBarMarkers.ts's mount-once-per-map-instance pattern, and
// keeps it in sync with `position` - the last accepted sample from
// tracking/useSampleTracking.ts (that file's own header comment explains
// why this reads that state rather than opening a second watchPosition).
import { useEffect, useRef } from 'react';
import type { Map as MaplibreMap } from 'maplibre-gl';
import type { LastAcceptedPosition } from '../../tracking/useSampleTracking.js';
import { OwnPositionMarker } from './own-position-marker.js';

export function useOwnPositionMarker(
  map: MaplibreMap | null,
  position: LastAcceptedPosition | null,
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

  useEffect(() => {
    markerRef.current?.setPosition(position);
  }, [position]);
}
