import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '@tipsytrails/shared';
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

// Hue and saturation, needed only to prove the palette below is not a grey
// ramp and does not sit in the accent's red family. Plain HSV, from the
// same hex the contrast helpers above read.
function hueDegrees(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) {
    return Number.NaN;
  }
  let sector: number;
  if (max === r) {
    sector = ((g - b) / delta) % 6;
  } else if (max === g) {
    sector = (b - r) / delta + 2;
  } else {
    sector = (r - g) / delta + 4;
  }
  const degrees = sector * 60;
  return degrees < 0 ? degrees + 360 : degrees;
}

function saturation(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

// Shortest distance between two hues on the 360-degree circle.
function hueGap(hexA: string, hexB: string): number {
  const raw = Math.abs(hueDegrees(hexA) - hueDegrees(hexB)) % 360;
  return raw > 180 ? 360 - raw : raw;
}

// SPEC.md Section 8.6, and the Phase 8 accessibility item that names it as
// outstanding: the three status icons are the one place in this application
// where colour carries state on its own, because their shapes are fixed by
// decision. WCAG 2.1 SC 1.4.1 is about colour not being the only *visual*
// signal, so the icons' aria-labels (asserted in App.test.tsx) do nothing
// for a sighted colour-blind player - the mitigation that does is
// luminance, and it is the one thing here that can be measured rather than
// judged. Everything below is derived from the real tokens in index.css and
// from the indicator's own button rule, so this is a live check on the
// palette: change a token badly and it fails. It is the automated discharge
// of Section 8.6's luminance requirement.
describe('the status-icon palette (SPEC.md Section 8.1/8.6)', () => {
  const css = readFileSync(CSS_PATH, 'utf-8');
  const paper = cssToken(css, 'color-paper');
  const accent = cssToken(css, 'color-accent');
  const ok = cssToken(css, 'color-status-ok');
  const degraded = cssToken(css, 'color-status-degraded');
  const bad = cssToken(css, 'color-status-bad');
  const levels: [string, string][] = [
    ['ok', ok],
    ['degraded', degraded],
    ['bad', bad],
  ];

  // The worst realistic background these icons are read against. The
  // indicator sits on the map, its button is a translucent paper fill (read
  // out of the button's own rule rather than repeated here), and the
  // darkest ground that fill can sit over is fully fogged terrain - the fog
  // layer's own colour at CONFIG.FOG_MAX_OPACITY over paper, which
  // composites to rgb(204, 199, 187). FOG_COLOR is not exported from
  // map/fog/webgl-fog-layer.ts, so it is mirrored here by hand, the same
  // way map/ink-style.ts mirrors PAPER and INK; the paper it is blended
  // over and the button fill on top of it are both read live.
  const FOG_COLOR: [number, number, number] = [0.78 * 255, 0.76 * 255, 0.71 * 255];
  const foggedGround = blendOverBackground(FOG_COLOR, CONFIG.FOG_MAX_OPACITY, paper);
  const buttonRule = cssRuleBody(css, '.tracking-indicator__button');
  const buttonFill = buttonRule.match(
    /background:\s*rgba\(([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\)/,
  );
  if (!buttonFill) {
    throw new Error('No rgba background found on .tracking-indicator__button');
  }
  const buttonOverFog = blendOverBackground(
    [Number(buttonFill[1]), Number(buttonFill[2]), Number(buttonFill[3])],
    Number(buttonFill[4]),
    foggedGround,
  );

  // Section 8.1: icons meet 3:1 against their background (WCAG 2.1 SC
  // 1.4.11).
  const ICON_MIN = 3.0;
  // Section 8.6: far enough apart to survive a greyscale rendering. Two
  // steps of 2.2:1 put the extremes at 4.84:1, so the pair of bounds is
  // reachable - but only just: with every colour under the luminance
  // ceiling ICON_MIN imposes, the widest possible spread is about 5.9:1.
  const ADJACENT_MIN = 2.2;
  const EXTREMES_MIN = 4.0;
  // Enough hue between them that they are not a grey ramp with a tint, and
  // enough between each of them and the accent that none reads as it.
  const HUE_GAP_MIN = 30;

  it('the fogged ground the button sits over is the one Section 7.3 produces', () => {
    expect(foggedGround).toBe('#ccc7bb');
  });

  it.each(levels)('%s clears 3:1 against the paper ground', (_name, colour) => {
    expect(contrastRatio(colour, paper)).toBeGreaterThanOrEqual(ICON_MIN);
  });

  it.each(levels)(
    "%s clears 3:1 against the indicator's own button over fogged ground",
    (_name, colour) => {
      expect(contrastRatio(colour, buttonOverFog)).toBeGreaterThanOrEqual(ICON_MIN);
    },
  );

  it('adjacent states separate by 2.2:1 in luminance, not only in hue', () => {
    expect(contrastRatio(ok, degraded)).toBeGreaterThanOrEqual(ADJACENT_MIN);
    expect(contrastRatio(degraded, bad)).toBeGreaterThanOrEqual(ADJACENT_MIN);
  });

  it('the two extremes separate by 4:1', () => {
    expect(contrastRatio(ok, bad)).toBeGreaterThanOrEqual(EXTREMES_MIN);
  });

  // On light paper a darker mark reads as the more prominent one, so
  // severity and prominence agree and a greyscale reader gets the ordering
  // of the three states for free rather than merely being able to tell them
  // apart.
  it('luminance runs in the direction of severity: ok lightest, bad darkest', () => {
    const luminance = (hex: string) => relativeLuminance(hexToRgb(hex));
    expect(luminance(ok)).toBeGreaterThan(luminance(degraded));
    expect(luminance(degraded)).toBeGreaterThan(luminance(bad));
  });

  // Section 8.6 asks for luminance *as well as* hue. A grey ramp would pass
  // every assertion above.
  it('the three differ in hue as well as luminance, and none of them is a grey', () => {
    for (const [, colour] of levels) {
      expect(saturation(colour)).toBeGreaterThan(0.2);
    }
    expect(hueGap(ok, degraded)).toBeGreaterThanOrEqual(HUE_GAP_MIN);
    expect(hueGap(degraded, bad)).toBeGreaterThanOrEqual(HUE_GAP_MIN);
    expect(hueGap(ok, bad)).toBeGreaterThanOrEqual(HUE_GAP_MIN);
  });

  // Section 8.1: the accent stays reserved for the player's own position
  // and for active states. A status colour in its hue family would compete
  // with it, which is exactly what the narrowing was written to avoid.
  it.each(levels)('%s is neither the accent nor in the accent hue family', (_name, colour) => {
    expect(colour.toLowerCase()).not.toBe(accent.toLowerCase());
    expect(hueGap(colour, accent)).toBeGreaterThanOrEqual(HUE_GAP_MIN);
  });

  // "Small and named" (Section 8.1): three tokens is the whole set - no
  // fourth for a hover or focus tint, and nothing outside the indicator may
  // reach for one.
  it('is exactly three tokens, used only by the status icons', () => {
    const tokens = css.match(/--color-status-[a-z-]+:/g) ?? [];
    expect(tokens.sort()).toEqual([
      '--color-status-bad:',
      '--color-status-degraded:',
      '--color-status-ok:',
    ]);
    const users = css.match(/var\(--color-status-[a-z-]+\)/g) ?? [];
    expect(users).toHaveLength(3);
    for (const level of ['ok', 'degraded', 'bad']) {
      expect(cssRuleBody(css, `.tracking-indicator__icon--${level}`)).toContain(
        `var(--color-status-${level})`,
      );
    }
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

  it.each([
    '.burger-menu__button',
    '.tracking-indicator__button',
    '.bar-marker',
    '.map-locate',
    // Section 7.5's bar sheet closes with a square icon-only button, the
    // same shape as the controls above and the same regression risk.
    '.bar-sheet__close',
  ])('%s reserves at least 44px in both dimensions', (selector) => {
    const body = cssRuleBody(css, selector);
    expect(body).toMatch(/(?:min-)?width:\s*44px/);
    expect(body).toMatch(/(?:min-)?height:\s*44px/);
  });
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
