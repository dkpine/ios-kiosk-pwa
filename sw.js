/* ============================================================
   Instructor Station Kiosk - Service Worker
   Caches the PWA shell files for offline resilience.
   Does NOT cache iframe content (live instructor station data).
   ============================================================ */

var CACHE_NAME = 'ios-kiosk-shell-v1.09';

var SHELL_ASSETS = [
  './',
  './index.html',
  './application.js',
  './application.css',
  './manifest.json',
  './devices.json',
  './icons/icon-128.png',
  './logos/one-G-Logo_Navy-White-navy_text.png'
];

// Install: pre-cache shell assets
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

// Fetch: cache-first for shell assets, network pass-through for everything else
self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);

  // Only intercept same-origin requests (shell assets)
  if (url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(event.request)
      .then(function (cached) {
        if (cached) {
          return cached;
        }
        return fetch(event.request).then(function (response) {
          // Don't cache non-ok responses
          if (!response || response.status !== 200) {
            return response;
          }
          // Cache a copy for future use
          var responseClone = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(event.request, responseClone);
          });
          return response;
        });
      })
  );
});
