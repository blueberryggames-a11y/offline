// ─── Cache version — bump to force update on all clients ──────────────────────
const CACHE_NAME = "ytoffline-v7";
const STATIC_ASSETS = ["./", "./index.html", "./app.js", "./manifest.json"];

// ─── IndexedDB helpers (duplicated in SW — no shared scope with page) ─────────
const DB_NAME    = "ytoffline";
const DB_VERSION = 1;
const STORE      = "videos";

function swOpenDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = ()  => reject(req.error);
  });
}

async function swGetVideo(id) {
  const db = await swOpenDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// ─── Install ──────────────────────────────────────────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// ─── Activate ─────────────────────────────────────────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ─── Fetch ────────────────────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // ── Video proxy: /sw-video/<id>.mp4 ─────────────────────────────────────
  if (url.pathname.startsWith("/sw-video/")) {
    event.respondWith(handleVideoRequest(event.request, url));
    return;
  }

  // ── blob: URLs — never intercept ─────────────────────────────────────────
  if (url.protocol === "blob:") return;

  // ── Backend / ngrok — never intercept ────────────────────────────────────
  if (url.hostname === "localhost" || url.port === "5000" ||
      url.hostname.includes("ngrok")) return;

  // ── Cross-origin (fonts, thumbnails) — never intercept ───────────────────
  if (url.origin !== self.location.origin) return;

  // ── App shell — cache first ───────────────────────────────────────────────
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});

async function handleVideoRequest(request, url) {
  // Extract video ID from path: /sw-video/<id>.mp4 → <id>
  const id = decodeURIComponent(
    url.pathname.replace("/sw-video/", "").replace(/\.mp4$/i, "")
  );

  let video;
  try {
    video = await swGetVideo(id);
  } catch (e) {
    return new Response("Video not found in IDB", { status: 404 });
  }

  if (!video || !video.blob) {
    return new Response("Video not found", { status: 404 });
  }

  // Normalise: video.blob may already be a Blob or raw ArrayBuffer/bytes
  const blob = video.blob instanceof Blob
    ? new Blob([video.blob], { type: "video/mp4" })
    : new Blob([video.blob], { type: "video/mp4" });

  const totalSize = blob.size;

  const rangeHeader = request.headers.get("range");

  if (rangeHeader) {
    // ── Range request (Safari's probe + seek requests) ─────────────────────
    const match = /bytes=(\d+)-(\d*)/i.exec(rangeHeader);
    if (!match) {
      return new Response(null, {
        status: 416,
        statusText: "Range Not Satisfiable",
        headers: { "Content-Range": `*/${totalSize}` },
      });
    }

    const start = parseInt(match[1], 10);
    const end   = match[2] ? parseInt(match[2], 10) : totalSize - 1;
    // Clamp end to actual file size
    const clampedEnd = Math.min(end, totalSize - 1);
    const chunkSize  = clampedEnd - start + 1;

    const chunk = blob.slice(start, clampedEnd + 1, "video/mp4");

    return new Response(chunk, {
      status: 206,
      statusText: "Partial Content",
      headers: {
        "Content-Type":   "video/mp4",
        "Content-Length": String(chunkSize),
        "Content-Range":  `bytes ${start}-${clampedEnd}/${totalSize}`,
        "Accept-Ranges":  "bytes",
      },
    });
  } else {
    // ── Full request ───────────────────────────────────────────────────────
    return new Response(blob, {
      status: 200,
      headers: {
        "Content-Type":   "video/mp4",
        "Content-Length": String(totalSize),
        "Accept-Ranges":  "bytes",
      },
    });
  }
}
