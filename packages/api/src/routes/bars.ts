import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireAuth } from '../auth/cookie.js';

// SPEC.md Sections 5.7, 7.4, 9.2, 9.5: `GET /api/bars` and `GET /api/bars/:id`
// answer only from bars the requesting user has discovered — every query in
// this file joins through `bar_discoveries` filtered by `user_id`, so a bar
// that row does not cover cannot appear in a response no matter what its id
// or position is. `toBarSummary` (also used by `routes/fog.ts` for the
// `newBars` field of `POST /api/samples`) is the one place a `bars` row
// becomes client-facing JSON, so the two surfaces can never drift apart on
// what a "discovered bar" looks like.

export interface DiscoveredBarRow {
  id: number;
  district_id: number | null;
  name: string;
  address: string | null;
  lat: number;
  lon: number;
  source: string;
  discovered_at: number;
}

export interface BarSummary {
  id: number;
  districtId: number | null;
  name: string;
  address: string | null;
  lat: number;
  lon: number;
  source: string;
  discoveredAt: number;
}

export function toBarSummary(row: DiscoveredBarRow): BarSummary {
  return {
    id: row.id,
    districtId: row.district_id,
    name: row.name,
    address: row.address,
    lat: row.lat,
    lon: row.lon,
    source: row.source,
    discoveredAt: row.discovered_at,
  };
}

// SPEC.md Section 9.5: identical for "does not exist" and "not discovered by
// you" — a 403 would confirm existence and defeat Section 7.4.
function sendBarNotFound(reply: FastifyReply): void {
  reply.code(404).send({ code: 'bar_not_found', message: 'That bar does not exist.' });
}

function sendUnauthenticated(reply: FastifyReply): void {
  reply.code(401).send({ code: 'unauthenticated', message: 'Authentication required.' });
}

const DISCOVERED_BAR_COLUMNS = `bars.id AS id, bars.district_id AS district_id, bars.name AS name,
  bars.address AS address, bars.lat AS lat, bars.lon AS lon, bars.source AS source,
  bar_discoveries.discovered_at AS discovered_at`;

export async function barsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/bars', { preHandler: requireAuth }, async (request, reply) => {
    if (request.userId == null) {
      sendUnauthenticated(reply);
      return;
    }

    const rows = request.server.db
      .prepare<[number], DiscoveredBarRow>(
        `SELECT ${DISCOVERED_BAR_COLUMNS}
         FROM bar_discoveries
         JOIN bars ON bars.id = bar_discoveries.bar_id
         WHERE bar_discoveries.user_id = ?
         ORDER BY bar_discoveries.discovered_at, bars.id`,
      )
      .all(request.userId);

    return { bars: rows.map(toBarSummary) };
  });

  app.get('/api/bars/:id', { preHandler: requireAuth }, async (request, reply) => {
    if (request.userId == null) {
      sendUnauthenticated(reply);
      return;
    }

    const { id } = request.params as { id: string };
    const barId = Number(id);
    if (!Number.isInteger(barId)) {
      sendBarNotFound(reply);
      return;
    }

    const row = request.server.db
      .prepare<[number, number], DiscoveredBarRow>(
        `SELECT ${DISCOVERED_BAR_COLUMNS}
         FROM bar_discoveries
         JOIN bars ON bars.id = bar_discoveries.bar_id
         WHERE bar_discoveries.user_id = ? AND bars.id = ?`,
      )
      .get(request.userId, barId);

    if (!row) {
      sendBarNotFound(reply);
      return;
    }

    return toBarSummary(row);
  });
}
