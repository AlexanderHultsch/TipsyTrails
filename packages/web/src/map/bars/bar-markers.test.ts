import { describe, expect, it, vi } from 'vitest';
import type { Map as MaplibreMap } from 'maplibre-gl';
import type { Bar } from '../../api/types.js';
import { cocktailGlassPathData } from '../../components/cocktail-glass.js';
import { BarMarkers } from './bar-markers.js';

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

/** The `d` of every path the marker's glass is actually drawn from. */
function glassPathsOf(button: Element): string[] {
  return Array.from(button.querySelectorAll('svg.cocktail-glass path')).map(
    (path) => path.getAttribute('d') ?? '',
  );
}

// Same fake-map shape as map/fog/canvas-fallback.test.ts: a hand-built
// stand-in with a made-up (non-mercator) project() and a real on/off/fire
// event bus, since BarMarkers reprojects on 'move' the same way that fallback
// redraws on 'moveend'.
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

describe('BarMarkers', () => {
  it('appends one real, keyboard-reachable button per bar to the map container', () => {
    const { map, container } = createFakeMap();
    const markers = new BarMarkers({ map: map as unknown as MaplibreMap, onSelect: vi.fn() });

    markers.setBars([makeBar({ id: 1, name: 'A' }), makeBar({ id: 2, name: 'B' })]);

    const buttons = container.querySelectorAll('button.bar-marker');
    expect(buttons).toHaveLength(2);
    buttons.forEach((button) => {
      expect(button.tagName).toBe('BUTTON');
      expect((button as HTMLButtonElement).tabIndex).toBe(0);
    });
    expect(
      container.querySelector('button.bar-marker[aria-label="A - not mastered yet"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('button.bar-marker[aria-label="B - not mastered yet"]'),
    ).not.toBeNull();
  });

  it('positions each marker from map.project and repositions it on move', () => {
    const { map, container } = createFakeMap();
    const markers = new BarMarkers({ map: map as unknown as MaplibreMap, onSelect: vi.fn() });
    markers.setBars([makeBar({ lon: 8.4, lat: 49.01 })]);

    const button = container.querySelector('button.bar-marker') as HTMLButtonElement;
    expect(button.style.left).toBe('840px');
    expect(button.style.top).toBe('4901px');

    map.project.mockReturnValueOnce({ x: 12, y: 34 });
    map.fire('move');

    expect(button.style.left).toBe('12px');
    expect(button.style.top).toBe('34px');
  });

  it('calls onSelect with the bar when its marker is activated', () => {
    const { map, container } = createFakeMap();
    const onSelect = vi.fn();
    const markers = new BarMarkers({ map: map as unknown as MaplibreMap, onSelect });
    const bar = makeBar();
    markers.setBars([bar]);

    const button = container.querySelector('button.bar-marker') as HTMLButtonElement;
    button.click();

    expect(onSelect).toHaveBeenCalledWith(bar);
  });

  it('adds and removes markers to match the given set exactly, without recreating unchanged ones', () => {
    const { map, container } = createFakeMap();
    const markers = new BarMarkers({ map: map as unknown as MaplibreMap, onSelect: vi.fn() });

    markers.setBars([makeBar({ id: 1, name: 'A' }), makeBar({ id: 2, name: 'B' })]);
    const firstElement = container.querySelector(
      'button.bar-marker[aria-label="A - not mastered yet"]',
    );

    markers.setBars([makeBar({ id: 1, name: 'A' }), makeBar({ id: 3, name: 'C' })]);

    expect(container.querySelectorAll('button.bar-marker')).toHaveLength(2);
    expect(
      container.querySelector('button.bar-marker[aria-label="B - not mastered yet"]'),
    ).toBeNull();
    expect(
      container.querySelector('button.bar-marker[aria-label="C - not mastered yet"]'),
    ).not.toBeNull();
    expect(container.querySelector('button.bar-marker[aria-label="A - not mastered yet"]')).toBe(
      firstElement,
    );
  });

  // SPEC.md Sections 5.7 and 8.1: the two states of the mark differ in the
  // shape that is drawn, not in a colour or a fill, and the state is also
  // carried in words for anyone who cannot see the shape at all.
  describe('the mastered state (SPEC.md Sections 5.7, 8.1)', () => {
    it('draws a different set of paths for a mastered bar than for one that is not', () => {
      const { map, container } = createFakeMap();
      const markers = new BarMarkers({ map: map as unknown as MaplibreMap, onSelect: vi.fn() });

      markers.setBars([
        makeBar({ id: 1, name: 'Plain', mastered: false }),
        makeBar({ id: 2, name: 'Done', mastered: true }),
      ]);

      const plain = container.querySelector(
        'button.bar-marker[aria-label="Plain - not mastered yet"]',
      ) as HTMLButtonElement;
      const done = container.querySelector(
        'button.bar-marker[aria-label="Done - mastered"]',
      ) as HTMLButtonElement;

      // The paths themselves, not the class or the fill: a mutation that
      // gave both states the same geometry and separated them only by a
      // modifier class would leave a marker whose whole content is a shape
      // saying nothing at all.
      expect(glassPathsOf(plain)).toEqual(cocktailGlassPathData(false));
      expect(glassPathsOf(done)).toEqual(cocktailGlassPathData(true));
      expect(glassPathsOf(plain)).not.toEqual(glassPathsOf(done));
      expect(done.classList.contains('bar-marker--mastered')).toBe(true);
      expect(plain.classList.contains('bar-marker--mastered')).toBe(false);
    });

    it('carries the state in the accessible name, not only in the glass', () => {
      const { map, container } = createFakeMap();
      const markers = new BarMarkers({ map: map as unknown as MaplibreMap, onSelect: vi.fn() });

      markers.setBars([
        makeBar({ id: 1, name: 'Plain', mastered: false }),
        makeBar({ id: 2, name: 'Done', mastered: true }),
      ]);

      const labels = Array.from(container.querySelectorAll('button.bar-marker')).map((button) =>
        button.getAttribute('aria-label'),
      );
      expect(labels).toEqual(['Plain - not mastered yet', 'Done - mastered']);
    });

    it('repaints an existing marker when its bar becomes mastered, keeping the element', () => {
      const { map, container } = createFakeMap();
      const markers = new BarMarkers({ map: map as unknown as MaplibreMap, onSelect: vi.fn() });

      markers.setBars([makeBar({ id: 1, name: 'The Fox', mastered: false })]);
      const before = container.querySelector('button.bar-marker') as HTMLButtonElement;
      expect(glassPathsOf(before)).toEqual(cocktailGlassPathData(false));

      // The bar this happens to is by definition one the player has already
      // discovered, so it is always an *update* to an existing marker and
      // never a new one - the case a set-difference-only setBars misses
      // entirely.
      markers.setBars([makeBar({ id: 1, name: 'The Fox', mastered: true })]);

      const after = container.querySelector('button.bar-marker') as HTMLButtonElement;
      expect(after).toBe(before);
      expect(glassPathsOf(after)).toEqual(cocktailGlassPathData(true));
      expect(after.getAttribute('aria-label')).toBe('The Fox - mastered');
    });

    it('keeps the community dot and its description on a mastered community bar', () => {
      const { map, container } = createFakeMap();
      const markers = new BarMarkers({ map: map as unknown as MaplibreMap, onSelect: vi.fn() });

      markers.setBars([makeBar({ id: 7, name: 'Cellar', source: 'community', mastered: true })]);

      const button = container.querySelector('button.bar-marker') as HTMLButtonElement;
      expect(button.classList.contains('bar-marker--community')).toBe(true);
      expect(button.classList.contains('bar-marker--mastered')).toBe(true);
      expect(button.querySelector('.bar-marker__community-mark')).not.toBeNull();
      expect(glassPathsOf(button)).toEqual(cocktailGlassPathData(true));
      // Section 11.3's distinction stays a description; Section 5.7's stays
      // in the name.
      const describedBy = button.getAttribute('aria-describedby');
      expect(describedBy).not.toBeNull();
      expect(button.querySelector(`#${describedBy}`)?.textContent).toBe('Added by the community');
      expect(button.getAttribute('aria-label')).toBe('Cellar - mastered');
    });

    it('drops the community description when a repaint turns a bar back into a plain one', () => {
      const { map, container } = createFakeMap();
      const markers = new BarMarkers({ map: map as unknown as MaplibreMap, onSelect: vi.fn() });

      markers.setBars([makeBar({ id: 7, name: 'Cellar', source: 'community' })]);
      markers.setBars([makeBar({ id: 7, name: 'Cellar', source: 'osm' })]);

      const button = container.querySelector('button.bar-marker') as HTMLButtonElement;
      expect(button.getAttribute('aria-describedby')).toBeNull();
      expect(button.querySelector('.bar-marker__community-mark')).toBeNull();
    });
  });

  it('removes the move listener and every marker element on destroy', () => {
    const { map, container } = createFakeMap();
    const markers = new BarMarkers({ map: map as unknown as MaplibreMap, onSelect: vi.fn() });
    markers.setBars([makeBar()]);
    expect(map.on).toHaveBeenCalledWith('move', expect.any(Function));

    markers.destroy();

    expect(map.off).toHaveBeenCalledWith('move', expect.any(Function));
    expect(container.querySelector('.bar-markers')).toBeNull();
    expect(container.querySelector('button.bar-marker')).toBeNull();
  });
});
