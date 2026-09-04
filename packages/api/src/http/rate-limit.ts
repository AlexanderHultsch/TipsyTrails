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
  // the caller-supplied username isn't on the request the way `request.userId`
  // is, so the route must say where to find it.
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

// The identity every `by: 'global'` limit shares. One fixed string rather
// than anything read off the request is the whole point of a global limit:
// every caller lands in the same bucket. The bucket key is still
// `${name}:${identity}` (see below), so two global limits do not share a
// bucket with each other — `authGlobal` and `register` are separate ceilings
// and the limiter's name is what keeps them apart.
const GLOBAL_IDENTITY = 'all';

// SPEC.md Section 9.4: there is deliberately no `'ip'` case, and the union
// has no `'ip'` member for one to be written against. "This app does not do
// IP-based blocking" is therefore something the compiler holds — adding
// `by: 'ip'` to a limit in config.ts fails to typecheck here — rather than a
// claim in a comment that a later edit could quietly falsify.
function resolveIdentity(
  name: RateLimitName,
  by: 'global' | 'user' | 'username',
  request: FastifyRequest,
  options: RateLimitOptions,
): string {
  switch (by) {
    case 'global':
      return GLOBAL_IDENTITY;
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
      // Normalised here rather than at the two call sites, so every
      // username-keyed limit gets it and a future one cannot forget it.
      //
      // `users.username` is `TEXT NOT NULL UNIQUE COLLATE NOCASE`
      // (migrations/001_init.sql), so SQLite matches `username = ?` without
      // regard to ASCII case: `admin`, `Admin`, `ADMIN` and `aDmIn` are one
      // account. Keying the bucket on the raw submission made them four
      // buckets on that one account, which multiplied the limit Section 9.4
      // promises by the number of spellings — 32x for a five-character name,
      // and exponentially more for a longer one. The two halves have to agree
      // on what one account is; this is that agreement, not tidying.
      //
      // `toLowerCase()` and not `toLocaleLowerCase()`: the latter follows the
      // runtime's default locale, and under a Turkish one `ADMIN` folds to
      // `admın` (dotless i) while `admin` stays `admin` — two spellings SQLite
      // calls one account, split back into two buckets by the very call meant
      // to join them, on nothing more than where the server runs.
      // `toLowerCase()` is locale-independent and maps A-Z to a-z exactly as
      // NOCASE does. It also folds non-ASCII pairs NOCASE keeps apart (`Ä`
      // and `ä`), which is safe in this direction: it can only merge buckets,
      // never split one, and `usernameSchema` admits only [a-zA-Z0-9_-], so no
      // stored account is reachable by a non-ASCII spelling anyway.
      //
      // The trim matches the `z.string().trim()` in the reset schemas, which
      // runs *after* this preHandler: the database sees the trimmed username
      // there, so ` admin` and `admin` are one account and must be one bucket.
      return options.getUsername(request).trim().toLowerCase();
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
    // The limiter's name is part of the key even though each limiter already
    // owns its own `buckets` map, and it earns its place for `by: 'global'`:
    // every global limit resolves to the same identity, so the name is the
    // only thing in the key that tells one global bucket from another if the
    // maps are ever shared or dumped together.
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
