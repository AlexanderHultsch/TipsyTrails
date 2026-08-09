# Contributing

`SPEC.md` is the single source of truth for what this project does and how it
is built. Read it — especially Section 1 (Hard Constraints) and Section 12
(Development Phases) — before opening a pull request.

## Getting set up

```
pnpm install
```

From there, the useful per-package scripts:

- `pnpm --filter @tipsytrails/web dev` — Vite dev server for the SPA
- `pnpm --filter @tipsytrails/web build` / `preview` — production build / preview it
- `pnpm --filter @tipsytrails/api build` — compile the API to `dist/`
- `pnpm --filter @tipsytrails/api start` — run the compiled API (needs the
  environment variables documented in `.env.example`)

To run the full stack as it actually deploys, use Docker Compose — see the
"Running it locally" section of `README.md`.

## Before you open a pull request

These four commands must pass from the repository root:

```
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
```

## Phase-gated workflow

Development proceeds strictly phase by phase, per `SPEC.md` Section 12. Each
phase has a Definition of Done. Do not start work on the next phase before
every item of the current phase's Definition of Done passes, and do not open
a pull request that leaves a phase partially done without saying so. `main`
is never left in a broken state — every merge keeps it building and
deployable.

## Licensing

Contributions are accepted under the same split the project uses:

- Contributions to application source code (`packages/*`, scripts, config) are
  under the **MIT** licence (`LICENSE`).
- Contributions to map-derived data artefacts (`data/seed/bars.json`,
  `data/seed/districts.geojson`, `data/seed/grid.bin`, the `.pmtiles`
  extract) are under the **ODbL** (`DATA-LICENSE`), inherited from
  OpenStreetMap. By submitting such a contribution you agree it is licensed
  under ODbL 1.0.

By opening a pull request you agree your contribution is licensed under the
licence that applies to the part of the repository it touches.
