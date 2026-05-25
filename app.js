// app.js
const SERVER = "https://jogger-trustable-abdomen.ngrok-free.dev";
const DB_NAME = "ytoffline";
const DB_VERSION = 1;
const STORE = "videos";

const NGROK_HEADERS = {
  "Content-Type": "application/json",
  "ngrok-skip-browser-warning": "1",
};

// ── IndexedDB ────────────────────────────────────────────────────────────────
let db;

async function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(STORE)) {
        const store = d.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("savedAt", "savedAt");
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = () => reject(req.error);
  });
}

async function saveVideo(meta, blob) {
  // Store as ArrayBuffer — avoids Safari SW blob-reading bugs
  const arrayBuffer = await blob.arrayBuffer();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put({
    id:        meta.id || Date.now().toString(),
    title:     meta.title,
    duration:  meta.duration,
    thumbnail: meta.thumbnail,
    uploader:  meta.uploader,
    savedAt:   Date.now(),
    blob:      arrayBuffer,   // stored as ArrayBuffer
    size:      blob.size,
  });
  return new Promise((res, rej) => {
    tx.oncomplete = res;
    tx.onerror    = () => rej(tx.error);
  });
}

async function getAllVideos() {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).index("savedAt").getAll();
    req.onsuccess = () => resolve(req.result.reverse());
    req.onerror   = () => reject(req.error);
  });
}

async function getVideo(id) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function deleteVideo(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
}

// ── Utilities ────────────────────────────────────────────────────────────────
function formatDuration(secs) {
  if (!secs) return "??:??";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function formatSize(bytes) {
  if (!bytes) return "";
  if (bytes > 1e9) return (bytes / 1e9).toFixed(1) + " GB";
  if (bytes > 1e6) return (bytes / 1e6).toFixed(1) + " MB";
  return (bytes / 1e3).toFixed(0) + " KB";
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

// ── Server Status ─────────────────────────────────────────────────────────────
let serverOnline = false;

async function checkServer() {
  try {
    const res = await fetch(`${SERVER}/ping`, {
      signal: AbortSignal.timeout(3000),
      headers: { "ngrok-skip-browser-warning": "1" },
    });
    serverOnline = res.ok;
  } catch {
    serverOnline = false;
  }
  updateServerBadge();
}

function updateServerBadge() {
  const badge = document.getElementById("server-badge");
  const dot   = document.getElementById("server-dot");
  if (serverOnline) {
    badge.textContent = "Server Online";
    badge.className   = "badge online";
    dot.className     = "dot online";
  } else {
    badge.textContent = "Server Offline";
    badge.className   = "badge offline";
    dot.className     = "dot offline";
  }
}

// ── UI State ──────────────────────────────────────────────────────────────────
let currentView    = "library";
let currentVideoId = null;

function showView(view) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.getElementById(`view-${view}`).classList.add("active");
  currentView = view;
}

// ── Download Flow ─────────────────────────────────────────────────────────────
async function handleDownload() {
  if (!serverOnline) {
    showToast("Server is offline. Start it on your PC first.", "error");
    return;
  }
  const urlInput = document.getElementById("url-input");
  const url = urlInput.value.trim();
  if (!url) { showToast("Paste a YouTube URL first", "error"); return; }
  if (!url.includes("youtube.com") && !url.includes("youtu.be")) {
    showToast("Please enter a valid YouTube URL", "error");
    return;
  }
  setDownloadState("fetching");
  try {
    const infoRes = await fetch(`${SERVER}/info`, {
      method: "POST", headers: NGROK_HEADERS, body: JSON.stringify({ url }),
    });
    const info = await infoRes.json();
    if (!infoRes.ok) throw new Error(info.error || "Could not fetch video info");
    showPreview(info);
    setDownloadState("preview");
    window._pendingDownload = { url, info };
  } catch (err) {
    showToast(err.message, "error");
    setDownloadState("idle");
  }
}

async function confirmDownload() {
  const { url, info } = window._pendingDownload;
  setDownloadState("downloading");
  try {
    const res = await fetch(`${SERVER}/download`, {
      method: "POST", headers: NGROK_HEADERS, body: JSON.stringify({ url }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Download failed" }));
      throw new Error(err.error || "Download failed");
    }
    const reader = res.body.getReader();
    const contentLength = res.headers.get("Content-Length");
    let received = 0;
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (contentLength) {
        updateProgress(Math.round((received / contentLength) * 100), received, contentLength);
      } else {
        updateProgress(null, received, null);
      }
    }
    const blob = new Blob(chunks, { type: "video/mp4" });
    await saveVideo(info, blob);
    showToast(`"${info.title}" saved!`, "success");
    setDownloadState("idle");
    document.getElementById("url-input").value = "";
    hidePreview();
    await renderLibrary();
  } catch (err) {
    showToast(err.message, "error");
    setDownloadState("idle");
  }
}

function setDownloadState(state) {
  const btn        = document.getElementById("dl-btn");
  const progress   = document.getElementById("progress-wrap");
  const confirmBar = document.getElementById("confirm-bar");
  if (state === "idle") {
    btn.textContent = "Fetch Info"; btn.disabled = false;
    progress.classList.add("hidden"); confirmBar.classList.add("hidden");
  } else if (state === "fetching") {
    btn.textContent = "Fetching…"; btn.disabled = true;
  } else if (state === "preview") {
    btn.textContent = "Fetch Info"; btn.disabled = false;
    confirmBar.classList.remove("hidden");
  } else if (state === "downloading") {
    btn.textContent = "Fetch Info"; btn.disabled = true;
    progress.classList.remove("hidden"); confirmBar.classList.add("hidden");
  }
}

function updateProgress(pct, received, total) {
  const bar   = document.getElementById("progress-bar");
  const label = document.getElementById("progress-label");
  if (pct !== null) {
    bar.style.width   = pct + "%";
    label.textContent = `${pct}% — ${formatSize(received)} / ${formatSize(Number(total))}`;
  } else {
    bar.style.width   = "60%";
    bar.style.animation = "pulse 1s infinite";
    label.textContent = `Downloading… ${formatSize(received)}`;
  }
}

function showPreview(info) {
  document.getElementById("preview-thumb").src = info.thumbnail || "";
  document.getElementById("preview-title").textContent = info.title;
  document.getElementById("preview-meta").textContent =
    `${info.uploader || "Unknown"} · ${formatDuration(info.duration)}`;
  document.getElementById("preview-box").classList.remove("hidden");
}

function hidePreview() {
  document.getElementById("preview-box").classList.add("hidden");
  document.getElementById("confirm-bar").classList.add("hidden");
}

// ── Library ───────────────────────────────────────────────────────────────────
async function renderLibrary() {
  const grid   = document.getElementById("video-grid");
  const empty  = document.getElementById("empty-state");
  const videos = await getAllVideos();
  if (videos.length === 0) {
    grid.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  grid.innerHTML = videos.map((v) => `
    <div class="video-card" onclick="playVideo('${v.id}')">
      <div class="card-thumb">
        ${v.thumbnail
          ? `<img src="${v.thumbnail}" alt="" loading="lazy">`
          : `<div class="thumb-placeholder"></div>`}
        <div class="card-duration">${formatDuration(v.duration)}</div>
        <div class="card-play-icon">▶</div>
      </div>
      <div class="card-info">
        <div class="card-title">${v.title}</div>
        <div class="card-meta">${v.uploader || "Unknown"} · ${formatSize(v.size)}</div>
        <div class="card-date">${formatDate(v.savedAt)}</div>
      </div>
      <button class="card-delete"
        onclick="event.stopPropagation(); deleteVideoUI('${v.id}')"
        title="Delete">✕</button>
    </div>
  `).join("");
}

async function deleteVideoUI(id) {
  if (!confirm("Delete this video from your device?")) return;
  await deleteVideo(id);
  showToast("Video deleted", "success");
  await renderLibrary();
}

// ── Player ────────────────────────────────────────────────────────────────────
async function playVideo(id) {
  const video = await getVideo(id);
  if (!video) return;

  currentVideoId = id;
  document.getElementById("player-title").textContent = video.title;
  document.getElementById("player-meta").textContent =
    `${video.uploader || "Unknown"} · ${formatDuration(video.duration)} · ${formatSize(video.size)}`;

  showView("player");

  // Fresh <video> element — gives Safari a clean AVFoundation context
  const container = document.querySelector(".video-container");
  const oldPlayer = document.getElementById("video-player");
  const player    = document.createElement("video");

  player.id       = "video-player";
  player.controls = true;
  player.setAttribute("playsinline", "");
  player.setAttribute("webkit-playsinline", "");
  player.setAttribute("x-webkit-airplay", "allow");
  player.setAttribute("preload", "auto");

  container.replaceChild(player, oldPlayer);

  // SW proxy URL — the SW intercepts this and serves from IDB with proper
  // range-request responses. This is what makes Safari show duration + seek.
  const src = `./sw-video/${encodeURIComponent(id)}.mp4`;

  // Use <source> child — more reliable than .src on iOS Safari
  const source = document.createElement("source");
  source.type  = "video/mp4";
  source.src   = src;
  player.appendChild(source);

  player.load();

  player.addEventListener("error", (e) => {
    const err = player.error;
    showToast(`Video error ${err ? err.code : "?"}`, "error");
  });
}

function closePlayer() {
  const player = document.getElementById("video-player");
  if (player) {
    player.pause();
    while (player.firstChild) player.removeChild(player.firstChild);
    player.removeAttribute("src");
    player.load();
  }
  showView("library");
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg, type = "info") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = `toast ${type} show`;
  setTimeout(() => t.classList.remove("show"), 3500);
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  db = await openDB();

  if ("serviceWorker" in navigator) {
    try {
      const reg = await navigator.serviceWorker.register("./sw.js");

      // Wait for SW to activate if it's new
      const sw = reg.installing || reg.waiting;
      if (sw) {
        await new Promise((resolve) => {
          sw.addEventListener("statechange", function h() {
            if (sw.state === "activated") { sw.removeEventListener("statechange", h); resolve(); }
          });
        });
      }

      // Wait for SW to claim this page if not yet controlled
      if (!navigator.serviceWorker.controller) {
        await new Promise((resolve) => {
          navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true });
          setTimeout(resolve, 1000); // safety fallback
        });
      }
    } catch (e) {
      console.warn("SW registration failed:", e);
    }
  }

  await checkServer();
  setInterval(checkServer, 10000);
  await renderLibrary();

  document.getElementById("url-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleDownload();
  });
}

init();
