# Tipsy Trails

A location-based exploration game for Karlsruhe, Germany.

The city starts under fog. You clear it by walking through it. Bars stay hidden until you come within 100 m of one — then they are yours forever. Check in, stay 20 minutes, and the bar is mastered. Progress is measured as percentage of area explored, per district and city-wide, plus the number of bars you have mastered.

Self-hosted on a Raspberry Pi, reachable at `https://tipsytrails.ahultsch.com` through a Cloudflare Tunnel. No inbound ports, no third-party analytics, no stored movement trails.

## Status

**Phases 0–8 are implemented** — the full eight-phase plan in [`SPEC.md`](SPEC.md) Section 12. Phase 8's device-dependent Definition-of-Done items — install to a home screen, Lighthouse ≥ 90, time to interactive on a mid-range Android, API p95 on the Pi, and container memory under load — need a phone, a browser, or the Pi, none of which exist in this environment, and remain unverified.

What exists today: a pnpm monorepo (`packages/shared`, `packages/api`,
`packages/web`); a Fastify API on SQLite (WAL) with an idempotent migration
runner; accounts, sessions, and a security-question password reset; the map —
MapLibre GL and PMTiles, code-split, in a hand-drawn ink style, with district
polygons and the city and district overview screens; fog of war — a per-user
bitmask revealed by walking, a WebGL layer with a 2D canvas fallback, and
per-district and per-day progress; bars — 170 of them imported from
OpenStreetMap, discovered at 100 m, permanently visible once found;
community submissions — a player places a pin on the map, names the bar,
and gives an address, and it goes live for everyone immediately unless it
duplicates a similarly named bar nearby, in which case the rejection names
the conflict; and an admin area, reachable only to admins, for creating,
editing, hiding, and deleting bars and for viewing the user list.

Mastering works like this: standing at a bar you have found, you check in.
Twenty minutes later, open the app again while you are still there and the bar
is yours for good. That is the whole mechanic — two moments twenty minutes
apart, not a stopwatch you have to babysit, because a browser cannot follow
you in the background and pretending otherwise would punish anyone whose phone
went to sleep. A banner shows how long is confirmed and how long is left; if
you wander off it says so rather than failing quietly; and a notification at
twenty-one minutes reminds you, once, if you asked for it.

Your profile shows the area you have revealed, the bars you have mastered,
and a badge shelf — an explorer badge and a barfly badge, each awarded
weekly, monthly, and yearly to anyone who was genuinely out walking during
that period, with your live progress toward the next one shown alongside.
The leaderboard ranks every player by area explored or bars mastered,
all-time or narrowed to the current week or month, with badges shown
inline next to each row. Turning on anonymity in Settings replaces your
name with "Player #<id>" everywhere — leaderboard included — immediately
and reversibly, without dropping you from the ranking or resetting anything
you have earned.

The app installs to a home screen as a proper PWA: a manifest, icons, and one
service worker that handles both the offline shell and push, reopening
offline to a cached shell, your last-known fog, and a plain offline indicator
rather than a blank screen. Position samples taken while offline queue in
memory and post once the connection returns — a reload during that stretch
starts the queue over, which is a stated limit, not an unnoticed gap. The fog
you have revealed is cached per account and cleared on sign-out, so a shared
device never shows the next player someone else's walked territory. Your own
position now renders on the map, in the app's one accent colour, once a GPS
fix arrives. A `/privacy` page states plainly what is stored and why, and
links out for anything broader.
`prefers-reduced-motion` turns off the fog dissolve and every other
transition; contrast, focus states, and form labelling meet WCAG 2.1 AA
against the app's near-monochrome palette; and every network failure now
surfaces a message instead of failing silently.

Six things are verified only as far as this development environment allows,
and are called out rather than glossed: the map extract has been built and
measures 9.4 MB, but it sits on the project owner's laptop and has not
reached the server, so nothing has rendered against real tiles; the fog shader
has never been
compiled, because there is no GPU here — its layer class is tested against a
fake WebGL context, which proves the call sequence and nothing about the GLSL;
no push notification has ever been delivered, because there is no browser and
no push service — the once-only, not-while-completed and dead-endpoint rules
are tested against a faked sender, the wire is not; no Docker image has
been built, because there is no Docker daemon; no screen reader has ever run
against any of this, so whether the accessibility pass's automated contrast,
focus and labelling checks add up to a sensibly narrated app is unknown; and
installing to a home screen, on Android or iOS, is unproven for the same
reason — no phone. What
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
unrelated projects on a shared platform (`AlexanderHultsch/PiMultiServiceServer`),
one container per site behind a single Caddy the platform owns, not this
repository. What follows comes from the platform's own files, pasted off
the running Pi by the owner on 2026-08-19 — the platform repository itself
has never been readable from here, and earlier versions of this section
described it second-hand and got several details wrong.

Registering a site takes three files, not one. A line in the platform's
`~/pi-server/sites.conf` — four fields, `name repo_url host admin`, no port
field — naming this site `tipsy-trails`, `admin: yes`, and `host`
`tipsytrails`, which is a subdomain label rather than a hostname
(`tipsytrails` → `tipsytrails.ahultsch.com`). A service block in the
platform's own `docker-compose.yml`. And a host block in its
`config/caddy/Caddyfile`, without which the site answers 404 from the
outside however healthy its container is. `sites.conf` is maintained only
on the platform checkout's `env` branch, which is where the Pi's checkout
sits. All three blocks are written out ready to copy in
[`SPEC.md`](SPEC.md) Section 4.3. As of that paste none of them exists:
nothing about this app has ever run on the Pi.

The platform's `deploy.sh` builds and runs the site locally
(`build: ./apps/tipsy-trails` plus `docker compose up -d --build` against
the root `Dockerfile` in this repository — no registry image involved) and
routes `tipsytrails.ahultsch.com` to the resulting container through its
own Caddy. `PORT` is `3000`, set in the platform's `docker-compose.yml` and
matched by its `Caddyfile` — not read from `sites.conf`. There is no
single-site mode: `deploy.sh` accepts only `--fresh` and `--set-password`,
and every run pulls, rebuilds and restarts every site on the Pi. A failing
image build aborts that whole run, every other site included; a failing
`git pull --ff-only`, by contrast, only warns and then builds whatever
stale code is already on disk, while the run reports success.

`admin: yes` makes `deploy.sh` write `apps/tipsy-trails/.env` on every
deploy, containing exactly three variables — `SESSION_SECRET`, `ADMIN_USER`,
`ADMIN_PASSWORD` — as a full overwrite each time. Only `SESSION_SECRET`
survives a redeploy: `deploy.sh` reads the existing value back out before
overwriting the file and writes the same value back. `ADMIN_USER` and
`ADMIN_PASSWORD` come from one shared `~/pi-server/admin.env` pair reused
across every `admin: yes` site on the Pi — nothing in `deploy.sh` does more
than supply those three values; this app's accounts and password hashing are
entirely its own.

Everything else — `PUBLIC_ORIGIN` above all, since the container refuses to
boot without it — must be added by hand to the platform's own
`docker-compose.yml`, in this site's `environment:` block, the same place
`PORT` and `DB_PATH` already live for the Pi's other sites. `deploy.sh`
never touches that file, so values placed there, unlike the three admin
values above, survive every redeploy:

```yaml
environment:
  PORT: "3000"
  DB_PATH: /data/db/tipsy.db
  PUBLIC_ORIGIN: https://tipsytrails.ahultsch.com
env_file: ./apps/tipsy-trails/.env
```

The `env_file:` line is the one not to forget. Without it the three
variables `deploy.sh` writes into `apps/tipsy-trails/.env` never reach the
container, and since `SESSION_SECRET` is required the app cannot boot at
all.

After bringing the containers up, `deploy.sh` runs
`docker compose exec -T tipsy-trails npm run seed:admin`, followed by
`|| echo "  WARN: seed:admin fehlgeschlagen"`. That `||` swallows the
failure: a missing or failing script does not abort the deploy, it prints
one warning line and the run carries on. The site then comes up looking
fine and has no working admin account, with nothing to say so but a warning
in a log nobody may read — worse than a loud failure, not better. The
script must exist and succeed idempotently on every run; this app already
seeds the admin account at boot, so the script has to be safe alongside
that, not a replacement for it.

The data volume is `./data/tipsy-trails:/data` on the platform side — host
`~/pi-server/data/tipsy-trails/`, container `/data`, created by Docker on
first start. The database and the map extract both live under it, and
`TILES_DIR`'s existing default (`/data/tiles`) already resolves correctly
here with no configuration change needed.

**`deploy.sh --fresh` deletes that entire volume before rebuilding.** For
some sites on this Pi that may just be a cache. Here it is every account,
all fog progress, and every mastered bar — there is no separate backup for
it beyond whatever the Pi's existing backup job already covers. Treat
`--fresh` against this site as data loss, not a reset.

See [`SPEC.md`](SPEC.md) Section 4.3 for the full contract, including the
Cloudflare TLS chain and why the rate limits' trusted-hop count is still an
open item.

### Standalone (this repository's compose)

```
git clone https://github.com/AlexanderHultsch/TipsyTrails.git
cd TipsyTrails
cp .env.example .env
# fill in .env: SESSION_SECRET, ADMIN_USER, ADMIN_PASSWORD, etc.
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

Described in Section 4.2 of the specification. Two directories are deliberately absent from a fresh clone: `data/db/` (the runtime SQLite database) and `data/tiles/` (the map extract, published as a GitHub Release asset rather than committed — 9.4 MB for Karlsruhe, and regenerated under a new filename each time). The API serves the extract from `TILES_DIR` with HTTP range support; without it the map routes have no basemap, and the tile route says so plainly instead of failing obscurely.

The city data under `data/seed/<slug>/` — boundaries, the cell grid, and the bars — is generated by the three scripts in `scripts/`, each parameterised by `data/cities/<slug>.json` so a second city needs a config file rather than a code change. See Section 11.4.

## Contributing

The build plan is phase-gated: a phase is not finished until every Definition-of-Done item in its section passes, and `main` is never left in a broken state. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the local setup and verification commands, and read `SPEC.md` before opening a pull request.
