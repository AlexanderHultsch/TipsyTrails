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

// Signed-in, not forced through a password change, and is_admin. Used for
// /admin. Section 12 Phase 7 DoD: "the admin section is visible in the
// burger menu only for admins" - this is that same gate applied to the
// route itself, and it is cosmetic only. The real boundary is
// requireAdmin (packages/api/src/auth/cookie.ts), which every
// /api/admin/* route sits behind and which answers 403 regardless of what
// this guard does.
export function RequireAdmin({ children }: { children: ReactElement }): ReactElement | null {
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
  if (!user.isAdmin) {
    return <Navigate to="/map" replace />;
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
