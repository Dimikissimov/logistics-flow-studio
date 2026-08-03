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
 *  22. verify_demo.js      - Guided demo plan + About copy (P8): WT.demo is a
 *      PURE, DETERMINISTIC step plan - script() returns an ordered non-empty
 *      list whose every action maps to a KNOWN capability (WT.demo.ACTIONS)
 *      and every referenced example id EXISTS in WT.examples.library; steps
 *      carry title+blurb; script() is byte-stable AND returns a fresh copy;
 *      run() drives the actions in order through an injected controller and
 *      is INTERRUPTIBLE (stops on request, fires onStop); and the About copy
 *      (WT.demo.ABOUT) states the offline / synthetic-unless-imported /
 *      not-a-certification facts, carries the generate->report pipeline, and
 *      is HYPE-FREE (no "certified"/"guaranteed"/"best-in-class"/"best", no
 *      real brand). The button/HUD/modal are DOM and not headless-testable;
 *      the pure plan + copy behind them are fully covered here.
 *  23. verify_ui.js        - Collapsible side-panel cards (v1.0): WT.cards is
 *      a PURE, DOM-free collapse-state helper with a localStorage-GUARDED
 *      backing (no-op in Node). Asserts the DEFAULT is all-expanded (empty
 *      set, nothing ships collapsed), slug() is pure/deterministic, toggle/
 *      set/clear behave, a collapse PERSISTS across a fresh set reading the
 *      same store (survives a reload), the localStorage guard no-ops cleanly
 *      while in-memory toggles still work, and only `true` ids ever count as
 *      collapsed (no corrupt default). Plus source guards: index.html loads
 *      cards.js before app.js and ships NO card--collapsed (default expanded),
 *      sw.js precaches ./cards.js, and app.js wires the cards GENERICALLY.
 *      The runtime DOM affordance is added by app.js and not headless-testable;
 *      the pure helper + shipped-source guarantees behind it are covered here.
 *  24. verify_scenarios.js - Save / load NAMED scenarios (v1.1): WT.scenarios
 *      is a PURE, localStorage-GUARDED store (no-op in Node -> default empty)
 *      for the user's OWN saved plants. Asserts the API surface, save->list->
 *      load round-tripping the serialize() snapshot DEEP-EQUAL (loading
 *      reconstructs the same layout+config), the list summary (element count/
 *      floor/savedAt), unique-BY-SLUG saves updating in place, rename (with a
 *      collision throw) + remove, exportBundle->importBundle round-tripping
 *      into a FRESH store, DETERMINISTIC sorted-key bytes (import->re-export
 *      stable), and honest validation (malformed bundles rejected without
 *      mutating the store, junk entries skipped, save() rejecting bad input).
 *      Plus shipped-source guards: index.html loads scenarios.js before app.js
 *      with the on-device honesty label, sw.js precaches it at a versioned cache, and
 *      app.js loads a scenario through the SAME deserialize() as JSON import.
 *      The DOM control is added by app.js and not headless-testable; the pure
 *      store + shipped-source guarantees behind it are covered here.
 *  25. verify_compare.js  - Scenario A/B compare (v1.2): WT.compare picks
 *      TWO set-ups and shows their key metrics side-by-side with honest
 *      deltas. Asserts each side is DERIVED FROM WT.report.build (the
 *      metricsFor result CARRIES the report verbatim, deep-equal) and its
 *      byKey values CROSS-CONSISTENTLY EQUAL WT.wms.kpis / WT.storage.stats
 *      / WT.automation.report / WT.compliance.check for the same layout +
 *      config - so a compared side can never drift from the app; deltas are
 *      correct B-A + % arithmetic; determinism (same layouts + timestamp ->
 *      identical bytes; deltas timestamp-independent); a layout vs ITSELF ->
 *      all-zero deltas; runs across an examples layout vs a generated one;
 *      sources() lists current + examples + saved (current honestly marked
 *      unavailable when absent); resolve() rebuilds each via the SAME
 *      builders; better/worse applied ONLY to unambiguous metrics (neutral -
 *      capacity/utilisation/automation - never scored); and the SYNTHETIC /
 *      NOT measured / NOT a certification / ISO-DIN-VDI honesty is restated.
 *      The DOM panel/modal are added by app.js and not headless-testable;
 *      the pure compare + cross-consistency behind them are covered here.
 *  26. verify_orderpool.js - Live order pool (v1.3): WT.orderpool is a PURE,
 *      DETERMINISTIC, bounded order-pool model (the Siemens generateOrders ->
 *      DT_tempOrders(SizeOrderPool) -> M_selectOrders -> consumed spine).
 *      Asserts determinism (same seed + same (dtTicks, io) sequence -> byte-
 *      identical counters/accumulators/PRNG, and chunking-invariant whole
 *      ticks), COUNT CONSERVATION at every step (generated == inPool +
 *      inFlightSelected + completed + dropped) across fill/drain/steady
 *      phases, the cap respected (inPool never exceeds SizeOrderPool, overflow
 *      counted as dropped/backpressure), backlog growing when arrivals >
 *      selections and draining when selections > arrivals, the starving
 *      (empty pool under demand) and saturating (backlog at the cap /
 *      overflowing) flags correct at the extremes and BOTH off at a balanced
 *      mid state, the selection rate tied to WT.wms / WT.flowsim throughput
 *      (releasing ~lineThroughput/avgUnits orders per hour), the wmsdata SKU-
 *      velocity-weighted generator used when present with a graceful fallback
 *      when it is absent (and when useWmsData:false), completions never
 *      exceeding selections, non-negative rates + fillPct, and the SYNTHETIC /
 *      heuristic / NOT a DES engine / NOT measured / NOT a certification /
 *      overflow + starvation honesty labels. The DOM readout is added by
 *      app.js and not headless-testable; the pure model behind it is covered.
 *  27. verify_shapes.js   - Distinct 2D glyph + 3D form per object type (v1.4):
 *      WT.shapes is the SINGLE per-type shape registry (has/draw2D/draw3D/
 *      ICONS/meta) both renderers route through. Asserts has() is true for
 *      EVERY domain element type (2D AND 3D defined - no type left a plain
 *      rect), the registry covers EXACTLY the domain types (no orphans),
 *      meta + ICONS cover them with non-empty descriptions/fns, and - the key
 *      gate for a pure-draw feature that can't be pixel-tested headlessly - a
 *      MOCK-CONTEXT smoke test that draws every type in BOTH 2D and 3D, in
 *      light + dark, at small AND large scale (exercising the LOD path), with
 *      NO throw and NO non-finite coordinate; the LOD path is distinct (the
 *      full glyph draws more than the zoomed-out icon), the 3D forms use the
 *      domain heightM (a taller element rises on screen for every type),
 *      neither draw mutates its inputs, unknown types are safe (false, no
 *      throw), and the illustrative / NOT CAD / NOT BIM / no-brands honesty
 *      labels are present. The live pixels are verified in the browser; every
 *      draw PATH is covered here.
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
  { name: "Guided demo plan + About copy (verify_demo.js)", args: ["verify_demo.js"] },
  { name: "Collapsible side-panel cards (verify_ui.js)", args: ["verify_ui.js"] },
  { name: "Save / load named scenarios (verify_scenarios.js)", args: ["verify_scenarios.js"] },
  { name: "Scenario A/B compare (verify_compare.js)", args: ["verify_compare.js"] },
  { name: "Live order pool (verify_orderpool.js)", args: ["verify_orderpool.js"] },
  { name: "Per-type 2D+3D shape registry (verify_shapes.js)", args: ["verify_shapes.js"] },
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
