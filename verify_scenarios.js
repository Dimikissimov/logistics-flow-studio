/* =====================================================================
 * verify_scenarios.js - Save / load NAMED scenarios verification (v1.1).
 *
 * Runs the REAL scenarios.js module (WT.scenarios) in Node under the same
 * window shim the other harnesses use and asserts the PURE, guarded store
 * behind the "My scenarios" control - so the usability feature is proven
 * headlessly even though the DOM wiring itself is not:
 *
 *   1.  API surface: WT.scenarios exposes save/load/list/has/rename/remove/
 *       clear/exportBundle/importBundle + KEY/slug/create/lsStore/memStore.
 *   2.  localStorage GUARD is a no-op in Node: the DEFAULT store reads EMPTY
 *       (list() -> []), lsStore().read() -> null and write() -> false, and a
 *       default save() no-ops without throwing (nothing persists in Node).
 *   3.  slug() is pure + deterministic (same name -> same lowercased key).
 *   4.  save -> list -> load ROUND-TRIP: a saved serialize()-shaped snapshot
 *       is listed with the right summary and loads back DEEP-EQUAL.
 *   5.  loading reconstructs the SAME serialize() object (a realistic wt-1
 *       layout+config is byte-identical after save->load).
 *   6.  list() summary carries element count + floor size + savedAt.
 *   7.  UNIQUE-BY-SLUG: re-saving the same name UPDATES in place (count
 *       stays 1); a differently-cased/spaced name that slugs the same also
 *       updates the same scenario (documented dedupe).
 *   8.  rename() renames; renaming onto a DIFFERENT existing name throws;
 *       renaming a missing scenario returns false.
 *   9.  remove() deletes (and returns false when absent).
 *  10.  exportBundle -> importBundle ROUND-TRIP into a FRESH store preserves
 *       every scenario (deep-equal on names, savedAt and snapshots).
 *  11.  DETERMINISM: exportBundle is byte-identical across calls, and an
 *       import->re-export reproduces the same bytes (sorted-key stable).
 *  12.  HONESTY / validation: importBundle REJECTS malformed input (not JSON,
 *       not an object, no scenarios array) with ok:false and WITHOUT mutating
 *       the store; a mixed bundle imports the valid entries and skips junk;
 *       save() rejects an empty name / non-object snapshot.
 *
 * Plus light INTEGRATION guards on the shipped source (load order, offline
 * shell, generic wiring, honesty label), since the DOM control is added at
 * runtime by app.js and is not itself headless-testable:
 *
 *  13.  index.html loads scenarios.js before app.js and ships the "My
 *       scenarios" control with the on-device honesty label.
 *  14.  sw.js precaches ./scenarios.js (offline shell complete) at a versioned cache.
 *  15.  app.js wires scenarios via WT.scenarios AND reuses deserialize()
 *       (the same loader as JSON import), not a bespoke apply path.
 *
 * Everything is deterministic (no wall-clock, no Math.random). Usage:
 *   node verify_scenarios.js
 * ASCII-only output. Exit 0 = all checks pass.
 * ===================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");

global.window = global; // scenarios.js attaches itself to window.WT
// eslint-disable-next-line no-eval
(0, eval)(fs.readFileSync(path.join(__dirname, "scenarios.js"), "utf8"));
const WT = global.WT;
const S = WT.scenarios;

let failures = 0;
let checks = 0;
function check(name, ok, detail) {
  checks++;
  console.log((ok ? "[PASS] " : "[FAIL] ") + name + (detail ? " - " + detail : ""));
  if (!ok) failures++;
}

// Canonical JSON (sorted keys) for order-independent deep-equality.
function canon(v) {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ":" + canon(v[k]); }).join(",") + "}";
  }
  return JSON.stringify(v);
}
function deepEqual(a, b) { return canon(a) === canon(b); }

// A realistic serialize()-shaped snapshot (matches app.js serialize()).
function makeSnapshot() {
  return {
    version: "wt-1",
    gridW: 48,
    gridH: 30,
    cell: 1,
    elements: [
      { id: "el-1", type: "rack", x: 2, y: 3, w: 4, d: 1 },
      { id: "el-2", type: "dock", x: 0, y: 12, w: 2, d: 2 },
      { id: "el-3", type: "conveyor", x: 10, y: 8, w: 1, d: 6 },
    ],
    config: { seed: 7, strategy: "abc", orders: 300, skuCount: 80, minAisleMetres: 3, flowMode: "pull", demandSkew: 1 },
  };
}

console.log("Save / load named scenarios verification (deterministic)");
console.log("");

// ---- 1. API surface -------------------------------------------------
check(
  "API surface: WT.scenarios exposes the store methods + building blocks",
  S &&
    typeof S.save === "function" &&
    typeof S.load === "function" &&
    typeof S.list === "function" &&
    typeof S.has === "function" &&
    typeof S.rename === "function" &&
    typeof S.remove === "function" &&
    typeof S.clear === "function" &&
    typeof S.exportBundle === "function" &&
    typeof S.importBundle === "function" &&
    typeof S.slug === "function" &&
    typeof S.create === "function" &&
    typeof S.lsStore === "function" &&
    typeof S.memStore === "function" &&
    typeof S.KEY === "string" && S.KEY.length > 0
);

// ---- 2. localStorage guard = no-op in Node --------------------------
const ls = S.lsStore();
let defaultNoThrow = true;
try {
  S.save("ghost", makeSnapshot(), { savedAt: "2026-08-03T00:00:00.000Z" }); // must not throw; must not persist
} catch (e) {
  defaultNoThrow = false;
}
check(
  "localStorage GUARD: default store empty in Node, lsStore no-ops, default save() does not throw or persist",
  ls.read() === null &&
    ls.write("x") === false &&
    S.list().length === 0 &&
    S.has("ghost") === false &&
    defaultNoThrow,
  "list=[] read=null write=false"
);

// ---- 3. slug() pure + deterministic ---------------------------------
check(
  "slug() is pure + deterministic (lowercased/hyphenated, never empty)",
  S.slug("My Cross-Dock v2") === S.slug("My Cross-Dock v2") &&
    S.slug("My Cross-Dock v2") === "my-cross-dock-v2" &&
    S.slug("   ") === "scenario" &&
    S.slug("A / B!!") === "a-b",
  S.slug("My Cross-Dock v2")
);

// A fresh in-memory store instance for the behavioural checks.
const store = S.create({ store: S.memStore() });
const snap = makeSnapshot();

// ---- 4. save -> list -> load round-trip -----------------------------
store.save("Cold chain hub", snap, { savedAt: "2026-08-03T10:00:00.000Z" });
const listed = store.list();
const loaded = store.load("Cold chain hub");
check(
  "save -> list -> load round-trips the snapshot (deep-equal)",
  listed.length === 1 &&
    listed[0].name === "Cold chain hub" &&
    listed[0].slug === "cold-chain-hub" &&
    deepEqual(loaded, snap),
  "listed=" + listed.length + ", load deep-equal=" + deepEqual(loaded, snap)
);

// ---- 5. loading reconstructs the same serialize() object ------------
check(
  "loading reconstructs the SAME serialize() object (byte-identical layout+config)",
  loaded !== snap && // a copy, not an alias
    canon(loaded) === canon(snap),
  "distinct object, canonical-equal"
);

// ---- 6. summary carries element count + floor + savedAt -------------
const sum = listed[0].summary;
check(
  "list() summary: element count + floor size + savedAt present",
  sum.elements === 3 &&
    sum.floor === "48x30" &&
    sum.gridW === 48 &&
    sum.gridH === 30 &&
    listed[0].savedAt === "2026-08-03T10:00:00.000Z",
  "elements=" + sum.elements + " floor=" + sum.floor
);

// ---- 7. unique BY SLUG: re-save updates in place --------------------
const snap2 = makeSnapshot();
snap2.elements = snap2.elements.slice(0, 1); // 1 element this time
store.save("Cold chain hub", snap2, { savedAt: "2026-08-03T11:00:00.000Z" }); // same name -> update
store.save("  COLD  chain  HUB ", snap2, { savedAt: "2026-08-03T12:00:00.000Z" }); // same slug -> update
const afterResave = store.list();
check(
  "unique BY SLUG: re-saving the same (or same-slug) name UPDATES in place (no duplicates)",
  afterResave.length === 1 &&
    afterResave[0].summary.elements === 1 &&
    afterResave[0].savedAt === "2026-08-03T12:00:00.000Z" &&
    store.load("Cold chain hub").elements.length === 1,
  "count=" + afterResave.length + " elements=" + afterResave[0].summary.elements
);

// ---- 8. rename + collision + missing --------------------------------
store.save("Pharma GDP", makeSnapshot(), { savedAt: "2026-08-03T09:00:00.000Z" });
const renamed = store.rename("Cold chain hub", "Frozen hub");
let collisionThrew = false;
try {
  store.rename("Frozen hub", "Pharma GDP"); // collides with a DIFFERENT scenario
} catch (e) {
  collisionThrew = true;
}
const renameMissing = store.rename("does-not-exist", "whatever");
check(
  "rename() renames; onto a different existing name it throws; a missing source returns false",
  renamed === true &&
    store.has("Frozen hub") === true &&
    store.has("Cold chain hub") === false &&
    collisionThrew === true &&
    renameMissing === false,
  "renamed=" + renamed + " collisionThrew=" + collisionThrew + " missing=" + renameMissing
);

// ---- 9. remove ------------------------------------------------------
const removed = store.remove("Frozen hub");
const removeMissing = store.remove("Frozen hub");
check(
  "remove() deletes the scenario and returns false when it is already gone",
  removed === true && removeMissing === false && store.has("Frozen hub") === false && store.list().length === 1,
  "removed=" + removed + " again=" + removeMissing
);

// ---- 10. exportBundle -> importBundle round-trip into a FRESH store --
// Rebuild a two-scenario store, export it, import into an empty store.
const src = S.create({ store: S.memStore() });
src.save("Alpha plant", makeSnapshot(), { savedAt: "2026-08-03T01:00:00.000Z" });
const bSnap = makeSnapshot();
bSnap.config.seed = 42;
src.save("Beta plant", bSnap, { savedAt: "2026-08-03T02:00:00.000Z" });
const bundleJson = src.exportBundle(null, { exportedAt: "2026-08-03T03:00:00.000Z" });
const dst = S.create({ store: S.memStore() });
const imp = dst.importBundle(bundleJson);
const srcList = src.list();
const dstList = dst.list();
let bundleRoundTrips = imp.ok && imp.imported === 2 && srcList.length === dstList.length;
for (let i = 0; i < srcList.length && bundleRoundTrips; i++) {
  const a = srcList[i];
  const b = dstList[i];
  if (a.name !== b.name || a.savedAt !== b.savedAt || !deepEqual(src.load(a.name), dst.load(b.name))) {
    bundleRoundTrips = false;
  }
}
check(
  "exportBundle -> importBundle into a FRESH store preserves every scenario (deep-equal)",
  bundleRoundTrips,
  "imported=" + imp.imported + " src=" + srcList.length + " dst=" + dstList.length
);

// ---- 11. determinism: byte-stable export + import/re-export ---------
const again = src.exportBundle(null, { exportedAt: "2026-08-03T03:00:00.000Z" });
const reExport = dst.exportBundle(null, { exportedAt: "2026-08-03T03:00:00.000Z" });
check(
  "DETERMINISM: exportBundle is byte-identical across calls and survives an import->re-export",
  bundleJson === again && bundleJson === reExport,
  "stable=" + (bundleJson === again) + " roundtrip-bytes=" + (bundleJson === reExport)
);

// ---- 12. honesty / validation --------------------------------------
const guard = S.create({ store: S.memStore() });
guard.save("keep", makeSnapshot(), { savedAt: "2026-08-03T00:00:00.000Z" });
const before = guard.exportBundle();
const badJson = guard.importBundle("{ not json");
const badObj = guard.importBundle(12345);
const noArray = guard.importBundle({ kind: "warehousetwin-scenarios" });
const storeUntouched = guard.exportBundle() === before && guard.list().length === 1;
// mixed bundle: one valid, two junk entries
const mixed = guard.importBundle({
  scenarios: [
    { name: "Good one", snapshot: makeSnapshot(), savedAt: "2026-08-03T05:00:00.000Z" },
    { name: "", snapshot: makeSnapshot() }, // empty name
    { name: "No snapshot" }, // missing snapshot
  ],
});
let saveRejects = 0;
try { guard.save("", makeSnapshot()); } catch (e) { saveRejects++; }
try { guard.save("ok", 123); } catch (e) { saveRejects++; }
check(
  "HONESTY/validation: malformed bundles rejected without mutating the store; junk entries skipped; save() rejects bad input",
  badJson.ok === false &&
    badObj.ok === false &&
    noArray.ok === false &&
    storeUntouched &&
    mixed.ok === true &&
    mixed.imported === 1 &&
    mixed.skipped === 2 &&
    guard.has("Good one") === true &&
    saveRejects === 2,
  "rejected 3 malformed, mixed imported=" + mixed.imported + " skipped=" + mixed.skipped + " saveRejects=" + saveRejects
);

// ---- 13-15. integration guards on the shipped source ---------------
const indexHtml = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const swJs = fs.readFileSync(path.join(__dirname, "sw.js"), "utf8");
const appJs = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");

const scenIdx = indexHtml.indexOf('src="scenarios.js"');
const appIdx = indexHtml.indexOf('src="app.js"');
check(
  'index.html loads scenarios.js before app.js and ships the "My scenarios" control with an on-device honesty label',
  scenIdx !== -1 &&
    appIdx !== -1 &&
    scenIdx < appIdx &&
    indexHtml.indexOf("My scenarios") !== -1 &&
    /this device|on-device|on this device/i.test(indexHtml),
  "scenarios.js@" + scenIdx + " < app.js@" + appIdx
);

check(
  "sw.js precaches ./scenarios.js (offline shell complete) and carries a versioned cache",
  swJs.indexOf('"./scenarios.js"') !== -1 && /wt-v\d+/.test(swJs)
);

check(
  "app.js wires scenarios via WT.scenarios AND reuses deserialize() (same loader as JSON import)",
  appJs.indexOf("WT.scenarios") !== -1 &&
    appJs.indexOf("scenarioSaveBtn") !== -1 &&
    appJs.indexOf("deserialize(") !== -1,
  "WT.scenarios + deserialize present"
);

console.log("");
console.log("-".repeat(60));
console.log(
  failures === 0
    ? "ALL " + checks + " CHECKS PASSED"
    : failures + " OF " + checks + " CHECKS FAILED"
);
process.exit(failures === 0 ? 0 : 1);
