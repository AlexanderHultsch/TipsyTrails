// Wires SPEC.md Section 7.3's district borders into the map screen: fetches
// the boundary collection the district overview already uses and mounts a
// DistrictBorders on the given map. The same mount-only-per-map-instance
// shape as map/fog/useFogLayer.ts and map/bars/useBarMarkers.ts.
//
// Best effort, like useCityMaxBounds and the fog: a failed fetch leaves the
// map without borders rather than surfacing anything, because the map is
// fully usable without them and there is nothing more specific to say about
// a background load. The file is served from /static (Section 4.1's one-day
// cache), so the repeat cost of also fetching it here is a cache hit.
import { useEffect, useRef } from 'react';
import type { Map as MaplibreMap } from 'maplibre-gl';
import { getDistrictBoundaries } from '../../api/client.js';
import { DistrictBorders } from './district-borders.js';

export function useDistrictBorders(map: MaplibreMap | null): void {
  const bordersRef = useRef<DistrictBorders | null>(null);

  useEffect(() => {
    if (!map) {
      return;
    }
    let cancelled = false;

    getDistrictBoundaries()
      .then((boundaries) => {
        if (cancelled) {
          return;
        }
        bordersRef.current = new DistrictBorders({ map, boundaries });
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      bordersRef.current?.destroy();
      bordersRef.current = null;
    };
  }, [map]);
}
