import Fastify, { type FastifyInstance } from 'fastify';
import type { Env } from './env.js';
import { healthRoutes } from './routes/health.js';

export function buildApp(env: Env): FastifyInstance {
  const app = Fastify({
    logger: env.NODE_ENV !== 'test',
  });

  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api')) {
      reply.header('Cache-Control', 'private, no-store');
    }
    return payload;
  });

  app.register(healthRoutes);

  return app;
}
