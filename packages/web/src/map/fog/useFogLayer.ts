// Wires SPEC.md Section 7.3's fog layer into the map screen: fetches the
// grid dimensions (GET /api/city) and the initial mask (GET /api/fog),
// mounts a FogController on the given map, and refetches the mask whenever
// `revealVersion` advances (see useSampleTracking.ts's own comment on why
// that field, not `lastNewCells`, is what drives this).
//
// Reveal updates (task item 4): POST /api/samples returns only a count of
// newly revealed cells, never which ones (Section 9.2's documented
// `{ newCells, ... }` shape). Refetching the whole mask with GET /api/fog
// after a successful post - rather than trying to infer the changed cells
// from the reveal radius client-side - is the choice made here: the mask
// is small (~17.5 KiB raw, Section 5.5) and refetching keeps the client
// trivially consistent with the server's teleport-guard and validation
// decisions, which the client cannot fully replicate. The diff against the
// previously held mask (grid-texture.ts's diffRevealedCells, driven from
// fog-controller.ts) is what turns that whole-mask refetch back into a
// bounded texSubImage2D update.
import { useEffect, useRef } from 'react';
import type { Map as MaplibreMap } from 'maplibre-gl';
import type { GridParams } from '@tipsytrails/shared';
import { getCity, getFogMask } from '../../api/client.js';
import { FogController } from './fog-controller.js';
import type { GridSize } from './grid-texture.js';

export function useFogLayer(map: MaplibreMap | null, revealVersion: number): void {
  const controllerRef = useRef<FogController | null>(null);

  useEffect(() => {
    if (!map) {
      return;
    }
    let cancelled = false;

    void (async () => {
      // The map still works without fog (same posture as the tile
      // availability probe in screens/Map.tsx) - a failed fetch here has
      // nothing more specific to surface for a Phase 3 background load.
      const result = await Promise.all([getCity(), getFogMask()]).catch(() => null);
      if (cancelled || !result) {
        return;
      }
      const [city, fog] = result;

      const grid: GridSize = { width: city.gridWidth, height: city.gridHeight };
      const gridParams: GridParams = {
        origin_lat: city.originLat,
        origin_lon: city.originLon,
        grid_width: city.gridWidth,
        grid_height: city.gridHeight,
        cell_size_m: city.cellSizeM,
      };
      controllerRef.current = new FogController({ map, grid, gridParams, initialMask: fog.mask });
    })();

    return () => {
      cancelled = true;
      controllerRef.current?.destroy();
      controllerRef.current = null;
    };
    // Mount-only per map instance, matching screens/Map.tsx's own mount-only
    // map effect - a new `map` means a fresh FogController, not an update.
  }, [map]);

  useEffect(() => {
    if (revealVersion === 0 || !controllerRef.current) {
      return;
    }
    let cancelled = false;
    getFogMask()
      .then((fog) => {
        if (!cancelled) {
          controllerRef.current?.applyMask(fog.mask);
        }
      })
      .catch(() => {
        // A failed refetch leaves the fog as it was; the next successful
        // reveal (or the next mount) brings it back in sync.
      });
    return () => {
      cancelled = true;
    };
  }, [revealVersion]);
}
