// Tipsy Trails - Web Push service worker (SPEC.md Sections 5.9, 7.5, 9.2,
// Phase 5 step 5). Registered from tracking/usePushSubscription.ts, only
// ever from a user-initiated "enable notifications" click - never
// automatically on page load (task Section D).
//
// Its only job is showing the 21-minute check-in reminder the maintenance
// tick (packages/api/src/maintenance.ts) sends. It does not cache app
// assets and is not an offline app shell - vite-plugin-pwa is not wired up
// yet (SPEC.md Section 3 names it for that, separately, when that work
// happens), so this file is hand-written and plain, not built by Vite.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let title = 'Tipsy Trails';
  let body = 'Your visit is close to complete.';

  if (event.data) {
    try {
      const data = event.data.json();
      title = data.title ?? title;
      body = data.body ?? body;
    } catch {
      body = event.data.text();
    }
  }

  event.waitUntil(self.registration.showNotification(title, { body }));
});

// Focuses an already-open tab if there is one, otherwise opens the map -
// either way gets the player back into the app, which is the entire point
// of the reminder (SPEC.md Section 7.5).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow ? self.clients.openWindow('/map') : undefined;
    }),
  );
});
