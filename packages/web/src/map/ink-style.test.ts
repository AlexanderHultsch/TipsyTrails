import { describe, expect, it } from 'vitest';
import { CONFIG } from '@tipsytrails/shared';
import { inkStyle } from './ink-style.js';

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
});
