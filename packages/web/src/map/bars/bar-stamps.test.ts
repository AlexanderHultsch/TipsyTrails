import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Map as MaplibreMap } from 'maplibre-gl';
import { CONFIG } from '@tipsytrails/shared';
import type { Bar } from '../../api/types.js';
import { cocktailGlassPathData } from '../../components/cocktail-glass.js';
import { BarStamps, barDiscoveryAnnouncement } from './bar-stamps.js';

// SPEC.md Sections 7.4 and 8.3: the moment a bar is discovered. Everything
// here is time-driven, so the whole file runs on fake timers - and the
// delays are read from CONFIG rather than written as numbers, so a test that
// still passes after a constant is changed is testing the same behaviour and
// not a coincidence.
const LEAD_IN_MS = CONFIG.FOG_REVEAL_ANIMATION_MS;

function makeBar(overrides: Partial<Bar> = {}): Bar {
  return {
    id: 1,
    districtId: 3,
    name: 'The Fox',
    address: 'Kaiserstraße 1',
    lat: 49.01,
    lon: 8.4,
    source: 'osm',
    discoveredAt: 1_700_000_000,
    mastered: false,
    ...overrides,
  };
}

// The same hand-built stand-in map/bars/bar-markers.test.ts uses: a made-up
// (non-mercator) project() and a real on/off/fire event bus, since a stamp is
// re-projected on 'move' exactly as a marker is.
function createFakeMap() {
  const container = document.createElement('div');
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const map = {
    getContainer: () => container,
    project: vi.fn(([lng, lat]: [number, number]) => ({ x: lng * 100, y: lat * 100 })),
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
  return { map, container };
}

function createStamps(options: { reducedMotion?: boolean } = {}) {
  const { map, container } = createFakeMap();
  // Every set this publishes, in order - the marker layer's side of the
  // hand-over (BarMarkers.setStamping).
  const stamping: number[][] = [];
  const stamps = new BarStamps({
    map: map as unknown as MaplibreMap,
    prefersReducedMotion: () => options.reducedMotion === true,
    onStampingChange: (ids) => stamping.push([...ids]),
  });
  return { map, container, stamps, stamping };
}

function stampElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('.bar-stamp'));
}

function stampedNames(container: HTMLElement): string[] {
  return stampElements(container).map(
    (stamp) => stamp.querySelector('.bar-stamp__name')?.textContent ?? '',
  );
}

function announcementText(container: HTMLElement): string {
  return container.querySelector('.bar-stamps__announcement')?.textContent ?? '';
}

describe('BarStamps (SPEC.md Sections 7.4, 8.3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // The response that discovers nothing is most sample responses on a walk,
  // and it must produce no announcement, no dim and no mark. A stamp keyed on
  // anything other than what was actually discovered - a counter that also
  // advances when a visit completes, say - fires here.
  it('says nothing and dims nothing for a response that discovered no bars', () => {
    const { container, stamps, stamping } = createStamps();

    stamps.stamp([]);
    vi.advanceTimersByTime(LEAD_IN_MS + CONFIG.BAR_STAMP_DURATION_MS);

    expect(stampElements(container)).toHaveLength(0);
    expect(container.querySelector('.bar-stamp-scrim')).toBeNull();
    expect(announcementText(container)).toBe('');
    expect(stamping).toEqual([]);
  });

  it('waits for the fog to clear, then stamps the glass at the bar itself', () => {
    const { container, stamps } = createStamps();

    stamps.stamp([makeBar({ lon: 8.4, lat: 49.01 })]);

    // Step two of the moment is the fog clearing; the stamp is step five.
    vi.advanceTimersByTime(LEAD_IN_MS - 1);
    expect(stampElements(container)).toHaveLength(0);

    vi.advanceTimersByTime(1);
    const stamp = stampElements(container)[0];
    expect(stamp).toBeDefined();
    // Projected through the map, exactly as a marker is - not placed in a
    // corner of the screen.
    expect(stamp.style.left).toBe('840px');
    expect(stamp.style.top).toBe('4901px');
    expect(container.querySelector('.bar-stamp-scrim')).not.toBeNull();
  });

  it('draws the shared cocktail glass, not a copy of the path', () => {
    const { container, stamps } = createStamps();

    stamps.stamp([makeBar()]);
    vi.advanceTimersByTime(LEAD_IN_MS);

    const paths = Array.from(container.querySelectorAll('.bar-stamp svg.cocktail-glass path')).map(
      (path) => path.getAttribute('d') ?? '',
    );
    // A newly discovered bar is not mastered (Section 5.7), so it is the
    // full glass - and it is the same full glass the marker under it draws,
    // which is what makes the hand-over invisible.
    expect(paths).toEqual(cocktailGlassPathData(false));
  });

  it('repositions the stamp on move, so a pan mid-stamp does not leave it behind', () => {
    const { map, container, stamps } = createStamps();

    stamps.stamp([makeBar()]);
    vi.advanceTimersByTime(LEAD_IN_MS);

    map.project.mockReturnValueOnce({ x: 12, y: 34 });
    map.fire('move');

    const stamp = stampElements(container)[0];
    expect(stamp.style.left).toBe('12px');
    expect(stamp.style.top).toBe('34px');
  });

  it('captions it in words, in ordinary sentence case, with the bar named', () => {
    const { container, stamps } = createStamps();

    stamps.stamp([makeBar({ name: 'The Fox' })]);
    vi.advanceTimersByTime(LEAD_IN_MS);

    const stamp = stampElements(container)[0];
    // Upper case is CSS's business (index.css, .bar-stamp__title) so the
    // string in the document stays ordinary English.
    expect(stamp.querySelector('.bar-stamp__title')?.textContent).toBe('Bar discovered');
    expect(stamp.querySelector('.bar-stamp__name')?.textContent).toBe('The Fox');
    // The words reach a screen reader through the live region below and only
    // there, so this visual half is hidden from it rather than announced a
    // second time as it comes and goes.
    expect(stamp.getAttribute('aria-hidden')).toBe('true');
  });

  describe('the announcement (SPEC.md Section 8.1)', () => {
    it('is a polite status, not an alert', () => {
      const { container, stamps } = createStamps();

      stamps.stamp([makeBar({ name: 'The Fox' })]);

      const region = container.querySelector('.bar-stamps__announcement');
      // role="status" is what the map's other messages use: finding a bar is
      // not an error and must not interrupt what is being read out.
      expect(region?.getAttribute('role')).toBe('status');
      expect(region?.getAttribute('role')).not.toBe('alert');
    });

    it('says it once for the whole batch, however many bars it carried', () => {
      const { container, stamps } = createStamps();

      stamps.stamp([makeBar({ id: 1, name: 'The Fox' }), makeBar({ id: 2, name: 'Anchor Bar' })]);
      vi.advanceTimersByTime(LEAD_IN_MS + CONFIG.BAR_STAMP_STAGGER_MS);

      // One region, one sentence - three stamps in a batch must not be three
      // interruptions.
      expect(container.querySelectorAll('.bar-stamps__announcement')).toHaveLength(1);
      expect(announcementText(container)).toBe('Bars discovered: The Fox, Anchor Bar.');
    });

    it('names a single bar in the singular', () => {
      const { container, stamps } = createStamps();

      stamps.stamp([makeBar({ name: 'The Fox' })]);

      expect(announcementText(container)).toBe('Bar discovered: The Fox.');
      expect(barDiscoveryAnnouncement(['The Fox'])).toBe('Bar discovered: The Fox.');
    });
  });

  describe('a batch that discovers more than one bar', () => {
    it('stamps them one after another rather than all at the same instant', () => {
      const { container, stamps } = createStamps();

      stamps.stamp([makeBar({ id: 1, name: 'The Fox' }), makeBar({ id: 2, name: 'Anchor Bar' })]);

      vi.advanceTimersByTime(LEAD_IN_MS);
      expect(stampedNames(container)).toEqual(['The Fox']);

      vi.advanceTimersByTime(CONFIG.BAR_STAMP_STAGGER_MS);
      // They overlap on screen - one event with two marks in it, not two
      // events queued behind each other.
      expect(stampedNames(container)).toEqual(['The Fox', 'Anchor Bar']);
    });

    it('stamps every bar of a batch, not only the first', () => {
      const { container, stamps } = createStamps();
      const seen = new Set<string>();

      stamps.stamp([
        makeBar({ id: 1, name: 'The Fox' }),
        makeBar({ id: 2, name: 'Anchor Bar' }),
        makeBar({ id: 3, name: 'The Cellar' }),
      ]);
      for (
        let elapsed = 0;
        elapsed <= LEAD_IN_MS + 4 * CONFIG.BAR_STAMP_DURATION_MS;
        elapsed += 50
      ) {
        vi.advanceTimersByTime(50);
        for (const name of stampedNames(container)) {
          seen.add(name);
        }
      }

      expect([...seen].sort()).toEqual(['Anchor Bar', 'The Cellar', 'The Fox']);
    });

    it('caps how many are stamped, and names every one of them anyway', () => {
      const { container, stamps } = createStamps();
      const overflowing = CONFIG.BAR_STAMP_MAX_PER_BATCH + 2;
      const bars = Array.from({ length: overflowing }, (_, index) =>
        makeBar({ id: index + 1, name: `Bar ${index + 1}` }),
      );
      const seen = new Set<string>();

      stamps.stamp(bars);
      for (
        let elapsed = 0;
        elapsed <= LEAD_IN_MS + (overflowing + 1) * CONFIG.BAR_STAMP_DURATION_MS;
        elapsed += 50
      ) {
        vi.advanceTimersByTime(50);
        for (const name of stampedNames(container)) {
          seen.add(name);
        }
      }

      // The cap is on the animation. Nothing is withheld from the player:
      // every discovered bar is named in the one announcement, and every one
      // of them gets its permanent marker from the bar list.
      expect(seen.size).toBe(CONFIG.BAR_STAMP_MAX_PER_BATCH);
      for (const bar of bars) {
        expect(announcementText(container)).toContain(bar.name);
      }
    });
  });

  it('ends by itself, leaving no stamp, no dim and nothing to dismiss', () => {
    const { container, stamps } = createStamps();

    stamps.stamp([makeBar({ id: 1, name: 'The Fox' }), makeBar({ id: 2, name: 'Anchor Bar' })]);
    vi.advanceTimersByTime(LEAD_IN_MS + CONFIG.BAR_STAMP_STAGGER_MS + CONFIG.BAR_STAMP_DURATION_MS);

    expect(stampElements(container)).toHaveLength(0);
    expect(container.querySelector('.bar-stamp-scrim')).toBeNull();
    // The live region is the one thing that stays - it is the element
    // assistive technology is watching, and removing it would be removing
    // the thing that announces the next discovery.
    expect(container.querySelector('.bar-stamps__announcement')).not.toBeNull();
  });

  it('never leaves the previous discovery dimming the map', () => {
    const { container, stamps } = createStamps();

    stamps.stamp([makeBar({ id: 1, name: 'The Fox' })]);
    vi.advanceTimersByTime(LEAD_IN_MS);
    expect(container.querySelectorAll('.bar-stamp-scrim')).toHaveLength(1);

    // A second discovery lands while the first is still on screen.
    stamps.stamp([makeBar({ id: 2, name: 'Anchor Bar' })]);
    for (let step = 0; step < 40; step += 1) {
      vi.advanceTimersByTime(100);
      expect(container.querySelectorAll('.bar-stamp-scrim').length).toBeLessThanOrEqual(1);
    }

    expect(container.querySelector('.bar-stamp-scrim')).toBeNull();
    expect(stampElements(container)).toHaveLength(0);
  });

  // SPEC.md Sections 8.2 and 12: reduced motion removes the movement and
  // keeps the information. Disabling the whole feature is as wrong as
  // ignoring the setting - the player still has to be told they found a bar.
  describe('prefers-reduced-motion', () => {
    it('keeps the mark, the caption, the name and the announcement, and still ends', () => {
      const { container, stamps } = createStamps({ reducedMotion: true });

      stamps.stamp([makeBar({ name: 'The Fox' })]);
      vi.advanceTimersByTime(LEAD_IN_MS);

      const stamp = stampElements(container)[0];
      expect(stamp).toBeDefined();
      expect(stamp.querySelector('svg.cocktail-glass')).not.toBeNull();
      expect(stamp.querySelector('.bar-stamp__title')?.textContent).toBe('Bar discovered');
      expect(stamp.querySelector('.bar-stamp__name')?.textContent).toBe('The Fox');
      expect(announcementText(container)).toBe('Bar discovered: The Fox.');
      expect(container.querySelector('.bar-stamp-scrim')).not.toBeNull();

      vi.advanceTimersByTime(CONFIG.BAR_STAMP_DURATION_MS);
      expect(stampElements(container)).toHaveLength(0);
      expect(container.querySelector('.bar-stamp-scrim')).toBeNull();
    });

    it('drops the animation rather than shortening it', () => {
      const { container, stamps } = createStamps({ reducedMotion: true });

      stamps.stamp([makeBar()]);
      vi.advanceTimersByTime(LEAD_IN_MS);

      // The modifier class is what carries every animation (index.css), so
      // its absence is the whole of "no scale, no travel, no pulse".
      expect(stampElements(container)[0].classList.contains('bar-stamp--motion')).toBe(false);
      expect(
        container.querySelector('.bar-stamp-scrim')?.classList.contains('bar-stamp-scrim--motion'),
      ).toBe(false);
    });

    it('animates for everyone else, over exactly the constant that removes it', () => {
      const { container, stamps } = createStamps({ reducedMotion: false });

      stamps.stamp([makeBar()]);
      vi.advanceTimersByTime(LEAD_IN_MS);

      const stamp = stampElements(container)[0];
      expect(stamp.classList.contains('bar-stamp--motion')).toBe(true);
      // The animation's length is the constant, handed to CSS rather than
      // repeated in it - a duration living only in the stylesheet is exactly
      // the number Section 0 rule 3 forbids.
      expect(stamp.style.getPropertyValue('--bar-stamp-duration')).toBe(
        `${CONFIG.BAR_STAMP_DURATION_MS}ms`,
      );
      expect(
        container.querySelector('.bar-stamp-scrim')?.classList.contains('bar-stamp-scrim--motion'),
      ).toBe(true);
    });
  });

  // The marker layer's half of the hand-over: the refetch a discovery
  // triggers is about to draw an identical glass on the same point.
  describe('the hand-over to the permanent marker', () => {
    it('claims the bar before its stamp appears and releases it when the stamp goes', () => {
      const { stamps, stamping } = createStamps();

      stamps.stamp([makeBar({ id: 7 })]);
      // Immediately, not at the stamp's first frame: the marker arrives from
      // a refetch that starts the moment the discovery lands, which is
      // during the lead-in.
      expect(stamping).toEqual([[7]]);

      vi.advanceTimersByTime(LEAD_IN_MS + CONFIG.BAR_STAMP_DURATION_MS - 1);
      expect(stamping[stamping.length - 1]).toEqual([7]);

      vi.advanceTimersByTime(1);
      expect(stamping[stamping.length - 1]).toEqual([]);
    });

    it('never claims a bar it did not stamp', () => {
      const { stamps, stamping } = createStamps();
      const bars = Array.from({ length: CONFIG.BAR_STAMP_MAX_PER_BATCH + 2 }, (_, index) =>
        makeBar({ id: index + 1 }),
      );

      stamps.stamp(bars);

      // A bar past the cap gets no stamp, so its marker must not be held
      // back waiting for one.
      expect(stamping[0]).toHaveLength(CONFIG.BAR_STAMP_MAX_PER_BATCH);
    });
  });

  it('removes the move listener, its elements and its pending timers on destroy', () => {
    const { map, container, stamps } = createStamps();
    stamps.stamp([makeBar()]);
    expect(map.on).toHaveBeenCalledWith('move', expect.any(Function));

    stamps.destroy();
    vi.advanceTimersByTime(LEAD_IN_MS + CONFIG.BAR_STAMP_DURATION_MS);

    expect(map.off).toHaveBeenCalledWith('move', expect.any(Function));
    expect(container.querySelector('.bar-stamps')).toBeNull();
    // Nothing scheduled before the map went away may put an element back
    // into a container that is no longer on the page.
    expect(container.querySelector('.bar-stamp')).toBeNull();
  });
});
