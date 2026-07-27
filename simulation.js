/* =====================================================================
 * Logistics Flow Studio - WarehouseTwin
 * simulation.js - seeded, deterministic warehouse simulation (P1 + P3)
 * ---------------------------------------------------------------------
 * Given a layout + a strategy + a seed, this produces IDENTICAL KPIs on
 * every run (pure function of its inputs). All randomness flows through
 * seeded PRNGs (mulberry32) - one independent sub-stream per concern
 * (SKUs, slotting, orders, flow noise) so features stay deterministic
 * and independent. Everything is synthetic and simplified; it is a
 * teaching twin, not a WMS.
 *
 * P3 depth (all documented in docs/DOMAIN_NOTES.md):
 *   - storage-system characteristics matter: per-line handling deltas
 *     (deep-lane repositioning vs flow-rack pick faces), goods-to-person
 *     machine cycles for AS/RS + shuttle (no walking travel).
 *   - material-flow chains: storage chained to shipping via conveyors
 *     drops the tour's return leg (goods ride the conveyor) and saves
 *     handling; a chained receiving side shortens pull replenishment
 *     lead time. Broken chains force full manual travel.
 *   - push vs pull pick-face inventory: push tops faces up on a
 *     forecast schedule (overstock returns when the forecast overshoots)
 *     while pull replenishes on consumption (reorder point + lead time).
 *     Stockouts cost a walk to reserve stock.
 *   - picking strategies: discrete (random/abc), zone (parallel
 *     zone-confined tours + consolidation), batch (shared tours + sort),
 *     wave (timed release, bigger batches + wave setup).
 *
 * KPIs produced:
 *   throughputOrdersPerHour, avgPickTravelM, storageFillPct,
 *   palletPositionsUsed/Total, stockoutPct, overstockUnits,
 *   avgFaceStockPct, chainAssistedLinesPct
 * Plus a per-cell pick-walking heatmap (metres walked per 1 m grid
 * cell, summing exactly to the charged travel) for the floor overlay.
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
   * Model parameters (synthetic, documented in DOMAIN_NOTES.md).
   * ------------------------------------------------------------------ */
  const PARAMS = {
    pickerSpeedMps: 1.2, // brisk walking pace, m/s (industry rule of thumb)
    handlingSecPerLine: 12, // base grab/scan/place time per pick line
    zipfExponent: 1.0, // default SKU popularity skew (config.demandSkew)
    palletsPerSkuMean: 1.8, // avg pallet positions an SKU occupies
    // --- P3 flow / inventory model ---
    stockoutPenaltySec: 45, // walk to reserve stock when the face is empty
    pushIntervalOrders: 25, // push: top-up every N orders (forecast cycle)
    pushForecastErr: 0.35, // push: +/- relative forecast noise
    pullLeadOrders: 5, // pull: replenishment lead time (orders)
    pullLeadOrdersChained: 3, // ...shorter when receiving is chain-connected
    faceCapSafety: 1.2, // pick-face capacity = expected interval demand x this
    pullRopSafety: 1.5, // pull reorder point = expected lead demand x this
    chainHandlingBonusSec: 2, // saved per line when storage is chained to shipping
    // --- P3 picking strategies ---
    zones: 3, // zone picking: vertical zones (resident pickers)
    zoneConsolidationSec: 15, // per order: merge zone totes
    zoneManualHandoffSec: 10, // extra per order without an outbound chain
    batchSize: 4, // batch picking: orders per shared tour
    batchSortSecPerOrder: 18, // downstream put-to-order sort
    waveSize: 20, // wave picking: orders per timed release
    waveBatchSize: 6, // batches built within a wave
    waveSetupSec: 90, // per-wave release/setup overhead
  };

  /* ------------------------------------------------------------------
   * Build the list of physical pallet SLOTS from placed storage
   * elements. Each slot has a metric position (centre-ish of its share
   * of the element footprint), its distance to the I/O point, and the
   * storage system it belongs to (for handling/goods-to-person effects).
   * ------------------------------------------------------------------ */
  function buildSlots(elements, ioPoint, cell) {
    const slots = [];
    for (const el of elements) {
      const cap = D.elementCapacity(el);
      if (cap <= 0) continue;
      const x0 = el.x * cell;
      const y0 = el.y * cell;
      const wM = el.w * cell;
      const dM = el.d * cell;
      const cols = Math.max(1, Math.round(Math.sqrt(cap * (wM / Math.max(dM, 0.001)))));
      for (let i = 0; i < cap; i++) {
        const cx = x0 + ((i % cols) + 0.5) * (wM / cols);
        const rows = Math.ceil(cap / cols);
        const cy = y0 + ((Math.floor(i / cols) % rows) + 0.5) * (dM / rows);
        const dist = Math.hypot(cx - ioPoint.x, cy - ioPoint.y);
        slots.push({ x: cx, y: cy, dist: dist, elId: el.id, type: el.type });
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
  function buildSkus(rng, count, skew) {
    const skus = [];
    const exp = skew || PARAMS.zipfExponent;
    for (let i = 0; i < count; i++) {
      const rank = i + 1;
      const weight = 1 / Math.pow(rank, exp);
      const pallets = Math.max(1, Math.round(PARAMS.palletsPerSkuMean * (0.4 + 1.2 * rng())));
      skus.push({ id: "SKU-" + String(rank).padStart(4, "0"), weight, pallets });
    }
    return skus;
  }

  // Weighted pick of one SKU index using cumulative weights.
  function pickWeighted(rng, cum, total) {
    const r = rng() * total;
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
   * random -> shuffled slots; every other strategy (abc, zone, batch,
   * wave) slots by popularity: nearest slots to the most popular SKUs.
   * ------------------------------------------------------------------ */
  function slotSkus(rng, skus, slots, strategy) {
    const home = {};
    const skuOrder = skus.slice(); // index 0 = most popular
    let orderedSlots;
    if (strategy === "random") {
      orderedSlots = shuffle(rng, slots);
    } else {
      orderedSlots = slots.slice().sort((a, b) => a.dist - b.dist);
    }
    let s = 0;
    let used = 0;
    for (const sku of skuOrder) {
      if (s >= orderedSlots.length) break; // out of positions
      home[sku.id] = orderedSlots[s];
      const consume = Math.min(sku.pallets, orderedSlots.length - s);
      s += consume;
      used += consume;
    }
    return { home, positionsUsed: used };
  }

  /* ------------------------------------------------------------------
   * Nearest-neighbour pick tour (deterministic).
   * Route: start -> visit each location (greedy nearest) -> start.
   * Returns the full loop distance and the final return-leg distance so
   * a conveyor-assisted tour can drop the return leg (goods ride the
   * chain to pack/ship while the picker starts the next tour nearby).
   * The optional legCb is invoked once per walked leg (from, to) —
   * excluding the return leg, which the caller owns (it knows whether
   * that leg is walked or dropped) via the returned `end` point.
   * ------------------------------------------------------------------ */
  function tourDistance(start, points, legCb) {
    if (points.length === 0) return { loop: 0, returnLeg: 0, end: start };
    const remaining = points.slice();
    let cur = start;
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
      if (legCb) legCb(cur, remaining[best]);
      cur = remaining[best];
      remaining.splice(best, 1);
    }
    const returnLeg = Math.hypot(cur.x - start.x, cur.y - start.y);
    return { loop: dist + returnLeg, returnLeg, end: cur };
  }

  /* ------------------------------------------------------------------
   * MAIN. Pure function of (layout, config). Same inputs -> same KPIs.
   * layout : { elements:[{id,type,x,y,w,d}], gridW, gridH, cell }
   * config : { seed, strategy, orders, skuCount, linesPerOrderMax,
   *            pickers, flowMode ("push"|"pull"), demandSkew,
   *            dataset? }
   *
   * W3 "bring your own data": config.dataset (built by data.js from the
   * user's CSVs) swaps the SYNTHETIC catalogue/order stream for the
   * user's REAL one:
   *   dataset.skus   [{id, picks}] - demand weights come from the
   *                  user's weekly_picks (no Zipf, no demandSkew).
   *                  Pallet counts per SKU stay a seeded model value
   *                  (the CSV does not carry them - disclosed in the UI).
   *   dataset.orders [{id, lines:[{skuIndex, qty}]}] | null - when
   *                  present the sim replays EXACTLY these orders (the
   *                  orders config count is ignored); when absent the
   *                  order stream stays synthetic, weighted by the
   *                  user's pick frequencies (disclosed as such).
   * Without config.dataset every code path below is byte-identical to
   * before - the synthetic baselines (verify_heatmap.js) pin that.
   * ------------------------------------------------------------------ */
  function run(layout, config) {
    const cfg = Object.assign(
      {
        seed: 42, strategy: "abc", orders: 200, skuCount: 120,
        linesPerOrderMax: 6, pickers: 1, flowMode: "pull",
        demandSkew: PARAMS.zipfExponent,
      },
      config || {}
    );
    const cell = layout.cell || D.METRES_PER_CELL;
    // Independent deterministic sub-streams (order of feature evaluation
    // can change without re-shuffling every other random draw).
    const rngSku = mulberry32((cfg.seed ^ 0xa511e9b3) >>> 0);
    const rngSlot = mulberry32((cfg.seed ^ 0x85ebca6b) >>> 0);
    const rngOrd = mulberry32((cfg.seed ^ 0xc2b2ae35) >>> 0);
    const rngFlow = mulberry32((cfg.seed ^ 0x27d4eb2f) >>> 0);

    const io = ioPointOf(layout.elements, layout.gridW, layout.gridH, cell);
    const slots = buildSlots(layout.elements, io, cell);
    const positionsTotal = slots.length;
    const chains = D.analyzeChains(layout.elements);

    // ---- Pick-walking traffic accumulation (heatmap) ---------------
    // Every walked leg of every simulated tour is rasterised onto the
    // floor grid: a leg is sampled in ~half-cell steps and each step's
    // share of the leg length is charged to the cell it falls in, so a
    // cell's value is "metres walked inside this cell" and the grand
    // total equals the charged travel exactly. Pure arithmetic, no
    // randomness — the heatmap is as deterministic as every other
    // output. Goods-to-person picks (AS/RS, shuttle) add no walking,
    // so they leave no trace here; dropped (chain-covered) return legs
    // are not stamped, matching the travel KPI.
    const heatW = Math.max(1, Math.round(layout.gridW || 1));
    const heatH = Math.max(1, Math.round(layout.gridH || 1));
    const heat = new Float64Array(heatW * heatH);
    function stampLeg(a, b) {
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len <= 0) return;
      const steps = Math.max(1, Math.ceil(len / (cell * 0.5)));
      const stepLen = len / steps;
      for (let i = 0; i < steps; i++) {
        const t = (i + 0.5) / steps;
        const cx = Math.min(heatW - 1, Math.max(0, Math.floor((a.x + (b.x - a.x) * t) / cell)));
        const cy = Math.min(heatH - 1, Math.max(0, Math.floor((a.y + (b.y - a.y) * t) / cell)));
        heat[cy * heatW + cx] += stepLen;
      }
    }

    // W3: the user's imported dataset (data.js) replaces the synthetic
    // SKU catalogue; without it, this path is exactly the old one.
    const ds = cfg.dataset && Array.isArray(cfg.dataset.skus) && cfg.dataset.skus.length ? cfg.dataset : null;
    const userOrders = ds && Array.isArray(ds.orders) && ds.orders.length ? ds.orders : null;
    let skus;
    if (ds) {
      // Real demand weights from the user's weekly picks. Pallet counts
      // per SKU are NOT in the CSV - keep the seeded model draw so
      // storage-fill behaviour stays comparable (disclosed in the UI).
      skus = ds.skus.map((u) => ({
        id: u.id,
        weight: Math.max(0, Number(u.picks) || 0),
        pallets: Math.max(1, Math.round(PARAMS.palletsPerSkuMean * (0.4 + 1.2 * rngSku()))),
      }));
      if (!skus.some((s) => s.weight > 0)) skus.forEach((s) => { s.weight = 1; }); // defensive; the parser rejects all-zero picks
    } else {
      skus = buildSkus(rngSku, cfg.skuCount, cfg.demandSkew);
    }
    const cum = [];
    let acc = 0;
    for (const s of skus) {
      acc += s.weight;
      cum.push(acc);
    }
    const total = acc;

    const { home, positionsUsed } = slotSkus(rngSlot, skus, slots, cfg.strategy);

    // ---- Pick-face inventory model (push vs pull) ------------------
    // Faces are sized to expected demand over the push cycle, so the two
    // modes differ by POLICY, not by capacity. All units are "lines".
    // With user orders the expected lines/order is measured from THEIR
    // stream instead of the synthetic uniform assumption.
    let avgLines = (1 + cfg.linesPerOrderMax) / 2;
    if (userOrders) {
      let userLineCount = 0;
      for (const uo of userOrders) userLineCount += uo.lines.length;
      avgLines = Math.max(1, userLineCount / userOrders.length);
    }
    const face = {}; // skuId -> {cap, inv, rop, pendingUntil}
    const pullLead = chains.inboundConnected ? PARAMS.pullLeadOrdersChained : PARAMS.pullLeadOrders;
    for (const sku of skus) {
      if (!home[sku.id]) continue;
      const expectedPerOrder = (sku.weight / total) * avgLines;
      const cap = Math.max(3, Math.ceil(expectedPerOrder * PARAMS.pushIntervalOrders * PARAMS.faceCapSafety));
      const rop = Math.max(1, Math.ceil(expectedPerOrder * pullLead * PARAMS.pullRopSafety));
      face[sku.id] = { cap, inv: cap, rop, pendingUntil: -1, expectedPerOrder };
    }

    // ---- Strategy setup --------------------------------------------
    const strat = cfg.strategy;
    let batchSize = 1;
    let perOrderOverheadSec = 0;
    if (strat === "batch") {
      batchSize = PARAMS.batchSize;
      perOrderOverheadSec = PARAMS.batchSortSecPerOrder;
    } else if (strat === "wave") {
      batchSize = PARAMS.waveBatchSize;
      perOrderOverheadSec = PARAMS.batchSortSecPerOrder + PARAMS.waveSetupSec / PARAMS.waveSize;
    } else if (strat === "zone") {
      perOrderOverheadSec = PARAMS.zoneConsolidationSec + (chains.outboundConnected ? 0 : PARAMS.zoneManualHandoffSec);
    }
    const zoneWidthM = (layout.gridW * cell) / PARAMS.zones;
    const zoneHomes = [];
    for (let z = 0; z < PARAMS.zones; z++) {
      zoneHomes.push({ x: (z + 0.5) * zoneWidthM, y: io.y });
    }
    const zoneOf = (p) => Math.min(PARAMS.zones - 1, Math.max(0, Math.floor(p.x / zoneWidthM)));

    // ---- Simulate the order stream ---------------------------------
    let totalTravel = 0;
    let totalLines = 0;
    let totalSeconds = 0;
    let ordersServed = 0;
    let stockoutLines = 0;
    let overstockUnits = 0;
    let chainAssistedLines = 0;
    let faceStockAcc = 0;
    let faceStockSamples = 0;

    // Batch accumulator (batch/wave strategies share one tour).
    let groupPoints = [];
    let groupAllCovered = true;
    let groupOrders = 0;

    function flushGroup() {
      if (groupOrders === 0) return;
      const t = tourDistance(io, groupPoints, stampLeg);
      const dropReturn = groupAllCovered && groupPoints.length > 0;
      if (!dropReturn && groupPoints.length > 0) stampLeg(t.end, io);
      const travel = t.loop - (dropReturn ? t.returnLeg : 0);
      totalTravel += travel;
      totalSeconds += travel / PARAMS.pickerSpeedMps;
      groupPoints = [];
      groupAllCovered = true;
      groupOrders = 0;
    }

    // W3: replaying the user's own orders overrides the orders count.
    const nOrders = userOrders ? userOrders.length : cfg.orders;
    for (let o = 0; o < nOrders; o++) {
      // --- replenishment events at order start ---
      if (cfg.flowMode === "push") {
        if (o > 0 && o % PARAMS.pushIntervalOrders === 0) {
          for (const sku of skus) {
            const f = face[sku.id];
            if (!f) continue;
            const err = (rngFlow() * 2 - 1) * PARAMS.pushForecastErr;
            const forecast = Math.max(0, Math.round(f.expectedPerOrder * PARAMS.pushIntervalOrders * (1 + err)));
            const newInv = f.inv + forecast;
            if (newInv > f.cap) {
              overstockUnits += newInv - f.cap; // returned to reserve
              f.inv = f.cap;
            } else {
              f.inv = newInv;
            }
          }
        }
      } else {
        // pull: consumption-triggered replenishments arrive after the lead time
        for (const sid in face) {
          const f = face[sid];
          if (f.pendingUntil >= 0 && f.pendingUntil <= o) {
            f.inv = f.cap;
            f.pendingUntil = -1;
          }
        }
      }

      // --- build the order ---
      // Synthetic: seeded line count + weighted SKU draws (unchanged).
      // User orders: replay exactly the imported lines (qty consumes
      // that many units of face stock; travel/handling stay per line).
      let lineSpecs; // [{idx, qty}]
      if (userOrders) {
        lineSpecs = userOrders[o].lines.map((l) => ({ idx: l.skuIndex, qty: Math.max(1, Number(l.qty) || 1) }));
      } else {
        const lines = 1 + randInt(rngOrd, cfg.linesPerOrderMax);
        lineSpecs = [];
        for (let l = 0; l < lines; l++) lineSpecs.push({ idx: pickWeighted(rngOrd, cum, total), qty: 1 });
      }
      const points = [];
      let orderHandlingSec = 0;
      let orderMachineSec = 0;
      let orderPenaltySec = 0;
      let placedLines = 0;
      let allCovered = true;
      for (const spec of lineSpecs) {
        const sku = skus[spec.idx];
        if (!sku) continue;
        const loc = home[sku.id];
        if (!loc) continue;
        placedLines++;

        // pick-face inventory
        const f = face[sku.id];
        if (f) {
          if (f.inv <= 0) {
            stockoutLines++;
            orderPenaltySec += PARAMS.stockoutPenaltySec; // fetch from reserve
          } else {
            f.inv = Math.max(0, f.inv - spec.qty);
          }
          if (cfg.flowMode === "pull" && f.inv <= f.rop && f.pendingUntil < 0) {
            f.pendingUntil = o + pullLead;
          }
        }

        // storage-system characteristics
        const def = D.ELEMENTS[loc.type] || {};
        const covered = chains.outboundCovered.has(loc.elId);
        if (def.goodsToPerson) {
          // AS/RS & shuttle: machine dual-command cycle, no walking travel.
          orderMachineSec += def.cycleSec || 30;
          orderHandlingSec += PARAMS.handlingSecPerLine;
          if (covered) {
            orderHandlingSec -= PARAMS.chainHandlingBonusSec;
            chainAssistedLines++;
          }
        } else {
          points.push(loc);
          orderHandlingSec += PARAMS.handlingSecPerLine + (def.handlingDeltaSec || 0);
          if (covered) {
            orderHandlingSec -= PARAMS.chainHandlingBonusSec;
            chainAssistedLines++;
          } else {
            allCovered = false;
          }
        }
      }
      if (placedLines === 0) continue; // nothing placed to pick from

      // --- travel per strategy ---
      if (strat === "zone") {
        const byZone = [[], [], []];
        for (const p of points) byZone[zoneOf(p)].push(p);
        let travel = 0;
        for (let z = 0; z < PARAMS.zones; z++) {
          if (!byZone[z].length) continue;
          const t = tourDistance(zoneHomes[z], byZone[z], stampLeg);
          if (!allCovered) stampLeg(t.end, zoneHomes[z]);
          travel += t.loop - (allCovered ? t.returnLeg : 0);
        }
        totalTravel += travel;
        totalSeconds += travel / PARAMS.pickerSpeedMps;
      } else if (batchSize > 1) {
        for (const p of points) groupPoints.push(p);
        if (!allCovered) groupAllCovered = false;
        groupOrders++;
        if (groupOrders >= batchSize) flushGroup();
      } else {
        const t = tourDistance(io, points, stampLeg);
        const dropReturn = allCovered && points.length > 0;
        if (!dropReturn && points.length > 0) stampLeg(t.end, io);
        const travel = t.loop - (dropReturn ? t.returnLeg : 0);
        totalTravel += travel;
        totalSeconds += travel / PARAMS.pickerSpeedMps;
      }

      totalLines += placedLines;
      totalSeconds += orderHandlingSec + orderMachineSec + orderPenaltySec + perOrderOverheadSec;
      ordersServed++;

      // sample face-stock level
      let sInv = 0, sCap = 0;
      for (const sid in face) { sInv += Math.max(0, face[sid].inv); sCap += face[sid].cap; }
      if (sCap > 0) { faceStockAcc += sInv / sCap; faceStockSamples++; }
    }
    flushGroup(); // trailing partial batch

    // Materialise the heatmap as a plain array (JSON-friendly) + peak.
    let heatMax = 0;
    const heatCells = new Array(heat.length);
    for (let i = 0; i < heat.length; i++) {
      heatCells[i] = heat[i];
      if (heat[i] > heatMax) heatMax = heat[i];
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
      flowMode: cfg.flowMode,
      ioSource: io.source,
      // W3: honest data provenance - "user" when config.dataset came
      // from imported CSVs, plus which order stream actually ran.
      dataSource: ds ? "user" : "synthetic",
      orderSource: userOrders ? "user-orders" : ds ? "synthetic-from-your-picks" : "synthetic",
      throughputOrdersPerHour: throughput,
      avgPickTravelM: avgTravel,
      storageFillPct: fillPct,
      palletPositionsUsed: Math.min(positionsUsed, positionsTotal),
      palletPositionsTotal: positionsTotal,
      ordersServed: ordersServed,
      linesPicked: totalLines,
      // Person-time per order actually simulated: travel + handling +
      // stockout penalties + strategy overheads + goods-to-person wait
      // (the operator stands at the port during the machine cycle).
      // Consumed by the labour-cost KPI (time x wage) in the shell.
      labourSecPerOrder: ordersServed > 0 ? totalSeconds / ordersServed : 0,
      // --- P3 KPIs ---
      stockoutLines: stockoutLines,
      stockoutPct: totalLines > 0 ? (stockoutLines / totalLines) * 100 : 0,
      overstockUnits: overstockUnits,
      avgFaceStockPct: faceStockSamples > 0 ? (faceStockAcc / faceStockSamples) * 100 : 0,
      chainAssistedLinesPct: totalLines > 0 ? (chainAssistedLines / totalLines) * 100 : 0,
      chainWarnings: chains.warnings.length,
      // Pick-walking heatmap: metres walked per 1 m grid cell (row-major
      // y*w+x), summing exactly to the charged travel. See stampLeg.
      heatmap: { w: heatW, h: heatH, cellM: cell, cells: heatCells, maxM: heatMax },
      // Echo the params so the readout can stay honest about assumptions.
      params: {
        pickerSpeedMps: PARAMS.pickerSpeedMps,
        handlingSecPerLine: PARAMS.handlingSecPerLine,
        pickers: pickers,
        // Effective values: with an imported dataset the SKU count is
        // the user's catalogue and orders is what actually ran.
        skuCount: ds ? skus.length : cfg.skuCount,
        orders: nOrders,
        demandSkew: ds ? null : cfg.demandSkew, // skew never applies to real picks
        avgLinesPerOrder: userOrders ? avgLines : null,
        flowMode: cfg.flowMode,
        pullLeadOrders: cfg.flowMode === "pull" ? (chains.inboundConnected ? PARAMS.pullLeadOrdersChained : PARAMS.pullLeadOrders) : null,
      },
    };
  }

  // Expose ioPointOf so the advisor & optimizer anchor to the exact same
  // I/O point the simulation uses.
  WT.sim = { run, mulberry32, PARAMS, ioPointOf };
})();
