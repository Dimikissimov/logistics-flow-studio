/* =====================================================================
 * Logistics Flow Studio - test/run-all.mjs
 * ---------------------------------------------------------------------
 * Single entry point for every verification harness in the repo. Each
 * harness is executed as a child process; a nonzero exit code fails the
 * run. These are the REAL checks the docs cite (no stubs):
 *
 *   1. measure_optimizer.js  - headless reproduction of the pinned
 *      optimizer measurement (docs/MEASUREMENTS.md) on the real app
 *      modules; fails if the modules throw.
 *   2. verify_heatmap.js     - heatmap conservation invariant + KPI
 *      baseline regression (ABC 36.70 / random 46.71 m per order).
 *   3. lsp/verify.js         - LSP Planner engine: determinism, the
 *      L3 (pull beats push) and L4 (cross-dock) lessons, tier gate,
 *      reference designs pass their level budgets.
 *   4. verify_share.js       - share-link codec: base64url round-trip
 *      on the starter + MRO layouts with identical sim KPIs, malformed
 *      payloads rejected, measured link lengths printed.
 *   5. verify_data.js        - W3 CSV data import: parser happy/error
 *      paths (row-numbered messages), ABC 80/20 recompute, dataset ->
 *      sim integration, determinism on imported data, and the pinned
 *      synthetic baseline staying untouched.
 *   6. verify_ifc.js         - W4 IFC export bridge: STEP framing,
 *      resolvable entity graph, entity counts vs the layout, GlobalId
 *      rules, string escaping, determinism - plus the OPTIONAL
 *      ifcopenshell gold-standard step (skips with a note if absent).
 *   7. verify_compliance.js  - Compliance Check: hand-built layouts
 *      assert exact pass/warn/fail outcomes for the aisle-width,
 *      traffic-route, escape-route and blocked-route rules (measured +
 *      informed-by numbers), determinism, and the not-a-certification
 *      disclaimer being present in the report output.
 *   8. verify_generate.js    - AI Environment Generator: the 4 pinned
 *      plant profiles, rgv/agv as 0-capacity transport, seeded
 *      determinism (byte-identical), every profile overlap-free and
 *      passing/warning (never failing) compliance, the three modes, and
 *      the offline NL parser (the pinned "include 2 more RGVs in the
 *      picking sector" -> +2 rgv, reserve/regenerate/widen/remove, and
 *      an honest not-understood on unknown input).
 *   9. verify_examples.js    - Example Scenarios library + data export:
 *      >=20 distinct realistic scenarios, every example builds
 *      overlap-free and passes/warns (never fails) compliance, a
 *      non-empty description + synthetic dataProfile each, item-type
 *      coverage is a majority of the palette (asserted set), exportData
 *      is a valid wt-1 layout and exportCsv a valid element+KPI+profile
 *      CSV, and everything is byte-identical on re-run (determinism).
 *  10. tools/offline-guard.mjs - no external assets referenced from
 *      any app file (the app must stay 100% offline).
 *  11. verify_wms.js          - WMS Operations layer (P2): the 7
 *      standard workflow stages present in order, runOperations
 *      deterministic across the MRO preset, an examples.js layout and a
 *      generated layout, KPIs within sane bounds and grounded in ISO
 *      22400 / standard practice, unit conservation, a more-docks/more-
 *      automation monotonic throughput sanity check, a bottleneck stage
 *      identified, and the SYNTHETIC + not-a-certification labels present.
 *  12. verify_view.js         - viewport transform (zoom/pan/fit) + the
 *      configurable floor: screenToWorld/worldToScreen round-trip at
 *      several scales/pans, zoom clamped to bounds, Fit computed for a
 *      known warehouse+viewport, grid-snap staying in world coords, a
 *      non-40x24 floor accepted with correct bounds, and the hit-test
 *      resolving the right element after a pan+zoom.
 *  13. verify_flowsim.js      - Live material-flow animation model (P3):
 *      the 5-stage flow spine (receiving..shipping), determinism on an
 *      examples and a generated layout (identical MU positions/counts),
 *      unit conservation at every step (spawned == in-flight + completed),
 *      a finite pool draining exactly, MUs staying within floor bounds,
 *      MUs progressing through stages in order, throughput responding to
 *      the layout (more docks/automation -> higher line throughput and
 *      more completions, monotonic via WT.wms), world-cell positions, the
 *      lineThroughput tied to WT.wms.capacities, and the SYNTHETIC / NOT
 *      a real DES engine / NOT a measurement / NOT a certification labels.
 *  14. verify_kpicharts.js    - Live KPI dashboard (P3.1): the PURE chart
 *      layer (WT.kpicharts) is deterministic for a given flowsim state,
 *      the throughput series is non-negative and sums to the completed
 *      count (honest/conserving), the 7 WMS stages appear in the
 *      utilisation bars, the bottleneck flagged matches WT.wms, every bar
 *      is 0-based (data scales + layout geometry - the honesty check), the
 *      colourblind-safe palette has enough distinct entries, light+dark
 *      theme inputs both render, it runs on an examples and a generated
 *      layout, and the SYNTHETIC / NOT measured / NOT a certification /
 *      0-based labels are present.
 *  15. verify_wmsdata.js     - the real-data layer (SKU master + order
 *      pool): seeded generation is deterministic, ABC/velocity is
 *      Pareto-shaped (A is ~20% of SKUs but a large, asserted share of
 *      demand), order lines reference existing SKUs, CSV export->import
 *      round-trips, a 20,000-SKU generate is fast and stats() correct,
 *      the sim consumes the pool (toDataset -> cfg.dataset) while the
 *      no-data FALLBACK stays the synthetic default, and the SYNTHETIC /
 *      on-device / heuristic honesty labels are present.
 *  16. verify_flowB.js       - Material-flow realism (P3.2): pick/put/pack
 *      stations as active FIFO servers whose service rates come from the
 *      WT.wms stage capacities, conveyor-following polyline routing along
 *      connected conveyor cells (with a straight-segment fallback), and
 *      emergent queue congestion. Asserts determinism INCLUDING the station
 *      queues, unit conservation counting queued MUs, conveyor-routed
 *      waypoints lying on conveyor cells, a monotonically growing queue when
 *      arrivals exceed service, queues draining to empty at the wms-tied
 *      rates, in-bounds MUs/queues, and the SYNTHETIC / NOT-a-DES honesty.
 *  17. verify_iso.js         - 2.5D isometric presentation projection: the
 *      pure 2:1-dimetric project() is deterministic and satisfies the iso
 *      invariants (+x -> right+down, +y -> left+down, +z raises screen-y,
 *      linear so collinear stays collinear, KX:KY = 2:1, a known cell maps
 *      to the expected offset), elementHeight is positive+finite for every
 *      element type and reuses the domain heightM (single source of truth,
 *      shared with the IFC export), the HEIGHTS fallback covers every type,
 *      the painter's depth sort orders a known set back-to-front (stable,
 *      non-mutating), the iso pure pipeline never mutates the layout (the
 *      view-mode toggle is a no-op on state), and the illustrative / NOT a
 *      BIM model honesty labels are present.
 *  18. verify_storage.js     - storage & inventory (P4): physical storage
 *      LOCATIONS derived from the racking (count == summed capacity), ABC /
 *      velocity slotting into the golden zone (A-class average distance <
 *      overall + ABC beats random), deterministic assignment, occupancy
 *      maths (placed == min(SKUs, capacity)) with HONEST overflow when
 *      demand exceeds capacity, locationOf/retrieve returning a valid in-
 *      layout location (mirrors Siemens M_retrieveSKUfromStorage), the
 *      flowsim retrieval leg moving the storage waypoint to the real
 *      slotting anchor with a byte-identical no-assignment FALLBACK, and
 *      the SYNTHETIC / heuristic / NOT a measurement honesty labels.
 *  19. verify_kb.js         - Editable standards knowledge base (P5):
 *      WT.kb defaults MATCH the previously-hardcoded constants (compliance
 *      guidance, generator aisles, rack densities - one source of truth),
 *      get/set/reset edit + VALIDATE (reject non-numeric / negative /
 *      out-of-range), addRule adds a retrievable entry (never overwriting
 *      a seed), exportJson -> importJson round-trips the whole KB EXACTLY
 *      including a user rule, editing a compliance threshold CHANGES
 *      compliance.check's verdict for a borderline layout while the
 *      DEFAULT KB leaves every existing verdict identical (regression
 *      guard), editing a rack density flows into elementCapacity (reset
 *      restores it), and the informed-by / NOT-a-certification / paywall
 *      "verify" honesty labels are present on the banner and every entry.
 *  20. verify_automation.js - Automation systems modeling (P6): WT.automation
 *      detects each automation type (asrs/shuttle/rgv/agv/conveyor) and
 *      counts them, per-unit throughput == the editable KB cycle-time param
 *      (auto.*), throughput scales with count AND with the KB param (editing
 *      auto.asrs.cyclesPerHr changes the automation throughput AND the WMS
 *      storage capacity - proves the wiring), utilisation == demand/
 *      throughput with over-capacity flagged honestly, report() names the
 *      automation constraint, the NO-automation regression guarantee (every
 *      WMS stage multiplier == 1, so capacities equal the pre-P6 manual
 *      formula), determinism, the auto.* KB defaults trace to the domain
 *      model (no drift), and the VDI-informed / NOT measured / NOT a vendor
 *      spec / NOT a certification honesty labels.
 *  21. verify_report.js    - Consolidated WMS Report (P7): WT.report.build()
 *      aggregates every layer into one stakeholder artifact and asserts
 *      CROSS-CONSISTENCY so it can never drift from the app - the report's
 *      compliance summary EQUALS WT.compliance.check, its KPIs EQUAL
 *      WT.wms.kpis(runOperations), its occupancy EQUALS WT.storage.stats,
 *      its automation EQUALS WT.automation.report and its data profile
 *      EQUALS WT.wmsdata.stats (all for the same layout + echoed config);
 *      the standards basis pulls WT.kb.list() with sources; toHtml is a
 *      self-contained OFFLINE printable (no external refs) carrying the
 *      honesty banner + every section header; toJson round-trips; same
 *      layout + timestamp -> identical html/json/csv bytes (determinism);
 *      it runs on an examples.js AND a generated layout; not-yet-run
 *      sections are MARKED (never thrown); and the SYNTHETIC / NOT measured
 *      / NOT a certification / ISO-DIN-VDI-informed honesty is restated.
 *
 * Usage:  node test/run-all.mjs
 * ASCII-only output. Exit code 0 = every harness green.
 * ===================================================================== */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const HARNESSES = [
  { name: "optimizer measurement (measure_optimizer.js)", args: ["measure_optimizer.js"] },
  { name: "heatmap conservation + KPI baselines (verify_heatmap.js)", args: ["verify_heatmap.js"] },
  { name: "LSP Planner engine gates (lsp/verify.js)", args: [path.join("lsp", "verify.js")] },
  { name: "share-link codec round-trip (verify_share.js)", args: ["verify_share.js"] },
  { name: "CSV data import + determinism (verify_data.js)", args: ["verify_data.js"] },
  { name: "IFC export bridge (verify_ifc.js)", args: ["verify_ifc.js"] },
  { name: "Compliance Check findings (verify_compliance.js)", args: ["verify_compliance.js"] },
  { name: "AI Environment Generator (verify_generate.js)", args: ["verify_generate.js"] },
  { name: "Example Scenarios + data export (verify_examples.js)", args: ["verify_examples.js"] },
  { name: "WMS Operations layer (verify_wms.js)", args: ["verify_wms.js"] },
  { name: "Live material-flow animation (verify_flowsim.js)", args: ["verify_flowsim.js"] },
  { name: "Live KPI dashboard (verify_kpicharts.js)", args: ["verify_kpicharts.js"] },
  { name: "viewport transform + floor size (verify_view.js)", args: ["verify_view.js"] },
  { name: "SKU master + order pool data layer (verify_wmsdata.js)", args: ["verify_wmsdata.js"] },
  { name: "Material-flow realism: stations/queues/conveyor (verify_flowB.js)", args: ["verify_flowB.js"] },
  { name: "2.5D isometric presentation projection (verify_iso.js)", args: ["verify_iso.js"] },
  { name: "Storage & inventory: slotting/occupancy/retrieval (verify_storage.js)", args: ["verify_storage.js"] },
  { name: "Editable standards knowledge base (verify_kb.js)", args: ["verify_kb.js"] },
  { name: "Automation systems modeling (verify_automation.js)", args: ["verify_automation.js"] },
  { name: "Consolidated WMS Report (verify_report.js)", args: ["verify_report.js"] },
  { name: "offline guard (tools/offline-guard.mjs)", args: [path.join("tools", "offline-guard.mjs")] },
];

let failures = 0;
console.log("Logistics Flow Studio - full verification run");
console.log("root: " + ROOT);

for (const h of HARNESSES) {
  console.log("");
  console.log("=".repeat(72));
  console.log("RUN  " + h.name);
  console.log("=".repeat(72));
  const res = spawnSync(process.execPath, h.args, { cwd: ROOT, stdio: "inherit" });
  const code = res.status === null ? 1 : res.status;
  if (code === 0) {
    console.log("[PASS] " + h.name);
  } else {
    console.log("[FAIL] " + h.name + " (exit " + code + ")");
    failures++;
  }
}

console.log("");
console.log("-".repeat(72));
console.log(
  failures === 0
    ? "ALL " + HARNESSES.length + " HARNESSES PASSED"
    : failures + " OF " + HARNESSES.length + " HARNESSES FAILED"
);
process.exit(failures === 0 ? 0 : 1);
