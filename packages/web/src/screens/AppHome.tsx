import { useCurrentUser } from '../auth/CurrentUserContext.js';

// Authenticated placeholder. The burger menu and real screens (map,
// districts, leaderboard, profile, ...) arrive in the next step.
export function AppHome() {
  const { user } = useCurrentUser();

  return (
    <main className="screen">
      <div className="screen__content screen__content--middle">
        <h1>Tipsy Trails</h1>
        <p>Signed in as {user?.username}</p>
      </div>
    </main>
  );
}
