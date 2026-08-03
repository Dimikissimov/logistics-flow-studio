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
