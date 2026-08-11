// Section 8.1/8.3: bar markers on the map - solid black pictograms, no
// gradient, shadow, or outline. The single accent colour (Section 8.1) is
// reserved for the player's own position and active states, so it never
// appears on a marker itself; the only place it shows up here is the
// focus-visible ring, the same treatment .field input already gets in
// index.css.
//
// Positioned as absolutely-placed DOM buttons re-projected via
// `map.project` on every 'move', the same approach
// map/fog/canvas-fallback.ts takes for the fog overlay - not
// maplibregl.Marker, so this stays testable against a hand-built fake map
// the way canvas-fallback.test.ts and fog-controller.test.ts already are,
// with no extra library surface to stand in for.
import type { Map as MaplibreMap } from 'maplibre-gl';
import type { Bar } from '../../api/types.js';

// A simple martini-glass silhouette: solid fill, no stroke, no gradient.
const BAR_MARKER_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
  '<path d="M4 4h16a1 1 0 0 1 .8 1.6l-6.8 8.7v4.7h3a1 1 0 0 1 0 2H7a1 1 0 0 1 0-2h3v-4.7L3.2 5.6A1 1 0 0 1 4 4z"/>' +
  '</svg>';

export interface BarMarkersOptions {
  map: MaplibreMap;
  onSelect: (bar: Bar) => void;
}

interface MarkerEntry {
  bar: Bar;
  element: HTMLButtonElement;
}

export class BarMarkers {
  private readonly map: MaplibreMap;
  private readonly onSelect: (bar: Bar) => void;
  private readonly container: HTMLDivElement;
  private readonly markers = new Map<number, MarkerEntry>();
  private readonly handleMove = () => this.reposition();

  constructor(options: BarMarkersOptions) {
    this.map = options.map;
    this.onSelect = options.onSelect;
    this.container = document.createElement('div');
    this.container.className = 'bar-markers';
    this.map.getContainer().appendChild(this.container);
    this.map.on('move', this.handleMove);
  }

  /** Replaces the rendered set of markers with exactly `bars`, adding and removing elements by id. */
  setBars(bars: Bar[]): void {
    const seen = new Set<number>();
    for (const bar of bars) {
      seen.add(bar.id);
      const existing = this.markers.get(bar.id);
      if (existing) {
        existing.bar = bar;
        continue;
      }
      const element = this.createElement(bar);
      this.markers.set(bar.id, { bar, element });
      this.container.appendChild(element);
    }
    for (const [id, entry] of this.markers) {
      if (!seen.has(id)) {
        entry.element.remove();
        this.markers.delete(id);
      }
    }
    this.reposition();
  }

  private createElement(bar: Bar): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'bar-marker';
    button.setAttribute('aria-label', bar.name);
    button.innerHTML = BAR_MARKER_SVG;
    button.addEventListener('click', () => {
      const entry = this.markers.get(bar.id);
      if (entry) {
        this.onSelect(entry.bar);
      }
    });
    return button;
  }

  private reposition(): void {
    for (const { bar, element } of this.markers.values()) {
      const point = this.map.project([bar.lon, bar.lat]);
      element.style.left = `${point.x}px`;
      element.style.top = `${point.y}px`;
    }
  }

  destroy(): void {
    this.map.off('move', this.handleMove);
    for (const { element } of this.markers.values()) {
      element.remove();
    }
    this.markers.clear();
    this.container.remove();
  }
}
