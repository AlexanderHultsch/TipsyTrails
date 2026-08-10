import type { ReactElement } from 'react';
import { Navigate } from 'react-router-dom';
import { useCurrentUser } from './CurrentUserContext.js';

// Signed-in and not forced through a password change. Used for the
// authenticated placeholder at /app.
export function RequireAuth({ children }: { children: ReactElement }): ReactElement | null {
  const { user, loading } = useCurrentUser();
  if (loading) {
    return null;
  }
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  if (user.mustChangePassword) {
    return <Navigate to="/change-password" replace />;
  }
  return children;
}

// Signed-in, regardless of the must-change-password flag. Used for
// /change-password itself, which has to stay reachable while that flag is
// set.
export function RequireAuthOnly({ children }: { children: ReactElement }): ReactElement | null {
  const { user, loading } = useCurrentUser();
  if (loading) {
    return null;
  }
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  return children;
}

// Signed-out only. Used for /login and /register.
export function GuestOnly({ children }: { children: ReactElement }): ReactElement | null {
  const { user, loading } = useCurrentUser();
  if (loading) {
    return null;
  }
  if (user) {
    return <Navigate to={user.mustChangePassword ? '/change-password' : '/app'} replace />;
  }
  return children;
}

// Applied to every route other than /change-password: a signed-in user with
// the flag set must land on the change-password screen no matter what they
// navigated to.
export function RedirectIfMustChangePassword({
  children,
}: {
  children: ReactElement;
}): ReactElement | null {
  const { user, loading } = useCurrentUser();
  if (loading) {
    return null;
  }
  if (user?.mustChangePassword) {
    return <Navigate to="/change-password" replace />;
  }
  return children;
}
