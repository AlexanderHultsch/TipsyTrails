import type { FastifyReply, FastifyRequest } from 'fastify';

// Section 10.1 baseline, transcribed verbatim. The blob: worker-src and
// child-src entries are load-bearing: MapLibre GL instantiates its workers
// from blob URLs and the map will not initialise without them.
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; worker-src 'self' blob:; child-src 'self' blob:; style-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

export async function applySecurityHeaders(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  reply.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'no-referrer');
  // Redundant with the CSP's frame-ancestors 'none' in modern browsers, kept
  // for the older ones that only understand this header.
  reply.header('X-Frame-Options', 'DENY');
}
