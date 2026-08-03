/* =====================================================================
 * verify_automation.js - Automation systems modeling verification (P6).
 *
 * Runs the REAL app modules (domain.js, knowledge.js, simulation.js,
 * wms.js, automation.js) in Node under the same window shim the other
 * harnesses use and asserts the WT.automation contract + its wiring into
 * the KB and the WMS capacity layer:
 *
 *   1.  API surface: systems / throughput / utilisation / report / PARAMS
 *       + SYNTHETIC_LABEL present.
 *   2.  systems() detects EACH automation type and counts correctly
 *       (asrs / shuttle / rgv / agv / conveyor).
 *   3.  Each system's per-unit throughput is the KB cycle-time param and
 *       throughput == count x per-unit (deterministic).
 *   4.  systems() is deterministic (byte-identical JSON on re-run).
 *   5.  Throughput scales with COUNT (2 conveyors == 2x one conveyor).
 *   6.  throughput() aggregates correctly + maps to the WMS stages served
 *       (per-stage present; AS/RS feeds storage).
 *   7.  Throughput scales with the KB CYCLE-TIME param: doubling
 *       auto.asrs.cyclesPerHr doubles the AS/RS throughput (proves KB
 *       wiring); reset restores it.
 *   8.  The SAME KB edit flows into WT.wms: raising auto.asrs.cyclesPerHr
 *       raises the WMS storage capacity; reset restores it exactly.
 *   9.  utilisation is demand / throughput (utilisationPct check).
 *  10.  Over-capacity is flagged HONESTLY (demand > throughput -> util>100%,
 *       overCapacity true).
 *  11.  report() identifies the automation CONSTRAINT (highest utilisation
 *       / lowest throughput system).
 *  12.  report() on a NO-automation layout: hasAutomation false + a plain
 *       "fully manual" summary, no constraint.
 *  13.  NO-AUTOMATION REGRESSION GUARANTEE: with no automation elements the
 *       WMS automation multiplier is exactly 1 for every stage (total
 *       automation throughput 0), so a stage capacity equals its raw manual
 *       formula - identical to the pre-P6 behaviour. runOperations stays
 *       deterministic.
 *  14.  report() is deterministic (byte-identical JSON for a fixed demand).
 *  15.  Honesty: SYNTHETIC_LABEL cites VDI and says NOT measured / NOT a
 *       vendor spec / NOT a certification; every system carries a source +
 *       note; PARAMS.systems tie to KB ids.
 *  16.  KB drift guard: the auto.* KB defaults trace to the domain model
 *       (AS/RS & shuttle cycleSec; RGV/AGV/conveyor movesPerHr/unitsPerHr).
 *  17.  Monotonic: adding an automation element raises the aggregate
 *       automation throughput AND a served stage's WMS capacity.
 *
 * Everything is deterministic (seeded, never wall-clock). Usage:
 *   node verify_automation.js
 * ASCII-only output. Exit 0 = all checks pass.
 * ===================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");

global.window = global; // app modules attach themselves to window.WT
for (const f of ["domain.js", "knowledge.js", "simulation.js", "wms.js", "automation.js"]) {
  // eslint-disable-next-line no-eval
  (0, eval)(fs.readFileSync(path.join(__dirname, f), "utf8"));
}
const WT = global.WT;
const D = WT.domain;
const W = WT.wms;
const A = WT.automation;
const kb = WT.kb;

let failures = 0;
let checks = 0;
function check(name, ok, detail) {
  checks++;
  console.log((ok ? "[PASS] " : "[FAIL] ") + name + (detail ? " - " + detail : ""));
  if (!ok) failures++;
}
const finite = (v) => typeof v === "number" && isFinite(v);
const approx = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 1e-6 : eps);

// ---- fixture helpers ------------------------------------------------
function mk(list) {
  let i = 0;
  return list.map((e) => {
    const def = D.ELEMENTS[e.type] || {};
    return { id: "el-" + ++i, type: e.type, x: e.x, y: e.y, w: e.w || def.w, d: e.d || def.d };
  });
}
function layout(list, cfg) {
  return { elements: mk(list), gridW: 60, gridH: 40, cell: 1, config: cfg || { seed: 5, strategy: "abc", orders: 200, skuCount: 80 } };
}
const capOf = (lay, id) => W.capacities(lay, { seed: 5 }).find((s) => s.id === id).capacityUnitsPerHr;

console.log("Automation systems modeling verification (deterministic)");
console.log("");

// A mixed automation layout: 2 conveyor, 1 rgv, 1 agv, 1 asrs, 1 shuttle,
// plus storage + docks + pack so the WMS run is valid.
const mixLayout = layout([
  { type: "dock-in", x: 2, y: 0 },
  { type: "selective-racking", x: 2, y: 6, w: 12, d: 1 },
  { type: "asrs", x: 2, y: 10 },
  { type: "shuttle", x: 12, y: 10 },
  { type: "conveyor", x: 2, y: 14, w: 6, d: 1 },
  { type: "conveyor", x: 2, y: 16, w: 6, d: 1 },
  { type: "rgv", x: 20, y: 14, w: 4, d: 1 },
  { type: "agv", x: 20, y: 16, w: 4, d: 1 },
  { type: "pack-station", x: 2, y: 30 },
  { type: "dock-out", x: 2, y: 38 },
]);
const noAutoLayout = layout([
  { type: "dock-in", x: 2, y: 0 },
  { type: "selective-racking", x: 2, y: 6, w: 8, d: 1 },
  { type: "pack-station", x: 2, y: 30 },
  { type: "dock-out", x: 2, y: 38 },
]);

/* --------------------------------------------------------------------
 * 1. API surface.
 * ------------------------------------------------------------------ */
check("WT.automation exposes systems/throughput/utilisation/report/PARAMS + label",
  A && typeof A.systems === "function" && typeof A.throughput === "function" &&
  typeof A.utilisation === "function" && typeof A.report === "function" &&
  A.PARAMS && typeof A.PARAMS === "object" && typeof A.SYNTHETIC_LABEL === "string");

/* --------------------------------------------------------------------
 * 2. systems() detects each type + correct counts.
 * ------------------------------------------------------------------ */
const sys = A.systems(mixLayout);
const byType = {};
for (const s of sys) byType[s.type] = s;
const countsOk =
  byType.conveyor && byType.conveyor.count === 2 &&
  byType.rgv && byType.rgv.count === 1 &&
  byType.agv && byType.agv.count === 1 &&
  byType.asrs && byType.asrs.count === 1 &&
  byType.shuttle && byType.shuttle.count === 1 &&
  sys.length === 5;
check("systems() detects each automation type with correct counts", countsOk,
  sys.map((s) => s.type + "x" + s.count).join(", "));

/* --------------------------------------------------------------------
 * 3. Per-unit throughput == KB cycle-time; throughput == count x per-unit.
 * ------------------------------------------------------------------ */
const asrsPerUnit = kb.get("auto.asrs.cyclesPerHr");
const convPerUnit = kb.get("auto.conveyor.unitsPerHr");
const perUnitOk =
  approx(byType.asrs.perUnitThroughputUnitsPerHr, asrsPerUnit) &&
  approx(byType.conveyor.perUnitThroughputUnitsPerHr, convPerUnit) &&
  approx(byType.asrs.throughputUnitsPerHr, byType.asrs.count * asrsPerUnit) &&
  approx(byType.conveyor.throughputUnitsPerHr, byType.conveyor.count * convPerUnit);
check("per-unit throughput == KB cycle-time param; total == count x per-unit", perUnitOk,
  "asrs " + byType.asrs.perUnitThroughputUnitsPerHr + " (kb " + asrsPerUnit + "), conveyor " +
  byType.conveyor.throughputUnitsPerHr + " = 2 x " + convPerUnit);

/* --------------------------------------------------------------------
 * 4. systems() deterministic.
 * ------------------------------------------------------------------ */
check("systems() is deterministic (byte-identical JSON on re-run)",
  JSON.stringify(A.systems(mixLayout)) === JSON.stringify(A.systems(mixLayout)));

/* --------------------------------------------------------------------
 * 5. Throughput scales with COUNT.
 * ------------------------------------------------------------------ */
const oneConv = A.systems(layout([{ type: "conveyor", x: 2, y: 6, w: 6, d: 1 }]));
const twoConv = A.systems(layout([{ type: "conveyor", x: 2, y: 6, w: 6, d: 1 }, { type: "conveyor", x: 2, y: 8, w: 6, d: 1 }]));
const oneThr = A.throughput(oneConv).totalUnitsPerHr;
const twoThr = A.throughput(twoConv).totalUnitsPerHr;
check("throughput scales with count (2 conveyors == 2x one conveyor)",
  oneThr > 0 && approx(twoThr, 2 * oneThr),
  oneThr + " -> " + twoThr);

/* --------------------------------------------------------------------
 * 6. throughput() aggregates + maps to the WMS stages served.
 * ------------------------------------------------------------------ */
const tp = A.throughput(sys);
const sumSys = sys.reduce((a, s) => a + s.throughputUnitsPerHr, 0);
const stagesPresent = ["receiving", "put-away", "storage", "replenishment", "packing", "shipping"].every((k) => k in tp.perStage);
check("throughput() total == sum of systems + per-stage map spans the 6 automatable stages",
  approx(tp.totalUnitsPerHr, sumSys) && stagesPresent && tp.perStage.storage > 0,
  "total=" + tp.totalUnitsPerHr.toFixed(0) + " storage-fed=" + tp.perStage.storage.toFixed(0));

/* --------------------------------------------------------------------
 * 7. Throughput scales with the KB CYCLE-TIME param (KB wiring proof).
 * ------------------------------------------------------------------ */
const asrsBefore = A.systems(mixLayout).find((s) => s.type === "asrs").throughputUnitsPerHr;
const setOk = kb.set("auto.asrs.cyclesPerHr", asrsPerUnit * 2);
const asrsAfter = A.systems(mixLayout).find((s) => s.type === "asrs").throughputUnitsPerHr;
kb.reset("auto.asrs.cyclesPerHr");
const asrsReset = A.systems(mixLayout).find((s) => s.type === "asrs").throughputUnitsPerHr;
check("editing auto.asrs.cyclesPerHr scales AS/RS throughput (KB wiring), reset restores it",
  setOk && approx(asrsAfter, 2 * asrsBefore) && approx(asrsReset, asrsBefore),
  asrsBefore + " -> " + asrsAfter + " -> " + asrsReset);

/* --------------------------------------------------------------------
 * 8. The SAME KB edit flows into WT.wms stage capacities.
 * ------------------------------------------------------------------ */
const storageCapBefore = capOf(mixLayout, "storage");
kb.set("auto.asrs.cyclesPerHr", asrsPerUnit * 4);
const storageCapAfter = capOf(mixLayout, "storage");
kb.reset("auto.asrs.cyclesPerHr");
const storageCapReset = capOf(mixLayout, "storage");
check("KB cycle-time edit changes WT.wms storage capacity; reset restores exactly",
  storageCapAfter > storageCapBefore + 1e-6 && approx(storageCapReset, storageCapBefore),
  storageCapBefore.toFixed(1) + " -> " + storageCapAfter.toFixed(1) + " -> " + storageCapReset.toFixed(1));

/* --------------------------------------------------------------------
 * 9. utilisation is demand / throughput.
 * ------------------------------------------------------------------ */
const util = A.utilisation(sys, 100);
const uAsrs = util.find((u) => u.type === "asrs");
check("utilisation == 100 * demand / throughput", uAsrs && approx(uAsrs.utilisationPct, 100 * 100 / uAsrs.throughputUnitsPerHr),
  uAsrs ? uAsrs.utilisationPct.toFixed(1) + "% @ demand 100 / thr " + uAsrs.throughputUnitsPerHr : "no asrs");

/* --------------------------------------------------------------------
 * 10. Over-capacity flagged honestly.
 * ------------------------------------------------------------------ */
const asrsOnly = layout([
  { type: "dock-in", x: 2, y: 0 }, { type: "asrs", x: 2, y: 6 },
  { type: "pack-station", x: 2, y: 30 }, { type: "dock-out", x: 2, y: 38 },
]);
const asrsThr = A.systems(asrsOnly).find((s) => s.type === "asrs").throughputUnitsPerHr;
const overUtil = A.utilisation(A.systems(asrsOnly), asrsThr + 50);
check("over-capacity is flagged HONESTLY (demand > throughput -> util>100%, overCapacity)",
  overUtil.length === 1 && overUtil[0].overCapacity === true && overUtil[0].utilisationPct > 100,
  overUtil[0].utilisationPct.toFixed(0) + "% overCapacity=" + overUtil[0].overCapacity);

/* --------------------------------------------------------------------
 * 11. report() identifies the automation constraint.
 * ------------------------------------------------------------------ */
const rep = A.report(mixLayout, 100);
// Lowest-throughput system is the AGV (1 x 30 u/hr) -> highest utilisation.
check("report() identifies the automation constraint (lowest-throughput system)",
  rep.constraint.present === true && rep.constraint.type === "agv" &&
  typeof rep.constraint.plain === "string" && rep.constraint.plain.length > 20,
  rep.constraint.present ? rep.constraint.type + " @ " + rep.constraint.utilisationPct.toFixed(0) + "%" : "none");

/* --------------------------------------------------------------------
 * 12. report() on a NO-automation layout.
 * ------------------------------------------------------------------ */
const repNo = A.report(noAutoLayout, 100);
check("report() on a no-automation layout: fully manual, no constraint",
  repNo.hasAutomation === false && repNo.systems.length === 0 &&
  repNo.constraint.present === false && /manual/i.test(repNo.summary),
  repNo.summary.slice(0, 60) + "...");

/* --------------------------------------------------------------------
 * 13. NO-AUTOMATION REGRESSION GUARANTEE (the load-bearing guard).
 *     With no automation elements every stage multiplier is EXACTLY 1 and
 *     the total automation throughput is 0, so wms behaves as before P6.
 * ------------------------------------------------------------------ */
const statsNo = W.layoutStats(noAutoLayout);
const boostNo = W.automationBoost(statsNo);
const allMultOne = Object.keys(boostNo.mult).every((k) => boostNo.mult[k] === 1);
// receiving with 1 dock-in, no inbound chain -> raw manual formula = 1 * rate.
const rawReceiving = 1 * W.PARAMS.receiveUnitsPerDockHr;
const receivingCap = capOf(noAutoLayout, "receiving");
const regressOk = allMultOne && boostNo.totalUnitsPerHr === 0 && approx(receivingCap, rawReceiving);
check("no automation -> every stage multiplier == 1, total automation throughput 0 (regression guarantee)",
  regressOk,
  "mult all 1=" + allMultOne + ", total=" + boostNo.totalUnitsPerHr + ", receiving=" + receivingCap.toFixed(1) + " vs raw " + rawReceiving);
const rn1 = W.runOperations(noAutoLayout, { seed: 5, orders: 200, hours: 8 });
const rn2 = W.runOperations(noAutoLayout, { seed: 5, orders: 200, hours: 8 });
check("runOperations deterministic on the no-automation layout", JSON.stringify(rn1) === JSON.stringify(rn2));

/* --------------------------------------------------------------------
 * 14. report() deterministic (fixed demand -> byte-identical).
 * ------------------------------------------------------------------ */
check("report() is deterministic for a fixed demand (byte-identical JSON)",
  JSON.stringify(A.report(mixLayout, 250)) === JSON.stringify(A.report(mixLayout, 250)));

/* --------------------------------------------------------------------
 * 15. Honesty labels.
 * ------------------------------------------------------------------ */
const lbl = A.SYNTHETIC_LABEL;
const honestyOk = /VDI/.test(lbl) && /NOT measured/i.test(lbl) && /NOT a vendor spec/i.test(lbl) && /NOT a certification/i.test(lbl);
check("SYNTHETIC label cites VDI and says NOT measured / NOT a vendor spec / NOT a certification", honestyOk);
const everySysLabelled = sys.every((s) => s.source && s.source.length > 10 && s.note && /NOT/i.test(s.note) && s.kbId);
check("every system carries a source + honest note + its KB id", everySysLabelled);
check("PARAMS.systems tie every automation type to a KB id",
  A.PARAMS.systems.length === 5 && A.PARAMS.systems.every((p) => typeof p.kbId === "string" && p.kbId.indexOf("auto.") === 0));

/* --------------------------------------------------------------------
 * 16. KB drift guard: the auto.* defaults trace to the domain model.
 * ------------------------------------------------------------------ */
const driftOk =
  kb.get("auto.asrs.cyclesPerHr") === Math.round(3600 / D.ELEMENTS.asrs.cycleSec) &&
  kb.get("auto.shuttle.cyclesPerHr") === Math.round(3600 / D.ELEMENTS.shuttle.cycleSec) &&
  kb.get("auto.rgv.movesPerHr") === D.ELEMENTS.rgv.movesPerHr &&
  kb.get("auto.agv.movesPerHr") === D.ELEMENTS.agv.movesPerHr &&
  kb.get("auto.conveyor.unitsPerHr") === D.ELEMENTS.conveyor.unitsPerHr;
check("auto.* KB defaults trace to the domain model (no drift)", driftOk,
  "asrs=" + kb.get("auto.asrs.cyclesPerHr") + " shuttle=" + kb.get("auto.shuttle.cyclesPerHr") +
  " rgv=" + kb.get("auto.rgv.movesPerHr") + " agv=" + kb.get("auto.agv.movesPerHr") +
  " conveyor=" + kb.get("auto.conveyor.unitsPerHr"));

/* --------------------------------------------------------------------
 * 17. Monotonic: adding an automation element raises throughput + capacity.
 * ------------------------------------------------------------------ */
const baseLay = layout([
  { type: "dock-in", x: 2, y: 0 }, { type: "selective-racking", x: 2, y: 6, w: 8, d: 1 },
  { type: "pack-station", x: 2, y: 30 }, { type: "dock-out", x: 2, y: 38 },
]);
const withConv = layout([
  { type: "dock-in", x: 2, y: 0 }, { type: "selective-racking", x: 2, y: 6, w: 8, d: 1 },
  { type: "conveyor", x: 2, y: 10, w: 6, d: 1 },
  { type: "pack-station", x: 2, y: 30 }, { type: "dock-out", x: 2, y: 38 },
]);
const totBase = A.throughput(baseLay).totalUnitsPerHr;
const totConv = A.throughput(withConv).totalUnitsPerHr;
check("adding an automation element raises aggregate automation throughput AND a served stage's WMS capacity",
  totConv > totBase && capOf(withConv, "put-away") > capOf(baseLay, "put-away"),
  "auto thr " + totBase + " -> " + totConv + "; put-away cap " + capOf(baseLay, "put-away").toFixed(0) + " -> " + capOf(withConv, "put-away").toFixed(0));

console.log("");
console.log(failures === 0 ? "ALL AUTOMATION CHECKS PASSED (" + checks + " checks)" : failures + " OF " + checks + " AUTOMATION CHECKS FAILED");
process.exit(failures === 0 ? 0 : 1);
