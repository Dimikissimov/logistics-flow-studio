/* =====================================================================
 * verify_heatmap.js - headless checks for the Round 2 pick-travel
 * heatmap (the `heatmap` field simulation.js now returns).
 *
 * Runs the REAL app modules in Node with the same window shim as
 * measure_optimizer.js, on the same starter demo layout and default
 * config, and asserts:
 *   1. determinism   - two runs at the same seed produce byte-identical
 *                      results INCLUDING the heatmap cells;
 *   2. conservation  - for every picking strategy, the heatmap's total
 *                      walked metres equals the travel the sim charged
 *                      (avgPickTravelM x ordersServed) to within
 *                      floating-point noise - the overlay can never
 *                      show more or less walking than the KPI;
 *   3. shape         - heatmap dimensions match the floor grid, cellM
 *                      is the grid pitch, and no cell is negative;
 *   4. goods-to-person - an AS/RS-only layout walks nowhere, so its
 *                      heatmap is all zeros;
 *   5. KPI regression - the KPIs with the heatmap code in place still
 *                      match the docs/MEASUREMENTS.md baseline
 *                      (ABC 36.70 / random 46.71 m per order on the
 *                      starter demo layout at the default config).
 *
 * Usage:  node verify_heatmap.js     (exit 0 = all checks pass)
 * ===================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");

global.window = global; // the app modules attach themselves to window.WT
for (const f of ["domain.js", "simulation.js"]) {
  // eslint-disable-next-line no-eval
  (0, eval)(fs.readFileSync(path.join(__dirname, f), "utf8"));
}
const WT = global.WT;
const D = WT.domain;

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? "PASS" : "FAIL") + "  " + name + (detail ? "  [" + detail + "]" : ""));
  if (!ok) failures++;
}

// Starter demo layout - identical to demoLayout() in app.js.
let idCounter = 0;
const mk = (type, x, y, w, d) => {
  const def = D.ELEMENTS[type];
  return { id: "el-" + ++idCounter, type, x, y, w: w || def.w, d: d || def.d };
};
const elements = [
  mk("dock-in", 4, 0, 2, 1),
  mk("dock-out", 20, 23, 2, 1),
  mk("staging", 18, 20, 4, 2),
  mk("selective-racking", 6, 5, 8, 1),
  mk("selective-racking", 6, 9, 8, 1),
  mk("selective-racking", 24, 5, 8, 1),
  mk("selective-racking", 24, 9, 8, 1),
  mk("block-stack", 6, 14, 6, 4),
  mk("conveyor", 24, 15, 8, 1),
  mk("push-station", 34, 5, 2, 2),
  mk("pull-station", 34, 9, 2, 2),
];

// Default config - identical to state.config in app.js.
const config = {
  seed: 42,
  strategy: "abc",
  orders: 200,
  skuCount: 80,
  minAisleMetres: D.AISLE.defaultMinMetres,
  flowMode: "pull",
  demandSkew: 1.0,
  palletType: "EUR1",
  boxType: "EURO-CASE",
};
const layout = { elements, gridW: 40, gridH: 24, cell: D.METRES_PER_CELL };

// 1. Determinism including the heatmap ------------------------------
const a = WT.sim.run(layout, config);
const b = WT.sim.run(layout, config);
check("determinism: identical results incl. heatmap at the same seed",
  JSON.stringify(a) === JSON.stringify(b));

// 2. Conservation per strategy --------------------------------------
// Sum of walked metres in the cells must equal the travel the KPIs
// charged. Exercises all three tour paths: discrete (random/abc),
// zone, and the batch/wave group accumulator.
for (const strategy of ["random", "abc", "zone", "batch", "wave"]) {
  const r = WT.sim.run(layout, Object.assign({}, config, { strategy }));
  let sum = 0;
  for (const v of r.heatmap.cells) sum += v;
  const charged = r.avgPickTravelM * r.ordersServed;
  const rel = charged > 0 ? Math.abs(sum - charged) / charged : Math.abs(sum);
  check("conservation (" + strategy + "): heatmap sum == charged travel",
    rel < 1e-6,
    sum.toFixed(2) + " m vs " + charged.toFixed(2) + " m");
}

// 3. Shape ----------------------------------------------------------
check("shape: heatmap is gridW x gridH at the grid pitch",
  a.heatmap.w === 40 && a.heatmap.h === 24 &&
  a.heatmap.cells.length === 40 * 24 && a.heatmap.cellM === D.METRES_PER_CELL);
check("shape: no negative cells and maxM is the true peak",
  a.heatmap.cells.every((v) => v >= 0) &&
  Math.abs(Math.max.apply(null, a.heatmap.cells) - a.heatmap.maxM) === 0);
check("shape: demo layout actually produces walking traffic", a.heatmap.maxM > 0);

// 4. Goods-to-person only -> zero walking ---------------------------
idCounter = 100;
const gtpLayout = {
  elements: [mk("dock-out", 20, 23, 2, 1), mk("asrs", 10, 8)],
  gridW: 40, gridH: 24, cell: D.METRES_PER_CELL,
};
const g = WT.sim.run(gtpLayout, config);
check("goods-to-person only: zero travel KPI and all-zero heatmap",
  g.ok && g.avgPickTravelM === 0 && g.heatmap.maxM === 0);

// 5. KPI regression vs docs/MEASUREMENTS.md -------------------------
const abc = WT.sim.run(layout, Object.assign({}, config, { strategy: "abc" }));
const rnd = WT.sim.run(layout, Object.assign({}, config, { strategy: "random" }));
check("regression: ABC demo-layout travel still 36.70 m/order",
  abc.avgPickTravelM.toFixed(2) === "36.70", abc.avgPickTravelM.toFixed(2));
check("regression: random demo-layout travel still 46.71 m/order",
  rnd.avgPickTravelM.toFixed(2) === "46.71", rnd.avgPickTravelM.toFixed(2));

console.log("");
console.log(failures === 0 ? "All heatmap checks passed." : failures + " check(s) FAILED.");
process.exit(failures === 0 ? 0 : 1);
