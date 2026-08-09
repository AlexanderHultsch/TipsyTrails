# Tipsy Trails

A location-based exploration game for Karlsruhe, Germany.

The city starts under fog. You clear it by walking through it. Bars stay hidden until you come within 100 m of one — then they are yours forever. Check in, stay 20 minutes, and the bar is mastered. Progress is measured as percentage of area explored, per district and city-wide, plus the number of bars you have mastered.

Self-hosted on a Raspberry Pi, reachable at `https://tipsytrails.ahultsch.com` through a Cloudflare Tunnel. No inbound ports, no third-party analytics, no stored movement trails.

## Status

**Specification only — no implementation yet.**

[`SPEC.md`](SPEC.md) is the single source of truth: data model, game mechanics, API surface, design direction, and an eight-phase build plan with a Definition of Done per phase. Implementation starts at Phase 0.

## Planned stack

React 18 + Vite + MapLibre GL and PMTiles on the client; Fastify on Node 22 with SQLite (WAL) on the server; Caddy in front, all in Docker Compose on a Raspberry Pi 4. No Postgres, no Redis, no ORM, no SSR.

## Design principles

- **Mobile-first.** Desktop is a fallback, never the design target.
- **A hand-drawn ink map.** Near-monochrome, one accent colour, generous with empty space.
- **Data minimisation as a constraint, not a feature.** Raw positions are processed in memory and discarded. Only derived state is persisted — which cells you revealed, which bars you discovered, when you visited. Never a trail.
- **No secrets in the repository.** `.env` is gitignored, `.env.example` documents every variable, the admin account is seeded from the environment.

## Licensing

Two licences, and the split matters:

- **Code** — MIT. Fork it and run your own city.
- **Map data and everything derived from it** — `bars.json`, `districts.geojson`, `grid.bin`, and the `.pmtiles` extract are derived from OpenStreetMap and are therefore **ODbL**. MIT does not cover them.

The `LICENSE` and `DATA-LICENSE` files land in Phase 0 along with the rest of the scaffold.

Map data © OpenStreetMap contributors.

## Repository layout

Described in Section 4.2 of the specification. Two directories are deliberately absent from a fresh clone: `data/db/` (the runtime SQLite database) and `data/tiles/` (the map extract, published as a GitHub Release asset because it is 30–80 MB — regenerate it with `scripts/extract-tiles.sh`).

## Contributing

The build plan is phase-gated: a phase is not finished until every Definition-of-Done item in its section passes, and `main` is never left in a broken state. Read `SPEC.md` before opening a pull request.
