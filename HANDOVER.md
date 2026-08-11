# Handover — state of play before Phase 5

For the next Claude Code session. Written at the end of the session that
completed Phases 2, 3 and 4.

`SPEC.md` is the source of truth; `CLAUDE.md` holds the guardrails. This file
only records where things stand, what is deliberately unfinished, and what to
do first. Replace it when Phase 5 is done — it is a note between sessions, not
project documentation.

---

## 1. Current state

|                       |                                                            |
| --------------------- | ---------------------------------------------------------- |
| Repository            | `AlexanderHultsch/TipsyTrails`, branch `main`              |
| Local clone directory | `Tipsy-Trails` — stale name, do not rename, it is cosmetic |
| Phases complete       | 0, 1, 2, 3, 4 (with the data-dependent gaps in §3 below)   |
| Phase 5               | not started — planned in §5, nothing written               |
| Tests                 | 410 green — shared 103, api 196, web 111                   |
| Last commit           | `3e4df53` Add the Karlsruhe bar seed data                  |

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
gitignored `dist`. Without the hook a fresh clone silently runs a subset of the
api package's tests while still printing a passing summary.

---

## 2. What landed since the last handover

- **Phase 2 — Map.** MapLibre GL v4 + PMTiles v3, code-split so they load only
  on map routes. The hand-drawn ink style (`packages/web/src/map/ink-style.ts`),
  district polygons, city and district overview screens, greyed-out inert
  neighbouring municipalities, OSM attribution. `GET /tiles/<filename>` serves
  the extract with HTTP range support and answers `206`.
- **Phase 3 — Fog of War.** `scripts/build-grid.ts`, the per-user bitmask blob,
  `POST /api/samples` with the full Section 7.2 validation chain, the WebGL fog
  layer with `texSubImage2D` partial updates and a 2D canvas fallback,
  per-district and per-day progress counters, the GPS/connection indicator,
  Wake Lock.
- **Phase 4 — Bars.** `scripts/import-osm-bars.ts`, bar seeding, discovery at
  100 m inside `POST /api/samples`, bar markers, the bar detail screen, and
  `data/seed/karlsruhe/bars.json` — 170 bars, committed.

### The city data pipeline (Section 11.4)

Three scripts, all city-parameterised through `data/cities/<slug>.json`:

```
node scripts/fetch-boundaries.ts  --city=karlsruhe
node scripts/build-grid.ts        --city=karlsruhe
node scripts/import-osm-bars.ts   --city=karlsruhe
```

`fetch-boundaries.ts` and `import-osm-bars.ts` also accept `--input=<file>`
(and `--input-city` / `--input-neighbours`), so a GeoJSON exported by hand from
overpass-turbo flows through the identical validation and conversion path as a
live Overpass call. That is how the Karlsruhe data was produced — the sandbox
network policy refused `overpass-api.de`. Keep those flags: they are the
supported offline path, not a workaround left lying around.

`import-osm-bars.ts` never writes to the live database. It writes the seed file
only; applying a diff to a running app is a manual admin decision (Section
11.2).

---

## 3. Data-dependent gaps — these need the owner, not an agent

Phase 2 and 3 are otherwise complete. These items cannot be closed here:

| Item                                                            | Blocked on                                                              |
| --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Karlsruhe renders in the ink style on a mid-range Android phone | the PMTiles extract, and a phone                                        |
| Pan and zoom hold ≥ 50 fps; the fog layer holds ≥ 50 fps        | same — unmeasurable in this sandbox                                     |
| Tiles cached at the edge (`cf-cache-status: HIT`)               | the Cloudflare Cache Rule for `/tiles/*` (Section 4.1), not yet created |
| The 2D canvas fallback renders correctly with WebGL2 disabled   | no GPU/WebGL here; the fog shader has **never been compiled**           |

**Build the tile extract on the Pi** — roughly 1–2 hours, unblocks the first
three Phase 2 items:

```
curl -LO https://github.com/onthegomap/planetiler/releases/latest/download/planetiler.jar
java -Xmx4g -jar planetiler.jar --download --area=baden-wuerttemberg \
  --bounds=8.2750,48.9400,8.5600,49.0950 \
  --output=karlsruhe.2026-08.pmtiles --force
```

The output belongs on the Pi's mounted data volume, in the directory the
container reads as `TILES_DIR` (default `/data/tiles`). The filename must match
`CONFIG.TILES_FILENAME`, so a regenerated extract bypasses the edge cache.
`data/tiles/` is gitignored; Section 13.2 publishes the file as a GitHub
Release asset.

**The fog shader is the one piece of this codebase that has never executed.**
The layer class is tested against a hand-built fake GL object, which proves the
call sequence and nothing about the GLSL. Treat the first render on a real
device as the actual test, and say so rather than reporting Phase 3 as fully
verified.

---

## 4. Deployment — unchanged, read before touching Docker

The Pi runs a **multi-site platform** maintained in a different repository and
a different chat. One container per site, listening on `PORT`, with its SQLite
path in `DB_PATH`, behind the platform's own Caddy. This repository's
`docker-compose.yml` and `caddy/Caddyfile` are the **standalone** self-hosting
path and are not what runs on the Pi.

Required in `apps/tipsy-trails/.env` on the Pi:

```
PUBLIC_ORIGIN=https://tipsytrails.ahultsch.com
SESSION_SECRET=<at least 32 characters>
```

Optional: `ADMIN_USERNAME`, `ADMIN_PASSWORD` (seeded once on first boot with
`must_change_password`; seeding never touches an existing user). `SEED_DIR` and
`TILES_DIR` if the defaults do not match the mount layout.

**The Docker image has still never been built** — no daemon in this
environment. Every image change has been verified by assembling the runtime
layout by hand (`pnpm deploy --prod --legacy` plus `dist`, `migrations`,
`public`, `data/seed`, `data/cities`) and booting the server from it. That boot
is real and passes; `docker build` itself remains unproven. There is a
`packages/api/src/docker-image.test.ts` guard asserting the Dockerfile copies
every directory the server reads at boot — it exists because a missing
`data/cities` crashed the container while all tests were green.

Two questions are still outstanding with the platform chat:

1. What does `admin: yes|no` in `sites.conf` actually do? If it only injects
   shared `ADMIN_USERNAME`/`ADMIN_PASSWORD`, `yes` is fine. If it writes into a
   shared user table, use `no` — this app has its own `users` table.
2. Does the Cloudflare route for `tipsytrails.ahultsch.com` point at the
   platform's Caddy?

---

## 5. Phase 5 — the plan, as far as it got

Scope from Section 12: visit creation, presence evaluation, the 20-minute rule,
expiry, the pending banner, the maintenance tick, Web Push, the explainer. It
needs **no external data** — it can be built end to end without the owner,
except for the VAPID keys in step 5.

The session that wrote this planned five steps and was cut off by a spend limit
partway into step 1. **Nothing was written; the tree is clean.** Start at step 1.

**Step 1 — visit rules and the two endpoints.**
A new pure `packages/shared/src/visits.ts` holding the Section 7.5 rules, so the
routes, the sample handler and the maintenance tick share one implementation:
the on-site radius `BAR_ONSITE_RADIUS_M + min(accuracy, BAR_ACCURACY_TOLERANCE_M)`,
the on-site test, on-site candidates sorted by distance, the completion
predicate (`confirmed_s >= VISIT_REQUIRED_S` **and** `onsite_samples >=
VISIT_MIN_ONSITE_SAMPLES`) and the expiry predicate. Then
`packages/api/src/routes/visits.ts` with `POST /api/visits` and
`GET /api/visits/pending`.

Three things to get right in that route, each of which is a real trap:

- An undiscovered bar and a nonexistent bar must produce **byte-identical**
  404s (Sections 7.4, 9.5). A check-in attempt is otherwise an existence oracle
  for bars the user has not found. Reuse `sendBarNotFound` from `routes/bars.ts`
  rather than writing a second copy of that body.
- Server-side proximity re-validation reads the caller's last accepted sample
  from the in-memory `lastAccepted` map in `routes/fog.ts`, which is currently
  module-private and needs a lookup exported. **Do not persist positions** to
  make this easier — C4 and Section 10.2 forbid it, and the map is
  memory-only on purpose. No sample on record, or one out of range, is a 422.
  That stored position carries no accuracy, so the check should use the most
  generous radius the client could legitimately have offered check-in at,
  `BAR_ONSITE_RADIUS_M + BAR_ACCURACY_TOLERANCE_M` — the server must never
  reject a check-in the client correctly offered.
- A second check-in at a bar with an open pending visit returns **that** visit.
  `idx_visits_one_pending` enforces it in the database, but the route must not
  use its constraint error as normal control flow.

`GET /api/visits/pending` evaluates expiry **lazily on read** and persists the
transition to `expired` — filtering it out of the response is not enough
(Section 7.9).

**Step 2 — sample-driven evaluation.** Every accepted sample within the on-site
radius of a bar with a pending visit updates `last_sample_at`, increments
`onsite_samples`, recomputes `confirmed_s`, and completes the visit when the
predicate holds. This fills in `visitUpdates` on `POST /api/samples`; the
comment in `routes/fog.ts` saying it is deliberately omitted comes out here.

**Step 3 — the maintenance tick** (Section 7.9), every
`MAINTENANCE_INTERVAL_MS`, inside the API process: expire stale pending visits,
purge expired sessions, and dispatch the 21-minute push. It must be idempotent
so a missed tick after a restart is self-healing — that is a Definition-of-Done
item ("expiry is correct after an API restart that skipped several ticks").

**Step 4 — the web UI.** The check-in affordance for every discovered bar in
range, listing multiple candidates sorted by distance; the persistent pending
banner with bar name, confirmed time and remaining time; the explicit
out-of-range message _"You've moved away from {bar} — your visit is still
pending"_; the "How mastering works" explainer in the burger menu, shown once
after the first check-in via `localStorage` (no server column).

**Step 5 — Web Push.** `POST`/`DELETE /api/push/subscribe`, the service worker,
and the dispatch at `VISIT_PUSH_AFTER_MS` recorded in `push_sent_at` so it
fires at most once and only while the visit is still pending. This is the one
step that needs the owner: generate a VAPID keypair and put
`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` in the Pi's `.env`.
Document the names in `.env.example` and **never the values** — CLAUDE.md.

Note that the DoD asks for the push to be verified on Android and on an
**installed iOS PWA**. That cannot be done from this sandbox; it is an owner
task like the ones in §3.

---

## 6. Deliberate debts

Small, known, and left alone on purpose. None of them block Phase 5.

| Item                                                                                                                                                                                       | Where                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| No map labels — needs a self-hosted glyph endpoint, which nothing serves yet                                                                                                               | `packages/web/src/map/ink-style.ts`    |
| Section 8.1's hatch/stipple texture is approximated with low-opacity fills                                                                                                                 | same                                   |
| Section 7.3's "buildings and minor streets only where revealed" is not built                                                                                                               | same                                   |
| Avatar SVGs contain float artefacts (`stroke-width="1.7999999999999998"`)                                                                                                                  | `packages/shared/src/avatar.ts`        |
| Avatar renders very small on `/app`                                                                                                                                                        | `packages/web/src/screens/AppHome.tsx` |
| `PASSWORD_MIN_LENGTH` is 8, chosen by an executor because the spec names no value                                                                                                          | `packages/shared/src/config.ts`        |
| The seeded admin cannot use the security-question reset — placeholder question, hash of random bytes. Its recovery path is the environment.                                                | `packages/api/src/db/seed-admin.ts`    |
| Section 9.4 still describes `trustProxy` as "restricted to the Docker network" — that is the old two-container topology; the code trusts exactly one hop, correct for the platform's Caddy | `SPEC.md` §9.4                         |

---

## 7. Things that bit, so they do not bite again

Each of these cost a round trip and each looked correct on first reading.

- **`trustProxy` must be `1`, never `true`.** With `true` Fastify takes the
  left-most `X-Forwarded-For` entry, which the client controls, so anyone can
  mint a fresh rate-limit bucket per request. A test fails if this is changed.
- **The reset-question decoy took three attempts.** The lookup and the decoy
  must normalise the username identically — the column is `COLLATE NOCASE`, so
  any difference in case or whitespace handling between them reopens an
  account-enumeration oracle. Both earlier attempts passed their own tests.
- **Verify security properties by executing the attack**, not by reading the
  diff. Both decoy defects were found by curling a real server, never by
  reviewing code and never by trusting a green suite.
- **`revealVersion` was serving two questions.** It only incremented when a
  sample revealed new cells, so a bar discovered in already-revealed ground
  produced no marker. Split into `revealVersion` and `discoveryVersion`. The
  same shape of bug is easy to reintroduce in Phase 5: visit updates are a
  third signal, not a reuse of either.
- **`pnpm deploy` needs `--legacy`** under pnpm 10, and `allowBuilds` must stay
  out of `pnpm-workspace.yaml` — it makes pnpm invoke `node-gyp`, and
  `node:22-bookworm-slim` has no compiler. `better-sqlite3` ships arm64
  prebuilds and declares no install script.
- **`bars.submitted_by` has no `ON DELETE` clause.** Account deletion nulls it
  inside the same transaction; without that the delete fails outright once a
  user has submitted a bar.
- **The container rolled the worktree back twice**, losing 4 and then 6
  commits. Both were recovered with `git fetch` + `git merge --ff-only
origin/main`. Push every step immediately; do not batch commits.
- **Commit messages with embedded double quotes break shell quoting.** Use
  `git commit -F <file>` with a heredoc.

---

## 8. How the previous sessions worked

The owner ran them as a planner-and-reviewer loop: the lead session planned and
verified but wrote no code itself, delegating each step to a subagent under a
fixed executor contract, then re-ran every verification command independently
and read the diff before committing. Steps were sequential, one delegation
each, and a step was never accepted on the strength of its report.

Two habits from that loop are worth keeping regardless of whether the contract
is used again:

- **Mutation-test a new guard.** After adding an assertion, break the
  production code it covers and confirm the test actually fails. Several
  green-looking tests here turned out to assert nothing until this was done.
- **Never accept green achieved by weakening a test.** If a fixture changes
  under a test — as `bars.json` did to the "no bars.json present" test — the
  test moves to a fixture that still exercises the old path, rather than
  losing the assertion.

That is a preference, not a repository rule. Ask before assuming it applies.
