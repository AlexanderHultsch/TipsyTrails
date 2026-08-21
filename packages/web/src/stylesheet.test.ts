import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The first real deployment came up with a blank map: the tile extract was
// installed, /tiles/ answered 206 with the right byte ranges, MapLibre
// raised no error, and the screen showed nothing but the paper background.
// The container measured 620x0.
//
// The cause was a cascade collision, not code. MapLibre adds its own
// `maplibregl-map` class to whichever element it is handed, and
// maplibre-gl.css sets `.maplibregl-map { position: relative }`. A bare
// `.map-container { position: absolute; inset: 0 }` has exactly the same
// specificity, and MapLibre's stylesheet ships inside the lazily loaded map
// chunk, so it arrives later and wins. `inset` then no longer applies and
// the element collapses to the height of its content - zero, because
// MapLibre's canvas within it is itself absolutely positioned. The map
// renders into MapLibre's own 400x300 fallback instead.
//
// Nothing in the type system, the linter or a jsdom test can see this: the
// bug lives entirely in the specificity arithmetic between two stylesheets.
// What defends against it is keeping these selectors at two classes, so
// they outrank `.maplibregl-map` regardless of load order. This test pins
// exactly that, and would have failed on the shipped stylesheet.
const here = import.meta.url;
const css = readFileSync(fileURLToPath(new URL('./index.css', here)), 'utf-8');

// Selector plus declaration block for every rule in the file. Deliberately
// simple - index.css has no nesting and no at-rule-wrapped versions of
// these selectors, so a flat scan is honest here.
//
// Comments are stripped first, and that is not a detail: the comments this
// file's own fix added quote `.maplibregl-map { position: relative }` as
// prose. Left in, those braces parse as a rule, the scan misaligns, and the
// check silently stops seeing the real one - which is exactly what happened
// on the first attempt at this test, caught only by mutating the stylesheet
// back and finding that one of the two cases still passed.
function rules(): { selector: string; body: string }[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1].trim(),
    body: match[2],
  }));
}

function classCount(selector: string): number {
  return (selector.match(/\.[a-zA-Z_-][\w-]*/g) ?? []).length;
}

// Every element this app hands to `new maplibregl.Map({ container })`.
// Add to this list whenever another one appears, or the new one inherits
// the blank-map bug.
const MAPLIBRE_CONTAINER_CLASSES = ['map-container', 'map-picker__map'];

describe('index.css: MapLibre container positioning', () => {
  for (const containerClass of MAPLIBRE_CONTAINER_CLASSES) {
    it(`positions .${containerClass} with more specificity than .maplibregl-map`, () => {
      const positioning = rules().filter(
        (rule) =>
          rule.selector.includes(`.${containerClass}`) && /position\s*:\s*absolute/.test(rule.body),
      );

      expect(
        positioning.length,
        `no rule sets position: absolute for .${containerClass}`,
      ).toBeGreaterThan(0);

      for (const rule of positioning) {
        // `.maplibregl-map` is one class. Anything that positions a MapLibre
        // container must carry at least two, or it loses the cascade to a
        // stylesheet loaded after this one.
        expect(
          classCount(rule.selector),
          `"${rule.selector}" has ${classCount(rule.selector)} class(es); ` +
            'MapLibre\'s own ".maplibregl-map { position: relative }" would outrank it ' +
            'and collapse the container to zero height',
        ).toBeGreaterThanOrEqual(2);
      }
    });
  }
});

// The suggest screen's picker (map/MapPicker.tsx) puts the player's own
// position marker and the pin being placed on one surface, and what keeps
// the two usable together is a single declaration each. Both are asserted
// here rather than in a render test for the same reason as the rules above:
// nothing in jsdom loads this stylesheet, so no rendered picker can see
// either declaration go missing.
describe('index.css: the picker pin and the own-position marker', () => {
  function bodiesFor(selector: string): string[] {
    return rules()
      .filter((rule) => rule.selector.split(',').some((part) => part.trim() === selector))
      .map((rule) => rule.body);
  }

  function zIndexOf(selector: string): number {
    for (const body of bodiesFor(selector)) {
      const declared = body.match(/z-index\s*:\s*(-?\d+)/);
      if (declared) {
        return Number(declared[1]);
      }
    }
    throw new Error(`no z-index declared for ${selector}`);
  }

  it('lets a tap pass through the own-position marker', () => {
    const marker = bodiesFor('.own-position-marker');

    expect(marker.length, 'no rule targets .own-position-marker').toBeGreaterThan(0);
    expect(
      marker.some((body) => /pointer-events\s*:\s*none/.test(body)),
      '.own-position-marker must set pointer-events: none, or it swallows the tap ' +
        'that places the pin - and the spot it covers is exactly the one someone ' +
        'adding the bar they are standing in front of aims at',
    ).toBe(true);
  });

  it('stacks the picker pin above the own-position marker', () => {
    // Having just centred on yourself and then tapping that same spot lands
    // the two on top of each other, and the object being placed is the one
    // that has to stay visible.
    expect(zIndexOf('.map-picker__pin')).toBeGreaterThan(zIndexOf('.own-position-marker'));
  });
});

// The districts screen visibly jumped when a district was selected: the
// detail panel's height changes with the selection, the page height changes
// with it, a desktop scrollbar appears or disappears, and every `width: 100%`
// element on the page - the district map among them - is re-laid out at a
// different width. Reserving the gutter unconditionally decouples the two.
//
// It gets a test because it is a single declaration with no visible effect
// until the exact moment it matters, on a screen no automated check here
// lays out. Nothing else in the repository would notice its removal.
describe('index.css: scrollbar gutter', () => {
  it('reserves the scrollbar width on the root element', () => {
    const root = rules().filter((rule) =>
      rule.selector.split(',').some((part) => part.trim() === 'html'),
    );

    expect(root.length, 'no rule targets the html element').toBeGreaterThan(0);
    expect(
      root.some((rule) => /scrollbar-gutter\s*:\s*stable/.test(rule.body)),
      'html must set scrollbar-gutter: stable, or a page whose height changes ' +
        'resizes every width: 100% element on it when the scrollbar appears',
    ).toBe(true);
  });
});
