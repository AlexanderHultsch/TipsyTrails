// SPEC.md Sections 8.1 and 8.3: the cocktail glass is the mark for a bar
// everywhere a bar is drawn, and its two states say whether the player has
// mastered that bar (Section 5.7) - a full glass for one they have not, a
// nearly empty one for one they have.
//
// One definition, here, because it is a system rather than an icon: the map
// marker (map/bars/bar-markers.ts), the bar sheet (components/BarSheet.tsx)
// and the bar detail screen (screens/BarDetail.tsx) all draw from these path
// strings. A martini glass copied into three files is three glasses that
// drift apart, and the two states are exactly the thing that must not.
//
// Hand-written SVG, like components/TrackingIndicator.tsx and
// components/BottomNav.tsx - no icon library, no new dependency.
//
// Two consumers with two rendering models: the marker builds DOM by hand
// (it is not a React tree) and the two React surfaces render elements. Both
// go through `cocktailGlassPathData` below, so neither can hold a shape the
// other does not.

/** The coordinate system every path below is drawn in. */
export const COCKTAIL_GLASS_VIEW_BOX = '0 0 24 24';

// The stem and the foot, shared by both states unchanged: what differs is
// what is in the glass, not which glass it is. The rectangle overlaps the
// bowl's apex so the two paths read as one silhouette.
const STEM_AND_FOOT_D = 'M11 13.4h2v5.6h3.6a1 1 0 0 1 0 2H7.4a1 1 0 0 1 0-2H11z';

// Not mastered: the bowl is solid ink from rim to apex - a full glass.
const BOWL_FULL_D = 'M2.9 4h18.2L12 14.6z';

// Mastered: the same bowl as a wall of ink around an empty middle, with the
// last of the drink left as a solid wedge at the bottom. It is one path with
// two subpaths, and the inner one is wound the other way so the default
// nonzero fill rule punches it out - so this is still a solid pictogram with
// no stroke, no gradient and no outline (Section 8.1), drawn the same way
// the full glass is.
//
// SPEC.md Section 8.1, and the constraint that decides every number in it:
// the two states differ in *shape*, never in colour, and the difference has
// to survive at marker size, which is 22 px. It does so by ink mass rather
// than by detail - a filled triangle against a hollow one is most of the
// bowl's area appearing or disappearing, which is legible at a glance and
// still legible to a player who cannot perceive colour at all. The wall is
// ~2 units, just under 2 px at marker size, so it is a line that is actually
// drawn rather than a hairline that greys out; the empty middle stops short
// of the apex, which both leaves the drink visible and keeps the tip from
// closing to a point too fine to render.
const BOWL_NEARLY_EMPTY_D = 'M2.9 4h18.2L12 14.6zM7.4 6.2 12 10.4 16.6 6.2z';

/** The `d` of every path making up the glass, in draw order. */
export function cocktailGlassPathData(mastered: boolean): string[] {
  return [mastered ? BOWL_NEARLY_EMPTY_D : BOWL_FULL_D, STEM_AND_FOOT_D];
}

/**
 * The glass as an SVG markup string, for `map/bars/bar-markers.ts` — the one
 * consumer that builds its DOM by hand rather than rendering a React tree.
 *
 * Always `aria-hidden`: the state it draws is carried in words by whatever
 * owns the mark (the marker's `aria-label`, the two screens' own text), and
 * a screen reader gets nothing from a fuller or emptier glass.
 */
export function cocktailGlassSvgMarkup(mastered: boolean): string {
  const paths = cocktailGlassPathData(mastered)
    .map((d) => `<path d="${d}"/>`)
    .join('');
  return (
    `<svg class="cocktail-glass" viewBox="${COCKTAIL_GLASS_VIEW_BOX}" aria-hidden="true" focusable="false">` +
    paths +
    '</svg>'
  );
}

/**
 * SPEC.md Section 5.7's state in words, lower case, for use inside a
 * sentence or an accessible name.
 *
 * "Not mastered yet" rather than "not mastered": mastering is permanent and
 * cannot be lost (Section 5.7), so the only direction this flag ever moves
 * is towards mastered, and the wording says so.
 */
export function masteredPhrase(mastered: boolean): string {
  return mastered ? 'mastered' : 'not mastered yet';
}

/** The same words, sentence-cased, for a label standing on its own. */
export function masteredStatusText(mastered: boolean): string {
  const phrase = masteredPhrase(mastered);
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

/**
 * The accessible name for a control that stands for one bar — its name and
 * its mastered state, in words.
 *
 * SPEC.md Section 8.1: nothing may rely on a visual channel alone, and this
 * mark's whole content is a visual difference in how full a glass is. The
 * state therefore goes into the *name* rather than into a description
 * (`aria-describedby`, which is where the community distinction stays): a
 * bar's mastered state is what this mark is for, not supplementary
 * information about it.
 */
export function barAccessibleName(name: string, mastered: boolean): string {
  return `${name} - ${masteredPhrase(mastered)}`;
}
