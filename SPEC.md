# Tipsy Trails — Technical Specification

**Version:** 1.44
**Status:** Built and deployed; see _Status_ at the end of this front matter
**Repository:** https://github.com/AlexanderHultsch/TipsyTrails
**Target host:** Raspberry Pi 4 Model B (4 GB), Raspberry Pi OS Lite 64-bit, Docker
**Public URL:** `https://tipsytrails.ahultsch.com` (via Cloudflare Tunnel)

---

## What this is

Tipsy Trails is a location-based exploration game for Karlsruhe, Germany, played in a mobile browser. The whole city starts under fog, and the only way to clear it is to physically walk: every position sample the app accepts uncovers the ground around you, permanently. Bars stay hidden until you come within 100 m of one. A bar is _mastered_ by checking in at it and still being there twenty minutes later. Progress is scored as percentage of the city explored and bars mastered, and each week, month and year the best player on each of those two metrics takes a badge.

**The loop, in six parts**

- **The fog grid.** The city is a fixed 50 m grid — 417 × 343 cells for Karlsruhe. Each player has one bit per cell, stored as a bitmask blob. Walking sets bits; nothing ever clears them.
- **Discovery.** An accepted sample within 100 m of a bar discovers it, permanently, and the map stamps a cocktail glass where that bar stands.
- **Check-in.** Discovery is generous on purpose; check-in is not. It is an explicit tap on that bar's own marker, enabled only within about 30 m, because Karlsruhe's centre puts bars a few metres apart and GPS cannot separate them.
- **Mastering.** Two accepted on-site samples at least twenty minutes apart complete the visit. The app does not have to stay open in between, which is what makes the mechanic survive a phone that sleeps.
- **Badges and the leaderboard.** A badge is a competition, not a participation award: the period's best player wins it, and nobody wins if nobody clears a floor that is never published. The public leaderboard ranks two metrics over three periods, and a player may appear under a masked handle.
- **The map.** MapLibre over a self-hosted PMTiles extract, drawn in a near-monochrome hand-drawn ink style, with the fog as a custom WebGL layer sitting above part of that style and below the rest.

**How it is built**

| Piece      | What it is                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------- |
| Shape      | pnpm workspace, three packages: `shared` (types and every constant), `api`, `web`                        |
| API        | Node 22 + Fastify + TypeScript; SQLite in WAL mode via `better-sqlite3`; sessions in a table, not JWTs   |
| Web        | React 18 + Vite + MapLibre GL; a PWA with one hand-written service worker                                |
| Data       | One SQLite file; committed GeoJSON and grid seed; a PMTiles extract that is never committed              |
| Deployment | One Docker container on a Raspberry Pi 4, behind the host platform's Caddy, reached by Cloudflare Tunnel |

**Where to look**

| Question                                                    | Section                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------ |
| What may I never do?                                        | 1 — Hard Constraints, non-negotiable                          |
| What is the product?                                        | 2                                                             |
| Which exact dependencies, and which commands?               | 3                                                             |
| How is it deployed, and what environment does it need?      | 4.3                                                           |
| What is in the database?                                    | 5                                                             |
| What is every number, and where does it live?               | 7.1 — `packages/shared/src/config.ts` and nowhere else        |
| How does the fog work?                                      | 7.3                                                           |
| How does check-in work?                                     | 7.5                                                           |
| What does each API route return, and with which status?     | 9                                                             |
| What is this supposed to look like?                         | 8.1 (direction), 8.3 (screens)                                |
| In what order was this built, and what proves each phase?   | 12                                                            |
| What is still wrong, unfinished, or deliberately left open? | 14                                                            |

**Section numbers are an interface, and they are frozen.** Code comments cite `Section N.N` 884 times across 45 distinct numbers — `7.3` alone 93 times, `8.1` 82, `8.3` 74, `7.5` 72. (The figures are illustrative of the scale and go stale with every block of work; they were 771 across 43 at v1.34 and had drifted to 844 before v1.41 added the rest.) Those citations are the codebase's index into this document, and nothing in the test suite would catch them breaking. Rewrite freely _inside_ a section; never renumber, merge, split, reorder or repurpose one. New material goes before Section 0, after Section 15, or under an unnumbered heading inside an existing section. The same applies to the `O`-numbers in Section 14, which code comments also cite.

**Status.** Phases 0 through 7 are built and deployed: the site answers on the public URL from the Pi, and Section 4.3 records that deployment in detail. Phase 8 is partly done — five of its Definition-of-Done items need a real phone, a real browser or the Pi under load, and are honestly left unticked rather than assumed. The map extract is not yet on the Pi's data volume, so `/tiles/*` currently serves the deliberate error of Section 13.2. Everything known to be missing, wrong, unverified or deliberately deferred is in Section 14 — including two gaps this document leaves open on purpose (O20, O21) rather than by omission.

Section 15 is the changelog, newest first. It records _what_ changed; the reasoning lives in the numbered sections, and nothing in the changelog needs to be read to rebuild the system.

---

## 0. How to use this document

This specification is the single source of truth for the implementing agent (Claude Code).

**Rules for the implementing agent:**

1. Do not deviate from Section 1 (Hard Constraints) under any circumstance. If a constraint blocks a task, stop and report instead of working around it.
2. Implement strictly phase by phase (Section 12). Do not start phase N+1 before every Definition-of-Done item of phase N passes.
3. All constants defined in this document must live in a single config module (`packages/shared/src/config.ts`), never inlined at call sites. This includes rate limits, radii, thresholds, tolerances, and timeouts.
4. If a requirement is ambiguous, consult Section 14 (Open Items). If it is not listed there, stop and ask. Do not invent product behaviour.
5. Every phase ends with a commit and a working deployment. Never leave `main` in a broken state.
6. **Unit rule.** The database stores every timestamp and duration in **seconds** (INTEGER, UTC epoch). Every constant in `config.ts` is in **milliseconds** or **metres**, as its name says. Conversion happens in exactly one place: the derived-constants block in `config.ts` (Section 7.1). Never convert ad hoc at a call site.

---

## 1. Hard Constraints

| # | Constraint |
|---|---|
| C1 | No inbound ports are opened on the home network. Public access is exclusively via Cloudflare Tunnel. |
| C2 | The Pi serves API + static assets only. No tile rendering, no image processing, no OCR, no heavy computation on the Pi. |
| C3 | No third-party analytics, trackers, ad networks, or CDN-hosted fonts. All assets are self-hosted. |
| C4 | No raw movement trails are stored. Only derived state (revealed grid cells) and visit records are persisted. See Section 10. |
| C5 | No photo upload, no image storage, no OCR anywhere in the system. |
| C6 | Secrets never enter the repository. `.env` is gitignored; `.env.example` documents every variable. |
| C7 | The database is a single SQLite file. Backups are handled by the existing Pi backup job — the implementing agent must not build a backup mechanism. |
| C8 | Everything is designed mobile-first. Desktop is a supported fallback, never the design target. |
| C9 | English only. All UI copy, code comments, commit messages, and identifiers are English. |
| C10 | The data model must be multi-city capable from day one (Section 5.1), even though only Karlsruhe is seeded in v1. |
| C11 | The repository is **public and open source** (Section 13). Every artefact needed to build and run the project from scratch must be reproducible from the repository alone. No user data, no runtime database, no secrets. |

---

## 2. Product Overview

Tipsy Trails is a location-based exploration game for the city of Karlsruhe, Germany.

The city map is fully covered by fog. Players reveal the map by physically walking through the city. Bars are hidden until a player comes within 100 m of them; once discovered they remain visible forever. A bar is "mastered" by checking in and remaining on site for at least 20 minutes.

Progress is measured as **percentage of area explored** (per district and city-wide) and **number of bars mastered**. Badges are a weekly, monthly, and yearly contest: each one goes to the period's top player, provided they clear a fixed floor that is never published (Section 7.7).

**Core loop:** walk → fog clears → hidden bars appear → check in → stay 20 minutes → bar mastered → progress and badges.

**Scale target:** ~10 concurrent users in v1; architecture must not prevent scaling to ~1,000 on a rented server later.

---

## 3. Technology Stack

| Layer | Choice | Rationale |
|---|---|---|
| Package manager | pnpm 10 (workspaces) | Fast, disk-efficient, first-class monorepo support |
| Frontend framework | React 18 + TypeScript + Vite | Small bundle, mature MapLibre bindings |
| Map renderer | MapLibre GL JS v4 | GPU-accelerated vector rendering, no license cost |
| Tile format | PMTiles (Protomaps) v3 | Single static file, HTTP range requests, CDN-cacheable, offline-capable |
| Fog rendering | MapLibre custom WebGL layer | See Section 7.3 |
| PWA | A hand-written service worker, no build plugin | Installable, offline shell, Web Push on iOS ≥ 16.4 |
| Backend | Node 22 LTS + Fastify + TypeScript | Low memory footprint, fast JSON. Node 20 leaves LTS maintenance in April 2026 — do not pin to it. |
| Database | SQLite (WAL mode) via `better-sqlite3` | Single-file backup, zero admin overhead, sufficient for target scale |
| Password hashing | argon2id | Current best practice |
| Sessions | Signed httpOnly cookies, server-side session table | Simpler and safer than JWT here |
| Web Push | `web-push` (VAPID) | No third-party service required |
| Validation | `zod` | Single schema source for route boundary + shared types |
| Reverse proxy | Caddy (in Docker) | Automatic compression, static file serving, simple config |
| Containerization | Docker Compose | Matches existing Pi setup |
| Public access | Cloudflare Tunnel (`cloudflared`) | Existing infrastructure |

**Explicitly excluded:** PostgreSQL/PostGIS, Redis, any ORM, server-side rendering, native app wrappers, email sending.

**There is no PWA build plugin, and that is not an omission.** The service worker is `packages/web/public/sw.js`, written by hand and shipped as a static asset; Section 4.1 says why there is exactly one of them and what it may never intercept. The point here is only that a rebuilder must not reach for `vite-plugin-pwa` or Workbox. This row named `vite-plugin-pwa` from v1.1 until v1.34 and was never true of the built system.

`better-sqlite3` is a native module. The API Dockerfile must either use the published arm64 prebuild or install build tools in a build stage that does not ship in the final image. A build that silently compiles from source on every `docker compose build` is a defect.

**Exact dependencies.** The table below is the whole of every `package.json` in the workspace, so that a rebuilder can write them without guessing. These are the ranges the manifests carry, not resolved versions; `pnpm-lock.yaml` is the record of what they resolved to.

| Manifest | Field | Contents |
|---|---|---|
| root | `packageManager` / `engines` | `pnpm@10.33.0` / `node >=22` |
| root | devDependencies | `@eslint/js` ^10.0.1, `eslint` ^10.8.1, `eslint-config-prettier` ^10.1.8, `globals` ^17.9.0, `prettier` ^3.9.6, `typescript` ~6.0.3, `typescript-eslint` ^8.66.0, `vitest` ^4.1.10 |
| `shared` | dependencies | **absent — the block does not exist, deliberately** (see below) |
| `shared` | devDependencies | `@types/node` ^26.2.0 |
| `api` | dependencies | `@fastify/cookie` ^11.1.2, `@fastify/static` ^10.1.3, `@node-rs/argon2` ^2.0.2, `@tipsytrails/shared` `workspace:*`, `better-sqlite3` ^13.0.3, `fastify` ^5.11.3, `web-push` ^3.6.7, `zod` ^4.4.3 |
| `api` | devDependencies | `@types/better-sqlite3` ^9.6.0, `@types/node` ^26.2.0, `@types/web-push` ^3.6.4 |
| `web` | dependencies | `@tipsytrails/shared` `workspace:*`, `maplibre-gl` ^4.7.1, `pmtiles` ^4.4.1, `react` ^18.3.1, `react-dom` ^18.3.1, `react-router-dom` ^7.18.2 |
| `web` | devDependencies | `@types/node` ^26.2.0, `@types/react` ^18.3.31, `@types/react-dom` ^18.3.7, `@vitejs/plugin-react` ^6.0.5, `jsdom` ^30.0.1, `vite` ^8.2.1 |

Two rows of that table are traps, and each has a wrong answer that looks right.

- **argon2id comes from `@node-rs/argon2`, not from the `argon2` package.** A rebuilder told only "argon2id" (Section 10.1) reaches for the other native module, which is a different build story on arm64 and a different API.
- **`packages/shared` has no `dependencies` block at all.** Zero runtime dependencies is a property of that package rather than an accident of nothing having been needed yet: it is imported by the API, by the browser bundle, and by the offline build scripts, so anything it depends on is dragged into all three at once. Adding one there is a decision about the whole system, not about one module.

`packages/shared` and `packages/api` resolve modules as NodeNext, so their relative imports carry an explicit `.js` extension even though the source file is `.ts`. `packages/web` is bundled by Vite and does not.

**Commands.** These are the root scripts, and they are the only ones the workflow depends on:

| Command | Does |
|---|---|
| `pnpm build` | Builds `shared`, then `api`, then `web`, in that order |
| `pnpm typecheck` | `tsc --noEmit` in every package, after a `pretypecheck` build of `shared` |
| `pnpm lint` | `eslint .` across the workspace |
| `pnpm format:check` | `prettier --check .` — note that `SPEC.md` and `README.md` are in `.prettierignore` and are **not** checked |
| `pnpm test` | `vitest run` in every package, after a `pretest` build of `shared` |

Two per-package scripts are load-bearing outside development: `api`'s `start` (`node dist/server.js`) is the container's `CMD`, and `api`'s `seed:admin` (`node dist/db/seed-admin-cli.js`) is what the Pi's deploy step invokes (Section 4.3).

**`packages/api` and `packages/web` resolve `@tipsytrails/shared` through a gitignored `dist`, so the shared build has to run before anything reads it.** The root `package.json` runs it as `pretest` and `pretypecheck` as well as `prepare`. Without that, a signature-preserving change to a shared rule leaves `pnpm typecheck` at zero errors and the suite green, because both were reading the *previous* build off disk.

One gap there is accepted rather than closed: a single package's tests invoked directly (`pnpm --filter @tipsytrails/api test`) bypass both hooks and can still read a stale `dist`. The four root commands above are the authoritative ones for exactly that reason.

---

## 4. Architecture

```
                    ┌──────────────────────────┐
Mobile browser ────▶│  Cloudflare (edge cache) │
                    └────────────┬─────────────┘
                                 │ Tunnel (outbound only)
                    ┌────────────▼─────────────┐
                    │  Raspberry Pi 4          │
                    │  ┌────────────────────┐  │
                    │  │ Caddy              │  │
                    │  │  /            → SPA│  │
                    │  │  /tiles/*     → pmt│  │
                    │  │  /api/*       → API│  │
                    │  └─────────┬──────────┘  │
                    │  ┌─────────▼──────────┐  │
                    │  │ Fastify API (Node) │  │
                    │  └─────────┬──────────┘  │
                    │  ┌─────────▼──────────┐  │
                    │  │ SQLite (WAL)       │  │
                    │  └────────────────────┘  │
                    └──────────────────────────┘
```

### 4.1 Caching strategy

Cache aggressively at the Cloudflare edge so the Pi handles almost no repeat traffic.

| Path | Cache-Control | Notes |
|---|---|---|
| `/assets/*` (hashed) | `public, max-age=31536000, immutable` | Vite content hashing |
| `/tiles/karlsruhe.<version>.pmtiles` | `public, max-age=2592000` | Range requests must be allowed; 9.4 MB measured for Karlsruhe, fetched in small ranges |
| `/static/districts.json` | `public, max-age=86400` | District polygons, simplified |
| `/index.html`, `/manifest.json`, `/sw.js` | `public, max-age=0, must-revalidate` | The service worker controls the whole app shell (Section 4.1, below); pinned the same as the shell document rather than left to an intermediary |
| `/icons/*` | `public, max-age=86400` | Referenced from the manifest, not content-hashed, changes rarely — same reasoning as `/static/districts.json` above, not the shell's must-revalidate treatment |
| `/api/*` | `private, no-store` | Never cached |

Two things Cloudflare does not do by default and that must be configured explicitly:

- **The tile file must be cached by a Cache Rule.** Cloudflare's default cache does not include `.pmtiles`. Without a rule matching `/tiles/*`, every range request reaches the Pi and the Phase 2 `cf-cache-status: HIT` check will never pass.
- **The tile filename carries a version segment** (`karlsruhe.2026-08.pmtiles`), because a 30-day immutable-ish cache on a stable filename makes regenerated tiles unreachable for a month. The current filename lives in `config.ts` and is referenced by both the Caddyfile and the client.

Range requests on the tile path are not an optimisation; they are mandatory. PMTiles works by fetching small byte ranges out of one large file — a server that ignores the `Range` header forces the client to download the whole extract on every map view, which defeats the point of the format. Whatever serves `/tiles/*` must answer `206 Partial Content` to a ranged request, and this is verified directly (Section 12, Phase 2 Definition of Done), not inferred from the serving library.

**Which component sets the `Cache-Control` value depends on the deployment** (Section 4.3), and the value itself is the same either way — only who applies it differs.

- Standalone two-container path: Caddy sets it when serving the file from disk, as the diagram above shows.
- Single-container deployment on the Pi (v1.2.2): there is no Caddy of ours in front of the API, so the API sets `Cache-Control: public, max-age=2592000` on `/tiles/*` itself, the same way it already sets headers for hashed assets and `index.html` (`packages/api/src/app.ts`).

The Cloudflare Cache Rule above is edge configuration and is required in both deployments, whichever origin component sets the header.

Client-side: district polygons, grid metadata, and the bar catalogue are cached in IndexedDB with an ETag-based revalidation on app start.

**There is exactly one service worker, and it owns both jobs.** A scope can have only one; registering a second silently replaces the first, and which one wins depends on load order rather than on anything readable in the source. So the offline shell (Phase 8) and Web Push (Phase 5) live in a single `packages/web/public/sw.js` — hand-written, with no build plugin behind it (Section 3).

Both registration sites — the eager registration on app start and `usePushSubscription`'s `enable()` — import one `SERVICE_WORKER_URL` constant rather than each naming a filename, so a second competing URL cannot be reintroduced by one call site drifting from the other.

Its fetch handler **never** intercepts `/api/*`: those responses are `private, no-store`, and a cached one on a shared device is a privacy problem, not a cache hit.

### 4.2 Repository structure

```
TipsyTrails/
├── Dockerfile                    # single-container image, the one the Pi builds — see 4.3
├── docker-entrypoint.sh          # root → mkdir → chown → gosu node, see 4.3
├── docker-compose.yml            # standalone two-container path only
├── pnpm-workspace.yaml
├── .env.example
├── .gitignore
├── .prettierignore               # SPEC.md and README.md are listed here
├── README.md
├── SPEC.md                       # this document
├── LICENSE                       # code licence, see Section 13.3
├── DATA-LICENSE                  # ODbL notice for OSM-derived artefacts
├── CONTRIBUTING.md
├── CLAUDE.md                     # agent guardrails, see Section 0
├── caddy/Caddyfile               # standalone two-container path only
├── packages/
│   ├── shared/                   # types + config constants, imported by both sides
│   ├── api/
│   │   ├── src/
│   │   ├── migrations/
│   │   └── Dockerfile
│   └── web/
│       ├── src/
│       ├── public/
│       └── Dockerfile
├── data/
│   ├── cities/                   # committed: <slug>.json, one per city — the pipeline's config seam, see 11.4
│   ├── seed/
│   │   └── karlsruhe/             # committed: bars.json, districts.geojson, neighbours.geojson, grid.bin, grid-meta.json
│   ├── tiles/                    # gitignored: *.pmtiles (GitHub Release asset)
│   └── db/                       # gitignored: tipsy.db, WAL, SHM — runtime only
└── scripts/
    ├── fetch-boundaries.ts       # Overpass → city outline, districts, neighbours (GeoJSON), see 11.4
    ├── build-grid.ts             # precompute cell→district mapping + playable_cells
    ├── import-osm-bars.ts        # one-off Overpass import → data/seed/<slug>/bars.json
    ├── rebuild-grid.ts           # stub, see O3
    └── extract-tiles.sh          # produce <slug>.<version>.pmtiles
```

### 4.3 Deployment

This section is long because the Pi's platform is not ours and every detail of it had to be established from evidence. It runs in this order: the two paths, the environment contract, the images, then the platform contract — provenance, registration, what `deploy.sh` does, storage, privileges, TLS, and tiles.

#### The two paths

There are two deployment paths. The diagram in Section 4 and this repository's own `docker-compose.yml` / `caddy/Caddyfile` describe the standalone, two-container path — unaffected by anything below and correct for anyone self-hosting outside the Pi. The single-container path is what actually runs on the Pi, and it is everything from *The Pi platform* onwards.

#### The environment contract

Every variable the API reads, in one place. `packages/api/src/env.ts` validates all of them at boot with `zod` and throws naming the offending variables, so a misconfiguration is a startup failure rather than a confusing symptom later. `.env.example` documents the same set with prose and never a value (C6).

| Variable | Shape | Required | Default |
|---|---|---|---|
| `NODE_ENV` | `development` \| `production` \| `test` | no | `development` |
| `API_HOST` | string | no | `0.0.0.0` |
| `API_PORT` | integer 1–65535 | no | `3000` |
| `PUBLIC_ORIGIN` | URL with an `http:` or `https:` protocol | **yes** | — |
| `DATABASE_PATH` | non-empty string | **yes** | — |
| `SESSION_SECRET` | string, at least 32 characters | **yes** | — |
| `ADMIN_USER` | string | no | — (no admin seeded without it) |
| `ADMIN_PASSWORD` | string | no | — (no admin seeded without it) |
| `WEB_ROOT` | path to the built SPA | no | `../public` relative to the compiled server |
| `SEED_DIR` | path to the committed `data/seed` tree | no | `../../data/seed` relative to the compiled server |
| `TILES_DIR` | directory holding the PMTiles extract | no | `/data/tiles` |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | strings | no | — (all three or none, Section 5.9) |
| `ADMIN_TELEPORT_ENABLED` | exactly `true` or `false` | no | — (unset = the teleport route is not registered, Sections 9.3, 10.1) |

**`ADMIN_TELEPORT_ENABLED` is a kill switch, and its absence is the whole of it.** Without it set to `true`, `buildApp` never registers the admin teleport plugin, so `POST /api/admin/teleport` is a route the server does not have: an unmatched `/api/*` path answering 404 (Section 9.5's first documented envelope exception), not a route that exists and refuses. That is deliberate — a 403 would tell a stolen admin session that there is something there. The code ships inert and a production deployment leaves the variable out.

It is validated as an enum rather than tested for truthiness, for the reason `API_PORT` is range-checked: `1`, `yes`, `on` and `TRUE` are all things an operator would type meaning "on", and every one of them would silently leave the feature off. They fail at boot naming the variable instead. `false` is accepted as a second, explicit way to say off, so a `.env` can record the answer rather than omit it.

Four of those checks are stricter than "is it a string", and each is deliberate. `PUBLIC_ORIGIN` is protocol-checked because a `ftp:` or `javascript:` value fails three unrelated things much later and none of them names the variable — the session cookie silently loses its `secure` flag, every state-changing request is refused for a mismatched `Origin`, and Web Push turns itself off. `API_PORT` is range-checked because `app.listen` is otherwise what fails, as a `RangeError` about a value the operator never typed. `SESSION_SECRET`'s length is checked for what it has to *mean*, not for what it has to look like.

**Two variables carry an alias, and the precedence is not symmetrical.** The Pi's platform supplies `PORT` and `DB_PATH` to every container it runs, so both names are accepted:

| Primary | Alias | Rule |
|---|---|---|
| `API_PORT` | `PORT` | `API_PORT` wins when both are set |
| `DATABASE_PATH` | `DB_PATH` | `DATABASE_PATH` wins when both are set |

For both, an **empty string counts as unset**, so an alias still applies when the primary name is present but blank — which is what a compose file that declares a variable without a value produces. `docker-entrypoint.sh` mirrors the same two rules when it decides which directory to create, because it runs before the app and cannot ask it.

One further variable is not part of this contract: `HTTP_PORT` in `.env.example` is read by the standalone `docker-compose.yml` to choose the host port Caddy publishes. The application never sees it.

#### The images and what runs in them

Three Dockerfiles, and only one of them matters on the Pi.

| File | Used by | Produces |
|---|---|---|
| `Dockerfile` (root) | the Pi platform's `build: ./apps/tipsy-trails` | one container serving the API **and** the built SPA |
| `packages/api/Dockerfile` | standalone `docker-compose.yml` | the API alone, `USER node`, no entrypoint script |
| `packages/web/Dockerfile` | standalone `docker-compose.yml` | a `caddy:2-alpine` image with the built SPA at `/srv` |

All three are multi-stage and all three build on the Pi's own arm64; the frontend build stage runs there either way. The root image's build stage is `node:22-bookworm-slim`, installs with `pnpm install --frozen-lockfile --ignore-scripts`, builds `shared` then `web` then `api`, and produces a production node_modules tree with `pnpm --filter @tipsytrails/api deploy --prod`. Its runtime stage copies exactly five things into `/app`, and each is read at boot by something named here:

| Copied to `/app` | Read by |
|---|---|
| `node_modules`, `dist` | the compiled API itself; `CMD` is `node dist/server.js` |
| `migrations` | `runMigrations()` at boot (Section 5) |
| `public` | the SPA the API serves through `@fastify/static` (`WEB_ROOT`'s default) |
| `data/seed` | `GET /static/<slug>/<filename>` and the grid load at boot (`SEED_DIR`'s default) |
| `data/cities` | the `cities` row seeding (Section 11.4) |
| `package.json` | nothing at boot — but `npm run seed:admin` needs it to resolve |

`packages/api/src/docker-image.test.ts` fails if that list falls out of step with the Dockerfile, which is what stops a route being added that reads a path the image never copies.

The runtime stage deliberately does **not** end with `USER node`; the entrypoint owns the privilege drop, for the reason given under *Storage* below.

#### The Pi platform

**Provenance.** What follows comes from the platform's real files — `sites.conf`, `scripts/deploy.sh`, `docker-compose.yml` and `config/caddy/Caddyfile` — pasted verbatim from the running Pi by the repository owner on 2026-08-19. That is the provenance, and it is the whole of it.

The platform repository (`AlexanderHultsch/PiMultiServiceServer`) has never been readable from any session working on this repository. Every description of it before this one, v1.10's included, was assembled second-hand from a summary relayed through another chat, and several of its details were wrong; those corrections are below and are listed in the v1.11 changelog. Where a question matters and the pasted files do not answer it, it is marked open here rather than filled in.

#### Registering the site

**Registration takes three files, not one.** `sites.conf`'s own header is explicit about it: *"WICHTIG: Neue Zeile hier genuegt NICHT allein - der Dienst muss auch in docker-compose.yml und config/caddy/Caddyfile stehen"* — a new line in `sites.conf` alone is not enough; the service must also appear in the platform's `docker-compose.yml` and in `config/caddy/Caddyfile`.

The Caddyfile's final rule is `handle { respond "Not found" 404 }`, so a hostname no block matches returns 404. Without its Caddy block this site is unreachable from outside even when its container is healthy and its compose service is correct. The three exact blocks are given below.

The platform's `~/pi-server/sites.conf` carries one line per site, four whitespace-separated fields — `name repo_url host admin`, and no port field:

- `name` is both the directory under `apps/` and the service name in the platform's `docker-compose.yml`. This app's is `tipsy-trails`.
- `host` is a **subdomain label, not a hostname** — the file's own example is `winecashing` → `winecashing.<DOMAIN>`, with the literal `apex` reserved for the main domain itself. This app's value is `tipsytrails`, never `tipsytrails.ahultsch.com`.
- `admin` is `yes|no`. `yes` means the site takes the shared admin account and has `seed:admin` run against it. This app's value is `yes`.

`sites.conf` is maintained **only on the platform checkout's `env` branch** — its header says so, because it points at private repositories and does not belong on the generic `main` branch — and the Pi's checkout is on `env` today.

**As of 2026-08-19 this site is registered in all three files and running.** The container is up, the root `Dockerfile` builds on the Pi's own arm64, migrations and startup complete, the server logs `Server listening at http://172.19.0.3:3000`, and the site answers from outside: `curl https://tipsytrails.ahultsch.com/api/health` returns `{"status":"ok"}` and a browser loads the PWA shell over that hostname.

It took two deploys. The first crash-looped on `EACCES: permission denied, mkdir '/data/db'` against the root-owned data volume — exactly the failure *Storage* below describes and the root-then-`gosu` entrypoint resolves. The second, with that entrypoint in place, came up and stayed up. Two things are still outstanding: the map extract is not on the volume, so `/tiles/*` answers with the error Section 13.2 specifies, and the admin account has not yet been confirmed by signing in.

#### What `deploy.sh` does

Deployment is a local build, not a registry pull: the platform's own `docker-compose.yml` carries `build: ./apps/<name>` per site, and `deploy.sh` runs `docker compose up -d --build`. The `Dockerfile` this builds is the one at this repository's **root** — not `packages/api/Dockerfile` or `packages/web/Dockerfile`, which serve only the standalone path — and it must sit there for the platform to find it.

`PORT` is not a `sites.conf` field. It is set per service in the platform's `docker-compose.yml` and matched by the Caddyfile's `reverse_proxy` target. Both of ginperium's blocks use `3000`, and the blocks below follow them.

**One deploy run is all-or-nothing, across every site.** `deploy.sh` accepts exactly two options — `--fresh` and `--set-password` — and exits 1 on anything else. There is no single-site mode: every run pulls, rebuilds and restarts every site in `sites.conf`, so this site cannot be deployed on its own.

Two failure modes follow from that, and they are opposites. The build step, `docker compose up -d --build`, runs once for the whole compose file with no `||` guard under `set -euo pipefail` — so a failing image build, this site's included, aborts the entire run, every other site's rebuild and the closing `docker compose restart caddy` with it. The per-site `git pull --ff-only`, by contrast, only warns on failure (`WARN: pull fehlgeschlagen`) and then builds whatever is already on disk: a branch that has diverged or been force-pushed deploys **stale code while the run reports success**.

**What `admin: yes` actually does.** `deploy.sh` writes `apps/tipsy-trails/.env` on every deploy, containing *exactly three* variables — `SESSION_SECRET`, `ADMIN_USER` (not `ADMIN_USERNAME`), `ADMIN_PASSWORD` — as a full overwrite (`>`) each time. Only `SESSION_SECRET` survives a redeploy: `deploy.sh` reads the value already in the file back out before overwriting, and writes the same value back. `ADMIN_USER` and `ADMIN_PASSWORD` come from a single shared `~/pi-server/admin.env`, one credential pair reused across every `admin: yes` site on the Pi, written interactively on the first run and by `--set-password` thereafter.

This is not a shared user store. Nothing in `deploy.sh` does more than supply those three values — no user table, no hashing of its own. This app's `users` table (Section 5.3) and its argon2id hashing are entirely its own, untouched by the platform.

**Everything else is manual, and it persists — unlike the three values above.** `PUBLIC_ORIGIN` and any other variable this app needs is *not* written by `deploy.sh`. It must be added by hand to the platform's own `docker-compose.yml`, in this site's `environment:` block, the same place `PORT` and `DB_PATH` already live for the Pi's other sites. `deploy.sh` never touches `docker-compose.yml`, so values placed there survive every redeploy undisturbed.

This app refuses to boot without `PUBLIC_ORIGIN`, so it goes in that block by hand, exactly as the service block below shows it.

**The `env_file:` line is not optional, and it is easy to miss.** `deploy.sh` writes the three admin variables into `apps/tipsy-trails/.env` on the host, and nothing carries that file into the container unless the service block names it. The Pi's ginperium service does exactly this (`env_file: ./apps/ginperium/.env`, commented there as the secrets file that lives only on the Pi).

Leave the line out and `SESSION_SECRET`, `ADMIN_USER` and `ADMIN_PASSWORD` never reach the process at all — and `SESSION_SECRET` is required, so the container does not boot. Note also that the platform writes `environment:` in map syntax with the port quoted, not list syntax.

**The three blocks that register this site.** Derived from the Pi's own ginperium blocks, changing only what must change, so nothing has to be invented at the Pi. On the platform checkout's `env` branch, one line in `~/pi-server/sites.conf`:

```
tipsy-trails    https://github.com/AlexanderHultsch/TipsyTrails.git    tipsytrails   yes
```

The service block in `~/pi-server/docker-compose.yml`, alongside the other sites' — note the absent `ports:`, which is what keeps the container reachable only through Caddy:

```yaml
  tipsy-trails:
    build: ./apps/tipsy-trails
    restart: unless-stopped
    environment:
      PORT: "3000"
      DB_PATH: /data/db/tipsy.db
      PUBLIC_ORIGIN: https://tipsytrails.ahultsch.com
    env_file: ./apps/tipsy-trails/.env
    volumes:
      - ./data/tipsy-trails:/data
    networks: [edge]
```

And the block in `~/pi-server/config/caddy/Caddyfile`, which must come before the fallback `handle` that answers 404:

```
@tipsy-trails host tipsytrails.{$DOMAIN}
handle @tipsy-trails {
        reverse_proxy tipsy-trails:3000
}
```

The repository URL is `TipsyTrails.git`; `Tipsy-Trails` is an old name that survives only as a redirect. `DB_PATH` is nested (`/data/db/tipsy.db`) where the Pi's other sites use a flat `/data/<name>.db`; that is safe, because both `packages/api/src/startup.ts` and `packages/api/src/db/seed-admin-cli.ts` create the directory recursively.

**The seed script must exist, and if it fails it fails silently.** After bringing containers up, `deploy.sh` runs, for every `admin: yes` site, `docker compose exec -T "${name}" npm run seed:admin || echo "  WARN: seed:admin fehlgeschlagen"` — with `-T`, no TTY allocated, and with a `|| echo` that handles the failure so `set -e` never fires.

A missing or failing `seed:admin` therefore does **not** abort the deploy: it prints that one warning line and the run continues to `docker compose restart caddy`. That is worse than a loud abort, not better. The site comes up, its pages load, and it has no working admin account, with nothing marking the difference but a German warning in a log nobody may read. (What *does* abort every site's deploy is the preceding `docker compose up -d --build`.)

`packages/api/package.json` must define this script, and it must be **idempotent**. This app already seeds the admin account at boot (`initialiseDatabase`, Section 13.4 — a no-op once a user with that username exists), so `seed:admin` has to be safe to run in addition to that on every single deploy, not a replacement for it.

It is also **self-sufficient**: it creates the database directory, runs the same migrations, then calls the same seeding insert, and exits 0 whether it seeded or found the account already there — the one case it exits nonzero for is the absent-credentials one below. It has to be, because `docker compose up -d` returns before boot-time setup has finished, so the script cannot assume any of it happened. Running those migrations alongside the booting server is safe for two reasons: `runMigrations` takes the write lock before it decides what to apply, and `openDatabase` retries the WAL journal-mode change — that pragma does not go through SQLite's busy handler, so two processes opening a brand-new database would otherwise collide there before any migration runs.

#### Rotating the shared password: `seed:admin -- --rotate-password`

This part of the contract is written for whoever maintains `deploy.sh` and has never read this codebase. Everything it needs is here.

**The problem it solves.** A plain `npm run seed:admin` creates the admin account if it is missing and otherwise changes nothing at all — deliberately, because it also runs on every boot. So the shared credential from `~/pi-server/admin.env` reaches this app exactly once, when the account is first created. A later `deploy.sh --set-password` writes the new password into `apps/tipsy-trails/.env`, the ordinary `seed:admin` runs, finds the account already there, and leaves the old password in place. The Pi's other `admin: yes` sites report a change; this one silently does not, and the operator's next sign-in here fails with the credential the platform believes it just set everywhere.

**The invocation.**

```
docker compose exec -T tipsy-trails npm run seed:admin -- --rotate-password
```

The `--` before the flag is npm's argument separator and is **required**: without it npm consumes `--rotate-password` as its own option and the script never sees it — which is the silent no-op again, so it is worth getting right in one place rather than debugging on the Pi. The flag's spelling is exactly `--rotate-password`, all lower case, one hyphen between the two words; it takes no value, and `--rotate-password=true` is not accepted.

**What it does.** With the flag, if the account is missing it is created exactly as without the flag; if the account exists, its stored password hash is rewritten from the current `ADMIN_PASSWORD`. Nothing else about the account is touched — not `must_change_password` (Section 5.3 explains why that stays 0), not `is_admin`, not the security question or its answer hash. Without the flag, an existing account's password is never written, on any run, by any means.

**Pass the flag only from `--set-password`.** An ordinary `deploy.sh` run must keep using the plain form. The reason is that this app lets an admin change their own password from inside the app, and nothing inside the container can tell "the operator rotated `admin.env`" apart from "the admin changed it themselves": in both cases the stored hash simply stops matching `ADMIN_PASSWORD`. Rotating on every deploy would therefore revert a self-chosen password on the next deploy, and so would the tempting-looking rule "rotate only when the stored password differs from `ADMIN_PASSWORD`" — that is the same bug in a disguise, because a self-changed password *is* the differing case. Which of the two happened is only knowable outside the container, at the moment the operator types `--set-password`, which is why it is an argument at that call site and nothing else.

**Do not turn it into an environment variable.** A variable left behind in `apps/tipsy-trails/.env` would rotate on every deploy and reintroduce exactly the overwrite the flag exists to make deliberate. An argument cannot become sticky.

**Exit codes, and what the `|| echo` will actually catch.** Four outcomes, one message each — no two share a sentence, so a log line says which of the four happened without anyone having to shell into the container to find out. The first three print on stdout and exit 0; the fourth prints on stderr and exits 1.

```
exit 0  seed:admin: created the admin account (<user>).
exit 0  seed:admin: updated the password of the admin account (<user>) from ADMIN_PASSWORD.
exit 0  seed:admin: the admin account (<user>) already exists and its password was
        left unchanged. Re-run with --rotate-password to set it from ADMIN_PASSWORD.
exit 1  seed:admin: ADMIN_USER and/or ADMIN_PASSWORD are not set, so no admin account
        was created or updated. For a site registered admin: yes this is a
        misconfiguration - check the env_file: line in the platform's
        docker-compose.yml and the site's .env.
```

The second line is reachable only with `--rotate-password`. Only the last exits non-zero, and that is the case the warning line is for: for an `admin: yes` site it means `deploy.sh` wrote the `.env` and it did not reach the process — usually a missing `env_file:` line in the platform's `docker-compose.yml`. "Already exists, not rotated" is the outcome of every ordinary deploy of a healthy site and must not warn, or the operator sees the warning on every run and stops reading it.

Never printed, on any path: the password itself or its hash. The username is printed, and it is already in clear in `admin.env` and the site's `.env`.

**A mistyped argument aborts the run.** `--rotate-passwrod`, `-r`, or any other argument makes the script exit non-zero and touch nothing — it does not even open the database. It is not ignored, because a rotation the operator asked for and quietly did not get is the entire failure this flag exists to eliminate.

#### Storage

**The data volume.** `./data/tipsy-trails:/data` on the platform side — host `~/pi-server/data/tipsy-trails/`, container `/data`, created by Docker on first start. `DATABASE_PATH`/`DB_PATH` (`/data/db/tipsy.db`) lives under it. So does the map extract: `TILES_DIR`'s default of `/data/tiles` already resolves correctly under this layout with no configuration change, so the extract belongs at host `~/pi-server/data/tipsy-trails/tiles/<filename>`.

**`deploy.sh --fresh` destroys that entire volume before rebuilding** — `sudo rm -rf data/tipsy-trails`. For a site on this Pi whose `/data` is a cache, that costs nothing. Here it is the database and the tile extract: every account, all fog progress, every mastered bar. There is no separate backup for it beyond whatever C7's existing Pi backup job already covers. `--fresh` against this site is data loss, not a reset.

**That volume belongs to root, so the container starts as root and drops privileges itself.** `~/pi-server/data/` is root-owned on the Pi — the owner cannot even `mkdir` inside it from his own shell — so Docker creates `data/tipsy-trails/` as root too. A container running as `node` against it cannot create `/data/db` at all: `initialiseDatabase`'s `mkdirSync` fails with EACCES and the container restart-loops behind a 502.

The root `Dockerfile` therefore does not end with `USER node`. It installs `gosu`, and `docker-entrypoint.sh` runs as root and does four things in order: create the database directory (the dirname of `DATABASE_PATH`/`DB_PATH`), create `TILES_DIR`, `chown -R node:node /data` — which also rescues a `.pmtiles` extract copied in by hand as another user — and then `exec gosu node "$@"`, so the server runs unprivileged as PID 1's successor and receives signals normally. This is the shape the platform's other two sites already use; they are Alpine images and reach for `su-exec` where this Debian one uses `gosu`. `packages/api/src/docker-image.test.ts` fails if any part of that arrangement is removed.

One consequence is worth stating: `docker compose exec tipsy-trails npm run seed:admin` does **not** run the entrypoint, so that command runs as root. That is harmless — the server already holds the SQLite connection open and its WAL files exist by then — and self-healing regardless, because the next boot chowns `/data` again.

#### TLS, proxies, and tiles

**TLS.** Caddy terminates none; Cloudflare's edge does. The full chain is browser → Cloudflare edge → Cloudflare Tunnel → the `cloudflared` container → Caddy → this app's container.

What the pasted `Caddyfile` excerpt covers is one site's `handle` block and the 404 fallback, and nothing else, so it settles none of the file's global options. Whether `auto_https` is off, and whether `trusted_proxies` or a `header_up` override for `X-Forwarded-For` is configured, are open questions against this evidence; earlier versions of this section asserted all three, on second-hand information. That bears directly on Section 9.4's `trustProxy` setting, which stays recorded as unverified rather than settled (O10, Section 14).

**Tile serving.** The extract is not in the image: Section 13.1 forbids committing it, and a regenerated extract must not require rebuilding the image either. It lives on the same persistent data volume as the database, under `TILES_DIR`, and the path the API reads is `${TILES_DIR}/${CONFIG.TILES_FILENAME}`.

In the single-container deployment the API serves `/tiles/*` from that path itself, range requests included (Section 4.1). In the standalone two-container path, Caddy serves it from the same mounted location per `caddy/Caddyfile`, unchanged. Startup and missing-file behaviour differ between the two deployments — see Section 13.2.

**Build resources.** A Vite + MapLibre build on a 4 GB Pi is close to the memory ceiling. The build stage sets `NODE_OPTIONS=--max-old-space-size=1536`, and the README documents that at least 2 GB of swap must be configured on the Pi. If build time exceeds ~5 minutes, the documented upgrade path is GitHub Actions building an arm64 image to GHCR and the Pi pulling it instead (O6). Do not implement that in v1.

---

## 5. Data Model

SQLite. All timestamps and durations are Unix epoch **seconds** (INTEGER, UTC) — see rule 6 in Section 0.

**Migrations.** Plain `.sql` files in `packages/api/migrations/`, named `NNN_snake_case_description.sql` with a zero-padded three-digit prefix (`001_init.sql`, `002_clear_admin_must_change_password.sql`). They are applied at boot in **lexicographic filename order**, which is why the prefix is padded, and each is recorded by its own filename so a rerun is a no-op:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
```

The whole pass runs inside one `BEGIN IMMEDIATE` transaction, so the write lock is taken *before* the applied-set is read. That is what stops a second process starting at the same moment — the booting server and `npm run seed:admin` on a first-ever deploy (Section 4.3) — from deciding against a stale applied-set and replaying a migration.

There is no down-migration mechanism and none is wanted: a migration that has to be undone is undone by a further migration.

### 5.1 Cities (multi-city readiness)

```sql
CREATE TABLE cities (
  id            INTEGER PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,        -- 'karlsruhe'
  name          TEXT NOT NULL,
  origin_lat    REAL NOT NULL,               -- grid anchor (SW corner)
  origin_lon    REAL NOT NULL,
  grid_width    INTEGER NOT NULL,            -- cells in x
  grid_height   INTEGER NOT NULL,            -- cells in y
  cell_size_m   INTEGER NOT NULL,            -- 50 in v1
  playable_cells INTEGER NOT NULL,           -- cells inside city boundary (% denominator)
  is_active     INTEGER NOT NULL DEFAULT 1
);
```

v1 seeds exactly one row: Karlsruhe. Every geographic entity references `city_id`. Positions outside the active city's bounding box are silently ignored by all endpoints.

The bounding box is **not stored** — it is derived from `origin_lat/lon`, `grid_width/height`, and `cell_size_m` using the projection in Section 6.1. There is exactly one implementation of that derivation, in `packages/shared`.

### 5.2 Districts

```sql
CREATE TABLE districts (
  id             INTEGER PRIMARY KEY,
  city_id        INTEGER NOT NULL REFERENCES cities(id),
  name           TEXT NOT NULL,
  playable_cells INTEGER NOT NULL
);
```

District polygons are **not** stored in the database. They live in `data/seed/karlsruhe/districts.geojson` (simplified, served statically). The database only holds the cell→district lookup, precomputed by `scripts/build-grid.ts` into a packed `Uint16Array` file (`data/seed/karlsruhe/grid.bin`), loaded into memory by the API at boot (~280 KB for Karlsruhe; sentinel `0xFFFF` means "not in any district").

`scripts/build-grid.ts` is also what computes `playable_cells` for every district and for the city. It writes both `grid.bin` and a `data/seed/karlsruhe/grid-meta.json` carrying `grid_width`, `grid_height`, and the per-district counts; the seeding step reads that file. These numbers are never typed in by hand.

### 5.3 Users

```sql
CREATE TABLE users (
  id                   INTEGER PRIMARY KEY,
  username             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash        TEXT NOT NULL,          -- argon2id
  security_question    TEXT NOT NULL,          -- user-authored, plaintext (it is a prompt, not a secret)
  security_answer_hash TEXT NOT NULL,          -- argon2id, lowercased + trimmed before hashing
  avatar_seed          TEXT NOT NULL,          -- deterministic avatar, see 8.5
  is_anonymous         INTEGER NOT NULL DEFAULT 0,
  is_admin             INTEGER NOT NULL DEFAULT 0,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  excluded_from_rankings INTEGER NOT NULL DEFAULT 0,  -- out of the leaderboard and the badge race, see 7.7/7.8
  age_confirmed_at     INTEGER NOT NULL,
  created_at           INTEGER NOT NULL,
  last_seen_at         INTEGER
);
```

No email address is collected. Username constraints: 3–20 characters, `[a-zA-Z0-9_-]`, case-insensitively unique.

**`excluded_from_rankings` takes an account out of the competition without taking it out of the game.** Added by migration `003_users_excluded_from_rankings.sql`, defaulting to "not excluded" so no existing account and no new registration is ever silently removed from the running — setting it is a deliberate act through `PATCH /api/admin/users/:id` (Section 9.3).

An excluded account plays exactly as before: it reveals fog, discovers bars, masters bars, checks in, and reads its own figures on its own profile. What it does not do is appear in the two places that rank players against each other — `GET /api/leaderboard` (Section 7.8) and the badge job's candidate sets (Section 7.7). It also does not appear in either of them as an *obstacle*: an excluded account cannot be the high scorer that denies a badge to somebody who is still competing.

It exists because the owner tests the game on his own account, and it is also the precondition the admin teleport (Section 9.3) refuses without — which is what makes that feature safe rather than merely gated. Deliberately **not** excluded: the account's own profile figures, the admin user list, and any badge awarded before the flag was set (Section 7.7: awarded badges are a permanent record and are never revoked).

The flag is the one field of a user an admin may write. There is no route that promotes an account to admin, renames one, or clears `must_change_password`; those would be new powers rather than new fields, and Section 13.4's admin story runs through `deploy.sh` and `seedAdmin` instead.

`must_change_password` gates an account until it sets a new password: while it is set, every endpoint except `/api/auth/me`, `/api/auth/change-password`, and `/api/auth/logout` returns 403 with a machine-readable `code: "password_change_required"`, and the client routes to the change-password screen.

**The seeded admin does not carry it** (`must_change_password = 0`, Section 13.4), and that is deliberate rather than an oversight. The forced change exists to stop a deployment shipping with a credential its operator never chose — a default baked into an image or a repository.

The Pi platform's admin credential is the opposite of that: `deploy.sh` asks the operator for it interactively on first run, stores it `0600` in `~/pi-server/admin.env`, and rewrites it into every `admin: yes` site's `.env` on every deploy (Section 4.3). Forcing a per-site change would invalidate the one credential the platform manages the moment it is first used, and leave the operator tracking a second password the platform knows nothing about.

The gate itself stays in place for any account that legitimately carries the flag; only the seeder no longer sets it.

A consequence worth stating plainly: because `seedAdmin` skips an account that already exists and never overwrites a password changed since (Section 13.4), an admin who changes this password inside the app takes it out of the platform's ordinary reach — every subsequent `deploy.sh` run leaves the self-chosen password standing, and boot-time seeding does too, however many times the container restarts.

The platform can take it back, but only by saying so: `npm run seed:admin -- --rotate-password` rewrites `password_hash` from the current `ADMIN_PASSWORD` and is what `deploy.sh --set-password` runs (Section 4.3). That is the whole of the difference between the two, and it is an argument at the call site rather than a rule this app evaluates for itself — from inside the container an operator's rotation and an admin's own change are the same observation, a stored hash that no longer matches `ADMIN_PASSWORD`, so any rule keyed on that difference would revert self-chosen passwords while believing it was rotating.

### 5.4 Sessions

```sql
CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,      -- 32 random bytes, base64url
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL       -- 90 days, sliding
);

CREATE INDEX idx_sessions_expires ON sessions(expires_at);
```

Sliding expiry is **not** refreshed on every request — that would mean a write per request. `expires_at` is extended only when less than `SESSION_REFRESH_THRESHOLD_DAYS` remain. Expired rows are purged by the maintenance job (Section 7.9).

### 5.5 Fog state

Stored as a bitmask blob per user per city — one bit per grid cell.

```sql
CREATE TABLE fog_state (
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  city_id       INTEGER NOT NULL REFERENCES cities(id),
  mask          BLOB NOT NULL,        -- ceil(grid_width*grid_height/8) bytes
  revealed_cells INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, city_id)
);

CREATE TABLE fog_district_progress (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  district_id INTEGER NOT NULL REFERENCES districts(id),
  revealed_cells INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, district_id)
);

-- Per-day reveal counters. Required for period-scoped progress: the mask itself
-- carries no history, so "newly revealed this week" is not otherwise computable.
-- See 7.7 and 7.8. One row per user per active day; negligible size.
CREATE TABLE fog_daily_progress (
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  city_id        INTEGER NOT NULL REFERENCES cities(id),
  day            TEXT NOT NULL,       -- 'YYYY-MM-DD', Europe/Berlin local day
  revealed_cells INTEGER NOT NULL DEFAULT 0,   -- cells FIRST revealed on that day
  PRIMARY KEY (user_id, city_id, day)
);
```

The `fog_state` row for a user is created lazily on first `GET /api/fog` or first accepted sample, not at registration.

The mask blob is rewritten only when at least one bit actually changed. A sample batch that reveals nothing must not produce a write.

For Karlsruhe at 50 m the grid is 417 × 343 = 143,031 cells; the mask is ~17.5 KiB raw, ~2 KiB gzipped. Transferred whole on session start.

### 5.6 Bars

```sql
CREATE TABLE bars (
  id           INTEGER PRIMARY KEY,
  city_id      INTEGER NOT NULL REFERENCES cities(id),
  district_id  INTEGER REFERENCES districts(id),   -- NULL if outside every district polygon
  name         TEXT NOT NULL,
  address      TEXT,
  lat          REAL NOT NULL,
  lon          REAL NOT NULL,
  cell_index   INTEGER NOT NULL,           -- denormalized for fast lookup
  source       TEXT NOT NULL,              -- 'osm' | 'community' | 'admin'
  osm_id       TEXT,
  submitted_by INTEGER REFERENCES users(id),
  status       TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'hidden'
  created_at   INTEGER NOT NULL
);

CREATE INDEX idx_bars_city_cell ON bars(city_id, cell_index);
```

### 5.7 Discoveries and visits

```sql
CREATE TABLE bar_discoveries (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bar_id       INTEGER NOT NULL REFERENCES bars(id) ON DELETE CASCADE,
  discovered_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, bar_id)
);

CREATE TABLE visits (
  id              INTEGER PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bar_id          INTEGER NOT NULL REFERENCES bars(id) ON DELETE CASCADE,
  started_at      INTEGER NOT NULL,   -- check-in time, seconds
  last_sample_at  INTEGER NOT NULL,   -- latest accepted on-site sample, seconds
  onsite_samples  INTEGER NOT NULL DEFAULT 1,   -- includes the check-in itself
  confirmed_s     INTEGER NOT NULL DEFAULT 0,   -- last_sample_at - started_at
  status          TEXT NOT NULL,      -- 'pending' | 'completed' | 'expired' | 'cancelled'
  completed_at    INTEGER,
  push_sent_at    INTEGER             -- set when the 21-minute reminder went out
);

CREATE INDEX idx_visits_user_status ON visits(user_id, status);
CREATE INDEX idx_visits_pending_sweep ON visits(status, last_sample_at);
CREATE UNIQUE INDEX idx_visits_one_pending ON visits(user_id, bar_id) WHERE status = 'pending';
```

`confirmed_s` is the elapsed time between check-in and the most recent accepted on-site sample — not a gap between arbitrary samples. It is stored in seconds like every other duration in the database and compared against `VISIT_REQUIRED_S` (Section 7.1).

The partial unique index makes a second pending visit at the same bar impossible; `POST /api/visits` for a bar with an open pending visit returns the existing visit rather than an error.

`cancelled` is the state a player puts a visit into deliberately (Section 7.5). It is terminal like `expired`, it masters nothing, and it is never reached by a sample or by the maintenance tick — only by the caller's own explicit request. Because it takes the row out of `pending` it also releases the partial unique index, so the player can check in at the same bar again straight away. The row is kept rather than deleted, for the same reason an expired one is: it is a record of what happened, not a mistake to erase.

A bar is **mastered** by a user if at least one `visits` row exists with `status='completed'`. Mastering is permanent and cannot be lost.

**Hiding a bar removes it from play; it never revokes what was earned at it.** `GET /api/bars` and `GET /api/bars/:id` filter to `bars.status = 'active'`, as do the discovery query in `POST /api/samples` and the check-in query — a bar an admin hides disappears from every player's map, including players who had already discovered it. The leaderboard and badge queries deliberately do **not** filter on `bars.status`: mastering is a completed visit, and an admin hiding a bar afterwards must not silently take a badge or a rank away. That asymmetry is a rule, not an oversight.

**Every bar the API hands a client carries that answer, for the caller and for nobody else.** `GET /api/bars`, `GET /api/bars/:id` and `POST /api/samples`'s `newBars` all return the same bar shape (Section 9.2), and it has a `mastered` boolean on it — because the client draws the state (Section 8.1's cocktail glass) and cannot derive it: nothing else the client holds says anything about visits. The flag is per user and never a property of the bar, so the same bar is `true` in one caller's response and `false` in another's at the same instant.

Two things about how it is computed are decisions rather than implementation detail, and they are here because getting either wrong produces a bug no single-user test can see.

**It is computed from the `bar_discoveries` row's own `user_id`** — the same row that makes an undiscovered bar unreachable at all — rather than from a user identity supplied separately, so a query cannot come to report one user's bars with another user's mastery.

**It is asked once per request, not once per bar.** `idx_visits_user_status` is on `(user_id, status)` and carries no `bar_id`, so a per-bar existence check walks every completed visit the caller has and the cost of the whole request becomes discovered bars × completed visits. Measured on a player with 500 discovered bars and 600 completed visits that is 15 ms, against 0.4 ms without the flag; asked once per request it is 0.6 ms. No index is added for this — the one this section already defines covers the shape that asks the question once.

The three surfaces are required to agree field for field. They do so by construction — one row-to-JSON mapper and one SELECT list between them — and not by three implementations that happen to match today.

### 5.8 Badges

```sql
CREATE TABLE badges (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,      -- 'explorer' | 'barfly'
  period      TEXT NOT NULL,      -- 'week' | 'month' | 'year'
  period_key  TEXT NOT NULL,      -- '2026-W32' | '2026-08' | '2026'
  value       REAL NOT NULL,      -- achieved value (percent or bar count)
  awarded_at  INTEGER NOT NULL,
  UNIQUE (user_id, kind, period, period_key)
);
```

`period_key` for weeks uses **ISO-8601 week numbering** (`YYYY-'W'WW`, Monday-based, week 1 contains the first Thursday). Period boundaries are computed in `Europe/Berlin` and then converted to UTC seconds for querying. There is one helper for this in `packages/shared`; no route computes period boundaries itself.

### 5.9 Push subscriptions

```sql
CREATE TABLE push_subscriptions (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

A push endpoint that returns 404 or 410 is deleted immediately — those codes mean the subscription is permanently gone.

**VAPID key material lives on disk, not in the environment.** Section 4.3 is why: the Pi's `deploy.sh` fully overwrites `apps/tipsy-trails/.env` on every deploy and preserves only `SESSION_SECRET` across that overwrite. A key pair placed there the way `SESSION_SECRET` is would survive exactly one deploy and then silently stop working — push would go dark with no error, since the subscriptions themselves are untouched and only sending against them would start failing.

So: on first boot, if no key file exists, the app generates a VAPID key pair and writes it to `CONFIG.VAPID_KEY_FILENAME` (Section 7.1) in the same directory as `DATABASE_PATH`, which is on the persistent data volume in both deployments. Every later boot loads that file instead of generating a new one. Only `--fresh` destroys it, and `--fresh` already destroys the database it sits beside.

The subject the Web Push protocol requires is not generated. It is derived from `PUBLIC_ORIGIN`, already a mandatory URL with an `http:` or `https:` protocol (Section 4.3), so no separate value needs provisioning.

**The three `VAPID_*` environment variables remain supported as an explicit override**, all three or none, exactly as `resolveVapidConfig` treats them — a partial set stays a misconfiguration, warned about at boot. When all three are set they win over both the persisted file and generation, so a deployment that wants to pin its own key keeps that option; it is most useful for local development or a fork with no persistent volume to write to. When none are set, the app loads or generates the file as above.

On the Pi itself the override should be left unset. `deploy.sh` never writes these three — its `admin: yes` block is exactly `SESSION_SECRET`, `ADMIN_USER`, `ADMIN_PASSWORD` and nothing else — so there is nothing here for it to wipe, and generation exists specifically to remove the manual key-provisioning step this platform cannot support.

---

## 6. Geometry and Grid System

### 6.1 Projection

A local equirectangular approximation anchored at the city origin. Accurate to well under one metre at city scale and far cheaper than a full projection library.

```ts
const M_PER_DEG_LAT = 110574;
const mPerDegLon = (lat: number) => 111320 * Math.cos(lat * Math.PI / 180);

function toCell(lat: number, lon: number, city: City): number | null {
  const x = Math.floor((lon - city.origin_lon) * mPerDegLon(city.origin_lat) / city.cell_size_m);
  const y = Math.floor((lat - city.origin_lat) * M_PER_DEG_LAT / city.cell_size_m);
  if (x < 0 || y < 0 || x >= city.grid_width || y >= city.grid_height) return null;
  return y * city.grid_width + x;
}
```

The longitude scale is evaluated once at `origin_lat`, not per sample. Across Karlsruhe's 0.155° of latitude that introduces a ~0.2 % east-west scale drift at the northern edge — about 10 cm per cell, far below GPS accuracy, and it keeps the grid strictly rectilinear. This is deliberate; do not "fix" it by evaluating at the sample latitude, which would make cells non-uniform and break the packed grid.

Distances use the haversine formula.

### 6.2 Karlsruhe grid parameters

These parameters are not loose values in this document — they live in `data/cities/karlsruhe.json` (Section 11.4), and that file is what the seed and build scripts and the `cities` row (Section 5.1) actually read. The table below is its human-readable copy, kept here for quick reference.

| Parameter | Value |
|---|---|
| `origin_lat` / `origin_lon` | 48.9400 / 8.2750 |
| Bounding box | 48.9400–49.0950 N, 8.2750–8.5600 E (≈ 20,839 × 17,139 m) |
| `cell_size_m` | **50** |
| `grid_width` × `grid_height` | 417 × 343 = 143,031 cells (authoritative value comes from `scripts/build-grid.ts`) |
| Mask size | ~17.5 KiB raw / ~2 KiB gzipped |
| Fog texture (R8) | ~140 KiB |
| `grid.bin` (Uint16) | ~280 KiB |

`cell_size_m` is a per-city database column and must never be hard-coded in application logic. Changing it requires a grid rebuild and a fog-state migration; a `scripts/rebuild-grid.ts` stub with a clear TODO is sufficient in v1.

### 6.3 Playable cells

A cell is playable if its centre lies inside a district polygon. `playable_cells` per district and per city is precomputed and stored. Progress percentages use these as denominators, so non-city cells inside the bounding box never dilute the score.

A consequence worth stating: cells outside every district are revealable (the fog clears there) but do not count toward any percentage. The UI must not present this as a bug.

---

## 7. Core Mechanics

### 7.1 Constants

All of these live in `packages/shared/src/config.ts`, and that file is authoritative: the block below reproduces every key it exports, with the file's own comments reduced to one line each. A constant named anywhere else in this document is defined here or nowhere.

```ts
export const CONFIG = {
  FOG_REVEAL_RADIUS_M: 100,
  FOG_MAX_SPEED_KMH: 30,          // above this, no reveal
  FOG_MAX_ACCURACY_M: 200,        // samples worse than this are discarded entirely
  FOG_REVEAL_ANIMATION_MS: 600,   // see 7.3; the bar stamp waits this out
  FOG_MAX_OPACITY: 0.96,          // alpha of the DENSEST fog and the ceiling on every fragment
  FOG_DENSITY_VARIATION: 0.12,    // how far below that ceiling the noise may thin it (floor 0.84)
  FOG_DENSITY_NOISE_CELLS: 24,    // period of the coarsest density octave, in grid cells
  FOG_VIEWPORT_PADDING_RATIO: 0.15, // margin around the viewport for the fog quad — NOT the pan limit
  FOG_EDGE_BLUR_RADIUS_CELLS: 1,  // box-blur radius r on the binary mask
  FOG_EDGE_ALPHA_HALF_WIDTH: 0.1, // alpha = smoothstep(0.5 - h, 0.5 + h, blurred); edge is 2(2r+1)h cells

  BAR_DISCOVERY_RADIUS_M: 100,
  BAR_ONSITE_RADIUS_M: 30,
  BAR_ACCURACY_TOLERANCE_M: 20,   // added to on-site radius, capped by accuracy

  BAR_STAMP_DURATION_MS: 1600,    // one stamp's life — animation and DOM timer read the same number
  BAR_STAMP_STAGGER_MS: 500,      // gap between two stamps of one batch
  BAR_STAMP_MAX_PER_BATCH: 3,     // caps the animation only, never the announcement or the markers

  VISIT_REQUIRED_MS: 20 * 60 * 1000,
  VISIT_EXPIRY_MS: 6 * 60 * 60 * 1000,
  VISIT_PUSH_AFTER_MS: 21 * 60 * 1000,
  VISIT_MIN_ONSITE_SAMPLES: 2,    // check-in plus at least one later on-site sample

  SAMPLE_MIN_INTERVAL_MS: 10 * 1000,   // client throttle
  SAMPLE_MAX_CLOCK_SKEW_MS: 60 * 1000, // reject samples further in the future
  SAMPLE_MAX_AGE_MS: 10 * 60 * 1000,   // reject samples older than this
  SAMPLE_TELEPORT_SPEED_KMH: 300,      // implied-speed guard between accepted samples
  SAMPLE_MAX_BATCH: 60,                // per POST /api/samples

  SESSION_TTL_DAYS: 90,
  SESSION_REFRESH_THRESHOLD_DAYS: 30,  // only then is expires_at rewritten

  GPS_ACCURACY_GOOD_M: 20,
  GPS_ACCURACY_FAIR_M: 50,
  GPS_STALE_MS: 30 * 1000,

  SUGGEST_DUPLICATE_RADIUS_M: 25,
  SUGGEST_NAME_SIMILARITY: 0.85,  // normalized Levenshtein ratio, see 11.3
  IMPORT_DUPLICATE_RADIUS_M: 40,  // import-side collapse radius, see 11.1 — measured, not chosen

  LEADERBOARD_PAGE_SIZE: 50,
  MAINTENANCE_INTERVAL_MS: 60 * 1000,  // see 7.9
  BADGE_EVAL_INTERVAL_MS: 60 * 60 * 1000,  // see 7.9

  // Switching a brand-new database to WAL needs an exclusive lock and does not
  // go through SQLite's busy handler, so two processes opening the same fresh
  // file at once collide — see 4.3.
  DB_WAL_RETRY_BUDGET_MS: 5000,
  DB_WAL_RETRY_INTERVAL_MS: 50,

  USERNAME_MIN_LENGTH: 3,         // Section 5.3
  USERNAME_MAX_LENGTH: 20,        // Section 5.3
  PASSWORD_MIN_LENGTH: 8,         // not stated elsewhere in this document; chosen by the auth route

  RATE_LIMITS: {
    auth:            { limit: 10, windowMs: 60 * 1000,          by: 'ip' },
    resetByUser:     { limit: 5,  windowMs: 60 * 60 * 1000,     by: 'username' },
    resetByIp:       { limit: 20, windowMs: 60 * 60 * 1000,     by: 'ip' },
    samples:         { limit: 30, windowMs: 60 * 1000,          by: 'user' },
    suggest:         { limit: 10, windowMs: 24 * 60 * 60 * 1000, by: 'user' },
  },

  // Badges are a per-period COMPETITION, and these are its FLOORS. A badge
  // goes to the highest-scoring user of the period, and to nobody at all if
  // no one reaches the floor — its only job is to stop the badge being won by
  // being the least inactive person. Set them low: they are qualification, not
  // the target. A user qualifies when value >= threshold (minimum, not
  // "strictly greater"). Never sent to a client — see Section 7.7.
  BADGE_THRESHOLDS: {
    // Percent of playable city area newly revealed in the period.
    // Deliberately not linear across periods: after the first weeks most walking
    // retraces already-revealed ground, so sustained progress decays sharply.
    // 0.1% is roughly 900 m of previously unexplored walking.
    explorer: { week: 0.1,  month: 0.3,  year: 2.0 },
    // Bars newly mastered in the period.
    barfly:   { week: 1,    month: 2,    year: 3 },
  },

  // Map camera limits. Zoom 10 keeps the whole city in view and never leaves
  // the area the extract covers (built for zoom 0–14); zoom 18 overzooms that
  // last level deliberately, which is what makes 50 m cells legible up close.
  MAP_MIN_ZOOM: 10,
  MAP_MAX_ZOOM: 18,
  MAP_BOUNDS_PADDING_RATIO: 0.2,  // margin around the playable grid for the pan limit
  MAP_DEFAULT_ZOOM: 16,           // opening view AND "to my location" — see 8.3
  MAP_FIT_PADDING_PX: 24,         // margin when "Open on the map" fits a district's box — see 8.3

  TILES_FILENAME: 'karlsruhe.2026-08.pmtiles',
  VAPID_KEY_FILENAME: 'vapid-keys.json',  // generated on first boot, persisted beside DATABASE_PATH — see 5.9
} as const;

// The single ms→s boundary required by rule 6 in Section 0.
export const DERIVED = {
  VISIT_REQUIRED_S: CONFIG.VISIT_REQUIRED_MS / 1000,
  VISIT_EXPIRY_S:   CONFIG.VISIT_EXPIRY_MS / 1000,
  VISIT_PUSH_AFTER_S: CONFIG.VISIT_PUSH_AFTER_MS / 1000,
  SESSION_TTL_S:    CONFIG.SESSION_TTL_DAYS * 86400,
  SESSION_REFRESH_THRESHOLD_S: CONFIG.SESSION_REFRESH_THRESHOLD_DAYS * 86400,
} as const;
```

### 7.2 Position sampling

The client obtains positions via `navigator.geolocation.watchPosition({ enableHighAccuracy: true })` while the app is in the foreground, and holds a Screen Wake Lock while an active exploration session is running.

**The app cannot receive positions in the background.** This is a browser platform limitation, not a design choice, and the UI must communicate it plainly (Section 8.6).

Samples are batched client-side and posted at most every 10 seconds, at most `SAMPLE_MAX_BATCH` per request. Each sample carries `{ lat, lon, accuracy, speed, timestamp }`.

Server-side validation, in order:

1. Discard if `accuracy > FOG_MAX_ACCURACY_M`.
2. Discard if `timestamp` is more than `SAMPLE_MAX_CLOCK_SKEW_MS` in the future or older than `SAMPLE_MAX_AGE_MS`. Client clocks are not trusted; ordering within a batch is by client timestamp, but every persisted timestamp is server time.
3. Discard if the position is outside the active city's bounding box.
4. Discard if the implied speed from the previous accepted sample exceeds `SAMPLE_TELEPORT_SPEED_KMH`.
5. Otherwise accept.

The previous accepted position used by step 4 is held in memory only (Section 10.2). After an API restart the guard has no reference point and passes the first sample of each user unconditionally. This is an accepted degradation, not a bug to work around by persisting positions — that would violate C4.

**While an admin teleport stands, this client watches nothing.** The teleported point (Section 9.3) _is_ the position: the map screen does not call `watchPosition` at all, and reports that point as the position everything else on the screen reads — the own-position marker, the nearby-bars panel, the check-in offer. One value, so none of them can disagree about where the player is, and no battery is spent on fixes that would be discarded.

It keeps posting on the ordinary cadence from that point, through `POST /api/samples` with every gate above applied. **That path needs no bypass and must not be given one.** The server's previous accepted position is already the teleported point, so a sample from the same point implies zero speed and passes step 4 on its own terms; the accuracy and speed those samples carry are the same pair the teleport route synthesises for itself, so a check-in the client offers is one the server accepts. Section 10.1's single rule — `POST /api/samples` has no bypass parameter — is untouched by any of this.

A teleport is not a way to sample from two places at once: the phone's real position is not watched, queued or posted while the mode is on, and the mode ends with an explicit request (Section 9.3) rather than with the next fix.

### 7.3 Fog of war

This is the longest section in the document and the most heavily cited. It runs: the reveal rule; what the map tells the player and what it deliberately does not; the renderer; the layer order; the edge; the density; the roads and district borders; the canvas fallback.

#### The reveal rule

For each accepted sample where speed < `FOG_MAX_SPEED_KMH`, reveal every cell whose centre lies within `FOG_REVEAL_RADIUS_M` of the position — about 13 cells at 50 m. Revealed cells are permanent.

Speed is taken from the Geolocation API where available, otherwise derived from the previous accepted sample. If neither is available — the first sample after a restart — the sample reveals.

Every newly set bit increments `fog_state.revealed_cells`, the matching `fog_district_progress` row if the cell belongs to a district, and the `fog_daily_progress` row for the current Europe/Berlin day. All three updates happen in one transaction with the mask write.

#### What the map tells the player

**The player is told when that rule is what is stopping them.** A map that does not clear looks exactly like a map that is broken, and the owner's own report was a train journey during which nothing revealed and nothing said why. So `POST /api/samples` answers with `tooFastToReveal` (Section 9.2) and the map screen renders it as a message in the notices row of its overlay layout (Section 8.3) — never as an overlay positioned against the map.

**The server is the only honest source for it, and that is the whole point of putting it in the response.** The client holds `position.speed` and could test the threshold itself, but that would be a second implementation of a rule the server has already applied, free to disagree with the one that actually decides — including in the case the client cannot reproduce at all, where the fix carries no speed and the server derives one from the previous accepted sample, which lives in the server's memory (Section 7.2) and nowhere else.

**A batch is several samples, so the field needs a defined meaning for a mixed one: the last accepted sample decides.** The message is present tense — it tells the player what is happening now — and the last accepted sample is the most recent thing anyone knows about where they are.

Two cases follow from that. A batch that begins on a moving train and ends on the platform reports `false`, because by the end of it the player was walking. A batch none of whose samples was accepted reports `false` too, since nothing in it was refused for speed and the message is not entitled to assert a speed no sample established.

The consequence worth stating plainly is that a batch can have had cells refused mid-way and still report `false`. That is correct for a present-tense message and would be wrong for a count of what was skipped. This is not a count.

**The message must clear itself.** Every successful `POST /api/samples` replaces the flag, including with `false`, so the message goes as soon as the player has slowed down. A message about a train that survives the player getting off it is the same class of defect as a pending-visit banner claiming time the player never spent at a bar (Section 7.5). Its wording says what will happen when they slow down rather than only what is not happening, and it does not accuse: the player is not doing anything wrong.

**The map does not announce revealed ground, and that is a decision.** It did: every batch that cleared a cell put "Revealed N new areas" on the screen, which on a walk is most batches, and the owner's report was of being told it repeatedly while finding nothing.

The count is not something a player can act on — the unit is a 50 m cell, not a place — and it narrates the one thing the map is already showing them, since the fog receding is its own feedback and the crisp edge below exists to be exactly that. What the map announces is what the player cannot see happen for themselves: a bar coming into range, and the speed message above, which reports a rule that is *stopping* something rather than a thing that just happened. A count of cells is neither.

#### Rendering

A MapLibre custom layer draws the fog as a single full-screen quad. The fog mask is uploaded to the GPU as a texture — one texel per grid cell, `R8` format, ~140 KiB for Karlsruhe — and sampled in the fragment shader. Reveals update the texture via `texSubImage2D` on the affected region only.

**"Full-screen" means the camera's screen, and it is rebuilt every frame.** The quad spans the current viewport plus `FOG_VIEWPORT_PADDING_RATIO` on each axis, taken from the map's own bounds, which already account for bearing and pitch.

It must not be a fixed rectangle derived from the city's extent. The map's pan limit constrains an *axis-aligned* viewport, so the moment the camera is rotated the viewport's corners sweep outside it — and where there is no quad there is no geometry and therefore no fog, leaving bare un-fogged ground in the corners of a turned map. `FOG_VIEWPORT_PADDING_RATIO` is deliberately a separate constant from `MAP_BOUNDS_PADDING_RATIO`, because sharing one number between the pan limit and the fog quad is exactly what produced that defect. Four vertices a frame is not a cost worth optimising away.

**Newly revealed cells animate from opaque to clear over `FOG_REVEAL_ANIMATION_MS`** (600 ms). This is also what Section 7.4's bar stamp waits out before it draws anything: the fog clearing and the stamp landing are two steps of one moment, in that order, so the stamp reads the same constant rather than carrying a second number that means the same thing.

That lines the two up and cannot guarantee it. The reveal begins when `GET /api/fog` answers, which is a request issued after the `POST /api/samples` that reported the discovery, so a stamp arriving slightly early on a slow connection is the accepted cost of not coupling a discovery to the fog layer's network.

#### Layer order

The fog is inserted into the style at one fixed point, and the two sides of that point are what a player sees on unrevealed ground. Bottom to top:

| Layer | Side of the fog |
|---|---|
| `background` (paper), `landcover-green`, `park`, `building`, `building-outline`, `road-minor` | below — hidden on unrevealed ground |
| **the fog** | — |
| `water-fill`, `water-outline`, `waterway`, `road-primary`, `road-highway` | above — drawn everywhere |

So a player on unrevealed ground sees roads and water and nothing else; buildings, green areas, parks and minor streets are hidden, deliberately. Above the fog, the district-border line layer is appended at runtime (below).

This widens an earlier rule under which only the motorway/trunk layer stayed above the fog and water was dimmed away with everything else. Orientation in unexplored ground is carried better by the water and the ordinary street grid than by the trunk network alone, and the fog still gets to do its job on everything that describes what a place is actually like.

Unrevealed fog is opaque grey, dense enough to hide detail rather than tint it, and **not at one alpha everywhere** — see *Density* below. `FOG_MAX_OPACITY` is the alpha of its densest patch and the ceiling on every fragment; the floor is `FOG_MAX_OPACITY - FOG_DENSITY_VARIATION`. Revealed ground is fog alpha 0.

#### The edge

**The edge is a boundary, not a fade.** It is irregular but crisp. A low-frequency noise offset displaces the sampling position so the edge never reads as a circle around the player or as a staircase of 50 m squares, and a narrow blur plus a tight alpha band around its midpoint keep the transition itself down to a fraction of a cell.

The two numbers are `FOG_EDGE_BLUR_RADIUS_CELLS` and `FOG_EDGE_ALPHA_HALF_WIDTH`, and they are **not independent**. Blurring a binary mask leaves the blurred value linear in distance from the boundary with slope `1 / (2r + 1)` per cell, so the visible transition is exactly `2 · (2r + 1) · h` cells wide. That relationship is recorded here so the next person tuning it does not have to re-derive it, and so that a change to either constant is understood as a change to one width rather than to two knobs.

This edge is not decoration. It is the only feedback that the reveal mechanic works at all — an earlier version faded over roughly 190 m, which read as no boundary, and a player who cannot see ground being unlocked cannot see the game working.

#### Density

**The fog's interior is uneven, and the unevenness comes from noise rather than from a texture.** The edge was made irregular first, and that left the inside of it a flat wash at a single alpha — which reads as a sheet of tracing paper laid over the map, not as a city nobody has walked yet.

The alpha is therefore varied by a noise field: `FOG_MAX_OPACITY` becomes the ceiling and the fog thins by up to `FOG_DENSITY_VARIATION` below it, so what a player sees vary is how much of the base map bleeds through from one patch to the next. The variation is bounded from below because the thinnest patch still has to hide detail rather than tint it, which is a requirement and not a matter of taste; it is bounded above by nothing but that, because a variation nobody can make out is the flat wash again under another name.

**The density is anchored to the ground, not to the screen, and that is the requirement this could most easily fail.** The noise is sampled in the grid's own coordinate — the fog quad's UV, which `grid-geometry.ts` derives from longitude and latitude against the grid's fixed corners, with the camera nowhere in the expression — so a given patch of the city keeps its own density as the map moves under it. Sampled in any coordinate that travels with the camera, the fog would crawl and shimmer under a pan: worse than the flat wash it replaced, and a failure to test for rather than to look for.

**It must not read as a repeating pattern**, which is a stronger requirement than being irregular, and it is what fixes the shape of the noise. A single lattice of value noise reads as a regular grid of blobs at whatever zoom makes its period a comfortable fraction of the screen, and a second lattice at twice the frequency puts its corners exactly on the first one's, so the two agree rather than cancel.

The field is therefore a few octaves at frequencies that are not whole multiples of each other, each shifted by its own offset, with falling amplitude so the coarse shape leads. The count is bounded from both sides: too few and the lattice shows, too many and the fine octaves add structure at cell scale, which stops reading as density and starts reading as a texture. `FOG_DENSITY_NOISE_CELLS` fixes the coarsest feature's size in grid cells and the finest follows from it; it is kept several cells across, because a feature approaching the size of a screen pixel at `MAP_MIN_ZOOM` aliases into shimmer.

**Whatever varies the density applies to fog and never to revealed ground.** The density multiplies into the same product as the edge factor rather than being added beside it, so where the edge factor is zero the alpha is zero whatever the density is. A term that leaked past the edge would put a haze on ground the player has earned, which is the opposite of the mechanic. It is a property of the arithmetic rather than of any constant, so it is tested as arithmetic and not as a value baked into a shader nothing here can execute.

#### Roads

**Minor roads exist, and they stay under the fog.** Residential and tertiary streets are drawn as their own layer, quieter than the major roads and appearing only at closer zooms, so explored ground shows the street pattern a walker actually recognises rather than the trunk network alone. They belong *below* the fog, and the reason is the whole point of the ordering above: put them above it and unrevealed ground gains the full street grid, which is precisely the detail the fog exists to withhold. Under the fog they are a reward for having been somewhere. This is also why they are a separate layer rather than a widened filter on `road-primary` — one filter cannot be on two sides of the fog at once.

**Major roads carry no extra weight.** `road-highway` used to be drawn heavier and more opaque than `road-primary`, which was defensible while it was the only road above the fog and had to carry orientation on its own. It no longer is, and the contrast the ordinary roads already have is enough for the major ones too: both road layers take the same colour, the same opacity, and the same width ramp.

The hierarchy does not disappear; it moves from stroke weight to visibility threshold. `road-highway` appears from zoom 4 and `road-primary` only from zoom 8, so a zoomed-out map still shows the trunk network alone, and the distinction between the two appears at the zoom where it is useful instead of as a permanent difference in ink.

**A layer above the fog cannot tell revealed ground from unrevealed ground.** It renders identically on both, and that is the subtle cost of this ordering, worth stating plainly because it is easy to discover only on the street. The road intensity that reads well today was only ever seen on revealed ground — beneath the fog those roads were dimmed to nothing — so moving them above puts that same intensity onto unexplored ground, where it may read as too loud and where it flattens the very distinction the fog exists to draw.

The answer is that roads above the fog carry a deliberately reduced opacity: enough to read through the fog without dominating it, with the revealed-versus-unrevealed contrast carried by the buildings, the green areas and the fog tone rather than by the roads. The exact value is a judgement to be made looking at the real map on a real device. **This document fixes the requirement and not the number**, and that is a decision rather than a gap — see O20.

If one value turns out not to serve both states, the named remedy is two copies of the road layers: a quiet one above the fog and a fuller one below it, so revealed ground gets both drawn over each other and fogged ground only the quiet one. That is the fallback, not the plan. It doubles the road geometry drawn per frame and gives the style two sets of paint properties to keep in step, so it is worth its cost only once a single opacity has demonstrably failed.

#### District borders

**The district boundaries are drawn on the map, above the fog.** A player asked which district they are standing in has no way to tell from the map, and the answer is most useful in exactly the ground they have not explored. So the borders go above the fog, and they pay the price the roads pay: they render identically on explored and unexplored ground and carry none of that distinction.

The geometry is the boundary file the district overview already draws (`/static/<slug>/districts.geojson`, Section 11.4), added to the map as a GeoJSON source and a line layer at runtime. Nothing new is generated, served, or seeded for it.

**It must read as a boundary and not as another street**, which is a stronger requirement than being quiet. A road network is continuous and connected, so an unbroken line joins it by resemblance however faint it is drawn, and a faint continuous line above the fog is precisely a road.

The border is therefore **dashed** — the cartographic idiom for an administrative boundary, and a kind of line the street layers never produce — and drawn wider than the roads rather than thinner, so it reads as a deliberate heavier mark that happens to be broken. Its opacity sits below the roads', because a boundary is context and the streets are what a player navigates by, but not below the 3:1 that Section 8.1 holds non-text marks to against the fogged ground it exists to be visible on. As with the roads, this document fixes the requirement and not the number.

**Its position in the layer order is fixed by construction, not by timing.** The border layer and the fog are both added at runtime from two independent network responses, so an ordering that depends on which arrives first works on a desk and fails on a phone. The fog is only ever *inserted* before the first above-fog layer of the static style and never appended; the border layer is only ever appended. That makes the border above the fog in both arrival orders, without either side having to know whether the other has mounted.

#### The canvas fallback

If WebGL2 is unavailable, fall back to a 2D canvas overlay redrawn on `moveend` only. Detect and log this; do not attempt feature parity on animation.

Nor on the uneven density above — that is a noise field evaluated per fragment, and this renderer has no fragments. It paints one flat alpha, and the value it paints is the **middle** of the WebGL path's range rather than its ceiling.

The reason is that `FOG_MAX_OPACITY` stopped being "the alpha of the fog" when the density landed, so taking it literally here would have made the fallback denser than any ground the other renderer produces on average — a change to what a user sees, arriving as a side effect of a change to a renderer they are not on. "Do not attempt feature parity" licenses this path to be simpler, not to drift.

Two known divergences of this path are recorded rather than fixed: it cannot be interleaved with the vector layers at all, so the layer order above does not hold for it (O13), and it measures a cell's pixel width from the wrong pair of points (O12).

### 7.4 Bar discovery

When an accepted sample lands within `BAR_DISCOVERY_RADIUS_M` of an active bar, a `bar_discoveries` row is created. Discovery is permanent and independent of fog state — a discovered bar stays visible even if it sits in an area the player never fully revealed.

Undiscovered bars are never sent to the client. The client receives only discovered bars. The API must never leak undiscovered bar positions, including through aggregate endpoints such as counts per district.

This applies to error codes as well: `GET /api/bars/:id` returns the same response for an undiscovered bar and for a bar that does not exist. See Section 9.5.

**Discovering a bar is a moment on the map, and the map says so where it happened.** Walking into a bar's radius used to change nothing a player could see except a marker appearing among the others — the one event in this game that a player earns by walking and was told nothing about.

So: the fog clears (Section 7.3), the map dims a little, and the cocktail glass of Section 8.1 is **stamped onto the map at the bar**, with "BAR DISCOVERED" and the bar's name under it, and then it goes away by itself. It is anchored at the bar's own position and re-projected as the map moves, exactly as a marker is — a message in a corner of the screen would be about a place without ever pointing at it.

**It is not a modal and it cannot be got stuck in.** Nothing about it takes a pointer event, nothing traps focus, and there is no control to dismiss: the player keeps panning, keeps tapping markers, and reaches Section 7.5's check-in at the bar they have just been told about while the stamp is still on screen. Every element it creates is removed by a timer scheduled when it is created, and a second discovery never leaves the first one's dim behind.

Its timing lives in `config.ts` like every other number here: `BAR_STAMP_DURATION_MS` for how long one stamp is on screen, `BAR_STAMP_STAGGER_MS` for the gap between two of them. `BAR_STAMP_DURATION_MS` is one number for both the animation and the element's life, so what is painted and what is in the document cannot disagree about when the moment is over.

**A batch discovers a set of bars, not a bar.** `newBars` is an array (Section 9.2) and a batch can carry ten minutes of walking when a queue drains after an offline stretch, so the plural case is the ordinary one rather than an edge. They are stamped one after another, `BAR_STAMP_STAGGER_MS` apart and overlapping on screen, so a batch reads as one event with several marks in it.

`BAR_STAMP_MAX_PER_BATCH` caps how many are stamped, and the cap is on the **animation only**: every discovered bar is named in the one spoken announcement and every one of them gets its marker, whatever the cap. Uncapped, a queue draining in Karlsruhe's centre would dim the map for as long as it took to play a dozen stamps, which turns a moment into something to sit through.

**The stamp and the marker are the same glass, so they are never both drawn.** The same response that reports a discovery is what refetches the bar list, so that bar's permanent marker appears within a few hundred milliseconds of the stamp starting, at the same point, drawing the same mark — and a stamp landing on an identical marker that just appeared is a flicker rather than a moment. The marker therefore gives up its ink for exactly as long as its stamp is on screen and takes it back the instant the stamp is removed.

Its **button** is never hidden. The tap target, the accessible name and the tab position all stay, because Section 7.5's check-in has to be reachable at the bar the player is standing at, including during the second and a half in which they are being told they found it.

**The announcement is in words, once per batch.** The visual half is a shape appearing on a map, which Section 8.1 does not allow to be the only channel. One `role="status"` live region — polite, not `role="alert"`: a discovery is good news and must not cut off what a screen reader is saying — carries one sentence naming every bar the batch discovered. One sentence and not one per bar, because three stamps must not be three interruptions.

### 7.5 Check-in and mastering

Bars sit close together in Karlsruhe's centre and GPS alone cannot distinguish neighbours, so **check-in is an explicit user action**.

**Flow:**

1. **A check-in starts at the bar's marker on the map, and nowhere else.** Tapping a discovered bar's marker leads to that bar, where a check-in action is offered and is enabled only while the player is within `BAR_ONSITE_RADIUS_M + min(accuracy, BAR_ACCURACY_TOLERANCE_M)` of it — 30 m with a good fix and 50 m at worst. There is exactly one implementation of that sum (`onsiteRadiusM`, `packages/shared/src/visits.ts`), shared by the client's candidate list, the sheet's enablement and the server's re-validation in step 2.

  The pair is what matters, not either number alone. They used to be 50 and 50, which reached 100 m — a whole street of bars in Karlsruhe's centre, and a radius a player could satisfy from a bar he was nowhere near. The tolerance is not folded into the base radius, because removing it would make check-in *impossible* on a poor fix rather than merely harder, and a player standing inside the bar being refused is a worse failure than a generous radius.

  **This radius is deliberately far smaller than `BAR_DISCOVERY_RADIUS_M`, and a bar discovered at 100 m that then needs 30 m to check into is the intended shape rather than a gap between two rules.** The two answer different questions. Discovery (Section 7.4) asks "have you been near this place" — a question about a walk, permanent once answered, and generous on purpose so the map fills in as the player moves. Check-in asks "are you at *this* bar", the question that has to separate two neighbours a few metres apart, and it is the whole reason this step is an explicit user action.

  Neither radius can be moved to meet the other. A discovery radius narrowed to match would hide bars the player walked past; a check-in radius widened to match would put the bar next door inside it. What makes two neighbouring bars separable is that the player names the one they mean by pointing at it, instead of accepting a suggestion the app derived from a position that cannot tell the two apart.

  The nearby panel on the map screen stays and stops being a control: it names the bars currently in range, sorted by distance, and tells the player to tap one on the map. It carries no button and performs no check-in.

  **"Leads to that bar" means a sheet on the map screen, not the `/bars/:id` route**, and the reason is worth recording because the wording invites the opposite reading. Position tracking runs in exactly one place — the map screen — so navigating away to a separate route unmounts it: fog reveal and sample posting stop, and the screen that is supposed to judge on-site eligibility has no live position to judge it against.

  Powering a check-in there would mean lifting tracking into a shared provider, a real change to the sample pipeline, bought for nothing the player can see. A sheet on the map keeps tracking alive and still has the player name the bar they mean by pointing at it, which is the whole property this step exists for. `/bars/:id` keeps its job as the linkable detail page and deliberately carries no check-in action.

  The sheet's action is **disabled rather than hidden** when it cannot be used, with a sentence saying why: a control that vanishes is harder to understand than one that is visibly inert, the same argument the "to my location" control rests on. It always names the bar it would check into, so a bare "Check in" can never float over a map with two bars a few metres apart on it.

  A bar that already has a pending visit offers no second check-in, and says so rather than making a request whose answer (Section 5.7) is the visit already open. It says that *before* any out-of-range wording, since a player standing in the bar they are checked into is on site and "too far away" would be a plain lie.

2. `POST /api/visits` creates a `pending` visit with `started_at = now`, `last_sample_at = now`, `onsite_samples = 1`. The server re-validates proximity using the caller's last accepted sample; a check-in without a recent on-site sample is rejected with 422.
3. Every subsequent accepted sample within the on-site radius of that bar updates `last_sample_at`, increments `onsite_samples`, and recomputes `confirmed_s = last_sample_at - started_at`.
4. When `confirmed_s >= VISIT_REQUIRED_S` **and** `onsite_samples >= VISIT_MIN_ONSITE_SAMPLES`, the visit becomes `completed`, `completed_at = now`, and the bar is mastered.
5. If no on-site sample arrives for `VISIT_EXPIRY_S`, the visit becomes `expired`. Expiry is never punitive — the user can simply check in again.

Because completion needs only *two* valid samples 20 minutes apart, the app does not have to stay open. Opening it on arrival and again before leaving is sufficient.

**A pending visit can be cancelled.** Step 5 is not the only way out. A player who checked in at the wrong bar, or by accident, must be able to end it there and then rather than carry it around for hours until the inactivity expiry catches it.

A cancel endpoint under `/api/visits` (Section 9.2) acts only on the caller's own pending visit and moves it to `cancelled` (Section 5.7). It is the caller's decision alone, so nothing else — no sample, no maintenance tick — ever produces that state. The pending-visit banner carries the control that calls it, behind a confirmation, because cancelling throws away whatever confirmed time the visit has accumulated and there is no route back to it.

Cancelling has nothing to do with expiry: `VISIT_EXPIRY_MS` keeps its value, its behaviour and its description exactly as step 5 states them.

**A request with no body must not declare one.** The cancel endpoint takes its only argument in the path and sends nothing else, and the same is true of `POST /api/auth/logout` and `DELETE /api/admin/bars/:id`. A client that sets `Content-Type: application/json` on such a request is rejected by the API's JSON body parser with a 400 before the route is reached — "Body cannot be empty when content-type is set to `application/json`" — so the header is sent only when there is a body to describe.

This is recorded here, in the mechanic it broke, because it is not a matter of style. Sent unconditionally it made cancelling a visit fail on every attempt, for every user, from the day the endpoint shipped, while every call that does carry a body went on working and hid the pattern. Any test that would catch a regression of it has to have a real body parser behind it; a client-side test with a stubbed `fetch` cannot see it at all.

**A 404 from cancel means the visit is gone, and the client must treat it as success.** The cancel endpoint answers one deliberately identical 404 (Section 9.5) for every case in which the caller has no pending visit with that id — another user's, already completed, already expired, already cancelled, never existed. Every one of those is the state the player was asking for, so the caller removes the visit from the banner and reports no failure.

Every other failure — a network error, a 500, a 403 — genuinely changed nothing on the server, so the visit stays and the failure is reported. This is decided on the status code, not on "the request failed" and not on the error's `code` either: a 404 on that path means "not pending" whoever produced it, a proxy included.

This rule is not what fixed the report above; it is what stops the same symptom having other causes. **The banner must never be able to hold a visit the server does not agree is pending**, whatever put it into that state — and a cancel button that visibly does nothing is indistinguishable to a player whether the visit expired an hour ago, was cancelled on another device, or never reached the server at all.

**The banner re-checks itself when the screen returns to the foreground.** `GET /api/visits/pending` expires stale visits lazily on read (Section 7.9) and returns only live ones, so it is the only thing that can tell a client that a visit ended for a reason the client never saw. Fetched once per mount it is only a snapshot: an installed PWA is backgrounded rather than unmounted, so a player who leaves the app and comes back hours later is looking at a screen that never asked again.

The client therefore refetches on `visibilitychange` when the document becomes visible, and applies the answer only if nothing local changed the list while the request was in flight — a cancel must not be undone on screen by a response that left the server before it.

There is deliberately **no periodic refetch** beside it. While the screen is visible the figures in the banner move only when a sample is accepted, and `POST /api/samples` already returns the visits it touched. The one thing a timer would catch that this does not is a visit expiring under a screen that stays continuously visible for the whole of `VISIT_EXPIRY_MS`, and buying that costs every open client a repeating authenticated request against the Pi for a transition that happens at most once per visit. See O14.

**The confirmation must be reachable.** The banner occupies a bounded, scrollable row of the map's overlay layout (Section 8.3), and the confirmation is the tallest thing it renders. With two pending visits on a phone this is not hypothetical — it was photographed: the banner filling the upper half of the screen with its own scrollbar, and the second visit's cancel control cut off mid-glyph at the row's edge.

Opening the confirmation therefore scrolls its buttons into view rather than trusting them to be on screen, and the banner is capped at the row's height so that it keeps a visible bottom edge instead of appearing to end mid-sentence. A control below a clip the player cannot see is indistinguishable from a control that does not work.

**Accepted trade-off.** A player who checks in, leaves, and returns 20 minutes later completes the visit without having stayed. This is inherent to a two-sample model and is accepted: the mechanic is a social prompt, not an audit. Do not add continuous-presence enforcement in v1 — it would require either background tracking (impossible, Section 7.2) or punishing users whose phone slept. Revisit only if abuse is observed.

**Transparency requirements — these are product requirements, not suggestions.** The mechanic must be legible at every moment:
- An active pending visit is shown persistently at the top of the screen: bar name, confirmed time, remaining time. **The confirmed figure is the server's `confirmed_s` for that visit** — the elapsed time between check-in and the most recent accepted on-site sample, as Section 5.7 defines it — and the remaining time is derived from it as `VISIT_REQUIRED_S - confirmed_s`, floored at zero.

  It is **not** the wall-clock time since check-in. The two agree only while the player is standing at the bar with the app open, and diverge the moment they walk away, at which point the wall clock asserts a presence that never happened: a visit checked into two hours ago and abandoned would read as two hours confirmed with nothing remaining — a banner claiming a complete visit that cannot complete.

  This does not mean a banner frozen at check-in. `confirmed_s` is recomputed on every accepted on-site sample (step 3 above), so while the player is at the bar with the app open the figure keeps advancing on its own: it *steps* forward once per accepted sample rather than ticking once per second, and the remaining time steps down with it.

  What it must not do is advance between samples, or advance at all once the player is out of range. The last confirmed value is where it stops, and it stays there until either a new on-site sample moves it or the visit ends. A frozen banner while the player is standing in the bar is the same defect in the other direction, and a client-side timer is not the way to avoid it — the fix is to reflect the server's figure as it changes, not to interpolate between the values the server has actually confirmed.
- Explicit wording of what is needed, matching the state the visit is actually in. On site: *"Open Tipsy Trails again while you're still here to complete this visit."* Away from the bar, the instruction is the opposite one — return to the bar and open the app there to finish — and the on-site wording is replaced by it rather than shown alongside it. A banner that says a player has moved away and, directly beneath, tells them to stay where they are is not guidance; it is two sentences that cannot both be true.
- A Web Push notification at `VISIT_PUSH_AFTER_MS`, dispatched by the maintenance job (Section 7.9) and recorded in `push_sent_at` so it fires at most once per visit, and only while the visit is still `pending`.
- If a sample arrives out of range, show *"You've moved away from {bar} — your visit is still pending"* rather than silently failing, and switch that visit's guidance to the return-to-finish wording of the bullet above.
- A short "How mastering works" explainer is reachable from the More sheet (Section 8.4) and shown once after the first check-in. "Shown once" is client-side state in `localStorage`; no server column for it.

Multiple simultaneous pending visits are allowed (adjacent bars); each is evaluated independently. At most one pending visit per bar (Section 5.7).

### 7.6 Progress

- **Area explored (district)** = `fog_district_progress.revealed_cells / districts.playable_cells * 100`
- **Area explored (city)** = `fog_state.revealed_cells / cities.playable_cells * 100`
- **Bars mastered** = count of distinct bars with a completed visit, city-wide and per district.

### 7.7 Badges

Two kinds, three periods, fixed thresholds (Section 7.1). Thresholds are constants in code — not admin-editable in v1.

- `explorer`: percent of **playable city area** newly revealed within the period, summed from `fog_daily_progress` over the period's days and divided by `cities.playable_cells`.
- `barfly`: bars newly mastered within the period — that is, bars whose *earliest* completed visit falls inside the period. A second completed visit at an already-mastered bar counts for nothing.

**Design intent — read this before tuning any threshold.** A badge is a *competition*, decided once per period: it goes to the period's highest scorer, not to everyone who was active. The threshold is a **floor, not a target** — it exists only so the badge cannot be won by being the least inactive person in a quiet period. Thresholds are therefore deliberately easy, and should be lowered rather than raised if real-world use shows them excluding genuinely active players; raising one does not make the badge harder to win, it only makes "nobody won" more likely.

The threshold is **never shown to users and no endpoint returns it**. Neither is any rank or standing: not "you are 2nd", not "0.3% to go". The profile shows a player their own value for the running period and nothing else, so the only thing a player can read off the game is what they themselves did. Since v1.31 the profile does show something about badges *nobody* has won yet — placeholders, below — and that is a statement about which badges exist rather than about where the player stands; the paragraph that introduces them bounds exactly what they may carry, and none of it moves.

**Awarding.** Candidates for a period are the users whose value is **greater than or equal to** the threshold for that period. If there are none, the badge is not awarded at all. Otherwise it goes to the candidate with the highest value, and to **every candidate tied at that highest value** — a tie awards all of them rather than being broken. (Section 7.8's "earliest achievement" tie-break orders the leaderboard and has no part in deciding a badge.)

**An account with `excluded_from_rankings` set (Section 5.3) is not a candidate, for either kind.** The exclusion is applied to the candidate set *before* the highest value is found, and the ordering matters: it makes the guarantee two-sided, so an excluded account can neither win a badge nor be the high scorer that denies one to a player still in the competition. The best remaining candidate wins instead, exactly as if the excluded account had never scored.

It is applied to the candidate set and **not** to the per-user value functions those candidates come from, because Section 7.8's leaderboard and the profile read the same functions and an excluded player still reads their own figures on their own profile. One placement covers both `explorer` and `barfly`, since both kinds pass through the same awarding step; two separate filters would be two things that could come to disagree about who is in the running.

Setting the flag revokes nothing. A badge awarded before it was set stays awarded, because badges are a permanent record (below) — the exclusion decides future evaluations and present listings, never the past.

Badges already awarded are a permanent record of the periods a player won and are never revoked. Evaluation runs as a scheduled job shortly after each period closes — weekly Monday 04:00, monthly 1st 04:00, yearly Jan 1st 04:00, Europe/Berlin — and badges are written to the `badges` table.

The job is idempotent through the `UNIQUE (user_id, kind, period, period_key)` constraint plus `INSERT ... ON CONFLICT DO NOTHING`. It takes the period key as an optional argument so a missed period can be re-run by hand.

The player's own value for the running period is shown on the profile, per kind and period, computed from the same `fog_daily_progress` sums. It is a plain reading of what they have done — no bar, no target, no percentage of a target, no rank.

Badges are prominent and public: rendered on the profile as a badge shelf, and as compact icons inline in leaderboard rows. Anonymous users' badges are shown against their anonymous handle.

**Each of the six has a name of its own, and the six are not composed from two vocabularies.** Until v1.38 a badge was titled by joining a kind word to a period word — "Explorer · Week", "Barfly · Year" — which is a naming *scheme* rather than six names, and it produced "Barfly · Year" for the thing the owner calls a Bar Legend. The names are his and they are these:

| period | `barfly` | `explorer` |
| --- | --- | --- |
| week | Bar Hopper | Explorer |
| month | Bar Champion | Explorer Champion |
| year | Bar Legend | Explorer Legend |

They are deliberately not composable — "Bar Hopper" and "Bar Legend" share no word, and "Explorer" is the whole name of the weekly explorer badge rather than the kind half of it — so the lookup is keyed on the pair. **A consequence has to be paid for and is:** a name that has stopped saying "week", "month" or "year" has stopped telling a screen reader user which of three badges this is, and the star or crown that carries the period on screen is silent. So the period stays in the accessible layer, as a word after the name — "Bar Legend badge, year" on the shelf, "Bar Legend, year" as the sheet's dialog name — and the copy that provides it lives beside the catalogue with the names.

**The glyph is two parts, and each part carries one axis.** The kind is a solid ink pictogram: a compass in its case for `explorer`, and for `barfly` a cocktail glass that is explicitly **not** the martini of Section 8.1 — a tapered highball with a straw crossing out of it and a garnish on the rim, told apart from the martini by its outline alone. The period is a modifier drawn above the pictogram: **nothing** for a week, a **star** for a month, a **crown** for a year. This replaced a ring frame whose stroke count carried the period, and the reason is size: a badge is drawn inline in a leaderboard row at 1.25 rem for the whole glyph, where counting one, two or three thin concentric circles is a task and "is there a crown on it?" is a silhouette. The pictogram does not move or grow when the modifier is absent, so the three periods of one kind read as one badge with something added.

**The explorer pictogram is a compass with a case, and v1.38's bare rose was the defect.** The owner asked, of a glyph that was already a compass rose, "can we make it a compass or something similar" — which is evidence that the drawing did not read as one, not a request for a shape it had. A rose is four long points and four short ones; at 1.25 rem that is a star. The month modifier drawn above it **is** a star, so "Explorer Champion" was a star under a star: the two halves of a glyph built to carry two axes drawn in one visual language. The case is what separates them — a ring with a north-pointing needle inside it has a closed outer silhouette, which nothing else on this shelf has and no star resembles, and a closed outline is the feature that survives being made small. The requirement is the case and the needle; the numbers are in `components/Badge.tsx` beside the path, with what an offline rasteriser showed at 20 device pixels. Nothing in this repository can see it rendered, so whether it reads as a compass is settled on a phone and nowhere else.

**A badge a player has not earned is shown as a placeholder, and what makes a placeholder work is what it leaves out.** Under their own shelf a player sees one placeholder for every badge type they have never held: **the same artwork as the real thing, pictogram and modifier both**, drawn back in ink, inside a **dashed frame**. The owner asked for exactly that — "just use same as real badge but in light grey maybe transparent; your frame idea is okay" — and the frame is required rather than decorative, because grey against ink is a difference in lightness alone and Section 8.1 does not allow a distinction to rest on one channel. It is named as unearned in words, first words first, so nothing on the shelf can announce to a screen reader a badge its owner does not have.

This replaced a hollow mark and broken rings (v1.31–v1.37). The rings went with the period they used to count, and hollowing the mark had become actively wrong: a wall of ink around an empty middle is Section 8.1's grammar for a **mastered** cocktail glass, and the `barfly` pictogram is now a cocktail glass. An empty frame around a badge says the thing the state actually is — a place kept for something not there yet.

A placeholder **may** say that the badge exists, which kind it is, which period it belongs to, and — qualitatively, in words — the activity that earns it. It **may not** carry the threshold, the player's distance from one, a rank, a standing, a share of a target, a progress bar, or **anything that changes as the player's own value changes**.

That last clause is the operative rule and not a restatement of the others: a placeholder that looked different once a player passed the floor would hand the floor straight back, readable by walking until the pixel changed. The set of placeholders therefore depends on which badges have been *earned* and on nothing else.

The question a placeholder is meant to raise — *what do I have to do to get that?* — has no numeric answer even in principle, because a badge goes to the period's best rather than to everyone past the floor. The profile says so in words rather than leaving a player to invent a number: it names the two activities and states that each badge goes to whoever does the most of it in its period. It stops there. An earlier wording closed with "no fixed score wins one"; that clause is cut, because the sentence before it already denies the existence of a score to reach, and the shorter line is the one a player actually reads.

**A placeholder disappears at the first award and does not come back.** A type is off the shelf permanently once it has been won once, in any period key, because badges recur and a placeholder that returned each period would be shown to a player who owns several of that badge, blinking off only when the evaluation job ran. Since awarded badges are never revoked, the earned set only grows and the placeholder set only shrinks, so neither can flicker.

**Placeholders belong to the player whose question they raise.** They appear on that player's own profile, and not in leaderboard rows, and not on another player's profile — where "three of the six" would be a completion score comparable between players, which is a standing by another name.

**Since v1.36 a badge can be asked what it is, and since v1.38 the answer is four things.** On their own profile a player may open any badge — earned or placeholder — into a sheet carrying the same mark drawn large, the badge's name, one sentence, and whether they hold it. The sentence is the same on all six and is the whole of the copy: *"Each badge goes to whoever does the most of it in the period."* It carries no threshold, no distance from one, no rank, no standing, no share of a target and no digit at all.

**The per-badge description is gone, and that is the owner's decision rather than a simplification.** His words: "Remove the detailed description for all of them, the name is enough", and, for the line that stays, "As description only: Each badge goes to whoever does the most of it in the period. Not more." So the two sentences of rule and window that v1.36 introduced — what each kind counts, over what window, in Europe/Berlin — are removed along with the vocabulary that composed them. Nothing that was said there was wrong; it was more than a player wants under a name like Bar Legend. What each kind rewards is still stated once, on the profile, under the placeholders that raise the question, and that is where it belongs: it answers "what do I have to do to get *those*", which is a question about the six and not about one. The names and the one sentence are copy and live in `packages/shared/src/badges.ts` beside the catalogue they are keyed on rather than beside the component that draws them.

**On an earned badge the sheet names the period won and the value it was won with**, formatted in that kind's own unit — a percent of the city for `explorer`, a count of bars for `barfly` (Section 5.8's column comment). That value is the player's own past achievement rather than a target, and it is already public: every award the API returns has carried it, in leaderboard rows as well as on the profile, since Phase 6. The period key is rendered as "week 32 of 2026" or "August 2026" rather than as a date range, because converting an ISO week to a Monday and a Sunday is arithmetic this needs no answer from.

**On a badge never held, the status line is "Not yet earned." and nothing else.** The placeholder rule extends to the sheet without weakening: no part of it may change as the player's own value changes, and the way that is guaranteed is that the sheet is handed no value at all for a badge nobody has won.

**The sheet is offered where the placeholders are offered, and nowhere else** — the player's own profile, not leaderboard rows and not another player's profile, where asking one glyph at a time what a badge is and whether that player got it assembles by hand the standing this section declines to publish. A badge is therefore a **button** exactly where the sheet is offered, and stays a picture everywhere else.

### 7.8 Leaderboard

Public, ranked by two switchable metrics: area explored (%) and bars mastered. All-time by default, with week/month filters.

- All-time area comes from `fog_state.revealed_cells`; week/month area comes from `fog_daily_progress`.
- All-time bars is the count of distinct mastered bars; week/month bars uses the earliest-completion rule from Section 7.7.

Ties are broken by earliest achievement, then by `users.id`, so ordering is stable across requests. Paged at `LEADERBOARD_PAGE_SIZE`.

**"Earliest achievement" needs a definition, because a running total has no single instant it was achieved.** The normative reading, applied identically in `packages/api/src/badges.ts` and `routes/leaderboard.ts`, is *the instant a user's value last rose to what it now is*:

- all-time area — `fog_state.updated_at`, since the mask's last write is the last time `revealed_cells` changed;
- week/month area — the latest day among those summed into the period total;
- bars, any period — the completion that pushed the user's mastered-bar count to its current total.

A user who never scored on a metric has no achievement instant at all and falls through to the `users.id` tie-break, exactly as a genuine tie does. This tie-break orders a *listing* only; it takes no part in awarding a badge (Section 7.7).

Users with `is_anonymous = 1` appear as `Player #{id}` with a neutral avatar. They remain ranked and their statistics are still recorded — only the display identity is masked. The setting is toggleable at any time and takes effect immediately.

**Users with `excluded_from_rankings = 1` (Section 5.3) do not appear at all, and are not counted.** The two flags are not variations on each other: anonymity masks a row that is still there and still ranked, while exclusion removes the row. The filter therefore sits in the query that lists users, not in a pass over the result, so `totalUsers` and `totalPages` are counted after it — a page count that includes a user nobody can see is its own bug, and an excluded account must not occupy a rank either. The next player up is rank 1.

Everything else about an excluded account is unchanged: it keeps its fog, its mastered bars, its badges and its own profile figures. Only the ranked listing and the badge race (Section 7.7) skip it, and both read the one flag, so an account cannot be ranked in one and scored in the other. Clearing the flag puts the account straight back, with its full history intact.

### 7.9 Scheduled work

Everything periodic runs inside the API process — no cron container, no external scheduler.

**Maintenance tick**, every `MAINTENANCE_INTERVAL_MS`:
- Expire pending visits whose `last_sample_at` is older than `VISIT_EXPIRY_S`.
- Dispatch the 21-minute reminder push for pending visits where `now - started_at >= VISIT_PUSH_AFTER_S` and `push_sent_at IS NULL`.
- Purge sessions past `expires_at`.

Because the tick is cheap and idempotent, a missed tick after a restart is self-healing. Pending-visit status is additionally evaluated lazily on read, so `GET /api/visits/pending` never returns a visit that should already have expired even if the tick has not run.

The tick **never reads the clock**; it takes `nowS` as a parameter and every statement inside it works against that one time. That is what makes it a pass over current state rather than a step forward from the last run — the property the self-healing above depends on — and what makes it drivable across hours in a test without faking timers. It is asynchronous, because push dispatch is network I/O and the tick owns it. `purgeExpiredSessions` takes the same `nowS` for the same reason, and exists as one statement with one caller rather than a second copy of an auth-critical `DELETE`.

**Badge evaluation**, at the period boundaries in Section 7.7. On boot the job checks whether the most recently closed period of each kind has been evaluated and runs it if not, so a Pi that was off at 04:00 still awards badges. Between boots the same catch-up entry point runs every `BADGE_EVAL_INTERVAL_MS` (hourly).

Hourly is enough to satisfy "shortly after each period closes", since periods only close at 04:00 Europe/Berlin, and it needs no cron parser or precise-boundary scheduling: the entry point is idempotent and already knows from the `UNIQUE` constraint whether a period was evaluated, so re-running it over a period it has already covered costs nothing.

---

## 8. Design and User Interface

### 8.1 Visual direction

**A hand-drawn ink map.** Desaturated, slightly warm paper ground. Lines read as if drawn with a pen or brush rather than as clean vectors — subtle weight variation, imperfect edges. Roads are fine black lines: the major ones everywhere, the minor streets only on ground the player has explored. Water and green areas are loose hatching and stipple textures rather than filled colour. Symbols are solid black pictograms with no gradients, shadows, or outlines. The overall impression is quiet, near-monochrome, and generous with empty space.

**The fog.** Unexplored terrain sits beneath a milky grey fog with a crisp but irregular edge, dense enough to hide detail and uneven in its density from one patch of the city to the next — organic rather than patterned, and never a texture a player could recognise as repeating. The major roads and the water stay legible there, and they do so by being drawn *above* the fog rather than showing through it, while buildings, green areas, parks and the minor streets are hidden beneath it. Section 7.3 is the authority on all of it, including the layer order.

(This paragraph said "only major roads" until v1.16, when the minor streets were added below the fog. Section 7.3 is the later and more specific decision, and this text is corrected to agree with it rather than left to be read alone and acted on.)

**District boundaries** are drawn over the whole map as broken lines in the same ink — dashed because that is what tells a boundary apart from a street on a near-monochrome map, where weight and opacity alone cannot (Section 7.3).

**One accent colour is permitted across the entire application:** a muted red, reserved for the player's own position and for active states.

Beside it, and only there, a small named set of status colours is permitted — used by the three status icons of Section 8.6 and by nothing else, and never as an accent. This is a deliberate narrowing of a rule this document set, and the reason is worth recording: those icons keep a fixed shape by decision, so colour is the only channel left to them, and one accent cannot express three states of three different things. The narrowing is bounded on purpose — one accent, one indicator, a fixed and named set of colours — so the restraint the rest of this direction rests on survives it.

This direction applies to the whole application, not only the map. Chrome, typography, and controls follow the same restraint.

**The cocktail glass is the application's central mark, and it says whether a bar is mastered.** A martini glass in ink stands for a bar everywhere a bar is drawn, and it has exactly two states: **full** for a bar the player has not mastered, **nearly empty** for one they have (Section 5.7). It is one definition — the same paths, used by the map marker, by the bar sheet and by the bar detail screen — rather than a shape redrawn in each place, because three copies of a mark are three marks that drift, and the two states are precisely what must not.

Four constraints bound it, and each of them is the whole point of one of the decisions above rather than a note about taste.

- **The states differ in shape, not in fill or colour.** A full glass is a solid bowl of ink; a mastered one is the same bowl as a wall of ink around an empty middle, with the last of the drink left at the bottom. That is most of the mark's area appearing or disappearing, which reads at a glance, reads for a player who perceives no colour at all, and survives at 22 px on a map marker — where a difference visible only at 3× zoom is not a difference.
- **It stays a silhouette in ink.** The accent colour is reserved for the player's own position and for active states, and a mastered bar is neither. Both states are `currentColor` and nothing else.
- **The state is also in words.** A screen reader user gets nothing from a fuller or emptier glass, so the mastered state joins the accessible name of anything whose whole content is the mark (the map marker), and stands as visible text beside it everywhere else. This is the same rule the paragraph below states generally; it is repeated here because this mark carries a state whose only other channel is a shape.
- **It is a statement and never a control.** Mastering is earned by a check-in (Section 7.5) and by nothing a player can tap on the mark itself. It does change the moment it is earned: a sample response that reports a visit reaching `completed` refreshes the bar list behind the markers, so the glass on the map empties then rather than the next time the screen is opened.
- **It is also the mark that is stamped onto the map when a bar is discovered** (Section 7.4) — a fourth surface drawing from the same paths, not a fifth shape. It stays a silhouette there too: a discovery is neither the player's own position nor an active state, so it gets no accent colour, and what makes the moment read is the dim behind it and the movement. A bar being discovered has not been mastered, so in practice it is always the full glass; it is nonetheless drawn from the bar's own flag rather than assumed, because the stamp's last frame and the marker it hands over to have to be the same shape.

The mark deliberately does not appear on the nearby-bars panel, which names what is in range and is a `role="status"` statement carrying no per-bar affordance (Sections 7.5, 8.3), nor on the admin bar list, which is moderation rather than play and is not scoped to one player's mastery at all.

**And it does not appear on the badges, which is a rule about this mark and not about badges.** Section 7.7's `barfly` badge is a cocktail glass too, and it is a *different* cocktail glass on purpose: the martini's silhouette carries a state (full, nearly empty) on four surfaces already, and a fifth surface wearing it where no state applies would make the shape mean two things. The badge glass is therefore a tapered highball with a straw and a garnish — no stem, no foot, no triangular bowl — and it is drawn from its own definition beside the other badge artwork rather than from `cocktail-glass.ts`. Two glasses in one application is a cost; one silhouette meaning two things is worse.

**The badges are ink, and there is nothing else in them.** They are the surface most likely to attract a colour — they are the thing on the profile a player is meant to want — and the answer is the rule as written: the accent belongs to the player's own position and to active states, and a badge is neither. Pictogram, period modifier, and the placeholder's frame are all `currentColor` over paper, with no gradient, no shadow and no outline. What a badge has to be worth having by is the drawing: a compass with a case around its needle, a crown with weight, a glass that is a glass at 1.25 rem.

**The wordmark is on every main screen, and it is one wordmark at two sizes.** "TIPSY TRAILS" is set in the serif of Section 8.2, in capitals, with wide letter-spacing, in ink — one definition used everywhere, so that the application reads as one product rather than as a collection of screens that happen to share a palette.

It has exactly two prominences: **hero**, where the wordmark *is* what the screen is about (the start screen and the landing screen), and **chrome**, where it is the application signing a screen that is about something else (the map, the city overview, the leaderboard, a profile). Nothing else varies between them — not the family, not the case, not the weight, not the colour, not the ratio of tracking to type — because a mark that is restyled per screen is several marks.

**Since v1.38 the chrome mark is also a link to the start screen**, which the owner asked for in one sentence and bounded in the next: "I would like that we can press the logo and get to the start screen", and "when we click the logo we should not be logged out, just land at the same page". So it leads to `/app` and to nowhere else, and it is **inert** in the two places where leading there would break the second sentence — on `/app` itself, where a control that visibly does nothing is worse than plain text, and on the signed-out landing screen, where `/app` is behind the auth guard and a tap would arrive at `/login`, which is the "logged out" outcome being ruled out. Both of those are the hero form, and the hero form takes no link at all: the component's props admit the question only on the chrome form and require an answer there, so a screen cannot forget to decide.

Three things follow. It is an ordinary link with the mark as its whole content and **no explanatory suffix** — a wordmark leading home needs no instructions read out with it — so what separates it from the inert mark for a screen reader is the role rather than the name: "Tipsy Trails, link" against "Tipsy Trails". It carries **no underline**, because an underlined wordmark is a different mark from the hero one and this section allows no such difference. And it reserves Section 8.2's 44 × 44 px around a line of type that is about 22 px tall, which means roughly half its target is padding nobody can see; on the map, where that padding sits over a surface whose one gesture is a drag, the box stays shrink-wrapped to the width of a single non-wrapping line rather than stretching across the top of the screen.

Six things bound it, and each is a decision rather than a note about taste.

- **Its alignment belongs to the mark, not to the screen hosting it.** Both prominences state their own `text-align` — hero centred, chrome left — instead of inheriting whatever the screen aligns its content to. Inherited, the chrome mark was centred on the city overview and on the leaderboard and hard left on a profile, which is the only screen overriding the default, so the application's signature moved as a player crossed between tabs. It is left on every screen that carries it as chrome. The map's corner mark is unaffected by that declaration and cannot be — there the wordmark is a flex item shrink-wrapped around a single non-wrapping line, so there is no leftover space in the line box for any alignment to distribute — which is exactly why the map needed the *markup* fixed instead: what put the mark on the wrong side there was the row's child order, and Section 8.3 records the swap.
- **Small and quiet is the default; loud is the exception.** The owner's instruction was explicit that this must not become a large header bolted onto every screen. On the map the wordmark is a small line in the top row of the overlay grid, taking no space from the map. Prominence is spent where the screen has nothing more important to say, which is the two entry screens and nowhere else.
- **It takes a pointer event on the map, and it is the only thing in that corner that does.** This bullet said "no pointer event from a drag" until v1.38, and that was the right rule for a mark: the overlay container passes events through to the map and its rows hand them back, so a mark that is not a control gives them up again and cannot swallow a drag. A link cannot, so the map's wordmark takes them — and the two rules both exist, the second scoped to the link, so the first still holds for a chrome mark that leads nowhere.
- **It goes into the layout the screen already has.** On the map it is a member of Section 8.3's overlay grid — the **first** child of an existing row — and not an absolutely positioned element on top of everything. An overlay grid that a mark is allowed to bypass is not a grid. It was the second child until v1.38, which cost the status icons nothing and cost the mark its position: that row is `justify-content: space-between`, so the second child takes the right-hand end, and the application's signature therefore sat right on the map and left on the four screens around it. Section 8.3 records what swapping them moved.
- **The element it renders as is chosen per screen, and heading structure is why.** Rendered as an `<h1>` everywhere, "Tipsy Trails" would silently become the title of every page, and a reader navigating by heading would be told the name of the application instead of the name of the screen they are on. So it is the `<h1>` only where it is the subject; where it is chrome it is an inert element above the screen's own heading, and every screen keeps exactly one sensible `<h1>`.
- **The capitals live in the stylesheet, not in the document.** The markup and the accessible name carry the ordinary name of the application, exactly as Section 7.4's stamp caption does, so what a screen reader announces is a name and not shouting.

Its typography is deliberately achieved with the two families this application already has, and Section 8.2 records why there is no third.

**A state may not rest on grey either.** The rule above is written about the accent colour, and v1.31 found the gap: greying something out is a difference in lightness, which survives no black-and-white print and is the weakest signal on a palette that is already near-monochrome. So the badge placeholders of Section 7.7 are greyed *and* framed in a broken line, and anything else that separates two states by drawing one back must likewise put the same distinction into shape, weight or label. Since v1.38 the artwork inside the frame is identical in the two states, by the owner's instruction, which leaves the frame as the only channel that is not lightness — so it is load-bearing rather than decorative, and removing it would leave the distinction resting on precisely the one channel this paragraph exists to forbid.

**Restraint does not override legibility.** A near-monochrome palette makes it easy to land below WCAG AA contrast without noticing. Body text and interactive labels meet 4.5:1 against their background, large text and icons 3:1. The accent red is never the only carrier of meaning — active states also change shape, weight, or label.

The status icons of Section 8.6 are the single exception to that last sentence, admitted by the same decision that narrowed the palette above, and they pay for it under their own rule: their colours must separate in luminance, not only in hue. This is checked in Phase 8.

### 8.2 Typography and layout

- One serif family for headings and map labels, one neutral sans for UI text. **Both are system stacks, and no webfont is loaded at all** — `--font-serif` is a Georgia stack and `--font-sans` a `system-ui` stack, declared in `packages/web/src/index.css` and nowhere else.
- **Why there is no webfont.** This section said "both self-hosted, subset to Latin, `font-display: swap`" from v1.1 until v1.32, describing a plan that was never built. The correction is recorded rather than quietly applied because the reason matters more than the fact: a downloaded face is a request on the first paint of the first screen a player ever sees, a flash of something else while it arrives, and — on a bad connection or a blocked host — a brand that never arrives. `font-display: swap` is a mitigation for that failure, not an answer to it. Two families already on the device cost nothing and cannot fail to load, which is why the wordmark of Section 8.1 takes its identity from case, tracking and spacing rather than from a face of its own. **Adding a third family is a decision about the whole application and not a styling detail**, and this bullet is where it would have to be argued.
- Minimum tap target 44 × 44 px. Bottom-anchored primary actions (thumb reach).
- **The content column has a width; it does not take one from its contents.** Every screen is a column flex container holding one centred content block capped at 32 rem, and that block states `width: 100%`. Without it Flexbox does not stretch the block at all — the `margin: 0 auto` that centres it is an auto cross-axis margin, and the stretch step applies only where neither cross-axis margin is auto — so the column was as wide as whatever text happened to be inside it, and a `width: 100%` child contributed nothing to that measurement. Two field reports came from that one omission: the district overview's schematic map shrank the first time a district was selected, because a long hint was replaced by a short name and a percentage; and the chrome wordmark on the profile screen, the only screen that left-aligns its content, sat near the middle of the screen while the profile loaded and jumped left when it arrived. **A screen's layout may not depend on the length of the text on it.**
- **The app extends under the device's safe areas, and pads around them itself.** `index.html`'s viewport meta tag carries `viewport-fit=cover`, without which `env(safe-area-inset-*)` reports `0px` in an installed iOS PWA and the bottom tab bar sits flush against the home indicator with no clearance at all. Turning that on makes the top edge-to-edge too, so both insets are read from one named token each — `--bottom-nav-inset` and `--safe-area-top` — declared once in `:root` and referenced by name everywhere else.
- **A second raw `env()` anywhere in the stylesheet is a second element claiming the same strip of screen**, and it doubles the gap rather than widening it. The stylesheet's own tests enforce the single declaration and the two places that must read the top token: `.screen`, and the map's top controls row, which sits at the physical top edge because the map screen is `position: fixed`.
- Respect `prefers-reduced-motion`: disable the fog dissolve animation and all transitions.
- **Reduced motion removes the movement and keeps what the movement was saying.** Disabling a feature outright because it happens to be animated is the same failure as ignoring the setting: a player who asked for less movement still has to be told they discovered a bar. So Section 7.4's stamp under `reduce` has no scale, no travel and no fade, while its mark, its caption, the bar's name and its spoken announcement are all still there and still go away on their own timer.
- **Collapsing every `animation-duration` to nothing does not satisfy that**, which is why the blanket rule above is not enough on its own: it runs an animation straight to its **last** keyframe, and anything that ends by fading out ends invisible. Such an animation must be dropped rather than shortened, and the resting state it leaves behind must be the finished thing rather than the first frame of it.

### 8.3 Screens

| Screen | Content |
|---|---|
| Landing | The wordmark at hero prominence (8.1) as the screen's own heading, one-line pitch, Sign in / Register |
| Register | Username, password, security question, security answer, 18+ checkbox |
| Login | Username, password, "Forgot password?" |
| Password reset | Username → security question → answer → new password |
| Change password | Forced when `must_change_password` is set; also reachable from Settings |
| Start screen (`/app`) | The wordmark at hero prominence (8.1) as the screen's own heading, one line under it, one action — "Open the map" — and, quietly below that, the player's own three figures: bars discovered, bars mastered, percentage of Karlsruhe explored. Behind all of it, a heavily fogged crop of Karlsruhe's real outline with its district edges drawn inside it, dissolving to nothing before every edge of the screen. See below |
| City overview | Karlsruhe outline with overall progress; neighbouring municipalities drawn greyed out and non-interactive |
| District overview | All districts with individual progress percentages; tap to zoom in — which opens the map framed on that district, see below. The detail panel under the schematic map reserves its tallest state in both states, so selecting a district cannot change the page's height or the map's size |
| Map (main) | Fog map, district boundaries (7.3), own position and direction of travel, discovered bar markers drawn as the cocktail glass of Section 8.1, full or nearly empty by whether that bar is mastered (5.7) — tapping one opens that bar's sheet **on this screen**, carrying the check-in action and the same mark (7.5) — the discovery stamp (7.4), pending-visit banner, nearby-bars panel (names the bars in range, carries no check-in and no mark — 7.5), the wordmark at chrome prominence leading the top row of the overlay grid, and the GPS/connection/tracking icons at the opposite end of the same row (8.1) |
| Bar detail (`/bars/:id`) | Name, address, district, mastered status — the cocktail glass of Section 8.1 with the state in words beside it — community tag if applicable. The linkable page for a bar; it carries **no** check-in action, and 7.5 explains why |
| Profile | Username, avatar, badge shelf — on the player's own profile followed by a placeholder for every badge they have never earned (7.7), and there every badge opens a sheet describing it, see below — area %, bars mastered, this period's own totals (no target, no rank — Section 7.7) |
| Leaderboard | Ranked list, metric toggle, period filter |
| Suggest a bar | Map picker + name + address. The picker draws the ink style and the pin only — no fog and no bar markers; see the admin's teleport picker below for the one caller that adds them |
| Settings | Anonymous toggle, push permission, change password, how-it-works, privacy, delete account, logout |
| Privacy | Static page at `/privacy`, see 10.3 |
| Admin (admins only) | Bar management, community bar moderation, user list, and Section 9.3's teleport with its own map picker |

**The start screen is arrived at, not lived on, and it is built for that.** Every authenticated entry path lands on `/app` — signing in, registering, completing a forced password change, and the route guards — so it is the first thing a player sees after signing in and the last thing they see before the map. It is deliberately *not* a tab: Section 8.4 fixes the five, and none of them is this screen, so a player passes through it rather than returning to it. That is what makes "Open the map" its one action rather than one of several.

**Its backdrop is the city outline, and it is explicitly not a map.** The requirement was "ein stark vernebelter Ausschnitt der Karlsruhe-Karte", and mounting a real map to satisfy it would be wrong on this screen above all others.

Three reasons, and they compound. The map route is lazily loaded on purpose (Section 12's bundle budget: MapLibre and PMTiles are ~250 KB gzipped and must not enter the shell chunk), and the one screen whose whole job is a fast, strong first impression is the last place to undo that. Section 7.3's fog additionally needs an authenticated binary mask fetch, the heaviest request the game makes, and WebGL2, which is not guaranteed — which is why there is a canvas fallback at all. And the fog is a *mechanic*: a second, decorative copy of it would either duplicate the renderer or drift from it, and decoration must never be the thing that fails.

So the backdrop is the same real geometry the city and district overviews draw — `GET /static/<slug>/city.geojson` and `GET /static/<slug>/districts.geojson`, projected and rendered as inline SVG — cropped to the screen and fogged with the application's own ink.

**It is a fogged detail of a map, and each of those three words is a decision.**

*A map.* The city fill alone is an administrative outline with nothing inside it, which reads as a silhouette rather than as a city. The district edges are drawn over the fill as hairlines a step darker than it, and they are what make it read as somewhere.

*A detail.* The drawing is fitted into a viewBox twice as tall as it is wide and covers the screen with `preserveAspectRatio="slice"`. That aspect sits between the two real phones have (9:16 and 9:19.5), so covering crops a little of one axis on any of them. A square viewBox is what must not be used: `slice` scales to cover, so a square drawing on a portrait phone is magnified past 2x and more than half of it is cut away — a fragment, not a crop. Within that box the city is fitted to a band across the top, so the action and the row of figures at the bottom of the screen have paper under them rather than the busiest part of a map.

*Fogged.* The drawing is masked by one radial gradient in the screen's own coordinates — solid over the middle of the city, falling to full transparency before every edge — because fog has no border and an unmasked drawing terminates as a crisp boundary that reads as a grey cutout laid on the page. The mask is a CSS mask on the element rather than an SVG `<mask>` inside it, and the reason is the `slice` above: an SVG mask lives in the drawing's user space and would be cropped along with the artwork on whichever axis is cropped, putting the hard edge back exactly where it was removed.

Nothing about it moves. Drifting fog would be motion behind text, and Section 8.2's reduced-motion rule collapses an animation's duration rather than removing it, which runs one to its final keyframe.

Four rules bound it, and the first three are about what happens when it is not there.

- **It degrades to nothing, and nothing is a complete screen.** Both boundaries are network fetches and either can fail or be slow. The wordmark, the line, the action and the figures are the screen; the backdrop is atmosphere. It is drawn out of the document flow, so arriving late, arriving never, or arriving with different bounds than expected cannot move a word in front of it — and there is no placeholder box to collapse, no spinner to flash. A visible error on the entry screen would be worse than never drawing it at all.
- **The two boundaries fail independently, which is why they are two requests and not one `Promise.all`.** The district edges are detail inside the city fill, so districts that never arrive leave the fill standing and cost the backdrop only its interior; a combined all-or-nothing fetch would take the whole backdrop down for a decoration on a decoration. The frame is computed from the city's bounding box alone for the same reason: the two responses land at different moments, and a frame that depended on both would slide the drawing sideways a beat after the first paint.
- **The three figures are all-or-nothing, and they are silent when they fail.** Half a row — a bar count beside a blank where the percentage should be — reads as a broken screen where none of them reads as a screen that simply does not mention them. Their row is reserved before they exist, so numbers arriving a moment after the first paint cannot lift the action above them out from under a thumb already reaching for it.
- **The text over the backdrop meets Section 8.1's contrast floor against the fogged artwork**, not against the paper colour it would have had. Every tone in the backdrop is Section 8.1's ink composited over the paper at some ratio and then **painted opaque** — the fill is the ink at 22%, the district edges the ink at 34% — so no pixel is ever any colour but one of the two that are declared. That is what allows the drawing to have layers at all: translucent paint compounds where it overlaps, and a stroke over a fill, or the border two neighbouring districts share, would otherwise be a darker grey nobody had computed. The mask only ever moves a pixel from its declared colour towards the paper behind it, never past it, so the darkest pixel on the screen is the district edges' declared colour and the floor is measured against that, from the stylesheet itself.

The figures come from `GET /api/progress` (the same `city.percent` the city overview renders, so the two screens cannot disagree) and `GET /api/bars` (its length is what has been discovered; Section 5.7's per-user `mastered` flag is what has been mastered, the same flag the map's markers are drawn from). `GET /api/profile/:handle` was the alternative and cannot replace the second — it carries no discovered count — so it would have been two requests either way, the larger of the two, and one needing a handle to ask at all. The remaining cost is recorded honestly as O17: `GET /api/bars` ships every discovered bar to a screen that wants two integers.

**A badge on the player's own profile opens a sheet, and it is the same dialog the More sheet already is.** Section 8.4's sheet is this repository's dismissible modal — `role="dialog"`, `aria-modal`, focus moved into it on open and handed back to what opened it on close, and three ways out: Escape, a tap outside it, and its own closing control. The badge sheet takes that shape rather than introducing a second modal vocabulary. Like it, it is an overlay and not a route: no URL and no history entry, so the back gesture leaves the profile behind rather than stepping through a page nobody navigated to. Section 7.7 governs what it may say.

A badge that opens a dialog is a control, so on that one shelf it is a **button**: 44 × 44 px of target around a mark that keeps its own size (8.2), the focus ring every control on this palette needs, and `aria-haspopup="dialog"`. Its accessible name is the badge's name followed by the period — the names no longer carry one (7.7) and the crown that does is silent. It is drawn in ink and nothing else — Section 8.1 keeps the accent for the player's own position and for active states, and a badge is neither — so what offers the tap is the pointer and the focus ring, not a colour. Nothing in the sheet moves: it carries no animation at all, which is the one dependable answer to Section 8.2's reduced-motion rule collapsing an animation's duration and thereby running it to its final keyframe.

**Direction of travel.** The own-position marker carries a cone showing which way the player is heading whenever the GPS reports a course. It is the *course* — the direction of movement the Geolocation API derives from successive fixes — and not the direction the phone is pointed; no compass is read and no device-orientation permission is asked for. The Geolocation API reports no course while the device is stationary, so the cone is simply absent then: nothing is shown rather than a stale or northward guess, the same rule the marker itself follows before the first fix. The course is display-only — it never reaches the server (constraint C4, Section 10.2). The map is rotatable, so the cone is drawn at the course minus the map's bearing.

**The map turns, and it does not tilt.** Its gestures are pan, zoom and rotate. Pitch is not one of them, on the map screen or on the suggest picker.

The camera is capped at pitch 0, so a tilted state is unreachable by any route rather than merely awkward to reach: MapLibre clamps every pitch it is handed into the camera's own limits, which covers the two-finger vertical drag, the pitch half of drag-to-rotate, the keyboard's shift+arrow, and a programmatic move that carries a pitch. The two gesture handlers are disabled as well — the cap is what makes the rule hold, and turning the gestures off is what stops a finger from fighting a camera that will not move.

Nothing on this map is drawn for a tilted view; the fog is a flat quad rebuilt from the map's bounds, which grow by several times under pitch. No feature ever asked for one, so this closes a gesture that only ever surprised the player who found it.

**Rotation stays, and that is not the same decision.** Three things were built for a turning map and are correct: the fog quad follows the rotated viewport rather than a fixed rectangle (7.3), the direction-of-travel cone is drawn at the course minus the map's bearing (above), and the canvas fallback measures a cell as a distance rather than as an offset along the screen's x axis. Disabling rotation would undo all three to solve a problem rotation does not cause. Pitch and bearing are one gesture family in MapLibre's defaults and two different questions here.

**The map's top row leads with the wordmark, and the status icons sit opposite it.** That row is `justify-content: space-between`, so its two children take the two ends and the order in the markup decides which end each gets. Until v1.38 the wordmark was second and therefore right-aligned — the one screen in the application where Section 8.1's signature did not sit where it sits everywhere else — and the tracking cluster kept the top-left corner it had held since before the wordmark existed. Swapping them is a straight trade: the mark is now consistent, and the GPS/connection/tracking icons move to the top right. The owner was told and accepts it.

One thing moved with them and is not cosmetic. The tracking explanation is a panel absolutely positioned against the icons and 18 rem wide; anchored on its left edge it grew rightwards, which was correct from the left corner and runs off the side of every phone from the right one. It is anchored on its right edge instead, and still reaches the full width of the row on a narrow screen, from the other end.

**Text the map carries sits on a plate of paper, and the plate is as light as the darkest ground allows.** Two overlays are text on the map itself — the wordmark in the top corner and the OSM attribution in the bottom one (Section 10.5) — and the ground under either is anything from bare paper to fully fogged terrain to a run of road lines. Ink straight onto that has no contrast floor anyone can state, so both sit on a translucent paper fill.

How translucent is decided by the worst ground and not by taste. **Bare fog is not that ground**: over the densest fog Section 7.3 produces, ink clears Section 8.1's 4.5:1 with no plate at all, so nothing about the plate can be argued from it. What the plate is for is the map's own ink under the text, and that is not a revealed-ground-only case — Section 7.3 draws the major roads and the water *above* the fog, so a road line over dense fog is darker than the same line on bare paper. Every layer of the ink style paints the same ink over the same paper at some opacity (Section 8.1), so the darkest pixel the map can produce is that ink solid — approached where major roads cross — and contrast falls monotonically as the ground darkens. Both plates are therefore set as light as they can be while ink on them still clears 4.5:1 **against solid ink**, which is a floor of about 0.49 alpha; the wordmark's keeps a little headroom above it and the attribution's sits just over it, quieter of the two.

They were both 0.85 until v1.40, which the owner called "too much … the logo needs to be visible but I think it can be done with less". He also said he did not care whether the attribution is visible; that half is declined, because Section 10.5 is a licence obligation whose word is *legible* and not a design preference. Quiet is available to it. Absent is not.

**An admin who is teleported is told so on the map, and the way out is beside the words.** While the mode of Section 9.3 stands, the map screen carries a bar across its top band saying that this is a test position and not GPS, and a control that leaves the mode. An admin who forgets files bugs against a phantom, so the indicator is not optional and not subtle; it is ink on paper like every other piece of chrome here, because Section 8.1 keeps the accent for the player's own position and for active states and a mode indicator is neither.

**Leaving teleport is a different action from recentring, so it is a different control.** The locate button is not given a second meaning, and three separate reasons each settle it: that button is shared with the picker on Suggest a bar, which has no teleport to leave; it is disabled whenever there is no position, and leaving teleport must never be refused for a condition of its own let alone for someone else's; and recentring is a free, idempotent camera move while leaving the mode is a server request that can fail and has to say so. Two actions that can disagree about whether they worked cannot share one button.

What the two do share is the move. The owner asked for "the button to zoom back on the actual position", and at the moment of the tap there is no actual position to go to — the mode has just been left and the next real fix has not arrived. So the map goes to that first real fix, at `MAP_DEFAULT_ZOOM`, by making the same move the locate control makes rather than a second copy of it, once per leave.

**The picker an admin teleports from draws the fog and their discovered bars; the picker on Suggest a bar draws neither.** One component (Section 11.3's map picker) with an opt-in the suggest screen does not pass, rather than two pickers: the question — "which point on the map" — is the same question, and a second copy of it would be a second place for the pin, the camera and the locate control to drift.

What differs is what a person is being asked to point at. Suggesting a bar means pointing at a building you are standing in front of: the fog would cover the residential streets you are pointing by, and a marker on a neighbouring bar would sit on the spot you are aiming at. Teleporting means pointing at a bar, and Section 7.5's check-in is the thing being tested, so a picker that draws no bars cannot be aimed. The owner's words: *"I still want to see the fog, known area and known bars … how should I teleport close to a bar if I don't see it on the map."*

**On that picker the bar markers are decoration, and that is what makes the feature work at all.** A marker on the map screen is a control — Section 7.5 offers check-in by tapping it — and it is 44 px of tap target sitting exactly on its bar. Kept interactive in a picker whose one gesture is a tap that places the pin, the single spot the admin most needs to reach is the one spot his tap cannot reach. A handler that did nothing would not help: the element still takes the event. So in this picker the marks are not controls: not buttons, not focusable, `pointer-events: none`, and the whole set hidden from assistive technology rather than announcing a position on a canvas map that a screen-reader user has no way to act on. The same information reaches them as text, with coordinates, in the admin bar list above.

**Discovered bars only.** That is what `GET /api/bars` returns. Section 7.4 keeps an undiscovered bar's position hidden, and drawing them here — even for an admin — would make this a second place that rule has to be reasoned about, for a case the bar list already covers.

**A consequence, stated rather than discovered later: the fog on that picker hides what it hides.** It is Section 7.3's real fog at its real density, which is the point — it is what the admin asked to see, and a picker showing a thinner fog would be showing him something the game does not do. Over unrevealed ground it leaves exactly what Section 7.3 draws above the fog — water, waterways and the major roads, all at full strength — and takes away the residential and tertiary street grid, the buildings and the parks, along with any bar he has not discovered. So aiming into explored ground is precise, and aiming into unexplored ground is aiming by trunk roads and rivers. `FOG_MAX_OPACITY` is not what to change if that turns out to be too little: it is a ceiling on the fog's alpha and the layers above the fog do not read it at all, so lowering it would only bleed buildings through faintly and would change the game everywhere else at the same time. If this needs an answer, the answer is a control on the picker that turns the fog off for a moment, not a second density.

**No map overlay may obscure another.** The map screen carries ten overlays anchored to its edges — wordmark, tracking icons, locate button, pending-visit banner, teleport banner, bar sheet, nearby-bars panel, notices, toasts, attribution — with Section 8.4's tab bar fixed below them, outside the overlay layout and clearing it rather than competing with it.

A control anchored to an edge must yield to any bar occupying that same edge: the locate button clears whatever occupies the bottom, the tracking icons clear the banner along the top, and each does so whether or not the bar it yields to is currently present. That last phrase means the guarantee holds in both states, not that empty space is reserved — with no banner the controls sit at the edge, and they move down when one appears.

This section said "eight" until v1.19, listing the set as it stood before the bar sheet of Section 7.5 existed, which is the sentence proving its own point: the ninth overlay is exactly what a list of hand-tuned offsets cannot survive. It then said "eight" again for four more versions, because v1.38's chrome wordmark went onto the map without anybody counting it — proving the point a second time, this time about the list rather than about the layout.

The requirement is therefore the rule and never the individual fixes. Ten independently positioned overlays that agree by coincidence are not a layout. What the screen needs is one container laying its edges out as bands that claim their own space, so that a control cannot be placed on a bar and an overlay added tomorrow goes into a band rather than on top of everything.

Two things follow that are worth stating because they are easy to lose. The container must let pointer events through to the map and take them back only on the overlays themselves, or the map stops responding to drags. And the bottom safe-area inset belongs to the layout, applied once, rather than being repeated by every child that happens to sit at that edge.

**Not everything drawn on the map is an overlay, and the line between the two is what a thing is anchored to.** An overlay is anchored to the *screen* — a bar along an edge, a control in a corner — and is placed by the bands above. The bar markers and Section 7.4's discovery stamp are anchored to the *ground*: they belong at a point on the map, they are projected from a latitude and longitude and re-projected as the camera moves, and a band would be exactly the wrong place for them.

They therefore live inside the map's own element, positioned against it, and that is not the defect the rule above is about — it is the only way to be at a place. They sit below every overlay, so the layout still decides what may cover what, and the discovery stamp's dim covers the map and never the app's own chrome. Nothing anchored to the ground takes a pointer event except the bar marker, which is a control.

**The map opens at street level.** The opening view is zoom **16** — a few blocks across, the scale at which a bar marker, the player's own position, and the 50 m grain of the fog are all legible and a player can act on what they see. It opened at zoom 12 before, a city overview: a whole city of fog with nothing in it to walk towards. The city as a whole already has a screen of its own (City overview, above), so the map does not have to be one too. Zooming out to `MAP_MIN_ZOOM` stays available and is unchanged. Like the zoom limits it sits beside, the opening zoom is a constant in `packages/shared/src/config.ts` and never a number at the call site (Section 0, rule 3).

**"Open on the map" frames the whole district, and that is a different question from "where am I".** The district overview's "tap to zoom in" used to carry the tapped district's centre and let the map open at `MAP_DEFAULT_ZOOM`, which put a player on a single street corner of a district they had come to look at; an unexplored one arrived as a few streets of fog with none of its shape. A centre can only say where to point the camera, so the link carries the district's **bounding box** as well, and the map is built framed on that box rather than moved to it afterwards — one camera move on that path, and nothing racing the one-time centring on the player, which stands down for any URL that framed the map.

Three things bound that framing and none of them is suspended for it.

- **The zoom limits still apply.** A district too large to fit lands at `MAP_MIN_ZOOM` centred on its box rather than zooming out past the area the tile extract covers, and the city's pan limit is unchanged.
- **The box is fitted with a margin** — `MAP_FIT_PADDING_PX`, a constant in `config.ts` like every other number here, in screen pixels because that is what the quantity is. A box fitted edge to edge puts the district's own border on the edge of the screen, which reads as a shape running off-screen rather than as one being shown whole.
- **The box is validated as defensively as the centre beside it.** Absent, blank, non-numeric, non-finite, out-of-range, inverted and zero-area boxes are all rejected rather than coerced, and a rejected box falls back to the centre the link also carries, or to the city.

That last one is not caution for its own sake. The centre parameters are validated that way because a URL once put this map on Null Island, where MapLibre requested no tiles, reported no error, and drew a blank page indistinguishable from a fully fogged city. The centre stays in the link beside the box, both as that fallback and because it is what an older link carries.

**"To my location" sets that same zoom, it does not merely centre.** Recentring while keeping whatever zoom the map happened to be on answers the wrong question: a player zoomed far out taps it and gets their position in the middle of a city-wide view they still cannot walk from. The control takes them to `MAP_DEFAULT_ZOOM` as well as to their position — one constant for the opening view and for this, because both answer "show me where I am, close enough to walk from", and two numbers meaning the same thing drift apart.

The map picker on Suggest a bar is the deliberate exception: its identical-looking control centres without changing zoom, because a player who has zoomed in to place a pin precisely would lose exactly the precision they zoomed in for. Two controls that look the same behaving differently is a cost, taken knowingly and recorded here rather than discovered later as an inconsistency.

### 8.4 Navigation

A persistent bottom tab bar on every signed-in screen, with five tabs in this order: **Cities**, **Map**, **Ranks**, **Profile**, **More**. Map sits in the middle and carries the primary visual weight — a larger icon and a heavier label — because the fog-clearing loop is the reason the rest of the app exists.

Map is **not** given the accent colour: Section 8.1 reserves that for the player's position and for active states, and a tab that is permanently accented would leave "which tab am I on?" without a colour of its own. The current tab is marked three ways — colour, weight, and `aria-current` — because Section 8.1 forbids the accent being the only carrier of meaning.

**More opens a sheet, not a page.** It has no URL and no history entry, and it carries the secondary destinations in this order: Suggest a bar, How mastering works, Settings, Privacy, Report a bug, Admin (admins only, the same visibility rule as everything else admin), and then, separated by a divider and styled apart from the navigation above it, Log out. Log out is the one item in the sheet that is not navigation, and it is set apart by more than colour for the same reason the active tab is.

**"Report a bug" is the one item that leaves the application**, and each part of it is a decision rather than a link. It opens the repository's issue **form** — `https://github.com/AlexanderHultsch/TipsyTrails/issues/new`, and never the repository root, which is a README a player with something to say then has to navigate out of. The repository is `TipsyTrails`; `Tipsy-Trails` is an old name surviving only as a GitHub redirect (Section 4.3), so it is not what the link says.

**It reads "Report a bug on GitHub" and nothing more**, at the owner's direction: "Report a bug on GitHub (remove the rest of the text)." It opens with `target="_blank"` and `rel="noopener noreferrer"`.

Two things went with that text and they went to different places. The new-tab warning moved into the item's **accessible name** — "Report a bug on GitHub, opens a new tab" — because a tap that silently swaps the app for a browser tab is one the player cannot undo with the back gesture they have, and a screen reader user is the one who gets least warning of it from the tab itself. WCAG 2.5.3 asks that the accessible name contain the visible label, which this does word for word and in order, so a voice-control user saying what they can see still reaches the item. The second line, which said GitHub will ask for an account before it takes an issue, is **gone rather than moved**: a player without an account now meets the sign-in wall in the new tab instead of hearing about it here. That is the owner's call, taken knowingly, and it is recorded here so it reads as a decision rather than as a line somebody lost.

The issue body is prefilled with three prompts — what happened, what was expected, which screen — and the screen is read from the router when the sheet is rendered over it rather than written down. **It carries no app version**, deliberately: `packages/web` has no build-time version (its `package.json` is at `0.0.0`), so a version line would be a number that means nothing, and a wrong version in a bug report is worse than no version.

**This reverses a decision this specification made.** Until v1.22 this section read "A single burger menu, top right … No bottom tab bar, no other persistent chrome — the map should own the screen." That was a defensible reading of a map-first app, and it is not being corrected as an error: the owner's judgement is that a mobile-native bottom bar makes the app's own structure visible at a glance, where a flat eleven-item dropdown behind an icon made every destination equally hidden. The map still owns the screen everywhere above the bar.

**The bar is signed-in chrome, and that has a consequence worth stating.** Two of its five tabs need a session to mean anything — Profile addresses the player's own handle, and the sheet's Log out needs a session to end — so the bar does not render for a signed-out reader.

`/privacy` is the one route outside the auth gate that a signed-out reader is sent to (Register links it), and in the installed PWA there is no browser chrome to go back with, so that screen carries a back link of its own when there is no user. The burger menu used to serve that role incidentally; removing it without replacing it would have walled a reader into the privacy page.

### 8.5 Avatars

Deterministic, generated locally from `avatar_seed` (assigned at registration). A schematic geometric mark in black on paper ground, in the style of the map symbols. Not customisable. No image files, no uploads — rendered as inline SVG.

### 8.6 GPS and connection quality indicator

Three icons on the map screen, always visible: GPS, connection, and tracking. **Their shape never changes** — the GPS icon is the same mark whatever the GPS is doing — and the state is carried by colour alone, from the small named set Section 8.1 permits for this indicator and nothing else. They replace the text indicator with three labelled states this section used to specify; the states themselves are unchanged:

- **GPS:** three states derived from the last accepted sample's accuracy — good (≤ `GPS_ACCURACY_GOOD_M`), fair (≤ `GPS_ACCURACY_FAIR_M`), poor (worse, or no fix for `GPS_STALE_MS`).
- **Connection:** online / offline / syncing, based on `navigator.onLine` plus how far behind this device is on sending. Offline is `!navigator.onLine` and outranks everything else — a device with no connection is not behind on sending, it is unable to send.
  **Syncing means samples have missed a send cycle**, not that a request is in flight. A sample counts once it was already queued when a flush attempt began and is still queued after it, which is either a POST that failed and left it for the next try, or a sample that did not fit in `SAMPLE_MAX_BATCH` and was passed over by the cycle that should have carried it. Everything else is online, including a queue that is filling and draining normally.
- **Foreground tracking:** whether position tracking is currently running, with a plain-language note that tracking pauses when the app is not in the foreground.

Tapping the indicator opens the same short explanation of each state as before. That explanation is where the words live, so an icon-only indicator is still readable by someone who does not know what a colour means. It also carries the one number the player can act on: how many samples are still on this device, which is **every** unsent sample and not only the ones behind — "how much of my walk has not left this phone" is the question a player asks, and it is the same count whether the state is syncing or offline.

**Why the connection state is not the queue's depth**, recorded because the obvious rule is the wrong one and was shipped once. Section 7.2 batches on purpose: a fix arrives roughly every second and the queue is emptied every `SAMPLE_MIN_INTERVAL_MS`, so on a perfectly healthy phone the queue holds something nearly all of the time. A state derived from the depth therefore reads `syncing` nearly all of the time and flaps to `online` for the instant after each flush — accurate about a number that did not mean what the icon claimed.

Raising the threshold does not fix that. It says "three requests in the air" instead of one, which is the same wrong question, and it hides a real three-sample backlog. The definition above measures the queue's *progress* rather than its depth, so it needs no threshold at all and there is no constant here to tune.

**Colour-only state has an accessibility cost, and the mitigation is a requirement.** WCAG 2.1 SC 1.4.1 is about colour not being the only *visual* means of conveying information, so an `aria-label` does not discharge it: it serves a screen-reader user and does nothing whatsoever for a sighted colour-blind one.

The shapes are fixed by decision, which removes the usual mitigation, so the one that remains is luminance. **The status colours must differ in luminance as well as in hue**, far enough apart that the states stay distinguishable under colour blindness and in a greyscale rendering of the screen — verified by converting the rendered icons to greyscale, not by judging the hues by eye.

**The deferred decision, taken (v1.15).** The bounds are:

- each of the three clears 3:1 against its own background — not only the paper ground but the indicator's translucent button composited over fogged ground, which is the darker and therefore binding case;
- adjacent states clear 2.2:1 against each other, and the two extremes clear 4:1;
- luminance runs in the direction of severity, `ok` lightest and `bad` darkest, so that a greyscale or colour-blind reader recovers the *ordering* of the three states and not merely the fact that they differ.

The values themselves live in `packages/web/src/index.css` as `--color-status-ok` / `--color-status-degraded` / `--color-status-bad`, with the whole of the above asserted from those tokens in `packages/web/src/App.a11y.test.tsx`, so a badly chosen replacement fails the suite rather than the eye.

Two consequences of that arithmetic are worth recording, because they look like mistakes and are not.

**The darkest status colour is darker than the ink the rest of the map is drawn in**, and it has to be: the 3:1 rule caps the lightest of the three at a relative luminance of about 0.24, and two 2.2:1 steps down from a cap that low land below ink.

**At that luminance hue is nearly imperceptible.** The `bad` colour reads as black however it is specified, so the hue requirement above is satisfied numerically but does almost no perceptual work at the bottom of the scale; the separation there is carried by luminance alone. That is the honest cost of fixing the shapes and excluding the accent's red from the set. It is not a reason to reopen either decision, but it is the first thing to revisit if the indicator turns out to be hard to read on the street.

Each icon additionally carries an accessible name that states its state in words rather than naming the icon — "GPS signal: poor", not "GPS" — so assistive technology announces what the colour means. That is for assistive technology and is **not** a substitute for the luminance rule. Both are required, and neither covers for the absence of the other.

---

## 9. API

REST, JSON, session cookie auth. All endpoints under `/api`, except the tile route served at `/tiles/*` (Section 9.2) — outside the `/api` prefix because it needs Cloudflare's cache, not session auth. All `/api` responses are `private, no-store`; the tile route is deliberately not (Section 4.1).

### 9.1 Auth

| Method | Path | Body / Notes |
|---|---|---|
| POST | `/api/auth/register` | `{ username, password, securityQuestion, securityAnswer, ageConfirmed }` — establishes a session on success |
| POST | `/api/auth/login` | `{ username, password }` |
| POST | `/api/auth/logout` | — |
| GET | `/api/auth/me` | Current user or 401 |
| GET | `/api/auth/reset/question?username=` | Returns the security question — see 9.5 |
| POST | `/api/auth/reset` | `{ username, securityAnswer, newPassword }` — invalidates all sessions of that user |
| POST | `/api/auth/change-password` | `{ currentPassword, newPassword }` — clears `must_change_password` |

### 9.2 Game

| Method | Path | Notes |
|---|---|---|
| GET | `/tiles/<filename>` | Serves the PMTiles extract (Section 4.3), with HTTP range support — must answer `206` to a ranged request. Unauthenticated, `Cache-Control: public, max-age=2592000` (Section 4.1) — the one path under the API's control that is deliberately not `private, no-store`. Answers with a clear error under `/tiles/*` if the extract is missing (Section 13.2) |
| GET | `/static/<slug>/<filename>` | Serves the committed per-city seed files from `SEED_DIR` — `city.geojson`, `districts.geojson`, `neighbours.geojson` (Section 11.4). Unauthenticated; read by the city and district overviews, the map's district-boundary layer (7.3) and the start screen's backdrop (8.3) |
| GET | `/api/health` | `{"status":"ok"}` — unauthenticated, used by Phase 0 and by Docker's healthcheck |
| GET | `/api/city` | Active city metadata + grid parameters |
| GET | `/api/fog` | Raw fog mask (`application/octet-stream`) + per-district revealed counts; Caddy applies the transport encoding |
| POST | `/api/samples` | `{ samples: Sample[] }` → `{ newCells, newBars, visitUpdates, tooFastToReveal }`. `tooFastToReveal` is a boolean and reports the *last accepted sample* of the batch (Section 7.3). `newBars` carries the same bar shape the two routes below do, `mastered` included (Section 5.7) |
| GET | `/api/bars` | Discovered bars only. Each carries `mastered` for the calling user (Section 5.7) |
| GET | `/api/bars/:id` | Bar detail, `mastered` included (Section 5.7) — see 9.5 |
| POST | `/api/bars/suggest` | `{ name, address, lat, lon }` |
| GET | `/api/visits/pending` | Active pending visits |
| POST | `/api/visits` | `{ barId }` → creates or returns the pending visit |
| POST | `/api/visits/:id/cancel` | Ends the caller's own pending visit, moving it to `cancelled` (Sections 5.7, 7.5). Reaches nothing but a pending visit belonging to the caller. Not a `DELETE`: the row survives as a cancelled record. The visit is named by id because a player may hold several pending visits at once |
| GET | `/api/progress` | City + per-district progress: `{ city: { revealedCells, playableCells, percent }, districts: [{ id, name, revealedCells, playableCells, percent }] }`. It carries **no** `barsMastered` field — Section 7.6 defines that figure but no route returns it city-wide. See O17 |
| GET | `/api/leaderboard` | `?metric=area\|bars&period=all\|week\|month&page=` |
| GET | `/api/profile/:handle` | Public profile + badges — see 9.5 |
| PATCH | `/api/settings` | `{ isAnonymous }` |
| DELETE | `/api/account` | `{ password }` required; hard delete, cascades everywhere |
| GET | `/api/push/vapid-public-key` | `{ publicKey: string \| null }` — `null` when push is not configured |
| POST | `/api/push/subscribe` | Web Push subscription |
| DELETE | `/api/push/subscribe` | `{ endpoint }` — removes it |

`GET /api/push/vapid-public-key` exists because `pushManager.subscribe()` cannot be called without the VAPID public key, and that key is a deployment fact rather than a build-time one. Baking it into the bundle would tie one image to one deployment; returning it from an unrelated response would overload that response's meaning. The key is not secret — only `VAPID_PRIVATE_KEY` is — so serving it costs nothing. It requires auth like every other `/api/*` route, and answers `null` rather than failing when push is unconfigured, so the client can simply not offer notifications.

### 9.3 Admin

All require `is_admin`. Prefix `/api/admin`.

A logged-in non-admin gets **403**, not 404 — the deliberate opposite of Section 9.5's bar rules. There, hiding a bar's existence is the point; here only the authority to act is secret, and the existence of `/api/admin/*` is not.

The community duplicate guard (Section 11.3) does **not** apply to admin create or admin edit. The admin is trusted to know what they are doing, including adding a second bar with a name close to an existing one; Section 11.3 specifies the guard for submissions only.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/admin/bars` | All bars including hidden, filterable by source, ordered by name |
| PATCH | `/api/admin/bars/:id` | Edit name, address, position, status |
| DELETE | `/api/admin/bars/:id` | Delete (cascades discoveries and visits) |
| POST | `/api/admin/bars` | Create bar directly |
| GET | `/api/admin/users` | User list with stats, including `excludedFromRankings` |
| PATCH | `/api/admin/users/:id` | Set or clear `excluded_from_rankings` (Sections 5.3, 7.8) — the only writable field of a user |
| POST | `/api/admin/teleport` | Move the calling admin's own position to a point, running the sample pipeline with the speed guards off, and stay there. **Registered only when `ADMIN_TELEPORT_ENABLED=true`** (Section 4.3); otherwise the path does not exist |
| GET | `/api/admin/teleport` | Where the caller is currently teleported to, or `null`. Same registration gate |
| DELETE | `/api/admin/teleport` | Leave the mode, and drop the caller's previous accepted position with it. Same registration gate |

Editing a bar's position recomputes `cell_index` and `district_id`. Existing discoveries are not revoked.

#### The ranking toggle

`PATCH /api/admin/users/:id` takes `{ excludedFromRankings?: boolean }` and answers with the same user object `GET /api/admin/users` lists, so the admin screen can put the response straight back into its list. An omitted field means unchanged, exactly as in the bars PATCH; an unknown field is ignored, which is what stops the route becoming a general user editor by accident — there is no `isAdmin` here.

The screen shows the flag as well as setting it: an excluded account is marked in the user list, and the section says in words what exclusion costs. An invisible switch that changes who wins is worse than no switch.

#### The teleport

`POST /api/admin/teleport` takes `{ lat, lon }` and answers with the body `POST /api/samples` answers with — `{ newCells, newBars, visitUpdates, tooFastToReveal }`. It moves the calling admin's own position to that point and runs everything an ordinary accepted sample runs: fog reveal (7.3), bar discovery (7.4), visit progress (7.5). What it writes is real. The point is chosen on the map picker Section 11.3 already specifies for suggesting a bar, reused rather than rebuilt — with Section 7.3's fog and the caller's discovered bar markers drawn into it, which the suggest picker does not get. Section 8.3 gives the whole of that: why it is an opt-in on one component rather than a second picker, why the markers there are decoration and take no taps, why only discovered bars are drawn, and what the fog costs an admin aiming into ground he has not walked.

**It shares the sample pipeline rather than copying it.** `routes/fog.ts` exposes the loop and the three write steps as one function, and both routes call it; the only difference between them is one boolean parameter, `skipSpeedGuards`. A second copy of that loop would be a second place for Section 7.5's rules to drift.

**Two guards are off and no others.** Section 7.2's teleport guard (`SAMPLE_TELEPORT_SPEED_KMH`) and Section 7.3's reveal-speed gate (`FOG_MAX_SPEED_KMH`) are skipped. Accuracy, clock skew, staleness and the active city's bounding box all still apply. The bounding box in particular is **not** bypassed: there is no fog grid outside Karlsruhe, so a teleport out there would test nothing. Unlike a GPS sample, which Section 5.1 says is silently ignored, a person who tapped a map is told — the route answers `422 outside_city`, the same way the admin create/move-a-bar handlers do.

**`lastAccepted` holds the destination afterwards**, written by the shared pipeline rather than by anything special here. It has to: that map is what the *next* real sample is compared against, so leaving the pre-teleport position in it would make the admin's next genuine sample look like a 300 km/h jump and get it dropped — the feature would break the ordinary sampling it exists to exercise. Clearing it instead would break check-in, which reads the same map (Section 7.5 step 2). A consequence, stated rather than hidden: while the mode stands, a genuine sample from the phone's real location *is* refused by the guard, which is the guard working. That is why leaving the mode is an operation and not a wait.

The four gates that stand between a request and any of this are in Section 10.1.

#### Teleport is a mode, not a one-shot

The first version moved the server's idea of the admin's position and left the browser watching real GPS. The result was that fog cleared at the destination while the map marker, the nearby-bars panel and the check-in offer all stayed at the phone — so **the check-in flow could not be reached at the destination at all**, which is the thing the feature exists to test — and every real sample was refused for speed, silently, for as long as the phone was far from the destination.

The requirement is therefore the owner's: *"we need to stay at the selected teleported position until the admin teleports somewhere else or presses the button to zoom back on the actual position."* Three operations on the one path deliver it, and all three stand behind the registration gate and `requireAdmin`:

- **Set** — the `POST` above. Keeps the exclusion precondition, keeps firing the synthetic sample so fog clears immediately, and now also records the destination as the caller's teleported position. A second teleport replaces the first.
- **Read** — the `GET`. Answers the caller's own teleported position or `null`, and nobody else's. It is on the admin route and deliberately **not** on `GET /api/auth/me` or any other route every player calls: a field that is null for everyone but the owner advertises the feature to people who cannot use it, which is the opposite of gate 2's purpose.
- **Clear** — the `DELETE`. **No exclusion precondition on this one.** Getting back to reality must never be refused, including when the flag was cleared while the admin was teleported; a mode that could not be left would strand the app asserting a position the admin is not at.

**The clear drops the caller's `lastAccepted` entry as well, and that is the half that is easy to miss.** It holds the teleport destination. Leave it and the returning admin's first real fix implies a jump of however far they teleported, is refused at Section 7.2 step 4, and is refused *silently* — their app simply stops working, sample after sample. Dropping the entry puts them in exactly the state Section 7.2 already defines for an API restart, where the guard has no reference point and passes the first sample unconditionally; that existing behaviour is reused rather than an exception being carved into the guard, and `POST /api/samples` is untouched. The cost is the mirror of that restart: check-in answers `no_recent_sample` until the first real fix arrives, because the server genuinely does not know where the admin is.

**A teleport asserts `accuracy: 0`, and that has a consequence worth stating once.** It is the strictest choice available and it is deliberate — a synthesised position declares no measurement error, and `onsiteRadiusM` widens the on-site radius with reported accuracy, so a teleport buys the tightest radius rather than a generous one. The client's samples while the mode stands carry the same pair, so the two agree. But the on-site radius that visit progress uses (Section 7.5 steps 3-4) is `onsiteRadiusM(accuracy)`, i.e. `BAR_ONSITE_RADIUS_M` exactly, while check-in judged against the previous accepted position uses the most-generous radius (`BAR_ONSITE_RADIUS_M + BAR_ACCURACY_TOLERANCE_M`). A teleport landing between those two distances of a bar can therefore check in and then never accrue a single on-site sample, and the visit expires instead of completing. Teleport onto the bar, not merely near it.

**The state is held in memory and never in the database.** Constraint C4 and Section 10.2 forbid persisting a position, and a teleported point is a position; Section 7.2 already pre-empts this workaround for the previous-accepted-position map beside it. What that buys is what the owner needs for a twenty-minute mastering test: the mode is the server's, so it survives a page reload and a backgrounded phone. **What it costs is that it does not survive an API restart** — the same degradation `lastAccepted` has always carried. A restart therefore ends the mode, and it does so in two steps rather than one: the next load of the map screen asks, is told `null`, and goes back to real GPS, while a map screen that is *already* open keeps honouring the point it was told about and keeps posting from it — those samples are accepted, because the restart also emptied the previous-accepted-position map and Section 7.2 passes the first sample unconditionally. Leaving the mode from that tab still works and is still worth doing: the `DELETE` clears a mode that is already gone, and clears the entry those samples have since re-seeded. None of this loses data or corrupts anything; it is written down so that a twenty-minute test is not quietly restarted underneath.

**The bar list comes back ordered by name, and stays that way on screen.** The order is a
locale-aware, case-insensitive collation of German place names — umlauts belong where a reader
looks for them, not after `Z` — with equal names broken by `id`, since the data really does
contain two bars of the same name and the order must not reshuffle between requests. It is not
a SQL `COLLATE NOCASE`: SQLite's built-in collation folds ASCII `A`–`Z` and compares everything
else by code point, which files every umlaut-initial name at the end of the list. It is
`Intl.Collator` with the **locale pinned to German**, not left to resolve — the UI is English
(C9) but the data is German place names, and an unpinned locale resolves to the container's on
the server and to the admin's browser language on the client, so the same list could come back
ordered two ways depending on who was looking. A second city would want this per city, alongside
the other per-city facts. The one comparator lives in `packages/shared/src/bars.ts` so the API
and the Admin screen cannot drift apart about it, and the screen re-applies it when a bar is
created or renamed, rather than appending the new one at the bottom and leaving the renamed one
in its old slot until a reload.

The user list on the same screen is ordered by `users.id` and is deliberately left that way:
ordering usernames raises questions this document has not answered (anonymity, admins first).

### 9.4 Rate limits

Per the `RATE_LIMITS` block in Section 7.1, enforced with an in-memory token bucket. Exceeding returns 429 with a `Retry-After` header.

**The admin surface carries no rate limit, deliberately.** `RATE_LIMITS` names none for it, every admin route sits behind `requireAdmin`, and the admin account is the trust boundary these limits exist to protect in the first place. Recorded so the absence is not read as a gap.

**The client IP must be taken from the trusted proxy header, not the socket.** Behind Cloudflare Tunnel every request reaches the API from `cloudflared`, so socket-based limiting would put all users in one bucket and make the per-IP limits meaningless. The Caddy instance immediately in front of the API sets `X-Forwarded-For` — this repository's own in the standalone two-container path, the platform's own single Caddy instance in front of the single container that runs on the Pi (Section 4.3, v1.2.2). For the standalone path that Caddy is the only proxy between the client and the API, so `trustProxy: 1` — trusting exactly one hop — is correct there.

**For the Pi path the hop count is not settled, and this app currently trusts `trustProxy: 1` without having verified it.** The chain there is longer than Caddy alone — browser → Cloudflare edge → Cloudflare Tunnel → the `cloudflared` container → Caddy. How many of those append an entry to `X-Forwarded-For` cannot be determined by reading either repository. Cloudflare's edge almost certainly adds the real client IP; `cloudflared` may add another before handing off. Section 4.3 also leaves open whether the platform's Caddy sets `trusted_proxies` or a `header_up` override, so a hop that may rewrite the list sits on top of a chain of unknown length.

Why the number matters: `X-Forwarded-For` is a comma-separated list a client can pre-seed with arbitrary entries, and only the right-most hop is guaranteed to have been appended by infrastructure we control. Trusting too many exposes the list to client-supplied fabrication; trusting too few reads a proxy's address as the client's. Either way per-IP buckets stop being per-IP, with no visible failure. Trusting the left-most entry outright — what `trustProxy: true` does — is wrong under any hop count and lets a client mint a fresh bucket per request.

Getting this right on the Pi is unverified, not assumed correct: log the raw `X-Forwarded-For` header once, from a real request made over the public internet — not from the Pi itself, not from the local network — and count the entries; set `trustProxy` to that count. That measurement is the first step and no longer the whole of it: if the platform's Caddy sets a `header_up` override or a trust list nobody has read, the right value can differ from what counting entries suggests, so the platform `Caddyfile`'s global options have to be read too before `trustProxy` is called settled. Until both are done, Section 13.4's "rate limits are load-bearing" is unverified for the Pi deployment, whatever Phase 1's Definition of Done already confirmed about the mechanism itself. Recorded as Open Item O10 (Section 14).

Buckets are in memory and reset on restart — acceptable at this scale, and stated here so nobody mistakes it for a durability bug.

### 9.5 Responses that must not leak

| Endpoint | Rule |
|---|---|
| `GET /api/bars/:id` | Identical 404 for "does not exist" and "not discovered by you". A 403 confirms existence and defeats Section 7.4. |
| `GET /api/auth/reset/question` | Always 200 with a question. For an unknown username, return a deterministic decoy derived from an HMAC of the username under the server secret, so the response is stable across attempts and indistinguishable from a real one. Rate-limited per username and per IP. |
| `POST /api/auth/login`, `POST /api/auth/reset` | One generic failure message; never distinguish unknown username from wrong password or wrong answer. |
| `GET /api/profile/:handle` | Accepts a username or a `player-{id}` handle. If the user is anonymous, the username form returns 404 and only the handle form resolves, masked. The `player-{id}` form resolves for **every** user, anonymous or not — what this rule protects is the path from a *known username* to a profile, and Section 7.8's leaderboard already shows masked and unmasked rows side by side, so which numeric ids belong to real accounts is public there by design. Unknown user, anonymous-by-username and malformed handle all answer one byte-identical 404. |
| Any error | No stack traces, no SQL text, no internal identifiers. A stable `code` string plus a human message. |

**The `{ code, message }` envelope has two documented exceptions, and a client must tolerate all three shapes.** Every route handler answers with `{ code, message }`. Two paths do not, and both are live behaviour rather than defects to be tidied away:

- The SPA fallback handler (`packages/api/src/app.ts`) answers an unmatched non-`GET` request, or any unmatched `/api/*` request, with Fastify's own `{ message, error, statusCode }` — **no `code`**. Every unmatched `GET` outside `/api` returns `index.html` instead, because the SPA owns client-side routing.
- Fastify's JSON body parser rejects a malformed or empty-but-declared body before any handler runs, with a fourth shape of its own (Section 7.5 records the empty-body case, which is why a bodyless request must not set `Content-Type: application/json`).

The client therefore reads `code` and `message` defensively and falls back to `unknown_error` plus a generic sentence when either is absent (`packages/web/src/api/client.ts`).

**`code` is uniform; the wording of `message` is not a contract.** The same `code` can carry more than one message — `invalid_request` is answered with "The request body is invalid." almost everywhere and with "The request query is invalid." by `GET /api/leaderboard` — and one route answers with the wording that does not match what it validated: `GET /api/admin/bars` parses `request.query` and replies "The request body is invalid.". That reply is what the endpoint sends today and is deliberately preserved; changing it is a behaviour change. Nothing may branch on message text.

---

### 9.6 Response shapes

Every shape a route can return, as the client declares it in
`packages/web/src/api/types.ts`. That file is the client's mirror of what the API sends; the two are
kept in step by hand, and a rebuilder should generate both from this table rather than from either
side alone. Timestamps are epoch **seconds** (Section 0, rule 6). `discoveredAt`, `createdAt`,
`awardedAt`, `startedAt`, `lastSampleAt` and `lastSeenAt` are all absolute; `confirmedS` and
`remainingS` are durations.

```ts
User          { id, username, avatarSeed, isAdmin, isAnonymous, mustChangePassword }
Bar           { id, districtId: number|null, name, address: string|null, lat, lon,
                source: 'osm'|'community'|'admin', discoveredAt, mastered: boolean }
VisitSummary  { id, barId, barName, startedAt, lastSampleAt, onsiteSamples,
                confirmedS, remainingS, status: 'pending'|'completed'|'expired'|'cancelled' }
BadgeSummary  { kind: 'explorer'|'barfly', period: 'week'|'month'|'year',
                periodKey, value, awardedAt }
BadgeProgress { kind, value }
CityMeta      { slug, name, originLat, originLon, gridWidth, gridHeight, cellSizeM,
                playableCells, districts: { id, name, playableCells }[] }
FogProgress   { revealedCells, playableCells, districts: { id, revealedCells }[] }
```

| Route | Response |
| --- | --- |
| `GET /api/health` | `{ status: 'ok' }` |
| `GET /api/auth/me` | `{ user: User }`, or 401 |
| `POST /api/auth/register`, `/login` | `{ user: User }` |
| `POST /api/auth/logout` | 204, no body |
| `GET /api/auth/reset/question` | `{ question: string }` |
| `GET /api/city` | `CityMeta` |
| `GET /api/fog` | Binary mask plus `FogProgress` — see the wire-format note below |
| `POST /api/samples` | `{ newCells: number, newBars: Bar[], visitUpdates: VisitSummary[], tooFastToReveal: boolean }` |
| `GET /api/bars` | `{ bars: Bar[] }` |
| `GET /api/bars/:id` | `Bar` |
| `POST /api/bars/suggest` | `Bar`, 201 |
| `GET /api/visits/pending` | `{ visits: VisitSummary[] }` |
| `POST /api/visits`, `/api/visits/:id/cancel` | `VisitSummary` |
| `GET /api/progress` | `{ city: { revealedCells, playableCells, percent }, districts: { id, name, revealedCells, playableCells, percent }[] }` — no `barsMastered`, see Section 9.2 |
| `GET /api/leaderboard` | `{ metric: 'area'\|'bars', period: 'all'\|'week'\|'month', page, pageSize, totalUsers, totalPages, entries: { rank, userId, displayName, isAnonymous, avatarSeed, value, badges: BadgeSummary[] }[] }` |
| `GET /api/profile/:handle` | `{ userId, handle, displayName, isAnonymous, avatarSeed, areaPercent, barsMastered, badges: BadgeSummary[], badgeProgress: Record<period, BadgeProgress[]> }` |
| `GET /api/push/vapid-public-key` | `{ publicKey: string \| null }` |
| `GET /api/admin/bars` | `{ bars: AdminBar[] }` where `AdminBar` is `{ id, cityId, districtId, name, address, lat, lon, source, submittedBy: number\|null, status: 'active'\|'hidden', createdAt }` |
| `GET /api/admin/users` | `{ users: AdminUser[] }` where `AdminUser` is `{ id, username, isAdmin, isAnonymous, mustChangePassword, createdAt, lastSeenAt: number\|null, areaRevealedCells, areaPercent, barsMastered, badgeCount }` |
| `POST /api/admin/teleport` | Exactly `POST /api/samples`'s body, deliberately — the admin screen renders what happened with the fields the map already understands |
| `GET /api/admin/teleport` | `{ position: { lat, lon } \| null }` — an object with a nullable field, not a bare `null` body, so there is one shape to parse either way |
| `DELETE /api/admin/teleport` | `{ ok: true }` |

**`GET /api/fog`'s wire format.** The mask is the response body as
`application/octet-stream`; `FogProgress` travels as JSON in an `X-Fog-Progress` response header,
because a binary body and a JSON body cannot share one response. The client parses the header and
returns `{ mask, progress }` as one value.

**The `code` vocabulary.** Section 9.5 makes `code` the contract and the message wording explicitly
not. The complete set a rebuilder must implement: `bar_not_found`, `city_not_found`,
`duplicate_bar`, `forbidden`, `grid_unavailable`, `invalid_credentials`, `invalid_request`,
`invalid_reset`, `no_recent_sample`, `not_onsite`, `origin_mismatch`, `outside_city`,
`password_change_required`, `profile_not_found`, `rate_limited`, `static_file_not_found`,
`tile_not_found`, `tiles_unavailable`, `unauthenticated`, `username_taken`, `visit_not_found`.

## 10. Security, Privacy, and Legal

### 10.1 Security

- argon2id for both password and security answer, with per-hash salts.
- Session cookies: `httpOnly`, `Secure`, `SameSite=Lax`, 90-day sliding expiry.
- CSRF: `SameSite=Lax` plus an `Origin` header check on all state-changing requests.
- CSP with no `unsafe-inline`. Baseline:
  `default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; worker-src 'self' blob:; child-src 'self' blob:; style-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`.
  The `blob:` worker and child sources are required — MapLibre GL instantiates its workers from blob URLs and the map will not initialise without them.
- All input validated with `zod` at the route boundary.
- Parameterised SQL exclusively.
- No stack traces or SQL errors in responses.
- Password reset invalidates every existing session of that user.
- The VAPID private key (Section 5.9) is generated on first boot and persisted in the same directory as the SQLite database — the same volume that already holds every password hash, so this widens no boundary. It is never logged, never returned by any API response, and never committed; `GET /api/push/vapid-public-key` (Section 9.2) serves only the public half.

#### The admin teleport, and why it takes nothing away

The teleport (Section 9.3) skips two anti-cheat guards, and this repository is public (Section 13.4), so the design has to survive being read by whoever wants to cheat.

**Start from what is already true: positions are client-asserted.** `POST /api/samples` accepts a `{ lat, lon, accuracy, speed, timestamp }` straight from the browser, and no web application can prove a location. Anyone holding a session cookie can already claim to be anywhere, today, with no admin flag and no new code. What stops casual abuse is friction plus the two guards. So the teleport hands a determined attacker no new capability; what it must not do is lower that friction for everyone else, or weaken the guards on the path the public uses.

**The single rule the design is built on: `POST /api/samples` has no bypass parameter.** Not `{ teleport: true }`, not `{ skipGuards: true }`, not a header. A check the request can switch off is not a check, because the check then depends on the caller. The bypass is a property of a **separate, admin-only route**, and the server decides it from the session. In the code the difference is a function parameter the public handler passes as a literal `false`, reachable from nothing in the request body.

**Four gates hold independently, and none of them is the client.**

1. **`requireAdmin`**, the same preHandler every other `/api/admin/*` route uses: 403 for a signed-in non-admin, 401 for an anonymous caller.
2. **`ADMIN_TELEPORT_ENABLED`** (Section 4.3). Unset, the plugin is never registered and the path answers **404, not 403** — the code ships inert, and a stolen admin session on a production box reaches nothing.
3. **The calling account must already carry `excluded_from_rankings`** (Section 5.3). This is the gate that makes the feature safe rather than merely gated: teleport is refused for every account still in the competition, so no amount of teleporting can ever produce a leaderboard place or a badge. It is checked before the request body is parsed, and refused with `422 not_excluded_from_rankings` naming the reason and the fix.
4. **All of it is server-side.** The admin screen's panel is a convenience; hiding it protects nothing and is not offered as protection. Every gate is re-applied on every request whatever the browser believes.

Each gate is separately mutation-tested: removing any one of them fails a specific test, and so does applying the bypass to `POST /api/samples`.

### 10.2 Data minimisation

Raw positions are **never persisted**. Samples are processed in memory to derive: revealed cells, bar discoveries, visit sample timestamps. The last accepted position per user is held in memory only, for the teleport guard, and discarded on restart.

The admin teleport's own state (Section 9.3) is the second position this server holds and is held the same way: in memory, keyed by user id, discarded on restart. A synthetic position is a position, so C4 covers it exactly as it covers a real one — there is no table, no column and no migration for it, and the survival it does have across a reload comes from being the server's rather than from being stored.

Stored per user: username, hashes, avatar seed, fog bitmask, per-day reveal counts, discovered bar IDs, visit records (bar + timestamps), badges, push subscription. Nothing else.

The per-day reveal counts (Section 5.5) record *how much* was revealed on a day, never *where*, and are therefore consistent with C4. State this in the privacy page.

**A client-side cache of the fog mask is location history and is treated as such.** The mask says where a person has walked, which is exactly what this section keeps out of the database in raw form. Its `localStorage` entry is therefore keyed by user id and cleared on logout. Unkeyed, the next account to sign in on a shared device — offline, before a single request completes — would be shown the previous account's revealed fog. The precedent that made the unkeyed version look reasonable is the one-flag "has seen the mastering explainer" entry, and the difference is the whole point: one records that somebody read a screen, the other records where they went.

### 10.3 Privacy notice

A short, project-specific privacy page at `/privacy`, in English, covering: what is collected, that location is processed but not stored as a trail, retention, the anonymity setting, and account deletion. It links to the main privacy policy on `ahultsch.com` for everything else. **No separate legal notice (Impressum)** — link to the one on the main site.

Three things this page must get right, because each is a claim of *absence* and nothing forces a claim of absence to be re-checked when the code beneath it changes:

- **OpenStreetMap is the source the map data came from, not a service the app talks to.** Tiles are served by this app's own `/tiles/*` route; the browser never contacts OSM.
- **Two outside services do see live traffic and must be named**: Cloudflare, which tunnels every request including position samples (C1, Section 4), and the browser vendor's own push service — Google, Apple or Mozilla depending on the browser — which carries the subscription and each reminder when push is on.
- **Deletion is immediate in the database but not in backups.** C7's existing Pi backup job means a routine backup can still hold a copy until it cycles out; say so rather than claiming unqualified immediate removal.

The per-day reveal counters feed both the badge job (7.7) and the leaderboard's week/month filters (7.8); the page says both.

### 10.4 Age gate

A single mandatory checkbox at registration: *"I confirm that I am 18 years of age or older."* Registration fails without it. `age_confirmed_at` is stored. No date of birth, no verification.

### 10.5 Attribution

Map data is OpenStreetMap under ODbL. A persistent, legible attribution — "© OpenStreetMap contributors" — must appear in the map's bottom corner and link to the OSM copyright page. This is a licence obligation, not a design option.

### 10.6 Account deletion

`DELETE /api/account` requires the current password, then performs an immediate hard delete of the user row; every foreign key cascades. No soft delete, no retention. Leaderboard entries disappear with the account.

Bars submitted by that user are **not** deleted — they are part of the shared catalogue. `bars.submitted_by` is set to NULL, which the schema already allows.

---

## 11. Bar Data and Data Pipeline

### 11.1 Seeding

`scripts/import-osm-bars.ts` runs **once, locally, offline from the app** and writes `data/seed/karlsruhe/bars.json`, which is committed.

Overpass query: nodes, ways, and relations within the Karlsruhe boundary relation with `amenity` in `bar`, `pub`, `biergarten`, `nightclub`, **or** carrying the tag `bar=yes`, regardless of `amenity` value.

OSM tagging of drinking establishments in Germany is inconsistent — bars are frequently tagged as `pub`, `restaurant`, or `cafe`, and the seed will contain both false positives and gaps. The `bar=yes` clause widens both: it catches restaurants and hotels that also run a real bar under OSM's "one main tag" convention (their primary business stays `amenity=restaurant`, `amenity=cafe`, or similar, with `bar=yes` as the secondary tag), but it will just as readily pull in a café or hotel with a token `bar=yes` and nothing bar-like about it. The seed is therefore a **starting point requiring manual curation**, not authoritative data. The admin interface exists primarily for this.

Entries without a `name` tag are discarded. Ways and relations are reduced to their centroid.

**Duplicate venues are collapsed on import.** OSM maps the same physical venue twice more often than it should: a node for the venue and a way for the building it occupies, or simply two nodes surveyed years apart by two mappers. Karlsruhe's seed contains both shapes. Two rows means two bar ids, and every rule keyed on a bar id then treats them as two bars — including the partial unique index of Section 5.7, which stops a second pending visit at the same id and cannot stop one at the twin. A player standing in front of one building sees two markers an arm's length apart carrying the same name and can check into both.

The rule for deciding that two records are one venue is **Section 11.3's duplicate guard, shared in every part but its radius**: one implementation, the same normalisation, the same `SUGGEST_NAME_SIMILARITY`, and a radius supplied by the caller. The similarity gate is what discriminates, and it is common to both. The radius is not, because the two callers compare different kinds of point: a submission is two places a person tapped, while the import compares a surveyed POI node against a **building centroid**, which sits half a building from the door. The import therefore uses `IMPORT_DUPLICATE_RADIUS_M` (40 m) and the submission form `SUGGEST_DUPLICATE_RADIUS_M` (25 m), and neither number can be changed by changing the other — which is the point, since loosening the import must not loosen what a player is allowed to submit.

Which of a pair survives is decided by a total order over the two records, never by the order Overpass answered in — re-running the import over the same data must produce the same file:

1. The record with an address beats the record without one. It carries information the other does not, and information the app uses.
2. Then a node beats a way, and a way beats a relation. A node is the surveyed position of the venue; a way or relation is reduced to a *building* centroid, which need not be where the bar is.
3. Then the lower OSM id wins. Within one element type the lower id is the older object, so it is the one an already-seeded database is more likely to hold already — keeping it makes the re-import a no-op for that venue rather than a delete that would take its discoveries and visits with it (Section 5.6).

Step 3 alone would be stable; steps 1 and 2 make the stable answer the better record as well. The script names every pair it merged on stdout, because a collapse is the one thing the import does that silently removes a real OSM object from its output.

This is a filter, not a merge: the surviving record is kept exactly as it was and nothing is copied across from the record that was dropped. A pair the rule does not catch — the same name well beyond the radius — stays two bars and is the admin interface's job, like every other curation decision here.

**The 40 m was measured, not chosen.** Across the whole committed Karlsruhe seed there are exactly two pairs that clear `SUGGEST_NAME_SIMILARITY` within 60 m, and both are one venue mapped twice: Fettschmelze as two nodes 6.2 m apart, and Traube as a node and the building way around it 25.3 m apart. Nothing else in the city becomes a candidate at any radius up to 60 m, so 40 m collapses both real duplicates with twenty metres of headroom before it could reach anything else. Traube is the pair that forced the separate constant — it is the one a player was checked into twice at once, and the 25 m submission radius misses it by thirty-four centimetres. Re-measure before carrying this number to a second city; it is a fact about how this city is mapped, not a universal one.

The `import-osm-bars.ts` script therefore needs `@tipsytrails/shared` **built** before it runs (`pnpm install` does it; so do `pnpm test` and `pnpm typecheck`). It used to run entirely from source with no build step, which is only possible for modules with no relative value imports of their own; sharing Section 11.3's rule means importing one, and the alternative — a second similarity function and a second copy of the radius — is what Section 0's rule 3 exists to prevent.

### 11.2 Refresh

No automatic synchronisation in v1. Re-running the import script produces a diff report to stdout; applying changes is a manual admin decision. The script must never write to the live database.

### 11.3 Community submissions

Users submit via the More sheet (Section 8.4): a map picker to place the pin (mandatory — this is how position is set, not geocoding), plus name and address.

Submitted bars go live **immediately** for all users, with `source = 'community'`, and are rendered with a small distinguishing marker in list and detail views. The admin can edit, hide, or delete them afterwards.

**Duplicate guard.** Reject if an active bar exists within `SUGGEST_DUPLICATE_RADIUS_M` whose name is similar. Similarity is a normalized Levenshtein ratio ≥ `SUGGEST_NAME_SIMILARITY`, computed after normalising both names: lowercase, strip diacritics, strip punctuation, collapse whitespace, and drop leading articles and common suffixes (`bar`, `pub`, `kneipe`, `cafe`). The rejection names the conflicting bar so the user understands why.

Four details of that rule are normative rather than left to the implementer, because each has a wrong answer that looks right:

- The ratio is `1 - distance / max(len a, len b)`, with `a === b` short-circuiting to 1 before any division — which is also what keeps two empty strings from dividing by zero.
- The order of normalisation steps is the literal sequence listed above, including that the leading article is dropped *before* the trailing suffix is checked.
- The leading-article set covers **English and German** definite and indefinite articles. This is a German-city app with English UI copy, so both languages reach the data.
- A name can normalise to nothing — "The Bar" loses its article and then its whole remaining content is the trailing suffix. Both sides of the comparison guard against the empty string, because without that guard two such names compare as identical and block each other, and an empty string matches every other name that also normalises away.

A submitting user immediately gets a `bar_discoveries` row for their own submission — they are demonstrably standing there.

### 11.4 City data pipeline

`import-osm-bars.ts` (11.1) is not the only script that has to reach outside the repository for OSM data — the district boundaries and the tile extract do too, and `build-grid.ts` (5.2) turns their output into the grid. The three that reach the network — `fetch-boundaries.ts`, `extract-tiles.sh`, `import-osm-bars.ts` — cannot run inside the implementing agent's sandbox, which has no route to Overpass or Geofabrik, the OSM data hosts; they are run by the project owner on his own machine. `build-grid.ts` is offline and runs anywhere. Every one of their outputs is committed or released the same way as any other artefact (Section 13.1). Nothing at runtime depends on those hosts, and a v1 rebuild without network access to them is still possible from the committed output.

Because C10 already requires the data model to be multi-city capable, there is no reason for this pipeline to be Karlsruhe-specific and generalised later. It is city-parameterised from the start.

**The per-city configuration file is the single seam.** `data/cities/<slug>.json`, one file per city, committed. It holds everything both the scripts and the `cities` row (Section 5.1) need:

| Field | Used by |
|---|---|
| `slug` | all scripts; `cities.slug` |
| `name` | `cities.name` |
| `osm_admin_filter` | `fetch-boundaries.ts` — the Overpass filter (admin level, name, regional key) that identifies the city relation |
| `bounding_box` | `fetch-boundaries.ts`, `extract-tiles.sh` |
| `cell_size_m` | `build-grid.ts`; `cities.cell_size_m` |
| `geofabrik_region` | `extract-tiles.sh` — stores the **full** Geofabrik path (`europe/germany/baden-wuerttemberg`), which is what the download URL and the script's reachability probe need. Planetiler's `--area` takes only the **last segment** (`baden-wuerttemberg`) and resolves the full URL itself. Both forms are used, each where it works |
| `tiles_filename` | `extract-tiles.sh`; `CONFIG.TILES_FILENAME` |

Every script takes a single `--city=<slug>` argument and reads everything else from this file. Adding a second city is adding a second JSON file, not a code change. This file is also what seeds the `cities` row from Section 5.1 — the seeding step reads it directly, the same way it already reads `grid-meta.json` for `playable_cells` (Section 5.2). Script parameters and the database row are therefore derived from one source and cannot drift apart.

**The script chain.**

| Script | Produces | Network |
|---|---|---|
| `scripts/fetch-boundaries.ts` | City outline, district polygons, and neighbouring municipalities as GeoJSON, into `data/seed/<slug>/` | Yes — Overpass |
| `scripts/extract-tiles.sh` | The PMTiles extract, into `data/tiles/` | Yes — Geofabrik; also needs Java |
| `scripts/build-grid.ts` | The cell grid (`grid.bin`, `grid-meta.json`), per Section 5.2 | No — offline, and its output is committed |
| `scripts/import-osm-bars.ts` | `data/seed/<slug>/bars.json`, per Section 11.1 | Yes — Overpass |

`import-osm-bars.ts` joins this chain unchanged in behaviour — it still runs once, locally, offline from the running app (11.1) — except that it now also takes `--city` and reads its Overpass filter and output path from the city config instead of having Karlsruhe hard-coded.

`fetch-boundaries.ts` also accepts `--input-city=<path>` and `--input-neighbours=<path>` to read a previously saved Overpass response from disk instead of querying, so the conversion can be run and re-run on a machine without a route to Overpass. That file may be a raw Overpass JSON response or a GeoJSON FeatureCollection — the shape a human export from overpass-turbo naturally produces — detected from the payload shape and run through the same conversion either way.

Raw OSM admin boundaries need two more fixes before they are usable. District admin levels can nest — Karlsruhe's has both level 9 and level 10 relations, and some level-9 areas geometrically contain level-10 ones — so districts are taken as the leaves of that hierarchy only: an area with a finer-grained area inside it is not itself a district, or its area would be double-counted in the percentages Sections 6.3 and 7.6 compute. Neighbouring municipalities are restricted to the city's own (municipal) admin level, dropping the county-level relations the neighbours query also picks up, since Section 8.3's greyed-out context is municipalities, not counties.

**Output and what is committed.** GeoJSON produced by `fetch-boundaries.ts` and `import-osm-bars.ts` lands in `data/seed/<slug>/` and is committed, ODbL-licensed like every other OSM-derived artefact (13.1, 13.3). The PMTiles extract from `extract-tiles.sh` is **never** committed, for the reasons already given in Section 13.2 — the scripts must not tempt anyone to override that by writing it anywhere under a committed path. `data/seed/` is therefore per-city rather than the flat directory earlier drafts of this document showed; the tree in Section 4.2 reflects that.

**Scripts fail loudly and leave nothing half-written.** A failed run must not leave a truncated GeoJSON file that a later script, or a human, would happily consume as if it were complete. Output is written to a temporary path and renamed into place only on success, or not written at all. Every script prints a summary of what it produced — feature counts, file sizes, the city slug — on exit.

**Re-running is safe.** Section 11.2 already establishes that the bar import never writes to the live database and produces a diff report rather than applying changes itself. The same posture extends to this whole chain: every script here is idempotent, writes only into `data/seed/` or `data/tiles/`, and never touches a running system.

---

## 12. Development Phases

Each phase is independently testable and ends in a deployable state. Do not begin a phase before the previous one's Definition of Done fully passes.

### Phase 0 — Foundation

Scaffold monorepo, Docker Compose (Caddy + API), SQLite with migration runner, health endpoint, Cloudflare Tunnel to `tipsytrails.ahultsch.com`, `CLAUDE.md`, `README.md`, `.env.example`.

**Definition of Done**
- [ ] `docker compose up -d --build` succeeds on the Pi from a clean clone
- [ ] `https://tipsytrails.ahultsch.com/api/health` returns `{"status":"ok"}` over the public internet
- [ ] The SPA shell loads and renders a placeholder page on a phone
- [ ] Migrations run idempotently on container restart, tracked in `schema_migrations`
- [ ] No secret is present anywhere in the repository, and secret scanning with push protection is enabled
- [ ] `LICENSE` (MIT) and `DATA-LICENSE` (ODbL) exist, and the README states which covers what
- [ ] `data/db/` and `data/tiles/` are gitignored; a fresh clone contains no database file
- [ ] The admin account is seeded from environment variables, never from code, with `must_change_password = 0` (Section 5.3: the platform supplies and rotates this credential, so it must stay valid)
- [ ] Container memory at idle < 150 MB total

### Phase 1 — Accounts

Registration, login, logout, sessions, security-question password reset, forced admin password change, age gate, settings skeleton, the navigation chrome (a burger menu then; Section 8.4's tab bar since v1.22), deterministic avatars.

**Definition of Done**
- [ ] A user can register, log out, and log back in on a phone
- [ ] Registration is rejected without the 18+ confirmation
- [ ] Password reset works end to end via the security question, and invalidates existing sessions
- [ ] An unknown username returns a stable decoy security question, indistinguishable from a real one
- [ ] The seeded admin signs in **without** a forced password change (`must_change_password = 0`, Section 5.3), and an account that does carry the flag is confined to `/api/auth/me`, `/api/auth/change-password` and `/api/auth/logout` until it clears it
- [ ] Passwords and security answers are argon2id hashes in the database — verified by inspection
- [ ] Session cookie is `httpOnly`, `Secure`, `SameSite=Lax`
- [ ] Rate limits on auth endpoints return 429 when exceeded, **and two different client IPs have independent buckets through the tunnel** (Section 9.4)
- [ ] Account deletion requires the password and removes every row belonging to the user

### Phase 2 — Map

PMTiles extract for Karlsruhe, MapLibre integration, custom ink style, district polygons, city and district overview screens (static progress values), OSM attribution.

**Definition of Done**
- [ ] Karlsruhe renders in the ink style on a mid-range Android phone
- [ ] Pan and zoom hold ≥ 50 fps
- [ ] The tile route answers `206 Partial Content` to a ranged request (Section 4.1)
- [ ] Tiles are served with range requests and cached at the Cloudflare edge (verified via `cf-cache-status: HIT`), with the Cache Rule from Section 4.1 in place
- [ ] City overview → district overview → map navigation works, neighbouring municipalities are greyed and inert
- [ ] OSM attribution is visible and links correctly
- [ ] App shell < 150 KB gzipped, excluding the map chunk; the map chunk (MapLibre + PMTiles, ~250 KB gzipped) is code-split and loaded only on map routes. A single bundle under 200 KB is not achievable with MapLibre and must not be attempted by trimming features.

### Phase 3 — Fog of War

Grid build script, fog bitmask storage, per-day counters, geolocation sampling, reveal logic with speed and accuracy gates, WebGL fog layer, progress calculation, GPS/connection indicator, Wake Lock.

**Definition of Done**
- [ ] Walking reveals a ~100 m radius; the mask survives logout and reload
- [ ] Travelling above 30 km/h reveals nothing
- [ ] Samples with accuracy > 200 m are discarded; so are stale and future-dated samples
- [ ] Fog edges are soft and irregular — no visible grid squares, no hard circle
- [ ] District and city percentages are correct against a hand-computed reference
- [ ] `fog_daily_progress` sums equal `fog_state.revealed_cells` for a test user
- [ ] The fog layer holds ≥ 50 fps during continuous panning
- [ ] The 2D canvas fallback renders correctly with WebGL2 disabled
- [ ] The GPS/connection indicator reflects real state, including the foreground-only note
- [ ] No raw position is written to the database — verified by inspection

### Phase 4 — Bars

Seed import, bar storage, discovery at 100 m, permanent visibility, bar markers, bar detail screen.

**Definition of Done**
- [ ] `data/seed/karlsruhe/bars.json` is committed and imports cleanly
- [ ] Approaching within 100 m discovers a bar; it persists after reload
- [ ] `/api/bars` returns only bars discovered by the requesting user
- [ ] `/api/bars/:id` returns an identical 404 for an undiscovered bar and a nonexistent one
- [ ] No endpoint leaks the existence or position of undiscovered bars, including counts

### Phase 5 — Check-in and Mastering

Visit creation, presence evaluation, 20-minute rule, expiry, pending banner, maintenance tick, Web Push, explainer.

**Definition of Done**

`[x]` means proven by an automated test in this repository. `[~]` means built and covered as far as this environment allows, with the part that needs a real device named — no browser, no GPU, no push service and no phone here, so those cannot be ticked and must not be.

- [x] Check-in is only offered within the on-site radius, is server-re-validated, and named by the player rather than suggested — **re-earned in v1.17** on the terms its v1.14 note set: the tests drive the marker route, the sheet's action is proven disabled out of range, and one case checks in at the bar whose marker was tapped rather than the nearest. A further case clicks through the whole nearby panel and requires that no request results, so the panel cannot quietly become a control again. "Lists multiple candidates by distance" is still proven, of the panel, which now only lists them.
- [~] Two samples ≥ 20 minutes apart complete the visit — covered end to end against the API with nothing sent in between; "with the app closed" itself needs a phone
- [x] A second check-in at a bar with an open pending visit returns the existing visit, not a duplicate
- [x] The pending banner shows confirmed and remaining time accurately at all times — **re-earned in v1.17** on exactly the terms its v1.14 note set: one test drives a real sample through the app and watches the figure step from 0:00 to 10:00 off the server's own response, then takes the player out of range and holds it there across 65 seconds of wall clock. Both directions of the defect — the clock that lied and the frozen banner that would have replaced it — fail that test.
- [x] A pending visit can be cancelled by the player alone, and only their own pending one — the endpoint answers one identical 404 for another user's visit, a completed, expired or already-cancelled one, and an id that never existed; cancelling releases the partial unique index so the same bar can be checked into again immediately; a maintenance tick run against a cancelled row backdated past both the expiry and the push threshold leaves it untouched. The banner's control is proven to need its confirmation, and to cancel the visit whose control was tapped rather than the first in the list
- [~] The push notification fires once at 21 minutes, and not at all if the visit already completed — the once-only guarantee, the not-while-completed rule and the 404/410 deletion are tested with the sender faked at a seam; **delivery on Android and on an installed iOS PWA is unverified**
- [x] Moving out of range shows the explicit "still pending" message
- [x] A visit expires after 6 hours and the user can immediately check in again
- [x] Expiry is correct after an API restart that skipped several maintenance ticks
- [x] Mastered status is permanent and survives visit expiry of later visits
- [x] The explainer is reachable from the More sheet and appears once after the first check-in

### Phase 6 — Progress, Leaderboard, Badges

Profile, badge shelf, leaderboard with metric and period switching, anonymity toggle, badge evaluation job.

**Definition of Done**

`[x]` means proven by an automated test in this repository. `[~]` means built and covered as far as this environment allows, with the missing part named. Phase 6 has no device-dependent items, so `[~]` is unused here.

- [x] The leaderboard ranks correctly on both metrics and all periods, with stable tie-breaking — `packages/api/src/routes/leaderboard.test.ts`, describe blocks `ranking — area metric`, `ranking — bars metric`, and `stable tie-breaking` (`breaks a value tie by earliest achievement, and repeats the same order on a second call`, `falls back to users.id when value and achievement instant both tie`)
- [x] Week/month area figures come from `fog_daily_progress` and match a hand-computed reference — `packages/api/src/routes/leaderboard.test.ts`: `week: sums fog_daily_progress over the current ISO week only, matching a hand-computed percent`, `month: sums fog_daily_progress over the current month only, matching a hand-computed percent`
- [x] A bar mastered twice counts once, in the period of its first completion — `packages/api/src/badges.test.ts`: `a bar mastered twice counts once, in the period of its first completion`, `fails the "mastered twice" DoD item if the earliest-completion rule is replaced by a plain count`; `packages/api/src/routes/leaderboard.test.ts`: `a bar mastered twice counts once, at the leaderboard level, in the period of its first completion`
- [x] Toggling anonymous masks the name immediately while preserving rank and statistics — `packages/api/src/routes/leaderboard.test.ts`: `toggling isAnonymous changes the displayed name on the very next read, without changing rank or statistics`
- [x] An anonymous user's profile is unreachable by username and reachable by handle — `packages/api/src/routes/profile.test.ts`, describe `an anonymous user`: `404s by username`, `resolves by handle, masked, with badges shown against the masked handle`
- [x] The threshold is a floor: a user below it is never awarded, a user at it qualifies, and nobody is awarded when even the best user of the period is below it — `packages/api/src/badges.test.ts`: `awards a user at exactly the week threshold` (explorer and barfly), `does not award a user just below the threshold`, describe `evaluateBadges — awarding`: `awards nobody when even the best user is below the threshold`, `awards the single user above the threshold`
- [x] A user who registered but never moved receives no badge for the period — `packages/api/src/badges.test.ts`: `a user who registered but never moved receives nothing`
- [x] The badge for a period goes only to the highest scorer above the threshold, and to everyone tied at that top value — `packages/api/src/badges.test.ts`, describe `evaluateBadges — awarding`: `awards only the highest scorer when several users clear the threshold`, `awards every user tied at the top, so several users can hold the same badge for the same period`
- [x] The threshold is never returned by any endpoint — `packages/api/src/routes/profile.test.ts`: `returns no threshold anywhere in the badge progress`; `packages/api/src/badges.test.ts`, describe `currentBadgeProgress`: `reports the player's own value from the same computation evaluateBadges scores, and no threshold`
- [x] Badges are visible on profiles and inline in leaderboard rows — `packages/api/src/routes/profile.test.ts`: `surfaces the badge shelf (all badges ever awarded)`; `packages/api/src/routes/leaderboard.test.ts`: `are ranked and counted, with identity masked but badges present`; `packages/web/src/App.leaderboard.test.tsx`: `shows an anonymous row masked, still ranked, with its badges`
- [x] The player's own value for the running period is shown on the profile, with no threshold, target, or rank beside it — `packages/api/src/badges.test.ts`, describe `currentBadgeProgress`: `reports the player's own value from the same computation evaluateBadges scores, and no threshold`; `packages/web/src/App.leaderboard.test.tsx`: `renders the badge shelf and the player's own value for each kind and period`
- [x] The evaluation job is idempotent — running it twice awards nothing twice — and catches up a period missed while the Pi was off — `packages/api/src/badges.test.ts`: `running the evaluation twice awards nothing the second time and does not change value or awarded_at`; describe `runBadgeCatchUp`: `evaluates a period that closed while the process was down, and does not re-evaluate one already done`

### Phase 7 — Community Submissions and Admin

Suggest-a-bar with map picker, duplicate guard, community marker, admin area.

**Definition of Done**

`[x]` means proven by an automated test in this repository. `[~]` means built and covered as far as this environment allows, with the missing part named. Phase 7 has no device-dependent items, so `[~]` is unused here.

- [x] A bar can be suggested via map pin, name, and address, and appears immediately for all users — `packages/api/src/routes/bars.test.ts`, describe `POST /api/bars/suggest`: `creates a community bar that appears immediately in GET /api/bars for the submitter, discovered`, `is discovered by a second, unrelated user who later walks within BAR_DISCOVERY_RADIUS_M of it`; `packages/web/src/App.community.test.tsx`, describe `suggest a bar`: `submitting a bar with a picked pin succeeds and the bar appears as discovered`
- [x] Community bars carry a visible distinguishing marker — `packages/web/src/App.community.test.tsx`, describe `community marker`: `shows a community bar marker distinctly from an OSM bar marker`
- [x] Submissions within 25 m of a similarly named active bar are rejected with a message naming the conflict — `packages/api/src/routes/bars.test.ts`, describe `POST /api/bars/suggest`: `rejects a near-duplicate within SUGGEST_DUPLICATE_RADIUS_M, naming the conflicting bar`
- [x] The submitter immediately has the bar as discovered — `packages/api/src/routes/bars.test.ts`, describe `POST /api/bars/suggest`: `creates a community bar that appears immediately in GET /api/bars for the submitter, discovered` (asserts the `bar_discoveries` row exists for the submitter)
- [x] The admin section is visible in the More sheet only for admins, and admin endpoints return 403 otherwise — `packages/web/src/App.community.test.tsx`, describe `admin menu visibility`: `hides the Admin entry from the More sheet for a non-admin user`, `shows the Admin entry in the More sheet for an admin user`; `packages/api/src/routes/admin.test.ts`, describe `admin guard`: `returns 403 for a logged-in non-admin at $method $url` (parameterised over every `/api/admin/*` route)
- [x] The admin can create, edit, hide, and delete bars; moving a bar recomputes cell and district; deletion cascades cleanly — `packages/api/src/routes/admin.test.ts`: describe `POST /api/admin/bars`: `creates a bar directly, active, source=admin, submitted by the admin`; describe `PATCH /api/admin/bars/:id`: `edits name, address, and status`, `recomputes cell_index and district_id to the values the projection gives for the new position`; describe `DELETE /api/admin/bars/:id`: `deletes a bar with discoveries and visits, cascading both away`; describe `hiding a bar and player-facing endpoints`: `a hidden bar vanishes from GET /api/bars for a player who had discovered it`
- [x] Submission rate limits are enforced — `packages/api/src/routes/bars.test.ts`, describe `POST /api/bars/suggest`: `enforces the suggest rate limit`

### Phase 8 — Hardening and Polish

PWA manifest and install prompt, offline shell, privacy page, performance pass, error states, empty states, accessibility pass.

**Definition of Done**

`[x]` means proven by an automated test in this repository. `[~]` means built and covered as far as this environment allows, with the part that needs a device, a browser, or the Pi named. Five items need a phone, a Lighthouse run, a browser tracing simulated 4G, or the Pi itself under load — nothing buildable from here gets any of them partway there, so they stay `[ ]`, each with what is missing named beside it.

- [ ] The app installs to the home screen on Android and iOS — needs an Android device and an iOS device; nothing here can install a PWA to a home screen
- [~] Opening offline shows the cached shell, the last fog state, and a clear offline indicator — the last fog state and the offline indicator are proven end to end: `packages/web/src/App.pwa.test.tsx`, describe blocks `offline indicator and queued samples` and `fog state offline`. The cached-shell half rests on `sw.js`'s own `networkFirst`/`cacheFirst` handlers, which jsdom has no Service Worker environment to execute — proven only as source-text assertions in the same file's `describe('a single service worker')` (the file exists, `push-sw.js` does not, `/api/*` is never intercepted), not by actually serving a page from the Cache API
- [~] Queued samples survive going offline and are posted on reconnect — proven for an offline stretch with the tab open and the tracking hook still mounted: `packages/web/src/App.pwa.test.tsx`, describe `offline indicator and queued samples`. The queue itself is a `useRef` held in memory (`packages/web/src/tracking/useSampleTracking.ts`), so it does not survive a reload — that half is a deliberate limit, recorded in a comment at the same `useRef`, not merely untested
- [ ] Lighthouse mobile performance ≥ 90 — needs a real browser and a Lighthouse run
- [ ] Time to interactive < 3 s on a mid-range Android over simulated 4G — needs a real or simulated Android device
- [ ] API p95 latency < 150 ms measured on the Pi under 10 concurrent users — needs the Pi
- [x] `/privacy` is live, mentions the per-day reveal counters, and links to the main site's policy and legal notice — `packages/web/src/App.privacy.test.tsx`, describe `/privacy`
- [~] `prefers-reduced-motion` disables the dissolve animation and all transitions — the CSS rule itself is asserted structurally: `packages/web/src/App.a11y.test.tsx`, describe `prefers-reduced-motion` (the universal `*, *::before, *::after` selector, durations collapsed to zero with `!important`). The JS-driven fog dissolve's own listener is exercised against a real `matchMedia`: `packages/web/src/map/fog/fog-controller.test.ts`, `packages/web/src/map/fog/webgl-fog-layer.test.ts`. Neither proves a real browser applying the rule — this project's jsdom test config applies no real stylesheet
- [~] Accessibility: WCAG 2.1 AA contrast on text and controls, visible focus states, labelled form fields, and no state signalled by the accent colour alone (Section 8.1). All of these are automated in `packages/web/src/App.a11y.test.tsx`, as are the Section 8.6 status icons' luminance separation, hue separation, distance from the accent and severity ordering — derived from the palette tokens themselves, since those icons are the one place colour does carry state alone. Two things stay unverified because nothing in this repository can do them: whether any of it is announced sensibly by a screen reader, and how the three status icons actually read, in colour and in greyscale, on a phone in daylight
- [x] Every network failure produces a user-facing message, never a silent failure — the same centralized network-error path (`packages/web/src/api/client.ts`) is exercised failing at three independent call sites: login (`packages/web/src/App.test.tsx`, `shows a message rather than failing silently on a network failure during login`), the city boundary fetch (`packages/web/src/App.test.tsx`, `shows a message rather than an empty screen when the city boundary fetch fails`), and the district overview fetch (`packages/web/src/App.privacy.test.tsx`, describe `network failures surface a message`)
- [ ] Total container memory under load < 400 MB — needs the Pi under load, and a Docker image, which has never been built here

---

## 13. Open Source and Licensing

The repository is public. Everything required to build, run, and self-host the project is in the repository. The only things that never leave the Pi are the runtime database and everything derived from it.

### 13.1 What is committed

| Artefact | Committed | Notes |
|---|---|---|
| Application source (api, web, shared) | Yes | |
| Docker Compose, Caddyfile, Dockerfiles | Yes | |
| Migrations | Yes | Schema is public; data is not |
| `data/seed/karlsruhe/bars.json` | Yes | OSM-derived, ODbL |
| `data/seed/karlsruhe/districts.geojson` | Yes | OSM-derived, ODbL |
| `data/seed/karlsruhe/grid.bin`, `grid-meta.json` | Yes | Reproducible via `scripts/build-grid.ts` |
| Map style definition | Yes | Own work |
| Build and import scripts | Yes | |
| `.env.example` | Yes | Variable names and shapes only, never values |
| `*.pmtiles` | **No** | Published as a GitHub Release asset, see 13.2 |
| `data/db/*` (SQLite, WAL, SHM) | **No** | Gitignored |
| `.env` | **No** | Gitignored |

**Never committed under any circumstance:** user accounts, password or security-answer hashes, fog state, discoveries, visits, badges, push subscriptions, session data, VAPID private key, session signing secret, admin credentials, Cloudflare Tunnel token.

### 13.2 Map tiles

The tile extract was estimated at 30–80 MB when this section was written. Karlsruhe's, built for the Section 6.2 bounding box at zoom 0–14, measures **9.4 MB** — the first time the figure was measured rather than assumed. GitHub's 100 MB hard limit and 50 MB warning are therefore not the binding constraint they were taken to be.

It is nonetheless published as a **GitHub Release asset**, not a tracked file. Every regeneration produces a new file under a new versioned name (Section 4.1), so committing them would accumulate binaries in history that no revision ever needs again, and the extract is ODbL-derived rather than MIT (13.1, 13.3). Keeping it out of the tree also keeps clones small for anyone who only wants the code. The premise changed; the decision stands, and the reasons above are the ones that carry it. `scripts/extract-tiles.sh` regenerates it from a public Geofabrik extract, so the artefact is reproducible without the release; it needs Java and network access to Geofabrik, and it is run by the owner rather than by the implementing agent (Section 11.4).

`docker compose up` fails with a clear, actionable error if the tiles file is absent, naming both the download URL and the regeneration script. The expected filename comes from `CONFIG.TILES_FILENAME`, so a regenerated extract is published under a new versioned name and the edge cache is bypassed automatically (Section 4.1). This holds for the standalone two-container path (Section 4), where Compose can check for the file before anything else starts.

It does **not** hold for the single-container deployment that runs on the Pi (v1.2.2). That container is the whole site: refusing to boot over a missing map extract would take registration, login and every other feature down for a file only the map needs. The API therefore always starts.

If `${TILES_DIR}/${CONFIG.TILES_FILENAME}` (Section 4.3) is missing at boot, the API logs the absence at `error` level, naming both the download URL and the `scripts/extract-tiles.sh` regeneration command. Every request under `/tiles/*` then answers with a machine-readable error (Section 9.5's conventions apply) that the client surfaces on the map screen, rather than a raw 404 or a hung request.

The difference between the two deployments is deliberate. The standalone path can fail fast because Compose owns nothing but this one service; the single container cannot let one optional feature take the whole site down.

Whichever deployment serves it, `/tiles/*` must answer HTTP range requests — PMTiles fetches small byte ranges out of the one large file rather than downloading it whole, and a server that ignores `Range` defeats the point of the format (Section 4.1). This is verified directly against a `206 Partial Content` response, not assumed from the serving library (Section 12, Phase 2 Definition of Done).

### 13.3 Licences

- **Code:** MIT. Permissive, minimal friction for anyone wanting to run their own city.
- **Map data and derived artefacts** (`bars.json`, `districts.geojson`, `*.pmtiles`, `grid.bin`): ODbL, inherited from OpenStreetMap. Documented in `DATA-LICENSE` with the attribution required by Section 10.5.
- The `README` states the split explicitly so nobody assumes MIT covers the data.

### 13.4 Consequences of a public repository

These are consequences to design around, not reasons to reconsider:

1. **No security through obscurity.** Rate limits, the session model, and the security-question reset flow are all publicly readable. They are specified to hold up under that assumption; the rate limits in Section 9.4 are load-bearing, not decorative — which is precisely why the proxy-header requirement in that section is a correctness issue, not a detail.
2. **Bar positions are public.** `bars.json` is in the repository, so the "hidden until discovered" mechanic is a gameplay convention, not a secret. This is acceptable — the underlying data is public OSM data regardless. The API still refuses to leak undiscovered bars (Sections 7.4, 9.5), because the convention should not be broken by the app itself.
3. **The admin account is never in code.** It is seeded on first boot from `ADMIN_USER` and `ADMIN_PASSWORD` environment variables. A hard-coded admin credential in a public repository is a critical failure. The account is seeded with `must_change_password = 0`, because on the Pi that credential is chosen by the operator and managed by the platform rather than shipped with the image — Section 5.3 sets out why forcing a change there breaks the managed path in rather than protecting it. Boot-time seeding creates and never overwrites (`seedAdmin` in `packages/api/src/db/seed-admin.ts`, called by `initialiseDatabase`); rewriting an existing account's password is a separate function that only `npm run seed:admin -- --rotate-password` calls, so no container restart can revert a password (Section 4.3).
4. **Secret scanning.** GitHub secret scanning and push protection are enabled on the repository. Any secret that ever lands in history must be rotated, not merely deleted.

---
## 14. Open Items

Re-audited against the code at v1.33. Items that were resolved and whose reasoning already lives in the section it concerns have been removed; the numbers of the items that remain are unchanged, because code comments cite them.

| #   | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Status                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| O2  | No **drawn** logo. The wordmark (Section 8.1) is the mark and is on every main screen; what is deferred is a pictogram to stand beside or instead of it. It would have to satisfy the wordmark's four rules, and one narrows the field sharply: it may not be a downloaded font (Section 8.2). An SVG in the ink style of the map symbols is the shape a future answer takes.                                                                                                                                                                                                                                                                                                                                                                      | Deferred                        |
| O3  | `cell_size_m` may move from 50 m to 25 m after real-world testing. At 25 m the grid is 834 × 686 = 572,124 cells: mask ~70 KiB, texture ~559 KiB, `grid.bin` ~1.1 MB — all viable. What is not built is the migration: every existing `fog_state.mask` has to be re-projected onto the new grid and `fog_district_progress` / `fog_daily_progress` recomputed with it, atomically, against a live database. `scripts/rebuild-grid.ts` validates its arguments and then refuses to run, deliberately, rather than silently doing nothing.                                                                                                                                                                                                            | Deferred                        |
| O4  | Native iOS wrapper (Capacitor) for true background tracking — the only route to background reveal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Out of scope for v1             |
| O5  | Additional cities. The data model and the pipeline support them; no admin flow for adding one exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Out of scope for v1             |
| O6  | GitHub Actions + GHCR build pipeline if on-Pi build times become painful. No workflow exists in the repository.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Documented, not built           |
| O7  | Friends, shared sessions, and social features.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Out of scope for v1             |
| O10 | **`trustProxy` is set to 1 on the Pi without anyone having verified the hop count** (Section 9.4). The chain is browser → Cloudflare edge → Cloudflare Tunnel → `cloudflared` → Caddy → API, and neither repository settles how many of those append to `X-Forwarded-For`; nor does either settle whether the platform's Caddy sets `trusted_proxies` or a `header_up` override that would rewrite the list. Too many trusted hops lets a client fabricate its own bucket; too few reads a proxy's address as the client's. Until it is settled, Section 13.4's "rate limits are load-bearing" is unverified for this deployment. **Remedy:** log the raw header from one real external request and count the entries, *and* read the platform `Caddyfile`'s global options. | Open — needs verification on the Pi |
| O11 | The owner reports well-known Karlsruhe venues missing from the seed. The import now covers `amenity` in bar/pub/biergarten/nightclub **or** `bar=yes` on any amenity (Section 11.1, widened in v1.20), and the committed seed holds 180 records. Whether anything is still missing has not been re-checked since that widening. Cause unestablished: venues tagged differently again (a cocktail bar as `amenity=cafe` with no `bar=yes`), absent from OSM, or outside the municipal boundary the import clips to. **Needs concrete named examples before any further filter change** — widening to `amenity=cafe` would pull in every café in the city.                                                                                              | Open                            |
| O12 | `estimateCellPixelSize` (`packages/web/src/map/fog/canvas-fallback.ts`) measures from `origin_lon` — the grid's **west boundary**, cell x = −0.5 — to `cellCenterXY(1, 0)`, a cell **centre** at x = 1. Those are 1.5 cells apart and the result is used as one cell's width, so every revealed-cell hole is drawn about 1.5× too large and cleared area bleeds roughly a quarter of a cell past the grid edge. Affects only the 2D canvas fallback, which is why nothing caught it. **Fix:** measure between two cell centres.                                                                                                                                                                                                                    | Open                            |
| O13 | The two fog renderers diverge on Section 7.3's layer ordering. The WebGL path is a style layer inserted at the ordering point that section fixes. The 2D canvas fallback is a `<canvas>` appended to the map container — a DOM overlay above the whole map — so it cannot be interleaved with the vector layers at all: without WebGL2 the fog covers roads and water too, and the whole base map shows through at one minus the fallback's flat alpha. Closing it means giving the fallback its own base-map compositing, which Section 7.3 explicitly does not ask of it. Accepted; revisit only if a real player turns out to be on that path. **Worse than recorded, found in v1.43 and not yet acted on:** `.fog-canvas-fallback` has no rule in `index.css` at all. It is a statically positioned `<canvas>` appended to the map container, while maplibre-gl.css gives `.maplibregl-canvas` `position: absolute` - and a positioned element paints above an in-flow non-positioned sibling in the same stacking context. So MapLibre's own opaque canvas paints over the fallback, and a device without WebGL2 most likely sees **no fog at all**, rather than the uniform sheet this item describes. Unobservable here: jsdom returns a null 2D context, so every test of this path asserts the element exists and nothing about what it paints. Closing it needs a real device without WebGL2, and a position/z-index rule. | Open |
| O14 | An **expired** visit is never removed from the pending banner while the map screen stays *continuously visible*. The banner refetches `GET /api/visits/pending` on `visibilitychange` (Section 7.5), which covers the backgrounded-PWA case the field report described; what is left is a screen visible for the whole of `VISIT_EXPIRY_S` with no accepted on-site sample, since `POST /api/samples` reports only the visits its sample touched. Ordinary on a desktop tab, six hours of unlocked phone otherwise. A periodic refetch was considered and rejected (Section 7.5 says why), which leaves one route: the sample response reporting the visits it expired. The banner can no longer be *stuck* — cancelling answers 404 and a 404 removes it. | Open — narrowed                 |
| O16 | `CONFIG.BADGE_THRESHOLDS` reaches the browser in plaintext. Section 7.7's wording holds — nothing renders a threshold and no route returns one — but its spirit does not. `CONFIG` is one object literal and `packages/web` imports it as a *value* in twelve modules (`api/types.ts`, `components/TrackingIndicator.tsx`, `map/ink-style.ts`, `map/MapPicker.tsx`, `map/bars/bar-stamps.ts`, all three under `map/fog/`, `screens/Map.tsx`, `screens/Leaderboard.tsx`, `screens/Privacy.tsx`, `tracking/status.ts`, `tracking/useSampleTracking.ts`), so the whole object is bundled and reads out of devtools in seconds. The exposure is mild — the thresholds are floors and a badge goes to the period's best — but the document should not read as a guarantee it does not enforce. **Fix:** split `CONFIG` into a client-safe half and a server-only half; that touches every one of those imports. | Open                            |
| O17 | **`GET /api/progress` returns no `barsMastered`, and the start screen pays for it.** Section 7.6 defines a city-wide mastered count and no route returns one, so `/app` (Section 8.3) fetches `GET /api/bars` — every discovered bar, with name, address, coordinates, district and timestamp — to read its length and count its `mastered` flags. Hundreds of rows for two integers, on the screen every authenticated entry path lands on, growing with exactly the players who play most. Both halves close with one change: add `barsMastered` and a discovered count to `GET /api/progress`, which makes the start screen one small request instead of two, one of them unbounded. That is a response-shape change and has not been made. | Open                            |
| O18 | **Nothing validates an API response on the client.** `request<T>` in `packages/web/src/api/client.ts` returns `body as T` — a cast, not a check — and `packages/web` carries no validation dependency at all, while the server validates every inbound body and query with `zod` at the route boundary (Section 10.1). A response that drifts from `packages/web/src/api/types.ts` therefore reaches React as an assertion the compiler has already believed, and surfaces as an undefined field somewhere far from the fetch. It is the largest remaining hole at a boundary untrusted data crosses. **Fix:** share the zod schemas both sides already imply, and parse in `request` rather than cast. | Open                            |
| O19 | **The committed seed was never regenerated after the duplicate collapse landed.** Section 11.1's collapse is implemented and tested, but it runs inside `scripts/import-osm-bars.ts`, and `data/seed/karlsruhe/bars.json` still holds the pre-collapse 180 records — including both pairs that rule exists for: Fettschmelze as two nodes 6.2 m apart and Traube as a node and the way around it 25.3 m apart. `packages/api/src/db/seed-bars.ts` seeds that file as it stands, so a fresh deployment still gets two markers an arm's length apart with the same name, and a player can still check into both. **Fix:** re-run the import (owner's machine — it needs Overpass) and commit the 178-record file. | Open                            |

---

## 15. Changelog

A record of **what** changed, newest first. The reasoning lives in the numbered sections, which are the authority; nothing here needs to be read to rebuild the system. v1.1 is the baseline, and anything not listed is unchanged since it.

- **v1.44** — `npm run seed:admin` gains one flag, `--rotate-password`, and stops reporting two different situations with the same sentence. Without the flag it is unchanged: create the admin account if it is missing, otherwise touch nothing. With it, an existing account's `password_hash` is rewritten from `ADMIN_PASSWORD` and nothing else about the row is — which is how `deploy.sh --set-password` reaches this site, and the only way it can, since from inside the container an operator's rotation and an admin's own password change are the same observation. Boot-time seeding calls a function that has no rotate path at all, so no restart can revert a password. Four outcomes now carry four messages, and exactly one of them — `ADMIN_USER`/`ADMIN_PASSWORD` absent — exits nonzero, so `deploy.sh`'s `|| echo WARN` fires for a real misconfiguration and not on every ordinary deploy. An unrecognised argument aborts the run rather than being ignored. Sections 4.3, 5.3, 13.4.
- **v1.43** — The admin's teleport picker draws Section 7.3's fog and the admin's discovered bar markers, behind an opt-in on the one map-picker component that Suggest a bar does not pass, so that picker is unchanged. In the teleport picker the markers are decoration and not controls — inert spans, no focus, `pointer-events: none`, the set hidden from assistive technology — because a 44 px marker sitting on a bar would otherwise swallow the one tap the screen exists to make. Undiscovered bars are still not drawn anywhere. Sections 8.3, 9.3.
- **v1.42** — Teleport becomes a mode the client honours instead of a one-shot it never hears about: `GET` and `DELETE` join the `POST` on `/api/admin/teleport` behind the same registration gate and the same `requireAdmin`, the clear carries no exclusion precondition and drops the caller's last accepted position with the mode, and the map screen stops watching GPS and reports the teleported point as the position while one stands — posting from it on the ordinary cadence through an unchanged `POST /api/samples`. The map says so in a bar across its top band and carries the way out beside the words. The state is in memory beside the previous-accepted-position map: it survives a reload, not a restart. Sections 7.2, 8.3, 9.3, 9.6, 10.2.
- **v1.41** — `users.excluded_from_rankings` (migration 003) takes an account out of the leaderboard and out of the badge race without taking it out of the game, set from a toggle on the admin user list; and `POST /api/admin/teleport` moves an admin's own position to a point on the map picker, running the shared sample pipeline with the two speed guards off behind four independent gates — `requireAdmin`, the `ADMIN_TELEPORT_ENABLED` variable whose absence means the route is not registered, the exclusion above, and no client-side gate anywhere. `POST /api/samples` keeps exactly the validation it had. Sections 4.3, 5.3, 7.7, 7.8, 9.3, 10.1.
- **v1.40** — The explorer badge gains a case: a ring with a north-pointing needle, because the bare compass rose it replaced reads as a star at 1.25 rem and the month modifier above it is a star. The More sheet's bug item says "Report a bug on GitHub" and nothing else, with the new-tab warning kept in its accessible name and the GitHub-account line dropped from the screen. The map's wordmark and OSM attribution plates drop from 0.85 to 0.6 and 0.5, measured against the darkest ground the ink style can produce rather than against the fog. Sections 7.7, 8.3, 8.4.
- **v1.39** — The badge note drops its closing "no fixed score wins one" clause at the owner's direction, on the shelf and in Section 7.7 alike. O15 (fog shimmer) closed: the owner has confirmed the application working in the field, which is the only place it could ever have been confirmed.
- **v1.38** — The badges are redrawn: six names of the owner's own instead of a kind word joined to a period word, a compass rose and a highball that is deliberately not the martini, the period carried by a star or a crown above the pictogram instead of by a ring count, and a placeholder that is the same artwork drawn back in ink inside a dashed frame. The sheet loses its description and keeps one sentence. The chrome wordmark becomes a link to the start screen — inert on `/app` and when signed out — and leads the map's top row, which moves the status icons and their explanation panel to the opposite corner. Sections 7.7, 8.1, 8.3.
- **v1.37** — The More sheet gains "Report a bug", the one item that leaves the app: the issue form, in a new tab, prefilled with three prompts and the screen from the router, and carrying no version because there is none to carry. The content column states its own width, which is what stopped the district map resizing on the first selection and the chrome wordmark jumping left on a loading profile; both wordmark prominences now state their own alignment, and the district detail panel reserves its tallest state rather than a line count. Sections 8.1, 8.2, 8.3, 8.4.
- **v1.36** — Every badge on a player's own profile becomes a button opening a sheet that describes it — what earns it, over what window, and whether they hold it; the descriptions live beside the catalogue in `packages/shared/src/badges.ts`, and an unearned badge's sheet says "Not yet earned." and carries no number to leak. Sections 7.7, 8.3.
- **v1.35** — The start screen's backdrop is reframed into a tall viewBox instead of a square one blown up to cover a phone, gains the district edges, and is dissolved at the screen's edges by a CSS mask; its ink is pre-composited and painted opaque, which is what makes the layers safe at unchanged contrast. Section 8.3.
- **v1.34** — Front matter added before Section 0 (what this is, the loop, how it is built, where to look); Section 3 gained the exact dependency manifest and stopped naming `vite-plugin-pwa`, which was never a dependency; Section 9.6 added, giving every response shape, the `GET /api/fog` wire format and the full `code` vocabulary; long paragraphs split and Sections 7.3 and 4.3 given unnumbered sub-headings.
- **v1.33** — Review pass over this document: eight confirmed inaccuracies corrected, Section 7.1's constants block completed against `config.ts`, changelog compressed, open items re-audited (O1, O8 and O9 removed as resolved; O18 and O19 added).
- **v1.32** — The wordmark goes on every main screen at two prominences (hero and chrome); `/app` becomes a real start screen — one action, the player's three figures, a fogged city outline behind them. Section 8.2 corrected: there is no webfont in this repository and never was. Sections 8.1, 8.2, 8.3. O17 added, O2 narrowed.
- **v1.31** — A player's own profile shows a placeholder for every badge type they have never held, carrying nothing that changes as their own value changes. Section 8.1's "never colour alone" generalised to "never grey alone". Section 7.7. O16 added.
- **v1.30** — Discovering a bar becomes a stamp pressed onto the map at the bar, with one spoken announcement per batch; Section 8.3 gains the distinction between screen-anchored overlays and ground-anchored marks. Sections 7.4, 8.2, 8.3.
- **v1.29** — Every bar the API returns carries a per-user `mastered` flag, asked once per request rather than once per bar; the cocktail glass becomes the mark for a bar, with two states. Sections 5.7, 8.1.
- **v1.28** — The fog's density varies across the city from a noise field instead of one flat alpha; `FOG_MAX_OPACITY` becomes a ceiling; the fog shader moves to `highp`. Section 7.3.
- **v1.27** — The map stops announcing revealed cells; a district link carries the district's bounding box and the map is built framed on it; district borders are drawn dashed, above the fog. Sections 7.3, 8.3.
- **v1.26** — `POST /api/samples` answers with `tooFastToReveal`; the check-in radius drops from 50 + 50 m to 30 + 20 m. Sections 7.3, 7.5.
- **v1.25** — The connection indicator measures the sample queue's *progress* rather than its depth; the map's camera is capped at pitch 0 while rotation stays. Sections 8.3, 8.6. O15 opened.
- **v1.24** — Cancelling a visit works (a bodyless request must not declare a JSON content type); the banner refetches on `visibilitychange`; duplicate venues are collapsed at import under `IMPORT_DUPLICATE_RADIUS_M`. Sections 5.7, 7.5, 11.1. O14 narrowed.
- **v1.23** — `viewport-fit=cover` added to the viewport meta tag, without which iOS reports no safe area at all; both insets read from one named token each. Section 8.2.
- **v1.22** — The burger menu becomes a five-tab bottom bar plus a More sheet; `/privacy` gains its own back link for a signed-out reader. Section 8.4.
- **v1.21** — The admin bar list is ordered by a German-pinned `Intl.Collator` shared by API and screen, not by SQL `COLLATE NOCASE`. Section 9.3.
- **v1.20** — The bar import widens to `bar=yes` regardless of `amenity`, catching venues OSM files under their primary business. Section 11.1.
- **v1.19** — The map's overlays become one band layout instead of independent offsets; the OSM attribution gets a band of its own. Section 8.3.
- **v1.18** — `POST /api/visits/:id/cancel` built; the banner renders the server's `confirmedS` and `remainingS`. Sections 5.7, 7.5, 9.2. O14 added.
- **v1.17** — Check-in moves onto the bar's marker and into a sheet on the map screen; `/bars/:id` carries none. Sections 7.5, 8.3.
- **v1.16** — The fog edge becomes a boundary rather than a 190 m fade, fixed by two related constants; the fog quad is rebuilt each frame from the camera's bounds; minor roads added below the fog; "to my location" sets `MAP_DEFAULT_ZOOM`. Sections 7.3, 8.3.
- **v1.15** — The status palette's deferred values are decided against Section 8.6's contrast bounds, and two consequences of that arithmetic recorded.
- **v1.14** — Seven decisions from the third round of field feedback: the fog moves down the layer order with water and both road layers above it; the status indicator becomes three fixed-shape icons, costing the palette its single-accent rule; check-in moves to the marker; visits become cancellable; the banner's confirmed figure becomes the server's; overlays may not obscure one another; the map opens at zoom 16. Sections 7.3, 7.5, 8.1, 8.3, 8.6.
- **v1.13** — The fog is inserted beneath the motorway layer rather than over the whole style, and its opacity rises and moves into `CONFIG.FOG_MAX_OPACITY`. Section 7.3. O13 opened.
- **v1.12** — Badges become a per-period competition decided on the highest score; the threshold survives only as a hidden floor; a tie awards everyone tied at the top. Section 7.7.
- **v1.11** — Section 4.3 corrected against the Pi's real `sites.conf`, `deploy.sh`, `docker-compose.yml` and `Caddyfile`, pasted by the owner on 2026-08-19. O10 widened to cover the unread `trusted_proxies` / `header_up` configuration.
- **v1.10** — First rewrite of the Pi contract, and VAPID keys move out of the environment onto the data volume. Sections 4.3, 5.9, 10.1. O10 opened. **Superseded by v1.11**: this entry's claim to have read the platform repository was false, and several details taken second-hand from it were wrong.
- **v1.9** — `/sw.js` and `/icons/*` added to the cache table; `scripts/rebuild-grid.ts` written as a stub that refuses to run. Sections 4.1, 6.2.
- **v1.8** — Phase 8. One service worker owns both the offline shell and Web Push; the client fog cache is keyed per user and cleared on logout; the privacy page's three overclaims corrected; the own-position marker built. Sections 4.1, 10.2, 10.3, 11.4.
- **v1.7** — Phase 7. The duplicate guard's four ambiguous readings settled; hidden bars actually hidden from player-facing reads while mastering survives hiding; the admin surface's missing rate limit, its 403, and its duplicate-guard exemption recorded as decisions. Sections 5.7, 9.3, 9.4, 11.3.
- **v1.6** — Phase 6. `BADGE_EVAL_INTERVAL_MS` added; "earliest achievement" given a normative definition; `player-{id}` resolves for every user; `pretest`/`pretypecheck` added after a stale `dist` hid a real break; the tile extract measured at 9.4 MB against a 30–80 MB estimate. Sections 3, 7.1, 7.8, 9.5, 13.2.
- **v1.5** — Phase 5. `GET /api/push/vapid-public-key` added; the three `VAPID_*` variables made optional; the maintenance tick made asynchronous and clock-free. Sections 7.9, 9.2.
- **v1.4** — The API serves `/tiles/*` itself in the single-container deployment, with range support mandatory; a missing extract no longer refuses boot there. Sections 4.1, 4.3, 9.2, 13.2.
- **v1.3** — The data pipeline is city-parameterised from the start: `data/cities/<slug>.json` as the single seam, `fetch-boundaries.ts`, per-city `data/seed/<slug>/`. Section 11.4.
- **v1.2.2** — A single-container deployment path added beside the standalone two-container one; the API serves the built SPA and reproduces Caddy's cache rules. Sections 4, 4.1.
- **v1.2.1** — Repository renamed to `TipsyTrails`, public host to `tipsytrails.ahultsch.com`, package manager pinned to pnpm 10.
- **v1.2** — Optimisation pass on v1.1. Fifteen corrections of things that were wrong or unbuildable — the `confirmed_ms`/seconds unit mismatch, period-scoped progress being uncomputable without `fog_daily_progress`, nothing expiring visits or sending the reminder, no password-change endpoint, per-IP limiting that would have been global, a CSP with no `worker-src`, an unachievable bundle budget, a tile filename with no version segment, Cloudflare not caching `.pmtiles`, a 403 that leaked undiscovered bars, username enumeration through the reset flow, two different mask sizes, Node 20's LTS end, a wrong cross-reference, and a review queue that does not exist — plus twelve additions. All folded into the sections above.

### Reversed decisions, and other traps worth guarding

Kept only where a future reader might otherwise re-propose the reverted thing and re-break it.

1. **Badges are a competition, not a participation floor** (v1.12 reversed v1.1). Raising a threshold does not make a badge harder to win — it only makes "nobody won" likelier. Section 7.7.
2. **There is a bottom tab bar** (v1.22 reversed this document's own "no bottom tab bar, no other persistent chrome"). Section 8.4.
3. **The fog quad must never be a fixed rectangle derived from the city extent, and `FOG_VIEWPORT_PADDING_RATIO` must never be merged with `MAP_BOUNDS_PADDING_RATIO`** (v1.16). Sharing them is what left the corners of a rotated map bare. Section 7.3.
4. **Roads and water are drawn _above_ the fog, not faintly through it** (v1.13, v1.14 reversed v1.1's "roughly 25% opacity beneath"). Section 7.3.
5. **`FOG_MAX_OPACITY` is a ceiling, not the fog's alpha** (v1.28). Three consumers read it wanting the darkest ground the fog can produce; a variation that went upward would understate all three. Section 7.1.
6. **No webfont** (v1.32). Adding a third family is a decision about the whole application, argued in Section 8.2 or not at all.
7. **A request with no body must never set `Content-Type: application/json`** (v1.24). Fastify rejects it with a 400 before any handler runs, and a test with a stubbed `fetch` cannot see it. Section 7.5.
8. **The nearby-bars panel is a statement, never a control** (v1.14, v1.17). It is what makes two neighbouring bars separable. Section 7.5.
9. **The pending banner shows the server's `confirmed_s`** — never a client clock counting from check-in, and never a figure frozen while the player is standing in the bar either (v1.14, v1.18). Section 7.5.
10. **`BAR_ONSITE_RADIUS_M` and `BAR_ACCURACY_TOLERANCE_M` stay two constants** (v1.26). Folding the tolerance into the base radius makes check-in impossible on a poor fix rather than merely harder.
11. **`SUGGEST_DUPLICATE_RADIUS_M` and `IMPORT_DUPLICATE_RADIUS_M` stay separate** (v1.24). Loosening the import must not loosen what a player may submit. Section 11.1.
12. **The connection indicator must not be derived from the queue's depth** (v1.25). Batching means a healthy phone almost always has something queued. Section 8.6.
13. **The longitude scale is evaluated once at `origin_lat`, never at the sample latitude** (Section 6.1). "Fixing" it makes cells non-uniform and breaks the packed grid.

---

_End of specification v1.44_
