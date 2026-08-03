/* =====================================================================
 * Logistics Flow Studio - WarehouseTwin
 * wms.js - WMS core operations layer (P2)
 * ---------------------------------------------------------------------
 * Models the STANDARD warehouse workflow as a chain of processing
 * stages and simulates a synthetic order/item stream flowing through
 * them over the CURRENT layout:
 *
 *   receiving -> put-away -> (storage) -> replenishment ->
 *   order-picking -> packing -> shipping
 *
 * Each stage has a THROUGHPUT (units/hr) derived transparently from the
 * layout (dock count, staging area, pick-face systems, pick-path length
 * via the existing pick-travel sim, automation lanes rgv/agv/conveyor).
 * A DETERMINISTIC (seeded, never wall-clock) discrete flow pushes units
 * tick-by-tick through the tandem line: when a stage's arrivals exceed
 * its capacity a backlog forms, and the slowest stage is the bottleneck.
 *
 * HONESTY (load-bearing, mirrored in the UI + README):
 *   - EVERYTHING here is SYNTHETIC and SIMPLIFIED. The per-stage rate
 *     constants (PARAMS) are transparent order-of-magnitude TEACHING
 *     values, NOT vendor specs and NOT measured from any real site.
 *   - The throughput model is a documented HEURISTIC, stated as such.
 *   - The KPIs are "grounded in ISO 22400 / standard warehouse practice"
 *     (see WMS_STANDARDS_CORPUS.md section 4) - the app mirrors the ISO
 *     22400 DISCIPLINE (formula + elements + unit + time behaviour). It
 *     is NOT a certification and NOT a measurement of a real operation.
 *   - The order-picking stage REUSES the existing seeded pick-travel
 *     simulation (WT.sim.run) rather than duplicating pick logic, so its
 *     productivity is exactly the sim's - same seed -> identical result.
 *
 * Determinism: same layout + seed + orders -> byte-identical result and
 * KPIs. All randomness flows through mulberry32(seed); no Date, no
 * Math.random. Verified in verify_wms.js.
 *
 * Classic script attaching to the global `WT` namespace so it works from
 * file:// too. Depends on domain.js (WT.domain) and simulation.js
 * (WT.sim). No frameworks, no build step, fully offline.
 * ===================================================================== */
(function () {
  "use strict";
  const WT = (window.WT = window.WT || {});
  const D = WT.domain;

  /* ------------------------------------------------------------------
   * Seeded PRNG (mulberry32) - same generator the sim uses so the whole
   * app shares ONE deterministic randomness discipline.
   * ------------------------------------------------------------------ */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ------------------------------------------------------------------
   * SYNTHETIC rate constants (units/hr per resource, and structural
   * factors). All order-of-magnitude TEACHING values - NOT vendor specs,
   * NOT measured. A "unit" here is one handling unit == one pick line
   * (documented simplification: 1 line = 1 unit).
   * ------------------------------------------------------------------ */
  const PARAMS = {
    // Flow granularity.
    ticksPerHour: 4, // 15-minute buckets for the discrete flow series
    unitsPerLine: 1, // 1 pick line == 1 handling unit (simplification)

    // Per-resource base throughputs (units/hr). Synthetic teaching values.
    receiveUnitsPerDockHr: 45, // a receiving team unloading/checking at one inbound dock
    shipUnitsPerDockHr: 50, // a loading team staging/loading at one outbound dock
    putawayTeamUnitsHr: 28, // one put-away resource moving units into storage
    replenTeamUnitsHr: 30, // one replenishment resource topping up pick faces
    packUnitsPerStationHr: 40, // one pack bench consolidating/packing units
    storageBaseUnitsHr: 60, // storage is a BUFFER, not a rate bottleneck: generous internal move rate
    storageRatePerPosition: 0.15, // + per pallet position (a bigger store moves more internally)

    // Structural scaling factors (dimensionless).
    // autoBoostPerLane: DEPRECATED (P6). The old flat "+0.15 per lane"
    // magic multiplier is superseded by the per-system automation model
    // below (automationBoost) which derives each stage's lift from the
    // modeled throughput of the automation systems that SERVE it. Kept
    // only so the params echo in runOperations stays stable.
    autoBoostPerLane: 0.15,
    autoFactorMax: 2.5, // cap on ANY single stage's automation multiplier (stays sane)
    // P6 automation model: reference automation throughput (units/hr) that
    // corresponds to a "+1.0" (full doubling) lift to a stage's manual
    // rate. Calibrated so ONE conveyor segment at its seed rate (180 u/hr,
    // domain/KB) lifts a served stage by +0.15 - matching the previous
    // flat per-lane boost - while every automation TYPE now contributes in
    // proportion to its OWN modeled throughput (read from WT.kb "auto.*")
    // instead of a flat +0.15. Transparent, editable, explainable.
    autoRefUnitsPerHr: 1200,
    stagingM2PerTeam: 12, // every ~12 m^2 of staging buffer supports one more parallel put-away team
    chainReceiveBonus: 1.2, // receiving chained to storage flows put-away straight off the dock
    chainPutawayBonus: 1.3, // an inbound conveyor/staging chain speeds put-away
    replenPerPickFace: 0.6, // each pick-face system adds this fraction to replenishment capacity

    // Nominal per-stage handling latency (minutes) - the synthetic floor
    // a unit needs to be physically handled through ONE stage even with
    // zero queue. Cycle/dock-to-stock KPIs add this to the Little's-Law
    // queue wait so they are never a bare 0 and stay layout-sensitive
    // through the queue term. Synthetic teaching value.
    stageHandleMin: 4,

    // Order-stream shape (synthetic; used when the caller gives no orders).
    defaultOrders: 300,
    defaultHours: 8, // one working shift
    linesPerOrderMax: 6, // avg lines/order = (1+max)/2 = 3.5 (matches the sim default)
    arrivalNoiseLo: 0.7, // seeded per-tick arrival multiplier lower bound...
    arrivalNoiseHi: 1.3, // ...and upper bound (deterministic demand ripple)
  };

  /* ------------------------------------------------------------------
   * THE 7 STANDARD WORKFLOW STAGES, in order. This IS the WMS core
   * process chain. Each entry documents its role and the honest,
   * layout-driven assumption behind its throughput.
   * ------------------------------------------------------------------ */
  const STAGES = [
    {
      id: "receiving", label: "Receiving", role: "inbound",
      note: "Goods arrive at inbound docks and are checked in. Throughput scales with the number of dock-in doors x a synthetic per-dock rate, lifted by automation and a storage chain.",
    },
    {
      id: "put-away", label: "Put-away", role: "inbound",
      note: "Received units are moved to storage locations. Throughput scales with parallel put-away teams (from staging-buffer area), automation lanes, and an inbound conveyor/staging chain.",
    },
    {
      id: "storage", label: "Storage (buffer)", role: "buffer",
      note: "Reserve holding. A BUFFER, rarely the rate bottleneck: a generous internal move rate that grows with pallet positions and automation. Its meaningful KPI is storage utilisation (fill %).",
    },
    {
      id: "replenishment", label: "Replenishment", role: "internal",
      note: "Reserve stock tops up the pick faces. Throughput scales with the number of pick-face systems (carton/pallet-flow, mezzanine, goods-to-person) and automation lanes.",
    },
    {
      id: "order-picking", label: "Order picking", role: "outbound",
      note: "Pickers fulfil order lines. Throughput is taken DIRECTLY from the existing seeded pick-travel simulation (WT.sim.run) for this layout - travel + handling + strategy - not re-modelled here.",
    },
    {
      id: "packing", label: "Packing", role: "outbound",
      note: "Picked units are consolidated and packed. Throughput scales with the number of pack stations x a synthetic per-station rate, lifted by automation.",
    },
    {
      id: "shipping", label: "Shipping", role: "outbound",
      note: "Packed orders are staged and loaded at outbound docks. Throughput scales with the number of dock-out doors x a synthetic per-dock rate, lifted by automation.",
    },
  ];

  const SYNTHETIC_LABEL =
    "SYNTHETIC operations model - transparent teaching heuristic. Per-stage " +
    "throughputs are order-of-magnitude assumptions (see wms.js PARAMS), NOT " +
    "vendor specs and NOT measured from a real site. Grounded in ISO 22400 / " +
    "standard warehouse practice for the KPI discipline; NOT a certification.";

  /* ------------------------------------------------------------------
   * Layout stats used by the throughput heuristics. Pure function of the
   * element list (deterministic).
   * ------------------------------------------------------------------ */
  function layoutStats(layout) {
    const els = (layout && layout.elements) || [];
    const cell = (layout && layout.cell) || (D ? D.METRES_PER_CELL : 1);
    const countType = (t) => els.filter((e) => e.type === t).length;

    const dockIn = countType("dock-in");
    const dockOut = countType("dock-out");
    const packStations = countType("pack-station");
    const conveyor = countType("conveyor");
    const rgv = countType("rgv");
    const agv = countType("agv");
    const asrs = countType("asrs");
    const shuttle = countType("shuttle");

    let stagingAreaM2 = 0;
    for (const e of els) {
      if (e.type === "staging") stagingAreaM2 += e.w * e.d * cell * cell;
    }

    // Pick-face systems: dedicated pick faces (carton-flow, mezzanine),
    // gravity pallet-flow, plus goods-to-person systems that present
    // goods to the operator (AS/RS, shuttle).
    let pickFaces = 0;
    for (const e of els) {
      const def = (D && D.ELEMENTS[e.type]) || {};
      if (def.pickFace || def.goodsToPerson || e.type === "pallet-flow") pickFaces++;
    }

    // Total pallet positions contributed by storage elements.
    let positions = 0;
    if (D && typeof D.elementCapacity === "function") {
      for (const e of els) positions += D.elementCapacity(e);
    }

    // Automation index: any powered transport/handling lane lifts stages.
    const automationIndex = conveyor + rgv + agv + asrs + shuttle;

    // Material-flow chain connectivity (reused from domain.js).
    let chains = { inboundConnected: false, outboundConnected: false };
    if (D && typeof D.analyzeChains === "function") {
      try { chains = D.analyzeChains(els); } catch (_) { /* defensive */ }
    }

    return {
      dockIn, dockOut, packStations, conveyor, rgv, agv, asrs, shuttle,
      stagingAreaM2, pickFaces, positions, automationIndex,
      inboundConnected: !!chains.inboundConnected,
      outboundConnected: !!chains.outboundConnected,
    };
  }

  /* ------------------------------------------------------------------
   * P6 AUTOMATION MODEL - per-system throughput contributions.
   *
   * Instead of a single flat "+0.15 per lane" magic multiplier, each
   * automation SYSTEM contributes a modeled throughput (units/hr) from a
   * transparent cycle-time param, and that throughput LIFTS the WMS stages
   * the system serves. The per-unit rates are read FALLBACK-SAFE from the
   * editable KB (WT.kb "auto.*"), exactly like domain.elementCapacity reads
   * rack densities: when the KB is absent or untouched they reproduce the
   * domain seed (AS/RS & shuttle machine cycleSec; RGV/AGV/conveyor
   * movesPerHr/unitsPerHr) BYTE-IDENTICALLY, so behaviour is unchanged;
   * editing a value flows straight into the automation throughput and the
   * stage capacities. Pure, deterministic, offline.
   *
   * REGRESSION GUARANTEE: with NO automation elements every served-stage
   * total is 0, so every stage multiplier is exactly 1.0 - identical to the
   * pre-P6 behaviour (the old autoFactor was 1 when automationIndex == 0).
   * order-picking is intentionally NOT lifted here: its throughput comes
   * from the seeded pick-travel sim, where AS/RS & shuttle already act via
   * their goods-to-person cycleSec (no double counting).
   * ------------------------------------------------------------------ */
  // Which WMS stages each automation system type serves (honest heuristic
  // mapping; order-picking excluded - see above).
  const AUTO_SERVES = {
    asrs: ["storage", "replenishment"],
    shuttle: ["storage", "replenishment"],
    rgv: ["put-away", "replenishment", "shipping"],
    agv: ["put-away", "replenishment", "packing", "shipping"],
    conveyor: ["receiving", "put-away", "replenishment", "packing", "shipping"],
  };

  function kbGetNum(id) {
    const kb = WT.kb;
    if (kb && typeof kb.get === "function") {
      const v = kb.get(id);
      if (typeof v === "number" && isFinite(v) && v >= 0) return v;
    }
    return null;
  }
  function domainDef(type) { return (D && D.ELEMENTS && D.ELEMENTS[type]) || {}; }
  function domainCycleRate(type, dfltSec) {
    const def = domainDef(type);
    const sec = typeof def.cycleSec === "number" && def.cycleSec > 0 ? def.cycleSec : dfltSec;
    return Math.round(3600 / sec);
  }
  function domainFieldRate(type, field, dflt) {
    const def = domainDef(type);
    return typeof def[field] === "number" && def[field] >= 0 ? def[field] : dflt;
  }
  // Per-unit throughput (units/hr) for each automation system type. The KB
  // is the editable source of truth; the domain seed is the fallback.
  function autoUnitRates() {
    const kAsrs = kbGetNum("auto.asrs.cyclesPerHr");
    const kShut = kbGetNum("auto.shuttle.cyclesPerHr");
    const kRgv = kbGetNum("auto.rgv.movesPerHr");
    const kAgv = kbGetNum("auto.agv.movesPerHr");
    const kConv = kbGetNum("auto.conveyor.unitsPerHr");
    return {
      asrs: kAsrs != null ? kAsrs : domainCycleRate("asrs", 45),
      shuttle: kShut != null ? kShut : domainCycleRate("shuttle", 28),
      rgv: kRgv != null ? kRgv : domainFieldRate("rgv", "movesPerHr", 60),
      agv: kAgv != null ? kAgv : domainFieldRate("agv", "movesPerHr", 30),
      conveyor: kConv != null ? kConv : domainFieldRate("conveyor", "unitsPerHr", 180),
    };
  }

  // automationContributions(stats) -> per-system automation throughput
  // { rows:[{type,label,unit,count,perUnitUnitsPerHr,rateLabel,
  //          throughputUnitsPerHr,serves[]}], totalUnitsPerHr, ... }.
  // Pure function of the layout stats + the KB. This is the "throughput
  // per automation system" the report/panel and automation.js reuse.
  function automationContributions(stats) {
    const rates = autoUnitRates();
    const spec = [
      { type: "asrs", label: "AS/RS crane aisle", unit: "aisle", rateLabel: "cycles/hr", rate: rates.asrs, count: stats.asrs },
      { type: "shuttle", label: "Shuttle system", unit: "system", rateLabel: "cycles/hr", rate: rates.shuttle, count: stats.shuttle },
      { type: "rgv", label: "RGV transport lane", unit: "lane", rateLabel: "moves/hr", rate: rates.rgv, count: stats.rgv },
      { type: "agv", label: "AGV / AMR route", unit: "route", rateLabel: "moves/hr", rate: rates.agv, count: stats.agv },
      { type: "conveyor", label: "Conveyor segment", unit: "segment", rateLabel: "units/hr", rate: rates.conveyor, count: stats.conveyor },
    ];
    let total = 0;
    const rows = spec.map((s) => {
      const count = Math.max(0, s.count | 0);
      const perUnit = Math.max(0, Number(s.rate) || 0);
      const thr = count * perUnit;
      total += thr;
      return {
        type: s.type, label: s.label, unit: s.unit, count: count,
        perUnitUnitsPerHr: perUnit, rateLabel: s.rateLabel,
        throughputUnitsPerHr: thr, serves: (AUTO_SERVES[s.type] || []).slice(),
      };
    });
    return { rows: rows, totalUnitsPerHr: total, refUnitsPerHr: PARAMS.autoRefUnitsPerHr, maxFactor: PARAMS.autoFactorMax };
  }

  // automationBoost(stats) -> the per-stage automation multiplier map used
  // by stageModel. served[stage] = sum of the throughput of the systems
  // that serve that stage; mult[stage] = min(cap, 1 + served/ref). With no
  // automation elements every mult is exactly 1 (regression guarantee).
  const AUTOMATABLE_STAGES = ["receiving", "put-away", "storage", "replenishment", "packing", "shipping"];
  function automationBoost(stats) {
    const c = automationContributions(stats);
    const served = {};
    for (const st of AUTOMATABLE_STAGES) served[st] = 0;
    for (const r of c.rows) {
      for (const st of r.serves) if (st in served) served[st] += r.throughputUnitsPerHr;
    }
    const mult = {};
    for (const st of AUTOMATABLE_STAGES) {
      mult[st] = Math.min(PARAMS.autoFactorMax, 1 + served[st] / PARAMS.autoRefUnitsPerHr);
    }
    return { rows: c.rows, totalUnitsPerHr: c.totalUnitsPerHr, served: served, mult: mult, refUnitsPerHr: c.refUnitsPerHr, maxFactor: c.maxFactor };
  }

  // Back-compat scalar (aggregate) automation factor. No longer used to
  // scale stages (that is now per-stage via automationBoost) but kept as a
  // single headline number for callers/summaries. 1.0 when no automation.
  function autoFactor(stats) {
    const c = automationContributions(stats);
    return Math.min(PARAMS.autoFactorMax, 1 + c.totalUnitsPerHr / PARAMS.autoRefUnitsPerHr);
  }

  /* ------------------------------------------------------------------
   * Effective orders / units for the run.
   * ------------------------------------------------------------------ */
  function resolveRun(layout, opts) {
    const cfg = (layout && layout.config) || {};
    const o = opts || {};
    const orders = Math.max(1, Math.round(o.orders != null ? o.orders : (cfg.orders != null ? cfg.orders : PARAMS.defaultOrders)));
    const hours = Math.max(1, Math.round(o.hours != null ? o.hours : PARAMS.defaultHours));
    const seed = (o.seed != null ? o.seed : (cfg.seed != null ? cfg.seed : 42)) >>> 0;
    const linesMax = cfg.linesPerOrderMax || PARAMS.linesPerOrderMax;
    const avgLinesPerOrder = (1 + linesMax) / 2;
    const avgUnitsPerOrder = avgLinesPerOrder * PARAMS.unitsPerLine;
    return { orders, hours, seed, avgLinesPerOrder, avgUnitsPerOrder };
  }

  /* ------------------------------------------------------------------
   * Per-stage throughput capacities (units/hr) for a layout. Every line
   * is a transparent, documented heuristic. Also runs the existing sim
   * for the picking stage (reuse, not re-model).
   * Returns { stages:[{...}], sim, stats, run }.
   * ------------------------------------------------------------------ */
  function stageModel(layout, opts) {
    const run = resolveRun(layout, opts);
    const stats = layoutStats(layout);
    const P = PARAMS;
    // P6: per-stage automation multipliers derived from the modeled
    // throughput of the automation systems that SERVE each stage (read
    // fallback-safe from WT.kb "auto.*"). With no automation elements every
    // entry is exactly 1 - identical to the pre-P6 flat factor of 1.
    const autob = automationBoost(stats);
    const am = autob.mult; // stage id -> multiplier (>= 1)

    // --- order-picking: REUSE the seeded pick-travel simulation --------
    const cfg = (layout && layout.config) || {};
    const simCfg = {
      seed: run.seed,
      strategy: cfg.strategy || "abc",
      orders: run.orders,
      skuCount: cfg.skuCount || 120,
      linesPerOrderMax: cfg.linesPerOrderMax || P.linesPerOrderMax,
      pickers: cfg.pickers || 1,
      flowMode: cfg.flowMode || "pull",
      demandSkew: cfg.demandSkew,
    };
    let sim = null;
    if (WT.sim && typeof WT.sim.run === "function") {
      sim = WT.sim.run(
        { elements: (layout && layout.elements) || [], gridW: layout && layout.gridW, gridH: layout && layout.gridH, cell: layout && layout.cell },
        simCfg
      );
    }
    // Picking capacity in units/hr = sim orders/hr x units/order. If the
    // sim could not run (no storage), fall back to a nominal manual rate.
    const pickingOrdersPerHr = sim ? sim.throughputOrdersPerHour : 0;
    const pickingUnitsPerHr = pickingOrdersPerHr > 0 ? pickingOrdersPerHr * run.avgUnitsPerOrder : P.putawayTeamUnitsHr;

    // --- capacities (units/hr) ----------------------------------------
    // Each automatable stage is lifted by its OWN automation multiplier
    // am[stage] (from the systems that serve it), replacing the single flat
    // factor. order-picking is untouched (it comes from the sim).
    const receiving = Math.max(1, stats.dockIn) * P.receiveUnitsPerDockHr * am["receiving"] *
      (stats.inboundConnected ? P.chainReceiveBonus : 1);

    const putawayTeams = 1 + Math.floor(stats.stagingAreaM2 / P.stagingM2PerTeam);
    const putaway = P.putawayTeamUnitsHr * putawayTeams * am["put-away"] *
      (stats.inboundConnected ? P.chainPutawayBonus : 1);

    const storage = (P.storageBaseUnitsHr + stats.positions * P.storageRatePerPosition) * am["storage"];

    const replenishment = P.replenTeamUnitsHr * (1 + P.replenPerPickFace * stats.pickFaces) * am["replenishment"];

    const packing = Math.max(1, stats.packStations) * P.packUnitsPerStationHr * am["packing"];

    const shipping = Math.max(1, stats.dockOut) * P.shipUnitsPerDockHr * am["shipping"];

    const capByStage = {
      "receiving": receiving,
      "put-away": putaway,
      "storage": storage,
      "replenishment": replenishment,
      "order-picking": pickingUnitsPerHr,
      "packing": packing,
      "shipping": shipping,
    };

    const stages = STAGES.map((s) => ({
      id: s.id,
      label: s.label,
      role: s.role,
      note: s.note,
      capacityUnitsPerHr: Math.max(0, capByStage[s.id] || 0),
    }));

    return { stages, sim, stats, run };
  }

  /* ------------------------------------------------------------------
   * Deterministic per-tick arrival stream: distribute `units` total over
   * `ticks` buckets with a seeded ripple, summing EXACTLY to `units`.
   * Cumulative-rounding guarantees the exact total and non-negativity.
   * ------------------------------------------------------------------ */
  function arrivalStream(rng, units, ticks) {
    const w = new Array(ticks);
    let totalW = 0;
    for (let t = 0; t < ticks; t++) {
      w[t] = PARAMS.arrivalNoiseLo + (PARAMS.arrivalNoiseHi - PARAMS.arrivalNoiseLo) * rng();
      totalW += w[t];
    }
    const arrivals = new Array(ticks);
    let acc = 0;
    let placed = 0;
    for (let t = 0; t < ticks; t++) {
      acc += w[t];
      const upto = Math.round((units * acc) / totalW);
      arrivals[t] = upto - placed;
      placed = upto;
    }
    return arrivals;
  }

  /* ------------------------------------------------------------------
   * MAIN: runOperations(layout, {orders, seed, hours}) -> result
   *
   * Deterministic discrete flow of a synthetic order stream through the
   * 7 stages over the layout. Returns per-stage {processed, backlog,
   * utilisation} time series + totals, plus the raw material for kpis().
   * ------------------------------------------------------------------ */
  function runOperations(layout, opts) {
    const model = stageModel(layout, opts);
    const { stages, sim, stats, run } = model;
    const P = PARAMS;

    const ticksPerHour = P.ticksPerHour;
    const dt = 1 / ticksPerHour; // hours per tick
    const T = run.hours * ticksPerHour;

    const totalUnits = Math.round(run.orders * run.avgUnitsPerOrder);
    const rng = mulberry32((run.seed ^ 0x5f3759df) >>> 0); // one dedicated sub-stream
    const arrivals = arrivalStream(rng, totalUnits, T);

    const N = stages.length;
    const capTick = stages.map((s) => s.capacityUnitsPerHr * dt);

    // Per-stage series + running carry (backlog).
    const series = stages.map(() => ({ processed: new Array(T), backlog: new Array(T), utilisation: new Array(T) }));
    const carry = new Array(N).fill(0);
    const processedTotal = new Array(N).fill(0);
    const utilSum = new Array(N).fill(0);
    const maxBacklog = new Array(N).fill(0);
    // Cumulative WIP (backlog) samples for Little's-Law cycle times.
    let wipAllSum = 0; // mean total WIP across all stages
    let wipRecPutSum = 0; // mean WIP in receiving + put-away (dock-to-stock)

    let shippedTotal = 0;

    for (let t = 0; t < T; t++) {
      let inflow = arrivals[t]; // external arrivals enter receiving
      let wipAll = 0;
      let wipRecPut = 0;
      for (let i = 0; i < N; i++) {
        const avail = carry[i] + inflow;
        const cap = capTick[i];
        const proc = cap > 0 ? Math.min(avail, cap) : 0;
        carry[i] = avail - proc;

        series[i].processed[t] = proc;
        series[i].backlog[t] = carry[i];
        series[i].utilisation[t] = cap > 0 ? proc / cap : 0;

        processedTotal[i] += proc;
        utilSum[i] += series[i].utilisation[t];
        if (carry[i] > maxBacklog[i]) maxBacklog[i] = carry[i];

        wipAll += carry[i];
        if (i <= 1) wipRecPut += carry[i]; // receiving(0) + put-away(1)

        inflow = proc; // cascade downstream within the same tick
      }
      shippedTotal += inflow; // inflow now holds shipping's processed output
      wipAllSum += wipAll;
      wipRecPutSum += wipRecPut;
    }

    // Per-stage totals.
    const stageTotals = stages.map((s, i) => ({
      id: s.id,
      label: s.label,
      role: s.role,
      note: s.note,
      capacityUnitsPerHr: s.capacityUnitsPerHr,
      processed: processedTotal[i],
      finalBacklog: carry[i],
      maxBacklog: maxBacklog[i],
      avgUtilisation: T > 0 ? utilSum[i] / T : 0, // 0..1 (share of capacity used)
    }));

    // Bottleneck = the stage with the LOWEST throughput capacity (the one
    // that caps the whole line). Ties broken by the most backlog built up.
    let bottleneckIdx = 0;
    for (let i = 1; i < N; i++) {
      const a = stageTotals[i];
      const b = stageTotals[bottleneckIdx];
      if (a.capacityUnitsPerHr < b.capacityUnitsPerHr - 1e-9 ||
        (Math.abs(a.capacityUnitsPerHr - b.capacityUnitsPerHr) <= 1e-9 && a.maxBacklog > b.maxBacklog)) {
        bottleneckIdx = i;
      }
    }

    const avgWipAll = T > 0 ? wipAllSum / T : 0;
    const avgWipRecPut = T > 0 ? wipRecPutSum / T : 0;
    const remainingWip = carry.reduce((s, v) => s + v, 0);

    return {
      ok: !!(sim && sim.ok),
      dataLabel: SYNTHETIC_LABEL,
      seed: run.seed,
      hours: run.hours,
      ticksPerHour: ticksPerHour,
      orders: run.orders,
      avgLinesPerOrder: run.avgLinesPerOrder,
      avgUnitsPerOrder: run.avgUnitsPerOrder,
      totalUnits: totalUnits,
      shippedUnits: shippedTotal,
      remainingWip: remainingWip,
      stages: stageTotals,
      series: series, // per-stage {processed[], backlog[], utilisation[]}
      bottleneckIndex: bottleneckIdx,
      // aggregates for the KPI layer (Little's-Law inputs).
      avgWipAll: avgWipAll,
      avgWipRecPut: avgWipRecPut,
      // provenance of the picking stage (the reused sim).
      sim: sim ? {
        ok: sim.ok,
        throughputOrdersPerHour: sim.throughputOrdersPerHour,
        avgPickTravelM: sim.avgPickTravelM,
        storageFillPct: sim.storageFillPct,
        palletPositionsUsed: sim.palletPositionsUsed,
        palletPositionsTotal: sim.palletPositionsTotal,
        strategy: sim.strategy,
        flowMode: sim.flowMode,
      } : null,
      stats: stats,
      params: {
        ticksPerHour: P.ticksPerHour,
        receiveUnitsPerDockHr: P.receiveUnitsPerDockHr,
        shipUnitsPerDockHr: P.shipUnitsPerDockHr,
        packUnitsPerStationHr: P.packUnitsPerStationHr,
        autoBoostPerLane: P.autoBoostPerLane,
      },
    };
  }

  /* ------------------------------------------------------------------
   * kpis(result, layout) -> warehouse KPIs grounded in ISO 22400 /
   * standard practice. Each KPI carries its definition/source note (see
   * WMS_STANDARDS_CORPUS.md section 4). All data SYNTHETIC.
   * ------------------------------------------------------------------ */
  function kpis(result, layout) {
    const r = result || runOperations(layout, {});
    const hours = r.hours || 1;

    // Throughput (rate): units shipped / time period. ISO 22400
    // throughput-rate analogue.
    const throughputUnitsPerHr = r.shippedUnits / hours;
    const ordersShipped = r.avgUnitsPerOrder > 0 ? r.shippedUnits / r.avgUnitsPerOrder : 0;
    const throughputOrdersPerHr = ordersShipped / hours;

    // Order cycle / lead time: time an order spends in the system.
    // = nominal handling latency (one stageHandleMin per stage traversed)
    //   + Little's-Law queue wait (mean WIP / throughput). Reported in min.
    const queueAllMin = throughputUnitsPerHr > 0 ? (r.avgWipAll / throughputUnitsPerHr) * 60 : 0;
    const orderCycleTimeMin = STAGES.length * PARAMS.stageHandleMin + queueAllMin;

    // Dock-to-stock time: from arrival at the dock to stored/ready. Covers
    // the receiving + put-away stages: their nominal handling latency plus
    // the Little's-Law queue wait over their WIP. Reported in minutes.
    const queueRecPutMin = throughputUnitsPerHr > 0 ? (r.avgWipRecPut / throughputUnitsPerHr) * 60 : 0;
    const dockToStockMin = 2 * PARAMS.stageHandleMin + queueRecPutMin;

    // Picking productivity: order lines picked per picking labour hour.
    // Taken from the reused pick-travel sim (orders/hr x avg lines/order).
    const pickingLinesPerHr = r.sim ? r.sim.throughputOrdersPerHour * r.avgLinesPerOrder : 0;

    // Storage utilisation: occupied positions / total usable positions.
    const storageUtilPct = r.sim ? r.sim.storageFillPct : 0;

    // Bottleneck stage (lowest-capacity stage from the flow).
    const bIdx = r.bottleneckIndex || 0;
    const bStage = r.stages[bIdx];
    const bottleneck = {
      index: bIdx,
      id: bStage.id,
      label: bStage.label,
      capacityUnitsPerHr: bStage.capacityUnitsPerHr,
      avgUtilisation: bStage.avgUtilisation,
      maxBacklog: bStage.maxBacklog,
      plain:
        bStage.label + " is the bottleneck: it has the lowest throughput (" +
        bStage.capacityUnitsPerHr.toFixed(0) + " units/hr) of the seven stages, so it caps the line" +
        (bStage.maxBacklog > 0.5 ? " and backs up to " + bStage.maxBacklog.toFixed(0) + " units." : "."),
    };

    return {
      dataLabel: SYNTHETIC_LABEL,
      kpis: [
        {
          id: "throughput", label: "Throughput", value: throughputUnitsPerHr, unit: "units / hr",
          extra: { ordersPerHr: throughputOrdersPerHr },
          source: "ISO 22400 throughput-rate analogue - units handled / time period (WMS_STANDARDS_CORPUS.md section 4, [PS]/ISO 22400).",
        },
        {
          id: "orderCycleTime", label: "Order cycle time", value: orderCycleTimeMin, unit: "min",
          source: "Order cycle / lead time = (ship time) - (order receipt time); estimated here as nominal per-stage handling latency + Little's-Law queue wait (mean WIP / throughput). Operations source [PS].",
        },
        {
          id: "dockToStock", label: "Dock-to-stock time", value: dockToStockMin, unit: "min",
          source: "Dock-to-stock = (time ready for picking) - (arrival at dock); estimated as receiving + put-away handling latency + Little's-Law queue wait over their WIP. Operations source [PS].",
        },
        {
          id: "pickingProductivity", label: "Picking productivity", value: pickingLinesPerHr, unit: "lines / hr",
          source: "Lines picked / picking labour hours - from the reused seeded pick-travel sim. Operations source [PS].",
        },
        {
          id: "storageUtilisation", label: "Storage utilisation", value: storageUtilPct, unit: "%",
          source: "Space / storage utilisation = (occupied positions / total usable positions) x 100. Operations source [PS].",
        },
      ],
      bottleneck: bottleneck,
      // Convenience scalars (also carried inside the kpis[] list above).
      throughputUnitsPerHr: throughputUnitsPerHr,
      throughputOrdersPerHr: throughputOrdersPerHr,
      orderCycleTimeMin: orderCycleTimeMin,
      dockToStockMin: dockToStockMin,
      pickingLinesPerHr: pickingLinesPerHr,
      storageUtilPct: storageUtilPct,
    };
  }

  /* ------------------------------------------------------------------
   * capacities(layout, opts) -> the per-stage throughput capacities
   * (units/hr). Exposed so the UI and the test harness can inspect the
   * heuristic directly (e.g. the "more docks/automation -> higher
   * throughput" monotonic sanity check).
   * ------------------------------------------------------------------ */
  function capacities(layout, opts) {
    return stageModel(layout, opts).stages;
  }

  WT.wms = {
    STAGES: STAGES,
    PARAMS: PARAMS,
    SYNTHETIC_LABEL: SYNTHETIC_LABEL,
    runOperations: runOperations,
    kpis: kpis,
    capacities: capacities,
    layoutStats: layoutStats,
    mulberry32: mulberry32,
    // P6 automation model (the single source of truth for the per-system
    // automation throughput math; WT.automation reuses these).
    AUTO_SERVES: AUTO_SERVES,
    autoUnitRates: autoUnitRates,
    automationContributions: automationContributions,
    automationBoost: automationBoost,
    autoFactor: autoFactor,
  };
})();
