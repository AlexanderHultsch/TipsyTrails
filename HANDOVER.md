# Handover — state of play before Phase 8

For the next Claude Code session. Written after the session that completed
Phase 7.

`SPEC.md` is the source of truth; `CLAUDE.md` holds the guardrails. This file
only records where things stand, what is deliberately unfinished, and what to
do first. Replace it when Phase 8 is done — it is a note between sessions, not
project documentation.

---

## 1. Current state

|                       |                                                            |
| --------------------- | ---------------------------------------------------------- |
| Repository            | `AlexanderHultsch/TipsyTrails`, branch `main`              |
| Local clone directory | `Tipsy-Trails` — stale name, do not rename, it is cosmetic |
| Phases complete       | 0–7 (with the gaps in §2, which need the owner)            |
| Phase 8               | not started                                                |
| Tests                 | 633 green — shared 165, api 326, web 142                   |
| Spec version          | 1.7                                                        |
| `main` at             | `47c2cbe`                                                  |

Everything is committed and pushed. The working tree was clean at handover.

### Verification commands — all four must pass before anything is "done"

```
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
```

`pnpm install` runs a `prepare` hook that builds `packages/shared`. Do not
remove it: `packages/api` and `packages/web` import `@tipsytrails/shared`,
which resolves to a gitignored `dist`. Without the hook a fresh clone
silently runs a subset of the api package's tests while still printing a
passing summary. `pnpm test` and `pnpm typecheck` also each carry their own
`pretest`/`pretypecheck` rebuild of `packages/shared` now (SPEC.md v1.6
changelog) — `prepare` covers a fresh clone, the two `pre*` hooks cover an
edit mid-session. Running a single package's tests directly
(`pnpm --filter @tipsytrails/api test`) still bypasses both and can read a
stale `dist`; that gap is accepted, not missed.

---

## 2. What needs the owner, not an agent

None of this can be closed from the sandbox. Carried forward unchanged from
the Phase 6 handover — Phase 7 touched none of it.

| Item                                                            | Blocked on                                                              |
| --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Karlsruhe renders in the ink style on a mid-range Android phone | copying the built extract to the Pi (see below), and a phone            |
| Pan and zoom hold ≥ 50 fps; the fog layer holds ≥ 50 fps        | same — unmeasurable in this sandbox                                     |
| Tiles cached at the edge (`cf-cache-status: HIT`)               | the Cloudflare Cache Rule for `/tiles/*` (Section 4.1), not yet created |
| The 2D canvas fallback renders correctly with WebGL2 disabled   | no GPU/WebGL here; the fog shader has **never been compiled**           |
| Push delivery on Android and on an installed iOS PWA            | no browser, no push service, no device                                  |
| The first real `docker build`                                   | no Docker daemon here                                                   |

**The PMTiles extract has been built and sits on the owner's laptop** as
`karlsruhe.2026-08.pmtiles` (9.4 MB, measured, not the 30–80 MB `SPEC.md`
originally estimated). What remains is copying it to the Pi's `TILES_DIR` and
re-testing the map screens there — not building it.

**`scripts/extract-tiles.sh` does not exist.** `packages/api/src/app.ts`
names it in its startup error and Section 4.2 lists it in the repository
tree, but the one real extract was produced by invoking `planetiler` by hand,
not by running this script. Tracked in §5 (deliberate debts).

**Push configuration.** Three optional variables in the Pi's
`apps/tipsy-trails/.env`: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
`VAPID_SUBJECT`. Without them the container boots normally and logs once that
push is off; with some but not all of them it warns about a partial
configuration. **Never write a key value into this file, `.env.example`, a
test, or a comment** — `.env` is gitignored and `.env.example` documents names
and shapes only (CLAUDE.md). Generate a keypair with `web-push`'s
`generateVAPIDKeys()` or an equivalent P-256 generator.

Two questions are still outstanding with the platform chat:

1. What does `admin: yes|no` in `sites.conf` actually do? If it only injects
   shared `ADMIN_USERNAME`/`ADMIN_PASSWORD`, `yes` is fine. If it writes into a
   shared user table, use `no` — this app has its own `users` table.
2. Does the Cloudflare route for `tipsytrails.ahultsch.com` point at the
   platform's Caddy?

---

## 3. Deployment — read before touching Docker

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

## 4. What Phase 7 built

Suggest-a-bar (map pin, name, address), the duplicate guard, the community
marker, and the admin area (bar management, user list). Three things a future
reader needs before touching any of it:

- **Section 11.3's duplicate guard has four readings that were undetermined
  by the spec text, now settled** (SPEC.md v1.7 changelog): the normalized
  Levenshtein ratio is `1 - distance / max(len a, len b)`, short-circuiting
  identical inputs (including both-empty) to 1 before any division; the
  leading-article set covers English and German, since Section 11.3 names the
  suffixes but not the articles; the order of normalisation steps is the
  literal sequence the section's own sentence lists, followed as normative,
  not a free choice; and a name can normalize to nothing (`"The Bar"` loses
  its article, then its remainder is entirely the trailing suffix), so both
  sides of the comparison guard against it.
- **The two empty-name guards in `packages/shared/src/suggest.ts` are
  individually redundant and jointly load-bearing.** Removing either alone
  changes no test's outcome — the candidate-side guard is redundant because a
  ratio against a non-empty string already comes out at 0, and the
  existing-side guard alone still catches the empty-candidate case earlier.
  Removing _both_ fails `packages/shared/src/suggest.test.ts`: `never matches
an existing bar whose name normalizes to the empty string`, because two
  names that both normalize to `""` would otherwise compare as identical.
  Neither guard is dead code — do not delete one as a "simplification" later.
- **The admin menu gate is cosmetic; the 403 is the real boundary.** Hiding
  the "Admin" burger-menu entry from a non-admin (`packages/web`) is a UX
  nicety. The actual authority check is `requireAdmin` in
  `packages/api/src/auth/cookie.ts`, applied to every `/api/admin/*` route
  independently and tested per-route, not just once for the prefix
  (`packages/api/src/routes/admin.test.ts`, describe `admin guard`). Do not
  treat the menu's visibility as the security control.

Also worth knowing: **hidden bars were not actually hidden until this
phase** — `GET /api/bars` and `GET /api/bars/:id` never filtered
`bars.status`, a gap open since Phase 4 and only closed now that admins had a
way to hide a bar at all (SPEC.md v1.7 changelog). The leaderboard and badge
queries still deliberately ignore bar status: mastering is permanent once
completed, and hiding a bar afterwards must not revoke it. That is a rule,
not an oversight — do not "fix" it by adding a status join there.

---

## 5. Deliberate debts

Small, known, left alone on purpose. None block Phase 8 except the
accessibility ones, which Phase 8 exists to close.

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
| `scripts/extract-tiles.sh` does not exist; the one real extract was produced by hand          | `scripts/` (Section 4.2, `app.ts`)     |
| The map picker has no keyboard-only path — Phase 8's accessibility pass                       | `packages/web/src/map/MapPicker.tsx`   |
| Admin create/edit forms take latitude and longitude as plain numbers, not a picker            | `packages/web/src/screens/Admin.tsx`   |

---

## 6. Things that bit, so they do not bite again

Each cost a round trip. Each looked correct on first reading.

- **The verification chain itself was lying.** `packages/api` and
  `packages/web` import `@tipsytrails/shared` through a gitignored `dist` that
  neither `pnpm test` nor `pnpm typecheck` rebuilt — only `prepare` did, and
  `prepare` runs on install, not on an edit. Confirmed by breaking
  `isVisitExpired` to a threshold ten times too large, a change that keeps its
  signature: `pnpm typecheck` reported zero errors and the api suite covering
  visit expiry passed 26 of 26, because the stale `dist` on disk was still the
  old, correct build. This is the most instructive defect in the project so
  far — every other bug here was caught by a test; this one was invisible to
  every test until the harness itself was mutated. `pretest` and
  `pretypecheck` now rebuild `shared` before either command runs (SPEC.md v1.6
  changelog).
- **A city-progress assertion that checked a number's format, not its
  value.** When the city and district overview screens moved from Phase 2's
  invented placeholder numbers onto real `GET /api/progress` data, the
  district assertion was exact and caught a zeroed value as it should; the
  city assertion only checked that the rendered text looked like a percentage
  (`toMatch(/^\d+%$/)`), so the same mutation — the real API figure silently
  replaced by zero — passed clean. Replacing an invented number with an
  unverified one is barely an improvement. Fixed to an exact assertion against
  the stubbed value in the same commit that found it. When a test changes from
  "the app made something up" to "the app used a real value", the assertion
  has to change from "looks plausible" to "is the value", or the migration
  proves nothing.
- **The first `POST /api/visits` returned a stale pending visit.** Expiry was
  evaluated lazily on the read path only, so a visit six hours dead still
  matched `status = 'pending'` and was handed back — with its old `started_at`,
  unable to ever complete. All nine of that implementation's own tests passed.
  It was found by executing the path, not by reading the diff, and only because
  the check-in route was tried before the pending-poll route. Both handlers now
  evaluate expiry.
- **`GET /api/bars` and `GET /api/bars/:id` never filtered `bars.status`.** A
  bar an admin hid stayed visible to every player who had already discovered
  it, from Phase 4 until Phase 7 gave admins a way to hide one at all. Found
  while building the admin area, not by a pre-existing test — nothing in
  Phases 4–6 exercised hiding, so nothing could have caught it earlier. Both
  endpoints now filter to `status = 'active'`.
- **Verify security and correctness properties by executing them.** A green
  suite has now hidden a real defect more than once on this project — the
  reset-question decoy took three attempts, `revealVersion` served two
  questions at once, the stale pending visit above, the unfiltered
  `bars.status` above, and now both entries above it. Mutation-test any guard
  you add: break the code it covers and confirm the test fails. Several tests
  here asserted nothing until that was done.
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

## 7. Phase 8 — next

Scope from Section 12: Hardening and Polish — PWA manifest and install
prompt, offline shell, the `/privacy` page, a performance pass, error states,
empty states, and an accessibility pass. Its Definition of Done is the
longest in the plan and most of it needs a real device or a real Pi under
load; some of it can be built and partly verified from the sandbox.

**Needs the owner or a real device — cannot be closed from here:**

- Install to the home screen on Android and iOS
- Lighthouse mobile performance ≥ 90
- Time to interactive < 3 s on a mid-range Android over simulated 4G
- API p95 latency < 150 ms measured on the Pi under 10 concurrent users
- Total container memory under load < 400 MB

**Buildable and at least partly testable in the sandbox:**

- The PWA manifest and offline shell (Workbox via `vite-plugin-pwa` — the
  gap already named in §5: `push-sw.js` is hand-written and nothing wires
  `vite-plugin-pwa` up yet)
- Queued samples surviving offline and posting on reconnect
- `/privacy`, covering the per-day reveal counters (Section 10.2) and linking
  to `ahultsch.com`'s policy and legal notice
- `prefers-reduced-motion` disabling the dissolve animation and all
  transitions
- The accessibility pass itself: WCAG 2.1 AA contrast, visible focus states,
  labelled form fields, no state carried by the accent colour alone — plus
  the two accessibility debts already on record in §5 (the map picker's
  missing keyboard path, the admin lat/lon inputs) are natural candidates to
  close here rather than defer again
- User-facing messages for every network failure, replacing any silent one

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
