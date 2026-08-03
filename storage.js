/* =====================================================================
 * Logistics Flow Studio - WarehouseTwin
 * storage.js - PHYSICAL storage locations, slotting, occupancy + retrieval
 * ---------------------------------------------------------------------
 * P4 - storage & inventory. Connects the real-data SKU master
 * (wmsdata.js) to the PHYSICAL storage locations derived from the placed
 * racking/storage elements, so pick behaviour reflects where stock is
 * actually put. This is the missing piece toward the Siemens reference,
 * which has explicit storage plus an `M_retrieveSKUfromStorage` method:
 *
 *   - buildLocations(layout) : each storage/racking element yields N slot
 *     LOCATIONS (from its documented capacity), each with a world
 *     position and a distance to the I/O point (the SAME dock-centroid
 *     the pick-travel sim anchors to, via WT.sim.ioPointOf) - so "close
 *     to the docks / pick face" means the same thing everywhere.
 *   - assign(locations, skuMaster, {strategy, seed}) : slot SKUs into
 *     locations by ABC / velocity, fast movers into the nearest ("golden
 *     zone") locations. REUSES the app's strategy set (domain STRATEGIES)
 *     and mirrors the sim's slotting discipline (random -> shuffled;
 *     abc/zone/batch/wave -> nearest-first by popularity). Deterministic.
 *   - occupancy(assignment) : fill %, per-rack + per-type occupancy, and
 *     an HONEST count of UNPLACED SKUs when demand exceeds capacity
 *     (overflow is reported, never silently dropped).
 *   - locationOf(sku) / retrieve(...) : the retrieval seam - returns the
 *     assigned location so the sim / flowsim can compute REAL travel from
 *     storage -> pick (mirrors Siemens M_retrieveSKUfromStorage). Wired
 *     into flowsim's storage->picking leg when an assignment exists; with
 *     none, flowsim is byte-identical to before (guarded by a test).
 *   - stats() : placement QUALITY (A-class avg distance vs overall, % of
 *     A-class in the golden zone), occupancy, and overflow flags.
 *
 * HONESTY (load-bearing, mirrored in the UI + README):
 *   - Data is SYNTHETIC unless the SKU master was imported (then it is the
 *     user's own, on-device). This is a TRANSPARENT slotting HEURISTIC
 *     (the app's ABC / velocity rule), NOT a measurement, NOT an
 *     optimisation proof and NOT a certification.
 *   - One SKU occupies ONE storage location here (a documented teaching
 *     simplification: it keeps the occupancy maths crisp - placed =
 *     min(SKUs, capacity), the remainder are reported as overflow).
 *   - Distances are the straight-line world distance to the pick-travel
 *     I/O point; they rank placements, they are not a routed path length.
 *
 * PURE + DETERMINISTIC: same (layout, skuMaster, strategy, seed) ->
 * byte-identical locations + assignment. All randomness flows through a
 * seeded mulberry32 (no Date, no Math.random). Verified in
 * verify_storage.js.
 *
 * Classic script attaching to the global `WT` namespace (works from
 * file:// too). Depends on domain.js (WT.domain) and, when present,
 * simulation.js (WT.sim.ioPointOf). No frameworks, no build step, offline.
 * ===================================================================== */
(function () {
  "use strict";
  const WT = (window.WT = window.WT || {});
  const D = WT.domain;

  /* ------------------------------------------------------------------
   * Transparent teaching parameters. All documented above.
   * ------------------------------------------------------------------ */
  const PARAMS = {
    defaultStrategy: "abc",
    defaultSeed: 42,
    // The "golden zone": the closest share of LOCATIONS to the I/O point
    // (near the docks / pick face). Fast movers belong here. 0.2 mirrors
    // the ABC A-class share (domain STRATEGIES abc: A ~= top 20%).
    goldenZoneFraction: 0.2,
    // One SKU occupies one storage location (documented simplification -
    // keeps occupancy exact: placed == min(SKUs, capacity)).
    slotsPerSku: 1,
  };

  const SYNTHETIC_LABEL =
    "SYNTHETIC storage & inventory model - a transparent teaching layer. " +
    "Slotting is the app's ABC / velocity HEURISTIC (fast movers nearest the " +
    "I/O 'golden zone'), NOT a measurement of any real placement, NOT an " +
    "optimisation proof and NOT a certification. One SKU occupies one location (a documented " +
    "simplification); demand beyond physical capacity is reported as OVERFLOW, " +
    "never silently dropped. When the SKU master was imported it is your own " +
    "data and stays on this device - nothing is uploaded.";

  /* ---- Seeded PRNG: mulberry32 (same family as the rest of the app) -- */
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

  // Deterministic Fisher-Yates shuffle (seeded).
  function shuffle(rng, arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // Stable string comparison for deterministic tie-breaks.
  function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

  /* ------------------------------------------------------------------
   * I/O point: reuse the EXACT anchor the pick-travel sim uses so
   * "distance to the docks" means the same thing across the app. Falls
   * back to a local copy (dock-out centroid -> dock-in -> canvas centre)
   * when simulation.js is not loaded (so this module tests standalone).
   * ------------------------------------------------------------------ */
  function ioPointOf(elements, gridW, gridH, cell) {
    if (WT.sim && typeof WT.sim.ioPointOf === "function") {
      return WT.sim.ioPointOf(elements, gridW, gridH, cell);
    }
    const pick = (type) => elements.filter((e) => e.type === type);
    let ref = pick("dock-out");
    if (ref.length === 0) ref = pick("dock-in");
    if (ref.length === 0) {
      return { x: (gridW * cell) / 2, y: (gridH * cell) / 2, source: "canvas-centre" };
    }
    let sx = 0, sy = 0;
    for (const e of ref) { sx += (e.x + e.w / 2) * cell; sy += (e.y + e.d / 2) * cell; }
    return { x: sx / ref.length, y: sy / ref.length, source: ref[0].type === "dock-out" ? "outbound-dock" : "inbound-dock" };
  }

  function elementCapacity(el) {
    if (D && typeof D.elementCapacity === "function") return D.elementCapacity(el);
    return 0;
  }
  function elementLabel(type) {
    const def = (D && D.ELEMENTS && D.ELEMENTS[type]) || null;
    return def ? def.label : type;
  }

  /* ==================================================================
   * buildLocations(layout) -> the concrete storage LOCATIONS.
   *
   * Every storage/racking element yields elementCapacity(el) slot
   * locations. Each location's world position mirrors the sim's buildSlots
   * grid (a cols x rows split of the element footprint) so a location
   * coincides with a sim pallet slot; its distance is the straight-line
   * distance to the I/O point (ioPointOf). Returns an ARRAY (so .length
   * == summed racking capacity) with attached metadata (io, cell,
   * capacityTotal, goldenThresholdM, racks).
   * ================================================================== */
  function buildLocations(layout) {
    const els = (layout && layout.elements) || [];
    const cell = (layout && layout.cell) || (D ? D.METRES_PER_CELL : 1) || 1;
    const gridW = (layout && layout.gridW) || 40;
    const gridH = (layout && layout.gridH) || 24;
    const io = ioPointOf(els, gridW, gridH, cell);

    const locations = [];
    const racks = [];
    els.forEach((el, elIndex) => {
      const cap = elementCapacity(el);
      if (cap <= 0) return;
      const elId = el.id != null ? el.id : "el-" + elIndex;
      const x0 = el.x * cell, y0 = el.y * cell;
      const wM = el.w * cell, dM = el.d * cell;
      const cols = Math.max(1, Math.round(Math.sqrt(cap * (wM / Math.max(dM, 0.001)))));
      const rows = Math.ceil(cap / cols);
      racks.push({ elId: elId, type: el.type, label: elementLabel(el.type), capacity: cap });
      for (let i = 0; i < cap; i++) {
        const cx = x0 + ((i % cols) + 0.5) * (wM / cols);
        const cy = y0 + ((Math.floor(i / cols) % rows) + 0.5) * (dM / rows);
        const dist = Math.hypot(cx - io.x, cy - io.y);
        locations.push({
          id: elId + "#" + i,
          elId: elId,
          type: el.type,
          x: cx, y: cy,          // world metres
          cx: cx / cell, cy: cy / cell, // world cells (flowsim units)
          dist: dist,            // straight-line metres to the I/O point
          golden: false,         // set below
        });
      }
    });

    // Golden zone: the closest goldenZoneFraction of locations to the I/O.
    const n = locations.length;
    const goldenCount = n ? Math.max(1, Math.round(PARAMS.goldenZoneFraction * n)) : 0;
    let goldenThresholdM = 0;
    if (n) {
      const ranked = locations
        .map((l) => l)
        .sort((a, b) => (a.dist - b.dist) || cmp(a.id, b.id));
      const goldenIds = {};
      for (let i = 0; i < goldenCount; i++) goldenIds[ranked[i].id] = true;
      goldenThresholdM = ranked[Math.max(0, goldenCount - 1)].dist;
      for (const l of locations) l.golden = !!goldenIds[l.id];
    }

    locations.io = io;
    locations.cell = cell;
    locations.gridW = gridW;
    locations.gridH = gridH;
    locations.capacityTotal = n;
    locations.goldenCount = goldenCount;
    locations.goldenThresholdM = goldenThresholdM;
    locations.racks = racks;
    return locations;
  }

  /* ==================================================================
   * assign(locations, skuMaster, {strategy, seed}) -> assignment.
   *
   * SKUs are ranked by velocity DESC (most popular first, deterministic
   * tie-break by sku id). Locations are ordered by strategy - random ->
   * seeded shuffle; every other strategy (abc/zone/batch/wave) -> nearest
   * first - then zipped: the i-th most popular SKU takes the i-th ordered
   * location, so fast movers land in the golden zone. One SKU per location
   * (PARAMS.slotsPerSku); SKUs beyond capacity are reported as UNPLACED
   * (overflow), never dropped.
   * ================================================================== */
  function assign(locations, skuMaster, opts) {
    const o = opts || {};
    const strategy = o.strategy || PARAMS.defaultStrategy;
    const seed = (o.seed != null ? o.seed : PARAMS.defaultSeed) >>> 0;
    const locs = Array.isArray(locations) ? locations : [];
    const cell = locs.cell || 1;
    const rng = mulberry32((seed ^ 0x510c0de5) >>> 0);

    // SKUs, most popular first (velocity desc; stable tie-break by sku).
    const skus = (skuMaster || []).slice().sort(
      (a, b) => ((Number(b.velocity) || 0) - (Number(a.velocity) || 0)) || cmp(String(a.sku), String(b.sku))
    );

    // Location order under the strategy.
    let ordered;
    if (strategy === "random") {
      ordered = shuffle(rng, locs);
    } else {
      ordered = locs.slice().sort((a, b) => (a.dist - b.dist) || cmp(a.id, b.id));
    }

    const capacity = ordered.length;
    const placements = [];
    const bySku = {};
    const byLoc = {};
    const unplaced = [];
    for (let i = 0; i < skus.length; i++) {
      const s = skus[i];
      if (i < capacity) {
        const loc = ordered[i];
        const rec = {
          sku: s.sku,
          abcClass: s.abcClass || "C",
          velocity: Number(s.velocity) || 0,
          locId: loc.id,
          elId: loc.elId,
          type: loc.type,
          x: loc.x, y: loc.y,
          cx: loc.cx, cy: loc.cy,
          dist: loc.dist,
          golden: !!loc.golden,
        };
        placements.push(rec);
        bySku[String(s.sku)] = rec;
        byLoc[loc.id] = rec;
      } else {
        unplaced.push({ sku: s.sku, abcClass: s.abcClass || "C", velocity: Number(s.velocity) || 0 });
      }
    }

    return {
      kind: "wt-storage-assignment",
      strategy: strategy,
      seed: seed,
      cell: cell,
      gridW: locs.gridW || 40,
      gridH: locs.gridH || 24,
      io: locs.io || null,
      capacityTotal: capacity,
      goldenCount: locs.goldenCount || 0,
      goldenThresholdM: locs.goldenThresholdM || 0,
      skuCount: skus.length,
      placedCount: placements.length,
      unplacedCount: unplaced.length,
      overflow: unplaced.length > 0,
      racks: (locs.racks || []).map((r) => ({ elId: r.elId, type: r.type, label: r.label, capacity: r.capacity })),
      placements: placements,
      bySku: bySku,
      byLoc: byLoc,
      unplaced: unplaced,
      dataLabel: SYNTHETIC_LABEL,
    };
  }

  /* ==================================================================
   * occupancy(assignment) -> fill %, per-rack + per-type occupancy,
   * golden-zone occupancy, and the honest unplaced/overflow report.
   * ================================================================== */
  function occupancy(assignment) {
    const a = assignment || active.assignment;
    if (!a) return null;
    const capacity = a.capacityTotal || 0;
    const placed = a.placedCount || 0;

    // Per-rack placed counts.
    const rackPlaced = {};
    const rackDistSum = {};
    let goldenPlaced = 0;
    for (const p of a.placements) {
      rackPlaced[p.elId] = (rackPlaced[p.elId] || 0) + 1;
      rackDistSum[p.elId] = (rackDistSum[p.elId] || 0) + p.dist;
      if (p.golden) goldenPlaced++;
    }
    const byRack = (a.racks || []).map((r) => {
      const pl = rackPlaced[r.elId] || 0;
      return {
        elId: r.elId, type: r.type, label: r.label,
        capacity: r.capacity, placed: pl,
        fillPct: r.capacity > 0 ? (pl / r.capacity) * 100 : 0,
        avgDistM: pl > 0 ? rackDistSum[r.elId] / pl : 0,
      };
    });

    // Per storage TYPE roll-up.
    const byType = {};
    for (const r of byRack) {
      const t = byType[r.type] || (byType[r.type] = { type: r.type, label: r.label, capacity: 0, placed: 0, fillPct: 0 });
      t.capacity += r.capacity;
      t.placed += r.placed;
    }
    for (const k in byType) byType[k].fillPct = byType[k].capacity > 0 ? (byType[k].placed / byType[k].capacity) * 100 : 0;

    return {
      capacityTotal: capacity,
      placed: placed,
      fillPct: capacity > 0 ? (placed / capacity) * 100 : 0,
      unplacedCount: a.unplacedCount || 0,
      overflow: !!a.overflow,
      goldenZone: {
        capacity: a.goldenCount || 0,
        placed: goldenPlaced,
        fillPct: (a.goldenCount || 0) > 0 ? (goldenPlaced / a.goldenCount) * 100 : 0,
      },
      byRack: byRack,
      byType: byType,
    };
  }

  /* ==================================================================
   * locationOf(sku) / locationOf(assignment, sku) - the RETRIEVAL seam
   * (mirrors Siemens M_retrieveSKUfromStorage). Returns the assigned
   * location record for a placed SKU, or null when unplaced / unknown.
   * With a single string arg it reads the ACTIVE assignment.
   * ================================================================== */
  function locationOf(a, b) {
    let assignment, sku;
    if (typeof a === "string") { assignment = active.assignment; sku = a; }
    else { assignment = a || active.assignment; sku = b; }
    if (!assignment || sku == null) return null;
    return assignment.bySku[String(sku)] || null;
  }

  // retrieve(assignment, sku) -> { found, sku, location, distToIoM,
  // travelM }. travel is the round trip storage <-> I/O (out-and-back),
  // the honest analogue of retrieving a unit and bringing it to the pick
  // face; distToIoM is the one-way straight-line distance.
  function retrieve(a, b) {
    let assignment, sku;
    if (typeof a === "string") { assignment = active.assignment; sku = a; }
    else { assignment = a || active.assignment; sku = b; }
    const loc = locationOf(assignment, sku);
    if (!loc) return { found: false, sku: sku, location: null, distToIoM: null, travelM: null };
    return { found: true, sku: loc.sku, location: loc, distToIoM: loc.dist, travelM: loc.dist * 2 };
  }

  /* ------------------------------------------------------------------
   * retrievalAnchor(assignment) -> the velocity-weighted centroid of the
   * placed locations, in world CELLS (flowsim units). This is where the
   * "average" pick actually comes from, given the slotting - flowsim uses
   * it as the storage waypoint so the retrieval leg reflects real
   * placement (fast movers pull the anchor toward the golden zone).
   * Returns null when nothing is placed (flowsim keeps its plain centroid).
   * ------------------------------------------------------------------ */
  function retrievalAnchor(assignment) {
    const a = assignment || active.assignment;
    if (!a || !a.placements || !a.placements.length) return null;
    let sw = 0, sx = 0, sy = 0;
    for (const p of a.placements) {
      const w = Math.max(0, p.velocity) || 0;
      sw += w; sx += w * p.cx; sy += w * p.cy;
    }
    if (sw <= 0) {
      // All-zero velocity: fall back to the plain placement centroid.
      let n = 0; sx = 0; sy = 0;
      for (const p of a.placements) { sx += p.cx; sy += p.cy; n++; }
      return n ? { x: sx / n, y: sy / n } : null;
    }
    return { x: sx / sw, y: sy / sw };
  }

  /* ==================================================================
   * stats(assignment) -> placement QUALITY + occupancy + honest flags.
   *   - avgDistAllM / avgDistAClassM / avgDistCClassM
   *   - goldenEffect: A-class avg distance < overall avg (the ABC win)
   *   - aClassInGoldenPct: % of placed A-class SKUs in the golden zone
   *   - flags: overflow (SKUs > capacity), goldenZoneOverflow (A-class
   *     could not all get a golden slot)
   * ================================================================== */
  function stats(assignment) {
    const a = assignment || active.assignment;
    if (!a) return null;
    const occ = occupancy(a);

    let sumAll = 0, nAll = 0;
    let sumA = 0, nA = 0, aGolden = 0;
    let sumC = 0, nC = 0;
    for (const p of a.placements) {
      sumAll += p.dist; nAll++;
      if (p.abcClass === "A") { sumA += p.dist; nA++; if (p.golden) aGolden++; }
      else if (p.abcClass === "C") { sumC += p.dist; nC++; }
    }
    const avgAll = nAll ? sumAll / nAll : 0;
    const avgA = nA ? sumA / nA : 0;
    const avgC = nC ? sumC / nC : 0;

    // A-class that could not get a golden slot (golden capacity < A count).
    const goldenZoneOverflow = nA > (a.goldenCount || 0);

    return {
      dataLabel: SYNTHETIC_LABEL,
      strategy: a.strategy,
      seed: a.seed,
      capacityTotal: a.capacityTotal,
      skuCount: a.skuCount,
      placedCount: a.placedCount,
      unplacedCount: a.unplacedCount,
      overflow: !!a.overflow,
      fillPct: occ ? occ.fillPct : 0,
      golden: {
        fraction: PARAMS.goldenZoneFraction,
        thresholdM: a.goldenThresholdM,
        count: a.goldenCount,
        aClassPct: nA ? (aGolden / nA) * 100 : 0,
      },
      placement: {
        avgDistAllM: avgAll,
        avgDistAClassM: avgA,
        avgDistCClassM: avgC,
        aClassInGoldenPct: nA ? (aGolden / nA) * 100 : 0,
        // The golden-zone effect: fast movers are, on average, closer than
        // the floor as a whole. (Always true for the abc family, by design;
        // false for random slotting - that is the point of the KPI.)
        goldenEffect: nA > 0 && avgA < avgAll,
        aCount: nA, cCount: nC,
      },
      occupancy: occ,
      flags: {
        overflow: !!a.overflow,
        goldenZoneOverflow: goldenZoneOverflow,
      },
    };
  }

  /* ------------------------------------------------------------------
   * The ACTIVE store: the currently-applied assignment the app + the
   * flowsim retrieval leg read. build()/load() set it; clear() empties it.
   * The pure functions above still accept an explicit assignment.
   * ------------------------------------------------------------------ */
  const active = { locations: null, assignment: null, source: "none" };

  // build(layout, skuMaster, {strategy, seed, source}) -> assignment, and
  // store it as active (the convenience path the panel uses).
  function build(layout, skuMaster, opts) {
    const o = opts || {};
    const locations = buildLocations(layout);
    const assignment = assign(locations, skuMaster, o);
    active.locations = locations;
    active.assignment = assignment;
    active.source = o.source || "synthetic";
    return assignment;
  }
  function load(assignment, source) {
    active.assignment = assignment || null;
    active.locations = null;
    active.source = source || "synthetic";
    return active.assignment;
  }
  function clear() { active.locations = null; active.assignment = null; active.source = "none"; }
  function isAssigned() { return !!active.assignment; }
  function current() { return active.assignment; }

  WT.storage = {
    // required API
    buildLocations: buildLocations,
    assign: assign,
    occupancy: occupancy,
    locationOf: locationOf,
    stats: stats,
    PARAMS: PARAMS,
    // retrieval + wiring helpers
    retrieve: retrieve,
    retrievalAnchor: retrievalAnchor,
    // active-store management (used by the app)
    build: build,
    load: load,
    clear: clear,
    isAssigned: isAssigned,
    current: current,
    // honesty
    SYNTHETIC_LABEL: SYNTHETIC_LABEL,
  };
})();
