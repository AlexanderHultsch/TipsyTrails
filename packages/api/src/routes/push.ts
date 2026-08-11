import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/cookie.js';

// SPEC.md Sections 5.9, 9.2, Phase 5 step 5: the subscription endpoints and
// the one piece of Web Push config the client needs to call
// `pushManager.subscribe()` at all — its VAPID public key, which is not
// sensitive (only the private key is, per CLAUDE.md) and is not in
// SPEC.md's Section 9.2 endpoint table because that table predates this
// step. It is grouped here rather than added to an existing response
// because no existing endpoint's shape is a natural home for it, and
// `GET /api/city` (routes/city.ts) already establishes the pattern of a
// small `requireAuth`, read-only, boot-config endpoint this mirrors.

function sendUnauthenticated(reply: FastifyReply): void {
  reply.code(401).send({ code: 'unauthenticated', message: 'Authentication required.' });
}

function sendInvalidRequest(reply: FastifyReply): void {
  reply.code(400).send({ code: 'invalid_request', message: 'The request body is invalid.' });
}

const subscribeSchema = z.object({
  endpoint: z.url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

const unsubscribeSchema = z.object({
  endpoint: z.url(),
});

export function pushRoutes(vapidPublicKey: string | null) {
  return async function pushRoutesPlugin(app: FastifyInstance): Promise<void> {
    app.get('/api/push/vapid-public-key', { preHandler: requireAuth }, async (request, reply) => {
      if (request.userId == null) {
        sendUnauthenticated(reply);
        return;
      }

      return { publicKey: vapidPublicKey };
    });

    app.post('/api/push/subscribe', { preHandler: requireAuth }, async (request, reply) => {
      if (request.userId == null) {
        sendUnauthenticated(reply);
        return;
      }

      const parsed = subscribeSchema.safeParse(request.body);
      if (!parsed.success) {
        sendInvalidRequest(reply);
        return;
      }

      const { endpoint, keys } = parsed.data;
      // Section 5.9: `endpoint` is UNIQUE. The same endpoint re-subscribing
      // — the ordinary case of a page reload re-registering, or a
      // logout/login on the same browser handing the row to a new user —
      // must not error (task Section B), so this upserts onto the caller's
      // account rather than inserting unconditionally.
      request.server.db
        .prepare(
          `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(endpoint) DO UPDATE SET
             user_id = excluded.user_id,
             p256dh = excluded.p256dh,
             auth = excluded.auth`,
        )
        .run(request.userId, endpoint, keys.p256dh, keys.auth, Math.floor(Date.now() / 1000));

      return { ok: true };
    });

    app.delete('/api/push/subscribe', { preHandler: requireAuth }, async (request, reply) => {
      if (request.userId == null) {
        sendUnauthenticated(reply);
        return;
      }

      const parsed = unsubscribeSchema.safeParse(request.body);
      if (!parsed.success) {
        sendInvalidRequest(reply);
        return;
      }

      // SPEC.md Section 9.5's reasoning, applied here (task Section B): a
      // 404 or a distinct "not yours" response would tell the caller
      // something exists that they cannot touch, the same existence-oracle
      // problem Section 9.5 forbids for bars. Scoping the DELETE to the
      // caller's own user_id makes it a no-op for someone else's endpoint
      // or a nonexistent one, and the response is `{ ok: true }` in every
      // case, so none of the three is distinguishable from the others.
      request.server.db
        .prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?')
        .run(parsed.data.endpoint, request.userId);

      return { ok: true };
    });
  };
}
