import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { BADGE_PERIODS } from '@tipsytrails/shared';
import type { BadgePeriod } from '@tipsytrails/shared';
import { errorMessage, getProfile } from '../api/client.js';
import type { BadgeKind, ProfileResponse } from '../api/types.js';
import { useCurrentUser } from '../auth/CurrentUserContext.js';
import { Avatar } from '../components/Avatar.js';
import { BadgeShelf } from '../components/Badge.js';
import { BottomNav } from '../components/BottomNav.js';
import { Wordmark } from '../components/Wordmark.js';

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
// shelf, area %, bars mastered, and the player's own value for each kind in
// each running period - all read from the single GET /api/profile/:handle
// response (task brief: "the server already returns all of it in one
// response — do not make a second request"). Values are never recomputed
// here, only formatted. Section 7.7 publishes no threshold and no rank, so
// there is nothing here to render a value against.
//
// The shelf shows placeholders for the badges the player has never held, and
// only on the player's *own* profile. The question they exist to raise -
// "what do I have to do to get that?" - is one only the player themselves can
// act on, and six grey glyphs on someone else's profile would instead read as
// an inventory of what that player has failed to win, with "three of six" a
// completion score comparable across players. That is a standing by another
// name, and Section 7.7 declines to publish standings. Nothing is concealed by
// the choice - the badges another player holds are public, and so therefore is
// what is missing from them - it is simply not a thing to draw.
export function Profile() {
  const { handle } = useParams<{ handle: string }>();
  const { user } = useCurrentUser();
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
        setError(errorMessage(err));
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
      <BottomNav />
      <div className="screen__content profile">
        {/* Outside the `profile &&` branch below, so the application signs the
            screen while the profile is still loading and while it is failing -
            a main screen that is briefly nothing but a spinner is exactly the
            "collection of separate screens" this wordmark exists against. */}
        <Wordmark prominence="chrome" />
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
              {/* Compared on the numeric user id rather than on the handle:
                  the same player resolves under two handles (their username
                  and `player-{id}`, Section 9.5) and under only one id. */}
              <BadgeShelf badges={profile.badges} showPlaceholders={user?.id === profile.userId} />
            </section>

            <section className="profile__section">
              <h2>Current progress</h2>
              <ul className="profile__progress-list">
                {BADGE_PERIODS.flatMap((period) =>
                  profile.badgeProgress[period].map((entry) => (
                    <li key={`${period}-${entry.kind}`} className="profile__progress-item">
                      <span className="profile__progress-label">
                        {PROGRESS_KIND_LABEL[entry.kind]} — {PROGRESS_PERIOD_LABEL[period]}
                      </span>
                      <span className="profile__progress-detail">
                        {formatMetric(entry.kind, entry.value)}
                      </span>
                    </li>
                  )),
                )}
              </ul>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
