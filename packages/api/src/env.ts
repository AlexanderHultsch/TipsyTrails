import { z } from 'zod';

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

// Internal: `loadEnv` below is the only supported way to turn a process
// environment into an `Env`, because it also applies the PORT/DB_PATH
// aliases and the empty-string normalisation the schema itself knows
// nothing about. Parsing against this schema directly would silently skip
// all of that, so it is not offered.
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  API_HOST: z.string().default('0.0.0.0'),
  // Constrained to a real TCP port, not merely "a number": `app.listen`
  // (server.ts) is what a fractional, negative or over-65535 value actually
  // fails on, several steps later and as a RangeError about a value the
  // operator never typed in that form. Same reasoning as SESSION_SECRET's
  // `.min(32)` — the variable is checked for what it has to mean, not only
  // for what it has to look like, and the one place that check belongs is
  // the point the environment is read.
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // `protocol` as well as URL syntax. Bare `z.url()` accepts `ftp://…` and
  // `javascript:…`, and a PUBLIC_ORIGIN like that fails three separate
  // things much later and each in its own confusing way: the session cookie
  // silently loses its `secure` flag (auth/cookie.ts reads
  // `startsWith('https:')`), every state-changing request is refused because
  // no browser will ever send a matching Origin header (http/csrf.ts), and
  // Web Push turns itself off because `setVapidDetails` rejects the subject
  // (push/sender.ts). None of those name the variable; this does.
  PUBLIC_ORIGIN: z.url({ protocol: /^https?$/ }),
  DATABASE_PATH: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  ADMIN_USER: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),
  WEB_ROOT: z.string().transform(emptyToUndefined).optional(),
  TILES_DIR: z.string().default('/data/tiles'),
  SEED_DIR: z.string().transform(emptyToUndefined).optional(),
  // Web Push (SPEC.md Sections 5.9, 7.5, 7.9, 9.2). All three are optional —
  // push is an enhancement, not a hard requirement (see PUBLIC_ORIGIN and
  // SESSION_SECRET above, the only ones that are). Whether some but not all
  // three are set is a misconfiguration worth warning about is decided by
  // push/config.ts's resolveVapidConfig, not here — this schema only says
  // each one, alone, is optional.
  VAPID_PUBLIC_KEY: z.string().transform(emptyToUndefined).optional(),
  VAPID_PRIVATE_KEY: z.string().transform(emptyToUndefined).optional(),
  VAPID_SUBJECT: z.string().transform(emptyToUndefined).optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const { API_PORT, PORT, DATABASE_PATH, DB_PATH, TILES_DIR, ...rest } = source;
  const normalised = {
    ...rest,
    API_PORT: emptyToUndefined(API_PORT) ?? emptyToUndefined(PORT),
    DATABASE_PATH: emptyToUndefined(DATABASE_PATH) ?? emptyToUndefined(DB_PATH),
    TILES_DIR: emptyToUndefined(TILES_DIR),
  };
  const result = envSchema.safeParse(normalised);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid environment variables: ${names.join(', ')}`);
  }
  return result.data;
}
