import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { cocktailGlassPathData } from './components/cocktail-glass.js';

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
    backgroundTrackingConsentedAt: null,
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
    // The name a player reads is the badge's own - one name, not a kind
    // joined to a period. The name a player *hears* carries the period as
    // well: a dialog is announced by its accessible name alone, and the star
    // or crown that says which period this is (Section 8.1) is silent.
    expect(panel?.getAttribute('aria-label')).toBe('Explorer, week');
    expect(panel?.querySelector('.badge-sheet__name')?.textContent).toBe('Explorer');
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
      'Not yet earned: Explorer Champion badge, month',
    );
  });

  // Mutation: the same name on two sheets. Since v1.38 the name is the whole
  // of what identifies a badge to a reader - there is no description under it
  // to disambiguate two badges that share one - so a sheet showing the wrong
  // name is a sheet about the wrong badge with nothing to contradict it.
  it('names the badge that was tapped, not the other one', async () => {
    const both = profileBody({
      badges: [
        badge({ kind: 'explorer', period: 'week' }),
        badge({ kind: 'barfly', period: 'year', periodKey: '2026', value: 4 }),
      ],
    });

    await openBadgeSheet('player-1', both, 0);
    expect(sheet()?.querySelector('.badge-sheet__name')?.textContent).toBe('Explorer');

    await click(sheet()?.querySelector('.badge-sheet__close') as HTMLElement);
    await click(earnedBadges()[1]);
    expect(sheet()?.querySelector('.badge-sheet__name')?.textContent).toBe('Bar Legend');
  });

  // Mutation: one name for all three periods of a kind. The three barfly
  // badges are three different things a player can hold and each has a name
  // of its own; a sheet that called them all "Bar Hopper" would be telling a
  // player who won the year that they won the week.
  it('gives each period of a kind its own name', async () => {
    const names: string[] = [];
    for (const [index, expected] of [
      [0, 'Bar Hopper'],
      [1, 'Bar Champion'],
      [2, 'Bar Legend'],
    ] as const) {
      act(() => {
        root.unmount();
      });
      root = createRoot(container);
      await openBadgeSheet(
        'player-1',
        profileBody({
          badges: [
            badge({ kind: 'barfly', period: 'week', periodKey: '2026-W32', value: 1 }),
            badge({ kind: 'barfly', period: 'month', periodKey: '2026-08', value: 2 }),
            badge({ kind: 'barfly', period: 'year', periodKey: '2026', value: 3 }),
          ],
        }),
        index,
      );
      expect(sheet()?.querySelector('.badge-sheet__name')?.textContent).toBe(expected);
      names.push(expected);
    }
    expect(new Set(names).size).toBe(3);
  });

  // The owner: "Remove the detailed description for all of them, the name is
  // enough", and for the one line that stays: "Each badge goes to whoever
  // does the most of it in the period. Not more." So the sheet is four
  // things - the mark, the name, that sentence, the status - and this is the
  // test that fails if a description comes back, in any of the three shapes
  // it could come back in: the old copy, a new element, or an extra
  // paragraph nobody counted.
  it('carries the name, one sentence and the status, and no description at all', async () => {
    await openBadgeSheet(
      'player-1',
      profileBody({
        badges: [badge({ kind: 'barfly', period: 'year', periodKey: '2026', value: 4 })],
      }),
    );

    const panel = sheet();
    expect(panel?.querySelector('.badge-sheet__description')).toBeNull();
    expect(panel?.querySelector('.badge-sheet__note')?.textContent).toBe(
      'Each badge goes to whoever does the most of it in the period.',
    );

    const text = sheetText();
    for (const gone of [
      'rewards new ground',
      'rewards new bars',
      'Europe/Berlin',
      'ISO week',
      'calendar month',
      'calendar year',
      'no fixed score wins one',
    ]) {
      expect(text, `the sheet is describing badges again: "${gone}"`).not.toContain(gone);
    }

    // Counted rather than listed, so a fourth paragraph slipped in between
    // the name and the status fails here even if its words are innocent.
    const paragraphs = Array.from(panel?.querySelectorAll('p') ?? []);
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0].className).toBe('badge-sheet__note');
    expect(paragraphs[1].className).toBe('badge-sheet__status');
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
    expect(panel?.getAttribute('aria-label')).toBe('Not yet earned: Explorer, week');
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

// SPEC.md Sections 7.7 and 8.1: what the glyph is made of. The kind carries a
// pictogram, the period carries a modifier drawn above it, and an unearned
// badge is the same artwork inside a dashed frame.
//
// Everything below is markup, and that is the boundary of what it can say.
// jsdom loads no stylesheet and lays nothing out, so no test here can see a
// crown at the 1.25rem a leaderboard row draws a badge at, or tell a crown
// from a star, or judge whether the drawing is any good. What it can prove is
// that the three periods are three different marks, that the week has none,
// that the two states draw the same artwork, and that the barfly badge is not
// wearing the martini that means something else everywhere it appears.
describe('the badge glyph (SPEC.md Sections 7.7, 8.1)', () => {
  function glyphOf(element: Element): { marks: string[]; modifiers: string[]; frames: number } {
    return {
      marks: Array.from(element.querySelectorAll('[class$="__mark"]')).map(
        (path) => path.getAttribute('d') ?? '',
      ),
      modifiers: Array.from(element.querySelectorAll('[class$="__modifier"]')).map(
        (path) => path.getAttribute('d') ?? '',
      ),
      frames: element.querySelectorAll('.badge-placeholder__frame').length,
    };
  }

  async function shelfOf(badges: Badge[]) {
    act(() => {
      root.unmount();
    });
    root = createRoot(container);
    stubProfile(profileBody({ badges }));
    await renderApp('/profile/player-1');
  }

  // Mutation: the same modifier for two periods, or a modifier on the week.
  // The period is carried by nothing / a star / a crown since the ring frame
  // went, and two periods drawing the same thing is a badge that cannot say
  // which of three it is to anyone who is looking at it rather than listening.
  it('draws one modifier per period, three different ones, and none on the week', async () => {
    await shelfOf([
      badge({ kind: 'barfly', period: 'week', periodKey: '2026-W32', value: 1 }),
      badge({ kind: 'barfly', period: 'month', periodKey: '2026-08', value: 2 }),
      badge({ kind: 'barfly', period: 'year', periodKey: '2026', value: 3 }),
    ]);

    const [week, month, year] = earnedBadges().map(glyphOf);
    expect(week.modifiers, 'the weekly badge has grown a modifier').toHaveLength(0);
    expect(month.modifiers).toHaveLength(1);
    expect(year.modifiers).toHaveLength(1);
    expect(
      month.modifiers[0],
      'the month and the year draw the same modifier, so the star and the crown are one ' +
        'shape and the two badges are indistinguishable by sight',
    ).not.toBe(year.modifiers[0]);
    for (const d of [...month.modifiers, ...year.modifiers]) {
      expect(d).not.toBe('');
    }

    // The pictogram is the kind's and does not change with the period: the
    // three barfly badges are one glass with something above it, not three
    // drawings.
    expect(new Set([week.marks[0], month.marks[0], year.marks[0]]).size).toBe(1);
  });

  // THE DEFECT THAT PROMPTED THE REDRAW OF v1.40, and the reason it is a test
  // and not just a comment. The owner asked for a compass and the explorer
  // pictogram already was one - a compass *rose*, which is four long points
  // and four short ones, which is a star. The modifier above it is also a
  // star. So the kind and the period were drawn in one visual language, and
  // "Explorer Champion" was a star with a star over it: two parts that are
  // supposed to carry two axes, saying the same thing twice.
  //
  // What this can prove is that no pictogram is the same drawing as any
  // modifier. What it cannot prove is that they no longer *resemble* each
  // other - that is a question about rendered pixels, and jsdom lays nothing
  // out. The case around the compass is the answer to it (components/Badge.tsx
  // records what an offline rasteriser showed at 20 px), and no test here can
  // see it.
  it('never draws a kind in the same shape as a period', async () => {
    await shelfOf([
      badge({ kind: 'explorer', period: 'month', periodKey: '2026-08', value: 1 }),
      badge({ kind: 'barfly', period: 'year', periodKey: '2026', value: 1 }),
    ]);

    const drawn = earnedBadges().map(glyphOf);
    const modifiers = drawn.flatMap((glyph) => glyph.modifiers);
    expect(new Set(modifiers).size).toBe(2);
    for (const glyph of drawn) {
      for (const mark of glyph.marks) {
        expect(
          modifiers,
          'a pictogram is drawn as one of the period modifiers, so the badge says its ' +
            'kind and its period in one shape',
        ).not.toContain(mark);
      }
    }
  });

  // The compass is the one shape in this file with a hole in it, and the hole
  // is made by winding rather than by a fill-rule: components/Badge.tsx draws
  // the case as two circles running in opposite directions, which the default
  // nonzero rule cancels to nothing between them. Give both arcs the same
  // sweep flag and the case fills in solid - a black disc with a needle
  // invisible inside it - which renders, passes every other test here, and is
  // exactly the failure nothing else would catch.
  it('draws the compass case as two circles wound against each other', async () => {
    await shelfOf([badge({ kind: 'explorer', period: 'week', periodKey: '2026-W32', value: 1 })]);

    const mark = glyphOf(earnedBadges()[0]).marks[0];
    const sweeps = Array.from(
      mark.matchAll(/A\s*[\d.]+[\s,]+[\d.]+[\s,]+[\d.]+[\s,]+([01])[\s,]+([01])[\s,]/g),
    ).map((match) => match[2]);
    expect(sweeps.length, 'the compass case is no longer drawn with arcs').toBeGreaterThanOrEqual(
      2,
    );
    expect(
      new Set(sweeps).size,
      'every arc of the compass runs the same way, so nonzero fills the case solid and ' +
        'there is no case left - only a disc',
    ).toBe(2);
  });

  // The kind is the other axis, and the two pictograms are two shapes.
  it('draws one pictogram per kind, and two different ones', async () => {
    await shelfOf([
      badge({ kind: 'explorer', period: 'week', periodKey: '2026-W32', value: 1 }),
      badge({ kind: 'barfly', period: 'week', periodKey: '2026-W32', value: 1 }),
    ]);

    const [explorer, barfly] = earnedBadges().map(glyphOf);
    expect(explorer.marks).toHaveLength(1);
    expect(barfly.marks).toHaveLength(1);
    expect(explorer.marks[0]).not.toBe(barfly.marks[0]);
  });

  // The owner ruled this out by name: the martini belongs to the map marker,
  // the bar sheet, the bar detail screen and the discovery stamp, where its
  // two states say whether a bar is mastered (Section 8.1). A badge wearing it
  // would make one silhouette mean two things. Compared against the real
  // definition rather than against a copy of it here, so this keeps working if
  // the glass is ever redrawn.
  it('does not wear the martini of Section 8.1', async () => {
    await shelfOf([badge({ kind: 'barfly', period: 'year', periodKey: '2026', value: 1 })]);

    const drawn = glyphOf(earnedBadges()[0]);
    const martini = [...cocktailGlassPathData(false), ...cocktailGlassPathData(true)];
    for (const d of [...drawn.marks, ...drawn.modifiers]) {
      expect(martini, `a badge is drawing the cocktail glass of Section 8.1: ${d}`).not.toContain(
        d,
      );
    }
  });

  // Section 8.1: the unearned state may not rest on lightness alone, and since
  // the artwork became identical in the two states the frame is the only other
  // channel there is. index.css proves it is dashed; this proves it is there,
  // and there in exactly one of the two states.
  it('frames the unearned glyph and only the unearned glyph', async () => {
    await shelfOf([badge({ kind: 'explorer', period: 'week', periodKey: '2026-W32', value: 1 })]);

    expect(glyphOf(earnedBadges()[0]).frames, 'an earned badge has grown a frame').toBe(0);
    for (const placeholder of placeholders()) {
      expect(
        glyphOf(placeholder).frames,
        'a placeholder has no frame, so nothing but opacity separates it from an earned ' +
          'badge - which Section 8.1 forbids and a greyscale print erases',
      ).toBe(1);
    }
  });

  // The owner's instruction was "same as real badge but in light grey", and
  // "the same" is a claim about the paths as well as the paint: a placeholder
  // that redrew the mark would be a second drawing of the badge free to drift
  // from the first.
  it('draws the placeholder from the same artwork as the badge it stands for', async () => {
    await shelfOf([badge({ kind: 'explorer', period: 'year', periodKey: '2026', value: 1 })]);

    const earned = glyphOf(earnedBadges()[0]);
    // explorer/year is held, so explorer/month is the placeholder to compare
    // against - same kind, and the modifier differs because the period does.
    const barflyYear = placeholders().find(
      (element) => element.getAttribute('aria-label') === 'Not yet earned: Bar Legend badge, year',
    );
    expect(barflyYear).toBeDefined();
    expect(glyphOf(barflyYear as HTMLElement).modifiers[0]).toBe(earned.modifiers[0]);

    const explorerMonth = placeholders().find(
      (element) =>
        element.getAttribute('aria-label') === 'Not yet earned: Explorer Champion badge, month',
    );
    expect(explorerMonth).toBeDefined();
    expect(glyphOf(explorerMonth as HTMLElement).marks[0]).toBe(earned.marks[0]);
  });
});
