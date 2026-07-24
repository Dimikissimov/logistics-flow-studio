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
   * CARTON / BOX TYPES. Synthetic but plausible EU carton sizes (mm).
   * Used later for pack/case-level flow (P3 depth). In P1 they seed the
   * "cartons per pallet" figure used by the simulation.
   * ------------------------------------------------------------------ */
  const BOXES = [
    { id: "C10", label: "Small carton", length: 200, width: 150, height: 120, mass: 2 },
    { id: "C20", label: "Medium carton", length: 400, width: 300, height: 250, mass: 8 },
    { id: "C30", label: "Large carton", length: 600, width: 400, height: 300, mass: 15 },
    { id: "EURO-CASE", label: "Euro case (400x300)", length: 400, width: 300, height: 200, mass: 6 },
  ];

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
      desc: "Floor block stacking, no racking. Highest floor density and lowest cost, but LIFO and low selectivity (honeycombing losses).",
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
  };

  /* ------------------------------------------------------------------
   * SLOTTING STRATEGIES (P1 needs at least random + ABC 80/20).
   * ABC uses the Pareto principle: a small share of SKUs drives most of
   * the picks. Classic split -> A: top 20% of SKUs ~ 80% of pick lines;
   * B: next 30%; C: last 50%. A-items are slotted closest to the I/O
   * point to cut travel. See DOMAIN_NOTES.md.
   * ------------------------------------------------------------------ */
  const STRATEGIES = {
    random: {
      id: "random", label: "Random slotting",
      desc: "SKUs assigned to free locations at random (seeded). Simple, spreads wear, but ignores demand - more travel.",
    },
    abc: {
      id: "abc", label: "ABC 80/20 slotting",
      desc: "Popularity-based: fast-moving A-items nearest the I/O, then B, then C. Cuts average pick travel for the same demand.",
      classes: [
        { cls: "A", skuShare: 0.2, note: "~20% of SKUs, ~80% of picks" },
        { cls: "B", skuShare: 0.3, note: "~30% of SKUs, ~15% of picks" },
        { cls: "C", skuShare: 0.5, note: "~50% of SKUs, ~5% of picks" },
      ],
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

  WT.domain = {
    METRES_PER_CELL,
    PALLETS,
    BOXES,
    ELEMENTS,
    STRATEGIES,
    AISLE,
    elementCapacity,
    palletById,
    // Palette order shown in the UI.
    paletteOrder: [
      "selective-racking", "block-stack",
      "dock-in", "dock-out",
      "staging", "conveyor",
      "push-station", "pull-station",
    ],
  };

  /* ==================================================================
   * TODO (P3 - domain depth): add the remaining storage systems and
   * flow chains here so the palette and simulation pick them up with no
   * other changes:
   *   - drive-in / drive-through racking (deep-lane, LIFO/FIFO)
   *   - double-deep / push-back / pallet-flow (dynamic) racking
   *   - mobile (moving) racking, cantilever, mezzanine/shelving
   *   - carton/tote flow racks and pick-to-light stations
   *   - AS/RS and shuttle systems
   *   - full material-flow chains (receiving -> put-away -> replenish ->
   *     pick -> pack -> ship) with push/pull segment semantics
   * Each just needs an ELEMENTS entry (+ density/selectivity/rotation
   * for storage) and, if storage, it flows through the sim automatically.
   * ================================================================== */
})();
