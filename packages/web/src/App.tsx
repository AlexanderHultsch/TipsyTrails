import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { CurrentUserProvider } from './auth/CurrentUserContext.js';
import {
  GuestOnly,
  RedirectIfMustChangePassword,
  RequireAdmin,
  RequireAuth,
  RequireAuthOnly,
} from './auth/route-guards.js';
import { AppHome } from './screens/AppHome.js';
import { BarDetail } from './screens/BarDetail.js';
import { ChangePassword } from './screens/ChangePassword.js';
import { CityOverview } from './screens/CityOverview.js';
import { DistrictOverview } from './screens/DistrictOverview.js';
import { HowMasteringWorks } from './screens/HowMasteringWorks.js';
import { Landing } from './screens/Landing.js';
import { Leaderboard } from './screens/Leaderboard.js';
import { Login } from './screens/Login.js';
import { Privacy } from './screens/Privacy.js';
import { Profile } from './screens/Profile.js';
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

// SuggestBar's map picker (map/MapPicker.tsx) pulls in the same MapLibre
// dependency as MapScreen above, for the same reason: it must not enter the
// shell chunk either.
const SuggestBar = lazy(() =>
  import('./screens/SuggestBar.js').then((module) => ({ default: module.SuggestBar })),
);

// Phase 7 task brief: the admin area is not on the critical path for a
// normal player, so it is code-split the same way the map routes are, kept
// out of the shell chunk even though it does not itself depend on MapLibre.
const Admin = lazy(() =>
  import('./screens/Admin.js').then((module) => ({ default: module.Admin })),
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
          path="/privacy"
          element={
            <RedirectIfMustChangePassword>
              <Privacy />
            </RedirectIfMustChangePassword>
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
        <Route
          path="/bars/:id"
          element={
            <RequireAuth>
              <BarDetail />
            </RequireAuth>
          }
        />
        <Route
          path="/suggest"
          element={
            <RequireAuth>
              <Suspense fallback={null}>
                <SuggestBar />
              </Suspense>
            </RequireAuth>
          }
        />
        <Route
          path="/admin"
          element={
            <RequireAdmin>
              <Suspense fallback={null}>
                <Admin />
              </Suspense>
            </RequireAdmin>
          }
        />
        <Route
          path="/how-it-works"
          element={
            <RequireAuth>
              <HowMasteringWorks />
            </RequireAuth>
          }
        />
        <Route
          path="/leaderboard"
          element={
            <RequireAuth>
              <Leaderboard />
            </RequireAuth>
          }
        />
        <Route
          path="/profile/:handle"
          element={
            <RequireAuth>
              <Profile />
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </CurrentUserProvider>
  );
}
