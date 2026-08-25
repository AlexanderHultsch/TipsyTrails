import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { CONFIG } from '@tipsytrails/shared';
import type { LatLon } from '@tipsytrails/shared';
import type Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { ACTIVE_CITY_SLUG } from './active-city.js';
import { mustChangePasswordGate } from './auth/password-gate.js';
import type { Env } from './env.js';
import { loadDistrictIdByGridIndex, loadGrid } from './fog/district-index.js';
import type { AcceptedPosition } from './last-accepted.js';
import { createOriginCheck } from './http/csrf.js';
import { applySecurityHeaders } from './http/security-headers.js';
import { resolveVapidConfig } from './push/config.js';
import { createWebPushSender, type PushSender } from './push/sender.js';
import { accountRoutes } from './routes/account.js';
import { adminRoutes } from './routes/admin.js';
import { adminTeleportRoutes } from './routes/admin-teleport.js';
import { authRoutes } from './routes/auth.js';
import { barsRoutes } from './routes/bars.js';
import { cityRoutes } from './routes/city.js';
import { fogRoutes } from './routes/fog.js';
import { healthRoutes } from './routes/health.js';
import { leaderboardRoutes } from './routes/leaderboard.js';
import { profileRoutes } from './routes/profile.js';
import { pushRoutes } from './routes/push.js';
import { resolveSeedDir, staticDataRoutes } from './routes/static-data.js';
import { tilesRoutes } from './routes/tiles.js';
import { visitsRoutes } from './routes/visits.js';

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
    // `grid`'s per-cell district *index* resolved to a `districts` row id
    // (SPEC.md Section 5.2), loaded alongside `grid` from the same seed
    // directory. Null under the same conditions `grid` is null.
    districtIdByGridIndex: Map<number, number> | null;
    // SPEC.md Sections 5.9, 7.9, Phase 5 step 5: resolved once at boot from
    // the VAPID_* env vars, or else the on-disk key file loaded/generated
    // beside DATABASE_PATH (push/config.ts). Null means push is disabled —
    // incomplete env config, an unusable key file, or config
    // `webpush.setVapidDetails` itself rejected — and maintenance.ts's
    // dispatch step is a no-op the same way the grid/tiles routes above
    // answer with a clear error rather than crashing when their own
    // optional input is missing.
    pushSender: PushSender | null;
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

  const seedDir = resolveSeedDir(env);
  const gridPath = join(seedDir, ACTIVE_CITY_SLUG, 'grid.bin');
  if (existsSync(gridPath)) {
    app.decorate('grid', loadGrid(gridPath));
    app.decorate('districtIdByGridIndex', loadDistrictIdByGridIndex(db, seedDir, ACTIVE_CITY_SLUG));
  } else {
    app.log.error(
      `Grid file not found at ${gridPath}. Regenerate it with ` +
        `scripts/build-grid.ts --city=${ACTIVE_CITY_SLUG}; routes needing the grid will answer ` +
        'with an error until it is present.',
    );
    app.decorate('grid', null);
    app.decorate('districtIdByGridIndex', null);
  }

  // Section 7.2's teleport guard and Section 7.5 step 2's check-in
  // proximity check read the same in-memory "last accepted sample" state
  // (Section 10.2: memory-only, never persisted), so both plugins share the
  // one Map created here rather than fogRoutes owning a copy visits.ts
  // cannot see.
  const lastAccepted = new Map<number, AcceptedPosition>();

  // Section 5.9/7.9/Phase 5 step 5: push is an enhancement (task brief) —
  // PUBLIC_ORIGIN and SESSION_SECRET above remain the only variables that
  // stop the app from booting. All three VAPID_* env vars set wins
  // outright; none set loads or generates the on-disk key file beside
  // DATABASE_PATH (the ordinary Pi deployment, silent at info level); some
  // but not all three set almost certainly means a typo, so it gets a
  // warning; a key file present but unreadable/malformed, or one that
  // could not be written, gets a loud error the same way a missing
  // grid.bin or tile extract does above — either way `pushSender` ends up
  // null and every push feature degrades to "disabled" rather than the
  // container refusing to start.
  const vapid = resolveVapidConfig(env);
  let pushSender: PushSender | null = null;
  if (vapid.status === 'misconfigured') {
    app.log.warn(
      `Web Push is misconfigured: ${vapid.missing.join(', ')} not set. Set all three VAPID_* ` +
        'variables to enable push, or none to leave it disabled. Push reminders are off.',
    );
  } else if (vapid.status === 'unavailable') {
    app.log.error(
      `Web Push key material is unavailable (${vapid.reason}); push reminders are off.`,
    );
  } else {
    pushSender = createWebPushSender(vapid.config, app.log);
  }
  app.decorate('pushSender', pushSender);

  app.register(healthRoutes);
  app.register(authRoutes(env));
  app.register(accountRoutes);
  app.register(adminRoutes);
  // SPEC.md Sections 9.3, 10.1: the admin teleport's second gate, and the
  // reason it is expressed as a registration rather than as a check inside
  // the handler. Without `ADMIN_TELEPORT_ENABLED=true` the plugin is never
  // registered, so `/api/admin/teleport` is a path this server does not have
  // — the SPA fallback below answers 404 to all three of its methods —
  // instead of a route that exists and says no. The code ships inert on a
  // production box, and a stolen admin session finds nothing to reach. It is
  // also what the map screen reads that 404 as: "not teleported", never an
  // error (screens/Map.tsx).
  //
  // It shares the one `lastAccepted` map for the same reason fogRoutes and
  // visitsRoutes do: a teleport has to be what the next real sample is
  // compared against, and check-in has to see where the teleport landed.
  if (env.ADMIN_TELEPORT_ENABLED === 'true') {
    app.log.warn(
      'ADMIN_TELEPORT_ENABLED is set: /api/admin/teleport is registered. It moves an ' +
        "admin's position without the speed guards and is intended for testing only; unset the " +
        'variable to remove the route.',
    );
    // Teleport as a mode rather than a one-shot (Section 9.3): where each
    // teleported admin currently stands, so the client can be told to honour
    // it until they teleport elsewhere or leave the mode.
    //
    // In memory and never in the database — constraint C4 and Section 10.2
    // forbid persisting a position, and Section 7.2 pre-empts the workaround
    // for the neighbouring map above. A restart is a fresh process and a
    // fresh Map, so the mode dies with the process exactly as `lastAccepted`
    // does.
    //
    // Declared inside this branch rather than beside `lastAccepted`, and
    // that is the difference between the two: `lastAccepted` is shared by
    // three plugins and lives where all three can be handed it, while this
    // has exactly one consumer and a server that never enabled the feature
    // then holds no such state at all.
    const teleported = new Map<number, LatLon>();
    app.register(adminTeleportRoutes(lastAccepted, teleported));
  }
  app.register(cityRoutes);
  app.register(fogRoutes(lastAccepted));
  app.register(barsRoutes);
  app.register(visitsRoutes(lastAccepted));
  app.register(leaderboardRoutes);
  app.register(profileRoutes);
  app.register(pushRoutes(vapid.status === 'enabled' ? vapid.config.publicKey : null));

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
        } else if (rel === 'index.html' || rel === 'manifest.json' || rel === 'sw.js') {
          reply.header('Cache-Control', 'public, max-age=0, must-revalidate');
        } else if (rel.startsWith(`icons${sep}`)) {
          reply.header('Cache-Control', 'public, max-age=86400');
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
