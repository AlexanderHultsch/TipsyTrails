import fastifyStatic from '@fastify/static';
import { CONFIG } from '@tipsytrails/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Env } from '../env.js';

// Section 4.1: the tile route is the one path under the API's control that
// is deliberately cacheable, unlike everything under /api (private, no-store
// in app.ts). Set literally here, matching how app.ts inlines the
// hashed-asset and index.html Cache-Control values rather than routing them
// through config.ts, which holds gameplay constants, not header strings.
const TILES_CACHE_CONTROL = 'public, max-age=2592000';

function sendTileNotFound(reply: FastifyReply): void {
  reply.code(404).send({ code: 'tile_not_found', message: 'That tile file does not exist.' });
}

function sendTilesUnavailable(reply: FastifyReply): void {
  reply.code(503).send({
    code: 'tiles_unavailable',
    message: 'The map tile extract is not installed on this server.',
  });
}

export function tilesRoutes(env: Env, available: boolean) {
  return async function tilesRoutesPlugin(app: FastifyInstance): Promise<void> {
    const tilesDir = env.TILES_DIR;

    if (available) {
      await app.register(fastifyStatic, {
        root: tilesDir,
        serve: false,
        decorateReply: true,
      });
    }

    app.get('/tiles/:filename', async (request, reply) => {
      if (!available) {
        sendTilesUnavailable(reply);
        return;
      }

      const { filename } = request.params as { filename: string };
      if (filename !== CONFIG.TILES_FILENAME) {
        sendTileNotFound(reply);
        return;
      }

      reply.header('Cache-Control', TILES_CACHE_CONTROL);
      await reply.sendFile(CONFIG.TILES_FILENAME, tilesDir, { cacheControl: false });
    });
  };
}
