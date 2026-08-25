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
  //
  // .bottom-nav is the fourth, and it is the one that needs saying. Section
  // 8.4's tab bar is not drawn on the map: it is the same app chrome every
  // signed-in screen carries, fixed to the bottom edge of the viewport, and
  // the map screen is one of its twelve callers rather than its owner. It
  // therefore does position itself - `fixed` with a `bottom` offset - and
  // that is correct rather than the defect the checks below look for. What
  // keeps it from obscuring an overlay is not this layout but the space the
  // layout reserves for it (`--bottom-nav-space`, asserted below), which is
  // why it is excluded here and checked there instead. The scan finds it at
  // all because screens/Map.tsx imports the component, which is the same
  // property that made it find the burger menu this bar replaced.
  const NOT_OVERLAYS = new Set(['screen', 'map-container', 'bottom-nav', OVERLAY_CONTAINER]);
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
  // flow it was in and drops every edge offset with it. Nothing needs it
  // today - the burger menu was the case that did, fixed to the viewport on
  // every other screen and moved into a row only on the map, and it is gone.
  // The escape hatch stays because the failure message below offers it as
  // the remedy, and an overlay that is shared with a screen having no row
  // layout would need it again.
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
        'position: relative and inset: auto.',
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

  // This used to require the bottom safe-area inset on .map-overlays and
  // nowhere else in the layout, because the overlay rows were what occupied
  // that edge. Section 8.4's tab bar occupies it now, so the inset moved with
  // it - and the rule did not change, only what satisfies it: whatever sits
  // at the bottom edge clears the home indicator, exactly once, and everything
  // above that element clears the element rather than repeating the inset.
  // Two elements both padding themselves by it is the defect either version
  // is written against; the tab bar simply made the second one easy to write
  // by accident, since a screen reserving the bar's height is one `+ env(...)`
  // away from double-counting it.
  //
  // Checked across the whole stylesheet rather than within the overlay
  // layout, which is stricter: the token is defined once, in :root, and the
  // elements that need it - the bar, the sheet over it, every scrolling
  // screen - reach it by name.
  it('applies the bottom safe-area inset exactly once, where the tab bar claims it', () => {
    const bottomInset = /env\(\s*safe-area-inset-bottom/;
    const carrying = rules().filter((rule) => bottomInset.test(rule.body));

    expect(
      carrying.map((rule) => rule.selector),
      'the phones this runs on have a home indicator along the bottom edge, and ' +
        'exactly one element may pad itself by it: the one that occupies that edge, ' +
        'which since Section 8.4 is the tab bar. It reads the inset from the ' +
        '--bottom-nav-inset token, so this is the only rule that may name env() at ' +
        'all - a second one is a second element claiming the same strip of screen.',
    ).toEqual([':root']);

    expect(
      declarationsOf(carrying[0]?.body ?? '').some(
        (declaration) =>
          declaration.property === '--bottom-nav-inset' && bottomInset.test(declaration.value),
      ),
      'the inset is still declared somewhere in :root, but not as --bottom-nav-inset, ' +
        'which is the name the tab bar and everything clearing it read it by',
    ).toBe(true);
  });

  // The top counterpart of the test above, and the same reasoning: turning on
  // viewport-fit=cover (index.html) for the bottom inset's sake also makes
  // the top edge-to-edge, so the notch/status-bar row is a second strip every
  // screen has to clear, exactly once, by name - not by a second raw env()
  // scattered wherever someone next reaches for "a bit more top padding".
  it('applies the top safe-area inset exactly once, by name, not as a second raw env()', () => {
    const topInset = /env\(\s*safe-area-inset-top/;
    const carrying = rules().filter((rule) => topInset.test(rule.body));

    expect(
      carrying.map((rule) => rule.selector),
      'the notch/Dynamic Island/status-bar row every screen has to clear is read from the ' +
        '--safe-area-top token, so :root is the only rule that may name env() for it at all',
    ).toEqual([':root']);

    expect(
      declarationsOf(carrying[0]?.body ?? '').some(
        (declaration) =>
          declaration.property === '--safe-area-top' && topInset.test(declaration.value),
      ),
      'the inset is declared somewhere in :root, but not as --safe-area-top, which is the ' +
        "name .screen and the map's top controls row read it by",
    ).toBe(true);
  });

  // The token existing is not the same as anything actually reading it -
  // that gap is exactly what the reported bug was: --bottom-nav-inset was
  // already correct before viewport-fit=cover was added, and it still sat at
  // 0px on every device because nothing made env() report a real number.
  // This is the --safe-area-top equivalent of that check: the two places the
  // owner's report and its own top-edge counterpart apply to must actually
  // reference the token, not merely have it available.
  it("clears the top safe area on every plain screen and on the map's top controls", () => {
    const token = 'var(--safe-area-top)';
    for (const block of ['screen', 'map-overlays__controls--top']) {
      const usesIt = rulesFor(block).some((rule) =>
        declarationsOf(rule.body).some((declaration) => declaration.value.includes(token)),
      );
      expect(usesIt, `.${block} does not read ${token}`).toBe(true);
    }
  });

  // Section 10.5 requires the OSM attribution persistently visible and
  // legible without a tap, and it sits in row 4 - the bottom corner controls.
  // The tab bar is fixed over the bottom edge of the same screen, so the only
  // thing keeping the two apart is the space this layout reserves for the
  // bar. Take it away and the attribution is behind chrome: still in the DOM,
  // still "rendered", and unreadable - which no test that does not lay the
  // screen out can see, and which is a licence obligation rather than a
  // matter of taste.
  it('reserves the tab bar height, so rows 4 and 5 clear it', () => {
    const reserved = rules()
      .filter((rule) =>
        rule.selector.split(',').some((part) => part.trim() === `.${OVERLAY_CONTAINER}`),
      )
      .flatMap((rule) => declarationsOf(rule.body))
      .filter((declaration) => declaration.property === 'padding-bottom')
      .map((declaration) => declaration.value);

    expect(reserved, `.${OVERLAY_CONTAINER} reserves no space at its bottom edge`).not.toHaveLength(
      0,
    );
    expect(
      reserved[reserved.length - 1],
      'the last padding-bottom on the overlay container is what the cascade uses, and ' +
        'it must be the whole of --bottom-nav-space (the bar plus the safe-area inset ' +
        'it carries). Anything smaller puts row 4 - the locate button and Section ' +
        "10.5's attribution - behind the tab bar.",
    ).toContain('var(--bottom-nav-space)');
  });
});

// SPEC.md Sections 7.4/8.3's bar stamp. Three of the things this feature
// promises are single declarations in this file with no visible effect until
// a real browser lays the map out, and jsdom renders none of them - the same
// limit every scan in this file works under, and the reason each of these is
// checked as text rather than by rendering the map.
describe('index.css: the bar stamp (SPEC.md Sections 7.4, 8.3)', () => {
  const css = readFileSync(fileURLToPath(new URL('./index.css', here)), 'utf-8');

  function bodiesFor(selector: string): string[] {
    return rules()
      .filter((rule) => rule.selector.split(',').some((part) => part.trim() === selector))
      .map((rule) => rule.body);
  }

  it('takes no pointer event anywhere, so nothing about it can eat a tap', () => {
    // It is a moment on the map and not a modal: the player keeps panning
    // and keeps tapping markers - including the one they have just
    // discovered - for the whole time it is on screen. The container is
    // where `pointer-events` is inherited from by everything inside it; the
    // scrim says it again because the scrim is the part that covers the
    // entire map.
    for (const selector of ['.bar-stamps', '.bar-stamp-scrim']) {
      const bodies = bodiesFor(selector);
      expect(bodies.length, `no rule targets ${selector}`).toBeGreaterThan(0);
      expect(
        bodies.some((body) => /pointer-events\s*:\s*none/.test(body)),
        `${selector} must set pointer-events: none, or the discovery moment blocks the ` +
          'map underneath it - a player cannot pan away from it and cannot reach the ' +
          'check-in on the marker of the bar they have just been told they found',
      ).toBe(true);
    }
  });

  // Section 8.2/12: reduced motion takes the movement away and leaves the
  // information. The two assertions here are one argument: the stamp's last
  // keyframe is transparent, so the global reduce rule - which collapses
  // every animation's *duration* rather than removing it - would run this
  // one instantly to "gone" and tell a player who asked for less movement
  // nothing at all. Dropping the animation is what leaves the base rules,
  // which are the finished stamp.
  it('drops the stamp animation under reduced motion rather than collapsing it to its last frame', () => {
    const press = css.match(/@keyframes bar-stamp-press \{([\s\S]*?)\n\}/);
    expect(press, 'no bar-stamp-press keyframes').not.toBeNull();
    expect(
      press?.[1],
      'the stamp animation is expected to end transparent - if it no longer does, this ' +
        'test is asserting a reason that has gone away and should be rewritten rather ' +
        'than deleted',
    ).toMatch(/100%\s*\{\s*opacity:\s*0/);

    const reduced = rules().filter((rule) =>
      rule.selector.split(',').some((part) => part.trim() === '.bar-stamp'),
    );
    expect(
      reduced.some((rule) => /animation\s*:\s*none/.test(rule.body)),
      'under prefers-reduced-motion the stamp must drop its animation entirely. The ' +
        'global rule only collapses animation-duration, which runs this one straight to ' +
        'its final keyframe - fully transparent - so a player who asked for less motion ' +
        'would never be told they had discovered a bar. Removing the motion is required; ' +
        'removing the information is the same failure as ignoring the setting.',
    ).toBe(true);
  });

  it('sets the caption in capitals in CSS, not in the document', () => {
    // "BAR DISCOVERED" is text in the app's own type (Section 8.1). The
    // string in the DOM stays ordinary English - map/bars/bar-stamps.ts's
    // BAR_STAMP_CAPTION - so what is read out is a sentence and not
    // shouting.
    const title = bodiesFor('.bar-stamp__title');
    expect(title.length, 'no rule targets .bar-stamp__title').toBeGreaterThan(0);
    expect(title.some((body) => /text-transform\s*:\s*uppercase/.test(body))).toBe(true);
  });
});

// Section 8.4's tab bar. It is the one piece of chrome that is on every
// signed-in screen at once, and the only element allowed to sit on the bottom
// edge - everything else on that edge clears it. Both halves of that bargain
// are single declarations with no visible effect until a phone renders them,
// and nothing else in this repository lays out a screen at all.
describe('index.css: the bottom tab bar', () => {
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

  function declarationsFor(selector: string): { property: string; value: string }[] {
    return rules()
      .filter((rule) => rule.selector.split(',').some((part) => part.trim() === selector))
      .flatMap((rule) => declarationsOf(rule.body));
  }

  it('is fixed to the bottom edge, at the height every screen reserves', () => {
    const bar = declarationsFor('.bottom-nav');
    expect(bar.length, 'no rule targets .bottom-nav').toBeGreaterThan(0);

    const declares = (property: string, value: string): boolean =>
      bar.some(
        (declaration) => declaration.property === property && declaration.value.includes(value),
      );

    expect(
      declares('position', 'fixed') && declares('bottom', '0'),
      '.bottom-nav must be fixed to the bottom edge of the viewport. In the flow it ' +
        'scrolls away with the page it sits over, and a tab bar that is only sometimes ' +
        'there is worse than none - it is the only navigation left after the burger ' +
        'menu.',
    ).toBe(true);
    expect(
      declares('height', 'var(--bottom-nav-space)'),
      '.bottom-nav must be exactly the height every other rule reserves for it. Sized ' +
        'independently, the bar and the space kept clear of it drift apart and the ' +
        'difference is either a strip of dead screen or content behind the bar.',
    ).toBe(true);
  });

  it('lets the scrolling screens clear it', () => {
    const clearing = rules().filter(
      (rule) =>
        rule.selector.includes('.bottom-nav') &&
        rule.selector.includes('.screen') &&
        declarationsOf(rule.body).some(
          (declaration) =>
            declaration.property === 'padding-bottom' &&
            declaration.value.includes('var(--bottom-nav-space)'),
        ),
    );

    expect(
      clearing.map((rule) => rule.selector),
      'a screen carrying the tab bar has to reserve its height at the bottom of its ' +
        'own padding, or its last line - the last row of the leaderboard, the delete ' +
        'account button on Settings - sits behind the bar and cannot be reached. The ' +
        'map is the exception and has its own reservation inside .map-overlays.',
    ).not.toHaveLength(0);
  });
});

// The map screen scrolled the document, and scrolling it carried the top row
// - the status icons of Section 8.6 and the burger menu of Section 8.4 - off
// the screen. There is nothing on the map to scroll to, so the scroll was
// pure loss.
//
// .screen--map already set `overflow: hidden`, which is why the map's own
// content could not scroll; what moved was the document underneath it. `body`
// and `#root` were `min-height: 100vh` with no `dvh` line while `.screen`
// carried both. On a mobile browser `100vh` is the *large* viewport height -
// what the page would get with the URL bar collapsed - and `100dvh` is what
// is visible now, so the two ancestors stayed taller than the screen by
// exactly the height of the URL bar and the document scrolled by that much.
//
// The defect was not "body had the wrong number". It was two rules that must
// agree about viewport height silently disagreeing, so what is checked here
// is the rule and not the instance: anything sizing itself to the viewport
// height carries the `vh` fallback and the `dvh` line that overrides it. The
// set is derived by scanning for the unit rather than listed, because a
// fourth rule added tomorrow with a bare `100vh` is precisely the regression
// this exists for and a list of three selectors would not see it.
//
// WHAT THIS CANNOT PROVE, plainly, and it is the same limit the overlay scan
// above states. This reads the stylesheet as text. jsdom computes no
// geometry, no test in this repository lays this screen out with index.css
// applied, and nothing here can show that a real browser has stopped
// scrolling - only that the declarations which made it scroll are gone and
// cannot come back unnoticed. It says nothing about whether `dvh` is
// supported by any particular browser, nothing about how tall anything
// actually is, and nothing about how the screen behaves while the URL bar
// animates. That still needs eyes on a phone.
describe('index.css: the map screen does not scroll the document', () => {
  // Both `100vh` and `100dvh` end in "vh", so the unit is matched from the
  // digits that immediately precede it: `100dvh` has a "d" in the way and
  // does not match the first pattern, and `100vw` matches neither.
  const STATIC_VIEWPORT_HEIGHT = /\d(?:\.\d+)?vh\b/;
  const DYNAMIC_VIEWPORT_HEIGHT = /\d(?:\.\d+)?dvh\b/;

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

  // One entry per (rule, property) that is sized in a viewport-height unit,
  // with that property's values in the order the rule declares them - which
  // is the order the cascade resolves them in, so the last one wins.
  function viewportHeightSized(): { selector: string; property: string; values: string[] }[] {
    return rules().flatMap((rule) => {
      const byProperty = new Map<string, string[]>();
      for (const { property, value } of declarationsOf(rule.body)) {
        if (!STATIC_VIEWPORT_HEIGHT.test(value) && !DYNAMIC_VIEWPORT_HEIGHT.test(value)) {
          continue;
        }
        byProperty.set(property, [...(byProperty.get(property) ?? []), value]);
      }
      return [...byProperty].map(([property, values]) => ({
        selector: rule.selector,
        property,
        values,
      }));
    });
  }

  it('sizes everything that follows the viewport height to the visible one', () => {
    const sized = viewportHeightSized();

    // A floor under the scan, not the list it works from: if the scan stopped
    // finding rules, the check below would run over an empty list and pass
    // without looking at anything. These three are the chain the map screen
    // hangs from - body, the React root, and the page shell - and they are
    // the ones that have to agree with each other.
    for (const selector of ['body', '#root', '.screen']) {
      expect(
        sized.map((entry) => entry.selector),
        `the scan no longer finds a viewport height on ${selector}`,
      ).toContain(selector);
    }

    const offending = sized
      .filter(
        (entry) =>
          !entry.values.some((value) => STATIC_VIEWPORT_HEIGHT.test(value)) ||
          !DYNAMIC_VIEWPORT_HEIGHT.test(entry.values[entry.values.length - 1] ?? ''),
      )
      .map((entry) => `${entry.selector} { ${entry.property}: ${entry.values.join(' / ')} }`);

    expect(
      offending,
      'every rule that sizes itself to the viewport height must declare the pair, ' +
        'plain `vh` first and `dvh` after it. `100vh` is the large viewport - the ' +
        'height the page would have with the mobile URL bar collapsed - and `100dvh` ' +
        'is what is actually visible, so a rule left on `vh` alone stays taller than ' +
        'the screen by the height of that bar and the document scrolls. The `vh` line ' +
        'is the fallback for browsers without `dvh` and has to come first; the `dvh` ' +
        'line has to come last or it never wins.',
    ).toEqual([]);
  });

  it('pins the map screen to the viewport', () => {
    const mapScreen = rules().filter((rule) =>
      rule.selector.split(',').some((part) => part.trim() === '.screen--map'),
    );

    expect(mapScreen.length, 'no rule targets .screen--map').toBeGreaterThan(0);

    const declared = mapScreen.flatMap((rule) => declarationsOf(rule.body));
    const declares = (property: string, value: string): boolean =>
      declared.some(
        (declaration) => declaration.property === property && declaration.value === value,
      );

    expect(
      declares('position', 'fixed'),
      '.screen--map must be `position: fixed`. In the document flow it is a child ' +
        'as tall as the viewport, so the document scrolls - and on this screen there ' +
        'is nothing to scroll to, so the only effect is carrying the status icons and ' +
        'the burger menu off the top. `overflow: hidden` does not cover this: it stops ' +
        'the map\'s own content scrolling, not the document underneath it. "fixed" is ' +
        'safe here because the screen has no text input to raise a keyboard over.',
    ).toBe(true);

    expect(
      declares('inset', '0') ||
        (['top', 'right', 'bottom', 'left'] as const).every((edge) => declares(edge, '0')),
      '.screen--map is taken out of the flow, so it has no size of its own to ' +
        'inherit. Without all four offsets it shrinks to its content instead of ' +
        'covering the viewport, and the map with it.',
    ).toBe(true);
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

// Three declarations that decide where things sit on a screen, none of which
// any test in this repository can watch doing its job: jsdom applies no
// stylesheet and computes no geometry, so what follows is a scan of the text
// of index.css and nothing more. It proves the declarations are there and
// cannot vanish unnoticed. It does not prove the district map stops resizing
// or that the wordmark stops moving - that still needs eyes on a phone.
describe('index.css: what the content column and the wordmark are allowed to depend on', () => {
  function bodiesFor(selector: string): string[] {
    return rules()
      .filter((rule) => rule.selector.split(',').some((part) => part.trim() === selector))
      .map((rule) => rule.body);
  }

  function declares(selector: string, property: string, value: RegExp): boolean {
    return bodiesFor(selector).some((body) =>
      new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*${value.source}\\s*(?:;|$)`).test(body),
    );
  }

  // .screen is a column flex container and .screen__content has `margin: 0
  // auto`. Flexbox stretches an item to the line only when "neither of its
  // cross-axis margins are auto", so those two auto margins mean the column
  // is *not* stretched: it is sized to fit its content and then centred. Its
  // width therefore followed the text inside it, and a percentage-width child
  // - the district and city maps - contributes nothing to that measurement.
  //
  // Two field reports came out of that one line: the schematic map shrank the
  // first time a district was selected, because a 46-character hint was
  // replaced by a name and a percentage; and the chrome wordmark on /profile,
  // the one screen that left-aligns its content, sat near the middle of the
  // screen while the profile loaded and jumped left when it arrived.
  it('gives the content column a width instead of letting its contents decide one', () => {
    expect(bodiesFor('.screen__content'), 'no rule targets .screen__content').not.toHaveLength(0);
    expect(
      declares('.screen__content', 'width', /100%/),
      '.screen__content must state `width: 100%`. It is a flex item with auto cross-axis ' +
        'margins, which suppresses the stretch that would otherwise give it the full ' +
        'width, so without this it is as wide as whatever text is in it - and every ' +
        '`width: 100%` child, the district and city maps included, is resized whenever ' +
        'that text changes.',
    ).toBe(true);
    // Still capped and still centred: the width above is what the cap and the
    // centring were always assumed to be applying to.
    expect(declares('.screen__content', 'max-width', /32rem/)).toBe(true);
    expect(declares('.screen__content', 'margin', /0 auto/)).toBe(true);
  });

  // Section 8.1: one mark, and its position is the mark's own rather than
  // whichever screen is hosting it. .screen__content centres, .profile is the
  // only screen that overrides that to `left`, and inheriting from either is
  // how the same signature ends up in two places in one application.
  it.each([
    ['.wordmark--chrome', 'left'],
    ['.wordmark--hero', 'center'],
  ])('gives %s an alignment of its own rather than inheriting the screen’s', (selector, value) => {
    expect(bodiesFor(selector), `no rule targets ${selector}`).not.toHaveLength(0);
    expect(
      declares(selector, 'text-align', new RegExp(value)),
      `${selector} must declare text-align: ${value}. Inherited, it is centred on the ` +
        'city overview and on the leaderboard and hard left on a profile, and it moves ' +
        'when a screen that hosts it changes its mind about its own text.',
    ).toBe(true);
  });

  // The district panel's first row holds a 46-character hint in one state and
  // a name plus a percentage in the other. The hint wraps to two lines on
  // every phone narrower than about 405 px and the selected state never wraps
  // at all, so the row lost a line on the first selection and the panel - and
  // the map above it - moved.
  //
  // The row therefore stacks both states in one grid cell and hides the
  // inactive one, which reserves the taller without anyone writing a height
  // down. A `min-height` in lines would encode today's string at today's font
  // size; the same hint takes three lines at a 24 px root font on a 320 px
  // phone. screens/DistrictOverview.tsx keeps the hidden hint rendered, which
  // App.test.tsx pins; these are the declarations that make it a reservation
  // rather than an overlap.
  it('reserves the district panel’s first row for its tallest state', () => {
    const row = '.district-overview__detail-row--primary';
    expect(bodiesFor(row), `no rule targets ${row}`).not.toHaveLength(0);
    expect(
      declares(row, 'display', /grid/),
      `${row} must be a grid, or its two states sit side by side instead of stacking`,
    ).toBe(true);
    expect(
      bodiesFor(`${row} > *`).some((body) => /grid-area\s*:\s*1\s*\/\s*1/.test(body)),
      `${row} > * must place every child in the same cell. Auto-placement puts them in ` +
        'two rows instead, which makes the panel taller in the selected state rather ' +
        'than the same height in both.',
    ).toBe(true);
    expect(
      declares('.district-overview__detail-hint--reserved', 'visibility', /hidden/),
      'the reserved hint must be hidden with `visibility`, not `display: none`: a box ' +
        'that is not generated reserves no height, which is the whole point of leaving ' +
        'it in the flow.',
    ).toBe(true);
  });
});

// SPEC.md Section 8.1: the accent colour "is never the only carrier of
// meaning - active states also change shape, weight, or label", and on a
// near-monochrome palette that goes double for grey. A badge placeholder
// (Section 7.7) is greyed because the owner asked for it to be, but greying
// is a difference in lightness and nothing else: it is gone in a black-and-
// white print, and it is the weakest of signals for anyone reading the shelf
// at a glance.
//
// SINCE v1.38 THE SECOND CHANNEL IS THE FRAME AND ONLY THE FRAME, which
// raises the stakes of these tests rather than lowering them. The artwork
// itself is now deliberately identical in the two states - the owner's "just
// use same as real badge but in light grey" - so where there used to be two
// shape channels (a hollowed mark, broken rings) there is now one, and it is
// the dashed frame drawn round the unearned glyph. Delete it and the entire
// distinction is opacity, which is exactly what Section 8.1 forbids.
//
// What this cannot prove is that the result reads well; that still needs
// eyes. What it does prove is that the artwork stays identical, that the
// frame exists and is broken, and that removing it leaves nothing but grey.
describe('index.css: an unearned badge differs from an earned one in shape, not only in grey', () => {
  function bodyFor(selector: string): string {
    const matching = rules().filter((rule) =>
      rule.selector.split(',').some((part) => part.trim() === selector),
    );
    expect(matching.length, `no rule targets ${selector}`).toBeGreaterThan(0);
    return matching.map((rule) => rule.body).join(' ');
  }

  // The owner asked for the same drawing, and "the same drawing" is a
  // property of the paint as much as of the paths: a placeholder whose mark
  // were hollow or stroked would be a second drawing of the same badge, which
  // is what this replaced. Hollowing it would also now say the wrong thing
  // outright - a wall of ink around an empty middle is Section 8.1's grammar
  // for a *mastered* cocktail glass, and the barfly pictogram is a cocktail
  // glass.
  it('paints the unearned artwork exactly as the earned artwork', () => {
    for (const element of ['mark', 'modifier']) {
      expect(bodyFor(`.badge__${element}`)).toMatch(/fill\s*:\s*currentColor/);
      const placeholder = bodyFor(`.badge-placeholder__${element}`);
      expect(
        placeholder,
        `.badge-placeholder__${element} must be filled like the earned one - the owner ` +
          'asked for the same badge in light grey, not a second drawing of it',
      ).toMatch(/fill\s*:\s*currentColor/);
      expect(placeholder).not.toMatch(/stroke\s*:/);
    }
  });

  it('frames the unearned glyph, and breaks the frame', () => {
    const frame = bodyFor('.badge-placeholder__frame');
    expect(frame).toMatch(/fill\s*:\s*none/);
    expect(frame).toMatch(/stroke\s*:\s*currentColor/);
    expect(
      frame,
      'the placeholder frame must be dashed - it is the only channel left that is not ' +
        'lightness, and Section 8.1 does not allow a state to rest on lightness alone. ' +
        'Broken against continuous is the same channel district boundaries use.',
    ).toMatch(/stroke-dasharray\s*:\s*\S/);

    // And the earned badge has no frame at all, or the channel carries
    // nothing: there is no .badge__frame rule, and Badge.tsx draws the <rect>
    // in one of the two states only.
    expect(
      rules().filter((rule) =>
        rule.selector.split(',').some((part) => part.trim() === '.badge__frame'),
      ),
      'an earned badge has grown a frame of its own, so the frame no longer separates ' +
        'the two states',
    ).toHaveLength(0);
  });

  it('keeps the placeholder quieter than an earned badge as well', () => {
    // The lightness channel, and the one the owner asked for by name
    // ("ausgegraut", "sehr dezent"): an earned badge stays the louder thing
    // on a shelf holding both. It is the *second* channel and never the only
    // one - see the frame above.
    expect(bodyFor('.badge__icon')).not.toMatch(/opacity/);
    const opacity = /opacity\s*:\s*(0?\.\d+)/.exec(bodyFor('.badge-placeholder__icon'));
    expect(opacity, '.badge-placeholder__icon must be drawn back from full ink').not.toBeNull();
    expect(Number(opacity?.[1])).toBeLessThan(1);
  });

  // Section 8.1: ink, and the accent is reserved for the player's own
  // position and for active states. A badge is neither, and a badge is
  // exactly the thing someone reaches for a colour to make special.
  it('draws every part of both states in ink and in nothing else', () => {
    for (const selector of [
      '.badge__icon',
      '.badge__mark',
      '.badge__modifier',
      '.badge-placeholder__icon',
      '.badge-placeholder__mark',
      '.badge-placeholder__modifier',
      '.badge-placeholder__frame',
      '.badge-sheet__mark',
    ]) {
      const body = bodyFor(selector);
      expect(body, `${selector} paints with the accent colour`).not.toMatch(/--color-accent/);
      expect(body, `${selector} paints with a colour of its own`).not.toMatch(
        /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/,
      );
      expect(body, `${selector} carries a gradient or a shadow`).not.toMatch(
        /gradient|box-shadow|filter\s*:|drop-shadow/,
      );
    }
  });
});

// Section 8.1/8.2: the wordmark became a control on every screen that carries
// it as chrome, and a control needs a target. This is a scan of index.css and
// nothing more - jsdom computes no geometry, so nothing here proves the 44 px
// is comfortable, or that the strip it adds above and below a 0.75rem line is
// as tight to the mark as it is meant to be. What it proves is that removing
// the declarations fails the suite.
describe('index.css: the wordmark as a link (SPEC.md Sections 8.1, 8.2)', () => {
  function bodyFor(selector: string): string {
    const matching = rules().filter((rule) =>
      rule.selector.split(',').some((part) => part.trim() === selector),
    );
    expect(matching.length, `no rule targets ${selector}`).toBeGreaterThan(0);
    return matching.map((rule) => rule.body).join(' ');
  }

  it('reserves Section 8.2’s 44px of height around a 0.75rem mark', () => {
    const body = bodyFor('.wordmark--link');
    expect(
      body,
      'the chrome wordmark is 0.75rem of type in a 0.25rem padding box - about 22px - ' +
        'so without a stated minimum it is half the tap target Section 8.2 requires',
    ).toMatch(/min-height:\s*44px/);
    // Shrink-wrapped, which is the half of it that matters on the map: a
    // block-level link would stretch an invisible 44px bar across the whole
    // width of a map whose one gesture is a drag.
    expect(
      body,
      'the wordmark link must be inline-flex, or its box is as wide as the row and the ' +
        'target becomes a strip along the top of the map instead of the mark itself',
    ).toMatch(/display:\s*inline-flex/);
    expect(body).toMatch(/text-decoration:\s*none/);
  });

  // `.map-overlays .wordmark` sets pointer-events: none, which is right for a
  // mark and fatal for a link. Both rules exist on purpose and the link one
  // has to come second - they have equal specificity, so this is source order
  // doing the work, and nothing about it is visible in a rendered DOM.
  it('gives the map’s wordmark its pointer events back, after the rule that took them', () => {
    const all = rules();
    const markIndex = all.findIndex((rule) => rule.selector.trim() === '.map-overlays .wordmark');
    const linkIndex = all.findIndex(
      (rule) => rule.selector.trim() === '.map-overlays .wordmark--link',
    );
    expect(markIndex, 'no rule targets .map-overlays .wordmark').toBeGreaterThanOrEqual(0);
    expect(linkIndex, 'no rule targets .map-overlays .wordmark--link').toBeGreaterThanOrEqual(0);
    expect(all[linkIndex].body).toMatch(/pointer-events:\s*auto/);
    expect(
      linkIndex,
      'the two selectors have the same specificity, so .map-overlays .wordmark--link ' +
        'must come after .map-overlays .wordmark - before it, the map’s wordmark is a ' +
        'link that cannot be tapped',
    ).toBeGreaterThan(markIndex);
  });

  // The tracking indicator moved to the top-right corner when the wordmark
  // took the row's first slot, and its explanation panel is 18rem wide and
  // absolutely positioned against it. Anchored on its left edge from that
  // corner it runs off the side of the phone, and `max-width` cannot save it
  // because the overflow is a position rather than a width.
  it('hangs the tracking explanation from the corner its icons now sit in', () => {
    const body = bodyFor('.tracking-indicator__panel');
    expect(
      body,
      'the tracking panel is anchored left again. Since the top row swapped its two ' +
        'children the icons sit at the right edge, and a panel growing rightwards from ' +
        'there is 18rem of panel off the side of the screen.',
    ).toMatch(/(?:^|;)\s*right:\s*0/);
    expect(body).not.toMatch(/(?:^|;)\s*left:\s*0/);
  });
});
