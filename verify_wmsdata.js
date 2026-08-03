/* =====================================================================
 * verify_wmsdata.js - the real-data layer (SKU master + order pool).
 *
 * Runs the REAL app modules (domain.js, data.js, simulation.js, wms.js,
 * flowsim.js, wmsdata.js) in Node with the same window shim as every
 * other harness and proves the data layer end to end:
 *
 *   1. GENERATION determinism: same params + seed -> byte-identical SKU
 *      master AND order pool; a different seed changes them.
 *   2. ABC / velocity is PARETO-shaped: A-class is ~20% of SKUs but a
 *      large share of demand (asserted skew), C is most SKUs but least
 *      demand; a sharper demandSkew increases the A demand share.
 *   3. Order lines reference EXISTING SKUs (every line.sku is in master).
 *   4. CSV round-trips: importSkusCsv(exportSkusCsv(x)) preserves rows;
 *      same for orders. Export bytes are deterministic + Excel-friendly.
 *   5. Tolerant import: alias headers (article/frequency/weight/storage)
 *      map correctly; documented error modes are row-numbered.
 *   6. LARGE N (20,000 SKUs + orders) generates quickly and stats() is
 *      correct (counts, ABC shares, avg lines/order, top-velocity SKUs).
 *   7. The SIM CONSUMES the data (toDataset -> cfg.dataset): dataSource
 *      "user", it replays exactly the pool, weighted by velocity.
 *   8. WMS + FLOWSIM consume the aggregate order shape (orderStreamShape)
 *      - the real order count flows through.
 *   9. FALLBACK unchanged: with nothing loaded the sim/flowsim/wms take
 *      the synthetic default from config and stay deterministic (the
 *      feature cannot disturb the existing baselines).
 *  10. HONESTY labels present (SYNTHETIC + on-device + heuristic).
 *
 * Usage:  node verify_wmsdata.js     ASCII-only output. Exit 0 = green.
 * ===================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");

global.window = global; // the app modules attach themselves to window.WT
for (const f of ["domain.js", "data.js", "simulation.js", "wms.js", "flowsim.js", "wmsdata.js"]) {
  // eslint-disable-next-line no-eval
  (0, eval)(fs.readFileSync(path.join(__dirname, f), "utf8"));
}
const WT = global.WT;
const M = WT.wmsdata;

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? "[PASS] " : "[FAIL] ") + name + (detail ? " - " + detail : ""));
  if (!ok) failures++;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A small but real layout (storage + both docks) for the sim consumers.
const LAYOUT = {
  gridW: 40,
  gridH: 24,
  cell: WT.domain.METRES_PER_CELL,
  elements: [
    { id: "el-1", type: "dock-in", x: 0, y: 11, w: 2, d: 2 },
    { id: "el-2", type: "dock-out", x: 38, y: 11, w: 2, d: 2 },
    { id: "el-3", type: "selective-racking", x: 8, y: 4, w: 8, d: 2 },
    { id: "el-4", type: "selective-racking", x: 8, y: 9, w: 8, d: 2 },
    { id: "el-5", type: "selective-racking", x: 8, y: 14, w: 8, d: 2 },
    { id: "el-6", type: "conveyor", x: 20, y: 11, w: 10, d: 1 },
  ],
  config: { seed: 7 },
};

/* ================= 1. Generation determinism ======================= */
console.log("-- generation determinism");
const genA = M.generate({ skuCount: 500, orders: 400, seed: 123, demandSkew: 1.0, maxLines: 6 });
const genB = M.generate({ skuCount: 500, orders: 400, seed: 123, demandSkew: 1.0, maxLines: 6 });
const genC = M.generate({ skuCount: 500, orders: 400, seed: 999, demandSkew: 1.0, maxLines: 6 });
check("SKU master deterministic (same params+seed -> identical)", eq(genA.skuMaster, genB.skuMaster));
check("order pool deterministic (same params+seed -> identical)", eq(genA.orderPool, genB.orderPool));
check("a different seed changes both master and pool",
  !eq(genA.skuMaster, genC.skuMaster) && !eq(genA.orderPool, genC.orderPool));
check("generate() returns the documented bundle shape",
  Array.isArray(genA.skuMaster) && Array.isArray(genA.orderPool) &&
    genA.skuMaster.length === 500 && genA.orderPool.length === 400 &&
    ["sku", "description", "abcClass", "velocity", "weightKg", "storageType"].every((k) => k in genA.skuMaster[0]));

/* ================= 2. Pareto-shaped ABC / velocity ================= */
console.log("-- ABC / velocity is Pareto-shaped (transparent heuristic)");
const st = M.stats(genA.skuMaster, genA.orderPool);
const A = st.abc.A, B = st.abc.B, C = st.abc.C;
check("A-class is a SMALL share of SKUs (~20%)", A.skuPct > 15 && A.skuPct < 25, "A.skuPct=" + A.skuPct.toFixed(1));
check("A-class is a LARGE share of demand (skew asserted)",
  A.demandPct > 50 && A.demandPct > A.skuPct * 2, "A carries " + A.demandPct.toFixed(1) + "% of demand from " + A.skuPct.toFixed(1) + "% of SKUs");
check("C-class is MOST SKUs but LEAST demand (the long tail)",
  C.skuPct > A.skuPct && C.demandPct < A.demandPct, "C.skuPct=" + C.skuPct.toFixed(1) + " C.demandPct=" + C.demandPct.toFixed(1));
check("ABC SKU shares and demand shares each sum to ~100%",
  Math.abs(A.skuPct + B.skuPct + C.skuPct - 100) < 0.001 && Math.abs(A.demandPct + B.demandPct + C.demandPct - 100) < 1e-6);
// A sharper demandSkew concentrates demand further into A.
const stSharp = M.stats(M.generateSkuMaster({ skuCount: 500, seed: 123, demandSkew: 1.4 }));
check("a sharper demandSkew increases the A-class demand share",
  stSharp.abc.A.demandPct > A.demandPct, "skew1.4 A=" + stSharp.abc.A.demandPct.toFixed(1) + "% > skew1.0 A=" + A.demandPct.toFixed(1) + "%");
// Velocity is monotonically non-increasing by rank (Zipf).
let mono = true;
for (let i = 1; i < genA.skuMaster.length; i++) if (genA.skuMaster[i].velocity > genA.skuMaster[i - 1].velocity) { mono = false; break; }
check("velocity is non-increasing by SKU rank (Zipf curve)", mono);

/* ================= 3. Orders reference existing SKUs =============== */
console.log("-- order pool integrity");
const known = new Set(genA.skuMaster.map((s) => s.sku));
let allKnown = true, totalLines = 0, badLines = 0, maxLinesSeen = 0;
for (const o of genA.orderPool) {
  if (o.lines.length < 1 || o.lines.length > 6) maxLinesSeen = -1;
  maxLinesSeen = Math.max(maxLinesSeen, o.lines.length);
  for (const l of o.lines) {
    totalLines++;
    if (!known.has(l.sku)) { allKnown = false; badLines++; }
    if (!(l.qty >= 1)) badLines++;
  }
}
check("every order line references an existing SKU", allKnown, badLines + " bad line(s) of " + totalLines);
check("orders have 1..maxLines lines with positive qty", maxLinesSeen >= 1 && maxLinesSeen <= 6 && badLines === 0);

/* ================= 4. CSV round-trips + determinism =============== */
console.log("-- CSV export -> import round-trip");
const skuCsv = M.exportSkusCsv(genA.skuMaster);
const skuBack = M.importSkusCsv(skuCsv);
check("SKU CSV export->import round-trips (rows preserved)", skuBack.ok && eq(skuBack.skus, genA.skuMaster),
  skuBack.ok ? (eq(skuBack.skus, genA.skuMaster) ? "" : "mismatch") : JSON.stringify(skuBack.errors.slice(0, 2)));
const ordCsv = M.exportOrdersCsv(genA.orderPool);
const ordBack = M.importOrdersCsv(ordCsv, genA.skuMaster);
check("order CSV export->import round-trips (rows preserved)", ordBack.ok && eq(ordBack.orders, genA.orderPool),
  ordBack.ok ? (eq(ordBack.orders, genA.orderPool) ? "" : "mismatch") : JSON.stringify(ordBack.errors.slice(0, 2)));
check("export bytes are deterministic + start with the documented header",
  M.exportSkusCsv(genA.skuMaster) === skuCsv && skuCsv.indexOf(M.HEADERS.skus) === 0 &&
    M.exportOrdersCsv(genA.orderPool) === ordCsv && ordCsv.indexOf(M.HEADERS.orders) === 0);
// CSV escaping: a description with a comma survives the round-trip.
const tricky = [{ sku: "X,1", description: 'Bracket, "heavy"', abcClass: "A", velocity: 10, weightKg: 1.5, storageType: "shelving" }];
check("CSV escaping handles commas + quotes in fields", eq(M.importSkusCsv(M.exportSkusCsv(tricky)).skus, tricky));

/* ================= 5. Tolerant import + error modes =============== */
console.log("-- tolerant column mapping + row-numbered errors");
const aliasCsv =
  "Article,Article Text,Frequency,Weight,Storage\n" +
  "A-1,Top mover,900,2.5,carton-flow\n" +
  "A-2,Mid mover,120,8,pallet-rack\n" +
  "A-3,Slow mover,3,0.5,shelving\n";
const aliased = M.importSkusCsv(aliasCsv);
check("tolerant headers (article/frequency/weight/storage) map correctly",
  aliased.ok && aliased.skus.length === 3 && aliased.skus[0].velocity === 900 && aliased.skus[0].storageType === "carton-flow",
  aliased.ok ? "" : JSON.stringify(aliased.errors));
check("no abc column -> ABC computed 80/20 from velocity (classSource=computed)",
  aliased.classSource === "computed" && aliased.skus[0].abcClass === "A");
const missCols = M.importSkusCsv("foo,bar\n1,2\n");
check("missing required columns -> row-1 error, nothing imported",
  !missCols.ok && missCols.skus.length === 0 && missCols.errors[0].row === 1 && /missing column/.test(missCols.errors[0].msg));
const badVel = M.importSkusCsv("sku,velocity\nA-1,abc\n");
check("non-numeric velocity -> row-numbered error", !badVel.ok && badVel.errors.some((e) => e.row === 2 && /velocity is not a number/.test(e.msg)));
const badAbc = M.importSkusCsv("sku,velocity,abc_class\nA-1,10,Z\n");
check("bad abc_class letter -> row-numbered error", !badAbc.ok && badAbc.errors.some((e) => e.row === 2 && /abc_class must be A, B or C/.test(e.msg)));
const unknownSku = M.importOrdersCsv("order_id,sku,qty\nO1,NOPE,2\n", genA.skuMaster);
check("order referencing an unknown SKU -> row-numbered error", !unknownSku.ok && unknownSku.errors.some((e) => e.row === 2 && /unknown sku/.test(e.msg)));

/* ================= 6. Large N is fast + stats correct ============= */
console.log("-- large N generation + stats()");
const N = 20000;
const t0 = Date.now();
const big = M.generate({ skuCount: N, orders: 3000, seed: 42, demandSkew: 1.0, maxLines: 6 });
const genMs = Date.now() - t0;
const bigStats = M.stats(big.skuMaster, big.orderPool);
check("large-N generation completes quickly", genMs < 3000, N + " SKUs + 3000 orders in " + genMs + " ms");
check("stats() counts are correct at large N",
  bigStats.skuCount === N && bigStats.orderCount === 3000 &&
    Math.abs(bigStats.abc.A.skuPct + bigStats.abc.B.skuPct + bigStats.abc.C.skuPct - 100) < 1e-6 &&
    bigStats.avgLinesPerOrder > 1 && bigStats.avgLinesPerOrder <= 6);
check("stats() top-velocity SKUs are the real maxima (sorted desc, <=10)",
  bigStats.topSkus.length === M.PARAMS.topSkus &&
    bigStats.topSkus[0].velocity === big.skuMaster.reduce((m, s) => Math.max(m, s.velocity), 0) &&
    bigStats.topSkus.every((s, i) => i === 0 || s.velocity <= bigStats.topSkus[i - 1].velocity));
check("large-N generation is still deterministic",
  eq(M.generate({ skuCount: N, orders: 3000, seed: 42, demandSkew: 1.0, maxLines: 6 }).skuMaster.slice(-3), big.skuMaster.slice(-3)));

/* ================= 7. The sim CONSUMES the data =================== */
console.log("-- sim consumes the SKU master + order pool (via toDataset)");
const bundle = M.generate({ skuCount: 300, orders: 250, seed: 7, demandSkew: 1.0 });
const ds = M.toDataset(bundle);
check("toDataset() emits the sim's cfg.dataset shape",
  Array.isArray(ds.skus) && "picks" in ds.skus[0] && Array.isArray(ds.orders) && "skuIndex" in ds.orders[0].lines[0]);
const runUser = WT.sim.run(LAYOUT, Object.assign({}, LAYOUT.config, { strategy: "abc", orders: 999, dataset: ds }));
check("sim runs on the pool: dataSource=user, replays exactly the pool (ignores cfg.orders)",
  runUser.ok && runUser.dataSource === "user" && runUser.orderSource === "user-orders" && runUser.params.orders === bundle.orderPool.length,
  "orders replayed=" + runUser.params.orders + " (pool=" + bundle.orderPool.length + ")");
const runUser2 = WT.sim.run(LAYOUT, Object.assign({}, LAYOUT.config, { strategy: "abc", orders: 999, dataset: M.toDataset(bundle) }));
check("sim on the data is deterministic (same bundle+seed -> identical KPIs)",
  runUser.avgPickTravelM === runUser2.avgPickTravelM && runUser.throughputOrdersPerHour === runUser2.throughputOrdersPerHour);

/* ================= 8. WMS + flowsim consume the order shape ======= */
console.log("-- wms + flowsim consume the aggregate order shape");
const shape = M.orderStreamShape(bundle.orderPool);
check("orderStreamShape() summarises the pool (count + avg lines)",
  shape && shape.orders === bundle.orderPool.length && shape.avgLinesPerOrder > 1 && shape.linesPerOrderMax >= 1);
const wmsUser = WT.wms.runOperations(LAYOUT, { orders: shape.orders, seed: 7 });
check("wms.runOperations takes the real order count through", wmsUser.ok && wmsUser.orders === bundle.orderPool.length);
const planUser = WT.flowsim.spawnPlan(Object.assign({}, LAYOUT), { orders: shape.orders, seed: 7, linesPerOrderMax: shape.linesPerOrderMax });
const planDefault = WT.flowsim.spawnPlan(Object.assign({}, LAYOUT), { seed: 7 });
check("flowsim.spawnPlan reflects the real pool size (totalUnits scales with orders)",
  planUser.totalUnits !== planDefault.totalUnits && planUser.totalUnits > 0);

/* ================= 9. FALLBACK path unchanged ===================== */
console.log("-- fallback (nothing loaded) is the synthetic default, unchanged");
const cfgSyn = Object.assign({}, LAYOUT.config, { strategy: "abc", orders: 150, skuCount: 80, demandSkew: 1.0 });
const runSyn1 = WT.sim.run(LAYOUT, cfgSyn);
const runSyn2 = WT.sim.run(LAYOUT, cfgSyn);
check("sim without a dataset is the pure synthetic path (dataSource=synthetic, honours cfg.orders)",
  runSyn1.dataSource === "synthetic" && runSyn1.orderSource === "synthetic" && runSyn1.params.orders === 150 && runSyn1.params.demandSkew === 1.0);
check("sim fallback is deterministic (byte-identical KPIs)",
  runSyn1.avgPickTravelM === runSyn2.avgPickTravelM && runSyn1.throughputOrdersPerHour === runSyn2.throughputOrdersPerHour);
check("wms fallback (no orders opt) uses the synthetic default and is deterministic",
  eq(WT.wms.runOperations(LAYOUT, { seed: 7 }), WT.wms.runOperations(LAYOUT, { seed: 7 })));
check("flowsim fallback plan is deterministic and independent of the loaded pool",
  eq(WT.flowsim.spawnPlan(Object.assign({}, LAYOUT), { seed: 7 }), planDefault));

/* ================= 10. Honesty labels ============================= */
console.log("-- honesty labels");
check("SYNTHETIC_LABEL calls the data synthetic + on-device + a heuristic",
  /SYNTHETIC/.test(M.SYNTHETIC_LABEL) && /device/.test(M.SYNTHETIC_LABEL) && /heuristic/i.test(M.SYNTHETIC_LABEL) && /NOT a measurement/.test(M.SYNTHETIC_LABEL));
check("generated bundles are labelled source=synthetic; ABC is the computed 80/20 heuristic",
  bundle.source === "synthetic" && bundle.classSource === "computed" && ds.source === "synthetic");
check("documented CSV headers are exposed for the UI/docs",
  M.HEADERS.skus === "sku,description,abc_class,velocity,weight_kg,storage_type" && M.HEADERS.orders === "order_id,sku,qty");

/* ========= 11. Active store (the no-arg path the app relies on) ==== */
console.log("-- active store (load / isLoaded / no-arg stats + export / clear)");
check("isLoaded() is false before anything is loaded", M.isLoaded() === false && M.skuMaster.length === 0);
M.load(bundle);
check("load() populates the live skuMaster / orderPool getters",
  M.isLoaded() && M.skuMaster.length === bundle.skuMaster.length && M.orderPool.length === bundle.orderPool.length);
check("no-arg stats() reads the active store", M.stats().skuCount === bundle.skuMaster.length && M.stats().source === "synthetic");
check("no-arg exportSkusCsv()/exportOrdersCsv() export the active store",
  M.exportSkusCsv() === M.exportSkusCsv(bundle.skuMaster) && M.exportOrdersCsv() === M.exportOrdersCsv(bundle.orderPool));
check("no-arg toDataset() + orderStreamShape() read the active store",
  M.toDataset().skus.length === bundle.skuMaster.length && M.orderStreamShape().orders === bundle.orderPool.length);
M.clear();
check("clear() empties the store (back to the synthetic default)", !M.isLoaded() && M.skuMaster.length === 0 && M.orderPool.length === 0);

console.log("");
console.log(failures === 0 ? "ALL wmsdata checks passed." : failures + " wmsdata check(s) FAILED.");
process.exit(failures === 0 ? 0 : 1);
