import { describe, expect, it, vi } from 'vitest';
import type { Map as MaplibreMap } from 'maplibre-gl';
import { OwnPositionMarker } from './own-position-marker.js';

// Same fake-map shape as map/bars/bar-markers.test.ts: a hand-built
// stand-in with a made-up (non-mercator) project() and a real on/off/fire
// event bus, since OwnPositionMarker reprojects on 'move' the same way.
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

describe('OwnPositionMarker', () => {
  it('renders nothing before the first fix arrives', () => {
    const { map, container } = createFakeMap();
    new OwnPositionMarker({ map: map as unknown as MaplibreMap });

    expect(container.querySelector('.own-position-marker')).toBeNull();
  });

  it('appears at the reported position once one is set', () => {
    const { map, container } = createFakeMap();
    const marker = new OwnPositionMarker({ map: map as unknown as MaplibreMap });

    marker.setPosition({ lat: 49.01, lon: 8.4, accuracy: 15 });

    const element = container.querySelector('.own-position-marker') as HTMLElement;
    expect(element).not.toBeNull();
    expect(element.style.left).toBe('840px');
    expect(element.style.top).toBe('4901px');
  });

  it('repositions on move, like a bar marker', () => {
    const { map, container } = createFakeMap();
    const marker = new OwnPositionMarker({ map: map as unknown as MaplibreMap });
    marker.setPosition({ lat: 49.01, lon: 8.4, accuracy: 15 });

    map.project.mockReturnValueOnce({ x: 12, y: 34 });
    map.fire('move');

    const element = container.querySelector('.own-position-marker') as HTMLElement;
    expect(element.style.left).toBe('12px');
    expect(element.style.top).toBe('34px');
  });

  it('is removed again if the position is cleared', () => {
    const { map, container } = createFakeMap();
    const marker = new OwnPositionMarker({ map: map as unknown as MaplibreMap });
    marker.setPosition({ lat: 49.01, lon: 8.4, accuracy: 15 });
    expect(container.querySelector('.own-position-marker')).not.toBeNull();

    marker.setPosition(null);

    expect(container.querySelector('.own-position-marker')).toBeNull();
  });

  it('is a distinct shape from the bar marker, not just a distinct colour', () => {
    const { map, container } = createFakeMap();
    const marker = new OwnPositionMarker({ map: map as unknown as MaplibreMap });
    marker.setPosition({ lat: 49.01, lon: 8.4, accuracy: 15 });

    const element = container.querySelector('.own-position-marker') as HTMLElement;
    // The bar marker (map/bars/bar-markers.ts) is a <path> pictogram; this
    // marker is built from <circle> elements instead, so the two never
    // rely on colour alone to be told apart (Section 8.1).
    expect(element.querySelector('path')).toBeNull();
    expect(element.querySelectorAll('circle').length).toBeGreaterThan(0);
  });

  it('removes the move listener and the element on destroy', () => {
    const { map, container } = createFakeMap();
    const marker = new OwnPositionMarker({ map: map as unknown as MaplibreMap });
    marker.setPosition({ lat: 49.01, lon: 8.4, accuracy: 15 });
    expect(map.on).toHaveBeenCalledWith('move', expect.any(Function));

    marker.destroy();

    expect(map.off).toHaveBeenCalledWith('move', expect.any(Function));
    expect(container.querySelector('.own-position-marker')).toBeNull();
  });
});
