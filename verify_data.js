/* =====================================================================
 * verify_data.js - "bring your own data" (W3) verification harness.
 *
 * Runs the REAL app modules (domain.js, simulation.js, data.js) in
 * Node with the same window shim as the other harnesses and proves:
 *
 *   1. PARSER, happy path: a valid article CSV yields the right SKUs,
 *      weekly-pick velocities and 80/20 ABC classes; a class column is
 *      honoured verbatim; a valid order CSV groups lines by order_id.
 *   2. PARSER, error paths: every documented failure mode produces a
 *      ROW-NUMBERED message and imports nothing - missing columns,
 *      non-numeric picks/qty, negative picks, duplicate SKU, empty
 *      sku/order_id, bad class letter, unknown SKU in orders, all-zero
 *      picks, row caps.
 *   3. ABC RECOMPUTE: top 20% of SKUs by picks = A, next 30% = B,
 *      rest = C; ties break deterministically by SKU id.
 *   4. SIM INTEGRATION: config.dataset feeds the sim - KPIs differ
 *      from the synthetic run (it IS different data), the provenance
 *      fields say so, user orders are replayed exactly, and the run is
 *      DETERMINISTIC (same dataset + seed -> byte-identical KPIs).
 *   5. SYNTHETIC PATH UNCHANGED: without a dataset the pinned demo
 *      baseline still holds (ABC 36.70 m/order - same as
 *      verify_heatmap.js), i.e. the feature cannot disturb determinism.
 *
 * Usage:  node verify_data.js     ASCII-only output. Exit 0 = green.
 * ===================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");

global.window = global; // the app modules attach themselves to window.WT
for (const f of ["domain.js", "simulation.js", "data.js"]) {
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

// One row-numbered-error assertion: parse fails AND some error carries
// the expected row number AND message fragment.
function checkErr(name, res, row, frag) {
  const hit = !res.ok && res.errors.some((e) => e.row === row && e.msg.indexOf(frag) !== -1);
  check(name, hit, hit ? 'row ' + row + ': "' + frag + '"' :
    "got: " + JSON.stringify(res.errors ? res.errors.slice(0, 3) : res));
}

/* ================= 1. Article CSV happy path ======================= */
console.log("-- article CSV: happy path");
const ART_OK =
  "sku,description,weekly_picks\n" +
  "FAST-1,Top mover,500\n" +
  "MID-1,Mid mover,120\n" +
  "MID-2,Mid mover 2,80\n" +
  "SLOW-1,Slow mover,10\n" +
  "SLOW-2,Slow mover 2,5\n";
const art = WT.data.parseArticles(ART_OK);
check("valid article CSV parses", art.ok && art.articles.length === 5);
check("weekly_picks become numeric velocities",
  art.articles[0].weeklyPicks === 500 && art.articles[4].weeklyPicks === 5);

const abc = WT.data.computeABC(art.articles);
check("ABC 80/20 recompute: top 20% = A", abc["FAST-1"] === "A", JSON.stringify(abc));
check("ABC 80/20 recompute: next 30% = B (rounded)", abc["MID-1"] === "B" && abc["MID-2"] === "B");
check("ABC 80/20 recompute: rest = C", abc["SLOW-1"] === "C" && abc["SLOW-2"] === "C");

// Ties break by SKU id: equal picks, deterministic classes.
const tied = WT.data.parseArticles(
  "sku,description,weekly_picks\nB-SKU,x,10\nA-SKU,x,10\nC-SKU,x,10\nD-SKU,x,10\nE-SKU,x,10\n");
const abcT1 = WT.data.computeABC(tied.articles);
const abcT2 = WT.data.computeABC(tied.articles.slice().reverse());
check("ABC ties break deterministically by sku", JSON.stringify(abcT1) === JSON.stringify(abcT2) && abcT1["A-SKU"] === "A");

// Class column is honoured verbatim (no recompute).
const ART_CLS =
  "sku,description,weekly_picks,class\n" +
  "X-1,With class,5,C\n" +
  "X-2,With class,900,B\n" +
  "X-3,With class,1,A\n";
const artCls = WT.data.parseArticles(ART_CLS);
const dsCls = WT.data.buildDataset(artCls.articles, null);
const clsOf = {};
dsCls.skus.forEach((s) => { clsOf[s.id] = s.cls; });
check("class column is used as-is (no 80/20 recompute)",
  dsCls.classSource === "csv" && clsOf["X-1"] === "C" && clsOf["X-2"] === "B" && clsOf["X-3"] === "A");

// Dataset ordering: index 0 = most picked (the slotting contract).
const ds0 = WT.data.buildDataset(art.articles, null);
check("dataset skus sorted by picks desc (slotting contract)",
  ds0.skus[0].id === "FAST-1" && ds0.skus[4].id === "SLOW-2");
check("dataset stats are honest",
  ds0.stats.skuCount === 5 && ds0.stats.orderCount === 0 && ds0.stats.totalWeeklyPicks === 715);

/* ================= 2. Order CSV happy path ========================= */
console.log("-- order CSV: happy path");
const ORD_OK =
  "order_id,sku,qty\n" +
  "O-1,FAST-1,2\n" +
  "O-1,SLOW-1,1\n" +
  "O-2,MID-1,\n" + // blank qty -> defaults to 1
  "O-3,fast-1,4\n"; // case-insensitive SKU match
const ord = WT.data.parseOrders(ORD_OK, art.articles);
check("valid order CSV parses + groups by order_id", ord.ok && ord.orders.length === 3);
check("lines grouped under their order", ord.orders[0].id === "O-1" && ord.orders[0].lines.length === 2);
check("blank qty defaults to 1", ord.orders[1].lines[0].qty === 1);
check("SKU matching is case-insensitive", ord.orders[2].lines[0].sku === "FAST-1");
const dsOrd = WT.data.buildDataset(art.articles, ord.orders);
check("order lines resolve to sku indexes", dsOrd.orders[0].lines[0].skuIndex === 0 &&
  dsOrd.stats.orderCount === 3 && dsOrd.stats.lineCount === 4);

/* ================= 3. Error paths (row-numbered) =================== */
console.log("-- article CSV: error paths");
checkErr("missing column(s) named on row 1",
  WT.data.parseArticles("sku,weekly_picks\nA,1\n"), 1, "missing column(s): description");
checkErr("non-numeric weekly_picks is row-numbered",
  WT.data.parseArticles("sku,description,weekly_picks\nA,x,1\nB,x,lots\n"), 3, "weekly_picks is not a number");
checkErr("negative weekly_picks is row-numbered",
  WT.data.parseArticles("sku,description,weekly_picks\nA,x,1\nB,x,-4\n"), 3, "cannot be negative");
checkErr("duplicate sku is row-numbered and names the first row",
  WT.data.parseArticles("sku,description,weekly_picks\nA,x,1\nB,x,2\na,x,3\n"), 4, "duplicate sku");
checkErr("empty sku is row-numbered",
  WT.data.parseArticles("sku,description,weekly_picks\nA,x,1\n,x,2\n"), 3, "empty sku");
checkErr("bad class letter is row-numbered",
  WT.data.parseArticles("sku,description,weekly_picks,class\nA,x,1,A\nB,x,2,Q\n"), 3, "class must be A, B or C");
checkErr("all-zero picks rejected honestly",
  WT.data.parseArticles("sku,description,weekly_picks\nA,x,0\nB,x,0\n"), 1, "every weekly_picks value is 0");
checkErr("empty file rejected",
  WT.data.parseArticles(""), 1, "empty");
checkErr("header-only file rejected",
  WT.data.parseArticles("sku,description,weekly_picks\n"), 1, "no data rows");
(function () {
  let big = "sku,description,weekly_picks\n";
  for (let i = 0; i < WT.data.LIMITS.maxArticles + 1; i++) big += "S" + i + ",x,1\n";
  checkErr("article row cap enforced (" + WT.data.LIMITS.maxArticles + ")",
    WT.data.parseArticles(big), 1, "too many articles");
})();

console.log("-- order CSV: error paths");
checkErr("order CSV missing columns named on row 1",
  WT.data.parseOrders("order_id,sku\nO1,A\n", art.articles), 1, "missing column(s): qty");
checkErr("unknown SKU in orders is row-numbered",
  WT.data.parseOrders("order_id,sku,qty\nO1,FAST-1,1\nO1,GHOST-9,2\n", art.articles), 3, 'unknown sku "GHOST-9"');
checkErr("non-numeric qty is row-numbered",
  WT.data.parseOrders("order_id,sku,qty\nO1,FAST-1,three\n", art.articles), 2, "qty is not a number");
checkErr("non-positive qty is row-numbered",
  WT.data.parseOrders("order_id,sku,qty\nO1,FAST-1,0\n", art.articles), 2, "qty must be positive");
checkErr("empty order_id is row-numbered",
  WT.data.parseOrders("order_id,sku,qty\n,FAST-1,1\n", art.articles), 2, "empty order_id");
check("formatErrors emits row-numbered lines",
  WT.data.formatErrors([{ row: 7, msg: "boom" }])[0] === "row 7: boom");

/* ================= 4. Sim integration ============================== */
console.log("-- sim integration (real layout, real sim)");
// The starter demo layout, exactly as app.js builds it.
function mkElements(list) {
  let n = 0;
  return list.map((e) => ({ id: "el-" + ++n, type: e.type, x: e.x, y: e.y, w: e.w, d: e.d }));
}
const LAYOUT = {
  elements: mkElements([
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
  ]),
  gridW: 40, gridH: 24, cell: D.METRES_PER_CELL,
};
const BASE_CFG = { seed: 42, strategy: "abc", orders: 200, skuCount: 80, flowMode: "pull", demandSkew: 1.0 };

const KPIS = ["avgPickTravelM", "throughputOrdersPerHour", "storageFillPct", "stockoutPct", "overstockUnits", "labourSecPerOrder"];
function kpisOf(res) { const o = {}; for (const k of KPIS) o[k] = res[k]; return o; }

// 5. synthetic path unchanged (same pin as verify_heatmap.js)
const synth = WT.sim.run(LAYOUT, BASE_CFG);
check("synthetic baseline still pinned: ABC 36.70 m/order",
  synth.avgPickTravelM.toFixed(2) === "36.70" && synth.dataSource === "synthetic" && synth.orderSource === "synthetic",
  synth.avgPickTravelM.toFixed(2));

// Articles only: real velocities, synthetic order stream.
const artBig = WT.data.parseArticles((function () {
  let t = "sku,description,weekly_picks\n";
  for (let i = 1; i <= 40; i++) t += "U-" + String(i).padStart(3, "0") + ",Article " + i + "," + (i * 7 % 97) + "\n";
  return t;
})());
check("fixture articles parse", artBig.ok && artBig.articles.length === 40);
const dsArt = WT.data.buildDataset(artBig.articles, null);
const cfgArt = Object.assign({}, BASE_CFG, { dataset: dsArt });
const runArt1 = WT.sim.run(LAYOUT, cfgArt);
const runArt2 = WT.sim.run(LAYOUT, cfgArt);
check("imported articles: provenance is user + synthetic-from-your-picks",
  runArt1.dataSource === "user" && runArt1.orderSource === "synthetic-from-your-picks");
check("imported articles: effective SKU count is the user's catalogue",
  runArt1.params.skuCount === 40 && runArt1.params.orders === 200);
check("imported articles: KPIs differ from the synthetic run (it IS different data)",
  JSON.stringify(kpisOf(runArt1)) !== JSON.stringify(kpisOf(synth)),
  runArt1.avgPickTravelM.toFixed(2) + " vs synthetic " + synth.avgPickTravelM.toFixed(2) + " m/order");
check("DETERMINISM: same dataset + seed -> byte-identical KPIs",
  JSON.stringify(kpisOf(runArt1)) === JSON.stringify(kpisOf(runArt2)));
const runArtSeed7a = WT.sim.run(LAYOUT, Object.assign({}, cfgArt, { seed: 7 }));
const runArtSeed7b = WT.sim.run(LAYOUT, Object.assign({}, cfgArt, { seed: 7 }));
check("DETERMINISM holds at another seed too",
  JSON.stringify(kpisOf(runArtSeed7a)) === JSON.stringify(kpisOf(runArtSeed7b)) &&
  JSON.stringify(kpisOf(runArtSeed7a)) !== JSON.stringify(kpisOf(runArt1)));

// Articles + orders: the sim replays exactly the user's orders.
const ordBig = WT.data.parseOrders((function () {
  let t = "order_id,sku,qty\n";
  for (let o = 1; o <= 25; o++) {
    for (let l = 0; l <= o % 3; l++) t += "ORD-" + o + ",U-" + String(((o * 5 + l * 11) % 40) + 1).padStart(3, "0") + "," + (1 + (l % 2)) + "\n";
  }
  return t;
})(), artBig.articles);
check("fixture orders parse", ordBig.ok && ordBig.orders.length === 25);
const dsFull = WT.data.buildDataset(artBig.articles, ordBig.orders);
const cfgFull = Object.assign({}, BASE_CFG, { dataset: dsFull });
const runFull1 = WT.sim.run(LAYOUT, cfgFull);
const runFull2 = WT.sim.run(LAYOUT, cfgFull);
check("imported orders: the sim replays EXACTLY the user's order count",
  runFull1.ordersServed === 25 && runFull1.params.orders === 25 && runFull1.orderSource === "user-orders",
  runFull1.ordersServed + " orders served");
check("imported orders: line count matches the user's lines",
  runFull1.linesPicked === dsFull.stats.lineCount,
  runFull1.linesPicked + " lines");
check("DETERMINISM with user orders: identical KPIs on re-run",
  JSON.stringify(kpisOf(runFull1)) === JSON.stringify(kpisOf(runFull2)));
check("heatmap conservation still holds on user data",
  Math.abs(runFull1.heatmap.cells.reduce((s, v) => s + v, 0) - runFull1.avgPickTravelM * runFull1.ordersServed) < 1e-6);

// Strategy switch still works on imported data (the A/B + advisor path).
const runRandom = WT.sim.run(LAYOUT, Object.assign({}, cfgFull, { strategy: "random" }));
check("strategies still differentiate on imported data (abc vs random)",
  runRandom.ok && runRandom.avgPickTravelM !== runFull1.avgPickTravelM,
  runFull1.avgPickTravelM.toFixed(2) + " (abc) vs " + runRandom.avgPickTravelM.toFixed(2) + " (random)");

console.log("");
console.log(failures === 0 ? "ALL DATA-IMPORT CHECKS PASSED" : failures + " DATA-IMPORT CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
