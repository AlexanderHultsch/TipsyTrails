import type { BadgePeriod } from '@tipsytrails/shared';
import type { BadgeKind, BadgeSummary } from '../api/types.js';

// SPEC.md Section 7.7: "badges are prominent and public" - a compact,
// solid-ink glyph per (kind, period) pair. The pictogram itself (the shape
// inside the ring) carries the kind, and the ring count carries the period
// tier (week/month/year) - both readable at a glance without text, per the
// task brief - but the badge is never identified by shape alone: `aria-label`
// below carries the same kind + period as text for anyone who can't see the
// shape at all.
const BADGE_KIND_LABEL: Record<BadgeKind, string> = {
  explorer: 'Explorer',
  barfly: 'Barfly',
};

const BADGE_PERIOD_LABEL: Record<BadgePeriod, string> = {
  week: 'week',
  month: 'month',
  year: 'year',
};

const BADGE_PERIOD_RINGS: Record<BadgePeriod, number> = {
  week: 1,
  month: 2,
  year: 3,
};

export function Badge({
  kind,
  period,
  className,
}: {
  kind: BadgeKind;
  period: BadgePeriod;
  className?: string;
}) {
  const label = `${BADGE_KIND_LABEL[kind]} badge, ${BADGE_PERIOD_LABEL[period]}`;
  const rings = BADGE_PERIOD_RINGS[period];

  return (
    <span className={className ? `badge ${className}` : 'badge'} role="img" aria-label={label}>
      <svg viewBox="0 0 32 32" className="badge__icon" aria-hidden="true" focusable="false">
        {Array.from({ length: rings }, (_, i) => (
          <circle key={i} cx="16" cy="16" r={13 - i * 3} className="badge__ring" />
        ))}
        {kind === 'explorer' ? (
          <path className="badge__mark" d="M16 7 L20.5 16 L16 25 L11.5 16 Z" />
        ) : (
          <path
            className="badge__mark"
            fillRule="evenodd"
            d="M10 9h9v10a4.5 4.5 0 0 1-9 0zm11 2h1.5a3.5 3.5 0 0 1 0 7H21v-2h1.5a1.5 1.5 0 0 0 0-3H21z"
          />
        )}
      </svg>
    </span>
  );
}

// SPEC.md Section 7.7: rendered on the profile as a shelf, and as compact
// icons inline in leaderboard rows - `compact` picks the latter sizing.
// Section F/task brief: "a profile with no badges renders an empty shelf
// without breaking the layout" - the non-compact empty state says so in
// text; the compact one (inline in a leaderboard row) stays silent rather
// than adding a caption to every unbadged row.
export function BadgeShelf({
  badges,
  compact = false,
}: {
  badges: BadgeSummary[];
  compact?: boolean;
}) {
  const className = compact ? 'badge-shelf badge-shelf--compact' : 'badge-shelf';

  if (badges.length === 0) {
    if (compact) {
      return <ul className={className} />;
    }
    return <p className="badge-shelf__empty">No badges yet — get out exploring to earn one.</p>;
  }

  return (
    <ul className={className}>
      {badges.map((badge) => (
        <li key={`${badge.kind}-${badge.period}-${badge.periodKey}`}>
          <Badge kind={badge.kind} period={badge.period} />
        </li>
      ))}
    </ul>
  );
}
