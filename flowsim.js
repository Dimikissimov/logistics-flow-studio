/* =====================================================================
 * Logistics Flow Studio - WarehouseTwin
 * flowsim.js - Live material-flow animation model (P3)
 * ---------------------------------------------------------------------
 * A DETERMINISTIC, seeded animated material-flow model over the CURRENT
 * layout. Boxes / handling units ("MUs") spawn at receiving, travel
 * through the warehouse and retire at shipping, so the app can render a
 * lightweight "live plant" view of goods moving over time.
 *
 * The visible path is the standard flow spine:
 *
 *   receiving -> storage -> picking -> packing -> shipping
 *
 * Each stage's waypoint is a WORLD-CELL centroid derived from the layout
 * (dock-in doors, storage racking, pick faces, pack stations, dock-out
 * doors). Where the layout has a conveyor / RGV / AGV spine, one extra
 * waypoint at its centroid is inserted between storage and picking so the
 * boxes appear to ride the automation. MUs move along STRAIGHT segments
 * between consecutive waypoints - this is transparent waypoint routing,
 * NOT pathfinding and NOT collision-aware.
 *
 * Rates are tied to the WMS operations layer (WT.wms): the spawn rate and
 * the whole-line completion rate follow the layout's bottleneck stage
 * capacity (WT.wms.capacities -> the lowest units/hr), and the travel
 * speed is lifted by an automation factor. So "more docks / more
 * automation" visibly speeds the flow, mirroring the wms heuristic.
 *
 * HONESTY (load-bearing, mirrored in the UI + README):
 *   - EVERYTHING here is SYNTHETIC. This is a transparent teaching
 *     ANIMATION, NOT a real discrete-event-simulation (DES) engine, NOT a
 *     measurement of any real operation and NOT a certification.
 *   - Routing is straight-segment waypoint routing between zone centroids
 *     (optionally via a conveyor centroid). There is no queueing model,
 *     no congestion, no real pathfinding and no obstacle avoidance.
 *   - Throughput / speed come from the documented wms.js heuristic
 *     (PARAMS there are order-of-magnitude assumptions), not vendor specs.
 *
 * Determinism: same (layout, seed, ticks) -> byte-identical MU positions
 * and counters. All randomness flows through a seeded mulberry32-style
 * PRNG carried inside the state; no Date, no Math.random. Verified in
 * verify_flowsim.js.
 *
 * Conserves units: at every step  spawned == in-flight + completed.
 *
 * Classic script attaching to the global `WT` namespace (works from
 * file:// too). Depends on domain.js (WT.domain) and wms.js (WT.wms).
 * No frameworks, no build step, fully offline.
 * ===================================================================== */
(function () {
  "use strict";
  const WT = (window.WT = window.WT || {});
  const D = WT.domain;

  /* ------------------------------------------------------------------
   * The 5 visible flow stages, in order. These are the zone keys the
   * generator/examples already use, so the animation lines up with the
   * layout's functional zones. MU colours (in the app) key off these.
   * ------------------------------------------------------------------ */
  const STAGES = ["receiving", "storage", "picking", "packing", "shipping"];

  const SYNTHETIC_LABEL =
    "SYNTHETIC live material-flow ANIMATION - a transparent teaching model, " +
    "NOT a real discrete-event-simulation engine, NOT a measurement and NOT a " +
    "certification. Straight-segment waypoint routing between zone centroids; " +
    "spawn/completion rate and travel speed follow the documented wms.js " +
    "throughput heuristic (order-of-magnitude assumptions, not vendor specs).";

  /* ------------------------------------------------------------------
   * SYNTHETIC animation parameters. All transparent teaching values.
   * ------------------------------------------------------------------ */
  const PARAMS = {
    ticksPerHour: 60, // sim ticks that stand for one hour (maps wms units/hr -> units/tick)
    cellsPerTick: 0.35, // base MU travel speed (world cells per tick) before automation lift
    autoBoostPerLane: 0.12, // each automation lane speeds internal flow (mirrors the wms idea)
    autoFactorMax: 2.2, // cap the automation speed multiplier so it stays sane
    jitterCells: 0.55, // lateral spread so many boxes don't stack on one centreline
    spawnNoiseLo: 0.7, // seeded per-tick arrival ripple (same band as wms arrivals)...
    spawnNoiseHi: 1.3, // ...upper bound
    shipDwellTicks: 8, // a unit lingers at the outbound dock (being loaded) before retiring
    defaultOrders: 300, // order pool when the caller gives none
    linesPerOrderMax: 6, // avg lines/order = 3.5 -> units/order (matches sim/wms defaults)
    minLineThroughput: 8, // floor so a sparse layout still animates (units/hr)
    maxInFlight: 600, // soft cap on live MUs (perf guard; never breaks conservation)
    maxTicksPerStep: 600, // clamp one step() so a huge dt can't hang the loop
    boundMargin: 0.15, // keep drawn MUs this far inside the floor edge (cells)
  };

  /* ------------------------------------------------------------------
   * Seeded PRNG (mulberry32), functional form: takes and returns the
   * integer state so the whole sim stays pure/deterministic given state.
   * ------------------------------------------------------------------ */
  function nextRand(s) {
    let a = s.rngState | 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    s.rngState = a >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /* ------------------------------------------------------------------
   * Layout geometry helpers (pure). All in WORLD CELLS.
   * ------------------------------------------------------------------ */
  function centroidOf(els, pred) {
    let sx = 0, sy = 0, n = 0;
    for (const e of els) {
      if (!pred(e)) continue;
      sx += e.x + e.w / 2;
      sy += e.y + e.d / 2;
      n++;
    }
    return n ? { x: sx / n, y: sy / n } : null;
  }

  function isStorage(e) {
    const def = (D && D.ELEMENTS[e.type]) || {};
    return def.category === "storage";
  }
  function isPickFace(e) {
    const def = (D && D.ELEMENTS[e.type]) || {};
    return !!def.pickFace || !!def.goodsToPerson || e.type === "pallet-flow";
  }
  function isTransport(e) {
    return e.type === "conveyor" || e.type === "rgv" || e.type === "agv" || e.type === "track";
  }

  // Zone-rect centre from layout.meta.zones (generator/examples metadata),
  // used only as a secondary fallback when a stage has no elements.
  function zoneCentre(layout, key) {
    const zs = layout && layout.meta && layout.meta.zones;
    if (!Array.isArray(zs)) return null;
    const z = zs.find((q) => q.key === key);
    return z ? { x: z.x + z.w / 2, y: z.y + z.d / 2 } : null;
  }

  function clampPt(p, gridW, gridH) {
    const m = PARAMS.boundMargin;
    return {
      x: Math.max(m, Math.min(gridW - m, p.x)),
      y: Math.max(m, Math.min(gridH - m, p.y)),
    };
  }

  /* ------------------------------------------------------------------
   * Build the ordered waypoint list (world cells) for a layout. Each
   * waypoint carries the flow STAGE a unit is performing while it travels
   * away from that waypoint. Straight segments connect them.
   * ------------------------------------------------------------------ */
  function buildWaypoints(layout) {
    const els = (layout && layout.elements) || [];
    const gridW = Math.max(1, (layout && layout.gridW) || 40);
    const gridH = Math.max(1, (layout && layout.gridH) || 24);
    const centre = { x: gridW / 2, y: gridH / 2 };

    const receiving =
      centroidOf(els, (e) => e.type === "dock-in") ||
      zoneCentre(layout, "receiving") ||
      { x: gridW / 2, y: 1 };
    const storage =
      centroidOf(els, isStorage) ||
      zoneCentre(layout, "storage") ||
      { x: gridW / 2, y: gridH * 0.4 };
    const packing =
      centroidOf(els, (e) => e.type === "pack-station") ||
      zoneCentre(layout, "packing") ||
      { x: gridW / 2, y: gridH - 4 };
    const shipping =
      centroidOf(els, (e) => e.type === "dock-out") ||
      zoneCentre(layout, "shipping") ||
      centroidOf(els, (e) => e.type === "dock-in") ||
      { x: gridW / 2, y: gridH - 1 };
    // Picking: pick faces if any, else the picking zone, else the mid
    // point between storage and packing (keeps the flow monotonic-ish).
    const picking =
      centroidOf(els, isPickFace) ||
      zoneCentre(layout, "picking") ||
      { x: (storage.x + packing.x) / 2, y: (storage.y + packing.y) / 2 };

    const wp = [
      { x: receiving.x, y: receiving.y, stage: "receiving" },
      { x: storage.x, y: storage.y, stage: "storage" },
    ];
    // Optional automation spine waypoint (conveyor / RGV / AGV centroid).
    const transport = centroidOf(els, isTransport);
    if (transport) wp.push({ x: transport.x, y: transport.y, stage: "storage" });
    wp.push({ x: picking.x, y: picking.y, stage: "picking" });
    wp.push({ x: packing.x, y: packing.y, stage: "packing" });
    wp.push({ x: shipping.x, y: shipping.y, stage: "shipping" });

    // Clamp every waypoint inside the floor so MUs can never render off it.
    return wp.map((p) => {
      const c = clampPt(p, gridW, gridH);
      return { x: c.x, y: c.y, stage: p.stage };
    });
  }

  /* ------------------------------------------------------------------
   * Layout throughput / automation, taken from the WMS heuristic so the
   * animation stays consistent with the operations layer.
   * ------------------------------------------------------------------ */
  function throughputOf(layout, seed) {
    let caps = null;
    if (WT.wms && typeof WT.wms.capacities === "function") {
      try { caps = WT.wms.capacities(layout, { seed: seed }); } catch (_) { caps = null; }
    }
    const capByStage = {};
    let minCap = Infinity;
    if (caps && caps.length) {
      for (const c of caps) {
        const v = Number(c.capacityUnitsPerHr) || 0;
        capByStage[c.id] = v;
        if (v > 0 && v < minCap) minCap = v;
      }
    }
    if (!isFinite(minCap) || minCap <= 0) minCap = PARAMS.minLineThroughput;
    const lineThroughput = Math.max(PARAMS.minLineThroughput, minCap);

    const els = (layout && layout.elements) || [];
    let automationIndex = 0;
    for (const e of els) {
      if (e.type === "conveyor" || e.type === "rgv" || e.type === "agv" || e.type === "asrs" || e.type === "shuttle") automationIndex++;
    }
    const autoFactor = Math.min(PARAMS.autoFactorMax, 1 + PARAMS.autoBoostPerLane * automationIndex);
    return { caps: caps, capByStage: capByStage, lineThroughput: lineThroughput, automationIndex: automationIndex, autoFactor: autoFactor };
  }

  /* ------------------------------------------------------------------
   * spawnPlan(layout, opts) -> a PURE plan (waypoints + rates + pool).
   * Deterministic function of (layout, seed). No live MUs.
   * ------------------------------------------------------------------ */
  function spawnPlan(layout, opts) {
    const o = opts || {};
    const cfg = (layout && layout.config) || {};
    const seed = (o.seed != null ? o.seed : (cfg.seed != null ? cfg.seed : 42)) >>> 0;
    const gridW = Math.max(1, (layout && layout.gridW) || 40);
    const gridH = Math.max(1, (layout && layout.gridH) || 24);

    const waypoints = buildWaypoints(layout);
    const tp = throughputOf(layout, seed);

    const orders = Math.max(1, Math.round(o.orders != null ? o.orders : PARAMS.defaultOrders));
    const avgUnits = (1 + (o.linesPerOrderMax || cfg.linesPerOrderMax || PARAMS.linesPerOrderMax)) / 2;
    const totalUnits = Math.max(1, Math.round(o.units != null ? o.units : orders * avgUnits));
    const loop = o.loop != null ? !!o.loop : true;

    return {
      kind: "wt-flowsim-plan",
      seed: seed,
      gridW: gridW,
      gridH: gridH,
      waypoints: waypoints,
      caps: tp.caps,
      capByStage: tp.capByStage,
      lineThroughput: tp.lineThroughput, // units/hr (the bottleneck; drives spawn + completion)
      automationIndex: tp.automationIndex,
      autoFactor: tp.autoFactor, // travel-speed multiplier
      ticksPerHour: PARAMS.ticksPerHour,
      cellsPerTick: PARAMS.cellsPerTick,
      totalUnits: totalUnits, // order pool size (drained unless loop)
      loop: loop,
      routing: "straight-segment waypoint routing (zone centroids; optional conveyor/RGV/AGV centroid)",
      dataLabel: SYNTHETIC_LABEL,
    };
  }

  /* ------------------------------------------------------------------
   * state(planOrLayout, opts) -> a fresh LIVE simulation state at tick 0.
   * Accepts a plan (from spawnPlan) or a layout (plan is built for you).
   * ------------------------------------------------------------------ */
  function makeState(planOrLayout, opts) {
    const plan = planOrLayout && planOrLayout.kind === "wt-flowsim-plan"
      ? planOrLayout
      : spawnPlan(planOrLayout, opts);
    return {
      kind: "wt-flowsim-state",
      plan: plan,
      seed: plan.seed,
      gridW: plan.gridW,
      gridH: plan.gridH,
      tick: 0,
      tickAccum: 0, // fractional ticks carried between step() calls
      rngState: (plan.seed ^ 0x9e3779b9) >>> 0,
      mus: [], // live units: {id, seg, t, cx, cy, stage, stageIndex, jitter, arrivedShip, dwell, status}
      nextId: 1,
      spawnAccum: 0, // fractional units carried between ticks
      spawned: 0, // total units ever spawned
      completed: 0, // total units retired at shipping
      poolRemaining: plan.totalUnits, // units left to spawn (ignored when loop)
      perStage: emptyStageCounts(),
      inflight: 0,
      done: false,
      dataLabel: plan.dataLabel,
    };
  }

  function emptyStageCounts() {
    const c = {};
    for (const s of STAGES) c[s] = 0;
    return c;
  }

  function segLen(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    return Math.max(1e-6, Math.sqrt(dx * dx + dy * dy));
  }

  // World position of an MU on its current segment, with a small fixed
  // perpendicular offset (its jitter) so many units fan out visually.
  function positionOf(state, mu) {
    const wp = state.plan.waypoints;
    if (mu.arrivedShip) {
      const last = wp[wp.length - 1];
      return clampPt({ x: last.x, y: last.y }, state.gridW, state.gridH);
    }
    const a = wp[mu.seg], b = wp[mu.seg + 1];
    const L = segLen(a, b);
    const nx = -(b.y - a.y) / L, ny = (b.x - a.x) / L; // unit perpendicular
    const px = a.x + (b.x - a.x) * mu.t + nx * mu.jitter;
    const py = a.y + (b.y - a.y) * mu.t + ny * mu.jitter;
    return clampPt({ x: px, y: py }, state.gridW, state.gridH);
  }

  /* ------------------------------------------------------------------
   * Advance exactly ONE tick (deterministic). Spawns from the pool at the
   * layout's line throughput, moves every MU along its straight segments,
   * dwells at the outbound dock, then retires shipped units.
   * ------------------------------------------------------------------ */
  function advanceOneTick(state) {
    const plan = state.plan;
    const wp = plan.waypoints;
    const lastSeg = wp.length - 2; // index of the final segment (-> shipping)

    // --- 1) Spawn ------------------------------------------------------
    const ratePerTick = plan.lineThroughput / plan.ticksPerHour; // units/tick
    const noise = PARAMS.spawnNoiseLo + (PARAMS.spawnNoiseHi - PARAMS.spawnNoiseLo) * nextRand(state);
    state.spawnAccum += ratePerTick * noise;
    while (state.spawnAccum >= 1) {
      if (!plan.loop && state.poolRemaining <= 0) { state.spawnAccum = 0; break; }
      if (state.mus.length >= PARAMS.maxInFlight) { break; } // perf soft cap (keeps conservation)
      state.spawnAccum -= 1;
      const jitter = (nextRand(state) - 0.5) * 2 * PARAMS.jitterCells;
      const mu = {
        id: state.nextId++,
        seg: 0, t: 0,
        stage: wp[0].stage, stageIndex: 0,
        jitter: jitter,
        arrivedShip: false, dwell: 0,
        status: "active",
        cx: 0, cy: 0,
      };
      const p = positionOf(state, mu);
      mu.cx = p.x; mu.cy = p.y;
      state.mus.push(mu);
      state.spawned++;
      if (!plan.loop) state.poolRemaining--;
    }

    // --- 2) Move / dwell / retire -------------------------------------
    const speed = plan.cellsPerTick * plan.autoFactor; // world cells this tick
    const survivors = [];
    for (const mu of state.mus) {
      if (mu.arrivedShip) {
        mu.dwell--;
        if (mu.dwell <= 0) { state.completed++; continue; } // retire
        const p = positionOf(state, mu);
        mu.cx = p.x; mu.cy = p.y;
        survivors.push(mu);
        continue;
      }
      let remaining = speed;
      let guard = 0;
      while (remaining > 0 && !mu.arrivedShip && guard++ < wp.length + 2) {
        const a = wp[mu.seg], b = wp[mu.seg + 1];
        const L = segLen(a, b);
        const need = (1 - mu.t) * L; // distance left on this segment
        if (remaining >= need) {
          remaining -= need;
          mu.seg++;
          mu.t = 0;
          if (mu.seg >= lastSeg + 1) {
            // reached the final (shipping) waypoint
            mu.arrivedShip = true;
            mu.stage = "shipping";
            mu.stageIndex = STAGES.indexOf("shipping");
            mu.dwell = PARAMS.shipDwellTicks;
          } else {
            mu.stage = wp[mu.seg].stage;
            mu.stageIndex = STAGES.indexOf(mu.stage);
          }
        } else {
          mu.t += remaining / L;
          remaining = 0;
        }
      }
      const p = positionOf(state, mu);
      mu.cx = p.x; mu.cy = p.y;
      survivors.push(mu);
    }
    state.mus = survivors;

    // --- 3) Live counters ---------------------------------------------
    const counts = emptyStageCounts();
    for (const mu of state.mus) counts[mu.stage] = (counts[mu.stage] || 0) + 1;
    state.perStage = counts;
    state.inflight = state.mus.length;
    state.tick++;
    if (!plan.loop && state.poolRemaining <= 0 && state.mus.length === 0) state.done = true;
  }

  /* ------------------------------------------------------------------
   * step(state, dtTicks) -> advances the sim by dtTicks (may be
   * fractional; whole ticks are applied, the remainder carries). Returns
   * the SAME (mutated) state for chaining. Deterministic.
   * ------------------------------------------------------------------ */
  function step(state, dtTicks) {
    if (!state || state.kind !== "wt-flowsim-state") return state;
    let dt = Number(dtTicks);
    if (!(dt > 0)) dt = 0;
    state.tickAccum += dt;
    let budget = PARAMS.maxTicksPerStep;
    while (state.tickAccum >= 1 && budget-- > 0) {
      advanceOneTick(state);
      state.tickAccum -= 1;
    }
    // Refresh positions/counters even on a sub-tick call so a fresh state
    // reports a consistent snapshot without having advanced a whole tick.
    if (state.tick === 0) {
      state.inflight = state.mus.length;
      state.perStage = emptyStageCounts();
      for (const mu of state.mus) state.perStage[mu.stage] = (state.perStage[mu.stage] || 0) + 1;
    }
    return state;
  }

  WT.flowsim = {
    STAGES: STAGES,
    PARAMS: PARAMS,
    SYNTHETIC_LABEL: SYNTHETIC_LABEL,
    spawnPlan: spawnPlan,
    state: makeState,
    step: step,
    // exposed for the UI legend / tests (pure helpers)
    buildWaypoints: buildWaypoints,
    throughputOf: throughputOf,
  };
})();
