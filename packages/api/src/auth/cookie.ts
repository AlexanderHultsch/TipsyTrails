import { DERIVED } from '@tipsytrails/shared';
import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Env } from '../env.js';
import { sendUnauthenticated } from '../http/errors.js';
import { getSession } from './session.js';

export const SESSION_COOKIE_NAME = 'tt_session';

declare module 'fastify' {
  interface FastifyRequest {
    userId: number | null;
  }
}

function isSecureOrigin(env: Env): boolean {
  return env.PUBLIC_ORIGIN.startsWith('https:');
}

// Internal to this module: setSessionCookie below is the only way a session
// cookie is ever written, so the option set it writes with is not something
// a route should be able to reach for and set half of.
function sessionCookieOptions(env: Env): CookieSerializeOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: DERIVED.SESSION_TTL_S,
    secure: isSecureOrigin(env),
    signed: true,
  };
}

export function setSessionCookie(reply: FastifyReply, env: Env, sessionId: string): void {
  reply.setCookie(SESSION_COOKIE_NAME, sessionId, sessionCookieOptions(env));
}

function sendForbidden(reply: FastifyReply): void {
  reply.code(403).send({ code: 'forbidden', message: 'Administrator access required.' });
}

// Shared by requireAuth and the must-change-password gate: both need to know
// which user (if any) a request's session cookie belongs to, resolved the
// same way, so the two can never disagree about who is authenticated.
export function resolveSessionUserId(request: FastifyRequest): number | null {
  const cookieValue = request.cookies[SESSION_COOKIE_NAME];
  if (!cookieValue) {
    return null;
  }

  const unsigned = request.unsignCookie(cookieValue);
  if (!unsigned.valid || !unsigned.value) {
    return null;
  }

  const session = getSession(request.server.db, unsigned.value);
  if (!session) {
    return null;
  }

  return session.userId;
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const userId = resolveSessionUserId(request);
  if (userId == null) {
    sendUnauthenticated(reply);
    return;
  }

  request.userId = userId;
}

// Phase 7 step 2 (SPEC.md Section 12): every /api/admin/* route sits behind
// this. Per that section's Definition of Done, a logged-in non-admin gets
// 403 — the endpoint's existence is not a secret here, unlike Section 9.5's
// bar rules, only the authority to use it is — while an unauthenticated
// caller still gets requireAuth's 401.
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const userId = resolveSessionUserId(request);
  if (userId == null) {
    sendUnauthenticated(reply);
    return;
  }

  const row = request.server.db
    .prepare<[number], { is_admin: number }>('SELECT is_admin FROM users WHERE id = ?')
    .get(userId);
  if (!row || !row.is_admin) {
    sendForbidden(reply);
    return;
  }

  request.userId = userId;
}
