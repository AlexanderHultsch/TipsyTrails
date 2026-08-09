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
COPY packages/web packages/web
ENV NODE_OPTIONS=--max-old-space-size=1536
RUN pnpm --filter @tipsytrails/web build

FROM caddy:2-alpine
COPY --from=build /app/packages/web/dist /srv
COPY caddy/Caddyfile /etc/caddy/Caddyfile
