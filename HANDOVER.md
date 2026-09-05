# Handover — from feature-complete to running

For the next Claude Code session, and for the owner. Written after the
session that completed Phase 8 — the last phase in `SPEC.md` Section 12's
plan of what runs on the Pi. There is now a Phase 9, the iPhone companion
specified in full in `ios/SPEC.md`, and nothing of it is built. The frame
this file used to write in, "before Phase N", no longer applies to Phases
0–8: every one of them is built, and what remains for the site itself is not
more building but the operational work of actually running this on the Pi,
plus the handful of spec items nobody has built at all (Section 3 below).

`SPEC.md` is the source of truth; `CLAUDE.md` holds the guardrails. The spec
version this file was last checked against is in the table below, stated in
exactly one place and pinned there by `packages/shared/src/spec-version.test.ts`
— it said "now v1.11" here for forty-one versions, in a second copy nothing
could check. This file only records where things stand, what is deliberately
unfinished, and what to do first. Keep it current rather than replacing it
wholesale again — there is no next phase to write it "before" any more.
`CLAUDE.md` requires that a change which falsifies a rule stated here updates
this file in the same commit.

---

## 1. Current state

|                       |                                                            |
| --------------------- | ---------------------------------------------------------- |
| Repository            | `AlexanderHultsch/TipsyTrails`, branch `main`              |
| Local clone directory | `Tipsy-Trails` — stale name, do not rename, it is cosmetic |
| Phases complete       | All eight (0–8)                                            |
| Spec version          | 1.64                                                       |

The test count used to sit in that table and is deliberately gone: it moved on
almost every commit, no test could pin it without failing constantly for no
signal, and a number nothing checks is a number that goes wrong quietly.
`pnpm test` prints the current one. The spec version stays because it changes
rarely and is now asserted.

Everything was committed and pushed at handover.

### Verification commands — all four must pass before anything is "done"

```
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
```

`pnpm install` runs a `prepare` hook that builds `packages/shared` and then
`packages/api`. Do not remove either: `packages/api` and `packages/web`
import `@tipsytrails/shared`, and since v1.60 `packages/api` is itself
imported by name — `packages/tracker` declares it for `ios/SPEC.md` 13.2's
replay harness — each through a gitignored `dist`. Without the hook a
fresh clone silently runs a subset of the api package's tests while still
printing a passing summary. `pnpm test` and `pnpm typecheck` also each carry
their own `pretest`/`pretypecheck` rebuild of the same two (SPEC.md v1.6 and
v1.60 changelogs) — `prepare` covers a fresh clone, the two `pre*` hooks
cover an edit mid-session. The order matters and is `shared` then `api`,
because building `api` reads `shared`'s `dist`. Running a single package's
tests directly (`pnpm --filter @tipsytrails/api test`) still bypasses both
and can read a stale `dist`; that gap is accepted, not missed.

---

## 2. The owner's list — the whole critical path

Three items that used to open this list are closed. Not deleted — recorded
briefly so nobody reopens them:

- **Both platform-chat questions** (what `admin: yes` injects, what
  `deploy.sh` does to `.env`) are answered: the owner pasted the platform's
  real `sites.conf`, `deploy.sh`, `docker-compose.yml` and Caddyfile off the
  running Pi on 2026-08-19, and `SPEC.md` Section 4.3 is written from those
  files (v1.11 changelog). The repository itself was never readable from any
  session here — v1.10 claimed it had been read directly, which was false and
  is what let several wrong details stand for a version.
- **VAPID key provisioning** is no longer a manual step. Keys generate
  themselves on first boot and persist beside the database (Section 5.9).
  Leave the three `VAPID_*` variables unset on the Pi.

**Before running anything on the Pi: `deploy.sh --fresh` deletes the data
volume.** That volume is this app's database and its tile extract — every
account, all fog progress, every mastered bar, and now the VAPID key file
too (Section 4.3). There is no separate backup beyond whatever C7's existing
Pi backup job covers. `--fresh` against this site is data loss, not a reset.

Nothing below is buildable from this sandbox. Every item needs either the
owner's own environment (the Pi, a phone, a browser) or a decision only the
owner can make. The numbers are stable identities — `SPEC.md` Section 12 cites
several of them — so they stay as they are and each entry opens with its
status instead.

**Where it stands.** Of the deployment items, **4, 5 and 6 are closed and 3 is
closed in the part that matters** (below). **1, 2 and one half of 5 are open**:

- **1, the tile extract**, is blocked on nothing and blocks the most — without
  it `/tiles/*` answers the Section 13.2 error, the map has no basemap, and
  item 2 has nothing to cache. Do it first.
- **2, the Cloudflare Cache Rule**, is blocked on nothing either, but it is
  only worth checking once 1 has landed, because there is nothing at the edge
  to produce a `cf-cache-status: HIT` until then.
- **The admin sign-in carried by 5** is blocked on nothing. One sign-in
  settles whether the account exists; nothing here can tell.

**7–14 need a device, a browser or the Pi under load** and are not on the
critical path — the site runs without any of them being answered.

Everything recorded below about the Pi was observed on **2026-08-19** and
nothing in this repository can see the Pi now. Treat it as a record of that
day, not as the current state of the machine, and re-check anything a decision
rests on.

1. **Open. The tile extract onto the Pi.** Independent of everything else here.
   Built and measured at 9.4 MB, sitting on the owner's laptop as
   `karlsruhe.2026-08.pmtiles`; copy it into the Pi's `TILES_DIR`, nothing
   more to build. `scripts/extract-tiles.sh` can regenerate it but has never
   been run end to end.
2. **Open. The Cloudflare Cache Rule for `/tiles/*`.** Independent of
   everything else here. Without it Cloudflare never caches `.pmtiles` and
   every range request reaches the Pi. Nothing to verify until item 1 puts an
   extract on the volume.
3. **Done for the two variables that matter; `PORT` undetermined —
   `PUBLIC_ORIGIN`, `PORT`, `DB_PATH` in the platform's own
   `docker-compose.yml`**, this site's `environment:` block (exact values in
   `SPEC.md` Section 4.3). `deploy.sh` never writes these; they were always
   manual. This entry is closed by inference rather than by anyone reading
   that file, and the inference is stated so it can be checked:
   `packages/api/src/env.ts` gives **neither** `PUBLIC_ORIGIN` nor
   `DATABASE_PATH`/`DB_PATH` a default, so the process cannot start without
   both — and item 5 records it started and served. Item 4's first-deploy
   crash on `mkdir '/data/db'` says the same thing from the other side:
   `docker-entrypoint.sh` creates that directory only when one of the two
   database variables is set. **`PORT` is not established by any of that.**
   `API_PORT` defaults to 3000, so the listening port in item 5's log line is
   exactly what an unset `PORT` would also produce, and the Caddy block
   proxies to 3000 either way. Nothing turns on the difference; if the block
   is ever edited, set all three as Section 4.3 shows.
4. **Done — the image builds and runs on the Pi, at the cost of one crash
   loop.** The root `Dockerfile` builds on the Pi's own arm64: `gosu`
   installs cleanly (`gosu 1.14-1+b10 arm64`) and the web build runs there
   too (`vite build`, `✓ built in 1.39s`). The first deploy then
   crash-looped on `EACCES: permission denied, mkdir '/data/db'`, exactly
   as predicted — the platform's `~/pi-server/data/` is root-owned, so a
   container running as `node` cannot create its own database directory.
   Commit `7626ecb` starts the container as root, prepares and chowns
   `/data`, then drops to `node` with `gosu`; the next deploy came up and
   stayed up, with `COMMAND` showing the entrypoint.
5. **Done — the site is registered and serving; two things it did not close,
   one of which is still open here.** All three blocks are on the Pi, and the container answers over
   the public internet: `curl -s https://tipsytrails.ahultsch.com/api/health`
   returns `{"status":"ok"}`, a real browser loaded the whole PWA shell over
   that hostname (`/`, the hashed CSS and JS, `manifest.json`, `sw.js`,
   every icon, all 200, plus a 304 on reload), and `/api/auth/me` returns
   401 when signed out. The server logs
   `Server listening at http://172.19.0.3:3000`. Still open, both carried
   by this step rather than closed with it: the tile extract is not on the
   volume, and the app says so in its own log — "Tile extract not found at
   /data/tiles/karlsruhe.2026-08.pmtiles" — which is step 1 above. And,
   **still open, the admin account is unconfirmed.** `deploy.sh`'s seeding loop skips every
   site after the first (a platform bug, reported separately), so
   `npm run seed:admin` never ran against this site at all; boot-time
   seeding in `initialiseDatabase` should have created the account from
   `ADMIN_USER` and `ADMIN_PASSWORD` regardless, but nobody has signed in
   to check. Do that before trusting the admin area exists.
6. **Nothing to do — Open Item O10 is closed, and this entry is kept only
   so nobody starts the work it used to ask for.** It wanted the real
   `X-Forwarded-For` hop count measured against the live deployment so that
   the per-IP rate limits could be trusted. There are no per-IP rate limits
   any more: `SPEC.md` Section 9.4 (v1.46) keys login on the submitted
   username and the password-verifying routes on one global ceiling,
   `by: 'ip'` no longer exists, and `trustProxy` is a list of private ranges
   that decides nothing but the address in Fastify's log lines. Do not log client
   IPs to settle a question that no longer has an answer worth having —
   Section 10.2's data minimisation is the reason.

**Needs a device, a browser, or the Pi under load — cannot be closed from a
sandbox regardless of who is asking:**

7. Real push delivery, on Android and on an installed iOS PWA — the
   once-only, not-while-completed and dead-endpoint rules are tested against
   a faked sender (`packages/api`); the wire to a real push service has never
   been exercised.
8. Install to the home screen, on Android and on iOS.
9. Lighthouse mobile performance ≥ 90.
10. Time to interactive < 3 s on a mid-range Android over simulated 4G.
11. API p95 latency < 150 ms measured on the Pi under 10 concurrent users.
12. Total container memory under load < 400 MB.
13. A screen-reader pass. The automated accessibility checks
    (`packages/web/src/App.a11y.test.tsx`) cover contrast, focus states,
    form labelling, and the accent-colour rule — none of them touch whether
    any of it is announced sensibly, because no screen reader exists here.
14. The WebGL fog shader's first real compile. There is no GPU in this
    sandbox; `packages/web/src/map/fog/webgl-fog-layer.test.ts` exercises the
    layer class's call sequence against a fake WebGL context, which proves
    nothing about the GLSL itself.
15. The baseline walk (`ios/SPEC.md` 13.3, walk 1) — twenty minutes with the
    map on screen, the walked streets revealed and `rejected` all zero — has
    never been run; it needs the owner's iPhone and a built shell.
16. The pocket walk (walk 2) — the phone locked and put away for thirty
    minutes, the streets revealed on next open with no gap except at a
    relaunch — has never been run.
17. The force-quit walk (walk 3) — whether the app is relaunched by a
    location event after being force-quit from the app switcher, the
    question Section 6.4 leaves open — has never been run.
18. The dwell walk (walk 4) — checking in, locking the phone for twenty-five
    minutes, and seeing the visit complete and the bar's glass empty without
    the app having been opened — has never been run.
19. The Low Power Mode walk (walk 5), repeating walk 2 with the flag on to
    compare fixes per hour against it — has never been run.
20. The Precise Location walk (walk 6) — turning it off in Settings and
    confirming the app blocks with zero flushes and prompts once — has never
    been run.

---

## 3. What nobody has built yet

Spec items with no code behind them at all, as distinct from the debts in
Section 5 (which are built, just imperfectly).

Re-read against the code at v1.57, after the blocks that produced v1.46–v1.56:
all three rows are still true and none of that work touched them. There is no
`@font-face` rule anywhere under `packages/web/src` — `--font-serif` and
`--font-sans` are still system stacks; `packages/web/src/map/ink-style.ts`
still declares no symbol layer, and says in a comment why; and no style layer
in it is filtered by the fog mask.

| Item                                                            | Needs                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Self-hosted fonts (Section 8.2)                                 | Subsetted Latin `@font-face` files for the serif/sans pair. Currently system stacks only — `--font-serif` and `--font-sans` in `packages/web/src/index.css` resolve to `Georgia, ...` and `system-ui, ...`; there is no `@font-face` rule anywhere in the app. Required by C3 (no CDN-hosted fonts) once real font files are added. |
| Map labels                                                      | A self-hosted glyph endpoint serving PBF glyphs for MapLibre's text rendering. Depends on the fonts above existing first — there is nothing to generate glyphs from otherwise. Nothing serves one yet; `packages/web/src/map/ink-style.ts` renders no text layers.                                                                  |
| Section 7.3's "buildings and minor streets only where revealed" | Not built. The fog currently gates the whole basemap the same way regardless of feature class; restricting buildings and minor streets specifically to revealed area needs style-layer filtering keyed to the fog mask, which nothing in `ink-style.ts` does today.                                                                 |

---

## 4. What Phase 8 built, and two things a reader must not undo

PWA manifest and install meta, the merged service worker, the offline shell,
the offline sample queue, the per-user fog cache, the `/privacy` page, the
own-position marker, the accessibility pass, and user-facing messages for
network failures. Full detail is in `SPEC.md`'s v1.8 changelog entry
(Section 15); two of those decisions are easy to accidentally reverse and
must not be:

- **One service worker, not two.** `packages/web/public/sw.js` now owns both
  the offline shell and Web Push; `push-sw.js` is gone. Both registration
  sites — the eager shell registration on app start and
  `usePushSubscription`'s `enable()` — import the same `SERVICE_WORKER_URL`
  constant from `packages/web/src/sw/register.ts`. Registering a second
  service worker file at the same scope, for any reason, silently replaces
  whichever one loses the race — do not reintroduce a second file, and do
  not give push its own URL again.
- **The fog cache is keyed per user and cleared on logout.**
  `packages/web/src/map/fog/fog-cache.ts` keys its `localStorage` entry by
  user id, and `auth/useLogout.ts` clears the current user's entry on sign
  out. An unkeyed cache here is not a style nit — on a shared device it means
  the next account to sign in, offline, sees the previous account's revealed
  fog: their walked-through movement history, drawn as a map, in violation of
  the spirit of Section 10.2's data minimisation even though nothing server-
  side changed. Do not go back to one shared cache entry, even if a future
  feature makes keying feel like unneeded complexity.

---

## 5. Deliberate debts

Small, known, left alone on purpose. Every row was checked against the file it
names at v1.57 and all eight still hold — the work behind v1.46–v1.56 closed
none of them, and none of them is now wrong.

| Item                                                                                                        | Where                                |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| No map labels — needs a self-hosted glyph endpoint, which nothing serves yet (Section 3 above)              | `packages/web/src/map/ink-style.ts`  |
| Section 8.1's hatch/stipple texture is approximated with low-opacity fills                                  | same                                 |
| Section 7.3's "buildings and minor streets only where revealed" is not built (Section 3 above)              | same                                 |
| Avatar SVGs contain float artefacts (e.g. a computed `stroke-width` with a long float tail)                 | `packages/shared/src/avatar.ts`      |
| `PASSWORD_MIN_LENGTH` is 8, chosen by an executor because the spec names no value                           | `packages/shared/src/config.ts`      |
| The seeded admin cannot use the security-question reset; its recovery path is the environment               | `packages/api/src/db/seed-admin.ts`  |
| The map picker has no keyboard-only path — carried forward through Phase 8's accessibility pass, still open | `packages/web/src/map/MapPicker.tsx` |
| Admin create/edit forms take latitude and longitude as plain numbers, not a picker — same                   | `packages/web/src/screens/Admin.tsx` |

"Avatar renders very small on `/app`" is dropped for a different reason: it is
false. v1.32 rebuilt `/app` into the start screen of Section 8.3 and it draws
no avatar at all — `packages/web/src/screens/AppHome.tsx` does not import
`components/Avatar.tsx`, and the only screens that render an avatar are the
leaderboard and the profiles. The debt pointed at a file that no longer holds
the thing complained about.

`scripts/extract-tiles.sh` (previously listed here as missing) was written
this session — dropped from the table, not because the pipeline it drives has
been run end to end (it hasn't; Section 2, item 1), but because the debt was
specifically the script's absence, and that absence is closed.

The map picker's missing keyboard path and the admin lat/lon plain-number
inputs were flagged in the Phase 7 handover as natural candidates for Phase
8's accessibility pass to close. It did not touch either — the pass built
contrast, focus-ring, form-labelling and accent-rule coverage (Section 4
above) but left both of these as they were. Recorded here rather than
silently dropped.

---

## 6. What Phase 7 built (kept for context — still true, still load-bearing)

Suggest-a-bar (map pin, name, address), the duplicate guard, the community
marker, and the admin area (bar management, user list). Three things a
future reader needs before touching any of it:

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
`bars.status`, a gap open since Phase 4 and only closed once admins had a
way to hide a bar at all (SPEC.md v1.7 changelog). The leaderboard and badge
queries still deliberately ignore bar status: mastering is permanent once
completed, and hiding a bar afterwards must not revoke it. That is a rule,
not an oversight — do not "fix" it by adding a status join there.

---

## 7. Things that bit, so they do not bite again

Each cost a round trip. Each looked correct on first reading.

- **A promise about what is _rendered_ is not a promise about what is
  _shipped_.** SPEC.md Section 7.7 said the badge thresholds are never shown
  to a user and never returned by an endpoint. Both were true, and both were
  worthless: `CONFIG` is one object literal, `packages/web` imports it as a
  value in twelve modules, so the six floors sat in the production bundle in
  plaintext from v1.31 to v1.53 and read out of devtools in seconds. Nothing
  in the suite could see it, because every test in it reads source, and this
  was a property of the build. The fix (v1.54) is a second constants module
  behind a `./server` subpath; the _proof_ is
  `packages/web/src/bundle.test.ts`, which builds the real bundle and greps
  it. **When a rule is about what reaches the client, test the artefact the
  client gets** — a test that asserts "no file imports X" is a test of the
  import graph, and the import graph is not the deliverable.
- **And building the artefact from inside a test does not, by itself, build
  the artefact.** The same file called Vite's `build()` with no `NODE_ENV`
  of its own, and Vitest sets `NODE_ENV=test`; Vite's `isProduction` is
  `(process.env.NODE_ENV || mode) === 'production'`, so from v1.53 to v1.57
  what it built and grepped was React's _development_ bundle — `jsxDEV`,
  invariant strings, 138.1 kB gzipped in the shell where `pnpm build` emits
  82.0 kB. Harmless for a grep and fatal for a size, which is how v1.58 found
  it while adding the app-shell budget. The build now stubs
  `NODE_ENV=production` for its own duration and comes out with the same
  chunk hashes `pnpm build` does. **A build in a test inherits the test
  runner's environment; say what you mean about the environment.**
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
- **The privacy page overclaimed twice, and once more understated a
  service.** Found while re-reading Section 10.3 against the actual code for
  Phase 8 (SPEC.md v1.8 changelog): OpenStreetMap was described as a runtime
  dependency when the app's own `/tiles/*` route is what the browser actually
  talks to; account deletion was described as unqualified when C7's backup
  job means a copy can outlive it briefly; and the per-day reveal counters
  were credited only to badges when the leaderboard's week/month filters
  read them too. None of these were caught by a test, because a privacy page
  is prose, not an assertion — verify claims like this by rereading them
  against the code that is supposed to back them, on a schedule, not only
  when something forces the question.
- **Verify security and correctness properties by executing them.** A green
  suite has now hidden a real defect more than once on this project — the
  reset-question decoy took three attempts, `revealVersion` served two
  questions at once, the stale pending visit above, the unfiltered
  `bars.status` above, and the privacy overclaims above. Mutation-test any
  guard you add: break the code it covers and confirm the test fails. Several
  tests here asserted nothing until that was done.
- **`trustProxy` must never be `true`.** With `true` Fastify takes the left-most
  `X-Forwarded-For` entry, which the client controls. Since v1.46 the value is
  `['loopback', 'linklocal', 'uniquelocal']` — a list of private ranges, not the
  hop count it used to be — and no rate limit is keyed on an address any more,
  so what it decides is the address in Fastify's log lines and nothing else. A
  test fails if it changes.
- **The reset-question decoy, the lookup, and the rate-limit bucket key must
  normalise the username identically.** The column is `COLLATE NOCASE`; any
  difference in case or whitespace handling between them reopens an
  account-enumeration oracle, and it broke the per-username rate limit in
  exactly this way at v1.46 — `admin`, `Admin` and `ADMIN` are one account and
  were three buckets, so the limit counted spellings instead of accounts
  (fixed in v1.47).
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
- **Every defect in the platform contract came from describing it
  second-hand instead of reading the real files, and none of them was
  reachable from this repository's own verification loop.** The wrong admin
  variable name (`ADMIN_USERNAME` where the platform injects `ADMIN_USER`) and
  the VAPID keys once slated for a file `deploy.sh` overwrites on every deploy
  would both have produced a deployment that looked complete — container up,
  pages loading — while silently missing an admin account, or silently losing
  push weeks later with no error at any point. `pnpm typecheck`/`lint`/`test`
  cannot catch either: they are compliance with another system's contract, not
  this codebase's own logic. The missing `seed:admin` script would not have
  announced itself either, contrary to what this list said until v1.11:
  `deploy.sh` runs it as `... || echo "  WARN: seed:admin fehlgeschlagen"`, so
  a failure prints one warning and the deploy carries on — a site up and
  serving with no admin account. All three closed only once the owner pasted
  the platform's real files off the Pi (v1.11 changelog). v1.10 had claimed the
  platform repository was read directly; it never was, which is the fourth
  defect of the same kind and the one that hid the others.

---

## 8. How these sessions have worked

The owner runs them as a planner-and-reviewer loop: the lead session plans and
verifies but writes no code itself, delegating each step to a subagent under a
fixed executor contract, then re-running every verification command
independently and reading the diff before committing. Steps are sequential, one
delegation each, and a step is never accepted on the strength of its report.
The same loop produced this documentation-only pass over Phase 8's spec entry,
the README, and this file.

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

A fourth, learned in Phase 8's privacy re-read: **re-verify claims of
absence on a schedule, not only when something forces the question.** "We
don't use X" or "X never happens" is the kind of sentence that quietly goes
stale as code changes underneath it, because nothing about writing new code
prompts a re-read of old prose. Three claims were wrong by the time anyone
looked (Section 7 above); nothing broke to reveal that, a deliberate re-read
did.

That is a preference, not a repository rule. Ask before assuming it applies.
