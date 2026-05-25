// sw.js — v7
// Key fix: use ArrayBuffer (not Blob) for range slicing.
// Safari's SW context has trouble with Blob objects retrieved from IDB.
// ArrayBuffer.slice() is reliable and matches the proven Phil Nash approach.

const CACHE_NAME = "ytoffline-v9";
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

  if (!video) {
    return new Response("Video not found", { status: 404 });
  }

  // Convert whatever is stored to ArrayBuffer.
  // The page stores a Blob; we need ArrayBuffer for reliable slicing in SW.
  let arrayBuffer;
  try {
    if (video.blob instanceof Blob) {
      arrayBuffer = await video.blob.arrayBuffer();
    } else if (video.blob instanceof ArrayBuffer) {
      arrayBuffer = video.blob;
    } else {
      // Fallback: try treating it as a blob-like object
      arrayBuffer = await new Blob([video.blob]).arrayBuffer();
    }
  } catch (e) {
    return new Response("Failed to read video data: " + e, { status: 500 });
  }

  const totalSize = arrayBuffer.byteLength;
  const rangeHeader = request.headers.get("range");

  if (rangeHeader) {
    // Parse bytes=start-end  (end is optional)
    const match = /^bytes=(\d+)-(\d*)$/i.exec(rangeHeader);
    if (!match) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `*/${totalSize}` },
      });
    }

    const start = Number(match[1]);
    const end   = match[2] ? Number(match[2]) : totalSize - 1;
    const clampedEnd = Math.min(end, totalSize - 1);
    const chunk  = arrayBuffer.slice(start, clampedEnd + 1);

    return new Response(chunk, {
      status: 206,
      statusText: "Partial Content",
      headers: {
        "Content-Type":   "video/mp4",
        "Content-Length": String(chunk.byteLength),
        "Content-Range":  `bytes ${start}-${clampedEnd}/${totalSize}`,
        "Accept-Ranges":  "bytes",
      },
    });
  }

  // Full request
  return new Response(arrayBuffer, {
    status: 200,
    headers: {
      "Content-Type":   "video/mp4",
      "Content-Length": String(totalSize),
      "Accept-Ranges":  "bytes",
    },
  });
}
