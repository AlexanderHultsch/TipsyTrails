# Build context: repository root.

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
RUN pnpm --filter @tipsytrails/api build
RUN pnpm --filter @tipsytrails/api deploy --prod --legacy /app/deploy

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app/deploy/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/api/dist ./dist
COPY --from=build --chown=node:node /app/packages/api/migrations ./migrations

USER node
CMD ["node", "dist/server.js"]
