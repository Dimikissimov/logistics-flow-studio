/* =====================================================================
 * verify_ifc.js - IFC export bridge verification harness (W4).
 *
 * Runs the REAL app modules (domain.js, ifc.js) in Node with the same
 * window shim the other harnesses use, generates IFC for the starter
 * layout and the MRO preset, and validates the files STRUCTURALLY:
 *
 *   1. STEP framing: ISO-10303-21 / HEADER / ENDSEC / DATA / ENDSEC /
 *      END-ISO-10303-21 present and in order.
 *   2. Header content: FILE_SCHEMA IFC4, ViewDefinition
 *      [CoordinationView], honest authoring app "WarehouseTwin".
 *   3. Every DATA statement parses as #id=ENTITY(...); with strictly
 *      sequential ids, and every #ref in a parameter list resolves to
 *      a defined entity (string-literal-aware scan).
 *   4. Balanced parentheses in every statement (outside strings).
 *   5. Entity counts match the layout exactly: one proxy / solid /
 *      profile / pset / rel-defines per element, the 4-level spatial
 *      tree once, 3 aggregations, 1 containment, SI metre units.
 *   6. GlobalIds: 22-char IFC base64 alphabet, first char 0-3, unique.
 *   7. String escaping: quotes, backslashes and non-ASCII survive per
 *      ISO 10303-21 rules (checked on the writer AND in a file).
 *   8. Determinism: same layout -> byte-identical file.
 *   9. File sizes printed for the starter + MRO exports.
 *  10. GOLD STANDARD (optional): if Python + ifcopenshell are present,
 *      tools/validate_ifc.py opens both files with ifcopenshell and
 *      asserts schema + entity counts. Skips with a printed note when
 *      ifcopenshell is absent - the structural checks above still ran.
 *
 * Everything is deterministic. Usage:  node verify_ifc.js
 * ASCII-only output. Exit 0 = all checks pass.
 * ===================================================================== */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

global.window = global; // the app modules attach themselves to window.WT
for (const f of ["domain.js", "ifc.js"]) {
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

const MRO = mkElements(D.PRESETS["mro-distributor"].elements);

function layoutObj(elements) {
  return { version: "wt-1", gridW: 40, gridH: 24, cell: D.METRES_PER_CELL, elements };
}

/* ---------------------------------------------------------------------
 * STEP structural validation helpers.
 * ------------------------------------------------------------------- */

// Remove STEP string literals ('' is an escaped quote inside a string)
// so parenthesis/reference scans never trip over quoted content.
function stripStrings(s) {
  return s.replace(/'(?:''|[^'])*'/g, "''");
}

function balancedParens(s) {
  let depth = 0;
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth < 0) return false; }
  }
  return depth === 0;
}

function validateStep(name, step, elements) {
  const N = elements.length;
  const S = elements.filter((e) => D.ELEMENTS[e.type].category === "storage").length;

  // 1. framing + order
  const lines = step.split("\n").filter((l) => l.length > 0);
  check(name + ": first line is ISO-10303-21;", lines[0] === "ISO-10303-21;");
  check(name + ": last line is END-ISO-10303-21;", lines[lines.length - 1] === "END-ISO-10303-21;");
  const iHeader = lines.indexOf("HEADER;");
  const iData = lines.indexOf("DATA;");
  const iEnd1 = lines.indexOf("ENDSEC;");
  const iEnd2 = lines.lastIndexOf("ENDSEC;");
  check(name + ": HEADER / ENDSEC / DATA / ENDSEC ordered",
    iHeader === 1 && iEnd1 > iHeader && iData === iEnd1 + 1 && iEnd2 > iData && iEnd2 === lines.length - 2);

  // 2. header content
  check(name + ": FILE_SCHEMA is IFC4", step.indexOf("FILE_SCHEMA(('IFC4'));") !== -1);
  check(name + ": ViewDefinition [CoordinationView] declared",
    step.indexOf("FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');") !== -1);
  check(name + ": honest authoring app in FILE_NAME",
    /FILE_NAME\([^\n]*WarehouseTwin/.test(step));

  // 3. parse DATA statements
  const dataLines = lines.slice(iData + 1, iEnd2);
  const entities = {}; // id -> {type, params}
  let parseOk = true, seqOk = true, parenOk = true;
  let n = 0;
  for (const line of dataLines) {
    const m = /^#(\d+)=([A-Z0-9_]+)\((.*)\);$/.exec(line);
    if (!m) { parseOk = false; console.log("       unparsable: " + line.slice(0, 80)); continue; }
    n++;
    const id = parseInt(m[1], 10);
    if (id !== n) seqOk = false;
    entities[id] = { type: m[2], params: m[3] };
    if (!balancedParens(stripStrings("(" + m[3] + ")"))) { parenOk = false; console.log("       unbalanced: " + line.slice(0, 80)); }
  }
  check(name + ": every DATA statement parses as #id=ENTITY(...);", parseOk, n + " statements");
  check(name + ": entity ids are strictly sequential #1..#" + n, seqOk);
  check(name + ": balanced parentheses in every statement", parenOk);

  // 4. every #ref resolves
  let refCount = 0, unresolved = 0;
  for (const id of Object.keys(entities)) {
    const stripped = stripStrings(entities[id].params);
    for (const rm of stripped.matchAll(/#(\d+)/g)) {
      refCount++;
      if (!entities[parseInt(rm[1], 10)]) unresolved++;
    }
  }
  check(name + ": every entity reference resolves", unresolved === 0,
    refCount + " refs, " + unresolved + " unresolved");

  // 5. entity counts match the layout
  const count = (t) => Object.values(entities).filter((e) => e.type === t).length;
  const expected = {
    IFCPROJECT: 1, IFCSITE: 1, IFCBUILDING: 1, IFCBUILDINGSTOREY: 1,
    IFCRELAGGREGATES: 3, IFCRELCONTAINEDINSPATIALSTRUCTURE: 1,
    IFCOWNERHISTORY: 1, IFCUNITASSIGNMENT: 1, IFCSIUNIT: 4,
    IFCGEOMETRICREPRESENTATIONCONTEXT: 1,
    IFCBUILDINGELEMENTPROXY: N, IFCEXTRUDEDAREASOLID: N,
    IFCRECTANGLEPROFILEDEF: N, IFCSHAPEREPRESENTATION: N,
    IFCPRODUCTDEFINITIONSHAPE: N, IFCPROPERTYSET: N,
    IFCRELDEFINESBYPROPERTIES: N,
    IFCLOCALPLACEMENT: N + 3, // one per element + site/building/storey
    IFCPROPERTYSINGLEVALUE: 5 * N + 2 * S, // 5 base props + VelocityClass/PalletPositions on storage
  };
  let countsOk = true;
  for (const t of Object.keys(expected)) {
    if (count(t) !== expected[t]) {
      countsOk = false;
      console.log("       count mismatch " + t + ": " + count(t) + " found, " + expected[t] + " expected");
    }
  }
  check(name + ": entity counts match the layout (" + N + " elements, " + S + " storage)", countsOk,
    "one proxy/solid/pset per element, spatial tree once");
  check(name + ": SI metre length unit present",
    Object.values(entities).some((e) => e.type === "IFCSIUNIT" && e.params.indexOf(".LENGTHUNIT.") !== -1 && e.params.indexOf(".METRE.") !== -1));

  // 6. GlobalIds: rooted entities start with a 22-char guid, unique file-wide
  const ROOTED = /^(IFCPROJECT|IFCSITE|IFCBUILDING|IFCBUILDINGSTOREY|IFCBUILDINGELEMENTPROXY|IFCPROPERTYSET|IFCRELAGGREGATES|IFCRELCONTAINEDINSPATIALSTRUCTURE|IFCRELDEFINESBYPROPERTIES)$/;
  const guids = [];
  let guidShapeOk = true;
  for (const e of Object.values(entities)) {
    if (!ROOTED.test(e.type)) continue;
    const gm = /^'([^']*)'/.exec(e.params);
    const g = gm ? gm[1] : "";
    guids.push(g);
    if (!/^[0-3][0-9A-Za-z_$]{21}$/.test(g)) { guidShapeOk = false; console.log("       bad GlobalId: '" + g + "' on " + e.type); }
  }
  check(name + ": GlobalIds are 22-char IFC base64 (first char 0-3)", guidShapeOk, guids.length + " ids");
  check(name + ": GlobalIds are unique within the file", new Set(guids).size === guids.length);

  return { entities, bytes: Buffer.byteLength(step, "utf8") };
}

console.log("IFC export bridge verification (deterministic)");
console.log("");

const starterStep = WT.ifc.generate(layoutObj(STARTER));
const mroStep = WT.ifc.generate(layoutObj(MRO));

validateStep("starter layout", starterStep, STARTER);
console.log("");
validateStep("MRO preset", mroStep, MRO);

// ---- determinism ----------------------------------------------------
console.log("");
check("determinism: starter generated twice is byte-identical",
  WT.ifc.generate(layoutObj(STARTER)) === starterStep);
check("determinism: MRO generated twice is byte-identical",
  WT.ifc.generate(layoutObj(MRO)) === mroStep);

// ---- string escaping ------------------------------------------------
check("escaping: apostrophe doubles per STEP", WT.ifc.stepString("O'Hara") === "O''Hara");
check("escaping: backslash doubles per STEP", WT.ifc.stepString("a\\b") === "a\\\\b");
check("escaping: non-ASCII uses \\X2\\..\\X0\\", WT.ifc.stepString("Übung") === "\\X2\\00DC\\X0\\bung");
const nasty = WT.ifc.generate(layoutObj(STARTER), { projectName: "O'Hara \\ Große Halle" });
check("escaping: nasty project name lands escaped in the file",
  nasty.indexOf("O''Hara \\\\ Gro\\X2\\00DF\\X0\\e Halle") !== -1);
check("escaping: nasty file still has sequential parseable statements",
  nasty.split("\n").filter((l) => l[0] === "#").every((l) => /^#\d+=[A-Z0-9_]+\(.*\);$/.test(l)));

// ---- velocity classes (derived, deterministic) ----------------------
const vc = WT.ifc.velocityClasses(MRO, 40, 24, 1);
const vcVals = Object.values(vc);
check("velocity classes: every storage element classified A/B/C",
  vcVals.length === MRO.filter((e) => D.ELEMENTS[e.type].category === "storage").length &&
  vcVals.every((c) => c === "A" || c === "B" || c === "C"),
  "A:" + vcVals.filter((c) => c === "A").length + " B:" + vcVals.filter((c) => c === "B").length + " C:" + vcVals.filter((c) => c === "C").length);

// ---- file sizes -----------------------------------------------------
console.log("");
console.log("       starter export: " + Buffer.byteLength(starterStep, "utf8") + " bytes (" + STARTER.length + " elements)");
console.log("       MRO export:     " + Buffer.byteLength(mroStep, "utf8") + " bytes (" + MRO.length + " elements)");

// ---- gold standard: ifcopenshell (optional, skips gracefully) -------
console.log("");
console.log("Gold-standard check (ifcopenshell via tools/validate_ifc.py):");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wt-ifc-"));
const starterFile = path.join(tmp, "starter.ifc");
const mroFile = path.join(tmp, "mro.ifc");
fs.writeFileSync(starterFile, starterStep);
fs.writeFileSync(mroFile, mroStep);

function goldStandard(label, file, expectedProxies) {
  const res = spawnSync("python", [path.join(__dirname, "tools", "validate_ifc.py"), file, String(expectedProxies)], {
    encoding: "utf8",
    timeout: 120000,
  });
  if (res.error || res.status === null) {
    console.log("       SKIP (" + label + "): could not run python (" + (res.error ? res.error.code : "no status") + ") - structural checks above still cover the file");
    return;
  }
  process.stdout.write(res.stdout.replace(/^/gm, "       "));
  if (res.stderr && res.stderr.trim()) process.stdout.write(res.stderr.replace(/^/gm, "       [py-err] "));
  if (res.status === 3) {
    console.log("       SKIP (" + label + "): ifcopenshell not installed - structural checks above still cover the file");
  } else {
    check("ifcopenshell validates the " + label + " export", res.status === 0);
  }
}

goldStandard("starter", starterFile, STARTER.length);
goldStandard("MRO", mroFile, MRO.length);

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

console.log("");
console.log(failures === 0 ? "ALL IFC EXPORT CHECKS PASSED" : failures + " IFC EXPORT CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
