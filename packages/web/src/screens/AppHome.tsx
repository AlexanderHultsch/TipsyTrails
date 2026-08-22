import { useCurrentUser } from '../auth/CurrentUserContext.js';
import { Avatar } from '../components/Avatar.js';
import { BottomNav } from '../components/BottomNav.js';

// Authenticated placeholder. The map and the rest of the real screens
// (districts, leaderboard, profile, ...) arrive in their own phases.
export function AppHome() {
  const { user } = useCurrentUser();

  return (
    <main className="screen">
      <BottomNav />
      <div className="screen__content screen__content--middle">
        {user && <Avatar seed={user.avatarSeed} />}
        <h1>Tipsy Trails</h1>
        <p>Signed in as {user?.username}</p>
      </div>
    </main>
  );
}
