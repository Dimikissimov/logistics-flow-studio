/* =====================================================================
 * verify_compliance.js - Compliance Check verification harness.
 *
 * Runs the REAL app modules (domain.js, compliance.js) in Node with the
 * same window shim the other harnesses use and asserts EXACT outcomes on
 * hand-constructed layouts:
 *
 *   1. An aisle narrower than the informed-by value is flagged FAIL with
 *      the right measured + guideline numbers (DIN 15185).
 *   2. An aisle at/above the value PASSES.
 *   3. A boxed-in rack (no free path to any exit) is a FAIL escape route
 *      (ASR A2.3) - a blocked escape route is detected.
 *   4. A dock sealed shut in front is a FAIL blocked-route (ASR A1.8).
 *   5. A dock with < 2.5 m clear in front is a WARN traffic route (A1.8).
 *   6. Determinism: the same layout checked twice is byte-identical JSON.
 *   7. The not-a-certification disclaimer (DE + EN) is present in output.
 *   8. Report shape: every finding carries status, guideline, DE/EN
 *      explanation, and measured/informed-by numbers where applicable.
 *   9. Regression: domain.aisleViolations still returns its {a,b,gapM}
 *      shape after the facingAislePairs refactor.
 *  10. The MRO preset runs without throwing and yields a full report.
 *
 * Everything is deterministic. Usage:  node verify_compliance.js
 * ASCII-only output. Exit 0 = all checks pass.
 * ===================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");

global.window = global; // app modules attach themselves to window.WT
for (const f of ["domain.js", "compliance.js"]) {
  // eslint-disable-next-line no-eval
  (0, eval)(fs.readFileSync(path.join(__dirname, f), "utf8"));
}
const WT = global.WT;
const D = WT.domain;
const C = WT.compliance;

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? "[PASS] " : "[FAIL] ") + name + (detail ? " - " + detail : ""));
  if (!ok) failures++;
}

// ---- fixture helpers ------------------------------------------------
function mkElements(list) {
  let idCounter = 0;
  return list.map((e) => {
    const def = D.ELEMENTS[e.type];
    return { id: "el-" + ++idCounter, type: e.type, x: e.x, y: e.y, w: e.w || def.w, d: e.d || def.d };
  });
}
function layoutObj(elements) {
  return { version: "wt-1", gridW: 40, gridH: 24, cell: D.METRES_PER_CELL, elements };
}
const CFG = { minAisleMetres: 2.9 };
function find(rep, ruleId, status) {
  return rep.findings.filter((f) => f.ruleId === ruleId && (!status || f.status === status));
}

console.log("Compliance Check verification (deterministic)");
console.log("");

/* ---------------------------------------------------------------------
 * 1 + 2. Aisle width: narrow -> FAIL with exact numbers; wide -> PASS.
 * ------------------------------------------------------------------- */
const narrow = mkElements([
  { type: "selective-racking", x: 4, y: 5, w: 8, d: 1 },
  { type: "selective-racking", x: 4, y: 8, w: 8, d: 1 }, // gap = 8 - 6 = 2 m
]);
const repNarrow = C.check(layoutObj(narrow), CFG);
const aFail = find(repNarrow, "aisle-width", "fail");
check("narrow aisle -> exactly one aisle-width FAIL", aFail.length === 1, aFail.length + " fail(s)");
check("narrow aisle FAIL measured value is 2.0 m",
  aFail.length === 1 && aFail[0].measured && aFail[0].measured.value === 2.0,
  aFail.length ? "measured " + (aFail[0].measured && aFail[0].measured.value) : "n/a");
check("narrow aisle FAIL informed-by value is 2.9 m (DIN 15185)",
  aFail.length === 1 && aFail[0].guideline === "DIN 15185" && aFail[0].informedBy.value === 2.9,
  aFail.length ? "informed-by " + aFail[0].informedBy.value : "n/a");
check("narrow aisle FAIL names both offending rack ids",
  aFail.length === 1 && aFail[0].elements.length === 2 &&
  aFail[0].elements.indexOf("el-1") !== -1 && aFail[0].elements.indexOf("el-2") !== -1,
  aFail.length ? aFail[0].elements.join(",") : "n/a");

const wide = mkElements([
  { type: "selective-racking", x: 4, y: 5, w: 8, d: 1 },
  { type: "selective-racking", x: 4, y: 11, w: 8, d: 1 }, // gap = 11 - 6 = 5 m
]);
const repWide = C.check(layoutObj(wide), CFG);
check("wide aisle (5 m) -> aisle-width PASS, no fail/warn",
  find(repWide, "aisle-width", "pass").length === 1 &&
  find(repWide, "aisle-width", "fail").length === 0 &&
  find(repWide, "aisle-width", "warn").length === 0);

/* ---------------------------------------------------------------------
 * 3. Boxed-in rack -> escape-route FAIL (blocked escape route detected).
 * A 2x2 target rack ringed on all four sides by touching racks; one dock
 * exists elsewhere so egress CAN be assessed.
 * ------------------------------------------------------------------- */
const boxed = mkElements([
  { type: "dock-in", x: 0, y: 0, w: 2, d: 1 },
  { type: "selective-racking", x: 10, y: 10, w: 2, d: 2 }, // el-2 TARGET (enclosed)
  { type: "selective-racking", x: 10, y: 8, w: 2, d: 2 },  // top
  { type: "selective-racking", x: 10, y: 12, w: 2, d: 2 }, // bottom
  { type: "selective-racking", x: 8, y: 10, w: 2, d: 2 },  // left
  { type: "selective-racking", x: 12, y: 10, w: 2, d: 2 }, // right
]);
const repBoxed = C.check(layoutObj(boxed), CFG);
const eFail = find(repBoxed, "escape-route", "fail");
check("boxed-in rack -> escape-route FAIL detected (ASR A2.3)",
  eFail.length >= 1 && eFail.some((f) => f.elements.indexOf("el-2") !== -1),
  eFail.length + " escape fail(s)");
check("boxed-in escape FAIL is guideline ASR A2.3",
  eFail.length >= 1 && eFail[0].guideline === "ASR A2.3");

/* ---------------------------------------------------------------------
 * 4. Sealed dock -> blocked-route FAIL (ASR A1.8).
 * A rack placed hard in front of the dock opening.
 * ------------------------------------------------------------------- */
const sealed = mkElements([
  { type: "dock-in", x: 4, y: 0, w: 2, d: 1 },
  { type: "selective-racking", x: 4, y: 1, w: 2, d: 2 }, // seals the door front
]);
const repSealed = C.check(layoutObj(sealed), CFG);
const bFail = find(repSealed, "blocked-route", "fail");
check("sealed dock -> blocked-route FAIL (ASR A1.8)",
  bFail.length === 1 && bFail[0].elements.indexOf("el-1") !== -1 && bFail[0].elements.indexOf("el-2") !== -1,
  bFail.length ? bFail[0].elements.join(",") : "n/a");

/* ---------------------------------------------------------------------
 * 5. Narrow-but-open route in front of a dock -> traffic-route WARN.
 * ------------------------------------------------------------------- */
const pinched = mkElements([
  { type: "dock-in", x: 4, y: 0, w: 2, d: 1 },
  { type: "selective-racking", x: 4, y: 2, w: 2, d: 2 }, // 1 m clear (y=1) then blocked
]);
const repPinched = C.check(layoutObj(pinched), CFG);
const tWarn = find(repPinched, "traffic-route", "warn");
check("narrow dock route (1 m) -> traffic-route WARN (ASR A1.8)",
  tWarn.length === 1 && tWarn[0].measured && tWarn[0].measured.value === 1.0 &&
  tWarn[0].informedBy.value === D.COMPLIANCE.mainRouteMinMetres,
  tWarn.length ? "measured " + (tWarn[0].measured && tWarn[0].measured.value) + " vs " + tWarn[0].informedBy.value : "n/a");
check("that same dock is NOT double-reported as blocked (open route)",
  find(repPinched, "blocked-route", "fail").length === 0);

/* ---------------------------------------------------------------------
 * 6. Determinism: same layout twice -> identical report JSON.
 * ------------------------------------------------------------------- */
const MRO = mkElements(D.PRESETS["mro-distributor"].elements);
const j1 = JSON.stringify(C.check(layoutObj(MRO), CFG));
const j2 = JSON.stringify(C.check(layoutObj(MRO), CFG));
check("determinism: MRO report checked twice is identical JSON", j1 === j2,
  j1.length + " bytes");
check("determinism: narrow report checked twice is identical JSON",
  JSON.stringify(C.check(layoutObj(narrow), CFG)) === JSON.stringify(repNarrow));

/* ---------------------------------------------------------------------
 * 7. Disclaimer (DE + EN) present in the report output.
 * ------------------------------------------------------------------- */
check("report carries an EN not-a-certification disclaimer",
  !!repNarrow.disclaimer && repNarrow.disclaimer.en.indexOf("NOT a certification") !== -1);
check("report carries a DE not-a-certification disclaimer",
  !!repNarrow.disclaimer && repNarrow.disclaimer.de.indexOf("KEINE Zertifizierung") !== -1);
check("disclaimer names it is not a Gefaehrdungsbeurteilung",
  repNarrow.disclaimer.en.indexOf("Gefaehrdungsbeurteilung") !== -1 &&
  repNarrow.disclaimer.de.indexOf("Gefaehrdungsbeurteilung") !== -1);

/* ---------------------------------------------------------------------
 * 8. Report shape: findings well-formed; guidelines cited; summary sound.
 * ------------------------------------------------------------------- */
const VALID = { pass: 1, warn: 1, fail: 1 };
let shapeOk = true;
for (const f of repBoxed.findings) {
  if (!VALID[f.status]) shapeOk = false;
  if (!f.guideline || !f.rule || !f.rule.en || !f.rule.de) shapeOk = false;
  if (!f.explain || !f.explain.en || !f.explain.de) shapeOk = false;
  if (!Array.isArray(f.elements)) shapeOk = false;
}
check("every finding is well-formed (status/guideline/DE+EN explain/elements)", shapeOk,
  repBoxed.findings.length + " findings");
const codes = repNarrow.guidelines.map((g) => g.code);
check("guidelines list cites ASR A1.8, ASR A2.3 and DIN 15185",
  ["ASR A1.8", "ASR A2.3", "DIN 15185"].every((c) => codes.indexOf(c) !== -1), codes.join(", "));
const s = repBoxed.summary;
check("summary counts add up and worst is correct",
  s.pass + s.warn + s.fail === s.total && s.total === repBoxed.findings.length &&
  s.worst === (s.fail ? "fail" : s.warn ? "warn" : "pass"),
  "pass " + s.pass + " warn " + s.warn + " fail " + s.fail + " worst " + s.worst);
check("all four rule categories are present in a full report",
  ["aisle-width", "traffic-route", "escape-route", "blocked-route"]
    .every((r) => find(repBoxed, r).length >= 1));

/* ---------------------------------------------------------------------
 * 9. Regression: aisleViolations keeps its {a,b,gapM} shape post-refactor.
 * ------------------------------------------------------------------- */
const viol = D.aisleViolations(narrow, 2.9);
check("regression: aisleViolations still returns {a,b,gapM}",
  viol.length === 1 && viol[0].a && viol[0].b && viol[0].gapM === 2 &&
  Object.keys(viol[0]).sort().join(",") === "a,b,gapM",
  JSON.stringify(viol.map((v) => v.gapM)));
check("regression: facingAislePairs is exported and axis-tagged",
  typeof D.facingAislePairs === "function" && D.facingAislePairs(narrow)[0].axis === "y");

/* ---------------------------------------------------------------------
 * 10. MRO preset: runs and yields a non-empty structured report.
 * ------------------------------------------------------------------- */
const repMro = C.check(layoutObj(MRO), CFG);
check("MRO preset produces a non-empty structured report",
  repMro.findings.length >= 4 && repMro.version === C.REPORT_VERSION,
  repMro.findings.length + " findings, summary " +
  "pass " + repMro.summary.pass + " warn " + repMro.summary.warn + " fail " + repMro.summary.fail);

// ---- sample output (one fail + one pass), for the record ------------
console.log("");
console.log("Sample findings (narrow-aisle + wide-aisle fixtures):");
function line(f) {
  const m = f.measured ? f.measured.value + f.measured.unit : "-";
  const g = f.informedBy ? f.informedBy.value + f.informedBy.unit : "-";
  return "  [" + f.status.toUpperCase() + "] " + f.guideline + " " + f.rule.en +
    ": measured " + m + " vs informed-by " + g;
}
console.log(line(aFail[0]));
console.log(line(find(repWide, "aisle-width", "pass")[0]));

console.log("");
console.log(failures === 0 ? "ALL COMPLIANCE CHECKS PASSED" : failures + " COMPLIANCE CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
