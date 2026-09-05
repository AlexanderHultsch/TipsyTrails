import { logout } from '../api/client.js';
import { clearFogState } from '../map/fog/fog-cache.js';
import { postShellSignedOut } from '../shell/messages.js';
import { clearLastKnownPosition } from '../tracking/lastKnownPosition.js';
import { useCurrentUser } from './CurrentUserContext.js';

// Shared by the burger menu and the Settings screen's own log-out action.
// Only used from RequireAuth-guarded screens, so clearing the user is
// enough - the guard itself redirects to /login once it re-renders signed
// out.
export function useLogout(): () => Promise<void> {
  const { user, setUser } = useCurrentUser();

  return async function handleLogout() {
    // ios/SPEC.md 8.2, and the order is the contract: `signedOut` goes
    // **before** the web app's own logout request, because the shell answers it
    // by telling the tracker `sessionLost('cookie')` "so no sample is posted
    // against a cookie about to be deleted". Posted after the request, a flush
    // already in flight - the tracker posts from a pocket every few seconds -
    // could carry a cookie the server has just invalidated, which is a 401 the
    // tracker reads as a session lost from elsewhere (5.2) and tells the player
    // about with a notification. The cookie-store observer of 5.2 is the safety
    // net for a missed message, and a safety net is not a schedule.
    //
    // It is outside the `try` for the same reason it is first: nothing about
    // this message depends on the request that follows it, and a message the
    // shell has already read cannot be un-posted by a failure afterwards.
    // Outside the shell it posts nothing (shell/messages.ts).
    postShellSignedOut();
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
      // The in-memory last known position (tracking/lastKnownPosition.ts)
      // goes with it: unkeyed, so unlike the fog cache it is cleared
      // whether or not a user was resolved here.
      clearLastKnownPosition();
      setUser(null);
    }
  };
}
