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
      await logout();
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
