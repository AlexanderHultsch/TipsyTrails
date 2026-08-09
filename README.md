# Tipsy Trails

A location-based exploration game for Karlsruhe, Germany.

The city starts under fog. You clear it by walking through it. Bars stay hidden until you come within 100 m of one — then they are yours forever. Check in, stay 20 minutes, and the bar is mastered. Progress is measured as percentage of area explored, per district and city-wide, plus the number of bars you have mastered.

Self-hosted on a Raspberry Pi, reachable at `https://tipsytrails.ahultsch.com` through a Cloudflare Tunnel. No inbound ports, no third-party analytics, no stored movement trails.

## Status

**Phase 0 (foundation) is implemented.** Phases 1–8 are not built yet.

What exists today: a pnpm monorepo (`packages/shared`, `packages/api`,
`packages/web`); a Fastify API with a `GET /api/health` endpoint; SQLite
(WAL) with an idempotent migration runner; admin-account seeding from
environment variables; a placeholder React SPA shell; and a Docker Compose
stack (Caddy in front of the API) that serves the SPA and proxies the API.

The compose stack has not yet been built or run: the development environment
has no Docker daemon, so `docker compose config` is validated but the images
themselves are unproven. The first `docker compose up -d --build` on the Pi is
the real test.

[`SPEC.md`](SPEC.md) is the single source of truth: data model, game mechanics, API surface, design direction, and an eight-phase build plan with a Definition of Done per phase.

## Planned stack

React 18 + Vite + MapLibre GL and PMTiles on the client; Fastify on Node 22 with SQLite (WAL) on the server; Caddy in front, all in Docker Compose on a Raspberry Pi 4. No Postgres, no Redis, no ORM, no SSR.

## Design principles

- **Mobile-first.** Desktop is a fallback, never the design target.
- **A hand-drawn ink map.** Near-monochrome, one accent colour, generous with empty space.
- **Data minimisation as a constraint, not a feature.** Raw positions are processed in memory and discarded. Only derived state is persisted — which cells you revealed, which bars you discovered, when you visited. Never a trail.
- **No secrets in the repository.** `.env` is gitignored, `.env.example` documents every variable, the admin account is seeded from the environment.

## Running it locally

```
pnpm install

# frontend dev server (Vite)
pnpm --filter @tipsytrails/web dev

# API, compiled and run against the env vars in .env.example
pnpm --filter @tipsytrails/api build
pnpm --filter @tipsytrails/api start
```

To run the whole stack the way it actually deploys — Caddy in front of the
API, in Docker — see "Deploying" below and just point it at your own
machine; the compose file has no Pi-specific assumptions.

## Deploying

The Pi build happens on the Pi itself:

```
git clone https://github.com/AlexanderHultsch/TipsyTrails.git
cd TipsyTrails
cp .env.example .env
# fill in .env: SESSION_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD, etc.
docker compose up -d --build
```

Caddy publishes the API and SPA on `HTTP_PORT` (`.env.example`, default
`8080`). The pre-existing Cloudflare Tunnel on the Pi — already running,
configured outside this repository — points at that port. The tunnel itself
is not part of this compose stack.

## Licensing

Two licences, and the split matters:

- **Code** — [MIT](LICENSE). Fork it and run your own city.
- **Map data and everything derived from it** — `bars.json`, `districts.geojson`, `grid.bin`, and the `.pmtiles` extract are derived from OpenStreetMap and are therefore [ODbL](DATA-LICENSE). MIT does not cover them.

Map data © OpenStreetMap contributors.

## Repository layout

Described in Section 4.2 of the specification. Two directories are deliberately absent from a fresh clone: `data/db/` (the runtime SQLite database) and `data/tiles/` (the map extract, published as a GitHub Release asset because it is 30–80 MB — regenerate it with `scripts/extract-tiles.sh`). Tiles are not served yet in any case; that arrives in Phase 2.

## Contributing

The build plan is phase-gated: a phase is not finished until every Definition-of-Done item in its section passes, and `main` is never left in a broken state. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the local setup and verification commands, and read `SPEC.md` before opening a pull request.
