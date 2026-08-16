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
//
// Phase 8 task brief, part B: every successful GET /api/city + GET
// /api/fog pair is mirrored to fog-cache.ts, so a mount that happens while
// offline (the Promise.all below rejecting) can fall back to the last
// state instead of never showing fog at all. Keyed by `userId` (reviewer
// finding on the first pass) - screens/Map.tsx passes the signed-in user's
// id, and `null` (never signed in yet, mid-transition) disables the cache
// entirely rather than falling back to some shared, unowned entry.
import { useEffect, useRef } from 'react';
import type { Map as MaplibreMap } from 'maplibre-gl';
import type { CityMeta } from '../../api/types.js';
import type { GridParams } from '@tipsytrails/shared';
import { getCity, getFogMask } from '../../api/client.js';
import { FogController } from './fog-controller.js';
import { loadFogState, saveFogState } from './fog-cache.js';
import type { GridSize } from './grid-texture.js';

function gridParamsOf(city: {
  originLat: number;
  originLon: number;
  gridWidth: number;
  gridHeight: number;
  cellSizeM: number;
}): GridParams {
  return {
    origin_lat: city.originLat,
    origin_lon: city.originLon,
    grid_width: city.gridWidth,
    grid_height: city.gridHeight,
    cell_size_m: city.cellSizeM,
  };
}

export function useFogLayer(
  map: MaplibreMap | null,
  revealVersion: number,
  userId: number | null,
): void {
  const controllerRef = useRef<FogController | null>(null);
  // Held so the revealVersion effect below can re-save the cache after a
  // refetch without fetching GET /api/city a second time - grid params
  // never change mid-session, only the mask does.
  const cityRef = useRef<CityMeta | null>(null);

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
      if (cancelled) {
        return;
      }

      if (!result) {
        const cached = userId != null ? loadFogState(userId) : null;
        if (!cached) {
          return;
        }
        const grid: GridSize = { width: cached.gridWidth, height: cached.gridHeight };
        controllerRef.current = new FogController({
          map,
          grid,
          gridParams: gridParamsOf(cached),
          initialMask: cached.mask,
        });
        return;
      }

      const [city, fog] = result;
      cityRef.current = city;
      if (userId != null) {
        saveFogState(userId, city, fog);
      }

      const grid: GridSize = { width: city.gridWidth, height: city.gridHeight };
      controllerRef.current = new FogController({
        map,
        grid,
        gridParams: gridParamsOf(city),
        initialMask: fog.mask,
      });
    })();

    return () => {
      cancelled = true;
      controllerRef.current?.destroy();
      controllerRef.current = null;
    };
    // Mount-only per map instance, matching screens/Map.tsx's own mount-only
    // map effect - a new `map` means a fresh FogController, not an update.
  }, [map, userId]);

  useEffect(() => {
    if (revealVersion === 0 || !controllerRef.current) {
      return;
    }
    let cancelled = false;
    getFogMask()
      .then((fog) => {
        if (cancelled) {
          return;
        }
        controllerRef.current?.applyMask(fog.mask);
        if (cityRef.current && userId != null) {
          saveFogState(userId, cityRef.current, fog);
        }
      })
      .catch(() => {
        // A failed refetch leaves the fog as it was; the next successful
        // reveal (or the next mount) brings it back in sync.
      });
    return () => {
      cancelled = true;
    };
  }, [revealVersion, userId]);
}
