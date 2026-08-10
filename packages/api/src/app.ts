import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { CONFIG } from '@tipsytrails/shared';
import type Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { ACTIVE_CITY_SLUG } from './active-city.js';
import { mustChangePasswordGate } from './auth/password-gate.js';
import type { Env } from './env.js';
import { createOriginCheck } from './http/csrf.js';
import { applySecurityHeaders } from './http/security-headers.js';
import { accountRoutes } from './routes/account.js';
import { authRoutes } from './routes/auth.js';
import { cityRoutes } from './routes/city.js';
import { healthRoutes } from './routes/health.js';
import { resolveSeedDir, staticDataRoutes } from './routes/static-data.js';
import { tilesRoutes } from './routes/tiles.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database.Database;
    // The cell -> district index grid (SPEC.md Section 5.2), or null when
    // grid.bin is absent at boot (Section 13.2's tile-missing reasoning
    // applies the same way: this is one feature's data, not the whole
    // site's). Routes that need it must check for null and answer with a
    // clear error, the same way routes/tiles.ts does when the tile extract
    // is missing.
    grid: Uint16Array | null;
  }
}

const defaultWebRoot = fileURLToPath(new URL('../public', import.meta.url));

function loadGrid(gridPath: string): Uint16Array {
  const fileBuffer = readFileSync(gridPath);
  // Copied into a fresh, zero-offset ArrayBuffer so the Uint16Array view is
  // guaranteed 2-byte aligned regardless of where Node placed the Buffer's
  // backing allocation.
  const copy = fileBuffer.buffer.slice(
    fileBuffer.byteOffset,
    fileBuffer.byteOffset + fileBuffer.byteLength,
  );
  return new Uint16Array(copy);
}

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

  const gridPath = join(resolveSeedDir(env), ACTIVE_CITY_SLUG, 'grid.bin');
  if (existsSync(gridPath)) {
    app.decorate('grid', loadGrid(gridPath));
  } else {
    app.log.error(
      `Grid file not found at ${gridPath}. Regenerate it with ` +
        `scripts/build-grid.ts --city=${ACTIVE_CITY_SLUG}; routes needing the grid will answer ` +
        'with an error until it is present.',
    );
    app.decorate('grid', null);
  }

  app.register(healthRoutes);
  app.register(authRoutes(env));
  app.register(accountRoutes);
  app.register(cityRoutes);

  const tilesPath = join(env.TILES_DIR, CONFIG.TILES_FILENAME);
  const tilesAvailable = existsSync(tilesPath);
  if (!tilesAvailable) {
    app.log.error(
      `Tile extract not found at ${tilesPath}. Download it from ` +
        'https://github.com/AlexanderHultsch/TipsyTrails/releases or regenerate it with ' +
        'scripts/extract-tiles.sh; /tiles/* will answer with an error until it is present.',
    );
  }
  app.register(tilesRoutes(env, tilesAvailable));
  app.register(staticDataRoutes(env));

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
