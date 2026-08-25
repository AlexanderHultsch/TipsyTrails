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

// ---------------------------------------------------------------------------
// What a badge is, in words.
//
// Copy rather than specification constants, so CLAUDE.md's "every constant
// lives in config.ts" does not apply - that rule covers rate limits, radii,
// thresholds, tolerances and timeouts, and none of these is a number at all.
// It lives here instead of beside the component that draws it because this is
// where the catalogue lives: a description written next to a shelf could name
// a badge the catalogue no longer has, and `Record<BadgeKind, ...>` below
// makes a third kind added to CONFIG.BADGE_THRESHOLDS a compile error here
// rather than a badge that opens with nothing to say.
//
// **Section 7.7 decides every word of this.** The threshold is never shown
// and no endpoint returns it; neither is a rank, a standing, a distance from
// a floor, or a share of a target. What is left - and it is the whole honest
// answer - is what the badge is, what activity earns it, and over what
// window. Not one of these strings carries a digit, and the tests hold them
// to that.
//
// There is a truthfulness reason on top of the policy one, and it is why
// BADGE_COMPETITION_NOTE exists: a badge goes to the period's *highest*
// scorer, so "what must I do to get it" has no numeric answer even in
// principle. A player told nothing would invent a number; this says outright
// that there is none.

/** The badge's name, per kind: the pictogram's own word. */
export const BADGE_KIND_NAME: Record<BadgeKind, string> = {
  explorer: 'Explorer',
  barfly: 'Barfly',
};

/** The badge's period, per period: the ring count's own word. */
export const BADGE_PERIOD_NAME: Record<BadgePeriod, string> = {
  week: 'Week',
  month: 'Month',
  year: 'Year',
};

// The rule, split where the sentence needs the window in the middle of it.
// Six unrelated strings would be six places for the barfly rule to drift from
// the barfly rule, and the two halves that vary are exactly the two axes the
// catalogue has: the kind carries what counts, the period carries how long
// it is counted for.
//
// `earns` names the activity and stops before any quantity of it. `excludes`
// is the half a player cannot guess and the half that costs them a period if
// they guess wrong - both metrics count a thing only the *first* time it
// happens (Section 7.7: fog newly revealed, and bars whose earliest completed
// visit falls in the period), so walking a cleared street again or drinking
// at a mastered bar again scores exactly nothing.
const BADGE_KIND_RULE: Record<BadgeKind, { earns: string; excludes: string }> = {
  explorer: {
    earns: 'Explorer rewards new ground: city area you clear for the first time',
    excludes: 'Walking a street you have already cleared adds nothing.',
  },
  barfly: {
    earns: 'Barfly rewards new bars: bars you master for the first time',
    excludes: 'A second completed visit to a bar you have already mastered counts for nothing.',
  },
};

// The window, per period (Sections 5.8 and 7.7). A week is an ISO week and
// not "the last seven days", which is the reading a player is most likely to
// arrive with and the one that would have them counting from the wrong day;
// the gloss says so rather than assuming "ISO" means anything to them.
const BADGE_PERIOD_WINDOW: Record<BadgePeriod, string> = {
  week: 'an ISO week (Monday to Sunday)',
  month: 'a calendar month',
  year: 'a calendar year',
};

/**
 * The one line every badge carries, identical on all six.
 *
 * A badge is a competition decided once, at the end of its period, on the
 * highest score (Section 7.7) - so no score secures one, and the floor that
 * exists is a floor rather than a target and is never published. Said in
 * words because the honest answer is not a number.
 */
export const BADGE_COMPETITION_NOTE =
  'Each badge goes to whoever does the most of it in the period — no fixed score wins one.';

/**
 * What earns this badge and over what window, in two sentences.
 *
 * Composed from the kind's rule and the period's window rather than written
 * out six times. Europe/Berlin is appended once here for the same reason: the
 * timezone is a property of every badge period (Section 5.8), not of any one
 * of them.
 */
export function badgeDescription(kind: BadgeKind, period: BadgePeriod): string {
  const rule = BADGE_KIND_RULE[kind];
  return `${rule.earns} within ${BADGE_PERIOD_WINDOW[period]} in Europe/Berlin. ${rule.excludes}`;
}

/** The badge's name as a title: 'Explorer · Week', 'Barfly · Year'. */
export function badgeName(kind: BadgeKind, period: BadgePeriod): string {
  return `${BADGE_KIND_NAME[kind]} · ${BADGE_PERIOD_NAME[period]}`;
}
