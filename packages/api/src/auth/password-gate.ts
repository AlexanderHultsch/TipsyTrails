import type { FastifyReply, FastifyRequest } from 'fastify';
import { resolveSessionUserId } from './cookie.js';

// Section 5.3: while must_change_password is set, every endpoint except
// these three returns 403 so the seeded admin cannot do anything until it
// has replaced the password that came from the environment (Section 13.4).
// /api/health is exempt too even though it never carries a session, because
// the container healthcheck must never depend on this gate.
const EXEMPT_PATHS = new Set([
  '/api/auth/me',
  '/api/auth/change-password',
  '/api/auth/logout',
  '/api/health',
]);

interface MustChangePasswordRow {
  must_change_password: number;
}

function sendPasswordChangeRequired(reply: FastifyReply): void {
  reply.code(403).send({
    code: 'password_change_required',
    message: 'You must change your password before continuing.',
  });
}

export async function mustChangePasswordGate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!request.url.startsWith('/api')) {
    return;
  }

  const pathname = request.url.split('?')[0];
  if (EXEMPT_PATHS.has(pathname)) {
    return;
  }

  // No (or an invalid) session: leave this request alone. The route's own
  // auth handling is responsible for the 401 — this gate only ever adds a
  // 403 on top of an already-authenticated request.
  const userId = resolveSessionUserId(request);
  if (userId == null) {
    return;
  }

  const row = request.server.db
    .prepare<[number], MustChangePasswordRow>('SELECT must_change_password FROM users WHERE id = ?')
    .get(userId);

  if (row?.must_change_password) {
    sendPasswordChangeRequired(reply);
  }
}
