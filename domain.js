/* =====================================================================
 * Logistics Flow Studio - WarehouseTwin
 * domain.js - the honest domain model (P1 foundation)
 * ---------------------------------------------------------------------
 * Everything here is a SYNTHETIC, SIMPLIFIED model of real warehouse
 * logistics. Dimensions and characteristics are drawn from public
 * standards and industry references (cited in comments below and in
 * docs/DOMAIN_NOTES.md). Cost/capacity/selectivity figures are
 * relative, order-of-magnitude teaching values - NOT vendor specs and
 * NOT a certification of anything.
 *
 * No frameworks, no build step. Attaches to the global `WT` namespace
 * so the app works when opened directly from disk (file://) as well as
 * over http. Classic script (not an ES module) on purpose.
 * ===================================================================== */
(function () {
  "use strict";
  const WT = (window.WT = window.WT || {});

  /* ------------------------------------------------------------------
   * Units. One grid cell = 1.0 metre. The whole simulator works in
   * metres so numbers stay human-readable.
   * ------------------------------------------------------------------ */
  const METRES_PER_CELL = 1.0;

  /* ------------------------------------------------------------------
   * EURO PALLETS (EPAL / UIC 435-2). Dimensions in millimetres.
   * Sources:
   *   - EPAL (European Pallet Association) pallet range.
   *   - UIC 435-2 (International Union of Railways) load-unit standard.
   *   - Wikipedia "EUR-pallet" summary table (cross-checked).
   * EUR1/2/3/6 are well-established EPAL sizes. EUR4/EUR5 are far less
   * standardised; the values below are commonly quoted by pallet
   * suppliers but vary by source - flagged `standardised:false`.
   * ------------------------------------------------------------------ */
  const PALLETS = [
    // EUR1 = EPAL 1, the classic "Euro pallet". 1200 x 800 mm, ~25 kg.
    { id: "EUR1", label: "EUR1 / EPAL 1", length: 1200, width: 800, mass: 25, standardised: true,
      note: "The classic Euro pallet (EPAL 1). Most common in EU FMCG." },
    // EUR2 = EPAL 2 (a.k.a. UK / industrial). 1200 x 1000 mm.
    { id: "EUR2", label: "EUR2 / EPAL 2", length: 1200, width: 1000, mass: 33, standardised: true,
      note: "1200x1000 mm. Common for heavier/industrial loads." },
    // EUR3 = EPAL 3. 1000 x 1200 mm (EUR2 rotated footprint family).
    { id: "EUR3", label: "EUR3 / EPAL 3", length: 1000, width: 1200, mass: 29, standardised: true,
      note: "1000x1200 mm industrial pallet." },
    // EUR4 - less standardised; ~1300 x 1100 mm quoted by suppliers.
    { id: "EUR4", label: "EUR4 (non-EPAL)", length: 1300, width: 1100, mass: 30, standardised: false,
      note: "~1300x1100 mm. Not an official EPAL/UIC size; dimensions vary by source." },
    // EUR5 - less standardised; ~1140 x 760 mm quoted by suppliers.
    { id: "EUR5", label: "EUR5 (non-EPAL)", length: 1140, width: 760, mass: 20, standardised: false,
      note: "~1140x760 mm. Not an official EPAL/UIC size; dimensions vary by source." },
    // EUR6 = EPAL 6, the half pallet. 800 x 600 mm.
    { id: "EUR6", label: "EUR6 / EPAL 6", length: 800, width: 600, mass: 10, standardised: true,
      note: "Half pallet (800x600 mm). Used for display/retail-ready units." },
  ];

  /* ------------------------------------------------------------------
   * CARTON / BOX / TOTE TYPES (P3 expanded catalogue).
   * Synthetic but plausible EU unit-load sizes (mm). The 600x400 and
   * 400x300 modules tile cleanly onto the 1200x800 EUR1 pallet (the
   * "Euro-modular" footprint family). Masses are assumptions. Totes are
   * reusable plastic containers (KLT-style small-load carriers in
   * spirit) - `tote:true`; original generic sizes, no vendor spec.
   * ------------------------------------------------------------------ */
  const BOXES = [
    { id: "C05", label: "Mini carton", length: 150, width: 100, height: 100, mass: 0.5,
      note: "Small-parts mailer size." },
    { id: "C10", label: "Small carton", length: 200, width: 150, height: 120, mass: 2,
      note: "Common e-commerce small box." },
    { id: "C15", label: "Flat carton", length: 350, width: 250, height: 150, mass: 4,
      note: "Document/flat-goods carton." },
    { id: "C20", label: "Medium carton", length: 400, width: 300, height: 250, mass: 8,
      note: "Euro-modular 400x300 footprint." },
    { id: "C30", label: "Large carton", length: 600, width: 400, height: 300, mass: 15,
      note: "Euro-modular 600x400 footprint." },
    { id: "C40", label: "Bulk carton", length: 600, width: 400, height: 400, mass: 18,
      note: "Tall 600x400; heavy, bottom layers only in practice." },
    { id: "EURO-CASE", label: "Euro case (400x300)", length: 400, width: 300, height: 200, mass: 6,
      note: "Standard Euro-modular case." },
    { id: "TOTE-64", label: "Tote 600x400", length: 600, width: 400, height: 320, mass: 12, tote: true,
      note: "Reusable plastic tote, Euro-modular footprint. Stackable." },
    { id: "TOTE-43", label: "Tote 400x300", length: 400, width: 300, height: 220, mass: 6, tote: true,
      note: "Reusable small-load tote (KLT-style footprint)." },
    { id: "TOTE-HALF", label: "Half tote 300x200", length: 300, width: 200, height: 170, mass: 2.5, tote: true,
      note: "Half-module tote for small parts / kitting." },
  ];

  /* ------------------------------------------------------------------
   * Cartons-per-pallet math. How many cartons of a given type fit on a
   * given EUR pallet: best-of-two-orientations per layer x layers that
   * fit in the usable load height. Load height default 1200 mm (a
   * conservative teaching assumption for a ~1.35 m max load minus
   * unevenness; documented in DOMAIN_NOTES.md). Interlocking/overhang
   * patterns are NOT modelled - this is the simple rectangular fit.
   * ------------------------------------------------------------------ */
  function cartonsPerPallet(boxId, palletId, loadHeightMm) {
    const box = BOXES.find((b) => b.id === boxId) || BOXES[0];
    const pal = palletById(palletId);
    const H = loadHeightMm || 1200;
    const a = Math.floor(pal.length / box.length) * Math.floor(pal.width / box.width);
    const b = Math.floor(pal.length / box.width) * Math.floor(pal.width / box.length);
    const perLayer = Math.max(a, b);
    const layers = Math.max(1, Math.floor(H / box.height));
    return { perLayer, layers, perPallet: perLayer * layers };
  }

  /* ------------------------------------------------------------------
   * PLACEABLE ELEMENTS (the P1 palette).
   *   category "storage" -> contributes pallet positions to the sim.
   *   category "flow"    -> docks, staging, conveyor, push/pull nodes.
   *
   * Footprint is given in grid CELLS (metres). `resizable` elements can
   * have their footprint edited in the properties panel.
   *
   * Storage characteristics (relative teaching values):
   *   density     = pallet positions per m^2 of the element footprint,
   *                 accounting roughly for beam levels & pallet gaps.
   *                 (This footprint is the racking itself; the aisle it
   *                 needs is a separate placed gap - see aisle rule.)
   *   selectivity = fraction of stored pallets directly accessible
   *                 without moving another pallet (1.0 = every pallet).
   *   rotation    = achievable stock rotation (FIFO / LIFO).
   *   costIndex   = relative capital cost per position (1 = cheapest).
   *
   * P3 sim-relevant characteristics (all synthetic, documented in
   * docs/DOMAIN_NOTES.md):
   *   handlingDeltaSec = seconds ADDED to (or, if negative, saved from)
   *                 the base per-line handling time when picking from
   *                 this system. Deep-lane/low-selectivity systems cost
   *                 extra repositioning time; flow-rack pick faces
   *                 present goods and save time.
   *   goodsToPerson + cycleSec = the system delivers the load to the
   *                 operator (AS/RS crane, shuttle): a pick line from it
   *                 adds a machine cycle time instead of walking travel.
   *   pickFace    = carton-level pick-face system; capacity is stated
   *                 in PALLET-EQUIVALENT positions.
   * Sources: general MHE/racking literature; see DOMAIN_NOTES.md. These
   * are illustrative, not quotations.
   * ------------------------------------------------------------------ */
  const ELEMENTS = {
    "selective-racking": {
      id: "selective-racking", label: "Selective racking", category: "storage",
      w: 6, d: 1, color: "#3b82f6", resizable: true,
      density: 2.4, levels: 3, selectivity: 1.0, rotation: "FIFO/LIFO", costIndex: 3,
      desc: "Single-deep adjustable pallet racking. Every pallet directly accessible (100% selective). Needs a working aisle in front. Good FIFO.",
    },
    "block-stack": {
      id: "block-stack", label: "Block-stack zone", category: "storage",
      w: 4, d: 4, color: "#8b5cf6", resizable: true,
      density: 3.2, levels: 3, selectivity: 0.35, rotation: "LIFO", costIndex: 1,
      handlingDeltaSec: 8,
      desc: "Floor block stacking, no racking. Highest floor density and lowest cost, but LIFO and low selectivity (honeycombing losses). +8 s/line repositioning in the sim.",
    },
    "drive-in": {
      id: "drive-in", label: "Drive-in racking", category: "storage",
      w: 4, d: 4, color: "#b45309", resizable: true,
      density: 3.0, levels: 3, selectivity: 0.25, rotation: "LIFO", costIndex: 2,
      handlingDeltaSec: 10,
      desc: "Deep-lane racking the truck drives into. High density, low cost per position, but LIFO and poor selectivity (~25%): reaching a specific pallet often means digging. +10 s/line in the sim. Best for few SKUs in volume.",
    },
    "double-deep": {
      id: "double-deep", label: "Double-deep racking", category: "storage",
      w: 6, d: 2, color: "#0369a1", resizable: true,
      density: 2.9, levels: 3, selectivity: 0.5, rotation: "FIFO within pairs", costIndex: 4,
      handlingDeltaSec: 6,
      desc: "Two pallets deep; needs a telescopic-fork reach truck. ~20% denser than selective, but only the front pallet of each pair is directly accessible (~50% selectivity). +6 s/line in the sim.",
    },
    "push-back": {
      id: "push-back", label: "Push-back racking", category: "storage",
      w: 4, d: 3, color: "#c026d3", resizable: true,
      density: 3.0, levels: 3, selectivity: 0.4, rotation: "LIFO", costIndex: 5,
      handlingDeltaSec: 4,
      desc: "Nested carts on inclined rails, loaded and picked from the same aisle face. Dense, fast face access - but strictly LIFO per lane. +4 s/line in the sim. Avoid for FIFO-critical (shelf-life/batch) SKUs.",
    },
    "pallet-flow": {
      id: "pallet-flow", label: "Pallet-flow racking", category: "storage",
      w: 4, d: 4, color: "#15803d", resizable: true,
      density: 3.4, levels: 3, selectivity: 0.45, rotation: "FIFO", costIndex: 7,
      handlingDeltaSec: -2,
      desc: "Gravity roller lanes: load the back, pick the front - true FIFO. The front pallet is always presented at the pick face (-2 s/line in the sim). High density; higher capital cost; great for high-velocity SKUs.",
    },
    "carton-flow": {
      id: "carton-flow", label: "Carton-flow pick faces", category: "storage",
      w: 3, d: 1, color: "#ea580c", resizable: true, pickFace: true,
      density: 1.6, levels: 4, selectivity: 1.0, rotation: "FIFO", costIndex: 4,
      handlingDeltaSec: -4,
      desc: "Inclined roller shelves presenting cartons at ergonomic pick faces, replenished from the back - FIFO at carton level. Fastest manual picking in the model (-4 s/line). Capacity in pallet-equivalents.",
    },
    "mobile-racking": {
      id: "mobile-racking", label: "Mobile (compact) racking", category: "storage",
      w: 6, d: 4, color: "#4338ca", resizable: true,
      density: 3.8, levels: 4, selectivity: 1.0, rotation: "FIFO/LIFO", costIndex: 8,
      handlingDeltaSec: 15,
      desc: "Racking on powered mobile bases sharing ONE opening aisle. Near block-stack density with 100% selectivity - but you wait for the aisle to open (+15 s/line amortised in the sim). Suits slow movers / cold storage.",
    },
    "cantilever": {
      id: "cantilever", label: "Cantilever racking", category: "storage",
      w: 6, d: 2, color: "#57534e", resizable: true, longGoods: true,
      density: 0.8, levels: 3, selectivity: 1.0, rotation: "FIFO/LIFO", costIndex: 4,
      handlingDeltaSec: 6,
      desc: "Arms on columns, no front uprights - for long goods (pipes, profiles, timber). Low position density in pallet-equivalents; awkward loads (+6 s/line in the sim, usually side-loaded).",
    },
    "asrs": {
      id: "asrs", label: "AS/RS crane aisle", category: "storage",
      w: 8, d: 2, color: "#dc2626", resizable: true,
      density: 5.0, levels: 10, selectivity: 1.0, rotation: "FIFO", costIndex: 10,
      goodsToPerson: true, cycleSec: 45,
      desc: "Automated high-bay aisle: a stacker crane serves double-sided racking. Goods-to-person: a pick line costs a ~45 s machine cycle instead of walking. Highest density (10+ levels) and highest capital cost. Informed by VDI 3564 high-bay design guidance (not certified).",
    },
    "shuttle": {
      id: "shuttle", label: "Shuttle system", category: "storage",
      w: 6, d: 3, color: "#0891b2", resizable: true,
      density: 4.5, levels: 6, selectivity: 0.9, rotation: "FIFO/LIFO", costIndex: 9,
      goodsToPerson: true, cycleSec: 28,
      desc: "Deep-lane channels served by autonomous shuttle carts + lifts. Goods-to-person (~28 s cycle/line). Denser than AS/RS per channel, per-level throughput scales with shuttle count (simplified to one cycle time here).",
    },
    "mezzanine": {
      id: "mezzanine", label: "Mezzanine pick level", category: "storage",
      w: 6, d: 4, color: "#65a30d", resizable: true, pickFace: true,
      density: 2.0, levels: 2, selectivity: 1.0, rotation: "FIFO", costIndex: 5,
      handlingDeltaSec: 5,
      desc: "A steel platform doubling the floor for small-parts shelving above/below. Capacity in pallet-equivalents across both levels; +5 s/line in the sim for the level change (stairs/lift).",
    },
    "dock-in": {
      id: "dock-in", label: "Dock door (inbound)", category: "flow",
      w: 2, d: 1, color: "#22c55e", resizable: false, io: "receiving",
      desc: "Inbound (receiving) dock door. Goods arrive here and enter the flow.",
    },
    "dock-out": {
      id: "dock-out", label: "Dock door (outbound)", category: "flow",
      w: 2, d: 1, color: "#ef4444", resizable: false, io: "shipping",
      desc: "Outbound (shipping) dock door. Picked orders leave here - it is the default I/O point for pick travel.",
    },
    "staging": {
      id: "staging", label: "Staging area", category: "flow",
      w: 4, d: 2, color: "#f59e0b", resizable: true,
      desc: "Marshalling / staging buffer for inbound put-away or outbound consolidation. Buffer, not long-term storage.",
    },
    "conveyor": {
      id: "conveyor", label: "Conveyor segment", category: "flow",
      w: 6, d: 1, color: "#64748b", resizable: true,
      desc: "Powered conveyor segment for internal material flow between zones.",
    },
    "push-station": {
      id: "push-station", label: "Push station", category: "flow",
      w: 2, d: 2, color: "#0ea5e9", flow: "push",
      desc: "PUSH control point: material is released to storage on a forecast/schedule (make-to-stock replenishment). Can build buffer ahead of demand.",
    },
    "pull-station": {
      id: "pull-station", label: "Pull station", category: "flow",
      w: 2, d: 2, color: "#14b8a6", flow: "pull",
      desc: "PULL control point: material moves only when a downstream order/kanban signal asks for it (make-to-order). Lower inventory, demand-paced.",
    },
    "pack-station": {
      id: "pack-station", label: "Pack station", category: "flow",
      w: 3, d: 2, color: "#eab308", resizable: true, stage: "pack",
      desc: "Packing/consolidation bench between picking and shipping. A complete outbound chain runs storage → (conveyor) → pack → outbound dock.",
    },
  };

  /* ------------------------------------------------------------------
   * SLOTTING + PICKING STRATEGIES.
   * P1: random + ABC 80/20 slotting. ABC uses the Pareto principle: a
   * small share of SKUs drives most of the picks (A: top 20% of SKUs ~
   * 80% of pick lines; B: next 30%; C: last 50%). A-items are slotted
   * closest to the I/O point to cut travel.
   * P3 adds PICKING strategies layered on ABC slotting:
   *   zone  - the floor splits into vertical zones, one resident picker
   *           each; an order's lines are picked in parallel per zone and
   *           consolidated (consolidation overhead per order).
   *   batch - N orders are combined into one picking tour; the tour's
   *           travel is shared, with a downstream sort overhead/order.
   *   wave  - orders are released in timed waves; within a wave, larger
   *           batches are built (more sharing) at the cost of a wave
   *           setup overhead. See DOMAIN_NOTES.md for the simplifications.
   * ------------------------------------------------------------------ */
  const STRATEGIES = {
    random: {
      id: "random", label: "Random slotting",
      desc: "SKUs assigned to free locations at random (seeded). Simple, spreads wear, but ignores demand - more travel. Discrete order picking.",
    },
    abc: {
      id: "abc", label: "ABC 80/20 slotting",
      desc: "Popularity-based: fast-moving A-items nearest the I/O, then B, then C. Cuts average pick travel for the same demand. Discrete order picking.",
      classes: [
        { cls: "A", skuShare: 0.2, note: "~20% of SKUs, ~80% of picks" },
        { cls: "B", skuShare: 0.3, note: "~30% of SKUs, ~15% of picks" },
        { cls: "C", skuShare: 0.5, note: "~50% of SKUs, ~5% of picks" },
      ],
    },
    zone: {
      id: "zone", label: "Zone picking (ABC slotted)",
      desc: "The floor is split into 3 vertical zones with a resident picker each. Lines are picked in parallel per zone, then consolidated (+15 s/order; +10 s more if no conveyor chain to shipping). Short, zone-confined tours.",
    },
    batch: {
      id: "batch", label: "Batch picking (ABC slotted)",
      desc: "4 orders are combined into one tour - travel is shared across the batch, then orders are sorted out downstream (+18 s/order sort). Big travel win for small orders.",
    },
    wave: {
      id: "wave", label: "Wave picking (ABC slotted)",
      desc: "Orders release in timed waves of 20; within a wave, batches of 6 share tours (+18 s/order sort, +90 s setup per wave). Best travel sharing, most coordination overhead.",
    },
  };

  /* ------------------------------------------------------------------
   * AISLE-WIDTH GUIDANCE (informed by DIN 15185).
   * DIN 15185-1 addresses the safety of storage installations and
   * working-aisle design. Different trucks need different aisles:
   *   - Counterbalance truck : ~3.5-4.0 m
   *   - Reach truck          : ~2.7-3.0 m
   *   - VNA (man-up turret)   : ~1.5-1.8 m (wire/rail guided)
   * WarehouseTwin uses a single configurable minimum working-aisle gap
   * between facing racking rows. Default reflects a reach-truck aisle.
   * This is design guidance to keep layouts sane - NOT a compliance
   * check or certification.
   * ------------------------------------------------------------------ */
  const AISLE = {
    defaultMinMetres: 2.9,
    presets: [
      { id: "vna", label: "VNA / man-up turret", metres: 1.8 },
      { id: "reach", label: "Reach truck", metres: 2.9 },
      { id: "counterbalance", label: "Counterbalance", metres: 3.8 },
    ],
    note: "Informed by DIN 15185-1 working-aisle guidance. Design aid only, not a compliance check.",
  };

  /* ------------------------------------------------------------------
   * Helpers.
   * ------------------------------------------------------------------ */
  function elementCapacity(el) {
    // Pallet positions contributed by a storage element instance.
    const def = ELEMENTS[el.type];
    if (!def || def.category !== "storage") return 0;
    const areaM2 = el.w * el.d * METRES_PER_CELL * METRES_PER_CELL;
    return Math.max(0, Math.round(areaM2 * def.density));
  }

  function palletById(id) {
    return PALLETS.find((p) => p.id === id) || PALLETS[0];
  }

  /* ------------------------------------------------------------------
   * Aisle-width guard (informed by DIN 15185). Shared by the canvas
   * editor (app.js), the advisor and the optimizer so there is ONE
   * definition of "too narrow". Returns the storage-element pairs whose
   * facing gap is > 0 but < the minimum working aisle. `gap == 0`
   * (racks back-to-back) is fine; overlap is handled elsewhere.
   * ------------------------------------------------------------------ */
  function aisleViolations(elements, minAisleMetres) {
    const min = minAisleMetres;
    const st = (elements || []).filter((e) => (ELEMENTS[e.type] || {}).category === "storage");
    const out = [];
    for (let i = 0; i < st.length; i++) {
      for (let j = i + 1; j < st.length; j++) {
        const a = st[i], b = st[j];
        const oX = a.x < b.x + b.w && b.x < a.x + a.w;
        const oY = a.y < b.y + b.d && b.y < a.y + a.d;
        if (oX && oY) continue; // overlap, not an aisle
        if (oX && !oY) {
          const gap = Math.max(a.y, b.y) - Math.min(a.y + a.d, b.y + b.d);
          if (gap > 0 && gap * METRES_PER_CELL < min - 1e-6) out.push({ a, b, gapM: gap * METRES_PER_CELL });
        } else if (oY && !oX) {
          const gap = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
          if (gap > 0 && gap * METRES_PER_CELL < min - 1e-6) out.push({ a, b, gapM: gap * METRES_PER_CELL });
        }
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------
   * MATERIAL-FLOW CHAIN ANALYSIS (P3).
   * The logical chain is: dock-in (receive) -> staging -> put-away ->
   * storage -> replenish -> pick -> pack -> dock-out (ship).
   * Elements CONNECT when their footprints touch (share an edge or a
   * corner, i.e. gap 0 on the 1 m grid). Material can pass THROUGH
   * connector elements (conveyor, staging, push/pull stations, pack
   * station); storage systems and dock doors are chain ENDPOINTS.
   *
   * Returns (all deterministic, pure function of the element list):
   *   edges            [{a,b}] element-id pairs that form the chain graph
   *   distToShip       id -> hops to the nearest outbound dock (chain)
   *   distFromReceive  id -> hops from the nearest inbound dock (chain)
   *   outboundCovered  Set of STORAGE ids with a chain path to shipping
   *   inboundCovered   Set of STORAGE ids fed from receiving by chain
   *   warnings         [{code,severity,msg,elId?}] broken-chain findings
   * ------------------------------------------------------------------ */
  const CONNECTOR_TYPES = { conveyor: 1, staging: 1, "push-station": 1, "pull-station": 1, "pack-station": 1 };

  function isConnector(el) { return !!CONNECTOR_TYPES[el.type]; }

  function touching(a, b) {
    return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.d && b.y <= a.y + a.d;
  }

  function analyzeChains(elements) {
    const els = elements || [];
    const byId = {};
    els.forEach((e) => (byId[e.id] = e));
    const isStorageEl = (e) => (ELEMENTS[e.type] || {}).category === "storage";
    const isDock = (e) => e.type === "dock-in" || e.type === "dock-out";

    // Chain edges: touching pairs where at least one side is a connector,
    // plus direct dock<->storage contact (a rack right at the door).
    const edges = [];
    const nbr = {};
    els.forEach((e) => (nbr[e.id] = []));
    for (let i = 0; i < els.length; i++) {
      for (let j = i + 1; j < els.length; j++) {
        const a = els[i], b = els[j];
        if (!touching(a, b)) continue;
        const chainy = isConnector(a) || isConnector(b) ||
          (isDock(a) && isStorageEl(b)) || (isDock(b) && isStorageEl(a));
        if (!chainy) continue;
        edges.push({ a: a.id, b: b.id });
        nbr[a.id].push(b.id);
        nbr[b.id].push(a.id);
      }
    }

    // BFS that only passes THROUGH connectors (endpoints terminate).
    function bfs(sources) {
      const dist = {};
      const q = [];
      sources.forEach((e) => { dist[e.id] = 0; q.push(e.id); });
      while (q.length) {
        const id = q.shift();
        const el = byId[id];
        // May expand from a source itself or any connector node.
        if (dist[id] > 0 && !isConnector(el)) continue;
        for (const nid of nbr[id]) {
          if (dist[nid] === undefined) {
            dist[nid] = dist[id] + 1;
            q.push(nid);
          }
        }
      }
      return dist;
    }

    const distToShip = bfs(els.filter((e) => e.type === "dock-out"));
    const distFromReceive = bfs(els.filter((e) => e.type === "dock-in"));

    const outboundCovered = new Set();
    const inboundCovered = new Set();
    els.forEach((e) => {
      if (!isStorageEl(e)) return;
      if (distToShip[e.id] !== undefined) outboundCovered.add(e.id);
      if (distFromReceive[e.id] !== undefined) inboundCovered.add(e.id);
    });

    // ---- Broken-chain warnings ------------------------------------
    const warnings = [];
    const connectors = els.filter(isConnector);
    const hasDockOut = els.some((e) => e.type === "dock-out");
    const hasDockIn = els.some((e) => e.type === "dock-in");
    const hasStorage = els.some(isStorageEl);
    const at = (e) => `(${e.x}, ${e.y})`;

    if (hasDockOut && hasStorage && connectors.length && outboundCovered.size === 0) {
      warnings.push({
        code: "no-pick-feed", severity: "high",
        msg: "Outbound dock has no connected pick feed - no storage reaches shipping through the chain, so every order is carried manually.",
      });
    }
    if (hasDockIn && hasStorage && connectors.length && inboundCovered.size === 0) {
      warnings.push({
        code: "no-inbound-chain", severity: "medium",
        msg: "Receiving is not chained to any storage - put-away and replenishment run manually (longer pull replenishment lead time in the sim).",
      });
    }
    for (const c of els.filter((e) => e.type === "conveyor")) {
      if (nbr[c.id].length < 2) {
        warnings.push({
          code: "dangling-conveyor", severity: "medium", elId: c.id,
          msg: `Conveyor at ${at(c)} is ${nbr[c.id].length === 0 ? "connected to nothing" : "connected at only one end"} - the flow dead-ends there.`,
        });
      }
    }
    for (const st of els.filter((e) => e.type === "push-station" || e.type === "pull-station")) {
      if (nbr[st.id].length === 0) {
        warnings.push({
          code: "orphan-station", severity: "low", elId: st.id,
          msg: `${ELEMENTS[st.type].label} at ${at(st)} is not connected to any flow - it controls nothing.`,
        });
      }
    }
    if (outboundCovered.size > 0) {
      const packOnPath = els.some((e) => e.type === "pack-station" && distToShip[e.id] !== undefined);
      if (!packOnPath) {
        warnings.push({
          code: "no-pack-step", severity: "low",
          msg: "The pick chain reaches shipping without a pack station - orders ship unconsolidated (add a Pack station before the outbound dock).",
        });
      }
    }

    return {
      edges,
      distToShip,
      distFromReceive,
      outboundCovered,
      inboundCovered,
      inboundConnected: inboundCovered.size > 0,
      outboundConnected: outboundCovered.size > 0,
      warnings,
    };
  }

  /* ------------------------------------------------------------------
   * PRESETS (P3). One-click illustrative layouts.
   * The MRO preset is an INDEPENDENT, ILLUSTRATIVE layout typical of a
   * large industrial MRO (maintenance/repair/operations) parts
   * distributor, drawn from publicly known patterns of that industry
   * segment (very high SKU count, strong 80/20 demand skew, small-parts
   * pick faces, AS/RS + conveyor spine). It is NOT affiliated with,
   * endorsed by, or a depiction of Wuerth or any real company; no real
   * layout, data, or branding is used.
   * ------------------------------------------------------------------ */
  const PRESETS = {
    "mro-distributor": {
      id: "mro-distributor",
      label: "Industrial MRO distributor (illustrative)",
      desc: "A bigger, realistic layout in the style of an industrial MRO parts distributor: three selective rack rows, deep-lane storage (drive-in, push-back, pallet-flow, double-deep), an AS/RS crane aisle + shuttle system, carton-flow and mezzanine small-parts picking, a conveyor spine with push/pull stations, pack station, staging, and paired inbound/outbound docks. Demand is 80/20-skewed. Independent and illustrative, based on public information about this industry segment - not affiliated with or endorsed by Wuerth or any real company.",
      config: {
        seed: 42, strategy: "abc", orders: 300, skuCount: 240,
        demandSkew: 1.15, flowMode: "pull", minAisleMetres: 2.9,
      },
      elements: [
        { type: "dock-in", x: 2, y: 0, w: 2, d: 1 },
        { type: "dock-in", x: 6, y: 0, w: 2, d: 1 },
        { type: "staging", x: 2, y: 1, w: 6, d: 2 },
        { type: "conveyor", x: 4, y: 3, w: 1, d: 3 },
        { type: "selective-racking", x: 2, y: 6, w: 12, d: 1 },
        { type: "selective-racking", x: 2, y: 10, w: 12, d: 1 },
        { type: "selective-racking", x: 2, y: 14, w: 12, d: 1 },
        { type: "conveyor", x: 14, y: 6, w: 1, d: 11 },
        { type: "drive-in", x: 17, y: 6, w: 4, d: 4 },
        { type: "push-back", x: 17, y: 13, w: 4, d: 3 },
        { type: "conveyor", x: 21, y: 6, w: 1, d: 11 },
        { type: "pallet-flow", x: 24, y: 6, w: 4, d: 4 },
        { type: "conveyor", x: 23, y: 10, w: 1, d: 7 },
        { type: "double-deep", x: 24, y: 13, w: 6, d: 2 },
        { type: "asrs", x: 31, y: 6, w: 8, d: 2 },
        { type: "conveyor", x: 32, y: 8, w: 1, d: 9 },
        { type: "shuttle", x: 33, y: 11, w: 6, d: 3 },
        { type: "push-station", x: 10, y: 15, w: 2, d: 2 },
        { type: "pull-station", x: 34, y: 15, w: 2, d: 2 },
        { type: "conveyor", x: 4, y: 17, w: 32, d: 1 },
        { type: "cantilever", x: 2, y: 18, w: 8, d: 2 },
        { type: "conveyor", x: 15, y: 18, w: 1, d: 1 },
        { type: "mezzanine", x: 13, y: 19, w: 6, d: 4 },
        { type: "conveyor", x: 23, y: 18, w: 1, d: 1 },
        { type: "carton-flow", x: 22, y: 19, w: 4, d: 2 },
        { type: "conveyor", x: 31, y: 18, w: 1, d: 3 },
        { type: "staging", x: 27, y: 21, w: 3, d: 2 },
        { type: "pack-station", x: 30, y: 21, w: 3, d: 2 },
        { type: "dock-out", x: 30, y: 23, w: 2, d: 1 },
        { type: "dock-out", x: 32, y: 23, w: 2, d: 1 },
      ],
    },
  };

  WT.domain = {
    METRES_PER_CELL,
    PALLETS,
    BOXES,
    ELEMENTS,
    STRATEGIES,
    AISLE,
    PRESETS,
    elementCapacity,
    palletById,
    cartonsPerPallet,
    aisleViolations,
    analyzeChains,
    isConnector,
    // Palette order shown in the UI (storage first, then flow).
    paletteOrder: [
      "selective-racking", "block-stack", "drive-in", "double-deep",
      "push-back", "pallet-flow", "carton-flow", "mobile-racking",
      "cantilever", "asrs", "shuttle", "mezzanine",
      "dock-in", "dock-out", "staging", "conveyor",
      "push-station", "pull-station", "pack-station",
    ],
  };
})();
