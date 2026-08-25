import type { ReactNode } from 'react';
import { BADGE_KIND_NAME, BADGE_PERIOD_NAME, unearnedBadgeTypes } from '@tipsytrails/shared';
import type { BadgePeriod } from '@tipsytrails/shared';
import type { BadgeKind, BadgeSummary } from '../api/types.js';

// SPEC.md Section 7.7: "badges are prominent and public" - a compact,
// solid-ink glyph per (kind, period) pair. The pictogram itself (the shape
// inside the ring) carries the kind, and the ring count carries the period
// tier (week/month/year) - both readable at a glance without text, per the
// task brief - but the badge is never identified by shape alone: `aria-label`
// below carries the same kind + period as text for anyone who can't see the
// shape at all.
//
// The two words come from packages/shared's badge vocabulary, which is also
// what BadgeSheet titles a badge with and what the descriptions are keyed on.
// They are lower-cased here and only here: this label is a sentence fragment
// ("Explorer badge, week") where the sheet's title is a title ("Explorer ·
// Week"), and one vocabulary in two cases is not two vocabularies.
const badgeKindLabel = (kind: BadgeKind): string => BADGE_KIND_NAME[kind];
const badgePeriodLabel = (period: BadgePeriod): string => BADGE_PERIOD_NAME[period].toLowerCase();

const BADGE_PERIOD_RINGS: Record<BadgePeriod, number> = {
  week: 1,
  month: 2,
  year: 3,
};

// One definition of each pictogram, drawn by both states. Section 8.1 makes
// the argument for the cocktail glass and it is the same one here: a mark
// redrawn per state is two marks that drift, and the two states are precisely
// what must stay the same shape. The earned/unearned difference is entirely in
// how these paths are painted (index.css), never in which paths they are.
//
// `fillRule` is only load-bearing for the barfly mug, whose handle is a second
// subpath punched out of the first; on the explorer's single-subpath diamond it
// is a no-op, and it is set unconditionally rather than branching for one of
// two shapes.
const BADGE_MARK_PATH: Record<BadgeKind, string> = {
  explorer: 'M16 7 L20.5 16 L16 25 L11.5 16 Z',
  barfly:
    'M10 9h9v10a4.5 4.5 0 0 1-9 0zm11 2h1.5a3.5 3.5 0 0 1 0 7H21v-2h1.5a1.5 1.5 0 0 0 0-3H21z',
};

// Exported for BadgeSheet, which draws the same mark large. That is the whole
// reason: "never a second copy of the path" is the rule this module already
// keeps between the earned and unearned states, and a sheet with its own
// `<svg>` would be a third mark free to drift from both. `block` still decides
// only how the paths are *painted*, so the sheet cannot invent a state either
// - it is handed one, from the same profile data the shelf drew itself from.
export function BadgeGlyph({
  kind,
  period,
  block,
}: {
  kind: BadgeKind;
  period: BadgePeriod;
  block: 'badge' | 'badge-placeholder';
}) {
  const rings = BADGE_PERIOD_RINGS[period];

  return (
    <svg viewBox="0 0 32 32" className={`${block}__icon`} aria-hidden="true" focusable="false">
      {Array.from({ length: rings }, (_, i) => (
        <circle key={i} cx="16" cy="16" r={13 - i * 3} className={`${block}__ring`} />
      ))}
      <path className={`${block}__mark`} fillRule="evenodd" d={BADGE_MARK_PATH[kind]} />
    </svg>
  );
}

/** What a tapped badge hands back: which badge it is, and the award if any. */
export interface BadgeSelection {
  kind: BadgeKind;
  period: BadgePeriod;
  // The award this glyph stands for, or null for a badge the player has never
  // held. Not a boolean: a player holds several awards of the same type
  // (badges recur), and the sheet names the period *this* one was won for.
  award: BadgeSummary | null;
}

// The callback also gets the button that was tapped, so the screen that owns
// the sheet can hand focus back to it on close - the same contract
// components/BottomNav.tsx keeps with its More tab, and the reason a keyboard
// reader does not land back at the top of the document after closing.
type BadgeSelect = (selection: BadgeSelection, opener: HTMLButtonElement) => void;

// A badge is a picture, until a screen offers to explain it - then it is a
// control, and the difference is not cosmetic. It opens a dialog, so it is a
// button rather than a `role="img"` with a click handler: it reaches the
// keyboard, it announces as a button, it says what it opens
// (`aria-haspopup`), and Section 8.2's 44px target and the global
// `button:focus-visible` ring come with it.
//
// The picture is what the leaderboard's rows keep. Six tappable glyphs per
// ranked row would offer to explain someone else's badges, and Section 7.7
// declines to publish standings - so the control is opt-in, exactly as
// `showPlaceholders` below is, and for the same reason.
function BadgeBox({
  className,
  label,
  onSelect,
  children,
}: {
  className: string;
  label: string;
  onSelect?: (opener: HTMLButtonElement) => void;
  children: ReactNode;
}) {
  if (!onSelect) {
    return (
      <span className={className} role="img" aria-label={label}>
        {children}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`${className} badge-button`}
      aria-label={label}
      aria-haspopup="dialog"
      onClick={(event) => onSelect(event.currentTarget)}
    >
      {children}
    </button>
  );
}

export function Badge({
  kind,
  period,
  className,
  onSelect,
}: {
  kind: BadgeKind;
  period: BadgePeriod;
  className?: string;
  onSelect?: (opener: HTMLButtonElement) => void;
}) {
  const label = `${badgeKindLabel(kind)} badge, ${badgePeriodLabel(period)}`;

  return (
    <BadgeBox
      className={className ? `badge ${className}` : 'badge'}
      label={label}
      onSelect={onSelect}
    >
      <BadgeGlyph kind={kind} period={period} block="badge" />
    </BadgeBox>
  );
}

// Section 7.7: a badge the player has *not* got, drawn so they can want it.
// The same pictogram and the same ring count as the real thing - a placeholder
// that did not say which badge it stands for could not raise the question it
// exists to raise - and three differences from it, none of which is a number.
//
// The state is never colour alone, which Section 8.1 forbids and a
// near-monochrome palette makes easy to fall into by accident. Two of the
// three differences are shape and survive greyscale, print and a reader who
// perceives no colour at all: the mark is hollow rather than solid ink (the
// same grammar as the mastered cocktail glass in Section 8.1 - a wall of ink
// around an empty middle, which is most of the mark's area appearing or
// disappearing), and the rings are broken rather than continuous (the same
// grammar as Section 8.1's district boundaries, dashed for exactly the reason
// that weight and opacity alone cannot carry a distinction on this palette).
// The third is the greying the owner asked for, and it is the one that makes
// an earned badge stay the louder thing on the shelf.
//
// What it never carries: the threshold, the player's distance from one, a
// rank, a standing, a share of a target, or any mark that moves as the
// player's own value moves. See `unearnedBadgeTypes` for why that last one is
// a rule about the data and not about this component.
//
// Not exported, and that is deliberate rather than an oversight: which
// badges a player has *not* got is `unearnedBadgeTypes`' answer to give, and
// BadgeShelf below is the only thing that asks it. A screen reaching for
// this component directly would be drawing a "not yet earned" glyph from
// some list of its own, which is exactly the drift Section 7.7's rule about
// never publishing a threshold or a standing is guarding against.
function BadgePlaceholder({
  kind,
  period,
  className,
  onSelect,
}: {
  kind: BadgeKind;
  period: BadgePeriod;
  className?: string;
  onSelect?: (opener: HTMLButtonElement) => void;
}) {
  // The state leads rather than trails. A screen reader user hearing
  // "Explorer badge, week" from a placeholder would be told they hold a badge
  // they do not, which is the worst failure available here, and a listener who
  // stops after the first words is exactly who that failure lands on - so the
  // first words are the ones that settle it.
  const label = `Not yet earned: ${badgeKindLabel(kind)} badge, ${badgePeriodLabel(period)}`;

  return (
    <BadgeBox
      className={className ? `badge-placeholder ${className}` : 'badge-placeholder'}
      label={label}
      onSelect={onSelect}
    >
      <BadgeGlyph kind={kind} period={period} block="badge-placeholder" />
    </BadgeBox>
  );
}

// SPEC.md Section 7.7: rendered on the profile as a shelf, and as compact
// icons inline in leaderboard rows - `compact` picks the latter sizing.
// Section F/task brief: "a profile with no badges renders an empty shelf
// without breaking the layout" - the non-compact empty state says so in
// text; the compact one (inline in a leaderboard row) stays silent rather
// than adding a caption to every unbadged row.
//
// `showPlaceholders` is opt-in and defaults to off, which is a decision and
// not caution. The shelf has two call sites and only one of them wants
// placeholders: the leaderboard draws a shelf per row, and six grey glyphs on
// every row of a ranked list would bury the badges people actually won. A
// default of `true` would have given it them by inheritance.
//
// `onSelect` is opt-in for the same reason and is the same decision: with it
// every glyph on the shelf becomes a control that explains itself, earned or
// not (the owner's "even not achieved badges need to be described on
// request"); without it the shelf is a picture, which is what a leaderboard
// row and a stranger's profile get. Offering to explain a badge is only ever
// offered about the player's own shelf - screens/Profile.tsx says why.
export function BadgeShelf({
  badges,
  compact = false,
  showPlaceholders = false,
  onSelect,
}: {
  badges: BadgeSummary[];
  compact?: boolean;
  showPlaceholders?: boolean;
  onSelect?: BadgeSelect;
}) {
  const className = compact ? 'badge-shelf badge-shelf--compact' : 'badge-shelf';

  // Awards in, badge *types* out. `unearnedBadgeTypes` cannot see a
  // `value` even though every award carries one - see its signature - so
  // nothing on this shelf can come to depend on how far along the player is.
  const placeholders = showPlaceholders ? unearnedBadgeTypes(badges) : [];

  if (badges.length === 0 && placeholders.length === 0) {
    if (compact) {
      return <ul className={className} />;
    }
    return <p className="badge-shelf__empty">No badges yet — get out exploring to earn one.</p>;
  }

  return (
    <>
      {badges.length > 0 && (
        <ul className={className}>
          {badges.map((badge) => (
            <li key={`${badge.kind}-${badge.period}-${badge.periodKey}`}>
              <Badge
                kind={badge.kind}
                period={badge.period}
                // The award itself, not its type: a player holds several
                // awards of one type and the sheet names the period *this*
                // glyph was won for.
                onSelect={
                  onSelect &&
                  ((opener) =>
                    onSelect({ kind: badge.kind, period: badge.period, award: badge }, opener))
                }
              />
            </li>
          ))}
        </ul>
      )}
      {placeholders.length > 0 && (
        <>
          {/* A heading rather than a caption, so the six placeholders are
              announced under their own label instead of extending the list of
              badges the player holds. Level 3 because the only screen that
              asks for placeholders puts this shelf under its own <h2>. */}
          <h3 className="badge-shelf__heading">Not yet earned</h3>
          <ul className="badge-shelf badge-shelf--placeholders">
            {placeholders.map((type) => (
              <li key={`${type.kind}-${type.period}`}>
                <BadgePlaceholder
                  kind={type.kind}
                  period={type.period}
                  // `award: null` is the whole of what the sheet is told
                  // about an unearned badge, and it is what stops the sheet
                  // being able to leak anything that moves with the player's
                  // own value: it is handed no value to leak. Section 7.7's
                  // operative rule - nothing about a placeholder may change
                  // as the player's value changes - reaches the sheet as this
                  // one `null`.
                  onSelect={
                    onSelect &&
                    ((opener) =>
                      onSelect({ kind: type.kind, period: type.period, award: null }, opener))
                  }
                />
              </li>
            ))}
          </ul>
          {/* The answer to "what do I have to do to get that?", given once for
              the whole group rather than six times, and given in words because
              the honest answer is not a number. A badge is a competition
              decided at the end of its period (Section 7.7), so no score
              secures one; the last clause says that outright, because a player
              left to assume there is a hidden number would simply invent one.
              Naming the two activities is as specific as this may get: the
              threshold, the player's distance from it and their standing are
              all things Section 7.7 keeps off the screen. */}
          <p className="badge-shelf__note">
            Explore new ground, master new bars. Each badge goes to whoever does the most of it in
            its week, month or year; no fixed score wins one.
          </p>
        </>
      )}
    </>
  );
}
