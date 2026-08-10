# Tipsy Trails — Technical Specification

**Version:** 1.4
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

Progress is measured as **percentage of area explored** (per district and city-wide) and **number of bars mastered**. Badges are awarded weekly, monthly, and yearly to players who exceed fixed thresholds.

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
| `/tiles/karlsruhe.<version>.pmtiles` | `public, max-age=2592000` | Range requests must be allowed; ~30–80 MB, fetched in small ranges |
| `/static/districts.json` | `public, max-age=86400` | District polygons, simplified |
| `/index.html`, `/manifest.json` | `public, max-age=0, must-revalidate` | |
| `/api/*` | `private, no-store` | Never cached |

Two things Cloudflare does not do by default and that must be configured explicitly:

- **The tile file must be cached by a Cache Rule.** Cloudflare's default cache does not include `.pmtiles`. Without a rule matching `/tiles/*`, every range request reaches the Pi and the Phase 2 `cf-cache-status: HIT` check will never pass.
- **The tile filename carries a version segment** (`karlsruhe.2026-08.pmtiles`), because a 30-day immutable-ish cache on a stable filename makes regenerated tiles unreachable for a month. The current filename lives in `config.ts` and is referenced by both the Caddyfile and the client.

Range requests on the tile path are not an optimisation; they are mandatory. PMTiles works by fetching small byte ranges out of one large file — a server that ignores the `Range` header forces the client to download the whole 30–80 MB extract on every map view, which defeats the point of the format. Whatever serves `/tiles/*` must answer `206 Partial Content` to a ranged request, and this is verified directly (Section 12, Phase 2 Definition of Done), not inferred from the serving library.

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

Build happens on the Pi. Push to `main` → SSH to Pi → `git pull && docker compose up -d --build`.

Multi-stage Dockerfiles; the frontend build stage runs on the Pi (arm64).

**Tile serving.** The extract is not in the image — Section 13.1 forbids committing it, and at 30–80 MB it does not belong in a build layer either. The platform mounts a persistent data volume for the container, the same one `DATABASE_PATH` lives under, so the extract lives there too, under a directory named by the `TILES_DIR` environment variable (default `/data/tiles`, mirroring the `/data/db/tipsy.db` default for `DATABASE_PATH` in `packages/api/src/env.ts`). The path the API reads is `${TILES_DIR}/${CONFIG.TILES_FILENAME}`. In the single-container deployment the API serves `/tiles/*` from that path itself, including range-request support (Section 4.1); in the standalone two-container path, Caddy serves it from the same mounted location per `caddy/Caddyfile`, unchanged. Startup and missing-file behaviour differ between the two deployments — see Section 13.2.

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

`must_change_password` exists for the seeded admin account (Section 13.4). While it is set, every endpoint except `/api/auth/me`, `/api/auth/change-password`, and `/api/auth/logout` returns 403 with a machine-readable `code: "password_change_required"`, and the client routes to the change-password screen.

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
  status          TEXT NOT NULL,      -- 'pending' | 'completed' | 'expired'
  completed_at    INTEGER,
  push_sent_at    INTEGER             -- set when the 21-minute reminder went out
);

CREATE INDEX idx_visits_user_status ON visits(user_id, status);
CREATE INDEX idx_visits_pending_sweep ON visits(status, last_sample_at);
CREATE UNIQUE INDEX idx_visits_one_pending ON visits(user_id, bar_id) WHERE status = 'pending';
```

`confirmed_s` is the elapsed time between check-in and the most recent accepted on-site sample — not a gap between arbitrary samples. It is stored in seconds like every other duration in the database and compared against `VISIT_REQUIRED_S` (Section 7.1).

The partial unique index makes a second pending visit at the same bar impossible; `POST /api/visits` for a bar with an open pending visit returns the existing visit rather than an error.

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

  RATE_LIMITS: {
    auth:            { limit: 10, windowMs: 60 * 1000,          by: 'ip' },
    resetByUser:     { limit: 5,  windowMs: 60 * 60 * 1000,     by: 'username' },
    resetByIp:       { limit: 20, windowMs: 60 * 60 * 1000,     by: 'ip' },
    samples:         { limit: 30, windowMs: 60 * 1000,          by: 'user' },
    suggest:         { limit: 10, windowMs: 24 * 60 * 60 * 1000, by: 'user' },
  },

  // Badges are ACTIVITY FLOORS, not competitive targets. Their only job is to
  // separate someone who actually went out during the period from someone who
  // just opened the app or was inactive. Set them low. A badge is awarded when
  // value >= threshold (minimum, not "strictly greater").
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

Visual behaviour:
- Unrevealed: opaque grey fog. Major roads (`highway` in `motorway|trunk|primary|secondary`) and water remain faintly visible beneath it, at roughly 25% opacity.
- Revealed: fog alpha 0. The edge is softened with a two-cell blur plus a low-frequency noise offset so the boundary never reads as a hard circle or as visible squares.
- Newly revealed cells animate from opaque to clear over 600 ms.
- Buildings and minor streets are only rendered where revealed.

**Fallback.** If WebGL2 is unavailable, fall back to a 2D canvas overlay redrawn on `moveend` only. Detect and log this; do not attempt feature parity on animation.

### 7.4 Bar discovery

When an accepted sample lands within `BAR_DISCOVERY_RADIUS_M` of an active bar, a `bar_discoveries` row is created. Discovery is permanent and independent of fog state — a discovered bar stays visible even if it sits in an area the player never fully revealed.

Undiscovered bars are never sent to the client. The client receives only discovered bars. The API must never leak undiscovered bar positions, including through aggregate endpoints such as counts per district.

This applies to error codes as well: `GET /api/bars/:id` returns the same response for an undiscovered bar and for a bar that does not exist. See Section 9.5.

### 7.5 Check-in and mastering

Bars sit close together in Karlsruhe's centre and GPS alone cannot distinguish neighbours, so **check-in is an explicit user action**.

**Flow:**

1. The client shows a "Check in" affordance for every discovered bar within `BAR_ONSITE_RADIUS_M + min(accuracy, BAR_ACCURACY_TOLERANCE_M)`. If several qualify, they are listed sorted by distance and the user picks one.
2. `POST /api/visits` creates a `pending` visit with `started_at = now`, `last_sample_at = now`, `onsite_samples = 1`. The server re-validates proximity using the caller's last accepted sample; a check-in without a recent on-site sample is rejected with 422.
3. Every subsequent accepted sample within the on-site radius of that bar updates `last_sample_at`, increments `onsite_samples`, and recomputes `confirmed_s = last_sample_at - started_at`.
4. When `confirmed_s >= VISIT_REQUIRED_S` **and** `onsite_samples >= VISIT_MIN_ONSITE_SAMPLES`, the visit becomes `completed`, `completed_at = now`, and the bar is mastered.
5. If no on-site sample arrives for `VISIT_EXPIRY_S`, the visit becomes `expired`. Expiry is never punitive — the user can simply check in again.

Because completion needs only *two* valid samples 20 minutes apart, the app does not have to stay open. Opening it on arrival and again before leaving is sufficient.

**Accepted trade-off.** A player who checks in, leaves, and returns 20 minutes later completes the visit without having stayed. This is inherent to a two-sample model and is accepted: the mechanic is a social prompt, not an audit. Do not add continuous-presence enforcement in v1 — it would require either background tracking (impossible, Section 7.2) or punishing users whose phone slept. See O9.

**Transparency requirements — these are product requirements, not suggestions.** The mechanic must be legible at every moment:
- An active pending visit is shown persistently at the top of the screen: bar name, elapsed confirmed time, remaining time.
- Explicit wording of what is needed: *"Open Tipsy Trails again while you're still here to complete this visit."*
- A Web Push notification at `VISIT_PUSH_AFTER_MS`, dispatched by the maintenance job (Section 7.9) and recorded in `push_sent_at` so it fires at most once per visit, and only while the visit is still `pending`.
- If a sample arrives out of range, show *"You've moved away from {bar} — your visit is still pending"* rather than silently failing.
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

**Design intent — read this before tuning any threshold.** Badges are an *activity floor*, not a competition. They exist to do exactly two things: prevent a user who has just registered and merely opened the app from receiving a badge, and prevent an inactive user from receiving one. Anyone who genuinely went out during the period should earn the badge. Thresholds are therefore deliberately easy, and should be lowered rather than raised if real-world use shows them excluding active players.

**Awarding.** A badge is granted to every user whose value is **greater than or equal to** the threshold for that period. Any number of users can hold the same badge — badges are never exclusive and are never taken away. Evaluation runs as a scheduled job shortly after each period closes (weekly Monday 04:00, monthly 1st 04:00, yearly Jan 1st 04:00, Europe/Berlin), and badges are written to the `badges` table.

The job is idempotent through the `UNIQUE (user_id, kind, period, period_key)` constraint plus `INSERT ... ON CONFLICT DO NOTHING`. It takes the period key as an optional argument so a missed period can be re-run by hand.

Live "on track" progress against the current period's threshold is shown on the profile, computed from the same `fog_daily_progress` sums.

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

A hand-drawn ink map. Desaturated, slightly warm paper ground. Lines read as if drawn with a pen or brush rather than as clean vectors — subtle weight variation and imperfect edges. Only major roads are rendered as fine black lines; water and green areas are rendered as loose hatching and stipple textures rather than filled colour. Symbols are solid black pictograms with no gradients, shadows, or outlines. Unexplored terrain sits beneath a milky grey fog with a soft, irregular edge. Exactly one accent colour is permitted across the entire application: a muted red, reserved for the player's own position and for active states. The overall impression is quiet, near-monochrome, and generous with empty space.

This direction applies to the whole application, not only the map. Chrome, typography, and controls follow the same restraint.

**Restraint does not override legibility.** A near-monochrome palette makes it easy to land below WCAG AA contrast without noticing. Body text and interactive labels meet 4.5:1 against their background, large text and icons 3:1. The accent red is never the only carrier of meaning — active states also change shape, weight, or label. This is checked in Phase 8.

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
| Map (main) | Fog map, own position, discovered bars, pending-visit banner, GPS/network indicator |
| Bar detail | Name, address, district, mastered status, community tag if applicable, Check in button |
| Profile | Username, avatar, badge shelf, area %, bars mastered, current-period progress |
| Leaderboard | Ranked list, metric toggle, period filter |
| Suggest a bar | Map picker + name + address |
| Settings | Anonymous toggle, push permission, change password, how-it-works, privacy, delete account, logout |
| Privacy | Static page at `/privacy`, see 10.3 |
| Admin (admins only) | Bar management, community bar moderation, user list |

### 8.4 Navigation

A single burger menu, top right, on every authenticated screen. Contents: Map, Districts, Leaderboard, Profile, Suggest a bar, Settings, Admin (admins only), Log out. No bottom tab bar, no other persistent chrome — the map should own the screen.

### 8.5 Avatars

Deterministic, generated locally from `avatar_seed` (assigned at registration). A schematic geometric mark in black on paper ground, in the style of the map symbols. Not customisable. No image files, no uploads — rendered as inline SVG.

### 8.6 GPS and connection quality indicator

A compact indicator on the map screen, always visible:

- **GPS:** three states derived from the last accepted sample's accuracy — good (≤ `GPS_ACCURACY_GOOD_M`), fair (≤ `GPS_ACCURACY_FAIR_M`), poor (worse, or no fix for `GPS_STALE_MS`).
- **Connection:** online / offline / syncing, based on `navigator.onLine` plus the queue depth of unsent samples.
- **Foreground tracking:** an explicit indicator showing whether position tracking is currently running, with a plain-language note that tracking pauses when the app is not in the foreground.

Tapping the indicator opens a short explanation of each state.

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
| GET | `/api/progress` | City + per-district progress, bars mastered |
| GET | `/api/leaderboard` | `?metric=area\|bars&period=all\|week\|month&page=` |
| GET | `/api/profile/:handle` | Public profile + badges — see 9.5 |
| PATCH | `/api/settings` | `{ isAnonymous }` |
| DELETE | `/api/account` | `{ password }` required; hard delete, cascades everywhere |
| POST | `/api/push/subscribe` | Web Push subscription |
| DELETE | `/api/push/subscribe` | `{ endpoint }` — removes it |

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

**The client IP must be taken from the trusted proxy header, not the socket.** Behind Cloudflare Tunnel every request reaches the API from `cloudflared`, so socket-based limiting would put all users in one bucket and make the per-IP limits meaningless. The Caddy instance immediately in front of the API sets `X-Forwarded-For` — this repository's own in the standalone two-container path, the platform's own single Caddy instance in front of the single container that runs on the Pi (Section 4.3, v1.2.2). Either way exactly one hop sits in front of the API, so Fastify runs with `trustProxy: 1`, trusting only that immediate hop. This matters because `X-Forwarded-For` is a comma-separated list the client can pre-seed with arbitrary entries; only the right-most hop is guaranteed to have been appended by infrastructure under our control. Trusting the left-most entry instead — what `trustProxy: true` does — would let any client mint a fresh rate-limit bucket per request just by sending a different fabricated value. Getting this wrong turns Section 13.4's "rate limits are load-bearing" into a false statement, so it is verified in Phase 1.

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
- [ ] The admin account is seeded from environment variables, never from code, with `must_change_password = 1`
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
- [ ] Check-in is only offered within the on-site radius, is server-re-validated, and lists multiple candidates by distance
- [ ] Two samples ≥ 20 minutes apart complete the visit — verified with the app closed in between
- [ ] A second check-in at a bar with an open pending visit returns the existing visit, not a duplicate
- [ ] The pending banner shows confirmed and remaining time accurately at all times
- [ ] The push notification fires once at 21 minutes on Android and on an installed iOS PWA, and not at all if the visit already completed
- [ ] Moving out of range shows the explicit "still pending" message
- [ ] A visit expires after 6 hours and the user can immediately check in again
- [ ] Expiry is correct after an API restart that skipped several maintenance ticks
- [ ] Mastered status is permanent and survives visit expiry of later visits
- [ ] The explainer is reachable from the burger menu and appears once after the first check-in

### Phase 6 — Progress, Leaderboard, Badges

Profile, badge shelf, leaderboard with metric and period switching, anonymity toggle, badge evaluation job.

**Definition of Done**
- [ ] The leaderboard ranks correctly on both metrics and all periods, with stable tie-breaking
- [ ] Week/month area figures come from `fog_daily_progress` and match a hand-computed reference
- [ ] A bar mastered twice counts once, in the period of its first completion
- [ ] Toggling anonymous masks the name immediately while preserving rank and statistics
- [ ] An anonymous user's profile is unreachable by username and reachable by handle
- [ ] Badges are awarded at or above the configured thresholds, verified with seeded test data
- [ ] A user who registered but never moved receives no badge for the period
- [ ] Multiple users can hold the same badge for the same period
- [ ] Badges are visible on profiles and inline in leaderboard rows
- [ ] Current-period progress toward each threshold is shown on the profile
- [ ] The evaluation job is idempotent — running it twice awards nothing twice — and catches up a period missed while the Pi was off

### Phase 7 — Community Submissions and Admin

Suggest-a-bar with map picker, duplicate guard, community marker, admin area.

**Definition of Done**
- [ ] A bar can be suggested via map pin, name, and address, and appears immediately for all users
- [ ] Community bars carry a visible distinguishing marker
- [ ] Submissions within 25 m of a similarly named active bar are rejected with a message naming the conflict
- [ ] The submitter immediately has the bar as discovered
- [ ] The admin section is visible in the burger menu only for admins, and admin endpoints return 403 otherwise
- [ ] The admin can create, edit, hide, and delete bars; moving a bar recomputes cell and district; deletion cascades cleanly
- [ ] Submission rate limits are enforced

### Phase 8 — Hardening and Polish

PWA manifest and install prompt, offline shell, privacy page, performance pass, error states, empty states, accessibility pass.

**Definition of Done**
- [ ] The app installs to the home screen on Android and iOS
- [ ] Opening offline shows the cached shell, the last fog state, and a clear offline indicator
- [ ] Queued samples survive going offline and are posted on reconnect
- [ ] Lighthouse mobile performance ≥ 90
- [ ] Time to interactive < 3 s on a mid-range Android over simulated 4G
- [ ] API p95 latency < 150 ms measured on the Pi under 10 concurrent users
- [ ] `/privacy` is live, mentions the per-day reveal counters, and links to the main site's policy and legal notice
- [ ] `prefers-reduced-motion` disables the dissolve animation and all transitions
- [ ] Accessibility: WCAG 2.1 AA contrast on text and controls, visible focus states, labelled form fields, and no state signalled by the accent colour alone (Section 8.1)
- [ ] Every network failure produces a user-facing message, never a silent failure
- [ ] Total container memory under load < 400 MB

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

The tile extract is roughly 30–80 MB. GitHub rejects files over 100 MB and warns above 50 MB, and Git LFS bandwidth on a public repository is exhausted quickly.

It is therefore published as a **GitHub Release asset**, not a tracked file. This keeps it freely downloadable — the project stays fully open — without bloating clone size. `scripts/extract-tiles.sh` regenerates it from a public Geofabrik extract, so the artefact is reproducible even without the release.

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
3. **The admin account is never in code.** It is seeded on first boot from `ADMIN_USERNAME` and `ADMIN_PASSWORD` environment variables with `must_change_password = 1`. A hard-coded admin credential in a public repository is a critical failure.
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

---

## 15. Changelog

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

*End of specification v1.4*
