import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth, SESSION_COOKIE_NAME } from '../auth/cookie.js';
import { verifyPassword } from '../auth/password.js';

interface UserRow {
  id: number;
  username: string;
  avatar_seed: string;
  is_admin: number;
  is_anonymous: number;
  must_change_password: number;
}

interface PublicUser {
  id: number;
  username: string;
  avatarSeed: string;
  isAdmin: boolean;
  isAnonymous: boolean;
  mustChangePassword: boolean;
}

function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    avatarSeed: row.avatar_seed,
    isAdmin: Boolean(row.is_admin),
    isAnonymous: Boolean(row.is_anonymous),
    mustChangePassword: Boolean(row.must_change_password),
  };
}

const settingsSchema = z.object({
  isAnonymous: z.boolean(),
});

const deleteAccountSchema = z.object({
  password: z.string().min(1),
});

function sendInvalidRequest(reply: FastifyReply): void {
  reply.code(400).send({ code: 'invalid_request', message: 'The request body is invalid.' });
}

// Section 9.5: the same generic failure POST /api/auth/login uses for a
// wrong password, reused here rather than a new code.
function sendInvalidCredentials(reply: FastifyReply): void {
  reply.code(401).send({ code: 'invalid_credentials', message: 'Invalid username or password.' });
}

function sendUnauthenticated(reply: FastifyReply): void {
  reply.code(401).send({ code: 'unauthenticated', message: 'Authentication required.' });
}

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.patch('/api/settings', { preHandler: requireAuth }, async (request, reply) => {
    if (request.userId == null) {
      sendUnauthenticated(reply);
      return;
    }

    const parsed = settingsSchema.safeParse(request.body);
    if (!parsed.success) {
      sendInvalidRequest(reply);
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
      sendInvalidRequest(reply);
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
