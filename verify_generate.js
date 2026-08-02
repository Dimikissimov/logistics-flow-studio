/* =====================================================================
 * verify_generate.js - AI Environment Generator verification harness.
 *
 * Runs the REAL app modules (domain.js, compliance.js, generate.js,
 * nlcommands.js) in Node with the same window shim the other harnesses
 * use and asserts EXACT outcomes:
 *
 *   Generator
 *     - the 4 pinned plant-profile keys exist (and only those)
 *     - rgv (+agv) exist in the domain as transport with 0 capacity
 *     - determinism: generateLayout is BYTE-IDENTICAL per profile+seed
 *     - seed actually changes the layout
 *     - every profile is overlap-free AND passes / honestly-warns
 *       compliance.check (never a FAIL) on the app's 40x24 floor
 *     - the layout serialization token stays "wt-1"
 *     - the three modes (auto / guided / manual-reserve) behave
 *   NL parser (offline, deterministic)
 *     - "include 2 more RGVs in the picking sector" -> EXACTLY +2 rgv in picking
 *     - "leave zone picking for manual expansion" reserves + empties it
 *     - "use the cold-chain baseline" regenerates that profile
 *     - "widen the main aisle to 4 m" widens + stays compliant
 *     - "remove the conveyor in packing" removes it
 *     - an unknown command returns an HONEST not-understood (never guesses)
 *
 * Everything is deterministic. Usage:  node verify_generate.js
 * ASCII-only output. Exit 0 = all checks pass.
 * ===================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");

global.window = global; // app modules attach themselves to window.WT
for (const f of ["domain.js", "compliance.js", "generate.js", "nlcommands.js"]) {
  // eslint-disable-next-line no-eval
  (0, eval)(fs.readFileSync(path.join(__dirname, f), "utf8"));
}
const WT = global.WT;
const D = WT.domain;
const C = WT.compliance;
const G = WT.generate;
const NL = WT.nl;

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? "[PASS] " : "[FAIL] ") + name + (detail ? " - " + detail : ""));
  if (!ok) failures++;
}

const PROFILE_KEYS = ["ecommerce-fulfilment", "spare-parts-distribution", "automotive-supply", "cold-chain"];
const GRID = { gridW: 40, gridH: 24 };

function layoutObj(gen) {
  return { version: "wt-1", gridW: gen.gridW, gridH: gen.gridH, cell: 1, elements: gen.elements };
}
function complianceOf(gen) {
  return C.check(layoutObj(gen), { minAisleMetres: gen.config.minAisleMetres });
}
function overlapFree(els) {
  for (let i = 0; i < els.length; i++)
    for (let j = i + 1; j < els.length; j++)
      if (G.rectsOverlap(els[i], els[j])) return false;
  return true;
}
function countType(els, type, zone) {
  return els.filter((e) => e.type === type && (!zone || e.zone === zone)).length;
}

console.log("AI Environment Generator verification (deterministic)");
console.log("");

/* ---- 1. Pinned profile keys ------------------------------------- */
const keys = Object.keys(G.plantProfiles);
check("plantProfiles has exactly the 4 pinned keys",
  PROFILE_KEYS.every((k) => keys.indexOf(k) !== -1) && keys.length === 4, keys.join(", "));

/* ---- 2. rgv/agv exist in the domain as 0-capacity transport ----- */
const rgv = D.ELEMENTS["rgv"];
check("domain has an 'rgv' element", !!rgv, rgv ? rgv.label : "missing");
check("rgv has 0 storage capacity (elementCapacity)",
  !!rgv && D.elementCapacity({ type: "rgv", w: 6, d: 2 }) === 0,
  rgv ? "cap=" + D.elementCapacity({ type: "rgv", w: 6, d: 2 }) : "n/a");
check("rgv is not a storage category (honest transport)",
  !!rgv && rgv.category !== "storage" && rgv.transport === true, rgv ? rgv.category : "n/a");
check("domain also has an 'agv' element with 0 capacity",
  !!D.ELEMENTS["agv"] && D.elementCapacity({ type: "agv", w: 4, d: 1 }) === 0);

/* ---- 3. Determinism: byte-identical per profile+seed ------------ */
for (const k of PROFILE_KEYS) {
  const a = JSON.stringify(G.generateLayout(k, Object.assign({ seed: 7 }, GRID)));
  const b = JSON.stringify(G.generateLayout(k, Object.assign({ seed: 7 }, GRID)));
  check("determinism: " + k + " (seed 7) is byte-identical on re-run", a === b, a.length + " bytes");
}

/* ---- 4. Seed actually changes the layout ------------------------ */
const s1 = JSON.stringify(G.generateLayout("ecommerce-fulfilment", Object.assign({ seed: 1 }, GRID)).elements);
const s2 = JSON.stringify(G.generateLayout("ecommerce-fulfilment", Object.assign({ seed: 2 }, GRID)).elements);
check("seed changes the generated layout (seed 1 != seed 2)", s1 !== s2);

/* ---- 5. Each profile: overlap-free + compliance never FAILs ----- */
for (const k of PROFILE_KEYS) {
  const gen = G.generateLayout(k, Object.assign({ seed: 42 }, GRID));
  check(k + ": generated layout is overlap-free", overlapFree(gen.elements), gen.elements.length + " elements");
  const rep = complianceOf(gen);
  check(k + ": compliance passes or honestly warns (never fails)",
    rep.summary.worst !== "fail",
    "worst=" + rep.summary.worst + " (pass " + rep.summary.pass + " warn " + rep.summary.warn + " fail " + rep.summary.fail + ")");
  check(k + ": serialization token is wt-1", gen.meta.version === "wt-1", gen.meta.version);
}

/* ---- 6. Three modes behave -------------------------------------- */
// Auto / Guided both build the full environment (all zones populated).
const auto = G.generateLayout("automotive-supply", Object.assign({ seed: 5 }, GRID));
check("mode Auto/Guided: builds a full environment (storage + picking present)",
  auto.meta.counts.storage >= 1 && auto.meta.counts.picking >= 1,
  "storage=" + auto.meta.counts.storage + " picking=" + auto.meta.counts.picking);
// Manual-reserve: a reserved zone is left EMPTY and flagged.
const reserved = G.generateLayout("automotive-supply", Object.assign({ seed: 5, reserve: ["picking"] }, GRID));
const pickingEls = reserved.elements.filter((e) => e.zone === "picking");
const pickZone = reserved.meta.zones.find((z) => z.key === "picking");
check("mode Manual-reserve: reserved 'picking' zone is left empty",
  pickingEls.length === 0, pickingEls.length + " picking elements");
check("mode Manual-reserve: reserved zone is flagged reserved + in meta.reserved",
  !!pickZone && pickZone.reserved === true && reserved.meta.reserved.indexOf("picking") !== -1);
check("mode Manual-reserve: docks still present (exits kept for compliance)",
  countType(reserved.elements, "dock-out") >= 1 && complianceOf(reserved).summary.worst !== "fail");

/* ---- 7. NL: the pinned RGV command -> EXACTLY +2 rgv in picking -- */
const base = G.generateLayout("spare-parts-distribution", Object.assign({ seed: 3 }, GRID));
const beforeRgv = countType(base.elements, "rgv", "picking");
const parsed = NL.parse("include 2 more RGVs in the picking sector");
check("NL parse: 'include 2 more RGVs in the picking sector' -> add/rgv/2/picking",
  parsed.ok && parsed.op.kind === "add" && parsed.op.type === "rgv" &&
  parsed.op.count === 2 && parsed.op.zone === "picking",
  parsed.ok ? JSON.stringify(parsed.op) : parsed.message);
const applied = NL.apply(base, "include 2 more RGVs in the picking sector");
const afterRgv = applied.ok ? countType(applied.layout.elements, "rgv", "picking") : -999;
check("NL apply: RGV command adds EXACTLY +2 rgv in the picking zone",
  applied.ok && afterRgv - beforeRgv === 2, "before " + beforeRgv + " -> after " + afterRgv);
check("NL apply: the RGV command touches no other zone's rgv count",
  applied.ok && countType(applied.layout.elements, "rgv", "storage") === countType(base.elements, "rgv", "storage"));

/* ---- 8. NL: reserve a zone -------------------------------------- */
const resParse = NL.parse("leave zone picking for manual expansion");
check("NL parse: 'leave zone picking for manual expansion' -> reserve/picking",
  resParse.ok && resParse.op.kind === "reserve" && resParse.op.zone === "picking",
  resParse.ok ? JSON.stringify(resParse.op) : resParse.message);
const resApplied = NL.apply(base, "leave zone picking for manual expansion");
check("NL apply: reserving picking empties it + marks it reserved",
  resApplied.ok &&
  resApplied.layout.elements.filter((e) => e.zone === "picking").length === 0 &&
  resApplied.layout.meta.reserved.indexOf("picking") !== -1);

/* ---- 9. NL: regenerate from a named baseline -------------------- */
const regen = NL.parse("use the cold-chain baseline");
check("NL parse: 'use the cold-chain baseline' -> regenerate/cold-chain",
  regen.ok && regen.op.kind === "regenerate" && regen.op.profileKey === "cold-chain",
  regen.ok ? JSON.stringify(regen.op) : regen.message);
const regenApplied = NL.apply(base, "use the cold-chain baseline");
check("NL apply: regenerate switches the layout to the cold-chain profile",
  regenApplied.ok && regenApplied.layout.meta.profileKey === "cold-chain");

/* ---- 10. NL: widen the main aisle ------------------------------- */
const widen = NL.parse("widen the main aisle to 4 m");
check("NL parse: 'widen the main aisle to 4 m' -> widen/4",
  widen.ok && widen.op.kind === "widen" && widen.op.metres === 4,
  widen.ok ? JSON.stringify(widen.op) : widen.message);
const widenApplied = NL.apply(base, "widen the main aisle to 4 m");
check("NL apply: widen sets minAisle to 4 m and stays overlap-free + non-failing",
  widenApplied.ok && widenApplied.layout.config.minAisleMetres === 4 &&
  overlapFree(widenApplied.layout.elements) &&
  complianceOf(widenApplied.layout).summary.worst !== "fail");

/* ---- 11. NL: remove a type in a zone ---------------------------- */
const rmParse = NL.parse("remove the conveyor in packing");
check("NL parse: 'remove the conveyor in packing' -> remove/conveyor/packing",
  rmParse.ok && rmParse.op.kind === "remove" && rmParse.op.type === "conveyor" && rmParse.op.zone === "packing",
  rmParse.ok ? JSON.stringify(rmParse.op) : rmParse.message);
const rmApplied = NL.apply(base, "remove the conveyor in packing");
check("NL apply: remove drops the packing conveyor",
  rmApplied.ok && countType(rmApplied.layout.elements, "conveyor", "packing") === 0 &&
  countType(base.elements, "conveyor", "packing") >= 1);

/* ---- 12. NL: unknown / ambiguous -> honest not-understood ------- */
const junk = NL.parse("make me a sandwich with extra pickles");
check("NL parse: gibberish returns an HONEST not-understood (never guesses)",
  junk.ok === false && junk.op === null && /couldn't understand|I understand/i.test(junk.message),
  junk.message.slice(0, 60) + "...");
const ambiguous = NL.parse("add 3 RGVs");
check("NL parse: 'add 3 RGVs' with no zone is NOT silently guessed",
  ambiguous.ok === false && /which zone/i.test(ambiguous.message));
const junkApplied = NL.apply(base, "teleport the racks to the moon");
check("NL apply: an unparseable command changes nothing (ok=false, no layout)",
  junkApplied.ok === false && junkApplied.layout == null);

/* ---- sample transcript, for the record -------------------------- */
console.log("");
console.log("Sample parser transcript:");
function line(text) {
  const p = NL.parse(text);
  console.log("  > " + text);
  console.log("    " + (p.ok ? "OK  " + p.echo : "NO  " + p.message));
}
line("include 2 more RGVs in the picking sector");
line("leave zone picking for manual expansion");
line("do a barrel roll");

console.log("");
console.log(failures === 0 ? "ALL GENERATOR CHECKS PASSED" : failures + " GENERATOR CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
