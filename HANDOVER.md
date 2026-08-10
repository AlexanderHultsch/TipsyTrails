# Handover — state of play before Phase 2

For the next Claude Code session. Written at the end of the session that
completed Phases 0 and 1.

`SPEC.md` is the source of truth; `CLAUDE.md` holds the guardrails. This file
only records where things stand, what is deliberately unfinished, and what to
do first. Delete it once Phase 2 is done — it is a note between sessions, not
project documentation.

---

## 1. Current state

|                       |                                                            |
| --------------------- | ---------------------------------------------------------- |
| Repository            | `AlexanderHultsch/TipsyTrails`, branch `main`              |
| Local clone directory | `Tipsy-Trails` — stale name, do not rename, it is cosmetic |
| Phases complete       | 0 (foundation) and 1 (accounts)                            |
| Phase 2               | not started                                                |
| Tests                 | 154 green — shared 17, web 12, api 125                     |
| Live site             | placeholder shell, served by the Pi platform               |

Everything is committed and pushed. The working tree was clean at handover.

### Verification commands — all four must pass before anything is "done"

```
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
```

`pnpm install` runs a `prepare` hook that builds `packages/shared`. Do not
remove it: `packages/api` imports `@tipsytrails/shared`, which resolves to a
gitignored `dist`. Without the hook a fresh clone silently runs 38 of the
api package's tests instead of 125 while still printing a passing summary.

---

## 2. Deployment — read this before touching Docker

The Pi runs a **multi-site platform** maintained in a different repository and
a different chat. It is not the two-container arrangement Section 4 of the
spec describes. Section 15 of `SPEC.md` records the deviation.

- One container per site. It listens on `PORT` and gets its SQLite path in
  `DB_PATH`. The platform's own Caddy fronts it; this repository's
  `docker-compose.yml` and `caddy/Caddyfile` are the **standalone**
  self-hosting path and are not what runs on the Pi.
- The root `Dockerfile` builds that single image: Fastify serves the API and
  the built SPA together.
- `packages/api/src/env.ts` accepts `PORT` and `DB_PATH` as aliases for
  `API_PORT` and `DATABASE_PATH`; the project's own names win when both are
  set. Empty strings are treated as absent.
- Public host is **`tipsytrails.ahultsch.com`** — no hyphen. The platform's
  route pattern would produce `tipsy-trails.…`, so its Caddy route is written
  explicitly. The internal service name `tipsy-trails` is unrelated.

Required in `apps/tipsy-trails/.env` on the Pi — the container refuses to
start without them:

```
PUBLIC_ORIGIN=https://tipsytrails.ahultsch.com
SESSION_SECRET=<at least 32 characters>
```

Optional: `ADMIN_USERNAME`, `ADMIN_PASSWORD` — seeded once on first boot with
`must_change_password` set. Seeding never touches an existing user, so the
credentials can stay in the environment without reverting a changed password.

**The Docker image has never been built.** No daemon was available. The
runtime layout was assembled by hand and booted, so the application works;
`docker build` itself is unproven. Expect the first build on the Pi to be the
real test.

Two questions are outstanding with the platform chat:

1. What does `admin: yes|no` in `sites.conf` actually do? If it only injects
   shared `ADMIN_USERNAME`/`ADMIN_PASSWORD`, `yes` is fine. If it writes into
   a shared user table, use `no` — this app has its own `users` table.
2. Does the Cloudflare route for `tipsytrails.ahultsch.com` point at the
   platform's Caddy?

---

## 3. What blocked Phase 2, and what changed

Phase 2 needs two OpenStreetMap artefacts that could not be produced in the
previous session, because the sandbox network policy refused the hosts:

```
download.geofabrik.de:443   CONNECT 403
overpass-api.de:443         CONNECT 403
```

The owner has since set the environment's domain allowlist to **all domains**.
That applies at container start, so it takes effect in a **new session** —
which is this one. Confirm before planning around it:

```
curl -sS "$HTTPS_PROXY/__agentproxy/status"
curl -s -o /dev/null -w '%{http_code}\n' https://overpass-api.de/api/status
```

If those still fail, the data can be supplied by hand; Section 4 below has the
exact commands to hand back.

The allowlist is expected to be narrowed again afterwards. Both artefacts are
one-time products, so nothing at runtime depends on those hosts.

---

## 4. Phase 2 — first moves

Scope, from Section 12: PMTiles extract for Karlsruhe, MapLibre integration,
the ink style, district polygons, city and district overview screens with
static progress values, OSM attribution.

### 4.1 Fetch the district boundaries

Overpass query. `out geom`, raw JSON, saved to `data/seed/districts-raw.json`;
the conversion to `districts.geojson` belongs to `scripts/` and is part of the
phase.

```
[out:json][timeout:300];
rel["boundary"="administrative"]["admin_level"~"^(6|8)$"]["name"="Karlsruhe"]["de:regionalschluessel"~"^08212"]->.city;
.city map_to_area->.ka;
(
  .city;
  rel(area.ka)["boundary"="administrative"]["admin_level"~"^(9|10)$"];
);
out geom;
```

The `de:regionalschluessel` filter only guards against matching a different
Karlsruhe; drop it if the result comes back empty. Karlsruhe has roughly 27
Stadtteile. The city relation itself is included because the city overview
needs its outline and `scripts/build-grid.ts` needs it to decide which cells
are playable.

Neighbouring municipalities are also required — Section 8.3 wants them drawn
greyed out and inert on the city overview. That is a second query; decide
whether to fetch adjacent `admin_level=8` relations or to clip them from a
wider bounding box.

### 4.2 Build the tile extract

```
curl -LO https://github.com/onthegomap/planetiler/releases/latest/download/planetiler.jar
java -Xmx4g -jar planetiler.jar --download --area=baden-wuerttemberg \
  --bounds=8.2750,48.9400,8.5600,49.0950 \
  --output=karlsruhe.2026-08.pmtiles --force
```

Bounds are from Section 6.2. Java is available in the sandbox. Expect 15–30
minutes and a few GB of scratch. The output belongs in `data/tiles/`, which is
gitignored; Section 13.2 publishes it as a GitHub Release asset. The filename
is carried by `CONFIG.TILES_FILENAME` so a regenerated extract bypasses the
edge cache.

### 4.3 Decide how tiles are served — this is a real design question

The spec assumed Caddy would serve `/tiles/*`. On the Pi there is no Caddy of
ours. So:

- Fastify has to serve the extract with **HTTP range requests**, or PMTiles
  cannot work at all.
- The file is 30–80 MB and is not in the image. The platform mounts
  `./data/tipsy-trails:/data`, so the extract most likely belongs on that
  volume, with its path configured through an environment variable.
- Section 13.2 wants `docker compose up` to fail with a clear message when the
  file is missing. In the single-container arrangement that becomes a startup
  check in the API, not a compose-level one. Phase 0 deliberately left tiles
  out for exactly this reason — decide it properly now rather than inheriting
  the assumption.

### 4.4 Budget

Section 12's Phase 2 item, as revised in Section 15: the app shell stays under
**150 KB gzipped excluding the map chunk**, and MapLibre plus PMTiles are
code-split and loaded only on map routes. The shell is currently **65 KB**
gzipped, so there is room, but MapLibre alone is around 230 KB gzipped and
must not land in the shell chunk. Measure with `pnpm --filter @tipsytrails/web
build` and read Vite's output.

### 4.5 Data-dependent Definition-of-Done items

These cannot close until the artefacts exist:

- Karlsruhe renders in the ink style on a mid-range Android phone
- pan and zoom hold ≥ 50 fps
- tiles served with range requests and cached at the edge (`cf-cache-status:
HIT`) — also needs the Cloudflare Cache Rule from Section 4.1, which nobody
  has created yet

The rest of Phase 2 — MapLibre integration, the style, the overview screens,
the attribution, the scripts — is independent of them.

---

## 5. Deliberate debts

Small, known, and left alone on purpose. None of them block Phase 2.

| Item                                                                                                                                                                                                  | Where                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Avatar SVGs contain float artefacts (`stroke-width="1.7999999999999998"`)                                                                                                                             | `packages/shared/src/avatar.ts`        |
| Avatar renders very small on `/app`                                                                                                                                                                   | `packages/web/src/screens/AppHome.tsx` |
| Section 9.4 still says `trustProxy` is "restricted to the Docker network" — that describes the old two-container topology; the code trusts exactly one hop, which is correct for the platform's Caddy | `SPEC.md` §9.4                         |
| `PASSWORD_MIN_LENGTH` is 8, chosen by an executor because the spec names no value                                                                                                                     | `packages/shared/src/config.ts`        |
| The seeded admin cannot use the security-question reset — it stores a placeholder question and a hash of random bytes. Its recovery path is the environment.                                          | `packages/api/src/db/seed-admin.ts`    |

---

## 6. Things that bit, so they do not bite again

Recorded because each cost a round trip and each looked correct on first
reading.

- **`trustProxy` must be `1`, never `true`.** With `true` Fastify takes the
  left-most `X-Forwarded-For` entry, which the client controls, so anyone can
  mint a fresh rate-limit bucket per request. Section 13.4 calls the limits
  load-bearing. There is a test that fails if this is changed.
- **The reset-question decoy took three attempts.** The lookup and the decoy
  must normalise the username identically — the column is `COLLATE NOCASE`, so
  any difference in case or whitespace handling between them reopens an
  account-enumeration oracle. Both earlier attempts passed their own tests. The
  tests now iterate one shared list of spelling variants against the real and
  the unknown path.
- **`pnpm deploy` needs `--legacy`** under pnpm 10, and `allowBuilds` must stay
  out of `pnpm-workspace.yaml` — it makes pnpm invoke `node-gyp`, and
  `node:22-bookworm-slim` has no compiler. `better-sqlite3` ships arm64
  prebuilds and declares no install script.
- **`bars.submitted_by` has no `ON DELETE` clause.** Account deletion nulls it
  inside the same transaction; without that the delete fails outright once a
  user has submitted a bar.
- **Verify security properties by executing the attack**, not by reading the
  diff. Both decoy defects were found by curling a real server, never by
  reviewing code or trusting a green suite.

---

## 7. How the previous session worked

The owner ran it as a planner-and-reviewer loop: the lead session planned and
verified but wrote no code itself, delegating each step to a subagent under a
fixed executor contract, then re-ran every verification command independently
and read the diff before committing. Steps were sequential, one delegation
each, and a step was not accepted on the strength of its report.

That is a preference, not a repository rule. Ask before assuming it applies.
