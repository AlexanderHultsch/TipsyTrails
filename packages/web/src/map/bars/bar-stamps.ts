// SPEC.md Sections 7.4 and 8.3: discovering a bar is a moment on the map,
// not a line in a log. The player walks into a bar's discovery radius, the
// fog clears (Section 7.3, and that already happened), the map dims a
// little, and the cocktail glass is stamped onto the map at the bar with a
// short caption - "BAR DISCOVERED" and the bar's name - which then goes away
// by itself.
//
// It is anchored at the bar and not at a corner of the screen, so it is
// positioned exactly the way map/bars/bar-markers.ts positions a marker:
// absolutely-placed DOM inside the map's own container, re-projected through
// `map.project` on every 'move'. Sharing that approach rather than inventing
// a second one is what keeps a stamp and the marker it hands over to on the
// same point of the map while the player pans mid-stamp.
//
// THE HAND-OVER, which is the part that is easy to get wrong. A discovery
// also advances `discoveryVersion`, which refetches GET /api/bars, which
// draws this same bar's permanent marker at this same point - so the stamp
// and the marker are about to be two identical glasses on one spot, and a
// stamp landing on a marker that just appeared is a flicker rather than a
// moment. So the two are not left to race: every bar being stamped is
// published through `onStampingChange` and BarMarkers hides that marker's
// ink for exactly as long as its stamp is on screen (`setStamping` there).
// One glass is visible throughout - the moving one - and the marker takes
// over the instant the stamp is removed. The marker's *button* is never
// hidden, only its ink: it keeps its 44 px tap target, its accessible name
// and its place in the tab order, because a player who taps the bar they
// just found must reach the check-in flow mid-stamp (Section 7.5).
//
// Nothing here takes a pointer event (index.css, `.bar-stamps`), there is
// nothing to dismiss, and no state a player can be stuck in: every element
// this creates is removed by a timer it schedules when it creates it.
import { CONFIG } from '@tipsytrails/shared';
import type { Map as MaplibreMap } from 'maplibre-gl';
import type { Bar } from '../../api/types.js';
import { cocktailGlassSvgMarkup } from '../../components/cocktail-glass.js';

/**
 * The caption, in the app's own words rather than as an image (Section 8.1).
 * Sentence case here and upper case in CSS (`text-transform`, index.css), so
 * what any reader of the DOM gets is an ordinary English string and not
 * shouting.
 */
export const BAR_STAMP_CAPTION = 'Bar discovered';

/**
 * What is said in words, for the one live region this layer owns.
 *
 * SPEC.md Section 8.1: nothing may rely on a visual channel alone, and this
 * whole feature is a shape appearing on a map. It is `role="status"` and not
 * `role="alert"` - the same choice the map's own toasts make (screens/
 * Map.tsx): finding a bar is good news and not an error, and it must not cut
 * off whatever a screen reader is part-way through saying.
 *
 * One sentence for the whole batch, however many bars it carried and however
 * many of them were stamped (`BAR_STAMP_MAX_PER_BATCH` caps the animation,
 * never the information). A live region written once per bar would announce
 * a three-bar batch three times, which is the interruption this is written
 * to avoid.
 */
export function barDiscoveryAnnouncement(names: string[]): string {
  return names.length === 1
    ? `Bar discovered: ${names[0]}.`
    : `Bars discovered: ${names.join(', ')}.`;
}

// SPEC.md Section 8.2. jsdom (this repo's test environment) implements no
// `matchMedia` at all, so this guard is load-bearing for tests rather than
// merely defensive - calling it unconditionally throws under jsdom.
//
// map/fog/fog-controller.ts holds the same four lines for the fog's reveal
// animation. Two copies is one too many and this is the deliberate reason
// for it: the fog renderer is out of scope for this change, and moving its
// copy into a shared module is a change to the fog. Whoever next has reason
// to touch that file should lift both into one place.
function defaultPrefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

// The constructor bag, contextually typed from the one `new BarStamps({…})`
// call site, so it is not surface.
interface BarStampsOptions {
  map: MaplibreMap;
  /** Injectable so a test can force either branch - see map/fog/fog-controller.ts. */
  prefersReducedMotion?: () => boolean;
  /**
   * The bars whose stamp is currently claimed - scheduled or on screen. The
   * marker layer hides exactly these markers' ink; see the hand-over note at
   * the top of this file. Called with a fresh set every time it changes, so
   * a React consumer holding it as state sees a new value.
   */
  onStampingChange?: (barIds: ReadonlySet<number>) => void;
}

interface StampEntry {
  bar: Bar;
  element: HTMLDivElement;
}

export class BarStamps {
  private readonly map: MaplibreMap;
  private readonly reducedMotion: () => boolean;
  private readonly onStampingChange?: (barIds: ReadonlySet<number>) => void;
  private readonly container: HTMLDivElement;
  private readonly announcement: HTMLParagraphElement;
  private readonly stamps = new Map<number, StampEntry>();
  // Every bar whose stamp has been scheduled and not yet removed, which is a
  // wider window than `stamps` above and is deliberately the one the marker
  // layer is told about. The marker arrives from a refetch that starts the
  // moment the discovery lands, well before the stamp appears, so a marker
  // suppressed only from the stamp's first frame would show its glass, hide
  // it again and show it once more - three states where the point of the
  // hand-over is one.
  private readonly claimed = new Set<number>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private scrim: HTMLDivElement | null = null;
  private readonly handleMove = () => this.reposition();
  private destroyed = false;

  constructor(options: BarStampsOptions) {
    this.map = options.map;
    this.reducedMotion = options.prefersReducedMotion ?? defaultPrefersReducedMotion;
    this.onStampingChange = options.onStampingChange;
    this.container = document.createElement('div');
    this.container.className = 'bar-stamps';
    // Created empty, at mount, and never replaced. A live region that is
    // inserted into the document already carrying its text is unreliably
    // announced - assistive technology watches an existing region for
    // changes - so what changes here is this element's text and never the
    // element itself.
    this.announcement = document.createElement('p');
    this.announcement.className = 'bar-stamps__announcement visually-hidden';
    this.announcement.setAttribute('role', 'status');
    this.container.appendChild(this.announcement);
    this.map.getContainer().appendChild(this.container);
    this.map.on('move', this.handleMove);
  }

  /**
   * Announces one POST /api/samples response's newly discovered bars and
   * stamps them onto the map, one after another.
   *
   * Called only for a response that actually discovered something
   * (map/bars/useBarStamps.ts keys on `newBarsVersion`); an empty batch is
   * ignored here as well, so neither an empty array nor a repeated one can
   * put an announcement on screen or dim the map for nothing.
   */
  stamp(bars: Bar[]): void {
    if (this.destroyed || bars.length === 0) {
      return;
    }
    this.announcement.textContent = barDiscoveryAnnouncement(bars.map((bar) => bar.name));

    const stamped = bars.slice(0, CONFIG.BAR_STAMP_MAX_PER_BATCH);
    for (const bar of stamped) {
      this.claimed.add(bar.id);
    }
    this.publishStamping();

    // The owner's sequence is: the fog clears, then the map dims, then the
    // glass is stamped. So the stamp waits out the fog's own reveal
    // animation before anything is drawn - FOG_REVEAL_ANIMATION_MS, read
    // rather than copied, because "as long as the fog takes to clear" is one
    // fact and two numbers meaning the same thing drift apart (the same
    // argument MAP_DEFAULT_ZOOM's single constant rests on).
    //
    // It lines the two up; it cannot guarantee they line up. The reveal
    // starts when GET /api/fog answers, which is a request issued after the
    // POST that produced this batch, so the fog may still be clearing when
    // the first stamp lands on a slow connection. That is a stamp arriving
    // slightly early, not a broken sequence, and buying certainty would mean
    // the discovery waiting on the fog layer's network - a coupling worth
    // far more than the frames it would save.
    const leadInMs = CONFIG.FOG_REVEAL_ANIMATION_MS;
    const batchMs =
      (stamped.length - 1) * CONFIG.BAR_STAMP_STAGGER_MS + CONFIG.BAR_STAMP_DURATION_MS;
    this.after(leadInMs, () => this.openScrim(batchMs));
    stamped.forEach((bar, index) => {
      this.after(leadInMs + index * CONFIG.BAR_STAMP_STAGGER_MS, () => this.show(bar));
    });
  }

  private show(bar: Bar): void {
    // Defensive rather than expected: discovery is permanent (Section 7.4),
    // so the same bar cannot honestly be discovered twice. If it ever is,
    // the second stamp replaces the first instead of leaving an element
    // behind that nothing is holding a timer for.
    this.remove(bar.id);

    const element = document.createElement('div');
    element.className = this.reducedMotion() ? 'bar-stamp' : 'bar-stamp bar-stamp--motion';
    // The words are announced once, by the live region above; this is the
    // visual half of the same statement, and left readable it would be a
    // second copy of it appearing and vanishing in the reading order.
    element.setAttribute('aria-hidden', 'true');
    // The one duration, handed to CSS rather than repeated in it - see
    // BAR_STAMP_DURATION_MS.
    element.style.setProperty('--bar-stamp-duration', `${CONFIG.BAR_STAMP_DURATION_MS}ms`);
    // The glass of Section 8.1, from the one definition that owns both its
    // states (components/cocktail-glass.ts) - never a third copy of the
    // path. The state is read off the bar rather than assumed full: a bar
    // discovered now is not mastered (mastering needs a completed visit at a
    // bar the player had already discovered, Section 5.7), so this is the
    // full glass in every real case, and reading the flag is what guarantees
    // the stamp's last frame and the marker it hands over to are the same
    // shape even if that ever stops being true.
    element.innerHTML = cocktailGlassSvgMarkup(bar.mastered);
    // The caption is built as elements with `textContent` and never
    // interpolated into the markup above: a bar's name comes from OpenStreetMap
    // or from a community submission (Section 11.3) and is not this layer's
    // to trust.
    const caption = document.createElement('span');
    caption.className = 'bar-stamp__caption';
    const title = document.createElement('span');
    title.className = 'bar-stamp__title';
    title.textContent = BAR_STAMP_CAPTION;
    const name = document.createElement('span');
    name.className = 'bar-stamp__name';
    name.textContent = bar.name;
    caption.append(title, name);
    element.appendChild(caption);

    this.stamps.set(bar.id, { bar, element });
    this.container.appendChild(element);
    this.reposition();
    this.after(CONFIG.BAR_STAMP_DURATION_MS, () => {
      this.remove(bar.id);
      this.claimed.delete(bar.id);
      this.publishStamping();
    });
  }

  private remove(barId: number): void {
    const entry = this.stamps.get(barId);
    if (!entry) {
      return;
    }
    entry.element.remove();
    this.stamps.delete(barId);
  }

  // Section 8.3's "minimal abgedunkelt": a brief scrim over the map for as
  // long as the batch's stamps last, and nothing more. It is not a modal -
  // it takes no pointer events, traps no focus and has no dismiss control -
  // so the map keeps panning and a marker keeps being tappable underneath
  // it.
  //
  // One scrim, replaced rather than stacked: a second discovery arriving
  // while the first is still playing must not leave the first's dim on
  // screen, and one element with one timer is what makes that true by
  // construction instead of by a counter that has to be got right.
  private openScrim(durationMs: number): void {
    this.closeScrim();
    const scrim = document.createElement('div');
    scrim.className = this.reducedMotion()
      ? 'bar-stamp-scrim'
      : 'bar-stamp-scrim bar-stamp-scrim--motion';
    scrim.style.setProperty('--bar-stamp-scrim-duration', `${durationMs}ms`);
    this.container.appendChild(scrim);
    this.scrim = scrim;
    this.after(durationMs, () => this.closeScrim());
  }

  private closeScrim(): void {
    this.scrim?.remove();
    this.scrim = null;
  }

  private publishStamping(): void {
    this.onStampingChange?.(new Set(this.claimed));
  }

  private after(delayMs: number, run: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.destroyed) {
        return;
      }
      run();
    }, delayMs);
    this.timers.add(timer);
  }

  private reposition(): void {
    for (const { bar, element } of this.stamps.values()) {
      const point = this.map.project([bar.lon, bar.lat]);
      element.style.left = `${point.x}px`;
      element.style.top = `${point.y}px`;
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.map.off('move', this.handleMove);
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    for (const { element } of this.stamps.values()) {
      element.remove();
    }
    this.stamps.clear();
    this.claimed.clear();
    this.closeScrim();
    this.container.remove();
  }
}
