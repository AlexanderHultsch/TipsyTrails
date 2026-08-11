// Wires Section 8.1/8.3's bar markers into the map screen: fetches the
// discovered bars (GET /api/bars) once the map exists, mounts a BarMarkers
// instance, and refetches whenever `revealVersion` advances - the exact same
// signal map/fog/useFogLayer.ts already uses to notice "a reveal just
// happened" and refetch the fog mask (see that file's own comment, and
// useSampleTracking.ts's comment on revealVersion, for why that field and
// not lastNewCells is the one to key off). Reusing it here means a bar
// discovered by POST /api/samples' `newBars` (Section 9.2) shows up without
// a page reload, with no second polling or event mechanism added alongside
// the one useFogLayer already established.
import { useEffect, useRef } from 'react';
import type { Map as MaplibreMap } from 'maplibre-gl';
import { getBars } from '../../api/client.js';
import type { Bar } from '../../api/types.js';
import { BarMarkers } from './bar-markers.js';

export function useBarMarkers(
  map: MaplibreMap | null,
  revealVersion: number,
  onSelect: (bar: Bar) => void,
): void {
  const markersRef = useRef<BarMarkers | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    if (!map) {
      return;
    }
    const markers = new BarMarkers({ map, onSelect: (bar) => onSelectRef.current(bar) });
    markersRef.current = markers;
    let cancelled = false;

    getBars()
      .then((result) => {
        if (!cancelled) {
          markers.setBars(result.bars);
        }
      })
      .catch(() => {
        // The map still works without markers - same posture as the tile
        // availability probe and useFogLayer's own background fetch in
        // screens/Map.tsx.
      });

    return () => {
      cancelled = true;
      markers.destroy();
      markersRef.current = null;
    };
    // Mount-only per map instance, matching useFogLayer.ts's own mount-only
    // effect - a new `map` means a fresh BarMarkers, not an update.
  }, [map]);

  useEffect(() => {
    if (revealVersion === 0 || !markersRef.current) {
      return;
    }
    let cancelled = false;
    getBars()
      .then((result) => {
        if (!cancelled) {
          markersRef.current?.setBars(result.bars);
        }
      })
      .catch(() => {
        // A failed refetch leaves the markers as they were; the next
        // successful reveal (or the next mount) brings them back in sync.
      });
    return () => {
      cancelled = true;
    };
  }, [revealVersion]);
}
