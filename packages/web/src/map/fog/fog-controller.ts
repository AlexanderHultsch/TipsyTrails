// Orchestrates SPEC.md Section 7.3's fog layer: picks the WebGL2 custom
// layer or the 2D canvas fallback (gated by an injectable WebGL2Detector,
// webgl-detect.ts), mounts it once the map's style has loaded, and forwards
// mask updates to whichever renderer is active. This is the seam
// useFogLayer.ts (the React hook) drives, and the seam fog-controller.test.ts
// exercises with a hand-built fake map - jsdom has no WebGL2, so "WebGL2
// available" here always means an injected detector, never a real context.
import type { Map as MaplibreMap } from 'maplibre-gl';
import type { GridParams } from '@tipsytrails/shared';
import { FIRST_ABOVE_FOG_LAYER_ID } from '../ink-style.js';
import { CanvasFogFallback } from './canvas-fallback.js';
import type { GridSize } from './grid-texture.js';
import { detectWebGL2 } from './webgl-detect.js';
import type { WebGL2Detector } from './webgl-detect.js';
import { WebGLFogLayer } from './webgl-fog-layer.js';

export const FOG_LAYER_ID = 'tipsy-trails-fog';

function defaultPrefersReducedMotion(): boolean {
  // SPEC.md Section 8.2. jsdom (this repo's test environment) implements no
  // `matchMedia` at all, so this guard is load-bearing for tests, not just
  // defensive - calling it unconditionally throws under jsdom.
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

// The constructor bag, contextually typed at the one call site, so it is not
// surface.
interface FogControllerOptions {
  map: MaplibreMap;
  grid: GridSize;
  gridParams: GridParams;
  initialMask: Uint8Array;
  /** Injectable so a test can force either rendering path (task brief) - see webgl-detect.ts. */
  detectWebGL2?: WebGL2Detector;
  prefersReducedMotion?: () => boolean;
  /** Section 7.3: "Detect and log this" when the 2D canvas fallback is used. */
  onFallback?: () => void;
}

export class FogController {
  private readonly map: MaplibreMap;
  private readonly grid: GridSize;
  private readonly gridParams: GridParams;
  private readonly detect: WebGL2Detector;
  private readonly reducedMotion: () => boolean;
  private readonly onFallback?: () => void;
  private readonly handleLoad = () => this.mount();

  private mask: Uint8Array;
  private webglLayer: WebGLFogLayer | null = null;
  private canvasFallback: CanvasFogFallback | null = null;
  private mounted = false;
  private destroyed = false;

  constructor(options: FogControllerOptions) {
    this.map = options.map;
    this.grid = options.grid;
    this.gridParams = options.gridParams;
    this.mask = options.initialMask;
    this.detect = options.detectWebGL2 ?? detectWebGL2;
    this.reducedMotion = options.prefersReducedMotion ?? defaultPrefersReducedMotion;
    this.onFallback = options.onFallback;

    // A style that has already finished loading by the time this
    // controller is constructed does not replay a past 'load' event to a
    // newly attached listener, so `loaded()` is checked up front. `loaded`
    // is called defensively (some map stand-ins, real or test doubles,
    // only implement `on`/`off`) rather than assumed present.
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

    const gl2 = this.detect();
    if (gl2) {
      this.webglLayer = new WebGLFogLayer({
        id: FOG_LAYER_ID,
        grid: this.grid,
        gridParams: this.gridParams,
        initialMask: this.mask,
        reducedMotion: this.reducedMotion,
      });
      // Section 7.3: the fog goes *below* the first of the layers that stay
      // legible on unrevealed ground - water, waterways and both road layers
      // - and above everything the fog is meant to hide. ink-style.ts names
      // that seam FIRST_ABOVE_FOG_LAYER_ID and owns which layer it is;
      // inserting the fog before it is the entire mechanism. `addLayer`
      // throws when `beforeId` names a layer the style does not have, and
      // nothing above this catches it - an exception here would take the
      // whole map down - so a style without that layer falls back to the fog
      // on top of everything, which is what it was before. `getLayer` is
      // called defensively for the same reason it is in `destroy`: some map
      // stand-ins only implement `on`/`off`/`addLayer`.
      const hasAnchorLayer =
        typeof this.map.getLayer === 'function' &&
        this.map.getLayer(FIRST_ABOVE_FOG_LAYER_ID) != null;
      if (hasAnchorLayer) {
        this.map.addLayer(this.webglLayer, FIRST_ABOVE_FOG_LAYER_ID);
      } else {
        console.warn(
          `[fog] Style has no "${FIRST_ABOVE_FOG_LAYER_ID}" layer; drawing the fog above the whole style instead.`,
        );
        this.map.addLayer(this.webglLayer);
      }
      return;
    }

    console.info('[fog] WebGL2 unavailable; falling back to the 2D canvas fog overlay.');
    this.onFallback?.();
    this.canvasFallback = new CanvasFogFallback({
      map: this.map,
      grid: this.grid,
      gridParams: this.gridParams,
      getMask: () => this.mask,
    });
  }

  /**
   * Replaces the held mask and, for the WebGL path, uploads only the
   * changed region to the GPU (WebGLFogLayer.applyDelta). The canvas
   * fallback reads the mask lazily through its `getMask` closure and only
   * repaints on `moveend` (Section 7.3), so there is nothing further to
   * push to it here.
   */
  applyMask(nextMask: Uint8Array): void {
    const previous = this.mask;
    this.mask = nextMask;
    this.webglLayer?.applyDelta(previous, nextMask);
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.map.off('load', this.handleLoad);

    if (this.webglLayer) {
      if (typeof this.map.getLayer === 'function' && this.map.getLayer(FOG_LAYER_ID)) {
        this.map.removeLayer(FOG_LAYER_ID);
      }
      this.webglLayer = null;
    }
    if (this.canvasFallback) {
      this.canvasFallback.destroy();
      this.canvasFallback = null;
    }
  }
}
