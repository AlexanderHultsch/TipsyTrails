import { Link } from 'react-router-dom';

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
 *
 * Internal: every call site writes the prominence as a string literal in
 * JSX and is contextually typed from the prop below, so the name is never
 * needed outside this file.
 */
type WordmarkProminence = 'hero' | 'chrome';

const WORDMARK_TEXT = 'Tipsy Trails';

/** Section 8.3's start screen, and the only place the mark ever leads to. */
const START_SCREEN_PATH = '/app';

/**
 * The element is a prop, and heading structure is why. Rendered as `<h1>`
 * everywhere, "Tipsy Trails" would become the title of every screen and a
 * reader navigating by heading would be told the name of the application
 * instead of the name of the page they are on. So it is an `<h1>` only where
 * the wordmark really is the screen's subject, and an inert `<span>` wherever
 * it is chrome sitting above a heading of the screen's own.
 *
 * `linksToStart` is the owner's *"I would like that we can press the logo and
 * get to the start screen"*, bounded by his second sentence: *"when we click
 * the logo we should not be logged out, just land at the same page"*. So the
 * mark leads to `/app` and to nothing else, and it is inert wherever leading
 * there would fail that - which is two cases and both of them real:
 *
 * - **On the start screen itself.** A control that visibly does nothing is
 *   worse than plain text, and re-navigating to the route you are already on
 *   is exactly nothing.
 * - **Signed out** (screens/Landing.tsx). `/app` is behind `RequireAuth`,
 *   which sends a reader with no session to `/login` - which is precisely the
 *   "logged out" outcome the owner ruled out, arrived at by a tap he was told
 *   would take him home.
 *
 * **IT IS A PROP AND NOT SOMETHING THIS COMPONENT LOOKS UP, AND THAT IS THE
 * DECISION WORTH RECORDING.** The two questions above are "which route is
 * this?" and "is there a session?", and this component could answer them
 * itself with `useLocation` and `useCurrentUser`. It does not, for three
 * reasons. It would make a mark that is drawn on the signed-out landing
 * screen a consumer of the auth context, so a screen or a test rendering it
 * outside `CurrentUserProvider` would throw where today it renders. It would
 * make the wordmark's behaviour invisible at the call site, where the owner's
 * rule ("not from here") actually lives. And the usual argument against a
 * prop - that a future screen forgets it - does not apply, because the prop
 * is **required** on every non-heading instance: the type below admits
 * `as="h1"` with no `linksToStart` (a hero mark is never a link; the two
 * screens that carry one are the two inert cases) and every other instance
 * only with the answer written out. The compiler asks the question; nobody
 * has to remember to.
 */
type WordmarkProps = { prominence: WordmarkProminence } & (
  { as: 'h1'; linksToStart?: never } | { as?: 'span'; linksToStart: boolean }
);

export function Wordmark({ prominence, ...rest }: WordmarkProps) {
  const className = `wordmark wordmark--${prominence}`;

  // An inner span purely so the tracking can be given back at the end.
  // letter-spacing adds its space after the *last* letter too, which pushes
  // centred text left by half of it - invisible at the chrome size, several
  // pixels at the hero size, and exactly the kind of thing that makes a
  // wordmark look not quite right without saying why.
  const text = <span className="wordmark__text">{WORDMARK_TEXT}</span>;

  if (rest.as !== 'h1' && rest.linksToStart) {
    // An ordinary link with the mark as its whole content, and deliberately
    // no explanatory suffix on it: a wordmark that leads to the start screen
    // is one of the oldest patterns on the web, and "Tipsy Trails, go to
    // start screen" is an instruction read aloud to someone who did not need
    // it. What separates it from the inert mark for a screen reader is
    // therefore the *role* and not the name - this announces as "Tipsy
    // Trails, link" where the span announces as "Tipsy Trails" and the
    // heading as "Tipsy Trails, heading level 1".
    //
    // .wordmark--link is what gives it Section 8.2's 44 px of target and takes
    // the underline off (index.css); it is a modifier of the same block, so
    // the family, case, weight, colour and tracking are still stated once for
    // every instance in the application.
    return (
      <Link className={`${className} wordmark--link`} to={START_SCREEN_PATH}>
        {text}
      </Link>
    );
  }

  const Element = rest.as ?? 'span';
  return <Element className={className}>{text}</Element>;
}
