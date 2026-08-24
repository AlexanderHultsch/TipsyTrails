// SPEC.md Section 7.7: "Two kinds, three periods". This module is the list of
// badges that *exist* - every (kind, period) pair the game can ever award -
// and the rule that turns a player's earned badges into the ones they have
// never held, which is what the profile draws as placeholders.
//
// It is derived, not written out. The six pairs could be listed by hand in
// half the lines, and that list would type-check forever: a subset of a union
// is still assignable to it, so a third kind added to CONFIG.BADGE_THRESHOLDS
// would silently produce a five-badge catalogue rather than an error. Deriving
// makes the same change either compile into the catalogue or fail loudly,
// which is the reason packages/api/src/badges.ts and
// packages/web/src/api/types.ts already derive their own BadgeKind from the
// same key set.
//
// Only the *key set* of BADGE_THRESHOLDS is read here. The numbers behind
// those keys are the floors of Section 7.7 and are never shown to a user and
// never returned by an endpoint; nothing in this file reads one, and nothing
// that imports this file needs to.

import { CONFIG } from './config.js';
import { BADGE_PERIODS } from './berlin-time.js';
import type { BadgePeriod } from './berlin-time.js';

// Deliberately module-local. The canonical public name for this type would
// mean collapsing the two copies packages/api and packages/web already
// derive, which is a refactor of the API package rather than part of this
// change; both copies are `keyof typeof CONFIG.BADGE_THRESHOLDS` too, so
// BadgeType below is structurally the same type at every call site without a
// third exported name to keep in step.
type BadgeKind = keyof typeof CONFIG.BADGE_THRESHOLDS;

/** One badge that exists: a kind awarded for a period. Not an award. */
export interface BadgeType {
  kind: BadgeKind;
  period: BadgePeriod;
}

/**
 * Every badge the game can award, kind-major and then shortest period first.
 *
 * The order is what a shelf of placeholders is drawn in, so it is fixed here
 * rather than left to whatever `Object.keys` happens to return: the two
 * pictograms group together, and within each the ring count ascends 1 -> 2
 * -> 3, which reads as a progression rather than as six unrelated glyphs.
 */
export const BADGE_CATALOGUE: readonly BadgeType[] = (
  Object.keys(CONFIG.BADGE_THRESHOLDS) as BadgeKind[]
).flatMap((kind) => BADGE_PERIODS.map((period) => ({ kind, period })));

/**
 * The badge types a player has never earned, in catalogue order.
 *
 * The parameter is `{ kind, period }` and nothing more, and that narrowness is
 * the point rather than tidiness. Section 7.7 publishes no threshold, no rank
 * and no standing, and a placeholder that looked any different once a player
 * passed the floor - brighter, closer, "nearly there" - would hand the
 * threshold back: a player could walk until the pixel changed and read the
 * number off the screen. The set may therefore depend on which badges have
 * been *earned* and on nothing else, and a signature that cannot see a value
 * is a rule the compiler enforces instead of a comment asking nicely. Callers
 * pass their award records straight in; the extra fields are simply not
 * visible here.
 *
 * "Earned" ignores the period key on purpose. Badges recur - a player wins
 * explorer/week again every week they lead it - and a placeholder that came
 * back each Monday would be showing a player a badge they hold several of,
 * blinking off only when the evaluation job runs after the period closes.
 * Once a type has been held once its placeholder is done, permanently, and
 * because awarded badges are never revoked (Section 7.7) the earned set only
 * grows and this set only shrinks. It cannot flicker.
 */
export function unearnedBadgeTypes(earned: readonly BadgeType[]): BadgeType[] {
  const held = new Set(earned.map((badge) => `${badge.kind}/${badge.period}`));
  return BADGE_CATALOGUE.filter((type) => !held.has(`${type.kind}/${type.period}`));
}
