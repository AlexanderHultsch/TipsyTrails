import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCurrentUser } from '../auth/CurrentUserContext.js';
import { useLogout } from '../auth/useLogout.js';

// Single burger menu, top right, on every authenticated screen (Section
// 8.4). Phase 2 adds Map, City and Districts; Phase 5 adds "How mastering
// works" (Section 7.5: reachable from here regardless of the auto-shown
// explainer); Phase 6 adds Leaderboard and Profile - the rest arrive with
// their own screens in later phases.
export function BurgerMenu() {
  const [open, setOpen] = useState(false);
  const { user } = useCurrentUser();
  const handleLogout = useLogout();
  const menuId = useId();

  useEffect(() => {
    if (!open) {
      return;
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open]);

  async function handleLogoutClick() {
    setOpen(false);
    await handleLogout();
  }

  return (
    <nav className="burger-menu">
      <button
        type="button"
        className="burger-menu__button"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label="Menu"
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">&#9776;</span>
      </button>
      {open && (
        <ul id={menuId} className="burger-menu__panel">
          <li>
            <Link to="/map" onClick={() => setOpen(false)}>
              Map
            </Link>
          </li>
          <li>
            <Link to="/city" onClick={() => setOpen(false)}>
              City
            </Link>
          </li>
          <li>
            <Link to="/districts" onClick={() => setOpen(false)}>
              Districts
            </Link>
          </li>
          <li>
            <Link to="/leaderboard" onClick={() => setOpen(false)}>
              Leaderboard
            </Link>
          </li>
          {user && (
            <li>
              <Link to={`/profile/player-${user.id}`} onClick={() => setOpen(false)}>
                Profile
              </Link>
            </li>
          )}
          <li>
            <Link to="/suggest" onClick={() => setOpen(false)}>
              Suggest a bar
            </Link>
          </li>
          <li>
            <Link to="/how-it-works" onClick={() => setOpen(false)}>
              How mastering works
            </Link>
          </li>
          <li>
            <Link to="/settings" onClick={() => setOpen(false)}>
              Settings
            </Link>
          </li>
          {user?.isAdmin && (
            <li>
              <Link to="/admin" onClick={() => setOpen(false)}>
                Admin
              </Link>
            </li>
          )}
          <li>
            <button type="button" onClick={handleLogoutClick}>
              Log out
            </button>
          </li>
        </ul>
      )}
    </nav>
  );
}
