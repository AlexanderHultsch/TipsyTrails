// Applies SPEC.md Section 11.4's per-city pan limit to a map: the padded
// extent of that city's grid (shared's gridMapBounds), so the map cannot be
// dragged away from the area the tile extract covers. Nothing here is
// city-specific - the grid parameters come from GET /api/city, so a second
// city needs only its own config file, never a change here.
//
// Both screens/Map.tsx and map/MapPicker.tsx build their map in a mount-only
// effect, before any city metadata exists, and neither may wait for it: the
// map has to be on screen either way. The zoom limits need no metadata and
// are passed straight into the constructor options; only the bounds arrive
// late, hence this hook, which mounts once per map instance the way
// map/position/useOwnPositionMarker.ts does. A failed fetch leaves the map
// unbounded rather than showing anything - the same best-effort posture
// screens/BarDetail.tsx takes for its own GET /api/city.
//
// The metadata this already fetches is handed back as well, null until it
// arrives, so a caller that needs the grid itself (screens/Map.tsx tests
// whether the player is inside it before centring on them) gets it without
// a second GET /api/city. The name still says what the hook *does* to the
// map: the bounds are the effect, the return value only the by-product -
// map/MapPicker.tsx calls it for the effect alone.
import { useEffect, useState } from 'react';
import type { Map as MaplibreMap } from 'maplibre-gl';
import { gridMapBounds } from '@tipsytrails/shared';
import { getCity } from '../api/client.js';
import type { CityMeta } from '../api/types.js';

export function useCityMaxBounds(map: MaplibreMap | null): CityMeta | null {
  const [city, setCity] = useState<CityMeta | null>(null);

  useEffect(() => {
    if (!map) {
      return;
    }
    let cancelled = false;

    getCity()
      .then((city) => {
        if (cancelled) {
          return;
        }
        map.setMaxBounds(
          gridMapBounds({
            origin_lat: city.originLat,
            origin_lon: city.originLon,
            grid_width: city.gridWidth,
            grid_height: city.gridHeight,
            cell_size_m: city.cellSizeM,
          }),
        );
        setCity(city);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [map]);

  return city;
}
