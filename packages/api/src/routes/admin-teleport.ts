import { TELEPORT_FIX, toCell } from '@tipsytrails/shared';
import type { LatLon } from '@tipsytrails/shared';
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

// SPEC.md Sections 9.3 and 10.1: `/api/admin/teleport`. Moves the calling
// admin's own position to a chosen point and runs everything an ordinary
// sample runs — fog reveal, bar discovery, visit progress — with Section
// 7.2's teleport guard and Section 7.3's reveal-speed gate off, so the owner
// can exercise the game without walking Karlsruhe.
//
// ════════════════════════════════════════════════════════════════════
// Teleport is a MODE, and this route path is the whole of it
// ════════════════════════════════════════════════════════════════════
//
// The first version was a one-shot: it moved the server's idea of where the
// admin was and the browser never found out. The map marker, the nearby-bars
// panel and the check-in offer all went on reading real GPS, so fog cleared
// at the destination and the check-in flow — the thing the feature exists to
// test — could not be reached there from the UI at all. Worse, every real
// sample after a teleport was silently refused as a 300 km/h jump for as
// long as the phone was far from the destination.
//
// So the destination is remembered, and three operations share this one path:
//
//  - `POST` sets it: the synthetic sample below, plus the destination
//    recorded as this caller's teleported position.
//  - `GET` reads the caller's own teleported position, or null. The map
//    screen asks once on mount and, while an answer stands, stops watching
//    GPS and reports that point as the player's position instead.
//  - `DELETE` clears it, and drops this caller's `lastAccepted` entry with
//    it. See its own comment: that second half is what lets the returning
//    admin's first real fix be accepted.
//
// The state is a `Map<number, LatLon>` created in app.ts and passed in, IN
// MEMORY AND NEVER IN THE DATABASE. Constraint C4 and Section 10.2 forbid
// persisting a position, and Section 7.2 already pre-empts exactly this
// workaround for the neighbouring `lastAccepted` map — "an accepted
// degradation, not a bug to work around by persisting positions". A
// teleported point is a position; nothing carves out a synthetic one. What
// that buys is what the owner actually needs: the mode survives a page
// reload and a backgrounded phone, because it lives on the server rather
// than in a tab. What it costs is that it dies with the process, the same
// degradation `lastAccepted` has always carried (Section 9.3).
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
//
//     THIS ONE GUARDS THE `POST` AND NOTHING ELSE, and that asymmetry is
//     deliberate rather than an oversight. It exists to stop a ranked
//     account acquiring position it did not walk to; reading where the
//     server already thinks you are acquires nothing, and getting back to
//     reality least of all. Put it on the `DELETE` and an admin whose
//     exclusion flag was cleared while they were teleported could never
//     leave the mode — their app would be stuck asserting a position they
//     are not at, which is the one failure this feature must not have.
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

/**
 * The body `GET /api/admin/teleport` answers with (SPEC.md Section 9.6):
 * where the caller is currently teleported to, or `null` for "not
 * teleported". Deliberately an object with a nullable field rather than a
 * bare `null` body, so the client parses one shape either way.
 */
export interface TeleportStateResponse {
  position: LatLon | null;
}

export function adminTeleportRoutes(
  lastAccepted: Map<number, AcceptedPosition>,
  // The teleport mode itself: the point each teleported admin is currently
  // standing on as far as this server is concerned. Passed in from app.ts
  // exactly as `lastAccepted` is, and for the same reason — a Map created
  // here would be a fresh one per plugin registration, and one written to
  // disk would violate C4. See the header.
  teleported: Map<number, LatLon>,
) {
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
      // `TELEPORT_FIX` is the accuracy and speed of it — `{ accuracy: 0,
      // speed: null }`, in `@tipsytrails/shared` rather than here because
      // the web client synthesises the identical pair while the mode stands
      // (tracking/useSampleTracking.ts) and the two must not drift; that
      // module records why neither number belongs in config.ts. `accuracy:
      // 0` declares no measurement error and buys the tightest check-in
      // radius, never a generous one; `speed: null` says nothing here was
      // measured moving, and with `skipSpeedGuards` on neither it nor the
      // speed derived from the previous position can refuse the reveal, so
      // the teleported point reveals fog the way standing there would.
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
        samples: [{ lat, lon, ...TELEPORT_FIX, timestamp: nowMs }],
        nowMs,
        skipSpeedGuards: true,
      });

      // The mode, set last: only a teleport that actually ran the pipeline
      // becomes the position the client is told to stand on. Everything that
      // can refuse — the three gates above, a malformed body, a missing city
      // or grid, a point outside the bounding box — returned before this
      // line, so a refused request leaves the previous mode (or none)
      // exactly as it was rather than half-applying.
      //
      // A second teleport simply overwrites the first: the owner's
      // requirement is to stay put "until the admin teleports somewhere else
      // or presses the button to zoom back on the actual position", which is
      // this `set` and the `DELETE` below and nothing in between.
      teleported.set(userId, { lat, lon });

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
      //
      // Nothing about the mode is added to this body, and that is not an
      // omission: the caller already knows where it asked to be sent, the
      // `GET` below is what anyone else asks, and Section 9.6 pins this
      // shape as identical to `POST /api/samples`'s.
      return result;
    });

    // Read. The map screen calls this once on mount to find out whether it
    // should be watching GPS at all, so it answers the caller's OWN state
    // and nobody else's — `request.userId` is the only key it ever looks up.
    //
    // It is on this route and deliberately not on `GET /api/auth/me`, which
    // every player calls on every load: a field that is null for everyone
    // but the owner advertises the feature's existence to people who cannot
    // use it, and Section 10.1's second gate is about this code being
    // invisible on a box that never enabled it.
    //
    // `requireAdmin` is not decoration here. Without it this would answer
    // 200 `{ position: null }` for any signed-in account, which is a
    // confirmation that the route exists on this deployment — precisely what
    // gate 2's 404 withholds.
    //
    // No exclusion precondition, for the same reason the `DELETE` has none:
    // reading where the server already thinks you are acquires nothing.
    app.get('/api/admin/teleport', { preHandler: requireAdmin }, async (request, reply) => {
      if (request.userId == null) {
        sendUnauthenticated(reply);
        return;
      }
      const response: TeleportStateResponse = {
        position: teleported.get(request.userId) ?? null,
      };
      return response;
    });

    // Clear. Getting back to reality must never be refused, so this carries
    // gates 1, 2 and 4 and nothing else — no exclusion check, no body, no
    // way for it to answer 422.
    //
    // ════════════════════════════════════════════════════════════════
    // It drops `lastAccepted` too, and that is the load-bearing half
    // ════════════════════════════════════════════════════════════════
    //
    // `lastAccepted` holds the teleport destination (the pipeline put it
    // there). Leave it and the admin's first real fix after coming home
    // implies a jump of however far they teleported — hundreds of km/h,
    // refused at Section 7.2's step 4, and refused silently: their app would
    // simply stop working, sample after sample, until the entry aged out of
    // a map that has no ageing. That is the failure this whole operation
    // exists to prevent, and it is invisible from the outside.
    //
    // Deleting the entry puts the user in exactly the state Section 7.2
    // already defines for an API restart — "the guard has no reference point
    // and passes the first sample of each user unconditionally" — so the
    // next real sample re-seeds the map from wherever the phone actually is.
    // That is an existing, specified behaviour being reused, not an
    // exception carved into the guard: `processSampleBatch` is untouched and
    // `POST /api/samples` is untouched.
    //
    // The cost is stated rather than hidden: check-in reads the same map and
    // answers `no_recent_sample` while it is empty (routes/visits.ts), so
    // for the seconds between leaving teleport and the first real fix the
    // admin cannot check in. That is true after every restart too, and it is
    // the correct answer — the server genuinely does not know where they are.
    //
    // Both deletes are unconditional, including for a caller who was never
    // teleported: `Map.delete` on an absent key is a no-op, and a "you were
    // not teleported" refusal would be a way for this operation to fail.
    app.delete('/api/admin/teleport', { preHandler: requireAdmin }, async (request, reply) => {
      if (request.userId == null) {
        sendUnauthenticated(reply);
        return;
      }
      teleported.delete(request.userId);
      lastAccepted.delete(request.userId);
      return { ok: true as const };
    });
  };
}
