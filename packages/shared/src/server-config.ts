// SPEC.md Section 7.1's second constants module, and the only one there will
// be: the constants a client may not be given. Everything else stays in
// `config.ts` (Section 0, rule 3), and a call site still never inlines a number
// from either file.
//
// **This module is not reachable from `packages/web`, and that is enforced
// rather than agreed.** Three things enforce it, in the order they fail:
//
//  1. `index.ts` does not re-export it, and `packages/shared`'s `package.json`
//     puts it behind its own subpath, `@tipsytrails/shared/server`. The package
//     has an `exports` map, so the subpath is the only way in — a deep import
//     of `dist/server-config.js` is refused by Node, by TypeScript under
//     NodeNext and by Vite's resolver alike. Importing this file therefore
//     costs a deliberate line naming `/server`; it cannot happen by reaching
//     for `CONFIG`.
//  2. ESLint refuses that line inside `packages/web` (`no-restricted-imports`
//     in the repository's `eslint.config.js`), so `pnpm lint` fails on it.
//  3. If both of those were removed, `packages/web/src/bundle.test.ts` builds
//     the production bundle and fails on the numbers themselves. That one is
//     the test that matters, because the leak this file exists to close
//     (Section 7.7, v1.54) was found in a built bundle and is a property of the
//     build rather than of the import graph.
//
// `packages/shared` has no runtime dependencies and this file adds none: its
// only import is a type, erased at compile time.

import type { BadgePeriod } from './berlin-time.js';
// A type-only import of a value binding. `typeof CONFIG.BADGE_KINDS` is all
// this file wants from `config.ts`, and taking it this way means the emitted
// JavaScript imports nothing at all — the coupling below is entirely a
// compile-time one, and this module stays a leaf.
import type { CONFIG } from './config.js';

// Derived from the client-safe key set rather than declared here, which is
// what makes the two modules one thing. Both packages that consume badges
// derive their own `BadgeKind` from `CONFIG.BADGE_KINDS` the same way; this is
// deliberately module-local, for the reason `badges.ts` gives for its own copy.
type BadgeKind = (typeof CONFIG.BADGE_KINDS)[number];

/**
 * Badge qualifying floors — SPEC.md Section 7.7.
 *
 * Badges are a per-period COMPETITION and these are its FLOORS. A badge goes
 * to the highest-scoring user of the period, and to nobody at all if no one
 * reaches the floor; the floor's only job is to stop the badge being won by
 * being the least inactive person in a quiet period. Set them low: they are
 * qualification, not the target. A user qualifies when value >= threshold
 * (minimum, not "strictly greater").
 *
 * **Why they are in this file and not in `config.ts`.** Section 7.7 says the
 * threshold is never shown to a user and never returned by an endpoint, and
 * that held literally while being false in effect: `CONFIG` is one object
 * literal, `packages/web` imports it as a value, and the whole literal was
 * bundled — the six numbers read out of devtools in seconds, from v1.31 to
 * v1.53. They have exactly one reader, `packages/api/src/badges.ts`, so the
 * split costs that one file an import and gives the section back its meaning.
 *
 * The `satisfies` clause is the coupling to `CONFIG.BADGE_KINDS`, and it is
 * two-directional on purpose: a kind named there with no floors here is a
 * missing property, and floors here for a kind not named there are an excess
 * one. Either way the package does not compile, which is what stops the
 * catalogue the browser draws and the floors the server applies from drifting
 * apart now that they live in different files.
 */
export const SERVER_CONFIG = {
  BADGE_THRESHOLDS: {
    // Percent of playable city area newly revealed in the period.
    // Deliberately not linear across periods: after the first weeks most walking
    // retraces already-revealed ground, so sustained progress decays sharply.
    // 0.1% is roughly 900 m of previously unexplored walking.
    explorer: { week: 0.1, month: 0.3, year: 2.0 },
    // Bars newly mastered in the period.
    barfly: { week: 1, month: 2, year: 3 },
  },
} as const satisfies {
  BADGE_THRESHOLDS: Record<BadgeKind, Record<BadgePeriod, number>>;
};
