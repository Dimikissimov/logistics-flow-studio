/* =====================================================================
 * verify_orderpool.js - Live ORDER POOL verification (v1.3)
 *
 * Runs the REAL app modules (domain.js, simulation.js, generate.js,
 * examples.js, wms.js, automation.js, flowsim.js, wmsdata.js, orderpool.js)
 * in Node under the same window shim the other harnesses use and asserts
 * the bounded order-pool model (WT.orderpool) is deterministic, conserving,
 * cap-bounded, correctly flagged and tied to the WMS / flow throughput:
 *
 *   1.  API surface: create / step / stats / conserved / PARAMS +
 *       SYNTHETIC_LABEL exist.
 *   2.  create() returns a sane, conserved initial state (counters, source).
 *   3.  Determinism: same (seed, opts) + same (dtTicks, io) sequence ->
 *       byte-identical counters, accumulators and PRNG state.
 *   4.  Count conservation at EVERY step:
 *       generated == inPool + inFlightSelected + completed + dropped.
 *   5.  The pool respects the cap: inPool never exceeds SizeOrderPool and
 *       overflow is counted as `dropped` (backpressure), still conserved.
 *   6.  Backlog GROWS when arrivals > selections.
 *   7.  Backlog DRAINS when selections > arrivals.
 *   8.  Starving flag correct at the extreme (empty pool, picker wants work).
 *   9.  Saturating flag correct at the extreme (backlog at the cap).
 *  10.  Neither flag set at a balanced mid state (0 < inPool < cap).
 *  11.  Selection rate ties to WT.wms / WT.flowsim throughput: driving the
 *       pool at the flow's line rate releases ~lineThroughput/avgUnits
 *       orders per hour (with ample supply).
 *  12.  Uses the wmsdata SKU-velocity-weighted generator when present.
 *  13.  Falls back to a simple seeded generator when wmsdata is absent
 *       (and when useWmsData:false is passed).
 *  14.  Completions never exceed selections (inFlightSelected >= 0 always).
 *  15.  Rates non-negative + fillPct == inPool/cap.
 *  16.  Honesty: the SYNTHETIC label states heuristic / NOT a DES engine /
 *       NOT a measurement / NOT a certification / backpressure + starvation.
 *
 * Everything is deterministic (seeded, never wall-clock). Usage:
 *   node verify_orderpool.js
 * ASCII-only output. Exit 0 = all checks pass.
 * ===================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");

global.window = global; // app modules attach themselves to window.WT
for (const f of ["domain.js", "compliance.js", "simulation.js", "generate.js", "nlcommands.js", "examples.js", "wms.js", "automation.js", "flowsim.js", "wmsdata.js", "orderpool.js"]) {
  // eslint-disable-next-line no-eval
  (0, eval)(fs.readFileSync(path.join(__dirname, f), "utf8"));
}
const WT = global.WT;
const D = WT.domain;
const OP = WT.orderpool;
const F = WT.flowsim;
const E = WT.examples;

let failures = 0;
let checks = 0;
function check(name, ok, detail) {
  checks++;
  console.log((ok ? "[PASS] " : "[FAIL] ") + name + (detail ? " - " + detail : ""));
  if (!ok) failures++;
}
const finite = (v) => typeof v === "number" && isFinite(v);

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

// Drive a pool with a FIXED per-tick io for `steps` step() calls of `dt`
// ticks each, asserting conservation after every step (returns the state).
function drive(state, io, steps, dt, onStep) {
  for (let i = 0; i < steps; i++) {
    OP.step(state, dt, io);
    if (onStep) onStep(state, i);
  }
  return state;
}

console.log("Live order-pool (orderpool) verification (deterministic)");
console.log("");

/* ---------------------------------------------------------------------
 * 1. API surface.
 * ------------------------------------------------------------------- */
check("WT.orderpool exposes create/step/stats/conserved/PARAMS",
  OP && typeof OP.create === "function" && typeof OP.step === "function" &&
  typeof OP.stats === "function" && typeof OP.conserved === "function" &&
  OP.PARAMS && typeof OP.PARAMS === "object" && typeof OP.SYNTHETIC_LABEL === "string");

/* ---------------------------------------------------------------------
 * 2. Sane initial state.
 * ------------------------------------------------------------------- */
{
  const s = OP.create({ cap: 120, seed: 7 });
  const st = OP.stats(s);
  check("create() initial state is conserved + zeroed",
    s.generated === 0 && s.inPool === 0 && s.selected === 0 && s.completed === 0 &&
    s.dropped === 0 && OP.conserved(s) && st.conserved,
    "cap=" + s.cap + " source=" + s.generatorSource);
  check("create() reports a known generator source + positive avgUnitsPerOrder",
    (s.generatorSource === "wmsdata" || s.generatorSource === "fallback") &&
    finite(s.avgUnitsPerOrder) && s.avgUnitsPerOrder > 0,
    s.generatorSource + " avgUnits=" + s.avgUnitsPerOrder.toFixed(2));
}

/* ---------------------------------------------------------------------
 * 3. Determinism: same seed + same io sequence -> identical.
 * ------------------------------------------------------------------- */
{
  const io = { arrivalsPerTick: 0.9, selectionsPerTick: 0.7, completionsPerTick: 0.6 };
  const snap = (s) => JSON.stringify({
    g: s.generated, p: s.inPool, sel: s.selected, c: s.completed, d: s.dropped,
    ga: s.genAccum, sa: s.selAccum, ca: s.compAccum, ta: s.tickAccum, rng: s.rngState, et: s.elapsedTicks,
  });
  const a = OP.create({ cap: 100, seed: 2024, avgUnitsPerOrder: 3.5 });
  const b = OP.create({ cap: 100, seed: 2024, avgUnitsPerOrder: 3.5 });
  drive(a, io, 300, 1);
  drive(b, io, 300, 1);
  check("determinism: identical counters/accumulators/PRNG after 300 ticks", snap(a) === snap(b),
    "gen=" + a.generated + " sel=" + a.selected + " comp=" + a.completed + " drop=" + a.dropped);
  // sub-tick chunking equivalence: 600 x 0.5 ticks == 300 x 1 tick
  const c = OP.create({ cap: 100, seed: 2024, avgUnitsPerOrder: 3.5 });
  drive(c, io, 600, 0.5);
  check("determinism: whole-tick execution is chunking-invariant (0.5x2 == 1x1)", snap(c) === snap(a),
    "gen=" + c.generated + " vs " + a.generated);
}

/* ---------------------------------------------------------------------
 * 4. Conservation at EVERY step (mixed rates).
 * ------------------------------------------------------------------- */
{
  const s = OP.create({ cap: 80, seed: 99 });
  let allConserved = true;
  const rates = [
    { arrivalsPerTick: 1.4, selectionsPerTick: 0.5, completionsPerTick: 0.3 }, // fill
    { arrivalsPerTick: 0.2, selectionsPerTick: 1.2, completionsPerTick: 1.0 }, // drain
    { arrivalsPerTick: 0.8, selectionsPerTick: 0.8, completionsPerTick: 0.8 }, // steady
  ];
  for (let r = 0; r < rates.length; r++) {
    drive(s, rates[r], 200, 1, (st) => { if (!OP.conserved(st)) allConserved = false; });
  }
  check("count conserved at every step across fill/drain/steady phases", allConserved,
    "gen=" + s.generated + " inPool=" + s.inPool + " inFlight=" + (s.selected - s.completed) +
    " comp=" + s.completed + " drop=" + s.dropped);
}

/* ---------------------------------------------------------------------
 * 5. Cap respected + overflow counted as dropped.
 * ------------------------------------------------------------------- */
{
  const cap = 60;
  const s = OP.create({ cap: cap, seed: 5 });
  let maxPool = 0;
  let everOverCap = false;
  // Arrivals far exceed selections -> the pool must fill and overflow.
  drive(s, { arrivalsPerTick: 3.0, selectionsPerTick: 0.4, completionsPerTick: 0.4 }, 500, 1, (st) => {
    if (st.inPool > maxPool) maxPool = st.inPool;
    if (st.inPool > cap) everOverCap = true;
  });
  check("pool never exceeds the SizeOrderPool cap", !everOverCap && maxPool <= cap,
    "maxPool=" + maxPool + " cap=" + cap);
  check("overflow is counted as dropped (backpressure), still conserved",
    s.dropped > 0 && OP.conserved(s),
    "dropped=" + s.dropped + " generated=" + s.generated);
}

/* ---------------------------------------------------------------------
 * 6/7. Backlog grows / drains with the arrival-vs-selection balance.
 * ------------------------------------------------------------------- */
{
  const grow = OP.create({ cap: 500, seed: 11 });
  const before = grow.inPool;
  drive(grow, { arrivalsPerTick: 1.5, selectionsPerTick: 0.4, completionsPerTick: 0.4 }, 200, 1);
  check("backlog GROWS when arrivals > selections", grow.inPool > before,
    before + " -> " + grow.inPool);

  const drain = OP.create({ cap: 500, seed: 12, initialFill: 0.8 });
  const start = drain.inPool;
  drive(drain, { arrivalsPerTick: 0.3, selectionsPerTick: 1.4, completionsPerTick: 1.2 }, 200, 1);
  check("backlog DRAINS when selections > arrivals", drain.inPool < start,
    start + " -> " + drain.inPool);
}

/* ---------------------------------------------------------------------
 * 8/9/10. Starving / saturating flags at the extremes + neither mid.
 * ------------------------------------------------------------------- */
{
  // Starving: some backlog, then arrivals stop while the picker keeps pulling.
  const starve = OP.create({ cap: 100, seed: 3, initialFill: 0.3 });
  drive(starve, { arrivalsPerTick: 0, selectionsPerTick: 1.0, completionsPerTick: 1.0 }, 200, 1);
  const stStarve = OP.stats(starve);
  check("starving flag TRUE when the pool empties under selection demand",
    stStarve.starving === true && stStarve.saturating === false && stStarve.inPool === 0,
    "inPool=" + stStarve.inPool);

  // Saturating: arrivals far exceed selections -> pool pinned at the cap.
  const sat = OP.create({ cap: 50, seed: 4 });
  drive(sat, { arrivalsPerTick: 3.0, selectionsPerTick: 0.2, completionsPerTick: 0.2 }, 400, 1);
  const stSat = OP.stats(sat);
  check("saturating flag TRUE when the backlog sits at the cap (overflowing)",
    stSat.saturating === true && stSat.starving === false && stSat.inPool >= sat.cap - 1 && sat.dropped > 0,
    "inPool=" + stSat.inPool + "/" + sat.cap + " dropped=" + sat.dropped);

  // Mid: balanced rates keep the pool between 0 and cap -> neither flag.
  const mid = OP.create({ cap: 400, seed: 6, initialFill: 0.4 });
  drive(mid, { arrivalsPerTick: 0.8, selectionsPerTick: 0.8, completionsPerTick: 0.8 }, 120, 1);
  const stMid = OP.stats(mid);
  check("neither flag at a balanced mid state (0 < inPool < cap)",
    stMid.starving === false && stMid.saturating === false && stMid.inPool > 0 && stMid.inPool < mid.cap,
    "inPool=" + stMid.inPool + "/" + mid.cap);
}

/* ---------------------------------------------------------------------
 * 11. Selection rate ties to WT.wms / WT.flowsim throughput.
 * ------------------------------------------------------------------- */
{
  const layout = examplesLayout("spare-parts-highsku");
  const plan = F.spawnPlan(layout, { seed: 42 });
  const lineThroughputUnitsPerHr = plan.lineThroughput; // units/hr, tied to WT.wms.capacities
  const tph = OP.PARAMS.ticksPerHour;
  const avgUnits = 3.5;
  // Convert the WMS/flow line rate (units/hr) into an orders/hr selection rate.
  const selOrdersPerHr = lineThroughputUnitsPerHr / avgUnits;
  const selectionsPerTick = selOrdersPerHr / tph;
  // Feed with ample supply so selection is never starved, run exactly 1 hour.
  const s = OP.create({ cap: 100000, seed: 8, avgUnitsPerOrder: avgUnits });
  drive(s, { arrivalsPerTick: selectionsPerTick * 3, selectionsPerTick: selectionsPerTick, completionsPerTick: selectionsPerTick }, tph, 1);
  const expected = selOrdersPerHr; // orders released in one hour
  const within = Math.abs(s.selected - expected) <= Math.max(2, expected * 0.05);
  check("selection rate ties to the WMS/flow throughput (released ~lineThroughput/avgUnits per hr)",
    within && lineThroughputUnitsPerHr > 0,
    "lineThroughput=" + lineThroughputUnitsPerHr.toFixed(1) + " u/hr -> released=" + s.selected +
    " orders/hr (expected ~" + expected.toFixed(1) + ")");
}

/* ---------------------------------------------------------------------
 * 12. Uses the wmsdata velocity-weighted generator when present.
 * ------------------------------------------------------------------- */
{
  const s = OP.create({ cap: 100, seed: 21, streamSize: 64 });
  const st = OP.stats(s);
  const sampleOk = Array.isArray(st.sample) && st.sample.length > 0 &&
    st.sample.every((o) => o && typeof o.orderId === "string" && finite(o.units) && o.units >= 1);
  check("uses wmsdata SKU-velocity-weighted generation when present",
    s.generatorSource === "wmsdata" && sampleOk && st.avgUnitsPerOrder > 0,
    "source=" + s.generatorSource + " avgUnits=" + st.avgUnitsPerOrder.toFixed(2) + " sample=" + st.sample.length);
}

/* ---------------------------------------------------------------------
 * 13. Fallback to a simple seeded generator when wmsdata is absent.
 * ------------------------------------------------------------------- */
{
  // (a) explicit opt-out.
  const optOut = OP.create({ cap: 100, seed: 21, useWmsData: false, streamSize: 32 });
  check("falls back to the seeded generator when useWmsData:false", optOut.generatorSource === "fallback",
    "source=" + optOut.generatorSource);
  // (b) wmsdata module genuinely absent.
  const saved = WT.wmsdata;
  try {
    delete WT.wmsdata;
    const noData = OP.create({ cap: 100, seed: 21, streamSize: 32 });
    check("falls back to the seeded generator when WT.wmsdata is absent",
      noData.generatorSource === "fallback" && finite(noData.avgUnitsPerOrder) && noData.avgUnitsPerOrder > 0,
      "source=" + noData.generatorSource + " avgUnits=" + noData.avgUnitsPerOrder.toFixed(2));
  } finally {
    WT.wmsdata = saved;
  }
}

/* ---------------------------------------------------------------------
 * 14. Completions never exceed selections (in-flight >= 0 always).
 * ------------------------------------------------------------------- */
{
  const s = OP.create({ cap: 120, seed: 77, initialFill: 0.2 });
  let minInFlight = Infinity;
  let compLeSel = true;
  drive(s, { arrivalsPerTick: 0.9, selectionsPerTick: 0.7, completionsPerTick: 1.5 }, 400, 1, (st) => {
    const inflight = st.selected - st.completed;
    if (inflight < minInFlight) minInFlight = inflight;
    if (st.completed > st.selected) compLeSel = false;
  });
  check("completions never exceed selections (in-flight selected >= 0)",
    minInFlight >= 0 && compLeSel, "minInFlight=" + minInFlight + " sel=" + s.selected + " comp=" + s.completed);
}

/* ---------------------------------------------------------------------
 * 15. Rate sanity + fillPct.
 * ------------------------------------------------------------------- */
{
  const s = OP.create({ cap: 90, seed: 33 });
  drive(s, { arrivalsPerTick: 1.0, selectionsPerTick: 0.7, completionsPerTick: 0.6 }, 120, 1);
  const st = OP.stats(s);
  const ratesOk = [st.generatedPerHr, st.acceptedPerHr, st.selectedPerHr, st.completedPerHr, st.droppedPerHr, st.inRatePerHr, st.outRatePerHr]
    .every((v) => finite(v) && v >= 0);
  const fillOk = Math.abs(st.fillPct - (st.inPool / st.cap) * 100) < 1e-9;
  check("rates are non-negative + fillPct == inPool/cap", ratesOk && fillOk,
    "in=" + st.inRatePerHr.toFixed(1) + "/hr out=" + st.outRatePerHr.toFixed(1) + "/hr fill=" + st.fillPct.toFixed(1) + "%");
}

/* ---------------------------------------------------------------------
 * 16. Honesty labelling.
 * ------------------------------------------------------------------- */
{
  const lbl = OP.SYNTHETIC_LABEL || "";
  check("SYNTHETIC label present + heuristic (not a DES engine)",
    /SYNTHETIC/.test(lbl) && /heuristic/i.test(lbl) && /NOT a real discrete-event/i.test(lbl));
  check("labelled NOT a measurement / NOT a certification + overflow + starvation reported",
    /NOT a measurement/i.test(lbl) && /NOT a certification/i.test(lbl) &&
    /backpressure/i.test(lbl) && /starvation/i.test(lbl));
  check("stats() carries the same honesty label", (OP.stats(OP.create({})).label || "") === lbl);
}

console.log("");
console.log(failures === 0 ? "ALL ORDERPOOL CHECKS PASSED (" + checks + " checks)" : failures + " OF " + checks + " ORDERPOOL CHECKS FAILED");
process.exit(failures === 0 ? 0 : 1);
