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

// Section 9.2, and `ios/SPEC.md` 9.2 which specifies it verbatim. A partial
// body of two independent settings: an omitted key means unchanged, which is
// the reading the two admin PATCH routes (Section 9.3) already have. The
// `.refine` is what keeps `{}` a 400 rather than the 200 no-op
// `patchUserSchema` answers with — the body here can carry a consent record,
// and a call that recorded nothing must not answer like a call that did.
//
// Deliberately not `.strict()`: an unknown key is stripped, so a misspelt
// `{ backgroundTrackng: true }` parses to `{}` and is caught by the refine as
// the same loud 400 rather than a silent success.
const settingsSchema = z
  .object({
    isAnonymous: z.boolean().optional(),
    backgroundTracking: z.boolean().optional(),
  })
  .refine((data) => data.isAnonymous !== undefined || data.backgroundTracking !== undefined);

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

    // The statement is built from the keys the body names, so a column the
    // body did not name is not written at all — not written back to the value
    // it already held, which a fixed two-placeholder UPDATE would have to
    // read first and would race with. Both keys together are therefore one
    // UPDATE on one row: there is no order between them and no window in
    // which one has landed and the other has not (`ios/SPEC.md` 9.2).
    const assignments: string[] = [];
    const values: (number | null)[] = [];

    if (parsed.data.isAnonymous !== undefined) {
      assignments.push('is_anonymous = ?');
      values.push(parsed.data.isAnonymous ? 1 : 0);
    }

    if (parsed.data.backgroundTracking !== undefined) {
      // `true` records the server's current second — the same idiom
      // routes/auth.ts writes `created_at` with, and the unit the database
      // stores every timestamp in (Section 0, rule 6). A `true` on an account
      // that already holds one re-stamps it: the record Art. 7(1) wants is
      // when the player *last* consented (`ios/SPEC.md` 9.2). `false`
      // withdraws by clearing the column back to NULL.
      assignments.push('background_tracking_consented_at = ?');
      values.push(parsed.data.backgroundTracking ? Math.floor(Date.now() / 1000) : null);
    }

    request.server.db
      .prepare(`UPDATE users SET ${assignments.join(', ')} WHERE id = ?`)
      .run(...values, request.userId);

    const row = request.server.db
      .prepare<[number], UserRow>(
        `SELECT id, username, avatar_seed, is_admin, is_anonymous, must_change_password,
                background_tracking_consented_at
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
