import { describe, expect, it } from 'vitest';
import { CONFIG } from '@tipsytrails/shared';
import { FIRST_ABOVE_FOG_LAYER_ID, inkStyle } from './ink-style.js';

// Section 7.3 fixes the layer order on either side of the fog, so the test
// states it as the whole order rather than as a handful of pairwise
// comparisons: a layer added in the wrong place has to fail here, and "X
// comes before Y" checks would let one through anywhere they do not look.
const BELOW_FOG_LAYER_IDS = [
  'background',
  'landcover-green',
  'park',
  'building',
  'building-outline',
];
const ABOVE_FOG_LAYER_IDS = [
  FIRST_ABOVE_FOG_LAYER_ID,
  'water-outline',
  'waterway',
  'road-primary',
  'road-highway',
];

function paintOf(id: string): Record<string, unknown> {
  const layer = inkStyle.layers.find((candidate) => candidate.id === id);
  expect(layer, `style has no "${id}" layer`).toBeDefined();
  return (layer as { paint?: Record<string, unknown> }).paint ?? {};
}

function minzoomOf(id: string): number | undefined {
  const layer = inkStyle.layers.find((candidate) => candidate.id === id);
  expect(layer, `style has no "${id}" layer`).toBeDefined();
  return (layer as { minzoom?: number }).minzoom;
}

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

  // The coupling the whole fog change rests on: FogController inserts the fog
  // before FIRST_ABOVE_FOG_LAYER_ID, so that layer must exist and the split it
  // makes must be exactly the one Section 7.3 describes - hidden ground below,
  // water and roads above - with nothing else in the array on either side.
  it('splits its layers at the fog anchor into exactly the below-fog and above-fog sets of Section 7.3', () => {
    const ids = inkStyle.layers.map((layer) => layer.id);
    const anchor = ids.indexOf(FIRST_ABOVE_FOG_LAYER_ID);

    expect(anchor).toBeGreaterThanOrEqual(0);
    expect(ids.slice(0, anchor)).toEqual(BELOW_FOG_LAYER_IDS);
    expect(ids.slice(anchor)).toEqual(ABOVE_FOG_LAYER_IDS);
  });

  // Section 7.3: "both road layers take the same colour, the same opacity, and
  // the same width ramp". Compared as whole paint objects, so the test cannot
  // pass by agreeing with a ramp copied into it.
  it('gives both road layers identical ink, opacity and width', () => {
    const highway = paintOf('road-highway');
    const primary = paintOf('road-primary');

    expect(highway['line-color']).toEqual(primary['line-color']);
    expect(highway['line-opacity']).toEqual(primary['line-opacity']);
    expect(highway['line-width']).toEqual(primary['line-width']);
  });

  // Section 7.3: the hierarchy between the two road layers moved out of the
  // stroke and into the zoom at which each one appears, so this difference is
  // now the only thing carrying it.
  it('keeps the two road layers apart by minzoom, which is where the hierarchy went', () => {
    expect(minzoomOf('road-highway')).toBe(4);
    expect(minzoomOf('road-primary')).toBe(8);
  });

  // Regression guard for Section 7.3's "deliberately reduced opacity": above
  // the fog these roads are drawn on unexplored ground too, where what either
  // layer used to carry reads as shouting. The bound is the quieter of the two
  // old values rather than the louder one, because "reduced" is a claim about
  // both layers - checking only against road-highway's 0.85 would let
  // road-primary's own 0.75 back in unnoticed, which reduces nothing. Section
  // 7.3 expressly declines to fix the number itself, so this is the only
  // assertion available: the exact value is a judgement made on a real device,
  // and if it is ever raised back above 0.75 the specification has to move
  // first and this test with it.
  it('draws roads more quietly than either road layer did before the move above the fog', () => {
    const QUIETER_OPACITY_BEFORE_THE_MOVE = 0.75;

    for (const id of ['road-highway', 'road-primary']) {
      const opacity = paintOf(id)['line-opacity'];
      expect(typeof opacity, `${id} line-opacity`).toBe('number');
      expect(opacity as number, `${id} line-opacity`).toBeLessThan(QUIETER_OPACITY_BEFORE_THE_MOVE);
    }
  });
});
