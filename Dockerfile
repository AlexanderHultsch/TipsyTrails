# Build context: repository root.
# Used by the Raspberry Pi multi-site platform's compose (build: ./apps/tipsy-trails,
# no dockerfile: key) — produces one container serving both the API and the SPA.

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/api/package.json packages/api/package.json
COPY packages/web/package.json packages/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.base.json ./
COPY packages/api packages/api
COPY packages/web packages/web
COPY packages/shared packages/shared

ENV NODE_OPTIONS=--max-old-space-size=1536
RUN pnpm --filter @tipsytrails/shared build

RUN pnpm --filter @tipsytrails/web build
RUN pnpm --filter @tipsytrails/api build
RUN pnpm --filter @tipsytrails/api deploy --prod --legacy /app/deploy

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

# gosu, not su-exec: the platform's other sites are Alpine images and use
# su-exec for the same job, but this one is Debian. docker-entrypoint.sh
# drops to `node` with it (SPEC.md Section 4.3).
RUN apt-get update && apt-get install -y --no-install-recommends gosu && rm -rf /var/lib/apt/lists/*

# Everything the running container reads on boot, and where that read
# lives. Check this list when adding a new path a route or startup step
# reads — packages/api/src/docker-image.test.ts fails if it falls out of
# sync with what is actually copied below.
#   node_modules + dist  the compiled API                    (build stage)
#   migrations            applied by runMigrations() on boot   (startup.ts)
#   public                 the built SPA
#   data/seed              per-city grid + geojson             (routes/static-data.ts)
#   data/cities             <slug>.json city config             (db/seed-city.ts)
# package.json is not read at boot (CMD invokes dist/server.js directly) but
# this stage is a `pnpm deploy` output, not the source tree, so nothing
# named `npm run <script>` resolves here otherwise — SPEC.md Section 4.3's
# `docker compose exec tipsy-trails npm run seed:admin` needs it present.
COPY --from=build --chown=node:node /app/packages/api/package.json ./package.json
COPY --from=build --chown=node:node /app/deploy/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/api/dist ./dist
COPY --from=build --chown=node:node /app/packages/api/migrations ./migrations
COPY --from=build --chown=node:node /app/packages/web/dist ./public
COPY --chown=node:node data/seed ./data/seed
COPY --chown=node:node data/cities ./data/cities

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000
# Deliberately no `USER node` here: the platform creates the /data bind mount
# as root, so the container has to start as root to chown it. The entrypoint
# owns the privilege drop and execs the CMD as `node` via gosu — putting
# `USER node` back breaks the chown and returns the container to the boot
# crash loop this replaced (SPEC.md Section 4.3).
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
