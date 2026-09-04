import { describe, expect, it } from 'vitest';
import type { CityConfig } from './city.js';
import { CONFIG } from './config.js';
import { haversineDistanceM, toCell } from './grid.js';
import {
  buildBarsQuery,
  collapseDuplicateBars,
  compareBarsByName,
  diffBars,
  gridParamsFromCityConfig,
  osmElementsToBars,
  parseBarsFile,
  parseBarsPayload,
  type Bar,
  type OverpassBarElement,
} from './bars.js';

const KARLSRUHE_CONFIG: CityConfig = {
  slug: 'karlsruhe',
  name: 'Karlsruhe',
  bounding_box: { south: 48.94, west: 8.275, north: 49.095, east: 8.56 },
  cell_size_m: 50,
  geofabrik_region: 'europe/germany/baden-wuerttemberg',
  tiles_filename: 'karlsruhe.2026-08.pmtiles',
  osm_admin_filter: {
    name: 'Karlsruhe',
    city_admin_levels: [6, 8],
    district_admin_levels: [9, 10],
    regional_key_prefix: '08212',
  },
};

// A deliberately different synthetic config, mirroring overpass.test.ts's
// OTHER_CONFIG, to prove the query builder is parameterised rather than
// accidentally matching on Karlsruhe strings.
const OTHER_CONFIG: CityConfig = {
  slug: 'testburg',
  name: 'Testburg',
  bounding_box: { south: 1, west: 2, north: 3, east: 4 },
  cell_size_m: 25,
  geofabrik_region: 'europe/germany/other',
  tiles_filename: 'testburg.pmtiles',
  osm_admin_filter: {
    name: 'Testburg',
    city_admin_levels: [7],
    district_admin_levels: [11],
  },
};

describe('buildBarsQuery', () => {
  it("contains the four amenity values and the city's own filter", () => {
    const query = buildBarsQuery(KARLSRUHE_CONFIG);
    expect(query).toContain('amenity"~"^(bar|pub|biergarten|nightclub)$"');
    expect(query).toContain('admin_level"~"^(6|8)$"');
    expect(query).toContain('"name"="Karlsruhe"');
    expect(query).toContain('de:regionalschluessel"~"^08212"');
    expect(query).toContain('out center;');
  });

  it('changes with a different config', () => {
    const karlsruheQuery = buildBarsQuery(KARLSRUHE_CONFIG);
    const otherQuery = buildBarsQuery(OTHER_CONFIG);

    expect(otherQuery).not.toEqual(karlsruheQuery);
    expect(otherQuery).toContain('admin_level"~"^(7)$"');
    expect(otherQuery).toContain('"name"="Testburg"');
    expect(otherQuery).not.toContain('regionalschluessel');
    expect(otherQuery).not.toContain('Karlsruhe');
    // The amenity list itself does not change with the config.
    expect(otherQuery).toContain('amenity"~"^(bar|pub|biergarten|nightclub)$"');
  });

  it('additionally contains a bar=yes clause for node, way and relation, independent of amenity', () => {
    const query = buildBarsQuery(KARLSRUHE_CONFIG);
    // Additive: the amenity clause from the test above is still present, unchanged.
    expect(query).toContain('amenity"~"^(bar|pub|biergarten|nightclub)$"');
    expect(query).toContain('node["bar"="yes"]');
    expect(query).toContain('way["bar"="yes"]');
    expect(query).toContain('relation["bar"="yes"]');
  });

  it('scopes both the amenity clause and the bar=yes clause inside the one area.cityArea union', () => {
    const query = buildBarsQuery(KARLSRUHE_CONFIG);

    // Extract exactly the union block: from the opening "(" that follows
    // ".city map_to_area->.cityArea;" up to its closing ");". A mutation
    // that moves the bar=yes statements outside this block — querying them
    // city-wide or worldwide instead of inside the union — must fail this,
    // not just a substring-anywhere-in-the-query check.
    const unionMatch = query.match(/\.cityArea;\n\(\n([\s\S]*?)\n\);\nout center;/);
    expect(unionMatch).not.toBeNull();
    const unionBody = unionMatch![1];

    expect(unionBody).toContain(
      'node["amenity"~"^(bar|pub|biergarten|nightclub)$"](area.cityArea);',
    );
    expect(unionBody).toContain(
      'way["amenity"~"^(bar|pub|biergarten|nightclub)$"](area.cityArea);',
    );
    expect(unionBody).toContain(
      'relation["amenity"~"^(bar|pub|biergarten|nightclub)$"](area.cityArea);',
    );
    expect(unionBody).toContain('node["bar"="yes"](area.cityArea);');
    expect(unionBody).toContain('way["bar"="yes"](area.cityArea);');
    expect(unionBody).toContain('relation["bar"="yes"](area.cityArea);');

    // Every statement line inside the union must itself carry the
    // area.cityArea scope — nothing unscoped smuggled into the block.
    const statementLines = unionBody.split('\n').filter((line) => line.trim().length > 0);
    expect(statementLines.length).toBeGreaterThan(0);
    for (const line of statementLines) {
      expect(line).toContain('(area.cityArea)');
    }
  });
});

describe('parseBarsPayload', () => {
  it('rejects an HTML error page', () => {
    const html = '<!DOCTYPE html><html><body>Too many requests</body></html>';
    expect(() => parseBarsPayload(html, undefined)).toThrow(/HTML/);
  });

  it('rejects a body that is not valid JSON', () => {
    expect(() => parseBarsPayload('not json at all', 'application/json')).toThrow(/JSON/);
  });

  it('rejects an empty elements array', () => {
    expect(() =>
      parseBarsPayload(JSON.stringify({ version: 0.6, elements: [] }), 'application/json'),
    ).toThrow(/zero elements/);
  });

  it('accepts a well-formed Overpass response', () => {
    const payload = JSON.stringify({
      version: 0.6,
      elements: [{ type: 'node', id: 1, lat: 49.0, lon: 8.4, tags: { amenity: 'bar', name: 'X' } }],
    });
    expect(parseBarsPayload(payload, 'application/json').elements).toHaveLength(1);
  });
});

describe('osmElementsToBars', () => {
  it('turns a named node into a bar', () => {
    const elements: OverpassBarElement[] = [
      { type: 'node', id: 1, lat: 49.0, lon: 8.4, tags: { amenity: 'bar', name: 'Zum Fass' } },
    ];
    const result = osmElementsToBars({ elements }, KARLSRUHE_CONFIG);

    expect(result.bars).toHaveLength(1);
    expect(result.bars[0]).toMatchObject({
      osm_id: 'node/1',
      name: 'Zum Fass',
      lat: 49.0,
      lon: 8.4,
      source: 'osm',
    });
    expect(result.discardedNoName).toBe(0);
    expect(result.wayOrRelationCount).toBe(0);
  });

  it('discards a node without a name tag, and counts it', () => {
    const elements: OverpassBarElement[] = [
      { type: 'node', id: 1, lat: 49.0, lon: 8.4, tags: { amenity: 'bar', name: 'Named' } },
      { type: 'node', id: 2, lat: 49.0, lon: 8.41, tags: { amenity: 'bar' } },
    ];
    const result = osmElementsToBars({ elements }, KARLSRUHE_CONFIG);

    expect(result.bars).toHaveLength(1);
    expect(result.bars[0].osm_id).toBe('node/1');
    expect(result.discardedNoName).toBe(1);
  });

  it('reduces a way with a center to a bar at that centroid, and counts it', () => {
    const elements: OverpassBarElement[] = [
      {
        type: 'way',
        id: 5,
        center: { lat: 49.02, lon: 8.42 },
        tags: { amenity: 'biergarten', name: 'Beer Garden' },
      },
    ];
    const result = osmElementsToBars({ elements }, KARLSRUHE_CONFIG);

    expect(result.bars).toHaveLength(1);
    expect(result.bars[0]).toMatchObject({
      osm_id: 'way/5',
      name: 'Beer Garden',
      lat: 49.02,
      lon: 8.42,
    });
    expect(result.wayOrRelationCount).toBe(1);
  });

  it('builds an address from addr:* tags, and leaves it null when absent', () => {
    const elements: OverpassBarElement[] = [
      {
        type: 'node',
        id: 1,
        lat: 49.0,
        lon: 8.4,
        tags: {
          amenity: 'pub',
          name: 'With Address',
          'addr:street': 'Kaiserstraße',
          'addr:housenumber': '1',
          'addr:postcode': '76133',
          'addr:city': 'Karlsruhe',
        },
      },
      { type: 'node', id: 2, lat: 49.0, lon: 8.41, tags: { amenity: 'pub', name: 'No Address' } },
    ];
    const result = osmElementsToBars({ elements }, KARLSRUHE_CONFIG);

    expect(result.bars[0].address).toBe('Kaiserstraße 1, 76133 Karlsruhe');
    expect(result.bars[1].address).toBeNull();
  });

  it('computes cell_index matching the Section 6.1 projection for the same coordinates', () => {
    const elements: OverpassBarElement[] = [
      { type: 'node', id: 1, lat: 49.02, lon: 8.42, tags: { amenity: 'bar', name: 'X' } },
    ];
    const result = osmElementsToBars({ elements }, KARLSRUHE_CONFIG);

    const expected = toCell(49.02, 8.42, gridParamsFromCityConfig(KARLSRUHE_CONFIG));
    expect(expected).not.toBeNull();
    expect(result.bars[0].cell_index).toBe(expected);
  });

  it('throws for a way/relation result missing a center', () => {
    const elements: OverpassBarElement[] = [
      { type: 'way', id: 5, tags: { amenity: 'biergarten', name: 'No Center' } },
    ];
    expect(() => osmElementsToBars({ elements }, KARLSRUHE_CONFIG)).toThrow(/center/);
  });

  it('throws for a coordinate outside the configured grid', () => {
    const elements: OverpassBarElement[] = [
      { type: 'node', id: 1, lat: 60.0, lon: 8.4, tags: { amenity: 'bar', name: 'Way Up North' } },
    ];
    expect(() => osmElementsToBars({ elements }, KARLSRUHE_CONFIG)).toThrow(/outside the grid/);
  });

  it('converts a non-drinking amenity carrying bar=yes exactly like any other match (regression guard: the filtering is entirely in the query, not here)', () => {
    const elements: OverpassBarElement[] = [
      {
        type: 'node',
        id: 42,
        lat: 49.0,
        lon: 8.4,
        tags: { amenity: 'restaurant', bar: 'yes', name: 'Enchilada Karlsruhe' },
      },
    ];
    const result = osmElementsToBars({ elements }, KARLSRUHE_CONFIG);

    expect(result.bars).toHaveLength(1);
    expect(result.bars[0]).toMatchObject({
      osm_id: 'node/42',
      name: 'Enchilada Karlsruhe',
      lat: 49.0,
      lon: 8.4,
      source: 'osm',
    });
    expect(result.discardedNoName).toBe(0);
  });

  // SPEC.md Section 11.1: the collapse is part of the conversion, not
  // something the caller is trusted to remember. Both nodes below are the
  // Fettschmelze pair as OSM actually holds it (see the collapse suite).
  it('collapses a duplicate venue as part of the conversion, and reports it', () => {
    const elements: OverpassBarElement[] = [
      {
        type: 'node',
        id: 5408199821,
        lat: 49.0046399,
        lon: 8.4290321,
        tags: { amenity: 'bar', name: 'Fettschmelze' },
      },
      {
        type: 'node',
        id: 5075975976,
        lat: 49.0045932,
        lon: 8.4290774,
        tags: { amenity: 'bar', name: 'Fettschmelze' },
      },
    ];
    const result = osmElementsToBars({ elements }, KARLSRUHE_CONFIG);

    expect(result.bars.map((entry) => entry.osm_id)).toEqual(['node/5075975976']);
    expect(result.collapsedDuplicates).toHaveLength(1);
    expect(result.collapsedDuplicates[0].dropped.osm_id).toBe('node/5408199821');
  });
});

// SPEC.md Section 11.1's import-side duplicate rule, which is Section 11.3's
// community-submission rule applied to the seed: within
// SUGGEST_DUPLICATE_RADIUS_M and a normalized name similarity of at least
// SUGGEST_NAME_SIMILARITY means one venue, not two.
//
// The fixtures are the two real pairs from `data/seed/karlsruhe/bars.json`
// that the owner's field test ran into, at their committed coordinates, so
// these tests are pinned to the data that produced the bug rather than to a
// synthetic pair chosen to sit comfortably inside the threshold.
describe('collapseDuplicateBars', () => {
  function importedBar(overrides: Partial<Bar> = {}): Bar {
    return {
      osm_id: 'node/1',
      name: 'Zum Fass',
      address: null,
      lat: 49.0,
      lon: 8.4,
      cell_index: 0,
      source: 'osm',
      ...overrides,
    };
  }

  // node/5075975976 and node/5408199821: the same building, 6.2 m apart,
  // same name, same address. The player saw two markers an arm's length
  // apart and checked into both.
  const FETTSCHMELZE_A = importedBar({
    osm_id: 'node/5075975976',
    name: 'Fettschmelze',
    address: 'Alter Schlachthof 25, 76131 Karlsruhe',
    lat: 49.0045932,
    lon: 8.4290774,
  });
  const FETTSCHMELZE_B = importedBar({
    osm_id: 'node/5408199821',
    name: 'Fettschmelze',
    address: 'Alter Schlachthof 25, 76131 Karlsruhe',
    lat: 49.0046399,
    lon: 8.4290321,
  });

  // node/1447845917 and way/54732961: the same name, 25.34 m apart, no
  // address on either — and *two venues*, a restaurant and a beer garden on
  // opposite sides of the street. Both must survive. The pair reads like a
  // node-and-building double mapping and is not one, which is the whole
  // reason IMPORT_DUPLICATE_RADIUS_M is 15 m (SPEC.md Section 11.1, trap 14).
  const TRAUBE_NODE = importedBar({
    osm_id: 'node/1447845917',
    name: 'Traube',
    lat: 48.9986991,
    lon: 8.4731355,
  });
  const TRAUBE_WAY = importedBar({
    osm_id: 'way/54732961',
    name: 'Traube',
    lat: 48.9988391,
    lon: 8.4734095,
  });

  it('collapses two records of the same venue metres apart into one', () => {
    const result = collapseDuplicateBars([FETTSCHMELZE_A, FETTSCHMELZE_B]);

    expect(result.bars.map((entry) => entry.osm_id)).toEqual(['node/5075975976']);
    expect(result.collapsed).toHaveLength(1);
    expect(result.collapsed[0].kept.osm_id).toBe('node/5075975976');
    expect(result.collapsed[0].dropped.osm_id).toBe('node/5408199821');
    expect(result.collapsed[0].distanceM).toBeCloseTo(6.2, 1);
  });

  // The pair that bounds IMPORT_DUPLICATE_RADIUS_M from above. Until v1.49
  // this suite asserted the opposite — that Traube collapsed at 40 m — on the
  // reading that it was one venue mapped as a node and as the building way
  // around it. The owner says it is two: a restaurant and a beer garden
  // facing each other across the street. So the assertion is inverted rather
  // than deleted, and it is inverted against the real coordinates from the
  // seed, because collapsing this pair is not a harmless over-merge — it
  // takes a bar a player can walk into off the map entirely, which is worse
  // than the duplicate marker the rule exists to remove.
  it('keeps Traube, which is two venues 25 m apart and not one venue mapped twice', () => {
    const result = collapseDuplicateBars([TRAUBE_NODE, TRAUBE_WAY]);

    expect(result.bars.map((entry) => entry.osm_id)).toEqual(['node/1447845917', 'way/54732961']);
    expect(result.collapsed).toHaveLength(0);
  });

  // The two halves of the tuning as one property, which is what actually
  // fails if someone widens the radius back: identical names at Traube's
  // separation stay two bars, and identical names at Fettschmelze's become
  // one. Written against the two real distances rather than against the
  // constant, so it pins the *outcome* and not the arithmetic.
  it('separates the two same-name pairs in the seed: 25 m survives, 6 m collapses', () => {
    const traube = collapseDuplicateBars([TRAUBE_NODE, TRAUBE_WAY]);
    const fettschmelze = collapseDuplicateBars([FETTSCHMELZE_A, FETTSCHMELZE_B]);

    expect(haversineDistanceM(TRAUBE_NODE, TRAUBE_WAY)).toBeCloseTo(25.34, 1);
    expect(traube.bars).toHaveLength(2);

    expect(haversineDistanceM(FETTSCHMELZE_A, FETTSCHMELZE_B)).toBeCloseTo(6.15, 1);
    expect(fettschmelze.bars).toHaveLength(1);

    // And the radius sits strictly between them, which is the only reason
    // both answers can hold at once.
    expect(CONFIG.IMPORT_DUPLICATE_RADIUS_M).toBeGreaterThan(6.15);
    expect(CONFIG.IMPORT_DUPLICATE_RADIUS_M).toBeLessThan(25.34);
  });

  // The distance half of the rule still has to bite somewhere, so this is the
  // same name at a separation no building explains - two genuinely different
  // pubs sharing a common name, which is the case the radius exists to spare.
  it('keeps two same-named bars that are further apart than the import radius', () => {
    const result = collapseDuplicateBars([
      TRAUBE_NODE,
      importedBar({
        osm_id: 'node/901',
        name: 'Traube',
        // ~89 m north of TRAUBE_NODE, well past any plausible import radius.
        lat: 48.9994991,
        lon: 8.4731355,
      }),
    ]);

    expect(result.bars).toHaveLength(2);
    expect(result.collapsed).toHaveLength(0);
  });

  // The name half of the rule: neighbours, metres apart, different names.
  it('keeps two differently named bars at the same address', () => {
    const result = collapseDuplicateBars([
      FETTSCHMELZE_A,
      importedBar({
        osm_id: 'node/900',
        name: 'Kohi',
        address: 'Alter Schlachthof 25, 76131 Karlsruhe',
        lat: 49.0046399,
        lon: 8.4290321,
      }),
    ]);

    expect(result.bars).toHaveLength(2);
  });

  // And the name half from close range, which is where the threshold
  // actually earns its value. Two venues in one complex whose names share a
  // word are the ordinary case in a converted industrial site like the Alter
  // Schlachthof, and they are two bars: 0.65 on this ratio, well under
  // SUGGEST_NAME_SIMILARITY. A threshold loosened far enough to merge these
  // would take real, separately checkable venues off the map.
  it('keeps two neighbours whose names merely share a word', () => {
    const result = collapseDuplicateBars([
      importedBar({ osm_id: 'node/10', name: 'Schlachthof', lat: 49.0045932, lon: 8.4290774 }),
      importedBar({
        osm_id: 'node/11',
        name: 'Alter Schlachthof',
        lat: 49.0046399,
        lon: 8.4290321,
      }),
    ]);

    expect(result.bars).toHaveLength(2);
  });

  // The other side of the same threshold: a spelling variation of one name -
  // here a space one mapper wrote and the other did not - is 0.875 and is
  // one venue. A threshold tightened to demand identity would leave these as
  // two bars, which is the bug this whole rule exists to remove.
  it('collapses a spelling variation of the same name', () => {
    const result = collapseDuplicateBars([
      importedBar({ osm_id: 'node/10', name: 'Sub Rosa', lat: 49.0045932, lon: 8.4290774 }),
      importedBar({ osm_id: 'node/11', name: 'SubRosa', lat: 49.0046399, lon: 8.4290321 }),
    ]);

    expect(result.bars.map((entry) => entry.osm_id)).toEqual(['node/10']);
  });

  // Section 11.3's normalisation is inherited whole, suffixes included, so a
  // venue mapped once with its type in the name and once without is one bar.
  it('collapses names that differ only by a suffix the rule normalises away', () => {
    const result = collapseDuplicateBars([
      FETTSCHMELZE_A,
      importedBar({ ...FETTSCHMELZE_B, name: 'Fettschmelze Bar' }),
    ]);

    expect(result.bars.map((entry) => entry.osm_id)).toEqual(['node/5075975976']);
  });

  // And so is its empty-name guard: two unrelated names that both normalise
  // to nothing must not become one bar just because "" equals "".
  it('never merges two names that both normalise to the empty string', () => {
    const result = collapseDuplicateBars([
      importedBar({ osm_id: 'node/10', name: 'The Bar', lat: 49.0, lon: 8.4 }),
      importedBar({ osm_id: 'node/11', name: 'Die Kneipe', lat: 49.0, lon: 8.4 }),
    ]);

    expect(result.bars).toHaveLength(2);
  });

  // Determinism: the seed must be reproducible, so the survivor cannot be
  // "whichever one Overpass listed first".
  it('picks the same survivor whichever order the pair arrives in', () => {
    const forwards = collapseDuplicateBars([FETTSCHMELZE_A, FETTSCHMELZE_B]);
    const backwards = collapseDuplicateBars([FETTSCHMELZE_B, FETTSCHMELZE_A]);

    expect(forwards.bars.map((entry) => entry.osm_id)).toEqual(['node/5075975976']);
    expect(backwards.bars.map((entry) => entry.osm_id)).toEqual(['node/5075975976']);
  });

  it('keeps the record that has an address over one that has none, whatever their ids', () => {
    const withAddress = importedBar({
      osm_id: 'node/999',
      name: 'Fettschmelze',
      address: 'Alter Schlachthof 25, 76131 Karlsruhe',
      lat: 49.0045932,
      lon: 8.4290774,
    });
    const withoutAddress = importedBar({
      osm_id: 'node/1',
      name: 'Fettschmelze',
      lat: 49.0046399,
      lon: 8.4290321,
    });

    const result = collapseDuplicateBars([withoutAddress, withAddress]);

    expect(result.bars.map((entry) => entry.osm_id)).toEqual(['node/999']);
  });

  // A way is reduced to a building centroid (Section 11.1); a node is the
  // surveyed point. The way carries the lower id here on purpose, so only the
  // element-type rank can produce this answer.
  it('keeps the surveyed node over a way reduced to its centroid', () => {
    const node = importedBar({
      osm_id: 'node/900',
      name: 'Traube',
      lat: TRAUBE_NODE.lat,
      lon: TRAUBE_NODE.lon,
    });
    const way = importedBar({
      osm_id: 'way/5',
      name: 'Traube',
      lat: TRAUBE_NODE.lat,
      lon: TRAUBE_NODE.lon,
    });

    const result = collapseDuplicateBars([way, node]);

    expect(result.bars.map((entry) => entry.osm_id)).toEqual(['node/900']);
  });

  it('returns the survivors in the order they were given', () => {
    const first = importedBar({ osm_id: 'node/1', name: 'Alpha', lat: 49.0, lon: 8.4 });
    const last = importedBar({ osm_id: 'node/3', name: 'Omega', lat: 49.02, lon: 8.42 });

    const result = collapseDuplicateBars([first, FETTSCHMELZE_B, last, FETTSCHMELZE_A]);

    expect(result.bars.map((entry) => entry.osm_id)).toEqual([
      'node/1',
      'node/3',
      'node/5075975976',
    ]);
  });

  it('leaves a set with no duplicates untouched', () => {
    const bars = [
      importedBar({ osm_id: 'node/1', name: 'Alpha', lat: 49.0, lon: 8.4 }),
      importedBar({ osm_id: 'node/2', name: 'Beta', lat: 49.01, lon: 8.41 }),
    ];

    const result = collapseDuplicateBars(bars);

    expect(result.bars).toEqual(bars);
    expect(result.collapsed).toHaveLength(0);
  });
});

describe('parseBarsPayload: raw Overpass and GeoJSON produce the same records', () => {
  it('yields identical bar records from an equivalent Overpass and GeoJSON payload', () => {
    const overpassPayload = JSON.stringify({
      version: 0.6,
      elements: [
        {
          type: 'node',
          id: 10,
          lat: 49.01,
          lon: 8.41,
          tags: { amenity: 'bar', name: 'Durlacher Hof' },
        },
        {
          type: 'way',
          id: 20,
          center: { lat: 49.02, lon: 8.43 },
          tags: { amenity: 'biergarten', name: 'Waldschänke' },
        },
      ],
    });

    const geoJsonPayload = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'node/10',
          properties: { amenity: 'bar', name: 'Durlacher Hof' },
          geometry: { type: 'Point', coordinates: [8.41, 49.01] },
        },
        {
          type: 'Feature',
          id: 'way/20',
          properties: { amenity: 'biergarten', name: 'Waldschänke' },
          geometry: { type: 'Point', coordinates: [8.43, 49.02] },
        },
      ],
    });

    const fromOverpass = osmElementsToBars(
      parseBarsPayload(overpassPayload, 'application/json'),
      KARLSRUHE_CONFIG,
    );
    const fromGeoJson = osmElementsToBars(
      parseBarsPayload(geoJsonPayload, 'application/json'),
      KARLSRUHE_CONFIG,
    );

    expect(fromGeoJson.bars).toEqual(fromOverpass.bars);
    expect(fromGeoJson.wayOrRelationCount).toBe(fromOverpass.wayOrRelationCount);
  });
});

describe('diffBars', () => {
  const before: Bar[] = [
    {
      osm_id: 'node/1',
      name: 'Stays Same',
      address: null,
      lat: 49.0,
      lon: 8.4,
      cell_index: 100,
      source: 'osm',
    },
    {
      osm_id: 'node/2',
      name: 'Old Name',
      address: null,
      lat: 49.01,
      lon: 8.41,
      cell_index: 200,
      source: 'osm',
    },
    {
      osm_id: 'node/3',
      name: 'Moves',
      address: null,
      lat: 49.02,
      lon: 8.42,
      cell_index: 300,
      source: 'osm',
    },
    {
      osm_id: 'node/4',
      name: 'Disappears',
      address: null,
      lat: 49.03,
      lon: 8.43,
      cell_index: 400,
      source: 'osm',
    },
  ];

  const after: Bar[] = [
    {
      osm_id: 'node/1',
      name: 'Stays Same',
      address: null,
      lat: 49.0,
      lon: 8.4,
      cell_index: 100,
      source: 'osm',
    },
    {
      osm_id: 'node/2',
      name: 'New Name',
      address: null,
      lat: 49.01,
      lon: 8.41,
      cell_index: 200,
      source: 'osm',
    },
    {
      osm_id: 'node/3',
      name: 'Moves',
      address: null,
      lat: 49.025,
      lon: 8.425,
      cell_index: 301,
      source: 'osm',
    },
    {
      osm_id: 'node/5',
      name: 'New Bar',
      address: null,
      lat: 49.04,
      lon: 8.44,
      cell_index: 500,
      source: 'osm',
    },
  ];

  it('reports additions, removals and changed fields (name, position)', () => {
    const diff = diffBars(before, after);

    expect(diff.added.map((b) => b.osm_id)).toEqual(['node/5']);
    expect(diff.removed.map((b) => b.osm_id)).toEqual(['node/4']);

    const changedIds = diff.changed.map((c) => c.osm_id).sort();
    expect(changedIds).toEqual(['node/2', 'node/3']);

    const nameChange = diff.changed.find((c) => c.osm_id === 'node/2')!;
    expect(nameChange.changedFields).toEqual(['name']);

    const positionChange = diff.changed.find((c) => c.osm_id === 'node/3')!;
    expect(positionChange.changedFields).toEqual(['position']);
  });

  it('reports no changes for identical sets', () => {
    const diff = diffBars(before, before);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
  });
});

describe('compareBarsByName', () => {
  // Real names from data/seed/karlsruhe/bars.json, chosen so that a
  // code-point comparison (which is what `ORDER BY name COLLATE NOCASE`
  // degrades to outside ASCII A-Z) gets a different answer from the one a
  // German reader expects: "ä" is U+00E4, so it sorts after every ASCII
  // letter by code point and "Bärenstüble" would land after
  // "Bergbräustube"; the lower-case names would all pile up after the
  // upper-case ones. No name in that file starts with a digit or a quote -
  // the closest the real data comes is a digit or an apostrophe inside the
  // name ("Bar 137", "Johnny's Pub"), and both are here.
  function bars(...names: string[]) {
    return names.map((name, index) => ({ id: index + 1, name }));
  }

  function sortedNames(entries: { id: number; name: string }[]): string[] {
    return [...entries].sort(compareBarsByName).map((entry) => entry.name);
  }

  it('sorts umlauts where a German reader expects them, not after Z', () => {
    expect(
      sortedNames(
        bars('Zum Schlossgarten', 'Bergbräustube', 'Bärenstüble', 'Änderungsbar', 'Ost-Bar'),
      ),
    ).toEqual(['Änderungsbar', 'Bärenstüble', 'Bergbräustube', 'Ost-Bar', 'Zum Schlossgarten']);
  });

  it('is case-insensitive in the way a reader expects', () => {
    expect(sortedNames(bars('Zeta Bar', 'uBu', 'Bar Alpha', 'apfel'))).toEqual([
      'apfel',
      'Bar Alpha',
      'uBu',
      'Zeta Bar',
    ]);
  });

  it('orders numbers in a name by value, and handles apostrophes', () => {
    expect(sortedNames(bars('Bar 137', 'Bar 23', "Johnny's Pub", 'Johnnys Pub'))).toEqual([
      'Bar 23',
      'Bar 137',
      "Johnny's Pub",
      'Johnnys Pub',
    ]);
  });

  it('breaks a tie on id, so two bars of the same name keep a stable order', () => {
    const first = { id: 7, name: 'Traube' };
    const second = { id: 3, name: 'Traube' };

    expect(compareBarsByName(first, second)).toBeGreaterThan(0);
    expect(compareBarsByName(second, first)).toBeLessThan(0);
    expect(compareBarsByName(first, first)).toBe(0);
    expect([first, second].sort(compareBarsByName).map((bar) => bar.id)).toEqual([3, 7]);
  });

  // The tie-break above is only meant to catch bars that genuinely share a
  // name. That holds because the collator distinguishes every other pair —
  // and that is a choice, not a given: `sensitivity: 'base'` would make
  // `Bar`/`bar` and `Cafe`/Café` compare equal, hand them to the id
  // tie-break, and order two differently spelled bars by whichever happened
  // to be inserted first. Nothing else here would have noticed; the ordering
  // stays plausible and quietly stops being alphabetical for those pairs.
  it('treats names that differ only in case or accent as distinct, not as a tie', () => {
    // Both entries carry the SAME id on purpose, so `a.id - b.id` is zero and
    // what is left is the collator's own verdict on the two names. Giving them
    // different ids would have made this test pass under exactly the
    // implementation it exists to reject: the tie-break would have supplied a
    // non-zero answer and hidden that the names compared equal. (Written that
    // way first, and it did.)
    for (const [left, right] of [
      ['Bar Alpha', 'bar Alpha'],
      ['Cafe Zentral', 'Café Zentral'],
    ]) {
      expect(
        compareBarsByName({ id: 1, name: left }, { id: 1, name: right }),
        `"${left}" and "${right}" must not compare equal, or the id tie-break decides their order`,
      ).not.toBe(0);
    }
  });
});

// Review block R2 (boundaries): both suites below exercise the *rejecting*
// branch of a check added in that block. A validator no test can make say no
// is decoration, so each case here is one the previous cast let through as
// type-confused data or as a TypeError from somewhere unrelated.
describe('parseBarsPayload: a GeoJSON Point with unusable coordinates', () => {
  function pointPayload(coordinates: unknown): string {
    return JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'node/10',
          properties: { amenity: 'bar', name: 'Durlacher Hof' },
          geometry: { type: 'Point', coordinates },
        },
      ],
    });
  }

  it.each([
    ['not an array', '8.41,49.01'],
    ['a one-element array', [8.41]],
    ['an empty array', []],
    ['null', null],
    ['strings rather than numbers', ['8.41', '49.01']],
  ])('is rejected by name rather than carried forward when it is %s', (_label, coordinates) => {
    expect(() => parseBarsPayload(pointPayload(coordinates), 'application/json')).toThrow(
      /Durlacher Hof.*coordinates/s,
    );
  });

  // The elevation case is the reason this is a length/type check and not an
  // exact-length one: RFC 7946 allows a third element, the destructuring this
  // replaced accepted it, and it must keep working.
  it('still accepts a position carrying an elevation as its third element', () => {
    const parsed = parseBarsPayload(pointPayload([8.41, 49.01, 116]), 'application/json');
    expect(parsed.elements).toEqual([
      {
        type: 'node',
        id: 10,
        lat: 49.01,
        lon: 8.41,
        tags: { amenity: 'bar', name: 'Durlacher Hof' },
      },
    ]);
  });
});

describe('parseBarsFile', () => {
  const VALID: Bar = {
    osm_id: 'node/10',
    name: 'Durlacher Hof',
    address: 'Kaiserstraße 1, 76133 Karlsruhe',
    lat: 49.01,
    lon: 8.41,
    cell_index: 42,
    source: 'osm',
  };

  it('returns the entries unchanged for a well-formed file', () => {
    expect(
      parseBarsFile([VALID, { ...VALID, osm_id: 'way/20', address: null }], 'bars.json'),
    ).toEqual([VALID, { ...VALID, osm_id: 'way/20', address: null }]);
  });

  it('accepts an empty array — a city with no bars yet is a file, not a fault', () => {
    expect(parseBarsFile([], 'bars.json')).toEqual([]);
  });

  it.each([
    ['an object', {}],
    ['null', null],
    ['a string', 'bars'],
    ['a number', 7],
  ])('rejects a payload that is %s, naming the file', (_label, payload) => {
    expect(() => parseBarsFile(payload, '/seed/bars.json')).toThrow(
      /\/seed\/bars\.json.*does not contain a JSON array/s,
    );
  });

  it.each([
    ['a non-object entry', 'not-a-bar', /entry 1 is not an object/],
    ['a missing osm_id', { ...VALID, osm_id: undefined }, /entry 1 has no "osm_id" string/],
    ['an empty osm_id', { ...VALID, osm_id: '' }, /entry 1 has no "osm_id" string/],
    ['a missing name', { ...VALID, name: undefined }, /has no "name" string/],
    ['a numeric address', { ...VALID, address: 7 }, /neither a string nor null/],
    ['a NaN lat', { ...VALID, lat: 'x' }, /no finite "lat"\/"lon"/],
    ['a fractional cell_index', { ...VALID, cell_index: 1.5 }, /"cell_index"/],
    ['a negative cell_index', { ...VALID, cell_index: -1 }, /"cell_index"/],
    ['a foreign source', { ...VALID, source: 'community' }, /expected "osm"/],
  ])('rejects %s, naming the offending entry', (_label, entry, pattern) => {
    expect(() => parseBarsFile([VALID, entry], 'bars.json')).toThrow(pattern);
  });

  // The index in the message is the index in the file, not in some filtered
  // subset — an operator opening bars.json has to be able to go straight to it.
  it('reports the index of the offending entry, not of the first entry', () => {
    expect(() => parseBarsFile([VALID, VALID, { ...VALID, name: '' }], 'bars.json')).toThrow(
      /entry 2 /,
    );
  });
});
