import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GridParams } from '@tipsytrails/shared';
import type { Map as MaplibreMap } from 'maplibre-gl';
import { FIRST_ABOVE_FOG_LAYER_ID } from '../ink-style.js';
import { FOG_LAYER_ID, FogController } from './fog-controller.js';
import { WebGLFogLayer } from './webgl-fog-layer.js';

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

// `styleLayerIds` stands in for the layers the loaded style already holds.
// It defaults to what ink-style.ts gives a real map - the layer the fog is
// inserted before - so every test here exercises the ordering the app runs
// on; the one test about a style missing it passes an empty list.
function createFakeMap(loaded: boolean, styleLayerIds: string[] = [FIRST_ABOVE_FOG_LAYER_ID]) {
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true });
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const layers = new Map<string, unknown>(styleLayerIds.map((id) => [id, { id }]));
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
    // Rest-typed so `mock.calls` keeps the optional second argument, which
    // is what carries the fog's `beforeId`.
    addLayer: vi.fn((...args: [layer: { id: string }, beforeId?: string]) => {
      if (args[1] !== undefined && !layers.has(args[1])) {
        throw new Error(`Layer with id "${args[1]}" does not exist on this map.`);
      }
      layers.set(args[0].id, args[0]);
    }),
    removeLayer: vi.fn((id: string) => {
      layers.delete(id);
    }),
    getLayer: vi.fn((id: string) => layers.get(id)),
    fire(event: string) {
      for (const handler of [...(listeners.get(event) ?? [])]) handler();
    },
  };
  return { map: map as unknown as MaplibreMap, rawMap: map, container, listeners, layers };
}

describe('FogController', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mounts immediately when the map has already loaded, without waiting for a load event', () => {
    const { map, rawMap } = createFakeMap(true);
    const controller = new FogController({
      map,
      grid: GRID,
      gridParams: GRID_PARAMS,
      initialMask: emptyMask(),
      detectWebGL2: () => ({}) as WebGL2RenderingContext,
    });

    expect(rawMap.addLayer).toHaveBeenCalledTimes(1);
    controller.destroy();
  });

  it('defers mounting until the load event when the map is not yet loaded, and never touches the map beyond on/off until then', () => {
    const { map, rawMap } = createFakeMap(false);
    const detect = vi.fn(() => ({}) as WebGL2RenderingContext);
    const controller = new FogController({
      map,
      grid: GRID,
      gridParams: GRID_PARAMS,
      initialMask: emptyMask(),
      detectWebGL2: detect,
    });

    expect(detect).not.toHaveBeenCalled();
    expect(rawMap.addLayer).not.toHaveBeenCalled();

    rawMap.fire('load');

    expect(detect).toHaveBeenCalledTimes(1);
    expect(rawMap.addLayer).toHaveBeenCalledTimes(1);
    controller.destroy();
  });

  it('selects the WebGL layer when the WebGL2 detector is forced on', () => {
    const { map, rawMap } = createFakeMap(true);
    const controller = new FogController({
      map,
      grid: GRID,
      gridParams: GRID_PARAMS,
      initialMask: emptyMask(),
      detectWebGL2: () => ({}) as WebGL2RenderingContext,
    });

    expect(rawMap.addLayer).toHaveBeenCalledTimes(1);
    const [addedLayer] = rawMap.addLayer.mock.calls[0];
    expect(addedLayer).toBeInstanceOf(WebGLFogLayer);
    expect(addedLayer.id).toBe(FOG_LAYER_ID);
    controller.destroy();
  });

  // Section 7.3: the fog must land *below* the first layer ink-style.ts keeps
  // above it. Passing that id, rather than appending, is the entire mechanism
  // by which water and roads stay legible on unrevealed ground.
  it('inserts the fog beneath the first above-fog layer instead of on top of the style', () => {
    const { map, rawMap } = createFakeMap(true);
    const controller = new FogController({
      map,
      grid: GRID,
      gridParams: GRID_PARAMS,
      initialMask: emptyMask(),
      detectWebGL2: () => ({}) as WebGL2RenderingContext,
    });

    expect(rawMap.addLayer).toHaveBeenCalledTimes(1);
    const [, beforeId] = rawMap.addLayer.mock.calls[0];
    expect(beforeId).toBe(FIRST_ABOVE_FOG_LAYER_ID);
    controller.destroy();
  });

  // MapLibre's addLayer throws on a beforeId the style does not have, and
  // nothing above the controller catches it - that exception would take the
  // map down rather than degrade it.
  it('adds the fog on top and warns, rather than throwing, when the style lacks the above-fog anchor layer', () => {
    const { map, rawMap } = createFakeMap(true, []);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const controller = new FogController({
      map,
      grid: GRID,
      gridParams: GRID_PARAMS,
      initialMask: emptyMask(),
      detectWebGL2: () => ({}) as WebGL2RenderingContext,
    });

    expect(rawMap.addLayer).toHaveBeenCalledTimes(1);
    const [addedLayer, beforeId] = rawMap.addLayer.mock.calls[0];
    expect(addedLayer.id).toBe(FOG_LAYER_ID);
    expect(beforeId).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    controller.destroy();
  });

  it('selects the 2D canvas fallback, logs it, and draws through it when the WebGL2 detector is forced off', () => {
    const { map, rawMap, container } = createFakeMap(true);
    const fillRect = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      globalCompositeOperation: 'source-over',
      fillStyle: '',
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      fillRect,
    } as unknown as RenderingContext);
    const onFallback = vi.fn();
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    const controller = new FogController({
      map,
      grid: GRID,
      gridParams: GRID_PARAMS,
      initialMask: emptyMask(),
      detectWebGL2: () => null,
      onFallback,
    });

    expect(rawMap.addLayer).not.toHaveBeenCalled();
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalled();
    expect(container.querySelector('canvas.fog-canvas-fallback')).not.toBeNull();
    expect(fillRect).toHaveBeenCalled();

    controller.destroy();
  });

  it('forwards mask updates to the WebGL layer as a delta, not a full re-upload', () => {
    const { map } = createFakeMap(true);
    const controller = new FogController({
      map,
      grid: GRID,
      gridParams: GRID_PARAMS,
      initialMask: emptyMask(),
      detectWebGL2: () => ({}) as WebGL2RenderingContext,
    });
    const applyDeltaSpy = vi.spyOn(WebGLFogLayer.prototype, 'applyDelta');

    const nextMask = new Uint8Array(emptyMask());
    nextMask[0] = 0b0000_0001;
    controller.applyMask(nextMask);

    expect(applyDeltaSpy).toHaveBeenCalledTimes(1);
    const [previousArg, nextArg] = applyDeltaSpy.mock.calls[0];
    expect(Array.from(previousArg)).toEqual(Array.from(emptyMask()));
    expect(Array.from(nextArg)).toEqual(Array.from(nextMask));

    controller.destroy();
  });

  it('tears down the WebGL layer on destroy without leaking the load listener', () => {
    const { map, rawMap } = createFakeMap(true);
    const controller = new FogController({
      map,
      grid: GRID,
      gridParams: GRID_PARAMS,
      initialMask: emptyMask(),
      detectWebGL2: () => ({}) as WebGL2RenderingContext,
    });

    controller.destroy();

    expect(rawMap.removeLayer).toHaveBeenCalledWith(FOG_LAYER_ID);
    expect(rawMap.off).toHaveBeenCalledWith('load', expect.any(Function));
  });

  it('tears down the canvas fallback on destroy, removing its element and its moveend listener', () => {
    const { map, rawMap, container } = createFakeMap(true);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);

    const controller = new FogController({
      map,
      grid: GRID,
      gridParams: GRID_PARAMS,
      initialMask: emptyMask(),
      detectWebGL2: () => null,
    });

    controller.destroy();

    expect(rawMap.off).toHaveBeenCalledWith('moveend', expect.any(Function));
    expect(container.querySelector('canvas.fog-canvas-fallback')).toBeNull();
  });

  // Phase 8 task brief, part A: `useFogLayer.ts` never passes its own
  // `prefersReducedMotion`, so this default wiring - not the injectable
  // override webgl-fog-layer.test.ts exercises - is what the real app
  // actually runs on. It was untested until now.
  it('reads window.matchMedia for prefers-reduced-motion by default, and wires that into the WebGL layer', () => {
    const { map, rawMap } = createFakeMap(true);
    const matchMediaMock = vi.fn(
      (query: string) =>
        ({ matches: query === '(prefers-reduced-motion: reduce)' }) as MediaQueryList,
    );
    vi.stubGlobal('matchMedia', matchMediaMock);

    const controller = new FogController({
      map,
      grid: GRID,
      gridParams: GRID_PARAMS,
      initialMask: emptyMask(),
      detectWebGL2: () => ({}) as WebGL2RenderingContext,
    });

    const addedLayer = rawMap.addLayer.mock.calls[0][0] as unknown as {
      reducedMotion: () => boolean;
    };
    expect(addedLayer.reducedMotion()).toBe(true);
    expect(matchMediaMock).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');

    controller.destroy();
    vi.unstubAllGlobals();
  });

  it('never mounts a second time if destroyed before a deferred load event fires', () => {
    const { map, rawMap } = createFakeMap(false);
    const detect = vi.fn(() => ({}) as WebGL2RenderingContext);
    const controller = new FogController({
      map,
      grid: GRID,
      gridParams: GRID_PARAMS,
      initialMask: emptyMask(),
      detectWebGL2: detect,
    });

    controller.destroy();
    rawMap.fire('load');

    expect(detect).not.toHaveBeenCalled();
    expect(rawMap.addLayer).not.toHaveBeenCalled();
  });
});
