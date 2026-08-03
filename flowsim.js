/* =====================================================================
 * Logistics Flow Studio - WarehouseTwin
 * flowsim.js - Live material-flow animation model (P3 / P3.2)
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
 * doors).
 *
 * P3.2 - MATERIAL-FLOW REALISM (built ON TOP of the P3 model, same API):
 *   1. STATIONS as active objects. Pick faces, staging (put-away) and
 *      pack stations become active servers: each has a SERVICE RATE
 *      (units/tick, taken from the documented wms.js stage capacity,
 *      divided across the stations of that stage) and a FIFO QUEUE. An MU
 *      arriving at a station joins its shortest queue and is served at the
 *      service rate; when arrivals exceed service the queue GROWS
 *      (congestion emerges). Units are conserved: spawned == in-flight
 *      (active + queued) + completed at EVERY step.
 *   2. CONVEYOR-FOLLOWING routing. Where conveyor / track cells form a
 *      connected path between the storage and picking waypoints, the MU
 *      travels ALONG the centres of those cells (a polyline discovered by
 *      a deterministic BFS over adjacent conveyor cells) so boxes ride the
 *      automation instead of cutting a straight line. If no connected
 *      conveyor path exists it FALLS BACK to the original straight-segment
 *      routing (optionally via a single conveyor/RGV/AGV centroid) -
 *      behaviour unchanged.
 *   3. CONGESTION. Each station reports its queue length; the state
 *      exposes queued / maxQueue / congestedStations for the UI to draw
 *      badges and colour congestion (a queue >= congestQueueThreshold is
 *      "congested"). All heuristic, all transparent.
 *
 * HONESTY (load-bearing, mirrored in the UI + README):
 *   - EVERYTHING here is SYNTHETIC. This is a transparent teaching
 *     ANIMATION, NOT a real discrete-event-simulation (DES) engine, NOT a
 *     measurement of any real operation and NOT a certification.
 *   - The stations are a HEURISTIC: FIFO servers whose service rates are
 *     the documented wms.js stage capacities (order-of-magnitude teaching
 *     assumptions, not vendor specs) split across the stations of a stage.
 *     This is NOT queueing theory and NOT a DES engine.
 *   - Conveyor-following routing is a greedy/BFS walk over adjacent
 *     conveyor cells, NOT real pathfinding and NOT collision-aware. The
 *     honest FALLBACK is the original straight-segment waypoint routing.
 *   - Throughput / speed come from the documented wms.js heuristic
 *     (PARAMS there are order-of-magnitude assumptions), not vendor specs.
 *
 * Determinism: same (layout, seed, ticks) -> byte-identical MU positions,
 * queue contents and counters. All randomness flows through a seeded
 * mulberry32-style PRNG carried inside the state; no Date, no Math.random.
 * Verified in verify_flowsim.js + verify_flowB.js.
 *
 * Conserves units: at every step spawned == in-flight + completed, where
 * in-flight counts both moving AND queued MUs.
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
    "certification. Pick/put/pack stations are heuristic FIFO servers whose " +
    "service rates come from the documented wms.js stage capacities (order-of-" +
    "magnitude assumptions, not vendor specs) split across the stations of a " +
    "stage; queues are simple FIFO congestion, NOT a queueing-theory / DES " +
    "model. Routing follows connected conveyor cells where a path exists and " +
    "falls back to straight-segment waypoint routing between zone centroids; " +
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
    // P3.2 station / queue parameters (synthetic teaching values).
    minStationServicePerTick: 0.02, // floor so a station always eventually drains its queue
    congestQueueThreshold: 6, // a station queue >= this is drawn/counted as "congested"
    queueStackOffset: 0.16, // world-cell spacing between stacked queued MUs (drawing)
    queueStackMax: 8, // cap the drawn stack length so a huge queue can't run off-station
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

  // Cell types that form a conveyor-following PATH (a box can ride ALONG
  // these). Same movement family as isTransport; documented as synthetic.
  const CONVEYOR_CELL_TYPES = { conveyor: 1, track: 1, rgv: 1, agv: 1 };
  function isConveyorCellEl(e) { return !!CONVEYOR_CELL_TYPES[e.type]; }

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

  /* ==================================================================
   * CONVEYOR-FOLLOWING ROUTING (P3.2). Deterministic walk over adjacent
   * conveyor / track cells - NOT pathfinding, NOT collision-aware.
   * ================================================================== */

  // Expand every conveyor/track/rgv/agv element into its unit CELLS. Each
  // cell is one grid square; its centre is (cx+0.5, cy+0.5) in world cells.
  // Returns a Map keyed "cx,cy" -> { cx, cy, x, y }.
  function conveyorCellSet(els) {
    const cells = new Map();
    for (const e of els || []) {
      if (!isConveyorCellEl(e)) continue;
      const x0 = Math.round(e.x), y0 = Math.round(e.y);
      const w = Math.max(1, Math.round(e.w || 1)), d = Math.max(1, Math.round(e.d || 1));
      for (let i = 0; i < w; i++) {
        for (let j = 0; j < d; j++) {
          const cx = x0 + i, cy = y0 + j;
          const key = cx + "," + cy;
          if (!cells.has(key)) cells.set(key, { cx: cx, cy: cy, x: cx + 0.5, y: cy + 0.5 });
        }
      }
    }
    return cells;
  }

  // The conveyor cell whose centre is nearest a world point. Deterministic:
  // iterate keys in sorted order and keep the first strict minimum.
  function nearestCellKey(cells, pt) {
    let best = null, bestD = Infinity;
    const keys = Array.from(cells.keys()).sort();
    for (const k of keys) {
      const c = cells.get(k);
      const dx = c.x - pt.x, dy = c.y - pt.y;
      const dd = dx * dx + dy * dy;
      if (dd < bestD - 1e-12) { bestD = dd; best = k; }
    }
    return best;
  }

  // Shortest path (in cells) between two conveyor cells over 4-neighbour
  // adjacency. Deterministic BFS (fixed neighbour order). Returns the list
  // of cell keys from start to goal, or null if disconnected.
  function bfsCellPath(cells, startKey, goalKey) {
    if (startKey == null || goalKey == null) return null;
    if (startKey === goalKey) return [startKey];
    const prev = new Map();
    prev.set(startKey, null);
    const q = [startKey];
    let head = 0;
    const NB = [[0, -1], [-1, 0], [1, 0], [0, 1]]; // up, left, right, down (fixed)
    while (head < q.length) {
      const k = q[head++];
      if (k === goalKey) break;
      const c = cells.get(k);
      for (let n = 0; n < NB.length; n++) {
        const nk = (c.cx + NB[n][0]) + "," + (c.cy + NB[n][1]);
        if (cells.has(nk) && !prev.has(nk)) { prev.set(nk, k); q.push(nk); }
      }
    }
    if (!prev.has(goalKey)) return null;
    const path = [];
    let cur = goalKey;
    while (cur != null) { path.push(cur); cur = prev.get(cur); }
    path.reverse();
    return path;
  }

  // Drop collinear intermediate points, keeping endpoints and turns. Every
  // kept point is still a conveyor-cell centre (a subset of the input).
  function simplifyPath(points) {
    if (points.length <= 2) return points.slice();
    const out = [points[0]];
    for (let i = 1; i < points.length - 1; i++) {
      const a = out[out.length - 1], b = points[i], c = points[i + 1];
      const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (Math.abs(cross) > 1e-9) out.push(b);
    }
    out.push(points[points.length - 1]);
    return out;
  }

  // Route ALONG conveyor cells from `from` (near storage) to `to` (near
  // picking). Returns { points:[{x,y}], cells } or null when no conveyor
  // cells connect the two ends (caller falls back to straight routing).
  function conveyorRoute(els, from, to) {
    const cells = conveyorCellSet(els);
    if (!cells.size) return null;
    const startKey = nearestCellKey(cells, from);
    const goalKey = nearestCellKey(cells, to);
    const path = bfsCellPath(cells, startKey, goalKey);
    if (!path || !path.length) return null;
    const pts = path.map((k) => { const c = cells.get(k); return { x: c.x, y: c.y }; });
    return { cells: cells, points: simplifyPath(pts) };
  }

  // Public helper: the set of conveyor-cell centres for a layout (array).
  function conveyorCells(layout) {
    const cells = conveyorCellSet((layout && layout.elements) || []);
    return Array.from(cells.values());
  }

  /* ------------------------------------------------------------------
   * Build the ordered waypoint list (world cells) for a layout. Each
   * waypoint carries the flow STAGE a unit is performing while it travels
   * away from that waypoint. Straight segments connect them - EXCEPT the
   * storage->picking leg, which follows the conveyor cells when a
   * connected path exists (each inserted waypoint is a conveyor-cell
   * centre, flagged onConveyor).
   * ------------------------------------------------------------------ */
  function buildWaypoints(layout) {
    const els = (layout && layout.elements) || [];
    const gridW = Math.max(1, (layout && layout.gridW) || 40);
    const gridH = Math.max(1, (layout && layout.gridH) || 24);

    const receiving =
      centroidOf(els, (e) => e.type === "dock-in") ||
      zoneCentre(layout, "receiving") ||
      { x: gridW / 2, y: 1 };
    let storage =
      centroidOf(els, isStorage) ||
      zoneCentre(layout, "storage") ||
      { x: gridW / 2, y: gridH * 0.4 };
    // P4 retrieval: when a physical storage ASSIGNMENT rides on the layout
    // (WT.storage), the storage waypoint moves from the geometric centroid
    // of all racking to the velocity-weighted centroid of the ACTUAL slot
    // placements (fast movers pull it toward the golden zone), so the
    // storage->picking retrieval leg reflects real slotting. With no
    // assignment this whole block is skipped and behaviour is byte-
    // identical to before (guarded by verify_storage.js + verify_flowsim.js).
    let retrievalAnchored = false;
    const asg = layout && layout.storageAssignment;
    if (asg && WT.storage && typeof WT.storage.retrievalAnchor === "function") {
      try {
        const anchor = WT.storage.retrievalAnchor(asg);
        if (anchor && isFinite(anchor.x) && isFinite(anchor.y)) {
          storage = { x: anchor.x, y: anchor.y };
          retrievalAnchored = true;
        }
      } catch (_) { /* defensive: keep the plain centroid */ }
    }
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

    // Storage -> picking leg. Prefer conveyor-following routing (a polyline
    // over connected conveyor cells); otherwise keep the original single
    // conveyor/RGV/AGV centroid; otherwise a straight segment. All three
    // preserve the honest fallback and the >=5-waypoint spine.
    const route = conveyorRoute(els, storage, picking);
    let routed = false;
    if (route && route.points.length) {
      for (const p of route.points) wp.push({ x: p.x, y: p.y, stage: "storage", onConveyor: true });
      routed = true;
    } else {
      const transport = centroidOf(els, isTransport);
      if (transport) wp.push({ x: transport.x, y: transport.y, stage: "storage" });
    }

    wp.push({ x: picking.x, y: picking.y, stage: "picking" });
    wp.push({ x: packing.x, y: packing.y, stage: "packing" });
    wp.push({ x: shipping.x, y: shipping.y, stage: "shipping" });

    // Clamp every waypoint inside the floor so MUs can never render off it.
    const out = wp.map((p) => {
      const c = clampPt(p, gridW, gridH);
      return { x: c.x, y: c.y, stage: p.stage, onConveyor: !!p.onConveyor };
    });
    out.conveyorRouted = routed; // non-enumerable-ish flag (array property)
    out.retrievalAnchored = retrievalAnchored; // P4: storage waypoint = real slotting anchor
    return out;
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
   * Build the STATION specs (pure, deterministic). Pick faces, staging
   * (put-away) and pack stations become active servers. Each station's
   * service rate is its stage's wms capacity (units/hr) / ticksPerHour /
   * the count of stations of that stage - so the aggregate service rate of
   * a stage equals its wms capacity (throughput stays tied to WT.wms).
   *
   * A station GROUP is bound to the flow WAYPOINT its stage passes through
   * (put -> the storage waypoint, pick -> picking, pack -> packing); the
   * individual stations are anchored at their element footprints so their
   * queues can be drawn at the real elements.
   * ------------------------------------------------------------------ */
  function stationKind(kind, stage, wpIndex, elsList, capUnitsPerHr, gridW, gridH) {
    if (wpIndex < 0 || !elsList.length) return [];
    const n = elsList.length;
    const per = Math.max(
      PARAMS.minStationServicePerTick,
      (Math.max(0, capUnitsPerHr) / PARAMS.ticksPerHour) / n
    );
    return elsList.map((e, i) => {
      const c = clampPt({ x: e.x + (e.w || 1) / 2, y: e.y + (e.d || 1) / 2 }, gridW, gridH);
      return {
        id: kind + "-" + i,
        kind: kind, // "put" | "pick" | "pack"
        stage: stage, // the flow stage a unit is in while queued here
        wpIndex: wpIndex,
        x: c.x, y: c.y,
        serviceRatePerTick: per,
      };
    });
  }

  function buildStationSpecs(layout, waypoints, tp) {
    const els = (layout && layout.elements) || [];
    const gridW = Math.max(1, (layout && layout.gridW) || 40);
    const gridH = Math.max(1, (layout && layout.gridH) || 24);
    const cap = (tp && tp.capByStage) || {};

    const firstStage = (stage) => waypoints.findIndex((w) => w.stage === stage);
    const putWp = firstStage("storage"); // storage centroid waypoint (put-away)
    const pickWp = firstStage("picking");
    const packWp = firstStage("packing");

    const putEls = els.filter((e) => e.type === "staging");
    const pickEls = els.filter(isPickFace);
    const packEls = els.filter((e) => e.type === "pack-station");

    const specs = [];
    Array.prototype.push.apply(specs, stationKind("put", "storage", putWp, putEls, cap["put-away"] || 0, gridW, gridH));
    Array.prototype.push.apply(specs, stationKind("pick", "picking", pickWp, pickEls, cap["order-picking"] || 0, gridW, gridH));
    Array.prototype.push.apply(specs, stationKind("pack", "packing", packWp, packEls, cap["packing"] || 0, gridW, gridH));
    return specs;
  }

  /* ------------------------------------------------------------------
   * spawnPlan(layout, opts) -> a PURE plan (waypoints + rates + pool +
   * stations). Deterministic function of (layout, seed). No live MUs.
   * ------------------------------------------------------------------ */
  function spawnPlan(layout, opts) {
    const o = opts || {};
    const cfg = (layout && layout.config) || {};
    const seed = (o.seed != null ? o.seed : (cfg.seed != null ? cfg.seed : 42)) >>> 0;
    const gridW = Math.max(1, (layout && layout.gridW) || 40);
    const gridH = Math.max(1, (layout && layout.gridH) || 24);

    const waypoints = buildWaypoints(layout);
    const tp = throughputOf(layout, seed);
    const stations = buildStationSpecs(layout, waypoints, tp);

    const orders = Math.max(1, Math.round(o.orders != null ? o.orders : PARAMS.defaultOrders));
    const avgUnits = (1 + (o.linesPerOrderMax || cfg.linesPerOrderMax || PARAMS.linesPerOrderMax)) / 2;
    const totalUnits = Math.max(1, Math.round(o.units != null ? o.units : orders * avgUnits));
    const loop = o.loop != null ? !!o.loop : true;

    // Optional what-if arrival override (units/hr). Default = the balanced
    // line rate (bottleneck, tied to WT.wms). Setting it ABOVE a station's
    // service rate lets congestion emerge - documented, honest what-if.
    const arrivalUnitsPerHr = o.arrivalUnitsPerHr != null && o.arrivalUnitsPerHr > 0
      ? Number(o.arrivalUnitsPerHr) : null;

    return {
      kind: "wt-flowsim-plan",
      seed: seed,
      gridW: gridW,
      gridH: gridH,
      waypoints: waypoints,
      conveyorRouted: !!waypoints.conveyorRouted,
      stations: stations, // static specs; live queues live on the state
      caps: tp.caps,
      capByStage: tp.capByStage,
      lineThroughput: tp.lineThroughput, // units/hr (the bottleneck; drives spawn + completion)
      arrivalUnitsPerHr: arrivalUnitsPerHr, // null unless a what-if override is given
      automationIndex: tp.automationIndex,
      autoFactor: tp.autoFactor, // travel-speed multiplier
      ticksPerHour: PARAMS.ticksPerHour,
      cellsPerTick: PARAMS.cellsPerTick,
      totalUnits: totalUnits, // order pool size (drained unless loop)
      loop: loop,
      routing:
        "conveyor-following polyline routing along connected conveyor/track cells " +
        "where a path exists between storage and picking; otherwise straight-segment " +
        "waypoint routing between zone centroids (optional conveyor/RGV/AGV centroid). " +
        "Pick/put/pack stations are FIFO servers (service rate from wms.js capacity); " +
        "NOT pathfinding and NOT a DES queueing model.",
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

    // Live stations: copy the specs and attach a mutable FIFO queue +
    // service accumulator. Index them by waypoint for O(1) enqueue.
    const stations = (plan.stations || []).map((s) => ({
      id: s.id, kind: s.kind, stage: s.stage, wpIndex: s.wpIndex,
      x: s.x, y: s.y, serviceRatePerTick: s.serviceRatePerTick,
      serviceAccum: 0, queue: [],
    }));
    const stationsByWp = {};
    for (const st of stations) {
      (stationsByWp[st.wpIndex] = stationsByWp[st.wpIndex] || []).push(st);
    }

    return {
      kind: "wt-flowsim-state",
      plan: plan,
      seed: plan.seed,
      gridW: plan.gridW,
      gridH: plan.gridH,
      tick: 0,
      tickAccum: 0, // fractional ticks carried between step() calls
      rngState: (plan.seed ^ 0x9e3779b9) >>> 0,
      mus: [], // live units (moving OR queued): {id, seg, t, cx, cy, stage, stageIndex, jitter, arrivedShip, dwell, status, station, stationId}
      nextId: 1,
      spawnAccum: 0, // fractional units carried between ticks
      spawned: 0, // total units ever spawned
      completed: 0, // total units retired at shipping
      poolRemaining: plan.totalUnits, // units left to spawn (ignored when loop)
      perStage: emptyStageCounts(),
      inflight: 0,
      stations: stations,
      stationsByWp: stationsByWp,
      queued: 0, // total MUs currently in any station queue
      maxQueue: 0, // longest single-station queue
      congestedStations: 0, // stations with queue >= congestQueueThreshold
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

  // World position of a MOVING MU on its current segment, with a small
  // fixed perpendicular offset (its jitter) so many units fan out visually.
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

  // World position of a QUEUED MU: stacked just "behind" (above) the
  // station anchor by its place in the queue, capped so a long queue never
  // runs off the station. Deterministic given the queue order.
  function queuedPosition(state, st, qIndex) {
    const k = Math.min(qIndex, PARAMS.queueStackMax);
    return clampPt({ x: st.x, y: st.y - PARAMS.queueStackOffset * k }, state.gridW, state.gridH);
  }

  // Join the SHORTEST queue of a station group (ties -> lowest station
  // index, which is the group's iteration order). Deterministic.
  function enqueueAt(state, mu, group) {
    let best = group[0];
    for (let i = 1; i < group.length; i++) {
      if (group[i].queue.length < best.queue.length) best = group[i];
    }
    best.queue.push(mu);
    mu.status = "queued";
    mu.station = best;
    mu.stationId = best.id;
    const p = queuedPosition(state, best, best.queue.length - 1);
    mu.cx = p.x; mu.cy = p.y;
  }

  /* ------------------------------------------------------------------
   * Advance exactly ONE tick (deterministic). Spawns from the pool at the
   * layout's arrival rate, SERVES station queues, moves every active MU
   * along its segments (queuing at pick/put/pack stations), dwells at the
   * outbound dock, then retires shipped units.
   * ------------------------------------------------------------------ */
  function advanceOneTick(state) {
    const plan = state.plan;
    const wp = plan.waypoints;
    const lastSeg = wp.length - 2; // index of the final segment (-> shipping)

    // --- 1) Spawn ------------------------------------------------------
    const arrivalPerHr = plan.arrivalUnitsPerHr != null ? plan.arrivalUnitsPerHr : plan.lineThroughput;
    const ratePerTick = arrivalPerHr / plan.ticksPerHour; // units/tick
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
        station: null, stationId: null,
        cx: 0, cy: 0,
      };
      const p = positionOf(state, mu);
      mu.cx = p.x; mu.cy = p.y;
      state.mus.push(mu);
      state.spawned++;
      if (!plan.loop) state.poolRemaining--;
    }

    // --- 2) Serve station queues (before movement, so a served MU can
    // move on the same tick). Each station releases floor(serviceAccum)
    // head-of-line MUs; an idle station banks at most ~1 unit of service.
    for (const st of state.stations) {
      st.serviceAccum += st.serviceRatePerTick;
      while (st.serviceAccum >= 1 && st.queue.length) {
        const mu = st.queue.shift();
        mu.status = "active";
        mu.station = null;
        mu.stationId = null;
        st.serviceAccum -= 1;
      }
      if (st.queue.length === 0 && st.serviceAccum > 1) st.serviceAccum = 1;
    }

    // --- 3) Move / queue / dwell / retire -----------------------------
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
      if (mu.status === "queued") {
        // Hold at the station, restacked to its live queue position.
        const st = mu.station;
        const idx = st ? st.queue.indexOf(mu) : 0;
        const p = queuedPosition(state, st, idx < 0 ? 0 : idx);
        mu.cx = p.x; mu.cy = p.y;
        survivors.push(mu);
        continue;
      }

      let remaining = speed;
      let guard = 0;
      let queuedNow = false;
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
            // Station at this waypoint? Join its queue and stop advancing.
            const group = state.stationsByWp[mu.seg];
            if (group && group.length) {
              enqueueAt(state, mu, group);
              queuedNow = true;
              remaining = 0;
              break;
            }
          }
        } else {
          mu.t += remaining / L;
          remaining = 0;
        }
      }
      if (queuedNow) { survivors.push(mu); continue; } // position set by enqueueAt
      const p = positionOf(state, mu);
      mu.cx = p.x; mu.cy = p.y;
      survivors.push(mu);
    }
    state.mus = survivors;

    // --- 4) Live counters (stage mix + queue/congestion) --------------
    const counts = emptyStageCounts();
    for (const mu of state.mus) counts[mu.stage] = (counts[mu.stage] || 0) + 1;
    state.perStage = counts;
    state.inflight = state.mus.length; // includes queued MUs
    refreshQueueStats(state);
    state.tick++;
    if (!plan.loop && state.poolRemaining <= 0 && state.mus.length === 0) state.done = true;
  }

  // Roll up per-station queue lengths into the state's congestion scalars.
  function refreshQueueStats(state) {
    let queued = 0, maxQ = 0, congested = 0;
    const thr = PARAMS.congestQueueThreshold;
    for (const st of state.stations) {
      const q = st.queue.length;
      queued += q;
      if (q > maxQ) maxQ = q;
      if (q >= thr) congested++;
    }
    state.queued = queued;
    state.maxQueue = maxQ;
    state.congestedStations = congested;
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
      refreshQueueStats(state);
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
    buildStationSpecs: buildStationSpecs,
    conveyorCells: conveyorCells,
    conveyorRoute: conveyorRoute,
  };
})();
