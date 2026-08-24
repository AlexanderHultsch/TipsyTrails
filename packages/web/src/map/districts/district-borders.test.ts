import { describe, expect, it, vi } from 'vitest';
import type { GridParams } from '@tipsytrails/shared';
import type { Map as MaplibreMap } from 'maplibre-gl';
import type { BoundaryFeatureCollection } from '../../api/geo-types.js';
import { FOG_LAYER_ID, FogController } from '../fog/fog-controller.js';
import { inkStyle } from '../ink-style.js';
import {
  DISTRICT_BORDERS_LAYER_ID,
  DISTRICT_BORDERS_SOURCE_ID,
  DistrictBorders,
} from './district-borders.js';

// Section 7.3: the district borders are a runtime-added layer, so unlike
// every layer of ink-style.ts their position in the style is decided by code
// rather than by an array literal - and decided while a second runtime layer,
// the fog, is being inserted from another network response. That race is what
// this file is mostly about, so the fake map below models the layer *order*
// rather than only recording calls, and the ordering tests drive the real
// FogController against it instead of a stand-in for one.

const GRID_PARAMS: GridParams = {
  origin_lat: 48.94,
  origin_lon: 8.275,
  grid_width: 3,
  grid_height: 3,
  cell_size_m: 50,
};
const GRID = { width: GRID_PARAMS.grid_width, height: GRID_PARAMS.grid_height };

function emptyMask(): Uint8Array {
  return new Uint8Array(Math.ceil((GRID.width * GRID.height) / 8));
}

const boundaries: BoundaryFeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { osm_id: 1, name: 'Innenstadt-West', admin_level: 10 },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [8.38, 49.0],
            [8.4, 49.0],
            [8.4, 49.02],
            [8.38, 49.02],
            [8.38, 49.0],
          ],
        ],
      },
    },
  ],
};

// The layers start as the real style's, in the real style's order, so the
// ordering assertions below are about the map the app actually builds.
function createFakeMap(loaded = true) {
  const container = document.createElement('div');
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const layerIds: string[] = inkStyle.layers.map((layer) => layer.id);
  const sources = new Map<string, unknown>();
  const map = {
    loaded: vi.fn(() => loaded),
    getContainer: () => container,
    project: vi.fn(() => ({ x: 0, y: 0 })),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)?.add(handler);
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(handler);
    }),
    addLayer: vi.fn((...args: [layer: { id: string }, beforeId?: string]) => {
      const [layer, beforeId] = args;
      if (beforeId === undefined) {
        layerIds.push(layer.id);
        return;
      }
      const index = layerIds.indexOf(beforeId);
      if (index < 0) {
        throw new Error(`Layer with id "${beforeId}" does not exist on this map.`);
      }
      layerIds.splice(index, 0, layer.id);
    }),
    removeLayer: vi.fn((id: string) => {
      const index = layerIds.indexOf(id);
      if (index >= 0) layerIds.splice(index, 1);
    }),
    getLayer: vi.fn((id: string) => (layerIds.includes(id) ? { id } : undefined)),
    addSource: vi.fn((id: string, source: unknown) => {
      sources.set(id, source);
    }),
    getSource: vi.fn((id: string) => sources.get(id)),
    removeSource: vi.fn((id: string) => {
      sources.delete(id);
    }),
    fire(event: string) {
      for (const handler of [...(listeners.get(event) ?? [])]) handler();
    },
  };
  return { map: map as unknown as MaplibreMap, rawMap: map, layerIds, sources };
}

function mountFog(map: MaplibreMap): FogController {
  return new FogController({
    map,
    grid: GRID,
    gridParams: GRID_PARAMS,
    initialMask: emptyMask(),
    detectWebGL2: () => ({}) as WebGL2RenderingContext,
  });
}

describe('DistrictBorders', () => {
  it('adds the fetched boundaries as a GeoJSON source and draws them as a line layer', () => {
    const { map, rawMap, sources } = createFakeMap();

    const borders = new DistrictBorders({ map, boundaries });

    expect(sources.get(DISTRICT_BORDERS_SOURCE_ID)).toEqual({
      type: 'geojson',
      data: boundaries,
    });
    const [layer] = rawMap.addLayer.mock.calls[0] as unknown as [{ id: string; type: string }];
    expect(layer.id).toBe(DISTRICT_BORDERS_LAYER_ID);
    expect(layer.type).toBe('line');
    borders.destroy();
  });

  // Section 7.3's whole point for this layer: a border the player cannot see
  // in unexplored ground answers none of what it was asked for. Both arrival
  // orders are exercised, because the fog and the boundary GeoJSON come from
  // two independent responses - an ordering that only holds when one of them
  // wins is the kind of defect that works on a desk and fails on a phone.
  it('draws the borders above the fog when the fog mounted first', () => {
    const { map, layerIds } = createFakeMap();

    const fog = mountFog(map);
    const borders = new DistrictBorders({ map, boundaries });

    expect(layerIds.indexOf(DISTRICT_BORDERS_LAYER_ID)).toBeGreaterThan(
      layerIds.indexOf(FOG_LAYER_ID),
    );
    borders.destroy();
    fog.destroy();
  });

  it('draws the borders above the fog when the boundaries arrived first', () => {
    const { map, layerIds } = createFakeMap();

    const borders = new DistrictBorders({ map, boundaries });
    const fog = mountFog(map);

    expect(layerIds.indexOf(DISTRICT_BORDERS_LAYER_ID)).toBeGreaterThan(
      layerIds.indexOf(FOG_LAYER_ID),
    );
    borders.destroy();
    fog.destroy();
  });

  // The mechanism behind both orders above, asserted directly so that a
  // change to it is a visible decision: appending is what makes the result
  // independent of who won the race, since the fog is only ever *inserted*
  // before a static style layer and never appended.
  it('appends the layer rather than anchoring it to a layer of the static style', () => {
    const { map, rawMap, layerIds } = createFakeMap();

    const borders = new DistrictBorders({ map, boundaries });

    const [, beforeId] = rawMap.addLayer.mock.calls[0];
    expect(beforeId).toBeUndefined();
    expect(layerIds[layerIds.length - 1]).toBe(DISTRICT_BORDERS_LAYER_ID);
    borders.destroy();
  });

  // addSource and addLayer both throw on a style that has not loaded, and
  // nothing above this catches that - the same reason FogController defers.
  it('waits for the load event when the style has not finished loading', () => {
    const { map, rawMap } = createFakeMap(false);

    const borders = new DistrictBorders({ map, boundaries });
    expect(rawMap.addSource).not.toHaveBeenCalled();
    expect(rawMap.addLayer).not.toHaveBeenCalled();

    rawMap.fire('load');

    expect(rawMap.addSource).toHaveBeenCalledTimes(1);
    expect(rawMap.addLayer).toHaveBeenCalledTimes(1);
    borders.destroy();
  });

  it('never mounts if destroyed before a deferred load event fires', () => {
    const { map, rawMap } = createFakeMap(false);

    const borders = new DistrictBorders({ map, boundaries });
    borders.destroy();
    rawMap.fire('load');

    expect(rawMap.addLayer).not.toHaveBeenCalled();
  });

  it('removes the layer, then its source, on destroy', () => {
    const { map, rawMap, layerIds, sources } = createFakeMap();

    const borders = new DistrictBorders({ map, boundaries });
    borders.destroy();

    expect(layerIds).not.toContain(DISTRICT_BORDERS_LAYER_ID);
    expect(sources.has(DISTRICT_BORDERS_SOURCE_ID)).toBe(false);
    expect(rawMap.off).toHaveBeenCalledWith('load', expect.any(Function));
  });
});
