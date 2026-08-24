// Section 8.1/8.2: the application's wordmark, defined here once and drawn at
// two prominences. The owner's requirement is that "Tipsy Trails" is visible
// on every main screen and always in the same typography and the same visual
// style - and, in the same breath, that it is *not* a large header bolted onto
// every screen: prominent on the start screen, small and quiet on the map. Two
// prominences of one definition is what satisfies both halves; a heading
// retyped per screen satisfies neither, and there were two of those
// (screens/AppHome.tsx and screens/Landing.tsx) before this existed.
//
// There is no webfont, and that is a decision rather than an omission.
// index.css carries exactly two families - a Georgia stack and a system-ui
// stack - and adding a third would mean a new network request on the first
// paint of the first screen a player ever sees, plus a brand that is missing
// for as long as it takes to arrive and gone entirely if it never does. So the
// identity comes from what is done with the stacks that are already there:
// the serif, capitals, wide tracking, ink. All of it lives in index.css under
// .wordmark, in one place, for the same reason this component exists.
//
// The capitals are applied in CSS (text-transform) and not written into the
// document, the same way Section 7.4's stamp caption is: what a screen reader
// announces and what a reader of the markup sees is the ordinary name of the
// application, not shouting.

/**
 * How loud this instance is. `hero` is the wordmark as the subject of the
 * screen (the start screen, the landing screen); `chrome` is the wordmark as
 * the application's signature on a screen that is about something else.
 */
export type WordmarkProminence = 'hero' | 'chrome';

const WORDMARK_TEXT = 'Tipsy Trails';

/**
 * The element is a prop, and heading structure is why. Rendered as `<h1>`
 * everywhere, "Tipsy Trails" would become the title of every screen and a
 * reader navigating by heading would be told the name of the application
 * instead of the name of the page they are on. So it is an `<h1>` only where
 * the wordmark really is the screen's subject, and an inert `<span>` wherever
 * it is chrome sitting above a heading of the screen's own.
 */
export function Wordmark({
  prominence,
  as = 'span',
}: {
  prominence: WordmarkProminence;
  as?: 'h1' | 'span';
}) {
  const Element = as;
  return (
    <Element className={`wordmark wordmark--${prominence}`}>
      {/* An inner span purely so the tracking can be given back at the end.
          letter-spacing adds its space after the *last* letter too, which
          pushes centred text left by half of it - invisible at the chrome
          size, several pixels at the hero size, and exactly the kind of thing
          that makes a wordmark look not quite right without saying why. */}
      <span className="wordmark__text">{WORDMARK_TEXT}</span>
    </Element>
  );
}
