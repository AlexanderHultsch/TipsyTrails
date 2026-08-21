import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG, cellCenterXY, gridMapBounds } from '@tipsytrails/shared';
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
  const fillRectCalls: { x: number; y: number; w: number; h: number; op: string; style: string }[] =
    [];
  const ctx = {
    globalCompositeOperation: 'source-over',
    fillStyle: '',
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn((x: number, y: number, w: number, h: number) => {
      fillRectCalls.push({ x, y, w, h, op: ctx.globalCompositeOperation, style: ctx.fillStyle });
    }),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, fillRectCalls };
}

function createFakeMap(scale = 1_000_000) {
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
    // covers the real mercator conversion). `scale` shrinks it further for
    // the one test that needs a larger grid plus its padding ring on the
    // same container.
    project: vi.fn(([lng, lat]: [number, number]) => ({
      x: 5000 + (lng - GRID_PARAMS.origin_lon) * scale,
      y: 5000 + (GRID_PARAMS.origin_lat - lat) * scale,
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

  // Both renderers read one fog opacity (CONFIG.FOG_MAX_OPACITY) so they
  // cannot drift apart on how dense the fog is - the WebGL shader's half of
  // this is asserted in webgl-fog-layer.test.ts.
  it('fills the fog at the configured opacity rather than a literal of its own', () => {
    const { map } = createFakeMap();
    new CanvasFogFallback({
      map: map as unknown as MaplibreMap,
      grid: GRID,
      gridParams: GRID_PARAMS,
      getMask: emptyMask,
    });

    const fogFill = ctxRig.fillRectCalls.find((call) => call.op === 'source-over');
    expect(fogFill?.style).toBe(`rgba(199, 194, 182, ${CONFIG.FOG_MAX_OPACITY})`);
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

  it('keeps the padding ring outside the grid fogged even when every cell is revealed', () => {
    // The map can be zoomed out to gridMapBounds - the grid plus
    // MAP_BOUNDS_PADDING_RATIO - and the fog covers all of it
    // (grid-geometry.ts). That ring holds no cells, so nothing can ever
    // punch a hole in it: it stays under the whole-canvas fog fill, at the
    // same opacity as unrevealed grid, which is what the WebGL shader does
    // for UVs outside 0..1.
    const params: GridParams = { ...GRID_PARAMS, grid_width: 20, grid_height: 15 };
    const grid = { width: params.grid_width, height: params.grid_height };
    const revealed = new Uint8Array(Math.ceil((grid.width * grid.height) / 8)).fill(0xff);
    const { map } = createFakeMap(200_000);
    const fallback = new CanvasFogFallback({
      map: map as unknown as MaplibreMap,
      grid,
      gridParams: params,
      getMask: () => revealed,
    });
    ctxRig.fillRectCalls.length = 0;

    fallback.redraw();

    const covers = (op: string, x: number, y: number) =>
      ctxRig.fillRectCalls.some(
        (call) =>
          call.op === op &&
          x >= call.x &&
          x <= call.x + call.w &&
          y >= call.y &&
          y <= call.y + call.h,
      );

    const [, [east, north]] = gridMapBounds(params);
    const ringCorner = map.project([east, north]);
    expect(covers('source-over', ringCorner.x, ringCorner.y)).toBe(true);
    expect(covers('destination-out', ringCorner.x, ringCorner.y)).toBe(false);

    // The control: inside the grid, a revealed cell is cleared - so the
    // assertion above is about where the ring is, not about the holes
    // having gone missing.
    const centre = cellCenterXY(grid.width - 1, grid.height - 1, params);
    const lastCell = map.project([centre.lon, centre.lat]);
    expect(covers('destination-out', lastCell.x, lastCell.y)).toBe(true);
  });

  // The fallback fills the whole canvas before punching holes, so unlike the
  // WebGL path it never leaves a rotated map's corners bare. Its hole *sizes*
  // did depend on the bearing, though: a step due east is not a step along
  // the screen's x axis once the map is turned.
  it('keeps the punched holes a full cell wide on a rotated map', () => {
    const scale = 1_000_000;
    const bearing = Math.PI / 2; // due east now points down the screen
    const { map } = createFakeMap();
    map.project = vi.fn(([lng, lat]: [number, number]) => {
      const dx = (lng - GRID_PARAMS.origin_lon) * scale;
      const dy = (GRID_PARAMS.origin_lat - lat) * scale;
      return {
        x: 5000 + dx * Math.cos(bearing) - dy * Math.sin(bearing),
        y: 5000 + dx * Math.sin(bearing) + dy * Math.cos(bearing),
      };
    });

    const mask = setCell(emptyMask(), 4);
    const fallback = new CanvasFogFallback({
      map: map as unknown as MaplibreMap,
      grid: GRID,
      gridParams: GRID_PARAMS,
      getMask: () => mask,
    });
    ctxRig.fillRectCalls.length = 0;

    fallback.redraw();

    const [hole] = ctxRig.fillRectCalls.filter((call) => call.op === 'destination-out');
    const origin = map.project([GRID_PARAMS.origin_lon, GRID_PARAMS.origin_lat]);
    const neighbour = cellCenterXY(1, 0, GRID_PARAMS);
    const east = map.project([neighbour.lon, GRID_PARAMS.origin_lat]);
    const cellPx = Math.hypot(east.x - origin.x, east.y - origin.y);

    expect(cellPx).toBeGreaterThan(10); // the rig really does span a cell
    expect(hole.w).toBeCloseTo(cellPx + 2, 6);
    expect(hole.h).toBeCloseTo(cellPx + 2, 6);
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
