// GET /api/bars (Section 9.2/7.4): the caller's discovered bars, fetched
// once here on mount and whenever discoveryVersion advances
// (tracking/useSampleTracking.ts — a bar discovered, or a bar mastered,
// which changes the `mastered` flag this list carries) and shared by both consumers that need
// the list - useBarMarkers.ts (marker rendering) and tracking/useVisits.ts
// (Section 7.5's check-in candidates and out-of-range lookups) - so the two
// issue exactly one request per mount and per discoveryVersion change
// between them, not one each.
import { useEffect, useState } from 'react';
import { getBars } from '../../api/client.js';
import type { Bar } from '../../api/types.js';

export function useDiscoveredBars(discoveryVersion: number): Bar[] {
  const [bars, setBars] = useState<Bar[]>([]);

  useEffect(() => {
    let cancelled = false;
    getBars()
      .then((result) => {
        if (!cancelled) {
          setBars(result.bars);
        }
      })
      .catch(() => {
        // Leaves the previous list in place; the next successful fetch
        // (mount, or the next discoveryVersion change) brings it back in
        // sync - same posture as the rest of this codebase's best-effort
        // background fetches.
      });
    return () => {
      cancelled = true;
    };
  }, [discoveryVersion]);

  return bars;
}
