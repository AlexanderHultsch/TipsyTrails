import { existsSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Env } from './env.js';
import { healthRoutes } from './routes/health.js';

const defaultWebRoot = fileURLToPath(new URL('../public', import.meta.url));

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

  const webRoot = env.WEB_ROOT ?? defaultWebRoot;
  if (existsSync(webRoot)) {
    app.register(fastifyStatic, {
      root: webRoot,
      setHeaders(reply, filePath) {
        const rel = relative(webRoot, filePath);
        if (rel.startsWith(`assets${sep}`)) {
          reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (rel === 'index.html') {
          reply.header('Cache-Control', 'public, max-age=0, must-revalidate');
        }
      },
    });

    app.setNotFoundHandler((request, reply) => {
      if (request.raw.method !== 'GET' || request.url.startsWith('/api')) {
        reply.code(404).send({
          message: `Route ${request.raw.method}:${request.raw.url} not found`,
          error: 'Not Found',
          statusCode: 404,
        });
        return;
      }
      reply.header('Cache-Control', 'public, max-age=0, must-revalidate');
      reply.type('text/html').sendFile('index.html');
    });
  } else {
    app.log.warn(`WEB_ROOT (${webRoot}) does not exist; the SPA will not be served`);
  }

  return app;
}
