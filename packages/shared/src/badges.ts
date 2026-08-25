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
 * pictograms group together, and within each the period modifier ascends
 * nothing -> star -> crown (Section 8.1), which reads as a progression rather
 * than as six unrelated glyphs.
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

// ---------------------------------------------------------------------------
// What a badge is, in words.
//
// Copy rather than specification constants, so CLAUDE.md's "every constant
// lives in config.ts" does not apply - that rule covers rate limits, radii,
// thresholds, tolerances and timeouts, and none of these is a number at all.
// It lives here instead of beside the component that draws it because this is
// where the catalogue lives: a name written next to a shelf could name a badge
// the catalogue no longer has, and the `Record` types below make a third kind
// added to CONFIG.BADGE_THRESHOLDS a compile error here rather than a badge
// that opens with nothing to say.
//
// **Section 7.7 decides every word of this.** The threshold is never shown
// and no endpoint returns it; neither is a rank, a standing, a distance from
// a floor, or a share of a target. Not one of these strings carries a digit,
// and the tests hold them to that.
//
// SINCE v1.38 A BADGE HAS ONE NAME AND NOT TWO. It used to be composed - a
// kind word ("Explorer", "Barfly") joined to a period word ("Week", "Month",
// "Year") by a middle dot - which is a naming *scheme* rather than six names,
// and it produced "Barfly · Year" for the thing the owner calls a Bar Legend.
// The six names below are his, verbatim, and they are deliberately not
// composable: "Bar Hopper" and "Bar Legend" share no word, and "Explorer" is
// the whole name of the weekly explorer badge rather than the kind half of it.
// So the lookup is keyed on the pair, and the nested Record is what makes a
// new kind or a new period fail to compile instead of quietly producing a
// name that reads like a placeholder.

// The six names, per (kind, period). Kind-major, in catalogue order, so this
// table reads in the order a shelf draws.
const BADGE_NAME: Record<BadgeKind, Record<BadgePeriod, string>> = {
  explorer: {
    week: 'Explorer',
    month: 'Explorer Champion',
    year: 'Explorer Legend',
  },
  barfly: {
    week: 'Bar Hopper',
    month: 'Bar Champion',
    year: 'Bar Legend',
  },
};

/**
 * The period's own word, for the accessible layer and for nothing else.
 *
 * The names above deliberately do not encode the period: "Bar Legend" is a
 * better name than "Barfly · Year" precisely because it stops saying "year",
 * and a sighted player recovers the period from the crown drawn above the
 * pictogram (Section 8.1). A screen reader user gets nothing from a crown, so
 * the period is spoken instead - it is real information about which badge
 * this is, not decoration, and dropping it would leave three explorer badges
 * announcing as three unrelated words.
 */
export const BADGE_PERIOD_NAME: Record<BadgePeriod, string> = {
  week: 'week',
  month: 'month',
  year: 'year',
};

/**
 * The one line every badge carries, identical on all six, and since v1.38 the
 * only line of description any of them carries.
 *
 * The owner's words: *"Remove the detailed description for all of them, the
 * name is enough"*, and *"As description only: Each badge goes to whoever does
 * the most of it in the period. Not more."* The sentence is his, and "not
 * more" is why it stops where it stops - the clause this string used to carry
 * ("- no fixed score wins one") was true and is now cut, because he asked for
 * one sentence and got one.
 *
 * What went with the descriptions: a per-kind rule ("Explorer rewards new
 * ground..."), a per-period window ("an ISO week (Monday to Sunday)") and the
 * `badgeDescription` that composed them. None of it was wrong; all of it was
 * more than a player wants to read on a sheet whose subject is a picture and a
 * name. The activity each kind rewards is still stated once, on the shelf,
 * under the placeholders that raise the question (components/Badge.tsx).
 *
 * It stays a sentence rather than a number because a badge is a competition
 * decided once, at the end of its period, on the highest score (Section 7.7):
 * no score secures one, and the floor that exists is a floor rather than a
 * target and is never published.
 */
export const BADGE_COMPETITION_NOTE =
  'Each badge goes to whoever does the most of it in the period.';

/**
 * The badge's name: 'Explorer', 'Bar Legend'. One name, not a composition.
 *
 * Six names and six pairs, so every badge has a name of its own and no two
 * badges share one - which is what stops a title telling a player they are
 * looking at a badge they are not.
 */
export function badgeName(kind: BadgeKind, period: BadgePeriod): string {
  return BADGE_NAME[kind][period];
}
