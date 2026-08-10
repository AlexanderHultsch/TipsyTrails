import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Env } from '../env.js';

const STATE_CHANGING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

function sendOriginMismatch(reply: FastifyReply): void {
  reply.code(403).send({
    code: 'origin_mismatch',
    message: 'The request Origin does not match this server.',
  });
}

export function createOriginCheck(env: Env) {
  return async function checkOrigin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!request.url.startsWith('/api')) {
      return;
    }
    if (!STATE_CHANGING_METHODS.has(request.method)) {
      return;
    }

    const origin = request.headers.origin;

    // A missing Origin header on a state-changing request is treated the
    // same as a mismatched one: rejected (Section 10.1). Fetch/XHR sends
    // Origin on POST/PATCH/PUT/DELETE regardless of whether the request is
    // same-origin or cross-origin, so every legitimate call from this app's
    // own SPA carries it. A request with none is either a non-browser
    // client nobody has taught to send it, or a legacy browser that
    // SameSite=Lax cannot protect either. Failing closed keeps this check a
    // real second line of defence instead of one an attacker defeats by
    // simply omitting the header.
    if (!origin || origin !== env.PUBLIC_ORIGIN) {
      sendOriginMismatch(reply);
      return;
    }
  };
}
