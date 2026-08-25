import type { ReactNode } from 'react';
import { BADGE_PERIOD_NAME, badgeName, unearnedBadgeTypes } from '@tipsytrails/shared';
import type { BadgePeriod } from '@tipsytrails/shared';
import type { BadgeKind, BadgeSummary } from '../api/types.js';

// SPEC.md Section 7.7: "badges are prominent and public" - a compact,
// solid-ink glyph per (kind, period) pair, on the badge shelf and inline in
// leaderboard rows.
//
// THE GLYPH IS TWO PARTS AND EACH CARRIES ONE AXIS. The pictogram carries the
// kind - a compass rose for `explorer`, a highball with a straw and a garnish
// for `barfly` - and a modifier drawn *above* it carries the period: nothing
// for a week, a star for a month, a crown for a year. That replaced a ring
// frame whose stroke count (one, two, three) used to carry the period, and the
// reason is that a count of thin concentric circles is a counting task at
// 1.25rem, where "is there a crown on it?" is a silhouette.
//
// Neither half is ever the only channel. `aria-label` below carries the
// badge's name *and* its period as text, because a screen reader user gets
// nothing from a crown - see BADGE_PERIOD_NAME in packages/shared, which
// exists for exactly that reason now that the names themselves have stopped
// saying "week", "month" or "year".
//
// The vocabulary comes from packages/shared's badge catalogue, which is also
// what BadgeSheet titles a badge with, so a name cannot mean one thing on the
// shelf and another in the sheet.
const badgePeriodLabel = (period: BadgePeriod): string => BADGE_PERIOD_NAME[period];

// One definition of each shape, drawn by both states. Section 8.1 makes the
// argument for the cocktail glass and it is the same one here: a mark redrawn
// per state is two marks that drift, and the two states are precisely what
// must stay the same shape. Since v1.38 the earned/unearned difference is
// entirely in how these paths are painted and in one frame drawn around them
// (index.css and the placeholder branch below), never in which paths they are.
//
// EVERYTHING IS DRAWN IN A 32-UNIT BOX WITH A FIXED DIVISION OF IT. The
// modifier band is y 2.6 - 10.4; the pictogram is y 12.4 - 29.2 around a
// centre at (16, 20.8); the two never come closer than two units, which is
// what keeps a crown from fusing with the glass under it at the smallest size
// this is drawn at. Nothing in either band moves or grows when the other is
// empty, which is what makes the three periods of one kind read as one badge
// with something added rather than as three drawings - a weekly badge is
// therefore a little low in its box, on purpose. What is left over at the
// edges is the margin the placeholder's frame sits in.
//
// No fill-rule is set and none is wanted: nothing here is a shape with a hole
// in it, and the barfly's three subpaths overlap deliberately - the straw
// crosses the rim, the garnish sits on it - which the default nonzero rule
// merges into one silhouette where `evenodd` would punch the overlaps out.

// The kind, as one solid pictogram.
//
// `explorer` is a compass rose and not the lozenge it replaced: four long
// cardinal points at radius 8.4, four short intercardinals at 4.6, and a waist
// of 3.2 between them. Those last two numbers are the whole of what makes it
// legible small: an earlier version had a 2.45 waist, which is a truer rose on
// paper and collapsed into a lumpy diamond at a leaderboard row's size,
// because a point whose base is under two units is under one device pixel
// there. Widening the waist trades a little of the drawing for arms that
// survive. It is the one shape here that is genuinely about direction, which
// is what the badge is for.
//
// `barfly` is a cocktail glass that is deliberately **not** the martini of
// Section 8.1. That silhouette - a wide triangular bowl on a stem and a foot -
// belongs to the bar marker and to the discovery stamp, where it carries a
// state (full/nearly empty, Section 5.7), and a badge wearing it would be a
// fifth surface drawing a mark that means something else. This is a tapered
// highball instead, and it is told apart from the martini by its outline
// alone: a tall column widest at the rim and narrowing to the base, a straw
// crossing out of it diagonally to the upper right, and a round garnish on the
// near rim - against a shape that is widest at the very top, pinches to a
// point in its middle, and stands on a foot. No stem, no foot, no triangle,
// and nothing at the top corners of the box for the two to be confused in.
const BADGE_MARK_PATH: Record<BadgeKind, string> = {
  explorer:
    'M16 12.4 L17.22 17.84 L19.25 17.55 L18.96 19.58 L24.4 20.8 L18.96 22.02 L19.25 24.05 ' +
    'L17.22 23.76 L16 29.2 L14.78 23.76 L12.75 24.05 L13.04 22.02 L7.6 20.8 L13.04 19.58 ' +
    'L12.75 17.55 L14.78 17.84 Z',
  barfly:
    'M10.5 15.4 L19.3 15.4 L18.3 29.2 L11.5 29.2 Z' +
    'M14.17 27.5 L22.27 13.4 L20.53 12.4 L12.43 26.5 Z' +
    'M9.3 14.3a1.9 1.9 0 1 0 3.8 0a1.9 1.9 0 1 0-3.8 0Z',
};

// The period, as a modifier above the pictogram - or as nothing at all.
//
// `null` for the week rather than an empty string or a missing key: a
// `Record<BadgePeriod, ...>` makes a fourth period a compile error here, and
// "the weekly badge has no modifier" is a decision worth being able to read.
//
// BOTH SHAPES ARE DRAWN FOR THE SIZE THEY ARE ACTUALLY RENDERED AT, which
// inline in a leaderboard row is 1.25rem for the whole 32-unit box - so this
// band is about five device pixels tall there, and every decision in these two
// paths is about that. The star is fat (inner radius 43% of outer, against the
// 38% of a classic pentagram) so it holds ink instead of dissolving into five
// hairs, and it is narrow: about eight units across. The crown is twelve units
// across - half again as wide - with three bold points over a solid band, no
// arches, no jewels and no rim, and its notches are cut deep enough (to y 8.2,
// against points reaching 2.6 and 3.9) that the three teeth stay separate
// rather than smearing into one lump. So the three periods differ by mass and
// width as much as by shape: nothing, a narrow point, a wide bar with teeth.
//
// None of that is provable here. jsdom loads no stylesheet and lays nothing
// out, so no test in this repository can see one of these rendered at any
// size; the drawings were checked by rasterising them offline at 20, 32 and 64
// device pixels, and the claim that they are *legible* still needs eyes on a
// phone. What the tests hold is that the three modifiers are three different
// paths and that the week has none.
const BADGE_MODIFIER_PATH: Record<BadgePeriod, string | null> = {
  week: null,
  month:
    'M16 2.6 L17.09 5.4 L20.09 5.57 L17.76 7.47 L18.53 10.38 L16 8.75 ' +
    'L13.47 10.38 L14.24 7.47 L11.91 5.57 L14.91 5.4 Z',
  year: 'M10 10.2 V3.9 L13 8.2 L16 2.6 L19 8.2 L22 3.9 V10.2 Z',
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
  const modifier = BADGE_MODIFIER_PATH[period];

  return (
    <svg viewBox="0 0 32 32" className={`${block}__icon`} aria-hidden="true" focusable="false">
      {/* The placeholder's frame, and the reason it is markup rather than a
          border in the stylesheet: it is a *shape*, and Section 8.1 requires
          the unearned state to differ from the earned one in more than
          lightness. It is drawn first so the artwork sits inside it, and it
          exists in exactly one of the two states - which is the whole point,
          since the artwork itself is now identical in both. */}
      {block === 'badge-placeholder' && (
        <rect className="badge-placeholder__frame" x="1" y="1" width="30" height="30" rx="4" />
      )}
      <path className={`${block}__mark`} d={BADGE_MARK_PATH[kind]} />
      {modifier !== null && <path className={`${block}__modifier`} d={modifier} />}
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
  // Name first, period second: "Bar Legend badge, year". The name is what the
  // sheet titles this badge with and the period is what the crown above the
  // glass says silently, so the two together are the whole of what a sighted
  // player can see - and the period is not optional information now that no
  // name carries it.
  const label = `${badgeName(kind, period)} badge, ${badgePeriodLabel(period)}`;

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
//
// The owner decided the treatment: *"just use same as real badge but in light
// grey maybe transparent. Your frame idea is okay."* So it is the same
// artwork, pictogram and modifier both - a placeholder that did not say which
// badge it stands for could not raise the question it exists to raise - drawn
// back in lightness, inside a dashed frame.
//
// THE FRAME IS NOT DECORATION. Section 8.1 does not allow a state to rest on
// lightness alone: greying something out is a difference nobody sees in a
// black-and-white print, and it is the weakest signal available on a palette
// that is already near-monochrome. Lightness is what the owner asked for and
// it is what makes an earned badge the louder thing on a shelf holding both;
// the frame is the second channel, and it is dashed for the reason Section 8.1
// gives for drawing district boundaries dashed - broken against continuous is
// a distinction weight and opacity cannot carry here. An empty frame around a
// badge also happens to say the right thing: a place kept for something not
// there yet.
//
// This replaces a hollow-mark-and-broken-rings treatment. Hollowing the mark
// is Section 8.1's grammar for a *mastered* cocktail glass, and with the badge
// pictogram now a glass of its own, an unearned barfly badge drawn hollow
// would have been saying "mastered" in the application's own vocabulary.
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
  // The state leads rather than trails. A screen reader user hearing "Bar
  // Legend badge, year" from a placeholder would be told they hold a badge
  // they do not, which is the worst failure available here, and a listener who
  // stops after the first words is exactly who that failure lands on - so the
  // first words are the ones that settle it.
  const label = `Not yet earned: ${badgeName(kind, period)} badge, ${badgePeriodLabel(period)}`;

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
              decided at the end of its period (Section 7.7). The clause that
              used to close this line - "no fixed score wins one" - is gone at
              the owner's direction, from here and from Section 7.7 with it:
              the sentence that remains already says a badge goes to whoever
              does the most, which leaves no score to hunt for. Naming the two
              activities is as specific as this may get: the threshold, the
              player's distance from it and their standing are all things
              Section 7.7 keeps off the screen. */}
          <p className="badge-shelf__note">
            Explore new ground, master new bars. Each badge goes to whoever does the most of it in
            its week, month or year.
          </p>
        </>
      )}
    </>
  );
}
