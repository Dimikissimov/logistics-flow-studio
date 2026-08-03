/* =====================================================================
 * verify_flowsim.js - Live material-flow animation model verification (P3)
 *
 * Runs the REAL app modules (domain.js, simulation.js, generate.js,
 * examples.js, wms.js, flowsim.js) in Node under the same window shim the
 * other harnesses use and asserts the animated material-flow model
 * (WT.flowsim) is deterministic, conserving, in-bounds, ordered and tied
 * to the WMS throughput heuristic:
 *
 *   1.  The API surface exists (spawnPlan, step, state, PARAMS) and the 5
 *       flow stages are present in the standard order.
 *   2.  Determinism on an examples.js layout: two independent runs of the
 *       same (layout, seed, ticks) produce byte-identical MU positions +
 *       counters.
 *   3.  Determinism on a generated (WT.generate) layout.
 *   4.  Unit conservation at EVERY step: spawned == in-flight + completed.
 *   5.  Finite pool (loop:false) conserves and drains: eventually
 *       completed == totalUnits, in-flight == 0, spawned == totalUnits.
 *   6.  MUs always stay within the floor bounds across a long run.
 *   7.  MUs progress through the stages IN ORDER (per-MU stage index is
 *       non-decreasing over time - never runs backwards).
 *   8.  Positions are in WORLD CELLS (not pixels): every MU cx/cy lies in
 *       [0, gridW] x [0, gridH]; the waypoint list has >= 5 world-cell
 *       waypoints spanning the flow spine.
 *   9.  Throughput responds to the layout (monotonic sanity via WT.wms):
 *       more docks + automation + pack stations -> higher line throughput
 *       AND more units completed after the same number of ticks.
 *  10.  Runs on an examples.js layout (spawns, moves and completes MUs).
 *  11.  Runs on a generated layout (spawns, moves and completes MUs).
 *  12.  Spawn/completion rate is tied to WT.wms: plan.lineThroughput ==
 *       max(minLineThroughput, min stage capacity from WT.wms.capacities).
 *  13.  Units retire at shipping: over a run some MUs reach the shipping
 *       stage and completed grows.
 *  14.  Honesty: the SYNTHETIC label is present and states NOT a real DES
 *       engine / NOT a measurement / NOT a certification.
 *
 * Everything is deterministic (seeded, never wall-clock). Usage:
 *   node verify_flowsim.js
 * ASCII-only output. Exit 0 = all checks pass.
 * ===================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");

global.window = global; // app modules attach themselves to window.WT
for (const f of ["domain.js", "compliance.js", "simulation.js", "generate.js", "nlcommands.js", "examples.js", "wms.js", "flowsim.js"]) {
  // eslint-disable-next-line no-eval
  (0, eval)(fs.readFileSync(path.join(__dirname, f), "utf8"));
}
const WT = global.WT;
const D = WT.domain;
const F = WT.flowsim;
const G = WT.generate;
const E = WT.examples;

let failures = 0;
let checks = 0;
function check(name, ok, detail) {
  checks++;
  console.log((ok ? "[PASS] " : "[FAIL] ") + name + (detail ? " - " + detail : ""));
  if (!ok) failures++;
}
const finite = (v) => typeof v === "number" && isFinite(v);

// ---- fixture helpers ------------------------------------------------
function mk(list) {
  let i = 0;
  return list.map((e) => {
    const def = D.ELEMENTS[e.type] || {};
    return { id: "el-" + ++i, type: e.type, x: e.x, y: e.y, w: e.w || def.w, d: e.d || def.d };
  });
}
function examplesLayout(id) {
  const b = E.build(id);
  return { elements: b.elements, gridW: b.gridW, gridH: b.gridH, cell: 1, config: b.config, meta: b.meta };
}
function generatedLayout(profile, seed) {
  const g = G.generateLayout(profile, { seed: seed });
  return { elements: g.elements, gridW: g.gridW, gridH: g.gridH, cell: 1, config: g.config, meta: g.meta };
}

console.log("Live material-flow (flowsim) verification (deterministic)");
console.log("");

/* ---------------------------------------------------------------------
 * 1. API surface + stage order.
 * ------------------------------------------------------------------- */
check("WT.flowsim exposes spawnPlan/step/state/PARAMS",
  F && typeof F.spawnPlan === "function" && typeof F.step === "function" &&
  typeof F.state === "function" && F.PARAMS && typeof F.PARAMS === "object");
check("the 5 flow stages are present in the standard order",
  JSON.stringify(F.STAGES) === JSON.stringify(["receiving", "storage", "picking", "packing", "shipping"]),
  (F.STAGES || []).join(" -> "));

/* ---------------------------------------------------------------------
 * 2 + 3. Determinism (examples + generated).
 * ------------------------------------------------------------------- */
function runTicks(layout, opts, nTicks, dtPerStep) {
  const s = F.state(layout, opts);
  for (let i = 0; i < nTicks; i++) F.step(s, dtPerStep);
  return s;
}
function snapshot(s) {
  // MU positions/stages + the live counters (the animation's observable state).
  return JSON.stringify({
    tick: s.tick, spawned: s.spawned, completed: s.completed, inflight: s.inflight,
    perStage: s.perStage,
    mus: s.mus.map((m) => [m.id, m.seg, +m.t.toFixed(9), +m.cx.toFixed(9), +m.cy.toFixed(9), m.stage]),
  });
}

const exId = "ecommerce-multichannel-fc";
const exLayout = examplesLayout(exId);
const exA = runTicks(exLayout, { seed: 7, loop: true }, 120, 1);
const exB = runTicks(examplesLayout(exId), { seed: 7, loop: true }, 120, 1);
check("deterministic on an examples.js layout (" + exId + ") - identical MU state",
  snapshot(exA) === snapshot(exB));

const genLayout = generatedLayout("ecommerce-fulfilment", 11);
const gA = runTicks(genLayout, { seed: 11, loop: true }, 120, 1);
const gB = runTicks(generatedLayout("ecommerce-fulfilment", 11), { seed: 11, loop: true }, 120, 1);
check("deterministic on a generated layout (ecommerce-fulfilment) - identical MU state",
  snapshot(gA) === snapshot(gB));

// step(state, N) once == N single-tick steps (whole-tick advance property).
const oneShot = F.state(exLayout, { seed: 7, loop: true });
F.step(oneShot, 60);
const manyShot = runTicks(exLayout, { seed: 7, loop: true }, 60, 1);
check("step(state, N) equals N single-tick steps (whole-tick determinism)",
  snapshot(oneShot) === snapshot(manyShot));

/* ---------------------------------------------------------------------
 * 4. Unit conservation at every step (loop, so the pool never limits).
 * ------------------------------------------------------------------- */
{
  const s = F.state(exLayout, { seed: 3, loop: true });
  let conserved = true, sawSpawn = false, sawComplete = false;
  for (let i = 0; i < 400; i++) {
    F.step(s, 1);
    if (s.spawned !== s.inflight + s.completed) conserved = false;
    if (s.spawned > 0) sawSpawn = true;
    if (s.completed > 0) sawComplete = true;
  }
  check("unit conservation at EVERY step (spawned == in-flight + completed)", conserved,
    "spawned=" + s.spawned + " inflight=" + s.inflight + " completed=" + s.completed);
  check("the flow actually runs (units spawned and some completed)", sawSpawn && sawComplete,
    "spawned=" + s.spawned + " completed=" + s.completed);
}

/* ---------------------------------------------------------------------
 * 5. Finite pool drains and conserves.
 * ------------------------------------------------------------------- */
{
  const units = 40;
  const s = F.state(exLayout, { seed: 9, loop: false, units: units });
  let conserved = true;
  let guard = 0;
  while (!s.done && guard++ < 20000) {
    F.step(s, 1);
    if (s.spawned !== s.inflight + s.completed) conserved = false;
  }
  check("finite pool conserves every step and drains to done", conserved && s.done,
    "done=" + s.done + " after " + guard + " ticks");
  check("finite pool: completed == totalUnits, in-flight == 0, spawned == totalUnits",
    s.completed === units && s.inflight === 0 && s.spawned === units,
    "spawned=" + s.spawned + " completed=" + s.completed + " inflight=" + s.inflight + " pool=" + units);
}

/* ---------------------------------------------------------------------
 * 6. MUs stay within the floor bounds.
 * ------------------------------------------------------------------- */
{
  const s = F.state(genLayout, { seed: 11, loop: true });
  let inBounds = true;
  let worst = "";
  for (let i = 0; i < 500; i++) {
    F.step(s, 1);
    for (const m of s.mus) {
      if (!(m.cx >= 0 && m.cx <= s.gridW && m.cy >= 0 && m.cy <= s.gridH)) {
        inBounds = false;
        worst = "(" + m.cx.toFixed(2) + "," + m.cy.toFixed(2) + ") on " + s.gridW + "x" + s.gridH;
      }
    }
  }
  check("every MU stays within the floor bounds across a long run", inBounds, worst || "all in-bounds");
}

/* ---------------------------------------------------------------------
 * 7. MUs progress through the stages in order (never backwards).
 * ------------------------------------------------------------------- */
{
  const s = F.state(exLayout, { seed: 5, loop: true });
  const lastIdx = {}; // mu id -> last seen stage index
  let ordered = true;
  let offender = "";
  for (let i = 0; i < 400; i++) {
    F.step(s, 1);
    for (const m of s.mus) {
      const prev = lastIdx[m.id];
      if (prev !== undefined && m.stageIndex < prev) { ordered = false; offender = "mu#" + m.id + " " + prev + "->" + m.stageIndex; }
      lastIdx[m.id] = m.stageIndex;
    }
  }
  check("MUs progress through stages in order (stage index never decreases)", ordered, offender || "monotonic");
}

/* ---------------------------------------------------------------------
 * 8. Positions are world cells; waypoints span the flow spine.
 * ------------------------------------------------------------------- */
{
  const plan = F.spawnPlan(exLayout, { seed: 7 });
  const wpOk = Array.isArray(plan.waypoints) && plan.waypoints.length >= 5 &&
    plan.waypoints.every((w) => finite(w.x) && finite(w.y) && w.x >= 0 && w.x <= plan.gridW && w.y >= 0 && w.y <= plan.gridH);
  const stagesSpanned = plan.waypoints.map((w) => w.stage);
  const spineOk = stagesSpanned[0] === "receiving" && stagesSpanned[stagesSpanned.length - 1] === "shipping" &&
    stagesSpanned.indexOf("picking") !== -1 && stagesSpanned.indexOf("packing") !== -1;
  check("waypoints are >= 5 world-cell points spanning receiving..shipping", wpOk && spineOk,
    plan.waypoints.length + " waypoints: " + stagesSpanned.join(" -> "));

  const s = runTicks(exLayout, { seed: 7, loop: true }, 150, 1);
  const cellScale = s.mus.every((m) => m.cx <= s.gridW + 1e-6 && m.cy <= s.gridH + 1e-6);
  check("MU positions are world CELLS, not pixels (cx<=gridW, cy<=gridH)", cellScale && s.mus.length > 0,
    s.mus.length + " live MUs on " + s.gridW + "x" + s.gridH);
}

/* ---------------------------------------------------------------------
 * 9. Throughput responds to the layout (monotonic via WT.wms).
 * ------------------------------------------------------------------- */
{
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
  const pBase = F.spawnPlan(base, { seed: 5 });
  const pAug = F.spawnPlan(augmented, { seed: 5 });
  check("more docks + automation + pack -> higher line throughput (via WT.wms)",
    pAug.lineThroughput > pBase.lineThroughput,
    pBase.lineThroughput.toFixed(1) + " -> " + pAug.lineThroughput.toFixed(1) + " units/hr");

  const sBase = runTicks(base, { seed: 5, loop: true }, 300, 1);
  const sAug = runTicks(augmented, { seed: 5, loop: true }, 300, 1);
  check("more docks + automation + pack -> more units completed after equal ticks",
    sAug.completed > sBase.completed,
    sBase.completed + " -> " + sAug.completed + " completed in 300 ticks");
}

/* ---------------------------------------------------------------------
 * 10 + 11. Runs on examples + generated layouts (spawns/moves/completes).
 * ------------------------------------------------------------------- */
{
  const s = runTicks(exLayout, { seed: 1, loop: true }, 300, 1);
  check("runs on an examples.js layout (spawns, moves and completes MUs)",
    s.spawned > 0 && s.completed > 0 && s.inflight > 0,
    "spawned=" + s.spawned + " inflight=" + s.inflight + " completed=" + s.completed);
}
{
  const s = runTicks(genLayout, { seed: 2, loop: true }, 300, 1);
  check("runs on a generated layout (spawns, moves and completes MUs)",
    s.spawned > 0 && s.completed > 0 && s.inflight > 0,
    "spawned=" + s.spawned + " inflight=" + s.inflight + " completed=" + s.completed);
}

/* ---------------------------------------------------------------------
 * 12. Spawn/completion rate is tied to WT.wms.
 * ------------------------------------------------------------------- */
{
  const plan = F.spawnPlan(exLayout, { seed: 7 });
  const caps = WT.wms.capacities(exLayout, { seed: 7 });
  let minCap = Infinity;
  for (const c of caps) { const v = c.capacityUnitsPerHr; if (v > 0 && v < minCap) minCap = v; }
  const expected = Math.max(F.PARAMS.minLineThroughput, minCap);
  check("plan.lineThroughput == max(min WT.wms stage capacity, floor) - tied to wms",
    Math.abs(plan.lineThroughput - expected) < 1e-6,
    "flowsim=" + plan.lineThroughput.toFixed(3) + " expected=" + expected.toFixed(3));
}

/* ---------------------------------------------------------------------
 * 13. Units retire at shipping (some reach the shipping stage).
 * ------------------------------------------------------------------- */
{
  const s = F.state(exLayout, { seed: 4, loop: true });
  let sawShipping = false;
  for (let i = 0; i < 400; i++) {
    F.step(s, 1);
    if (s.perStage.shipping > 0) sawShipping = true;
  }
  check("units reach the shipping stage and retire (completed grows)",
    sawShipping && s.completed > 0, "completed=" + s.completed);
}

/* ---------------------------------------------------------------------
 * 14. Honesty labelling.
 * ------------------------------------------------------------------- */
{
  const plan = F.spawnPlan(exLayout, { seed: 7 });
  const lbl = plan.dataLabel || "";
  check("SYNTHETIC label present on the plan", /SYNTHETIC/.test(lbl));
  check("labelled NOT a real DES engine / NOT a measurement / NOT a certification",
    /NOT a real discrete-event/i.test(lbl) && /NOT a measurement/i.test(lbl) && /NOT a certification/i.test(lbl));
  check("routing honestly described as straight-segment waypoint routing",
    /straight-segment waypoint routing/i.test(plan.routing || ""));
}

console.log("");
console.log(failures === 0 ? "ALL FLOWSIM CHECKS PASSED (" + checks + " checks)" : failures + " OF " + checks + " FLOWSIM CHECKS FAILED");
process.exit(failures === 0 ? 0 : 1);
