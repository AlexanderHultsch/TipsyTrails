import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONFIG } from './config.js';
import { citySeedDir, parseCityConfig } from './city.js';

const KARLSRUHE_CONFIG_PATH = fileURLToPath(
  new URL('../../../data/cities/karlsruhe.json', import.meta.url),
);

function loadKarlsruheJson(): unknown {
  return JSON.parse(readFileSync(KARLSRUHE_CONFIG_PATH, 'utf-8'));
}

describe('parseCityConfig', () => {
  it('parses and validates the real data/cities/karlsruhe.json', () => {
    const config = parseCityConfig(loadKarlsruheJson());
    expect(config.slug).toBe('karlsruhe');
    expect(config.name).toBe('Karlsruhe');
  });

  it('keeps tiles_filename in sync with CONFIG.TILES_FILENAME', () => {
    const config = parseCityConfig(loadKarlsruheJson());
    expect(config.tiles_filename).toBe(CONFIG.TILES_FILENAME);
  });

  it('matches the Section 6.2 cell_size_m', () => {
    const config = parseCityConfig(loadKarlsruheJson());
    expect(config.cell_size_m).toBe(50);
  });

  it('matches the Section 6.2 bounding box', () => {
    const config = parseCityConfig(loadKarlsruheJson());
    expect(config.bounding_box).toEqual({
      south: 48.94,
      west: 8.275,
      north: 49.095,
      east: 8.56,
    });
  });

  it('rejects a config with a missing slug, naming the field', () => {
    const data = loadKarlsruheJson() as Record<string, unknown>;
    delete data.slug;
    expect(() => parseCityConfig(data)).toThrow(/"slug"/);
  });

  it('rejects a bounding box whose north is below its south, naming the field', () => {
    const data = loadKarlsruheJson() as Record<string, unknown>;
    data.bounding_box = { ...(data.bounding_box as object), north: 48.0, south: 49.0 };
    expect(() => parseCityConfig(data)).toThrow(/"bounding_box\.north"/);
  });

  it('rejects a non-positive cell_size_m, naming the field', () => {
    const data = loadKarlsruheJson() as Record<string, unknown>;
    data.cell_size_m = 0;
    expect(() => parseCityConfig(data)).toThrow(/"cell_size_m"/);
  });

  it('rejects an empty district admin-level list, naming the field', () => {
    const data = loadKarlsruheJson() as Record<string, unknown>;
    data.osm_admin_filter = { ...(data.osm_admin_filter as object), district_admin_levels: [] };
    expect(() => parseCityConfig(data)).toThrow(/"osm_admin_filter\.district_admin_levels"/);
  });
});

describe('citySeedDir', () => {
  it('resolves karlsruhe to data/seed/karlsruhe', () => {
    expect(citySeedDir('karlsruhe')).toBe('data/seed/karlsruhe');
  });
});
