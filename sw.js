// sw.js — v9
// Fix for large videos on mobile Safari:
// Never load the full ArrayBuffer into memory.
// Instead: get the blob's total size, then slice ONLY the requested bytes.
// blob.slice(start, end) is lazy — it doesn't read the data until .arrayBuffer()
// is called on the slice, so only the requested chunk is ever in memory.

const CACHE_NAME = "ytoffline-v10";
const STATIC_ASSETS = ["./", "./index.html", "./app.js", "./manifest.json"];

const DB_NAME    = "ytoffline";
const DB_VERSION = 1;
const STORE      = "videos";

function swOpenDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = () => reject(req.error);
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

// Normalise whatever is stored into a Blob (doesn't read data, just wraps)
function toBlob(stored) {
  if (stored instanceof Blob) return stored;
  if (stored instanceof ArrayBuffer) return new Blob([stored], { type: "video/mp4" });
  // Uint8Array / Buffer / etc.
  return new Blob([stored], { type: "video/mp4" });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (url.pathname.includes("/sw-video/")) {
    event.respondWith(handleVideoRequest(event.request, url));
    return;
  }

  if (url.protocol === "blob:") return;
  if (url.hostname === "localhost" || url.hostname.includes("ngrok")) return;
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});

async function handleVideoRequest(request, url) {
  const id = decodeURIComponent(
    url.pathname.split("/sw-video/")[1].replace(/\.mp4$/i, "")
  );

  let video;
  try {
    video = await swGetVideo(id);
  } catch (e) {
    return new Response("DB error: " + e, { status: 500 });
  }

  if (!video || !video.blob) {
    return new Response("Video not found", { status: 404 });
  }

  // Wrap in a Blob — this is O(0), no data is read yet
  const blob      = toBlob(video.blob);
  const totalSize = blob.size;

  const rangeHeader = request.headers.get("range");

  if (rangeHeader) {
    const match = /^bytes=(\d+)-(\d*)$/i.exec(rangeHeader);
    if (!match) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `*/${totalSize}` },
      });
    }

    const start      = Number(match[1]);
    const end        = match[2] ? Number(match[2]) : totalSize - 1;
    const clampedEnd = Math.min(end, totalSize - 1);

    // KEY: slice the blob first (no memory cost), then read only that slice
    const slicedBlob = blob.slice(start, clampedEnd + 1, "video/mp4");
    const chunkBuffer = await slicedBlob.arrayBuffer();

    return new Response(chunkBuffer, {
      status: 206,
      statusText: "Partial Content",
      headers: {
        "Content-Type":   "video/mp4",
        "Content-Length": String(chunkBuffer.byteLength),
        "Content-Range":  `bytes ${start}-${clampedEnd}/${totalSize}`,
        "Accept-Ranges":  "bytes",
      },
    });
  }

  // Full request — stream the blob directly, no ArrayBuffer conversion
  return new Response(blob, {
    status: 200,
    headers: {
      "Content-Type":   "video/mp4",
      "Content-Length": String(totalSize),
      "Accept-Ranges":  "bytes",
    },
  });
}
