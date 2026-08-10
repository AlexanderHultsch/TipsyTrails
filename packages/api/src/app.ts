import { existsSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import type Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { mustChangePasswordGate } from './auth/password-gate.js';
import type { Env } from './env.js';
import { createOriginCheck } from './http/csrf.js';
import { applySecurityHeaders } from './http/security-headers.js';
import { accountRoutes } from './routes/account.js';
import { authRoutes } from './routes/auth.js';
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

  app.addHook('onRequest', applySecurityHeaders);
  app.addHook('onRequest', createOriginCheck(env));
  // preHandler, not onRequest: it needs request.cookies, which @fastify/cookie
  // populates in its own onRequest hook and whose relative order among
  // several root-level onRequest hooks is not guaranteed. Every onRequest
  // hook (including that one) always finishes before any preHandler hook
  // runs, so this is guaranteed to see cookies already parsed.
  app.addHook('preHandler', mustChangePasswordGate);

  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api')) {
      reply.header('Cache-Control', 'private, no-store');
    }
    return payload;
  });

  app.register(healthRoutes);
  app.register(authRoutes(env));
  app.register(accountRoutes);

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
