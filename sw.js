// CACHE VERSION — bump this forces all clients to get fresh SW + clear old caches
const CACHE_NAME = "ytoffline-v4";
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.json",
];

// Install: cache static assets and skip waiting immediately
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: nuke ALL old caches, then claim all open tabs
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

// ---------------------------------------------------------------------------
// Fetch handler
//
// The critical Safari/iOS problem:
//   Safari sends a Range: bytes=0-1 probe BEFORE playing any video.
//   It needs a proper 206 Partial Content response — even for blob: URLs.
//   If the SW intercepts that request and doesn't return 206, Safari shows
//   the broken icon or (with blob URLs) plays audio but shows 0:00 / can't seek.
//
// Our approach:
//   1. App shell requests  → cache-first as normal
//   2. Cross-origin        → pass through, don't touch
//   3. ngrok / localhost   → pass through (backend API calls)
//   4. blob: URLs          → NEVER intercept; let the browser handle natively
//   5. Any request with a Range header → pass straight through; we never
//      cache video data so there's nothing to serve — just let it go to network
// ---------------------------------------------------------------------------
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Rule 4: blob: URLs must NEVER be intercepted by the SW.
  // Safari makes internal range requests against blob: URLs even though they're
  // in-memory — intercepting them breaks duration / seeking.
  if (url.protocol === "blob:") return;

  // Rule 5: Range requests must pass through untouched.
  // Safari uses Range: bytes=0-1 as a probe to verify the server supports
  // partial content before it will show a seek bar or duration.
  // We have no business intercepting these for video content.
  if (event.request.headers.has("range")) return;

  // Rule 3: Backend / tunnel — never cache, always network
  if (
    url.hostname === "localhost" ||
    url.port === "5000" ||
    url.hostname.includes("ngrok")
  ) return;

  // Rule 2: Cross-origin requests (fonts, thumbnails from YouTube CDN, etc.)
  if (url.origin !== self.location.origin) return;

  // Rule 1: App shell — cache first, fallback to network
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
