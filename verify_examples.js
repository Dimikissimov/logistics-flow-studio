/* =====================================================================
 * verify_examples.js - Example Scenarios library + data export harness.
 *
 * Runs the REAL app modules (domain.js, compliance.js, generate.js,
 * nlcommands.js, examples.js) in Node under the same window shim the
 * other harnesses use and asserts EXACT outcomes for WT.examples:
 *
 *   Library
 *     - >=20 named, DISTINCT scenarios (unique ids)
 *     - every example has a non-empty name, industry, a >=2-sentence
 *       description, a build config and a synthetic dataProfile with
 *       plausible (>0) operational numbers
 *   Build (deterministic)
 *     - every example builds -> {elements, config, meta}
 *     - every built layout is OVERLAP-FREE
 *     - every built layout PASSES or honestly WARNS compliance.check
 *       (never a FAIL) on the app's 40x24 floor
 *     - elements carry zone tags (so the app loads them like a generate)
 *     - build is byte-identical on re-run (determinism)
 *   Coverage
 *     - ITEM_COVERAGE is a MAJORITY of the app's palette, and includes
 *       the key racking / flow / transport types (asserted set)
 *   Export
 *     - exportData -> a valid wt-1 layout (serialize() schema), every
 *       element type known, byte-identical on re-run
 *     - exportCsv -> non-empty CSV with one row PER element, a KPI/
 *       summary block and the dataProfile rows, byte-identical on re-run
 *   Honesty
 *     - the synthetic label + "not a certification" wording are present
 *     - no example name/description carries a real company brand
 *
 * Everything is deterministic. Usage:  node verify_examples.js
 * ASCII-only output. Exit 0 = all checks pass.
 * ===================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");

global.window = global; // app modules attach themselves to window.WT
for (const f of ["domain.js", "compliance.js", "generate.js", "nlcommands.js", "examples.js"]) {
  // eslint-disable-next-line no-eval
  (0, eval)(fs.readFileSync(path.join(__dirname, f), "utf8"));
}
const WT = global.WT;
const D = WT.domain;
const C = WT.compliance;
const G = WT.generate;
const E = WT.examples;

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? "[PASS] " : "[FAIL] ") + name + (detail ? " - " + detail : ""));
  if (!ok) failures++;
}

function overlapFree(els) {
  for (let i = 0; i < els.length; i++)
    for (let j = i + 1; j < els.length; j++)
      if (G.rectsOverlap(els[i], els[j])) return false;
  return true;
}
function complianceOf(b) {
  return C.check(
    { version: "wt-1", gridW: b.gridW, gridH: b.gridH, cell: 1, elements: b.elements },
    { minAisleMetres: b.config.minAisleMetres }
  );
}
function sentences(s) { return String(s).split(/[.!?]+\s/).filter((x) => x.trim().length > 3).length; }

console.log("Example Scenarios (library + data export) verification (deterministic)");
console.log("");

const LIB = E.library;

/* ---- 1. Library size + distinctness ----------------------------- */
check("library has >=20 named scenarios", Array.isArray(LIB) && LIB.length >= 20, "count=" + (LIB ? LIB.length : 0));
const ids = LIB.map((e) => e.id);
check("every example id is unique", new Set(ids).size === ids.length, ids.length + " ids");

/* ---- 2. Every example has the required, non-empty fields -------- */
let fieldOK = true, descOK = true, dpOK = true, dpNumOK = true;
const DP_NUM = ["skuCount", "dailyOrderLines", "throughputPerHour", "storagePositions", "dockCount", "staffingFte", "peakFactor"];
for (const ex of LIB) {
  if (!ex.name || !ex.industry || !ex.config || !ex.dataProfile) { fieldOK = false; }
  if (!ex.description || sentences(ex.description) < 2) { descOK = false; }
  const dp = ex.dataProfile || {};
  if (!dp.automation || typeof dp.automation !== "string" || !dp.automation.trim()) dpOK = false;
  for (const k of DP_NUM) {
    if (!(typeof dp[k] === "number" && isFinite(dp[k]) && dp[k] > 0)) dpNumOK = false;
  }
}
check("every example has name + industry + config + dataProfile", fieldOK);
check("every example description is non-empty and >=2 sentences", descOK);
check("every dataProfile has a non-empty automation summary", dpOK);
check("every dataProfile has plausible (>0) numeric operational figures", dpNumOK, DP_NUM.join(", "));

/* ---- 3. Build: overlap-free + compliance never FAILs ------------ */
const builds = {};
let buildOK = true, overlapOK = true, nonFailOK = true, zoneOK = true;
const worstCounts = { pass: 0, warn: 0, fail: 0 };
for (const ex of LIB) {
  let b;
  try { b = E.build(ex.id); } catch (err) { buildOK = false; continue; }
  builds[ex.id] = b;
  if (!b || !Array.isArray(b.elements) || !b.elements.length || !b.config || !b.meta) buildOK = false;
  if (!overlapFree(b.elements)) overlapOK = false;
  const rep = complianceOf(b);
  worstCounts[rep.summary.worst] = (worstCounts[rep.summary.worst] || 0) + 1;
  if (rep.summary.worst === "fail") nonFailOK = false;
  if (!b.elements.every((e) => typeof e.zone === "string" && e.zone.length)) zoneOK = false;
}
check("every example builds into a non-empty {elements, config, meta}", buildOK, Object.keys(builds).length + " built");
check("every built layout is overlap-free", overlapOK);
check("every built layout passes or honestly warns compliance (never fails)", nonFailOK,
  "pass " + worstCounts.pass + " / warn " + worstCounts.warn + " / fail " + worstCounts.fail);
check("every built element carries a zone tag (loads like a generated layout)", zoneOK);

/* ---- 4. build meta reports the same non-fail verdict ------------ */
check("every build meta.compliance.worst is non-fail",
  LIB.every((ex) => builds[ex.id] && builds[ex.id].meta.compliance.worst !== "fail"));

/* ---- 5. Determinism: build byte-identical on re-run ------------- */
let buildDetOK = true;
for (const ex of LIB) {
  const a = JSON.stringify(E.build(ex.id));
  const b = JSON.stringify(E.build(ex.id));
  if (a !== b) { buildDetOK = false; break; }
}
check("determinism: build(id) is byte-identical on re-run", buildDetOK);

/* ---- 6. Item-type coverage is a MAJORITY of the palette --------- */
const palette = D.paletteOrder;
const majority = Math.ceil(palette.length / 2);
const COV = E.ITEM_COVERAGE;
check("ITEM_COVERAGE is a majority of the app's item types",
  Array.isArray(COV) && COV.length >= majority, COV.length + " of " + palette.length + " (majority " + majority + ")");
const REQUIRED_TYPES = [
  "selective-racking", "drive-in", "push-back", "pallet-flow", "carton-flow",
  "block-stack", "asrs", "mezzanine", "double-deep",
  "dock-in", "dock-out", "staging", "conveyor", "pack-station",
  "push-station", "pull-station", "rgv", "agv",
];
const missingReq = REQUIRED_TYPES.filter((t) => COV.indexOf(t) === -1);
check("ITEM_COVERAGE includes the key racking + flow + transport types",
  missingReq.length === 0, missingReq.length ? "missing: " + missingReq.join(", ") : "all present");
check("ITEM_COVERAGE only lists real palette element types",
  COV.every((t) => !!D.ELEMENTS[t]));

/* ---- 7. exportData is a valid wt-1 layout ----------------------- */
let dataOK = true, dataTypeOK = true;
for (const ex of LIB) {
  const dat = E.exportData(ex.id);
  if (!dat || dat.version !== "wt-1" || dat.gridW !== 40 || dat.gridH !== 24 || !Array.isArray(dat.elements) || !dat.config) dataOK = false;
  for (const e of dat.elements) {
    if (!e || !D.ELEMENTS[e.type] || typeof e.x !== "number" || typeof e.y !== "number" || typeof e.w !== "number" || typeof e.d !== "number") dataTypeOK = false;
  }
}
check("exportData returns a valid wt-1 layout for every example", dataOK);
check("exportData elements are all known types with numeric geometry", dataTypeOK);
let dataDetOK = true;
for (const ex of LIB) {
  if (JSON.stringify(E.exportData(ex.id)) !== JSON.stringify(E.exportData(ex.id))) { dataDetOK = false; break; }
}
check("determinism: exportData(id) is byte-identical on re-run", dataDetOK);

/* ---- 8. exportCsv: non-empty, element rows + summary + profile -- */
const SAMPLE = "automotive-jit-sequencing";
const csv = E.exportCsv(SAMPLE);
const lines = csv.split("\r\n");
check("exportCsv returns a non-empty CSV string", typeof csv === "string" && csv.length > 200, csv.length + " chars");
check("exportCsv uses CRLF line endings (Excel-friendly)", csv.indexOf("\r\n") !== -1);
const hdrIdx = lines.indexOf("idx,id,type,label,zone,x,y,w,d,category,storage_positions");
let elemRowCount = 0;
if (hdrIdx !== -1) {
  for (let i = hdrIdx + 1; i < lines.length && lines[i].trim() !== ""; i++) elemRowCount++;
}
const sampleBuild = E.build(SAMPLE);
check("exportCsv has an element header + one data row per element",
  hdrIdx !== -1 && elemRowCount === sampleBuild.elements.length,
  "rows=" + elemRowCount + " elements=" + sampleBuild.elements.length);
check("exportCsv carries a KPI/summary block (positions, floor use, aisle compliance, docks)",
  /\[SUMMARY \/ KPI\]/.test(csv) &&
  /Total storage positions/.test(csv) &&
  /Floor use \(%\)/.test(csv) &&
  /Aisle-width compliance/.test(csv) &&
  /Dock count/.test(csv));
check("exportCsv carries the synthetic dataProfile rows",
  /\[DATA PROFILE/.test(csv) && /SKU count/.test(csv) && /Throughput/.test(csv) && /Staffing/.test(csv));
check("determinism: exportCsv(id) is byte-identical on re-run", E.exportCsv(SAMPLE) === E.exportCsv(SAMPLE));

/* ---- 9. Honesty: synthetic + not-a-certification labelling ------ */
check("exportCsv is labelled a SYNTHETIC / illustrative scenario",
  /SYNTHETIC/i.test(csv) && /illustrative/i.test(csv));
check("exportCsv states the compliance basis is NOT a certification",
  /NOT a certification/i.test(csv));
// No real brand names anywhere in the library-facing text.
const BRAND_BLOCKLIST = ["amazon", "wuerth", "wurth", "würth", "dhl", "ikea", "zalando", "bosch", "siemens", "walmart", "ocado", "kion", "dematic", "ssi schaefer", "jungheinrich"];
let brandHit = null;
for (const ex of LIB) {
  const hay = (ex.name + " " + ex.industry + " " + ex.description).toLowerCase();
  for (const b of BRAND_BLOCKLIST) if (hay.indexOf(b) !== -1) { brandHit = ex.id + " -> " + b; break; }
  if (brandHit) break;
}
check("no example name/industry/description carries a real company brand", brandHit === null, brandHit || "clean");

/* ---- 10. Unknown id is an honest throw -------------------------- */
let threw = false;
try { E.build("no-such-example-xyz"); } catch (_) { threw = true; }
check("build() throws on an unknown example id (never guesses)", threw);

/* ---- sample transcript, for the record -------------------------- */
console.log("");
console.log("Library (" + LIB.length + " scenarios):");
for (const ex of LIB) {
  const b = builds[ex.id];
  console.log("  - " + ex.name + " [" + ex.industry + "] : " +
    b.elements.length + " els, " + b.meta.positions + " positions, compliance " + b.meta.compliance.worst);
}
console.log("");
console.log("Item-type coverage (" + COV.length + " of " + palette.length + "): " + COV.join(", "));
console.log("");
console.log("Sample CSV export (" + SAMPLE + ", first 6 lines):");
lines.slice(0, 6).forEach((l) => console.log("  " + l));

console.log("");
console.log(failures === 0 ? "ALL EXAMPLE CHECKS PASSED" : failures + " EXAMPLE CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
