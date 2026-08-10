import { DERIVED } from '@tipsytrails/shared';
import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Env } from '../env.js';
import { getSession } from './session.js';

export const SESSION_COOKIE_NAME = 'tt_session';

declare module 'fastify' {
  interface FastifyRequest {
    userId: number | null;
  }
}

export function isSecureOrigin(env: Env): boolean {
  return env.PUBLIC_ORIGIN.startsWith('https:');
}

export function sessionCookieOptions(env: Env): CookieSerializeOptions {
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

function sendUnauthenticated(reply: FastifyReply): void {
  reply.code(401).send({ code: 'unauthenticated', message: 'Authentication required.' });
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
