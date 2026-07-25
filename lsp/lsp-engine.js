/* =====================================================================
 * Logistics Flow Studio - LSP Planner (P5)
 * lsp/lsp-engine.js - the deterministic network evaluation engine
 * ---------------------------------------------------------------------
 * The network-level companion to WarehouseTwin's warehouse simulation:
 * given a DESIGN (sites + lanes drawn by the player) and its LEVEL
 * (seeded customer-zone demand + targets), evaluate() computes weekly
 * transport cost, facility fixed/handling cost, holding cost (safety
 * stock via the base-stock / square-root risk-pooling logic), achieved
 * service level, a CO2 ESTIMATE, and a 0-100 game score with visible
 * weights. Pure function of its inputs: the same design at the same
 * level ALWAYS returns identical numbers.
 *
 * HONESTY NOTES (also in docs/DOMAIN_NOTES.md section 9):
 *   - Every cost and CO2 figure is an ESTIMATE from the stated
 *     assumptions in PARAMS/MODES below - synthetic teaching values in
 *     a plausible order of magnitude, not quotations from any carrier,
 *     3PL or manufacturer.
 *   - Safety stock uses the textbook base-stock formula
 *     SS = z * sqrt(LT) * sigma with independent-demand pooling
 *     (sigma_pooled = sqrt(sum sigma_i^2), the square-root law) -
 *     reimplemented in JS from the author's own Python reference
 *     (supply-network-opt/supplynet/safetystock.py). Real demand is
 *     neither perfectly normal nor independent.
 *   - Push vs pull is a transparent heuristic model (fill and holding
 *     shift with demand volatility), not a claim about any real ERP.
 *   - The map is an ABSTRACT region on a clean grid - not any real
 *     country or company network. All data is synthetic and seeded.
 *
 * Runs BOTH in the browser (window.LSP.engine, classic script) and in
 * Node (module.exports) so lsp/verify.js can prove determinism.
 * ===================================================================== */
(function (root) {
  "use strict";

  /* ---- Seeded PRNG: mulberry32 (same generator the main app uses). -- */
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
   * Model parameters. ALL of these are stated assumptions; the UI and
   * docs surface them next to every result they influence.
   * ------------------------------------------------------------------ */
  const PARAMS = {
    gridW: 60, // cells across
    gridH: 36, // cells down
    cellKm: 10, // one grid cell = 10 km -> a 600 x 360 km abstract region
    // --- inventory / service (base-stock, square-root pooling) ---
    zServe: 1.65, // safety factor ~ 95% cycle service (normal quantile)
    holdingEurPerTonneWk: 10, // assumes ~2000 EUR/t goods value at 25%/yr
    cycleStockWeeks: 0.35, // avg cycle stock ~ half of a 0.7-week order cycle
    // --- lead-time building blocks (days) ---
    dispatchDays: 0.5, // order processing at the stocking DC
    legLoadDays: 0.2, // load/unload per transport leg
    factoryMakeDays: 2.5, // make-to-order wait when no DC decouples the zone
    factoryDispatchDays: 1.0, // factory outbound scheduling (DC replenishment)
    crossdockDwellDays: 0.3, // fast transship, no storage
    dcPassThroughDays: 0.75, // passing a DC without stopping stock there
    // --- push vs pull (transparent heuristic; see DOMAIN_NOTES 9) ---
    pullFill: 0.95, // reorder-point replenishment hits the z-target fill
    pushFillBase: 0.98, // push pre-positions stock: slightly better when...
    pushFillCvSlope: 0.15, // ...demand is stable; fill = base - slope * avgCV
    pushHoldingCvFactor: 0.8, // push overstocks with volatility: x(1 + 0.8*CV)
    // --- service coverage vs the lead-time target ---
    coverageGraceFactor: 2, // coverage falls linearly to 0 at target*(1+2)
  };

  /* ------------------------------------------------------------------
   * Transport modes. Two SIMPLE, honest cost models:
   *   ftl    - you pay per truck-km; weekly trucks = ceil(flow / cap),
   *            so a thin flow still pays a whole truck (that IS the
   *            teaching point about wasted FTL capacity).
   *   parcel - parcel / LTL network: you pay per tonne-km, no truck
   *            minimum, slower door-to-door, higher CO2 per tonne-km
   *            (smaller vehicles, extra handling legs).
   * CO2 figures are ESTIMATES (g/t-km ballpark of published road-freight
   * ranges; assumption stated wherever shown). Backhaul/empty running is
   * NOT modelled - one-way costs only.
   * ------------------------------------------------------------------ */
  const MODES = {
    ftl: {
      id: "ftl", label: "Full truckload (FTL)",
      truckCapT: 15, // avg usable payload, tonnes
      costPerTruckKm: 1.4, // EUR per truck-km (estimate)
      co2KgPerTruckKm: 0.9, // ~900 g CO2 per truck-km (estimate)
      speedKmPerDay: 500, // effective door-to-door incl. breaks
      desc: "Pay per truck: weekly trucks = ceil(flow / 15 t). Cheap per tonne-km when trucks run full - wasteful for thin flows.",
    },
    parcel: {
      id: "parcel", label: "Parcel / LTL",
      costPerTonneKm: 0.3, // EUR per tonne-km (estimate)
      co2KgPerTonneKm: 0.18, // ~180 g CO2 per tonne-km (estimate)
      speedKmPerDay: 350, // slower: hub sorting adds time
      desc: "Pay per tonne-km through a carrier network: no truck minimum, ideal for thin flows - pricier and higher-CO2 per tonne-km than a full truck.",
    },
  };

  /* ------------------------------------------------------------------
   * Site types (the palette). Fixed costs are weekly ESTIMATES.
   *   stocking: holds inventory -> safety stock + cycle stock live here,
   *             and it DECOUPLES the zones it serves from the factory
   *             lead time (that is what a DC buys you).
   *   crossdock: transships only - no stock, low fixed cost, small
   *             handling fee, a short dwell. Pays off when thin flows
   *             can ride one full line-haul truck and fan out nearby.
   * ------------------------------------------------------------------ */
  const SITE_TYPES = {
    factory: {
      id: "factory", label: "Factory", color: "#8b5cf6",
      fixedCostWk: 4000, handlingEurPerT: 0,
      desc: "The source of goods. Zones served with no DC in between wait for make-to-order production (+2.5 days).",
    },
    "central-dc": {
      id: "central-dc", label: "Central DC", color: "#0ea5e9",
      fixedCostWk: 3000, handlingEurPerT: 4, stocking: true,
      desc: "Large stocking DC: holds pooled safety stock (base-stock logic), decouples zones from the factory. Push or pull replenishment.",
    },
    "regional-dc": {
      id: "regional-dc", label: "Regional DC", color: "#14b8a6",
      fixedCostWk: 1600, handlingEurPerT: 4, stocking: true,
      desc: "Smaller stocking DC close to demand: shorter last legs, but splitting stock forfeits part of the risk-pooling effect (~sqrt(n) law).",
    },
    crossdock: {
      id: "crossdock", label: "Cross-dock", color: "#f59e0b",
      fixedCostWk: 900, handlingEurPerT: 1.5,
      desc: "Transship point, no storage: consolidate one full line-haul in, fan thin flows out. Adds a 0.3-day dwell; holds zero stock.",
    },
    zone: {
      id: "zone", label: "Customer zone", color: "#ef4444",
      fixedCostWk: 0, handlingEurPerT: 0,
      desc: "A demand region with seeded weekly demand (mean t/wk + variability). Serve it within the lead-time target to score service.",
    },
  };

  /* ------------------------------------------------------------------
   * Score weights - VISIBLE in the UI next to every score.
   * ------------------------------------------------------------------ */
  const SCORE_WEIGHTS = { cost: 0.45, service: 0.4, co2: 0.15 };

  function starsFor(total) {
    if (total >= 85) return 5;
    if (total >= 72) return 4;
    if (total >= 58) return 3;
    if (total >= 42) return 2;
    return total > 0 ? 1 : 0;
  }

  /* ------------------------------------------------------------------
   * LEVELS. Each level fixes the factory + customer zones (positions
   * hand-authored; demand mean/CV drawn from the level's own seed, so
   * the same level ALWAYS presents the same demand), states its goal in
   * one sentence, and sets the pass thresholds. Budgets were calibrated
   * against reference solutions in lsp/verify.js (a sensible design
   * passes with margin; a design that misses the level's lesson fails).
   * ------------------------------------------------------------------ */
  const LEVELS = [
    {
      id: "L1", name: "First network", seed: 101,
      goal: "Serve all four customer zones from a single central DC and stay under the weekly cost budget.",
      lesson: "A DC decouples customers from the factory: stock near demand turns a 3+ day make-to-order wait into a next-day delivery.",
      leadTargetDays: 2.0, minService: 0.8,
      budgetCostWk: 13000, budgetCo2KgWk: 4200,
      zoneMean: [18, 36], zoneCv: [0.2, 0.3],
      factory: { x: 7, y: 18 },
      zonePos: [ { x: 46, y: 7 }, { x: 52, y: 16 }, { x: 47, y: 28 }, { x: 40, y: 20 } ],
    },
    {
      id: "L2", name: "Demand doubles", seed: 202,
      goal: "Demand has doubled and two far zones joined - add a regional DC where it helps and watch the risk-pooling trade-off.",
      lesson: "Splitting stock across DCs shortens lanes and lead times but forfeits part of the square-root pooling effect - safety stock rises.",
      leadTargetDays: 0.8, minService: 0.9,
      budgetCostWk: 26000, budgetCo2KgWk: 11000,
      zoneMean: [36, 72], zoneCv: [0.2, 0.3],
      factory: { x: 7, y: 18 },
      zonePos: [
        { x: 46, y: 7 }, { x: 52, y: 16 }, { x: 47, y: 28 }, { x: 40, y: 20 },
        { x: 54, y: 5 }, { x: 55, y: 31 },
      ],
    },
    {
      id: "L3", name: "Volatile demand", seed: 303,
      goal: "Five swingy zones - pick the replenishment mode that survives the volatility (measure push vs pull before you commit).",
      lesson: "Pull (reorder-point, consumption-driven) follows real demand; push (forecast allocation) overstocks and under-serves when demand swings.",
      leadTargetDays: 2.0, minService: 0.89,
      budgetCostWk: 16500, budgetCo2KgWk: 5200,
      zoneMean: [20, 40], zoneCv: [0.55, 0.85],
      factory: { x: 7, y: 18 },
      zonePos: [ { x: 44, y: 8 }, { x: 52, y: 12 }, { x: 50, y: 22 }, { x: 43, y: 28 }, { x: 56, y: 29 } ],
    },
    {
      id: "L4", name: "The cross-dock play", seed: 404,
      goal: "Six thin, steady flows to a far cluster - make a cross-dock pay for itself.",
      lesson: "Cross-docking consolidates thin flows onto one full line-haul truck and fans out close to demand - it pays when inbound and outbound flows balance.",
      leadTargetDays: 2.0, minService: 0.88,
      budgetCostWk: 15500, budgetCo2KgWk: 4300,
      zoneMean: [10, 18], zoneCv: [0.12, 0.2],
      factory: { x: 6, y: 18 },
      zonePos: [
        { x: 52, y: 8 }, { x: 57, y: 13 }, { x: 58, y: 21 },
        { x: 54, y: 27 }, { x: 50, y: 32 }, { x: 49, y: 14 },
      ],
    },
    {
      id: "L5", name: "Free play", seed: 505,
      goal: "Eight zones, the full palette, no script - design any network you like and chase the stars.",
      lesson: "Everything at once: pooling vs proximity, push vs pull, mode choice per lane, and cross-docks where flows balance.",
      leadTargetDays: 2.0, minService: 0.75,
      budgetCostWk: 30000, budgetCo2KgWk: 12000,
      zoneMean: [15, 45], zoneCv: [0.15, 0.6],
      factory: { x: 7, y: 10 },
      zonePos: [
        { x: 15, y: 30 }, { x: 25, y: 6 }, { x: 34, y: 14 }, { x: 44, y: 28 },
        { x: 52, y: 8 }, { x: 56, y: 18 }, { x: 40, y: 4 }, { x: 20, y: 22 },
      ],
      freePlay: true,
    },
  ];

  function levelById(id) {
    return LEVELS.find((l) => l.id === id) || null;
  }

  /* ------------------------------------------------------------------
   * Seeded demand for a level's fixed zones. Deterministic: the same
   * level id always yields the same means/CVs.
   * ------------------------------------------------------------------ */
  function levelZoneDemand(level) {
    const rng = mulberry32(level.seed >>> 0);
    return level.zonePos.map((p, i) => {
      const mean = Math.round(level.zoneMean[0] + rng() * (level.zoneMean[1] - level.zoneMean[0]));
      const cv = Math.round((level.zoneCv[0] + rng() * (level.zoneCv[1] - level.zoneCv[0])) * 100) / 100;
      return { x: p.x, y: p.y, mean, cv, label: "Zone " + String.fromCharCode(65 + i) };
    });
  }

  /* ------------------------------------------------------------------
   * DESIGN factory + mutation helpers (shared by the UI and the
   * verification harness). A design is plain JSON:
   *   { version, levelId, idCounter, sites:[{id,type,x,y,fixed?,mode?,
   *     demandMean?,demandCv?,label?}], lanes:[{id,a,b,mode}] }
   * Zones carry their demand IN the design, so evaluate() is a pure
   * function of the design object alone.
   * ------------------------------------------------------------------ */
  function newDesign(levelId) {
    const level = levelById(levelId);
    if (!level) throw new Error("Unknown level: " + levelId);
    const d = { version: "lsp-1", levelId: level.id, idCounter: 0, sites: [], lanes: [] };
    const f = addSite(d, "factory", level.factory.x, level.factory.y);
    f.fixed = true;
    for (const z of levelZoneDemand(level)) {
      const s = addSite(d, "zone", z.x, z.y);
      s.fixed = true;
      s.demandMean = z.mean;
      s.demandCv = z.cv;
      s.label = z.label;
    }
    return d;
  }

  function addSite(design, type, x, y) {
    const def = SITE_TYPES[type];
    if (!def) throw new Error("Unknown site type: " + type);
    const site = {
      id: "s-" + ++design.idCounter,
      type, x: Math.round(x), y: Math.round(y),
    };
    if (def.stocking) site.mode = "pull"; // push/pull toggle per DC
    if (type === "zone" && site.fixed !== true) {
      // Player-added zone (free play): deterministic demand drawn from
      // the level seed + the zone's placement index, then STORED on the
      // site - evaluation never rolls dice.
      const level = levelById(design.levelId);
      const idx = design.sites.filter((s) => s.type === "zone" && !s.fixed).length;
      const rng = mulberry32(((level ? level.seed : 1) ^ (0x51ab + idx * 0x9e37)) >>> 0);
      site.demandMean = Math.round(12 + rng() * 30);
      site.demandCv = Math.round((0.15 + rng() * 0.5) * 100) / 100;
      site.label = "Zone +" + (idx + 1);
    }
    design.sites.push(site);
    return site;
  }

  function addLane(design, aId, bId, mode) {
    if (aId === bId) return null;
    const exists = design.lanes.find(
      (l) => (l.a === aId && l.b === bId) || (l.a === bId && l.b === aId)
    );
    if (exists) return exists;
    const lane = { id: "ln-" + ++design.idCounter, a: aId, b: bId, mode: MODES[mode] ? mode : "ftl" };
    design.lanes.push(lane);
    return lane;
  }

  function removeSite(design, siteId) {
    const s = design.sites.find((x) => x.id === siteId);
    if (!s || s.fixed) return false; // level-fixed sites stay
    design.sites = design.sites.filter((x) => x.id !== siteId);
    design.lanes = design.lanes.filter((l) => l.a !== siteId && l.b !== siteId);
    return true;
  }

  function removeLane(design, laneId) {
    const before = design.lanes.length;
    design.lanes = design.lanes.filter((l) => l.id !== laneId);
    return design.lanes.length < before;
  }

  function siteById(design, id) {
    return design.sites.find((s) => s.id === id) || null;
  }

  function distKm(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y) * PARAMS.cellKm;
  }

  /* ------------------------------------------------------------------
   * Shortest paths (km) from all factories over the drawn lanes.
   * Plain O(n^2) Dijkstra - networks here are tiny. Deterministic:
   * ties resolve by site insertion order.
   * ------------------------------------------------------------------ */
  function shortestFromFactories(design) {
    const idx = {};
    design.sites.forEach((s, i) => (idx[s.id] = i));
    const n = design.sites.length;
    const dist = new Array(n).fill(Infinity);
    const prev = new Array(n).fill(-1); // previous SITE index on the path
    const prevLane = new Array(n).fill(null);
    const done = new Array(n).fill(false);
    const adj = design.sites.map(() => []);
    for (const lane of design.lanes) {
      const ai = idx[lane.a], bi = idx[lane.b];
      if (ai === undefined || bi === undefined) continue;
      const km = distKm(design.sites[ai], design.sites[bi]);
      adj[ai].push({ to: bi, km, lane });
      adj[bi].push({ to: ai, km, lane });
    }
    design.sites.forEach((s, i) => {
      if (s.type === "factory") dist[i] = 0;
    });
    for (let iter = 0; iter < n; iter++) {
      let u = -1, best = Infinity;
      for (let i = 0; i < n; i++) {
        if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
      }
      if (u === -1) break;
      done[u] = true;
      for (const e of adj[u]) {
        if (dist[u] + e.km < dist[e.to] - 1e-9) {
          dist[e.to] = dist[u] + e.km;
          prev[e.to] = u;
          prevLane[e.to] = e.lane;
        }
      }
    }
    return { idx, dist, prev, prevLane };
  }

  // Ordered factory -> ... -> site path as [{site, laneToHere}] entries.
  function pathTo(design, sp, siteId) {
    const i0 = sp.idx[siteId];
    if (i0 === undefined || !isFinite(sp.dist[i0])) return null;
    const chain = [];
    let i = i0;
    while (i !== -1) {
      chain.push({ site: design.sites[i], lane: sp.prevLane[i] });
      i = sp.prev[i];
    }
    chain.reverse(); // factory first; factory's lane entry is null
    return chain;
  }

  /* ------------------------------------------------------------------
   * MAIN EVALUATION. Pure + deterministic: no RNG anywhere in here -
   * all randomness happened once, at design creation (seeded zone
   * demand stored on the sites).
   * ------------------------------------------------------------------ */
  function evaluate(design) {
    const level = levelById(design.levelId) || LEVELS[LEVELS.length - 1];
    const sp = shortestFromFactories(design);

    const zones = design.sites.filter((s) => s.type === "zone");
    const laneFlow = {}; // laneId -> tonnes/wk
    const laneDir = {}; // laneId -> "ab" | "ba" (flow direction for arrows)
    const nodeThroughput = {}; // siteId -> tonnes/wk handled
    const dcZones = {}; // stocking DC id -> [zone evaluation stubs]
    const zoneOut = [];

    let demandTotal = 0;
    let demandServedPath = 0; // demand with ANY path from a factory

    for (const z of zones) {
      const mean = z.demandMean || 0;
      const cv = z.demandCv || 0;
      demandTotal += mean;
      const chain = pathTo(design, sp, z.id);
      if (!chain || chain.length < 2) {
        zoneOut.push({
          id: z.id, label: z.label || z.id, mean, cv,
          served: false, servedBy: null, leadDays: null,
          coverage: 0, fill: 0, service: 0,
        });
        continue;
      }
      demandServedPath += mean;

      // Flow + throughput along the whole factory -> zone path.
      for (let i = 1; i < chain.length; i++) {
        const lane = chain[i].lane;
        laneFlow[lane.id] = (laneFlow[lane.id] || 0) + mean;
        laneDir[lane.id] = lane.a === chain[i - 1].site.id ? "ab" : "ba";
        const node = chain[i].site;
        if (node.type !== "zone") {
          nodeThroughput[node.id] = (nodeThroughput[node.id] || 0) + mean;
        }
      }

      // Serving stock point: the LAST stocking DC before the zone.
      let stockIdx = -1;
      for (let i = chain.length - 2; i >= 0; i--) {
        if (SITE_TYPES[chain[i].site.type].stocking) { stockIdx = i; break; }
      }

      // Lead time from the decoupling point to the zone.
      let leadDays;
      let servedBy;
      const startIdx = stockIdx >= 0 ? stockIdx : 0;
      if (stockIdx >= 0) {
        leadDays = PARAMS.dispatchDays;
        servedBy = chain[stockIdx].site.id;
      } else {
        leadDays = PARAMS.factoryMakeDays; // straight from the factory
        servedBy = "factory-direct";
      }
      for (let i = startIdx + 1; i < chain.length; i++) {
        const lane = chain[i].lane;
        const km = distKm(chain[i - 1].site, chain[i].site);
        leadDays += km / MODES[lane.mode].speedKmPerDay + PARAMS.legLoadDays;
        const node = chain[i].site;
        if (node.type === "crossdock") leadDays += PARAMS.crossdockDwellDays;
        else if (i < chain.length - 1 && SITE_TYPES[node.type].stocking && i !== stockIdx) {
          leadDays += PARAMS.dcPassThroughDays; // passing a DC we don't stock at
        }
      }

      const target = level.leadTargetDays;
      const coverage = leadDays <= target
        ? 1
        : Math.max(0, 1 - (leadDays - target) / (PARAMS.coverageGraceFactor * target));

      const stub = {
        id: z.id, label: z.label || z.id, mean, cv,
        served: true, servedBy, leadDays, coverage,
        fill: 1, service: coverage, // fill patched below for DC-served zones
      };
      if (stockIdx >= 0) {
        const dcId = chain[stockIdx].site.id;
        (dcZones[dcId] = dcZones[dcId] || []).push(stub);
      }
      zoneOut.push(stub);
    }

    // ---- Stocking DCs: base-stock safety stock + push/pull ----------
    // SS = z * sqrt(LT_weeks) * sigma_pooled, sigma_pooled =
    // sqrt(sum sigma_i^2) over the zones this DC serves (square-root /
    // risk-pooling law; assumes independent zone demand).
    const dcOut = [];
    let holdingCostWk = 0;
    for (const dc of design.sites.filter((s) => SITE_TYPES[s.type].stocking)) {
      const served = dcZones[dc.id] || [];
      const muTotal = served.reduce((s, z) => s + z.mean, 0);
      const sigmaPooled = Math.sqrt(served.reduce((s, z) => s + Math.pow(z.cv * z.mean, 2), 0));
      const avgCv = muTotal > 0 ? served.reduce((s, z) => s + z.cv * z.mean, 0) / muTotal : 0;

      // Replenishment lead time: factory -> this DC along its own path.
      let ltDays = PARAMS.factoryDispatchDays;
      const chain = pathTo(design, sp, dc.id);
      if (chain && chain.length >= 2) {
        for (let i = 1; i < chain.length; i++) {
          const km = distKm(chain[i - 1].site, chain[i].site);
          ltDays += km / MODES[chain[i].lane.mode].speedKmPerDay + PARAMS.legLoadDays;
          const node = chain[i].site;
          if (i < chain.length - 1) {
            if (node.type === "crossdock") ltDays += PARAMS.crossdockDwellDays;
            else if (SITE_TYPES[node.type].stocking) ltDays += PARAMS.dcPassThroughDays;
          }
        }
      }
      const ltWks = Math.max(0.1, ltDays / 7);

      const mode = dc.mode === "push" ? "push" : "pull";
      const safetyStockT = PARAMS.zServe * Math.sqrt(ltWks) * sigmaPooled;
      const cycleStockT = PARAMS.cycleStockWeeks * muTotal;
      const holdMult = mode === "push" ? 1 + PARAMS.pushHoldingCvFactor * avgCv : 1;
      const holding = (safetyStockT + cycleStockT) * PARAMS.holdingEurPerTonneWk * holdMult;
      const fill = mode === "push"
        ? Math.min(0.99, Math.max(0.5, PARAMS.pushFillBase - PARAMS.pushFillCvSlope * avgCv))
        : PARAMS.pullFill;

      for (const z of served) {
        z.fill = fill;
        z.service = z.coverage * fill;
      }
      holdingCostWk += holding;
      dcOut.push({
        id: dc.id, type: dc.type, mode,
        zonesServed: served.length, demandTWk: muTotal,
        avgCv: Math.round(avgCv * 100) / 100,
        replenLtWks: Math.round(ltWks * 100) / 100,
        sigmaPooledT: Math.round(sigmaPooled * 10) / 10,
        safetyStockT: Math.round(safetyStockT * 10) / 10,
        cycleStockT: Math.round(cycleStockT * 10) / 10,
        holdingCostWk: Math.round(holding),
        fill: Math.round(fill * 1000) / 1000,
      });
    }

    // ---- Lanes: transport cost + CO2 estimate -----------------------
    const laneOut = [];
    let transportCostWk = 0;
    let co2KgWk = 0;
    for (const lane of design.lanes) {
      const a = siteById(design, lane.a), b = siteById(design, lane.b);
      if (!a || !b) continue;
      const km = distKm(a, b);
      const flow = laneFlow[lane.id] || 0;
      const m = MODES[lane.mode];
      let cost = 0, co2 = 0, trucks = 0, util = 0;
      if (flow > 0) {
        if (lane.mode === "ftl") {
          trucks = Math.ceil(flow / m.truckCapT - 1e-9);
          util = flow / (trucks * m.truckCapT);
          cost = trucks * km * m.costPerTruckKm;
          co2 = trucks * km * m.co2KgPerTruckKm;
        } else {
          cost = flow * km * m.costPerTonneKm;
          co2 = flow * km * m.co2KgPerTonneKm;
          util = 1;
        }
      }
      transportCostWk += cost;
      co2KgWk += co2;
      laneOut.push({
        id: lane.id, a: lane.a, b: lane.b, mode: lane.mode,
        distKm: Math.round(km), flowTWk: Math.round(flow * 10) / 10,
        dir: laneDir[lane.id] || null,
        trucksWk: trucks, utilization: Math.round(util * 100) / 100,
        costWk: Math.round(cost), co2Kg: Math.round(co2),
      });
    }

    // ---- Facilities: fixed + handling -------------------------------
    let facilityFixedWk = 0;
    let handlingCostWk = 0;
    for (const s of design.sites) {
      const def = SITE_TYPES[s.type];
      facilityFixedWk += def.fixedCostWk;
      handlingCostWk += (nodeThroughput[s.id] || 0) * def.handlingEurPerT;
    }

    const totalCostWk = transportCostWk + facilityFixedWk + handlingCostWk + holdingCostWk;

    // ---- Service level: demand-weighted across zones ----------------
    const service = demandTotal > 0
      ? zoneOut.reduce((s, z) => s + z.service * z.mean, 0) / demandTotal
      : 0;
    const servedShare = demandTotal > 0 ? demandServedPath / demandTotal : 0;

    // ---- Score ------------------------------------------------------
    // Cost & CO2 points scale with the share of demand actually
    // connected (an empty network must not score cost points).
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    const costScore = 100 * Math.min(1.2, level.budgetCostWk / Math.max(1, totalCostWk)) / 1.2 * servedShare;
    const svcScore = 100 * clamp01((service - 0.5) / 0.5);
    const co2Score = 100 * Math.min(1.2, level.budgetCo2KgWk / Math.max(1, co2KgWk)) / 1.2 * servedShare;
    const total = Math.round(
      SCORE_WEIGHTS.cost * costScore + SCORE_WEIGHTS.service * svcScore + SCORE_WEIGHTS.co2 * co2Score
    );

    const checks = [
      { id: "cost", label: "Weekly cost within budget", ok: totalCostWk <= level.budgetCostWk,
        actual: Math.round(totalCostWk), limit: level.budgetCostWk, unit: "EUR/wk", cmp: "<=" },
      { id: "service", label: "Service level target", ok: service >= level.minService,
        actual: Math.round(service * 1000) / 10, limit: level.minService * 100, unit: "%", cmp: ">=" },
      { id: "co2", label: "CO2 estimate within budget", ok: co2KgWk <= level.budgetCo2KgWk,
        actual: Math.round(co2KgWk), limit: level.budgetCo2KgWk, unit: "kg/wk", cmp: "<=" },
      { id: "connected", label: "Every zone connected", ok: servedShare >= 0.999,
        actual: Math.round(servedShare * 100), limit: 100, unit: "%", cmp: ">=" },
    ];

    return {
      ok: true,
      levelId: level.id,
      seed: level.seed,
      zones: zoneOut,
      dcs: dcOut,
      lanes: laneOut,
      totals: {
        demandTWk: Math.round(demandTotal * 10) / 10,
        servedShare: Math.round(servedShare * 1000) / 1000,
        transportCostWk: Math.round(transportCostWk),
        facilityFixedWk: Math.round(facilityFixedWk),
        handlingCostWk: Math.round(handlingCostWk),
        holdingCostWk: Math.round(holdingCostWk),
        totalCostWk: Math.round(totalCostWk),
        co2KgWk: Math.round(co2KgWk),
        serviceLevel: Math.round(service * 1000) / 1000,
      },
      score: {
        cost: Math.round(costScore),
        service: Math.round(svcScore),
        co2: Math.round(co2Score),
        total,
        stars: starsFor(total),
        weights: SCORE_WEIGHTS,
        pass: checks.every((c) => c.ok),
        checks,
      },
      assumptions:
        "Estimates from stated assumptions: FTL " + MODES.ftl.costPerTruckKm + " EUR/truck-km @ " +
        MODES.ftl.truckCapT + " t cap, " + Math.round(MODES.ftl.co2KgPerTruckKm * 1000) + " g CO2/truck-km; " +
        "parcel/LTL " + MODES.parcel.costPerTonneKm + " EUR/t-km, " + Math.round(MODES.parcel.co2KgPerTonneKm * 1000) +
        " g CO2/t-km; holding " + PARAMS.holdingEurPerTonneWk + " EUR/t-wk; safety stock = z*sqrt(LT)*sigma (z=" +
        PARAMS.zServe + ", independent zone demand); one-way transport, no backhaul. Synthetic, seeded data.",
    };
  }

  /* ------------------------------------------------------------------
   * REFERENCE DESIGNS - one sensible (not necessarily optimal) solution
   * per level. The level budgets were calibrated against these in
   * lsp/verify.js; the UI offers them as the "Starter" network.
   * ------------------------------------------------------------------ */
  function referenceDesign(levelId) {
    const d = newDesign(levelId);
    const f = d.sites.find((s) => s.type === "factory");
    const zones = d.sites.filter((s) => s.type === "zone");
    if (levelId === "L1") {
      const dc = addSite(d, "central-dc", 45, 17);
      addLane(d, f.id, dc.id, "ftl");
      for (const z of zones) addLane(d, dc.id, z.id, "ftl");
    } else if (levelId === "L2") {
      const dc = addSite(d, "central-dc", 49, 25); // south + mid
      const rdc = addSite(d, "regional-dc", 51, 10); // north cluster
      addLane(d, f.id, dc.id, "ftl");
      addLane(d, f.id, rdc.id, "ftl");
      for (const z of zones) addLane(d, z.y <= 16 ? rdc.id : dc.id, z.id, "ftl");
    } else if (levelId === "L3") {
      const dc = addSite(d, "central-dc", 48, 18); // mode defaults to pull
      addLane(d, f.id, dc.id, "ftl");
      for (const z of zones) addLane(d, dc.id, z.id, "ftl");
    } else if (levelId === "L4") {
      const dc = addSite(d, "central-dc", 26, 18);
      const xd = addSite(d, "crossdock", 53, 19);
      addLane(d, f.id, dc.id, "ftl");
      addLane(d, dc.id, xd.id, "ftl"); // one consolidated line-haul
      for (const z of zones) addLane(d, xd.id, z.id, "parcel"); // short fan-out
    } else {
      const dc = addSite(d, "central-dc", 28, 14);
      const rdc = addSite(d, "regional-dc", 50, 16);
      addLane(d, f.id, dc.id, "ftl");
      addLane(d, dc.id, rdc.id, "ftl");
      for (const z of zones) {
        const hub = z.x >= 42 ? rdc : dc;
        addLane(d, hub.id, z.id, z.demandMean >= 25 ? "ftl" : "parcel");
      }
    }
    return d;
  }

  /* ------------------------------------------------------------------
   * ADVISOR - explained heuristics, each naming its principle. Honest:
   * where a number is shown it is MEASURED with this same evaluation
   * (deterministic), otherwise the hint stays qualitative. Max 4 hints.
   * ------------------------------------------------------------------ */
  function advise(design) {
    const res = evaluate(design);
    const level = levelById(design.levelId) || LEVELS[LEVELS.length - 1];
    const out = [];
    const s = (severity, finding, principle, impact) => out.push({ severity, finding, principle, impact });

    // ---- 1: unserved zones (connectivity first) --------------------
    const unserved = res.zones.filter((z) => !z.served);
    if (unserved.length) {
      s("high",
        unserved.length + " customer zone" + (unserved.length > 1 ? "s have" : " has") + " no lane path from the factory (" +
          unserved.map((z) => z.label).join(", ") + ").",
        "Network connectivity: demand you cannot reach is service you cannot earn - every zone needs a route from a source.",
        "Draw lanes so each zone connects (via DCs / cross-docks) to the factory. Unserved demand scores zero service and forfeits cost points.");
    }

    // ---- 2: FTL lanes running near-empty ---------------------------
    const thin = res.lanes.filter((l) => l.mode === "ftl" && l.flowTWk > 0 && l.utilization < 0.35);
    if (thin.length) {
      let saving = 0;
      for (const l of thin) {
        const parcelCost = l.flowTWk * l.distKm * MODES.parcel.costPerTonneKm;
        saving += Math.max(0, l.costWk - parcelCost);
      }
      if (saving > 1) {
        s("medium",
          thin.length + " FTL lane" + (thin.length > 1 ? "s run" : " runs") + " under 35% truck utilization - you pay for empty trailer space.",
          "Transport consolidation: a full truckload is the cheapest tonne-km on the road, but ceil(flow/capacity) means thin flows still pay whole trucks.",
          "Switching " + (thin.length > 1 ? "these lanes" : "this lane") + " to Parcel/LTL saves ~" + Math.round(saving) +
            " EUR/wk at current flows (measured with both cost models; parcel CO2/t-km is higher - check the estimate).");
      }
    }

    // ---- 3: push vs pull, measured by flipping each DC -------------
    const stockingDcs = design.sites.filter((x) => SITE_TYPES[x.type].stocking);
    let bestFlip = null;
    for (const dc of stockingDcs) {
      const clone = JSON.parse(JSON.stringify(design));
      const cdc = clone.sites.find((x) => x.id === dc.id);
      cdc.mode = cdc.mode === "push" ? "pull" : "push";
      const alt = evaluate(clone);
      const gain = alt.score.total - res.score.total;
      if (!bestFlip || gain > bestFlip.gain) bestFlip = { dc, to: cdc.mode, gain, alt };
    }
    if (bestFlip && bestFlip.gain >= 1) {
      s("medium",
        "Switching " + (SITE_TYPES[bestFlip.dc.type].label) + " " + bestFlip.dc.id + " to " + bestFlip.to.toUpperCase() +
          " scores " + bestFlip.gain + " point" + (bestFlip.gain > 1 ? "s" : "") + " higher (measured: " +
          res.score.total + " -> " + bestFlip.alt.score.total + ").",
        "Push suits stable, forecastable demand (pre-positioned stock); pull (reorder-point) follows actual consumption and is robust to volatility.",
        "Service " + (res.totals.serviceLevel * 100).toFixed(1) + "% -> " + (bestFlip.alt.totals.serviceLevel * 100).toFixed(1) +
          "%, holding " + res.totals.holdingCostWk + " -> " + bestFlip.alt.totals.holdingCostWk +
          " EUR/wk. Toggle the DC's replenishment mode in its properties.");
    }

    // ---- 4: risk pooling across stocking DCs -----------------------
    const activeDcs = res.dcs.filter((d) => d.zonesServed > 0);
    if (activeDcs.length >= 2) {
      const ssNow = activeDcs.reduce((a, d) => a + d.safetyStockT, 0);
      const sigmaAll = Math.sqrt(res.zones.reduce((a, z) => a + Math.pow(z.cv * z.mean, 2), 0));
      const muAll = activeDcs.reduce((a, d) => a + d.demandTWk, 0);
      const ltAvg = muAll > 0 ? activeDcs.reduce((a, d) => a + d.replenLtWks * d.demandTWk, 0) / muAll : 0.5;
      const ssPooled = PARAMS.zServe * Math.sqrt(ltAvg) * sigmaAll;
      const cut = ssNow > 0 ? (1 - ssPooled / ssNow) * 100 : 0;
      if (cut >= 12) {
        s("low",
          "Safety stock is split across " + activeDcs.length + " stocking DCs (" + ssNow.toFixed(0) + " t total).",
          "Square-root law of risk pooling: with independent zone demand, one pooled stock point needs only sqrt(sum sigma_i^2) - roughly 1/sqrt(n) of the decentralized total.",
          "Fully pooling into one DC would need ~" + ssPooled.toFixed(0) + " t (~" + cut.toFixed(0) +
            "% less) at the same z - but longer last legs can cost more transport and service than the holding it saves. It is a trade, not a free lunch.");
      }
    } else if (activeDcs.length === 1 && res.totals.serviceLevel < level.minService) {
      const worst = res.zones.filter((z) => z.served && z.coverage < 1);
      if (worst.length) {
        s("medium",
          "One DC serves everything and " + worst.length + " zone" + (worst.length > 1 ? "s miss" : " misses") +
            " the " + level.leadTargetDays + "-day lead-time target.",
          "Pooling vs proximity: centralizing stock minimizes safety stock (square-root law) but stretches delivery legs; a regional DC near far zones buys back lead time at the cost of pooling.",
          "Consider a Regional DC near the slowest zones - then re-evaluate: holding will rise, service should jump.");
      }
    }

    // ---- 5: cross-dock opportunity ---------------------------------
    const hasCrossdock = design.sites.some((x) => x.type === "crossdock");
    if (!hasCrossdock && activeDcs.length) {
      for (const dcRes of activeDcs) {
        const fanLanes = res.lanes.filter((l) => {
          if (l.flowTWk <= 0 || l.distKm < 80) return false;
          const from = l.dir === "ba" ? l.b : l.a;
          if (from !== dcRes.id) return false;
          return l.mode === "parcel" || l.utilization < 0.4;
        });
        if (fanLanes.length >= 3) {
          s("low",
            SITE_TYPES[design.sites.find((x) => x.id === dcRes.id).type].label + " " + dcRes.id + " fans out " +
              fanLanes.length + " thin lanes over " + Math.min.apply(null, fanLanes.map((l) => l.distKm)) + "+ km each.",
            "Cross-docking: consolidate thin flows onto one full line-haul truck, break bulk close to demand - it pays when inbound and outbound flows balance (what arrives leaves the same day, no storage).",
            "Try a Cross-dock near the zone cluster: one FTL line-haul in, short fan-out lanes out. It holds zero stock and adds only a 0.3-day dwell + 1.5 EUR/t handling.");
          break;
        }
      }
    }

    // ---- 6: idle paid capacity -------------------------------------
    const idle = design.sites.filter((x) => {
      const def = SITE_TYPES[x.type];
      if (!def.fixedCostWk || x.type === "factory") return false;
      return !res.lanes.some((l) => (l.a === x.id || l.b === x.id) && l.flowTWk > 0);
    });
    if (idle.length) {
      s("medium",
        idle.length + " facilit" + (idle.length > 1 ? "ies carry" : "y carries") + " zero flow but full fixed cost (" +
          idle.reduce((a, x) => a + SITE_TYPES[x.type].fixedCostWk, 0) + " EUR/wk).",
        "Fixed-cost discipline: a facility earns its keep through flow; an idle node is pure overhead in the weekly P&L.",
        "Connect " + (idle.length > 1 ? "them" : "it") + " with lanes that actually route demand, or delete " + (idle.length > 1 ? "them" : "it") + ".");
    }

    // ---- all-clear -------------------------------------------------
    if (res.score.pass && out.every((h) => h.severity === "low" || h.severity === "good")) {
      s("good",
        "All level thresholds met: " + res.score.total + "/100 (" + res.score.stars + " star" + (res.score.stars === 1 ? "" : "s") + ").",
        "Cost, service and CO2 pull against each other; a passing design balances all three.",
        "Chase a higher score: check lane utilizations, the push/pull fit and whether pooling or a cross-dock still has something to give.");
    }

    const RANK = { high: 0, medium: 1, low: 2, good: 3 };
    out.forEach((h, i) => (h._i = i));
    out.sort((a, b) => RANK[a.severity] - RANK[b.severity] || a._i - b._i);
    out.forEach((h) => delete h._i);
    return out.slice(0, 4);
  }

  /* ------------------------------------------------------------------
   * Export: browser global (classic script) AND Node module, so the
   * verification harness runs the exact same code the app ships.
   * ------------------------------------------------------------------ */
  const api = {
    PARAMS, MODES, SITE_TYPES, LEVELS, SCORE_WEIGHTS,
    mulberry32, levelById, levelZoneDemand,
    newDesign, addSite, addLane, removeSite, removeLane, siteById, distKm,
    referenceDesign, evaluate, advise, starsFor,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) (root.LSP = root.LSP || {}).engine = api;
})(typeof window !== "undefined" ? window : null);
