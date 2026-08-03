/* =====================================================================
 * verify_compare.js - Scenario A/B compare verification (v1.2).
 *
 * Runs the REAL app modules (domain, knowledge, simulation, compliance,
 * generate, examples, wms, automation, wmsdata, storage, report,
 * scenarios, compare) in Node under the same window shim the other
 * harnesses use and asserts the WT.compare contract + its CROSS-
 * CONSISTENCY with every source module - so a compared side can never
 * drift from the app:
 *
 *   1.  API surface: sources / resolve / metricsFor / compare + SECTIONS
 *       + METRICS + HONESTY.
 *   2.  metricsFor CARRIES the full WT.report.build output verbatim
 *       (deep-equal) - a side is literally the app's report, so it can't
 *       drift; byKey values EQUAL the report's own fields.
 *   3.  Layout metrics: elementCount / storageCapacity (== sum of
 *       WT.domain.elementCapacity) / floorUse EQUAL report.layout.
 *   4.  WMS CROSS-CONSISTENCY: a side's throughput / cycle / dock-to-stock
 *       / picking / storageUtil EQUAL WT.wms.kpis(WT.wms.runOperations()).
 *   5.  Storage CROSS-CONSISTENCY: occupancy / placed / overflow / A-class
 *       travel / golden EQUAL WT.storage.stats(assign(buildLocations,...)).
 *   6.  Automation CROSS-CONSISTENCY: automation throughput EQUALS
 *       WT.automation.report(layout, demand).throughput.totalUnitsPerHr.
 *   7.  Compliance CROSS-CONSISTENCY: pass / warn / fail EQUAL
 *       WT.compliance.check(layout, cfg).summary.
 *   8.  Deltas are correct arithmetic: absolute == B-A (rounded) and
 *       pct == (B-A)/|A|*100 (rounded), for every available metric.
 *   9.  DETERMINISM: same layouts + timestamp -> byte-identical result;
 *       the deltas are INDEPENDENT of the timestamp (header-only).
 *  10.  Comparing a layout to ITSELF -> every delta zero (absolute 0,
 *       pct 0) and a "tie" / neutral verdict (never a/b).
 *  11.  Runs across an examples.js layout vs a GENERATED layout (all
 *       metrics present, a summary produced).
 *  12.  sources() lists the current layout + the built-in examples + the
 *       user's saved scenarios (injected store); current is marked
 *       unavailable (not dropped) when no current layout is supplied.
 *  13.  resolve() resolves current / example / saved to a layout snapshot
 *       through the SAME builders the app uses.
 *  14.  HONESTY: SYNTHETIC / NOT a certification / NOT measured / informed
 *       by ISO/DIN/VDI, restated on the module + every result.
 *  15.  Better/worse is applied ONLY to unambiguous metrics: neutral
 *       metrics NEVER carry a verdict; unambiguous metrics that differ
 *       always do; the roster contains both higher- and lower-is-better.
 *  16.  metricsFor is deterministic given a timestamp and marks
 *       unavailable sections (no-storage floor) rather than throwing.
 *
 * Everything is deterministic (seeded, never wall-clock for the compared
 * numbers). Usage:  node verify_compare.js
 * ASCII-only output. Exit 0 = all checks pass.
 * ===================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

global.window = global; // app modules attach themselves to window.WT
for (const f of [
  "domain.js", "knowledge.js", "simulation.js", "compliance.js",
  "generate.js", "nlcommands.js", "examples.js", "wms.js", "automation.js",
  "wmsdata.js", "storage.js", "report.js", "scenarios.js", "compare.js",
]) {
  // eslint-disable-next-line no-eval
  (0, eval)(fs.readFileSync(path.join(__dirname, f), "utf8"));
}
const WT = global.WT;
const D = WT.domain;
const C = WT.compliance;
const W = WT.wms;
const A = WT.automation;
const ST = WT.storage;
const DATA = WT.wmsdata;
const EX = WT.examples;
const R = WT.report;
const CMP = WT.compare;

let failures = 0;
let checks = 0;
function check(name, ok, detail) {
  checks++;
  console.log((ok ? "[PASS] " : "[FAIL] ") + name + (detail ? " - " + detail : ""));
  if (!ok) failures++;
}
function deepEq(a, b) { try { assert.deepStrictEqual(a, b); return true; } catch (_) { return false; } }
function roundTo(v, dp) { if (!isFinite(v)) return null; const f = Math.pow(10, dp); const r = Math.round(v * f) / f; return r === 0 ? 0 : r; }

// ---- fixture helpers (same shape the other harnesses use) -----------
function mk(list) {
  let i = 0;
  return list.map((e) => {
    const def = D.ELEMENTS[e.type] || {};
    return { id: "el-" + ++i, type: e.type, x: e.x, y: e.y, w: e.w || def.w, d: e.d || def.d };
  });
}
function layout(list, cfg) {
  return { elements: mk(list), gridW: 60, gridH: 40, cell: 1, config: cfg || { seed: 5, strategy: "abc", orders: 200, skuCount: 80, hours: 8, demandSkew: 1 } };
}
const STAMP = "2026-08-03T09:00:00Z";

console.log("Scenario A/B compare verification (deterministic)");
console.log("");

// A full mixed layout (docks + racking + automation + pack) so every
// section produces real numbers on side A.
const fullLayout = layout([
  { type: "dock-in", x: 2, y: 0 },
  { type: "selective-racking", x: 2, y: 6, w: 14, d: 1 },
  { type: "selective-racking", x: 2, y: 9, w: 14, d: 1 },
  { type: "asrs", x: 20, y: 10 },
  { type: "conveyor", x: 2, y: 14, w: 8, d: 1 },
  { type: "conveyor", x: 2, y: 16, w: 8, d: 1 },
  { type: "rgv", x: 24, y: 14, w: 4, d: 1 },
  { type: "agv", x: 24, y: 16, w: 4, d: 1 },
  { type: "pack-station", x: 2, y: 30 },
  { type: "dock-out", x: 2, y: 38 },
]);

// A leaner alternative set-up (different strategy) to compare against.
const leanLayout = layout([
  { type: "dock-in", x: 2, y: 0 },
  { type: "dock-in", x: 6, y: 0 },
  { type: "selective-racking", x: 2, y: 6, w: 10, d: 1 },
  { type: "pack-station", x: 2, y: 30 },
  { type: "dock-out", x: 2, y: 38 },
], { seed: 5, strategy: "random", orders: 200, skuCount: 80, hours: 8, demandSkew: 1 });

const m = CMP.metricsFor(fullLayout, { timestamp: STAMP });
const cfg = m.config;

/* --------------------------------------------------------------------
 * 1. API surface.
 * ------------------------------------------------------------------ */
check("WT.compare exposes sources/resolve/metricsFor/compare + SECTIONS + METRICS + HONESTY",
  CMP && typeof CMP.sources === "function" && typeof CMP.resolve === "function" &&
  typeof CMP.metricsFor === "function" && typeof CMP.compare === "function" &&
  Array.isArray(CMP.SECTIONS) && CMP.SECTIONS.length >= 3 &&
  Array.isArray(CMP.METRICS) && CMP.METRICS.length >= 12 && typeof CMP.HONESTY === "string");

/* --------------------------------------------------------------------
 * 2. metricsFor carries the report verbatim + byKey equals report fields.
 * ------------------------------------------------------------------ */
const reportDirect = R.build(fullLayout, { timestamp: STAMP });
const carriesReport = deepEq(m.report, reportDirect);
const byKeyEqReport =
  m.byKey.elementCount === reportDirect.layout.elementCount &&
  m.byKey.throughputUnitsPerHr === reportDirect.operations.throughputUnitsPerHr &&
  m.byKey.occupancyPct === reportDirect.storage.fillPct &&
  m.byKey.automationThroughput === reportDirect.automation.totalThroughputUnitsPerHr &&
  m.byKey.complianceFail === reportDirect.compliance.summary.fail;
check("metricsFor IS the app's report (deep-equal WT.report.build) + byKey equals report fields (can't drift)",
  carriesReport && byKeyEqReport, "report bytes " + R.toJson(m.report).length);

/* --------------------------------------------------------------------
 * 3. Layout metrics correctness.
 * ------------------------------------------------------------------ */
const els = fullLayout.elements;
const expCap = els.reduce((s, e) => s + D.elementCapacity(e), 0);
const expArea = els.reduce((s, e) => s + e.w * e.d, 0);
const expFloor = Math.round((expArea / (fullLayout.gridW * fullLayout.gridH)) * 1000) / 10;
check("layout metrics: elementCount / storageCapacity (== sum elementCapacity) / floorUse are correct",
  m.byKey.elementCount === els.length && m.byKey.storageCapacity === expCap && m.byKey.floorUsePct === expFloor,
  "els=" + m.byKey.elementCount + " cap=" + m.byKey.storageCapacity + " floor=" + m.byKey.floorUsePct + "%");

/* --------------------------------------------------------------------
 * 4. WMS CROSS-CONSISTENCY.
 * ------------------------------------------------------------------ */
const run = W.runOperations(fullLayout, { orders: cfg.orders, hours: cfg.hours, seed: cfg.seed });
const kp = W.kpis(run, fullLayout);
const wmsOk =
  m.byKey.throughputUnitsPerHr === kp.throughputUnitsPerHr &&
  m.byKey.throughputOrdersPerHr === kp.throughputOrdersPerHr &&
  m.byKey.orderCycleTimeMin === kp.orderCycleTimeMin &&
  m.byKey.dockToStockMin === kp.dockToStockMin &&
  m.byKey.pickingLinesPerHr === kp.pickingLinesPerHr &&
  m.byKey.storageUtilPct === kp.storageUtilPct;
check("WMS metrics EQUAL WT.wms.kpis(runOperations) (throughput/cycle/dock-to-stock/picking/util) (cross-consistency)",
  wmsOk, "thr " + m.byKey.throughputUnitsPerHr.toFixed(1));

/* --------------------------------------------------------------------
 * 5. Storage CROSS-CONSISTENCY (rebuild the identical assignment).
 * ------------------------------------------------------------------ */
const bundle = DATA.generate({ skuCount: cfg.skuCount, orders: cfg.orders, seed: cfg.seed, demandSkew: cfg.demandSkew });
const asg = ST.assign(ST.buildLocations(fullLayout), bundle.skuMaster, { strategy: cfg.strategy, seed: cfg.seed });
const sst = ST.stats(asg);
const storeOk =
  m.byKey.occupancyPct === sst.fillPct &&
  m.byKey.placedCount === sst.placedCount &&
  m.byKey.overflowCount === sst.unplacedCount &&
  m.byKey.aClassTravelM === sst.placement.avgDistAClassM &&
  m.byKey.goldenAClassPct === sst.golden.aClassPct;
check("storage metrics EQUAL WT.storage.stats(assign(...)) (occupancy/placed/overflow/A-travel/golden) (cross-consistency)",
  storeOk, "fill " + m.byKey.occupancyPct.toFixed(1) + "% A-travel " + m.byKey.aClassTravelM.toFixed(1) + "m");

/* --------------------------------------------------------------------
 * 6. Automation CROSS-CONSISTENCY.
 * ------------------------------------------------------------------ */
const demand = m.byKey.throughputUnitsPerHr;
const arep = A.report(fullLayout, demand);
check("automation throughput EQUALS WT.automation.report(layout, demand).throughput.totalUnitsPerHr (cross-consistency)",
  m.byKey.automationThroughput === arep.throughput.totalUnitsPerHr,
  "auto " + m.byKey.automationThroughput + " u/hr");

/* --------------------------------------------------------------------
 * 7. Compliance CROSS-CONSISTENCY.
 * ------------------------------------------------------------------ */
const cc = C.check(fullLayout, cfg);
check("compliance pass/warn/fail EQUAL WT.compliance.check(layout, cfg).summary (cross-consistency)",
  m.byKey.compliancePass === cc.summary.pass && m.byKey.complianceWarn === cc.summary.warn && m.byKey.complianceFail === cc.summary.fail,
  JSON.stringify({ pass: m.byKey.compliancePass, warn: m.byKey.complianceWarn, fail: m.byKey.complianceFail }));

/* --------------------------------------------------------------------
 * 8. Delta arithmetic (absolute == B-A, pct == (B-A)/|A|*100).
 * ------------------------------------------------------------------ */
const cmp = CMP.compare(fullLayout, leanLayout, { timestamp: STAMP });
let arithOk = cmp.deltas.length === CMP.METRICS.length;
let arithDetail = "";
for (const d of cmp.deltas) {
  const av = cmp.a.byKey[d.key], bv = cmp.b.byKey[d.key];
  if (!d.available) { arithOk = arithOk && d.absolute === null && d.pct === null; continue; }
  const expAbs = roundTo(bv - av, 4);
  let expPct;
  if (av === bv) expPct = 0; else if (av === 0) expPct = null; else expPct = roundTo(((bv - av) / Math.abs(av)) * 100, 1);
  if (d.absolute !== expAbs || d.pct !== expPct) { arithOk = false; arithDetail = d.key + " abs " + d.absolute + " vs " + expAbs + " / pct " + d.pct + " vs " + expPct; }
}
check("deltas are correct arithmetic: absolute == B-A and pct == (B-A)/|A|*100 for every available metric", arithOk, arithDetail);

/* --------------------------------------------------------------------
 * 9. Determinism (+ deltas independent of the timestamp).
 * ------------------------------------------------------------------ */
const cmp2 = CMP.compare(fullLayout, leanLayout, { timestamp: STAMP });
const cmpOtherStamp = CMP.compare(fullLayout, leanLayout, { timestamp: "2020-01-01T00:00:00Z" });
const detOk =
  JSON.stringify(cmp) === JSON.stringify(cmp2) &&
  JSON.stringify(cmp.deltas) === JSON.stringify(cmpOtherStamp.deltas);
check("determinism: same layouts + timestamp -> identical bytes; deltas are timestamp-independent (header-only)", detOk);

/* --------------------------------------------------------------------
 * 10. Comparing a layout to ITSELF -> all-zero deltas.
 * ------------------------------------------------------------------ */
const self = CMP.compare(fullLayout, fullLayout, { timestamp: STAMP });
const availSelf = self.deltas.filter((d) => d.available);
const selfOk = availSelf.length > 0 && availSelf.every((d) => d.absolute === 0 && d.pct === 0 && (d.better === "tie" || d.better === null));
check("comparing a layout to ITSELF yields all-zero deltas (absolute 0, pct 0, no a/b verdict)", selfOk,
  availSelf.length + " available metrics");

/* --------------------------------------------------------------------
 * 11. Runs across an examples.js layout vs a GENERATED layout.
 * ------------------------------------------------------------------ */
const exB = EX.build(EX.library[0].id);
const exLayout = { elements: exB.elements, gridW: exB.gridW, gridH: exB.gridH, cell: D.METRES_PER_CELL, config: exB.config, meta: exB.meta };
const genKey = Object.keys(WT.generate.plantProfiles)[0];
const gen = WT.generate.generateLayout(genKey, { seed: 11 });
const genLayout = { elements: gen.elements, gridW: gen.gridW, gridH: gen.gridH, cell: D.METRES_PER_CELL, config: gen.config };
const exGen = CMP.compare(exLayout, genLayout, { timestamp: STAMP });
const exGenOk =
  exGen.deltas.length === CMP.METRICS.length &&
  exGen.a.report && exGen.b.report &&
  exGen.summary && typeof exGen.summary.headline === "string" && Array.isArray(exGen.summary.points);
check("runs across an examples.js layout vs a generated layout (all metrics + a plain-language summary)", exGenOk,
  EX.library[0].id + " vs " + genKey);

/* --------------------------------------------------------------------
 * 12. sources() lists current + examples + saved; current honestly marked.
 * ------------------------------------------------------------------ */
const store = WT.scenarios.create({ store: WT.scenarios.memStore() });
store.save("My saved plant", { version: "wt-1", gridW: 60, gridH: 40, cell: 1, elements: fullLayout.elements.map((e) => ({ id: e.id, type: e.type, x: e.x, y: e.y, w: e.w, d: e.d })), config: cfg }, { savedAt: "2026-08-03T10:00:00Z" });
const srcs = CMP.sources({ current: fullLayout, examples: EX, scenarios: store });
const kinds = srcs.map((s) => s.kind);
const curSrc = srcs.find((s) => s.kind === "current");
const srcsNoCurrent = CMP.sources({ examples: EX });
const curOmitted = srcsNoCurrent.find((s) => s.kind === "current");
const sourcesOk =
  kinds.indexOf("current") !== -1 && kinds.indexOf("example") !== -1 && kinds.indexOf("saved") !== -1 &&
  curSrc.available === true && curOmitted && curOmitted.available === false &&
  srcs.filter((s) => s.kind === "example").length === EX.library.length;
check("sources() lists current + examples + saved; current marked unavailable (not dropped) when absent", sourcesOk,
  srcs.length + " sources (" + EX.library.length + " examples)");

/* --------------------------------------------------------------------
 * 13. resolve() resolves current / example / saved to a layout snapshot.
 * ------------------------------------------------------------------ */
const rCur = CMP.resolve({ kind: "current", id: "current" }, { current: fullLayout });
const rEx = CMP.resolve({ kind: "example", id: EX.library[0].id }, { examples: EX });
const saved0 = store.list()[0];
const rSaved = CMP.resolve({ kind: "saved", id: saved0.slug, name: saved0.name }, { scenarios: store });
const resolveOk =
  rCur === fullLayout &&
  rEx && Array.isArray(rEx.elements) && rEx.elements.length > 0 &&
  rSaved && Array.isArray(rSaved.elements) && rSaved.elements.length > 0 &&
  // and a resolved side is comparable end-to-end:
  CMP.compare(rEx, rSaved, { timestamp: STAMP }).deltas.length === CMP.METRICS.length;
check("resolve() resolves current / example / saved to a layout snapshot (same builders the app uses)", resolveOk);

/* --------------------------------------------------------------------
 * 14. Honesty labels.
 * ------------------------------------------------------------------ */
const H = CMP.HONESTY;
const honestyOk =
  /SYNTHETIC/.test(H) && /NOT a certification/i.test(H) && /NOT measured/i.test(H) &&
  /ISO 22400/.test(H) && /DIN 15185/.test(H) && /VDI/.test(H) &&
  cmp.honesty === H && m.honesty === H;
check("honesty: SYNTHETIC / NOT a certification / NOT measured / informed by ISO/DIN/VDI (module + every result)", honestyOk);

/* --------------------------------------------------------------------
 * 15. Better/worse only on unambiguous metrics.
 * ------------------------------------------------------------------ */
const neutralNeverScored = cmp.deltas.every((d) => d.dir !== "neutral" || d.better === null);
const unambiguousAlwaysScored = cmp.deltas.every((d) => !(d.available && d.dir !== "neutral" && d.a !== d.b) || (d.better === "a" || d.better === "b"));
const rosterHasBothDirs =
  CMP.METRICS.some((x) => x.dir === "higher") && CMP.METRICS.some((x) => x.dir === "lower") && CMP.METRICS.some((x) => x.dir === "neutral");
// The neutral automation metric explicitly stays neutral (more automation != better).
const autoDelta = cmp.deltas.find((d) => d.key === "automationThroughput");
const autoNeutral = !autoDelta || (autoDelta.dir === "neutral" && autoDelta.better === null);
check("better/worse applied ONLY to unambiguous metrics (neutral never scored; unambiguous differing always scored; both dirs present)",
  neutralNeverScored && unambiguousAlwaysScored && rosterHasBothDirs && autoNeutral,
  "neutral-clean=" + neutralNeverScored + " unambiguous-scored=" + unambiguousAlwaysScored);

/* --------------------------------------------------------------------
 * 16. Deterministic + marks unavailable sections (no-storage floor).
 * ------------------------------------------------------------------ */
const noStoreLayout = layout([
  { type: "dock-in", x: 2, y: 0 },
  { type: "pack-station", x: 2, y: 20 },
  { type: "dock-out", x: 2, y: 38 },
]);
const mNoStore = CMP.metricsFor(noStoreLayout, { timestamp: STAMP });
const mNoStore2 = CMP.metricsFor(noStoreLayout, { timestamp: STAMP });
const markOk =
  mNoStore.available.occupancyPct === false && mNoStore.byKey.occupancyPct === null &&
  mNoStore.available.throughputUnitsPerHr === false && // ops can't run without storage
  mNoStore.available.elementCount === true &&
  JSON.stringify(mNoStore) === JSON.stringify(mNoStore2);
check("metricsFor marks unavailable sections (no-storage floor -> storage/ops null, layout still present) + deterministic", markOk,
  "occ.avail=" + mNoStore.available.occupancyPct + " ops.avail=" + mNoStore.available.throughputUnitsPerHr);

console.log("");
console.log(failures === 0 ? "ALL COMPARE CHECKS PASSED (" + checks + " checks)" : failures + " OF " + checks + " COMPARE CHECKS FAILED");
process.exit(failures === 0 ? 0 : 1);
