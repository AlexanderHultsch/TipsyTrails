import { z } from 'zod';

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().default(3000),
  PUBLIC_ORIGIN: z.url(),
  DATABASE_PATH: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  ADMIN_USERNAME: z.string().optional(),
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
