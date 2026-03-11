/* ============================================================
   Instructor Station Kiosk - Service Worker
   Caches the PWA shell files for offline resilience.
   Does NOT cache iframe content (live instructor station data).

   Strategy: NETWORK-FIRST with cache fallback.
   Always tries to fetch fresh code from the server. If the
   network is down, falls back to the cached copy. This ensures
   kiosks pick up new deployments on the next page load without
   needing manual cache clears.
   ============================================================ */

var CACHE_NAME = 'ios-kiosk-shell-v1.20';

var SHELL_ASSETS = [
  './',
  './index.html',
  './application.js',
  './application.css',
  './manifest.json',
  './devices.json',
  './icons/icon-128.png',
  './logos/one-G-Logo_Navy-White-navy_text.png',
  './logos/one-G-Logo_Navy-White.png'
];

// Install: pre-cache shell assets for offline fallback
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) {
        return cache.addAll(SHELL_ASSETS);
      })
      .then(function () {
        return self.skipWaiting();
      })
  );
});

// Activate: clean up old caches, take control immediately
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (names) {
        return Promise.all(
          names
            .filter(function (name) { return name !== CACHE_NAME; })
            .map(function (name) { return caches.delete(name); })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

// Fetch: network-first for same-origin, pass-through for cross-origin
self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);

  // Only intercept same-origin requests (shell assets)
  if (url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(function (response) {
        // Got a fresh response — update the cache and return it
        if (response && response.status === 200) {
          var responseClone = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(function () {
        // Network failed — fall back to cache (offline resilience)
        return caches.match(event.request);
      })
  );
});
