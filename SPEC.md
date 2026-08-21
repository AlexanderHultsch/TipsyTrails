# Tipsy Trails — Technical Specification

**Version:** 1.18
**Status:** Draft — ready for implementation
**Repository:** https://github.com/AlexanderHultsch/TipsyTrails
**Target host:** Raspberry Pi 4 Model B (4 GB), Raspberry Pi OS Lite 64-bit, Docker
**Public URL:** `https://tipsytrails.ahultsch.com` (via Cloudflare Tunnel)

> Changes from v1.1 are listed in Section 15. Anything not listed there is unchanged.

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
| PWA | `vite-plugin-pwa` (Workbox) | Installable, offline shell, Web Push on iOS ≥ 16.4 |
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

`better-sqlite3` is a native module. The API Dockerfile must either use the published arm64 prebuild or install build tools in a build stage that does not ship in the final image. A build that silently compiles from source on every `docker compose build` is a defect.

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
| `/index.html`, `/manifest.json`, `/sw.js` | `public, max-age=0, must-revalidate` | The service worker controls the whole app shell (Section 15, v1.9); pinned the same as the shell document rather than left to an intermediary |
| `/icons/*` | `public, max-age=86400` | Referenced from the manifest, not content-hashed, changes rarely — same reasoning as `/static/districts.json` above, not the shell's must-revalidate treatment |
| `/api/*` | `private, no-store` | Never cached |

Two things Cloudflare does not do by default and that must be configured explicitly:

- **The tile file must be cached by a Cache Rule.** Cloudflare's default cache does not include `.pmtiles`. Without a rule matching `/tiles/*`, every range request reaches the Pi and the Phase 2 `cf-cache-status: HIT` check will never pass.
- **The tile filename carries a version segment** (`karlsruhe.2026-08.pmtiles`), because a 30-day immutable-ish cache on a stable filename makes regenerated tiles unreachable for a month. The current filename lives in `config.ts` and is referenced by both the Caddyfile and the client.

Range requests on the tile path are not an optimisation; they are mandatory. PMTiles works by fetching small byte ranges out of one large file — a server that ignores the `Range` header forces the client to download the whole extract on every map view, which defeats the point of the format. Whatever serves `/tiles/*` must answer `206 Partial Content` to a ranged request, and this is verified directly (Section 12, Phase 2 Definition of Done), not inferred from the serving library.

Which component sets the `Cache-Control` value in the table above depends on the deployment (Section 4.3). In the standalone two-container path, Caddy sets it when serving the file from disk, as the diagram in Section 4 shows. In the single-container deployment that actually runs on the Pi (v1.2.2), there is no Caddy in front of the API; the API sets `Cache-Control: public, max-age=2592000` itself on `/tiles/*` responses, the same way it already sets headers for hashed assets and `index.html` in `packages/api/src/app.ts`. The value is unchanged either way — only who applies it differs. The Cloudflare Cache Rule below is edge configuration and is required in both deployments regardless of which origin component sets the header.

Client-side: district polygons, grid metadata, and the bar catalogue are cached in IndexedDB with an ETag-based revalidation on app start.

### 4.2 Repository structure

```
TipsyTrails/
├── docker-compose.yml
├── pnpm-workspace.yaml
├── .env.example
├── .gitignore
├── README.md
├── SPEC.md                       # this document
├── LICENSE                       # code licence, see Section 13.3
├── DATA-LICENSE                  # ODbL notice for OSM-derived artefacts
├── CONTRIBUTING.md
├── CLAUDE.md                     # agent guardrails, see Section 0
├── caddy/Caddyfile
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

There are two deployment paths. The diagram in Section 4 and this repository's own `docker-compose.yml` / `caddy/Caddyfile` describe the standalone, two-container path — unaffected by anything below and correct for anyone self-hosting outside the Pi.

**The Pi path.** What follows comes from the platform's real files — `sites.conf`, `scripts/deploy.sh`, `docker-compose.yml` and `config/caddy/Caddyfile` — pasted verbatim from the running Pi by the repository owner on 2026-08-19. That is the provenance, and it is the whole of it. The platform repository (`AlexanderHultsch/PiMultiServiceServer`) has never been readable from any session working on this repository; every description of it before this one, v1.10's included, was assembled second-hand from a summary relayed through another chat, and several of its details were wrong. Those corrections are below and are listed in the v1.11 changelog. Where a question matters and the pasted files do not answer it, it is marked as open here rather than filled in.

**Registration takes three files, not one.** `sites.conf`'s own header is explicit about it: *"WICHTIG: Neue Zeile hier genuegt NICHT allein - der Dienst muss auch in docker-compose.yml und config/caddy/Caddyfile stehen"* — a new line in `sites.conf` alone is not enough; the service must also appear in the platform's `docker-compose.yml` and in `config/caddy/Caddyfile`. The Caddyfile's final rule is `handle { respond "Not found" 404 }`, so a hostname no block matches returns 404: without its Caddy block this site is unreachable from the outside even when its container is healthy and its compose service is correct. The three exact blocks are given below.

The platform's `~/pi-server/sites.conf` carries one line per site, four whitespace-separated fields — `name repo_url host admin`, no port field. `name` is both the directory under `apps/` and the service name in the platform's `docker-compose.yml`. `host` is a **subdomain label, not a hostname** — the file's own example is `winecashing` → `winecashing.<DOMAIN>`, with the literal `apex` reserved for the main domain itself — so this site's value is `tipsytrails`, never `tipsytrails.ahultsch.com`. `admin` is `yes|no`, where `yes` means the site takes the shared admin account and has `seed:admin` run against it. This app's line names it `tipsy-trails`, `host` `tipsytrails`, `admin` `yes`. `sites.conf` is maintained **only on the platform checkout's `env` branch** — its header says so, because it points at private repositories and does not belong on the generic `main` branch — and the Pi's checkout is on `env` today. As of 2026-08-19 this site is registered in all three files and running: the container is up, the root `Dockerfile` builds on the Pi's own arm64, migrations and startup complete, the server logs `Server listening at http://172.19.0.3:3000`, and the site answers from outside — `curl https://tipsytrails.ahultsch.com/api/health` returns `{"status":"ok"}` and a browser loads the PWA shell over that hostname. It took two deploys: the first crash-looped on `EACCES: permission denied, mkdir '/data/db'` against the root-owned data volume, which is exactly the failure the storage-ownership paragraph below describes and the root-then-`gosu` entrypoint resolves; the second, with that entrypoint in place, came up and stayed up. The map extract is still not on the volume, so `/tiles/*` answers with the error Section 13.2 specifies, and the admin account has not yet been confirmed by signing in.

Deployment is a local build, not a registry pull: the platform's own `docker-compose.yml` carries `build: ./apps/<name>` per site, and `deploy.sh` runs `docker compose up -d --build`. The `Dockerfile` this builds is the one at this repository's root — not `packages/api/Dockerfile` or `packages/web/Dockerfile`, which serve only the standalone path — and it must sit at the repository root for the platform to find it. `PORT` is not a `sites.conf` field: it is set per service in the platform's `docker-compose.yml` and matched by the Caddyfile's `reverse_proxy` target. Both of ginperium's blocks use `3000`, and the blocks below follow them.

**One deploy run is all-or-nothing, across every site.** `deploy.sh` accepts exactly two options — `--fresh` and `--set-password` — and exits 1 on anything else. There is no single-site mode: every run pulls, rebuilds and restarts every site in `sites.conf`, so this site cannot be deployed on its own. The build step, `docker compose up -d --build`, runs once for the whole compose file with no `||` guard under `set -euo pipefail` — so a failing image build, this site's included, aborts the entire run, every other site's rebuild and the closing `docker compose restart caddy` with it. The per-site `git pull --ff-only`, by contrast, only warns on failure (`WARN: pull fehlgeschlagen`) and then builds whatever is already on disk: a site branch that has diverged or been force-pushed deploys **stale code while the run reports success**.

**What `admin: yes` actually does.** `deploy.sh` writes `apps/tipsy-trails/.env` on every deploy, containing *exactly three* variables — `SESSION_SECRET`, `ADMIN_USER` (not `ADMIN_USERNAME`), `ADMIN_PASSWORD` — as a full overwrite (`>`) each time. Only `SESSION_SECRET` survives a redeploy: `deploy.sh` reads the value already in the file back out before overwriting it, and writes the same value back. `ADMIN_USER` and `ADMIN_PASSWORD` come from a single shared `~/pi-server/admin.env` — one credential pair reused across every `admin: yes` site on the Pi, written interactively on the first run and by `--set-password` thereafter. This is not a shared user store: nothing in `deploy.sh` does more than supply these three values — no user table, no hashing of its own. This app's `users` table (Section 5.3) and its argon2id hashing are entirely its own, untouched by the platform.

**Everything else is manual, and it persists — unlike the three values above.** `PUBLIC_ORIGIN` and any other variable this app needs is *not* written by `deploy.sh`; it must be added by hand to the platform's own `docker-compose.yml`, in this site's `environment:` block, the same place `PORT` and `DB_PATH` already live for the Pi's other sites. `deploy.sh` never touches `docker-compose.yml`, so values placed there survive every redeploy undisturbed. This app refuses to boot without `PUBLIC_ORIGIN` (`packages/api/src/env.ts`), and nothing on the platform side sets it, so the block must read:

```yaml
environment:
  PORT: "3000"
  DB_PATH: /data/db/tipsy.db
  PUBLIC_ORIGIN: https://tipsytrails.ahultsch.com
env_file: ./apps/tipsy-trails/.env
```

**The `env_file:` line is not optional, and it is easy to miss.** `deploy.sh` writes the three admin variables into `apps/tipsy-trails/.env` on the host, and nothing carries that file into the container unless the service block names it — the Pi's ginperium service does exactly this (`env_file: ./apps/ginperium/.env`, commented there as the secrets file that lives only on the Pi). Leave the line out and `SESSION_SECRET`, `ADMIN_USER` and `ADMIN_PASSWORD` never reach the process at all; `SESSION_SECRET` is required (`packages/api/src/env.ts`), so the container does not boot. Note also that the platform writes `environment:` in map syntax with the port quoted, as above, not list syntax.

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

**The seed script must exist, and if it fails it fails silently.** After bringing containers up, `deploy.sh` runs, for every `admin: yes` site, `docker compose exec -T "${name}" npm run seed:admin || echo "  WARN: seed:admin fehlgeschlagen"` — with `-T`, no TTY allocated, and with a `|| echo` that handles the failure so `set -e` never fires. A missing or failing `seed:admin` therefore does **not** abort the deploy: it prints that one warning line and the run continues to `docker compose restart caddy`. That is worse than a loud abort, not better. The site comes up, its pages load, and it has no working admin account — nothing marks the difference except a German warning in a log nobody may read. (What does abort every site's deploy is the preceding `docker compose up -d --build`, above.) `packages/api/package.json` must define this script, and it must be idempotent: this app already seeds the admin account at boot (`initialiseDatabase`, Section 13.4 — a no-op once a user with that username exists), so `seed:admin` has to be safe to run in addition to that on every single deploy, not a replacement for it. The form it takes is self-sufficient — it creates the database directory, runs the same migrations, then calls the same seeding insert, and exits 0 whether it seeded or found the account already there — because `docker compose up -d` returns before boot-time setup has finished, so the script cannot assume any of it happened; running those migrations alongside the booting server is safe because `runMigrations` takes the write lock before it decides what to apply, and because `openDatabase` retries the WAL journal-mode change — that pragma does not go through SQLite's busy handler, so two processes opening a brand-new database would otherwise collide there before any migration runs.

**Storage.** The data volume is `./data/tipsy-trails:/data` on the platform side — host `~/pi-server/data/tipsy-trails/`, container `/data`, created by Docker on first start. `DATABASE_PATH`/`DB_PATH` above (`/data/db/tipsy.db`) lives under it. So does the map extract: `TILES_DIR`'s existing default, `/data/tiles` (`packages/api/src/env.ts`), already resolves correctly under this layout with no configuration change — the extract belongs at host `~/pi-server/data/tipsy-trails/tiles/<filename>`.

**`deploy.sh --fresh` destroys that entire volume before rebuilding** — `sudo rm -rf data/tipsy-trails`. For a site on this Pi whose `/data` is a cache, that costs nothing. Here it is the database and the tile extract: every account, all fog progress, every mastered bar. There is no separate backup for it beyond whatever C7's existing Pi backup job already covers. `--fresh` against this site is data loss, not a reset.

**That volume belongs to root, so the container starts as root and drops privileges itself.** `~/pi-server/data/` is root-owned on the Pi — the owner cannot even `mkdir` inside it from his own shell — so Docker creates `data/tipsy-trails/` as root too, and a container running as `node` against it cannot create `/data/db` at all: `initialiseDatabase`'s `mkdirSync` fails with EACCES and the container restart-loops behind a 502. The root `Dockerfile` therefore does not end with `USER node`. It installs `gosu`, and `docker-entrypoint.sh` runs as root, creates the database directory (the dirname of `DATABASE_PATH`/`DB_PATH`) and `TILES_DIR`, `chown -R node:node /data` — which also rescues a `.pmtiles` extract copied in by hand as another user — and then `exec gosu node "$@"` so the server runs unprivileged as PID 1's successor and receives signals normally. This is the shape the platform's other two sites already use; they are Alpine images and reach for `su-exec` where this Debian one uses `gosu`. `packages/api/src/docker-image.test.ts` fails if any part of that arrangement is removed. The consequence for `docker compose exec tipsy-trails npm run seed:admin` above is that it does **not** run the entrypoint, so that command runs as root: harmless, because the server already holds the SQLite connection open and its WAL files exist by then, and self-healing regardless — the next boot chowns `/data` again.

**TLS.** Caddy terminates none; Cloudflare's edge does. The full chain is browser → Cloudflare edge → Cloudflare Tunnel → the `cloudflared` container → Caddy → this app's container. What the pasted `Caddyfile` excerpt covers is one site's `handle` block and the 404 fallback, nothing else — so it settles none of the file's global options. Whether `auto_https` is off, and whether `trusted_proxies` or a `header_up` override for `X-Forwarded-For` is configured, are open questions against this evidence; earlier versions of this section asserted all three, on second-hand information. That bears directly on Section 9.4's `trustProxy` setting, which stays recorded as unverified rather than settled (Open Item O10, Section 14).

Multi-stage Dockerfiles throughout — this repository's root `Dockerfile` included; the frontend build stage runs on the Pi (arm64) either way.

**Tile serving.** The extract is not in the image — Section 13.1 forbids committing it, and a regenerated extract must not require rebuilding the image either. The platform mounts a persistent data volume for the container, the same one `DATABASE_PATH` lives under, so the extract lives there too, under a directory named by the `TILES_DIR` environment variable (default `/data/tiles`, mirroring the `/data/db/tipsy.db` default for `DATABASE_PATH` in `packages/api/src/env.ts`). The path the API reads is `${TILES_DIR}/${CONFIG.TILES_FILENAME}`. In the single-container deployment the API serves `/tiles/*` from that path itself, including range-request support (Section 4.1); in the standalone two-container path, Caddy serves it from the same mounted location per `caddy/Caddyfile`, unchanged. Startup and missing-file behaviour differ between the two deployments — see Section 13.2.

A Vite + MapLibre build on a 4 GB Pi is close to the memory ceiling. The web Dockerfile sets `NODE_OPTIONS=--max-old-space-size=1536` in the build stage, and the README documents that at least 2 GB of swap must be configured on the Pi. If build time exceeds ~5 minutes, the documented upgrade path is GitHub Actions building an arm64 image to GHCR and the Pi pulling the image instead. Do not implement this in v1.

---

## 5. Data Model

SQLite. All timestamps and durations are Unix epoch **seconds** (INTEGER, UTC) — see rule 6 in Section 0. All migrations are plain numbered `.sql` files applied in order at container start, tracked in a `schema_migrations` table so reruns are no-ops.

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
  age_confirmed_at     INTEGER NOT NULL,
  created_at           INTEGER NOT NULL,
  last_seen_at         INTEGER
);
```

No email address is collected. Username constraints: 3–20 characters, `[a-zA-Z0-9_-]`, case-insensitively unique.

`must_change_password` gates an account until it sets a new password: while it is set, every endpoint except `/api/auth/me`, `/api/auth/change-password`, and `/api/auth/logout` returns 403 with a machine-readable `code: "password_change_required"`, and the client routes to the change-password screen.

**The seeded admin does not carry it** (`must_change_password = 0`, Section 13.4), and that is deliberate rather than an oversight. The forced change exists to stop a deployment shipping with a credential its operator never chose — a default baked into an image or a repository. The Pi platform's admin credential is the opposite of that: `deploy.sh` asks the operator for it interactively on first run, stores it `0600` in `~/pi-server/admin.env`, and rewrites it into every `admin: yes` site's `.env` on every deploy (Section 4.3). Forcing a per-site change would invalidate the one credential the platform manages, the moment it is first used, and leave the operator tracking a second password the platform knows nothing about. The gate itself stays in place for any account that legitimately carries the flag; only the seeder no longer sets it.

A consequence worth stating plainly: because `seedAdmin` skips an account that already exists and never overwrites a password changed since (Section 13.4), an admin who changes this password inside the app takes it out of the platform's hands permanently — `admin.env` and `deploy.sh --set-password` stop reaching it.

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

**VAPID key material lives on disk, not in the environment.** Section 4.3 is why: the Pi's `deploy.sh` fully overwrites `apps/tipsy-trails/.env` on every deploy and preserves only `SESSION_SECRET` across that overwrite, so a key pair placed there the way `SESSION_SECRET` is would survive exactly one deploy and then silently stop working — push would go dark with no error, since the subscriptions themselves are untouched and only sending against them would start failing. On first boot, if no key file exists, the app generates a VAPID key pair and writes it to `CONFIG.VAPID_KEY_FILENAME` (Section 7.1) in the same directory as `DATABASE_PATH` — already on the persistent data volume in both deployments (Section 4.3). Every later boot loads that file instead of generating a new one. The subject the Web Push protocol requires is not generated; it is derived from `PUBLIC_ORIGIN`, already a mandatory `https:` URL (Section 4.3), so no separate value needs provisioning. Only `--fresh` destroys the key file, and `--fresh` already destroys the database it sits beside.

The three `VAPID_*` environment variables (`packages/api/src/env.ts`) are not removed — they remain supported as an explicit override, all three or none, exactly as `resolveVapidConfig` already treats them (a partial set stays a misconfiguration, warned about at boot). When all three are set, they win over both the persisted file and generation, so a deployment that wants to pin its own key keeps that option — most useful for local development or a fork with no persistent volume to write to. When none are set, the app loads or generates the file as above. On the Pi itself the override should be left unset: `deploy.sh` never writes these three (its `admin: yes` block is exactly `SESSION_SECRET`, `ADMIN_USER`, `ADMIN_PASSWORD`, nothing else), so there is nothing here for it to wipe, and generation exists specifically to remove the manual key-provisioning step this platform cannot support.

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

All of these live in `packages/shared/src/config.ts`.

```ts
export const CONFIG = {
  FOG_REVEAL_RADIUS_M: 100,
  FOG_MAX_SPEED_KMH: 30,          // above this, no reveal
  FOG_MAX_ACCURACY_M: 200,        // samples worse than this are discarded entirely

  BAR_DISCOVERY_RADIUS_M: 100,
  BAR_ONSITE_RADIUS_M: 50,
  BAR_ACCURACY_TOLERANCE_M: 50,   // added to on-site radius, capped by accuracy

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

  LEADERBOARD_PAGE_SIZE: 50,
  MAINTENANCE_INTERVAL_MS: 60 * 1000,  // see 7.9
  BADGE_EVAL_INTERVAL_MS: 60 * 60 * 1000,  // see 7.9

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

  TILES_FILENAME: 'karlsruhe.2026-08.pmtiles',
  VAPID_KEY_FILENAME: 'vapid-keys.json',  // generated on first boot, persisted beside DATABASE_PATH — see 5.9
} as const;

// The single ms→s boundary required by rule 6 in Section 0.
export const DERIVED = {
  VISIT_REQUIRED_S: CONFIG.VISIT_REQUIRED_MS / 1000,
  VISIT_EXPIRY_S:   CONFIG.VISIT_EXPIRY_MS / 1000,
  VISIT_PUSH_AFTER_S: CONFIG.VISIT_PUSH_AFTER_MS / 1000,
  SESSION_TTL_S:    CONFIG.SESSION_TTL_DAYS * 86400,
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

### 7.3 Fog of war

**Reveal rule.** For each accepted sample where speed < `FOG_MAX_SPEED_KMH`, reveal every cell whose centre lies within `FOG_REVEAL_RADIUS_M` of the position (~13 cells at 50 m). Revealed cells are permanent. Speed is taken from the Geolocation API where available, otherwise derived from the previous accepted sample; if neither is available (first sample after restart), the sample reveals.

Every newly set bit increments `fog_state.revealed_cells`, the matching `fog_district_progress` row if the cell belongs to a district, and the `fog_daily_progress` row for the current Europe/Berlin day. All three updates happen in one transaction with the mask write.

**Rendering.** A MapLibre custom layer draws the fog as a single full-screen quad. The fog mask is uploaded to the GPU as a texture (one texel per grid cell, `R8` format, ~140 KiB for Karlsruhe) and sampled in the fragment shader. Reveals update the texture via `texSubImage2D` on the affected region only.

**"Full-screen" means the camera's screen, and it is rebuilt every frame.** The quad spans the current viewport plus `FOG_VIEWPORT_PADDING_RATIO` on each axis, taken from the map's own bounds, which already account for bearing and pitch. It must not be a fixed rectangle derived from the city's extent: the map's pan limit constrains an *axis-aligned* viewport, so the moment the camera is rotated the viewport's corners sweep outside it, and where there is no quad there is no geometry and therefore no fog — bare, un-fogged ground in the corners of a turned map. That padding ratio is deliberately a separate constant from `MAP_BOUNDS_PADDING_RATIO`: sharing one number between the pan limit and the fog quad is exactly what produced the defect. Four vertices a frame is not a cost worth optimising away.

Visual behaviour:
- Unrevealed: opaque grey fog, at `FOG_MAX_OPACITY` alpha, dense enough that it hides detail rather than tinting it. The fog is inserted into the style at one fixed point in the layer order: **beneath** it, in order, sit the paper background, green landcover, parks, building fills, building outlines and the minor-road layer; **above** it sit water fill, water outline, waterways, and both major-road layers. So a player on unrevealed ground sees roads and water and nothing else — buildings, green areas and parks are hidden by the fog, deliberately. This widens the earlier rule, under which only the motorway/trunk layer stayed above the fog and water was dimmed away with everything else: orientation in unexplored ground is carried better by the water and the ordinary street grid than by the trunk network alone, and the fog still gets to do its job on everything that describes what a place is actually like.
- Revealed: fog alpha 0. **The edge is a boundary, not a fade.** It is irregular but crisp: a low-frequency noise offset displaces the sampling position so the edge never reads as a circle around the player or as a staircase of 50 m squares, and a narrow blur plus a tight alpha band around its midpoint keep the transition itself down to a fraction of a cell. The two numbers are `FOG_EDGE_BLUR_RADIUS_CELLS` and `FOG_EDGE_ALPHA_HALF_WIDTH`, and they are not independent: blurring a binary mask leaves the blurred value linear in distance from the boundary with slope `1 / (2r + 1)` per cell, so the visible transition is exactly `2 · (2r + 1) · h` cells wide. That relationship is recorded here so the next person tuning it does not have to re-derive it, and so that a change to either constant is understood as a change to one width rather than to two knobs. This edge is not decoration. It is the only feedback that the reveal mechanic works at all — an earlier version faded over roughly 190 m, which read as no boundary, and a player who cannot see ground being unlocked cannot see the game working.
- Newly revealed cells animate from opaque to clear over 600 ms.
- Buildings, green areas, parks and minor roads are only rendered where revealed. Water and the major roads are drawn everywhere, above the fog.

**Minor roads exist, and they stay under the fog.** Residential and tertiary streets are drawn as their own layer, quieter than the major roads and appearing only at closer zooms, so explored ground shows the street pattern a walker actually recognises rather than the trunk network alone. They belong *below* the fog, and the reason is the whole point of the ordering above: put them above it and unrevealed ground gains the full street grid, which is precisely the detail the fog exists to withhold. Under the fog they are a reward for having been somewhere. This is also why they are a separate layer rather than a widened filter on `road-primary` — one filter cannot be on two sides of the fog at once.

**Major roads carry no extra weight.** `road-highway` used to be drawn heavier and more opaque than `road-primary`, which was defensible while it was the only road above the fog and had to carry orientation on its own. It no longer is, and the contrast the ordinary roads already have is enough for the major ones too: both road layers take the same colour, the same opacity, and the same width ramp. The hierarchy does not disappear — it moves from stroke weight to visibility threshold. `road-highway` appears from zoom 4 and `road-primary` only from zoom 8, so a zoomed-out map still shows the trunk network alone, and the distinction between the two appears at the zoom where it is useful instead of as a permanent difference in ink.

**A layer above the fog cannot tell revealed ground from unrevealed ground.** It renders identically on both, and that is the subtle cost of this ordering, worth stating plainly because it is easy to discover only on the street. The road intensity that reads well today was only ever seen on revealed ground — beneath the fog those roads were dimmed to nothing — so moving them above puts that same intensity onto unexplored ground, where it may read as too loud, and where it flattens the very distinction the fog exists to draw. The specification's answer is that roads above the fog carry a deliberately reduced opacity: enough to read through the fog without dominating it, with the revealed-versus-unrevealed contrast carried by the buildings, the green areas and the fog tone rather than by the roads. The exact value is a judgement to be made looking at the real map on a real device; this document fixes the requirement, not the number.

If one value turns out not to serve both states — quiet enough over fog, present enough on revealed ground — the named remedy is two copies of the road layers: a quiet one above the fog and a fuller one below it, so revealed ground gets both drawn over each other and fogged ground only the quiet one. That is the fallback, not the plan. It doubles the road geometry drawn per frame and gives the style two sets of paint properties to keep in step, so it is worth its cost only once a single opacity has demonstrably failed.

**Fallback.** If WebGL2 is unavailable, fall back to a 2D canvas overlay redrawn on `moveend` only. Detect and log this; do not attempt feature parity on animation.

### 7.4 Bar discovery

When an accepted sample lands within `BAR_DISCOVERY_RADIUS_M` of an active bar, a `bar_discoveries` row is created. Discovery is permanent and independent of fog state — a discovered bar stays visible even if it sits in an area the player never fully revealed.

Undiscovered bars are never sent to the client. The client receives only discovered bars. The API must never leak undiscovered bar positions, including through aggregate endpoints such as counts per district.

This applies to error codes as well: `GET /api/bars/:id` returns the same response for an undiscovered bar and for a bar that does not exist. See Section 9.5.

### 7.5 Check-in and mastering

Bars sit close together in Karlsruhe's centre and GPS alone cannot distinguish neighbours, so **check-in is an explicit user action**.

**Flow:**

1. **A check-in starts at the bar's marker on the map, and nowhere else.** Tapping a discovered bar's marker leads to that bar, where a check-in action is offered and is enabled only while the player is within `BAR_ONSITE_RADIUS_M + min(accuracy, BAR_ACCURACY_TOLERANCE_M)` of it. This is what makes two bars next door to each other separable: the player names the one they mean by pointing at it, instead of accepting a suggestion the app derived from a position that cannot tell the two apart. The nearby panel on the map screen stays and stops being a control — it names the bars currently in range, sorted by distance, and tells the player to tap one on the map. It carries no button and performs no check-in.

  **"Leads to that bar" means a sheet on the map screen, not the `/bars/:id` route**, and the reason is worth recording because the wording invites the opposite reading. Position tracking runs in exactly one place — the map screen — so navigating away to a separate route unmounts it: fog reveal and sample posting stop, and the screen that is supposed to judge on-site eligibility has no live position to judge it against. Powering a check-in there would mean lifting tracking into a shared provider, a real change to the sample pipeline, bought for nothing the player can see. A sheet on the map keeps tracking alive and still has the player name the bar they mean by pointing at it, which is the whole property this step exists for. `/bars/:id` keeps its job as the linkable detail page and deliberately carries no check-in action.

  The sheet's action is **disabled rather than hidden** when it cannot be used, with a sentence saying why: a control that vanishes is harder to understand than one that is visibly inert, which is the same argument the "to my location" control already rests on. It always names the bar it would check into, so a bare "Check in" can never float over a map with two bars a few metres apart on it. A bar that already has a pending visit offers no second check-in, and says so rather than making a request whose answer (Section 5.7) is the visit already open — and it says that *before* any out-of-range wording, since a player standing in the bar they are checked into is on site and "too far away" would be a plain lie.

2. `POST /api/visits` creates a `pending` visit with `started_at = now`, `last_sample_at = now`, `onsite_samples = 1`. The server re-validates proximity using the caller's last accepted sample; a check-in without a recent on-site sample is rejected with 422.
3. Every subsequent accepted sample within the on-site radius of that bar updates `last_sample_at`, increments `onsite_samples`, and recomputes `confirmed_s = last_sample_at - started_at`.
4. When `confirmed_s >= VISIT_REQUIRED_S` **and** `onsite_samples >= VISIT_MIN_ONSITE_SAMPLES`, the visit becomes `completed`, `completed_at = now`, and the bar is mastered.
5. If no on-site sample arrives for `VISIT_EXPIRY_S`, the visit becomes `expired`. Expiry is never punitive — the user can simply check in again.

Because completion needs only *two* valid samples 20 minutes apart, the app does not have to stay open. Opening it on arrival and again before leaving is sufficient.

**A pending visit can be cancelled.** Step 5 is not the only way out of a pending visit. A player who checked in at the wrong bar, or by accident, must be able to end it there and then rather than carry it around for hours until the inactivity expiry catches it. A cancel endpoint under `/api/visits` (Section 9.2) acts only on the caller's own pending visit and moves it to `cancelled` (Section 5.7); it is the caller's decision alone, so nothing else — no sample, no maintenance tick — ever produces that state. The pending-visit banner carries the control that calls it, behind a confirmation, because cancelling throws away whatever confirmed time the visit has accumulated and there is no route back to it. Cancelling has nothing to do with expiry: `VISIT_EXPIRY_MS` keeps its value, its behaviour and its description exactly as step 5 states them.

**Accepted trade-off.** A player who checks in, leaves, and returns 20 minutes later completes the visit without having stayed. This is inherent to a two-sample model and is accepted: the mechanic is a social prompt, not an audit. Do not add continuous-presence enforcement in v1 — it would require either background tracking (impossible, Section 7.2) or punishing users whose phone slept. See O9.

**Transparency requirements — these are product requirements, not suggestions.** The mechanic must be legible at every moment:
- An active pending visit is shown persistently at the top of the screen: bar name, confirmed time, remaining time. **The confirmed figure is the server's `confirmed_s` for that visit** — the elapsed time between check-in and the most recent accepted on-site sample, as Section 5.7 defines it — and the remaining time is derived from it as `VISIT_REQUIRED_S - confirmed_s`, floored at zero. It is not the wall-clock time since check-in. The two agree only while the player is standing at the bar with the app open, and diverge the moment they walk away, at which point the wall clock asserts a presence that never happened: a visit checked into two hours ago and abandoned reads as two hours confirmed with nothing remaining — a banner claiming a complete visit that cannot complete.

  This does not mean a banner frozen at check-in. `confirmed_s` is recomputed on every accepted on-site sample (step 3 above), so while the player is at the bar with the app open the figure keeps advancing on its own — it *steps* forward once per accepted sample rather than ticking once per second, and the remaining time steps down with it. What it must not do is advance between samples, or advance at all once the player is out of range: the last confirmed value is where it stops, and it stays there until either a new on-site sample moves it or the visit ends. A frozen banner while the player is standing in the bar is the same defect in the other direction, and a client-side timer is not the way to avoid it — the fix is to reflect the server's figure as it changes, not to interpolate between the values the server has actually confirmed.
- Explicit wording of what is needed, matching the state the visit is actually in. On site: *"Open Tipsy Trails again while you're still here to complete this visit."* Away from the bar, the instruction is the opposite one — return to the bar and open the app there to finish — and the on-site wording is replaced by it rather than shown alongside it. A banner that says a player has moved away and, directly beneath, tells them to stay where they are is not guidance; it is two sentences that cannot both be true.
- A Web Push notification at `VISIT_PUSH_AFTER_MS`, dispatched by the maintenance job (Section 7.9) and recorded in `push_sent_at` so it fires at most once per visit, and only while the visit is still `pending`.
- If a sample arrives out of range, show *"You've moved away from {bar} — your visit is still pending"* rather than silently failing, and switch that visit's guidance to the return-to-finish wording of the bullet above.
- A short "How mastering works" explainer is reachable from the burger menu and shown once after the first check-in. "Shown once" is client-side state in `localStorage`; no server column for it.

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

The threshold is **never shown to users and no endpoint returns it**. Neither is any rank or standing: not "you are 2nd", not "0.3% to go". The profile shows a player their own value for the running period and nothing else, so the only thing a player can read off the game is what they themselves did.

**Awarding.** Candidates for a period are the users whose value is **greater than or equal to** the threshold for that period. If there are none, the badge is not awarded at all. Otherwise the badge goes to the candidate with the highest value, and to **every candidate tied at that highest value** — a tie awards all of them rather than being broken. (Section 7.8's "earliest achievement" tie-break orders the leaderboard and has no part in deciding a badge.) Badges already awarded are a permanent record of the periods a player won and are never revoked. Evaluation runs as a scheduled job shortly after each period closes (weekly Monday 04:00, monthly 1st 04:00, yearly Jan 1st 04:00, Europe/Berlin), and badges are written to the `badges` table.

The job is idempotent through the `UNIQUE (user_id, kind, period, period_key)` constraint plus `INSERT ... ON CONFLICT DO NOTHING`. It takes the period key as an optional argument so a missed period can be re-run by hand.

The player's own value for the running period is shown on the profile, per kind and period, computed from the same `fog_daily_progress` sums. It is a plain reading of what they have done — no bar, no target, no percentage of a target, no rank.

Badges are prominent and public: rendered on the profile as a badge shelf, and as compact icons inline in leaderboard rows. Anonymous users' badges are shown against their anonymous handle.

### 7.8 Leaderboard

Public, ranked by two switchable metrics: area explored (%) and bars mastered. All-time by default, with week/month filters.

- All-time area comes from `fog_state.revealed_cells`; week/month area comes from `fog_daily_progress`.
- All-time bars is the count of distinct mastered bars; week/month bars uses the earliest-completion rule from Section 7.7.

Ties are broken by earliest achievement, then by `users.id`, so ordering is stable across requests. Paged at `LEADERBOARD_PAGE_SIZE`.

Users with `is_anonymous = 1` appear as `Player #{id}` with a neutral avatar. They remain ranked and their statistics are still recorded — only the display identity is masked. The setting is toggleable at any time and takes effect immediately.

### 7.9 Scheduled work

Everything periodic runs inside the API process — no cron container, no external scheduler.

**Maintenance tick**, every `MAINTENANCE_INTERVAL_MS`:
- Expire pending visits whose `last_sample_at` is older than `VISIT_EXPIRY_S`.
- Dispatch the 21-minute reminder push for pending visits where `now - started_at >= VISIT_PUSH_AFTER_S` and `push_sent_at IS NULL`.
- Purge sessions past `expires_at`.

Because the tick is cheap and idempotent, a missed tick after a restart is self-healing. Pending-visit status is additionally evaluated lazily on read, so `GET /api/visits/pending` never returns a visit that should already have expired even if the tick has not run.

**Badge evaluation**, at the period boundaries in Section 7.7. On boot the job checks whether the most recently closed period of each kind has been evaluated and runs it if not, so a Pi that was off at 04:00 still awards badges.

---

## 8. Design and User Interface

### 8.1 Visual direction

A hand-drawn ink map. Desaturated, slightly warm paper ground. Lines read as if drawn with a pen or brush rather than as clean vectors — subtle weight variation and imperfect edges. Roads are rendered as fine black lines: the major ones everywhere, the minor streets only on ground the player has explored. Water and green areas are rendered as loose hatching and stipple textures rather than filled colour. Symbols are solid black pictograms with no gradients, shadows, or outlines. Unexplored terrain sits beneath a milky grey fog with a crisp but irregular edge, dense enough to hide detail; the major roads and the water stay legible there, and they do so by being drawn above the fog rather than showing through it, while buildings, green areas, parks and the minor streets are hidden beneath it (Section 7.3). This section said "only major roads" until v1.16, when the minor streets were added below the fog; Section 7.3 is the later and more specific decision, and this sentence is corrected to agree with it rather than left to be read alone and acted on. One accent colour is permitted across the entire application: a muted red, reserved for the player's own position and for active states, exactly as before. Beside it, and only there, a small named set of status colours is permitted — used by the three status icons of Section 8.6 and by nothing else in the application, and never as an accent. This is a deliberate narrowing of a rule this specification set, and the reason is worth recording: the status indicator's icons keep a fixed shape by decision, so colour is the only channel left to them, and one accent cannot express three states of three different things. The narrowing is bounded on purpose — one accent, one indicator, a fixed and named set of colours — so the restraint the rest of this direction rests on survives it. The overall impression is quiet, near-monochrome, and generous with empty space.

This direction applies to the whole application, not only the map. Chrome, typography, and controls follow the same restraint.

**Restraint does not override legibility.** A near-monochrome palette makes it easy to land below WCAG AA contrast without noticing. Body text and interactive labels meet 4.5:1 against their background, large text and icons 3:1. The accent red is never the only carrier of meaning — active states also change shape, weight, or label. The status icons of Section 8.6 are the single exception to that sentence, admitted by the same decision that narrowed the palette above, and they pay for it under their own rule: their colours must separate in luminance, not only in hue (Section 8.6). This is checked in Phase 8.

### 8.2 Typography and layout

- One serif family for headings and map labels, one neutral sans for UI text. Both self-hosted, subset to Latin, `font-display: swap`.
- Minimum tap target 44 × 44 px. Bottom-anchored primary actions (thumb reach).
- Respect `prefers-reduced-motion`: disable the fog dissolve animation and all transitions.

### 8.3 Screens

| Screen | Content |
|---|---|
| Landing | Name, one-line pitch, Sign in / Register |
| Register | Username, password, security question, security answer, 18+ checkbox |
| Login | Username, password, "Forgot password?" |
| Password reset | Username → security question → answer → new password |
| Change password | Forced when `must_change_password` is set; also reachable from Settings |
| City overview | Karlsruhe outline with overall progress; neighbouring municipalities drawn greyed out and non-interactive |
| District overview | All districts with individual progress percentages; tap to zoom in |
| Map (main) | Fog map, own position and direction of travel, discovered bar markers (tapping one opens that bar's sheet **on this screen**, carrying the check-in action — 7.5), pending-visit banner, nearby-bars panel (names the bars in range, carries no check-in — 7.5), GPS/connection/tracking icons |
| Bar detail (`/bars/:id`) | Name, address, district, mastered status, community tag if applicable. The linkable page for a bar; it carries **no** check-in action, and 7.5 explains why |
| Profile | Username, avatar, badge shelf, area %, bars mastered, this period's own totals (no target, no rank — Section 7.7) |
| Leaderboard | Ranked list, metric toggle, period filter |
| Suggest a bar | Map picker + name + address |
| Settings | Anonymous toggle, push permission, change password, how-it-works, privacy, delete account, logout |
| Privacy | Static page at `/privacy`, see 10.3 |
| Admin (admins only) | Bar management, community bar moderation, user list |

**Direction of travel.** The own-position marker carries a cone showing which way the player is heading whenever the GPS reports a course. It is the *course* — the direction of movement the Geolocation API derives from successive fixes — and not the direction the phone is pointed; no compass is read and no device-orientation permission is asked for. The Geolocation API reports no course while the device is stationary, so the cone is simply absent then: nothing is shown rather than a stale or northward guess, the same rule the marker itself follows before the first fix. The course is display-only — it never reaches the server (constraint C4, Section 10.2). The map is rotatable, so the cone is drawn at the course minus the map's bearing.

**No map overlay may obscure another.** The map screen carries eight overlays anchored to its edges — burger menu, tracking icons, locate button, pending-visit banner, nearby-bars panel, notices, toasts, attribution — each positioned independently against the map container, and a control anchored to an edge must yield to any bar occupying that same edge: the locate button clears the panel along the bottom, the tracking icons clear the banner along the top, and each does so whether or not the bar it yields to is currently present. The requirement is the rule, not the two fixes. Correcting today's two collisions individually leaves eight hand-tuned offsets that agree by coincidence, and the ninth overlay breaks them again — what the screen needs is a layout for its edges that positions the overlays relative to each other, so that adding one cannot put it on top of another.

**The map opens at street level.** The opening view is zoom **16** — a few blocks across, the scale at which a bar marker, the player's own position, and the 50 m grain of the fog are all legible and a player can act on what they see. It opened at zoom 12 before, a city overview: a whole city of fog with nothing in it to walk towards. The city as a whole already has a screen of its own (City overview, above), so the map does not have to be one too. Zooming out to `MAP_MIN_ZOOM` stays available and is unchanged. Like the zoom limits it sits beside, the opening zoom is a constant in `packages/shared/src/config.ts` and never a number at the call site (Section 0, rule 3).

**"To my location" sets that same zoom, it does not merely centre.** Recentring while keeping whatever zoom the map happened to be on answers the wrong question: a player zoomed far out taps it and gets their position in the middle of a city-wide view they still cannot walk from. The control takes them to `MAP_DEFAULT_ZOOM` as well as to their position — one constant for the opening view and for this, because both answer "show me where I am, close enough to walk from", and two numbers meaning the same thing drift apart. The map picker on Suggest a bar is the deliberate exception: its identical-looking control centres without changing zoom, because a player who has zoomed in to place a pin precisely would lose exactly the precision they zoomed in for. Two controls that look the same behaving differently is a cost, taken knowingly and recorded here rather than discovered later as an inconsistency.

### 8.4 Navigation

A single burger menu, top right, on every authenticated screen. Contents: Map, Districts, Leaderboard, Profile, Suggest a bar, Settings, Admin (admins only), Log out. No bottom tab bar, no other persistent chrome — the map should own the screen.

### 8.5 Avatars

Deterministic, generated locally from `avatar_seed` (assigned at registration). A schematic geometric mark in black on paper ground, in the style of the map symbols. Not customisable. No image files, no uploads — rendered as inline SVG.

### 8.6 GPS and connection quality indicator

Three icons on the map screen, always visible: GPS, connection, and tracking. **Their shape never changes** — the GPS icon is the same mark whatever the GPS is doing — and the state is carried by colour alone, from the small named set Section 8.1 permits for this indicator and nothing else. They replace the text indicator with three labelled states this section used to specify; the states themselves are unchanged:

- **GPS:** three states derived from the last accepted sample's accuracy — good (≤ `GPS_ACCURACY_GOOD_M`), fair (≤ `GPS_ACCURACY_FAIR_M`), poor (worse, or no fix for `GPS_STALE_MS`).
- **Connection:** online / offline / syncing, based on `navigator.onLine` plus the queue depth of unsent samples.
- **Foreground tracking:** whether position tracking is currently running, with a plain-language note that tracking pauses when the app is not in the foreground.

Tapping the indicator opens the same short explanation of each state as before. That explanation is where the words live, so an icon-only indicator is still readable by someone who does not know what a colour means.

**Colour-only state has an accessibility cost, and the mitigation is a requirement.** WCAG 2.1 SC 1.4.1 is about colour not being the only *visual* means of conveying information, so an `aria-label` does not discharge it: it serves a screen-reader user and does nothing whatsoever for a sighted colour-blind one. The shapes are fixed by decision, which removes the usual mitigation, so the one that remains is luminance. **The status colours must differ in luminance as well as in hue**, far enough apart that the states stay distinguishable under colour blindness and in a greyscale rendering of the screen — verified by converting the rendered icons to greyscale, not by judging the hues by eye. The specific values are a later decision and are deliberately not fixed here; the constraint on them is.

**The deferred decision, taken (v1.15).** The bounds are: each of the three clears 3:1 against its own background — not only the paper ground but the indicator's translucent button composited over the fogged ground the fog produces, which is the darker and therefore binding case — adjacent states clear 2.2:1 against each other, and the two extremes clear 4:1. Luminance runs in the direction of severity, `ok` lightest and `bad` darkest, so that a greyscale or colour-blind reader recovers the *ordering* of the three states and not merely the fact that they differ. The values themselves live in `packages/web/src/index.css` as `--color-status-ok` / `--color-status-degraded` / `--color-status-bad`, with the whole of the above asserted from those tokens in `packages/web/src/App.a11y.test.tsx`, so a badly chosen replacement fails the suite rather than the eye.

Two consequences of that arithmetic are worth recording, because they look like mistakes and are not. First, **the darkest status colour is darker than the ink the rest of the map is drawn in**, and it has to be: the 3:1 rule caps the lightest of the three at a relative luminance of about 0.24, and two 2.2:1 steps down from a cap that low land below ink. Second, and following from it, **at that luminance hue is nearly imperceptible** — the `bad` colour reads as black however it is specified, so the hue requirement above is satisfied numerically but does almost no perceptual work at the bottom of the scale. The separation there is carried by luminance alone. That is the honest cost of fixing the shapes and excluding the accent's red from the set; it is not a reason to reopen either decision, but it is the first thing to revisit if the indicator turns out to be hard to read on the street.

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
| GET | `/api/health` | `{"status":"ok"}` — unauthenticated, used by Phase 0 and by Docker's healthcheck |
| GET | `/api/city` | Active city metadata + grid parameters |
| GET | `/api/fog` | Raw fog mask (`application/octet-stream`) + per-district revealed counts; Caddy applies the transport encoding |
| POST | `/api/samples` | `{ samples: Sample[] }` → `{ newCells, newBars, visitUpdates }` |
| GET | `/api/bars` | Discovered bars only |
| GET | `/api/bars/:id` | Bar detail — see 9.5 |
| POST | `/api/bars/suggest` | `{ name, address, lat, lon }` |
| GET | `/api/visits/pending` | Active pending visits |
| POST | `/api/visits` | `{ barId }` → creates or returns the pending visit |
| POST | `/api/visits/:id/cancel` | Ends the caller's own pending visit, moving it to `cancelled` (Sections 5.7, 7.5). Reaches nothing but a pending visit belonging to the caller. Not a `DELETE`: the row survives as a cancelled record. The visit is named by id because a player may hold several pending visits at once |
| GET | `/api/progress` | City + per-district progress, bars mastered |
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

| Method | Path | Notes |
|---|---|---|
| GET | `/api/admin/bars` | All bars including hidden, filterable by source |
| PATCH | `/api/admin/bars/:id` | Edit name, address, position, status |
| DELETE | `/api/admin/bars/:id` | Delete (cascades discoveries and visits) |
| POST | `/api/admin/bars` | Create bar directly |
| GET | `/api/admin/users` | User list with stats |

Editing a bar's position recomputes `cell_index` and `district_id`. Existing discoveries are not revoked.

### 9.4 Rate limits

Per the `RATE_LIMITS` block in Section 7.1, enforced with an in-memory token bucket. Exceeding returns 429 with a `Retry-After` header.

**The client IP must be taken from the trusted proxy header, not the socket.** Behind Cloudflare Tunnel every request reaches the API from `cloudflared`, so socket-based limiting would put all users in one bucket and make the per-IP limits meaningless. The Caddy instance immediately in front of the API sets `X-Forwarded-For` — this repository's own in the standalone two-container path, the platform's own single Caddy instance in front of the single container that runs on the Pi (Section 4.3, v1.2.2). For the standalone path that Caddy is the only proxy between the client and the API, so `trustProxy: 1` — trusting exactly one hop — is correct there.

**For the Pi path the hop count is not settled, and this app currently trusts `trustProxy: 1` without having verified it.** The chain in front of the API is longer than Caddy alone — browser → Cloudflare edge → Cloudflare Tunnel → the `cloudflared` container → Caddy — and how many of those hops actually append an entry to `X-Forwarded-For` cannot be determined by reading either repository. Nor is that the whole of it: Section 4.3 leaves open whether the platform's Caddy configures `trusted_proxies` or a `header_up` override of its own, so a last hop that may rewrite the list stacks on top of a chain whose length is already unknown. Cloudflare's edge almost certainly adds the real client IP; `cloudflared` may add another before handing off to Caddy. `X-Forwarded-For` is a comma-separated list the client can pre-seed with arbitrary entries, so this is not a detail: only the right-most hop is guaranteed to have been appended by infrastructure under our control, and trusting the wrong number of hops either exposes the list to client-supplied fabrication (too many trusted) or reads a proxy's own address as the client's (too few) — either way, per-IP buckets stop being per-IP with no visible failure. Trusting the left-most entry outright, what `trustProxy: true` does, is wrong either way and would let any client mint a fresh bucket per request.

Getting this right on the Pi is unverified, not assumed correct: log the raw `X-Forwarded-For` header once, from a real request made over the public internet — not from the Pi itself, not from the local network — and count the entries; set `trustProxy` to that count. That measurement is the first step and no longer the whole of it: if the platform's Caddy sets a `header_up` override or a trust list nobody has read, the right value can differ from what counting entries suggests, so the platform `Caddyfile`'s global options have to be read too before `trustProxy` is called settled. Until both are done, Section 13.4's "rate limits are load-bearing" is unverified for the Pi deployment, whatever Phase 1's Definition of Done already confirmed about the mechanism itself. Recorded as Open Item O10 (Section 14).

Buckets are in memory and reset on restart — acceptable at this scale, and stated here so nobody mistakes it for a durability bug.

### 9.5 Responses that must not leak

| Endpoint | Rule |
|---|---|
| `GET /api/bars/:id` | Identical 404 for "does not exist" and "not discovered by you". A 403 confirms existence and defeats Section 7.4. |
| `GET /api/auth/reset/question` | Always 200 with a question. For an unknown username, return a deterministic decoy derived from an HMAC of the username under the server secret, so the response is stable across attempts and indistinguishable from a real one. Rate-limited per username and per IP. |
| `POST /api/auth/login`, `POST /api/auth/reset` | One generic failure message; never distinguish unknown username from wrong password or wrong answer. |
| `GET /api/profile/:handle` | Accepts a username or a `player-{id}` handle. If the user is anonymous, the username form returns 404 and only the handle form resolves, masked. |
| Any error | No stack traces, no SQL text, no internal identifiers. A stable `code` string plus a human message. |

---

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

### 10.2 Data minimisation

Raw positions are **never persisted**. Samples are processed in memory to derive: revealed cells, bar discoveries, visit sample timestamps. The last accepted position per user is held in memory only, for the teleport guard, and discarded on restart.

Stored per user: username, hashes, avatar seed, fog bitmask, per-day reveal counts, discovered bar IDs, visit records (bar + timestamps), badges, push subscription. Nothing else.

The per-day reveal counts (Section 5.5) are an addition over v1.1. They record *how much* was revealed on a day, never *where*, and are therefore consistent with C4. State this in the privacy page.

### 10.3 Privacy notice

A short, project-specific privacy page at `/privacy`, in English, covering: what is collected, that location is processed but not stored as a trail, retention, the anonymity setting, and account deletion. It links to the main privacy policy on `ahultsch.com` for everything else. **No separate legal notice (Impressum)** — link to the one on the main site.

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

Overpass query: nodes, ways, and relations within the Karlsruhe boundary relation with `amenity` in `bar`, `pub`, `biergarten`, `nightclub`.

OSM tagging of drinking establishments in Germany is inconsistent — bars are frequently tagged as `pub`, `restaurant`, or `cafe`, and the seed will contain both false positives and gaps. The seed is therefore a **starting point requiring manual curation**, not authoritative data. The admin interface exists primarily for this.

Entries without a `name` tag are discarded. Ways and relations are reduced to their centroid.

### 11.2 Refresh

No automatic synchronisation in v1. Re-running the import script produces a diff report to stdout; applying changes is a manual admin decision. The script must never write to the live database.

### 11.3 Community submissions

Users submit via the burger menu: a map picker to place the pin (mandatory — this is how position is set, not geocoding), plus name and address.

Submitted bars go live **immediately** for all users, with `source = 'community'`, and are rendered with a small distinguishing marker in list and detail views. The admin can edit, hide, or delete them afterwards.

**Duplicate guard.** Reject if an active bar exists within `SUGGEST_DUPLICATE_RADIUS_M` whose name is similar. Similarity is a normalized Levenshtein ratio ≥ `SUGGEST_NAME_SIMILARITY`, computed after normalising both names: lowercase, strip diacritics, strip punctuation, collapse whitespace, and drop leading articles and common suffixes (`bar`, `pub`, `kneipe`, `cafe`). The rejection names the conflicting bar so the user understands why.

A submitting user immediately gets a `bar_discoveries` row for their own submission — they are demonstrably standing there.

### 11.4 City data pipeline

`import-osm-bars.ts` (11.1) is not the only script that has to reach outside the repository for OSM data — the district boundaries and the tile extract do too, and `build-grid.ts` (5.2) turns their output into the grid. None of these can run inside the implementing agent's sandbox: the sandbox has no route to Overpass or Geofabrik, the OSM data hosts. They are run by the project owner on his own machine, and their output is committed or released the same way as every other artefact (Section 13.1). Nothing at runtime depends on those hosts, and a v1 rebuild without network access to them is still possible from the committed output.

Because C10 already requires the data model to be multi-city capable, there is no reason for this pipeline to be Karlsruhe-specific and generalised later. It is city-parameterised from the start.

**The per-city configuration file is the single seam.** `data/cities/<slug>.json`, one file per city, committed. It holds everything both the scripts and the `cities` row (Section 5.1) need:

| Field | Used by |
|---|---|
| `slug` | all scripts; `cities.slug` |
| `name` | `cities.name` |
| `osm_admin_filter` | `fetch-boundaries.ts` — the Overpass filter (admin level, name, regional key) that identifies the city relation |
| `bounding_box` | `fetch-boundaries.ts`, `extract-tiles.sh` |
| `cell_size_m` | `build-grid.ts`; `cities.cell_size_m` |
| `geofabrik_region` | `extract-tiles.sh` |
| `tiles_filename` | `extract-tiles.sh`; `CONFIG.TILES_FILENAME` |

Every script takes a single `--city=<slug>` argument and reads everything else from this file. Adding a second city is adding a second JSON file, not a code change. This file is also what seeds the `cities` row from Section 5.1 — the seeding step reads it directly, the same way it already reads `grid-meta.json` for `playable_cells` (Section 5.2). Script parameters and the database row are therefore derived from one source and cannot drift apart.

**The script chain.**

| Script | Produces | Network |
|---|---|---|
| `scripts/fetch-boundaries.ts` | City outline, district polygons, and neighbouring municipalities as GeoJSON, into `data/seed/<slug>/` | Yes — Overpass |
| `scripts/extract-tiles.sh` | The PMTiles extract, into `data/tiles/` | Yes — Geofabrik; also needs Java |
| `scripts/build-grid.ts` | The cell grid (`grid.bin`, `grid-meta.json`), per Section 5.2 | No — offline. Belongs to Phase 3; not yet built |
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

Registration, login, logout, sessions, security-question password reset, forced admin password change, age gate, settings skeleton, burger menu, deterministic avatars.

**Definition of Done**
- [ ] A user can register, log out, and log back in on a phone
- [ ] Registration is rejected without the 18+ confirmation
- [ ] Password reset works end to end via the security question, and invalidates existing sessions
- [ ] An unknown username returns a stable decoy security question, indistinguishable from a real one
- [ ] The seeded admin is forced through a password change before any other screen is reachable
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
- [x] The explainer is reachable from the burger menu and appears once after the first check-in

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
- [x] The admin section is visible in the burger menu only for admins, and admin endpoints return 403 otherwise — `packages/web/src/App.community.test.tsx`, describe `admin menu visibility`: `hides the Admin entry from the burger menu for a non-admin user`, `shows the Admin entry in the burger menu for an admin user`; `packages/api/src/routes/admin.test.ts`, describe `admin guard`: `returns 403 for a logged-in non-admin at $method $url` (parameterised over every `/api/admin/*` route)
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
- [~] Accessibility: WCAG 2.1 AA contrast on text and controls, visible focus states, labelled form fields, and no state signalled by the accent colour alone (Section 8.1) — contrast, the focus ring's own contrast, labelled form fields, and the accent-plus-label rule are all automated in `packages/web/src/App.a11y.test.tsx`. Nothing here can run a screen reader, so whether any of this is announced sensibly is unverified. **Added in v1.14, narrowed in v1.15:** the status icons of Section 8.6 are the one place where colour does carry state alone, and the accent-plus-label rule says nothing about them. Their luminance separation, hue separation, distance from the accent and severity ordering are now all automated in the same file, derived from the palette tokens themselves. What remains unverified is what Section 8.6 asks for in the same breath and no test here can do: how the three actually read, in colour and in greyscale, on a phone screen in daylight
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

It is nonetheless published as a **GitHub Release asset**, not a tracked file. Every regeneration produces a new file under a new versioned name (Section 4.1), so committing them would accumulate binaries in history that no revision ever needs again, and the extract is ODbL-derived rather than MIT (13.1, 13.3). Keeping it out of the tree also keeps clones small for anyone who only wants the code. The premise changed; the decision stands, and the reasons above are the ones that carry it. `scripts/extract-tiles.sh` is meant to regenerate it from a public Geofabrik extract so the artefact is reproducible without the release — that script does not exist yet, and Karlsruhe's extract was produced by invoking `planetiler` by hand.

`docker compose up` fails with a clear, actionable error if the tiles file is absent, naming both the download URL and the regeneration script. The expected filename comes from `CONFIG.TILES_FILENAME`, so a regenerated extract is published under a new versioned name and the edge cache is bypassed automatically (Section 4.1). This holds for the standalone two-container path (Section 4), where Compose can check for the file before anything else starts.

It does **not** hold for the single-container deployment that runs on the Pi (v1.2.2). That container is the whole site — refusing to boot because the map extract is absent would take registration, login, and every other feature down over a file that only the map needs, which is a worse failure than a broken map screen. The API therefore always starts. If the file at `${TILES_DIR}/${CONFIG.TILES_FILENAME}` (Section 4.3) is missing at boot, the API logs the absence at `error` level, naming both the download URL and the `scripts/extract-tiles.sh` regeneration command, and every request under `/tiles/*` answers with a clear, machine-readable error (Section 9.5's conventions apply) that the client surfaces on the map screen rather than a raw 404 or a hung request. This is a deliberate difference between the two deployments, not an oversight: the standalone path can afford to fail fast because Compose owns nothing but this one service, while the single container cannot let one optional feature take the whole site down.

Whichever deployment serves it, `/tiles/*` must answer HTTP range requests — PMTiles fetches small byte ranges out of the one large file rather than downloading it whole, and a server that ignores `Range` defeats the point of the format (Section 4.1). This is verified directly against a `206 Partial Content` response, not assumed from the serving library (Section 12, Phase 2 Definition of Done).

### 13.3 Licences

- **Code:** MIT. Permissive, minimal friction for anyone wanting to run their own city.
- **Map data and derived artefacts** (`bars.json`, `districts.geojson`, `*.pmtiles`, `grid.bin`): ODbL, inherited from OpenStreetMap. Documented in `DATA-LICENSE` with the attribution required by Section 10.5.
- The `README` states the split explicitly so nobody assumes MIT covers the data.

### 13.4 Consequences of a public repository

These are consequences to design around, not reasons to reconsider:

1. **No security through obscurity.** Rate limits, the session model, and the security-question reset flow are all publicly readable. They are specified to hold up under that assumption; the rate limits in Section 9.4 are load-bearing, not decorative — which is precisely why the proxy-header requirement in that section is a correctness issue, not a detail.
2. **Bar positions are public.** `bars.json` is in the repository, so the "hidden until discovered" mechanic is a gameplay convention, not a secret. This is acceptable — the underlying data is public OSM data regardless. The API still refuses to leak undiscovered bars (Sections 7.4, 9.5), because the convention should not be broken by the app itself.
3. **The admin account is never in code.** It is seeded on first boot from `ADMIN_USER` and `ADMIN_PASSWORD` environment variables. A hard-coded admin credential in a public repository is a critical failure. The account is seeded with `must_change_password = 0`, because on the Pi that credential is chosen by the operator and managed by the platform rather than shipped with the image — Section 5.3 sets out why forcing a change there breaks the managed path in rather than protecting it.
4. **Secret scanning.** GitHub secret scanning and push protection are enabled on the repository. Any secret that ever lands in history must be rotated, not merely deleted.

---

## 14. Open Items

| # | Item | Status |
|---|---|---|
| O1 | Explorer thresholds set to 0.1% / 0.3% / 2.0% as activity floors. At a 100 m reveal radius, 0.1% of Karlsruhe's playable area is roughly 900 m of previously unexplored walking (verified: ~69 cells ≈ 865 m of a 200 m-wide corridor). Lower them if real use shows active players being excluded. | Resolved |
| O8 | Barfly thresholds set to 1 / 2 / 3 bars. Same intent: a floor, not a target. | Resolved |
| O9 | Check-in can be satisfied by leaving and returning within the window (Section 7.5). Accepted for v1; revisit only if abuse is observed. | Resolved |
| O2 | No logo yet. Wordmark-only placeholder in the chosen serif until one exists. | Deferred |
| O3 | Cell size may move from 50 m to 25 m after real-world testing. At 25 m the grid is 834 × 686 = 572,124 cells: mask ~70 KiB, texture ~559 KiB, `grid.bin` ~1.1 MB — all still viable, but the fog-state migration is real work. Grid rebuild path is stubbed, not implemented. | Deferred |
| O4 | Native iOS wrapper (Capacitor) for true background tracking — the only route to background reveal. | Out of scope for v1 |
| O5 | Additional cities. The data model supports them; no admin flow for adding one exists. | Out of scope for v1 |
| O6 | GitHub Actions + GHCR build pipeline if on-Pi build times become painful. | Documented, not built |
| O7 | Friends, shared sessions, and social features. | Out of scope for v1 |
| O10 | Section 9.4's `trustProxy` hop count for the Pi deployment is unverified — Cloudflare's edge and `cloudflared` may together add entries to `X-Forwarded-For` before Caddy ever sees the request, and neither this repository nor the platform's settles the real count; nor does either settle whether the platform's Caddy configures `trusted_proxies` or a `header_up` override that would change what the header holds by the time the API reads it. Verify by logging the raw header from one real external request against the running deployment and counting the entries, and by reading the platform `Caddyfile`'s global options, then set `trustProxy` to match. | Open — needs verification on the Pi |
| O11 | The bar import covers `amenity` in bar\|pub\|biergarten\|nightclub (`packages/shared/src/bars.ts:84`) and produced 170 bars, but the owner reports well-known venues missing. Cause not established: venues tagged differently in OSM (cocktail bars are often `amenity=cafe`, some are `amenity=restaurant` with `bar=yes`), venues absent from OSM altogether, or venues outside the municipal boundary the import clips to. Needs concrete examples before any filter change — widening to `amenity=cafe` would pull in every café in the city. | Open |
| O12 | `estimateCellPixelSize` in `packages/web/src/map/fog/canvas-fallback.ts` measures from `origin_lon` — the grid's **west boundary**, cell x = −0.5 — to `cellCenterXY(1, 0)`, a cell **centre** at x = 1. Those are 1.5 cells apart but the result is used as one cell's width, so every revealed-cell hole is drawn about 1.5× too large and cleared area bleeds roughly a quarter of a cell past the grid edge. Affects only the 2D canvas fallback (no WebGL2), so it is invisible on most devices, which is why nothing caught it. Found while extending the fog quad; not fixed there because it is unrelated to that change. | Open |
| O13 | The two fog renderers diverge on Section 7.3's layer ordering. The WebGL path is a MapLibre style layer and is inserted at the ordering point Section 7.3 fixes, so the road and water layers above it stay crisp and everything below it is hidden. The 2D canvas fallback (`packages/web/src/map/fog/canvas-fallback.ts`) is a `<canvas>` appended to the map container — a DOM overlay above the whole map, not a style layer — so it cannot be interleaved with the vector layers at all. On a device without WebGL2 the fog therefore covers everything uniformly, roads and water included, and the entire base map keeps showing through it at `1 - FOG_MAX_OPACITY`. Closing this means giving the fallback its own base-map compositing, which Section 7.3 explicitly does not ask of it ("do not attempt feature parity"). Accepted for now; revisit only if a real player turns out to be on that path. | Open |
| O14 | An **expired** visit is never removed from the pending banner while the map screen stays open. `POST /api/samples` deliberately reports only the visits its sample touched, and `GET /api/visits/pending` is fetched once per mount, so a visit that reaches `VISIT_EXPIRY_S` with the app open keeps rendering as pending until the screen is remounted. It is the same family as the confirmed-time defect v1.14 named — the banner asserting a state the server does not hold — and it was found while fixing that one, not by it. Closing it means either the sample response reporting the visits it expired, or the banner refetching; both are small, and neither was done at the time because it was outside that task's scope. | Open |

---

## 15. Changelog

### v1.18 — a visit can be ended, and the banner stops lying about it

The last two items of the third feedback round. `POST /api/visits/:id/cancel` acts only on the
caller's own pending visit and answers one identical 404 for every other case — another
player's visit, a completed or expired or already-cancelled one, an id that never existed —
for the reason Section 9.5 gives about bars, which applies with more force here: visit ids are
one global sequence, so a distinguishable response would let any signed-in player enumerate
how many visits everyone else holds. A pending row that is already stale by time is expired
rather than cancelled: the six-hour rule ending a visit and the player choosing to end it are
different things and the row records which happened.

The banner now renders the server's `confirmedS` and `remainingS` instead of a client-side
clock counting from check-in. That clock is what produced "Confirmed 120:21 - 0:00 remaining"
on a visit walked away from two hours earlier. Section 7.5's rule about what the figure does
over time is now proven by a test that both steps it on a real sample and holds it still once
the player is out of range, so neither the lie nor its over-correction can come back. The
guidance moved inside the list item, which is where it always belonged: several simultaneous
pending visits are allowed, so one sentence under the whole list could not be true of all of
them, and that is why the away wording used to appear directly beneath its own contradiction.

Two Phase 5 Definition-of-Done ticks withdrawn in v1.14 are re-earned here, each on the exact
terms its note set. One new Open Item, O14: an expired visit is still never removed from the
banner while the map stays open — the same family of defect as the one just fixed, found while
fixing it, and left recorded rather than quietly folded into an unrelated change.

### v1.17 — checking in moves onto the marker

v1.14 specified this and the code caught up here. The bar's own marker is now the only route
into a check-in; the nearby panel keeps naming what is in range and has stopped being a
control. That is what makes two bars a few metres apart separable — the player names the one
they mean instead of accepting a suggestion made from a position that cannot tell them apart.

One thing v1.14 left ambiguous is now settled and written down. "Leads to that bar" reads as a
navigation, and taken literally it is impossible: position tracking runs only on the map
screen, so routing away from it stops fog reveal and sample posting and leaves the destination
with no live position to judge on-site eligibility against. The check-in therefore lives in a
sheet on the map screen, and `/bars/:id` is recorded as carrying no check-in at all. Section
8.3's screen table said the opposite in two rows and is corrected with them.

### v1.16 — the fourth round: the fog edge, a rotated map, minor streets, and the locate zoom

The owner walked the city again with the layer ordering of v1.14 in place and reported it
working: zoomed out he sees roads and water through the fog and nothing else, zoomed in the
buildings stay hidden, and explored ground reads as detailed and looks right. Four things came
back with that.

**The fog edge is a boundary now, not a fade.** His words: the transition fades out so
gradually that no clear boundary is visible, which makes it not obvious at first glance that
the player is actually unlocking parts of the map. That is not a cosmetic complaint — the edge
is the only feedback that the core mechanic works, so an invisible edge is an invisible game.
The old edge faded over about 190 m. Two things caused it, a two-cell blur and an alpha ramp
spanning almost the entire blurred range, and Section 7.3 now names both as constants and
records the relationship between them: the visible transition is exactly `2 · (2r + 1) · h`
cells wide, so they are one width expressed as two numbers rather than two independent knobs.
The noise offset that makes the boundary irregular stays untouched — "harder" here means a
crisp *irregular* edge, never a crisp circle.

**The fog did not cover a rotated map, and the cause was structural.** The quad was a fixed
rectangle: the city's extent plus the same padding ratio the map uses as its pan limit. That
reasoning holds only while the map is north-up, because a pan limit constrains an axis-aligned
viewport — rotate the camera and the viewport's corners sweep outside the rectangle, leaving
bare un-fogged ground where there is simply no geometry to shade. Section 7.3 now requires the
quad to be rebuilt every frame from the camera's own bounds, which account for bearing and
pitch, with its own padding constant. That the padding was shared with the pan limit is
recorded as the cause, because the same shortcut would produce the same defect again.

**Minor roads are added, below the fog.** He asked for the smaller streets he was missing on
explored ground, and where they go is the whole question: above the fog they would hand
unexplored ground the full street grid, which is the detail the fog exists to withhold. Below
it they are a reward for having been somewhere. That also settles why they are their own layer
rather than a wider filter on the existing one — a single filter cannot sit on both sides of
the fog.

**"To my location" now sets a zoom instead of only centring.** Tapping it while zoomed far out
used to leave the player centred on a city-wide view they still could not walk from. It takes
them to `MAP_DEFAULT_ZOOM`, the same constant as the opening view, since both answer the same
question. The map picker on Suggest a bar keeps the old behaviour on purpose, and Section 8.3
says so: someone who zoomed in to place a pin precisely would otherwise lose the precision
they zoomed in for. Two identical-looking controls behaving differently is a real cost, taken
knowingly rather than found later.

### v1.15 — the status palette's deferred values are decided

v1.14 specified the three status icons and expressly left their colours open: "the specific
values are a later decision and are deliberately not fixed here; the constraint on them is."
The code landed, so the decision is taken and Section 8.6 records it — the 3:1 floor against
the binding background, 2.2:1 between adjacent states, 4:1 across the extremes, and luminance
descending with severity so the ordering survives greyscale. The values live in `index.css` and
are asserted from those tokens in `App.a11y.test.tsx`, which is what closes the half of Phase
8's accessibility item that v1.14 opened; the other half, how the three read on a real screen,
stays a human step.

Recording the numbers also surfaced two things the arithmetic forces rather than chooses, and
Section 8.6 now says both. The darkest status colour comes out darker than the ink the map
itself is drawn in, because the 3:1 rule caps the lightest of the three near a relative
luminance of 0.24 and two steps down from there land below ink. And at that luminance hue
barely registers, so the `bad` colour reads as black whatever hue it is given and its
separation is carried by luminance alone. Neither reopens the fixed-shape decision or the
exclusion of the accent's red — they are the price of both, written down so the next person
does not mistake them for sloppiness.

### v1.14 — the third round of feedback from the street

Seven decisions, all the owner's, from the third round of feedback on the running app. They
touch what the fog hides, what the status indicator looks like, where a check-in happens, how a
player gets out of one, and what the map shows when it opens.

**The fog moves down the layer order, and water and the ordinary streets come up above it.**
v1.13 put the fog directly beneath the motorway/trunk layer, so trunk roads alone stayed crisp
on unrevealed ground and everything else — water included — was dimmed away with the buildings.
Section 7.3 now fixes the order explicitly: background, green landcover, parks and buildings
below the fog; water, waterways and both road layers above it. Green areas and parks go under
the fog by the owner's explicit request. A player on unrevealed ground sees roads and water and
nothing else, which is more of a skeleton to orient by than the trunk network on its own ever
gave, while everything that says what a place is actually like still waits to be walked to.

**Major roads lose their extra weight, and the hierarchy moves to the zoom threshold.**
`road-highway` carried the widest ramp in the style at `line-opacity: 0.85`, which was the right
call while it was the only road above the fog; above the fog alongside everything else it simply
shouts. Both road layers now take the same colour, opacity and width ramp. Nothing is lost:
`road-highway` still appears from zoom 4 and `road-primary` only from zoom 8, so the zoomed-out
map still shows the trunk network alone — the difference shows up at the zoom where it helps
rather than as a permanent difference in ink.

**The consequence of that ordering is recorded rather than discovered later.** A layer above the
fog renders identically on fogged and revealed ground; it cannot know the difference. The road
intensity the owner likes was only ever seen on revealed ground, because below the fog those
roads were dimmed to nothing — so moving them above puts that same intensity onto unexplored
ground, where it may read as too loud and where it flattens the distinction the fog exists to
draw. Section 7.3's answer is a deliberately reduced opacity for the roads above the fog, with
the revealed-versus-unrevealed contrast carried by the buildings, the green areas and the fog
tone instead. The exact value is a judgement to be made on a real device. If a single value
cannot serve both states, the named remedy — the fallback, not the plan — is two copies of the
road layers, quiet above the fog and full below it, so revealed ground gets both and fogged
ground only the quiet one.

**The status indicator becomes three icons whose shape never changes, and that costs the
palette its "exactly one accent colour" rule.** Section 8.6's text indicator with three labelled
states is replaced by GPS, connection and tracking icons that carry their state in colour alone;
tapping still opens the same short explanation. Section 8.1 said exactly one accent colour was
permitted across the whole application, and that the accent was never the only carrier of
meaning. Both sentences now carry a bounded exception: a small named set of status colours, used
by this indicator and by nothing else, never as an accent, with the muted red still reserved for
the player's position and active states. The narrowing is stated as a narrowing, with its reason
— shapes held fixed leave colour as the only channel, and one accent cannot express three states.

**The accessibility cost of that is mitigated in the spec, not assumed away.** WCAG 2.1 SC 1.4.1
is about colour not being the only *visual* means of conveying information, so an `aria-label`
answers for a screen-reader user and does nothing at all for a sighted colour-blind one. With the
shapes fixed, the mitigation that works is luminance: Section 8.6 requires the three status
colours to differ in luminance as well as hue, far enough apart to survive colour blindness and a
greyscale rendering, checked by actually converting the icons to greyscale. Each icon also
carries an accessible name stating its state in words — for assistive technology, and explicitly
not a substitute for the luminance rule. No hex values are invented here; the constraint is
specified and the values are a later decision.

**Checking in moves onto the map, and the nearby panel stops being a control.** The panel used to
propose a check-in and carry the button. Now the bar's own marker is the only route: tapping a
discovered bar's marker leads to that bar, where the check-in action is offered and enabled only
inside the on-site radius. That is what makes two bars next door to each other separable — the
player names the one they mean instead of accepting a suggestion made from a position that cannot
tell them apart. The panel stays, because knowing what is in range is worth having; it names the
bars in range and tells the player to tap one on the map, and it performs no check-in. Sections
7.5 and 8.3 both described the old arrangement and both are corrected.

**A visit can be cancelled.** There was no way to end a pending visit at all — `POST /api/visits`
created one and the only exit was the inactivity expiry hours later, so a player who checked in
by mistake was stuck with it. Section 9.2 gains a cancel endpoint under `/api/visits`, acting
only on the caller's own pending visit; Section 5.7 gains `cancelled` as a terminal status
alongside `expired`, reached only by that explicit request, mastering nothing, and releasing the
partial unique index so the same bar can be checked into again immediately. The pending-visit
banner carries the control, behind a confirmation, because cancelling discards confirmed time
that cannot be recovered. `VISIT_EXPIRY_MS` is untouched in value, behaviour and description.

**The pending-visit banner tells the truth about confirmed time.** It labelled as "Confirmed" a
number that was wall-clock time since check-in, so a visit checked into two hours earlier and
walked away from read "Confirmed 120:21 - 0:00 remaining" — claiming two hours of presence that
never happened, and looking complete on a visit that could not complete. Section 7.5 now requires
the confirmed figure to be the server's own `confirmed_s`, the elapsed time between check-in and
the last accepted on-site sample as Section 5.7 already defines it, with remaining time derived
from that. Read alone, that rule invites the opposite defect — a banner frozen at 0:00 while the
player is standing in the bar — so Section 7.5 also says what the figure does over time: it steps
forward once per accepted on-site sample, holds between samples, and stops at the last confirmed
value once the player is out of range. Following the server's number as it changes is the
requirement; interpolating between the values the server has confirmed is the thing that was
wrong in the first place. The banner's guidance must also match the state it is shown in: the "Open Tipsy Trails
again while you're still here" line was rendered unconditionally, directly beneath "You've moved
away from *bar* — your visit is still pending", telling a player who had left to stay where they
were. On site, stay and reopen; away, return to finish; never both at once.

**Map overlays may not overlap.** Eight overlays are positioned independently against the map
container and two collide today — the locate button over the nearby panel at the bottom, the
tracking indicator over the pending-visit banner at the top, both because a corner control sits
at a higher z-index than the full-width bar sharing its edge. Section 8.3 specifies the
requirement rather than the two fixes: no overlay may obscure another, and a control anchored to
an edge yields to any bar occupying that edge. Fixing the present collisions one at a time leaves
eight hand-tuned offsets that agree by coincidence and a ninth overlay that breaks them again.

**The map opens at zoom 16 instead of 12.** Zoom 12 is a city overview — a screenful of fog with
nothing in it to walk towards, and the City overview screen already exists for that. Zoom 16 is a
few blocks across, the scale at which a bar marker, the player's position and the 50 m grain of
the fog are all legible. Zooming out to `MAP_MIN_ZOOM` is unchanged. The value belongs in
`packages/shared/src/config.ts` beside the existing zoom limits, not at the call site that
creates the map (Section 0, rule 3).

**Two Phase 5 Definition-of-Done ticks are withdrawn.** Section 12's legend says `[x]` means
proven by an automated test in this repository, so a tick outlives the requirement it was earned
against only by accident. Check-in "is only offered within the on-site radius … and lists multiple
candidates by distance" was proven through the panel's button, which no longer exists; and "the
pending banner shows confirmed and remaining time accurately at all times" was proven by asserting
that the number moves with the wall clock, which is the defect. Both are unticked with the reason
recorded inline, and both are re-earned when the code and its tests catch up. The code still
implements the superseded behaviour as of this version — that is the next step's work, not a
regression introduced here.

### v1.13 — the fog hides detail instead of tinting it

The owner walked the city with the app open for the first time and reported the fog as too
low-contrast: zoomed in, every detail still read through it, and revealed ground was only a
faintly lighter shade. Measured against the palette, he was right, and the cause was two
deliberate decisions meeting badly. Section 7.3 required roads and water to stay "faintly
visible beneath [the fog], at roughly 25% opacity", and Section 8.1's near-monochrome style
draws building fills at `fill-opacity: 0.04`. So a building differed from bare paper by 8 of
255 levels before any fog, and by 2 underneath it, while a motorway kept 46 — the fog had
almost nothing to hide, and could not create a difference where none existed.

**The fog now sits beneath the motorway layer rather than on top of the whole style.** It was
added with no `beforeId` at all, so it dimmed motorway and building alike. Ordering does the
work instead: everything below it is dimmed away, the motorway layer above it stays crisp on
unrevealed ground. This serves 7.3's own reason better than 7.3's rule did — that rule existed
so players could orient themselves, and a sharp motorway orients better than a dimmed one.
Minor roads and buildings deliberately stay below and disappear, which is the "only high-level
features" the report asked for. One accepted consequence: motorways now draw over building
fills rather than under them, imperceptible at 0.04.

**Fog opacity rises from 0.75 to 0.88**, which it can now afford because it no longer carries
orientation. It had been hardcoded twice — once as a GLSL `const float`, once inside an
`rgba()` string — and in neither `config.ts` nor `DERIVED`, so the two renderers could have
drifted apart silently. It is now `CONFIG.FOG_MAX_OPACITY`, read by both.

**A divergence between the two renderers is now permanent and recorded as O13.** The 2D canvas
fallback is a DOM overlay appended above the entire map, not a style layer, so it cannot be
interleaved with vector layers and cannot reproduce the ordering. On a device without WebGL2
the fog still covers motorways and detail still shows through, now at 0.88. There is no clean
workaround, so it is documented rather than papered over.

Two further options from the same concept — a colder fog hue, and a stronger base map — were
deliberately not taken, pending a look at this on a real device. Changing all four levers at
once would have left nobody able to say which one worked.

### v1.12 — badges become a competition, and the threshold goes back behind the server

**This reverses the design intent every version since v1.x has stated, deliberately and on the owner's decision.** Section 7.7 used to open with "Badges are an *activity floor*, not a competition" and award the badge to every user who cleared the threshold. It now awards the badge for a period to the highest scorer alone. The old rule made a badge a participation marker: with thresholds set as low as they must be to avoid excluding real players (0.1% of the city in a week is roughly 900 m of new ground), everyone who went out at all collected the same shelf, and a shelf everyone has says nothing about anyone. A badge that marks the best week in the city is worth something to win; one that marks having left the house is not.

**The threshold survives, in the one role that still makes sense: a floor.** It is not a target and never was — it exists only so the badge cannot be won in a dead period by whoever was least inactive. If nobody reaches it, nobody wins it, and the period simply has no holder. This is why raising a threshold does not make the badge harder to win; it only makes an empty period more likely. `CONFIG.BADGE_THRESHOLDS` keeps its values and its home in `config.ts`; only the comment above it changed, because half of what that comment claimed ("not competitive targets") is now the opposite of the rule.

**Ties award everyone tied at the top rather than being broken.** Section 7.8's "earliest achievement" tie-break exists to make a *listing* deterministic, and reusing it here would silently turn a genuine draw into a loss for whoever moved later in the week — a rule nobody would choose if asked outright. Two users on identical values both won; the schema already permits it, since `UNIQUE (user_id, kind, period, period_key)` is per user. Equality is compared exactly: both metrics derive every value from integer counts through one identical computation, so equal users produce bit-identical floats and a tolerance would only promote near-misses into ties.

**Neither the threshold nor any standing is published.** No endpoint returns the threshold — `GET /api/profile/:handle`'s badge progress carries the player's own value and nothing else — and the profile shows no rank, no "2nd place", no "0.3% to go". The progress bar it used to draw is gone with the number it was drawn against, along with its CSS. A hidden floor keeps the badge from being farmed to the decimal, and withholding rank keeps the surface a record of what a player did rather than a running scoreboard of what everyone else did. Badges already awarded are untouched by any of this: they are a record of periods won and are never revoked.

### v1.11 — the Pi contract, read from the actual files this time

v1.10 opened Section 4.3 with "verified by reading the platform repository directly (`AlexanderHultsch/PiMultiServiceServer`), not inferred". That sentence was false, and it is the reason everything below went unchallenged for a version: the platform repository has never been readable from any session working on this repository, and the description was assembled second-hand from a summary relayed through another chat. Its confidence was borrowed, not earned. On 2026-08-19 the owner pasted the real `sites.conf`, `scripts/deploy.sh`, `docker-compose.yml` and `config/caddy/Caddyfile` off the running Pi; Section 4.3 is corrected against them and now states that provenance instead. Where the paste does not answer a question, the section says so rather than filling it in.

**A failing `seed:admin` does not abort anything — it is swallowed.** The real line is `docker compose exec -T "${name}" npm run seed:admin || echo "  WARN: seed:admin fehlgeschlagen"`. The `|| echo` handles the failure, so `set -e` never fires and the run continues to `docker compose restart caddy`. v1.10 stated the opposite as its headline requirement, and the risk inverts with the correction: not a loud abort that takes the Pi's other sites down with this one, but a site that comes up looking healthy, serving pages, with no working admin account and nothing to mark it but one German warning line in a log nobody may read. Silent is worse than loud here. What *does* abort every site's deploy is the preceding `docker compose up -d --build`, which carries no `||` — a failing image build there ends the whole run, every other site's rebuild included. The demands on the script itself are unchanged and still worth stating: it must exist, be idempotent, be safe to run alongside boot-time seeding, and exit 0 whether it seeded or found the account already present. The `runMigrations` write-lock and `openDatabase` WAL-retry reasoning behind that form is unaffected and was re-verified.

**Registration takes three files, not one line.** `sites.conf`'s own header says a new line there is not sufficient — the service must also appear in the platform's `docker-compose.yml` and in `config/caddy/Caddyfile`. The Caddyfile ends in a fallback that answers 404 to any unmatched hostname, so a site missing its Caddy block is unreachable from the outside while its container runs perfectly, which is the failure mode least likely to be diagnosed quickly. Two further facts about `sites.conf` were never recorded at all: `host` is a **subdomain label**, not a hostname (`winecashing` → `winecashing.<DOMAIN>`), making this site's value `tipsytrails` rather than `tipsytrails.ahultsch.com`; and the file is maintained only on the platform checkout's `env` branch, where the Pi's checkout sits today, because it names private repositories.

**The service block needs `env_file: ./apps/<name>/.env`, and v1.10's example omitted it.** `deploy.sh` writes `SESSION_SECRET`, `ADMIN_USER` and `ADMIN_PASSWORD` into that host file, and nothing carries them into the container unless the service names it — the Pi's ginperium block does. Following the old example would have produced a container that never receives `SESSION_SECRET` and therefore refuses to start (`packages/api/src/env.ts`), after a deploy that reported success.

**`deploy.sh` has no single-site mode, and a failed `git pull` still deploys.** It accepts `--fresh` and `--set-password` and exits 1 on anything else; every run rebuilds and restarts every site on the Pi, so nothing about this site can be deployed in isolation — the earlier text implied it could. And the per-site `git pull --ff-only` only warns on failure before building whatever is already on disk, so a diverged or force-pushed site branch deploys stale code while the run reports success.

**Section 4.3 now carries the three registration blocks verbatim**, derived from the Pi's ginperium blocks so that nothing has to be composed by hand at the Pi: the `sites.conf` line, the `docker-compose.yml` service block (with `env_file:`, with no `ports:`), and the `Caddyfile` host block.

**Two earlier claims are downgraded to open rather than corrected.** The pasted `Caddyfile` excerpt covers one site's `handle` block and the 404 fallback and nothing else, so it evidences neither `auto_https off` nor the absence of `trusted_proxies`/`header_up` — both of which v1.10 asserted. They are now stated as unanswered by the available evidence. Open Item O10 keeps its status — the `trustProxy` hop count was already recorded as unverified, and still is — but its scope and remedy widen: it now names the unread `trusted_proxies`/`header_up` configuration alongside the hop count, and its remedy requires reading the platform `Caddyfile`'s global options in addition to counting header entries, because counting the entries in `X-Forwarded-For` no longer settles the value on its own once a `header_up` override nobody has read might rewrite the list. Section 9.4 is amended to match.

### v1.10 — the real Pi contract, corrected

Three items, all from finally reading `PiMultiServiceServer` instead of inferring its behaviour.

**Section 4.3 is rewritten wholesale.** Everything about `sites.conf`, `deploy.sh`, and the platform's `docker-compose.yml` in the previous text — going back to v1.2.2 — was inferred from the fact that a multi-site platform existed, not read from it. The real contract differs in enough places that patching it piecemeal would have left the two versions tangled: `sites.conf` has four fields (`name repo_url host admin`), no port field; `admin: yes` writes exactly `SESSION_SECRET`, `ADMIN_USER` — not `ADMIN_USERNAME`, which the previous text (and Section 13.4) had been calling it — and `ADMIN_PASSWORD` into `apps/tipsy-trails/.env`, fully overwritten on every deploy, with only `SESSION_SECRET` read back and preserved; `ADMIN_USER`/`ADMIN_PASSWORD` come from one shared `~/pi-server/admin.env` pair reused across every `admin: yes` site, not a shared user store — this app's own `users` table and hashing are untouched by the platform. `PUBLIC_ORIGIN`, `PORT`, and `DB_PATH` must be added by hand to the platform's `docker-compose.yml`, which `deploy.sh` never touches and which therefore does survive redeploys, unlike the three admin values. `deploy.sh --fresh` deletes the whole per-site data volume, which for other sites on this Pi may be a cache and here is the database and the tile extract — every account, all fog progress, every mastered bar. And `deploy.sh` runs `npm run seed:admin` after bringing containers up, under `set -euo pipefail`, so that script must exist and must succeed, idempotently, every time, or it takes every other site on the Pi down with it — a requirement the previous text never stated because the platform's error-handling posture around `admin: yes` was never actually read.

**VAPID keys move out of the environment.** The corrected `admin: yes` contract above is what forces this: a key pair placed in `apps/tipsy-trails/.env` the way `SESSION_SECRET` might be would survive exactly one deploy, because `SESSION_SECRET` is the only value `deploy.sh` reads back and reuses — everything else in that file is a full overwrite. Section 5.9 now specifies generation on first boot, persisted beside the database on the same data volume, loaded on every later boot, and untouched by anything short of `--fresh`. The three `VAPID_*` environment variables stay supported as an all-or-nothing override for deployments that want to pin their own key — most usefully local development — but the Pi should leave them unset now that there is nothing left for it to provision by hand. Section 10.1 states the resulting security posture: the private key lives on the same volume as the password hashes already do, which widens no boundary, and is never logged, returned, or committed.

**Section 9.4's `trustProxy: 1` is downgraded from settled to open for the Pi.** The platform repository confirms Caddy adds no `trusted_proxies` or `header_up` override, but it does not settle how many hops actually reach it — Cloudflare's edge and `cloudflared` may together add more than the one this app currently trusts, and nothing in either repository resolves the count. Recorded as Open Item O10 (Section 14): verify by logging the raw `X-Forwarded-For` header from one real external request against the running deployment and counting the entries, before treating Section 13.4's "rate limits are load-bearing" as true for this hop.

### v1.9 — two loose ends from closing Phase 8

Two corrections, not decisions.

**`/sw.js` gets the same cache treatment as `index.html` and `manifest.json`.** Section 4.1's table predates the service worker and never listed it, so it fell through to the same `public, max-age=0` every other unlisted static file gets — missing `must-revalidate`. That worker controls the entire app shell; a stale copy left cacheable by an intermediary (Cloudflare sits in front of this origin) pins every client it reaches to an old shell until it updates. `packages/api/src/app.ts` now sets `must-revalidate` for it, `app.test.ts` covers it, and the table gains both `/sw.js` and `/icons/*` — the latter at `public, max-age=86400`, matching `/static/districts.json`'s existing reasoning: referenced from the manifest, not content-hashed, changes rarely.

**`scripts/rebuild-grid.ts` now exists.** Section 4.2's tree and Section 6.2 both named it since before v1.8; the file itself was never written — the same gap `extract-tiles.sh` had until v1.6. The new stub validates `--city=<slug>` and the city config like the other pipeline scripts, then refuses to run: migrating every existing `fog_state.mask` onto a new grid (O3) is real work, and a stub that quietly did nothing would be worse than the missing file.

### v1.8 — hardening, polish, and the offline shell

Recorded after Phase 8 was built — the last phase in Section 12's plan. Five decisions. A sixth candidate — the tile extract's measured size — needed nothing further: it was already corrected to 9.4 MB in the v1.6 entry below, and neither Section 4.2's tree nor 13.2 states the old estimate any more, so there was nothing left to fix.

**One service worker, not two.** A scope can have exactly one service worker; registering a second silently replaces the first, and which one wins depends on load order, not on anything a reviewer could predict from the source. `push-sw.js` (Phase 5) and an offline-shell worker (this phase) cannot coexist at the app's one scope, so they are merged into a single `packages/web/public/sw.js` that owns both the Cache-API shell and Web Push. Both registration sites — the eager offline-shell registration on app start and `usePushSubscription`'s `enable()` — import the same `SERVICE_WORKER_URL` constant from `packages/web/src/sw/register.ts` rather than each naming a filename, so a second, competing URL cannot be reintroduced by one call site drifting from the other. `sw.js`'s fetch handler explicitly never intercepts `/api/*`: those responses are `private, no-store` (Section 4.1), and a cached one on a shared device is a privacy problem, not a cache-hit win.

**The client-side fog cache is keyed per user and cleared on logout.** The first version of `packages/web/src/map/fog/fog-cache.ts` used one unkeyed `localStorage` entry, reasoning from the precedent of `packages/web/src/tracking/masteringExplainer.ts`'s existing unkeyed flag — but that flag only records whether someone has seen the mastering explainer once, while this one records where a person walked. On a shared device, the next account to sign in, offline, would have been shown the previous account's revealed fog — their movement history, drawn as a map — before a single network request completed. The cache key now includes the user id, and `auth/useLogout.ts` clears the current user's entry on logout. Sections 10.2 (data minimisation) and 10.6 (account deletion) both bear on this: a fog mask reveals where someone has been in a way the server-side model already treats as sensitive, and a client-side cache is not exempt from that just because it never touches the database.

**The privacy page was re-read line by line against what the code actually does, and three overclaims came out of it.** A claim of *absence* — "we don't use X" — is the kind most worth checking, because nothing forces it to be re-verified when the code beneath it changes. `/privacy` previously implied OpenStreetMap was a service the app talks to at runtime; it is not — tiles are served by this app's own `/tiles/*` route (Section 9.2), and the browser never contacts OSM directly. The page now names OpenStreetMap correctly as the source the map *data* came from, and separately names the two outside services that genuinely do see live traffic: Cloudflare, which tunnels every request including position samples (Section 4, C1), and the browser vendor's own push service (Google, Apple, or Mozilla, depending on the browser), which carries a subscription and each reminder if push is turned on. Two smaller overclaims came out of the same pass: the deletion section stated an unqualified immediate removal, when C7's existing Pi backup job means a routine backup can still hold a copy until it cycles out — now stated as such. And the per-day reveal counters (Section 5.5) were described as feeding only the badge job, when Section 7.8 already has them feeding the leaderboard's week/month filters too; the page now says both.

**`scripts/extract-tiles.sh`'s `--area` flag takes the last segment of `geofabrik_region`, not the field's full stored path.** `data/cities/<slug>.json` stores the full Geofabrik path (`europe/germany/baden-wuerttemberg`) because that is the more useful value to keep on record — it is also the path segment of the actual download URL, which the script's own reachability probe uses. Planetiler's `--area`, however, only ever ran successfully against the short form (`baden-wuerttemberg`); its own log shows it resolving that short name to the full download URL itself. Recorded here because the difference reads as an inconsistency on a first pass over the script, and is not one — the full path and the short segment are each used exactly where they work.

**The player's own position is now rendered on the map** (Sections 8.1, 8.3). It was specified from the start — Section 8.1's one accent colour is reserved for exactly this, among active states — and never built until this phase's `OwnPositionMarker`. Nothing is drawn before the first GPS fix arrives; there is no last-known-position guess and no origin-corner placeholder.

### v1.7 — community submissions and admin

Recorded after Phase 7 was built. Section 11.3 left four things open; all four were decided. Two more decisions, neither previously stated, came out of building the admin area.

**Section 11.3's duplicate guard needed four readings.** The normalized Levenshtein ratio is `1 - distance / max(len a, len b)`, with `a === b` (which also covers both-empty) short-circuiting to 1 before any division, so the both-empty case never divides by zero. The leading-article set covers English and German — the section names the suffixes (`bar`, `pub`, `kneipe`, `cafe`) but not the articles, and this is a German-city app with English UI copy, so both languages' definite/indefinite articles apply. The order of normalisation steps is not a free choice: it is the literal sequence the section's own sentence lists — lowercase, strip diacritics, strip punctuation, collapse whitespace, drop leading article, drop trailing suffix — and is followed as normative, including that the article is dropped before the suffix is checked. And a name can normalize to nothing (the section's own example, "The Bar", loses its article and then its remaining content is entirely the trailing suffix): both sides of the comparison guard against this, because without it two such names would compare as identical and block each other, and an empty string would match every other name that also normalizes away to nothing.

**Hidden bars were not actually hidden.** `GET /api/bars` and `GET /api/bars/:id` never filtered on `bars.status`, so a bar an admin hid stayed visible to every player who had already discovered it — a gap open since Phase 4, closed now that Phase 7 gave admins a way to hide a bar in the first place. Both endpoints now filter to `status = 'active'`. `POST /api/samples`'s discovery query and the check-in query in `routes/visits.ts` already filtered correctly. The leaderboard and badge queries deliberately ignore bar status: mastering is a completed visit, and hiding a bar afterwards must not revoke it. That is a rule, not an oversight.

**Admin routes carry no rate limit.** Section 7.1's `RATE_LIMITS` names none for the admin surface, every admin route sits behind `requireAdmin`, and the admin account is the trust boundary those limits exist to protect in the first place. Recorded here as a decision so a future reader does not mistake the absence for a gap.

**Admin-created and admin-edited bars are exempt from the duplicate guard.** Section 11.3 specifies the guard for community submissions; Section 9.3 says nothing about applying it to admin routes, and the admin is trusted to know what they are doing — including, deliberately, adding a second bar with a name close to an existing one.

**Admin endpoints answer 403 to a logged-in non-admin, not 404.** The opposite of Section 9.5's bar rules, and deliberately so: there, hiding a bar's existence is the point; here, only the authority to act is secret, not the existence of `/api/admin/*` itself.

### v1.6 — progress, leaderboard, and badges

Recorded after Phase 6 was built. Four decisions the earlier text did not settle.

**`BADGE_EVAL_INTERVAL_MS` joined Section 7.1's `CONFIG` block.** Section 7.7 specifies the badge job's cadence only in words ("shortly after each period closes") and names no evaluation interval, so CLAUDE.md's guardrail — every constant lives in `config.ts`, never inlined at a call site — admitted two readings: the constant is not "defined in the spec", but the same rule forbids inlining a timeout next to the `setInterval` that reads it, and `MAINTENANCE_INTERVAL_MS` was already sitting in the block for exactly the tick it serves. It lives in `config.ts` beside that sibling constant and is mirrored into this section, above. The value is hourly, and that is a decision worth recording rather than leaving as a bare number: the catch-up entry point (Section 7.9) is already idempotent and already knows, from the `UNIQUE` constraint, whether a given period was evaluated, so running it once an hour and re-running it on a period it already covered costs nothing extra — no cron parser or precise-boundary scheduling is needed to satisfy "shortly after".

**Section 7.8's tie-break needed a reading.** "Earliest achievement" is well defined for a one-off event but not for a running total — a user's area percentage or bar count does not have a single instant it was "achieved" the way a badge award does. The adopted meaning, applied identically in `packages/api/src/badges.ts` and `routes/leaderboard.ts`: the instant a user's value last rose to what it now is. Concretely, `fog_state.updated_at` for all-time area (the mask's last write is the last time `revealed_cells` changed); the latest day among those summed into the period total for week/month area; and the completion that pushed a user's mastered-bar count to its current total for the bars metric. Users who never scored on a metric carry no achievement instant at all and fall through to the `users.id` tie-break, same as a genuine tie. This is recorded here as the normative reading so a future change does not re-derive a different one for the same words.

**`GET /api/profile/:handle` resolves the `player-{id}` form for every user, not only anonymous ones.** Section 9.5, read literally, restricts only the *username* form for an anonymous user ("the username form returns 404 and only the handle form resolves, masked") and says nothing against the handle form also resolving a non-anonymous user. It does: a bare username still resolves only a non-anonymous user, so an anonymous user stays unreachable by their real username, but `player-{id}` now works for anyone. This discloses nothing the ranked list does not already — Section 7.8's leaderboard shows masked and unmasked entries side by side on the same page, so which numeric ids belong to real accounts is public by design there. What Section 9.5 actually protects is the path from a *known username* to a profile; that path stays closed for anonymous users exactly as written, and the byte-identical 404 (unknown user, anonymous-by-username, malformed handle) still holds.

**The verification chain gained `pretest` and `pretypecheck`.** `packages/api` and `packages/web` resolve `@tipsytrails/shared` through a gitignored `dist`, and neither `pnpm test` nor `pnpm typecheck` rebuilt it — only the `prepare` hook did, and `prepare` covers installing, not editing. A signature-preserving break to a shared rule (`isVisitExpired`, changed to a threshold ten times too large) left `pnpm typecheck` at zero errors and the api suite covering visit expiry green, 26 of 26, because a behaviour change that keeps its signature produces no type error and the stale `dist` on disk was still the old, correct build. Stated plainly: for as long as this held, the four commands CLAUDE.md makes authoritative were testing the *previous* build of `packages/shared`, not the one on disk. `package.json` now runs the `shared` build as `pretest` and `pretypecheck`, so `pnpm test` and `pnpm typecheck` from the repository root are correct again. One gap is accepted rather than closed: a single package's tests invoked directly, as `pnpm --filter @tipsytrails/api test`, still bypasses both hooks and can read a stale `dist`. The four root commands remain the authoritative ones for exactly this reason.

**The tile extract's size was measured, not estimated.** Sections 4.1, 4.3 and 13.2 all quoted "30–80 MB", a figure nobody had ever produced a file to check. Karlsruhe's extract, built for the Section 6.2 bounding box at zoom 0–14, is **9.4 MB**. The numbers are corrected where they informed a decision, and 13.2's reasoning is restated: GitHub's file-size limits were never the real argument for publishing the extract as a Release asset, so the decision now rests on the reasons that actually carry it — a new versioned file per regeneration, ODbL rather than MIT, and clone size. The v1.4 entry below keeps its original wording; it is a record of what was decided then.

**`scripts/extract-tiles.sh` does not exist.** Section 4.2 lists it and `packages/api/src/app.ts` names it in the startup error logged when the extract is missing, but it was never written — Karlsruhe's extract was produced by invoking `planetiler` by hand. Recorded here rather than quietly dropped from the tree, because the error message currently points an operator at a file they cannot find.

### v1.5 — check-in, mastering, and optional push

Recorded after Phase 5 was built. Four decisions the earlier text did not settle.

Section 9.2 gains `GET /api/push/vapid-public-key`, with the reasoning stated beside the table. It is a genuine addition to the endpoint surface rather than a clarification of one, so it is listed here as such.

**The three `VAPID_*` variables are optional.** A deployment that does not set them boots normally, logs once that push is off, and runs every other feature. `PUBLIC_ORIGIN` and `SESSION_SECRET` remain the only variables the container refuses to start without. Push is an enhancement; making it a boot requirement would take down registration and the map over a notification. A partial configuration — some of the three but not all — is treated as a misconfiguration and warned about rather than left as a silent half-state, because it is far likelier to be a typo than an intent.

**`purgeExpiredSessions` now takes an explicit `nowS`.** It previously read the clock itself and had no production caller at all. The maintenance tick (Section 7.9) needs the same statement against a time it controls, and re-deriving the query there would have left two copies of an auth-critical `DELETE` with the dead one easier to find. One statement, one caller, the time passed in.

**`runMaintenanceTick` is asynchronous.** Push dispatch is network I/O, and the tick owns it. It still takes `nowS` as a parameter and still never reads the clock itself, which is what keeps it drivable across hours in a test without faking timers, and what makes it a pass over current state rather than a step forward from the last run — the property Section 7.9 relies on for a missed tick to be self-healing.

### v1.4 — tile serving in the single-container deployment

Sections 4.1 and 13.2 assumed Caddy would serve `/tiles/*` and that `docker compose up` would fail outright when the extract was missing — both true only of the standalone two-container path (Section 4). The single-container deployment that actually runs on the Pi (v1.2.2) has no Caddy in front of the API, so neither assumption held, and Phase 2 could not be built against them (`HANDOVER.md` §4.3).

Closed the gap. The API now serves `/tiles/*` itself in that deployment, with HTTP range support stated as mandatory rather than an optimisation — PMTiles fetches small byte ranges out of one large file, and ignoring `Range` would force the whole 30–80 MB extract down the wire on every map view (Section 4.1). The extract lives on the platform's mounted data volume rather than in the image, under a directory named by the new `TILES_DIR` environment variable (default `/data/tiles`, mirroring `DATABASE_PATH`'s convention in `packages/api/src/env.ts`); see Section 4.3.

Section 13.2's "fails to start" behaviour is now explicitly scoped to the standalone compose path. Refusing to boot the single container over a missing map file would take down registration, login, and every other feature over something only the map needs — a deliberate difference from the standalone path, stated as such rather than left implicit. Instead the API always starts, logs the absence loudly at startup with the download URL and the regeneration script, and answers `/tiles/*` with a clear, client-surfaceable error.

Section 4.1's cache table is unchanged in its values but now says which component applies them per deployment: Caddy in the standalone path, the API itself in the single container. The Cloudflare Cache Rule remains required either way — it is edge configuration, not an origin concern.

Section 9.2 gains the tile route, marked unauthenticated and cacheable — the one path under the API's control deliberately not `private, no-store`. Section 9.4's `trustProxy` description, stale since the single-container topology replaced the two-container tunnel (v1.2.2), is corrected to describe trusting exactly one hop. Phase 2's Definition of Done gains a `206 Partial Content` check.

### v1.3 — city-parameterised data pipeline

Phase 2 needs a district-boundary fetch and a tile extract, and both need OSM data hosts (Overpass, Geofabrik) the implementing agent's sandbox cannot reach. Those scripts are specified as something the project owner runs locally instead — but C10 already commits this project to a multi-city data model, and a pipeline hard-coded to Karlsruhe would just have to be generalised the first time a second city is added. Added Section 11.4: a per-city `data/cities/<slug>.json` config file that is the single seam feeding both the scripts and the `cities` row (5.1), `scripts/fetch-boundaries.ts` for district and neighbour geometry, and the same idempotent, network-scoped, fail-loud posture already established for `import-osm-bars.ts` (11.2) extended across the whole chain. Section 4.2's tree updated to a per-city `data/seed/<slug>/` layout and the new script; Section 6.2 notes that Karlsruhe's grid parameters now live in `data/cities/karlsruhe.json`, with the table there kept as a human-readable copy.

### v1.2.2 — single-container deployment path

Section 4's architecture puts Caddy in front of a separate API container, one
service per concern. The Raspberry Pi now also runs a small multi-site
platform: several unrelated projects share the Pi, each as one container
listening on `PORT` with its SQLite path at `DB_PATH`, sitting behind a single
Caddy instance the platform owns rather than one this repository ships. That
container can't run its own Caddy in front of itself, so the API serves the
built SPA directly through `@fastify/static`, and the cache rules Section 4.1
described for Caddy — immutable hashed assets, revalidated `index.html` — are
reproduced in Fastify instead.

The two-container arrangement in Section 4 is not replaced by this. It is
still what `docker-compose.yml` and `caddy/Caddyfile` provide, and remains
correct for anyone self-hosting the project outside the Pi's platform. The
diagram in Section 4 describes that standalone path, not the Pi's.

### v1.2.1 — repository rename

Repository renamed to `TipsyTrails` and the public host to `tipsytrails.ahultsch.com`. The public URL stays HTTPS: the session cookie carries the `Secure` flag (Section 10.1) and would not be sent over plain HTTP. Package manager pinned to pnpm 10, which is what the toolchain provides.

### v1.2 — optimisation pass on v1.1

Corrections (things that were wrong or unbuildable as written):

1. **Visit duration unit mismatch.** `confirmed_ms` was defined as `last_sample_at - started_at`, but those columns are epoch *seconds* while `VISIT_REQUIRED_MS` is 1,200,000 ms — a visit would have needed ~14 days to complete. Renamed to `confirmed_s`, added the global unit rule (Section 0, rule 6) and a single `DERIVED` conversion block.
2. **Period-scoped progress was not computable.** Badges (7.7) and the leaderboard's week/month filters (7.8) both need "area newly revealed in the period", but the schema stored only a mask with no history. Added `fog_daily_progress`.
3. **Nothing expired visits or sent the reminder push.** Both were specified as behaviour with no mechanism. Added Section 7.9 (maintenance tick + lazy evaluation on read) and `push_sent_at`.
4. **No password-change endpoint existed**, although 13.4 requires the seeded admin to change its password on first login. Added `must_change_password`, `POST /api/auth/change-password`, and the forced-change screen.
5. **Per-IP rate limiting would have been global.** Behind Cloudflare Tunnel every request arrives from `cloudflared`; without a trusted forwarded header all users share one bucket. Specified in 9.4 and made a Phase 1 DoD item.
6. **CSP would have broken the map.** MapLibre creates workers from blob URLs; the v1.1 policy had no `worker-src`. Full baseline policy now in 10.1.
7. **Phase 2's "< 200 KB gzipped initial JS" is not achievable** — MapLibre GL v4 alone is ~230 KB gzipped. Replaced with a shell budget plus a code-split map chunk.
8. **Tile cache-busting.** A 30-day cache on a stable `karlsruhe.pmtiles` filename makes regenerated tiles unreachable for a month. Filename now carries a version segment from `CONFIG.TILES_FILENAME`.
9. **Cloudflare does not cache `.pmtiles` by default**, so Phase 2's `cf-cache-status: HIT` check could never have passed. Cache Rule requirement added to 4.1.
10. **`GET /api/bars/:id` returning 403 for undiscovered bars leaks their existence**, contradicting 7.4. Unified to 404, alongside the other non-leaking responses now collected in 9.5.
11. **Username enumeration via the reset flow.** `GET /api/auth/reset/question` revealed which usernames exist. Now returns a stable HMAC-derived decoy for unknown names.
12. **Mask size stated as ~16 KB in 5.5 and ~18 KB in 6.2.** Computed once and unified: 417 × 343 = 143,031 cells, ~17.5 KiB.
13. **Node 20 leaves LTS maintenance in April 2026.** Moved to Node 22 LTS.
14. **Cross-reference error:** 4.2 pointed at Section 14 for the licence; it is Section 13.
15. **Admin screen listed "community submission review"** although 11.3 makes submissions live immediately — there is no review queue. Renamed to moderation.

Additions (gaps that were not contradictions but would have caused a stop-and-ask):

16. Package manager named (pnpm), `SPEC.md` and `pnpm-workspace.yaml` added to the tree.
17. `schema_migrations` tracking made explicit; `grid-meta.json` added so `playable_cells` is never hand-typed.
18. Sliding-session refresh threshold, session purge, and an `expires_at` index — v1.1 implied a database write per request.
19. Partial unique index preventing duplicate pending visits at one bar; server-side re-validation of check-in proximity; `VISIT_MIN_ONSITE_SAMPLES`.
20. Sample validation extended with clock-skew and staleness rules and a batch size cap.
21. Deletion semantics for bars submitted by a deleted account; password confirmation on account deletion; session invalidation on password reset; push-endpoint cleanup on 404/410.
22. Duplicate-guard similarity defined concretely rather than as "similar name".
23. Leaderboard tie-breaking and paging; anonymous-profile addressing.
24. Accessibility criteria for Phase 8, and the note in 8.1 that the monochrome direction must not cost contrast.
25. `better-sqlite3` arm64 build note, Pi build memory and swap guidance.
26. Rate limits, GPS thresholds, duplicate radius, and page size moved into `config.ts` as rule 3 requires.
27. Explicit statements of accepted trade-offs so they are not "fixed" later: the teleport guard's memory-only reference, the check-in return trip (O9), the equirectangular longitude scale, and revealable-but-unscored cells outside districts.

---

*End of specification v1.18*
