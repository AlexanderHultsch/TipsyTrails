# Agent guardrails

Instructions for an AI agent (Claude Code) working in this repository. Keep to
them; they are not suggestions.

- `SPEC.md` is the single source of truth. Section 1 (Hard Constraints) is
  non-negotiable. If a task would violate a constraint or a constraint blocks
  the way forward, stop and report — do not work around it.
- Implement strictly phase by phase, per Section 12. Do not start a phase
  before every Definition-of-Done item of the previous phase passes.
- All constants defined in the spec live in `packages/shared/src/config.ts`
  and nowhere else. Never inline a rate limit, radius, threshold, tolerance,
  or timeout at a call site — import it from `config.ts`.
- Unit rule (Section 0, rule 6): the database stores every timestamp and
  duration in **seconds**. Every constant in `config.ts` is in **milliseconds**
  or **metres**, as its name says. The only conversion boundary is the
  `DERIVED` block in `config.ts`. Never convert ad hoc at a call site.
- Never commit secrets. `.env` is gitignored; `.env.example` documents
  variable names and shapes only, never real values.
- Never commit runtime data. `data/db/` and `data/tiles/` are gitignored and
  must stay that way.
- English only, everywhere — UI copy, code comments, commit messages,
  identifiers (constraint C9).
- Before anything is considered done, these must all pass from the repository
  root: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`.
- `packages/api` and `packages/shared` resolve modules as NodeNext: relative
  imports carry an explicit `.js` extension (e.g. `import { foo } from
'./foo.js'`), even though the source file is `.ts`.
