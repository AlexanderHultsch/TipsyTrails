import { describe, expect, it } from 'vitest';
import type { CityConfig } from './city.js';
import {
  buildCityAndDistrictsQuery,
  buildNeighboursQuery,
  findCityRelation,
  findDistrictRelations,
  findNeighbourRelations,
  parseOverpassPayload,
  relationToFeature,
  relationToGeometry,
  type OverpassRelation,
  type OverpassResponse,
} from './overpass.js';

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

// A deliberately different synthetic config: different admin levels, a
// different name, no regional key. Used to prove the query builders are
// parameterised rather than accidentally matching on Karlsruhe strings.
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
    // no regional_key_prefix
  },
};

describe('buildCityAndDistrictsQuery', () => {
  it('embeds the city admin levels, district admin levels, name and regional key prefix', () => {
    const query = buildCityAndDistrictsQuery(KARLSRUHE_CONFIG);
    expect(query).toContain('admin_level"~"^(6|8)$"');
    expect(query).toContain('admin_level"~"^(9|10)$"');
    expect(query).toContain('"name"="Karlsruhe"');
    expect(query).toContain('de:regionalschluessel"~"^08212"');
  });

  it('changes output when fed a different config, proving parameterisation', () => {
    const karlsruheQuery = buildCityAndDistrictsQuery(KARLSRUHE_CONFIG);
    const otherQuery = buildCityAndDistrictsQuery(OTHER_CONFIG);

    expect(otherQuery).not.toEqual(karlsruheQuery);
    expect(otherQuery).toContain('admin_level"~"^(7)$"');
    expect(otherQuery).toContain('admin_level"~"^(11)$"');
    expect(otherQuery).toContain('"name"="Testburg"');
    expect(otherQuery).not.toContain('regionalschluessel');
    expect(otherQuery).not.toContain('Karlsruhe');
  });

  it('is a pure function of the config alone (no network, no side effects)', () => {
    expect(buildCityAndDistrictsQuery(KARLSRUHE_CONFIG)).toEqual(
      buildCityAndDistrictsQuery(KARLSRUHE_CONFIG),
    );
  });
});

describe('buildNeighboursQuery', () => {
  it('embeds the city admin levels, name, regional key prefix and bounding box', () => {
    const query = buildNeighboursQuery(KARLSRUHE_CONFIG);
    expect(query).toContain('admin_level"~"^(6|8)$"');
    expect(query).toContain('"name"="Karlsruhe"');
    expect(query).toContain('de:regionalschluessel"~"^08212"');
    expect(query).toContain('(48.94,8.275,49.095,8.56)');
    expect(query).toContain('- .city');
  });

  it('changes output when fed a different config', () => {
    const karlsruheQuery = buildNeighboursQuery(KARLSRUHE_CONFIG);
    const otherQuery = buildNeighboursQuery(OTHER_CONFIG);

    expect(otherQuery).not.toEqual(karlsruheQuery);
    expect(otherQuery).toContain('admin_level"~"^(7)$"');
    expect(otherQuery).toContain('"name"="Testburg"');
    expect(otherQuery).toContain('(1,2,3,4)');
    expect(otherQuery).not.toContain('regionalschluessel');
  });
});

describe('parseOverpassPayload', () => {
  it('rejects an HTML error page even when the content type is missing', () => {
    const html = '<!DOCTYPE html><html><body>Too many requests</body></html>';
    expect(() => parseOverpassPayload(html, undefined)).toThrow(/HTML/);
  });

  it('rejects a JSON content type response whose body is still HTML', () => {
    const html = '<html><body>Rate limited</body></html>';
    expect(() => parseOverpassPayload(html, 'text/html; charset=utf-8')).toThrow(/HTML/);
  });

  it('rejects a body that is not valid JSON', () => {
    expect(() => parseOverpassPayload('not json at all', 'application/json')).toThrow(/JSON/);
  });

  it('rejects valid JSON that is missing an elements array', () => {
    expect(() =>
      parseOverpassPayload(JSON.stringify({ version: 0.6 }), 'application/json'),
    ).toThrow(/elements/);
  });

  it('rejects an empty elements array', () => {
    expect(() =>
      parseOverpassPayload(JSON.stringify({ version: 0.6, elements: [] }), 'application/json'),
    ).toThrow(/zero elements/);
  });

  it('accepts a well-formed Overpass response', () => {
    const payload = JSON.stringify({
      version: 0.6,
      elements: [{ type: 'relation', id: 1, members: [] }],
    });
    expect(parseOverpassPayload(payload, 'application/json').elements).toHaveLength(1);
  });
});

function relation(
  id: number,
  tags: Record<string, string>,
  members: OverpassRelation['members'] = [],
): OverpassRelation {
  return { type: 'relation', id, tags, members };
}

describe('findCityRelation', () => {
  it('rejects a payload with no matching city relation, naming what was expected', () => {
    const response: OverpassResponse = {
      elements: [
        relation(1, { boundary: 'administrative', name: 'SomewhereElse', admin_level: '8' }),
      ],
    };
    expect(() => findCityRelation(response, KARLSRUHE_CONFIG)).toThrow(/Karlsruhe/);
  });

  it('rejects more than one candidate relation', () => {
    const response: OverpassResponse = {
      elements: [
        relation(1, { boundary: 'administrative', name: 'Karlsruhe', admin_level: '6' }),
        relation(2, { boundary: 'administrative', name: 'Karlsruhe', admin_level: '8' }),
      ],
    };
    expect(() => findCityRelation(response, KARLSRUHE_CONFIG)).toThrow(/found 2/);
  });

  it('finds the single matching city relation', () => {
    const response: OverpassResponse = {
      elements: [relation(42, { boundary: 'administrative', name: 'Karlsruhe', admin_level: '6' })],
    };
    expect(findCityRelation(response, KARLSRUHE_CONFIG).id).toBe(42);
  });
});

describe('findDistrictRelations and findNeighbourRelations', () => {
  const response: OverpassResponse = {
    elements: [
      relation(1, { boundary: 'administrative', name: 'Karlsruhe', admin_level: '6' }),
      relation(2, { boundary: 'administrative', name: 'Durlach', admin_level: '9' }),
      relation(3, { boundary: 'administrative', name: 'Weingarten', admin_level: '8' }),
    ],
  };

  it('finds district relations by admin level, excluding the city', () => {
    const districts = findDistrictRelations(response, KARLSRUHE_CONFIG, 1);
    expect(districts.map((d) => d.id)).toEqual([2]);
  });

  it('finds neighbour relations, excluding the city by id', () => {
    const neighbours = findNeighbourRelations(response, 1);
    expect(neighbours.map((n) => n.id).sort()).toEqual([2, 3]);
  });
});

describe('relationToGeometry', () => {
  it('produces a closed ring for a relation with a single outer way', () => {
    const rel = relation(1, { boundary: 'administrative', name: 'Simple', admin_level: '8' }, [
      {
        type: 'way',
        ref: 100,
        role: 'outer',
        geometry: [
          { lat: 49.0, lon: 8.4 },
          { lat: 49.0, lon: 8.5 },
          { lat: 49.1, lon: 8.5 },
          { lat: 49.1, lon: 8.4 },
          { lat: 49.0, lon: 8.4 },
        ],
      },
    ]);

    const geometry = relationToGeometry(rel);
    expect(geometry.type).toBe('Polygon');
    const ring = (geometry as { coordinates: [number, number][][] }).coordinates[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(ring.length).toBeGreaterThanOrEqual(4);
  });

  it('assembles two outer way segments sharing endpoints into one closed ring', () => {
    const rel = relation(2, { boundary: 'administrative', name: 'TwoWays', admin_level: '8' }, [
      {
        type: 'way',
        ref: 200,
        role: 'outer',
        geometry: [
          { lat: 49.0, lon: 8.4 },
          { lat: 49.0, lon: 8.5 },
          { lat: 49.1, lon: 8.5 },
        ],
      },
      {
        type: 'way',
        ref: 201,
        role: 'outer',
        geometry: [
          { lat: 49.1, lon: 8.5 },
          { lat: 49.1, lon: 8.4 },
          { lat: 49.0, lon: 8.4 },
        ],
      },
    ]);

    const geometry = relationToGeometry(rel);
    expect(geometry.type).toBe('Polygon');
    const ring = (geometry as { coordinates: [number, number][][] }).coordinates[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  it('keeps an inner way as a hole, both rings closed', () => {
    const rel = relation(3, { boundary: 'administrative', name: 'WithHole', admin_level: '8' }, [
      {
        type: 'way',
        ref: 300,
        role: 'outer',
        geometry: [
          { lat: 49.0, lon: 8.4 },
          { lat: 49.0, lon: 8.6 },
          { lat: 49.2, lon: 8.6 },
          { lat: 49.2, lon: 8.4 },
          { lat: 49.0, lon: 8.4 },
        ],
      },
      {
        type: 'way',
        ref: 301,
        role: 'inner',
        geometry: [
          { lat: 49.05, lon: 8.45 },
          { lat: 49.05, lon: 8.5 },
          { lat: 49.1, lon: 8.5 },
          { lat: 49.1, lon: 8.45 },
          { lat: 49.05, lon: 8.45 },
        ],
      },
    ]);

    const geometry = relationToGeometry(rel);
    expect(geometry.type).toBe('Polygon');
    const rings = (geometry as { coordinates: [number, number][][] }).coordinates;
    expect(rings).toHaveLength(2);
    for (const ring of rings) {
      expect(ring[0]).toEqual(ring[ring.length - 1]);
    }
  });

  it('throws for a relation with no outer way members', () => {
    const rel = relation(4, { boundary: 'administrative', name: 'Empty', admin_level: '8' }, []);
    expect(() => relationToGeometry(rel)).toThrow(/outer/);
  });
});

describe('relationToFeature', () => {
  it('carries the district name and OSM id in properties', () => {
    const rel = relation(99, { boundary: 'administrative', name: 'Durlach', admin_level: '9' }, [
      {
        type: 'way',
        ref: 900,
        role: 'outer',
        geometry: [
          { lat: 49.0, lon: 8.4 },
          { lat: 49.0, lon: 8.5 },
          { lat: 49.1, lon: 8.5 },
          { lat: 49.0, lon: 8.4 },
        ],
      },
    ]);

    const feature = relationToFeature(rel);
    expect(feature.type).toBe('Feature');
    expect(feature.properties.osm_id).toBe(99);
    expect(feature.properties.name).toBe('Durlach');
  });
});
