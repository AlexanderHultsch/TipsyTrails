# Handover — state of play before Phase 6

For the next Claude Code session. Written at the end of the session that
completed Phase 5.

`SPEC.md` is the source of truth; `CLAUDE.md` holds the guardrails. This file
only records where things stand, what is deliberately unfinished, and what to
do first. Replace it when Phase 6 is done — it is a note between sessions, not
project documentation.

---

## 1. Current state

|                       |                                                            |
| --------------------- | ---------------------------------------------------------- |
| Repository            | `AlexanderHultsch/TipsyTrails`, branch `main`              |
| Local clone directory | `Tipsy-Trails` — stale name, do not rename, it is cosmetic |
| Phases complete       | 0–5 (with the gaps in §3, which need the owner)            |
| Phase 6               | not started                                                |
| Tests                 | 504 green — shared 117, api 258, web 129                   |
| Spec version          | 1.5                                                        |

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

## 2. What Phase 5 built

Check-in and mastering, in five parts: the Section 7.5 rules as a pure module
in `packages/shared/src/visits.ts`; `POST /api/visits` and
`GET /api/visits/pending`; visit evaluation inside `POST /api/samples`, which
now returns `visitUpdates`; the maintenance tick in
`packages/api/src/maintenance.ts`; and the web UI — check-in affordance,
pending banner, out-of-range message, explainer, mastered confirmation.

Three things are worth knowing before you touch any of it.

- **`confirmed_s` is measured from `started_at`**, not between successive
  samples. Section 5.7 says so in as many words. It is derived from
  request-arrival time rather than each sample's client timestamp, because
  Section 7.2 mandates server time for persisted timestamps;
  `SAMPLE_MAX_AGE_MS` bounds the resulting slack at ten minutes, well inside
  the leave-and-return trade-off Section 7.5 already accepts in writing.
- **`isVisitComplete`'s `onsite_samples` condition is unreachable through the
  sample handler.** Check-in seeds the row with 1 and the increment always
  precedes the check, so the count is at least 2 at every evaluation. The
  api-level test that covers it drives the row into that state directly and is
  therefore defence-in-depth against a future second writer or a raised
  `VISIT_MIN_ONSITE_SAMPLES` — not coverage of anything a client can reach. The
  rule itself is tested where it lives, in `packages/shared/src/visits.test.ts`.
  Do not mistake "unreachable" for "untested", or the reverse.
- **The pending banner's countdown is wall-clock-derived**, not taken from the
  server's last reported `confirmed_s`, which would freeze between sample
  posts. The two diverge only while the player is out of range or offline — and
  the out-of-range case says so on the same row.

Push is optional and off unless configured; see §3.

---

## 3. What needs the owner, not an agent

None of this can be closed from the sandbox. Carried forward, all still open.

| Item                                                            | Blocked on                                                              |
| --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Karlsruhe renders in the ink style on a mid-range Android phone | the PMTiles extract, and a phone                                        |
| Pan and zoom hold ≥ 50 fps; the fog layer holds ≥ 50 fps        | same — unmeasurable in this sandbox                                     |
| Tiles cached at the edge (`cf-cache-status: HIT`)               | the Cloudflare Cache Rule for `/tiles/*` (Section 4.1), not yet created |
| The 2D canvas fallback renders correctly with WebGL2 disabled   | no GPU/WebGL here; the fog shader has **never been compiled**           |
| Push delivery on Android and on an installed iOS PWA            | no browser, no push service, no device                                  |
| The first real `docker build`                                   | no Docker daemon here                                                   |

**Push configuration.** Three optional variables in the Pi's
`apps/tipsy-trails/.env`: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
`VAPID_SUBJECT`. Without them the container boots normally and logs once that
push is off; with some but not all of them it warns about a partial
configuration. **Never write a key value into this file, `.env.example`, a
test, or a comment** — `.env` is gitignored and `.env.example` documents names
and shapes only (CLAUDE.md). Generate a keypair with `web-push`'s
`generateVAPIDKeys()` or an equivalent P-256 generator.

**Build the tile extract on the Pi** — roughly 1–2 hours, unblocks the first
three rows above:

```
curl -LO https://github.com/onthegomap/planetiler/releases/latest/download/planetiler.jar
java -Xmx4g -jar planetiler.jar --download --area=baden-wuerttemberg \
  --bounds=8.2750,48.9400,8.5600,49.0950 \
  --output=karlsruhe.2026-08.pmtiles --force
```

It belongs on the mounted data volume, in the directory the container reads as
`TILES_DIR` (default `/data/tiles`). The filename must match
`CONFIG.TILES_FILENAME`, so a regenerated extract bypasses the edge cache.
`data/tiles/` is gitignored; Section 13.2 publishes the file as a GitHub
Release asset.

**The fog shader has never executed.** Its layer class is tested against a
hand-built fake GL object, which proves the call sequence and nothing about the
GLSL. Treat the first render on a real device as the actual test, and say so
rather than reporting Phase 3 as fully verified.

Two questions are still outstanding with the platform chat:

1. What does `admin: yes|no` in `sites.conf` actually do? If it only injects
   shared `ADMIN_USERNAME`/`ADMIN_PASSWORD`, `yes` is fine. If it writes into a
   shared user table, use `no` — this app has its own `users` table.
2. Does the Cloudflare route for `tipsytrails.ahultsch.com` point at the
   platform's Caddy?

---

## 4. Deployment — read before touching Docker

The Pi runs a **multi-site platform** maintained in a different repository and
a different chat. One container per site, listening on `PORT`, with its SQLite
path in `DB_PATH`, behind the platform's own Caddy. This repository's
`docker-compose.yml` and `caddy/Caddyfile` are the **standalone** self-hosting
path and are not what runs on the Pi.

Required in `apps/tipsy-trails/.env`:

```
PUBLIC_ORIGIN=https://tipsytrails.ahultsch.com
SESSION_SECRET=<at least 32 characters>
```

Those two are the only variables the container refuses to start without, and
that must stay true. Optional: `ADMIN_USERNAME`, `ADMIN_PASSWORD` (seeded once
on first boot with `must_change_password`; seeding never touches an existing
user), `SEED_DIR`, `TILES_DIR`, and the three `VAPID_*` above.

**The Docker image has still never been built.** Every image change has been
verified by assembling the runtime layout by hand (`pnpm deploy --prod
--legacy` plus `dist`, `migrations`, `public`, `data/seed`, `data/cities`) and
booting the server from it. That boot is real and passes; `docker build` itself
remains unproven. `packages/api/src/docker-image.test.ts` asserts the Dockerfile
copies every directory the server reads at boot — it exists because a missing
`data/cities` crashed the container while all tests were green.

---

## 5. Phase 6 — next

Scope from Section 12: the profile, the badge shelf, the leaderboard with
metric and period switching, the anonymity toggle, and the badge evaluation
job. Endpoints in Section 9.2: `GET /api/leaderboard`, `GET /api/profile/:handle`,
`PATCH /api/settings`. Rules in Sections 7.6–7.8; the badge table is Section
5.8.

It needs **no external data** and nothing from the owner — it can be built end
to end from what is already in the repository.

Three things to get right, because the spec is specific and easy to skim past:

- **Badges are activity floors, not competitive targets.** Section 7.1's
  `BADGE_THRESHOLDS` comment says so explicitly, and explains why the numbers
  are deliberately not linear across periods. Award at `value >= threshold`,
  minimum and not "strictly greater".
- **ISO-8601 week numbering**, Monday-based, week 1 containing the first
  Thursday. Period boundaries are computed in `Europe/Berlin` and then
  converted to UTC seconds. Section 5.8 says there is **one** helper for this
  in `packages/shared` and that no route computes boundaries itself —
  `berlin-time.ts` is where it belongs.
- **Section 9.5 governs the profile and the leaderboard.** Read it before
  designing either. The anonymity toggle is not decoration.

Badge evaluation runs on boot if the most recently closed period was missed
(Section 7.9), the same self-healing posture the maintenance tick already has.
`runMaintenanceTick` is the precedent worth copying: it takes `nowS` as a
parameter, never reads the clock itself, and is a pass over current state
rather than a step forward from the last run.

---

## 6. Deliberate debts

Small, known, left alone on purpose. None block Phase 6.

| Item                                                                                          | Where                                  |
| --------------------------------------------------------------------------------------------- | -------------------------------------- |
| No map labels — needs a self-hosted glyph endpoint, which nothing serves yet                  | `packages/web/src/map/ink-style.ts`    |
| Section 8.1's hatch/stipple texture is approximated with low-opacity fills                    | same                                   |
| Section 7.3's "buildings and minor streets only where revealed" is not built                  | same                                   |
| `push-sw.js` is a hand-written static file; no `vite-plugin-pwa` is wired up                  | `packages/web/public/push-sw.js`       |
| Avatar SVGs contain float artefacts (`stroke-width="1.7999999999999998"`)                     | `packages/shared/src/avatar.ts`        |
| Avatar renders very small on `/app`                                                           | `packages/web/src/screens/AppHome.tsx` |
| `PASSWORD_MIN_LENGTH` is 8, chosen by an executor because the spec names no value             | `packages/shared/src/config.ts`        |
| The seeded admin cannot use the security-question reset; its recovery path is the environment | `packages/api/src/db/seed-admin.ts`    |

---

## 7. Things that bit, so they do not bite again

Each cost a round trip. Each looked correct on first reading.

- **The first `POST /api/visits` returned a stale pending visit.** Expiry was
  evaluated lazily on the read path only, so a visit six hours dead still
  matched `status = 'pending'` and was handed back — with its old `started_at`,
  unable to ever complete. All nine of that implementation's own tests passed.
  It was found by executing the path, not by reading the diff, and only because
  the check-in route was tried before the pending-poll route. Both handlers now
  evaluate expiry.
- **Verify security and correctness properties by executing them.** This is the
  third time on this project that a green suite hid a real defect — the
  reset-question decoy took three attempts, `revealVersion` served two
  questions at once, and now this. Mutation-test any guard you add: break the
  code it covers and confirm the test fails. Several tests here asserted
  nothing until that was done.
- **`trustProxy` must be `1`, never `true`.** With `true` Fastify takes the
  left-most `X-Forwarded-For` entry, which the client controls, so anyone can
  mint a fresh rate-limit bucket per request. A test fails if this changes.
- **The reset-question decoy and the lookup must normalise the username
  identically.** The column is `COLLATE NOCASE`; any difference in case or
  whitespace handling between them reopens an account-enumeration oracle.
- **`pnpm deploy` needs `--legacy`** under pnpm 10, and `allowBuilds` must stay
  out of `pnpm-workspace.yaml` — it makes pnpm invoke `node-gyp`, and
  `node:22-bookworm-slim` has no compiler. `better-sqlite3` ships arm64
  prebuilds and declares no install script.
- **`bars.submitted_by` has no `ON DELETE` clause.** Account deletion nulls it
  inside the same transaction; without that the delete fails outright once a
  user has submitted a bar.
- **The container rolled the worktree back twice**, losing 4 and then 6
  commits, recovered with `git fetch` + `git merge --ff-only origin/main`. Push
  every step immediately; do not batch commits.
- **Commit messages with embedded double quotes break shell quoting.** Use
  `git commit -F <file>` with a heredoc.

---

## 8. How these sessions have worked

The owner runs them as a planner-and-reviewer loop: the lead session plans and
verifies but writes no code itself, delegating each step to a subagent under a
fixed executor contract, then re-running every verification command
independently and reading the diff before committing. Steps are sequential, one
delegation each, and a step is never accepted on the strength of its report.

Two habits from that loop are worth keeping regardless of whether the contract
is used again:

- **Mutation-test every new guard**, as above.
- **Never accept green achieved by weakening a test.** When a fixture changes
  under a test, move the test to a fixture that still exercises the old path
  rather than losing the assertion.

A third, learned in Phase 5: **ask the executor whether the thing it just
tested is reachable.** One test here passed while guarding a branch no request
can produce. That is legitimate defence-in-depth, but only if it is written
down as such — otherwise the next reader counts it as coverage it is not.

That is a preference, not a repository rule. Ask before assuming it applies.
