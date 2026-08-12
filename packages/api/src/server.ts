import { buildApp } from './app.js';
import { startBadgeScheduler } from './badges.js';
import { loadEnv } from './env.js';
import { startMaintenanceScheduler } from './maintenance.js';
import { initialiseDatabase } from './startup.js';

const env = loadEnv();
const db = await initialiseDatabase(env);
const app = buildApp(env, db);
// Started here, not in `buildApp`: tests build apps constantly (`app.test.ts`
// and friends) and must not each spin up a background timer.
const maintenance = startMaintenanceScheduler(app);
const badges = startBadgeScheduler(app);

async function shutdown(): Promise<void> {
  maintenance.stop();
  badges.stop();
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
