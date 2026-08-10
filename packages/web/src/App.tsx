import { Navigate, Route, Routes } from 'react-router-dom';
import { CurrentUserProvider } from './auth/CurrentUserContext.js';
import {
  GuestOnly,
  RedirectIfMustChangePassword,
  RequireAuth,
  RequireAuthOnly,
} from './auth/route-guards.js';
import { AppHome } from './screens/AppHome.js';
import { ChangePassword } from './screens/ChangePassword.js';
import { Landing } from './screens/Landing.js';
import { Login } from './screens/Login.js';
import { Register } from './screens/Register.js';
import { Reset } from './screens/Reset.js';

export function App() {
  return (
    <CurrentUserProvider>
      <Routes>
        <Route
          path="/"
          element={
            <RedirectIfMustChangePassword>
              <Landing />
            </RedirectIfMustChangePassword>
          }
        />
        <Route
          path="/register"
          element={
            <GuestOnly>
              <Register />
            </GuestOnly>
          }
        />
        <Route
          path="/login"
          element={
            <GuestOnly>
              <Login />
            </GuestOnly>
          }
        />
        <Route
          path="/reset"
          element={
            <RedirectIfMustChangePassword>
              <Reset />
            </RedirectIfMustChangePassword>
          }
        />
        <Route
          path="/change-password"
          element={
            <RequireAuthOnly>
              <ChangePassword />
            </RequireAuthOnly>
          }
        />
        <Route
          path="/app"
          element={
            <RequireAuth>
              <AppHome />
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </CurrentUserProvider>
  );
}
