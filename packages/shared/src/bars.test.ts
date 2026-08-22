import { describe, expect, it } from 'vitest';
import type { CityConfig } from './city.js';
import { toCell } from './grid.js';
import {
  buildBarsQuery,
  diffBars,
  gridParamsFromCityConfig,
  osmElementsToBars,
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
