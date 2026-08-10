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
RUN pnpm --filter @tipsytrails/web build

RUN pnpm --filter @tipsytrails/shared build
RUN pnpm --filter @tipsytrails/api build
RUN pnpm --filter @tipsytrails/api deploy --prod --legacy /app/deploy

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

# Everything the running container reads on boot, and where that read
# lives. Check this list when adding a new path a route or startup step
# reads — packages/api/src/docker-image.test.ts fails if it falls out of
# sync with what is actually copied below.
#   node_modules + dist  the compiled API                    (build stage)
#   migrations            applied by runMigrations() on boot   (startup.ts)
#   public                 the built SPA
#   data/seed              per-city grid + geojson             (routes/static-data.ts)
#   data/cities             <slug>.json city config             (db/seed-city.ts)
COPY --from=build --chown=node:node /app/deploy/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/api/dist ./dist
COPY --from=build --chown=node:node /app/packages/api/migrations ./migrations
COPY --from=build --chown=node:node /app/packages/web/dist ./public
COPY --chown=node:node data/seed ./data/seed
COPY --chown=node:node data/cities ./data/cities

EXPOSE 3000
USER node
CMD ["node", "dist/server.js"]
