// The iPhone shell's bridge, page side (`ios/SPEC.md` 8.1 and 8.2).
//
// The shell injects a `WKUserScript` at document start, main frame only, that
// defines `window.__tipsyTrails`. **The web app detects the shell by the
// presence of that object and by nothing else** - not the user agent, which
// carries a `TipsyTrailsShell/<version>` suffix for the server's log lines and
// is explicitly not a contract (8.1).
//
// This directory is the only place in `packages/web` that may touch
// `window.__tipsyTrails`; every other module asks these functions. That rule
// is what keeps the shell's surface countable when it grows, and it is 8.1's,
// not a local preference.

// What the shell injects. `platform`, `shellVersion` and `trackerVersion` are
// the shell's own (8.1) and are read by nothing here yet; they are typed as the
// shell guarantees them rather than validated, because nothing in this module
// branches on a value. A reader who starts branching on one should validate it
// first - this object arrives from outside the bundle, and the type is a
// declaration of the contract, not proof it was honoured.
//
// `requestSettingsUpdate` is the odd member: the shell *calls* it, and the page
// *attaches* it. 8.2 has the shell guard the call "exactly as `dispatch` is so
// that a page which has not yet implemented it is a no-op rather than a thrown
// exception", which only means anything if the property can be absent - so it
// is optional here, and `useShellSettingsUpdate` is what fills it in.
//
// Deliberately not declared yet: `dispatch` and `addListener`, the Shell -> page
// event path of 8.2. Their signatures need the `TrackerEvent` union of
// `ios/SPEC.md` 7.5, and the `isReplay` rule that goes with them has consumers
// (`useSampleTracking`'s shell driver, 8.3) that do not exist on `main` yet.
// Declaring them here without those consumers would be untested surface, so the
// interface is extended when they arrive rather than guessed at now.
export interface ShellBridge {
  readonly platform: 'ios';
  readonly shellVersion: string;
  readonly trackerVersion: string;
  requestSettingsUpdate?: (backgroundTracking: boolean) => void;
}

declare global {
  interface Window {
    __tipsyTrails?: ShellBridge;
  }
}

// The one read of the injected global. `null` means "running in a browser",
// which is every case outside the app.
//
// The check is presence and nothing more, per 8.1. A stricter test - say
// `platform === 'ios'` - would be detection by something else, and it would
// make a future shell that names a second platform invisible to the web app
// rather than merely unusual.
export function getShellBridge(): ShellBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  return window.__tipsyTrails ?? null;
}

// The predicate the rest of the web app asks. It exists beside
// `getShellBridge` so that a screen wanting only "am I in the app" does not
// take a reference to the bridge object it has no business holding.
export function isShell(): boolean {
  return getShellBridge() !== null;
}
