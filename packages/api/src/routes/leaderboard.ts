import {
  badgePeriodBoundaries,
  badgePeriodDays,
  badgePeriodKey,
  CONFIG,
} from '@tipsytrails/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/cookie.js';
import { loadActiveCity, type CityRow } from '../city-grid.js';
import {
  allTimeBarflyValuesByUser,
  badgesByUser,
  barflyValuesByUser,
  explorerValuesByUser,
  type MetricStanding,
} from '../badges.js';
import { sendCityNotFound, sendInvalidRequestQuery, sendUnauthenticated } from '../http/errors.js';
import { ANONYMOUS_AVATAR_SEED, anonymousDisplayName } from './anonymity.js';

// SPEC.md Section 7.8: the public leaderboard, ranked by area explored or
// bars mastered, over all-time/week/month. Value computation is not
// reimplemented here — `explorerValuesByUser`/`barflyValuesByUser`/
// `allTimeBarflyValuesByUser` (../badges.ts) are the exact same queries the
// badge job scores users against (Section 7.7), reused rather than
// duplicated so a user's leaderboard standing and their badges can never
// disagree on the same number.

const leaderboardQuerySchema = z.object({
  // "All-time by default" (Section 7.8) settles `period`; the metric default
  // is this implementation's own choice, following the order Section 7.8
  // lists the two metrics in ("area explored (%) and bars mastered").
  metric: z.enum(['area', 'bars']).default('area'),
  period: z.enum(['all', 'week', 'month']).default('all'),
  page: z.coerce.number().int().positive().default(1),
});

interface UserRow {
  id: number;
  username: string;
  avatar_seed: string;
  is_anonymous: number;
}

function loadAllUsers(db: Database.Database): UserRow[] {
  return db
    .prepare<[], UserRow>('SELECT id, username, avatar_seed, is_anonymous FROM users ORDER BY id')
    .all();
}

interface FogStateRow {
  user_id: number;
  revealed_cells: number;
  updated_at: number;
}

// SPEC.md Section 7.8: "All-time area comes from `fog_state.revealed_cells`"
// — distinct from the week/month figure, which sums `fog_daily_progress`
// (badges.ts's `explorerValuesByUser`); badges are never scored all-time, so
// there is nothing to reuse for this one. `fog_state.updated_at` is the last
// time this user's mask changed, i.e. the instant `revealed_cells` reached
// its current total — the Section 7.8 "earliest achievement" tie-break
// instant for this metric, the role `achieved_day` plays for a period.
function allTimeExplorerValuesByUser(
  db: Database.Database,
  cityId: number,
  playableCells: number,
): Map<number, MetricStanding> {
  const values = new Map<number, MetricStanding>();
  if (playableCells <= 0) {
    return values;
  }
  const rows = db
    .prepare<[number], FogStateRow>(
      'SELECT user_id, revealed_cells, updated_at FROM fog_state WHERE city_id = ?',
    )
    .all(cityId);
  for (const row of rows) {
    values.set(row.user_id, {
      value: (row.revealed_cells / playableCells) * 100,
      achievedAtS: row.updated_at,
    });
  }
  return values;
}

function loadMetricStandings(
  db: Database.Database,
  metric: 'area' | 'bars',
  period: 'all' | 'week' | 'month',
  city: CityRow | null,
  nowMs: number,
): Map<number, MetricStanding> {
  if (metric === 'bars') {
    if (period === 'all') {
      return allTimeBarflyValuesByUser(db);
    }
    const periodKey = badgePeriodKey(period, nowMs);
    const { startS, endS } = badgePeriodBoundaries(period, periodKey);
    return barflyValuesByUser(db, startS, endS);
  }

  if (!city) {
    return new Map();
  }
  if (period === 'all') {
    return allTimeExplorerValuesByUser(db, city.id, city.playable_cells);
  }
  const periodKey = badgePeriodKey(period, nowMs);
  return explorerValuesByUser(db, city.id, city.playable_cells, badgePeriodDays(period, periodKey));
}

interface Standing {
  user: UserRow;
  value: number;
  achievedAtS: number | null;
}

function buildStandings(users: UserRow[], metricMap: Map<number, MetricStanding>): Standing[] {
  return users.map((user) => {
    const standing = metricMap.get(user.id);
    return { user, value: standing?.value ?? 0, achievedAtS: standing?.achievedAtS ?? null };
  });
}

// SPEC.md Section 7.8: "Ties are broken by earliest achievement, then by
// `users.id`". Reading applied here (stated in the phase report): the
// "achievement instant" is when a user's value last changed to reach its
// current total — `fog_state.updated_at` for all-time area, the latest
// contributing day/completion for a period-scoped metric (both computed
// alongside `value` above so they can never drift apart from it). Two users
// who never registered any value for the metric (both 0, both `null`) fall
// straight through to the `users.id` tie-break, same as a real tie.
function compareStandings(a: Standing, b: Standing): number {
  if (a.value !== b.value) {
    return b.value - a.value;
  }
  const aAt = a.achievedAtS ?? Infinity;
  const bAt = b.achievedAtS ?? Infinity;
  if (aAt !== bAt) {
    return aAt - bAt;
  }
  return a.user.id - b.user.id;
}

export async function leaderboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/leaderboard', { preHandler: requireAuth }, async (request, reply) => {
    if (request.userId == null) {
      sendUnauthenticated(reply);
      return;
    }

    const parsed = leaderboardQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      sendInvalidRequestQuery(reply);
      return;
    }
    const { metric, period, page } = parsed.data;

    const db = request.server.db;
    const city = loadActiveCity(db);
    if (!city) {
      sendCityNotFound(reply);
      return;
    }

    const metricStandings = loadMetricStandings(db, metric, period, city, Date.now());
    const users = loadAllUsers(db);
    const sorted = buildStandings(users, metricStandings).sort(compareStandings);

    const pageSize = CONFIG.LEADERBOARD_PAGE_SIZE;
    const totalUsers = sorted.length;
    const totalPages = Math.max(1, Math.ceil(totalUsers / pageSize));
    const pageStart = (page - 1) * pageSize;
    const pageRows = sorted.slice(pageStart, pageStart + pageSize);

    const badgesByUserId = badgesByUser(
      db,
      pageRows.map((row) => row.user.id),
    );

    return {
      metric,
      period,
      page,
      pageSize,
      totalUsers,
      totalPages,
      entries: pageRows.map((standing, index) => {
        const anonymous = Boolean(standing.user.is_anonymous);
        return {
          rank: pageStart + index + 1,
          userId: standing.user.id,
          displayName: anonymous ? anonymousDisplayName(standing.user.id) : standing.user.username,
          isAnonymous: anonymous,
          avatarSeed: anonymous ? ANONYMOUS_AVATAR_SEED : standing.user.avatar_seed,
          value: standing.value,
          badges: badgesByUserId.get(standing.user.id) ?? [],
        };
      }),
    };
  });
}
