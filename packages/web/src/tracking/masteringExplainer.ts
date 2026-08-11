// Section 7.5: "A short 'How mastering works' explainer is reachable from
// the burger menu and shown once after the first check-in. 'Shown once' is
// client-side state in localStorage; no server column for it." This is the
// one seam that reads/writes that flag - screens/Map.tsx checks it after a
// successful check-in, screens/HowMasteringWorks.tsx does not need it at
// all (it is reachable from the burger menu unconditionally).
const EXPLAINER_STORAGE_KEY = 'tipsytrails:mastering-explainer-shown';

export function hasSeenMasteringExplainer(): boolean {
  try {
    return window.localStorage.getItem(EXPLAINER_STORAGE_KEY) === '1';
  } catch {
    // Storage disabled (private browsing, etc.) - treat every check-in as
    // the first, the same fail-open posture as every other best-effort
    // read in this codebase.
    return false;
  }
}

export function markMasteringExplainerSeen(): void {
  try {
    window.localStorage.setItem(EXPLAINER_STORAGE_KEY, '1');
  } catch {
    // Nothing to persist to - the explainer simply shows again next time,
    // which is harmless.
  }
}
