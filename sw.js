// CACHE VERSION — bump this to force cache refresh on all clients
const CACHE_NAME = "ytoffline-v3";
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.json",
];

// Install: cache static assets and immediately take over
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  // Force this SW to activate immediately — don't wait for old SW to die
  self.skipWaiting();
});

// Activate: delete ALL old caches so stale assets don't persist
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => {
          console.log("[SW] Deleting old cache:", k);
          return caches.delete(k);
        })
      )
    ).then(() => self.clients.claim()) // take control of all open tabs
  );
});

// Fetch: carefully decide what to intercept
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // FIX 1: Never intercept blob: URLs — Safari cannot play video from a SW-wrapped blob
  if (url.protocol === "blob:") return;

  // FIX 2: Never intercept video/media range requests.
  // Safari sends "Range: bytes=0-1" as a probe before playing any video.
  // If the SW intercepts it without returning a proper 206 Partial Content,
  // Safari shows the broken video icon. Easiest fix: let these pass through.
  const rangeHeader = event.request.headers.get("range");
  if (rangeHeader) return;

  // Don't intercept backend API calls (localhost or ngrok server)
  if (
    url.hostname === "localhost" ||
    url.port === "5000" ||
    url.hostname.includes("ngrok")
  ) return;

  // Don't intercept cross-origin requests (fonts, thumbnails, etc.)
  if (url.origin !== self.location.origin) return;

  // For everything else (app shell assets): cache-first strategy
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
