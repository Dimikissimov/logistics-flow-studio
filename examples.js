/* =====================================================================
 * Logistics Flow Studio - WarehouseTwin
 * examples.js - the preselected Example Scenarios library + data export
 * ---------------------------------------------------------------------
 * HARD HONESTY (mirrored in the UI + README): every scenario here is a
 * REALISTIC-BUT-ILLUSTRATIVE SYNTHETIC set-up. The names describe real
 * industry segments (automotive JIT, cold-chain, pharma GDP, AS/RS
 * high-bay, ...) but NONE is a real company, brand, or a depiction of
 * any firm's actual site - there are NO real names, logos or data. The
 * operational figures in each `dataProfile` are PLAUSIBLE ESTIMATES for
 * that industry, labelled synthetic - they are NOT measured and NOT a
 * quotation. Every generated layout is checked against the SAME ASR/DIN
 * guidance as the rest of the app (compliance.js) - informed by, NOT a
 * certification.
 *
 * WT.examples = { library, build, exportData, exportCsv, ITEM_COVERAGE }
 *   library       >=20 named, distinct warehouse/plant scenarios spanning
 *                 real industries. Each entry:
 *                   { id, name, industry, description, config, dataProfile }
 *   build(id)     -> { elements, config, meta, gridW, gridH }
 *                 DETERMINISTIC layout for the example. Built by reusing
 *                 WT.generate.generateLayout (proven overlap-free +
 *                 never-failing), then geometry-preserving racking-type
 *                 substitution (keeps compliance non-fail) and a few
 *                 safe flow-element adds via applyCommand. Overlap-free
 *                 and PASSES / honestly WARNS compliance.check.
 *   exportData(id)-> a wt-1 layout object (the app's serialize() schema)
 *   exportCsv(id) -> an Excel-openable CSV string (every element row +
 *                 a KPI/summary block + the dataProfile rows)
 *   ITEM_COVERAGE the sorted set of element types used across the whole
 *                 library (a MAJORITY of the app's palette - asserted in
 *                 verify_examples.js).
 *
 * Determinism: pure functions of the pinned per-example config. No Date,
 * no Math.random - build/export twice yields byte-identical output
 * (verified in verify_examples.js).
 *
 * Classic script attaching to the global `WT` namespace so it works from
 * file:// too. Reuses domain.js, generate.js and compliance.js.
 * ===================================================================== */
(function () {
  "use strict";
  const WT = (window.WT = window.WT || {});
  const D = WT.domain;
  const G = WT.generate;
  const C = WT.compliance;

  const SERIALIZE_VERSION = "wt-1"; // matches app.js serialize()/share.js
  const GRID_W = 40;
  const GRID_H = 24;
  const CELL_M = 1;

  // Standing honesty labels reused in the CSV + (via meta) the UI.
  const SYNTHETIC_LABEL =
    "Realistic-but-illustrative SYNTHETIC scenario - no real company/brand; " +
    "dataProfile numbers are plausible estimates, labelled, not measured.";
  const COMPLIANCE_LABEL =
    "Informed by ASR A1.8 / ASR A2.3 / DIN 15185 - a design aid, NOT a certification.";

  /* ------------------------------------------------------------------
   * THE LIBRARY. 22 named, distinct, realistic industry scenarios.
   * `config` carries the deterministic build recipe:
   *   profile        one of generate.js's 4 pinned plant profiles (the
   *                  proven skeleton: docks/staging/rows/spine/pack)
   *   seed           deterministic PRNG seed
   *   minAisle       working-aisle metres (truck class); tunes row pitch
   *   racking        the racking MIX - storage rows are re-typed to this
   *                  set, in order (bulk first, pick faces last)
   *   transport      "rgv" | "agv" | null - the transport spine type
   *   adds           safe flow-element adds [{type, zone, count}]
   * `dataProfile` is synthetic-but-plausible operational data for the
   * industry (labelled synthetic; grounded loosely in the standards
   * corpus + general intralogistics references).
   * ------------------------------------------------------------------ */
  const LIBRARY = [
    {
      id: "automotive-jit-sequencing",
      name: "Automotive JIT/JIS line-feed centre",
      industry: "Automotive supply",
      description:
        "A just-in-time / just-in-sequence supplier feeding an assembly line: parts arrive sequenced and must reach line-side within a tight time window, so many balanced in/out docks and an RGV transport spine dominate. Selective and pallet-flow racking hold the fast movers with a drive-in bulk block for volume runners. Complexity comes from sequencing discipline - a late or out-of-order pallet stops the line.",
      config: { profile: "automotive-supply", seed: 101, minAisle: 3.0, racking: ["selective-racking", "pallet-flow", "drive-in"], transport: "rgv", adds: [{ type: "pull-station", zone: "picking", count: 1 }] },
      dataProfile: { skuCount: 900, dailyOrderLines: 4200, throughputPerHour: 520, storagePositions: 3600, dockCount: 8, automation: "RGV transport spine + pallet-flow line-feed lanes", staffingFte: 34, peakFactor: 1.4 },
    },
    {
      id: "ecommerce-multichannel-fc",
      name: "E-commerce multi-channel fulfilment centre",
      industry: "E-commerce / retail",
      description:
        "A B2C + marketplace fulfilment centre: a huge small-item SKU base, very high pick velocity and steep peak-season swings. Carton-flow pick faces and a mezzanine handle the small items, an AGV/AMR spine feeds a conveyor sortation wall, and few receiving docks face many shipping docks. Batch picking on 80/20 demand; the hard part is scaling labour to peak without breaking single-line SLAs.",
      config: { profile: "ecommerce-fulfilment", seed: 202, minAisle: 2.9, racking: ["selective-racking", "carton-flow", "mezzanine"], transport: "agv", adds: [{ type: "push-station", zone: "picking", count: 1 }, { type: "pull-station", zone: "picking", count: 1 }] },
      dataProfile: { skuCount: 42000, dailyOrderLines: 38000, throughputPerHour: 2400, storagePositions: 5200, dockCount: 12, automation: "AGV/AMR fleet + conveyor sortation to a wide pack-and-ship wall", staffingFte: 180, peakFactor: 3.2 },
    },
    {
      id: "coldchain-frozen-dc",
      name: "Cold-chain frozen distribution centre",
      industry: "Cold-chain / frozen",
      description:
        "A -24 C frozen DC where every open door leaks cooled volume, so storage is dense and doors are few. Mobile (compact) racking and drive-in lanes maximise pallets per cubic metre, carton-flow faces sit in a chilled pick module, and push replenishment keeps the buffer ahead of demand. Complexity is thermal: layout, MHE and shift length are all constrained by the cold.",
      config: { profile: "cold-chain", seed: 303, minAisle: 1.8, racking: ["mobile-racking", "drive-in", "selective-racking"], transport: null, adds: [{ type: "push-station", zone: "picking", count: 1 }] },
      dataProfile: { skuCount: 2600, dailyOrderLines: 9800, throughputPerHour: 760, storagePositions: 8200, dockCount: 4, automation: "mobile compact racking + drive-in density; insulated doors, few openings", staffingFte: 48, peakFactor: 1.8 },
    },
    {
      id: "spare-parts-highsku",
      name: "Spare-parts high-SKU distribution centre",
      industry: "Spare parts / aftermarket",
      description:
        "An aftermarket spares DC with a very high SKU count and a long tail of slow movers. Dense narrow-aisle (VNA) selective racking plus a shuttle small-parts store and carton-flow pick faces keep footprint down; an RGV lane bridges zones. Zone picking splits the tail; the challenge is service level on tens of thousands of rarely-ordered lines.",
      config: { profile: "spare-parts-distribution", seed: 404, minAisle: 1.8, racking: ["selective-racking", "carton-flow", "shuttle"], transport: "rgv", adds: [{ type: "pull-station", zone: "picking", count: 1 }] },
      dataProfile: { skuCount: 68000, dailyOrderLines: 14500, throughputPerHour: 980, storagePositions: 9400, dockCount: 6, automation: "shuttle small-parts + carton-flow, VNA narrow aisles, RGV lane", staffingFte: 72, peakFactor: 1.5 },
    },
    {
      id: "pharma-gdp-warehouse",
      name: "Pharma GDP temperature-controlled warehouse",
      industry: "Pharmaceutical (GDP)",
      description:
        "A Good-Distribution-Practice pharma warehouse: full temperature mapping, segregated quarantine/release stock and batch/expiry FIFO discipline. Selective racking for released stock, a chilled carton-flow module and mobile racking for the compact controlled zone; an AGV route keeps handling auditable. The complexity is regulatory - traceability and cold-chain integrity beat raw throughput.",
      config: { profile: "cold-chain", seed: 505, minAisle: 2.0, racking: ["selective-racking", "carton-flow", "mobile-racking"], transport: "agv", adds: [{ type: "pull-station", zone: "picking", count: 1 }] },
      dataProfile: { skuCount: 5400, dailyOrderLines: 7200, throughputPerHour: 540, storagePositions: 6100, dockCount: 5, automation: "AGV route + chilled carton-flow; segregated quarantine/release", staffingFte: 41, peakFactor: 1.6 },
    },
    {
      id: "3pl-crossdock-hub",
      name: "3PL cross-dock consolidation hub",
      industry: "3PL / cross-dock",
      description:
        "A third-party-logistics cross-dock: freight flows door-to-door in hours, not days, so staging and docks dominate and storage is a thin buffer. Selective and pallet-flow racking hold overflow only; an AGV spine and a wide conveyor move consolidated loads between many inbound and outbound doors. Complexity is scheduling - every trailer has a slot and a cut-off.",
      config: { profile: "ecommerce-fulfilment", seed: 606, minAisle: 2.9, racking: ["selective-racking", "pallet-flow"], transport: "agv", adds: [{ type: "staging", zone: "picking", count: 2 }, { type: "push-station", zone: "picking", count: 1 }] },
      dataProfile: { skuCount: 12000, dailyOrderLines: 21000, throughputPerHour: 1900, storagePositions: 2200, dockCount: 14, automation: "AGV spine + conveyor consolidation; staging-heavy, minimal storage", staffingFte: 96, peakFactor: 2.1 },
    },
    {
      id: "beverage-drivein-warehouse",
      name: "Beverage drive-in pallet warehouse",
      industry: "Beverage / FMCG",
      description:
        "A beverage producer's finished-goods store: few SKUs in enormous pallet volumes, so deep-lane drive-in and pallet-flow lanes give maximum density per SKU. A block-stack marshalling area handles promotions. Low selectivity is acceptable because whole lanes turn over fast; the complexity is honeycombing loss and strict FIFO on shelf-life stock.",
      config: { profile: "cold-chain", seed: 707, minAisle: 1.8, racking: ["drive-in", "pallet-flow", "block-stack"], transport: null, adds: [{ type: "staging", zone: "picking", count: 1 }] },
      dataProfile: { skuCount: 480, dailyOrderLines: 6300, throughputPerHour: 880, storagePositions: 11200, dockCount: 6, automation: "deep-lane drive-in + pallet-flow density; block-stack marshalling", staffingFte: 38, peakFactor: 2.4 },
    },
    {
      id: "asrs-highbay-dc",
      name: "AS/RS automated high-bay distribution centre",
      industry: "Automated high-bay",
      description:
        "A fully automated high-bay DC: stacker-crane AS/RS aisles and a shuttle system do goods-to-person, so labour is thin and throughput is machine-paced. Selective racking covers manual overflow; an RGV spine links the automation islands. The complexity is uptime and cycle-time balancing - one crane fault throttles a whole aisle's picks.",
      config: { profile: "automotive-supply", seed: 808, minAisle: 2.9, racking: ["asrs", "shuttle", "selective-racking"], transport: "rgv", adds: [{ type: "pull-station", zone: "picking", count: 1 }] },
      dataProfile: { skuCount: 8800, dailyOrderLines: 26000, throughputPerHour: 2100, storagePositions: 22000, dockCount: 8, automation: "AS/RS crane aisles + shuttle goods-to-person; RGV spine", staffingFte: 44, peakFactor: 1.7 },
    },
    {
      id: "furniture-bulky-goods",
      name: "Furniture & bulky-goods warehouse",
      industry: "Furniture / bulky goods",
      description:
        "A furniture DC handling oversized, awkward loads: cantilever racking carries long/flat goods with no front uprights, block-stack holds boxed flat-packs, and wide selective bays take the rest. No conveyor spine - forklifts and manual handling rule. Complexity is cube utilisation and damage control on non-palletised, non-conveyable items.",
      config: { profile: "cold-chain", seed: 909, minAisle: 2.9, racking: ["cantilever", "block-stack", "selective-racking"], transport: null, adds: [{ type: "staging", zone: "picking", count: 1 }] },
      dataProfile: { skuCount: 3200, dailyOrderLines: 2600, throughputPerHour: 210, storagePositions: 4800, dockCount: 5, automation: "manual/forklift; cantilever for long goods, block-stack flat-packs", staffingFte: 29, peakFactor: 1.9 },
    },
    {
      id: "hazmat-storage-facility",
      name: "Hazardous-materials storage facility",
      industry: "Hazmat / chemicals",
      description:
        "A hazardous-goods store built around segregation: incompatible classes sit in separated selective bays and block-stack cells with generous aisles for spill access and escape. A push station governs controlled replenishment into the segregated zones. Complexity is compliance-led - separation distances and egress dominate the floor plan over density.",
      config: { profile: "cold-chain", seed: 111, minAisle: 3.0, racking: ["selective-racking", "block-stack", "selective-racking"], transport: null, adds: [{ type: "push-station", zone: "picking", count: 1 }, { type: "pull-station", zone: "picking", count: 1 }] },
      dataProfile: { skuCount: 1400, dailyOrderLines: 1800, throughputPerHour: 160, storagePositions: 3100, dockCount: 4, automation: "manual with segregation; wide egress aisles, controlled replenishment", staffingFte: 22, peakFactor: 1.3 },
    },
    {
      id: "apparel-textile-dc",
      name: "Apparel & textile fulfilment DC",
      industry: "Apparel / textile",
      description:
        "An apparel DC mixing hanging and folded goods with heavy seasonality and high return rates. Carton-flow faces and a mezzanine give dense small-item picking, selective racking holds bulk cartons, and an AGV route feeds a pack wall. Complexity is the fashion calendar - huge SKU churn per season and a returns stream that re-enters stock.",
      config: { profile: "ecommerce-fulfilment", seed: 222, minAisle: 2.0, racking: ["selective-racking", "carton-flow", "mezzanine"], transport: "agv", adds: [{ type: "push-station", zone: "picking", count: 1 }] },
      dataProfile: { skuCount: 55000, dailyOrderLines: 31000, throughputPerHour: 1700, storagePositions: 6400, dockCount: 10, automation: "AGV route + carton-flow/mezzanine small-item picking", staffingFte: 140, peakFactor: 3.0 },
    },
    {
      id: "building-materials-branch",
      name: "Building-materials trade warehouse",
      industry: "Building materials",
      description:
        "A builders' merchant warehouse serving trade counters: long profiles and boards on cantilever, palletised bagged goods on drive-in, and selective bays for the rest. An RGV lane moves loads to a loading yard. Complexity is the mix of very long goods and heavy pallets in one hall with kerbside pickup timing.",
      config: { profile: "automotive-supply", seed: 333, minAisle: 3.0, racking: ["cantilever", "drive-in", "selective-racking"], transport: "rgv", adds: [{ type: "staging", zone: "picking", count: 1 }] },
      dataProfile: { skuCount: 9600, dailyOrderLines: 5200, throughputPerHour: 430, storagePositions: 5600, dockCount: 6, automation: "RGV lane to loading yard; cantilever long goods + drive-in bulk", staffingFte: 33, peakFactor: 1.6 },
    },
    {
      id: "grocery-ambient-chilled-dc",
      name: "Grocery ambient + chilled retail DC",
      industry: "Grocery / retail",
      description:
        "A grocery retail DC running two temperature regimes side by side: pallet-flow and drive-in for fast ambient lines, a chilled carton-flow module for fresh, and both push and pull control points for the mixed replenishment. An AGV route links the regimes. Complexity is store-order waves - hundreds of stores, tight delivery windows, mixed-temperature roll cages.",
      config: { profile: "cold-chain", seed: 444, minAisle: 2.0, racking: ["pallet-flow", "drive-in", "carton-flow"], transport: "agv", adds: [{ type: "push-station", zone: "picking", count: 1 }, { type: "pull-station", zone: "picking", count: 1 }] },
      dataProfile: { skuCount: 14000, dailyOrderLines: 44000, throughputPerHour: 2600, storagePositions: 9800, dockCount: 12, automation: "AGV route; dual ambient/chilled, push+pull replenishment", staffingFte: 165, peakFactor: 2.2 },
    },
    {
      id: "electronics-components-dc",
      name: "Electronics components distribution",
      industry: "Electronics components",
      description:
        "An electronic-components distributor: tiny high-value parts, ESD control and reel/tray handling. A shuttle small-parts system and carton-flow faces give dense, fast goods-to-person picking, with selective racking for bulk reels; an RGV lane keeps handling gentle. Complexity is value density and mis-pick cost on visually similar parts.",
      config: { profile: "spare-parts-distribution", seed: 555, minAisle: 1.8, racking: ["shuttle", "carton-flow", "selective-racking"], transport: "rgv", adds: [{ type: "pull-station", zone: "picking", count: 1 }] },
      dataProfile: { skuCount: 120000, dailyOrderLines: 18000, throughputPerHour: 1400, storagePositions: 16000, dockCount: 5, automation: "shuttle goods-to-person + carton-flow; ESD-controlled, RGV lane", staffingFte: 58, peakFactor: 1.5 },
    },
    {
      id: "returns-reverse-logistics",
      name: "Returns / reverse-logistics centre",
      industry: "Reverse logistics",
      description:
        "A dedicated returns centre: inbound is unpredictable, so grading and disposition staging dominate the floor. Selective racking and carton-flow buffer graded stock, a mezzanine holds refurb, and an AGV route moves totes between grade stations. Complexity is variability - every return is a mini-inspection with a different downstream path (restock, refurb, liquidate, scrap).",
      config: { profile: "ecommerce-fulfilment", seed: 666, minAisle: 2.9, racking: ["selective-racking", "carton-flow", "mezzanine"], transport: "agv", adds: [{ type: "staging", zone: "picking", count: 2 }, { type: "push-station", zone: "picking", count: 1 }] },
      dataProfile: { skuCount: 33000, dailyOrderLines: 12000, throughputPerHour: 640, storagePositions: 4200, dockCount: 8, automation: "AGV totes between grade stations; staging-heavy disposition", staffingFte: 74, peakFactor: 2.6 },
    },
    {
      id: "urban-micro-fulfilment",
      name: "Urban micro-fulfilment centre",
      industry: "Urban micro-fulfilment",
      description:
        "A compact in-city micro-fulfilment centre for rapid grocery/essentials delivery: a small footprint packed with a mezzanine, a shuttle store and carton-flow faces for maximum picks per square metre. An AGV route shuttles totes to a tight dispatch wall. Complexity is density under a rent-driven footprint with sub-hour delivery promises.",
      config: { profile: "ecommerce-fulfilment", seed: 777, minAisle: 1.8, racking: ["mezzanine", "carton-flow", "shuttle"], transport: "agv", adds: [{ type: "pull-station", zone: "picking", count: 1 }] },
      dataProfile: { skuCount: 6500, dailyOrderLines: 9200, throughputPerHour: 720, storagePositions: 3400, dockCount: 3, automation: "AGV totes to dispatch wall; mezzanine + shuttle in a small footprint", staffingFte: 26, peakFactor: 2.8 },
    },
    {
      id: "aerospace-mro-parts",
      name: "Aerospace MRO parts store",
      industry: "Aerospace MRO",
      description:
        "An aerospace maintenance-repair-overhaul parts store: strict traceability, rotable/consumable segregation and long structural spares. Selective racking and carton-flow hold serialised consumables, cantilever carries long structural parts, and an RGV lane keeps AOG (aircraft-on-ground) picks fast. Complexity is certification paperwork per part and the cost of a stockout grounding an aircraft.",
      config: { profile: "spare-parts-distribution", seed: 888, minAisle: 2.9, racking: ["selective-racking", "cantilever", "carton-flow"], transport: "rgv", adds: [{ type: "pull-station", zone: "picking", count: 1 }] },
      dataProfile: { skuCount: 47000, dailyOrderLines: 3400, throughputPerHour: 260, storagePositions: 7200, dockCount: 4, automation: "RGV lane for AOG picks; cantilever long spares, serialised carton-flow", staffingFte: 37, peakFactor: 1.4 },
    },
    {
      id: "food-production-raw-finished",
      name: "Food production raw + finished store",
      industry: "Food production",
      description:
        "An on-site food-plant warehouse spanning raw-material intake and finished-goods dispatch around a production core. Pallet-flow and selective racking feed the line (pull) and buffer output (push), mobile racking compresses the ingredient store, and an AGV route links intake to line. Complexity is allergen segregation, FIFO on perishables and synchronising with production schedules.",
      config: { profile: "automotive-supply", seed: 999, minAisle: 2.0, racking: ["pallet-flow", "selective-racking", "mobile-racking"], transport: "agv", adds: [{ type: "push-station", zone: "picking", count: 1 }, { type: "pull-station", zone: "picking", count: 1 }] },
      dataProfile: { skuCount: 2100, dailyOrderLines: 8600, throughputPerHour: 690, storagePositions: 7400, dockCount: 7, automation: "AGV intake-to-line; push finished-goods buffer, pull line-feed", staffingFte: 52, peakFactor: 1.7 },
    },
    {
      id: "media-book-distribution",
      name: "Media & book distribution centre",
      industry: "Media / publishing",
      description:
        "A book and media distributor: dense, uniform cartons and a strong 80/20 title curve. Carton-flow faces present the bestsellers, double-deep racking compresses the mid-list, and selective racking holds the long tail; an AGV route feeds a sortation pack wall. Complexity is release-day spikes - a single launch can dwarf a normal day's volume.",
      config: { profile: "ecommerce-fulfilment", seed: 121, minAisle: 2.0, racking: ["carton-flow", "double-deep", "selective-racking"], transport: "agv", adds: [{ type: "push-station", zone: "picking", count: 1 }] },
      dataProfile: { skuCount: 90000, dailyOrderLines: 27000, throughputPerHour: 1850, storagePositions: 12500, dockCount: 9, automation: "AGV route + carton-flow bestsellers, double-deep mid-list", staffingFte: 110, peakFactor: 3.4 },
    },
    {
      id: "tools-hardware-branch",
      name: "Tools & hardware branch warehouse",
      industry: "Tools / hardware",
      description:
        "A tools-and-hardware branch distribution warehouse replenishing trade counters: a broad SKU range from bagged fixings to boxed power tools. Selective and double-deep racking hold bulk, carton-flow faces speed the fast movers, and an RGV lane serves the counter. Complexity is breadth - thousands of small lines with counter-driven, same-day pull.",
      config: { profile: "spare-parts-distribution", seed: 232, minAisle: 2.0, racking: ["selective-racking", "double-deep", "carton-flow"], transport: "rgv", adds: [{ type: "pull-station", zone: "picking", count: 1 }] },
      dataProfile: { skuCount: 31000, dailyOrderLines: 11000, throughputPerHour: 900, storagePositions: 8600, dockCount: 6, automation: "RGV counter lane; double-deep bulk + carton-flow fast movers", staffingFte: 45, peakFactor: 1.6 },
    },
    {
      id: "chemical-drum-store",
      name: "Chemical drum & IBC store",
      industry: "Chemicals / process",
      description:
        "A process-industry store for drums and IBCs: heavy, spill-sensitive unit loads on drive-in lanes and block-stack bunded cells, with selective racking for smaller packs. A push station governs controlled put-away. Complexity is bunding and separation - containment and access for spill response shape the aisles more than throughput does.",
      config: { profile: "cold-chain", seed: 343, minAisle: 3.0, racking: ["drive-in", "block-stack", "selective-racking"], transport: null, adds: [{ type: "push-station", zone: "picking", count: 1 }] },
      dataProfile: { skuCount: 1900, dailyOrderLines: 2400, throughputPerHour: 190, storagePositions: 4300, dockCount: 4, automation: "manual with bunding; drive-in + block-stack, controlled put-away", staffingFte: 24, peakFactor: 1.4 },
    },
    {
      id: "tyre-storage-dc",
      name: "Tyre storage & distribution centre",
      industry: "Tyre / automotive aftermarket",
      description:
        "A tyre DC handling millions of units of a compressible, seasonal product. Push-back racking gives dense LIFO lanes for a size, drive-in holds bulk runs, and selective racking covers the fitment tail; an RGV lane moves stacks to dispatch. Complexity is the winter/summer swing and the cube of a low-value, high-volume unit.",
      config: { profile: "automotive-supply", seed: 454, minAisle: 2.9, racking: ["push-back", "drive-in", "selective-racking"], transport: "rgv", adds: [{ type: "pull-station", zone: "picking", count: 1 }] },
      dataProfile: { skuCount: 7400, dailyOrderLines: 9600, throughputPerHour: 1050, storagePositions: 14800, dockCount: 8, automation: "RGV to dispatch; push-back dense LIFO + drive-in bulk", staffingFte: 49, peakFactor: 2.9 },
    },
  ];

  const BY_ID = {};
  for (const e of LIBRARY) BY_ID[e.id] = e;

  /* ------------------------------------------------------------------
   * Geometry-preserving racking substitution.
   * We only ever CHANGE THE TYPE STRING of an existing storage-category
   * row (never move/resize it). Because compliance.js's aisle-width,
   * traffic-route, escape-route and blocked-route checks are ALL purely
   * geometric (facing-pair gaps + a 1 m occupancy flood; storage type is
   * irrelevant to every one of them), substituting one storage type for
   * another leaves the compliance outcome byte-for-byte unchanged. So a
   * base layout that PASSES/WARNS still PASSES/WARNS after substitution.
   * Rows are addressed top-to-bottom, left-to-right, and the racking mix
   * is applied in order (so bulk-first mixes land nearest receiving).
   * ------------------------------------------------------------------ */
  function isStorage(type) { return (D.ELEMENTS[type] || {}).category === "storage"; }
  function isTransport(type) { return (D.ELEMENTS[type] || {}).transport === true; }

  // Re-type every storage-category row (top-to-bottom, left-to-right) to
  // the racking mix, in order. Pure type change -> geometry untouched.
  function substituteRacking(els, racking) {
    if (!Array.isArray(racking) || !racking.length) return;
    const rows = els
      .filter((e) => isStorage(e.type))
      .sort((a, b) => a.y - b.y || a.x - b.x);
    rows.forEach((row, i) => {
      const t = racking[i % racking.length];
      if (D.ELEMENTS[t] && isStorage(t)) row.type = t;
    });
  }

  // If the base skeleton has fewer storage rows than the racking mix has
  // distinct systems (the transport spine consumes a row slot), add the
  // shortfall as extra full-width rack rows via applyCommand (overlap-free
  // by construction). These land in the storage band and can tighten one
  // aisle -> at worst an HONEST aisle-width WARN, never a fail. This lets
  // every example actually SHOW the full racking mix its description names.
  function ensureRackingRows(layout, racking) {
    if (!Array.isArray(racking) || !racking.length) return layout;
    let lay = layout;
    let have = lay.elements.filter((e) => isStorage(e.type)).length;
    const need = racking.length - have;
    for (let k = 0; k < need; k++) {
      let res = G.applyCommand(lay, { kind: "add", type: "selective-racking", zone: "storage", count: 1 });
      if (!res.ok) res = G.applyCommand(lay, { kind: "add", type: "selective-racking", zone: "picking", count: 1 });
      if (res.ok) lay = res.layout; else break;
    }
    return lay;
  }

  function setTransport(layout, transport) {
    // Re-type the generated transport spine, or add one (a flow element,
    // so it can never break the aisle-width check) if the base profile
    // had none. cold-chain has no spine; an agv/rgv example still gets one.
    const els = layout.elements;
    const spine = els.find((e) => isTransport(e.type));
    if (!transport) {
      return layout; // manual/dense example: leave whatever the base did
    }
    if (spine) {
      spine.type = transport;
      return layout;
    }
    const res = G.applyCommand(layout, { kind: "add", type: transport, zone: "picking", count: 1 });
    return res.ok ? res.layout : layout;
  }

  function applyAdds(layout, adds) {
    if (!Array.isArray(adds)) return layout;
    let lay = layout;
    for (const a of adds) {
      const res = G.applyCommand(lay, { kind: "add", type: a.type, zone: a.zone || "picking", count: a.count || 1 });
      if (res.ok) lay = res.layout;
    }
    return lay;
  }

  /* ------------------------------------------------------------------
   * build(id) -> { elements, config, meta, gridW, gridH }
   * DETERMINISTIC. Overlap-free and compliance pass/warn by construction
   * (generate.js base + geometry-preserving substitution + safe flow
   * adds). Elements keep their zone tag so the app loads them exactly
   * like a generated layout (applyGeneratedLayout).
   * ------------------------------------------------------------------ */
  function build(id) {
    const ex = BY_ID[id];
    if (!ex) throw new Error("Unknown example: " + id);
    const cfg = ex.config;

    // 1. Proven skeleton from the generator (overlap-free, never-failing).
    let layout = G.generateLayout(cfg.profile, {
      gridW: GRID_W, gridH: GRID_H, seed: cfg.seed >>> 0,
      minAisleOverride: cfg.minAisle,
    });

    // 2. Transport spine type (add one if the base profile had none).
    layout = setTransport(layout, cfg.transport || null);

    // 3. Ensure enough storage rows to realise the full racking mix, then
    //    geometry-preserving substitution over ALL storage rows in order.
    layout = ensureRackingRows(layout, cfg.racking);
    substituteRacking(layout.elements, cfg.racking);

    // 4. Safe flow-element adds (push/pull/staging) for coverage + detail.
    layout = applyAdds(layout, cfg.adds);

    const els = layout.elements;

    // ---- derived KPI / meta (also used by the CSV) ----
    const positions = els.reduce((s, e) => s + D.elementCapacity(e), 0);
    const floorArea = els.reduce((s, e) => s + e.w * e.d, 0);
    const floorUsePct = Math.round((floorArea / (GRID_W * GRID_H)) * 1000) / 10;
    const dockIn = els.filter((e) => e.type === "dock-in").length;
    const dockOut = els.filter((e) => e.type === "dock-out").length;
    const rackingUsed = [];
    for (const e of els) if (isStorage(e.type) && rackingUsed.indexOf(e.type) === -1) rackingUsed.push(e.type);

    const report = C.check(
      { version: SERIALIZE_VERSION, gridW: GRID_W, gridH: GRID_H, cell: CELL_M, elements: els },
      { minAisleMetres: cfg.minAisle }
    );
    const aisleFinding = report.findings.find((f) => f.ruleId === "aisle-width");

    const config = Object.assign({}, layout.config, { minAisleMetres: cfg.minAisle });

    const meta = {
      version: SERIALIZE_VERSION,
      exampleId: ex.id,
      name: ex.name,
      industry: ex.industry,
      description: ex.description,
      dataProfile: Object.assign({}, ex.dataProfile),
      profileKey: cfg.profile,
      seed: cfg.seed >>> 0,
      gridW: GRID_W,
      gridH: GRID_H,
      minAisleMetres: cfg.minAisle,
      rackingUsed: rackingUsed,
      transport: cfg.transport || null,
      // zones from the (possibly re-typed/added) geometry, for app load.
      zones: G.buildZones(els, GRID_W, GRID_H, []),
      reserved: [],
      counts: G.countByZone(els),
      positions: positions,
      floorUsePct: floorUsePct,
      dockIn: dockIn,
      dockOut: dockOut,
      compliance: {
        worst: report.summary.worst,
        pass: report.summary.pass,
        warn: report.summary.warn,
        fail: report.summary.fail,
        aisle: aisleFinding ? aisleFinding.status : "n/a",
      },
      syntheticLabel: SYNTHETIC_LABEL,
      complianceLabel: COMPLIANCE_LABEL,
    };

    return { elements: els, config: config, meta: meta, gridW: GRID_W, gridH: GRID_H };
  }

  /* ------------------------------------------------------------------
   * exportData(id) -> a wt-1 layout object (app.js serialize() schema).
   * Round-trips through deserialize()/share.js unchanged. Deterministic:
   * no savedAt / Date. Elements are stripped to the serialized shape.
   * ------------------------------------------------------------------ */
  function exportData(id) {
    const b = build(id);
    return {
      version: SERIALIZE_VERSION,
      gridW: b.gridW,
      gridH: b.gridH,
      cell: CELL_M,
      elements: b.elements.map((e) => ({ id: e.id, type: e.type, x: e.x, y: e.y, w: e.w, d: e.d })),
      config: Object.assign({}, b.config),
      example: {
        id: b.meta.exampleId,
        name: b.meta.name,
        industry: b.meta.industry,
        synthetic: true,
        label: SYNTHETIC_LABEL,
      },
    };
  }

  /* ------------------------------------------------------------------
   * exportCsv(id) -> Excel-openable CSV string.
   * Sections: a metadata header, one row PER element (type/x/y/w/d/
   * storage capacity), a KPI/summary block (total positions, floor use %,
   * aisle-compliance result, dock count) and the synthetic dataProfile
   * rows. CRLF line endings + RFC-4180 quoting so Excel opens it cleanly.
   * Deterministic: same example -> identical bytes.
   * ------------------------------------------------------------------ */
  function csvCell(v) {
    let s = v === null || v === undefined ? "" : String(v);
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function csvRow(cells) { return cells.map(csvCell).join(","); }

  function exportCsv(id) {
    const b = build(id);
    const m = b.meta;
    const dp = m.dataProfile;
    const rows = [];

    // ---- metadata header ----
    rows.push(csvRow(["Logistics Flow Studio - WarehouseTwin - Example scenario export"]));
    rows.push(csvRow(["Example ID", m.exampleId]));
    rows.push(csvRow(["Example name", m.name]));
    rows.push(csvRow(["Industry", m.industry]));
    rows.push(csvRow(["Data label", SYNTHETIC_LABEL]));
    rows.push(csvRow(["Compliance basis", COMPLIANCE_LABEL]));
    rows.push(csvRow(["Floor (m)", GRID_W + " x " + GRID_H]));
    rows.push(csvRow(["Min working aisle (m)", m.minAisleMetres]));
    rows.push(csvRow(["Generator seed", m.seed]));
    rows.push(csvRow(["Layout format", SERIALIZE_VERSION]));
    rows.push("");

    // ---- every element ----
    rows.push(csvRow(["[ELEMENTS]"]));
    rows.push(csvRow(["idx", "id", "type", "label", "zone", "x", "y", "w", "d", "category", "storage_positions"]));
    b.elements.forEach((e, i) => {
      const def = D.ELEMENTS[e.type] || {};
      rows.push(csvRow([
        i + 1, e.id, e.type, def.label || e.type, e.zone || "",
        e.x, e.y, e.w, e.d, def.category || "", D.elementCapacity(e),
      ]));
    });
    rows.push("");

    // ---- KPI / summary block ----
    rows.push(csvRow(["[SUMMARY / KPI]"]));
    rows.push(csvRow(["metric", "value"]));
    rows.push(csvRow(["Total elements", b.elements.length]));
    rows.push(csvRow(["Total storage positions (pallet-equiv)", m.positions]));
    rows.push(csvRow(["Floor use (%)", m.floorUsePct]));
    rows.push(csvRow(["Inbound docks", m.dockIn]));
    rows.push(csvRow(["Outbound docks", m.dockOut]));
    rows.push(csvRow(["Dock count (total)", m.dockIn + m.dockOut]));
    rows.push(csvRow(["Racking types used", m.rackingUsed.join("; ")]));
    rows.push(csvRow(["Transport spine", m.transport || "none (manual/dense)"]));
    rows.push(csvRow(["Aisle-width compliance", m.compliance.aisle]));
    rows.push(csvRow([
      "Compliance (worst of 4 rules)",
      m.compliance.worst + " (pass " + m.compliance.pass + " / warn " + m.compliance.warn + " / fail " + m.compliance.fail + ")",
    ]));
    rows.push("");

    // ---- synthetic dataProfile ----
    rows.push(csvRow(["[DATA PROFILE - synthetic, illustrative estimates]"]));
    rows.push(csvRow(["metric", "value", "unit", "note"]));
    const note = "illustrative estimate for this industry, labelled synthetic - not measured";
    rows.push(csvRow(["SKU count", dp.skuCount, "SKUs", note]));
    rows.push(csvRow(["Avg daily order lines", dp.dailyOrderLines, "lines/day", note]));
    rows.push(csvRow(["Throughput", dp.throughputPerHour, "lines/hr", note]));
    rows.push(csvRow(["Storage positions", dp.storagePositions, "positions", note]));
    rows.push(csvRow(["Dock count", dp.dockCount, "doors", note]));
    rows.push(csvRow(["Automation", dp.automation, "", note]));
    rows.push(csvRow(["Staffing", dp.staffingFte, "FTE", note]));
    rows.push(csvRow(["Peak factor", dp.peakFactor, "x avg", note]));

    return rows.join("\r\n") + "\r\n";
  }

  /* ------------------------------------------------------------------
   * ITEM_COVERAGE - the distinct element types used across the WHOLE
   * library (sorted in the app's palette order). Computed once, lazily,
   * and cached. verify_examples.js asserts this is a MAJORITY of the
   * palette and that the expected racking/flow/transport types appear.
   * ------------------------------------------------------------------ */
  let _coverage = null;
  function coverageSet() {
    if (_coverage) return _coverage;
    const seen = {};
    for (const ex of LIBRARY) {
      let b;
      try { b = build(ex.id); } catch (_) { continue; }
      for (const e of b.elements) seen[e.type] = true;
    }
    const order = (D.paletteOrder || []).slice();
    const out = order.filter((t) => seen[t]);
    // include any type not in paletteOrder (defensive), appended sorted.
    Object.keys(seen).forEach((t) => { if (out.indexOf(t) === -1) out.push(t); });
    _coverage = out;
    return out;
  }

  WT.examples = {
    library: LIBRARY,
    build: build,
    exportData: exportData,
    exportCsv: exportCsv,
    get ITEM_COVERAGE() { return coverageSet(); },
    SYNTHETIC_LABEL: SYNTHETIC_LABEL,
    COMPLIANCE_LABEL: COMPLIANCE_LABEL,
  };
})();
