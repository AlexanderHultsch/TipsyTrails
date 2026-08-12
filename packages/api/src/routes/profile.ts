import type { BadgePeriod } from '@tipsytrails/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireAuth } from '../auth/cookie.js';
import { allTimeBarflyValuesByUser, badgesByUser, currentBadgeProgress } from '../badges.js';
import type { BadgeProgress } from '../badges.js';
import {
  ANONYMOUS_AVATAR_SEED,
  anonymousDisplayName,
  parsePlayerHandle,
  playerHandle,
} from './anonymity.js';

// SPEC.md Section 9.5, quoted exactly: "Accepts a username or a
// `player-{id}` handle. If the user is anonymous, the username form returns
// 404 and only the handle form resolves, masked." Section 8.3 lists the
// profile's content; the badge shelf and current-period progress are read
// from ../badges.ts rather than recomputed here, for the same
// never-disagree-with-the-badge-job reason routes/leaderboard.ts reuses it.

const PROFILE_BADGE_PERIODS: readonly BadgePeriod[] = ['week', 'month', 'year'];

function sendUnauthenticated(reply: FastifyReply): void {
  reply.code(401).send({ code: 'unauthenticated', message: 'Authentication required.' });
}

// Section 9.5: "Every 404 in this route must be byte-identical regardless
// of cause: unknown user, anonymous user addressed by username, malformed
// handle." One body, used for all three, the same way routes/bars.ts's
// `sendBarNotFound` is the one body for "does not exist" and "not
// discovered by you" (Section 7.4).
function sendProfileNotFound(reply: FastifyReply): void {
  reply.code(404).send({ code: 'profile_not_found', message: 'That profile does not exist.' });
}

interface CityRow {
  id: number;
  playable_cells: number;
}

function loadActiveCity(db: Database.Database): CityRow | null {
  return (
    db
      .prepare<[], CityRow>(`SELECT id, playable_cells FROM cities WHERE is_active = 1 LIMIT 1`)
      .get() ?? null
  );
}

interface UserRow {
  id: number;
  username: string;
  avatar_seed: string;
  is_anonymous: number;
}

// Resolves the `:handle` path param to a target user (SPEC.md Section 9.5).
// The `player-{id}` form resolves any existing user id, anonymous or not —
// a non-anonymous user's numeric handle also resolving is this
// implementation's own reading (stated in the phase report): Section 9.5
// only restricts the *username* form for an anonymous user, says nothing
// against the handle form working for a non-anonymous one, and the
// byte-identical 404 rule already makes an unknown/non-anonymous id
// indistinguishable from an anonymous one either way, so allowing it costs
// no security. A bare username resolves only a non-anonymous user, so an
// anonymous user is unreachable by their real username. Every failure
// returns null; the caller answers with the one shared 404 body regardless
// of which case it was — the class of oracle HANDOVER.md Section 7's
// reset-question decoy took three attempts to close.
function resolveProfileTarget(db: Database.Database, handle: string): UserRow | null {
  const handleUserId = parsePlayerHandle(handle);
  if (handleUserId !== null) {
    return (
      db
        .prepare<[number], UserRow>(
          'SELECT id, username, avatar_seed, is_anonymous FROM users WHERE id = ?',
        )
        .get(handleUserId) ?? null
    );
  }

  const row = db
    .prepare<[string], UserRow>(
      'SELECT id, username, avatar_seed, is_anonymous FROM users WHERE username = ?',
    )
    .get(handle);
  if (!row || row.is_anonymous) {
    return null;
  }
  return row;
}

export async function profileRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/profile/:handle', { preHandler: requireAuth }, async (request, reply) => {
    if (request.userId == null) {
      sendUnauthenticated(reply);
      return;
    }

    const { handle } = request.params as { handle: string };
    const db = request.server.db;

    const target = resolveProfileTarget(db, handle);
    if (!target) {
      sendProfileNotFound(reply);
      return;
    }

    const anonymous = Boolean(target.is_anonymous);

    // Section 7.6: "Area explored (city) = fog_state.revealed_cells /
    // cities.playable_cells * 100." A user with no fog_state row (never
    // moved, or the row's lazy creation — Section 5.5 — never triggered for
    // them) simply reads as 0%; viewing a profile must not create one.
    const city = loadActiveCity(db);
    const fogRow = city
      ? db
          .prepare<[number, number], { revealed_cells: number }>(
            'SELECT revealed_cells FROM fog_state WHERE user_id = ? AND city_id = ?',
          )
          .get(target.id, city.id)
      : undefined;
    const areaPercent =
      city && city.playable_cells > 0 && fogRow
        ? (fogRow.revealed_cells / city.playable_cells) * 100
        : 0;

    const barsMastered = allTimeBarflyValuesByUser(db).get(target.id)?.value ?? 0;

    const badges = badgesByUser(db, [target.id]).get(target.id) ?? [];

    const nowMs = Date.now();
    const badgeProgress = Object.fromEntries(
      PROFILE_BADGE_PERIODS.map((period) => [
        period,
        currentBadgeProgress(db, target.id, period, nowMs),
      ]),
    ) as Record<BadgePeriod, BadgeProgress[]>;

    return {
      userId: target.id,
      handle: playerHandle(target.id),
      displayName: anonymous ? anonymousDisplayName(target.id) : target.username,
      isAnonymous: anonymous,
      avatarSeed: anonymous ? ANONYMOUS_AVATAR_SEED : target.avatar_seed,
      areaPercent,
      barsMastered,
      badges,
      badgeProgress,
    };
  });
}
