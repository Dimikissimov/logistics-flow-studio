/* =====================================================================
 * measure_optimizer.js - headless reproduction of the one-click
 * layout-optimizer measurement cited in docs/MEASUREMENTS.md.
 *
 * Runs the REAL app modules (domain.js, simulation.js, optimizer.js)
 * in Node with a window shim, rebuilds the starter demo layout exactly
 * as app.js demoLayout() does, and runs the optimizer with the app's
 * default config (seed 42, ABC slotting, 200 orders, 80 SKUs, pull
 * flow). Everything is seeded and deterministic: the same code always
 * prints the same numbers.
 *
 * Usage:  node measure_optimizer.js
 * ===================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");

global.window = global; // the app modules attach themselves to window.WT
for (const f of ["domain.js", "simulation.js", "optimizer.js"]) {
  // eslint-disable-next-line no-eval
  (0, eval)(fs.readFileSync(path.join(__dirname, f), "utf8"));
}
const WT = global.WT;
const D = WT.domain;

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

// GRID_W / GRID_H as in app.js.
const layout = { elements, gridW: 40, gridH: 24, cell: D.METRES_PER_CELL };
const res = WT.optimizer.optimize(layout, config);

console.log("One-click layout optimizer - starter demo layout (synthetic, seeded)");
console.log("  config: seed 42, ABC slotting, 200 orders, 80 SKUs, pull flow");
console.log("  avg pick travel before : " + res.before.avgPickTravelM.toFixed(2) + " m/order");
console.log("  avg pick travel after  : " + res.after.avgPickTravelM.toFixed(2) + " m/order");
console.log("  delta                  : -" + res.travelDeltaPct.toFixed(1) + "% pick travel");
console.log("  elements moved         : " + res.movedCount);
console.log("  improved=" + res.improved + " ok=" + res.ok);

// A/B strategy comparison on the same layout: Random vs ABC 80/20 slotting,
// same seed - the measurement behind the advisor's ABC suggestion.
const rnd = WT.sim.run(layout, Object.assign({}, config, { strategy: "random" }));
const abc = WT.sim.run(layout, Object.assign({}, config, { strategy: "abc" }));
const abPct = ((rnd.avgPickTravelM - abc.avgPickTravelM) / rnd.avgPickTravelM) * 100;
console.log("");
console.log("A/B comparison - Random vs ABC 80/20 slotting (same layout, same seed)");
console.log("  random slotting        : " + rnd.avgPickTravelM.toFixed(2) + " m/order");
console.log("  ABC 80/20 slotting     : " + abc.avgPickTravelM.toFixed(2) + " m/order");
console.log("  ABC beats random by    : ~" + abPct.toFixed(1) + "% pick travel");
