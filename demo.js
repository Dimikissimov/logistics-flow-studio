/* =====================================================================
 * Logistics Flow Studio - WarehouseTwin
 * demo.js - the one-click GUIDED DEMO plan + the "About / why this" copy
 * ---------------------------------------------------------------------
 * Phase P8 (commercial demo polish). This module is a PURE, DETERMINISTIC
 * DESCRIPTION of the guided demo - data, not DOM. It knows the ORDER of a
 * short end-to-end tour and which existing app capability each step
 * exercises; it does NOT touch the page. app.js drives the real UI by
 * handing `run()` a controller whose `actions` map the step action names
 * to the SAME functions the manual controls already call (loadExample,
 * runWmsOps, flowPlay, the KPI cockpit repaint, the WMS Report button) -
 * so the demo never re-implements a feature, it only sequences them.
 *
 * WT.demo = { PARAMS, ACTIONS, STEPS, script, run, ABOUT }
 *   PARAMS    timing knobs (pauses) - plain numbers.
 *   ACTIONS   the KNOWN capability names a step may reference (the set
 *             verify_demo.js asserts every step.action against).
 *   STEPS     the canonical ordered step plan. Each step:
 *               { id, title, blurb, action[, exampleId, pauseAfterMs] }
 *   script()  -> a FRESH deep copy of the ordered step list (so a caller
 *             can annotate its copy without mutating the canon; two calls
 *             are byte-identical -> deterministic).
 *   run(ctrl) -> drives the plan through an injected controller and
 *             resolves to { ran:[actionNames], stopped:bool, steps:n }.
 *             Interruptible: ctrl.stopped() is checked before every step.
 *   ABOUT     the concise, HONEST positioning copy (structured data) the
 *             About panel renders - single source of truth, so the honesty
 *             statements are asserted headlessly in verify_demo.js.
 *
 * HARD HONESTY (mirrored in the UI + README): the demo loads a SYNTHETIC,
 * illustrative example scenario (no real company/brand); the About copy is
 * hype-free and states the offline / synthetic-unless-imported /
 * not-a-certification facts. No external references - fully offline.
 *
 * Classic script attaching to the global `WT` namespace so it works from
 * file:// too. No dependencies at module-load time.
 * ===================================================================== */
(function () {
  "use strict";
  const WT = (window.WT = window.WT || {});

  // Timing knobs. Plain numbers so the plan stays deterministic and the
  // app can override per-run (e.g. a faster screenshot pass).
  const PARAMS = {
    stepPauseMs: 1500, // dwell between steps so each is readable
    flowWarmupMs: 2800, // extra dwell after Play so the floor + KPIs fill
  };

  // The KNOWN set of capability names a step may reference. Each maps to a
  // real app function (wired in app.js's demo controller). verify_demo.js
  // asserts every step.action is in this set - a step can never name a
  // capability the app does not expose.
  //   loadExample  -> app.loadExample(id)   (Example scenarios loader)
  //   runWmsOps    -> app.runWmsOps()        (WMS Operations panel run)
  //   playFlow     -> app.flowPlay()         (Live material-flow animation)
  //   showKpis     -> repaint/focus the live KPI cockpit canvas
  //   offerReport  -> surface the WMS Report (print) control
  const ACTIONS = ["loadExample", "runWmsOps", "playFlow", "showKpis", "offerReport"];

  // The canonical guided tour: a strong synthetic scenario -> WMS ops ->
  // live flow -> live KPIs -> the consolidated report. Five readable steps.
  const STEPS = [
    {
      id: "load-scenario",
      title: "Load a scenario",
      blurb:
        "Loading the Cold-chain frozen DC - a synthetic, illustrative scenario (no real company). " +
        "It builds a compliance-checked layout on the floor.",
      action: "loadExample",
      exampleId: "coldchain-frozen-dc",
    },
    {
      id: "run-wms",
      title: "Run WMS operations",
      blurb:
        "Running the 7-stage WMS flow - receiving through shipping - with per-stage throughput, " +
        "load and backlog, and the bottleneck stage flagged in plain language.",
      action: "runWmsOps",
    },
    {
      id: "play-flow",
      title: "Animate the material flow",
      blurb:
        "Starting the live material-flow animation - synthetic handling units moving " +
        "receiving -> storage -> pick -> pack -> ship. A teaching animation, not a DES engine.",
      action: "playFlow",
      pauseAfterMs: PARAMS.flowWarmupMs,
    },
    {
      id: "surface-kpis",
      title: "Watch the live KPIs",
      blurb:
        "Surfacing the live KPI cockpit - throughput over time and load-vs-capacity per stage, " +
        "updating as the flow runs. Modelled and synthetic, not measured.",
      action: "showKpis",
    },
    {
      id: "open-report",
      title: "Build the report",
      blurb:
        "The consolidated WMS Report pulls every layer into one offline, printable stakeholder " +
        "document. Open it whenever you are ready - nothing is uploaded.",
      action: "offerReport",
    },
  ];

  // A fresh deep copy each call: callers may annotate their copy without
  // mutating the canon, and two calls are byte-identical (determinism is
  // asserted in verify_demo.js). No Date / Math.random anywhere.
  function script() {
    return STEPS.map((s) => Object.assign({}, s));
  }

  // Drive the plan through an injected controller so this module stays
  // DOM-free (and headlessly testable). The controller supplies:
  //   actions  { [name]: fn(step) }  - the real app capabilities
  //   pause    (ms) => Promise        - an INTERRUPTIBLE delay
  //   stopped  () => boolean          - true once the user hit Stop
  //   onStep   (step, index, total)   - update the step indicator
  //   onDone   ()                     - the plan finished
  //   onStop   (index)                - the plan was interrupted
  // Resolves to a summary of what actually ran (used by verify_demo.js).
  function run(controller) {
    const c = controller || {};
    const actions = c.actions || {};
    const pause = typeof c.pause === "function" ? c.pause : function () { return Promise.resolve(); };
    const stopped = typeof c.stopped === "function" ? c.stopped : function () { return false; };
    const steps = script();
    const total = steps.length;
    const ran = [];

    return (async function () {
      for (let i = 0; i < total; i++) {
        if (stopped()) {
          if (c.onStop) c.onStop(i);
          return { ran: ran, stopped: true, steps: total };
        }
        const step = steps[i];
        if (c.onStep) c.onStep(step, i, total);
        const fn = actions[step.action];
        if (typeof fn === "function") {
          fn(step);
          ran.push(step.action);
        }
        if (i < total - 1) {
          const ms = step.pauseAfterMs != null ? step.pauseAfterMs : PARAMS.stepPauseMs;
          await pause(ms);
        }
      }
      if (c.onDone) c.onDone();
      return { ran: ran, stopped: false, steps: total };
    })();
  }

  // The "About / why this" positioning - concise, HONEST, hype-free. This
  // is the SINGLE SOURCE OF TRUTH: app.js renders the About panel from it,
  // and verify_demo.js asserts the honesty statements + the absence of any
  // hype word against it. No superlatives, no real brands.
  const ABOUT = {
    title: "About WarehouseTwin",
    tagline:
      "An offline, browser-based warehouse / WMS digital twin and plant-flow simulator - " +
      "it runs on a laptop, with no install and no account.",
    what: [
      "Generate a whole warehouse layout from a plant profile, or start from one of the 22 synthetic industry example scenarios.",
      "Simulate the material flow and the 7-stage WMS operation to see throughput, per-stage load and where the bottleneck is.",
      "Read the live KPI cockpit, check the layout against public safety/design guidance, and roll every layer up into one consolidated report.",
    ],
    pipeline: ["Generate", "Simulate", "Live KPIs", "Compliance-aware", "Report"],
    honesty: [
      "Runs fully offline in your browser - nothing is uploaded, there is no cloud and no account.",
      "All data is synthetic and seeded unless you import your own - the example scenarios are illustrative and name no real company, brand or site.",
      "Informed by public standards (ISO 22400, DIN 15185, ASR, EN, VDI) - it is a design aid, not a certification, and its numbers are modelled, not measured.",
    ],
    forWho:
      "For warehouse and logistics planners, industrial-engineering students and solution consultants who want to sketch, " +
      "sanity-check and explain a layout quickly - before committing to a detailed engineering tool.",
  };

  WT.demo = { PARAMS: PARAMS, ACTIONS: ACTIONS, STEPS: STEPS, script: script, run: run, ABOUT: ABOUT };
})();
