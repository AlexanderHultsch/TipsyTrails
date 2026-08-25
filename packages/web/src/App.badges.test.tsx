import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';

// SPEC.md Sections 7.7 and 8.3: tapping a badge on the player's own profile
// opens a sheet that says what the badge is, what earns it and over what
// window - earned or not, which is the owner's "even not achieved badges need
// to be described on request".
//
// A file of its own rather than another describe block in
// App.leaderboard.test.tsx (already ~1000 lines and about ranking), following
// the precedent App.checkin.test.tsx and App.privacy.test.tsx set for a
// feature; the harness below is a trimmed copy of that file's own, with no
// map or geolocation stubs because the profile touches neither.
//
// Almost every test here exists to fail on one specific way of getting this
// wrong, and the ways are not symmetrical. A sheet that shows the same words
// for two kinds is a nuisance; a sheet that shows a number on a badge the
// player has not earned hands back the threshold Section 7.7 exists to keep
// off the screen, and no test that only ever opens an earned badge can see it.

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

async function click(element: Element) {
  await act(async () => {
    (element as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
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
    // Deliberately not zero. Every test that opens an unearned badge does so
    // against a player whose running values are large and distinctive, so a
    // sheet that leaked one would show a string no other part of this fixture
    // could have produced.
    badgeProgress: {
      week: [
        { kind: 'explorer', value: 47.53 },
        { kind: 'barfly', value: 99 },
      ],
      month: [],
      year: [],
    },
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

function earnedBadges(): HTMLElement[] {
  return Array.from(
    container.querySelectorAll('.badge-shelf:not(.badge-shelf--compact) .badge'),
  ) as HTMLElement[];
}

function placeholders(): HTMLElement[] {
  return Array.from(container.querySelectorAll('.badge-placeholder')) as HTMLElement[];
}

function sheet(): HTMLElement | null {
  return container.querySelector('.badge-sheet__panel');
}

function sheetText(): string {
  return sheet()?.textContent ?? '';
}

async function openBadgeSheet(handle: string, body: ReturnType<typeof profileBody>, index = 0) {
  stubProfile(body);
  await renderApp(`/profile/${handle}`);
  await click(earnedBadges()[index]);
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
  vi.restoreAllMocks();
});

describe('the badge sheet', () => {
  it('opens as a modal dialog named for the badge that was tapped', async () => {
    await openBadgeSheet(
      'player-1',
      profileBody({ badges: [badge({ kind: 'explorer', period: 'week' })] }),
    );

    const panel = sheet();
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute('role')).toBe('dialog');
    expect(panel?.getAttribute('aria-modal')).toBe('true');
    expect(panel?.getAttribute('aria-label')).toBe('Explorer · Week');
    expect(panel?.querySelector('.badge-sheet__name')?.textContent).toBe('Explorer · Week');
    // The same mark the shelf drew, from the same definition and in the
    // earned state - not a second copy of the path and not a second state.
    expect(panel?.querySelector('.badge-sheet__mark .badge__icon')).not.toBeNull();
    expect(panel?.querySelector('.badge-placeholder__icon')).toBeNull();
  });

  it('makes every badge on the player’s own shelf a button that says it opens a dialog', async () => {
    stubProfile(
      profileBody({
        badges: [badge({ kind: 'explorer', period: 'week' })],
      }),
    );
    await renderApp('/profile/player-1');

    for (const element of [...earnedBadges(), ...placeholders()]) {
      expect(element.tagName).toBe('BUTTON');
      expect(element.getAttribute('type')).toBe('button');
      expect(element.getAttribute('aria-haspopup')).toBe('dialog');
      // The name is unchanged by becoming a control: it still says which
      // badge it is, and a placeholder still says it is unearned first.
      expect(element.getAttribute('aria-label')).not.toBe('');
    }
    expect(earnedBadges()[0].getAttribute('aria-label')).toBe('Explorer badge, week');
    expect(placeholders()[0].getAttribute('aria-label')).toBe(
      'Not yet earned: Explorer badge, month',
    );
  });

  // Mutation: one description for both kinds. The sheet must carry the rule
  // of the badge that was tapped, exclusion clause and all.
  it('describes the kind that was tapped, not the other one', async () => {
    const both = profileBody({
      badges: [
        badge({ kind: 'explorer', period: 'week' }),
        badge({ kind: 'barfly', period: 'week', periodKey: '2026-W32', value: 4 }),
      ],
    });

    await openBadgeSheet('player-1', both, 0);
    const explorerText = sheetText();
    expect(explorerText).toContain('city area you clear for the first time');
    expect(explorerText).toContain('Walking a street you have already cleared adds nothing.');
    expect(explorerText).not.toContain('master');

    await click(sheet()?.querySelector('.badge-sheet__close') as HTMLElement);
    await click(earnedBadges()[1]);
    const barflyText = sheetText();
    expect(barflyText).toContain('bars you master for the first time');
    expect(barflyText).toContain(
      'A second completed visit to a bar you have already mastered counts for nothing.',
    );
    expect(barflyText).not.toContain('city area you clear');
    expect(barflyText).not.toBe(explorerText);
  });

  // Mutation: one description for all three periods. Each sheet must name its
  // own window, and an ISO week is not a calendar month.
  it('names the window of the period that was tapped', async () => {
    const windows: string[] = [];
    for (const [index, expected] of [
      [0, 'an ISO week (Monday to Sunday)'],
      [1, 'a calendar month'],
      [2, 'a calendar year'],
    ] as const) {
      act(() => {
        root.unmount();
      });
      root = createRoot(container);
      await openBadgeSheet(
        'player-1',
        profileBody({
          badges: [
            badge({ period: 'week', periodKey: '2026-W32' }),
            badge({ period: 'month', periodKey: '2026-08' }),
            badge({ period: 'year', periodKey: '2026' }),
          ],
        }),
        index,
      );
      const text = sheetText();
      expect(text).toContain(expected);
      expect(text).toContain('Europe/Berlin');
      windows.push(text);
    }
    expect(new Set(windows).size).toBe(3);
  });

  // Section 7.7 permits this one number: it is the player's own past
  // achievement on a badge they hold, not a threshold and not a standing.
  // Section 5.8's column comment is why it cannot be printed raw - the same
  // field is a percent of the city for explorer and a count of bars for
  // barfly.
  it('reads an earned badge back in the unit of its own kind', async () => {
    await openBadgeSheet(
      'player-1',
      profileBody({
        badges: [badge({ kind: 'explorer', period: 'week', periodKey: '2026-W32', value: 1.2 })],
      }),
    );
    expect(sheet()?.querySelector('.badge-sheet__status')?.textContent).toBe(
      'Earned for week 32 of 2026, with 1.20% of the city cleared.',
    );

    act(() => {
      root.unmount();
    });
    root = createRoot(container);
    await openBadgeSheet(
      'player-1',
      profileBody({
        badges: [badge({ kind: 'barfly', period: 'month', periodKey: '2026-08', value: 4 })],
      }),
    );
    expect(sheet()?.querySelector('.badge-sheet__status')?.textContent).toBe(
      'Earned for August 2026, with 4 bars mastered.',
    );
  });

  it('counts one bar as a bar', async () => {
    await openBadgeSheet(
      'player-1',
      profileBody({
        badges: [badge({ kind: 'barfly', period: 'year', periodKey: '2026', value: 1 })],
      }),
    );
    expect(sheet()?.querySelector('.badge-sheet__status')?.textContent).toBe(
      'Earned for 2026, with 1 bar mastered.',
    );
  });

  // The period key is rendered readably and without inventing dates - "week
  // 32 of 2026" rather than a Monday-to-Sunday date range, which needs ISO
  // week arithmetic to be right and is no more true when it is.
  it('renders each period key in a form that needs no date arithmetic', async () => {
    await openBadgeSheet(
      'player-1',
      profileBody({
        badges: [
          badge({ period: 'week', periodKey: '2026-W01' }),
          badge({ period: 'month', periodKey: '2026-12' }),
          badge({ period: 'year', periodKey: '2026' }),
        ],
      }),
      0,
    );
    expect(sheetText()).toContain('week 1 of 2026');
    await click(sheet()?.querySelector('.badge-sheet__close') as HTMLElement);

    await click(earnedBadges()[1]);
    expect(sheetText()).toContain('December 2026');
    await click(sheet()?.querySelector('.badge-sheet__close') as HTMLElement);

    await click(earnedBadges()[2]);
    expect(sheetText()).toContain('Earned for 2026,');
  });

  // The test that matters most, and the one a suite that only ever opens
  // earned badges cannot have. Section 7.7's operative rule is that no part
  // of an unearned badge may change as the player's own value changes - so
  // the sheet for one says four words and carries no digit at all, and in
  // particular not the running values this fixture is full of.
  it('says only "Not yet earned." on a badge the player has never held', async () => {
    stubProfile(profileBody());
    await renderApp('/profile/player-1');
    await click(placeholders()[0]);

    const panel = sheet();
    expect(panel).not.toBeNull();
    expect(panel?.querySelector('.badge-sheet__status')?.textContent).toBe('Not yet earned.');
    expect(panel?.getAttribute('aria-label')).toBe('Not yet earned: Explorer · Week');
    expect(panel?.querySelector('.badge-sheet__mark .badge-placeholder__icon')).not.toBeNull();
    expect(panel?.querySelector('.badge__icon')).toBeNull();

    const text = sheetText();
    expect(text).not.toMatch(/\d/);
    expect(text).not.toContain('%');
    expect(text).not.toContain('47.53');
    expect(text).not.toContain('99');
    expect(text).not.toContain('Earned for');
    expect(text.toLowerCase()).not.toMatch(/threshold|so close|to go|nearly|keep going|almost/);
  });

  // The same rule from the other side: not one character of the unearned
  // sheet may move when the player's own value moves. Comparing the markup
  // rather than the words is deliberate - a leak dressed as a class name or
  // an inline style has to fail this too.
  it('draws the same unearned sheet whatever the player is currently worth', async () => {
    async function markupAtProgress(badgeProgress: unknown): Promise<string | undefined> {
      act(() => {
        root.unmount();
      });
      root = createRoot(container);
      stubProfile(profileBody({ badgeProgress }));
      await renderApp('/profile/player-1');
      await click(placeholders()[3]);
      return sheet()?.outerHTML;
    }

    const atZero = await markupAtProgress({
      week: [
        { kind: 'explorer', value: 0 },
        { kind: 'barfly', value: 0 },
      ],
      month: [],
      year: [],
    });
    const wellPastAnyFloor = await markupAtProgress({
      week: [
        { kind: 'explorer', value: 47.53 },
        { kind: 'barfly', value: 99 },
      ],
      month: [],
      year: [],
    });

    expect(atZero).toBeDefined();
    expect(wellPastAnyFloor).toBe(atZero);
  });

  // Mutation: a placeholder that opened the earned sheet. Telling a player
  // they earned a badge they did not is the worst failure available here, and
  // it would arrive with a period and a value attached.
  it('never opens an earned sheet from a placeholder, even beside a real award', async () => {
    stubProfile(
      profileBody({
        badges: [badge({ kind: 'explorer', period: 'week', periodKey: '2026-W32', value: 1.2 })],
      }),
    );
    await renderApp('/profile/player-1');

    for (const placeholder of placeholders()) {
      await click(placeholder);
      expect(sheet()?.querySelector('.badge-sheet__status')?.textContent).toBe('Not yet earned.');
      expect(sheetText()).not.toContain('1.20');
      await click(sheet()?.querySelector('.badge-sheet__close') as HTMLElement);
    }
  });

  // Three ways out, the same three components/MoreSheet.tsx offers, and
  // focus back on the badge that opened it afterwards.
  it('closes on the button, on Escape and on a tap outside, handing focus back', async () => {
    const body = profileBody({ badges: [badge({ kind: 'explorer', period: 'week' })] });

    await openBadgeSheet('player-1', body);
    expect(document.activeElement).toBe(sheet()?.querySelector('.badge-sheet__close'));
    await click(sheet()?.querySelector('.badge-sheet__close') as HTMLElement);
    expect(sheet()).toBeNull();
    expect(document.activeElement).toBe(earnedBadges()[0]);

    await click(earnedBadges()[0]);
    expect(sheet()).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(sheet()).toBeNull();

    await click(earnedBadges()[0]);
    expect(sheet()).not.toBeNull();
    await click(container.querySelector('.badge-sheet') as HTMLElement);
    expect(sheet()).toBeNull();
  });

  // Section 7.7 keeps standings off the screen, and "what is that badge, and
  // did they get it?" asked one glyph at a time about someone else's shelf is
  // a standing being assembled by hand. A stranger's badges stay pictures.
  it("offers no sheet on another player's profile", async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser({ id: 1 });
      }
      if (url === '/api/profile/player-2') {
        return jsonResponse(
          200,
          profileBody({
            userId: 2,
            handle: 'player-2',
            displayName: 'bob',
            badges: [badge({ kind: 'explorer', period: 'week' })],
          }),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/profile/player-2');

    expect(container.querySelector('h1')?.textContent).toBe('bob');
    const strangersBadge = earnedBadges()[0];
    expect(strangersBadge.tagName).toBe('SPAN');
    expect(strangersBadge.getAttribute('role')).toBe('img');
    expect(container.querySelector('.badge-button')).toBeNull();

    await click(strangersBadge);
    expect(sheet()).toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  // The other call site of the shelf. A leaderboard row draws badges as
  // compact icons (Section 7.7); six controls per ranked row would offer to
  // explain everyone else's badges as well.
  it('leaves the leaderboard’s compact badges as pictures', async () => {
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
              rank: 1,
              userId: 2,
              displayName: 'bob',
              isAnonymous: false,
              avatarSeed: 'seed2',
              value: 10,
              badges: [badge({ kind: 'barfly', period: 'week', periodKey: '2026-W32' })],
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/leaderboard');

    const compact = container.querySelector('.badge-shelf--compact .badge');
    expect(compact).not.toBeNull();
    expect(compact?.tagName).toBe('SPAN');
    expect(compact?.getAttribute('role')).toBe('img');
    expect(container.querySelector('.badge-button')).toBeNull();
  });
});
