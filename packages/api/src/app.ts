import { existsSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import type Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Env } from './env.js';
import { healthRoutes } from './routes/health.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database.Database;
  }
}

const defaultWebRoot = fileURLToPath(new URL('../public', import.meta.url));

export function buildApp(env: Env, db: Database.Database): FastifyInstance {
  const app = Fastify({
    logger: env.NODE_ENV !== 'test',
    trustProxy: 1,
  });

  app.decorate('db', db);
  app.decorateRequest('userId', null);

  app.register(fastifyCookie, {
    secret: env.SESSION_SECRET,
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
