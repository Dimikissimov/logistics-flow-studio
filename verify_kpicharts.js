/* =====================================================================
 * verify_kpicharts.js - Live KPI dashboard verification (P3.1)
 *
 * Runs the REAL app modules (domain.js, simulation.js, generate.js,
 * examples.js, wms.js, flowsim.js, kpicharts.js) in Node under the same
 * window shim the other harnesses use and asserts the PURE chart layer
 * (WT.kpicharts) is deterministic, honest and correctly wired to the live
 * flowsim state + the WMS heuristic:
 *
 *   1.  API surface: WT.kpicharts exposes series, layout, drawDashboard,
 *       PALETTE and THEMES.
 *   2.  series() is deterministic for a given flowsim state + history
 *       (identical inputs -> byte-identical output).
 *   3.  The throughput series is NON-NEGATIVE at every bucket.
 *   4.  The throughput series SUMS to the completed count (full history,
 *       baseline 0) - an honest, conserving reading.
 *   5.  Windowed history stays honest: windowUnits == completed - baseline
 *       while total tracks the true cumulative completed.
 *   6.  The seven WMS stages are present, in order, in the utilisation bars.
 *   7.  The bottleneck flagged matches WT.wms (same stage id), and EXACTLY
 *       one stage is flagged; every utilisation is within [0, 1].
 *   8.  Bars are 0-BASED (honesty): utilisation.scale.min == 0 and
 *       throughput.scale.min == 0; layout() places every bar at the value-0
 *       baseline x, and a 0-utilisation stage renders width 0; the
 *       throughput value-0 sits on the plot floor.
 *   9.  The categorical PALETTE has >= 7 DISTINCT entries in BOTH modes.
 *  10.  Light AND dark theme inputs both produce a full render model
 *       (7 bars, resolved tokens, the mode's palette).
 *  11.  Runs on an examples.js layout (streams throughput, 7 stages).
 *  12.  Runs on a generated layout (streams throughput, 7 stages).
 *  13.  Honesty labelling: SYNTHETIC + NOT measured + NOT a certification +
 *       0-based; series.synthetic === true.
 *
 * Everything is deterministic (seeded, never wall-clock). Usage:
 *   node verify_kpicharts.js
 * ASCII-only output. Exit 0 = all checks pass.
 * ===================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");

global.window = global; // app modules attach themselves to window.WT
for (const f of ["domain.js", "compliance.js", "simulation.js", "generate.js", "nlcommands.js", "examples.js", "wms.js", "flowsim.js", "kpicharts.js"]) {
  // eslint-disable-next-line no-eval
  (0, eval)(fs.readFileSync(path.join(__dirname, f), "utf8"));
}
const WT = global.WT;
const D = WT.domain;
const F = WT.flowsim;
const G = WT.generate;
const E = WT.examples;
const K = WT.kpicharts;

let failures = 0;
let checks = 0;
function check(name, ok, detail) {
  checks++;
  console.log((ok ? "[PASS] " : "[FAIL] ") + name + (detail ? " - " + detail : ""));
  if (!ok) failures++;
}
const finite = (v) => typeof v === "number" && isFinite(v);

// ---- fixture helpers ------------------------------------------------
function examplesLayout(id) {
  const b = E.build(id);
  return { elements: b.elements, gridW: b.gridW, gridH: b.gridH, cell: 1, config: b.config, meta: b.meta };
}
function generatedLayout(profile, seed) {
  const g = G.generateLayout(profile, { seed: seed });
  return { elements: g.elements, gridW: g.gridW, gridH: g.gridH, cell: 1, config: g.config, meta: g.meta };
}
// Run a flowsim state forward, sampling {tick, completed} each tick the
// way the app's throttled rAF loop feeds the throughput chart.
function runWithHistory(layout, opts, nTicks) {
  const s = F.state(layout, opts);
  const hist = [];
  for (let i = 0; i < nTicks; i++) {
    F.step(s, 1);
    hist.push({ tick: s.tick, completed: s.completed });
  }
  return { state: s, history: hist };
}

console.log("Live KPI dashboard (kpicharts) verification (deterministic)");
console.log("");

/* ---------------------------------------------------------------------
 * 1. API surface.
 * ------------------------------------------------------------------- */
check("WT.kpicharts exposes series/layout/drawDashboard/PALETTE/THEMES",
  K && typeof K.series === "function" && typeof K.layout === "function" &&
  typeof K.drawDashboard === "function" && K.PALETTE && K.THEMES);

const exId = "ecommerce-multichannel-fc";
const exLayout = examplesLayout(exId);
const genLayout = generatedLayout("ecommerce-fulfilment", 11);

/* ---------------------------------------------------------------------
 * 2. Determinism for a given state + history.
 * ------------------------------------------------------------------- */
{
  const r = runWithHistory(exLayout, { seed: 7, loop: true }, 200);
  const a = JSON.stringify(K.series(r.state, { history: r.history, baselineCompleted: 0, playing: true }));
  const b = JSON.stringify(K.series(r.state, { history: r.history, baselineCompleted: 0, playing: true }));
  check("series() deterministic for a given flowsim state + history", a === b);
}

/* ---------------------------------------------------------------------
 * 3 + 4. Throughput non-negative and sums to completed.
 * ------------------------------------------------------------------- */
{
  const r = runWithHistory(exLayout, { seed: 3, loop: true }, 300);
  const data = K.series(r.state, { history: r.history, baselineCompleted: 0 });
  const buckets = data.throughput.buckets;
  const allNonNeg = buckets.every((x) => finite(x.units) && x.units >= 0);
  const sum = buckets.reduce((s, x) => s + x.units, 0);
  check("throughput series is non-negative at every bucket", allNonNeg && buckets.length > 0,
    buckets.length + " buckets");
  check("throughput series sums to the completed count (full history, baseline 0)",
    sum === r.state.completed && data.throughput.total === r.state.completed,
    "sum=" + sum + " completed=" + r.state.completed);
}

/* ---------------------------------------------------------------------
 * 5. Windowed history stays honest.
 * ------------------------------------------------------------------- */
{
  const r = runWithHistory(exLayout, { seed: 3, loop: true }, 300);
  const cut = 120; // drop the first `cut` samples (a scrolled window)
  const baseline = r.history[cut - 1].completed;
  const windowed = r.history.slice(cut);
  const data = K.series(r.state, { history: windowed, baselineCompleted: baseline });
  const winSum = data.throughput.buckets.reduce((s, x) => s + x.units, 0);
  const allNonNeg = data.throughput.buckets.every((x) => x.units >= 0);
  check("windowed history: windowUnits == completed - baseline, total == completed, all >= 0",
    allNonNeg && data.throughput.windowUnits === winSum &&
    winSum === r.state.completed - baseline && data.throughput.total === r.state.completed,
    "window=" + winSum + " completed-baseline=" + (r.state.completed - baseline));
}

/* ---------------------------------------------------------------------
 * 6. The seven WMS stages, in order, in the utilisation bars.
 * ------------------------------------------------------------------- */
{
  const r = runWithHistory(exLayout, { seed: 7, loop: true }, 60);
  const data = K.series(r.state, { history: r.history });
  const ids = data.utilisation.stages.map((s) => s.id);
  const wmsIds = WT.wms.STAGES.map((s) => s.id);
  check("the seven WMS stages are present in the utilisation bars, in order",
    ids.length === 7 && JSON.stringify(ids) === JSON.stringify(wmsIds),
    ids.join(" -> "));
}

/* ---------------------------------------------------------------------
 * 7. Bottleneck matches WT.wms; exactly one; util in [0,1].
 * ------------------------------------------------------------------- */
{
  const r = runWithHistory(exLayout, { seed: 7, loop: true }, 60);
  const data = K.series(r.state, { history: r.history });
  const wmsResult = WT.wms.runOperations(exLayout, { seed: 7 });
  const wmsBottleneck = WT.wms.kpis(wmsResult, exLayout).bottleneck.id;
  const flagged = data.utilisation.stages.filter((s) => s.isBottleneck);
  const utilOk = data.utilisation.stages.every((s) => s.util >= 0 && s.util <= 1);
  check("bottleneck flagged matches WT.wms (same stage id)",
    data.utilisation.bottleneck && data.utilisation.bottleneck.id === wmsBottleneck,
    "kpicharts=" + (data.utilisation.bottleneck && data.utilisation.bottleneck.id) + " wms=" + wmsBottleneck);
  check("exactly one stage flagged as bottleneck and every utilisation in [0,1]",
    flagged.length === 1 && utilOk, "flagged=" + flagged.length);
}

/* ---------------------------------------------------------------------
 * 8. Bars are 0-based (honesty), in the data AND the geometry.
 * ------------------------------------------------------------------- */
{
  const r = runWithHistory(exLayout, { seed: 7, loop: true }, 120);
  const data = K.series(r.state, { history: r.history });
  check("utilisation + throughput scales are 0-based (min == 0)",
    data.utilisation.scale.min === 0 && data.throughput.scale.min === 0,
    "util.min=" + data.utilisation.scale.min + " tp.min=" + data.throughput.scale.min);

  const m = K.layout(data, { width: 320, height: 320, theme: "light" });
  const allAtBaseline = m.utilisation.bars.every((bar) => bar.x === m.utilisation.barX0);
  // A synthetic 0-utilisation stage must render as width 0 at the baseline.
  const zeroData = JSON.parse(JSON.stringify(data));
  zeroData.utilisation.stages[0].util = 0; zeroData.utilisation.stages[0].pct = 0;
  const mz = K.layout(zeroData, { width: 320, height: 320, theme: "light" });
  const zeroBar = mz.utilisation.bars[0];
  const tickZero = m.utilisation.xTicks[0];
  check("layout(): every bar starts at the value-0 baseline x; a 0-util stage has width 0",
    allAtBaseline && zeroBar.w === 0 && zeroBar.x === mz.utilisation.barX0 &&
    tickZero.value === 0 && tickZero.x === m.utilisation.barX0,
    "barX0=" + m.utilisation.barX0);
  // Throughput value-0 sits on the plot floor (no truncated axis).
  const floorY = m.throughput.plot.y + m.throughput.plot.h;
  const zeroTick = m.throughput.yTicks.find((t) => t.value === 0);
  check("layout(): throughput value-0 sits on the plot floor (0-based y-axis)",
    !!zeroTick && Math.abs(zeroTick.y - floorY) < 1e-6 && Math.abs(m.throughput.zeroY - floorY) < 1e-6,
    "zeroY=" + m.throughput.zeroY + " floorY=" + floorY);
}

/* ---------------------------------------------------------------------
 * 9. Palette has >= 7 distinct entries in both modes.
 * ------------------------------------------------------------------- */
{
  const distinct = (arr) => new Set(arr.map((h) => String(h).toLowerCase())).size;
  check("PALETTE has >= 7 distinct colourblind-safe entries in both modes",
    Array.isArray(K.PALETTE.light) && Array.isArray(K.PALETTE.dark) &&
    distinct(K.PALETTE.light) >= 7 && distinct(K.PALETTE.dark) >= 7,
    "light=" + distinct(K.PALETTE.light) + " dark=" + distinct(K.PALETTE.dark));
}

/* ---------------------------------------------------------------------
 * 10. Light AND dark theme inputs both produce a full render model.
 * ------------------------------------------------------------------- */
{
  const r = runWithHistory(exLayout, { seed: 7, loop: true }, 120);
  const data = K.series(r.state, { history: r.history });
  const mLight = K.layout(data, { width: 340, height: 320, theme: "light" });
  const mDark = K.layout(data, { width: 340, height: 320, theme: "dark" });
  const okLight = mLight && mLight.mode === "light" && mLight.utilisation.bars.length === 7 && mLight.tokens && mLight.palette;
  const okDark = mDark && mDark.mode === "dark" && mDark.utilisation.bars.length === 7 && mDark.tokens && mDark.palette;
  const differ = mLight.tokens.surface !== mDark.tokens.surface && mLight.palette[0] !== mDark.palette[0];
  check("light AND dark theme inputs both produce a full render model (7 bars, distinct tokens)",
    okLight && okDark && differ,
    "light.surface=" + mLight.tokens.surface + " dark.surface=" + mDark.tokens.surface);
}

/* ---------------------------------------------------------------------
 * 11 + 12. Runs on examples + generated layouts.
 * ------------------------------------------------------------------- */
{
  const r = runWithHistory(exLayout, { seed: 1, loop: true }, 300);
  const data = K.series(r.state, { history: r.history });
  check("runs on an examples.js layout (streams throughput, 7 stages, MUs in flight)",
    data.ok && data.throughput.total > 0 && data.utilisation.stages.length === 7 && data.flow.inflight > 0,
    "total=" + data.throughput.total + " inflight=" + data.flow.inflight);
}
{
  const r = runWithHistory(genLayout, { seed: 2, loop: true }, 300);
  const data = K.series(r.state, { history: r.history });
  check("runs on a generated layout (streams throughput, 7 stages, MUs in flight)",
    data.ok && data.throughput.total > 0 && data.utilisation.stages.length === 7 && data.flow.inflight > 0,
    "total=" + data.throughput.total + " inflight=" + data.flow.inflight);
}

/* ---------------------------------------------------------------------
 * 13. Honesty labelling.
 * ------------------------------------------------------------------- */
{
  const r = runWithHistory(exLayout, { seed: 7, loop: true }, 60);
  const data = K.series(r.state, { history: r.history });
  const lbl = data.label || "";
  check("SYNTHETIC label present and series flagged synthetic",
    /SYNTHETIC/.test(lbl) && data.synthetic === true);
  check("labelled NOT measured / NOT a certification / 0-based",
    /NOT measured/i.test(lbl) && /NOT a certification/i.test(lbl) && /0-based/i.test(lbl));
}

console.log("");
console.log(failures === 0 ? "ALL KPICHARTS CHECKS PASSED (" + checks + " checks)" : failures + " OF " + checks + " KPICHARTS CHECKS FAILED");
process.exit(failures === 0 ? 0 : 1);
