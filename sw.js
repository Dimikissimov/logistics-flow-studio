/* =====================================================================
 * Logistics Flow Studio - WarehouseTwin
 * sw.js - service worker: precache the app shell so it works offline.
 * ---------------------------------------------------------------------
 * Cache-first for the precached shell (fully offline, no network needed
 * at runtime). Bump CACHE_VERSION when shipping new asset content so
 * clients pick up the update.
 * ===================================================================== */
const CACHE_VERSION = "wt-v34"; // v1.5: Production hardening - global error boundary (errors.js), in-browser E2E self-test (selftest.js, ?selftest=1), and a strict offline Content-Security-Policy meta in index.html. errors.js loads first (before all app scripts) and records uncaught errors/rejections into window.__WT_ERRORS__ + surfaces a non-blocking honest banner; selftest.js is INERT without the flag and, when enabled, drives the LIVE app through the same handlers the UI uses (exposed as window.__WT_TEST_API__ in self-test mode) writing a machine-readable `WT-SELFTEST: PASS n/n` into #wt-selftest. New verify_hardening.js harness (28th). Previously wt-v33: Distinct 2D + 3D object representations (shapes.js -> WT.shapes, the SINGLE per-type shape registry: has/draw2D/draw3D/ICONS/meta). Every warehouse object type now has a distinct, recognizable top-down GLYPH (shelf-bay grids, depth/flow chevrons, cantilever arms, AS/RS crane-aisle hatch, shuttle channels, mezzanine platform, dock notches, conveyor rollers, station benches, RGV/AGV vehicles, block-stack pattern) AND a distinct ISOMETRIC form (open see-through rack frames, tall crane tower, raised deck on legs, low belt bed, bench furniture, floor vehicles, stacked cubes) - reused by BOTH renderers (app.js draw2D + iso.js draw3D route through WT.shapes, fallback-safe to the old rect/box). LOD path keeps large layouts fast + legible at any zoom; iso forms reuse the domain heightM (single source of truth with the IFC export). Illustrative schematic, NOT CAD/BIM. New verify_shapes.js harness (shapes/app/iso/index/sw changed)
const CACHE_NAME = "warehousetwin-" + CACHE_VERSION;

// The complete offline app shell. All local, no external hosts.
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./errors.js",
  "./view.js",
  "./domain.js",
  "./knowledge.js",
  "./tiers.js",
  "./simulation.js",
  "./optimizer.js",
  "./advisor.js",
  "./compliance.js",
  "./generate.js",
  "./nlcommands.js",
  "./examples.js",
  "./share.js",
  "./ifc.js",
  "./data.js",
  "./wms.js",
  "./automation.js",
  "./flowsim.js",
  "./kpicharts.js",
  "./wmsdata.js",
  "./iso.js",
  "./shapes.js",
  "./storage.js",
  "./report.js",
  "./demo.js",
  "./cards.js",
  "./scenarios.js",
  "./compare.js",
  "./orderpool.js",
  "./app.js",
  "./selftest.js",
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
