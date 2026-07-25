/* =====================================================================
 * Logistics Flow Studio - LSP Planner (P5)
 * lsp/verify.js - Node verification harness for the evaluation engine
 * ---------------------------------------------------------------------
 * Run:  node lsp/verify.js
 * Proves, on the exact code the app ships (lsp-engine.js exports both
 * to the browser and to Node):
 *   1. DETERMINISM  - building + evaluating the same design twice gives
 *                     byte-identical JSON on every level.
 *   2. L3 LESSON    - pull beats push on the volatile-demand level
 *                     (same network, only the DC mode flipped).
 *   3. L4 LESSON    - adding the cross-dock improves the score vs the
 *                     same network with direct DC->zone lanes.
 *   4. TIER GATE    - demo tier allows L1-L2 only; full allows all
 *                     (loads ../tiers.js with a stubbed window).
 *   5. REFERENCES   - a sensible reference design passes every level's
 *                     thresholds (budgets are honest, not decorative).
 * ASCII-only output. Exit code 0 = all gates green.
 * ===================================================================== */
"use strict";
const path = require("path");
const E = require(path.join(__dirname, "lsp-engine.js"));

let failures = 0;
function check(name, ok, detail) {
  const mark = ok ? "PASS" : "FAIL";
  console.log("  [" + mark + "] " + name + (detail ? " - " + detail : ""));
  if (!ok) failures++;
}
function eur(n) { return Math.round(n).toString(); }

/* ------------------------------------------------------------------
 * Reference designs come from the engine itself (E.referenceDesign -
 * the same "Starter" networks the UI offers; the level budgets were
 * calibrated against them). The LESSON VARIANTS below are the designs
 * that are supposed to fail or lose.
 * ------------------------------------------------------------------ */
function refL2Single() {
  // L2 with ONE central DC instead of the intended central + regional.
  const d = E.newDesign("L2");
  const f = d.sites.find((s) => s.type === "factory");
  const dc = E.addSite(d, "central-dc", 48, 17);
  E.addLane(d, f.id, dc.id, "ftl");
  for (const z of d.sites.filter((s) => s.type === "zone")) E.addLane(d, dc.id, z.id, "ftl");
  return d;
}

function refL3(mode) {
  // The L3 reference network with the DC forced to push or pull.
  const d = E.referenceDesign("L3");
  d.sites.find((s) => s.type === "central-dc").mode = mode;
  return d;
}

function refL4(withCrossdock) {
  if (withCrossdock) return E.referenceDesign("L4");
  // Same network minus the cross-dock: direct long thin lanes.
  const d = E.newDesign("L4");
  const f = d.sites.find((s) => s.type === "factory");
  const dc = E.addSite(d, "central-dc", 26, 18);
  E.addLane(d, f.id, dc.id, "ftl");
  for (const z of d.sites.filter((s) => s.type === "zone")) E.addLane(d, dc.id, z.id, "parcel");
  return d;
}

const REFS = {};
for (const lv of E.LEVELS) REFS[lv.id] = () => E.referenceDesign(lv.id);

/* ------------------------------------------------------------------ */
function summarize(res) {
  const t = res.totals, s = res.score;
  return "cost " + eur(t.totalCostWk) + " EUR/wk, service " + (t.serviceLevel * 100).toFixed(1) +
    "%, CO2 " + eur(t.co2KgWk) + " kg/wk, score " + s.total + "/100 (" + s.stars + " stars), " +
    (s.pass ? "PASSES" : "fails");
}

const calibrate = process.argv.includes("--calibrate");
if (calibrate) {
  console.log("CALIBRATION - reference designs vs current thresholds");
  console.log("L2 single-DC variant : " + summarize(E.evaluate(refL2Single())));
  console.log("L3 push variant      : " + summarize(E.evaluate(refL3("push"))));
  console.log("L4 no-crossdock      : " + summarize(E.evaluate(refL4(false))));
  for (const lv of E.LEVELS) {
    const res = E.evaluate(REFS[lv.id]());
    console.log(lv.id + " reference          : " + summarize(res));
    console.log("     breakdown: transport " + res.totals.transportCostWk + " fixed " + res.totals.facilityFixedWk +
      " handling " + res.totals.handlingCostWk + " holding " + res.totals.holdingCostWk);
    for (const c of res.score.checks) {
      console.log("     check " + c.id + ": actual " + c.actual + " " + c.cmp + " " + c.limit + " " + c.unit + " -> " + (c.ok ? "ok" : "MISS"));
    }
  }
  process.exit(0);
}

console.log("LSP Planner verification harness");
console.log("");

// ---- 1. Determinism ------------------------------------------------
console.log("1. Determinism (same seed -> identical evaluation)");
for (const lv of E.LEVELS) {
  const a = JSON.stringify(E.evaluate(REFS[lv.id]()));
  const b = JSON.stringify(E.evaluate(REFS[lv.id]()));
  check(lv.id + " evaluate twice from scratch -> identical JSON", a === b);
}
// Demand seeding is part of the determinism claim.
{
  const z1 = JSON.stringify(E.levelZoneDemand(E.levelById("L3")));
  const z2 = JSON.stringify(E.levelZoneDemand(E.levelById("L3")));
  check("Seeded zone demand identical across calls", z1 === z2);
}

// ---- 2. L3: pull beats push ---------------------------------------
console.log("");
console.log("2. L3 lesson: pull beats push under volatile demand");
{
  const pull = E.evaluate(refL3("pull"));
  const push = E.evaluate(refL3("push"));
  check("pull score > push score", pull.score.total > push.score.total,
    "pull " + pull.score.total + " vs push " + push.score.total);
  check("pull service > push service", pull.totals.serviceLevel > push.totals.serviceLevel,
    (pull.totals.serviceLevel * 100).toFixed(1) + "% vs " + (push.totals.serviceLevel * 100).toFixed(1) + "%");
  check("pull holding < push holding", pull.totals.holdingCostWk < push.totals.holdingCostWk,
    pull.totals.holdingCostWk + " vs " + push.totals.holdingCostWk + " EUR/wk");
  check("pull passes the level, push does not", pull.score.pass && !push.score.pass,
    "pull " + (pull.score.pass ? "pass" : "fail") + ", push " + (push.score.pass ? "pass" : "fail"));
}

// ---- 3. L4: cross-dock pays off -----------------------------------
console.log("");
console.log("3. L4 lesson: the cross-dock improves the score");
{
  const withXd = E.evaluate(refL4(true));
  const noXd = E.evaluate(refL4(false));
  check("cross-dock score > direct-lanes score", withXd.score.total > noXd.score.total,
    "with " + withXd.score.total + " vs without " + noXd.score.total);
  check("cross-dock cuts weekly cost", withXd.totals.totalCostWk < noXd.totals.totalCostWk,
    eur(withXd.totals.totalCostWk) + " vs " + eur(noXd.totals.totalCostWk) + " EUR/wk");
  check("cross-dock cuts the CO2 estimate", withXd.totals.co2KgWk < noXd.totals.co2KgWk,
    eur(withXd.totals.co2KgWk) + " vs " + eur(noXd.totals.co2KgWk) + " kg/wk");
  check("cross-dock design passes L4, direct design does not", withXd.score.pass && !noXd.score.pass);
}

// ---- 4. Tier gate --------------------------------------------------
console.log("");
console.log("4. Tier gate: demo locks L3+ (../tiers.js, stubbed window)");
{
  global.window = global.window || {};
  require(path.join(__dirname, "..", "tiers.js"));
  const tiers = global.window.WT.tiers;
  // No localStorage in Node -> current() falls back to "demo".
  const demoCaps = tiers.caps();
  check("default tier is demo", demoCaps.isDemo === true);
  check("demo allows L1", demoCaps.lspLevelAllowed("L1") === true);
  check("demo allows L2", demoCaps.lspLevelAllowed("L2") === true);
  check("demo locks L3", demoCaps.lspLevelAllowed("L3") === false);
  check("demo locks L4", demoCaps.lspLevelAllowed("L4") === false);
  check("demo locks L5", demoCaps.lspLevelAllowed("L5") === false);
  const full = tiers.TIERS.full;
  check("full tier unlocks all levels (lspLevels = null)", full.lspLevels === null);
}

// ---- 5. Reference designs pass their levels ------------------------
console.log("");
console.log("5. Reference designs pass every level (budgets are honest)");
for (const lv of E.LEVELS) {
  const res = E.evaluate(REFS[lv.id]());
  check(lv.id + " reference passes", res.score.pass, summarize(res));
}
// The L2 lesson: one central DC alone misses the service target.
{
  const single = E.evaluate(refL2Single());
  check("L2 single-DC design fails (pooling vs proximity is a real trade)",
    !single.score.pass, summarize(single));
}

console.log("");
console.log(failures === 0 ? "ALL GATES GREEN" : failures + " GATE(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
