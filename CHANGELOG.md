# Changelog

All notable changes to WarehouseTwin (Logistics Flow Studio) are recorded here.
Dates are ISO (YYYY-MM-DD). Every figure the app produces is a **synthetic,
seeded teaching heuristic unless you import your own data** — informed by public
standards (ISO 22400, DIN 15185, ASR, EN, VDI), not a certification and not a
measurement of a real site.

## [1.4.0] — 2026-08-03

### Added
- **Distinct 2D + 3D object representations.** Every warehouse object type
  now has its **own recognizable schematic** in both views instead of a
  coloured rectangle (top-down) and a plain height-extruded box (2.5D). A new
  **single per-type shape registry** (`shapes.js` → `WT.shapes`, exposing
  `has / draw2D / draw3D / ICONS / meta`) is the **one source of truth** both
  renderers route through:
  - **Top-down glyphs** (`draw2D`): selective racking → shelf-bay grid;
    drive-in → deep lanes + entry depth arrows; double-deep → paired bays +
    two-deep divider; push-back → nested chevrons; pallet-flow/carton-flow →
    roller dots + FIFO flow chevrons; mobile racking → base rail + wheels;
    cantilever → column + projecting arms; AS/RS → tall-rack hatch + crane
    aisle + trolley; shuttle → channels + carts + lift; mezzanine → dashed
    platform + posts + stairs; dock-in/out → door notch + in/out arrow;
    staging → dashed holding area; conveyor → belt rollers + direction;
    push/pull/pack stations → workbench + flow arrow / parcel; block-stack →
    stacked-square pattern; RGV → twin rails + cart; AGV → guide path + robot.
  - **Isometric forms** (`draw3D`): open, **see-through rack frames** (uprights
    + beam levels, not a solid block); a **tall crane tower** for AS/RS; a
    **raised deck on legs** for the mezzanine; a **low belt bed** with rollers
    for the conveyor; **bench furniture** for the stations; small **floor
    vehicles** for RGV/AGV; a **door opening in a low wall** for docks;
    **stacked unit cubes** for block-stack; a **low outlined pad** for staging.
    The 3D forms reuse the **same per-type height** (`domain.heightM` via
    `iso.elementHeight`) the IFC export and the iso projection already agree on.
- Both renderers are wired through `WT.shapes` **fallback-safe**: the top-down
  loop (`app.js`) and the iso scene (`iso.js`) fall back to the previous rect /
  extruded-box draw if a type has no custom shape or the module is absent, so
  nothing breaks. The heatmap, aisle-violation, chain-arrow, compliance,
  reserved-zone, flow-MU and order-pool overlays, selection highlight, labels
  and hit-testing are **unchanged**.
- A **level-of-detail** path keeps large layouts smooth and legible: when a
  footprint is small on screen the glyph simplifies to the already-tinted
  footprint plus a tiny centred icon; at high zoom the full glyph is crisp.
  The module is **pure and deterministic** (a canvas `ctx` + plain geometry/
  colour in, drawing out — no app state, no per-call input mutation), theme-
  aware (light + dark) and **offline** (no external assets).
- These are **illustrative, recognizable schematic** glyphs and forms with
  heights taken from the domain model's **assumed** `heightM` — **not** CAD,
  **not** BIM, **not** a survey and **not** measured geometry. The real
  BIM/geometry path remains the separate **IFC export** (`ifc.js`). No real
  brands, logos or trademarked shapes.

### Engineering
- 27 headless verification harnesses via `node test/run-all.mjs` (the new
  `verify_shapes.js`, 13 checks). Because the pixels of a pure-draw feature
  can't be verified headlessly, the harness runs a **mock-context smoke test**
  that draws **every** object type in **both 2D and 3D**, in **light + dark**,
  at **small + large** scale (exercising the LOD path), asserting **no
  non-finite coordinate** and **no throw**; it also asserts `has()` is true for
  every domain type (2D **and** 3D defined — no type left a plain rect), the
  registry covers **exactly** the domain types (no orphans), the 3D forms use
  the domain `heightM` (a taller element rises on screen), neither draw mutates
  its inputs, unknown types are safe, and the honesty labels are present. All
  26 pre-existing harnesses still pass unchanged. Service-worker cache bumped
  to `wt-v33` (precaching `shapes.js`).

## [1.3.0] — 2026-08-03

### Added
- **Live order pool.** The demand side of the plant is now **visible and
  live**. A new bounded order-pool model (`orderpool.js` → `WT.orderpool`)
  mirrors the classic Siemens Plant Simulation spine — *generateOrders →
  DT_tempOrders (SizeOrderPool) → M_selectOrders → consumed*: orders are
  **generated over time** into a **bounded backlog** (a `SizeOrderPool`-style
  cap), **selected/released** into the picking flow at the line rate, and
  marked **completed** as the flow ships them. It is driven from the **same
  `requestAnimationFrame` loop** that steps `WT.flowsim` (no competing loop),
  so the pool's **selected** aligns with handling units entering picking and
  its **completed** with units shipped; the pool's selection/completion rates
  are taken from the flow's realized spawn/retire deltas each frame, and its
  arrival (order-generation) rate is a synthetic demand set a little above the
  modelled pick capacity so a live backlog is visible. When the flow isn't
  playing the pool **holds its last state**.
- A compact **"Order pool"** readout in the Live material flow card shows the
  **backlog + fill bar**, **generated / selected / completed** counts (and
  **dropped** when the cap overflows), live **in / out rates** (orders/hr),
  **in-flight** count, a backlog **sparkline**, and an honest **starving**
  (empty pool while the picker wants work) / **saturating** (backlog at the
  cap, overflowing) flag.
- The model is **pure and deterministic** (seeded mulberry32; no `Date`, no
  `Math.random`) and **count-conserving at every step**: `generated == inPool
  + inFlightSelected + completed + dropped`. Overflow at the cap is counted as
  **dropped** (backpressure) and pool **starvation** is flagged — both
  reported, never hidden. Order generation **reuses the SKU-velocity-weighted
  generator from `wmsdata`** when present (a Zipf/Pareto heuristic, not
  measured demand) and falls back to a simple seeded generator when it is not.
- A transparent **bounded-queue heuristic** — selection tied to the documented
  `wms.js`/`flowsim.js` throughput model — **not** a real discrete-event /
  queueing engine, **not measured**, not a certification. **SYNTHETIC** unless
  you import your own data.

### Engineering
- 26 headless verification harnesses via `node test/run-all.mjs` (the new
  `verify_orderpool.js`, 22 checks: determinism, count conservation, the cap +
  honest overflow, backlog grow/drain, the starving/saturating flags, the
  selection-rate tie to WT.wms/WT.flowsim, the wmsdata velocity-weighting +
  fallback, and the honesty labels). Service-worker cache bumped to `wt-v32`
  (precaching `orderpool.js`).

## [1.2.0] — 2026-08-03

### Added
- **Scenario A/B compare.** A new **"Scenario A/B compare"** panel lets you pick
  **two whole set-ups** — the current layout, a built-in example, or one of your
  saved scenarios — and see their key metrics **side-by-side with deltas** in a
  modal, so you can answer *"which layout / strategy is better?"*. Each side's
  numbers are **derived from the same consolidated WMS Report the app shows**
  (`WT.report.build`), which is itself cross-consistent with the WMS, storage,
  automation and compliance modules — so the two sides **can never drift** from
  the app. The table diffs layout capacity/floor-use, WMS operations KPIs
  (throughput, order cycle time, dock-to-stock, picking), storage
  occupancy/placement/A-class pick travel, automation throughput and compliance
  pass/warn/fail, with each delta given as an **absolute and % change (B-vs-A)**.
  A plain-language *"what changed"* summary calls out which side has higher
  throughput, lower pick travel and better compliance. **"Better/worse" colouring
  is shown only where the direction is unambiguous** (lower pick travel = better);
  capacity, utilisation and automation are left **neutral** with an honest
  *"higher isn't always better"* note (more automation ≠ automatically better).
  Comparing runs on the picked snapshots and **never disturbs your current
  floor**. Sources resolve through the **same builders the app uses**
  (`currentLayout` / `WT.examples.build` / `WT.scenarios.load`). The pure,
  deterministic engine lives in `compare.js` (`WT.compare`), covered by the new
  `verify_compare.js` harness (16 checks). This is broader than, and separate
  from, the existing strategy-only *Compare A/B* predictor. **SYNTHETIC** unless
  you imported your own data — a transparent heuristic informed by ISO/DIN/EN/VDI,
  **not a certification, not measured**.

### Engineering
- 25 headless verification harnesses via `node test/run-all.mjs` (the new
  `verify_compare.js` added). Service-worker cache bumped to `wt-v31`
  (precaching `compare.js`).

## [1.1.0] — 2026-08-03

### Added
- **Save / load named scenarios.** A compact **"My scenarios"** control (near
  the Layout Save/Export buttons) lets you save the plants **you** build under a
  **name**, then reload, rename or delete them, and **export/import** a JSON
  backup bundle to move them between devices. Saving captures the same
  `serialize()` layout + configuration used by JSON export and share links (and,
  when a real-data bundle is loaded, your imported SKU/order data rides along);
  loading applies it through the **same `deserialize()` loader as JSON import**.
  These are your **own saved work**, stored **only on this device** (browser
  `localStorage`) — nothing is uploaded — and are kept distinct from the
  read-only synthetic example scenarios. Saving under an existing name updates
  that scenario in place. The pure, storage-guarded store lives in
  `scenarios.js` (`WT.scenarios`) with deterministic, sorted-key serialization
  (a bundle round-trips exactly), covered by the new `verify_scenarios.js`
  harness.

### Engineering
- 24 headless verification harnesses via `node test/run-all.mjs` (the new
  `verify_scenarios.js` added). Service-worker cache bumped to `wt-v30`
  (precaching `scenarios.js`).

## [1.0.0] — 2026-08-03

First consolidated product release. WarehouseTwin is an offline, browser-based
warehouse / WMS digital twin and plant-flow simulator: draw or generate a
warehouse layout, simulate the material flow and the standard warehouse
operation, read live KPIs, check the layout against public design guidance, and
roll every layer up into one report — all fully offline, with no account and no
server.

### Design & generate
- Interactive HTML5-canvas floor plan: racks, block-stack, docks, staging,
  conveyor and push/pull stations on a 1 m grid, with overlap blocking and a
  DIN 15185-informed minimum working-aisle rule.
- AI Environment Generator: a deterministic rule/heuristic engine plus offline
  plain-language command parsing (no cloud, no trained model).
- 22 synthetic industry example scenarios, one-click loadable.
- Zoom / pan / Fit and a resizable warehouse floor (up to 120 × 80 m).
- Presentation-only 2.5D isometric view.

### Simulate & KPIs
- Seeded, deterministic slotting + pick-travel simulation (Random / ABC 80/20)
  with throughput, pick travel, storage fill and positions KPIs; a pick-travel
  heatmap overlay and a session-only run-history table.
- WMS Operations: the 7-stage receiving→shipping workflow with per-stage
  throughput and a plain-language bottleneck, grounded in the ISO 22400 KPI
  discipline.
- Live material-flow animation with station FIFO servers, conveyor-following
  routing and emergent queue congestion (a teaching animation, not a DES engine).
- Live KPI cockpit: throughput-over-time, seven-stage load-vs-capacity bars and
  in-flight-vs-shipped, with honest 0-based, colourblind-safe dataviz.
- Rule-based advisor, golden-zone layout optimizer (preview before apply) and an
  A/B configuration comparator.

### Data & storage
- SKU master + order pool data layer (seeded synthetic or import your own CSV).
- CSV import for your own article/order data, parsed in-browser with row-numbered
  validation; data stays on the device.
- Floor-plan image underlay with two-point scale calibration.
- Storage & inventory: physical locations from the racking, ABC/velocity slotting
  into the golden zone, occupancy with honest overflow, and a retrieval location
  the flow animation uses.

### Standards, compliance & automation
- Compliance Check (DIN 15185 / ASR A1.8 / ASR A2.3) — a deterministic
  pass/warn/fail design aid with measured + informed-by values and
  click-to-highlight; explicitly not a certification.
- Editable, versioned standards knowledge base (ISO/DIN/EN/VDI/ASR) that every
  engine reads from, with add/reset and JSON import/export.
- Automation systems modeling (AS/RS, shuttle, RGV, AGV, conveyor) as explicit
  per-system throughput contributors with editable VDI-informed cycle times.

### Outputs & demo
- Consolidated WMS Report (print / JSON / CSV) that aggregates every layer and
  pulls each number from its owning module so it cannot drift from the app.
- Dependency-free scoped IFC4 (STEP) BIM export.
- Save / load / export-import JSON, and a share link that carries the whole
  layout in its `#layout=…` URL fragment (nothing uploaded).
- One-click guided demo that sequences the existing features end-to-end, plus an
  honest About panel.
- LSP Planner companion app (network-level planning game) under `lsp/`.

### Added in this release
- **Collapsible side-panel cards.** Each side-panel card header is now a toggle
  (click, or Enter/Space when focused) that folds the card body away; the
  collapsed set persists in `localStorage` (guarded — a safe no-op when storage
  is unavailable). Cards ship **expanded**, so first load is unchanged. The
  collapse-state helper lives in `cards.js` (`WT.cards`) and is covered by the
  new `verify_ui.js` harness.
- **Product-level README** rewritten into one coherent document (what it is,
  grouped feature overview, run-it-locally, honesty & standards, verification).
- **This CHANGELOG.**

### Engineering
- 23 headless verification harnesses via `node test/run-all.mjs`; deterministic,
  ASCII-only, with an offline guard asserting the app references no external
  assets. Service-worker cache bumped to `wt-v29`.
