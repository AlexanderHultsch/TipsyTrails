import { useEffect, useRef } from 'react';
import { BADGE_COMPETITION_NOTE, badgeDescription, badgeName } from '@tipsytrails/shared';
import type { BadgePeriod } from '@tipsytrails/shared';
import type { BadgeKind, BadgeSummary } from '../api/types.js';
import { BadgeGlyph } from './Badge.js';

// The owner's request: "a short description should pop up when you click on
// the badges. Even not achieved badges need to be described on request."
//
// An overlay, not a route, and therefore a dialog - the same shape and the
// same three ways out as components/MoreSheet.tsx, which is the repository's
// dismissible modal and is followed here rather than invented again:
// role="dialog" with an accessible name, aria-modal, focus moved into the
// sheet on open, and Escape / a tap outside / the close button to leave. Its
// backdrop carries no keyboard handler for the reason MoreSheet's comment
// gives, and this one does not either.
//
// **Section 7.7 is what this sheet may say, and it is a short list.** What a
// badge is, what activity earns it, over what window, and - if the player
// won it - which period they won it for and what they did to win it. Never
// the threshold, never a distance from one, never a rank, never a standing,
// never a share of a target. The unearned branch is where that matters most:
// a sheet that leaked a number there would hand back the floor Section 7.7
// keeps off the screen, readable by opening the sheet again after every walk.
// It is handed no value at all for an unearned badge (see BadgeSelection),
// so there is nothing there to leak.
//
// The one number this sheet does show is the value on an award the player
// already holds. That is their own past achievement rather than a target: the
// API has published it on every badge in every leaderboard row since Phase 6,
// and it is what makes an earned badge weigh something instead of being a
// glyph with a date.

// Section 5.8's column comment - `value REAL NOT NULL, -- achieved value
// (percent or bar count)` - is the whole reason this is not one format
// string. The same field is 1.2 (percent of the city) for explorer and 4
// (bars) for barfly, and printing either raw would be a number with no unit
// at best and a wrong one at worst.
//
// It is not screens/Profile.tsx's `formatMetric` either, and that is
// deliberate: there the value sits in a two-column list whose left column
// already says "Bars mastered", so the figure carries no unit of its own.
// Here it stands inside a sentence and has to.
function formatAchievedValue(kind: BadgeKind, value: number): string {
  if (kind === 'explorer') {
    // The same two decimals the profile's running totals use. A badge value
    // and a progress value are the same quantity read at two moments, and two
    // precisions for one quantity reads as two different numbers.
    return `${value.toFixed(2)}% of the city cleared`;
  }
  return `${value} ${value === 1 ? 'bar' : 'bars'} mastered`;
}

// Month names, because '2026-08' is not something to show a player.
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

// `badges.period_key` (Section 5.8) made readable: '2026-W32' -> 'week 32 of
// 2026', '2026-08' -> 'August 2026', '2026' -> '2026'.
//
// Deliberately no date arithmetic. An ISO week could be rendered as the dates
// of its Monday and Sunday, and that conversion is a bug farm - week 53,
// week-years that disagree with the calendar year at both ends, and a
// timezone to get wrong on top - for a line that reads no better. "Week 32 of
// 2026" is exactly as true and costs a split. packages/shared's
// berlin-time.ts does own the parsing for the arithmetic it really does need
// (`badgePeriodBoundaries`), and none of it is exported or wanted here: this
// is a label, not a boundary.
//
// A key that does not parse falls back to itself rather than throwing. It
// comes from the server and the sheet is not the place to discover that it
// has changed shape; an unreadable label loses a player nothing, where a
// crash loses them the screen.
function formatPeriodKey(period: BadgePeriod, periodKey: string): string {
  if (period === 'week') {
    const match = /^(\d{4})-W(\d{2})$/.exec(periodKey);
    return match ? `week ${Number(match[2])} of ${match[1]}` : periodKey;
  }
  if (period === 'month') {
    const match = /^(\d{4})-(\d{2})$/.exec(periodKey);
    if (!match) {
      return periodKey;
    }
    const monthName = MONTH_NAMES[Number(match[2]) - 1];
    return monthName ? `${monthName} ${match[1]}` : periodKey;
  }
  return periodKey;
}

export function BadgeSheet({
  kind,
  period,
  award,
  onClose,
}: {
  kind: BadgeKind;
  period: BadgePeriod;
  award: BadgeSummary | null;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const name = badgeName(kind, period);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Focus moves into the sheet on open, or a keyboard reader who just opened
  // it is still standing on the badge behind it. The close button is the only
  // control in here, so it is both the first stop and the way out.
  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('button')?.focus();
  }, []);

  return (
    <div className="badge-sheet" role="presentation" onClick={onClose}>
      <div
        className="badge-sheet__panel"
        role="dialog"
        aria-modal="true"
        // The state leads for an unearned badge, exactly as it does on the
        // shelf's own label (Badge.tsx) and for the same reason: a dialog's
        // name is announced on open, the status line is a beat later, and a
        // listener who stops after the first words must not be told they hold
        // a badge they do not.
        aria-label={award ? name : `Not yet earned: ${name}`}
        ref={panelRef}
        onClick={(event) => event.stopPropagation()}
      >
        {/* The same mark the shelf drew, from the same definition, painted in
            the same state - large, because the sheet is where a player looks
            at a badge rather than past it. */}
        <span className="badge-sheet__mark">
          <BadgeGlyph kind={kind} period={period} block={award ? 'badge' : 'badge-placeholder'} />
        </span>
        <h2 className="badge-sheet__name">{name}</h2>
        <p className="badge-sheet__description">{badgeDescription(kind, period)}</p>
        {/* Said on every sheet, identically, because it is true of every
            badge: there is no score that wins one. A player who is told what
            earns a badge and nothing else will supply a number themselves. */}
        <p className="badge-sheet__note">{BADGE_COMPETITION_NOTE}</p>
        <p className="badge-sheet__status">
          {award
            ? `Earned for ${formatPeriodKey(period, award.periodKey)}, with ${formatAchievedValue(kind, award.value)}.`
            : // Four words, and nothing that moves. Not "not yet - keep
              // going", not a hint, and above all nothing derived from what
              // the player is currently worth: Section 7.7's rule is that no
              // part of an unearned badge may change as their own value
              // changes, because anything that did would hand back the floor.
              'Not yet earned.'}
        </p>
        <button type="button" className="badge-sheet__close" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
