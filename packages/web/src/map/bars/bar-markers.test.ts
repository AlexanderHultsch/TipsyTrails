import { describe, expect, it, vi } from 'vitest';
import type { Map as MaplibreMap } from 'maplibre-gl';
import type { Bar } from '../../api/types.js';
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
    ...overrides,
  };
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
    expect(container.querySelector('button.bar-marker[aria-label="A"]')).not.toBeNull();
    expect(container.querySelector('button.bar-marker[aria-label="B"]')).not.toBeNull();
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
    const firstElement = container.querySelector('button.bar-marker[aria-label="A"]');

    markers.setBars([makeBar({ id: 1, name: 'A' }), makeBar({ id: 3, name: 'C' })]);

    expect(container.querySelectorAll('button.bar-marker')).toHaveLength(2);
    expect(container.querySelector('button.bar-marker[aria-label="B"]')).toBeNull();
    expect(container.querySelector('button.bar-marker[aria-label="C"]')).not.toBeNull();
    expect(container.querySelector('button.bar-marker[aria-label="A"]')).toBe(firstElement);
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
