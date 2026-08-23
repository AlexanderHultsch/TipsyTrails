// OSM bar import: Overpass query construction and OSM/GeoJSON → bar record
// conversion (SPEC.md Section 11.1, `scripts/import-osm-bars.ts`).
//
// This module is pure and side-effect free — no network, no file system —
// so the query builder, the conversion and the diff logic can be
// unit-tested without touching Overpass, and `scripts/import-osm-bars.ts`
// stays a thin CLI wrapper (arg parsing, the actual HTTP call, atomic
// writes, the diff report) around it, the same split `overpass.ts` and
// `fetch-boundaries.ts` already establish.
//
// This is a separate module from `overpass.ts` rather than an extension of
// it: bars are points (nodes, or ways/relations reduced to a centroid via
// `out center`), not the administrative-boundary polygons `overpass.ts`
// assembles, so the response shapes and the GeoJSON conversion rules
// genuinely differ (every bar GeoJSON feature is a Point; `overpass.ts`'s
// GeoJSON conversion deliberately drops Point features, since those are
// admin_centre/label nodes for its Polygon/MultiPolygon boundaries).
//
// This module used to carry no relative *value* imports at all — only
// type-only ones, which TypeScript erases completely — because
// `scripts/import-osm-bars.ts` imported it by its literal `.ts` path and ran
// it as source with Node's native type stripping, and that only resolves a
// relative NodeNext ".js" specifier (CLAUDE.md's required convention for
// `packages/shared`) back to its co-located ".ts" file when the import is
// type-only and erased before Node ever attempts to load it. A genuine
// *value* import written the same way has no ".js" file to resolve to on
// that unbuilt path, so the Section 6.1 projection was copied in here rather
// than imported from `grid.ts`.
//
// That constraint is gone, and it had to go: Section 11.1's import-side
// duplicate rule is Section 11.3's community duplicate rule (`suggest.ts`),
// and reusing one implementation of it means importing `suggest.ts` — which
// itself reads `CONFIG` (`config.ts`) and `haversineDistanceM` (`grid.ts`).
// A second similarity function, or a second copy of
// `SUGGEST_DUPLICATE_RADIUS_M`, is exactly what CLAUDE.md's config rule and
// Section 11.3 forbid, so the loader had to move instead of the rule:
// `scripts/import-osm-bars.ts` now imports the built
// `packages/shared/dist/*.js` rather than this source tree, and needs
// `pnpm --filter @tipsytrails/shared build` (or plain `pnpm install`, whose
// `prepare` script runs it) to have run first. See that script's own header.
//
// With ordinary imports available, the projection copy is gone too — `toCell`
// and `computeGridDimensions` come from `grid.ts`, so they cannot drift from
// Section 6.1's normative definition at all any more.
//
// (`scripts/build-grid.ts` still imports `packages/shared/src/grid.ts` as
// source and is therefore *already* broken by this same resolution rule, with
// or without this change — see the report. It is outside this task's scope.)

import type { CityConfig } from './city.js';
import { CONFIG } from './config.js';
import { computeGridDimensions, haversineDistanceM, toCell, type GridParams } from './grid.js';
import { findConflictingBar, type DuplicateCandidateBar } from './suggest.js';

/** Mirrors `overpass.ts`'s constant of the same name and value — see the note above. */
export const DEFAULT_OVERPASS_TIMEOUT_S = 180;

// ---------------------------------------------------------------------------
// Query construction — pure function of the city config, mirroring
// `buildCityAndDistrictsQuery` in `overpass.ts`: match the city relation,
// turn it into an area, then find drinking establishments inside it.
//
// The amenity list lives here, in the script's own module, rather than in
// the per-city config: SPEC.md Section 11.1 states it normatively for the
// product ("amenity in bar, pub, biergarten, nightclub"), the same way for
// every city, unlike `osm_admin_filter` or `bounding_box`, which are
// genuinely per-city facts. Section 11.4's config field table lists what
// each script reads from the config; the amenity list is not among them.
// The `bar=yes` criterion added to `buildBarsQuery` below is the same kind
// of normative, city-independent fact and lives the same way — inline in
// the query builder, not in `config.ts` or the per-city config.
// ---------------------------------------------------------------------------

export const BAR_AMENITY_VALUES = ['bar', 'pub', 'biergarten', 'nightclub'] as const;

function escapeOverpassString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function adminLevelRegex(levels: number[]): string {
  return `^(${levels.join('|')})$`;
}

function regionalKeyClause(prefix: string | undefined): string {
  return prefix ? `["de:regionalschluessel"~"^${escapeOverpassString(prefix)}"]` : '';
}

/**
 * Nodes, ways and relations tagged `amenity` in `BAR_AMENITY_VALUES`, OR
 * carrying `bar=yes` regardless of their `amenity` value, inside the city
 * boundary (SPEC.md Section 11.1). The `bar=yes` clause exists because OSM's
 * "one main tag" convention files a venue's primary business under
 * `amenity` — a restaurant that also runs a bar stays `amenity=restaurant`
 * — and puts the bar-ness as the secondary tag `bar=yes`; the amenity-only
 * clause above never sees those. Both clauses live in the same
 * `area.cityArea`-scoped union, so an element matching both (e.g. a
 * redundant `bar=yes` on an `amenity=bar` node) is not double-counted —
 * Overpass QL's union statement is true set semantics: it writes into its
 * result set "all objects that it has seen in one of the partial results",
 * not a concatenation of them, so the same (type, id) surviving more than
 * one branch of the union still appears once in `out`'s output. See the
 * module note above and the `buildBarsQuery` tests for the corresponding
 * regression guard.
 *
 * `out center` so ways and relations come back with a centroid — simpler
 * and more accurate than assembling rings to average one by hand, and
 * Section 11.1 only requires they end up reduced to a centroid, not how.
 */
export function buildBarsQuery(
  config: CityConfig,
  timeoutS: number = DEFAULT_OVERPASS_TIMEOUT_S,
): string {
  const filter = config.osm_admin_filter;
  const cityLevels = adminLevelRegex(filter.city_admin_levels);
  const name = escapeOverpassString(filter.name);
  const regionalKey = regionalKeyClause(filter.regional_key_prefix);
  const amenity = `^(${BAR_AMENITY_VALUES.join('|')})$`;

  return [
    `[out:json][timeout:${timeoutS}];`,
    `rel["boundary"="administrative"]["admin_level"~"${cityLevels}"]["name"="${name}"]${regionalKey}->.city;`,
    `.city map_to_area->.cityArea;`,
    `(`,
    `  node["amenity"~"${amenity}"](area.cityArea);`,
    `  way["amenity"~"${amenity}"](area.cityArea);`,
    `  relation["amenity"~"${amenity}"](area.cityArea);`,
    `  node["bar"="yes"](area.cityArea);`,
    `  way["bar"="yes"](area.cityArea);`,
    `  relation["bar"="yes"](area.cityArea);`,
    `);`,
    `out center;`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Minimal Overpass `out center` response types — only what this module
// reads. Distinct from `overpass.ts`'s `OverpassElement`, which only ever
// carries a bare `{ type, id }` for nodes and ways because that pipeline
// only needs way/relation geometry, never node coordinates or tags.
// ---------------------------------------------------------------------------

export interface OverpassBarNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

export interface OverpassBarWayOrRelation {
  type: 'way' | 'relation';
  id: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export type OverpassBarElement = OverpassBarNode | OverpassBarWayOrRelation;

export interface OverpassBarsResponse {
  elements: OverpassBarElement[];
}

export class OverpassBarsResponseError extends Error {}

// ---------------------------------------------------------------------------
// GeoJSON input — the shape overpass-turbo's "export as GeoJSON" produces
// for an `out center` query: every feature (node, or way/relation reduced
// to its centroid) is a Point. Detected by payload shape and converted to
// an `OverpassBarsResponse` right here, at parse time, so the rest of this
// module (name-discard, centroid handling, `cell_index`) runs identically
// for either input format.
// ---------------------------------------------------------------------------

interface RawGeoJsonPointFeature {
  type: 'Feature';
  id?: string | number;
  properties?: Record<string, unknown> | null;
  geometry?: { type: string; coordinates: unknown } | null;
}

interface RawGeoJsonFeatureCollection {
  type: 'FeatureCollection';
  features: RawGeoJsonPointFeature[];
}

function isGeoJsonFeatureCollection(value: unknown): value is RawGeoJsonFeatureCollection {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'FeatureCollection' &&
    Array.isArray((value as { features?: unknown }).features)
  );
}

/** Extracts the OSM type and id from a GeoJSON feature's `id` (e.g. "way/62518"). */
function osmTypeAndIdFromGeoJsonFeature(feature: RawGeoJsonPointFeature): {
  type: 'node' | 'way' | 'relation';
  id: number;
} {
  const id = feature.id;
  const asString = typeof id === 'number' ? String(id) : id;
  const match =
    typeof asString === 'string' ? asString.match(/^(node|way|relation)\/(\d+)$/) : null;
  if (!match) {
    const name = feature.properties?.name;
    throw new OverpassBarsResponseError(
      `GeoJSON feature${typeof name === 'string' ? ` "${name}"` : ''} has no usable "id" field ` +
        `(expected "node/<id>", "way/<id>" or "relation/<id>") to derive an OSM element from.`,
    );
  }
  return { type: match[1] as 'node' | 'way' | 'relation', id: Number(match[2]) };
}

function tagsFromGeoJsonProperties(
  properties: Record<string, unknown> | null | undefined,
): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(properties ?? {})) {
    if (typeof value === 'string') tags[key] = value;
  }
  return tags;
}

function geoJsonToBarsResponse(collection: RawGeoJsonFeatureCollection): OverpassBarsResponse {
  const elements: OverpassBarElement[] = [];
  for (const feature of collection.features) {
    const geometry = feature.geometry;
    if (!geometry || geometry.type !== 'Point') continue;

    const [lon, lat] = geometry.coordinates as [number, number];
    const { type, id } = osmTypeAndIdFromGeoJsonFeature(feature);
    const tags = tagsFromGeoJsonProperties(feature.properties);

    if (type === 'node') {
      elements.push({ type, id, lat, lon, tags });
    } else {
      elements.push({ type, id, center: { lat, lon }, tags });
    }
  }
  return { elements };
}

// ---------------------------------------------------------------------------
// Response validation — "fail loudly" (SPEC.md 11.4), mirroring
// `parseOverpassPayload` in `overpass.ts`.
// ---------------------------------------------------------------------------

export function parseBarsPayload(
  raw: string,
  contentType: string | undefined,
): OverpassBarsResponse {
  const looksLikeHtml =
    /^\s*(<!doctype html|<html)/i.test(raw) || Boolean(contentType?.includes('text/html'));
  if (looksLikeHtml) {
    throw new OverpassBarsResponseError(
      `Expected a JSON response from Overpass but received HTML ` +
        `(content-type: ${contentType ?? 'unknown'}). This usually means Overpass is overloaded ` +
        `or rate-limiting; first 200 characters of the body: ${raw.slice(0, 200)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new OverpassBarsResponseError(
      `Expected a JSON response from Overpass but the body did not parse as JSON: ` +
        `${err instanceof Error ? err.message : String(err)}. First 200 characters: ${raw.slice(0, 200)}`,
    );
  }

  if (isGeoJsonFeatureCollection(parsed)) {
    if (parsed.features.length === 0) {
      throw new OverpassBarsResponseError(
        `Expected a GeoJSON FeatureCollection with at least one feature, got zero. This usually ` +
          `means the overpass-turbo export was run against the wrong query.`,
      );
    }
    return geoJsonToBarsResponse(parsed);
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as { elements?: unknown }).elements)
  ) {
    throw new OverpassBarsResponseError(
      `Expected an Overpass response with an "elements" array, or a GeoJSON FeatureCollection, ` +
        `got: ${raw.slice(0, 200)}`,
    );
  }

  const response = parsed as OverpassBarsResponse;
  if (response.elements.length === 0) {
    throw new OverpassBarsResponseError(
      `Overpass returned zero elements. Expected at least one drinking establishment; this usually ` +
        `means the osm_admin_filter in the city config does not match anything, or there really are ` +
        `none in the query area.`,
    );
  }

  return response;
}

// ---------------------------------------------------------------------------
// OSM element → bar record conversion (SPEC.md Section 11.1, 5.6).
// ---------------------------------------------------------------------------

/** What Section 5.6's `bars` table needs at import time. `source` is always 'osm' here. */
export interface Bar {
  osm_id: string;
  name: string;
  address: string | null;
  lat: number;
  lon: number;
  cell_index: number;
  source: 'osm';
}

export interface OsmToBarsResult {
  bars: Bar[];
  discardedNoName: number;
  wayOrRelationCount: number;
  /** The duplicate pairs Section 11.1's collapse rule merged — see `collapseDuplicateBars`. */
  collapsedDuplicates: CollapsedDuplicate[];
}

/**
 * The grid a bar's coordinates are projected against, derived from the city
 * config the same way `scripts/build-grid.ts` derives it: the bounding
 * box's SW corner as origin, dimensions from `computeGridDimensions`. There
 * is no separate `grid_width`/`grid_height`/`origin_lat`/`origin_lon` source
 * at import time — `data/cities/<slug>.json` is the only one.
 */
export function gridParamsFromCityConfig(config: CityConfig): GridParams {
  const { grid_width, grid_height } = computeGridDimensions(
    config.bounding_box,
    config.cell_size_m,
  );
  return {
    origin_lat: config.bounding_box.south,
    origin_lon: config.bounding_box.west,
    grid_width,
    grid_height,
    cell_size_m: config.cell_size_m,
  };
}

function addressFromTags(tags: Record<string, string> | undefined): string | null {
  if (!tags) return null;
  const street = tags['addr:street'];
  const housenumber = tags['addr:housenumber'];
  const postcode = tags['addr:postcode'];
  const city = tags['addr:city'];

  const streetLine = [street, housenumber].filter(Boolean).join(' ');
  const cityLine = [postcode, city].filter(Boolean).join(' ');
  const address = [streetLine, cityLine].filter((part) => part.length > 0).join(', ');
  return address.length > 0 ? address : null;
}

/**
 * Converts Overpass `out center` elements into bar records. Entries without
 * a `name` tag are discarded and counted (SPEC.md Section 11.1) — not
 * thrown on, since this is expected and common for OSM drinking
 * establishments, unlike a bar with no usable position, which fails loudly
 * (a coordinate outside the configured grid means the city config or the
 * query area is wrong, not that the bar should be silently dropped).
 *
 * The duplicate collapse (SPEC.md Section 11.1, `collapseDuplicateBars`
 * below) runs here rather than being left to the caller, so that every
 * consumer of the conversion — the seed file, the diff report, the counts
 * printed on exit — sees the same set and no caller can forget the step.
 * It runs *after* the name discard, because the rule is a rule about names
 * and an element without one has already left the data.
 */
export function osmElementsToBars(
  response: OverpassBarsResponse,
  config: CityConfig,
): OsmToBarsResult {
  const grid = gridParamsFromCityConfig(config);
  const bars: Bar[] = [];
  let discardedNoName = 0;
  let wayOrRelationCount = 0;

  for (const el of response.elements) {
    const name = el.tags?.name;
    if (!name) {
      discardedNoName++;
      continue;
    }

    let lat: number;
    let lon: number;
    if (el.type === 'node') {
      lat = el.lat;
      lon = el.lon;
    } else {
      if (!el.center) {
        throw new Error(
          `OSM ${el.type} ${el.id} ("${name}") has no "center" — expected every way/relation result ` +
            `to carry one from "out center". The Overpass response may be malformed.`,
        );
      }
      lat = el.center.lat;
      lon = el.center.lon;
      wayOrRelationCount++;
    }

    const cellIndex = toCell(lat, lon, grid);
    if (cellIndex === null) {
      throw new Error(
        `OSM ${el.type} ${el.id} ("${name}") at (${lat}, ${lon}) falls outside the grid configured ` +
          `for "${config.name}" (bounding box ${JSON.stringify(config.bounding_box)}). This usually ` +
          `means the city config's bounding_box is wrong, or Overpass returned an element outside ` +
          `the queried area.`,
      );
    }

    bars.push({
      osm_id: `${el.type}/${el.id}`,
      name,
      address: addressFromTags(el.tags),
      lat,
      lon,
      cell_index: cellIndex,
      source: 'osm',
    });
  }

  const collapsed = collapseDuplicateBars(bars);
  return {
    bars: collapsed.bars,
    discardedNoName,
    wayOrRelationCount,
    collapsedDuplicates: collapsed.collapsed,
  };
}

// ---------------------------------------------------------------------------
// Duplicate collapse (SPEC.md Section 11.1).
//
// OSM maps the same physical venue twice more often than one would like: a
// node for the venue and a way for the building it occupies, or simply two
// nodes surveyed by two mappers years apart. Karlsruhe's seed contains both
// shapes — "Fettschmelze" as two nodes about 7 m apart, "Traube" as a node
// and a way about 20 m apart. Two rows means two bar ids, and every rule
// downstream that is keyed on a bar id then treats them as two bars: the
// partial unique index `idx_visits_one_pending` (Section 5.7) stops a second
// pending visit at the same *id* and cannot stop one at the twin, so a player
// standing in front of one building sees two markers an arm's length apart
// with the same name and can check into both.
//
// The rule applied is not a new one. It is Section 11.3's community-
// submission duplicate guard, `findConflictingBar` (`suggest.ts`), called
// with the bars kept so far as the "active bars" it checks against — the same
// `SUGGEST_DUPLICATE_RADIUS_M`, the same `SUGGEST_NAME_SIMILARITY`, the same
// name normalisation and the same empty-name guard. One implementation, so
// the import and the submission form can never disagree about what a
// duplicate is.
// ---------------------------------------------------------------------------

/** One merged pair: which bar was kept, which was dropped, and how far apart they were. */
export interface CollapsedDuplicate {
  kept: Bar;
  dropped: Bar;
  distanceM: number;
}

// Which of a duplicate pair survives. A total order over the pair, so the
// answer depends only on the two records and never on the order Overpass
// happened to return them in — re-running the import over the same data has
// to produce the same file.
//
//   1. The one with an address beats the one without. An `addr:*`-tagged
//      element carries real information the other does not, and it is
//      information the app uses (Section 8.3's detail view, and Section
//      11.3's own duplicate guard when a player later submits the same
//      venue). Dropping the tagged twin would throw it away.
//   2. Then a node beats a way, and a way beats a relation. A node is the
//      surveyed position of the venue itself; a way or relation is reduced to
//      its centroid (Section 11.1), which is the middle of a *building* and
//      need not be where the bar is — a building with three venues in it has
//      one centroid for all three.
//   3. Then the lower OSM id wins. Within one element type the lower id is
//      the older object: it has been in OSM longer, so it is the one other
//      data is more likely to already reference — including `bars.osm_id` in
//      an already-seeded database, where keeping it means the re-import is a
//      no-op for that venue rather than a delete plus an insert that would
//      take its discoveries and visits with it (Section 5.6, ON DELETE
//      CASCADE).
//
// Step 3 alone would already be a stable rule; steps 1 and 2 are there so the
// stable answer is also the better record.
const OSM_TYPE_RANK: Record<string, number> = { node: 0, way: 1, relation: 2 };

function osmIdSortKey(osmId: string): { typeRank: number; id: number } {
  const slash = osmId.indexOf('/');
  const type = slash === -1 ? osmId : osmId.slice(0, slash);
  const rawId = slash === -1 ? '' : osmId.slice(slash + 1);
  const id = Number(rawId);
  return {
    typeRank: OSM_TYPE_RANK[type] ?? Number.MAX_SAFE_INTEGER,
    id: Number.isFinite(id) ? id : Number.MAX_SAFE_INTEGER,
  };
}

function compareSurvivorPriority(a: Bar, b: Bar): number {
  const byAddress = (a.address === null ? 1 : 0) - (b.address === null ? 1 : 0);
  if (byAddress !== 0) return byAddress;

  const keyA = osmIdSortKey(a.osm_id);
  const keyB = osmIdSortKey(b.osm_id);
  if (keyA.typeRank !== keyB.typeRank) return keyA.typeRank - keyB.typeRank;
  if (keyA.id !== keyB.id) return keyA.id - keyB.id;
  // Unreachable for well-formed OSM ids (they are unique per type), and here
  // only so the comparator is a total order for any input at all.
  return a.osm_id < b.osm_id ? -1 : a.osm_id > b.osm_id ? 1 : 0;
}

/**
 * Collapses near-identical venues into one bar, per SPEC.md Section 11.1.
 *
 * Two bars are the same venue when Section 11.3's rule says so: within
 * `SUGGEST_DUPLICATE_RADIUS_M` of each other and with a normalized
 * Levenshtein name ratio of at least `SUGGEST_NAME_SIMILARITY`.
 *
 * The scan runs over a copy sorted by `compareSurvivorPriority`, keeping the
 * first member of each cluster and dropping every later one that conflicts
 * with something already kept. Sorting first is what makes the survivor the
 * pair's *best* record rather than whichever of them Overpass listed first,
 * and it is also what makes the whole operation deterministic: the output is
 * a function of the set of input records, not of their order.
 *
 * The surviving bars are returned in the caller's original order, so this
 * changes which records are in the seed file and nothing else about it.
 */
export function collapseDuplicateBars(bars: readonly Bar[]): {
  bars: Bar[];
  collapsed: CollapsedDuplicate[];
} {
  const byPriority = [...bars].sort(compareSurvivorPriority);
  const kept: Bar[] = [];
  // `findConflictingBar` answers with the conflicting entry itself, so `id`
  // is set to the entry's index in `kept` and the survivor of the pair is
  // recoverable from the answer without a second search.
  const keptCandidates: DuplicateCandidateBar[] = [];
  const collapsed: CollapsedDuplicate[] = [];
  const droppedOsmIds = new Set<string>();

  for (const candidate of byPriority) {
    const conflict = findConflictingBar(
      candidate.name,
      candidate,
      keptCandidates,
      CONFIG.IMPORT_DUPLICATE_RADIUS_M,
    );
    if (conflict) {
      const survivor = kept[conflict.id];
      droppedOsmIds.add(candidate.osm_id);
      collapsed.push({
        kept: survivor,
        dropped: candidate,
        distanceM: haversineDistanceM(survivor, candidate),
      });
      continue;
    }
    keptCandidates.push({
      id: kept.length,
      name: candidate.name,
      lat: candidate.lat,
      lon: candidate.lon,
    });
    kept.push(candidate);
  }

  return {
    bars: bars.filter((entry) => !droppedOsmIds.has(entry.osm_id)),
    collapsed,
  };
}

// ---------------------------------------------------------------------------
// Display ordering for a list of bars (SPEC.md Section 9.3).
//
// Defined here, once, and used by both the admin endpoint
// (`packages/api/src/routes/admin.ts`) and the admin screen
// (`packages/web/src/screens/Admin.tsx`), so the server and the client cannot
// disagree about what "alphabetical" means: the server sends a sorted list,
// the client keeps it sorted as bars are created and renamed in place, and
// both call this one function to do it.
//
// Not `ORDER BY name COLLATE NOCASE` in SQL. SQLite's built-in NOCASE
// collation folds ASCII A–Z only and otherwise compares by code point, so
// every umlaut sorts after `Z` (`Ä` is U+00C4, `Z` is U+005A) — on a German
// city's bar names that is visibly wrong, and it is invisible to any test
// whose fixture is ASCII. `Intl.Collator` is the ICU collation Node and every
// browser this app targets already ship, so it costs no dependency; the list
// is one unpaginated page of a few hundred rows, so sorting it in memory
// costs nothing either.
//
// The locale is pinned to German deliberately. The UI is English-only
// (constraint C9), but the *data* being ordered is German place names, and the
// app serves one city (Section 5.1). Pinning it also keeps the two callers in
// agreement: an unspecified locale resolves to the environment's — the
// container's on the server, the *admin's browser language* on the client —
// so the same list could be ordered two different ways depending on who is
// looking at it. A second city would want this per-city, alongside the other
// per-city facts in `data/cities/<slug>.json`; that is an observation for
// whoever adds one, not something built here.
//
// `numeric: true` because the real data has numbered names — "Bar 23" and
// "Bar 137", "P10" and "Studio 83" — and a reader expects 23 before 137.
// Sensitivity is left at its default ("variant"), so upper- and lower-case
// spellings of the same name sort next to each other but are still ordered
// against each other rather than compared equal; the comparison therefore
// stays a total order over distinct names.
//
// The collator is built once, at module scope: constructing one inside a
// comparator would rebuild it on every one of the O(n log n) comparisons.
//
// Like everything else in this module, this uses no relative value import —
// `Intl` is a JavaScript built-in — so `scripts/import-osm-bars.ts` can still
// run this file as raw source (see the module note at the top).
// ---------------------------------------------------------------------------

/** The two fields the ordering reads. Every bar list entry in the app has both. */
export interface BarListEntry {
  id: number;
  name: string;
}

const BAR_NAME_COLLATOR = new Intl.Collator('de', { numeric: true });

/**
 * Orders bars by name for display, case-insensitively in the way a reader
 * expects and with umlauts in their German places.
 *
 * Equal names are broken by `id`: this data set really does contain two bars
 * of the same name (the same chain in two districts), and without a stable
 * second key their relative order would be whatever the sort implementation
 * and the row order happened to produce, so the list would reshuffle between
 * requests for no visible reason. `id` is the right key because it is unique,
 * immutable and present on every bar the admin area handles — a newly created
 * bar included, which `created_at` (seconds, and equal for a batch import)
 * could not promise.
 */
export function compareBarsByName(a: BarListEntry, b: BarListEntry): number {
  const byName = BAR_NAME_COLLATOR.compare(a.name, b.name);
  return byName !== 0 ? byName : a.id - b.id;
}

// ---------------------------------------------------------------------------
// Diff between two sets of bars (SPEC.md Section 11.2) — re-running the
// import must report what changed to stdout, never apply it anywhere but
// the seed file.
// ---------------------------------------------------------------------------

export interface ChangedBar {
  osm_id: string;
  before: Bar;
  after: Bar;
  changedFields: string[];
}

export interface BarDiff {
  added: Bar[];
  removed: Bar[];
  changed: ChangedBar[];
}

/** Compares two bar sets by `osm_id`, reporting additions, removals and field changes. */
export function diffBars(previous: Bar[], next: Bar[]): BarDiff {
  const previousById = new Map(previous.map((b) => [b.osm_id, b]));
  const nextById = new Map(next.map((b) => [b.osm_id, b]));

  const added = next.filter((b) => !previousById.has(b.osm_id));
  const removed = previous.filter((b) => !nextById.has(b.osm_id));

  const changed: ChangedBar[] = [];
  for (const [osmId, before] of previousById) {
    const after = nextById.get(osmId);
    if (!after) continue;

    const changedFields: string[] = [];
    if (before.name !== after.name) changedFields.push('name');
    if (before.address !== after.address) changedFields.push('address');
    if (before.lat !== after.lat || before.lon !== after.lon) changedFields.push('position');

    if (changedFields.length > 0) {
      changed.push({ osm_id: osmId, before, after, changedFields });
    }
  }

  return { added, removed, changed };
}
