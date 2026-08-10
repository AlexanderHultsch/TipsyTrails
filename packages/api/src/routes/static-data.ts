import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Env } from '../env.js';

// Section 4.1's caching table predates the multi-city seam (Section 11.4)
// and writes a single `/static/districts.json` path. The data is now
// per-city (`data/seed/<slug>/*.geojson`), so the URL carries the slug —
// `/static/<slug>/<filename>` — which the client can derive from the active
// city's slug alone, same as it derives `/tiles/<filename>` today.
const STATIC_CACHE_CONTROL = 'public, max-age=86400';

// The only filenames fetch-boundaries.ts (Section 11.4) ever writes into a
// city's seed directory. Exact allowlist match, the same defence tiles.ts
// uses for CONFIG.TILES_FILENAME rather than sanitizing an arbitrary name.
const ALLOWED_STATIC_FILES = new Set(['city.geojson', 'districts.geojson', 'neighbours.geojson']);

// City slugs (Section 11.4) are plain lowercase-hyphen identifiers; this
// also guards the slug URL segment against a ".." traversal component the
// filename allowlist alone would not catch.
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Resolved relative to the compiled module, the same mechanism app.ts uses
// for the default WEB_ROOT and startup.ts uses for migrationsDir. The root
// Dockerfile places `data/seed` next to `dist`, `migrations` and `public`
// under /app, so this lands on /app/data/seed at runtime.
const defaultSeedDir = fileURLToPath(new URL('../../data/seed', import.meta.url));

function sendStaticFileNotFound(reply: FastifyReply): void {
  reply.code(404).send({
    code: 'static_file_not_found',
    message: 'That static file does not exist.',
  });
}

// The one place `env.SEED_DIR` is resolved against its default, so every
// consumer of the seed tree (this route, city/district seeding, the grid.bin
// load at boot) agrees on the same directory.
export function resolveSeedDir(env: Env): string {
  return env.SEED_DIR ?? defaultSeedDir;
}

export function staticDataRoutes(env: Env) {
  const seedDir = resolveSeedDir(env);

  return async function staticDataRoutesPlugin(app: FastifyInstance): Promise<void> {
    await app.register(fastifyStatic, {
      root: seedDir,
      serve: false,
      decorateReply: true,
    });

    app.get('/static/:slug/:filename', async (request, reply) => {
      const { slug, filename } = request.params as { slug: string; filename: string };

      if (!SLUG_PATTERN.test(slug) || !ALLOWED_STATIC_FILES.has(filename)) {
        sendStaticFileNotFound(reply);
        return;
      }

      const relativePath = join(slug, filename);
      if (!existsSync(join(seedDir, relativePath))) {
        sendStaticFileNotFound(reply);
        return;
      }

      reply.header('Cache-Control', STATIC_CACHE_CONTROL);
      await reply.sendFile(relativePath, seedDir, { cacheControl: false });
    });
  };
}
