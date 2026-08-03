/* =====================================================================
 * verify_wms.js - WMS Operations layer verification harness (P2).
 *
 * Runs the REAL app modules (domain.js, compliance.js, simulation.js,
 * generate.js, nlcommands.js, examples.js, wms.js) in Node under the
 * same window shim the other harnesses use and asserts:
 *
 *   1. The 7 standard workflow stages are present, in order:
 *      receiving -> put-away -> storage -> replenishment ->
 *      order-picking -> packing -> shipping.
 *   2. runOperations is DETERMINISTIC on the MRO preset (twice ->
 *      byte-identical JSON, result AND KPIs).
 *   3. runOperations is deterministic on an examples.js layout.
 *   4. runOperations runs on a generated (WT.generate) layout, ok +
 *      deterministic.
 *   5. Every stage has a positive throughput capacity (units/hr).
 *   6. KPIs are computed and within sane bounds (throughput,
 *      order cycle time, dock-to-stock, picking productivity,
 *      storage utilisation).
 *   7. Unit conservation: shipped + remaining WIP == total units in.
 *   8. Time series shape: each stage has hours*ticksPerHour samples and
 *      every utilisation sample is in [0, 1].
 *   9. A bottleneck stage is identified with a plain-language sentence.
 *  10. Monotonic sanity (system): more docks + automation + pack
 *      stations -> strictly higher shipped throughput.
 *  11. Monotonic sanity (stage, pure): more dock-in -> higher receiving
 *      capacity; more dock-out -> higher shipping capacity; an
 *      automation lane -> higher put-away capacity.
 *  12. Honesty: the SYNTHETIC label is present in the runOperations
 *      result AND the kpis result; every KPI carries a non-empty source
 *      note; ISO 22400 is cited in the KPI sources.
 *  13. capacities(layout) returns exactly 7 stage entries.
 *
 * Everything is deterministic (seeded, never wall-clock). Usage:
 *   node verify_wms.js
 * ASCII-only output. Exit 0 = all checks pass.
 * ===================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");

global.window = global; // app modules attach themselves to window.WT
for (const f of ["domain.js", "compliance.js", "simulation.js", "generate.js", "nlcommands.js", "examples.js", "wms.js"]) {
  // eslint-disable-next-line no-eval
  (0, eval)(fs.readFileSync(path.join(__dirname, f), "utf8"));
}
const WT = global.WT;
const D = WT.domain;
const W = WT.wms;
const G = WT.generate;
const E = WT.examples;

let failures = 0;
let checks = 0;
function check(name, ok, detail) {
  checks++;
  console.log((ok ? "[PASS] " : "[FAIL] ") + name + (detail ? " - " + detail : ""));
  if (!ok) failures++;
}

// ---- fixture helpers ------------------------------------------------
function mk(list) {
  let i = 0;
  return list.map((e) => {
    const def = D.ELEMENTS[e.type] || {};
    return { id: "el-" + ++i, type: e.type, x: e.x, y: e.y, w: e.w || def.w, d: e.d || def.d };
  });
}
function presetLayout() {
  const p = D.PRESETS["mro-distributor"];
  return { elements: mk(p.elements), gridW: 40, gridH: 24, cell: 1, config: p.config };
}
const finite = (v) => typeof v === "number" && isFinite(v);

console.log("WMS Operations verification (deterministic)");
console.log("");

/* ---------------------------------------------------------------------
 * 1. The 7 standard workflow stages, in order.
 * ------------------------------------------------------------------- */
const EXPECTED = ["receiving", "put-away", "storage", "replenishment", "order-picking", "packing", "shipping"];
const stageIds = W.STAGES.map((s) => s.id);
check("STAGES has exactly 7 entries", W.STAGES.length === 7, W.STAGES.length + " stages");
check("STAGES are in the standard order", JSON.stringify(stageIds) === JSON.stringify(EXPECTED), stageIds.join(" -> "));

/* ---------------------------------------------------------------------
 * 2. Determinism on the MRO preset (result + KPIs byte-identical).
 * ------------------------------------------------------------------- */
const layoutA = presetLayout();
const r1 = W.runOperations(layoutA, { seed: 42, orders: 300, hours: 8 });
const r2 = W.runOperations(presetLayout(), { seed: 42, orders: 300, hours: 8 });
check("runOperations deterministic on MRO preset (result JSON identical)", JSON.stringify(r1) === JSON.stringify(r2));
const k1 = W.kpis(r1, layoutA);
const k2 = W.kpis(r2, layoutA);
check("kpis deterministic on MRO preset (KPI JSON identical)", JSON.stringify(k1) === JSON.stringify(k2));
check("MRO preset run is ok (storage present, sim ran)", r1.ok === true);

/* ---------------------------------------------------------------------
 * 3. Determinism on an examples.js layout.
 * ------------------------------------------------------------------- */
const exId = "ecommerce-multichannel-fc";
const exBuild = E.build(exId);
const exLayout = { elements: exBuild.elements, gridW: exBuild.gridW, gridH: exBuild.gridH, cell: 1, config: exBuild.config };
const ex1 = W.runOperations(exLayout, { seed: 7, orders: 250, hours: 8 });
const ex2 = W.runOperations(exLayout, { seed: 7, orders: 250, hours: 8 });
check("runOperations runs on an examples.js layout (" + exId + ")", ex1.ok === true);
check("runOperations deterministic on the examples.js layout", JSON.stringify(ex1) === JSON.stringify(ex2));

/* ---------------------------------------------------------------------
 * 4. Runs on a generated (WT.generate) layout.
 * ------------------------------------------------------------------- */
const gen = G.generateLayout("ecommerce-fulfilment", { seed: 11 });
const genLayout = { elements: gen.elements, gridW: gen.gridW, gridH: gen.gridH, cell: 1, config: gen.config };
const g1 = W.runOperations(genLayout, { seed: 11, orders: 300, hours: 8 });
const g2 = W.runOperations(genLayout, { seed: 11, orders: 300, hours: 8 });
check("runOperations runs on a generated layout (ecommerce-fulfilment)", g1.ok === true);
check("runOperations deterministic on the generated layout", JSON.stringify(g1) === JSON.stringify(g2));

/* ---------------------------------------------------------------------
 * 5. Every stage has a positive throughput capacity.
 * ------------------------------------------------------------------- */
const allCapsPositive = r1.stages.every((s) => finite(s.capacityUnitsPerHr) && s.capacityUnitsPerHr > 0);
check("every stage has a positive, finite capacity (units/hr)", allCapsPositive,
  r1.stages.map((s) => s.id + "=" + s.capacityUnitsPerHr.toFixed(0)).join(", "));

/* ---------------------------------------------------------------------
 * 6. KPIs computed and within sane bounds.
 * ------------------------------------------------------------------- */
const K = k1;
check("throughput is positive & finite", finite(K.throughputUnitsPerHr) && K.throughputUnitsPerHr > 0,
  K.throughputUnitsPerHr.toFixed(1) + " units/hr");
check("orders/hr throughput is positive & finite", finite(K.throughputOrdersPerHr) && K.throughputOrdersPerHr > 0,
  K.throughputOrdersPerHr.toFixed(2) + " ord/hr");
check("order cycle time is positive & finite", finite(K.orderCycleTimeMin) && K.orderCycleTimeMin > 0,
  K.orderCycleTimeMin.toFixed(1) + " min");
check("dock-to-stock time is non-negative & finite", finite(K.dockToStockMin) && K.dockToStockMin >= 0,
  K.dockToStockMin.toFixed(1) + " min");
check("picking productivity is positive & finite", finite(K.pickingLinesPerHr) && K.pickingLinesPerHr > 0,
  K.pickingLinesPerHr.toFixed(1) + " lines/hr");
check("storage utilisation is within [0, 100]", finite(K.storageUtilPct) && K.storageUtilPct >= 0 && K.storageUtilPct <= 100,
  K.storageUtilPct.toFixed(1) + " %");
check("exactly 5 headline KPIs in the kpis[] list", K.kpis.length === 5, K.kpis.length + " KPIs");

/* ---------------------------------------------------------------------
 * 7. Unit conservation: shipped + remaining WIP == total units in.
 * ------------------------------------------------------------------- */
const conserved = Math.abs(r1.shippedUnits + r1.remainingWip - r1.totalUnits) < 1e-6;
check("unit conservation (shipped + WIP == total in)", conserved,
  r1.shippedUnits.toFixed(2) + " + " + r1.remainingWip.toFixed(2) + " vs " + r1.totalUnits);

/* ---------------------------------------------------------------------
 * 8. Time series shape + utilisation bounds.
 * ------------------------------------------------------------------- */
const expectedT = r1.hours * r1.ticksPerHour;
let seriesShapeOk = r1.series.length === 7;
let utilBoundsOk = true;
for (const s of r1.series) {
  if (s.processed.length !== expectedT || s.backlog.length !== expectedT || s.utilisation.length !== expectedT) seriesShapeOk = false;
  for (const u of s.utilisation) if (!(u >= -1e-9 && u <= 1 + 1e-9)) utilBoundsOk = false;
}
check("per-stage time series length == hours*ticksPerHour (" + expectedT + ")", seriesShapeOk);
check("every utilisation sample is within [0, 1]", utilBoundsOk);

/* ---------------------------------------------------------------------
 * 9. A bottleneck stage is identified with plain language.
 * ------------------------------------------------------------------- */
const b = K.bottleneck;
const bottleneckOk = b && EXPECTED.indexOf(b.id) !== -1 && typeof b.plain === "string" && b.plain.length > 20 &&
  b.index === r1.bottleneckIndex;
check("bottleneck stage identified with a plain-language sentence", bottleneckOk, b ? b.label : "none");
// The bottleneck must be the lowest-capacity stage.
const minCap = Math.min.apply(null, r1.stages.map((s) => s.capacityUnitsPerHr));
check("bottleneck is the lowest-capacity stage", Math.abs(r1.stages[r1.bottleneckIndex].capacityUnitsPerHr - minCap) < 1e-6,
  b.label + " @ " + r1.stages[r1.bottleneckIndex].capacityUnitsPerHr.toFixed(0));

/* ---------------------------------------------------------------------
 * 10. Monotonic sanity (system): more docks + automation + pack -> more
 *     shipped throughput.
 * ------------------------------------------------------------------- */
const baseCfg = { seed: 5, strategy: "abc", orders: 200, skuCount: 80 };
const base = {
  elements: mk([
    { type: "dock-in", x: 2, y: 0 },
    { type: "selective-racking", x: 2, y: 6, w: 12, d: 1 },
    { type: "selective-racking", x: 2, y: 9, w: 12, d: 1 },
    { type: "pack-station", x: 2, y: 20 },
    { type: "dock-out", x: 2, y: 23 },
  ]),
  gridW: 40, gridH: 24, cell: 1, config: baseCfg,
};
const augmented = {
  elements: mk([
    { type: "dock-in", x: 2, y: 0 }, { type: "dock-in", x: 6, y: 0 }, { type: "dock-in", x: 10, y: 0 },
    { type: "staging", x: 2, y: 1, w: 8, d: 2 },
    { type: "selective-racking", x: 2, y: 6, w: 12, d: 1 },
    { type: "selective-racking", x: 2, y: 9, w: 12, d: 1 },
    { type: "conveyor", x: 16, y: 6, w: 1, d: 10 },
    { type: "agv", x: 18, y: 6, w: 4, d: 1 },
    { type: "pack-station", x: 2, y: 20 }, { type: "pack-station", x: 6, y: 20 }, { type: "pack-station", x: 10, y: 20 },
    { type: "dock-out", x: 2, y: 23 }, { type: "dock-out", x: 6, y: 23 }, { type: "dock-out", x: 10, y: 23 },
  ]),
  gridW: 40, gridH: 24, cell: 1, config: baseCfg,
};
const kBase = W.kpis(W.runOperations(base, { seed: 5 }), base);
const kAug = W.kpis(W.runOperations(augmented, { seed: 5 }), augmented);
check("more docks + automation + pack stations -> higher throughput",
  kAug.throughputUnitsPerHr > kBase.throughputUnitsPerHr,
  kBase.throughputUnitsPerHr.toFixed(1) + " -> " + kAug.throughputUnitsPerHr.toFixed(1) + " units/hr");

/* ---------------------------------------------------------------------
 * 11. Monotonic sanity (stage-level, pure).
 * ------------------------------------------------------------------- */
function capOf(layout, id) {
  return W.capacities(layout, { seed: 1 }).find((s) => s.id === id).capacityUnitsPerHr;
}
const oneDockIn = { elements: mk([{ type: "dock-in", x: 2, y: 0 }, { type: "selective-racking", x: 2, y: 6, w: 8, d: 1 }, { type: "dock-out", x: 2, y: 23 }]), gridW: 40, gridH: 24, cell: 1, config: baseCfg };
const twoDockIn = { elements: mk([{ type: "dock-in", x: 2, y: 0 }, { type: "dock-in", x: 6, y: 0 }, { type: "selective-racking", x: 2, y: 6, w: 8, d: 1 }, { type: "dock-out", x: 2, y: 23 }]), gridW: 40, gridH: 24, cell: 1, config: baseCfg };
check("receiving capacity strictly increases with more dock-in doors",
  capOf(twoDockIn, "receiving") > capOf(oneDockIn, "receiving"),
  capOf(oneDockIn, "receiving").toFixed(0) + " -> " + capOf(twoDockIn, "receiving").toFixed(0));

const oneDockOut = oneDockIn;
const twoDockOut = { elements: mk([{ type: "dock-in", x: 2, y: 0 }, { type: "selective-racking", x: 2, y: 6, w: 8, d: 1 }, { type: "dock-out", x: 2, y: 23 }, { type: "dock-out", x: 6, y: 23 }]), gridW: 40, gridH: 24, cell: 1, config: baseCfg };
check("shipping capacity strictly increases with more dock-out doors",
  capOf(twoDockOut, "shipping") > capOf(oneDockOut, "shipping"),
  capOf(oneDockOut, "shipping").toFixed(0) + " -> " + capOf(twoDockOut, "shipping").toFixed(0));

const noAuto = oneDockIn;
const withAuto = { elements: mk([{ type: "dock-in", x: 2, y: 0 }, { type: "selective-racking", x: 2, y: 6, w: 8, d: 1 }, { type: "conveyor", x: 12, y: 6, w: 1, d: 6 }, { type: "dock-out", x: 2, y: 23 }]), gridW: 40, gridH: 24, cell: 1, config: baseCfg };
check("put-away capacity strictly increases with an automation lane",
  capOf(withAuto, "put-away") > capOf(noAuto, "put-away"),
  capOf(noAuto, "put-away").toFixed(0) + " -> " + capOf(withAuto, "put-away").toFixed(0));

/* ---------------------------------------------------------------------
 * 12. Honesty: SYNTHETIC label + KPI source notes + ISO 22400 citation.
 * ------------------------------------------------------------------- */
check("SYNTHETIC label present in runOperations result", /SYNTHETIC/.test(r1.dataLabel || ""));
check("SYNTHETIC label present in kpis result", /SYNTHETIC/.test(K.dataLabel || ""));
const everyKpiHasSource = K.kpis.every((x) => typeof x.source === "string" && x.source.length > 10);
check("every KPI carries a non-empty source/definition note", everyKpiHasSource);
const citesIso = K.kpis.some((x) => /ISO 22400/.test(x.source));
check("KPI sources cite ISO 22400 (grounded, not certified)", citesIso);
check("model is honestly labelled NOT a certification", /NOT a certification/i.test(r1.dataLabel || ""));

/* ---------------------------------------------------------------------
 * 13. capacities() returns exactly 7 stage entries.
 * ------------------------------------------------------------------- */
const caps = W.capacities(layoutA, { seed: 42 });
check("capacities() returns 7 stage entries", caps.length === 7 && caps.every((c) => c.id && finite(c.capacityUnitsPerHr)));

console.log("");
console.log(failures === 0 ? "ALL WMS CHECKS PASSED (" + checks + " checks)" : failures + " OF " + checks + " WMS CHECKS FAILED");
process.exit(failures === 0 ? 0 : 1);
