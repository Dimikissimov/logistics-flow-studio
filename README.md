# Logistics Flow Studio — WarehouseTwin

WarehouseTwin is a small, honest **warehouse digital-twin simulator** you can play with in a browser. I built it to feel game-like and immediately usable: drop racks and dock doors onto a floor, pick a slotting strategy, hit **Run**, and watch the numbers move. It installs as an offline app and holds no company's IP — every icon and line of code here is original or permissively licensed, and every number is synthetic and seeded so you can reproduce it exactly.

This repository is **Pass 1 (the foundation)** of a longer build. It is deliberately a clean, extensible base — the smart-advisor, comparison, standards and packaging features are mapped out in the roadmap below and stubbed with clear hooks in the code, not faked in the UI.

## What it is

A single-page, no-build, no-framework PWA (Progressive Web App). Hand-written HTML, CSS and JavaScript. It runs fully offline and can be **installed** on a phone or desktop straight from the browser.

- **Interactive floor plan** on an HTML5 canvas. Place selective racking, block-stack zones, inbound/outbound dock doors, staging, conveyor, and push/pull control stations. Click to place, drag to move, everything snaps to a 1-metre grid, overlaps are blocked, and a **minimum working-aisle rule** (informed by DIN 15185) flags rack rows that sit too close.
- **A real-ish domain model.** EUR1–EUR6 euro pallets with their actual dimensions, carton types, and honest storage-system characteristics (footprint density, selectivity, FIFO/LIFO, a relative cost index). See `docs/DOMAIN_NOTES.md` for the numbers and their sources.
- **A seeded, deterministic simulation.** It builds a synthetic order stream, slots SKUs into your layout using **Random** or **ABC 80/20** slotting, simulates picking over the floor you drew, and reports live KPIs: throughput (orders/hr), average pick travel (m/order), storage fill %, and pallet positions used. The same seed always gives the same result.
- **Save / load / share.** Layouts persist in your browser and can be exported and imported as plain JSON.

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

## Install on Android (as a PWA, today)

1. Serve the folder over http(s) (or host it) and open it in Chrome on Android.
2. Use the **Install app** button in the header, or the browser menu → **Install app / Add to Home screen**.
3. It installs with its own icon and launches standalone, fully offline.

Getting it into the **Google Play Store** is a separate packaging step (a TWA wrap) planned for Pass 4 — the honest path is written up in [`PUBLISH_ANDROID.md`](PUBLISH_ANDROID.md).

## Honesty notes

- **All data is synthetic and seeded.** There is no real inventory, no real order history, no telemetry. Nothing leaves your device — there are zero runtime network calls.
- **All assets are original or open.** Icons are SVG I drew (and rasterised with a small Python/Pillow script); the font is your system font stack; there are no third-party logos, images, or trademarks. See [`CREDITS.md`](CREDITS.md).
- **"Informed by / aligned to", not certified.** The aisle rule is *informed by* DIN 15185 and the pallet sizes follow EPAL/UIC references, but WarehouseTwin performs **no compliance certification** of any kind. The advisor / standards / German-compliance features are design aids coming in later passes.
- **No superlatives.** It's a teaching twin, not a WMS. I make no "best/patented/superhuman" claims, and the shipped UI doesn't name or knock any specific commercial product.

## Roadmap

Pass 1 (this repo) is the foundation. Planned next:

- **P2 — Advisor + comparative + standards panel.** A plain-language layout advisor, an A/B predictor that runs two configurations and diffs the KPIs, a spatial-layout optimiser that minimises pick travel, and a German-standards panel (DIN 15185 aisle checks and load notes — *informed by*, not certified). Hooks are already in `simulation.js` and `app.js`.
- **P3 — Domain depth.** The remaining storage systems (drive-in, double-deep, push-back, pallet-flow, mobile, cantilever, AS/RS, shuttle), carton/tote flow, and full material-flow chains (receive → put-away → replenish → pick → pack → ship) with push/pull semantics. New elements added to `domain.js` flow through the palette and simulation automatically.
- **P4 — Android / TWA package.** Wrap the PWA with Bubblewrap into a signed AAB for the Play Store. Packaging only; see `PUBLISH_ANDROID.md`.
- **P5 — LSP Planner.** A higher-level logistics-network / planning layer that consumes exported layouts.

## Licence

MIT © 2026 Dimitres Kisimov. See [`LICENSE`](LICENSE).
