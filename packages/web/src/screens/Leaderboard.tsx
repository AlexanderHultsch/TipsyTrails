import { useEffect, useState } from 'react';
import { ApiError, getLeaderboard } from '../api/client.js';
import type { LeaderboardResponse } from '../api/types.js';
import { useCurrentUser } from '../auth/CurrentUserContext.js';
import { Avatar } from '../components/Avatar.js';
import { BadgeShelf } from '../components/Badge.js';
import { BurgerMenu } from '../components/BurgerMenu.js';

type Metric = 'area' | 'bars';
type Period = 'all' | 'week' | 'month';

const METRICS: { value: Metric; label: string }[] = [
  { value: 'area', label: 'Area' },
  { value: 'bars', label: 'Bars' },
];

const PERIODS: { value: Period; label: string }[] = [
  { value: 'all', label: 'All-time' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
];

function formatValue(metric: Metric, value: number): string {
  return metric === 'area' ? `${value.toFixed(1)}%` : `${value}`;
}

// SPEC.md Section 8.3/7.8: ranked list, metric toggle, period filter, paged
// at CONFIG.LEADERBOARD_PAGE_SIZE (the server's own page size - not
// duplicated here, `data.response.pageSize`/`data.response.totalPages`
// below come straight from GET /api/leaderboard). Section 7.8's anonymous
// rendering is not special-cased client-side at all:
// `displayName`/`avatarSeed` are rendered exactly as the server sends them
// (routes/leaderboard.ts already applies the mask), so this screen cannot
// disagree with it.
//
// `data` holds the response together with the metric it was fetched with,
// and `formatValue` is given that stored metric rather than the live one.
// Switching metric deliberately leaves the previous rows on screen while
// the new request is in flight (a blank flash is worse), so formatting
// against the live `metric` relabelled those still-visible rows: an area
// percentage lost its "%", a bar count gained one.
export function Leaderboard() {
  const { user } = useCurrentUser();
  const [metric, setMetric] = useState<Metric>('area');
  const [period, setPeriod] = useState<Period>('all');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ response: LeaderboardResponse; metric: Metric } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getLeaderboard({ metric, period, page })
      .then((result) => {
        if (!cancelled) setData({ response: result, metric });
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
  }, [metric, period, page]);

  function changeMetric(next: Metric) {
    setMetric(next);
    setPage(1);
  }

  function changePeriod(next: Period) {
    setPeriod(next);
    setPage(1);
  }

  return (
    <main className="screen">
      <BurgerMenu />
      <div className="screen__content leaderboard">
        <h1>Leaderboard</h1>

        <div className="leaderboard__controls">
          <div className="leaderboard__toggle" role="group" aria-label="Metric">
            {METRICS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={
                  option.value === metric
                    ? 'leaderboard__toggle-button leaderboard__toggle-button--active'
                    : 'leaderboard__toggle-button'
                }
                aria-pressed={option.value === metric}
                onClick={() => changeMetric(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="leaderboard__toggle" role="group" aria-label="Period">
            {PERIODS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={
                  option.value === period
                    ? 'leaderboard__toggle-button leaderboard__toggle-button--active'
                    : 'leaderboard__toggle-button'
                }
                aria-pressed={option.value === period}
                onClick={() => changePeriod(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {loading && <p role="status">Loading the leaderboard…</p>}
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}

        {data && data.response.entries.length === 0 && <p>No players yet.</p>}

        {data && data.response.entries.length > 0 && (
          <>
            <ol className="leaderboard__list">
              {data.response.entries.map((entry) => {
                const isSelf = user?.id === entry.userId;
                return (
                  <li
                    key={entry.userId}
                    className={
                      isSelf ? 'leaderboard__row leaderboard__row--self' : 'leaderboard__row'
                    }
                  >
                    <span className="leaderboard__rank">#{entry.rank}</span>
                    <Avatar seed={entry.avatarSeed} className="leaderboard__avatar" />
                    <span className="leaderboard__name">
                      {entry.displayName}
                      {isSelf && <span className="leaderboard__self-tag"> (you)</span>}
                    </span>
                    <BadgeShelf badges={entry.badges} compact />
                    <span className="leaderboard__value">
                      {formatValue(data.metric, entry.value)}
                    </span>
                  </li>
                );
              })}
            </ol>

            <div className="leaderboard__pager">
              <button
                type="button"
                className="button button--secondary"
                disabled={data.response.page <= 1}
                onClick={() => setPage((current) => current - 1)}
              >
                Previous
              </button>
              <span>
                Page {data.response.page} of {data.response.totalPages}
              </span>
              <button
                type="button"
                className="button button--secondary"
                disabled={data.response.page >= data.response.totalPages}
                onClick={() => setPage((current) => current + 1)}
              >
                Next
              </button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
