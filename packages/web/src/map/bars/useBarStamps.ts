// Wires Sections 7.4/8.3's bar stamp into the map screen: mounts a
// BarStamps instance once the map exists, stamps each batch of newly
// discovered bars as POST /api/samples reports them
// (tracking/useSampleTracking.ts's newBars/newBarsVersion pair), and hands
// the screen the ids whose marker must stay out of the way meanwhile.
//
// Mount and update are two effects for the same reason useBarMarkers.ts
// splits them: a new `map` means a fresh instance, a new batch means a call
// on the existing one.
import { useEffect, useRef, useState } from 'react';
import type { Map as MaplibreMap } from 'maplibre-gl';
import type { Bar } from '../../api/types.js';
import { BarStamps } from './bar-stamps.js';

const NO_BARS: ReadonlySet<number> = new Set();

export function useBarStamps(
  map: MaplibreMap | null,
  newBars: Bar[],
  newBarsVersion: number,
): ReadonlySet<number> {
  const stampsRef = useRef<BarStamps | null>(null);
  // The bars whose marker is being held back while their stamp plays - see
  // the hand-over note in bar-stamps.ts. State rather than a ref: the marker
  // layer has to be repainted when it changes.
  const [stamping, setStamping] = useState<ReadonlySet<number>>(NO_BARS);
  // Read inside the update effect below, which is deliberately keyed on the
  // version alone - the array is what changed, the version is when, and
  // keying on the array would re-stamp a batch every time the tracking hook
  // re-rendered for an unrelated reason.
  const newBarsRef = useRef(newBars);
  newBarsRef.current = newBars;

  useEffect(() => {
    if (!map) {
      return;
    }
    const stamps = new BarStamps({ map, onStampingChange: setStamping });
    stampsRef.current = stamps;

    return () => {
      stamps.destroy();
      stampsRef.current = null;
      // The instance that was publishing this is gone, and its pending
      // stamps went with it; leaving the last set behind would hold the
      // markers of a batch that will never finish.
      setStamping(NO_BARS);
    };
  }, [map]);

  useEffect(() => {
    // Nothing has been discovered yet in this session - and in particular
    // this is what stops the initial render stamping an empty batch.
    if (newBarsVersion === 0) {
      return;
    }
    stampsRef.current?.stamp(newBarsRef.current);
    // Deliberately keyed on the version only - see newBarsRef above.
  }, [newBarsVersion]);

  return stamping;
}
