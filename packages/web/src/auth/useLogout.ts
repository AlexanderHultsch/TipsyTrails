import { logout } from '../api/client.js';
import { useCurrentUser } from './CurrentUserContext.js';

// Shared by the burger menu and the Settings screen's own log-out action.
// Only used from RequireAuth-guarded screens, so clearing the user is
// enough - the guard itself redirects to /login once it re-renders signed
// out.
export function useLogout(): () => Promise<void> {
  const { setUser } = useCurrentUser();

  return async function handleLogout() {
    try {
      await logout();
    } finally {
      setUser(null);
    }
  };
}
