import { CONFIG } from '@tipsytrails/shared';
import type { StyleSpecification } from 'maplibre-gl';

// Section 8.1: a hand-drawn ink map. Desaturated, slightly warm paper
// ground; fine black lines for major roads only; water and green areas read
// as texture rather than filled colour; no gradients or shadows; exactly
// one accent colour in the whole application, reserved for the player's
// position and active states, so it never appears here. These are the same
// hex values index.css defines as --color-paper / --color-ink - kept in
// sync by hand, since a MapLibre style is plain JSON and cannot read CSS
// custom properties.
const PAPER = '#f4efe6';
const INK = '#1c1a17';

// The extract's vector layers follow the standard OpenMapTiles/Planetiler
// schema (Section 3), which is what data/tiles/<CONFIG.TILES_FILENAME> will
// contain once the extract exists.
const SOURCE_ID = 'openmaptiles';

// Section 4.3 / 9.2: served by the API itself at /tiles/<filename>, not
// under /api - see packages/api/src/routes/tiles.ts. The scheme prefix is
// how the pmtiles MapLibre protocol (registered in the Map screen)
// recognises a PMTiles source; everything after "pmtiles://" is passed
// straight to fetch, so a path relative to the app's own origin works.
const TILES_URL = `/tiles/${CONFIG.TILES_FILENAME}`;

// Green space in the OpenMapTiles schema is split across landcover (wood,
// grass, ...) and a dedicated park layer; both read as the same restrained
// texture stand-in here rather than as filled colour.
const GREEN_LANDCOVER_CLASSES = ['wood', 'grass'];

// A true stipple/hatch texture needs a pattern image (a sprite, or a
// canvas-generated one registered with map.addImage at runtime) - see the
// report for why that is not attempted here. Water and green areas instead
// use a very low, near-paper fill opacity well short of a filled colour,
// plus a fine outline, as the closest approximation achievable in a plain
// style object with no rendered preview to check it against.
//
// No symbol/label layers: rendering text requires a `glyphs` URL template
// serving SDF glyph PBFs, and no such asset pipeline exists anywhere in
// this repository (data/ tree in Section 4.2, script chain in 11.4). Adding
// one is a new asset pipeline this task was not asked to build.
export const inkStyle: StyleSpecification = {
  version: 8,
  name: 'tipsy-trails-ink',
  sources: {
    [SOURCE_ID]: {
      type: 'vector',
      url: `pmtiles://${TILES_URL}`,
    },
  },
  layers: [
    {
      id: 'background',
      type: 'background',
      paint: {
        'background-color': PAPER,
      },
    },
    {
      id: 'landcover-green',
      type: 'fill',
      source: SOURCE_ID,
      'source-layer': 'landcover',
      minzoom: 6,
      filter: ['in', ['get', 'class'], ['literal', GREEN_LANDCOVER_CLASSES]],
      paint: {
        'fill-color': INK,
        'fill-opacity': 0.05,
      },
    },
    {
      id: 'park',
      type: 'fill',
      source: SOURCE_ID,
      'source-layer': 'park',
      minzoom: 10,
      paint: {
        'fill-color': INK,
        'fill-opacity': 0.05,
      },
    },
    {
      id: 'water-fill',
      type: 'fill',
      source: SOURCE_ID,
      'source-layer': 'water',
      paint: {
        'fill-color': INK,
        'fill-opacity': 0.06,
      },
    },
    {
      id: 'water-outline',
      type: 'line',
      source: SOURCE_ID,
      'source-layer': 'water',
      paint: {
        'line-color': INK,
        'line-width': 0.75,
        'line-opacity': 0.6,
      },
    },
    {
      id: 'waterway',
      type: 'line',
      source: SOURCE_ID,
      'source-layer': 'waterway',
      minzoom: 8,
      paint: {
        'line-color': INK,
        'line-width': 0.5,
        'line-opacity': 0.5,
      },
    },
    // road-highway and road-primary together cover exactly the class set
    // Section 7.3 calls "major roads" (motorway|trunk|primary|secondary),
    // split in two only so weight can taper in earlier for the busier
    // classes; no other transportation class is drawn (Section 8.1: "only
    // major roads").
    {
      id: 'road-highway',
      type: 'line',
      source: SOURCE_ID,
      'source-layer': 'transportation',
      minzoom: 4,
      filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk']]],
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
      },
      paint: {
        'line-color': INK,
        'line-opacity': 0.85,
        'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.4, 12, 1.25, 18, 2],
      },
    },
    {
      id: 'road-primary',
      type: 'line',
      source: SOURCE_ID,
      'source-layer': 'transportation',
      minzoom: 8,
      filter: ['in', ['get', 'class'], ['literal', ['primary', 'secondary']]],
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
      },
      paint: {
        'line-color': INK,
        'line-opacity': 0.75,
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.4, 14, 1, 18, 1.5],
      },
    },
    {
      id: 'building',
      type: 'fill',
      source: SOURCE_ID,
      'source-layer': 'building',
      minzoom: 15,
      paint: {
        'fill-color': INK,
        'fill-opacity': 0.04,
      },
    },
    {
      id: 'building-outline',
      type: 'line',
      source: SOURCE_ID,
      'source-layer': 'building',
      minzoom: 16,
      paint: {
        'line-color': INK,
        'line-opacity': 0.3,
        'line-width': 0.5,
      },
    },
  ],
};
