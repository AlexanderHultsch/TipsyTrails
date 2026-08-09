import { buildApp } from './app.js';
import { loadEnv } from './env.js';

const env = loadEnv();
const app = buildApp(env);

try {
  await app.listen({ host: env.API_HOST, port: env.API_PORT });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
