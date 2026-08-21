import { describe, expect, it } from 'vitest';
import { CONFIG } from '@tipsytrails/shared';
import { ROAD_HIGHWAY_LAYER_ID, inkStyle } from './ink-style.js';

describe('inkStyle', () => {
  it('is a version 8 MapLibre style', () => {
    expect(inkStyle.version).toBe(8);
  });

  it('points its vector source at the configured tile filename', () => {
    const sources = Object.values(inkStyle.sources);
    expect(sources).toHaveLength(1);
    const [source] = sources;
    expect(source.type).toBe('vector');
    expect('url' in source && source.url).toContain(CONFIG.TILES_FILENAME);
  });

  it('has a non-empty layers array', () => {
    expect(inkStyle.layers.length).toBeGreaterThan(0);
  });

  // The coupling the whole fog-contrast change rests on: FogController
  // inserts the fog before ROAD_HIGHWAY_LAYER_ID, so that layer must exist
  // and must be last, or the fog stops being below exactly one layer.
  it('keeps the major-road layer last so the fog can be inserted directly beneath it', () => {
    const ids = inkStyle.layers.map((layer) => layer.id);
    expect(ids).toContain(ROAD_HIGHWAY_LAYER_ID);
    expect(ids[ids.length - 1]).toBe(ROAD_HIGHWAY_LAYER_ID);
  });

  it('leaves the minor-road layer below the fog, so minor roads disappear on unrevealed ground', () => {
    const ids = inkStyle.layers.map((layer) => layer.id);
    expect(ids.indexOf('road-primary')).toBeLessThan(ids.indexOf(ROAD_HIGHWAY_LAYER_ID));
  });
});
