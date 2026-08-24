import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';

// SPEC.md Section 8.3/7.7/7.8 (Phase 6 step 4): leaderboard ranking, metric
// and period switching, paging, anonymous rows, the anonymity toggle's
// effect on a subsequent leaderboard view, and the profile's badge shelf
// and current-period progress. A separate file rather than another describe
// block in App.test.tsx (already large), following App.checkin.test.tsx's
// precedent for a phase step - the harness below is a trimmed copy of that
// file's own (no map/geolocation stubs needed here, since none of these
// screens touch the map).

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

type FetchHandler = (url: string, init: RequestInit | undefined) => Promise<Response> | Response;

function stubFetch(handler: FetchHandler) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return handler(url, init);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function searchParamsOf(url: string): URLSearchParams {
  return new URL(url, 'http://localhost').searchParams;
}

async function renderApp(initialPath: string) {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[initialPath]}>
        <App />
      </MemoryRouter>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function click(element: Element) {
  await act(async () => {
    (element as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// Section 8.4: navigation is a bottom tab bar plus a More sheet, so what used
// to be one dropdown is now two surfaces. Which one a destination lives on is
// part of what this change decided, so the tests reach for it the way a
// player would rather than through one helper that searches both.
async function navigateViaTab(label: string) {
  const tab = Array.from(container.querySelectorAll('.bottom-nav a')).find(
    (entry) => entry.textContent?.trim() === label,
  ) as HTMLAnchorElement;
  await click(tab);
}

async function navigateViaMoreSheet(label: string) {
  // The tabs are links; the only button in the bar is More.
  const moreButton = container.querySelector('.bottom-nav button') as HTMLButtonElement;
  act(() => {
    moreButton.click();
  });
  const link = Array.from(container.querySelectorAll('.more-sheet__panel a')).find(
    (entry) => entry.textContent === label,
  ) as HTMLAnchorElement;
  await click(link);
}

function stubSignedInUser(overrides: Record<string, unknown> = {}) {
  return jsonResponse(200, {
    id: 1,
    username: 'alice',
    avatarSeed: 'seed',
    isAdmin: false,
    isAnonymous: false,
    mustChangePassword: false,
    ...overrides,
  });
}

interface Badge {
  kind: 'explorer' | 'barfly';
  period: 'week' | 'month' | 'year';
  periodKey: string;
  value: number;
  awardedAt: number;
}

function badge(overrides: Partial<Badge> = {}): Badge {
  return {
    kind: 'explorer',
    period: 'week',
    periodKey: '2026-W32',
    value: 0.5,
    awardedAt: 100,
    ...overrides,
  };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe('leaderboard', () => {
  it('renders ranked rows, and switching metric and period refetches and re-renders', async () => {
    const fetchMock = stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url.startsWith('/api/leaderboard')) {
        const params = searchParamsOf(url);
        const metric = params.get('metric');
        const period = params.get('period');
        if (metric === 'bars') {
          return jsonResponse(200, {
            metric: 'bars',
            period: 'all',
            page: 1,
            pageSize: 50,
            totalUsers: 2,
            totalPages: 1,
            entries: [
              {
                rank: 1,
                userId: 1,
                displayName: 'alice',
                isAnonymous: false,
                avatarSeed: 'seed',
                value: 7,
                badges: [],
              },
              {
                rank: 2,
                userId: 2,
                displayName: 'bob',
                isAnonymous: false,
                avatarSeed: 'seed2',
                value: 3,
                badges: [],
              },
            ],
          });
        }
        if (period === 'week') {
          return jsonResponse(200, {
            metric: 'area',
            period: 'week',
            page: 1,
            pageSize: 50,
            totalUsers: 1,
            totalPages: 1,
            entries: [
              {
                rank: 1,
                userId: 2,
                displayName: 'bob',
                isAnonymous: false,
                avatarSeed: 'seed2',
                value: 0.4,
                badges: [],
              },
            ],
          });
        }
        return jsonResponse(200, {
          metric: 'area',
          period: 'all',
          page: 1,
          pageSize: 50,
          totalUsers: 2,
          totalPages: 1,
          entries: [
            {
              rank: 1,
              userId: 2,
              displayName: 'bob',
              isAnonymous: false,
              avatarSeed: 'seed2',
              value: 40.5,
              badges: [],
            },
            {
              rank: 2,
              userId: 1,
              displayName: 'alice',
              isAnonymous: false,
              avatarSeed: 'seed',
              value: 12.3,
              badges: [],
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/leaderboard');

    let rows = container.querySelectorAll('.leaderboard__row');
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('.leaderboard__rank')?.textContent).toBe('#1');
    expect(rows[0].querySelector('.leaderboard__name')?.textContent).toBe('bob');
    expect(rows[0].querySelector('.leaderboard__value')?.textContent).toBe('40.5%');
    expect(rows[1].querySelector('.leaderboard__value')?.textContent).toBe('12.3%');

    const barsButton = Array.from(container.querySelectorAll('.leaderboard__toggle-button')).find(
      (button) => button.textContent === 'Bars',
    ) as HTMLButtonElement;
    await click(barsButton);

    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('metric=bars'))).toBe(
      true,
    );
    rows = container.querySelectorAll('.leaderboard__row');
    expect(rows[0].querySelector('.leaderboard__value')?.textContent).toBe('7');
    expect(rows[1].querySelector('.leaderboard__value')?.textContent).toBe('3');

    const areaButton = Array.from(container.querySelectorAll('.leaderboard__toggle-button')).find(
      (button) => button.textContent === 'Area',
    ) as HTMLButtonElement;
    await click(areaButton);
    const weekButton = Array.from(container.querySelectorAll('.leaderboard__toggle-button')).find(
      (button) => button.textContent === 'Week',
    ) as HTMLButtonElement;
    await click(weekButton);

    expect(
      fetchMock.mock.calls.some(
        ([input]) => String(input).includes('metric=area') && String(input).includes('period=week'),
      ),
    ).toBe(true);
    rows = container.querySelectorAll('.leaderboard__row');
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('.leaderboard__name')?.textContent).toBe('bob');
  });

  // The previous rows deliberately stay on screen while the new request is
  // in flight - a blank flash is worse - but they were being formatted with
  // the newly selected metric, so an area percentage lost its "%" and a bar
  // count gained one for as long as the fetch took. Formatting follows the
  // metric the visible response was fetched with, not the live toggle.
  it("keeps the previous metric's formatting on the still-visible rows while the new request is pending", async () => {
    let releaseBars = () => {};
    const barsPending = new Promise<void>((resolve) => {
      releaseBars = resolve;
    });

    stubFetch(async (url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url.startsWith('/api/leaderboard')) {
        if (searchParamsOf(url).get('metric') === 'bars') {
          await barsPending;
          return jsonResponse(200, {
            metric: 'bars',
            period: 'all',
            page: 1,
            pageSize: 50,
            totalUsers: 1,
            totalPages: 1,
            entries: [
              {
                rank: 1,
                userId: 2,
                displayName: 'bob',
                isAnonymous: false,
                avatarSeed: 'seed2',
                value: 7,
                badges: [],
              },
            ],
          });
        }
        return jsonResponse(200, {
          metric: 'area',
          period: 'all',
          page: 1,
          pageSize: 50,
          totalUsers: 1,
          totalPages: 1,
          entries: [
            {
              rank: 1,
              userId: 2,
              displayName: 'bob',
              isAnonymous: false,
              avatarSeed: 'seed2',
              value: 40.5,
              badges: [],
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/leaderboard');
    expect(container.querySelector('.leaderboard__value')?.textContent).toBe('40.5%');

    const barsButton = Array.from(container.querySelectorAll('.leaderboard__toggle-button')).find(
      (button) => button.textContent === 'Bars',
    ) as HTMLButtonElement;
    await click(barsButton);

    // The bars request has not answered yet: the row is still the area one,
    // and must still read as an area percentage.
    expect(container.querySelector('.leaderboard__name')?.textContent).toBe('bob');
    expect(container.querySelector('.leaderboard__value')?.textContent).toBe('40.5%');

    releaseBars();
    await flush();

    expect(container.querySelector('.leaderboard__value')?.textContent).toBe('7');
  });

  // The loading message answers "there is nothing here yet", and nothing
  // else. A refetch deliberately keeps the table on screen (see above), and
  // against a server on the local network it answers in tens of
  // milliseconds - so the message appeared over a full table and was gone
  // again before it could be read, which reads as a flicker and a bug
  // rather than as progress.
  describe('the loading message', () => {
    function loadingMessage(): Element | null {
      return (
        Array.from(container.querySelectorAll('[role="status"]')).find((element) =>
          element.textContent?.includes('Loading the leaderboard'),
        ) ?? null
      );
    }

    function entry(displayName: string, value: number) {
      return {
        rank: 1,
        userId: 2,
        displayName,
        isAnonymous: false,
        avatarSeed: 'seed2',
        value,
        badges: [],
      };
    }

    function pageOf(period: string, displayName: string, value: number) {
      return {
        metric: 'area',
        period,
        page: 1,
        pageSize: 50,
        totalUsers: 1,
        totalPages: 1,
        entries: [entry(displayName, value)],
      };
    }

    it('is shown on a first load, while there is nothing on screen yet', async () => {
      let release = () => {};
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });

      stubFetch(async (url) => {
        if (url.startsWith('/api/auth/me')) {
          return stubSignedInUser();
        }
        if (url.startsWith('/api/leaderboard')) {
          await pending;
          return jsonResponse(200, pageOf('all', 'bob', 40.5));
        }
        throw new Error(`Unexpected request: ${url}`);
      });

      await renderApp('/leaderboard');

      expect(container.querySelector('.leaderboard__row')).toBeNull();
      expect(loadingMessage()).not.toBeNull();

      release();
      await flush();

      expect(container.querySelector('.leaderboard__row')).not.toBeNull();
      expect(loadingMessage()).toBeNull();
    });

    it('is not shown on a refetch that still has its table on screen', async () => {
      let releaseWeek = () => {};
      const weekPending = new Promise<void>((resolve) => {
        releaseWeek = resolve;
      });

      stubFetch(async (url) => {
        if (url.startsWith('/api/auth/me')) {
          return stubSignedInUser();
        }
        if (url.startsWith('/api/leaderboard')) {
          if (searchParamsOf(url).get('period') === 'week') {
            await weekPending;
            return jsonResponse(200, pageOf('week', 'carol', 12.5));
          }
          return jsonResponse(200, pageOf('all', 'bob', 40.5));
        }
        throw new Error(`Unexpected request: ${url}`);
      });

      await renderApp('/leaderboard');
      expect(container.querySelector('.leaderboard__name')?.textContent).toBe('bob');

      const weekButton = Array.from(container.querySelectorAll('.leaderboard__toggle-button')).find(
        (button) => button.textContent === 'Week',
      ) as HTMLButtonElement;
      await click(weekButton);

      // The week request is still in flight: no message, and the previous
      // rows are still the ones on screen.
      expect(loadingMessage()).toBeNull();
      expect(container.querySelector('.leaderboard__row')).not.toBeNull();
      expect(container.querySelector('.leaderboard__name')?.textContent).toBe('bob');

      releaseWeek();
      await flush();

      expect(loadingMessage()).toBeNull();
      expect(container.querySelector('.leaderboard__name')?.textContent).toBe('carol');
    });
  });

  it('shows an anonymous row masked, still ranked, with its badges', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url.startsWith('/api/leaderboard')) {
        return jsonResponse(200, {
          metric: 'area',
          period: 'all',
          page: 1,
          pageSize: 50,
          totalUsers: 1,
          totalPages: 1,
          entries: [
            {
              rank: 3,
              userId: 5,
              displayName: 'Player #5',
              isAnonymous: true,
              avatarSeed: 'anonymous-player',
              value: 9.1,
              badges: [badge({ kind: 'barfly', period: 'month', periodKey: '2026-08' })],
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/leaderboard');

    const row = container.querySelector('.leaderboard__row') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.querySelector('.leaderboard__rank')?.textContent).toBe('#3');
    expect(row.querySelector('.leaderboard__name')?.textContent).toContain('Player #5');
    expect(row.querySelector('.avatar svg')).not.toBeNull();
    const badgeEl = row.querySelector('.badge');
    expect(badgeEl).not.toBeNull();
    expect(badgeEl?.getAttribute('aria-label')).toBe('Barfly badge, month');
  });

  it('reflects a toggled anonymity setting on the next leaderboard view without a reload', async () => {
    let anonymous = false;
    stubFetch((url, init) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser({ id: 9, isAnonymous: anonymous });
      }
      if (url === '/api/settings' && init?.method === 'PATCH') {
        anonymous = (JSON.parse((init.body as string) ?? '{}') as { isAnonymous: boolean })
          .isAnonymous;
        return stubSignedInUser({ id: 9, isAnonymous: anonymous });
      }
      if (url.startsWith('/api/leaderboard')) {
        return jsonResponse(200, {
          metric: 'area',
          period: 'all',
          page: 1,
          pageSize: 50,
          totalUsers: 1,
          totalPages: 1,
          entries: [
            {
              rank: 1,
              userId: 9,
              displayName: anonymous ? 'Player #9' : 'alice',
              isAnonymous: anonymous,
              avatarSeed: anonymous ? 'anonymous-player' : 'seed',
              value: 1,
              badges: [],
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/leaderboard');
    expect(container.querySelector('.leaderboard__name')?.textContent).toContain('alice');
    expect(container.querySelector('.leaderboard__name')?.textContent).not.toContain('Player #9');

    await navigateViaMoreSheet('Settings');
    const checkbox = container.querySelector('#settings-anonymous') as HTMLInputElement;
    await click(checkbox);
    expect(checkbox.checked).toBe(true);

    await navigateViaTab('Ranks');
    await flush();

    expect(container.querySelector('.leaderboard__name')?.textContent).toContain('Player #9');
  });

  it('pages without duplicating rows', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser({ id: 100 });
      }
      if (url.startsWith('/api/leaderboard')) {
        const page = searchParamsOf(url).get('page') ?? '1';
        const entries =
          page === '2'
            ? [4, 5, 6].map((id) => ({
                rank: id,
                userId: id,
                displayName: `user${id}`,
                isAnonymous: false,
                avatarSeed: `seed${id}`,
                value: id,
                badges: [],
              }))
            : [1, 2, 3].map((id) => ({
                rank: id,
                userId: id,
                displayName: `user${id}`,
                isAnonymous: false,
                avatarSeed: `seed${id}`,
                value: id,
                badges: [],
              }));
        return jsonResponse(200, {
          metric: 'area',
          period: 'all',
          page: Number(page),
          pageSize: 3,
          totalUsers: 6,
          totalPages: 2,
          entries,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/leaderboard');

    const namesOnPage1 = Array.from(container.querySelectorAll('.leaderboard__name')).map(
      (el) => el.textContent,
    );
    expect(namesOnPage1).toEqual(['user1', 'user2', 'user3']);

    const previousButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Previous',
    ) as HTMLButtonElement;
    expect(previousButton.disabled).toBe(true);

    const nextButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Next',
    ) as HTMLButtonElement;
    await click(nextButton);

    const namesOnPage2 = Array.from(container.querySelectorAll('.leaderboard__name')).map(
      (el) => el.textContent,
    );
    expect(namesOnPage2).toEqual(['user4', 'user5', 'user6']);
    expect(namesOnPage2.some((name) => namesOnPage1.includes(name))).toBe(false);

    expect(previousButton.disabled).toBe(false);
    expect(nextButton.disabled).toBe(true);
  });
});

describe('profile', () => {
  it("renders the badge shelf and the player's own value for each kind and period", async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url === '/api/profile/player-1') {
        return jsonResponse(200, {
          userId: 1,
          handle: 'player-1',
          displayName: 'alice',
          isAnonymous: false,
          avatarSeed: 'seed',
          areaPercent: 8.42,
          barsMastered: 3,
          badges: [
            badge({ kind: 'explorer', period: 'week', periodKey: '2026-W32' }),
            badge({ kind: 'barfly', period: 'month', periodKey: '2026-08' }),
          ],
          badgeProgress: {
            week: [
              { kind: 'explorer', value: 0.05 },
              { kind: 'barfly', value: 1 },
            ],
            month: [
              { kind: 'explorer', value: 0.2 },
              { kind: 'barfly', value: 2 },
            ],
            year: [
              { kind: 'explorer', value: 1 },
              { kind: 'barfly', value: 1 },
            ],
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/profile/player-1');

    expect(container.querySelector('h1')?.textContent).toBe('alice');
    const stats = container.querySelectorAll('.profile__stats dd');
    expect(stats[0].textContent).toBe('8.4%');
    expect(stats[1].textContent).toBe('3');

    const badges = container.querySelectorAll('.badge-shelf:not(.badge-shelf--compact) .badge');
    expect(badges).toHaveLength(2);
    expect(badges[0].getAttribute('aria-label')).toBe('Explorer badge, week');
    expect(badges[1].getAttribute('aria-label')).toBe('Barfly badge, month');

    const progressItems = container.querySelectorAll('.profile__progress-item');
    expect(progressItems).toHaveLength(6);

    const weekExplorer = Array.from(progressItems).find((item) =>
      item.textContent?.includes('This week'),
    );
    expect(weekExplorer?.querySelector('.profile__progress-detail')?.textContent).toBe('0.05%');

    const monthBarfly = Array.from(progressItems).find(
      (item) =>
        item.textContent?.includes('This month') && item.textContent?.includes('Bars mastered'),
    );
    expect(monthBarfly?.querySelector('.profile__progress-detail')?.textContent).toBe('2');

    // SPEC.md Section 7.7: no threshold, no target, no rank reaches the
    // player — the section shows the player's own value and nothing else.
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    const progressSection = weekExplorer?.closest('.profile__section');
    expect(progressSection?.textContent).not.toContain('to go');
    expect(progressSection?.textContent).not.toContain(' of ');
  });

  it('renders an empty badge shelf without breaking the layout for a new user', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url === '/api/profile/player-1') {
        return jsonResponse(200, {
          userId: 1,
          handle: 'player-1',
          displayName: 'alice',
          isAnonymous: false,
          avatarSeed: 'seed',
          areaPercent: 0,
          barsMastered: 0,
          badges: [],
          badgeProgress: {
            week: [
              { kind: 'explorer', value: 0 },
              { kind: 'barfly', value: 0 },
            ],
            month: [
              { kind: 'explorer', value: 0 },
              { kind: 'barfly', value: 0 },
            ],
            year: [
              { kind: 'explorer', value: 0 },
              { kind: 'barfly', value: 0 },
            ],
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/profile/player-1');

    // No earned badges and therefore no earned shelf - what fills the space
    // is the full catalogue as placeholders (Section 7.7), which is the whole
    // point of a shelf that used to be a single apologetic sentence.
    expect(container.querySelector('.badge-shelf__empty')).toBeNull();
    expect(
      container.querySelectorAll('.badge-shelf:not(.badge-shelf--compact) .badge'),
    ).toHaveLength(0);
    expect(container.querySelectorAll('.badge-placeholder')).toHaveLength(6);
    expect(container.querySelectorAll('.profile__progress-item')).toHaveLength(6);
    expect(container.querySelectorAll('.profile__stats dd')).toHaveLength(2);
  });
});

// SPEC.md Section 7.7's placeholders: the badges a player has not earned,
// shown so they can be wanted. Everything here is one rule seen from a
// different side - a placeholder says a badge exists and stays silent about
// the number, because the number is both forbidden (the threshold is never
// shown and no endpoint returns it) and, a badge being a competition decided
// at the end of its period, not an answer to "what must I do" in the first
// place.
describe('badge placeholders', () => {
  function profileBody(overrides: Record<string, unknown> = {}) {
    return {
      userId: 1,
      handle: 'player-1',
      displayName: 'alice',
      isAnonymous: false,
      avatarSeed: 'seed',
      areaPercent: 0,
      barsMastered: 0,
      badges: [] as Badge[],
      badgeProgress: { week: [], month: [], year: [] },
      ...overrides,
    };
  }

  function stubProfile(body: ReturnType<typeof profileBody>) {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url === `/api/profile/${String(body.handle)}`) {
        return jsonResponse(200, body);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
  }

  function placeholderLabels(): (string | null)[] {
    return Array.from(container.querySelectorAll('.badge-placeholder')).map((el) =>
      el.getAttribute('aria-label'),
    );
  }

  const ALL_PLACEHOLDER_LABELS = [
    'Not yet earned: Explorer badge, week',
    'Not yet earned: Explorer badge, month',
    'Not yet earned: Explorer badge, year',
    'Not yet earned: Barfly badge, week',
    'Not yet earned: Barfly badge, month',
    'Not yet earned: Barfly badge, year',
  ];

  // The worst failure available in this feature is telling a screen reader
  // user they hold a badge they do not, so the two names are pinned exactly
  // rather than by substring: an earned badge and a placeholder for the same
  // (kind, period) must not be able to announce the same words.
  it('announces an unearned badge as unearned and an earned one as earned', async () => {
    stubProfile(
      profileBody({
        badges: [badge({ kind: 'explorer', period: 'week', periodKey: '2026-W32' })],
      }),
    );

    await renderApp('/profile/player-1');

    const earned = Array.from(
      container.querySelectorAll('.badge-shelf:not(.badge-shelf--compact) .badge'),
    ).map((el) => el.getAttribute('aria-label'));
    expect(earned).toEqual(['Explorer badge, week']);

    expect(placeholderLabels()).toEqual([
      'Not yet earned: Explorer badge, month',
      'Not yet earned: Explorer badge, year',
      'Not yet earned: Barfly badge, week',
      'Not yet earned: Barfly badge, month',
      'Not yet earned: Barfly badge, year',
    ]);
    expect(placeholderLabels()).not.toContain('Explorer badge, week');
  });

  // Once a type has been held once its placeholder is done, permanently.
  // Badges recur - explorer/week is won again every week someone leads it -
  // and a placeholder keyed on the period *key* would come back every Monday
  // and blink off whenever the evaluation job ran, showing a player a badge
  // they own several of.
  it('keeps a type off the shelf however many periods it was won in', async () => {
    stubProfile(
      profileBody({
        badges: [
          badge({ kind: 'barfly', period: 'month', periodKey: '2026-06' }),
          badge({ kind: 'barfly', period: 'month', periodKey: '2026-07' }),
          badge({ kind: 'barfly', period: 'month', periodKey: '2026-08' }),
        ],
      }),
    );

    await renderApp('/profile/player-1');

    expect(
      container.querySelectorAll('.badge-shelf:not(.badge-shelf--compact) .badge'),
    ).toHaveLength(3);
    expect(placeholderLabels()).toEqual(
      ALL_PLACEHOLDER_LABELS.filter((label) => label !== 'Not yet earned: Barfly badge, month'),
    );
  });

  // The rule that matters most. If a placeholder looked any different once a
  // player passed the floor - brighter, nearer, anything - the threshold
  // Section 7.7 keeps off the screen could be read back off it by walking
  // until the pixel changed. So the set, and every attribute of every glyph in
  // it, is compared across two players who are identical in what they have
  // earned and as far apart as the data allows in what they are currently
  // worth. Comparing the markup rather than the labels is deliberate: a leak
  // dressed as a class name or an inline style has to fail this too.
  it('draws the same placeholders whatever the player is currently worth', async () => {
    async function placeholderMarkupFor(badgeProgress: unknown): Promise<string | undefined> {
      act(() => {
        root.unmount();
      });
      root = createRoot(container);
      stubProfile(
        profileBody({
          badges: [badge({ kind: 'explorer', period: 'year', periodKey: '2026' })],
          badgeProgress,
        }),
      );
      await renderApp('/profile/player-1');
      return container.querySelector('.badge-shelf--placeholders')?.outerHTML;
    }

    const atZero = await placeholderMarkupFor({
      week: [
        { kind: 'explorer', value: 0 },
        { kind: 'barfly', value: 0 },
      ],
      month: [],
      year: [],
    });
    const wellPastAnyFloor = await placeholderMarkupFor({
      week: [
        { kind: 'explorer', value: 47.5 },
        { kind: 'barfly', value: 99 },
      ],
      month: [],
      year: [],
    });

    expect(atZero).toBeDefined();
    expect(wellPastAnyFloor).toBe(atZero);
  });

  // The placeholders belong to the player whose question they answer. On
  // someone else's profile they would be an inventory of what that player has
  // failed to win, and "three of six" is a completion score comparable across
  // players - a standing by another name, which Section 7.7 declines to
  // publish. The old empty-shelf sentence is what a stranger's bare profile
  // still shows.
  it("shows no placeholders on another player's profile", async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser({ id: 1 });
      }
      if (url === '/api/profile/player-2') {
        return jsonResponse(
          200,
          profileBody({ userId: 2, handle: 'player-2', displayName: 'bob' }),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/profile/player-2');

    expect(container.querySelector('h1')?.textContent).toBe('bob');
    expect(container.querySelectorAll('.badge-placeholder')).toHaveLength(0);
    expect(container.querySelector('.badge-shelf__note')).toBeNull();
    expect(container.querySelector('.badge-shelf__empty')?.textContent).toContain('No badges yet');
  });

  // The other call site. A shelf is drawn per leaderboard row, so placeholders
  // there would be six grey glyphs on every row of a ranked list, burying the
  // badges people actually won.
  it("shows no placeholders in the leaderboard's compact shelves", async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      if (url.startsWith('/api/leaderboard')) {
        return jsonResponse(200, {
          metric: 'area',
          period: 'all',
          page: 1,
          pageSize: 50,
          totalUsers: 2,
          totalPages: 1,
          entries: [
            {
              rank: 1,
              userId: 2,
              displayName: 'bob',
              isAnonymous: false,
              avatarSeed: 'seed2',
              value: 10,
              badges: [badge({ kind: 'barfly', period: 'week', periodKey: '2026-W32' })],
            },
            {
              rank: 2,
              userId: 1,
              displayName: 'alice',
              isAnonymous: false,
              avatarSeed: 'seed',
              value: 5,
              badges: [],
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/leaderboard');

    expect(container.querySelectorAll('.leaderboard__row')).toHaveLength(2);
    expect(container.querySelectorAll('.badge-shelf--compact .badge')).toHaveLength(1);
    expect(container.querySelectorAll('.badge-placeholder')).toHaveLength(0);
    expect(container.querySelector('.badge-shelf__heading')).toBeNull();
    expect(container.querySelector('.badge-shelf__note')).toBeNull();
  });

  // What a placeholder may say, and what it may not. The copy names the two
  // activities in words and says outright that no score secures a badge; there
  // is no threshold, no distance from one, no rank and no bar anywhere near
  // it, and no digit at all in the whole section.
  it('answers "what do I have to do?" in words, with no number anywhere in it', async () => {
    stubProfile(profileBody());

    await renderApp('/profile/player-1');

    const note = container.querySelector('.badge-shelf__note')?.textContent ?? '';
    expect(note).toContain('Explore new ground, master new bars.');
    expect(note).toContain('no fixed score wins one');

    const section = container.querySelector('.badge-shelf__heading')?.closest('.profile__section');
    expect(section?.querySelector('h2')?.textContent).toBe('Badges');
    expect(section?.textContent ?? '').not.toMatch(/\d/);
    expect(section?.textContent ?? '').not.toContain('%');
    expect(section?.querySelector('[role="progressbar"]')).toBeNull();
    for (const placeholder of container.querySelectorAll('.badge-placeholder')) {
      expect(placeholder.textContent).toBe('');
      expect(placeholder.getAttribute('title')).toBeNull();
    }
  });
});
