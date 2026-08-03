/* =====================================================================
 * Logistics Flow Studio - WarehouseTwin
 * orderpool.js - Live, visible ORDER POOL (v1.3)
 * ---------------------------------------------------------------------
 * A PURE, DETERMINISTIC, bounded order-pool model that makes the demand
 * side of the plant VISIBLE and LIVE. It mirrors the classic Siemens
 * Plant Simulation order-pool spine:
 *
 *   generateOrders  ->  DT_tempOrders (SizeOrderPool)  ->  M_selectOrders
 *      (arrivals)          (bounded backlog)              (release to flow)
 *                                                              -> consumed
 *
 * Orders are GENERATED over time into a bounded backlog (capped at a
 * SizeOrderPool-style limit), SELECTED / released out of the pool into the
 * picking flow at the line rate, and marked COMPLETED as the flow ships
 * them. The app drives this from the SAME rAF loop that steps WT.flowsim,
 * so the pool's "selected" aligns with MUs entering picking and its
 * "completed" aligns with MUs shipped. The user sees pool backlog, fill %,
 * generated / selected / completed counts, live in/out rates and a
 * starving / saturating flag updating while the animation plays.
 *
 * CONSERVATION (exact, every step, asserted in verify_orderpool.js):
 *   generated == inPool + inFlightSelected + completed + dropped
 * where inFlightSelected = selected - completed. Every generated order is
 * either accepted into the pool or (at the cap) HONESTLY counted as
 * dropped/backpressure - overflow is never hidden. Accepted orders flow
 * inPool -> selected(in-flight) -> completed.
 *
 * HONESTY (load-bearing, mirrored in the UI + README):
 *   - This is SYNTHETIC unless you import your own data. It is a
 *     TRANSPARENT BOUNDED-QUEUE HEURISTIC (a seeded arrival process + a
 *     selection rate tied to the documented WT.wms / WT.flowsim throughput
 *     model), NOT a real discrete-event-simulation / queueing engine, NOT a
 *     measurement of any real operation and NOT a certification.
 *   - Overflow at the cap is counted as `dropped` (backpressure) and pool
 *     starvation (empty pool while the picker wants work) is flagged - both
 *     reported, never hidden.
 *   - Order generation reuses the SKU-velocity-weighted generator from
 *     WT.wmsdata when present (a Zipf/Pareto heuristic ranked by SKU, not
 *     measured demand); it falls back to a simple seeded generator when the
 *     data layer is absent.
 *
 * Determinism: same (seed, cap, opts) + same (dtTicks, io) sequence ->
 * byte-identical counters and pool state. All randomness flows through a
 * seeded mulberry32-style PRNG carried inside the state; no Date, no
 * Math.random anywhere here.
 *
 * Classic script attaching to the global `WT` namespace (works from
 * file:// too). WT.wmsdata is an OPTIONAL dependency (graceful fallback).
 * No frameworks, no build step, fully offline, no deps.
 * ===================================================================== */
(function () {
  "use strict";
  const WT = (window.WT = window.WT || {});

  /* ------------------------------------------------------------------
   * Transparent teaching parameters. All synthetic; documented above.
   * ------------------------------------------------------------------ */
  const PARAMS = {
    defaultCap: 200, // SizeOrderPool-style backlog cap (bounded pool)
    hardMaxCap: 100000, // guard so a bad cap can't allocate absurd state
    ticksPerHour: 60, // matches WT.flowsim.PARAMS.ticksPerHour (units/hr -> per-tick)
    defaultSeed: 1234, // seeded arrival ripple (deterministic)
    arrivalNoiseLo: 0.7, // per-tick arrival ripple, same band as flowsim spawn noise...
    arrivalNoiseHi: 1.3, // ...upper bound (averages to 1.0)
    fallbackAvgUnitsPerOrder: 3.5, // avg lines/order when WT.wmsdata is absent (matches wms/flowsim default)
    streamSize: 256, // representative velocity-weighted order sample built once in create()
    sampleOrders: 6, // orders peeked for the UI readout
    maxTicksPerStep: 2000, // clamp one step() so a huge dt can't hang the loop
  };

  const SYNTHETIC_LABEL =
    "SYNTHETIC live order pool - a transparent bounded-queue HEURISTIC " +
    "(a seeded arrival process feeding a capped backlog, with selection tied " +
    "to the documented wms.js / flowsim.js throughput model), NOT a real " +
    "discrete-event-simulation / queueing engine, NOT a measurement of any " +
    "real operation and NOT a certification. Overflow at the pool cap is " +
    "counted as dropped (backpressure) and pool starvation is flagged - both " +
    "reported, never hidden. Order generation reuses the SKU-velocity-weighted " +
    "generator from wmsdata (a Zipf/Pareto heuristic, not measured demand) when " +
    "present and falls back to a simple seeded generator when it is not. " +
    "SYNTHETIC unless you import your own data.";

  /* ---- Seeded PRNG: mulberry32, functional form carrying the integer
   * state inside `state` so the whole model stays pure/deterministic. Same
   * family as flowsim.js / wmsdata.js. No Date, no Math.random. --------- */
  function nextRand(state) {
    let a = state.rngState | 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    state.rngState = a >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function clampInt(v, lo, hi, dflt) {
    let n = Math.round(Number(v));
    if (!isFinite(n)) n = dflt != null ? dflt : lo;
    return Math.max(lo, Math.min(hi, n));
  }
  function posNum(v, dflt) {
    const n = Number(v);
    return isFinite(n) && n >= 0 ? n : dflt;
  }

  /* ------------------------------------------------------------------
   * Build a representative, seeded ORDER STREAM used to (a) demonstrate +
   * reuse the SKU-velocity-weighted generation from WT.wmsdata, (b) compute
   * the pool's avgUnitsPerOrder (units of flow work each order represents),
   * and (c) provide a small SAMPLE for the UI. Pure; O(streamSize).
   *
   * When WT.wmsdata is present (and not disabled via opts.useWmsData=false):
   *   - if the user has IMPORTED/loaded a pool, sample its real orders;
   *   - else GENERATE one via WT.wmsdata.generateOrders (velocity-weighted).
   * Otherwise a simple seeded fallback generator is used.
   * ------------------------------------------------------------------ */
  function buildOrderStream(opts, seed) {
    const o = opts || {};
    const useWms = o.useWmsData !== false && WT.wmsdata && typeof WT.wmsdata.generateOrders === "function";
    const n = clampInt(o.streamSize != null ? o.streamSize : PARAMS.streamSize, 1, 20000, PARAMS.streamSize);

    if (useWms) {
      // Prefer the user's loaded pool (their own data), else a seeded,
      // velocity-weighted synthetic pool from the SKU master.
      let pool = null;
      try {
        if (typeof WT.wmsdata.isLoaded === "function" && WT.wmsdata.isLoaded() && WT.wmsdata.orderPool && WT.wmsdata.orderPool.length) {
          pool = WT.wmsdata.orderPool;
        } else {
          pool = WT.wmsdata.generateOrders({ nOrders: n, seed: seed, skuCount: o.skuCount, demandSkew: o.demandSkew });
        }
      } catch (_) { pool = null; }
      if (pool && pool.length) {
        const stream = pool.slice(0, n).map((ord) => ({
          orderId: ord.orderId,
          lines: (ord.lines || []).length,
          units: (ord.lines || []).reduce((a, l) => a + (Number(l.qty) || 1), 0),
        }));
        return { stream: stream, source: "wmsdata" };
      }
    }

    // Fallback: a simple seeded generator (no velocity weighting, no SKUs) -
    // just an order-size distribution so the pool still has a shape offline.
    const fb = { rngState: (seed ^ 0x0dec0de5) >>> 0 };
    const maxLines = clampInt(o.maxLines != null ? o.maxLines : 6, 1, 64, 6);
    const maxQty = clampInt(o.maxQtyPerLine != null ? o.maxQtyPerLine : 5, 1, 1000, 5);
    const stream = new Array(n);
    for (let i = 0; i < n; i++) {
      const lines = 1 + Math.floor(nextRand(fb) * maxLines);
      let units = 0;
      for (let l = 0; l < lines; l++) units += 1 + Math.floor(nextRand(fb) * maxQty);
      stream[i] = { orderId: "GEN-" + String(i + 1), lines: lines, units: units };
    }
    return { stream: stream, source: "fallback" };
  }

  function streamAvgUnits(stream) {
    if (!stream || !stream.length) return PARAMS.fallbackAvgUnitsPerOrder;
    let u = 0;
    for (const s of stream) u += Math.max(1, Number(s.units) || 1);
    return u / stream.length;
  }

  /* ------------------------------------------------------------------
   * create(opts) -> a fresh, deterministic pool state.
   *   opts:
   *     cap                - SizeOrderPool backlog cap (default PARAMS.defaultCap)
   *     seed               - PRNG seed for the arrival ripple
   *     ticksPerHour       - ticks that stand for one hour (default matches flowsim)
   *     useWmsData         - set false to force the fallback generator
   *     avgUnitsPerOrder   - override the flow-units-per-order conversion
   *     initialFill        - 0..1 fraction of the cap to pre-load as backlog
   *     streamSize/maxLines/maxQtyPerLine/skuCount/demandSkew - generation opts
   * ------------------------------------------------------------------ */
  function create(opts) {
    const o = opts || {};
    const cap = clampInt(o.cap, 1, PARAMS.hardMaxCap, PARAMS.defaultCap);
    const seed = (o.seed != null ? o.seed : PARAMS.defaultSeed) >>> 0;
    const ticksPerHour = Math.max(1, posNum(o.ticksPerHour, PARAMS.ticksPerHour));

    const built = buildOrderStream(o, seed);
    const avgUnitsPerOrder = o.avgUnitsPerOrder != null && Number(o.avgUnitsPerOrder) > 0
      ? Number(o.avgUnitsPerOrder)
      : Math.max(1, streamAvgUnits(built.stream));

    const state = {
      kind: "wt-orderpool-state",
      cap: cap,
      ticksPerHour: ticksPerHour,
      seed: seed,
      rngState: (seed ^ 0x51ed5eed) >>> 0,
      // fractional accumulators carried between ticks (determinism)
      genAccum: 0,
      selAccum: 0,
      compAccum: 0,
      tickAccum: 0,
      // conserved counters (orders)
      generated: 0, // every order the generator emitted (accepted OR dropped)
      inPool: 0, // backlog currently waiting (<= cap)
      selected: 0, // cumulative orders released into the flow
      completed: 0, // cumulative orders shipped (flow retired)
      dropped: 0, // cumulative overflow at the cap (backpressure)
      elapsedTicks: 0,
      // generation provenance + flow-units conversion
      generatorSource: built.source, // "wmsdata" | "fallback"
      avgUnitsPerOrder: avgUnitsPerOrder,
      orderStream: built.stream,
      sample: built.stream.slice(0, PARAMS.sampleOrders),
      // last-step rollup (rates + flags)
      last: emptyLast(),
      lastTargets: { arrivalsPerTick: 0, selectionsPerTick: 0, completionsPerTick: 0 },
      label: SYNTHETIC_LABEL,
    };

    // Optional starting backlog so the pool isn't empty on the very first
    // frame. Counts as generated + accepted (conservation preserved).
    const fill = Number(o.initialFill);
    if (isFinite(fill) && fill > 0) {
      const pre = clampInt(fill <= 1 ? fill * cap : fill, 0, cap, 0);
      state.generated += pre;
      state.inPool += pre;
    }
    return state;
  }

  function emptyLast() {
    return {
      ticks: 0,
      arrivals: 0, // generated this step
      accepted: 0, // entered the pool this step
      dropped: 0, // overflow this step
      selected: 0, // released this step
      completed: 0, // shipped this step
      wantSelect: 0, // selection demand this step (before availability)
      starvedTicks: 0, // ticks where selection demand exceeded supply
      saturatedTicks: 0, // ticks that ended at the cap
    };
  }

  /* ------------------------------------------------------------------
   * Advance exactly ONE tick (deterministic). io carries the per-tick
   * rates the app derives from the flow:
   *   arrivalsPerTick     - order generation (demand) into the pool
   *   selectionsPerTick   - release rate (tied to WT.wms / flow throughput)
   *   completionsPerTick  - ship rate (tied to the flow's retire); defaults
   *                         to selectionsPerTick (steady state) when absent
   * ------------------------------------------------------------------ */
  function advanceOneTick(state, io) {
    const arrivals = posNum(io.arrivalsPerTick, 0);
    const selections = posNum(io.selectionsPerTick, 0);
    const completions = io.completionsPerTick != null ? posNum(io.completionsPerTick, selections) : selections;

    // --- 1) Generate arrivals into the bounded pool -------------------
    const noise = PARAMS.arrivalNoiseLo + (PARAMS.arrivalNoiseHi - PARAMS.arrivalNoiseLo) * nextRand(state);
    state.genAccum += arrivals * noise;
    while (state.genAccum >= 1) {
      state.genAccum -= 1;
      state.generated += 1;
      state.last.arrivals += 1;
      if (state.inPool < state.cap) {
        state.inPool += 1;
        state.last.accepted += 1;
      } else {
        state.dropped += 1; // honest overflow / backpressure at the cap
        state.last.dropped += 1;
      }
    }

    // --- 2) Select / release orders out of the pool -------------------
    state.selAccum += selections;
    const wantSel = Math.floor(state.selAccum);
    state.selAccum -= wantSel; // unmet demand is NOT carried (an idle/starved picker)
    const takeSel = Math.min(wantSel, state.inPool);
    state.inPool -= takeSel;
    state.selected += takeSel;
    state.last.selected += takeSel;
    state.last.wantSelect += wantSel;
    if (wantSel > takeSel) state.last.starvedTicks += 1; // wanted more than the pool held

    // --- 3) Complete selected orders as the flow ships them -----------
    state.compAccum += completions;
    const wantComp = Math.floor(state.compAccum);
    state.compAccum -= wantComp;
    const inFlight = state.selected - state.completed;
    const takeComp = Math.min(wantComp, inFlight);
    state.completed += takeComp;
    state.last.completed += takeComp;

    if (state.inPool >= state.cap) state.last.saturatedTicks += 1;
    state.elapsedTicks += 1;
    state.last.ticks += 1;
  }

  /* ------------------------------------------------------------------
   * step(state, dtTicks, io) -> advances the pool by dtTicks (may be
   * fractional; whole ticks are applied, the remainder carries). Returns
   * the SAME (mutated) state for chaining. Deterministic given the same
   * (dtTicks, io) sequence. When the flow isn't playing the app simply
   * does not call step(), so the pool holds its last state.
   * ------------------------------------------------------------------ */
  function step(state, dtTicks, io) {
    if (!state || state.kind !== "wt-orderpool-state") return state;
    const inp = io || {};
    state.last = emptyLast();
    state.lastTargets = {
      arrivalsPerTick: posNum(inp.arrivalsPerTick, 0),
      selectionsPerTick: posNum(inp.selectionsPerTick, 0),
      completionsPerTick: inp.completionsPerTick != null ? posNum(inp.completionsPerTick, 0) : posNum(inp.selectionsPerTick, 0),
    };
    let dt = Number(dtTicks);
    if (!(dt > 0)) dt = 0;
    state.tickAccum += dt;
    let budget = PARAMS.maxTicksPerStep;
    while (state.tickAccum >= 1 && budget-- > 0) {
      advanceOneTick(state, inp);
      state.tickAccum -= 1;
    }
    return state;
  }

  /* ------------------------------------------------------------------
   * stats(state) -> live pool metrics for the UI + tests. Rates are the
   * realized averages SINCE START (stable + honest); the current target
   * in/out rates are also carried. Flags starving (empty pool while the
   * picker wants work) and saturating (backlog at the cap) honestly.
   * ------------------------------------------------------------------ */
  function stats(state) {
    if (!state || state.kind !== "wt-orderpool-state") return null;
    const cap = state.cap;
    const inPool = state.inPool;
    const inFlightSelected = state.selected - state.completed;
    const accepted = state.generated - state.dropped;
    const elapsedHours = state.elapsedTicks / state.ticksPerHour;
    const perHr = (n) => (elapsedHours > 0 ? n / elapsedHours : 0);

    const conserved = state.generated === inPool + inFlightSelected + state.completed + state.dropped;
    const starving = inPool <= 0 && state.lastTargets.selectionsPerTick > 0;
    // At (or effectively at) the cap: full now, OR overflow was counted in the
    // last step (actively dropping) - so a single release on the final tick
    // does not mask a saturated/overflowing pool. Mutually exclusive with
    // starving (an empty pool cannot be dropping).
    const saturating = inPool >= cap || state.last.dropped > 0;

    return {
      // backlog + fill
      cap: cap,
      backlog: inPool,
      inPool: inPool,
      fillPct: cap > 0 ? (inPool / cap) * 100 : 0,
      // conserved counters (orders)
      generated: state.generated,
      accepted: accepted,
      selected: state.selected,
      completed: state.completed,
      dropped: state.dropped,
      inFlightSelected: inFlightSelected,
      // realized average rates (orders / hr) since start
      generatedPerHr: perHr(state.generated),
      acceptedPerHr: perHr(accepted),
      selectedPerHr: perHr(state.selected),
      completedPerHr: perHr(state.completed),
      droppedPerHr: perHr(state.dropped),
      inRatePerHr: perHr(accepted), // orders entering the pool
      outRatePerHr: perHr(state.selected), // orders leaving the pool (released)
      // current target rates (orders / hr) the app is driving
      arrivalTargetPerHr: state.lastTargets.arrivalsPerTick * state.ticksPerHour,
      selectionTargetPerHr: state.lastTargets.selectionsPerTick * state.ticksPerHour,
      // flags (honest)
      starving: starving,
      saturating: saturating,
      conserved: conserved,
      // provenance / honesty
      generatorSource: state.generatorSource,
      avgUnitsPerOrder: state.avgUnitsPerOrder,
      elapsedTicks: state.elapsedTicks,
      elapsedHours: elapsedHours,
      sample: state.sample,
      label: SYNTHETIC_LABEL,
    };
  }

  // Explicit conservation predicate (used by the app + tests).
  function conserved(state) {
    if (!state || state.kind !== "wt-orderpool-state") return false;
    const inFlightSelected = state.selected - state.completed;
    return state.generated === state.inPool + inFlightSelected + state.completed + state.dropped;
  }

  WT.orderpool = {
    create: create,
    step: step,
    stats: stats,
    conserved: conserved,
    PARAMS: PARAMS,
    SYNTHETIC_LABEL: SYNTHETIC_LABEL,
  };
})();
