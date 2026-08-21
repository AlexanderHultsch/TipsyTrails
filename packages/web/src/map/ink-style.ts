import { CONFIG } from '@tipsytrails/shared';
import type { LayerSpecification, StyleSpecification } from 'maplibre-gl';

// Section 8.1: a hand-drawn ink map. Desaturated, slightly warm paper
// ground; fine black lines for major roads only; water and green areas read
// as texture rather than filled colour; no gradients or shadows. Everything
// that is not this ink is spoken for elsewhere: the single accent colour is
// reserved for the player's own position and for active states, and the small
// named set of status colours beside it belongs to the three status icons of
// Section 8.6 and to nothing else - so neither has any business in the base
// map, and neither appears here. PAPER and INK are the same hex values
// index.css defines as --color-paper / --color-ink - kept in sync by hand,
// since a MapLibre style is plain JSON and cannot read CSS custom properties.
const PAPER = '#f4efe6';
const INK = '#1c1a17';

// Section 7.3: both road layers are drawn above the fog, so the same ink
// falls on unrevealed and revealed ground alike and one opacity has to serve
// both states - quiet enough not to dominate the fog, present enough to
// orient by on paper. At 0.6, INK over the ground the fog actually produces
// (webgl-fog-layer.ts's FOG_COLOR at CONFIG.FOG_MAX_OPACITY over PAPER, which
// composites to rgb(204, 199, 187)) reaches 3.77:1 - past the 3:1 WCAG asks
// of non-text graphics, and the same floor Section 8.1 holds icons and large
// text to - without shouting over the fog the way 0.75 would at 5.65:1. On
// revealed paper the same value gives 4.35:1.
// Provisional by name because Section 7.3 fixes the requirement and expressly
// not the number: this is the starting value, and the knob the owner nudges
// after walking the city with the real map on a real screen.
const PROVISIONAL_ROAD_OPACITY = 0.6;

// Section 7.3: major roads carry no extra weight any more. Both road layers
// take this one ramp, held once rather than written twice so they cannot
// drift apart. What remains of the hierarchy is the minzoom of each layer -
// motorways from zoom 4, ordinary major roads only from zoom 8 - so the
// distinction appears at the zoom where it is useful instead of as a
// permanent difference in ink. Below zoom 8 a stop list starting there simply
// clamps to its first value, which is exactly what the trunk network wants
// when it is alone on the map.
type LineLayer = Extract<LayerSpecification, { type: 'line' }>;
const ROAD_WIDTH_RAMP: NonNullable<LineLayer['paint']>['line-width'] = [
  'interpolate',
  ['linear'],
  ['zoom'],
  8,
  0.4,
  14,
  1,
  18,
  1.5,
];

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

// The seam Section 7.3 cuts through `layers`: the fog custom layer is
// inserted directly before this one (fog-controller.ts), so everything
// listed ahead of it - paper, green landcover, parks, buildings - is hidden
// on unrevealed ground, and everything from it onwards - water, waterways
// and both road layers - stays legible there. The name says "first above the
// fog" rather than naming a position, because five layers now sit above the
// fog and no single one of them is last; only the layer this id points at
// defines the seam, so reordering the water and roads among themselves
// cannot quietly move it. Exported rather than repeated as a string literal
// in fog-controller.ts, so renaming the layer cannot silently break it.
export const FIRST_ABOVE_FOG_LAYER_ID = 'water-fill';

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
    // Buildings, green areas and parks are the layers that describe what a
    // place is actually like, so they are the ones the fog is for: they sit
    // below it and appear only where the player has been (Section 7.3).
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
    // ---- The fog is inserted here, before FIRST_ABOVE_FOG_LAYER_ID. ----
    // Everything from this point on is drawn over the fog and reads the same
    // on unrevealed ground as on revealed ground: Section 7.3's judgement is
    // that water and the street grid orient a player in unexplored parts of
    // the city better than the trunk network alone ever did, and that the fog
    // still has plenty left to hide. Water goes first because it is the
    // widest, flattest thing above the fog and the roads should cross it.
    {
      id: FIRST_ABOVE_FOG_LAYER_ID,
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
    // Section 7.3 calls "major roads" (motorway|trunk|primary|secondary), and
    // no other transportation class is drawn (Section 8.1: "only major
    // roads"). They are two layers rather than one only so each can appear at
    // its own zoom; they are identical in colour, opacity and weight, and the
    // pair of them is last so that the roads cross everything else the map
    // draws. That includes the building fills they used to sit under - at
    // fill-opacity 0.04 the difference is barely perceptible, and a road not
    // occluded by a building is the better reading anyway.
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
        'line-opacity': PROVISIONAL_ROAD_OPACITY,
        'line-width': ROAD_WIDTH_RAMP,
      },
    },
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
        'line-opacity': PROVISIONAL_ROAD_OPACITY,
        'line-width': ROAD_WIDTH_RAMP,
      },
    },
  ],
};
