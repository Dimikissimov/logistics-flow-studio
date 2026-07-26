# Business Case

*All numbers below come from the repo's synthetic, deterministic simulations (seed 42) at
teaching scale. They demonstrate method and relative gains, not any real facility or network.
The advisor is a heuristic rule engine, not a trained model; the standards features are
guidance-aligned, not a certification. Every figure is pinned in
[`MEASUREMENTS.md`](MEASUREMENTS.md) and reproducible headlessly (`node test/run-all.mjs`).*

## Situation

Two layers of logistics decisions are routinely made without a model:

- **Inside the warehouse**, layout and slotting decisions — where racking goes, which SKUs sit
  near the dock, how wide aisles are — are often made by feel or by copying the last site.
  Nobody measures how far the pickers will walk before the racking is bolted down.
- **At network level**, decisions about DCs, cross-docks and lanes are made in spreadsheets
  that hide the real trade-offs: risk pooling vs proximity, full-truckload vs parcel economics,
  push vs pull replenishment under volatile demand.

Both audiences — trainees, analysts, and teams heading into a WMS or network-design project —
lack a safe, fast place to *see* these trade-offs before real money is involved.

## Quantified problem (from the model)

On WarehouseTwin's starter demo layout (synthetic order stream, seed 42, 200 orders, 80 SKUs):

- With **random slotting**, average pick travel is **46.71 m/order** — the "wherever it fits"
  baseline many real operations live with.
- Even with ABC slotting, the demo layout *as drawn* leaves storage far from the outbound dock:
  **36.70 m/order**, with the pick-travel heatmap showing the walking spread across the floor.

On LSP Planner's networks (seeded weekly demand, textbook base-stock safety stock):

- Under volatile demand (level 3), **push** replenishment holds **1,452 EUR/wk** in inventory
  yet reaches only **87.1% service** — overstocked and still missing the target.
- With thin balanced flows (level 4), direct lanes cost **16,496 EUR/wk** and emit an estimated
  **5,367 kg CO2/wk**, because a thin flow still pays for a whole truck.
- A single central DC (level 2) pools stock efficiently but tops out at **88.4% service**
  against a 92% target — pooling vs proximity is a real trade, not a slogan.

## Solution

Two small, fully offline, deterministic apps — one screen each, no build step, installable as a
PWA — that make the levers visible and measurable:

1. **WarehouseTwin**: draw the floor (12 storage systems, docks, staging, conveyors), pick a
   slotting/picking strategy, run the seeded simulation, and read the KPIs. A one-click
   **golden-zone optimizer** previews a better layout with before/after numbers; a **heuristic
   advisor** (transparent rules that name their principle) ranks suggestions with impacts
   measured by the same simulation; a **pick-travel heatmap** shows where the walking actually
   goes.
2. **LSP Planner**: place factories, DCs, cross-docks and customer zones on an abstract map,
   draw lanes (FTL vs parcel/LTL), toggle push/pull per DC, and get weekly cost, service, CO2
   estimate and a 0-100 score — through five levels each built around one network-design
   lesson.

## Results (measured, teaching-scale, synthetic)

WarehouseTwin, starter demo layout, same seed throughout (`node measure_optimizer.js`):

- **ABC 80/20 vs random slotting: 46.71 → 36.70 m/order (~21% less pick travel)** — the
  measurement behind the advisor's slotting suggestion.
- **One-click layout optimizer: 36.70 → 18.85 m/order (−48.6%)**, 5 storage elements moved,
  every aisle still valid.
- **Heatmap conservation invariant**: the per-cell walked metres sum exactly to the charged
  travel KPI for all five picking strategies (`node verify_heatmap.js`).

LSP Planner, reference networks (`node lsp/verify.js` proves each on every run):

- **Pull beats push under volatile demand (L3)**: service **95.0% vs 87.1%**, holding cost
  **919 vs 1,452 EUR/wk**, score **89 vs 82** — same network, only the DC mode flipped.
- **A cross-dock pays off on thin flows (L4)**: weekly cost **14,755 vs 16,496 EUR/wk**
  (−10.6%), CO2 estimate **3,804 vs 5,367 kg/wk** — consolidation, not magic.
- **Risk pooling vs proximity (L2)**: central-only serves **88.4%** and fails the level; adding
  a regional DC reaches **92.6%** and passes.

**Honest caveats:** all of this is teaching-scale and synthetic — straight-line travel, seeded
demand, simplified inventory dynamics (each simplification is written down in
[`DOMAIN_NOTES.md`](DOMAIN_NOTES.md)). The deltas show the *direction and rough magnitude* of
well-known levers; they are not forecasts for any real operation. No ROI in euros is claimed
because no real rates are involved.

## Stakeholders and use cases

- **Training / education** — logistics students and new planners learn slotting, flow design
  and network economics by playing, with every number reproducible from a seed.
- **Pre-study before a WMS or consulting engagement** — a cheap way to demonstrate to a
  customer *which* levers matter and roughly how much, before commissioning real data work.
- **Candidate skill demonstration** — the repo shows domain knowledge (DIN/VDI-informed rules,
  base-stock safety stock, risk pooling) and engineering discipline (deterministic sims,
  pinned measurements, verification harnesses in CI) in one place.

## Deliverable

The **apps themselves** — an installable, 100% offline PWA (WarehouseTwin at `/`, LSP Planner
at `/lsp/`) — plus a one-page executive **PDF**
([`../deliverables/warehousetwin_onepager.pdf`](../deliverables/warehousetwin_onepager.pdf),
rebuilt by `python tools/make_onepager.py`), the pinned measurement record
([`MEASUREMENTS.md`](MEASUREMENTS.md)), and the verification suite (`node test/run-all.mjs`)
that re-proves every number above.
