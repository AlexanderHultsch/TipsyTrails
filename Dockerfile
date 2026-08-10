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
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/api packages/api
COPY packages/web packages/web

ENV NODE_OPTIONS=--max-old-space-size=1536
RUN pnpm --filter @tipsytrails/web build

RUN pnpm --filter @tipsytrails/api build
RUN pnpm --filter @tipsytrails/api deploy --prod --legacy /app/deploy

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

COPY --from=build --chown=node:node /app/deploy/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/api/dist ./dist
COPY --from=build --chown=node:node /app/packages/api/migrations ./migrations
COPY --from=build --chown=node:node /app/packages/web/dist ./public

EXPOSE 3000
USER node
CMD ["node", "dist/server.js"]
