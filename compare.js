/* =====================================================================
 * Logistics Flow Studio - WarehouseTwin
 * compare.js - Scenario A/B compare (v1.2)
 * ---------------------------------------------------------------------
 * Pick TWO warehouse set-ups and see their key metrics side-by-side with
 * honest deltas, so the user can answer "which layout / strategy is
 * better?" without eyeballing two separate reports.
 *
 * It does NOT recompute the physics. Every per-side number is DERIVED
 * FROM WT.report.build - the same consolidated report the app already
 * shows - which itself is cross-consistent with WT.compliance / WT.wms /
 * WT.storage / WT.automation / WT.wmsdata. So a side's figures EQUAL what
 * the app / WMS Report shows and the compare can never drift from them.
 *
 * API (pure + deterministic):
 *   sources(ctx)              -> the selectable A/B sources: the current
 *                               layout + the built-in example scenarios
 *                               (WT.examples.library) + the user's saved
 *                               scenarios (WT.scenarios.list). Each is
 *                               resolvable to a layout snapshot.
 *   resolve(src, ctx)         -> the layout snapshot for one source
 *                               descriptor (current / example / saved),
 *                               through the SAME builders the app uses
 *                               (WT.examples.build / WT.scenarios.load).
 *   metricsFor(layout, opts)  -> the comparable metric set for ONE side,
 *                               pulled out of WT.report.build(layout,opts):
 *                               layout capacity / floor-use, WMS operations
 *                               KPIs, storage occupancy / placement,
 *                               automation throughput, compliance
 *                               pass/warn/fail. Carries the full report so
 *                               nothing can drift. Deterministic (pass any
 *                               timestamp via opts).
 *   compare(aLayout, bLayout, opts) -> { a, b, deltas, summary }. Each
 *                               numeric delta gives absolute + % change
 *                               B-vs-A, a better/worse verdict ONLY where
 *                               the direction is unambiguous (lower pick
 *                               travel = better; more automation is NOT
 *                               automatically better - flagged neutral),
 *                               plus a plain-language "what changed"
 *                               summary with honest "higher isn't always
 *                               better" notes.
 *   SECTIONS, METRICS         -> the metric roster the compare emits.
 *   HONESTY                   -> the standing honesty statement.
 *
 * HARD HONESTY (mirrored in the UI + README): every figure is a
 * transparent, deterministic HEURISTIC informed by published standards
 * (ISO 22400, DIN 15185, ASR A1.8 / A2.3, EN / VDI). All numbers are
 * SYNTHETIC teaching estimates unless the user imported their own data.
 * This is NOT a certification, NOT measured. "Better / worse" is shown
 * ONLY for metrics whose direction is unambiguous; capacity / utilisation
 * / automation are left NEUTRAL with a note, because higher isn't always
 * better.
 *
 * Determinism: a pure function of (layouts, opts, the loaded modules). No
 * Date, no Math.random. Classic script attaching to the global `WT`
 * namespace so it works from file:// too. Loads AFTER report.js (and the
 * modules report aggregates). No frameworks, no build step, fully offline.
 * ===================================================================== */
(function () {
  "use strict";
  const WT = (window.WT = window.WT || {});

  const COMPARE_VERSION = "wt-compare-1";

  const HONESTY =
    "SYNTHETIC A/B compare - both sides are DERIVED FROM the same " +
    "consolidated WMS Report the app shows (WT.report.build), a transparent " +
    "deterministic HEURISTIC informed by published standards (ISO 22400, " +
    "DIN 15185, ASR A1.8 / A2.3, EN / VDI). All numbers are SYNTHETIC " +
    "teaching estimates unless you imported your own data. This is NOT a " +
    "certification and NOT measured. 'Better / worse' is shown ONLY where a " +
    "metric's direction is unambiguous - capacity, utilisation and " +
    "automation are left NEUTRAL because higher isn't always better.";

  // Metric section roster, in display order. Titles are the printed
  // group headers; keys tag each metric to a section.
  const SECTIONS = [
    { key: "layout", title: "Layout & capacity" },
    { key: "operations", title: "WMS operations" },
    { key: "storage", title: "Storage & inventory" },
    { key: "automation", title: "Automation" },
    { key: "compliance", title: "Compliance" },
  ];

  // ------------------------------------------------------------------
  // Small helpers.
  // ------------------------------------------------------------------
  function mod(name) { return WT[name] || null; }
  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function numOr(v, d) { const n = Number(v); return isFinite(n) ? n : d; }
  // Round to dp decimals, normalising -0 to 0 so deep-equality is stable.
  function roundTo(v, dp) {
    if (!isFinite(v)) return null;
    const f = Math.pow(10, dp);
    const r = Math.round(v * f) / f;
    return r === 0 ? 0 : r;
  }

  // ------------------------------------------------------------------
  // THE METRIC ROSTER. Each metric knows how to PULL its value out of the
  // report (never re-derived) and whether its direction is unambiguous:
  //   dir "higher"  -> more is better   (throughput, capacity, ...)
  //   dir "lower"   -> less is better   (cycle time, pick travel, ...)
  //   dir "neutral" -> direction is ambiguous; NEVER coloured better/worse,
  //                    carries a `note` explaining why higher isn't always
  //                    better (utilisation slack, automation capex, ...).
  // `get(report)` returns the number or null when the section could not be
  // produced for that layout (e.g. no storage -> storage metrics null).
  // ------------------------------------------------------------------
  const opAvail = (r) => !!(r && r.operations && r.operations.available && r.operations.ran);
  const stAvail = (r) => !!(r && r.storage && r.storage.available);
  const auAvail = (r) => !!(r && r.automation && r.automation.available);
  const coAvail = (r) => !!(r && r.compliance && r.compliance.available);

  const ROSTER = [
    // --- layout & capacity ---
    {
      key: "elementCount", label: "Elements", unit: "count", section: "layout", dir: "neutral",
      note: "More elements isn't inherently better or worse - it depends on what they contribute.",
      get: (r) => (r.layout ? numOr(r.layout.elementCount, null) : null),
    },
    {
      key: "storageCapacity", label: "Storage capacity", unit: "positions", section: "layout", dir: "higher",
      get: (r) => (r.layout ? numOr(r.layout.storageCapacityPositions, null) : null),
    },
    {
      key: "floorUsePct", label: "Floor use", unit: "%", section: "layout", dir: "neutral",
      note: "Higher floor use packs more in but leaves less circulation space - denser isn't automatically better.",
      get: (r) => (r.layout ? numOr(r.layout.floorUsePct, null) : null),
    },
    // --- WMS operations ---
    {
      key: "throughputUnitsPerHr", label: "Throughput", unit: "units / hr", section: "operations", dir: "higher",
      get: (r) => (opAvail(r) ? numOr(r.operations.throughputUnitsPerHr, null) : null),
    },
    {
      key: "throughputOrdersPerHr", label: "Throughput", unit: "orders / hr", section: "operations", dir: "higher",
      get: (r) => (opAvail(r) ? numOr(r.operations.throughputOrdersPerHr, null) : null),
    },
    {
      key: "orderCycleTimeMin", label: "Order cycle time", unit: "min", section: "operations", dir: "lower",
      get: (r) => (opAvail(r) ? numOr(r.operations.orderCycleTimeMin, null) : null),
    },
    {
      key: "dockToStockMin", label: "Dock-to-stock", unit: "min", section: "operations", dir: "lower",
      get: (r) => (opAvail(r) ? numOr(r.operations.dockToStockMin, null) : null),
    },
    {
      key: "pickingLinesPerHr", label: "Picking productivity", unit: "lines / hr", section: "operations", dir: "higher",
      get: (r) => (opAvail(r) ? numOr(r.operations.pickingLinesPerHr, null) : null),
    },
    {
      key: "storageUtilPct", label: "Storage utilisation", unit: "%", section: "operations", dir: "neutral",
      note: "High storage utilisation leaves less slack for peaks; very low means wasted space - mid-range is usually healthiest.",
      get: (r) => (opAvail(r) ? numOr(r.operations.storageUtilPct, null) : null),
    },
    // --- storage & inventory ---
    {
      key: "occupancyPct", label: "Occupancy", unit: "%", section: "storage", dir: "neutral",
      note: "Occupancy trades slack against space efficiency - higher isn't automatically better.",
      get: (r) => (stAvail(r) ? numOr(r.storage.fillPct, null) : null),
    },
    {
      key: "placedCount", label: "SKUs placed", unit: "SKUs", section: "storage", dir: "higher",
      get: (r) => (stAvail(r) ? numOr(r.storage.placedCount, null) : null),
    },
    {
      key: "overflowCount", label: "Overflow (unplaced)", unit: "SKUs", section: "storage", dir: "lower",
      get: (r) => (stAvail(r) ? numOr(r.storage.unplacedCount, null) : null),
    },
    {
      key: "aClassTravelM", label: "A-class pick travel", unit: "m", section: "storage", dir: "lower",
      get: (r) => (stAvail(r) && r.storage.placement ? numOr(r.storage.placement.avgDistAClassM, null) : null),
    },
    {
      key: "goldenAClassPct", label: "A-class in golden zone", unit: "%", section: "storage", dir: "higher",
      get: (r) => (stAvail(r) && r.storage.golden ? numOr(r.storage.golden.aClassPct, null) : null),
    },
    // --- automation ---
    {
      key: "automationThroughput", label: "Automation throughput", unit: "units / hr", section: "automation", dir: "neutral",
      note: "More modelled automation throughput adds capex and complexity - it only helps if it relieves the actual flow constraint.",
      get: (r) => (auAvail(r) ? numOr(r.automation.totalThroughputUnitsPerHr, null) : null),
    },
    // --- compliance ---
    {
      key: "compliancePass", label: "Compliance pass", unit: "rules", section: "compliance", dir: "higher",
      get: (r) => (coAvail(r) ? numOr(r.compliance.summary.pass, null) : null),
    },
    {
      key: "complianceWarn", label: "Compliance warn", unit: "rules", section: "compliance", dir: "lower",
      get: (r) => (coAvail(r) ? numOr(r.compliance.summary.warn, null) : null),
    },
    {
      key: "complianceFail", label: "Compliance fail", unit: "rules", section: "compliance", dir: "lower",
      get: (r) => (coAvail(r) ? numOr(r.compliance.summary.fail, null) : null),
    },
  ];

  // Data-only descriptor list (no getters), safe to expose / serialize.
  const METRICS = ROSTER.map((m) => ({
    key: m.key, label: m.label, unit: m.unit, section: m.section, dir: m.dir, note: m.note || null,
  }));

  // ------------------------------------------------------------------
  // metricsFor(layout, opts) -> the comparable metric set for ONE side.
  // Built by calling WT.report.build(layout, opts) and reading its already-
  // aggregated numbers, so the side EQUALS the app / WMS Report. Returns
  // the full report too, so a consumer (and the verify harness) can prove
  // cross-consistency against the source modules.
  // ------------------------------------------------------------------
  function metricsFor(layout, opts) {
    const R = mod("report");
    if (!R || typeof R.build !== "function") throw new Error("compare.metricsFor needs report.js (WT.report.build).");
    const report = R.build(layout || { elements: [] }, opts || {});
    const byKey = {};
    const availByKey = {};
    const metrics = ROSTER.map((m) => {
      const v = m.get(report);
      const value = isNum(v) ? v : null;
      const available = value !== null;
      byKey[m.key] = value;
      availByKey[m.key] = available;
      return {
        key: m.key, label: m.label, unit: m.unit, section: m.section, dir: m.dir,
        note: m.note || null, value: value, available: available,
      };
    });
    return {
      compareVersion: COMPARE_VERSION,
      metrics: metrics,
      byKey: byKey,
      available: availByKey,
      config: (report.meta && report.meta.config) || null,
      dataMode: (report.meta && report.meta.dataMode) || null,
      imported: !!(report.meta && report.meta.imported),
      scenario: (report.header && report.header.scenario) || null,
      honesty: HONESTY,
      report: report,
    };
  }

  // ------------------------------------------------------------------
  // Delta between two side values for one metric.
  //   absolute = B - A (rounded to 4 dp, -0 normalised)
  //   pct      = (B - A) / A * 100 (rounded 1 dp); null when A is 0 and the
  //             value changed (percent of zero is undefined)
  //   better   = "a" | "b" | "tie" | null. NEVER set for a neutral metric,
  //             so ambiguous-direction rows stay uncoloured.
  // ------------------------------------------------------------------
  function deltaFor(m, aVal, bVal) {
    const bothNum = isNum(aVal) && isNum(bVal);
    if (!bothNum) {
      return { key: m.key, dir: m.dir, available: false, absolute: null, pct: null, better: null };
    }
    const absolute = roundTo(bVal - aVal, 4);
    let pct;
    if (aVal === bVal) pct = 0;
    else if (aVal === 0) pct = null; // percent change from zero is undefined
    else pct = roundTo(((bVal - aVal) / Math.abs(aVal)) * 100, 1);
    let better = null;
    if (m.dir === "higher") better = bVal > aVal ? "b" : bVal < aVal ? "a" : "tie";
    else if (m.dir === "lower") better = bVal < aVal ? "b" : bVal > aVal ? "a" : "tie";
    // neutral -> better stays null (never coloured better/worse)
    return { key: m.key, dir: m.dir, available: true, absolute: absolute, pct: pct, better: better };
  }

  // ------------------------------------------------------------------
  // Plain-language "what changed" summary. Honest: unambiguous metrics get
  // a "better" verdict; neutral metrics get a "higher isn't always better"
  // note instead of a verdict.
  // ------------------------------------------------------------------
  function fmt(v) {
    if (!isNum(v)) return "-";
    const r = roundTo(v, 1);
    return String(r);
  }
  function sideWord(side) { return side === "a" ? "A" : side === "b" ? "B" : ""; }

  function buildSummary(a, b, deltas) {
    const points = [];
    const notes = [];
    const dByKey = {};
    deltas.forEach((d) => { dByKey[d.key] = d; });

    function bothAvail(key) { return a.available[key] && b.available[key]; }
    function phrase(key, higherWord, lowerWord, unit) {
      const d = dByKey[key];
      if (!d || !d.available || d.better == null || d.better === "tie") return null;
      const av = a.byKey[key], bv = b.byKey[key];
      const winner = d.better; // "a" | "b"
      const word = d.dir === "higher" ? higherWord : lowerWord;
      return "Side " + sideWord(winner) + " has " + word + " (" +
        "A " + fmt(av) + " " + unit + " vs B " + fmt(bv) + " " + unit +
        (d.pct != null ? ", " + (d.pct >= 0 ? "+" : "") + fmt(d.pct) + "% B-vs-A" : "") + ").";
    }

    // Throughput (higher is better) - the headline operational metric.
    if (bothAvail("throughputUnitsPerHr")) {
      const p = phrase("throughputUnitsPerHr", "higher throughput", "", "units/hr");
      if (p) points.push(p); else points.push("Throughput is identical on both sides (" + fmt(a.byKey.throughputUnitsPerHr) + " units/hr).");
    }
    // Order cycle time (lower is better).
    if (bothAvail("orderCycleTimeMin")) {
      const p = phrase("orderCycleTimeMin", "", "a shorter order cycle time", "min");
      if (p) points.push(p);
    }
    // Pick travel (lower is better) - the task's canonical unambiguous case.
    if (bothAvail("aClassTravelM")) {
      const p = phrase("aClassTravelM", "", "lower A-class pick travel", "m");
      if (p) points.push(p); else points.push("A-class pick travel is identical on both sides (" + fmt(a.byKey.aClassTravelM) + " m).");
    }
    // Compliance - fewer fails first, then fewer warns (both lower-is-better).
    if (bothAvail("complianceFail") && bothAvail("complianceWarn")) {
      const df = dByKey.complianceFail, dw = dByKey.complianceWarn;
      let better = null, why = "";
      if (df.better === "a" || df.better === "b") { better = df.better; why = "fewer compliance fails"; }
      else if (dw.better === "a" || dw.better === "b") { better = dw.better; why = "fewer compliance warnings"; }
      if (better) {
        points.push("Side " + sideWord(better) + " has " + why + " (A " +
          fmt(a.byKey.complianceFail) + " fail / " + fmt(a.byKey.complianceWarn) + " warn vs B " +
          fmt(b.byKey.complianceFail) + " fail / " + fmt(b.byKey.complianceWarn) + " warn).");
      } else {
        points.push("Compliance is level (both " + fmt(a.byKey.complianceFail) + " fail / " + fmt(a.byKey.complianceWarn) + " warn) - informed by standards, not a certification.");
      }
    }

    // NEUTRAL metrics that DIFFER -> honest "higher isn't always better" note
    // instead of a better/worse verdict.
    ROSTER.forEach((m) => {
      if (m.dir !== "neutral") return;
      if (!bothAvail(m.key)) return;
      const d = dByKey[m.key];
      if (!d || !d.available || d.absolute === 0) return;
      const av = a.byKey[m.key], bv = b.byKey[m.key];
      const higher = bv > av ? "B" : "A";
      notes.push(m.label + ": Side " + higher + " is higher (A " + fmt(av) + " vs B " + fmt(bv) + " " + m.unit + "). " + (m.note || "Direction is ambiguous - not scored better/worse."));
    });

    // Headline: the throughput verdict when there is one, else compliance.
    let headline = "Both sides are comparable on the metrics shown.";
    const dth = dByKey.throughputUnitsPerHr;
    if (dth && dth.available && (dth.better === "a" || dth.better === "b")) {
      headline = "Side " + sideWord(dth.better) + " has the higher modelled throughput.";
    } else if (dByKey.complianceFail && dByKey.complianceFail.better && dByKey.complianceFail.better !== "tie") {
      headline = "Side " + sideWord(dByKey.complianceFail.better) + " has fewer compliance fails.";
    }

    return { headline: headline, points: points, notes: notes };
  }

  // ------------------------------------------------------------------
  // compare(aLayout, bLayout, opts) -> { a, b, deltas, summary }.
  // Both sides go through metricsFor (i.e. WT.report.build), so they can
  // never drift from the app. Deltas are correct B-vs-A arithmetic with a
  // better/worse verdict ONLY on unambiguous metrics.
  // ------------------------------------------------------------------
  function compare(aLayout, bLayout, opts) {
    const o = opts || {};
    const a = metricsFor(aLayout, o.a || o);
    const b = metricsFor(bLayout, o.b || o);
    const deltas = ROSTER.map((m) => {
      const d = deltaFor(m, a.byKey[m.key], b.byKey[m.key]);
      return {
        key: m.key, label: m.label, unit: m.unit, section: m.section, dir: m.dir,
        a: a.byKey[m.key], b: b.byKey[m.key],
        absolute: d.absolute, pct: d.pct, better: d.better, available: d.available,
      };
    });
    const summary = buildSummary(a, b, deltas);
    return {
      compareVersion: COMPARE_VERSION,
      honesty: HONESTY,
      sections: SECTIONS.map((s) => ({ key: s.key, title: s.title })),
      a: a, b: b, deltas: deltas, summary: summary,
    };
  }

  // ------------------------------------------------------------------
  // sources(ctx) -> the selectable A/B sources. ctx (all optional):
  //   current   a layout snapshot for "current layout" (the app injects
  //             currentLayout()); omitted -> the current source is marked
  //             unavailable rather than dropped.
  //   examples  override the examples library (defaults to WT.examples).
  //   scenarios override the saved-scenarios list (defaults to WT.scenarios).
  // Each descriptor is { kind, id, name, group, ... , available }.
  // ------------------------------------------------------------------
  function sources(ctx) {
    const c = ctx || {};
    const out = [];
    out.push({
      kind: "current", id: "current", name: "Current layout", group: "Current",
      available: !!(c.current && Array.isArray(c.current.elements)),
    });
    const EX = c.examples || mod("examples");
    if (EX && Array.isArray(EX.library)) {
      EX.library.forEach((e) => {
        out.push({ kind: "example", id: e.id, name: e.name, industry: e.industry || null, group: "Example scenarios", available: true });
      });
    }
    const SC = c.scenarios || mod("scenarios");
    if (SC && typeof SC.list === "function") {
      let list = [];
      try { list = SC.list() || []; } catch (_) { list = []; }
      list.forEach((s) => {
        out.push({ kind: "saved", id: s.slug || s.name, name: s.name, group: "Saved scenarios", summary: s.summary || null, available: true });
      });
    }
    return out;
  }

  // ------------------------------------------------------------------
  // resolve(src, ctx) -> the layout snapshot for a source descriptor, via
  // the SAME builders the app uses (no bespoke apply path):
  //   current -> ctx.current
  //   example -> WT.examples.build(id) (shaped to a layout)
  //   saved   -> WT.scenarios.load(name)
  // Returns null when the source cannot be resolved.
  // ------------------------------------------------------------------
  function resolve(src, ctx) {
    const c = ctx || {};
    if (!src || !src.kind) return null;
    const D = mod("domain");
    const cell = (D && D.METRES_PER_CELL) || 1;
    if (src.kind === "current") {
      return c.current && Array.isArray(c.current.elements) ? c.current : null;
    }
    if (src.kind === "example") {
      const EX = c.examples || mod("examples");
      if (!EX || typeof EX.build !== "function") return null;
      let b;
      try { b = EX.build(src.id); } catch (_) { return null; }
      if (!b) return null;
      return {
        version: "wt-1", gridW: b.gridW, gridH: b.gridH, cell: cell,
        elements: b.elements, config: b.config, meta: b.meta,
      };
    }
    if (src.kind === "saved") {
      const SC = c.scenarios || mod("scenarios");
      if (!SC || typeof SC.load !== "function") return null;
      let snap;
      try { snap = SC.load(src.name != null ? src.name : src.id); } catch (_) { return null; }
      return snap && Array.isArray(snap.elements) ? snap : null;
    }
    return null;
  }

  WT.compare = {
    COMPARE_VERSION: COMPARE_VERSION,
    HONESTY: HONESTY,
    SECTIONS: SECTIONS,
    METRICS: METRICS,
    sources: sources,
    resolve: resolve,
    metricsFor: metricsFor,
    compare: compare,
  };
})();
