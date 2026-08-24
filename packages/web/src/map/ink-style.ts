import { CONFIG } from '@tipsytrails/shared';
import type { LayerSpecification, StyleSpecification } from 'maplibre-gl';

// Section 8.1: a hand-drawn ink map. Desaturated, slightly warm paper
// ground; fine black lines for the roads - the major ones everywhere, the
// minor streets only on revealed ground (Section 7.3, which widened 8.1's
// "major roads only" and is the later decision); water and green areas read
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

// Section 7.3: the minor streets are the one road layer that sits *below*
// the fog, so unlike the major roads they are only ever seen on revealed
// paper - never through fog. The legibility argument that pins the major
// roads at 0.6 (reading over the fog's own ground) therefore does not apply
// to them, and they get their own number rather than sharing that constant:
// Section 7.3 asks for them to be "quieter than the major roads", which a
// shared constant could not express. 0.5 is the quietest round value that
// still clears the 3:1 Section 8.1 holds non-text marks to - INK at 0.5
// over PAPER is 3.23:1, against 4.35:1 for the major roads' 0.6 - so the
// residential grid reads as a subordinate texture under the major roads
// rather than as a second set of equals. Provisional for the same reason
// PROVISIONAL_ROAD_OPACITY is: Section 7.3 fixes the requirement and
// expressly not the number.
const PROVISIONAL_MINOR_ROAD_OPACITY = 0.5;

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

// Section 7.3: the minor streets appear "only at closer zooms", so this ramp
// starts at 14 - the zoom at which a walker is looking at blocks rather than
// at the city - and the layer's own minzoom matches it, meaning there is no
// clamped first value here the way there is for the major roads below zoom
// 8. It stays thinner than ROAD_WIDTH_RAMP at every zoom the two share:
// residential streets outnumber the major roads by an order of magnitude,
// and at equal weight they would read as the map's main structure instead of
// as the texture under it.
const MINOR_ROAD_WIDTH_RAMP: NonNullable<LineLayer['paint']>['line-width'] = [
  'interpolate',
  ['linear'],
  ['zoom'],
  14,
  0.4,
  18,
  0.9,
];

// Section 7.3/8.1: the district boundaries drawn on the main map
// (map/districts/district-borders.ts). They live here, beside the road
// opacities, because they are paint and this file is where the map's ink is
// decided; the layer itself is added at runtime, since its geometry arrives
// over the network rather than with the style.
//
// The boundaries are drawn *above* the fog, which is the whole point of the
// owner's request - a border is only useful if it is visible in the ground
// he has not explored yet - and that puts them under the same rule Section
// 7.3 records for the roads: one treatment has to serve fogged and revealed
// ground alike, and it must not read as another street.
//
// Dashes are what make it a different *kind* of line. A street network is
// continuous and connected, so an unbroken line of any weight joins that
// network by resemblance however quiet it is made; a dashed line cannot,
// and it is the cartographic idiom for an administrative boundary besides.
// The dash lengths are in units of the line's own width, so the pattern
// scales with the ramp below and stays a dash rather than becoming a dotted
// line when the border thickens. `line-cap: butt` belongs with them
// (district-borders.ts sets it): a round cap grows each dash by half a width
// at both ends, which at these lengths closes the gaps up again.
const DISTRICT_BORDER_DASHARRAY = [3, 2];

// Quieter than PROVISIONAL_ROAD_OPACITY (0.6) - a boundary is context and
// the streets are what the player navigates by, so the border must not be
// the loudest thing above the fog - but held to the same floor the roads
// are: INK at 0.55 over the ground the fog actually produces (rgb(204, 199,
// 187), the darker and therefore binding case) reaches 3.30:1, past the 3:1
// Section 8.1 asks of non-text marks, and 3.74:1 on revealed paper. 0.5 was
// the first candidate and is rejected at 2.91:1 over fog, below that floor.
// Provisional in the same sense the road opacities are: Section 7.3 fixes
// the requirement and not the number.
const DISTRICT_BORDER_OPACITY = 0.55;

// Wider than ROAD_WIDTH_RAMP at every zoom the map can reach, which is the
// second half of "not another road": the border reads as a deliberate,
// heavier mark that happens to be broken, rather than as a faint street. The
// stops are style stops in the same idiom as the road ramps above - literals
// rather than the zoom limits from config.ts, exactly as those ramps use 8,
// 14 and 18 - and they start at the map's furthest-out view, because a
// district boundary is at its most useful when the whole city is on screen.
const DISTRICT_BORDER_WIDTH_RAMP: NonNullable<LineLayer['paint']>['line-width'] = [
  'interpolate',
  ['linear'],
  ['zoom'],
  10,
  1,
  14,
  1.4,
  18,
  2,
];

export const DISTRICT_BORDER_PAINT: NonNullable<LineLayer['paint']> = {
  'line-color': INK,
  'line-opacity': DISTRICT_BORDER_OPACITY,
  'line-width': DISTRICT_BORDER_WIDTH_RAMP,
  'line-dasharray': DISTRICT_BORDER_DASHARRAY,
};

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

// Section 7.3's "residential and tertiary streets", named the way the
// OpenMapTiles/Planetiler transportation layer names them: that schema folds
// residential, unclassified, living_street and road into the single class
// "minor", and keeps "tertiary" separate. Together those two are the street
// pattern a walker recognises in a German city centre.
//
// Everything else the layer carries is deliberately left undrawn. "service"
// is the judgement call and the answer is no: it is parking aisles, driveways
// and alleys behind buildings, which on a 50 m grid would double the ink for
// ways nobody navigates by, and on a map whose whole direction is restraint
// (Section 8.1) that is the difference between a street pattern and a mess.
// "track", "path", "raceway", "bus_guideway", "busway", "ferry" and
// "aerialway" are out for the same reason plus their own: none of them is a
// street, so none of them helps a walker read the grid they are standing in.
const MINOR_ROAD_CLASSES = ['minor', 'tertiary'];

// The seam Section 7.3 cuts through `layers`: the fog custom layer is
// inserted directly before this one (fog-controller.ts), so everything
// listed ahead of it - paper, green landcover, parks, buildings and the
// minor streets - is hidden on unrevealed ground, and everything from it
// onwards - water, waterways and both major-road layers - stays legible
// there. The name says "first above the fog" rather than naming a position,
// because five layers now sit above the fog and no single one of them is
// last; only the layer this id points at
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
    // Section 7.3: the minor streets are below the fog, and that is the
    // point rather than an implementation detail - above it they would hand
    // unexplored ground the full street grid, which is precisely the detail
    // the fog exists to withhold. Below it they are a reward for having been
    // somewhere. It is a separate layer rather than a wider filter on
    // road-primary because one filter cannot sit on both sides of the fog.
    // Last of the below-fog set, so that on revealed ground it draws over
    // the building fills the way the major roads draw over everything.
    {
      id: 'road-minor',
      type: 'line',
      source: SOURCE_ID,
      'source-layer': 'transportation',
      minzoom: 14,
      filter: ['in', ['get', 'class'], ['literal', MINOR_ROAD_CLASSES]],
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
      },
      paint: {
        'line-color': INK,
        'line-opacity': PROVISIONAL_MINOR_ROAD_OPACITY,
        'line-width': MINOR_ROAD_WIDTH_RAMP,
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
    // Section 7.3 calls "major roads" (motorway|trunk|primary|secondary).
    // With road-minor above they are no longer the only transportation
    // classes drawn, but they are the only ones drawn *here*, above the fog:
    // these two read the same on unexplored ground as on explored ground,
    // and that is what they are for. They are two layers rather than one
    // only so each can appear at its own zoom; they are identical in colour,
    // opacity and weight, and the pair of them is last so that the roads
    // cross everything else the map draws. That includes the building fills
    // they used to sit under - at fill-opacity 0.04 the difference is barely
    // perceptible, and a road not occluded by a building is the better
    // reading anyway.
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
