import { useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useCurrentUser } from '../auth/CurrentUserContext.js';
import { MoreSheet } from './MoreSheet.js';

// Section 8.4: the persistent bottom tab bar. Five tabs - Cities, Map,
// Ranks, Profile, More - with the secondary destinations behind the More
// sheet (components/MoreSheet.tsx).
//
// It renders only for a signed-in reader, and that is a decision with a
// consequence. Two of its five tabs need a session to mean anything at all:
// Profile addresses the signed-in user's own handle, and the sheet's Log out
// needs a session to end. So this is signed-in chrome, and /privacy - the one
// screen reachable while signed out that used to carry the burger menu -
// renders a back link of its own instead (screens/Privacy.tsx). Without one
// it is a dead end in the installed PWA, which has no browser chrome to go
// back with.
//
// The nav is mounted by each screen rather than once around the router,
// which is how the burger menu it replaces was mounted too. One mount in
// App.tsx would be better - twelve mounts are twelve places to forget one -
// and the task brief for this change put App.tsx outside its file scope.

type TabId = 'cities' | 'map' | 'ranks' | 'profile';

// Which tab the current URL belongs to, derived from the router and from
// nothing else. A prop passed down by each screen would be the same answer
// written twelve times, and twelve places for it to be wrong; a screen that
// forgot it would simply show no tab as current, which is invisible until
// someone notices they cannot tell where they are.
//
// /districts is the drill-down of the Cities tab (the owner's specification,
// section 3: Cities -> Districts), so it lights the tab it was reached
// through. Everything the More sheet leads to - Settings, Privacy, Admin,
// Suggest a bar, How mastering works - and the bar detail page belong to no
// tab and light none: `null` is a real answer here, not a missing case.
function activeTabFor(pathname: string): TabId | null {
  if (pathname === '/city' || pathname === '/districts') {
    return 'cities';
  }
  if (pathname === '/map') {
    return 'map';
  }
  if (pathname === '/leaderboard') {
    return 'ranks';
  }
  if (pathname.startsWith('/profile/')) {
    return 'profile';
  }
  return null;
}

// Hand-written line work in the same ink style as the three status icons of
// components/TrackingIndicator.tsx: one 24x24 viewBox, stroked in
// currentColor, no fill and no shadow (Section 8.1). No icon library - the
// repository has none and this change adds no dependency.
function TabIcon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" className="bottom-nav__icon" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

// A pair of buildings: the mark for a city.
const CITIES_ICON = (
  <>
    <path d="M3.5 20.5V9.5l6-3v14" />
    <path d="M9.5 20.5V12l11 2.5v6" />
    <path d="M6 12.5v0M6 16v0M13.5 17v0M17 17.5v0" />
  </>
);

// A folded map: three panels, the folds alternating up and down.
const MAP_ICON = (
  <>
    <path d="M3 6.5 9 4l6 2.5L21 4v13.5L15 20l-6-2.5L3 20z" />
    <path d="M9 4v13.5M15 6.5V20" />
  </>
);

// A trophy: a cup with two handles on a stem and a base.
const RANKS_ICON = (
  <>
    <path d="M7.5 3.5h9v5a4.5 4.5 0 0 1-9 0z" />
    <path d="M7.5 5H5a2.5 2.5 0 0 0 2.5 2.5M16.5 5H19a2.5 2.5 0 0 1-2.5 2.5" />
    <path d="M12 13v4M8.5 20.5h7" />
  </>
);

// A person: a head over the curve of a pair of shoulders.
const PROFILE_ICON = (
  <>
    <circle cx="12" cy="8" r="3.75" />
    <path d="M4.75 20.5a7.25 7.25 0 0 1 14.5 0" />
  </>
);

// Three dots: the overflow mark.
const MORE_ICON = (
  <>
    <circle className="bottom-nav__icon-dot" cx="5.5" cy="12" r="1.6" />
    <circle className="bottom-nav__icon-dot" cx="12" cy="12" r="1.6" />
    <circle className="bottom-nav__icon-dot" cx="18.5" cy="12" r="1.6" />
  </>
);

function tabClassName(...modifiers: (string | false)[]): string {
  return ['bottom-nav__tab', ...modifiers.filter((modifier) => modifier !== false)].join(' ');
}

export function BottomNav() {
  const { user } = useCurrentUser();
  const { pathname } = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);

  if (!user) {
    return null;
  }

  const active = activeTabFor(pathname);
  const tabs: { id: TabId; label: string; to: string; icon: ReactNode }[] = [
    { id: 'cities', label: 'Cities', to: '/city', icon: CITIES_ICON },
    { id: 'map', label: 'Map', to: '/map', icon: MAP_ICON },
    // "Ranks", not "Leaderboard": the screen's own heading changed with the
    // tab (screens/Leaderboard.tsx). A tab that leads to a page headed
    // something else is a navigation defect, not a shorter label - the route
    // /leaderboard is unchanged, because renaming it would break every
    // existing link for nothing a reader can see.
    { id: 'ranks', label: 'Ranks', to: '/leaderboard', icon: RANKS_ICON },
    // The burger menu addressed the same handle: profiles are public and
    // addressed by handle (Section 8.3), so "my profile" is a URL like any
    // other rather than a route of its own.
    { id: 'profile', label: 'Profile', to: `/profile/player-${user.id}`, icon: PROFILE_ICON },
  ];

  function closeMore() {
    setMoreOpen(false);
    moreButtonRef.current?.focus();
  }

  return (
    <>
      <nav className="bottom-nav" aria-label="Primary">
        {tabs.map((tab) => (
          <Link
            key={tab.id}
            to={tab.to}
            className={tabClassName(
              tab.id === active && 'bottom-nav__tab--active',
              // The owner's specification gives the Map tab the primary
              // visual weight: it is the fog-clearing loop, the reason the
              // rest of the app exists. It gets a larger icon and a heavier
              // label for that, and deliberately not the accent colour -
              // Section 8.1 reserves the accent for the player's own position
              // and for active states, and a tab that is permanently red
              // would leave "which tab am I on?" with no colour of its own.
              tab.id === 'map' && 'bottom-nav__tab--primary',
            )}
            // The active tab is marked three ways and not one: the accent
            // colour, a heavier label, and this - Section 8.1 forbids the
            // accent being the only carrier of meaning, and aria-current is
            // what says it to a screen reader at all.
            aria-current={tab.id === active ? 'page' : undefined}
          >
            <TabIcon>{tab.icon}</TabIcon>
            <span className="bottom-nav__label">{tab.label}</span>
          </Link>
        ))}
        <button
          type="button"
          ref={moreButtonRef}
          className={tabClassName(moreOpen && 'bottom-nav__tab--active')}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen(true)}
        >
          <TabIcon>{MORE_ICON}</TabIcon>
          <span className="bottom-nav__label">More</span>
        </button>
      </nav>
      {/* Rendered beside the bar rather than inside it: the sheet is a
          dialog, and a dialog nested in the navigation landmark would be
          announced as part of it. */}
      {moreOpen && <MoreSheet onClose={closeMore} />}
    </>
  );
}
