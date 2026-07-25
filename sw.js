/* =====================================================================
 * Logistics Flow Studio - WarehouseTwin
 * sw.js - service worker: precache the app shell so it works offline.
 * ---------------------------------------------------------------------
 * Cache-first for the precached shell (fully offline, no network needed
 * at runtime). Bump CACHE_VERSION when shipping new asset content so
 * clients pick up the update.
 * ===================================================================== */
const CACHE_VERSION = "wt-v7";
const CACHE_NAME = "warehousetwin-" + CACHE_VERSION;

// The complete offline app shell. All local, no external hosts.
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./domain.js",
  "./tiers.js",
  "./simulation.js",
  "./optimizer.js",
  "./advisor.js",
  "./app.js",
  // P5: LSP Planner sub-app (network-level planning game)
  "./lsp/index.html",
  "./lsp/lsp-styles.css",
  "./lsp/lsp-engine.js",
  "./lsp/lsp.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-512.png",
  "./icons/favicon-32.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Only serve our own origin from cache; never reach out to the network
  // for third-party hosts (there are none, but stay defensive & offline).
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          // Runtime-cache same-origin GETs (e.g. future assets).
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => {
          // Offline fallback: serve the shell for navigations.
          if (req.mode === "navigate") return caches.match("./index.html");
          return new Response("", { status: 504, statusText: "Offline" });
        });
    })
  );
});
