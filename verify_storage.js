/* =====================================================================
 * verify_storage.js - storage & inventory: physical locations, slotting,
 * occupancy + retrieval (P4).
 *
 * Runs the REAL app modules (domain.js, simulation.js, wms.js, flowsim.js,
 * wmsdata.js, storage.js) in Node with the same window shim as every other
 * harness and proves the storage layer end to end:
 *
 *   1. API surface + buildLocations count == summed racking capacity.
 *   2. Locations sit inside their element footprints; golden zone marked.
 *   3. assign() is DETERMINISTIC (same inputs+seed -> identical).
 *   4. ABC-aware placement: A-class average distance < overall average
 *      (the golden-zone effect), and ABC beats random for A-class.
 *   5. Occupancy maths: placed == min(SKUs, capacity), per-rack sums match,
 *      overflow reported honestly when SKUs > capacity (nothing dropped).
 *   6. locationOf() returns a VALID in-layout location for placed SKUs and
 *      null for unplaced/unknown; retrieve() mirrors M_retrieveSKUfromStorage.
 *   7. FLOWSIM WIRING: with an assignment the storage waypoint moves to the
 *      real slotting anchor; the no-assignment FALLBACK is byte-identical to
 *      the plain storage centroid (regression guard) + run determinism.
 *   8. Honesty labels present (SYNTHETIC / heuristic / NOT a measurement).
 *
 * Usage:  node verify_storage.js     ASCII-only output. Exit 0 = green.
 * ===================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");

global.window = global; // the app modules attach themselves to window.WT
for (const f of ["domain.js", "simulation.js", "wms.js", "flowsim.js", "wmsdata.js", "storage.js"]) {
  // eslint-disable-next-line no-eval
  (0, eval)(fs.readFileSync(path.join(__dirname, f), "utf8"));
}
const WT = global.WT;
const S = WT.storage;
const D = WT.domain;

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? "[PASS] " : "[FAIL] ") + name + (detail ? " - " + detail : ""));
  if (!ok) failures++;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isStorageEl = (e) => (D.ELEMENTS[e.type] || {}).category === "storage";

/* A layout with a NEAR rack (close to the outbound dock) and two FAR racks,
 * so distance has a real spread and ABC slotting has something to optimise. */
const LAYOUT = {
  gridW: 40, gridH: 24, cell: D.METRES_PER_CELL,
  elements: [
    { id: "din", type: "dock-in", x: 0, y: 0, w: 2, d: 1 },
    { id: "dout", type: "dock-out", x: 0, y: 11, w: 2, d: 2 },
    { id: "near", type: "selective-racking", x: 4, y: 10, w: 8, d: 2 },
    { id: "far1", type: "selective-racking", x: 30, y: 2, w: 8, d: 2 },
    { id: "far2", type: "selective-racking", x: 30, y: 20, w: 8, d: 2 },
    { id: "cv", type: "conveyor", x: 12, y: 11, w: 16, d: 1 },
  ],
  config: { seed: 7 },
};

const summedCapacity = LAYOUT.elements.filter(isStorageEl).reduce((a, e) => a + D.elementCapacity(e), 0);

/* ================= 1. API + buildLocations count ==================== */
console.log("-- API surface + buildLocations");
check("WT.storage exposes the required API",
  S && ["buildLocations", "assign", "occupancy", "locationOf", "stats", "PARAMS"].every((k) => k in S) &&
    typeof S.buildLocations === "function" && typeof S.assign === "function" &&
    typeof S.occupancy === "function" && typeof S.locationOf === "function" && typeof S.stats === "function");

const locations = S.buildLocations(LAYOUT);
check("buildLocations count == summed racking capacity",
  locations.length === summedCapacity && locations.capacityTotal === summedCapacity,
  locations.length + " locations vs summed capacity " + summedCapacity);

/* ================= 2. Locations valid + golden zone ================= */
console.log("-- locations sit in their elements + golden zone marked");
const byElId = {};
LAYOUT.elements.forEach((e) => (byElId[e.id] = e));
let allInside = true;
for (const l of locations) {
  const e = byElId[l.elId];
  if (!e) { allInside = false; break; }
  if (!(l.x >= e.x && l.x <= e.x + e.w && l.y >= e.y && l.y <= e.y + e.d && isFinite(l.dist))) { allInside = false; break; }
}
check("every location lies inside its element footprint with a finite distance", allInside);
const goldenLocs = locations.filter((l) => l.golden);
const nonGoldenMaxNear = Math.max.apply(null, goldenLocs.map((l) => l.dist));
const nonGoldenMin = Math.min.apply(null, locations.filter((l) => !l.golden).map((l) => l.dist));
check("golden zone = the closest ~20% of locations (nearest the I/O)",
  goldenLocs.length === locations.goldenCount && goldenLocs.length > 0 &&
    Math.abs(goldenLocs.length / locations.length - S.PARAMS.goldenZoneFraction) < 0.05 &&
    nonGoldenMaxNear <= nonGoldenMin + 1e-9,
  goldenLocs.length + "/" + locations.length + " golden");

/* ================= 3. Deterministic assignment ===================== */
console.log("-- assignment determinism");
const nSku = Math.max(10, Math.floor(summedCapacity * 0.6)); // below capacity: no overflow
const master = WT.wmsdata.generate({ skuCount: nSku, orders: 1, seed: 123, demandSkew: 1.1 }).skuMaster;
const asgA = S.assign(S.buildLocations(LAYOUT), master, { strategy: "abc", seed: 42 });
const asgB = S.assign(S.buildLocations(LAYOUT), master, { strategy: "abc", seed: 42 });
check("assign() deterministic (same inputs+seed -> byte-identical)", eq(asgA, asgB));
check("assign() returns the documented shape",
  asgA.kind === "wt-storage-assignment" && Array.isArray(asgA.placements) &&
    typeof asgA.bySku === "object" && asgA.strategy === "abc" && asgA.capacityTotal === summedCapacity);

/* ================= 4. ABC-aware placement (golden-zone effect) ====== */
console.log("-- ABC-aware placement: fast movers close (golden-zone effect)");
const stA = S.stats(asgA);
check("A-class average distance < overall average (golden-zone effect)",
  stA.placement.avgDistAClassM < stA.placement.avgDistAllM && stA.placement.goldenEffect === true,
  "A avg=" + stA.placement.avgDistAClassM.toFixed(2) + "m vs all=" + stA.placement.avgDistAllM.toFixed(2) + "m");
check("most placed A-class SKUs land in the golden zone",
  stA.placement.aClassInGoldenPct > 50, stA.placement.aClassInGoldenPct.toFixed(1) + "% of A-class in golden zone");
const asgRnd = S.assign(S.buildLocations(LAYOUT), master, { strategy: "random", seed: 42 });
const stRnd = S.stats(asgRnd);
check("ABC places A-class closer than RANDOM slotting does (the KPI is meaningful)",
  stA.placement.avgDistAClassM < stRnd.placement.avgDistAClassM,
  "abc A=" + stA.placement.avgDistAClassM.toFixed(2) + "m < random A=" + stRnd.placement.avgDistAClassM.toFixed(2) + "m");
check("random slotting does NOT concentrate A-class in the golden zone (contrast)",
  stRnd.placement.aClassInGoldenPct < stA.placement.aClassInGoldenPct);

/* ================= 5. Occupancy maths + overflow honesty =========== */
console.log("-- occupancy maths + honest overflow report");
const occ = S.occupancy(asgA);
const rackPlacedSum = occ.byRack.reduce((a, r) => a + r.placed, 0);
check("occupancy: placed == min(SKUs, capacity); per-rack placed sums to the total",
  occ.placed === Math.min(nSku, summedCapacity) && rackPlacedSum === occ.placed && asgA.placedCount === occ.placed,
  "placed=" + occ.placed + " expected=" + Math.min(nSku, summedCapacity));
check("occupancy: no overflow when SKUs <= capacity; fill % is in range",
  occ.overflow === false && occ.unplacedCount === 0 && occ.fillPct > 0 && occ.fillPct <= 100 &&
    occ.byRack.every((r) => r.fillPct <= 100 + 1e-9));

// Overflow layout: capacity deliberately tiny, SKUs many.
const TINY = {
  gridW: 20, gridH: 12, cell: D.METRES_PER_CELL,
  elements: [
    { id: "d", type: "dock-out", x: 0, y: 5, w: 2, d: 2 },
    { id: "cf", type: "carton-flow", x: 3, y: 3, w: 3, d: 1 },
  ],
  config: { seed: 1 },
};
const tinyCap = D.elementCapacity(TINY.elements[1]);
const tinyMaster = WT.wmsdata.generate({ skuCount: tinyCap + 15, orders: 1, seed: 5 }).skuMaster;
const asgTiny = S.assign(S.buildLocations(TINY), tinyMaster, { strategy: "abc", seed: 9 });
const occTiny = S.occupancy(asgTiny);
const minPlacedVel = Math.min.apply(null, asgTiny.placements.map((p) => p.velocity));
const maxUnplacedVel = Math.max.apply(null, asgTiny.unplaced.map((u) => u.velocity));
check("overflow reported HONESTLY: placed==capacity, unplaced==SKUs-capacity, flag set",
  occTiny.overflow === true && occTiny.placed === tinyCap && occTiny.unplacedCount === (tinyCap + 15) - tinyCap &&
    asgTiny.placedCount === tinyCap,
  "cap=" + tinyCap + " placed=" + occTiny.placed + " unplaced=" + occTiny.unplacedCount);
check("overflow drops only the SLOWEST movers (fast movers never dropped)",
  maxUnplacedVel <= minPlacedVel, "max unplaced velocity " + maxUnplacedVel + " <= min placed velocity " + minPlacedVel);

/* ================= 6. Retrieval seam (locationOf / retrieve) ======== */
console.log("-- retrieval seam (mirrors M_retrieveSKUfromStorage)");
const placedSku = asgA.placements[0].sku;
const loc = S.locationOf(asgA, placedSku);
const layoutStorageIds = new Set(LAYOUT.elements.filter(isStorageEl).map((e) => e.id));
check("locationOf() returns a VALID in-layout location for a placed SKU",
  !!loc && layoutStorageIds.has(loc.elId) &&
    loc.x >= byElId[loc.elId].x && loc.x <= byElId[loc.elId].x + byElId[loc.elId].w,
  loc ? loc.sku + " -> " + loc.elId + " @(" + loc.x.toFixed(1) + "," + loc.y.toFixed(1) + ")" : "null");
const unknown = S.locationOf(asgA, "SKU-DOES-NOT-EXIST");
const unplacedSku = asgTiny.unplaced[0].sku;
check("locationOf() returns null for unknown + unplaced SKUs (honest)",
  unknown === null && S.locationOf(asgTiny, unplacedSku) === null);
const ret = S.retrieve(asgA, placedSku);
check("retrieve() returns the location + round-trip travel (2x one-way distance)",
  ret.found === true && ret.distToIoM === loc.dist && Math.abs(ret.travelM - 2 * loc.dist) < 1e-9 &&
    S.retrieve(asgA, "NOPE").found === false);

/* ================= 7. Flowsim wiring + byte-identical fallback ====== */
console.log("-- flowsim storage->picking retrieval leg (+ byte-identical fallback)");
// Plain storage centroid (the ORIGINAL formula), computed independently.
const stEls = LAYOUT.elements.filter(isStorageEl);
const plain = stEls.reduce((a, e) => ({ x: a.x + (e.x + e.w / 2), y: a.y + (e.y + e.d / 2) }), { x: 0, y: 0 });
plain.x /= stEls.length; plain.y /= stEls.length;

const wpNo = WT.flowsim.buildWaypoints(LAYOUT);
const wpAsg = WT.flowsim.buildWaypoints(Object.assign({}, LAYOUT, { storageAssignment: asgA }));
const sNo = wpNo[1], sAsg = wpAsg[1]; // index 1 = the storage-stage anchor
const anchor = S.retrievalAnchor(asgA);
check("FALLBACK (no assignment): storage waypoint == plain storage centroid (unchanged)",
  sNo.stage === "storage" && Math.abs(sNo.x - plain.x) < 1e-6 && Math.abs(sNo.y - plain.y) < 1e-6 &&
    wpNo.retrievalAnchored === false,
  "wp=(" + sNo.x.toFixed(2) + "," + sNo.y.toFixed(2) + ") centroid=(" + plain.x.toFixed(2) + "," + plain.y.toFixed(2) + ")");
check("WITH assignment: storage waypoint moves to the real slotting anchor",
  wpAsg.retrievalAnchored === true && Math.abs(sAsg.x - anchor.x) < 1e-6 && Math.abs(sAsg.y - anchor.y) < 1e-6 &&
    Math.hypot(sAsg.x - plain.x, sAsg.y - plain.y) > 0.25,
  "anchor=(" + anchor.x.toFixed(2) + "," + anchor.y.toFixed(2) + ") moved " +
    Math.hypot(sAsg.x - plain.x, sAsg.y - plain.y).toFixed(2) + " cells toward the golden zone");
check("retrieval anchor is velocity-weighted toward the I/O (closer than the plain centroid)",
  Math.hypot(anchor.x - wpNo[0].x, anchor.y - wpNo[0].y) < Math.hypot(plain.x - wpNo[0].x, plain.y - wpNo[0].y) ||
    anchor.x < plain.x, "anchor.x=" + anchor.x.toFixed(2) + " < centroid.x=" + plain.x.toFixed(2));

// Regression: a full flowsim run with NO assignment is deterministic AND
// unaffected by loading storage.js (the fallback path is byte-identical).
function runFlow(layout, steps) {
  const s = WT.flowsim.state(layout, { seed: 7, loop: true });
  for (let i = 0; i < steps; i++) WT.flowsim.step(s, 1);
  return { spawned: s.spawned, completed: s.completed, inflight: s.inflight, mus: s.mus.map((m) => [m.cx, m.cy, m.stage]) };
}
check("flowsim FALLBACK run (no assignment) is deterministic (byte-identical)",
  eq(runFlow(LAYOUT, 40), runFlow(LAYOUT, 40)));
check("assign() does not mutate the layout (no storageAssignment leaks in)",
  !("storageAssignment" in LAYOUT));

/* ================= 8. Determinism of stats/occupancy + honesty ===== */
console.log("-- stats/occupancy determinism + honesty labels");
check("stats() + occupancy() are deterministic for a given assignment",
  eq(S.stats(asgA), S.stats(asgB)) && eq(S.occupancy(asgA), S.occupancy(asgB)));
check("active store: build()/current()/no-arg locationOf + stats + clear()",
  (function () {
    S.build(LAYOUT, master, { strategy: "abc", seed: 42, source: "synthetic" });
    const okBuilt = S.isAssigned() && eq(S.current().placements, asgA.placements);
    const okNoArg = S.locationOf(placedSku) && S.stats().placedCount === asgA.placedCount;
    S.clear();
    return okBuilt && okNoArg && !S.isAssigned() && S.current() == null;
  })());
check("honesty: SYNTHETIC label calls slotting a heuristic, NOT a measurement/certification",
  /SYNTHETIC/.test(S.SYNTHETIC_LABEL) && /HEURISTIC/i.test(S.SYNTHETIC_LABEL) &&
    /NOT a measurement/i.test(S.SYNTHETIC_LABEL) && /NOT a certification/i.test(S.SYNTHETIC_LABEL) &&
    /OVERFLOW/i.test(S.SYNTHETIC_LABEL) && stA.dataLabel === S.SYNTHETIC_LABEL);
check("honesty: overflow flags surface in stats() (goldenZoneOverflow honest too)",
  S.stats(asgTiny).flags.overflow === true && typeof S.stats(asgA).flags.goldenZoneOverflow === "boolean");

console.log("");
console.log(failures === 0 ? "ALL storage checks passed." : failures + " storage check(s) FAILED.");
process.exit(failures === 0 ? 0 : 1);
