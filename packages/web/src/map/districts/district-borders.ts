// SPEC.md Section 7.3 / 8.1: the district boundaries, drawn on the main map
// as a runtime-added GeoJSON source and line layer. The geometry is the same
// GET /static/<slug>/districts.geojson the district overview already draws
// (api/client.ts), so nothing new is generated or served for this - it is the
// existing boundary file put on the map the player actually walks with.
//
// It is a runtime layer rather than part of ink-style.ts because the data
// arrives over the network: a style is plain JSON and cannot wait for a
// fetch. Only the paint lives in the style module (DISTRICT_BORDER_PAINT),
// beside the road opacities, so the map's ink is decided in one file.
import type { Map as MaplibreMap } from 'maplibre-gl';
import type { BoundaryFeatureCollection } from '../../api/geo-types.js';
import { DISTRICT_BORDER_PAINT } from '../ink-style.js';

export const DISTRICT_BORDERS_SOURCE_ID = 'district-borders';
export const DISTRICT_BORDERS_LAYER_ID = 'district-borders';

// The constructor bag, contextually typed at the one call site, so it is not
// surface. The two layer/source ids above are, because teardown and the map
// screen's tests both name them.
interface DistrictBordersOptions {
  map: MaplibreMap;
  boundaries: BoundaryFeatureCollection;
}

export class DistrictBorders {
  private readonly map: MaplibreMap;
  private readonly boundaries: BoundaryFeatureCollection;
  private readonly handleLoad = () => this.mount();

  private mounted = false;
  private destroyed = false;

  constructor(options: DistrictBordersOptions) {
    this.map = options.map;
    this.boundaries = options.boundaries;

    // Same wiring as fog-controller.ts, and for the same reason: a style
    // that finished loading before this was constructed will not replay its
    // 'load' event to a listener attached afterwards, and `addSource` /
    // `addLayer` throw on a style that has not loaded yet. `loaded` is called
    // defensively because some map stand-ins only implement `on`/`off`.
    if (typeof this.map.loaded === 'function' && this.map.loaded()) {
      this.mount();
    } else {
      this.map.on('load', this.handleLoad);
    }
  }

  private mount(): void {
    if (this.mounted || this.destroyed) {
      return;
    }
    this.mounted = true;
    this.map.off('load', this.handleLoad);

    this.map.addSource(DISTRICT_BORDERS_SOURCE_ID, {
      type: 'geojson',
      // The fetched collection is the app's own BoundaryFeature shape
      // (api/geo-types.ts), which is a GeoJSON FeatureCollection with a
      // narrower `properties` than the GeoJSON types express. It satisfies
      // `GeoJSON.FeatureCollection` structurally and is passed as-is; see
      // `BoundaryFeatureProperties` for why that only holds while it is a
      // type alias and not an interface.
      data: this.boundaries,
    });

    // **No `beforeId`, and that is the whole ordering argument.** Section 7.3
    // requires these borders above the fog - a border only answers the
    // owner's request if it is visible on ground he has not explored - and
    // the fog and this GeoJSON arrive independently over two networks, so
    // whichever lands first must give the same result. Appending does:
    //
    // - Fog first: it is already in the style, below the water layer it was
    //   inserted before, and appending puts this on top of everything.
    // - Borders first: the fog is inserted *before*
    //   `FIRST_ABOVE_FOG_LAYER_ID` (fog-controller.ts) and never appended, so
    //   it lands below the water layer - which is below this one.
    //
    // The order is therefore fixed by where the fog goes, not by which fetch
    // won, which is exactly the race that works on a desk and fails on a
    // phone. Passing an anchor id here would break that: any anchor from the
    // static style is a layer the fog can be inserted above or below
    // depending on arrival order, and the one anchor that would not be -
    // the fog's own layer id - does not exist yet when the borders win the
    // race.
    this.map.addLayer({
      id: DISTRICT_BORDERS_LAYER_ID,
      type: 'line',
      source: DISTRICT_BORDERS_SOURCE_ID,
      layout: {
        // Butt caps keep the dashes of DISTRICT_BORDER_PAINT rectangular;
        // round caps would add half a line width at each end of every dash
        // and close the gaps that make the line read as a boundary.
        'line-cap': 'butt',
        'line-join': 'round',
      },
      paint: DISTRICT_BORDER_PAINT,
    });
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.map.off('load', this.handleLoad);

    if (!this.mounted) {
      return;
    }
    // Guarded the way fog-controller.ts guards its own teardown: the layer
    // has to go before the source it reads, and a map stand-in need not
    // implement the getters.
    if (typeof this.map.getLayer === 'function' && this.map.getLayer(DISTRICT_BORDERS_LAYER_ID)) {
      this.map.removeLayer(DISTRICT_BORDERS_LAYER_ID);
    }
    if (
      typeof this.map.getSource === 'function' &&
      this.map.getSource(DISTRICT_BORDERS_SOURCE_ID)
    ) {
      this.map.removeSource(DISTRICT_BORDERS_SOURCE_ID);
    }
  }
}
