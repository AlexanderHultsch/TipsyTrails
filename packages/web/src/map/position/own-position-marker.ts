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
//
// It does show which way the player is travelling when the fix carries a
// course (Section 8.3): a translucent cone in the same accent colour,
// drawn beneath the dot. That is the GPS course - the direction of
// movement - and not the direction the phone is pointed, so it is absent
// while the player stands still, which is when the Geolocation API reports
// no course at all. Nothing is shown then, for the same reason setPosition
// below shows nothing before the first fix: a cone pointing north while
// nobody is moving is a wrong answer, not a cheaper one.
import type { Map as MaplibreMap } from 'maplibre-gl';

// A wedge from the dot's centre, 60 degrees wide, pointing up (course 0,
// true north, on a north-up map). Every point of it sits exactly 12 from
// the centre - the viewBox's inscribed radius - so rotating it about that
// centre can never push it outside the viewBox and have it clipped.
const HEADING_CONE_PATH = 'M12 12L6 1.61A12 12 0 0 1 18 1.61Z';

const OWN_POSITION_MARKER_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
  `<g class="own-position-marker__heading"><path d="${HEADING_CONE_PATH}" opacity="0.3"/></g>` +
  '<circle cx="12" cy="12" r="10" opacity="0.3"/>' +
  '<circle cx="12" cy="12" r="4.5"/>' +
  '</svg>';

export interface OwnPositionMarkerOptions {
  map: MaplibreMap;
}

// Everything this marker needs of a position, and no more. Deliberately not
// tracking/useSampleTracking.ts's LastAcceptedPosition: that type carries an
// accuracy this marker never reads (see the header comment), and demanding it
// would shut out the other holder of a player position - map/MapPicker.tsx's
// one-shot fix, which has no accuracy to give. A LastAcceptedPosition still
// satisfies this structurally, so the map screen passes one unchanged.
export interface OwnPositionMarkerPosition {
  lat: number;
  lon: number;
  // Degrees clockwise from true north, as GeolocationCoordinates.heading
  // reports it, or nothing at all - null when the device is stationary or
  // cannot tell, absent for the picker's own one-shot fix, and NaN on some
  // platforms. Optional for that last holder's sake: map/MapPicker.tsx has
  // no course to give and must keep compiling without one.
  heading?: number | null;
}

export class OwnPositionMarker {
  private readonly map: MaplibreMap;
  private readonly container: HTMLElement;
  private readonly element: HTMLDivElement;
  private readonly svg: SVGSVGElement;
  private readonly headingCone: SVGGElement;
  private position: OwnPositionMarkerPosition | null = null;
  private readonly handleMove = () => this.reposition();

  constructor(options: OwnPositionMarkerOptions) {
    this.map = options.map;
    this.container = this.map.getContainer();
    this.element = document.createElement('div');
    this.element.className = 'own-position-marker';
    this.element.setAttribute('aria-hidden', 'true');
    this.element.innerHTML = OWN_POSITION_MARKER_SVG;
    this.svg = this.element.querySelector('svg') as SVGSVGElement;
    this.headingCone = this.svg.querySelector('g') as SVGGElement;
    this.headingCone.remove();
    this.map.on('move', this.handleMove);
  }

  /**
   * Shows the marker at `position`, or removes it entirely when `position`
   * is null - a marker at a default coordinate would tell the player they
   * are somewhere they are not, so nothing is shown before the first fix
   * arrives (SPEC.md Section 8.3/8.1).
   */
  setPosition(position: OwnPositionMarkerPosition | null): void {
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
    this.renderHeading();
  }

  // Two fingers rotate this map - neither map instance disables MapLibre's
  // dragRotate or touchZoomRotate - so a cone turned by the course alone
  // would point the right way only while the map happens to be north-up.
  // What it is turned by on screen is the course minus the map's own
  // bearing. Rotation happens on this <g> and about the dot's centre,
  // never on the host element: that element's CSS transform is
  // translate(-50%, -50%), which is what centres the marker on its
  // coordinate, and folding a rotation into it would quietly undo that.
  //
  // Called from reposition(), so the map's own 'move' event keeps this in
  // step: MapLibre fires 'move' for a bearing change too, both from the
  // rotate handlers (ui/handler_manager.ts counts rotate as moving) and
  // from a programmatic jumpTo/easeTo, so no second subscription is needed.
  private renderHeading(): void {
    const heading = this.position?.heading;
    if (typeof heading !== 'number' || !Number.isFinite(heading)) {
      this.headingCone.remove();
      return;
    }
    this.headingCone.setAttribute('transform', `rotate(${heading - this.map.getBearing()} 12 12)`);
    if (this.headingCone.parentNode === null) {
      this.svg.insertBefore(this.headingCone, this.svg.firstChild);
    }
  }

  destroy(): void {
    this.map.off('move', this.handleMove);
    this.element.remove();
  }
}
