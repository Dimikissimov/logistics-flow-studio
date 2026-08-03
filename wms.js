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
    autoBoostPerLane: 0.15, // each automation lane (conveyor/rgv/agv/asrs/shuttle) lifts a stage's rate
    autoFactorMax: 2.5, // cap the automation multiplier so it stays sane
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

  // Automation multiplier shared by the stages it applies to.
  function autoFactor(stats) {
    return Math.min(PARAMS.autoFactorMax, 1 + PARAMS.autoBoostPerLane * stats.automationIndex);
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
    const af = autoFactor(stats);

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
    const receiving = Math.max(1, stats.dockIn) * P.receiveUnitsPerDockHr * af *
      (stats.inboundConnected ? P.chainReceiveBonus : 1);

    const putawayTeams = 1 + Math.floor(stats.stagingAreaM2 / P.stagingM2PerTeam);
    const putaway = P.putawayTeamUnitsHr * putawayTeams * af *
      (stats.inboundConnected ? P.chainPutawayBonus : 1);

    const storage = (P.storageBaseUnitsHr + stats.positions * P.storageRatePerPosition) * af;

    const replenishment = P.replenTeamUnitsHr * (1 + P.replenPerPickFace * stats.pickFaces) * af;

    const packing = Math.max(1, stats.packStations) * P.packUnitsPerStationHr * af;

    const shipping = Math.max(1, stats.dockOut) * P.shipUnitsPerDockHr * af;

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
  };
})();
