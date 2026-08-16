// SPEC.md Section 12, Phase 8 task brief: a scope can have exactly one
// service worker, so this is the single URL both consumers register
// against - public/sw.js's own comment explains why it now carries both
// the offline shell and Web Push, rather than the two racing separately.
export const SERVICE_WORKER_URL = '/sw.js';

// Called once, unconditionally, from main.tsx on every app start - not
// gated behind a user click the way tracking/usePushSubscription.ts's push
// registration is (that gate exists to avoid an unsolicited permission
// prompt, task Section D of an earlier phase; registering a service worker
// itself shows no prompt of any kind, so the offline shell needs this to
// run as early as possible, well before the user ever opens Settings).
// usePushSubscription.ts's own registration call, later, against the same
// URL, is idempotent - the browser resolves it to this same registration
// rather than creating a second one.
export function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return;
  }
  navigator.serviceWorker.register(SERVICE_WORKER_URL).catch(() => {
    // Best effort - the app still works fully online without it, and
    // usePushSubscription's own register() call gets a second chance
    // whenever the user opts into push.
  });
}
