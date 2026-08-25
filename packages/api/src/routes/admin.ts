import { compareBarsByName } from '@tipsytrails/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../auth/cookie.js';
import {
  loadActiveCity,
  loadCityById,
  resolveCellAndDistrict,
  toGridParams,
} from '../city-grid.js';
import {
  sendBarNotFound,
  sendCityNotFound,
  sendGridUnavailable,
  sendInvalidRequestBody,
  sendOutsideCity,
  sendUnauthenticated,
} from '../http/errors.js';
import type { BarSource, BarStatus } from './bars.js';

// SPEC.md Section 9.3, Phase 7 step 2: the admin area. Every route here sits
// behind requireAdmin (auth/cookie.ts) — a logged-in non-admin gets 403, an
// unauthenticated caller gets 401 from requireAdmin itself. Bar creation and
// the move-a-bar recompute reuse city-grid.ts's resolveCellAndDistrict,
// the same computation routes/bars.ts's suggest handler uses, rather than a
// third copy of it.

interface BarRow {
  id: number;
  city_id: number;
  district_id: number | null;
  name: string;
  address: string | null;
  lat: number;
  lon: number;
  cell_index: number;
  source: BarSource;
  osm_id: string | null;
  submitted_by: number | null;
  status: BarStatus;
  created_at: number;
}

interface AdminBarSummary {
  id: number;
  cityId: number;
  districtId: number | null;
  name: string;
  address: string | null;
  lat: number;
  lon: number;
  source: BarSource;
  submittedBy: number | null;
  status: BarStatus;
  createdAt: number;
}

function toAdminBarSummary(row: BarRow): AdminBarSummary {
  return {
    id: row.id,
    cityId: row.city_id,
    districtId: row.district_id,
    name: row.name,
    address: row.address,
    lat: row.lat,
    lon: row.lon,
    source: row.source,
    submittedBy: row.submitted_by,
    status: row.status,
    createdAt: row.created_at,
  };
}

// SPEC.md Section 9.3, Phase 7 task brief: "user list with stats". Kept
// cheap — one query, no per-user round trip — and deliberately excludes
// password_hash and security_answer_hash (never sent to any client). The
// username is the real one, not the anonymous handle: Section 7.8's
// anonymity is a display choice for other players, not a shield from the
// admin who already moderates their submissions.
interface AdminUserRow {
  id: number;
  username: string;
  is_admin: number;
  is_anonymous: number;
  must_change_password: number;
  created_at: number;
  last_seen_at: number | null;
  revealed_cells: number;
  bars_mastered: number;
  badge_count: number;
}

interface AdminUserSummary {
  id: number;
  username: string;
  isAdmin: boolean;
  isAnonymous: boolean;
  mustChangePassword: boolean;
  createdAt: number;
  lastSeenAt: number | null;
  areaRevealedCells: number;
  areaPercent: number;
  barsMastered: number;
  badgeCount: number;
}

function toAdminUserSummary(row: AdminUserRow, playableCells: number): AdminUserSummary {
  return {
    id: row.id,
    username: row.username,
    isAdmin: Boolean(row.is_admin),
    isAnonymous: Boolean(row.is_anonymous),
    mustChangePassword: Boolean(row.must_change_password),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    areaRevealedCells: row.revealed_cells,
    areaPercent: playableCells > 0 ? (row.revealed_cells / playableCells) * 100 : 0,
    barsMastered: row.bars_mastered,
    badgeCount: row.badge_count,
  };
}

const listBarsQuerySchema = z.object({
  source: z.string().trim().min(1).optional(),
});

const createBarSchema = z.object({
  name: z.string().trim().min(1),
  address: z.string().trim().min(1).nullable(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});

const patchBarSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    address: z.string().trim().min(1).nullable().optional(),
    lat: z.number().min(-90).max(90).optional(),
    lon: z.number().min(-180).max(180).optional(),
    status: z.enum(['active', 'hidden']).optional(),
  })
  .refine((data) => (data.lat === undefined) === (data.lon === undefined), {
    message: 'lat and lon must be provided together',
  });

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/bars', { preHandler: requireAdmin }, async (request, reply) => {
    if (request.userId == null) {
      sendUnauthenticated(reply);
      return;
    }

    const parsed = listBarsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      sendInvalidRequestBody(reply);
      return;
    }

    const db = request.server.db;
    const rows = parsed.data.source
      ? db
          .prepare<[string], BarRow>('SELECT * FROM bars WHERE source = ? ORDER BY id')
          .all(parsed.data.source)
      : db.prepare<[], BarRow>('SELECT * FROM bars ORDER BY id').all();

    // SPEC.md Section 9.3: the list is ordered by name. The ordering is
    // applied here rather than in SQL, and once rather than per query path,
    // for the reasons `compareBarsByName` (packages/shared/src/bars.ts)
    // states: SQLite's NOCASE collation would file every umlaut after Z, and
    // two sort sites are two things that can drift apart. The queries keep
    // `ORDER BY id` only so the rows reaching the sort are in a defined
    // order; the comparator's own tie-break, not that clause, is what makes
    // same-named bars come back the same way every time.
    return { bars: rows.map(toAdminBarSummary).sort(compareBarsByName) };
  });

  // SPEC.md Section 9.3: created with source='admin', active immediately,
  // submitted_by set to the creating admin — the same convention
  // routes/bars.ts's suggest handler uses for community submissions.
  app.post('/api/admin/bars', { preHandler: requireAdmin }, async (request, reply) => {
    if (request.userId == null) {
      sendUnauthenticated(reply);
      return;
    }

    const parsed = createBarSchema.safeParse(request.body);
    if (!parsed.success) {
      sendInvalidRequestBody(reply);
      return;
    }
    const { name, address, lat, lon } = parsed.data;

    const db = request.server.db;
    const city = loadActiveCity(db);
    if (!city) {
      sendCityNotFound(reply);
      return;
    }

    const grid = toGridParams(city);
    const cellResult = resolveCellAndDistrict(
      grid,
      request.server.grid,
      request.server.districtIdByGridIndex,
      lat,
      lon,
    );
    if (cellResult.status === 'outside_city') {
      sendOutsideCity(reply);
      return;
    }
    if (cellResult.status === 'grid_unavailable') {
      sendGridUnavailable(reply);
      return;
    }

    const nowS = Math.floor(Date.now() / 1000);
    const result = db
      .prepare(
        `INSERT INTO bars
           (city_id, district_id, name, address, lat, lon, cell_index, source, submitted_by, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'admin', ?, 'active', ?)`,
      )
      .run(
        city.id,
        cellResult.districtId,
        name,
        address,
        lat,
        lon,
        cellResult.cellIndex,
        request.userId,
        nowS,
      );

    const barId = Number(result.lastInsertRowid);
    const row = db.prepare<[number], BarRow>('SELECT * FROM bars WHERE id = ?').get(barId);
    if (!row) {
      throw new Error('bar row missing immediately after insert');
    }

    reply.code(201);
    return toAdminBarSummary(row);
  });

  // SPEC.md Section 9.3: "Editing a bar's position recomputes cell_index and
  // district_id. Existing discoveries are not revoked." — this handler never
  // touches bar_discoveries, so the second half holds by construction.
  app.patch('/api/admin/bars/:id', { preHandler: requireAdmin }, async (request, reply) => {
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

    const parsed = patchBarSchema.safeParse(request.body);
    if (!parsed.success) {
      sendInvalidRequestBody(reply);
      return;
    }

    const db = request.server.db;
    const existing = db.prepare<[number], BarRow>('SELECT * FROM bars WHERE id = ?').get(barId);
    if (!existing) {
      sendBarNotFound(reply);
      return;
    }

    const { name, address, lat, lon, status } = parsed.data;

    let cellIndex = existing.cell_index;
    let districtId = existing.district_id;

    if (lat !== undefined && lon !== undefined) {
      const city = loadCityById(db, existing.city_id);
      if (!city) {
        sendCityNotFound(reply);
        return;
      }
      const grid = toGridParams(city);
      const cellResult = resolveCellAndDistrict(
        grid,
        request.server.grid,
        request.server.districtIdByGridIndex,
        lat,
        lon,
      );
      if (cellResult.status === 'outside_city') {
        sendOutsideCity(reply);
        return;
      }
      if (cellResult.status === 'grid_unavailable') {
        sendGridUnavailable(reply);
        return;
      }
      cellIndex = cellResult.cellIndex;
      districtId = cellResult.districtId;
    }

    const newName = name ?? existing.name;
    // `address` distinguishes "omitted" (undefined, keep as-is) from
    // "explicitly cleared" (null) the same way patchBarSchema's `.nullable()`
    // preserves that distinction from the request body.
    const newAddress = address !== undefined ? address : existing.address;
    const newLat = lat ?? existing.lat;
    const newLon = lon ?? existing.lon;
    const newStatus = status ?? existing.status;

    db.prepare(
      `UPDATE bars SET name = ?, address = ?, lat = ?, lon = ?, cell_index = ?, district_id = ?, status = ?
       WHERE id = ?`,
    ).run(newName, newAddress, newLat, newLon, cellIndex, districtId, newStatus, barId);

    const row = db.prepare<[number], BarRow>('SELECT * FROM bars WHERE id = ?').get(barId);
    if (!row) {
      throw new Error('bar row missing immediately after update');
    }
    return toAdminBarSummary(row);
  });

  // SPEC.md Section 9.3: "Delete (cascades discoveries and visits)." The
  // cascade itself is the schema's ON DELETE CASCADE on bar_discoveries.bar_id
  // and visits.bar_id (migrations/001_init.sql), enforced at runtime by
  // `foreign_keys = ON` (db/index.ts) — this handler only issues the delete.
  app.delete('/api/admin/bars/:id', { preHandler: requireAdmin }, async (request, reply) => {
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

    const db = request.server.db;
    const existing = db
      .prepare<[number], { id: number }>('SELECT id FROM bars WHERE id = ?')
      .get(barId);
    if (!existing) {
      sendBarNotFound(reply);
      return;
    }

    db.prepare('DELETE FROM bars WHERE id = ?').run(barId);
    return { ok: true };
  });

  app.get('/api/admin/users', { preHandler: requireAdmin }, async (request, reply) => {
    if (request.userId == null) {
      sendUnauthenticated(reply);
      return;
    }

    const db = request.server.db;
    const city = loadActiveCity(db);
    const cityId = city ? city.id : null;
    const playableCells = city ? city.playable_cells : 0;

    const rows = db
      .prepare<[number | null], AdminUserRow>(
        `SELECT
           users.id AS id,
           users.username AS username,
           users.is_admin AS is_admin,
           users.is_anonymous AS is_anonymous,
           users.must_change_password AS must_change_password,
           users.created_at AS created_at,
           users.last_seen_at AS last_seen_at,
           COALESCE(fog_state.revealed_cells, 0) AS revealed_cells,
           COALESCE(mastered.bars_mastered, 0) AS bars_mastered,
           COALESCE(badge_counts.badge_count, 0) AS badge_count
         FROM users
         LEFT JOIN fog_state ON fog_state.user_id = users.id AND fog_state.city_id = ?
         LEFT JOIN (
           SELECT user_id, COUNT(DISTINCT bar_id) AS bars_mastered
           FROM visits WHERE status = 'completed' GROUP BY user_id
         ) mastered ON mastered.user_id = users.id
         LEFT JOIN (
           SELECT user_id, COUNT(*) AS badge_count FROM badges GROUP BY user_id
         ) badge_counts ON badge_counts.user_id = users.id
         ORDER BY users.id`,
      )
      .all(cityId);

    return { users: rows.map((row) => toAdminUserSummary(row, playableCells)) };
  });
}
