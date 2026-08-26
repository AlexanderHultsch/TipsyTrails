// Wires Section 8.1/8.3's bar markers into the map screen: mounts a
// BarMarkers instance once the map exists, and keeps it in sync with
// `bars` (screens/Map.tsx, via useDiscoveredBars.ts - shared with
// tracking/useVisits.ts so the two do not each fetch GET /api/bars on
// their own). This means a bar discovered by POST /api/samples' `newBars`
// (Section 9.2) shows up without a page reload, with no second polling or
// event mechanism added alongside the one useFogLayer already established.
import { useEffect, useRef } from 'react';
import type { Map as MaplibreMap } from 'maplibre-gl';
import type { Bar } from '../../api/types.js';
import { BarMarkers } from './bar-markers.js';

export function useBarMarkers(
  map: MaplibreMap | null,
  bars: Bar[],
  // Sections 7.4/8.3: the bars whose discovery stamp is playing right now
  // (map/bars/useBarStamps.ts), whose markers hand their ink to the stamp
  // for its duration - see BarMarkers.setStamping.
  stampingBarIds: ReadonlySet<number>,
  // `null` draws the markers as decoration rather than as controls - see
  // BarMarkers' own comment for what that changes and why the admin's
  // teleport picker (map/MapPicker.tsx) needs it. Read through a ref like
  // the function case, so an inline arrow at a call site does not remount
  // the marker layer on every render; whether it is null, however, is what
  // the mode is built from, so *that* is a dependency of the effect below.
  onSelect: ((bar: Bar) => void) | null,
): void {
  const markersRef = useRef<BarMarkers | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const interactive = onSelect !== null;

  useEffect(() => {
    if (!map) {
      return;
    }
    const markers = new BarMarkers({
      map,
      onSelect: interactive ? (bar) => onSelectRef.current?.(bar) : null,
    });
    markersRef.current = markers;

    return () => {
      markers.destroy();
      markersRef.current = null;
    };
    // Mount-only per map instance, matching useFogLayer.ts's own mount-only
    // effect - a new `map` means a fresh BarMarkers, not an update.
  }, [map, interactive]);

  // Before the bars, and that order is load-bearing: a batch that discovers
  // a bar publishes the stamping id and the refetched list in the same
  // render, and setBars is what creates that bar's marker. Told afterwards,
  // the marker would exist for one paint with its ink showing.
  useEffect(() => {
    markersRef.current?.setStamping(stampingBarIds);
  }, [stampingBarIds]);

  useEffect(() => {
    markersRef.current?.setBars(bars);
  }, [bars]);
}
