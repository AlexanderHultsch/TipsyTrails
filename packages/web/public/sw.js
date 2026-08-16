// Tipsy Trails - single service worker for the offline app shell (SPEC.md
// Section 12, Phase 8 task brief, part B) and Web Push (Sections 5.9, 7.5,
// 9.2, Phase 5 step 5). A scope can have exactly one service worker - this
// used to be two hand-written files (push-sw.js plus nothing for the
// shell), which would have raced two competing registrations for the same
// scope with whichever ran last silently winning. Merging them into one
// file is the fix, not a second file. Registered from src/sw/register.ts
// (offline shell, eagerly on app start) and again, idempotently, from
// src/tracking/usePushSubscription.ts's enable() (same URL, so the browser
// reuses the existing registration rather than creating a second one).
//
// Not built by Vite - hand-written and plain, like the push-only file it
// replaces (vite-plugin-pwa/Workbox are explicitly out for this phase, task
// brief; the gap is recorded in HANDOVER.md).

const SHELL_CACHE = 'tipsy-trails-shell-v1';

// Not content-hashed, so their URLs are stable and knowable up front -
// unlike /assets/*, whose filenames only exist once Vite has built them.
const SHELL_URLS = [
  '/',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .catch(() => {
        // Best effort - a failed precache (e.g. the very first install
        // happening offline, which cannot happen for a same-origin file but
        // is defended anyway) just means the runtime caching in the fetch
        // handler below is what populates the shell cache instead.
      }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches
        .keys()
        .then((keys) =>
          Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key))),
        ),
    ]),
  );
});

// SPEC.md Section 4.1: hashed /assets/* are immutable (safe to serve
// straight from cache, no revalidation needed - that is what "immutable"
// means), index.html and manifest.json must revalidate (max-age=0). Task
// brief: "your caching strategy must not defeat that, or a deploy will
// serve a stale shell forever" - so the shell/manifest path always tries
// the network first and only falls back to the cached copy when the
// network is unreachable, never the reverse. /api/* is `private, no-store`
// (Section 4.1) - a cached response there is a privacy leak on a shared
// device (task brief), so it is never touched: the guard below returns
// before either caching strategy runs. /tiles/* and /static/* are left
// alone entirely - the offline shell requirement (task brief, part B) is
// the cached shell, the last fog state, and the offline indicator, not an
// offline map, so caching a multi-megabyte, range-fetched tile file here
// would spend storage the task never asked for.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) {
    return;
  }

  if (
    request.mode === 'navigate' ||
    url.pathname === '/index.html' ||
    url.pathname === '/manifest.json'
  ) {
    event.respondWith(networkFirst(request));
    return;
  }

  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(cacheFirst(request));
  }
});

// The whole SPA is one shell - every navigation, regardless of path, is
// cached and restored under the fixed key '/' rather than the requested
// URL, the same fallback packages/api/src/app.ts's own catch-all route
// serves index.html for any non-API GET it does not otherwise recognise.
function shellKey(request) {
  return request.mode === 'navigate' ? '/' : request;
}

async function networkFirst(request) {
  const key = shellKey(request);
  try {
    const response = await fetch(request);
    const cache = await caches.open(SHELL_CACHE);
    cache.put(key, response.clone());
    return response;
  } catch (err) {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(key);
    if (cached) {
      return cached;
    }
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) {
    return cached;
  }
  const response = await fetch(request);
  cache.put(request, response.clone());
  return response;
}

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
