/* =====================================================================
 * verify_share.js - share-link codec verification harness.
 *
 * Runs the REAL app modules (domain.js, simulation.js, share.js) in
 * Node with the same window shim the other harnesses use and proves:
 *
 *   1. ROUND-TRIP: encoding the starter-demo layout and the MRO-preset
 *      layout to a #layout= payload and decoding it back yields a
 *      byte-identical layout object (deep JSON equality).
 *   2. KPI EQUALITY: the seeded simulation produces IDENTICAL headline
 *      KPIs on the decoded layout as on the original - a share link
 *      changes nothing about the design it carries.
 *   3. PAYLOAD SHAPE: payloads are pure base64url (URL-fragment-safe,
 *      no percent-encoding needed) and their measured lengths are
 *      printed for the starter and MRO layouts.
 *   4. MALFORMED INPUT: garbage, truncated, non-JSON and non-object
 *      payloads all throw (the app then boots normally with a toast).
 *   5. UTF-8: non-ASCII content survives the UTF-8 -> base64url trip.
 *
 * Everything is deterministic. Usage:  node verify_share.js
 * ASCII-only output. Exit 0 = all checks pass.
 * ===================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");

global.window = global; // the app modules attach themselves to window.WT
for (const f of ["domain.js", "simulation.js", "share.js"]) {
  // eslint-disable-next-line no-eval
  (0, eval)(fs.readFileSync(path.join(__dirname, f), "utf8"));
}
const WT = global.WT;
const D = WT.domain;

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? "[PASS] " : "[FAIL] ") + name + (detail ? " - " + detail : ""));
  if (!ok) failures++;
}

// ---- Layout fixtures (identical to app.js demoLayout() / the MRO preset) ----
function mkElements(list) {
  let idCounter = 0;
  return list.map((e) => {
    const def = D.ELEMENTS[e.type];
    return { id: "el-" + ++idCounter, type: e.type, x: e.x, y: e.y, w: e.w || def.w, d: e.d || def.d };
  });
}

const DEFAULT_CONFIG = {
  seed: 42, strategy: "abc", orders: 200, skuCount: 80,
  minAisleMetres: D.AISLE.defaultMinMetres, flowMode: "pull", demandSkew: 1.0,
  palletType: "EUR1", boxType: "EURO-CASE", wagePerHour: 22, weeklyOrders: 1500,
};

const STARTER = mkElements([
  { type: "dock-in", x: 4, y: 0, w: 2, d: 1 },
  { type: "dock-out", x: 20, y: 23, w: 2, d: 1 },
  { type: "staging", x: 18, y: 20, w: 4, d: 2 },
  { type: "selective-racking", x: 6, y: 5, w: 8, d: 1 },
  { type: "selective-racking", x: 6, y: 9, w: 8, d: 1 },
  { type: "selective-racking", x: 24, y: 5, w: 8, d: 1 },
  { type: "selective-racking", x: 24, y: 9, w: 8, d: 1 },
  { type: "block-stack", x: 6, y: 14, w: 6, d: 4 },
  { type: "conveyor", x: 24, y: 15, w: 8, d: 1 },
  { type: "push-station", x: 34, y: 5, w: 2, d: 2 },
  { type: "pull-station", x: 34, y: 9, w: 2, d: 2 },
]);

const MRO_PRESET = D.PRESETS["mro-distributor"];
const MRO = mkElements(MRO_PRESET.elements);
const MRO_CONFIG = Object.assign({}, DEFAULT_CONFIG, MRO_PRESET.config);

// serialize() schema exactly as app.js exports it (savedAt is dropped
// from share links by buildShareHash, so it is absent here too).
function shareObject(elements, config) {
  return {
    version: "wt-1", gridW: 40, gridH: 24, cell: D.METRES_PER_CELL,
    elements: elements.map((e) => ({ id: e.id, type: e.type, x: e.x, y: e.y, w: e.w, d: e.d })),
    config: Object.assign({}, config),
  };
}

const KPI_FIELDS = [
  "avgPickTravelM", "throughputOrdersPerHour", "storageFillPct",
  "stockoutPct", "overstockUnits", "palletPositionsTotal", "labourSecPerOrder",
];

function runKpis(elements, config) {
  const layout = { elements, gridW: 40, gridH: 24, cell: D.METRES_PER_CELL };
  const res = WT.sim.run(layout, config);
  const out = {};
  for (const k of KPI_FIELDS) out[k] = res[k];
  return out;
}

// A representative base URL for length reporting (the fragment length
// itself is what matters - fragments are never sent to any server).
const BASE_URL = "http://localhost:8000/";

function roundTrip(name, elements, config) {
  const obj = shareObject(elements, config);
  const payload = WT.share.encodeLayout(obj);

  check(name + ": payload is pure base64url", /^[A-Za-z0-9_-]+$/.test(payload));

  const decoded = WT.share.decodeLayout(payload);
  check(name + ": decoded object deep-equals the original",
    JSON.stringify(decoded) === JSON.stringify(obj));

  const kBefore = runKpis(obj.elements, obj.config);
  const kAfter = runKpis(decoded.elements, decoded.config);
  check(name + ": identical KPIs on the decoded layout",
    JSON.stringify(kBefore) === JSON.stringify(kAfter),
    "travel " + kAfter.avgPickTravelM.toFixed(2) + " m/order, " +
    kAfter.throughputOrdersPerHour.toFixed(2) + " orders/hr");

  const link = BASE_URL + "#layout=" + payload;
  console.log("       " + name + " link length: " + link.length + " chars total (" +
    payload.length + "-char payload, " + obj.elements.length + " elements)");
  return payload;
}

console.log("Share-link codec verification (deterministic)");
console.log("");
const starterPayload = roundTrip("starter layout", STARTER, DEFAULT_CONFIG);
roundTrip("MRO preset", MRO, MRO_CONFIG);

// ---- Malformed payloads must throw ---------------------------------
console.log("");
const bad = [
  ["percent garbage", "%%%not-base64%%%"],
  ["empty string", ""],
  ["truncated payload", starterPayload.slice(0, 40)], // valid b64url, broken JSON
  ["base64url of non-JSON", "aGVsbG8gd29ybGQ"], // "hello world"
  ["base64url of a JSON array", "WzEsMiwzXQ"], // [1,2,3] - not a layout object
  ["base64url of JSON null", "bnVsbA"], // null
  ["invalid UTF-8 bytes", "_w"], // 0xFF
];
for (const [label, payload] of bad) {
  let threw = false;
  try { WT.share.decodeLayout(payload); } catch (_) { threw = true; }
  check("malformed rejected: " + label, threw);
}

// ---- UTF-8 round trip ----------------------------------------------
const utf8Obj = { note: "Grosse Übung — € é 中文", elements: [] };
let utf8Ok = false;
try {
  utf8Ok = JSON.stringify(WT.share.decodeLayout(WT.share.encodeLayout(utf8Obj))) === JSON.stringify(utf8Obj);
} catch (_) { utf8Ok = false; }
check("non-ASCII content survives the UTF-8/base64url trip", utf8Ok);

// ---- payloadFromHash parsing ---------------------------------------
check("payloadFromHash extracts #layout=...",
  WT.share.payloadFromHash("#layout=" + starterPayload) === starterPayload);
check("payloadFromHash ignores unrelated hashes",
  WT.share.payloadFromHash("#section-2") === null && WT.share.payloadFromHash("") === null);

console.log("");
console.log(failures === 0 ? "ALL SHARE-LINK CHECKS PASSED" : failures + " SHARE-LINK CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
