import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/cookie.js';
import { sendCityNotFound } from '../http/errors.js';

interface CityRow {
  slug: string;
  name: string;
  origin_lat: number;
  origin_lon: number;
  grid_width: number;
  grid_height: number;
  cell_size_m: number;
  playable_cells: number;
}

interface DistrictRow {
  id: number;
  name: string;
  playable_cells: number;
}

// SPEC.md Section 9.2: active city metadata + grid parameters, what the web
// client uses to project coordinates (Section 6.1) and show progress
// denominators (Section 6.3) instead of the hard-coded slug it holds today.
export async function cityRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/city', { preHandler: requireAuth }, async (request, reply) => {
    const city = request.server.db
      .prepare<[], CityRow>(
        `SELECT slug, name, origin_lat, origin_lon, grid_width, grid_height, cell_size_m, playable_cells
         FROM cities WHERE is_active = 1
         LIMIT 1`,
      )
      .get();

    if (!city) {
      sendCityNotFound(reply);
      return;
    }

    const districts = request.server.db
      .prepare<[string], DistrictRow>(
        `SELECT districts.id, districts.name, districts.playable_cells
         FROM districts
         JOIN cities ON cities.id = districts.city_id
         WHERE cities.slug = ?
         ORDER BY districts.id`,
      )
      .all(city.slug);

    return {
      slug: city.slug,
      name: city.name,
      originLat: city.origin_lat,
      originLon: city.origin_lon,
      gridWidth: city.grid_width,
      gridHeight: city.grid_height,
      cellSizeM: city.cell_size_m,
      playableCells: city.playable_cells,
      districts: districts.map((district) => ({
        id: district.id,
        name: district.name,
        playableCells: district.playable_cells,
      })),
    };
  });
}
