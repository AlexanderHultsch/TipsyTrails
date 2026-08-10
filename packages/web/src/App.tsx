import { lazy, Suspense } from 'react';
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
import { CityOverview } from './screens/CityOverview.js';
import { DistrictOverview } from './screens/DistrictOverview.js';
import { Landing } from './screens/Landing.js';
import { Login } from './screens/Login.js';
import { Register } from './screens/Register.js';
import { Reset } from './screens/Reset.js';
import { Settings } from './screens/Settings.js';

// MapLibre + PMTiles are ~250 KB gzipped on their own (Section 12, Phase 2
// budget) and must never enter the shell chunk. A lazily imported route
// component is what makes Vite emit them as a separate chunk, loaded only
// when a map route is actually visited.
const MapScreen = lazy(() =>
  import('./screens/Map.js').then((module) => ({ default: module.MapScreen })),
);

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
        <Route
          path="/settings"
          element={
            <RequireAuth>
              <Settings />
            </RequireAuth>
          }
        />
        <Route
          path="/city"
          element={
            <RequireAuth>
              <CityOverview />
            </RequireAuth>
          }
        />
        <Route
          path="/districts"
          element={
            <RequireAuth>
              <DistrictOverview />
            </RequireAuth>
          }
        />
        <Route
          path="/map"
          element={
            <RequireAuth>
              <Suspense fallback={null}>
                <MapScreen />
              </Suspense>
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </CurrentUserProvider>
  );
}
