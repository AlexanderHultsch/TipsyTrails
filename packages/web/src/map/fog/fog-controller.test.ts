import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GridParams } from '@tipsytrails/shared';
import type { Map as MaplibreMap } from 'maplibre-gl';
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

function createFakeMap(loaded: boolean) {
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true });
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const layers = new Map<string, unknown>();
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
    addLayer: vi.fn((layer: { id: string }) => {
      layers.set(layer.id, layer);
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
