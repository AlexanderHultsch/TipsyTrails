import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GridParams } from '@tipsytrails/shared';
import type { Map as MaplibreMap } from 'maplibre-gl';
import { CanvasFogFallback } from './canvas-fallback.js';

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

function setCell(mask: Uint8Array, index: number): Uint8Array {
  const copy = new Uint8Array(mask);
  copy[index >> 3] |= 1 << (index & 7);
  return copy;
}

function createFakeCtx() {
  const fillRectCalls: { x: number; y: number; w: number; h: number; op: string }[] = [];
  const ctx = {
    globalCompositeOperation: 'source-over',
    fillStyle: '',
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn((x: number, y: number, w: number, h: number) => {
      fillRectCalls.push({ x, y, w, h, op: ctx.globalCompositeOperation });
    }),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, fillRectCalls };
}

function createFakeMap() {
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientWidth', { value: 10000, configurable: true });
  Object.defineProperty(container, 'clientHeight', { value: 10000, configurable: true });
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const map = {
    getContainer: () => container,
    // A deliberately made-up projection (not real mercator), centred on the
    // oversized container above so every cell of the small test grid -
    // whichever direction it sits from the origin - lands comfortably
    // inside it. This test is about hole-punching and lifecycle, not about
    // verifying real map projection math (grid-geometry.test.ts already
    // covers the real mercator conversion).
    project: vi.fn(([lng, lat]: [number, number]) => ({
      x: 5000 + (lng - GRID_PARAMS.origin_lon) * 1_000_000,
      y: 5000 + (GRID_PARAMS.origin_lat - lat) * 1_000_000,
    })),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)?.add(handler);
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(handler);
    }),
    fire(event: string) {
      for (const handler of listeners.get(event) ?? []) handler();
    },
  };
  return { map, container, listeners };
}

describe('CanvasFogFallback', () => {
  let getContextSpy: ReturnType<typeof vi.spyOn>;
  let ctxRig: ReturnType<typeof createFakeCtx>;

  beforeEach(() => {
    ctxRig = createFakeCtx();
    getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(ctxRig.ctx as unknown as RenderingContext);
  });

  afterEach(() => {
    getContextSpy.mockRestore();
  });

  it('appends a canvas to the map container and paints immediately on construction', () => {
    const { map, container } = createFakeMap();
    const fallback = new CanvasFogFallback({
      map: map as unknown as MaplibreMap,
      grid: GRID,
      gridParams: GRID_PARAMS,
      getMask: emptyMask,
    });
    expect(fallback.canvas).toBeInstanceOf(HTMLCanvasElement);

    const canvas = container.querySelector('canvas.fog-canvas-fallback');
    expect(canvas).not.toBeNull();
    // One fillRect for the whole-canvas fog fill, drawn before any moveend.
    expect(ctxRig.fillRectCalls.length).toBeGreaterThanOrEqual(1);
    expect(ctxRig.fillRectCalls[0].op).toBe('source-over');
  });

  it('punches exactly one destination-out hole per revealed cell', () => {
    const { map } = createFakeMap();
    const mask = setCell(setCell(emptyMask(), 0), 4);
    const fallback = new CanvasFogFallback({
      map: map as unknown as MaplibreMap,
      grid: GRID,
      gridParams: GRID_PARAMS,
      getMask: () => mask,
    });
    ctxRig.fillRectCalls.length = 0;

    fallback.redraw();

    const holes = ctxRig.fillRectCalls.filter((call) => call.op === 'destination-out');
    expect(holes).toHaveLength(2);
  });

  it('punches no holes when nothing is revealed', () => {
    const { map } = createFakeMap();
    const fallback = new CanvasFogFallback({
      map: map as unknown as MaplibreMap,
      grid: GRID,
      gridParams: GRID_PARAMS,
      getMask: emptyMask,
    });
    ctxRig.fillRectCalls.length = 0;

    fallback.redraw();

    const holes = ctxRig.fillRectCalls.filter((call) => call.op === 'destination-out');
    expect(holes).toHaveLength(0);
  });

  it('redraws on moveend and not otherwise', () => {
    const { map } = createFakeMap();
    let mask = emptyMask();
    const fallback = new CanvasFogFallback({
      map: map as unknown as MaplibreMap,
      grid: GRID,
      gridParams: GRID_PARAMS,
      getMask: () => mask,
    });
    ctxRig.fillRectCalls.length = 0;

    mask = setCell(mask, 0);
    expect(ctxRig.fillRectCalls).toHaveLength(0); // no redraw just from the mask changing

    map.fire('moveend');
    expect(ctxRig.fillRectCalls.length).toBeGreaterThan(0);

    fallback.destroy();
  });

  it('removes the moveend listener and the canvas element on destroy', () => {
    const { map, container } = createFakeMap();
    const fallback = new CanvasFogFallback({
      map: map as unknown as MaplibreMap,
      grid: GRID,
      gridParams: GRID_PARAMS,
      getMask: emptyMask,
    });
    expect(map.on).toHaveBeenCalledWith('moveend', expect.any(Function));

    fallback.destroy();

    expect(map.off).toHaveBeenCalledWith('moveend', expect.any(Function));
    expect(container.querySelector('canvas.fog-canvas-fallback')).toBeNull();

    // A moveend after destroy must not touch the (now-detached) canvas.
    ctxRig.fillRectCalls.length = 0;
    map.fire('moveend');
    expect(ctxRig.fillRectCalls).toHaveLength(0);
  });
});
