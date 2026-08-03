/* =====================================================================
 * verify_demo.js - Guided demo plan + About copy verification (P8).
 *
 * Runs the REAL app modules (domain, knowledge, simulation, compliance,
 * generate, nlcommands, examples, demo) in Node under the same window shim
 * the other harnesses use and asserts the WT.demo contract - the DECLARATIVE
 * demo plan and the honest About copy - so the one-click demo can never
 * reference a missing example/capability and the About copy can never drift
 * into hype:
 *
 *   1.  API surface: WT.demo exposes STEPS, script, run, PARAMS, ACTIONS,
 *       ABOUT.
 *   2.  script() returns an ordered, NON-EMPTY step list (an array) whose
 *       order + ids match the canonical STEPS.
 *   3.  Every step has an id, a non-empty title, a non-empty blurb and an
 *       action.
 *   4.  ACTIONS is a non-empty known set and EVERY step.action is in it
 *       (a step can never name a capability the app does not expose).
 *   5.  Every example id a step references (loadExample) EXISTS in
 *       WT.examples.library.
 *   6.  Determinism: JSON.stringify(script()) is stable across calls, and
 *       script() returns a FRESH array (mutating one copy never leaks).
 *   7.  run() drives the actions in the declared order (a synchronous fake
 *       controller records the call order == the step actions).
 *   8.  run() is INTERRUPTIBLE: a controller that reports stopped after two
 *       steps runs exactly the first two actions and fires onStop.
 *   9.  About honesty: the ABOUT copy states the offline / synthetic-unless-
 *       imported / not-a-certification facts and carries the generate->report
 *       pipeline.
 *  10.  About is HYPE-FREE: the copy contains none of the banned superlatives
 *       ("certified", "guaranteed", "best-in-class", "best") and no obvious
 *       real brand.
 *
 * Everything is deterministic (no wall-clock, no Math.random). Usage:
 *   node verify_demo.js
 * ASCII-only output. Exit 0 = all checks pass.
 * ===================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");

global.window = global; // app modules attach themselves to window.WT
for (const f of [
  "domain.js", "knowledge.js", "simulation.js", "compliance.js",
  "generate.js", "nlcommands.js", "examples.js", "demo.js",
]) {
  // eslint-disable-next-line no-eval
  (0, eval)(fs.readFileSync(path.join(__dirname, f), "utf8"));
}
const WT = global.WT;
const EX = WT.examples;
const DEMO = WT.demo;

let failures = 0;
let checks = 0;
function check(name, ok, detail) {
  checks++;
  console.log((ok ? "[PASS] " : "[FAIL] ") + name + (detail ? " - " + detail : ""));
  if (!ok) failures++;
}
function isNonEmptyStr(s) { return typeof s === "string" && s.trim().length > 0; }

console.log("Guided demo plan + About copy verification (deterministic)");
console.log("");

// ---- 1. API surface -------------------------------------------------
check(
  "API surface: STEPS/script/run/PARAMS/ACTIONS/ABOUT present",
  DEMO &&
    Array.isArray(DEMO.STEPS) &&
    typeof DEMO.script === "function" &&
    typeof DEMO.run === "function" &&
    DEMO.PARAMS && typeof DEMO.PARAMS === "object" &&
    Array.isArray(DEMO.ACTIONS) &&
    DEMO.ABOUT && typeof DEMO.ABOUT === "object"
);

// ---- 2. script() ordered non-empty, matches canon ------------------
const steps = DEMO.script();
check(
  "script() returns an ordered, non-empty step list",
  Array.isArray(steps) && steps.length > 0,
  steps.length + " steps"
);
check(
  "script() order + ids match the canonical STEPS",
  steps.length === DEMO.STEPS.length &&
    steps.every((s, i) => s.id === DEMO.STEPS[i].id && s.action === DEMO.STEPS[i].action),
  steps.map((s) => s.id).join(" -> ")
);

// ---- 3. every step has id/title/blurb/action -----------------------
check(
  "every step has id + title + blurb + action",
  steps.every((s) => isNonEmptyStr(s.id) && isNonEmptyStr(s.title) && isNonEmptyStr(s.blurb) && isNonEmptyStr(s.action))
);

// ---- 4. ACTIONS known set; every step.action in it -----------------
const known = new Set(DEMO.ACTIONS);
check(
  "ACTIONS is a non-empty known capability set",
  Array.isArray(DEMO.ACTIONS) && DEMO.ACTIONS.length > 0 && DEMO.ACTIONS.every(isNonEmptyStr),
  DEMO.ACTIONS.join(", ")
);
const unknownActions = steps.filter((s) => !known.has(s.action)).map((s) => s.action);
check(
  "every step.action maps to a known capability",
  unknownActions.length === 0,
  unknownActions.length ? "unknown: " + unknownActions.join(", ") : "all known"
);

// ---- 5. referenced example ids exist in the library ----------------
const libIds = new Set((EX.library || []).map((e) => e.id));
const exampleSteps = steps.filter((s) => s.action === "loadExample");
const missingEx = exampleSteps.filter((s) => !isNonEmptyStr(s.exampleId) || !libIds.has(s.exampleId)).map((s) => s.exampleId);
check(
  "every loadExample step references an existing example id",
  exampleSteps.length > 0 && missingEx.length === 0,
  exampleSteps.map((s) => s.exampleId).join(", ") + (missingEx.length ? " | missing: " + missingEx.join(", ") : "")
);

// ---- 6. determinism + fresh copy -----------------------------------
const a = JSON.stringify(DEMO.script());
const b = JSON.stringify(DEMO.script());
check("script() is deterministic (byte-identical across calls)", a === b);
const c1 = DEMO.script();
const c2 = DEMO.script();
c1[0].title = "MUTATED";
check(
  "script() returns a FRESH copy (mutating one never leaks)",
  c2[0].title !== "MUTATED" && DEMO.STEPS[0].title !== "MUTATED"
);

// ---- 7. run() drives actions in declared order ---------------------
(async function runOrderTest() {
  const called = [];
  const actions = {};
  for (const name of DEMO.ACTIONS) actions[name] = () => called.push(name);
  const res = await DEMO.run({
    actions: actions,
    pause: () => Promise.resolve(), // immediate: deterministic + fast
    stopped: () => false,
  });
  const expected = DEMO.script().map((s) => s.action);
  check(
    "run() drives every action in the declared order",
    !res.stopped && JSON.stringify(res.ran) === JSON.stringify(expected) && JSON.stringify(called) === JSON.stringify(expected),
    called.join(" -> ")
  );

  // ---- 8. run() is interruptible -----------------------------------
  const called2 = [];
  const actions2 = {};
  for (const name of DEMO.ACTIONS) actions2[name] = () => called2.push(name);
  let stopIndex = -1;
  const res2 = await DEMO.run({
    actions: actions2,
    pause: () => Promise.resolve(),
    stopped: () => called2.length >= 2, // stop once two steps have run
    onStop: (i) => { stopIndex = i; },
  });
  check(
    "run() is interruptible (stops after the requested step, fires onStop)",
    res2.stopped === true && called2.length === 2 && stopIndex === 2,
    "ran " + called2.length + " actions, onStop at index " + stopIndex
  );

  // ---- 9 + 10. About copy honesty + hype-free ----------------------
  const A = DEMO.ABOUT;
  const blob = [
    A.title, A.tagline, A.forWho,
    (A.what || []).join(" "), (A.honesty || []).join(" "), (A.pipeline || []).join(" "),
  ].join(" ").toLowerCase();

  check(
    "About states the honesty facts (offline / synthetic-unless-imported / not a certification)",
    blob.indexOf("offline") !== -1 &&
      blob.indexOf("not a certification") !== -1 &&
      blob.indexOf("synthetic") !== -1 &&
      blob.indexOf("unless you import") !== -1,
    "ok"
  );
  check(
    "About carries the generate->report pipeline + non-empty what/honesty",
    Array.isArray(A.pipeline) && A.pipeline.length >= 3 &&
      A.pipeline.join(" ").toLowerCase().indexOf("generate") !== -1 &&
      A.pipeline.join(" ").toLowerCase().indexOf("report") !== -1 &&
      Array.isArray(A.what) && A.what.length > 0 && A.what.every(isNonEmptyStr) &&
      Array.isArray(A.honesty) && A.honesty.length > 0 && A.honesty.every(isNonEmptyStr)
  );

  const banned = ["certified", "guaranteed", "best-in-class", "best"];
  const hits = banned.filter((w) => blob.indexOf(w) !== -1);
  check(
    "About is hype-free (no banned superlatives)",
    hits.length === 0,
    hits.length ? "found: " + hits.join(", ") : "none of: " + banned.join(", ")
  );
  const brands = ["amazon", "wurth", "wurth", "sap", "siemens", "dematic", "swisslog", "kardex", "jungheinrich"];
  const brandHits = brands.filter((w) => blob.indexOf(w) !== -1);
  check(
    "About names no obvious real brand",
    brandHits.length === 0,
    brandHits.length ? "found: " + brandHits.join(", ") : "clean"
  );

  console.log("");
  console.log("-".repeat(60));
  console.log(
    failures === 0
      ? "ALL " + checks + " CHECKS PASSED"
      : failures + " OF " + checks + " CHECKS FAILED"
  );
  process.exit(failures === 0 ? 0 : 1);
})();
