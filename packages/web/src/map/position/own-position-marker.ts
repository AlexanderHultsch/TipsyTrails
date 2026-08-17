// Section 8.1/8.3: the player's own position on the map - the one marker
// permitted to use the accent colour (Section 8.1: "reserved for the
// player's own position and for active states"). Positioned the same way
// map/bars/bar-markers.ts positions a bar marker - an absolutely-placed DOM
// element re-projected via `map.project` on every 'move' - not a second
// mechanism for putting something at a coordinate on this map.
//
// The marker is a solid dot with a halo, not the bar marker's martini-glass
// pictogram: Section 8.1's accessibility-pass rule ("the accent red is
// never the only carrier of meaning") applies here too, so the two markers
// are never told apart by colour alone.
//
// Section 8.6 already covers accuracy reporting through the tracking
// indicator, so this marker carries no accuracy display of its own - it is
// decorative (aria-hidden), not interactive, and takes no focus.
import type { Map as MaplibreMap } from 'maplibre-gl';
import type { LastAcceptedPosition } from '../../tracking/useSampleTracking.js';

const OWN_POSITION_MARKER_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
  '<circle cx="12" cy="12" r="10" opacity="0.3"/>' +
  '<circle cx="12" cy="12" r="4.5"/>' +
  '</svg>';

export interface OwnPositionMarkerOptions {
  map: MaplibreMap;
}

export class OwnPositionMarker {
  private readonly map: MaplibreMap;
  private readonly container: HTMLElement;
  private readonly element: HTMLDivElement;
  private position: LastAcceptedPosition | null = null;
  private readonly handleMove = () => this.reposition();

  constructor(options: OwnPositionMarkerOptions) {
    this.map = options.map;
    this.container = this.map.getContainer();
    this.element = document.createElement('div');
    this.element.className = 'own-position-marker';
    this.element.setAttribute('aria-hidden', 'true');
    this.element.innerHTML = OWN_POSITION_MARKER_SVG;
    this.map.on('move', this.handleMove);
  }

  /**
   * Shows the marker at `position`, or removes it entirely when `position`
   * is null - a marker at a default coordinate would tell the player they
   * are somewhere they are not, so nothing is shown before the first fix
   * arrives (SPEC.md Section 8.3/8.1).
   */
  setPosition(position: LastAcceptedPosition | null): void {
    const hadPosition = this.position !== null;
    this.position = position;
    if (position === null) {
      if (hadPosition) {
        this.element.remove();
      }
      return;
    }
    if (!hadPosition) {
      this.container.appendChild(this.element);
    }
    this.reposition();
  }

  private reposition(): void {
    if (!this.position) {
      return;
    }
    const point = this.map.project([this.position.lon, this.position.lat]);
    this.element.style.left = `${point.x}px`;
    this.element.style.top = `${point.y}px`;
  }

  destroy(): void {
    this.map.off('move', this.handleMove);
    this.element.remove();
  }
}
