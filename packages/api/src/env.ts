import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().default(3000),
  PUBLIC_ORIGIN: z.url(),
  DATABASE_PATH: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  ADMIN_USERNAME: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),
  WEB_ROOT: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const { API_PORT, PORT, DATABASE_PATH, DB_PATH, ...rest } = source;
  const normalised = {
    ...rest,
    API_PORT: API_PORT ?? PORT,
    DATABASE_PATH: DATABASE_PATH ?? DB_PATH,
  };
  const result = envSchema.safeParse(normalised);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid environment variables: ${names.join(', ')}`);
  }
  return result.data;
}
