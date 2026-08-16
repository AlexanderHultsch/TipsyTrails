import { logout } from '../api/client.js';
import { clearFogState } from '../map/fog/fog-cache.js';
import { useCurrentUser } from './CurrentUserContext.js';

// Shared by the burger menu and the Settings screen's own log-out action.
// Only used from RequireAuth-guarded screens, so clearing the user is
// enough - the guard itself redirects to /login once it re-renders signed
// out.
export function useLogout(): () => Promise<void> {
  const { user, setUser } = useCurrentUser();

  return async function handleLogout() {
    try {
      // Phase 8 task brief, part B: whether this succeeds or fails (e.g. a
      // network error), the `finally` block below still clears the local
      // user and lets the route guards redirect to /login - a caught
      // failure here would have nothing further to tell the player, who
      // ends up signed out locally either way.
      await logout().catch(() => {});
    } finally {
      // Phase 8 task brief, part B (reviewer finding): keying the fog
      // cache per user (map/fog/fog-cache.ts) stops a different account
      // from ever reading it, but leaves it sitting on the device after
      // this account is done with it. Cleared here, unconditionally on
      // sign-out, regardless of whether the server-side logout above
      // succeeded - it is a local artefact, not something the server call
      // could fail to remove.
      if (user) {
        clearFogState(user.id);
      }
      setUser(null);
    }
  };
}
