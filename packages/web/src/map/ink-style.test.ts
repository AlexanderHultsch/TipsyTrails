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
  // Section 7.3: the minor streets belong below the fog - above it they
  // would hand unexplored ground the full street grid - and last of this
  // set, so they draw over the building fills on revealed ground.
  'road-minor',
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

// The class list out of a ["in", ["get", "class"], ["literal", [...]]] filter,
// read rather than restated, so the assertions below are about what the style
// actually draws.
function filterClassesOf(id: string): string[] {
  const layer = inkStyle.layers.find((candidate) => candidate.id === id);
  expect(layer, `style has no "${id}" layer`).toBeDefined();
  const filter = (layer as { filter?: unknown }).filter as unknown[];
  expect(Array.isArray(filter), `${id} has no array filter`).toBe(true);
  const literal = filter[2] as unknown[];
  expect(Array.isArray(literal) && literal[0], `${id} filter is not an "in" over a literal`).toBe(
    'literal',
  );
  return literal[1] as string[];
}

// A ["interpolate", ["linear"], ["zoom"], z0, w0, z1, w1, ...] stop list as
// [zoom, width] pairs. The two road ramps are compared by the widths they
// actually produce rather than by their shape, so "thinner" cannot be
// satisfied by a ramp that merely differs.
function rampStopsOf(id: string): [number, number][] {
  const ramp = paintOf(id)['line-width'] as unknown[];
  expect(Array.isArray(ramp) && ramp[0], `${id} line-width is not an interpolate`).toBe(
    'interpolate',
  );
  const stops: [number, number][] = [];
  for (let index = 3; index < ramp.length; index += 2) {
    stops.push([ramp[index] as number, ramp[index + 1] as number]);
  }
  return stops;
}

// MapLibre's own clamping behaviour: outside the stop range an interpolate
// holds its first or last value.
function widthAtZoom(stops: [number, number][], zoom: number): number {
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (zoom <= first[0]) {
    return first[1];
  }
  if (zoom >= last[0]) {
    return last[1];
  }
  for (let index = 1; index < stops.length; index += 1) {
    const [zoomBefore, widthBefore] = stops[index - 1];
    const [zoomAfter, widthAfter] = stops[index];
    if (zoom <= zoomAfter) {
      const t = (zoom - zoomBefore) / (zoomAfter - zoomBefore);
      return widthBefore + t * (widthAfter - widthBefore);
    }
  }
  return last[1];
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

  // Section 7.3: "residential and tertiary streets are drawn as their own
  // layer". In the OpenMapTiles/Planetiler schema residential, unclassified
  // and living_street all arrive as class "minor". The negative half is the
  // point of the assertion: Section 8.1's restraint is a rule about what is
  // *not* drawn, and service ways (driveways, parking aisles) plus the
  // non-street classes are the ones that quietly undo it.
  it('draws the residential and tertiary street classes, and no other transportation class', () => {
    expect(filterClassesOf('road-minor').slice().sort()).toEqual(['minor', 'tertiary']);

    const drawn = new Set([
      ...filterClassesOf('road-minor'),
      ...filterClassesOf('road-primary'),
      ...filterClassesOf('road-highway'),
    ]);
    for (const undrawn of [
      'service',
      'track',
      'path',
      'raceway',
      'bus_guideway',
      'busway',
      'ferry',
      'aerialway',
    ]) {
      expect(drawn.has(undrawn), `${undrawn} must not be drawn`).toBe(false);
    }
  });

  // Section 7.3: the minor streets are "quieter than the major roads and
  // appearing only at closer zooms". Both halves are compared against what
  // the major roads actually carry, not against copied numbers, so raising
  // road-minor to the major roads' weight fails here however that is done.
  // They are not held to the above-fog opacity floor and must not share the
  // major roads' constant: this layer is below the fog, so it is only ever
  // seen on revealed paper and never has to read through fog.
  it('keeps the minor streets quieter, thinner and closer-in than the major roads', () => {
    const minorOpacity = paintOf('road-minor')['line-opacity'] as number;
    const majorOpacity = paintOf('road-primary')['line-opacity'] as number;
    expect(typeof minorOpacity).toBe('number');
    expect(minorOpacity).toBeLessThan(majorOpacity);

    const minorMinzoom = minzoomOf('road-minor') as number;
    expect(minorMinzoom).toBeGreaterThan(minzoomOf('road-primary') as number);

    const minorStops = rampStopsOf('road-minor');
    const majorStops = rampStopsOf('road-primary');
    // A later ramp start, and thinner at every zoom the two are both drawn
    // at - up to CONFIG.MAP_MAX_ZOOM, past which neither is ever rendered.
    expect(minorStops[0][0]).toBeGreaterThan(majorStops[0][0]);
    for (let zoom = minorMinzoom; zoom <= CONFIG.MAP_MAX_ZOOM; zoom += 0.5) {
      expect(widthAtZoom(minorStops, zoom), `line-width at zoom ${zoom}`).toBeLessThan(
        widthAtZoom(majorStops, zoom),
      );
    }
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
