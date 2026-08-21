// The last position tracking/useSampleTracking.ts accepted, held so a
// screen that must not start a GPS watch of its own can still open where
// the player is. map/MapPicker.tsx (screens/SuggestBar.tsx) is the one
// reader: mounting useSampleTracking there would open a second
// watchPosition and post samples from a screen that is not the map, which
// is why this holder exists rather than that hook being reused.
//
// IN MEMORY ONLY - module-level state, and it must stay that way. Constraint
// C4 / Section 10.2: raw positions are processed in memory and discarded,
// never persisted. localStorage, sessionStorage, IndexedDB or any other
// storage here would leave a coordinate on the device, which is exactly what
// that constraint forbids; this is not negotiable for convenience, however
// convenient surviving a reload would be. Cleared on sign-out
// (auth/useLogout.ts), alongside the fog cache.
import type { LastAcceptedPosition } from './useSampleTracking.js';

let lastKnownPosition: LastAcceptedPosition | null = null;

export function getLastKnownPosition(): LastAcceptedPosition | null {
  return lastKnownPosition;
}

export function setLastKnownPosition(position: LastAcceptedPosition): void {
  lastKnownPosition = position;
}

export function clearLastKnownPosition(): void {
  lastKnownPosition = null;
}
