// Section 8.1/8.3: bar markers on the map - solid black pictograms, no
// gradient, shadow, or outline. The single accent colour (Section 8.1) is
// reserved for the player's own position and active states, so it never
// appears on a marker itself; the only place it shows up here is the
// focus-visible ring, the same treatment .field input already gets in
// index.css. A mastered bar is neither the player's position nor an active
// state, so it is not an exception to that: both states of the mark are ink,
// and what separates them is the shape of the glass
// (components/cocktail-glass.ts, which owns both).
//
// Two modes, and the difference is whether the marker is a control at all.
// On the map screen it is: Section 7.5's check-in is offered by tapping it,
// so it is a button. In the admin's teleport picker (map/MapPicker.tsx,
// SPEC.md Section 9.3) the same marks are drawn as decoration - the tap
// there belongs to the map, which is what places the pin - so they are inert
// spans, hidden from assistive technology and passing pointer events
// through. `onSelect: null` selects that mode; see BarMarkersOptions.
//
// Positioned as absolutely-placed DOM elements re-projected via
// `map.project` on every 'move', the same approach
// map/fog/canvas-fallback.ts takes for the fog overlay - not
// maplibregl.Marker, so this stays testable against a hand-built fake map
// the way canvas-fallback.test.ts and fog-controller.test.ts already are,
// with no extra library surface to stand in for.
import type { Map as MaplibreMap } from 'maplibre-gl';
import type { Bar } from '../../api/types.js';
import { barAccessibleName, cocktailGlassSvgMarkup } from '../../components/cocktail-glass.js';

// Section 11.3, a Definition-of-Done item: community bars carry a visible
// distinguishing marker. A small solid dot in the corner - a shape
// difference, not a colour one (Section 8.1's rule that the accent colour
// is never the only carrier of meaning applies just as much to "no colour
// at all" as it does to the accent itself) - paired with text in the
// button's own aria-label below, so the distinction survives for anyone who
// cannot see the shape either.
const COMMUNITY_MARK_SVG =
  '<svg class="bar-marker__community-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
  '<circle cx="19" cy="5" r="4"/>' +
  '</svg>';

// The constructor bag, contextually typed from the one `new BarMarkers({…})`
// call site, so it is not surface.
//
// `onSelect: null` is the decorative mode SPEC.md Sections 8.3/9.3 give the
// admin's teleport picker (map/MapPicker.tsx). It is one parameter and not
// two on purpose: "there is nothing to select" and "this is not a control"
// are the same fact, and splitting them would allow the two combinations
// that must never exist - a decorative marker that still fires a selection,
// and a tappable marker with no handler behind it.
interface BarMarkersOptions {
  map: MaplibreMap;
  onSelect: ((bar: Bar) => void) | null;
}

/**
 * Everything about a bar that the marker actually draws, as one comparable
 * value — the mastered glass (Section 5.7) and the community dot (Section
 * 11.3). A marker is repainted when this changes and left alone otherwise,
 * so a repeated `GET /api/bars` answering the same thing costs nothing.
 */
function markerStateOf(bar: Bar): string {
  return `${bar.mastered ? 'mastered' : 'not-mastered'}:${bar.source}:${bar.name}`;
}

interface MarkerEntry {
  bar: Bar;
  // HTMLElement and not HTMLButtonElement: a decorative marker is not a
  // button at all (createElement below), and typing this to the interactive
  // case would only push the cast one level down.
  element: HTMLElement;
}

export class BarMarkers {
  private readonly map: MaplibreMap;
  private readonly onSelect: ((bar: Bar) => void) | null;
  private readonly container: HTMLDivElement;
  private readonly markers = new Map<number, MarkerEntry>();
  // The bars whose discovery stamp is currently playing (map/bars/
  // bar-stamps.ts). Held here rather than passed through setBars because the
  // two arrive independently: the stamp starts the moment the discovery
  // lands, and the bar list carrying that same bar arrives from a refetch
  // some time afterwards.
  private stamping: ReadonlySet<number> = new Set();
  private readonly handleMove = () => this.reposition();

  constructor(options: BarMarkersOptions) {
    this.map = options.map;
    this.onSelect = options.onSelect;
    this.container = document.createElement('div');
    this.container.className = 'bar-markers';
    // Decorative markers are hidden from assistive technology as one set,
    // here, rather than attribute by attribute on every element: one
    // `aria-hidden` on the container covers the marks, the glasses inside
    // them and the community description alike, and cannot be left off a
    // marker created later by a refetch. What it hides is a scattering of
    // unlabelled positions on a canvas map that carries no accessible
    // geometry to relate them to - see createElement below for why they are
    // not controls in this mode, and SPEC.md Section 9.3 for what carries
    // the same information as text.
    if (this.onSelect === null) {
      this.container.setAttribute('aria-hidden', 'true');
    }
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
        // Section 5.7: mastering a bar changes which glass its marker draws,
        // and the marker for a bar the player has *already* discovered is
        // exactly the one that changes - so the element is repainted rather
        // than only the record behind it being replaced. Keeping the element
        // (rather than recreating it) is what stops a bar list arriving
        // mid-tap from destroying the button under the finger.
        const changed = markerStateOf(existing.bar) !== markerStateOf(bar);
        existing.bar = bar;
        if (changed) {
          this.paintElement(existing.element, bar);
        }
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

  /**
   * Sections 7.4/8.3's hand-over: while a bar's discovery stamp is on
   * screen, that bar's marker gives up its ink so the stamp is the only
   * glass at that point (index.css, `.bar-marker--stamping`) - a stamp
   * landing on an identical marker that just appeared is a flicker, not a
   * moment, and the two arrive within a few hundred milliseconds of each
   * other by construction.
   *
   * What it does *not* do is hide the marker. The button keeps its 44 px tap
   * target, its accessible name and its place in the tab order throughout,
   * because Section 7.5's check-in has to stay reachable at the bar the
   * player has just walked up to - including in the second and a half in
   * which they are being told they found it.
   */
  setStamping(barIds: ReadonlySet<number>): void {
    this.stamping = barIds;
    for (const [id, entry] of this.markers) {
      entry.element.classList.toggle('bar-marker--stamping', barIds.has(id));
    }
  }

  private createElement(bar: Bar): HTMLElement {
    // Section 9.3's teleport picker: the marker is a drawing of where a bar
    // is and nothing else. It is a `span` rather than a disabled or
    // no-op button because the element's *tag* is what decides three things
    // at once - what it announces itself as, whether it takes focus, and
    // whether it is a plausible target for a tap. A button that did nothing
    // would still be announced as a control, still be in the tab order and
    // still invite the tap, and the whole point of the picker is that the
    // tap belongs to the map underneath. `pointer-events: none` in index.css
    // is the other half of this and is not optional either: the class this
    // element carries sizes it to a 44 px circle, and a span that size
    // swallows a tap exactly as a button does.
    if (this.onSelect === null) {
      const mark = document.createElement('span');
      this.paintElement(mark, bar);
      return mark;
    }
    const button = document.createElement('button');
    button.type = 'button';
    this.paintElement(button, bar);
    button.addEventListener('click', () => {
      const entry = this.markers.get(bar.id);
      if (entry) {
        this.onSelect?.(entry.bar);
      }
    });
    return button;
  }

  /**
   * Writes everything about a marker that depends on the bar's own state -
   * its classes, its accessible name and its contents - so that a marker
   * created now and a marker repainted after a change go through one piece
   * of code and cannot end up saying different things.
   */
  private paintElement(element: HTMLElement, bar: Bar): void {
    const isCommunity = bar.source === 'community';
    const decorative = this.onSelect === null;
    element.className = [
      'bar-marker',
      bar.mastered ? 'bar-marker--mastered' : null,
      isCommunity ? 'bar-marker--community' : null,
      // Carried on every marker rather than only on the container, because
      // this is what index.css hangs `pointer-events: none` off, and a
      // descendant selector would have to name an ancestor this class owns.
      decorative ? 'bar-marker--decorative' : null,
      // This rebuilds the whole class list, so the stamp's hand-over has to
      // be part of it: a marker created (or repainted) while its stamp is
      // playing would otherwise arrive with its ink showing, which is the
      // exact frame setStamping exists to prevent - and that marker is
      // created by the refetch the discovery itself triggered, so it is the
      // normal case rather than an edge one.
      this.stamping.has(bar.id) ? 'bar-marker--stamping' : null,
    ]
      .filter((name) => name !== null)
      .join(' ');
    // Section 5.7 / Section 8.1: the mastered state goes into the accessible
    // *name*, because the glass is the marker's entire content and a screen
    // reader user gets nothing at all from a fuller or emptier one. The
    // community distinction stays a description (aria-describedby below)
    // rather than joining it: that one is supplementary information about
    // where the bar came from, while whether the player has mastered it is
    // what this control is showing.
    //
    // A decorative marker gets neither, and that is not an omission: the
    // whole set is `aria-hidden` (constructor above), so a name on it would
    // be a name nothing can reach - and an accessible name is the promise
    // that something is there to be acted on.
    if (!decorative) {
      element.setAttribute('aria-label', barAccessibleName(bar.name, bar.mastered));
    } else {
      element.removeAttribute('aria-label');
    }
    element.innerHTML = isCommunity
      ? cocktailGlassSvgMarkup(bar.mastered) + COMMUNITY_MARK_SVG
      : cocktailGlassSvgMarkup(bar.mastered);
    if (isCommunity && !decorative) {
      const descriptionId = `bar-marker-community-desc-${bar.id}`;
      const description = document.createElement('span');
      description.id = descriptionId;
      description.className = 'visually-hidden';
      description.textContent = 'Added by the community';
      element.appendChild(description);
      element.setAttribute('aria-describedby', descriptionId);
    } else {
      element.removeAttribute('aria-describedby');
    }
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
