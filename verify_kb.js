/* =====================================================================
 * verify_kb.js - Editable standards knowledge base (P5) verification.
 *
 * Runs the REAL app modules (domain.js, knowledge.js, compliance.js,
 * generate.js) in Node with the same window shim the other harnesses use
 * and asserts the WT.kb contract:
 *
 *   1. API surface: defaults, get, set, addRule, reset, list,
 *      exportJson, importJson, meta all present.
 *   2. Defaults MATCH the previously-hardcoded constants (compliance
 *      guidance, generator aisles, rack densities) - so default
 *      behaviour is unchanged.
 *   3. get/set edit + VALIDATE (reject non-numeric, negative, out-of-range).
 *   4. reset(id) and reset() restore defaults (and drop custom rules).
 *   5. addRule adds a retrievable entry; it cannot overwrite a seed.
 *   6. exportJson -> importJson round-trips the WHOLE KB EXACTLY,
 *      including a user-added rule.
 *   7. Editing a compliance threshold in the KB CHANGES compliance.check's
 *      verdict for a borderline layout (proves the wiring), while the
 *      DEFAULT KB leaves the existing compliance verdicts identical
 *      (regression guard).
 *   8. Editing a rack density changes domain.elementCapacity; reset
 *      restores it (proves the capacity wiring + default-identical).
 *   9. Honesty: the banner + every entry are labelled "informed by, NOT a
 *      certification"; paywalled values say "verify"; nothing claims
 *      "compliant"/"certified".
 *
 * Everything is deterministic. Usage:  node verify_kb.js
 * ASCII-only output. Exit 0 = all checks pass.
 * ===================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");

global.window = global; // app modules attach themselves to window.WT
for (const f of ["domain.js", "knowledge.js", "compliance.js", "generate.js"]) {
  // eslint-disable-next-line no-eval
  (0, eval)(fs.readFileSync(path.join(__dirname, f), "utf8"));
}
const WT = global.WT;
const D = WT.domain;
const C = WT.compliance;
const kb = WT.kb;

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? "[PASS] " : "[FAIL] ") + name + (detail ? " - " + detail : ""));
  if (!ok) failures++;
}

// ---- fixture helpers (mirror verify_compliance.js) ------------------
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
function findN(rep, ruleId, status) {
  return rep.findings.filter((f) => f.ruleId === ruleId && (!status || f.status === status)).length;
}

console.log("Editable standards knowledge base verification (deterministic)");
console.log("");

/* ---------------------------------------------------------------------
 * 1. API surface.
 * ------------------------------------------------------------------- */
const API = ["defaults", "get", "set", "addRule", "reset", "list", "exportJson", "importJson", "meta"];
check("WT.kb exposes the full API (" + API.join(", ") + ")",
  !!kb && API.every((k) => kb[k] !== undefined),
  kb ? API.filter((k) => kb[k] === undefined).join(",") || "all present" : "no WT.kb");

/* ---------------------------------------------------------------------
 * 2. Defaults match the previously-hardcoded constants (ONE source).
 * ------------------------------------------------------------------- */
check("default min working aisle == domain AISLE.defaultMinMetres",
  kb.get("compliance.aisle.min") === D.AISLE.defaultMinMetres,
  kb.get("compliance.aisle.min") + " vs " + D.AISLE.defaultMinMetres);
check("default main-route == domain COMPLIANCE.mainRouteMinMetres (ASR A1.8)",
  kb.get("compliance.trafficRoute.min") === D.COMPLIANCE.mainRouteMinMetres,
  kb.get("compliance.trafficRoute.min") + " vs " + D.COMPLIANCE.mainRouteMinMetres);
check("default escape width + travel == domain COMPLIANCE (ASR A2.3)",
  kb.get("compliance.escapeRoute.width") === D.COMPLIANCE.escapeWidthMinMetres &&
  kb.get("compliance.escapeRoute.travel") === D.COMPLIANCE.escapeMaxTravelMetres,
  kb.get("compliance.escapeRoute.width") + " / " + kb.get("compliance.escapeRoute.travel"));
check("kb.defaults map equals the seeded values",
  kb.defaults["compliance.trafficRoute.min"] === D.COMPLIANCE.mainRouteMinMetres &&
  kb.defaults["compliance.escapeRoute.travel"] === D.COMPLIANCE.escapeMaxTravelMetres);
// generator profile aisles must mirror generate.js PROFILES (drift guard)
const profiles = WT.generate.plantProfiles;
const genOk = Object.keys(profiles).every(
  (key) => kb.get("generator." + key + ".minAisle") === profiles[key].minAisleMetres
);
check("generator profile aisles == generate.js PROFILES (drift guard)", genOk,
  Object.keys(profiles).map((k) => k + ":" + kb.get("generator." + k + ".minAisle")).join(", "));
// rack densities must mirror domain ELEMENTS (drift guard)
const storageTypes = Object.keys(D.ELEMENTS).filter((t) => D.ELEMENTS[t].category === "storage");
const densOk = storageTypes.every((t) => kb.get("rack." + t + ".density") === D.ELEMENTS[t].density);
check("rack densities == domain ELEMENTS densities (drift guard)", densOk,
  storageTypes.length + " storage types checked");

/* ---------------------------------------------------------------------
 * 3. get/set + validation (reject non-numeric / negative / out-of-range).
 * ------------------------------------------------------------------- */
check("set(id, value) applies a valid edit and get() returns it",
  kb.set("compliance.trafficRoute.min", 3.1) === true && kb.get("compliance.trafficRoute.min") === 3.1);
check("set rejects a non-numeric value (unchanged)",
  kb.set("compliance.trafficRoute.min", "abc") === false && kb.get("compliance.trafficRoute.min") === 3.1);
check("set rejects a negative value (unchanged)",
  kb.set("compliance.trafficRoute.min", -2) === false && kb.get("compliance.trafficRoute.min") === 3.1);
check("set rejects an out-of-range (> max) value (unchanged)",
  kb.set("compliance.escapeRoute.width", 999) === false && kb.get("compliance.escapeRoute.width") === D.COMPLIANCE.escapeWidthMinMetres);
check("reset(id) restores the seeded default",
  kb.reset("compliance.trafficRoute.min") === true && kb.get("compliance.trafficRoute.min") === D.COMPLIANCE.mainRouteMinMetres);

/* ---------------------------------------------------------------------
 * 4. addRule adds a retrievable entry; cannot overwrite a seed.
 * ------------------------------------------------------------------- */
const rid = kb.addRule({ label: "Max block-stack height (site rule)", value: 6, unit: "m", category: "custom",
  source: "Site fire concept (user-supplied)" });
check("addRule adds a retrievable entry", typeof rid === "string" && kb.get(rid) === 6,
  String(rid));
check("addRule-ed entry appears in list()", kb.list().some((e) => e.id === rid));
check("addRule refuses to overwrite a seed id",
  kb.addRule({ id: "compliance.trafficRoute.min", value: 1 }) === null &&
  kb.get("compliance.trafficRoute.min") === D.COMPLIANCE.mainRouteMinMetres);

/* ---------------------------------------------------------------------
 * 5. export -> import round-trips the WHOLE KB EXACTLY (incl. custom rule).
 * ------------------------------------------------------------------- */
kb.set("advisor.fill.highPct", 90); // an extra edit to carry through
const snapshot = kb.exportJson();
kb.reset();                          // wipe edits + custom rules
check("reset() drops custom rules and restores defaults",
  kb.get(rid) === undefined && kb.get("advisor.fill.highPct") === kb.defaults["advisor.fill.highPct"],
  "custom " + kb.get(rid) + ", highPct now " + kb.get("advisor.fill.highPct"));
const imp = kb.importJson(snapshot);
const snapshot2 = kb.exportJson();
check("importJson re-applies edits + custom rules without error",
  imp.ok === true && imp.applied >= 1 && imp.added === 1, JSON.stringify({ applied: imp.applied, added: imp.added }));
check("export -> import round-trips the KB EXACTLY (byte-identical JSON)",
  snapshot === snapshot2, snapshot.length + " vs " + snapshot2.length + " bytes");
check("the user-added rule survived the round-trip", kb.get(rid) === 6);
kb.reset(); // back to clean defaults for the wiring tests

/* ---------------------------------------------------------------------
 * 6. Editing a compliance threshold CHANGES the verdict for a borderline
 *    layout; the DEFAULT KB leaves it (and the classic fixtures) identical.
 * ------------------------------------------------------------------- */
// A dock with exactly 3 m clear in front, then a rack: PASS at 2.5 m.
const borderline = mkElements([
  { type: "dock-in", x: 4, y: 0, w: 2, d: 1 },
  { type: "selective-racking", x: 4, y: 4, w: 2, d: 2 },
]);
const repDefault = C.check(layoutObj(borderline), CFG);
check("DEFAULT KB: borderline dock -> traffic-route PASS (no warn)",
  findN(repDefault, "traffic-route", "pass") === 1 && findN(repDefault, "traffic-route", "warn") === 0);
kb.set("compliance.trafficRoute.min", 4); // raise the requirement above 3 m
const repEdited = C.check(layoutObj(borderline), CFG);
check("EDITED KB (4 m): same layout -> traffic-route WARN (wiring proven)",
  findN(repEdited, "traffic-route", "warn") === 1 && findN(repEdited, "traffic-route", "pass") === 0);
kb.reset();
const repReset = C.check(layoutObj(borderline), CFG);
check("RESET KB: verdict returns to PASS (deterministic, reversible)",
  findN(repReset, "traffic-route", "pass") === 1 && findN(repReset, "traffic-route", "warn") === 0);

// Regression: with default KB, the classic verify_compliance fixtures are
// unchanged (narrow aisle -> FAIL @2.0 m/2.9 m, wide aisle -> PASS).
const narrow = mkElements([
  { type: "selective-racking", x: 4, y: 5, w: 8, d: 1 },
  { type: "selective-racking", x: 4, y: 8, w: 8, d: 1 }, // gap 2 m
]);
const repNarrow = C.check(layoutObj(narrow), CFG);
const aFail = repNarrow.findings.filter((f) => f.ruleId === "aisle-width" && f.status === "fail");
check("regression: narrow aisle still FAIL @ 2.0 m measured / 2.9 m informed-by",
  aFail.length === 1 && aFail[0].measured.value === 2.0 && aFail[0].informedBy.value === 2.9);
const wide = mkElements([
  { type: "selective-racking", x: 4, y: 5, w: 8, d: 1 },
  { type: "selective-racking", x: 4, y: 11, w: 8, d: 1 }, // gap 5 m
]);
check("regression: wide aisle still PASS (default KB unchanged)",
  findN(C.check(layoutObj(wide), CFG), "aisle-width", "pass") === 1 &&
  findN(C.check(layoutObj(wide), CFG), "aisle-width", "fail") === 0);
// The guidelines summary reflects the KB values (default -> the constants).
const gl = repNarrow.guidelines.find((g) => g.code === "ASR A1.8");
check("guidelines summary shows the KB main-route value (default = constant)",
  gl && gl.value.indexOf(String(D.COMPLIANCE.mainRouteMinMetres) + " m") !== -1, gl && gl.value);

/* ---------------------------------------------------------------------
 * 7. Rack density wiring: editing changes elementCapacity; reset restores.
 * ------------------------------------------------------------------- */
const rackEl = { type: "selective-racking", x: 0, y: 0, w: 6, d: 1 };
const capDefault = D.elementCapacity(rackEl);
kb.set("rack.selective-racking.density", D.ELEMENTS["selective-racking"].density * 2);
const capEdited = D.elementCapacity(rackEl);
kb.reset();
const capReset = D.elementCapacity(rackEl);
check("editing rack density changes elementCapacity, reset restores it (default-identical)",
  capEdited > capDefault && capReset === capDefault,
  "default " + capDefault + " edited " + capEdited + " reset " + capReset);

/* ---------------------------------------------------------------------
 * 8. Honesty labels (mirror WMS_STANDARDS_CORPUS.md).
 * ------------------------------------------------------------------- */
check("meta banner is labelled NOT a certification (EN + DE)",
  kb.meta.honesty.en.indexOf("NOT a certification") !== -1 &&
  kb.meta.honesty.de.indexOf("KEINE Zertifizierung") !== -1);
const all = kb.list();
check("every entry carries a non-empty source + note",
  all.length >= 12 && all.every((e) => e.source && e.note && String(e.source).length > 0 && String(e.note).length > 0),
  all.length + " entries");
check("paywalled compliance values carry a 'verify' note (paywall honesty)",
  all.some((e) => e.category === "compliance" && /verify/i.test(e.note)));
check("no entry falsely claims the layout is 'compliant' or 'certified'",
  all.every((e) => !/\bcompliant\b/i.test(String(e.source) + String(e.note)) &&
                   !/\bcertified\b/i.test(String(e.source) + String(e.note))));

/* ---------------------------------------------------------------------
 * 9. list(category) filters; meta.version; malformed import handled.
 * ------------------------------------------------------------------- */
check("list(category) returns only that category",
  kb.list("compliance").length >= 1 && kb.list("compliance").every((e) => e.category === "compliance"));
check("meta.version is the pinned KB version", kb.meta.version === "wt-kb-1", kb.meta.version);
const bad = kb.importJson("{ not json");
const bad2 = kb.importJson({ foo: 1 });
check("importJson rejects malformed input gracefully (no throw)",
  bad.ok === false && bad2.ok === false && !!bad.error && !!bad2.error);

console.log("");
console.log(failures === 0 ? "ALL KB CHECKS PASSED" : failures + " KB CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
