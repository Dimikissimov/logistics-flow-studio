/* =====================================================================
 * Logistics Flow Studio - WarehouseTwin
 * automation.js - warehouse AUTOMATION systems modeling (phase P6)
 * ---------------------------------------------------------------------
 * Models the warehouse AUTOMATION systems - AS/RS, shuttle, RGV, AGV,
 * conveyor - as EXPLICIT throughput contributors with cycle-time
 * parameters and utilisation, toward the material-handling detail of the
 * Siemens reference's RGV / AS-RS handling. This replaces the previous
 * single flat automation multiplier with a per-system model you can
 * read, explain and edit:
 *
 *   systems(layout)      -> the automation systems present, grouped by
 *                           type, each with a count and a per-unit
 *                           throughput (units/hr) from a cycle-time param.
 *   throughput(systems)  -> the aggregate automation-provided throughput,
 *                           and how much of it feeds each WMS stage.
 *   utilisation(systems, -> each system's utilisation % against the flow
 *               demand)     demand (over-capacity flagged HONESTLY).
 *   report(layout,demand)-> a structured automation report: per-system
 *                           count / throughput / utilisation, whether it
 *                           is the constraint, and a plain-language line.
 *
 * SINGLE SOURCE OF TRUTH. The per-unit cycle-time / throughput numbers
 * live in the editable knowledge base (WT.kb "auto.*", seeded from the
 * domain model). The throughput MATH lives in WT.wms
 * (automationContributions / automationBoost) so the WMS capacity layer
 * and this module can never disagree - this module reuses it and adds the
 * utilisation / constraint / report layer on top. Editing a KB cycle-time
 * (e.g. auto.asrs.cyclesPerHr) changes BOTH the automation throughput here
 * AND the WMS stage capacities - that is the point.
 *
 * HARD HONESTY (mirrored in the UI + README): everything here is a
 * transparent cycle-time HEURISTIC informed by VDI 4480 (throughput
 * determination for storage/retrieval machines) and VDI 2510 (AGV
 * systems), editable via the KB. It is NOT measured, NOT a vendor spec
 * and NOT a certification. Utilisation is demand / modeled throughput, not
 * an observed figure.
 *
 * Determinism: pure function of (layout, KB, demand); no Date, no
 * Math.random. Classic script attaching to the global `WT` namespace so it
 * works from file:// too. Loads AFTER wms.js (it reuses WT.wms) and after
 * knowledge.js. No frameworks, no build step, fully offline.
 * ===================================================================== */
(function () {
  "use strict";
  const WT = (window.WT = window.WT || {});

  const SYNTHETIC_LABEL =
    "SYNTHETIC automation model - a transparent, VDI-informed cycle-time " +
    "HEURISTIC. Per-unit throughputs (AS/RS & shuttle machine cycles, " +
    "RGV/AGV moves, conveyor units per hour) are order-of-magnitude " +
    "teaching values editable in the knowledge base (WT.kb 'auto.*'), " +
    "informed by VDI 4480 (throughput determination for storage/retrieval) " +
    "and VDI 2510 (AGV systems). Utilisation is demand / modeled " +
    "throughput. NOT measured, NOT a vendor spec, NOT a certification.";

  // KB ids + descriptive metadata per automation system type. The numeric
  // values come from WT.kb / WT.wms, never duplicated here.
  const KB_ID = {
    asrs: "auto.asrs.cyclesPerHr",
    shuttle: "auto.shuttle.cyclesPerHr",
    rgv: "auto.rgv.movesPerHr",
    agv: "auto.agv.movesPerHr",
    conveyor: "auto.conveyor.unitsPerHr",
  };
  const CATEGORY = {
    asrs: "storage/retrieval", shuttle: "storage/retrieval",
    rgv: "transport", agv: "transport", conveyor: "transport",
  };
  const SOURCE = {
    asrs: "AS/RS stacker-crane dual-command cycle throughput - informed by VDI 4480 & VDI 3564. Editable KB param; NOT measured, NOT a vendor spec.",
    shuttle: "Shuttle+lift channel cycle throughput - informed by VDI 4480. Editable KB param; NOT measured, NOT a vendor spec.",
    rgv: "Rail-guided-vehicle transport moves/hr per lane - informed by VDI 2510. Editable KB param; NOT measured, NOT a vendor spec.",
    agv: "AGV / AMR delivery moves/hr per route - informed by VDI 2510. Editable KB param; NOT measured, NOT a vendor spec.",
    conveyor: "Powered conveyor segment units/hr - informed by general material-flow throughput practice (VDI 4480 family). Editable KB param; NOT measured.",
  };
  const NOTE =
    "Transparent, VDI-informed cycle-time heuristic - editable in the knowledge base, the user's to verify. NOT measured, NOT a vendor spec, NOT a certification.";

  // The WMS stages automation can feed (order-picking excluded - it comes
  // from the pick-travel sim). Kept in sync via WT.wms.AUTO_SERVES below.
  const AUTOMATABLE_STAGES = ["receiving", "put-away", "storage", "replenishment", "packing", "shipping"];

  function wms() { return WT.wms || null; }

  function refUnitsPerHr() {
    const W = wms();
    return (W && W.PARAMS && W.PARAMS.autoRefUnitsPerHr) || 1200;
  }
  function maxFactor() {
    const W = wms();
    return (W && W.PARAMS && W.PARAMS.autoFactorMax) || 2.5;
  }

  // Layout stats (counts per type) - reuse WT.wms.layoutStats so the whole
  // app shares ONE definition of "how many of each automation element".
  function statsOf(layout) {
    const W = wms();
    if (W && typeof W.layoutStats === "function") return W.layoutStats(layout);
    // Minimal fallback (should not happen when wms.js is loaded).
    const els = (layout && layout.elements) || [];
    const c = (t) => els.filter((e) => e.type === t).length;
    return { asrs: c("asrs"), shuttle: c("shuttle"), rgv: c("rgv"), agv: c("agv"), conveyor: c("conveyor") };
  }

  // The per-system throughput rows (the single source of truth = WT.wms).
  function contributionRows(layout) {
    const W = wms();
    const stats = statsOf(layout);
    if (W && typeof W.automationContributions === "function") {
      return W.automationContributions(stats).rows;
    }
    return [];
  }

  /* ------------------------------------------------------------------
   * systems(layout) -> the automation systems PRESENT (count > 0),
   * grouped by type, each with its per-unit + total modeled throughput
   * and the WMS stages it serves. Honest labels attached.
   * ------------------------------------------------------------------ */
  function systems(layout) {
    return contributionRows(layout)
      .filter((r) => r.count > 0)
      .map((r) => ({
        type: r.type,
        label: r.label,
        category: CATEGORY[r.type] || "automation",
        unit: r.unit,
        count: r.count,
        perUnitThroughputUnitsPerHr: r.perUnitUnitsPerHr,
        rateLabel: r.rateLabel,
        throughputUnitsPerHr: r.throughputUnitsPerHr,
        serves: r.serves.slice(),
        kbId: KB_ID[r.type] || null,
        source: SOURCE[r.type] || "",
        note: NOTE,
      }));
  }

  /* ------------------------------------------------------------------
   * throughput(systemsOrLayout) -> the aggregate automation-provided
   * throughput and how much feeds each WMS stage.
   *   { totalUnitsPerHr, perSystem:[{type,throughputUnitsPerHr}],
   *     perStage:{stage: unitsPerHr}, factorByStage:{stage: multiplier},
   *     refUnitsPerHr, maxFactor }.
   * Accepts EITHER the array from systems() or a raw layout.
   * ------------------------------------------------------------------ */
  function throughput(systemsOrLayout) {
    const list = Array.isArray(systemsOrLayout) ? systemsOrLayout : systems(systemsOrLayout);
    const ref = refUnitsPerHr();
    const cap = maxFactor();

    let total = 0;
    const perSystem = [];
    const perStage = {};
    for (const st of AUTOMATABLE_STAGES) perStage[st] = 0;

    for (const s of list) {
      total += s.throughputUnitsPerHr;
      perSystem.push({ type: s.type, label: s.label, throughputUnitsPerHr: s.throughputUnitsPerHr });
      for (const stage of (s.serves || [])) {
        if (stage in perStage) perStage[stage] += s.throughputUnitsPerHr;
      }
    }
    const factorByStage = {};
    for (const st of AUTOMATABLE_STAGES) {
      factorByStage[st] = Math.min(cap, 1 + perStage[st] / ref);
    }
    return {
      totalUnitsPerHr: total,
      perSystem: perSystem,
      perStage: perStage,
      factorByStage: factorByStage,
      refUnitsPerHr: ref,
      maxFactor: cap,
    };
  }

  /* ------------------------------------------------------------------
   * utilisation(systemsOrLayout, demand) -> each system's utilisation %
   * against the flow demand (units/hr the operation must sustain).
   *   utilisationPct = 100 * demand / systemThroughput.
   * A system whose modeled throughput is below the demand is HONESTLY
   * flagged over-capacity (utilisation > 100% -> a constraint).
   * `demand` may be a number (units/hr) or omitted (0).
   * ------------------------------------------------------------------ */
  function utilisation(systemsOrLayout, demand) {
    const list = Array.isArray(systemsOrLayout) ? systemsOrLayout : systems(systemsOrLayout);
    const d = Math.max(0, Number(demand) || 0);
    return list.map((s) => {
      const thr = Math.max(0, s.throughputUnitsPerHr);
      const pct = thr > 0 ? (100 * d) / thr : (d > 0 ? Infinity : 0);
      const finitePct = isFinite(pct) ? pct : 999;
      return {
        type: s.type,
        label: s.label,
        category: s.category,
        count: s.count,
        throughputUnitsPerHr: thr,
        demandUnitsPerHr: d,
        utilisationPct: finitePct,
        overCapacity: thr > 0 ? d > thr + 1e-9 : d > 0,
        headroomUnitsPerHr: thr - d,
      };
    });
  }

  /* ------------------------------------------------------------------
   * resolveDemand(layout, demand) -> the flow demand (units/hr) the
   * automation systems must sustain. A number is used directly; an object
   * carrying throughputUnitsPerHr (a WMS kpis / result) is read; otherwise
   * the WMS operations model is run (deterministic) and its realized
   * throughput used. Returns { demandUnitsPerHr, source }.
   * ------------------------------------------------------------------ */
  function resolveDemand(layout, demand) {
    if (typeof demand === "number" && isFinite(demand) && demand >= 0) {
      return { demandUnitsPerHr: demand, source: "given (units/hr)" };
    }
    if (demand && typeof demand === "object" && isFinite(demand.throughputUnitsPerHr)) {
      return { demandUnitsPerHr: Math.max(0, demand.throughputUnitsPerHr), source: "WMS throughput" };
    }
    const W = wms();
    if (W && typeof W.runOperations === "function" && typeof W.kpis === "function") {
      try {
        const res = W.runOperations(layout, {});
        const kp = W.kpis(res, layout);
        return { demandUnitsPerHr: Math.max(0, kp.throughputUnitsPerHr || 0), source: "WMS operations run" };
      } catch (_) { /* fall through */ }
    }
    return { demandUnitsPerHr: 0, source: "none" };
  }

  /* ------------------------------------------------------------------
   * report(layout, demand) -> a structured automation report:
   *   { dataLabel, hasAutomation, systems, throughput, demandUnitsPerHr,
   *     demandSource, utilisation, constraint, summary }.
   * The constraint is the automation system with the highest utilisation
   * (over-capacity if its modeled throughput is below the demand).
   * ------------------------------------------------------------------ */
  function report(layout, demand) {
    const sys = systems(layout);
    const tp = throughput(sys);
    const dem = resolveDemand(layout, demand);
    const util = utilisation(sys, dem.demandUnitsPerHr);

    // Constraint = the highest-utilisation automation system.
    let constraint = { present: false };
    if (util.length) {
      let top = util[0];
      for (const u of util) if (u.utilisationPct > top.utilisationPct + 1e-9) top = u;
      constraint = {
        present: true,
        type: top.type,
        label: top.label,
        utilisationPct: top.utilisationPct,
        throughputUnitsPerHr: top.throughputUnitsPerHr,
        demandUnitsPerHr: top.demandUnitsPerHr,
        overCapacity: top.overCapacity,
        plain:
          top.overCapacity
            ? top.label + " is the automation constraint: its modeled throughput (" +
              Math.round(top.throughputUnitsPerHr).toLocaleString("en-US") + " units/hr) is below the " +
              Math.round(top.demandUnitsPerHr).toLocaleString("en-US") + " units/hr flow demand (" +
              fmtPct(top.utilisationPct) + " utilisation) - add units or raise its cycle rate."
            : top.label + " is the most-loaded automation system at " + fmtPct(top.utilisationPct) +
              " utilisation vs the " + Math.round(top.demandUnitsPerHr).toLocaleString("en-US") +
              " units/hr flow demand (it keeps up, with headroom).",
      };
    }

    const summary = buildSummary(sys, tp, dem, constraint);

    return {
      dataLabel: SYNTHETIC_LABEL,
      hasAutomation: sys.length > 0,
      systems: sys,
      throughput: tp,
      demandUnitsPerHr: dem.demandUnitsPerHr,
      demandSource: dem.source,
      utilisation: util,
      constraint: constraint,
      summary: summary,
    };
  }

  function buildSummary(sys, tp, dem, constraint) {
    if (!sys.length) {
      return "No automation systems on this floor - throughput is fully manual. " +
        "Add a conveyor, RGV, AGV, AS/RS or shuttle to model automated material handling.";
    }
    const parts = sys.map((s) => s.count + "x " + s.label + " (" + Math.round(s.throughputUnitsPerHr).toLocaleString("en-US") + " u/hr)");
    let msg = "Automation provides " + Math.round(tp.totalUnitsPerHr).toLocaleString("en-US") +
      " units/hr of modeled handling throughput across " + sys.length +
      " system type" + (sys.length === 1 ? "" : "s") + ": " + parts.join(", ") + ". " +
      "Against a " + Math.round(dem.demandUnitsPerHr).toLocaleString("en-US") + " units/hr flow demand, ";
    if (constraint.present) {
      msg += constraint.overCapacity
        ? constraint.label + " is over capacity (" + fmtPct(constraint.utilisationPct) + ") and is the constraint."
        : "the busiest system (" + constraint.label + ") runs at " + fmtPct(constraint.utilisationPct) + " - within capacity.";
    } else {
      msg += "no single system stands out.";
    }
    return msg;
  }

  function fmtPct(v) {
    if (!isFinite(v)) return ">999%";
    return v.toFixed(v >= 100 ? 0 : 1) + "%";
  }

  // The editable parameter roster (for the panel + honesty tie to the KB).
  const PARAMS = {
    label: SYNTHETIC_LABEL,
    get refUnitsPerHr() { return refUnitsPerHr(); },
    get maxFactor() { return maxFactor(); },
    stages: AUTOMATABLE_STAGES.slice(),
    systems: Object.keys(KB_ID).map((type) => ({
      type: type,
      kbId: KB_ID[type],
      category: CATEGORY[type],
      source: SOURCE[type],
      note: NOTE,
    })),
  };

  WT.automation = {
    SYNTHETIC_LABEL: SYNTHETIC_LABEL,
    KB_ID: KB_ID,
    PARAMS: PARAMS,
    AUTOMATABLE_STAGES: AUTOMATABLE_STAGES.slice(),
    systems: systems,
    throughput: throughput,
    utilisation: utilisation,
    resolveDemand: resolveDemand,
    report: report,
  };
})();
