import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, SESSION_COOKIE_NAME } from '../auth/cookie.js';
import { verifyPassword } from '../auth/password.js';
// `PATCH /api/settings` answers with the same user body `GET /api/auth/me`,
// register and login do, so it uses that module's projection rather than a
// second identical copy of the row shape, the public shape and the mapper —
// see routes/auth.ts's own comment on them.
import {
  sendInvalidCredentials,
  sendInvalidRequestBody,
  sendUnauthenticated,
} from '../http/errors.js';
import { toPublicUser, type UserRow } from './auth.js';

const settingsSchema = z.object({
  isAnonymous: z.boolean(),
});

const deleteAccountSchema = z.object({
  password: z.string().min(1),
});

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.patch('/api/settings', { preHandler: requireAuth }, async (request, reply) => {
    if (request.userId == null) {
      sendUnauthenticated(reply);
      return;
    }

    const parsed = settingsSchema.safeParse(request.body);
    if (!parsed.success) {
      sendInvalidRequestBody(reply);
      return;
    }

    request.server.db
      .prepare('UPDATE users SET is_anonymous = ? WHERE id = ?')
      .run(parsed.data.isAnonymous ? 1 : 0, request.userId);

    const row = request.server.db
      .prepare<[number], UserRow>(
        `SELECT id, username, avatar_seed, is_admin, is_anonymous, must_change_password
         FROM users WHERE id = ?`,
      )
      .get(request.userId);

    if (!row) {
      sendUnauthenticated(reply);
      return;
    }

    return toPublicUser(row);
  });

  app.delete('/api/account', { preHandler: requireAuth }, async (request, reply) => {
    if (request.userId == null) {
      sendUnauthenticated(reply);
      return;
    }

    const parsed = deleteAccountSchema.safeParse(request.body);
    if (!parsed.success) {
      sendInvalidRequestBody(reply);
      return;
    }

    const row = request.server.db
      .prepare<[number], { password_hash: string }>('SELECT password_hash FROM users WHERE id = ?')
      .get(request.userId);
    if (!row) {
      sendUnauthenticated(reply);
      return;
    }

    const passwordValid = await verifyPassword(row.password_hash, parsed.data.password);
    if (!passwordValid) {
      sendInvalidCredentials(reply);
      return;
    }

    const userId = request.userId;
    const db = request.server.db;
    // bars.submitted_by has no ON DELETE clause, so with foreign_keys=ON the
    // DELETE below would be rejected by that constraint unless the reference
    // is cleared first (Section 10.6: bars are shared catalogue data and
    // survive account deletion with submitted_by set to NULL). Every other
    // table referencing users(id) is declared ON DELETE CASCADE and needs no
    // help here.
    const deleteAccount = db.transaction(() => {
      db.prepare('UPDATE bars SET submitted_by = NULL WHERE submitted_by = ?').run(userId);
      db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    });
    deleteAccount();

    reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    return { ok: true };
  });
}
