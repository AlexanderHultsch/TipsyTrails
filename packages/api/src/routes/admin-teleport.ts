import { toCell } from '@tipsytrails/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../auth/cookie.js';
import { loadActiveCity, toGridParams } from '../city-grid.js';
import {
  sendCityNotFound,
  sendGridUnavailable,
  sendInvalidRequestBody,
  sendOutsideCity,
  sendUnauthenticated,
} from '../http/errors.js';
import type { AcceptedPosition } from '../last-accepted.js';
import { isExcludedFromRankings } from '../rankings.js';
import { processSampleBatch } from './fog.js';

// SPEC.md Sections 9.3 and 10.1: `POST /api/admin/teleport`. Moves the
// calling admin's own position to a chosen point and runs everything an
// ordinary sample runs — fog reveal, bar discovery, visit progress — with
// Section 7.2's teleport guard and Section 7.3's reveal-speed gate off, so
// the owner can exercise the game without walking Karlsruhe.
//
// ════════════════════════════════════════════════════════════════════
// Why this is a route of its own, and not a flag on POST /api/samples
// ════════════════════════════════════════════════════════════════════
//
// This repository is public (Section 13.4), so the design has to survive
// being read by whoever wants to cheat.
//
// Start from what is already true: positions are client-asserted. Anyone
// with a session cookie can already claim to be anywhere, and no web
// application can prove otherwise. What this feature must not do is lower
// that friction for everyone else, or weaken the guards on the path the
// public uses. So there is no `{ teleport: true }`, no `skipGuards`, and no
// header on `POST /api/samples`: a check the request can switch off is not
// a check, because the check then depends on the caller. The bypass is a
// property of THIS route, and the server decides it from the session.
// `routes/fog.ts` passes `skipSpeedGuards: false` as a literal, and this
// module is the only place in the codebase that passes `true`.
//
// Four gates hold independently, and none of them is the client:
//
//  1. `requireAdmin` — the same preHandler every other `/api/admin/*` route
//     uses. A signed-in non-admin gets 403, an anonymous caller 401.
//  2. The environment variable `ADMIN_TELEPORT_ENABLED`. When it is not
//     `true`, app.ts never registers this plugin, so the path does not
//     exist: a 404, not a 403. The code ships inert, and a stolen admin
//     session on a production box reaches nothing here.
//  3. The calling account must already be excluded from the rankings
//     (Section 7.8, `users.excluded_from_rankings`). This is the gate that
//     makes the feature safe rather than merely gated: teleport is refused
//     for every account still in the competition, so no amount of
//     teleporting can ever produce a leaderboard place or a badge. It is
//     checked before the body is even parsed — nothing at all happens for an
//     account that still counts.
//  4. All of the above is server-side. The admin screen hides the panel
//     when it gets a 404 from here, and that is a convenience and not a
//     control; every one of these tests runs again on every request whatever
//     the browser believes.
//
// What is deliberately NOT bypassed: the active city's bounding box
// (Section 5.1). Teleporting outside Karlsruhe tests nothing — there is no
// fog grid, no cells and no districts out there — so the position is
// rejected rather than silently ignored, following the same reading
// http/errors.ts records for the other routes that accept a position from a
// person: a submission is a write the caller must be told about.

const teleportSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});

// Gate 3's refusal. 422 rather than 403, and the distinction is real: the
// caller has the authority (gate 1 already said so) and the request is
// well-formed; the server's own state is what forbids it. That is the same
// shape routes/visits.ts's `no_recent_sample` and `not_onsite` have, and
// http/errors.ts's `outside_city`. It is not in http/errors.ts because only
// this module ever sends it, the rule that file states for
// `sendVisitNotFound` and `sendForbidden`.
//
// The message names the reason and the fix, because the admin reading it is
// the person who can apply the fix and the alternative is a dead button.
function sendNotExcludedFromRankings(reply: FastifyReply): void {
  reply.code(422).send({
    code: 'not_excluded_from_rankings',
    message:
      'Teleport is refused for an account that still counts in the rankings. ' +
      'Exclude this account from the leaderboard and badges first, in Admin → Users.',
  });
}

export function adminTeleportRoutes(lastAccepted: Map<number, AcceptedPosition>) {
  return async function adminTeleportRoutesPlugin(app: FastifyInstance): Promise<void> {
    // No rate limiter, matching every other admin route: Section 9.4 records
    // that the admin surface deliberately carries none, `RATE_LIMITS` names
    // none for it, and inventing one here would be a constant at a call site
    // (CLAUDE.md).
    app.post('/api/admin/teleport', { preHandler: requireAdmin }, async (request, reply) => {
      if (request.userId == null) {
        sendUnauthenticated(reply);
        return;
      }
      const userId = request.userId;
      const db = request.server.db;

      // Gate 3, first — before the body is parsed, so an account still in
      // the competition cannot reach a single line that reads what it sent.
      if (!isExcludedFromRankings(db, userId)) {
        sendNotExcludedFromRankings(reply);
        return;
      }

      const parsed = teleportSchema.safeParse(request.body);
      if (!parsed.success) {
        sendInvalidRequestBody(reply);
        return;
      }
      const { lat, lon } = parsed.data;

      const city = loadActiveCity(db);
      if (!city) {
        sendCityNotFound(reply);
        return;
      }
      if (!request.server.grid || !request.server.districtIdByGridIndex) {
        sendGridUnavailable(reply);
        return;
      }

      // Section 5.1's bounding box, checked here as well as inside the
      // pipeline. The pipeline skips an out-of-box sample silently, which is
      // right for a batch of GPS readings and wrong for a person who tapped
      // a map: they would get a 200 saying nothing happened. This turns it
      // into the same 422 the admin bar create/move handlers send for the
      // same reason. The pipeline's own check stays as the second line.
      if (toCell(lat, lon, toGridParams(city)) === null) {
        sendOutsideCity(reply);
        return;
      }

      const nowMs = Date.now();

      // The synthetic sample. Every field is the server's, and the request
      // contributed exactly two numbers — which is the point: a teleport is
      // the server asserting a position on the admin's behalf, not the admin
      // handing over a sample with the checks pre-answered.
      //
      // `accuracy: 0` is not a tuning constant and so is not in config.ts
      // (CLAUDE.md's rule is about rate limits, radii, thresholds,
      // tolerances and timeouts): a synthesised position has no measurement
      // error to declare. It is also the strictest choice available, since
      // `onsiteRadiusM` widens the check-in radius with reported accuracy —
      // a teleport buys the tightest radius, never a generous one.
      //
      // `speed: null` says the same thing: nothing here was measured moving.
      // With `skipSpeedGuards` on, neither the sample's speed nor the one
      // derived from the previous position can refuse the reveal, so the
      // teleported point reveals fog the way standing there would.
      //
      // `timestamp: nowMs` puts the sample at the instant of the request, so
      // the clock-skew and staleness gates (which are NOT bypassed) pass on
      // their own terms rather than by exception.
      const result = processSampleBatch({
        db,
        userId,
        city,
        districtGrid: request.server.grid,
        districtIdByGridIndex: request.server.districtIdByGridIndex,
        lastAccepted,
        samples: [{ lat, lon, accuracy: 0, speed: null, timestamp: nowMs }],
        nowMs,
        skipSpeedGuards: true,
      });

      // The same body `POST /api/samples` answers with, deliberately: the
      // admin screen renders what happened using the same fields the map
      // already understands, and a second response shape would be a second
      // thing to keep in step with Section 9.6.
      //
      // `lastAccepted` now holds this point at this instant — written by the
      // pipeline itself, not by anything here. See its comment for why that
      // is the only workable answer: a stale entry would make the admin's
      // next genuine sample look like a 300 km/h jump and be refused, and an
      // empty one would break check-in.
      return result;
    });
  };
}
