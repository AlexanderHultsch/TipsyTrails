# Tipsy Trails

A location-based exploration game for Karlsruhe, Germany.

The city starts under fog. You clear it by walking through it. Bars stay hidden until you come within 100 m of one — then they are yours forever. Check in, stay 20 minutes, and the bar is mastered. Progress is measured as percentage of area explored, per district and city-wide, plus the number of bars you have mastered.

Self-hosted on a Raspberry Pi, reachable at `https://tipsytrails.ahultsch.com` through a Cloudflare Tunnel. No inbound ports, no third-party analytics, no stored movement trails.

## Status

**Phases 0–4 are implemented.** Phases 5–8 are not built yet.

What exists today: a pnpm monorepo (`packages/shared`, `packages/api`,
`packages/web`); a Fastify API on SQLite (WAL) with an idempotent migration
runner; accounts, sessions, and a security-question password reset; the map —
MapLibre GL and PMTiles, code-split, in a hand-drawn ink style, with district
polygons and the city and district overview screens; fog of war — a per-user
bitmask revealed by walking, a WebGL layer with a 2D canvas fallback, and
per-district and per-day progress; and bars — 170 of them imported from
OpenStreetMap, discovered at 100 m, permanently visible once found.

Check-in and mastering (Phase 5) are specified but not built.

Three things are verified only as far as this development environment allows,
and are called out rather than glossed: the map extract has not been generated,
so nothing has rendered against real tiles; the fog shader has never been
compiled, because there is no GPU here — its layer class is tested against a
fake WebGL context, which proves the call sequence and nothing about the GLSL;
and no Docker image has been built, because there is no Docker daemon. What
*has* been verified is the server itself, booted from a hand-assembled copy of
the runtime image's file layout — it serves the API and the SPA, runs
migrations, seeds the admin account and the city data, and imports all 170 bars
against a real SQLite file. The first `docker build` and the first render on a
phone are the real tests, both still to happen on the Pi.

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

There are two deployment paths.

### The Pi (multi-site platform)

The Raspberry Pi that hosts `tipsytrails.ahultsch.com` runs several
unrelated projects, each as one container behind a single shared Caddy that
the platform — not this repository — owns and routes. The root `Dockerfile`
builds one image for that platform: the API serves the built SPA itself, on
`PORT`. The platform clones this repository, builds the image from the root
`Dockerfile`, and routes `tipsytrails.ahultsch.com` to the resulting
container through its own Caddy.

The container needs `PORT`, `DB_PATH`, `PUBLIC_ORIGIN`, and
`SESSION_SECRET` from the environment, and optionally `ADMIN_USERNAME` and
`ADMIN_PASSWORD` to seed the admin account. `SESSION_SECRET` must be at
least 32 characters, and the container refuses to start without
`PUBLIC_ORIGIN` and `SESSION_SECRET` set.

### Standalone (this repository's compose)

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

Described in Section 4.2 of the specification. Two directories are deliberately absent from a fresh clone: `data/db/` (the runtime SQLite database) and `data/tiles/` (the map extract, published as a GitHub Release asset because it is 30–80 MB). The API serves the extract from `TILES_DIR` with HTTP range support; without it the map routes have no basemap, and the tile route says so plainly instead of failing obscurely.

The city data under `data/seed/<slug>/` — boundaries, the cell grid, and the bars — is generated by the three scripts in `scripts/`, each parameterised by `data/cities/<slug>.json` so a second city needs a config file rather than a code change. See Section 11.4.

## Contributing

The build plan is phase-gated: a phase is not finished until every Definition-of-Done item in its section passes, and `main` is never left in a broken state. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the local setup and verification commands, and read `SPEC.md` before opening a pull request.
