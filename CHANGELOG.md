# Changelog

All notable changes to WarehouseTwin (Logistics Flow Studio) are recorded here.
Dates are ISO (YYYY-MM-DD). Every figure the app produces is a **synthetic,
seeded teaching heuristic unless you import your own data** — informed by public
standards (ISO 22400, DIN 15185, ASR, EN, VDI), not a certification and not a
measurement of a real site.

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
