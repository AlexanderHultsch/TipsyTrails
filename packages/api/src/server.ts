import { buildApp } from './app.js';
import { loadEnv } from './env.js';
import { initialiseDatabase } from './startup.js';

const env = loadEnv();
const db = await initialiseDatabase(env);
const app = buildApp(env, db);

async function shutdown(): Promise<void> {
  await app.close();
  db.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

try {
  await app.listen({ host: env.API_HOST, port: env.API_PORT });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
