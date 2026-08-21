import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';

// SPEC.md Section 8.1/8.2/12 (Phase 8 task brief, step 3, the accessibility
// pass): colour contrast, the accent colour never being the only carrier of
// meaning, and every form control having an accessible name. A separate file
// rather than another describe block in App.test.tsx, following
// App.privacy.test.tsx's precedent for a phase step - no map/geolocation
// harness needed here, since none of the screens under test touch the map.
// prefers-reduced-motion is covered in two other places instead of here: the
// CSS-level guarantee (a universal `*, *::before, *::after` rule) is a plain
// text assertion below, since jsdom applies no real stylesheet in this
// project's test config (vite.config.ts has no `test.css`); the JS-driven
// fog dissolve is covered where it actually lives -
// map/fog/reveal-animation.test.ts (the pure progress function),
// map/fog/webgl-fog-layer.test.ts (the injected reducedMotion() callback),
// and map/fog/fog-controller.test.ts (the real window.matchMedia wiring
// behind that callback, added alongside this file).

const here = import.meta.url;
const CSS_PATH = fileURLToPath(new URL('./index.css', here));

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

// WCAG 2.1 SC 1.4.3 / 1.4.11 relative-luminance contrast formula, computed
// by hand (task brief: "compute contrast ratios yourself, the formula is
// short" - no dependency added). Kept local to this test file rather than a
// production module, since nothing outside the test suite needs it - the
// app's own colours live only as index.css custom properties, never
// duplicated into TS (ink-style.ts states its own PAPER/INK are "kept in
// sync by hand" with index.css for the same reason: no shared module reads
// CSS custom properties).
function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrastRatio(hexA: string, hexB: string): number {
  const luminanceA = relativeLuminance(hexToRgb(hexA));
  const luminanceB = relativeLuminance(hexToRgb(hexB));
  const [lighter, darker] =
    luminanceA > luminanceB ? [luminanceA, luminanceB] : [luminanceB, luminanceA];
  return (lighter + 0.05) / (darker + 0.05);
}

// index.css's only non-opaque token, --color-border, is a solid colour
// painted at partial alpha over whatever sits beneath it (paper, everywhere
// it is used) - not a colour of its own, so contrast against it means
// contrast against the flattened result of that blend.
function rgbToHex([r, g, b]: [number, number, number]): string {
  const toHex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function blendOverBackground(
  foreground: [number, number, number],
  alpha: number,
  backgroundHex: string,
): string {
  const [br, bg, bb] = hexToRgb(backgroundHex);
  const mix = (f: number, b: number) => Math.round(f * alpha + b * (1 - alpha));
  return rgbToHex([mix(foreground[0], br), mix(foreground[1], bg), mix(foreground[2], bb)]);
}

function cssToken(css: string, name: string): string {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match) {
    throw new Error(`--${name} not found in index.css`);
  }
  return match[1];
}

function cssRgbaToken(css: string, name: string): { r: number; g: number; b: number; a: number } {
  const match = css.match(
    new RegExp(`--${name}:\\s*rgba\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)\\)`),
  );
  if (!match) {
    throw new Error(`--${name} not found in index.css`);
  }
  const [, r, g, b, a] = match;
  return { r: Number(r), g: Number(g), b: Number(b), a: Number(a) };
}

function cssRuleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.#]/g, (character) => `\\${character}`);
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) {
    throw new Error(`No CSS rule found for ${selector}`);
  }
  return match[1];
}

// SPEC.md Section 8.1: "Body text and interactive labels meet 4.5:1 against
// their background, large text and icons 3:1." Derived from the real
// palette tokens in index.css, not hard-coded hex values, so this survives a
// future palette tweak rather than being a one-off audit (task brief).
describe('colour contrast (SPEC.md Section 8.1)', () => {
  const css = readFileSync(CSS_PATH, 'utf-8');
  const paper = cssToken(css, 'color-paper');
  const ink = cssToken(css, 'color-ink');
  const accent = cssToken(css, 'color-accent');
  const border = cssRgbaToken(css, 'color-border');
  const hoverBackground = blendOverBackground([border.r, border.g, border.b], border.a, paper);

  const BODY_TEXT_MIN = 4.5;
  const LARGE_TEXT_OR_ICON_MIN = 3.0;

  it('body text: ink on the paper ground clears 4.5:1', () => {
    expect(contrastRatio(ink, paper)).toBeGreaterThanOrEqual(BODY_TEXT_MIN);
  });

  it('.button--primary text: paper on the ink fill clears 4.5:1', () => {
    expect(contrastRatio(paper, ink)).toBeGreaterThanOrEqual(BODY_TEXT_MIN);
  });

  it('interactive labels set in the accent colour (.error-message, .admin-bar-row__tag--hidden) clear 4.5:1 on paper', () => {
    expect(contrastRatio(accent, paper)).toBeGreaterThanOrEqual(BODY_TEXT_MIN);
  });

  it('the accent focus ring and active-state borders clear the 3:1 icon/UI-component threshold on paper', () => {
    expect(contrastRatio(accent, paper)).toBeGreaterThanOrEqual(LARGE_TEXT_OR_ICON_MIN);
  });

  it('ink text stays readable on the --color-border hover background used by list rows and menu items', () => {
    expect(contrastRatio(ink, hoverBackground)).toBeGreaterThanOrEqual(BODY_TEXT_MIN);
  });
});

// SPEC.md Section 12: "prefers-reduced-motion disables the dissolve
// animation and all transitions" - absolute, not "reduces". This asserts
// the CSS mechanism directly: a single universal rule reaching every
// element, not a per-component opt-in that something could be missing from,
// and durations collapsed to (near-)zero rather than merely shortened.
describe('prefers-reduced-motion (SPEC.md Section 8.2/12)', () => {
  const css = readFileSync(CSS_PATH, 'utf-8');

  it('reaches every element (*, *::before, *::after), not a hand-picked list of components', () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\*,\s*\*::before,\s*\*::after \{/,
    );
  });

  it('collapses animation and transition duration to (near-)zero rather than only shortening it', () => {
    const block = css.match(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\*,\s*\*::before,\s*\*::after \{([^}]*)\}/,
    );
    expect(block).not.toBeNull();
    const body = block?.[1] ?? '';
    expect(body).toMatch(/animation-duration:\s*0(\.\d+)?ms\s*!important/);
    expect(body).toMatch(/animation-iteration-count:\s*1\s*!important/);
    expect(body).toMatch(/transition-duration:\s*0(\.\d+)?ms\s*!important/);
  });
});

// SPEC.md Section 8.2: "Minimum tap target 44 × 44 px." Spot-checks the
// square icon-only controls, where a regression (a shrunk icon button) is
// both most likely and least visible to a sighted developer resizing by eye.
describe('minimum tap targets (SPEC.md Section 8.2)', () => {
  const css = readFileSync(CSS_PATH, 'utf-8');

  it.each(['.burger-menu__button', '.tracking-indicator__button', '.bar-marker', '.map-locate'])(
    '%s reserves at least 44px in both dimensions',
    (selector) => {
      const body = cssRuleBody(css, selector);
      expect(body).toMatch(/(?:min-)?width:\s*44px/);
      expect(body).toMatch(/(?:min-)?height:\s*44px/);
    },
  );
});

// SPEC.md Section 8.1, a Definition-of-Done item: "no state signalled by the
// accent colour alone." Renders the two screens where the accent marks an
// application state (as opposed to a UI convention like a focus ring) and
// checks the paired, non-colour signal a screen reader or colour-blind
// player would still get.
describe('the accent colour is never the only carrier of meaning (SPEC.md Section 8.1)', () => {
  it("the leaderboard's own-row accent border is paired with a '(you)' text label", async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser({ id: 1 });
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
              badges: [],
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

    const rows = Array.from(container.querySelectorAll('.leaderboard__row'));
    const selfRow = rows.find((row) => row.classList.contains('leaderboard__row--self'));
    const otherRow = rows.find((row) => !row.classList.contains('leaderboard__row--self'));
    expect(selfRow?.textContent).toContain('(you)');
    expect(otherRow?.textContent).not.toContain('(you)');
  });

  // Section 7.7 removed the profile's progress bar along with the threshold
  // it was drawn against, and with it the accent-coloured "met" fill. What
  // replaced it carries every value as text, which is the strongest form of
  // this section's rule: there is no colour signal left to pair anything
  // with.
  it("the profile's current-progress section carries each value as text, with no coloured state", async () => {
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
          areaPercent: 5,
          barsMastered: 2,
          badges: [],
          badgeProgress: {
            week: [
              { kind: 'explorer', value: 1 },
              { kind: 'barfly', value: 0 },
            ],
            month: [],
            year: [],
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderApp('/profile/player-1');

    const items = Array.from(container.querySelectorAll('.profile__progress-item'));
    expect(
      items.map((item) => item.querySelector('.profile__progress-detail')?.textContent),
    ).toEqual(['1.00%', '0']);
    expect(container.querySelector('.profile__progress-fill--met')).toBeNull();
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
  });
});

// SPEC.md Section 8.1's Definition-of-Done item: "labelled form fields" - a
// <label> bound to its control, not a placeholder standing in for one.
// `HTMLInputElement.labels` is the browser's own accessible-name lookup
// (matches `for`/`id`, or an ancestor <label>), so this fails exactly when a
// real screen reader would announce the field with no name - not merely
// when an attribute is missing. Three screens, chosen to cover every
// labelling pattern the app uses: a plain text/password pair (Login), a
// checkbox plus several text fields in one form (Register), and a checkbox
// alongside a password field guarding a destructive action (Settings). The
// remaining screens with form fields (Reset, ChangePassword, SuggestBar,
// Admin) follow the identical `<label htmlFor>` / `<input id>` structure on
// inspection; see the task report for that audit.
describe('every form control has an accessible name (SPEC.md Section 8.1)', () => {
  async function expectAllInputsLabelled(path: string, stub: FetchHandler) {
    stubFetch(stub);
    await renderApp(path);

    const inputs = Array.from(container.querySelectorAll('input'));
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      expect(input.labels?.length ?? 0).toBeGreaterThan(0);
      expect(input.labels?.[0]?.textContent?.trim()).not.toBe('');
    }
  }

  it('every input on /login', async () => {
    await expectAllInputsLabelled('/login', (url) => {
      if (url.startsWith('/api/auth/me')) {
        return jsonResponse(401, { code: 'unauthenticated', message: 'Authentication required.' });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
  });

  it('every input on /register, including the age checkbox', async () => {
    await expectAllInputsLabelled('/register', (url) => {
      if (url.startsWith('/api/auth/me')) {
        return jsonResponse(401, { code: 'unauthenticated', message: 'Authentication required.' });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
  });

  it('every input on /settings, including the anonymous checkbox and the delete-account password', async () => {
    await expectAllInputsLabelled('/settings', (url) => {
      if (url.startsWith('/api/auth/me')) {
        return stubSignedInUser();
      }
      throw new Error(`Unexpected request: ${url}`);
    });
  });
});
