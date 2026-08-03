# Changelog

All notable changes to WarehouseTwin (Logistics Flow Studio) are recorded here.
Dates are ISO (YYYY-MM-DD). Every figure the app produces is a **synthetic,
seeded teaching heuristic unless you import your own data** — informed by public
standards (ISO 22400, DIN 15185, ASR, EN, VDI), not a certification and not a
measurement of a real site.

## [1.7.0] — 2026-08-03

### Added
- **Deep-link to a scenario via URL.** A URL can now open a specific example
  scenario (and skip the onboarding modal), so a synthetic plant is
  **shareable/embeddable with a link** and a demo or screenshot can open a
  chosen plant directly, unobstructed. Additive and non-breaking — a normal
  load (no query flags) looks and behaves exactly as before.
  - `index.html?scenario=<id>` (or the alias `?example=<id>`) where `<id>` is a
    `WT.examples.library` id — e.g. `index.html?scenario=coldchain-frozen-dc` —
    loads that scenario onto the floor **via the same `loadExample()` the side
    panel and header quick-pick use** (no re-implementation) and suppresses the
    welcome modal for that load so the plant shows immediately.
  - `?onboarding=0` (also `false`/`off`/`no`) suppresses the welcome modal on
    its own, without loading a scenario; a `?scenario=` implies it.
  - **Nothing is persisted.** A deep-link is per-URL, not a saved preference —
    it never flips the "don't show onboarding again" `localStorage` flag; it
    only suppresses the modal for that one load. (Loading the scenario itself
    autosaves the working layout exactly as the UI "Load onto floor" button
    does — that is the shared loader's normal behaviour, unchanged.)
  - **Unknown id is safe:** a `?scenario=` that isn't in the library falls
    through to a normal boot with a gentle notice — a bad link never breaks the
    app.
  - **Composes with everything.** Boot **precedence**: an explicit `#layout=`
    share-hash wins, else a `?scenario=` deep-link, else the saved layout, else
    the demo starter. `?selftest=1` is never hijacked; `?tour=off` still works.
  - The parsing is a **pure, DOM-free, deterministic** helper
    `WT.deeplink.parse(search) → { scenario, skipOnboarding }` (`deeplink.js`)
    that reads nothing, mutates nothing and does **not** validate the id (it
    returns the raw id; the app validates it against the library) — so it is
    fully headless-tested.
- **New harness** `verify_deeplink.js` (**30th**): the parser returns the id
  for `?scenario=` and `?example=` with onboarding suppressed, `?onboarding=0`
  suppresses on its own (`?onboarding=1` keeps the modal), an empty/`?`/
  non-string query and `?selftest=1` are a clean no-op, an unknown id is
  returned verbatim, a real library id round-trips, purity + determinism
  (proven with a poisoned `document`, no input mutation), composition +
  order-independence, and tolerance of a trailing `#fragment`/`+`-space/
  malformed `%xx`/bare key without throwing.
- **Self-test extended** (`selftest.js`, now **46** checks): a live check that
  `WT.deeplink.parse` exists and that `parse("?scenario=<real id>")` yields
  that id with onboarding suppressed while `?selftest=1` stays a no-op.

### Changed
- **Offline PWA cache** bumped `wt-v35` → `wt-v36`; `deeplink.js` added to the
  service-worker precache and loaded in `index.html` before `app.js`. Fully
  offline; no new dependencies; no external references.

## [1.6.0] — 2026-08-03

### Added
- **Production hardening (pass 2): accessibility, large-layout performance, and
  a QA/production checklist.** Real, verified improvements — additive and
  non-breaking; a normal load looks and behaves exactly as before.
  - **Accessibility (real, but *not* a WCAG certification).**
    - **Landmarked regions:** `<main>` and the three columns carry `aria-label`s
      (building tools / floor / simulation panels) so assistive tech can jump
      between them.
    - **The `<canvas>` gets a text alternative.** A canvas is opaque to screen
      readers, so `#floor` now carries an `aria-label` **and** an
      `aria-describedby` pointing at an **offscreen summary** (`#floorDesc`,
      `.sr-only`) that `app.js` keeps current — element count, floor size (m),
      view mode, and live-flow status. It only touches the DOM when the text
      changes, so it stays cheap even during playback.
    - **Named toolbar controls:** the icon / short-text controls (zoom −/+,
      Fit, 100%, Pan, 2.5D, Guided demo, Play/Pause) all expose an accessible
      name (`aria-label`/`title`). Every primary control is a native
      `<button>` (keyboard-operable); the custom card-header toggles remain
      `role="button"` + `tabindex` + Enter/Space.
    - **Visible focus:** a `:focus-visible` outline is shown on every
      interactive control (buttons, button-styled links, role=button toggles).
    - **Reduced motion honoured:** with the OS "reduce motion" setting on, the
      continuous material-flow animation **does not auto-run** — Play shows a
      single static/stepped frame and the app stays **fully usable** (Step /
      Reset advance the model on demand). This governs the one-click Guided
      demo too. CSS transitions/animations are also stilled. `app.js` reads a
      cached `prefers-reduced-motion` matcher.
  - **Performance for large layouts (bounded effort, *not* a guarantee for
    arbitrary size).** A new **pure, testable** helper
    `WT.view.cullToView(elements, viewBounds, pad)` culls the per-frame element
    draw to the elements whose footprint overlaps the visible world rectangle
    (`WT.view.viewBounds`), so on a big floor (e.g. 120×80) zoomed in, glyph +
    label work is proportional to what is **on screen**, not the whole layout.
    The per-type shapes registry already drops to a single LOD icon when zoomed
    out. **Simulation results are unchanged** — this is rendering/throughput
    only; every logic/determinism harness still passes byte-for-byte.
- **New maintainer doc** `docs/QA_CHECKLIST.md` — an honest pre-release
  checklist (offline works; installs as a PWA; service-worker cache bumped;
  `?selftest=1` → `PASS n/n` with the headless one-liner; no console errors;
  CSP present; error boundary works; keyboard/a11y checks; large-layout perf
  sanity; data stays on-device; honesty labels present; proprietary license).
  Cross-linked from `docs/PRODUCTION.md` (new a11y/perf section).
- **Self-test extended** (`selftest.js`, now **45** checks): the canvas
  aria-label + offscreen description, key toolbar controls having accessible
  names, the reduced-motion flag hook, and the pure `cullToView` culling being
  correct + non-mutating — driven against the live app.
- **New harness** `verify_a11y_perf.js` (**29th**, ≥ 10 checks) gates all of
  the above headlessly: the canvas aria wiring, named toolbar controls,
  landmarked regions, the `prefers-reduced-motion` rule + the flow loop reading
  the flag, `:focus-visible` + `.sr-only`, `cullToView`/`viewBounds` purity +
  correctness + determinism, `QA_CHECKLIST.md` presence, the new self-test
  checks, and the license staying proprietary (no MIT in any touched file).
- Service-worker cache bumped **`wt-v34` → `wt-v35`**.

## [1.5.0] — 2026-08-03

### Added
- **Production hardening: in-browser self-test, global error boundary, and a
  strict Content-Security-Policy.** The app's DOM/UI had only ever been tested
  indirectly (the harnesses cover pure logic); this pass closes that gap with a
  real in-browser end-to-end self-test plus two safety nets — none of which
  change a normal load.
  - **Global error boundary** (`errors.js`, loaded **first**, before every other
    script). It installs `window.onerror` + `window.onunhandledrejection`,
    records every uncaught error / unhandled rejection into
    `window.__WT_ERRORS__`, and surfaces **one honest, non-blocking banner**
    — *"Something went wrong — details in console."* — instead of leaving a
    silently dead UI. It never **swallows** an error: the handlers do not return
    `true` / `preventDefault()`, so the browser's own console reporting stays
    intact. Tiny, dependency-free, CSP-safe.
  - **In-browser self-test** (`selftest.js`, `?selftest=1`). **Inert** by default
    — a normal load never runs it. When enabled it waits for boot, then drives
    the **live app** through the same functions the UI uses (exposed as
    `window.__WT_TEST_API__` only in self-test mode) and asserts ~40 checks:
    every `WT.*` module present and correctly shaped, a clean error-free boot,
    the key panels/buttons in the DOM, a real example load placing elements and
    redrawing, WMS ops populating its panel, the flow stepping/playing then
    stopping, the 2.5D toggle being a pure layout no-op, the report building with
    its expected sections, About/KB opening, and the zoom controls running. It
    writes a **machine-readable** result into a `#wt-selftest` element and the
    console — `WT-SELFTEST: PASS 40/40` or `WT-SELFTEST: FAIL n/40 :: <checks>`
    — for a maintainer to read headlessly. Each check is isolated (a thrown
    check is one FAIL, never a dead page) and the suite restores the app to a
    normal state at the end.
  - **Strict offline Content-Security-Policy** (`<meta>` in `index.html`):
    `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
    img-src 'self' data: blob:; connect-src 'self'; worker-src 'self';
    manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none';
    frame-src 'none'`. No external hosts, **no `unsafe-eval`**, no inline scripts;
    inline **style** is allowed because the UI uses a handful of `style=""`
    attributes. A static scan confirms there is no `eval(` / `new Function(` and
    no inline `on*=` handler anywhere, so the policy breaks nothing. This is
    **best-practice hardening for an offline app, not a security certification**.
- **New harness** `verify_hardening.js` (28th) verifies all of the above
  headlessly (the error boundary actually installs + records + does not swallow
  under a window-shim; the CSP directives; the eval/inline-handler scan; the
  self-test's inertness, ≥ 25 assertions and machine-readable output; the
  guarded test API; the service-worker precache + cache bump). The **live**
  self-test runs in a real browser; the harness gates its presence and wiring.
- Service-worker cache bumped **`wt-v33` → `wt-v34`**; `errors.js` + `selftest.js`
  added to the offline precache shell.

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
