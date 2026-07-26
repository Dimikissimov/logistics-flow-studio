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
 *   4. tools/offline-guard.mjs - no external assets referenced from
 *      any app file (the app must stay 100% offline).
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
