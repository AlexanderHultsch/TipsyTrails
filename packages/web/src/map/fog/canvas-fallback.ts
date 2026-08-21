// SPEC.md Section 7.3, "Fallback": "If WebGL2 is unavailable, fall back to
// a 2D canvas overlay redrawn on `moveend` only. Detect and log this; do
// not attempt feature parity on animation." No edge softening, no
// per-cell animation here - the WebGL path (webgl-fog-layer.ts) owns both;
// this is a plain flat-grey overlay with holes punched over revealed
// cells.
import type { Map as MaplibreMap } from 'maplibre-gl';
import { CONFIG, cellCenterXY } from '@tipsytrails/shared';
import type { GridParams } from '@tipsytrails/shared';
import { isRevealed } from './mask.js';
import { cellToTexel } from './grid-texture.js';
import type { GridSize } from './grid-texture.js';

// Same "milky grey fog" family as WebGLFogLayer's FOG_COLOR
// (webgl-fog-layer.ts), converted to CSS rgba. The colour stays an
// independent implementation of the one visual direction (Section 8.1), the
// same way the WebGL shader's colour isn't imported from ink-style.ts
// either; the alpha does not - both renderers read CONFIG.FOG_MAX_OPACITY,
// so the two paths cannot drift apart on how dense the fog is.
//
// WHAT THIS RENDERER CANNOT DO. The WebGL path is a MapLibre style layer and
// is inserted directly beneath the motorway layer (fog-controller.ts), so
// motorways draw over the fog and stay crisp while everything below it is
// dimmed. This one is a <canvas> appended to the map container - a DOM
// overlay above the entire map, not a style layer - so there is no way to
// interleave it with the vector layers. On a device without WebGL2 the fog
// therefore covers everything uniformly, motorways included, and every
// detail of the base map keeps showing through it at 1 - FOG_MAX_OPACITY.
// This is a real divergence in what a user sees, not an approximation; it
// is recorded as an Open Item in SPEC.md Section 14.
const FOG_CSS_COLOR = `rgba(199, 194, 182, ${CONFIG.FOG_MAX_OPACITY})`;

export interface CanvasFogFallbackOptions {
  map: MaplibreMap;
  grid: GridSize;
  gridParams: GridParams;
  getMask: () => Uint8Array;
}

/**
 * Section 7.3's fallback overlay. Iterating the full mask on every redraw
 * (a plain bit scan, no projection) is cheap even for Karlsruhe's ~143k
 * cells (Section 6.2); the expensive part - `map.project` - only runs for
 * cells that are actually revealed, which is the minority for most of a
 * player's history. That is the deliberate cost trade-off here, not an
 * oversight: bounding the *unrevealed* majority to a viewport-sized cell
 * range would need the grid's inverse projection duplicated locally, for a
 * path the spec explicitly says need not chase the WebGL path's
 * performance.
 */
export class CanvasFogFallback {
  private readonly map: MaplibreMap;
  private readonly grid: GridSize;
  private readonly gridParams: GridParams;
  private readonly getMask: () => Uint8Array;
  readonly canvas: HTMLCanvasElement;
  private readonly handleMoveEnd = () => this.redraw();

  constructor(options: CanvasFogFallbackOptions) {
    this.map = options.map;
    this.grid = options.grid;
    this.gridParams = options.gridParams;
    this.getMask = options.getMask;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'fog-canvas-fallback';
    this.map.getContainer().appendChild(this.canvas);

    this.map.on('moveend', this.handleMoveEnd);
    // The very first paint is not itself a "redraw on moveend" - without
    // it the fallback would show a blank map until the user's first pan or
    // zoom, which is worse than the literal wording of Section 7.3 was
    // guarding against.
    this.redraw();
  }

  private resizeCanvas(): void {
    const container = this.map.getContainer();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
  }

  /** Screen pixels spanned by one grid cell at the current view - used to size the punched holes. */
  private estimateCellPixelSize(): number {
    const origin = this.map.project([this.gridParams.origin_lon, this.gridParams.origin_lat]);
    const neighbour = cellCenterXY(1, 0, this.gridParams);
    const east = this.map.project([neighbour.lon, this.gridParams.origin_lat]);
    return Math.max(1, Math.abs(east.x - origin.x));
  }

  redraw(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    this.resizeCanvas();
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cssWidth = this.canvas.width / dpr;
    const cssHeight = this.canvas.height / dpr;

    ctx.clearRect(0, 0, cssWidth, cssHeight);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = FOG_CSS_COLOR;
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    const mask = this.getMask();
    const cellPx = this.estimateCellPixelSize();
    const margin = cellPx / 2 + 1;
    const total = this.grid.width * this.grid.height;

    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    for (let index = 0; index < total; index++) {
      if (!isRevealed(mask, index)) {
        continue;
      }
      const { x, y } = cellToTexel(index, this.grid);
      const centre = cellCenterXY(x, y, this.gridParams);
      const point = this.map.project([centre.lon, centre.lat]);
      if (
        point.x < -margin ||
        point.x > cssWidth + margin ||
        point.y < -margin ||
        point.y > cssHeight + margin
      ) {
        continue;
      }
      ctx.fillRect(point.x - margin, point.y - margin, cellPx + 2, cellPx + 2);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  destroy(): void {
    this.map.off('moveend', this.handleMoveEnd);
    this.canvas.remove();
  }
}
