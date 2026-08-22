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

// Section 8.3, "No map overlay may obscure another". The map screen used to
// position each of its overlays against the map container, every one with
// its own edge offsets and its own z-index, and two of them collided: the
// locate button sat above the full-width bar along the bottom edge, the
// tracking icons above the banner along the top. Section 8.3 is explicit
// that correcting those two is not the requirement - eight hand-tuned
// offsets that agree by coincidence are not a layout, and the ninth overlay
// breaks them again.
//
// So the check is of the rule, not of the two collisions: no overlay the map
// screen renders positions itself against the map any more. They are placed
// by one container laying them out as rows (index.css, .map-overlays), which
// is what makes a control at an edge yield to a bar at that edge whether or
// not the bar is on screen. An overlay added tomorrow that brought its own
// `position: absolute` and edge offsets back would fail here, and nothing
// else in the repository would notice it.
//
// The overlays are read out of screens/Map.tsx and the components it mounts
// rather than listed here, so a ninth one is covered without anyone
// remembering to add it to a list.
//
// WHAT THIS CANNOT PROVE, plainly. It is a static scan of a stylesheet.
// Nothing here lays anything out: jsdom computes no geometry and no test in
// this repository renders this screen with index.css applied at all. It
// therefore cannot show that two overlays do not overlap on a real screen,
// that the rows come out in the intended order, or that any overlay is
// visible. What it does prove is the narrower thing that regressed - that
// the overlays are placed by the container instead of against the map, that
// the container lets pointer events through to the map, and that the bottom
// safe-area inset is applied once by the layout rather than by each child
// that happens to sit at that edge. Whether the result looks right still
// needs eyes on a phone.
describe('index.css: the map screen lays its overlays out, it does not pile them up', () => {
  const OVERLAY_CONTAINER = 'map-overlays';
  // The container covers the map rather than sitting at one of its edges,
  // and `inset: 0` is how it covers; .map-container is the map itself and
  // .screen is the page under it. None of the three is an overlay.
  const NOT_OVERLAYS = new Set(['screen', 'map-container', OVERLAY_CONTAINER]);
  const EDGE_PROPERTIES = new Set(['top', 'right', 'bottom', 'left', 'inset']);

  function source(relative: string): string {
    return readFileSync(fileURLToPath(new URL(relative, here)), 'utf-8');
  }

  const mapScreen = source('./screens/Map.tsx');
  const mapScreenSources = [
    mapScreen,
    // .bar-sheet and .tracking-indicator are named in their own component
    // file, not in the screen's, so the screen alone is not the whole list.
    ...[...mapScreen.matchAll(/from '\.\.\/(components\/[A-Za-z]+)\.js'/g)].map((match) =>
      source(`./${match[1]}.tsx`),
    ),
  ];

  function classesIn(code: string): string[] {
    const found: string[] = [];
    for (const match of code.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
      const literal = (match[1] ?? match[2] ?? '').replace(/\$\{[^}]*\}/g, ' ');
      found.push(...literal.split(/\s+/).filter(Boolean));
    }
    return found;
  }

  // BEM: `block__element` is positioned inside its own block and not against
  // the map - .tracking-indicator__panel is the explanation hanging under
  // the tracking icons and is absolutely positioned on purpose. The blocks
  // are the elements the container places, and they are what this is about.
  function blockOf(className: string): string {
    return className.split('__')[0].split('--')[0];
  }

  function classesOf(selectorPart: string): string[] {
    return (selectorPart.match(/\.[a-zA-Z_-][\w-]*/g) ?? []).map((name) => name.slice(1));
  }

  // Generic classes the overlays happen to use - .button, .error-message -
  // come along with them, and they are left in on purpose: they are elements
  // of this screen too, and none of them may position itself against the map
  // either.
  const mapScreenClasses = new Set(mapScreenSources.flatMap(classesIn));
  const overlayBlocks = [...new Set([...mapScreenClasses].map(blockOf))]
    .filter((block) => !NOT_OVERLAYS.has(block))
    .sort();

  // A rule is in force on the map screen when every class it names is one
  // that screen actually renders. `.map-picker .map-locate` is the same
  // locate button on the suggest screen's picker, where it genuinely is
  // positioned against that picker - the map screen never carries
  // .map-picker, so that rule is not this check's business.
  function inForceOnTheMapScreen(selectorPart: string): boolean {
    return classesOf(selectorPart).every((name) => mapScreenClasses.has(name));
  }

  // The classes on the element a selector actually styles, as opposed to the
  // ancestors it is scoped by.
  function subjectClassesOf(selectorPart: string): string[] {
    return classesOf(
      selectorPart
        .trim()
        .split(/[\s>+~]+/)
        .pop() ?? '',
    );
  }

  // The block element itself, or the block wearing a modifier - but not
  // `block__element`, which is positioned inside its block rather than
  // against the map.
  function targets(selectorPart: string, block: string): boolean {
    return (
      inForceOnTheMapScreen(selectorPart) &&
      subjectClassesOf(selectorPart).some((name) => name === block || name.startsWith(`${block}--`))
    );
  }

  // Wider: the container, one of its rows, an overlay, or any element inside
  // one of those - everything the overlay layout is made of.
  function partOfTheOverlayLayout(selectorPart: string): boolean {
    return (
      inForceOnTheMapScreen(selectorPart) &&
      subjectClassesOf(selectorPart).some(
        (name) => blockOf(name) === OVERLAY_CONTAINER || overlayBlocks.includes(blockOf(name)),
      )
    );
  }

  function rulesFor(block: string): { selector: string; body: string }[] {
    return rules().filter((rule) => rule.selector.split(',').some((part) => targets(part, block)));
  }

  function declarationsOf(body: string): { property: string; value: string }[] {
    return body
      .split(';')
      .map((declaration) => declaration.split(':'))
      .filter((parts) => parts.length > 1)
      .map((parts) => ({
        property: (parts[0] ?? '').trim().toLowerCase(),
        value: parts.slice(1).join(':').trim().toLowerCase(),
      }));
  }

  function positionedAgainstTheMap(body: string): boolean {
    const declarations = declarationsOf(body);
    return (
      declarations.some(
        (declaration) =>
          declaration.property === 'position' &&
          (declaration.value === 'absolute' || declaration.value === 'fixed'),
      ) &&
      declarations.some(
        (declaration) => EDGE_PROPERTIES.has(declaration.property) && declaration.value !== 'auto',
      )
    );
  }

  // The one way an overlay may keep positioning of its own and still be part
  // of the layout: a rule scoped to the container that takes it out of the
  // flow it was in and drops every edge offset with it. The burger menu is
  // the case that needs it - Section 8.4 fixes it to the viewport on every
  // other screen, and only the map moves it into a row.
  function releasedIntoTheLayout(block: string): boolean {
    return rulesFor(block).some((rule) => {
      if (!rule.selector.includes(`.${OVERLAY_CONTAINER}`)) {
        return false;
      }
      const declarations = declarationsOf(rule.body);
      return (
        declarations.some(
          (declaration) =>
            declaration.property === 'position' &&
            (declaration.value === 'static' || declaration.value === 'relative'),
        ) &&
        declarations.some(
          (declaration) => declaration.property === 'inset' && declaration.value === 'auto',
        )
      );
    });
  }

  it('renders its overlays inside the container that lays them out', () => {
    expect(
      mapScreenClasses.has(OVERLAY_CONTAINER),
      `screens/Map.tsx no longer renders .${OVERLAY_CONTAINER}; without it every ` +
        'check below is scanning a layout the screen does not use',
    ).toBe(true);
    expect(
      rules().some((rule) =>
        rule.selector.split(',').some((part) => part.trim() === `.${OVERLAY_CONTAINER}`),
      ),
      `no rule targets .${OVERLAY_CONTAINER}`,
    ).toBe(true);

    // A floor under the scan, not the list it works from: if the sources
    // stopped yielding class names, the per-overlay check below would run
    // over an empty list and pass without looking at anything. These are the
    // overlays Section 8.3 names.
    for (const overlay of [
      'pending-visit-banner',
      'tracking-indicator',
      'burger-menu',
      'map-locate',
      'map-attribution',
      'bar-sheet',
      'nearby-bars-panel',
      'map-notice',
      'map-toast',
    ]) {
      expect(overlayBlocks, `the scan no longer finds the overlay .${overlay}`).toContain(overlay);
    }
  });

  // The checks above prove the overlays are placed by the container rather
  // than against the map. They do not prove the container has five distinct
  // bands: give two row wrappers the same `grid-row` and the overlays are
  // still "laid out by the container", and still descendants of it in the
  // DOM - they simply share a cell and stack on each other, which is the
  // exact defect Section 8.3 is about. A mutation that moved the bottom
  // controls into the top controls' row passed every other test here.
  //
  // This is still a text scan and still proves nothing geometric: it cannot
  // say the rows come out top to bottom on a screen, only that the
  // stylesheet asks for five different ones in the order the markup nests
  // them. That is the part a stylesheet can be held to.
  it('gives each overlay row a band of its own, in order', () => {
    const rowsInOrder = [
      'map-overlays__top-bars',
      'map-overlays__controls--top',
      'map-overlays__middle',
      'map-overlays__controls--bottom',
      'map-overlays__bottom-bars',
    ];

    const assigned = rowsInOrder.map((row) => {
      const values = rulesFor(row)
        .flatMap((rule) => declarationsOf(rule.body))
        .filter((declaration) => declaration.property === 'grid-row')
        .map((declaration) => declaration.value);
      expect(
        values,
        `.${row} is given no grid-row, so auto-placement decides where it lands`,
      ).not.toHaveLength(0);
      return values[values.length - 1];
    });

    expect(new Set(assigned).size, `two overlay rows share a band: ${assigned.join(', ')}`).toBe(
      rowsInOrder.length,
    );
    expect(assigned, 'the overlay rows are not banded in the order the markup nests them').toEqual(
      [...assigned].sort((a, b) => Number(a) - Number(b)),
    );
  });

  it.each(overlayBlocks)('leaves .%s to the layout instead of positioning it', (block) => {
    const offending = rulesFor(block).filter((rule) => positionedAgainstTheMap(rule.body));

    expect(
      offending.length === 0 || releasedIntoTheLayout(block),
      `"${offending.map((rule) => rule.selector).join('", "')}" positions .${block} ` +
        'against the map with edge offsets of its own. Overlays on the map screen are ' +
        `placed by .${OVERLAY_CONTAINER}'s rows, which is what stops a control at an ` +
        'edge landing on a bar at that edge whether or not the bar is on screen ' +
        '(Section 8.3). An overlay that must keep positioning of its own has to be ' +
        `released into the layout by a ".${OVERLAY_CONTAINER} .${block}" rule setting ` +
        'position: relative and inset: auto, the way the burger menu is.',
    ).toBe(true);
  });

  it('passes pointer events through the container and takes them back on the overlays', () => {
    const container = rules().filter((rule) =>
      rule.selector.split(',').some((part) => part.trim() === `.${OVERLAY_CONTAINER}`),
    );

    expect(
      container.some((rule) => /pointer-events\s*:\s*none/.test(rule.body)),
      `.${OVERLAY_CONTAINER} covers the entire map. Without pointer-events: none it ` +
        'swallows every drag and the map stops panning - which no test that does not ' +
        'lay the screen out can see happen.',
    ).toBe(true);

    expect(
      rules().some(
        (rule) =>
          rule.selector.includes(`.${OVERLAY_CONTAINER}`) &&
          rule.selector.trim() !== `.${OVERLAY_CONTAINER}` &&
          /pointer-events\s*:\s*auto/.test(rule.body),
      ),
      'the overlays inside the container must take pointer events back, or the ' +
        'container hands every tap to the map and none of them can be used',
    ).toBe(true);
  });

  it('applies the bottom safe-area inset once, in the layout', () => {
    const bottomInset = /env\(\s*safe-area-inset-bottom/;
    const carrying = rules().filter(
      (rule) =>
        bottomInset.test(rule.body) &&
        rule.selector.split(',').some((part) => partOfTheOverlayLayout(part)),
    );

    expect(
      carrying.map((rule) => rule.selector),
      'the phones this runs on have a home indicator along the bottom edge, and ' +
        'whatever occupies that edge has to clear it. The layout applies the inset ' +
        `once, on .${OVERLAY_CONTAINER}, so rows 4 and 5 clear it without each child ` +
        'repeating the value - and so that a child that forgot it cannot be wrong.',
    ).toEqual([`.${OVERLAY_CONTAINER}`]);
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
