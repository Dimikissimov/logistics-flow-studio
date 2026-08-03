/* =====================================================================
 * verify_flowB.js - Material-flow realism verification (P3.2)
 *
 * Runs the REAL app modules (domain.js, simulation.js, generate.js,
 * examples.js, wms.js, flowsim.js) in Node under the same window shim the
 * other harnesses use and asserts the P3.2 realism layer built ON TOP of
 * WT.flowsim - pick/put/pack STATIONS as active FIFO servers, CONVEYOR-
 * following routing and emergent QUEUE congestion - is deterministic,
 * conserving (INCLUDING queued units), honest and tied to WT.wms:
 *
 *   1.  API surface: station/queue/conveyor helpers + plan/state fields.
 *   2.  Station kinds pick/put/pack are identified from a layout that has
 *       all three element groups (staging, pick faces, pack stations).
 *   3.  Determinism WITH stations+queues on an examples.js layout: two
 *       runs of the same (layout, seed, ticks) give byte-identical MU AND
 *       station-queue state.
 *   4.  Determinism on a generated layout (same, incl. queues).
 *   5.  Whole-tick determinism: step(state, N) == N single-tick steps,
 *       including the station queues + service accumulators.
 *   6.  Unit conservation INCLUDING queued units at EVERY step: spawned ==
 *       in-flight + completed, in-flight counts queued MUs, and state.queued
 *       equals the sum of the per-station queue lengths.
 *   7.  Conveyor-path routing: a layout WITH a connected conveyor spine
 *       routes storage->picking ALONG conveyor cells - every onConveyor
 *       waypoint lies on a conveyor cell.
 *   8.  Fallback: a layout WITHOUT any conveyor falls back to the original
 *       straight-segment routing (no onConveyor waypoints; clean spine).
 *   9.  Congestion emerges: a station whose arrival rate exceeds its
 *       service rate builds a MONOTONICALLY growing queue that crosses the
 *       congestion threshold.
 *  10.  Honest fallback: with the default wms-tied service rates a finite
 *       pool drains to done with EVERY queue empty (congestion is not a
 *       permanent artifact of the model).
 *  11.  Throughput ties to WT.wms: the aggregate pick/put/pack station
 *       service rate reconstructs the WT.wms stage capacity, and
 *       plan.lineThroughput is still max(min wms capacity, floor).
 *  12.  MUs + queued units + station anchors stay within the floor bounds
 *       across a long run.
 *  13.  Runs on an examples.js layout (spawns, queues, moves, completes;
 *       stations present).
 *  14.  Runs on a generated layout (same).
 *  15.  Congestion metrics are consistent: state.maxQueue / congestedStations
 *       / queued match the live per-station queues.
 *  16.  Honesty: the SYNTHETIC label + NOT a real DES / NOT a measurement /
 *       NOT a certification, the routing string names conveyor-following AND
 *       keeps the straight-segment fallback, and the FIFO/heuristic (NOT
 *       queueing-theory) framing is present.
 *
 * Everything is deterministic (seeded, never wall-clock). Usage:
 *   node verify_flowB.js
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
function presetLayout(id) {
  const p = D.PRESETS[id];
  return { elements: mk(p.elements), gridW: 40, gridH: 24, cell: 1, config: p.config };
}
function runTicks(layout, opts, nTicks, dtPerStep) {
  const s = F.state(layout, opts);
  for (let i = 0; i < nTicks; i++) F.step(s, dtPerStep);
  return s;
}
// Observable state INCLUDING the station queues + service accumulators.
function snapshot(s) {
  return JSON.stringify({
    tick: s.tick, spawned: s.spawned, completed: s.completed, inflight: s.inflight,
    queued: s.queued, maxQueue: s.maxQueue, congestedStations: s.congestedStations,
    perStage: s.perStage,
    stations: s.stations.map((st) => [st.id, st.queue.length, +st.serviceAccum.toFixed(9)]),
    mus: s.mus.map((m) => [m.id, m.seg, +m.t.toFixed(9), +m.cx.toFixed(9), +m.cy.toFixed(9), m.stage, m.status, m.stationId || ""]),
  });
}

console.log("Material-flow realism (flowsim P3.2) verification (deterministic)");
console.log("");

/* ---------------------------------------------------------------------
 * Shared fixtures.
 * ------------------------------------------------------------------- */
const exId = "ecommerce-multichannel-fc";
const exLayout = examplesLayout(exId);
const genLayout = generatedLayout("ecommerce-fulfilment", 11);
const mroLayout = presetLayout("mro-distributor");

// A pack-only, no-automation overload rig: no staging (no put station), no
// pick faces (no pick station), a single pack station. Driving arrivals
// above the pack service rate makes ITS queue grow.
const overloadLayout = {
  elements: mk([
    { type: "dock-in", x: 2, y: 0 }, { type: "dock-in", x: 6, y: 0 }, { type: "dock-in", x: 10, y: 0 },
    { type: "selective-racking", x: 2, y: 6, w: 12, d: 1 },
    { type: "selective-racking", x: 2, y: 9, w: 12, d: 1 },
    { type: "pack-station", x: 2, y: 20 },
    { type: "dock-out", x: 2, y: 23 },
  ]),
  gridW: 40, gridH: 24, cell: 1, config: { seed: 5, strategy: "abc", orders: 200, skuCount: 80 },
};

// A layout WITH a connected conveyor spine from storage down to picking.
const withConveyor = {
  elements: mk([
    { type: "dock-in", x: 2, y: 0 },
    { type: "selective-racking", x: 2, y: 5, w: 10, d: 1 },
    { type: "conveyor", x: 16, y: 5, w: 1, d: 13 },
    { type: "carton-flow", x: 2, y: 18, w: 4, d: 2 },
    { type: "pack-station", x: 20, y: 20 },
    { type: "dock-out", x: 20, y: 23 },
  ]),
  gridW: 40, gridH: 24, cell: 1, config: { seed: 3 },
};

// A layout WITHOUT any conveyor/transport at all (straight-segment fallback).
const withoutConveyor = {
  elements: mk([
    { type: "dock-in", x: 2, y: 0 },
    { type: "selective-racking", x: 2, y: 6, w: 10, d: 1 },
    { type: "pack-station", x: 2, y: 20 },
    { type: "dock-out", x: 2, y: 23 },
  ]),
  gridW: 40, gridH: 24, cell: 1, config: { seed: 3 },
};

/* ---------------------------------------------------------------------
 * 1. API surface.
 * ------------------------------------------------------------------- */
{
  const apiOk = F && typeof F.buildStationSpecs === "function" &&
    typeof F.conveyorCells === "function" && typeof F.conveyorRoute === "function";
  const plan = F.spawnPlan(mroLayout, { seed: 42 });
  const st = F.state(mroLayout, { seed: 42, loop: true });
  const planOk = Array.isArray(plan.stations) && "conveyorRouted" in plan;
  const stateOk = Array.isArray(st.stations) && finite(st.queued) && finite(st.maxQueue) && finite(st.congestedStations);
  check("API: station/conveyor helpers + plan.stations + state queue fields exist",
    apiOk && planOk && stateOk,
    "helpers=" + apiOk + " plan.stations=" + (plan.stations || []).length + " state.stations=" + (st.stations || []).length);
}

/* ---------------------------------------------------------------------
 * 2. Station kinds pick/put/pack identified.
 * ------------------------------------------------------------------- */
{
  const plan = F.spawnPlan(mroLayout, { seed: 42 });
  const kinds = new Set(plan.stations.map((s) => s.kind));
  check("pick/put/pack stations identified from a layout with all three (MRO preset)",
    kinds.has("pick") && kinds.has("put") && kinds.has("pack"),
    "kinds={" + Array.from(kinds).sort().join(",") + "} from " + plan.stations.length + " stations");
}

/* ---------------------------------------------------------------------
 * 3 + 4. Determinism WITH stations + queues (examples + generated).
 * ------------------------------------------------------------------- */
{
  const a = runTicks(exLayout, { seed: 7, loop: true }, 150, 1);
  const b = runTicks(examplesLayout(exId), { seed: 7, loop: true }, 150, 1);
  check("deterministic on an examples.js layout - identical MU + station-queue state",
    snapshot(a) === snapshot(b));
}
{
  const a = runTicks(genLayout, { seed: 11, loop: true }, 150, 1);
  const b = runTicks(generatedLayout("ecommerce-fulfilment", 11), { seed: 11, loop: true }, 150, 1);
  check("deterministic on a generated layout - identical MU + station-queue state",
    snapshot(a) === snapshot(b));
}

/* ---------------------------------------------------------------------
 * 5. Whole-tick determinism WITH stations (step(N) == N x step(1)).
 * ------------------------------------------------------------------- */
{
  const oneShot = F.state(mroLayout, { seed: 42, loop: true });
  F.step(oneShot, 90);
  const manyShot = runTicks(mroLayout, { seed: 42, loop: true }, 90, 1);
  check("step(state, N) equals N single-tick steps incl. station queues",
    snapshot(oneShot) === snapshot(manyShot));
}

/* ---------------------------------------------------------------------
 * 6. Unit conservation INCLUDING queued units at every step.
 * ------------------------------------------------------------------- */
{
  const s = F.state(overloadLayout, { seed: 5, loop: true, arrivalUnitsPerHr: 150 });
  let conserved = true, queuedOk = true, inflightOk = true, sawQueue = false, worst = "";
  for (let i = 0; i < 200; i++) {
    F.step(s, 1);
    if (s.spawned !== s.inflight + s.completed) { conserved = false; worst = "spawned=" + s.spawned + " inflight=" + s.inflight + " completed=" + s.completed; }
    const sumQ = s.stations.reduce((a, st) => a + st.queue.length, 0);
    if (s.queued !== sumQ) queuedOk = false;
    if (s.queued > s.inflight) inflightOk = false; // queued MUs are a subset of in-flight
    if (s.queued > 0) sawQueue = true;
  }
  check("unit conservation INCLUDING queued at EVERY step (spawned == in-flight + completed)",
    conserved && queuedOk && inflightOk && sawQueue,
    worst || ("queued<=inflight, queued==sum(queues), sawQueue=" + sawQueue));
}

/* ---------------------------------------------------------------------
 * 7. Conveyor-following routing lies on conveyor cells.
 * ------------------------------------------------------------------- */
{
  const plan = F.spawnPlan(withConveyor, { seed: 3 });
  const onC = plan.waypoints.filter((w) => w.onConveyor);
  const cells = F.conveyorCells(withConveyor);
  const cellSet = new Set(cells.map((c) => c.x + "," + c.y));
  const allOn = onC.length > 0 && onC.every((w) => cellSet.has(w.x + "," + w.y));
  check("conveyor path: storage->picking routes ALONG conveyor cells (waypoints on cells)",
    plan.conveyorRouted && allOn,
    onC.length + " onConveyor waypoints, all on conveyor cells=" + allOn);
}

/* ---------------------------------------------------------------------
 * 8. Fallback to straight-segment routing without a conveyor.
 * ------------------------------------------------------------------- */
{
  const plan = F.spawnPlan(withoutConveyor, { seed: 3 });
  const onC = plan.waypoints.filter((w) => w.onConveyor);
  const stages = plan.waypoints.map((w) => w.stage);
  const spineOk = stages[0] === "receiving" && stages[stages.length - 1] === "shipping" &&
    stages.indexOf("picking") !== -1 && stages.indexOf("packing") !== -1;
  check("no conveyor -> straight-segment fallback (no onConveyor waypoints, clean spine)",
    !plan.conveyorRouted && onC.length === 0 && spineOk,
    "onConveyor=" + onC.length + " routed=" + plan.conveyorRouted + " spine=" + stages.join(">"));
}

/* ---------------------------------------------------------------------
 * 9. Congestion emerges: arrival > service -> monotonically growing queue.
 * ------------------------------------------------------------------- */
{
  const s = F.state(overloadLayout, { seed: 5, loop: true, arrivalUnitsPerHr: 150 });
  const packOf = () => s.stations.find((st) => st.kind === "pack");
  const packService = packOf().serviceRatePerTick;
  // Warm up until the first units reach the (slow, no-automation) pack.
  for (let i = 0; i < 70; i++) F.step(s, 1);
  const samples = [];
  for (let k = 0; k < 8; k++) { for (let i = 0; i < 10; i++) F.step(s, 1); samples.push(packOf().queue.length); }
  let monotonic = true;
  for (let i = 1; i < samples.length; i++) if (samples[i] < samples[i - 1]) monotonic = false;
  const grew = samples[samples.length - 1] > samples[0];
  const congested = s.congestedStations >= 1 && s.maxQueue >= F.PARAMS.congestQueueThreshold;
  check("a station whose arrivals exceed its service builds a monotonically growing queue",
    monotonic && grew && congested,
    "packSvc=" + packService.toFixed(3) + "/tick, queue samples [" + samples.join(",") + "], congested=" + s.congestedStations);
}

/* ---------------------------------------------------------------------
 * 10. Honest fallback: default wms-tied rates -> queues drain to empty.
 * ------------------------------------------------------------------- */
{
  const s = F.state(overloadLayout, { seed: 5, loop: false, units: 60 });
  let conserved = true, guard = 0;
  while (!s.done && guard++ < 20000) {
    F.step(s, 1);
    if (s.spawned !== s.inflight + s.completed) conserved = false;
  }
  check("default (wms-tied) rates: finite pool drains to done with EVERY queue empty",
    conserved && s.done && s.completed === 60 && s.queued === 0 && s.maxQueue === 0,
    "done=" + s.done + " completed=" + s.completed + " queued=" + s.queued + " maxQueue=" + s.maxQueue);
}

/* ---------------------------------------------------------------------
 * 11. Station service rates + line throughput tie to WT.wms.
 * ------------------------------------------------------------------- */
{
  const plan = F.spawnPlan(mroLayout, { seed: 42 });
  const caps = WT.wms.capacities(mroLayout, { seed: 42 });
  const capOf = (id) => (caps.find((c) => c.id === id) || {}).capacityUnitsPerHr || 0;
  const aggByKind = { put: 0, pick: 0, pack: 0 };
  for (const st of plan.stations) aggByKind[st.kind] += st.serviceRatePerTick * F.PARAMS.ticksPerHour;
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  const tied = near(aggByKind.put, capOf("put-away")) && near(aggByKind.pick, capOf("order-picking")) && near(aggByKind.pack, capOf("packing"));
  let minCap = Infinity;
  for (const c of caps) { const v = c.capacityUnitsPerHr; if (v > 0 && v < minCap) minCap = v; }
  const lineOk = Math.abs(plan.lineThroughput - Math.max(F.PARAMS.minLineThroughput, minCap)) < 1e-6;
  check("station service rates reconstruct WT.wms stage capacities; lineThroughput tied to wms",
    tied && lineOk,
    "pack agg=" + aggByKind.pack.toFixed(2) + " vs wms packing=" + capOf("packing").toFixed(2) + "; line=" + plan.lineThroughput.toFixed(2));
}

/* ---------------------------------------------------------------------
 * 12. MUs + queued units + station anchors stay in bounds.
 * ------------------------------------------------------------------- */
{
  const s = F.state(overloadLayout, { seed: 5, loop: true, arrivalUnitsPerHr: 150 });
  let inBounds = true, worst = "";
  const anchorsOk = s.stations.every((st) => st.x >= 0 && st.x <= s.gridW && st.y >= 0 && st.y <= s.gridH);
  for (let i = 0; i < 200; i++) {
    F.step(s, 1);
    for (const m of s.mus) {
      if (!(m.cx >= 0 && m.cx <= s.gridW && m.cy >= 0 && m.cy <= s.gridH)) {
        inBounds = false; worst = "(" + m.cx.toFixed(2) + "," + m.cy.toFixed(2) + ") on " + s.gridW + "x" + s.gridH;
      }
    }
  }
  check("MUs (moving + queued) and station anchors stay within the floor bounds",
    inBounds && anchorsOk, worst || "all in-bounds");
}

/* ---------------------------------------------------------------------
 * 13 + 14. Runs on examples + generated layouts (with stations).
 * ------------------------------------------------------------------- */
{
  const s = runTicks(exLayout, { seed: 1, loop: true }, 300, 1);
  check("runs on an examples.js layout with stations (spawns, moves, completes)",
    s.stations.length > 0 && s.spawned > 0 && s.completed > 0 && s.inflight > 0,
    "stations=" + s.stations.length + " spawned=" + s.spawned + " inflight=" + s.inflight + " completed=" + s.completed);
}
{
  const s = runTicks(genLayout, { seed: 2, loop: true }, 300, 1);
  check("runs on a generated layout with stations (spawns, moves, completes)",
    s.stations.length > 0 && s.spawned > 0 && s.completed > 0 && s.inflight > 0,
    "stations=" + s.stations.length + " spawned=" + s.spawned + " inflight=" + s.inflight + " completed=" + s.completed);
}

/* ---------------------------------------------------------------------
 * 15. Congestion metrics consistent with the live queues.
 * ------------------------------------------------------------------- */
{
  const s = runTicks(overloadLayout, { seed: 5, loop: true, arrivalUnitsPerHr: 150 }, 120, 1);
  const lens = s.stations.map((st) => st.queue.length);
  const maxQ = lens.reduce((m, v) => (v > m ? v : m), 0);
  const sumQ = lens.reduce((a, v) => a + v, 0);
  const cong = lens.filter((v) => v >= F.PARAMS.congestQueueThreshold).length;
  check("congestion metrics (maxQueue / queued / congestedStations) match the live queues",
    s.maxQueue === maxQ && s.queued === sumQ && s.congestedStations === cong,
    "maxQueue=" + s.maxQueue + "/" + maxQ + " queued=" + s.queued + "/" + sumQ + " congested=" + s.congestedStations + "/" + cong);
}

/* ---------------------------------------------------------------------
 * 16. Honesty labelling.
 * ------------------------------------------------------------------- */
{
  const plan = F.spawnPlan(exLayout, { seed: 7 });
  const lbl = plan.dataLabel || "";
  const routing = plan.routing || "";
  check("SYNTHETIC label present, NOT a real DES / NOT a measurement / NOT a certification",
    /SYNTHETIC/.test(lbl) && /NOT a real discrete-event/i.test(lbl) && /NOT a measurement/i.test(lbl) && /NOT a certification/i.test(lbl));
  check("routing names conveyor-following AND keeps the straight-segment fallback",
    /conveyor-following/i.test(routing) && /straight-segment waypoint routing/i.test(routing));
  check("stations framed honestly as FIFO servers / NOT queueing-theory / NOT a DES model",
    /FIFO/i.test(lbl) && (/NOT a queueing-theory/i.test(lbl) || /NOT a DES/i.test(routing)));
}

console.log("");
console.log(failures === 0 ? "ALL FLOW-B CHECKS PASSED (" + checks + " checks)" : failures + " OF " + checks + " FLOW-B CHECKS FAILED");
process.exit(failures === 0 ? 0 : 1);
