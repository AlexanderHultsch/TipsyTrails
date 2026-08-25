import { useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useCurrentUser } from '../auth/CurrentUserContext.js';
import { useLogout } from '../auth/useLogout.js';

// Section 8.4: where "Report a bug" goes. The issue *form*, not the
// repository root - a player who taps this has something to say and must land
// somewhere they can type it, not on a README they then have to navigate out
// of. The repository is `TipsyTrails`; `Tipsy-Trails` is an old name that
// survives only as a redirect (Section 4.3), so it is not written here.
//
// Copy, not a constant of the specification: this is a URL and a template, so
// it lives beside the sheet's other strings rather than in
// packages/shared/src/config.ts, which holds the rate limits, radii and
// thresholds of Section 0 rule 3.
const ISSUE_FORM_URL = 'https://github.com/AlexanderHultsch/TipsyTrails/issues/new';

// What a bug report needs and a player will not think to include. Deliberately
// three short prompts rather than a form: anything longer is a wall of
// boilerplate to delete on a phone.
//
// There is no app version in it, and that is a decision. packages/web has no
// build-time version to read - its package.json is at 0.0.0 - so a version
// line here would be a number that means nothing, and a wrong one is worse in
// a bug report than an absent one.
//
// The screen comes from the router rather than from a hard-coded string, so it
// is the screen the sheet was opened over and cannot go stale.

// The dynamic segments of a path are replaced by their parameter names before
// the template is built, so `/profile/silke` reports as `/profile/:handle` and
// `/bars/41` as `/bars/:id`.
//
// A GitHub issue is public and permanent, and this body is prefilled rather
// than typed - a player who never scrolls the field would publish their own
// handle, or a bar's id, without having decided to. Which *screen* a bug
// happened on is the whole diagnostic value here; *which* profile or bar is
// not, and Section 10.1's posture is that the application does not put a
// player's identity anywhere they did not put it themselves. The player can
// still add the specific one, in the field, on purpose.
function maskDynamicSegments(pathname: string): string {
  return pathname
    .replace(/^\/profile\/[^/]+/, '/profile/:handle')
    .replace(/^\/bars\/[^/]+/, '/bars/:id');
}

function issueUrlFor(screen: string): string {
  const body = [
    'What happened:',
    '',
    'What I expected:',
    '',
    `Screen: ${maskDynamicSegments(screen)}`,
  ].join('\n');
  return `${ISSUE_FORM_URL}?body=${encodeURIComponent(body)}`;
}

// Section 8.4: the secondary destinations the bottom tab bar does not carry,
// in a sheet the More tab opens.
//
// An overlay, not a route: it has no URL of its own and adds no history
// entry, so the back gesture leaves the screen behind the sheet rather than
// stepping through a page nobody navigated to. That makes it a dialog, and it
// takes the shape the repository's other dialog already has
// (components/TrackingIndicator.tsx's panel): role="dialog" with an
// accessible name of its own. It adds what a modal needs on top - it is the
// whole screen's business while it is open, so aria-modal, focus moved into
// it on open and handed back to the More tab on close, and three ways out:
// Escape, a tap outside it, and choosing an item.
//
// Every destination here is also reachable while the sheet is closed, so
// nothing is lost by not trapping focus - a Tab out of the sheet lands on the
// page behind it rather than on nothing.
export function MoreSheet({ onClose }: { onClose: () => void }) {
  const { user } = useCurrentUser();
  const handleLogout = useLogout();
  const panelRef = useRef<HTMLDivElement | null>(null);
  // The sheet is an overlay on the screen behind it and closes on navigation,
  // so this is that screen for as long as the item can be tapped.
  const { pathname } = useLocation();

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Focus moves into the sheet on open, or a keyboard reader who opened it
  // is still standing on the More tab behind it, tabbing through the page
  // under the sheet to reach what they just asked for.
  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('a, button')?.focus();
  }, []);

  async function handleLogoutClick() {
    onClose();
    await handleLogout();
  }

  return (
    // The backdrop closes the sheet on a tap outside it. It is not a control
    // and carries no keyboard handler of its own on purpose: Escape above is
    // the keyboard's way out, and a focusable backdrop would be one more stop
    // between a keyboard reader and the items.
    <div className="more-sheet" role="presentation" onClick={onClose}>
      <div
        className="more-sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-label="More"
        ref={panelRef}
        onClick={(event) => event.stopPropagation()}
      >
        <ul className="more-sheet__items">
          <li>
            <Link to="/suggest" onClick={onClose}>
              Suggest a bar
            </Link>
          </li>
          <li>
            <Link to="/how-it-works" onClick={onClose}>
              How mastering works
            </Link>
          </li>
          <li>
            <Link to="/settings" onClick={onClose}>
              Settings
            </Link>
          </li>
          <li>
            <Link to="/privacy" onClick={onClose}>
              Privacy
            </Link>
          </li>
          {/* The one destination in the sheet that is not in the
              application. It is an <a> and not a <Link> because there is no
              route to give the router, and it says so in its own label: a tap
              that silently swaps the app for a browser tab is a tap a player
              cannot undo with the back gesture they have. `noopener
              noreferrer` for the reason every `target="_blank"` needs it - the
              opened page must not get a handle on this one.
              `rel="external"` is deliberately not added: it says nothing to a
              browser or a reader that the label does not already say.

              The second line is the sign-in wall stated before it is hit.
              GitHub asks for an account to file an issue, and a player who
              does not have one should find that out here rather than on a
              login page in a tab they did not ask for.

              It sits with the navigation above rather than in the gap below,
              which belongs to Log out alone: this is somewhere to go, and the
              divider's whole job is to keep the item that ends a session
              apart from the items that do not. */}
          <li>
            <a
              className="more-sheet__external"
              href={issueUrlFor(pathname)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={onClose}
            >
              <span>Report a bug on GitHub (opens a new tab)</span>
              <span className="more-sheet__item-note">A GitHub account is required.</span>
            </a>
          </li>
          {/* Exactly the rule the burger menu applied, unchanged. It is
              cosmetic either way: the real boundary is requireAdmin on the
              server, which answers 403 whatever this renders. */}
          {user?.isAdmin && (
            <li>
              <Link to="/admin" onClick={onClose}>
                Admin
              </Link>
            </li>
          )}
        </ul>
        {/* The one item here that is not navigation, and it is separated
            from the items above by more than colour: a rule across the
            sheet, a gap, its own border, and a heavier label. Section 8.1
            forbids the accent carrying a meaning on its own, and this is
            exactly the item where a misfire costs the most. */}
        <hr className="more-sheet__divider" />
        <button
          type="button"
          className="more-sheet__logout"
          onClick={() => void handleLogoutClick()}
        >
          Log out
        </button>
      </div>
    </div>
  );
}
