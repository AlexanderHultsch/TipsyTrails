import { useEffect, useState } from 'react';
import { DERIVED } from '@tipsytrails/shared';
import type { VisitSummary } from '../api/types.js';

const TICK_MS = 1000;

function formatDuration(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

// Section 7.5's transparency requirements: an active pending visit is shown
// persistently at the top of the screen with bar name, elapsed confirmed
// time and remaining time, "accurate at all times" (Section 12's DoD
// wording) - so both are derived from `startedAt` and a ticking clock here,
// not from the server's last-reported confirmedS/remainingS, which would
// freeze between POST /api/samples calls. DERIVED.VISIT_REQUIRED_S
// (packages/shared/src/config.ts) is the one source of truth for the
// threshold. Multiple simultaneous pending visits (Section 7.5) render as a
// list rather than assuming there is only one.
export function PendingVisitBanner({
  visits,
  outOfRangeVisitIds,
}: {
  visits: VisitSummary[];
  outOfRangeVisitIds: ReadonlySet<number>;
}) {
  const [nowS, setNowS] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    if (visits.length === 0) {
      return;
    }
    const interval = setInterval(() => {
      setNowS(Math.floor(Date.now() / 1000));
    }, TICK_MS);
    return () => clearInterval(interval);
  }, [visits.length]);

  if (visits.length === 0) {
    return null;
  }

  return (
    <div className="pending-visit-banner" role="status">
      <ul className="pending-visit-banner__list">
        {visits.map((visit) => {
          const elapsedS = nowS - visit.startedAt;
          const remainingS = Math.max(0, DERIVED.VISIT_REQUIRED_S - elapsedS);
          return (
            <li key={visit.id} className="pending-visit-banner__item">
              <p className="pending-visit-banner__bar">{visit.barName}</p>
              <p className="pending-visit-banner__time">
                Confirmed {formatDuration(elapsedS)} - {formatDuration(remainingS)} remaining
              </p>
              {outOfRangeVisitIds.has(visit.id) && (
                <p className="pending-visit-banner__out-of-range error-message">
                  You&apos;ve moved away from {visit.barName} — your visit is still pending
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <p className="pending-visit-banner__hint">
        Open Tipsy Trails again while you&apos;re still here to complete this visit.
      </p>
    </div>
  );
}
