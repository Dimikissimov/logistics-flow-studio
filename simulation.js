/* =====================================================================
 * Logistics Flow Studio - WarehouseTwin
 * simulation.js - seeded, deterministic warehouse simulation (P1)
 * ---------------------------------------------------------------------
 * Given a layout + a strategy + a seed, this produces IDENTICAL KPIs on
 * every run (pure function of its inputs). All randomness flows through
 * one seeded PRNG (mulberry32). Everything is synthetic and simplified;
 * it is a teaching twin, not a WMS.
 *
 * KPIs produced:
 *   throughputOrdersPerHour
 *   avgPickTravelM        (average travel distance per order, metres)
 *   storageFillPct        (pallets stored / positions available)
 *   palletPositionsUsed / palletPositionsTotal
 * ===================================================================== */
(function () {
  "use strict";
  const WT = (window.WT = window.WT || {});
  const D = WT.domain;

  /* ---- Seeded PRNG: mulberry32. Deterministic, fast, good enough. --- */
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

  // Deterministic integer in [0, n).
  function randInt(rng, n) {
    return Math.floor(rng() * n);
  }

  // Fisher-Yates shuffle driven by the seeded rng (deterministic).
  function shuffle(rng, arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = randInt(rng, i + 1);
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }

  /* ------------------------------------------------------------------
   * Model parameters (synthetic, documented).
   * ------------------------------------------------------------------ */
  const PARAMS = {
    pickerSpeedMps: 1.2, // brisk walking pace, m/s (industry rule of thumb)
    handlingSecPerLine: 12, // fixed grab/scan/place time per pick line
    zipfExponent: 1.0, // SKU popularity skew (Pareto-ish); 1.0 = classic Zipf
    palletsPerSkuMean: 1.8, // avg pallet positions an SKU occupies
  };

  /* ------------------------------------------------------------------
   * Build the list of physical pallet SLOTS from placed storage
   * elements. Each slot has a metric position (centre-ish of its share
   * of the element footprint) and its distance to the I/O point.
   * ------------------------------------------------------------------ */
  function buildSlots(elements, ioPoint, cell) {
    const slots = [];
    for (const el of elements) {
      const cap = D.elementCapacity(el);
      if (cap <= 0) continue;
      // Distribute `cap` slots across the element footprint (metric).
      const x0 = el.x * cell;
      const y0 = el.y * cell;
      const wM = el.w * cell;
      const dM = el.d * cell;
      // Lay slots on a coarse grid inside the footprint.
      const cols = Math.max(1, Math.round(Math.sqrt(cap * (wM / Math.max(dM, 0.001)))));
      for (let i = 0; i < cap; i++) {
        const cx = x0 + ((i % cols) + 0.5) * (wM / cols);
        const rows = Math.ceil(cap / cols);
        const cy = y0 + ((Math.floor(i / cols) % rows) + 0.5) * (dM / rows);
        const dist = Math.hypot(cx - ioPoint.x, cy - ioPoint.y);
        slots.push({ x: cx, y: cy, dist: dist, elId: el.id });
      }
    }
    return slots;
  }

  /* ------------------------------------------------------------------
   * I/O point: centroid of outbound docks if any, else inbound docks,
   * else canvas centre. This is where pick travel starts and ends.
   * ------------------------------------------------------------------ */
  function ioPointOf(elements, gridW, gridH, cell) {
    const pick = (type) => elements.filter((e) => e.type === type);
    let ref = pick("dock-out");
    if (ref.length === 0) ref = pick("dock-in");
    if (ref.length === 0) {
      return { x: (gridW * cell) / 2, y: (gridH * cell) / 2, source: "canvas-centre" };
    }
    let sx = 0, sy = 0;
    for (const e of ref) {
      sx += (e.x + e.w / 2) * cell;
      sy += (e.y + e.d / 2) * cell;
    }
    return {
      x: sx / ref.length,
      y: sy / ref.length,
      source: ref[0].type === "dock-out" ? "outbound-dock" : "inbound-dock",
    };
  }

  /* ------------------------------------------------------------------
   * Synthetic SKU catalogue with Zipf popularity weights.
   * ------------------------------------------------------------------ */
  function buildSkus(rng, count) {
    const skus = [];
    for (let i = 0; i < count; i++) {
      const rank = i + 1;
      const weight = 1 / Math.pow(rank, PARAMS.zipfExponent);
      // Inventory in pallet positions for this SKU (>=1), seeded.
      const pallets = Math.max(1, Math.round(PARAMS.palletsPerSkuMean * (0.4 + 1.2 * rng())));
      skus.push({ id: "SKU-" + String(rank).padStart(4, "0"), weight, pallets });
    }
    return skus;
  }

  // Weighted pick of one SKU index using cumulative weights.
  function pickWeighted(rng, cum, total) {
    const r = rng() * total;
    // binary search
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /* ------------------------------------------------------------------
   * Slot the SKUs into physical positions under the chosen strategy.
   * Returns a map skuId -> {x,y,dist} (its home location).
   * ------------------------------------------------------------------ */
  function slotSkus(rng, skus, slots, strategy) {
    const home = {};
    // Order SKUs by popularity (weight desc) - already the case by rank.
    const skuOrder = skus.slice(); // index 0 = most popular
    let orderedSlots;
    if (strategy === "abc") {
      // Nearest slots first -> most popular SKUs get them.
      orderedSlots = slots.slice().sort((a, b) => a.dist - b.dist);
    } else {
      // Random slotting: shuffle slot order deterministically.
      orderedSlots = shuffle(rng, slots);
    }
    let s = 0;
    let used = 0;
    for (const sku of skuOrder) {
      if (s >= orderedSlots.length) break; // out of positions
      home[sku.id] = orderedSlots[s];
      // Each SKU consumes `pallets` positions; advance that many.
      const consume = Math.min(sku.pallets, orderedSlots.length - s);
      s += consume;
      used += consume;
    }
    return { home, positionsUsed: used };
  }

  /* ------------------------------------------------------------------
   * Nearest-neighbour pick tour for one order (deterministic).
   * Route: I/O -> visit each distinct location (greedy nearest) -> I/O.
   * ------------------------------------------------------------------ */
  function tourDistance(io, points) {
    if (points.length === 0) return 0;
    const remaining = points.slice();
    let cur = io;
    let dist = 0;
    while (remaining.length) {
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const d = Math.hypot(remaining[i].x - cur.x, remaining[i].y - cur.y);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      dist += bestD;
      cur = remaining[best];
      remaining.splice(best, 1);
    }
    dist += Math.hypot(cur.x - io.x, cur.y - io.y); // return to I/O
    return dist;
  }

  /* ------------------------------------------------------------------
   * MAIN. Pure function of (layout, config). Same inputs -> same KPIs.
   * layout   : { elements:[{id,type,x,y,w,d}], gridW, gridH, cell }
   * config   : { seed, strategy, orders, skuCount, linesPerOrderMax, pickers }
   * ------------------------------------------------------------------ */
  function run(layout, config) {
    const cfg = Object.assign(
      { seed: 42, strategy: "abc", orders: 200, skuCount: 120, linesPerOrderMax: 6, pickers: 1 },
      config || {}
    );
    const cell = layout.cell || D.METRES_PER_CELL;
    const rng = mulberry32(cfg.seed);

    const io = ioPointOf(layout.elements, layout.gridW, layout.gridH, cell);
    const slots = buildSlots(layout.elements, io, cell);
    const positionsTotal = slots.length;

    const skus = buildSkus(rng, cfg.skuCount);
    // Cumulative weights for weighted sampling.
    const cum = [];
    let acc = 0;
    for (const s of skus) {
      acc += s.weight;
      cum.push(acc);
    }
    const total = acc;

    const { home, positionsUsed } = slotSkus(rng, skus, slots, cfg.strategy);

    // Simulate the order stream.
    let totalTravel = 0;
    let totalLines = 0;
    let totalSeconds = 0;
    let ordersServed = 0;
    for (let o = 0; o < cfg.orders; o++) {
      const lines = 1 + randInt(rng, cfg.linesPerOrderMax);
      const points = [];
      for (let l = 0; l < lines; l++) {
        const idx = pickWeighted(rng, cum, total);
        const loc = home[skus[idx].id];
        if (loc) points.push(loc);
      }
      if (points.length === 0) continue; // nothing placed to pick from
      const travel = tourDistance(io, points);
      totalTravel += travel;
      totalLines += points.length;
      totalSeconds += travel / PARAMS.pickerSpeedMps + points.length * PARAMS.handlingSecPerLine;
      ordersServed++;
    }

    const pickers = Math.max(1, cfg.pickers);
    const wallSeconds = totalSeconds / pickers;
    const throughput = wallSeconds > 0 ? (ordersServed / wallSeconds) * 3600 : 0;
    const avgTravel = ordersServed > 0 ? totalTravel / ordersServed : 0;
    const fillPct = positionsTotal > 0 ? Math.min(100, (positionsUsed / positionsTotal) * 100) : 0;

    return {
      ok: positionsTotal > 0,
      seed: cfg.seed,
      strategy: cfg.strategy,
      ioSource: io.source,
      throughputOrdersPerHour: throughput,
      avgPickTravelM: avgTravel,
      storageFillPct: fillPct,
      palletPositionsUsed: Math.min(positionsUsed, positionsTotal),
      palletPositionsTotal: positionsTotal,
      ordersServed: ordersServed,
      linesPicked: totalLines,
      // Echo the params so the readout can stay honest about assumptions.
      params: {
        pickerSpeedMps: PARAMS.pickerSpeedMps,
        handlingSecPerLine: PARAMS.handlingSecPerLine,
        pickers: pickers,
        skuCount: cfg.skuCount,
        orders: cfg.orders,
      },
    };
  }

  WT.sim = { run, mulberry32, PARAMS };

  /* ==================================================================
   * TODO (P2 - AI advisor / comparative predictor):
   *   - `run()` is already a pure fn -> a comparative A/B predictor can
   *     call it twice (e.g. random vs abc, or aisle 2.9 vs 3.8) and diff
   *     the KPIs. Wire that into a P2 "compare layouts" panel.
   *   - A spatial-layout optimiser can search element positions using
   *     avgPickTravelM as the objective (this fn is the fitness eval).
   *   - Feed KPIs + layout stats to the P2 advisor for recommendations.
   * TODO (P3): richer sim - replenishment, put-away travel, congestion,
   *   push vs pull inventory dynamics, multi-picker routing.
   * ================================================================== */
})();
