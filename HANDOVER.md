# Handover — from feature-complete to running

For the next Claude Code session, and for the owner. Written after the
session that completed Phase 8 — the last phase in `SPEC.md` Section 12's
plan. There is no Phase 9. The frame this file used to write in, "before
Phase N", no longer applies: every phase is built, and what remains is not
more building but the operational work of actually running this on the Pi,
plus the handful of spec items nobody has built at all (Section 3 below).

`SPEC.md` is the source of truth (now v1.11); `CLAUDE.md` holds the
guardrails. This file only records where things stand, what is deliberately
unfinished, and what to do first. Keep it current rather than replacing it
wholesale again — there is no next phase to write it "before" any more.

---

## 1. Current state

|                       |                                                            |
| --------------------- | ---------------------------------------------------------- |
| Repository            | `AlexanderHultsch/TipsyTrails`, branch `main`              |
| Local clone directory | `Tipsy-Trails` — stale name, do not rename, it is cosmetic |
| Phases complete       | All eight (0–8)                                            |
| Tests                 | 719 green — shared 165, api 353, web 201                   |
| Spec version          | 1.11                                                       |

Everything was committed and pushed at handover.

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
`pretest`/`pretypecheck` rebuild of `packages/shared` (SPEC.md v1.6
changelog) — `prepare` covers a fresh clone, the two `pre*` hooks cover an
edit mid-session. Running a single package's tests directly
(`pnpm --filter @tipsytrails/api test`) still bypasses both and can read a
stale `dist`; that gap is accepted, not missed.

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
owner can make. In dependency order — independent steps can proceed even if
an earlier one is stuck:

1. **The tile extract onto the Pi.** Independent of everything else here.
   Built and measured at 9.4 MB, sitting on the owner's laptop as
   `karlsruhe.2026-08.pmtiles`; copy it into the Pi's `TILES_DIR`, nothing
   more to build. `scripts/extract-tiles.sh` can regenerate it but has never
   been run end to end.
2. **The Cloudflare Cache Rule for `/tiles/*`.** Independent of everything
   else here. Without it Cloudflare never caches `.pmtiles` and every range
   request reaches the Pi.
3. **`PUBLIC_ORIGIN`, `PORT`, `DB_PATH` in the platform's own
   `docker-compose.yml`**, this site's `environment:` block (exact values in
   `SPEC.md` Section 4.3). Independent of 1–2. `deploy.sh` never writes
   these and the app refuses to boot without `PUBLIC_ORIGIN` — has to be in
   place before the site can come up at all.
4. **Prove the `docker build` in isolation before adding this site to
   `sites.conf`.** This repository's root `Dockerfile` has never been built
   anywhere, not even in this sandbox — every image change so far was
   verified by hand-assembling the runtime layout and booting the server
   from it, not by the real build. `deploy.sh` builds every site on the Pi
   in one pass under `set -euo pipefail`, and `docker compose up -d --build`
   carries no `||`: a failing build here aborts the whole deployment run —
   every other site's rebuild included. Build and boot the image on its own
   first. Blocks step 5.
5. **Register the site in all three files and let `deploy.sh` run.**
   Depends on 3 and 4. A line in `sites.conf` is not enough on its own: the
   service block in the platform's `docker-compose.yml` and the host block
   in its `config/caddy/Caddyfile` are equally required, and `sites.conf` is
   maintained only on the platform checkout's `env` branch. All three blocks
   are written out ready to copy in `SPEC.md` Section 4.3. Then confirm
   `npm run seed:admin` actually succeeded against the real container —
   nothing else will tell you, because `deploy.sh` runs it as
   `... || echo "  WARN: seed:admin fehlgeschlagen"` and a failure only
   prints that warning while the deploy reports success. It is idempotent,
   exits zero when there is nothing to do, and never resets a changed
   password (`packages/api/src/db/seed-admin-cli.ts`), but it has only ever
   run in tests so far.
6. **Open Item O10 — measure `trustProxy`'s real hop count.** Depends on 5:
   needs one real request over the public internet against the live
   deployment (`SPEC.md` Section 9.4 has the exact procedure). Until it's
   measured and `trustProxy` set to match, the rate limits cannot be relied
   on for the Pi deployment — the chain in front of the app is longer than
   one hop and nobody has counted how many of them append to
   `X-Forwarded-For`. Do the one-off header log the section describes and
   stop there: this must not become a reason to start logging client IPs on
   an ongoing basis, which Section 10.2's data minimisation exists to
   prevent.

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

---

## 3. What nobody has built yet

Spec items with no code behind them at all, as distinct from the debts in
Section 5 (which are built, just imperfectly).

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

Small, known, left alone on purpose.

| Item                                                                                                        | Where                                  |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| No map labels — needs a self-hosted glyph endpoint, which nothing serves yet (Section 3 above)              | `packages/web/src/map/ink-style.ts`    |
| Section 8.1's hatch/stipple texture is approximated with low-opacity fills                                  | same                                   |
| Section 7.3's "buildings and minor streets only where revealed" is not built (Section 3 above)              | same                                   |
| Avatar SVGs contain float artefacts (e.g. a computed `stroke-width` with a long float tail)                 | `packages/shared/src/avatar.ts`        |
| Avatar renders very small on `/app`                                                                         | `packages/web/src/screens/AppHome.tsx` |
| `PASSWORD_MIN_LENGTH` is 8, chosen by an executor because the spec names no value                           | `packages/shared/src/config.ts`        |
| The seeded admin cannot use the security-question reset; its recovery path is the environment               | `packages/api/src/db/seed-admin.ts`    |
| The map picker has no keyboard-only path — carried forward through Phase 8's accessibility pass, still open | `packages/web/src/map/MapPicker.tsx`   |
| Admin create/edit forms take latitude and longitude as plain numbers, not a picker — same                   | `packages/web/src/screens/Admin.tsx`   |

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
