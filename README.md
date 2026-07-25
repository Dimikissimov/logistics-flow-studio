# Logistics Flow Studio — WarehouseTwin

WarehouseTwin is a small, honest **warehouse digital-twin simulator** you can play with in a browser. I built it to feel game-like and immediately usable: drop racks and dock doors onto a floor, pick a slotting strategy, hit **Run**, and watch the numbers move. It installs as an offline app and holds no company's IP — every icon and line of code here is original or permissively licensed, and every number is synthetic and seeded so you can reproduce it exactly.

This is a multi-pass build, and all five passes are shipped: **Pass 1 (the foundation)**, **Pass 2 (the decision-support layer)**, **Pass 3 (domain depth)**, **Pass 4 (Android delivery + the demo/full tier gate)** and **Pass 5 (LSP Planner — the network-level planning game at [`lsp/`](lsp/), linked from the header)**.

## What it is

A single-page, no-build, no-framework PWA (Progressive Web App). Hand-written HTML, CSS and JavaScript. It runs fully offline and can be **installed** on a phone or desktop straight from the browser.

- **Interactive floor plan** on an HTML5 canvas. Place selective racking, block-stack zones, inbound/outbound dock doors, staging, conveyor, and push/pull control stations. Click to place, drag to move, everything snaps to a 1-metre grid, overlaps are blocked, and a **minimum working-aisle rule** (informed by DIN 15185) flags rack rows that sit too close.
- **A real-ish domain model.** EUR1–EUR6 euro pallets with their actual dimensions, carton types, and honest storage-system characteristics (footprint density, selectivity, FIFO/LIFO, a relative cost index). See `docs/DOMAIN_NOTES.md` for the numbers and their sources.
- **A seeded, deterministic simulation.** It builds a synthetic order stream, slots SKUs into your layout using **Random** or **ABC 80/20** slotting, simulates picking over the floor you drew, and reports live KPIs: throughput (orders/hr), average pick travel (m/order), storage fill %, and pallet positions used. The same seed always gives the same result.
- **Save / load / share.** Layouts persist in your browser and can be exported and imported as plain JSON.

### Pass 2 — decision support (new)

Four features that help you reason about a layout, all running offline on the same deterministic simulation:

- **Heuristic advisor.** A transparent rule engine (`advisor.js`) — *informed by operations-research and warehousing best practice, not a trained or black-box model*. It returns a ranked list of suggestions, and each one states the **finding**, the **principle** behind it, and an **estimated impact** measured with the real simulation where possible (e.g. "switching to ABC 80/20 is estimated to cut average pick travel ~21%" on the starter demo layout — pinned in [`docs/MEASUREMENTS.md`](docs/MEASUREMENTS.md)). Rules cover slotting strategy, the ABC golden zone, DIN 15185 aisle widths, dock/staging placement, and storage over-/under-utilisation.
- **Comparative A/B predictor.** Pick two configurations (e.g. Random vs ABC, or current vs optimised layout); it runs the sim twice at the same seed, shows the KPI deltas side by side, and names the better config in plain language. Deterministic.
- **Spatial-layout optimiser.** A one-click, deterministic "golden-zone" heuristic (`optimizer.js`) that proposes pulling storage closer to the outbound dock while keeping every aisle valid. It **previews** the move as dashed ghosts on the floor and shows the predicted KPI improvement via the sim — you accept or discard. It never mutates your layout until you apply it. Measured on the starter demo layout at the default settings: average pick travel **36.70 → 18.85 m/order, −48.6%** — pinned and reproducible headlessly via `node measure_optimizer.js` (see [`docs/MEASUREMENTS.md`](docs/MEASUREMENTS.md)).
- **German-standards panel.** A collapsible reference (ASR A1.8, DIN 15185, EN 15512, EPAL/DIN EN 13698, VDI 2510, VDI 3564, DIN EN 619, DGUV rules) with one line each on what the standard governs and how the app aligns — plus the **live DIN 15185 aisle check** as a concrete example. It carries a bold disclaimer that this is *guidance-aligned, not a certification or a legal-compliance guarantee.*

### Pass 3 — domain depth (new)

The full storage-systems palette, material-flow chains, and inventory dynamics — still one screen, still fully offline and deterministic:

- **Twelve storage systems**, each with honest, sim-relevant characteristics (footprint density, pallet positions, selectivity %, FIFO/LIFO rotation, relative cost, and a handling delta or machine cycle the simulation actually charges): selective racking, block-stack, **drive-in** (deep-lane LIFO), **double-deep**, **push-back** (LIFO), **pallet-flow** (true FIFO, presented pick faces), **carton-flow** (fast small-parts pick faces), **mobile/compact racking**, **cantilever** (long goods), **AS/RS crane aisle** and **shuttle system** (goods-to-person machine cycles instead of walking), and a **mezzanine pick level**. Distinct original canvas glyphs for each.
- **Material-flow chains.** Conveyors, staging, push/pull stations and the new **pack station** connect into validated chains (dock → staging → put-away → storage → replen → pick → pack → ship). Flow arrows show what is connected; broken chains warn (dangling conveyor, outbound dock with no pick feed, orphan stations); connected chains genuinely help in the sim (covered tours drop the return leg, chained legs save handling, chained receiving shortens pull lead time) while broken chains force manual travel.
- **Push vs pull, simulated.** A per-run toggle: push replenishes pick faces to a periodic forecast (with seeded forecast noise → overstock returns *and* dry spells between reviews); pull replenishes on consumption via reorder points and lead times. New KPIs: stockout % of lines, overstock returns, average face stock. Simplifications documented in `docs/DOMAIN_NOTES.md`.
- **Zone / batch / wave picking** joined random and ABC (zone = resident pickers per area + consolidation; batch = shared tours + sort; wave = timed release, bigger batches + setup). The A/B panel compares any two of the five — and is honest when shorter tours *don't* win on labour.
- **Unit-load catalog.** More cartons plus reusable totes, with **cartons-per-pallet math per EUR pallet type**; storage capacity is shown in pallet positions *and* estimated cartons.
- **One-click preset: "Industrial MRO distributor (illustrative)"** — a large layout (rack rows, deep-lane blocks, AS/RS aisle + shuttle, conveyor spine, push/pull stations, pack station, both docks) with an 80/20-skewed demand profile. *Independent, illustrative, based on public information about the industry segment — not affiliated with or endorsed by Würth or any real company.*
- **Advisor grew new rules**: broken-chain findings, LIFO-share vs FIFO-critical SKUs, carton-flow for high-velocity small parts, an AS/RS-needs-a-takeaway-conveyor check, and a **measured push-vs-pull comparison** using the same sim.

### Pass 4 — Android delivery + demo/full tiers (new)

- **Demo/full tier gate — honestly framed.** The app opens in a **demo tier**: the palette is limited to the starter six elements (selective racking, block-stack, both docks, staging, conveyor), slotting to Random + ABC, the MRO preset is locked, and the advisor shows its top 2 suggestions. Locked items are **never hidden** — they render greyed with an original padlock glyph and explain how to unlock. The header's **"Unlock full version"** button flips the tier. *Honesty note:* this is a **client-side showcase gate, not DRM** — it is a `localStorage` flag anyone can flip in DevTools, and the code says so. Its purpose is engineering demonstration: all gating flows through **one capability-flag module (`tiers.js`)** — palette, strategy selects, preset button and advisor read flags, no scattered if-statements — which is exactly the seam where a real deployment would plug in a license/purchase check (documented in `PUBLISH_ANDROID.md`). The gate never touches the simulation: the same config gives byte-identical KPIs in both tiers.
- **Android packaging scaffold** (`android/`): a pre-filled Bubblewrap `twa-manifest.json` (placeholder package id, colors/URLs matching the web manifest), a Digital Asset Links template, and a guide. Config and docs only — no AAB is checked in; building, signing and store submission are the owner's steps, walked through honestly in [`PUBLISH_ANDROID.md`](PUBLISH_ANDROID.md).

### Pass 5 — LSP Planner, the network game (new)

A second, self-contained app at [`lsp/`](lsp/) — **LSP Planner** — that zooms out from one warehouse to the whole logistics network. Same rules as everything else here: offline, deterministic, synthetic, original assets, honest labels.

- **An interactive network map** on an abstract grid region (1 cell = 10 km — *not* any real country or company network). Place factories, central DCs, regional DCs, cross-docks and customer zones; draw lanes between sites (click A, then B); drag to move, select to edit, delete, save/load per level, JSON export/import.
- **Two honest transport modes per lane.** Full truckload pays per truck (`ceil(flow / 15 t)` weekly trucks — a thin flow still pays a whole truck, which is exactly the lesson), Parcel/LTL pays per tonne-km. Each stocking DC has a **push vs pull replenishment toggle**.
- **A deterministic, seeded evaluation engine** (`lsp/lsp-engine.js`, pure — it runs identically in the browser and in Node). Customer zones carry seeded weekly demand (mean + variability); one click computes weekly transport cost, facility fixed + handling cost, **holding cost with safety stock via the textbook base-stock / square-root risk-pooling formula** (`SS = z·√LT·σ_pooled`), achieved service against a lead-time target, and a **CO2 estimate** with its per-mode assumptions stated. Same design → identical numbers, every time.
- **Game scoring + five levels.** A 0–100 score with visible weights (cost 45% / service 40% / CO2 15%), stars, and per-level pass/fail thresholds: L1 serve four zones from one DC; L2 demand doubles and the risk-pooling trade-off appears; L3 volatile demand where **pull measurably beats push**; L4 thin balanced flows where **a cross-dock pays off**; L5 free play with the full palette. Level budgets were calibrated against reference designs (the in-app "Starter" networks) by the verification harness `lsp/verify.js` — which also proves determinism and both level lessons on every run.
- **Comparative A/B + advisor.** Freeze design A, keep editing, diff cost/service/CO2/score with a plain-language winner line. The advisor is the same species as WarehouseTwin's: explained heuristics that *name their principle* (square-root law of risk pooling, transport consolidation, push vs pull fit, cross-dock flow balance) with impacts measured by the same deterministic evaluation — capped at the 4 most relevant.
- **Shared tier gate.** The same `tiers.js` module gates the levels: demo plays L1–L2, L3+ render with the padlock and the honest unlock hint.

## Design philosophy

I wanted the opposite of a dense enterprise tool: something a newcomer can understand in under a minute. So the whole app is one screen — palette on the left, floor in the middle, properties and the simulation on the right — with a three-step onboarding card and tooltips on every palette item. The goal is **radically intuitive and game-like**: you learn the domain by playing with it, not by reading a manual.

## The domain it models

This is genuine warehouse/intralogistics territory, kept deliberately simple for Pass 1:

- **Storage systems:** selective (single-deep) pallet racking vs. floor block-stacking — a classic selectivity-vs-density trade-off.
- **Flow elements:** receiving and shipping docks, staging/marshalling, conveyor, and **push vs. pull** control points (forecast/schedule-driven replenishment vs. demand/kanban-driven movement).
- **Slotting:** random placement vs. ABC 80/20 (Pareto) placement, where fast-moving A-items go closest to the I/O point to cut travel.
- **Aisle design:** a single configurable minimum working-aisle width between facing rack rows, informed by DIN 15185 truck-aisle guidance.

Details and citations live in [`docs/DOMAIN_NOTES.md`](docs/DOMAIN_NOTES.md).

## How to run

It's static — no server or build step required.

- **Simplest:** open `index.html` in a modern browser. Everything works, including the canvas, the simulation, and save/load.
- **As a full PWA (recommended):** service workers need `http(s)`, so serve the folder:
  ```
  python -m http.server 8000
  ```
  then visit `http://localhost:8000/`. Now it precaches itself and works offline, and the **Install app** button appears when your browser offers installation.

## Install on Android

**Now, as a PWA (zero cost):**

1. Serve the folder over http(s) (or host it) and open it in Chrome on Android.
2. Use the **Install app** button in the header, or the browser menu → **Install app / Add to Home screen**.
3. It installs with its own icon and launches standalone, fully offline.

**Play Store path (TWA wrap):** the packaging scaffold ships in [`android/`](android/) — a pre-filled Bubblewrap config and a Digital Asset Links template. The complete step-by-step (hosting the PWA, building the signed AAB, the $25 developer account, store submission — with every owner-only step marked) is in [`PUBLISH_ANDROID.md`](PUBLISH_ANDROID.md). No built AAB is included: signing and submission belong to the app owner.

## Honesty notes

- **All data is synthetic and seeded.** There is no real inventory, no real order history, no telemetry. Nothing leaves your device — there are zero runtime network calls.
- **All assets are original or open.** Icons are SVG I drew (and rasterised with a small Python/Pillow script); the font is your system font stack; there are no third-party logos, images, or trademarks. See [`CREDITS.md`](CREDITS.md).
- **"Informed by / aligned to", not certified.** The aisle rule is *informed by* DIN 15185 and the pallet sizes follow EPAL/UIC references, but WarehouseTwin performs **no compliance certification** of any kind. The advisor / standards / German-compliance features (shipped in Pass 2) are design aids, not certification tools.
- **No superlatives.** It's a teaching twin, not a WMS. I make no "best/patented/superhuman" claims, and the shipped UI doesn't name or knock any specific commercial product.

## Roadmap

All five passes are shipped:

- **P1 — Foundation. ✅ Done.** PWA shell, interactive canvas, domain model, seeded simulation, KPIs.
- **P2 — Advisor + comparative + optimiser + standards panel. ✅ Done.** A heuristic (rule-based, explainable) layout advisor, an A/B predictor that runs two configurations and diffs the KPIs, a spatial-layout optimiser that pulls storage into the golden zone to cut pick travel, and a German-standards panel with a live DIN 15185 aisle check — all *informed by*, not certified. See `advisor.js`, `optimizer.js`, and the Pass 2 panels in the app.
- **P3 — Domain depth. ✅ Done.** All twelve storage systems with sim-relevant characteristics (selectivity, FIFO/LIFO, handling deltas, goods-to-person cycles), validated material-flow chains with flow arrows and broken-chain warnings, simulated push-vs-pull pick-face inventory (stockouts vs overstock), zone/batch/wave picking, the carton/tote catalog with cartons-per-pallet math, and the illustrative MRO-distributor preset. Every model simplification is written down in `docs/DOMAIN_NOTES.md` — it remains a teaching twin, not a WMS.
- **P4 — Android delivery + tiers. ✅ Done.** The demo/full tier gate (`tiers.js` — one capability-flag module; locked items visible with an original padlock, honestly documented as a showcase gate, not DRM) and the Bubblewrap/TWA packaging scaffold (`android/` + the rewritten `PUBLISH_ANDROID.md`). Docs and config only on the store side — the signing key, developer account and submission are the owner's, marked as such.
- **P5 — LSP Planner. ✅ Done.** The network-level planning game at [`lsp/`](lsp/): abstract-region map editor (sites + lanes, FTL vs Parcel/LTL, push/pull per DC), a pure deterministic evaluation engine (transport/facility/holding cost with base-stock safety stock and square-root risk pooling, service vs a lead-time target, labelled CO2 estimates), five scored levels with honest calibrated thresholds, A/B compare, a principle-naming advisor, the shared demo/full tier gate, and a Node verification harness (`lsp/verify.js`) that proves determinism and the L3 (pull beats push) and L4 (cross-dock pays off) lessons. Model simplifications are documented in `docs/DOMAIN_NOTES.md` §9.

## Licence

MIT © 2026 Dimitres Kisimov. See [`LICENSE`](LICENSE).
