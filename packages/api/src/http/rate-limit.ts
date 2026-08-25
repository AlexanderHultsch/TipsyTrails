import { CONFIG } from '@tipsytrails/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';

// Both internal: `createRateLimiter` below is this module's whole surface,
// and a call site names its limit with a string literal and its options with
// an object literal, so neither type is ever written out elsewhere. Keeping
// `RateLimitName` tied to CONFIG.RATE_LIMITS is still what makes an unknown
// limit name a compile error at every call site.
type RateLimitName = keyof typeof CONFIG.RATE_LIMITS;

interface RateLimitOptions {
  // Required (and only meaningful) for limits configured with `by: 'username'`:
  // the caller-supplied username isn't on the request the way `request.ip` or
  // `request.userId` are, so the route must say where to find it.
  getUsername?: (request: FastifyRequest) => string;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

function sendRateLimited(reply: FastifyReply, retryAfterMs: number): void {
  const retryAfterS = Math.max(1, Math.ceil(retryAfterMs / 1000));
  reply.header('Retry-After', String(retryAfterS));
  reply.code(429).send({
    code: 'rate_limited',
    message: 'Too many requests. Try again later.',
  });
}

function resolveIdentity(
  name: RateLimitName,
  by: 'ip' | 'user' | 'username',
  request: FastifyRequest,
  options: RateLimitOptions,
): string {
  switch (by) {
    case 'ip':
      return request.ip;
    case 'user':
      if (request.userId == null) {
        throw new Error(
          `rate limiter "${name}" is scoped by user but request.userId is not set; ` +
            'run an auth preHandler before this one',
        );
      }
      return String(request.userId);
    case 'username':
      if (!options.getUsername) {
        throw new Error(
          `rate limiter "${name}" is scoped by username but no getUsername() was provided`,
        );
      }
      return options.getUsername(request);
  }
}

export function createRateLimiter(name: RateLimitName, options: RateLimitOptions = {}) {
  const spec = CONFIG.RATE_LIMITS[name];
  const capacity = spec.limit;
  const windowMs = spec.windowMs;
  const refillPerMs = capacity / windowMs;

  const buckets = new Map<string, Bucket>();
  let lastSweep = Date.now();

  function sweep(now: number): void {
    if (now - lastSweep < windowMs) {
      return;
    }
    lastSweep = now;
    for (const [key, bucket] of buckets) {
      // A bucket that has had a full window to refill is indistinguishable
      // from one that was never created — drop it so idle callers don't
      // accumulate in memory forever.
      if (now - bucket.lastRefill >= windowMs) {
        buckets.delete(key);
      }
    }
  }

  return async function rateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const now = Date.now();
    sweep(now);

    const identity = resolveIdentity(name, spec.by, request, options);
    const key = `${name}:${identity}`;

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, lastRefill: now };
      buckets.set(key, bucket);
    } else {
      const elapsed = now - bucket.lastRefill;
      if (elapsed > 0) {
        bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
        bucket.lastRefill = now;
      }
    }

    if (bucket.tokens < 1) {
      const retryAfterMs = (1 - bucket.tokens) / refillPerMs;
      sendRateLimited(reply, retryAfterMs);
      return;
    }

    bucket.tokens -= 1;
  };
}
