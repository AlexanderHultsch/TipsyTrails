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

function openBurgerMenu(): void {
  const menuButton = container.querySelector('.burger-menu__button') as HTMLButtonElement;
  act(() => {
    menuButton.click();
  });
}

async function navigateViaMenu(label: string) {
  openBurgerMenu();
  const link = Array.from(container.querySelectorAll('.burger-menu__panel a')).find(
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
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Loading');
    expect(container.querySelector('.leaderboard__name')?.textContent).toBe('bob');
    expect(container.querySelector('.leaderboard__value')?.textContent).toBe('40.5%');

    releaseBars();
    await flush();

    expect(container.querySelector('.leaderboard__value')?.textContent).toBe('7');
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

    await navigateViaMenu('Settings');
    const checkbox = container.querySelector('#settings-anonymous') as HTMLInputElement;
    await click(checkbox);
    expect(checkbox.checked).toBe(true);

    await navigateViaMenu('Leaderboard');
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
  it('renders the badge shelf and current-period progress toward each threshold', async () => {
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
              { kind: 'explorer', value: 0.05, threshold: 0.1 },
              { kind: 'barfly', value: 1, threshold: 1 },
            ],
            month: [
              { kind: 'explorer', value: 0.2, threshold: 0.3 },
              { kind: 'barfly', value: 2, threshold: 2 },
            ],
            year: [
              { kind: 'explorer', value: 1, threshold: 2 },
              { kind: 'barfly', value: 1, threshold: 3 },
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
    expect(weekExplorer?.querySelector('.profile__progress-detail')?.textContent).toBe(
      '0.05% of 0.10% (0.05% to go)',
    );

    const monthBarfly = Array.from(progressItems).find(
      (item) =>
        item.textContent?.includes('This month') && item.textContent?.includes('Bars mastered'),
    );
    expect(monthBarfly?.querySelector('.profile__progress-detail')?.textContent).toBe(
      '2 of 2 — earned',
    );
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
              { kind: 'explorer', value: 0, threshold: 0.1 },
              { kind: 'barfly', value: 0, threshold: 1 },
            ],
            month: [
              { kind: 'explorer', value: 0, threshold: 0.3 },
              { kind: 'barfly', value: 0, threshold: 2 },
            ],
            year: [
              { kind: 'explorer', value: 0, threshold: 2 },
              { kind: 'barfly', value: 0, threshold: 3 },
            ],
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/profile/player-1');

    expect(container.querySelector('.badge-shelf__empty')).not.toBeNull();
    expect(
      container.querySelectorAll('.badge-shelf:not(.badge-shelf--compact) .badge'),
    ).toHaveLength(0);
    expect(container.querySelectorAll('.profile__progress-item')).toHaveLength(6);
    expect(container.querySelectorAll('.profile__stats dd')).toHaveLength(2);
  });
});
