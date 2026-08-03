/* =====================================================================
 * verify_report.js - Consolidated "WMS Report" verification (P7).
 *
 * Runs the REAL app modules (domain, knowledge, simulation, compliance,
 * generate, examples, wms, automation, wmsdata, storage, report) in Node
 * under the same window shim the other harnesses use and asserts the
 * WT.report contract + its CROSS-CONSISTENCY with every source module - so
 * the report can never drift from the app:
 *
 *   1.  API surface: build / toHtml / toJson / toCsv + SECTIONS + HONESTY.
 *   2.  build() aggregates the expected sections (roster == SECTIONS; every
 *       section object present as a top-level field).
 *   3.  Layout summary numbers: element count, storage capacity (==
 *       sum of WT.domain.elementCapacity) and floor-use % are correct.
 *   4.  Compliance CROSS-CONSISTENCY: report.compliance.summary EQUALS
 *       WT.compliance.check(layout, cfg).summary (+ findings count).
 *   5.  WMS CROSS-CONSISTENCY: report throughput / cycle / dock-to-stock /
 *       bottleneck EQUAL WT.wms.kpis(WT.wms.runOperations(...)).
 *   6.  Storage CROSS-CONSISTENCY: report occupancy / capacity / placed
 *       EQUAL WT.storage.stats(assign(buildLocations,...)) for the same
 *       master + strategy + seed.
 *   7.  Automation CROSS-CONSISTENCY: report total throughput + constraint
 *       EQUAL WT.automation.report(layout, demand).
 *   8.  Data-profile CROSS-CONSISTENCY: report SKU / order / ABC stats
 *       EQUAL WT.wmsdata.stats(master, orders).
 *   9.  Standards basis: pulls WT.kb.list() entries (each with a source +
 *       note) and the not-a-certification disclaimer.
 *  10.  toHtml is OFFLINE (no https://, no <script>, no <link>, no url(http,
 *       no external src/href) + contains the honesty banner + every section
 *       header title.
 *  11.  toJson ROUND-TRIPS: JSON.parse(toJson(x)) deep-equals x.
 *  12.  DETERMINISM: same layout + timestamp -> identical html AND json
 *       bytes; toCsv identical too.
 *  13.  Runs on an examples.js layout (all sections; ops ran).
 *  14.  Runs on a GENERATED layout (generate.js) (all sections present).
 *  15.  HONESTY: report.honesty + toHtml restate SYNTHETIC / NOT a
 *       certification / NOT measured / informed by ISO/DIN/VDI.
 *  16.  Not-yet-run marking: a no-automation floor -> automation.available
 *       false + a manual note; a no-storage floor -> operations.ran false +
 *       storage.available false (marked, never thrown).
 *
 * Everything is deterministic (seeded, never wall-clock). Usage:
 *   node verify_report.js
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
  "wmsdata.js", "storage.js", "report.js",
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
const KB = WT.kb;
const EX = WT.examples;
const R = WT.report;

let failures = 0;
let checks = 0;
function check(name, ok, detail) {
  checks++;
  console.log((ok ? "[PASS] " : "[FAIL] ") + name + (detail ? " - " + detail : ""));
  if (!ok) failures++;
}
function deepEq(a, b) { try { assert.deepStrictEqual(a, b); return true; } catch (_) { return false; } }

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

console.log("Consolidated WMS Report verification (deterministic)");
console.log("");

// A full mixed layout: docks + racking + automation + pack, so every
// section produces real numbers.
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

const rep = R.build(fullLayout, { timestamp: STAMP });
const cfg = rep.meta.config;

/* --------------------------------------------------------------------
 * 1. API surface.
 * ------------------------------------------------------------------ */
check("WT.report exposes build/toHtml/toJson/toCsv + SECTIONS + HONESTY",
  R && typeof R.build === "function" && typeof R.toHtml === "function" &&
  typeof R.toJson === "function" && typeof R.toCsv === "function" &&
  Array.isArray(R.SECTIONS) && R.SECTIONS.length >= 8 && typeof R.HONESTY === "string");

/* --------------------------------------------------------------------
 * 2. build() aggregates the expected sections.
 * ------------------------------------------------------------------ */
const wantKeys = ["header", "layout", "compliance", "operations", "storage", "automation", "dataProfile", "standardsBasis"];
const sectionsOk = wantKeys.every((k) => rep[k] && typeof rep[k] === "object") &&
  deepEq(rep.sections.map((s) => s.key), R.SECTIONS.map((s) => s.key)) &&
  deepEq(rep.sections.map((s) => s.key), wantKeys);
check("build() aggregates every expected section (roster == SECTIONS)", sectionsOk,
  rep.sections.map((s) => s.key).join(","));

/* --------------------------------------------------------------------
 * 3. Layout summary numbers.
 * ------------------------------------------------------------------ */
const els = fullLayout.elements;
const expCap = els.reduce((s, e) => s + D.elementCapacity(e), 0);
const expArea = els.reduce((s, e) => s + e.w * e.d, 0);
const expFloor = Math.round((expArea / (fullLayout.gridW * fullLayout.gridH)) * 1000) / 10;
check("layout summary: element count / storage capacity / floor-use % are correct",
  rep.layout.elementCount === els.length &&
  rep.layout.storageCapacityPositions === expCap &&
  rep.layout.floorUsePct === expFloor,
  "els=" + rep.layout.elementCount + " cap=" + rep.layout.storageCapacityPositions + " floor=" + rep.layout.floorUsePct + "%");

/* --------------------------------------------------------------------
 * 4. Compliance CROSS-CONSISTENCY.
 * ------------------------------------------------------------------ */
const cc = C.check(fullLayout, cfg);
check("compliance summary EQUALS WT.compliance.check(layout, cfg).summary (cross-consistency)",
  deepEq(rep.compliance.summary, cc.summary) && rep.compliance.findings.length === cc.findings.length,
  "report " + JSON.stringify(rep.compliance.summary) + " vs module " + JSON.stringify(cc.summary));

/* --------------------------------------------------------------------
 * 5. WMS CROSS-CONSISTENCY.
 * ------------------------------------------------------------------ */
const run = W.runOperations(fullLayout, { orders: cfg.orders, hours: cfg.hours, seed: cfg.seed });
const kp = W.kpis(run, fullLayout);
const wmsOk =
  rep.operations.throughputUnitsPerHr === kp.throughputUnitsPerHr &&
  rep.operations.orderCycleTimeMin === kp.orderCycleTimeMin &&
  rep.operations.dockToStockMin === kp.dockToStockMin &&
  rep.operations.pickingLinesPerHr === kp.pickingLinesPerHr &&
  rep.operations.storageUtilPct === kp.storageUtilPct &&
  rep.operations.bottleneck.id === kp.bottleneck.id;
check("WMS KPIs EQUAL WT.wms.kpis(runOperations) (throughput/cycle/dock-to-stock/bottleneck)", wmsOk,
  "thr " + rep.operations.throughputUnitsPerHr.toFixed(1) + " bottleneck " + rep.operations.bottleneck.id);

/* --------------------------------------------------------------------
 * 6. Storage CROSS-CONSISTENCY (rebuild the identical assignment).
 * ------------------------------------------------------------------ */
const bundle = DATA.generate({ skuCount: cfg.skuCount, orders: cfg.orders, seed: cfg.seed, demandSkew: cfg.demandSkew });
const asg = ST.assign(ST.buildLocations(fullLayout), bundle.skuMaster, { strategy: cfg.strategy, seed: cfg.seed });
const sst = ST.stats(asg);
const storeOk =
  rep.storage.fillPct === sst.fillPct &&
  rep.storage.capacityTotal === sst.capacityTotal &&
  rep.storage.placedCount === sst.placedCount &&
  rep.storage.unplacedCount === sst.unplacedCount;
check("storage occupancy/capacity/placed EQUAL WT.storage.stats(assign(...)) (cross-consistency)", storeOk,
  "fill " + rep.storage.fillPct.toFixed(1) + "% cap " + rep.storage.capacityTotal + " placed " + rep.storage.placedCount);

/* --------------------------------------------------------------------
 * 7. Automation CROSS-CONSISTENCY.
 * ------------------------------------------------------------------ */
const demand = rep.operations.throughputUnitsPerHr;
const arep = A.report(fullLayout, demand);
const autoOk =
  rep.automation.hasAutomation === arep.hasAutomation &&
  rep.automation.totalThroughputUnitsPerHr === arep.throughput.totalUnitsPerHr &&
  rep.automation.constraint.type === arep.constraint.type &&
  rep.automation.systems.length === arep.systems.length;
check("automation total throughput + constraint EQUAL WT.automation.report(layout, demand) (cross-consistency)", autoOk,
  "total " + rep.automation.totalThroughputUnitsPerHr + " constraint " + (rep.automation.constraint.type || "-"));

/* --------------------------------------------------------------------
 * 8. Data-profile CROSS-CONSISTENCY.
 * ------------------------------------------------------------------ */
const dstats = DATA.stats(bundle.skuMaster, bundle.orderPool);
const dpOk =
  rep.dataProfile.skuCount === dstats.skuCount &&
  rep.dataProfile.orderCount === dstats.orderCount &&
  rep.dataProfile.lineCount === dstats.lineCount &&
  deepEq(rep.dataProfile.abc, dstats.abc);
check("data profile SKU/order/ABC stats EQUAL WT.wmsdata.stats(master, orders) (cross-consistency)", dpOk,
  rep.dataProfile.skuCount + " SKUs, " + rep.dataProfile.orderCount + " orders, ABC-A " + rep.dataProfile.abc.A.skuPct.toFixed(0) + "%");

/* --------------------------------------------------------------------
 * 9. Standards basis pulls the KB entries with sources + note.
 * ------------------------------------------------------------------ */
const kbList = KB.list();
const sb = rep.standardsBasis;
const basisOk =
  sb.available && sb.entries.length === kbList.length && sb.entries.length > 0 &&
  sb.entries.every((e) => typeof e.source === "string" && e.source.length > 5 && "id" in e && "label" in e) &&
  /NOT a certification/i.test(sb.note);
check("standards basis pulls WT.kb.list() entries (each with a source) + the not-a-certification note", basisOk,
  sb.entries.length + " KB entries");

/* --------------------------------------------------------------------
 * 10. toHtml is OFFLINE + has the banner + every section header.
 * ------------------------------------------------------------------ */
const html = R.toHtml(rep);
const escHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const noExternal =
  !/https?:\/\//i.test(html) &&
  !/<script/i.test(html) &&
  !/<link/i.test(html) &&
  !/url\(\s*["']?https?:/i.test(html) &&
  !/(?:src|href)\s*=\s*["']https?:/i.test(html);
const headersPresent = R.SECTIONS.every((s) => html.indexOf("<h2>" + escHtml(s.title) + "</h2>") !== -1);
const bannerPresent = /SYNTHETIC WMS report/.test(html) && /NOT a certification/i.test(html);
check("toHtml is self-contained/offline (no external refs) + banner + all section headers present",
  noExternal && headersPresent && bannerPresent,
  "external-clean=" + noExternal + " headers=" + headersPresent + " banner=" + bannerPresent);

/* --------------------------------------------------------------------
 * 11. toJson round-trips (parse(toJson(x)) deep-equals x).
 * ------------------------------------------------------------------ */
const json = R.toJson(rep);
const back = JSON.parse(json);
check("toJson round-trips: JSON.parse(toJson(report)) deep-equals report", deepEq(back, rep),
  json.length + " bytes");

/* --------------------------------------------------------------------
 * 12. Determinism: same layout + timestamp -> identical bytes.
 * ------------------------------------------------------------------ */
const rep2 = R.build(fullLayout, { timestamp: STAMP });
const detOk =
  R.toJson(rep2) === json &&
  R.toHtml(rep2) === html &&
  R.toCsv(rep2) === R.toCsv(rep);
check("determinism: same layout + timestamp -> identical html + json + csv bytes", detOk);

/* --------------------------------------------------------------------
 * 13. Runs on an examples.js layout (all sections; ops ran).
 * ------------------------------------------------------------------ */
const exLib = EX.library[0];
const b = EX.build(exLib.id);
const exLayout = { elements: b.elements, gridW: b.gridW, gridH: b.gridH, cell: D.METRES_PER_CELL, config: b.config, meta: b.meta };
const exRep = R.build(exLayout, { timestamp: STAMP, scenario: { id: exLib.id, name: exLib.name, industry: exLib.industry, description: exLib.description } });
const exOk =
  wantKeys.every((k) => exRep[k]) &&
  exRep.operations.available && exRep.operations.ran &&
  exRep.header.scenario && exRep.header.scenario.name === exLib.name &&
  R.toHtml(exRep).indexOf(exLib.name) !== -1;
check("runs on an examples.js layout (all sections; ops ran; scenario name in header)", exOk,
  exLib.name);

/* --------------------------------------------------------------------
 * 14. Runs on a GENERATED layout (generate.js).
 * ------------------------------------------------------------------ */
const genKey = Object.keys(WT.generate.plantProfiles)[0];
const gen = WT.generate.generateLayout(genKey, { seed: 11 });
const genLayout = { elements: gen.elements, gridW: gen.gridW, gridH: gen.gridH, cell: D.METRES_PER_CELL, config: gen.config };
const genRep = R.build(genLayout, { timestamp: STAMP });
const genOk = wantKeys.every((k) => genRep[k]) && genRep.compliance.available && genRep.layout.elementCount === gen.elements.length;
// cross-consistency also holds on the generated layout:
const genCc = C.check(genLayout, genRep.meta.config);
check("runs on a generated layout (generate.js) with all sections + compliance cross-consistency",
  genOk && deepEq(genRep.compliance.summary, genCc.summary),
  genKey + " -> " + genRep.layout.elementCount + " els, compliance " + genRep.compliance.summary.worst);

/* --------------------------------------------------------------------
 * 15. Honesty labels.
 * ------------------------------------------------------------------ */
const hon = rep.honesty;
const honestyOk =
  /SYNTHETIC/.test(hon) && /NOT a certification/i.test(hon) && /NOT measured/i.test(hon) &&
  /ISO 22400/.test(hon) && /DIN 15185/.test(hon) && /VDI/.test(hon) &&
  /SYNTHETIC/.test(html) && /NOT measured/i.test(html);
check("honesty: report.honesty + toHtml restate SYNTHETIC / NOT measured / NOT a certification / informed by ISO/DIN/VDI",
  honestyOk);

/* --------------------------------------------------------------------
 * 16. Not-yet-run marking (never throws; sections marked instead).
 * ------------------------------------------------------------------ */
const noAutoLayout = layout([
  { type: "dock-in", x: 2, y: 0 },
  { type: "selective-racking", x: 2, y: 6, w: 8, d: 1 },
  { type: "pack-station", x: 2, y: 30 },
  { type: "dock-out", x: 2, y: 38 },
]);
const noStoreLayout = layout([
  { type: "dock-in", x: 2, y: 0 },
  { type: "pack-station", x: 2, y: 20 },
  { type: "dock-out", x: 2, y: 38 },
]);
const repNoAuto = R.build(noAutoLayout, { timestamp: STAMP });
const repNoStore = R.build(noStoreLayout, { timestamp: STAMP });
const markOk =
  repNoAuto.automation.available === false && /manual/i.test(repNoAuto.automation.note) &&
  repNoStore.operations.ran === false && repNoStore.storage.available === false &&
  // and the printable HTML still renders (never throws) for both:
  R.toHtml(repNoAuto).length > 500 && R.toHtml(repNoStore).length > 500;
check("not-yet-run sections are MARKED (no-automation -> manual note; no-storage -> ops not run + storage n/a), never thrown", markOk,
  "noAuto.available=" + repNoAuto.automation.available + " noStore.ops.ran=" + repNoStore.operations.ran);

console.log("");
console.log(failures === 0 ? "ALL REPORT CHECKS PASSED (" + checks + " checks)" : failures + " OF " + checks + " REPORT CHECKS FAILED");
process.exit(failures === 0 ? 0 : 1);
