import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useCurrentUser } from '../auth/CurrentUserContext.js';
import { useLogout } from '../auth/useLogout.js';

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
