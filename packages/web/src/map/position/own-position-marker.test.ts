import { describe, expect, it, vi } from 'vitest';
import type { Map as MaplibreMap } from 'maplibre-gl';
import { OwnPositionMarker } from './own-position-marker.js';

// Same fake-map shape as map/bars/bar-markers.test.ts: a hand-built
// stand-in with a made-up (non-mercator) project() and a real on/off/fire
// event bus, since OwnPositionMarker reprojects on 'move' the same way.
function createFakeMap() {
  const container = document.createElement('div');
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  // The map is not necessarily north-up (MapLibre's rotate handlers are
  // left enabled on both maps), so this stand-in has a bearing that a test
  // can turn, the same way the real map's does.
  let bearing = 0;
  const map = {
    getContainer: () => container,
    getBearing: vi.fn(() => bearing),
    rotateTo(degrees: number) {
      bearing = degrees;
    },
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

describe('OwnPositionMarker', () => {
  it('renders nothing before the first fix arrives', () => {
    const { map, container } = createFakeMap();
    new OwnPositionMarker({ map: map as unknown as MaplibreMap });

    expect(container.querySelector('.own-position-marker')).toBeNull();
  });

  it('appears at the reported position once one is set', () => {
    const { map, container } = createFakeMap();
    const marker = new OwnPositionMarker({ map: map as unknown as MaplibreMap });

    marker.setPosition({ lat: 49.01, lon: 8.4 });

    const element = container.querySelector('.own-position-marker') as HTMLElement;
    expect(element).not.toBeNull();
    expect(element.style.left).toBe('840px');
    expect(element.style.top).toBe('4901px');
  });

  it('repositions on move, like a bar marker', () => {
    const { map, container } = createFakeMap();
    const marker = new OwnPositionMarker({ map: map as unknown as MaplibreMap });
    marker.setPosition({ lat: 49.01, lon: 8.4 });

    map.project.mockReturnValueOnce({ x: 12, y: 34 });
    map.fire('move');

    const element = container.querySelector('.own-position-marker') as HTMLElement;
    expect(element.style.left).toBe('12px');
    expect(element.style.top).toBe('34px');
  });

  it('is removed again if the position is cleared', () => {
    const { map, container } = createFakeMap();
    const marker = new OwnPositionMarker({ map: map as unknown as MaplibreMap });
    marker.setPosition({ lat: 49.01, lon: 8.4 });
    expect(container.querySelector('.own-position-marker')).not.toBeNull();

    marker.setPosition(null);

    expect(container.querySelector('.own-position-marker')).toBeNull();
  });

  it('is a distinct shape from the bar marker, not just a distinct colour', () => {
    const { map, container } = createFakeMap();
    const marker = new OwnPositionMarker({ map: map as unknown as MaplibreMap });
    marker.setPosition({ lat: 49.01, lon: 8.4 });

    const element = container.querySelector('.own-position-marker') as HTMLElement;
    // The bar marker (map/bars/bar-markers.ts) is a <path> pictogram; this
    // marker's own body is <circle> elements instead, so the two never rely
    // on colour alone to be told apart (Section 8.1).
    //
    // Scoped to paths OUTSIDE the heading cone rather than to "no path at
    // all": the cone is a <path>, so the blunter assertion would hold only
    // while the player is stationary and would fail the first time this
    // case was given a course - looking like a shape regression when it was
    // nothing of the kind.
    const bodyPaths = [...element.querySelectorAll('path')].filter(
      (path) => path.closest('.own-position-marker__heading') === null,
    );
    expect(bodyPaths).toHaveLength(0);
    expect(element.querySelectorAll('circle').length).toBeGreaterThan(0);
  });

  // Section 8.3: which way the player is travelling, taken from the GPS
  // course alone - the direction of movement, not the direction the phone
  // is pointed - so it is absent whenever the fix carries no course, which
  // is what standing still produces.
  describe('the direction cone', () => {
    function coneOf(container: HTMLElement) {
      return container.querySelector('.own-position-marker__heading');
    }

    it('is drawn when the fix reports a course', () => {
      const { map, container } = createFakeMap();
      const marker = new OwnPositionMarker({ map: map as unknown as MaplibreMap });

      marker.setPosition({ lat: 49.01, lon: 8.4, heading: 90 });

      expect(coneOf(container)?.getAttribute('transform')).toBe('rotate(90 12 12)');
    });

    it.each([
      ['null, as standing still reports it', null],
      ['absent altogether', undefined],
      ['NaN, as some platforms report it', Number.NaN],
    ])('is absent when the course is %s', (_case, heading: number | null | undefined) => {
      const { map, container } = createFakeMap();
      const marker = new OwnPositionMarker({ map: map as unknown as MaplibreMap });

      marker.setPosition({ lat: 49.01, lon: 8.4, heading });

      expect(container.querySelector('.own-position-marker')).not.toBeNull();
      expect(coneOf(container)).toBeNull();
    });

    it('goes away again when a later fix carries no course', () => {
      const { map, container } = createFakeMap();
      const marker = new OwnPositionMarker({ map: map as unknown as MaplibreMap });
      marker.setPosition({ lat: 49.01, lon: 8.4, heading: 90 });
      expect(coneOf(container)).not.toBeNull();

      marker.setPosition({ lat: 49.01, lon: 8.4, heading: null });

      expect(coneOf(container)).toBeNull();
    });

    it('is turned by the course minus the map bearing, not by the course alone', () => {
      const { map, container } = createFakeMap();
      const marker = new OwnPositionMarker({ map: map as unknown as MaplibreMap });
      map.rotateTo(30);

      marker.setPosition({ lat: 49.01, lon: 8.4, heading: 90 });

      expect(coneOf(container)?.getAttribute('transform')).toBe('rotate(60 12 12)');
    });

    it('follows the map as it is rotated, with no new fix arriving', () => {
      const { map, container } = createFakeMap();
      const marker = new OwnPositionMarker({ map: map as unknown as MaplibreMap });
      marker.setPosition({ lat: 49.01, lon: 8.4, heading: 90 });

      map.rotateTo(45);
      map.fire('move');

      expect(coneOf(container)?.getAttribute('transform')).toBe('rotate(45 12 12)');
    });

    it('rotates without touching the host element, which is centred by its own transform', () => {
      const { map, container } = createFakeMap();
      const marker = new OwnPositionMarker({ map: map as unknown as MaplibreMap });
      map.rotateTo(30);

      marker.setPosition({ lat: 49.01, lon: 8.4, heading: 90 });

      // translate(-50%, -50%) comes from the stylesheet and is what puts
      // the marker on its coordinate; a rotation folded in here would
      // silently un-centre it.
      const element = container.querySelector('.own-position-marker') as HTMLElement;
      expect(element.style.transform).toBe('');
      expect(element.getAttribute('style') ?? '').not.toContain('rotate');
    });
  });

  it('removes the move listener and the element on destroy', () => {
    const { map, container } = createFakeMap();
    const marker = new OwnPositionMarker({ map: map as unknown as MaplibreMap });
    marker.setPosition({ lat: 49.01, lon: 8.4 });
    expect(map.on).toHaveBeenCalledWith('move', expect.any(Function));

    marker.destroy();

    expect(map.off).toHaveBeenCalledWith('move', expect.any(Function));
    expect(container.querySelector('.own-position-marker')).toBeNull();
  });
});
