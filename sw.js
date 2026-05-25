const CACHE_NAME = "ytoffline-v1";
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.json",
];

// Install: cache static assets
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: only cache same-origin requests — never intercept API/ngrok calls
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Let ALL cross-origin requests (ngrok, youtube, etc.) pass through untouched
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
