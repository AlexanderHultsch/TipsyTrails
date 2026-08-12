import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { BadgePeriod } from '@tipsytrails/shared';
import { ApiError, getProfile } from '../api/client.js';
import type { BadgeKind, ProfileResponse } from '../api/types.js';
import { Avatar } from '../components/Avatar.js';
import { BadgeShelf } from '../components/Badge.js';
import { BurgerMenu } from '../components/BurgerMenu.js';

const PROGRESS_PERIODS: readonly BadgePeriod[] = ['week', 'month', 'year'];

const PROGRESS_PERIOD_LABEL: Record<BadgePeriod, string> = {
  week: 'This week',
  month: 'This month',
  year: 'This year',
};

const PROGRESS_KIND_LABEL: Record<BadgeKind, string> = {
  explorer: 'Area explored',
  barfly: 'Bars mastered',
};

function formatMetric(kind: BadgeKind, value: number): string {
  return kind === 'explorer' ? `${value.toFixed(2)}%` : `${value}`;
}

// SPEC.md Section 8.3/7.6/7.7: username or masked handle, avatar, badge
// shelf, area %, bars mastered, and live "on track" progress toward each
// period's threshold - all read from the single GET /api/profile/:handle
// response (task brief: "the server already returns all of it in one
// response — do not make a second request"). Thresholds and progress values
// are never recomputed here, only formatted.
export function Profile() {
  const { handle } = useParams<{ handle: string }>();
  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!handle) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setProfile(null);

    getProfile(handle)
      .then((result) => {
        if (!cancelled) setProfile(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [handle]);

  return (
    <main className="screen">
      <BurgerMenu />
      <div className="screen__content profile">
        {loading && <p role="status">Loading profile…</p>}
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        {profile && (
          <>
            <Avatar seed={profile.avatarSeed} className="profile__avatar" />
            <h1>{profile.displayName}</h1>

            <dl className="profile__stats">
              <div>
                <dt>Area explored</dt>
                <dd>{profile.areaPercent.toFixed(1)}%</dd>
              </div>
              <div>
                <dt>Bars mastered</dt>
                <dd>{profile.barsMastered}</dd>
              </div>
            </dl>

            <section className="profile__section">
              <h2>Badges</h2>
              <BadgeShelf badges={profile.badges} />
            </section>

            <section className="profile__section">
              <h2>Current progress</h2>
              <ul className="profile__progress-list">
                {PROGRESS_PERIODS.flatMap((period) =>
                  profile.badgeProgress[period].map((entry) => {
                    const met = entry.value >= entry.threshold;
                    const gap = Math.max(0, entry.threshold - entry.value);
                    const fillPercent = Math.min(100, (entry.value / entry.threshold) * 100);
                    return (
                      <li key={`${period}-${entry.kind}`} className="profile__progress-item">
                        <span className="profile__progress-label">
                          {PROGRESS_KIND_LABEL[entry.kind]} — {PROGRESS_PERIOD_LABEL[period]}
                        </span>
                        <div
                          className="profile__progress-bar"
                          role="progressbar"
                          aria-valuenow={Math.min(entry.value, entry.threshold)}
                          aria-valuemin={0}
                          aria-valuemax={entry.threshold}
                        >
                          <div
                            className={
                              met
                                ? 'profile__progress-fill profile__progress-fill--met'
                                : 'profile__progress-fill'
                            }
                            style={{ width: `${fillPercent}%` }}
                          />
                        </div>
                        <span className="profile__progress-detail">
                          {met
                            ? `${formatMetric(entry.kind, entry.value)} of ${formatMetric(entry.kind, entry.threshold)} — earned`
                            : `${formatMetric(entry.kind, entry.value)} of ${formatMetric(entry.kind, entry.threshold)} (${formatMetric(entry.kind, gap)} to go)`}
                        </span>
                      </li>
                    );
                  }),
                )}
              </ul>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
