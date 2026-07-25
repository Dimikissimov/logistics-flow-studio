# Domain notes (Passes 1–3)

The reference behind WarehouseTwin's domain model. Everything here is a **simplified, synthetic teaching model**. Dimensions of standardised objects (pallets) are drawn from public standards; the operational figures (densities, selectivity, costs, picker speed, handling deltas, cycle times) are **illustrative order-of-magnitude values**, not vendor specifications and not a certification of anything. Where a number is an assumption, it says so.

---

## 1. Euro pallets (EUR1–EUR6)

Dimensions in millimetres. The EUR/EPAL pallet system is standardised by **EPAL (European Pallet Association)** and referenced in **UIC 435-2** (International Union of Railways).

| ID | Also known as | Length × Width (mm) | Standardised? | Notes |
|----|---------------|---------------------|---------------|-------|
| EUR1 | EPAL 1 / "Euro pallet" | 1200 × 800 | Yes | The classic pallet; ~25 kg; dominant in EU FMCG. |
| EUR2 | EPAL 2 | 1200 × 1000 | Yes | Larger footprint for heavier/industrial loads. |
| EUR3 | EPAL 3 | 1000 × 1200 | Yes | Industrial pallet. |
| EUR4 | — | ~1300 × 1100 | **No** | Commonly quoted by suppliers; **not** an official EPAL/UIC size — dimensions vary by source. |
| EUR5 | — | ~1140 × 760 | **No** | As above; treat as approximate. |
| EUR6 | EPAL 6 | 800 × 600 | Yes | Half pallet; retail/display-ready units. |

**Sources / cross-checks:** EPAL pallet range (europeanpallet.org); UIC 435-2 load-unit standard; the Wikipedia "EUR-pallet" summary table. EUR1/2/3/6 are well established; **EUR4 and EUR5 are flagged `standardised: false` in `domain.js`** because they are not part of the official EPAL/UIC set and figures differ between vendors.

A EUR1 footprint is 1.2 × 0.8 = **0.96 m²**, which is why the simulator treats "about one pallet per square metre of footprint" as a sanity anchor.

---

## 2. Carton / box / tote catalogue (P3 expanded)

Synthetic but plausible EU unit-load sizes (mm). The 400 × 300 and 600 × 400 modules are common Euro-modular footprints (they tile onto the 1200 × 800 pallet). Totes are reusable plastic containers (KLT-style small-load carriers *in spirit* — the sizes here are original generic values, not any vendor's spec). Masses are assumptions.

| ID | Label | L × W × H (mm) | Mass (kg) | Tote? |
|----|-------|----------------|-----------|-------|
| C05 | Mini carton | 150 × 100 × 100 | 0.5 | |
| C10 | Small carton | 200 × 150 × 120 | 2 | |
| C15 | Flat carton | 350 × 250 × 150 | 4 | |
| C20 | Medium carton | 400 × 300 × 250 | 8 | |
| C30 | Large carton | 600 × 400 × 300 | 15 | |
| C40 | Bulk carton | 600 × 400 × 400 | 18 | |
| EURO-CASE | Euro case | 400 × 300 × 200 | 6 | |
| TOTE-64 | Tote 600×400 | 600 × 400 × 320 | 12 | ✔ |
| TOTE-43 | Tote 400×300 | 400 × 300 × 220 | 6 | ✔ |
| TOTE-HALF | Half tote | 300 × 200 × 170 | 2.5 | ✔ |

### Cartons-per-pallet math (P3)

`WT.domain.cartonsPerPallet(boxId, palletId)` computes the **simple rectangular fit**:

- **Per layer** = the better of the two orientations: `⌊L/l⌋·⌊W/w⌋` vs `⌊L/w⌋·⌊W/l⌋` on the pallet deck.
- **Layers** = `⌊1200 mm / boxHeight⌋` — a **1.2 m usable load height** is assumed (a conservative teaching value for a ~1.35 m max load; real limits depend on racking beam pitch, truck mast and goods stability).
- **Per pallet** = per-layer × layers.

Interlocking, column vs brick stacking, overhang and weight limits are **not** modelled. The app uses this figure to convert storage capacity from pallet positions into **estimated cartons** (properties panel, KPI note, and the Unit-loads panel), for every EUR pallet type in §1.

Example: EURO-CASE (400×300×200) on EUR1 (1200×800) → 8/layer × 6 layers = **48 per pallet**.

---

## 3. Storage & flow elements (P1 + P3 palette)

Twelve **storage** systems contribute pallet positions to the simulation; the rest are **flow** elements.

### Storage systems (P3 full set)

| System | Density (pos./m²) | Selectivity | Rotation | Cost idx | Sim effect | Real-world character |
|--------|------------------|-------------|----------|----------|-----------|----------------------|
| Selective racking (single-deep) | 2.4 | 100% | FIFO/LIFO | ×3 | baseline | Every pallet directly accessible; adjustable beams; the flexible default. Needs a working aisle per row. |
| Block-stack zone (floor) | 3.2 | ~35% | LIFO | ×1 | +8 s/line | No racking at all. Highest floor density and lowest cost, but honeycombing losses and stack-stability limits; only for few-SKU volume. |
| Drive-in racking | 3.0 | ~25% | LIFO | ×2 | +10 s/line | The truck drives into deep lanes on guide rails. Great density for few SKUs; slow, damage-prone access; strictly LIFO (drive-*through* would give FIFO but needs both aisles). |
| Double-deep racking | 2.9 | ~50% | FIFO within pairs | ×4 | +6 s/line | Two pallets deep, needs telescopic forks. A midpoint on the selectivity-vs-density curve. |
| Push-back racking | 3.0 | ~40% | LIFO | ×5 | +4 s/line | Nested carts on inclined rails, 2–6 deep, one loading face. Fast face access, dense — but per-lane LIFO. |
| Pallet-flow racking | 3.4 | ~45% | **FIFO** | ×7 | **−2 s/line** | Gravity roller lanes: load rear, pick front — true FIFO; the front pallet is always presented. High capital cost (rollers + brakes). |
| Carton-flow pick faces | 1.6 (pallet-eq.) | 100% | FIFO (carton) | ×4 | **−4 s/line** | Inclined roller shelves presenting cartons at ergonomic pick faces, replenished from behind. The classic fast-pick face for high-velocity small parts. |
| Mobile (compact) racking | 3.8 | 100% | FIFO/LIFO | ×8 | +15 s/line | Racking on powered bases sharing ONE opening aisle: near block-stack density with full selectivity, but you wait for the aisle. Suits slow movers, archives, cold stores. |
| Cantilever racking | 0.8 (pallet-eq.) | 100% | FIFO/LIFO | ×4 | +6 s/line | Arms on columns, no front uprights — long goods (pipes, profiles, timber). Low pallet-equivalent density; side-loading trucks. |
| AS/RS crane aisle | 5.0 | 100% | FIFO | ×10 | goods-to-person, ~45 s cycle/line | Automated high-bay: stacker crane serves double-sided racking, 10+ levels. No walking travel; a pick line costs a machine (dual-command) cycle. Informed by VDI 3564 high-bay guidance — **not certified**. |
| Shuttle system | 4.5 | ~90% | FIFO/LIFO | ×9 | goods-to-person, ~28 s cycle/line | Autonomous shuttles in deep channels + lifts. Denser than crane AS/RS per channel; throughput scales with shuttle count (simplified to one cycle time here). |
| Mezzanine pick level | 2.0 (pallet-eq.) | 100% | FIFO | ×5 | +5 s/line | Steel platform doubling the floor for small-parts shelving; the +5 s models the level change (stairs/lift). |

**How to read these:** *Density* is pallet positions per square metre of the **element's own footprint** (roughly accounting for beam levels and pallet gaps) — the working aisle a system needs is placed **separately** on the floor, so it isn't baked into this number. *Selectivity* is the share of stored pallets you can reach without moving another pallet. *Cost index* is relative capital cost per position (1 = cheapest). *Sim effect* is how the P3 simulation makes the system's character felt: a per-line handling delta versus the 12 s base (deep-lane digging vs presented goods), or a goods-to-person machine cycle replacing walking travel. All values are teaching values consistent with general materials-handling literature (the classic selectivity-vs-density trade-off, dynamic-racking FIFO behaviour, AS/RS dual-command cycles); they are **not** quotations from any manufacturer.

`WT.domain.elementCapacity(el)` = `round(footprint_area_m² × density)`.

### Flow elements

- **Dock door (inbound / receiving):** where goods enter the flow.
- **Dock door (outbound / shipping):** where picked orders leave. It is the **default I/O point** for pick-travel measurement (the simulation starts and ends picking tours here; it falls back to inbound docks, then the floor centre).
- **Staging area:** marshalling buffer for put-away or order consolidation — a buffer, not long-term storage.
- **Conveyor segment:** powered internal transport between zones; the link element of P3 material-flow chains (informed by DIN EN 619 unit-load conveyor concepts — chain *logic* only, never a safety check).
- **Push station / Pull station:** the two classic control philosophies (see §5).
- **Pack station (P3):** packing/consolidation bench; a complete outbound chain is storage → (conveyor) → pack → outbound dock.

---

## 4. Slotting strategies

### Random slotting
SKUs are assigned to free locations at random (seeded). Simple and spreads wear, but it ignores demand, so average pick travel is higher.

### ABC 80/20 (Pareto) slotting
Based on the **Pareto principle**: a small share of SKUs drives most of the picks. WarehouseTwin uses the classic split:

| Class | Share of SKUs | Approx. share of picks |
|-------|---------------|------------------------|
| A | ~20% | ~80% |
| B | ~30% | ~15% |
| C | ~50% | ~5% |

Fast-moving **A-items are slotted in the locations closest to the I/O point**, then B, then C. For the same demand this shortens the average picking tour — which is exactly what you can see by running the sim on one layout with `random` and then `abc` at the same seed.

SKU popularity in the simulation follows a **Zipf-like distribution** (rank *r* popularity ∝ 1/*r*^s, exponent `demandSkew`, default 1.0; the MRO preset uses 1.15 for a harder 80/20 skew), which is what makes ABC slotting pay off.

### P3 picking strategies (layered on ABC slotting)

| Strategy | Model | Overheads (assumptions) | What it teaches |
|----------|-------|--------------------------|-----------------|
| **Zone** | Floor split into 3 vertical zones with a resident picker each; an order's lines are toured **per zone** from a zone home point (parallel in reality; the KPI model sums labour-seconds) | +15 s/order consolidation; +10 s/order more if no conveyor chain to shipping | Short, zone-confined tours; consolidation is the price of parallelism |
| **Batch** | 4 orders share one tour over the union of their pick locations | +18 s/order downstream sort (put-to-order) | Travel is shared across the batch — the classic batching win |
| **Wave** | Orders release in timed waves of 20; batches of 6 within each wave | +18 s/order sort, +90 s per wave setup (≈4.5 s/order) | Best travel sharing, most coordination overhead |

**Simplifications (deliberate, documented):** zone picking is modelled with total labour-seconds, not parallel wall-clock makespan, so its benefit shows as shorter tours rather than lower lead time; batch capacity limits (cart size) and wave-release waiting time are not modelled; batching uses consecutive orders rather than intelligent order grouping. A genuinely interesting honest result: in a compact, well-chained layout the sort overhead can outweigh the saved metres — batch/wave then show **lower travel but also lower throughput**, and the A/B panel says so explicitly.

---

## 5. Push vs. pull (P3: simulated on pick-face inventory)

- **Push:** material is released into storage on a **forecast or schedule** (make-to-stock). It can build a buffer ahead of demand — good for smoothing, at the cost of holding inventory.
- **Pull:** material moves only when a **downstream order or kanban signal** asks for it (make-to-order). It holds less inventory and is demand-paced, but is more sensitive to demand spikes.

### The P3 model (honest simplifications)

Each slotted SKU gets a **pick face** sized to its expected demand over one push review cycle (`max(3, ⌈expected demand per 25 orders × 1.2⌉)` units, one unit = one pick line), so the two modes differ by **policy**, not by capacity:

- **Push = periodic, forecast-driven top-up.** Every 25 orders each face receives `expected demand × (1 + ε)`, with seeded forecast noise ε ∈ ±35%. Overshoot beyond the face capacity is **bounced back to reserve** (the `overstock returns` KPI); undershoot leaves the face short until the *next* review — so push can **run dry between review cycles** (a real periodic-review phenomenon).
- **Pull = continuous reorder point.** When a face falls to its reorder point (`⌈expected lead-time demand × 1.5⌉`), a replenishment is triggered and arrives after a lead time of **5 orders** — **3** if receiving is connected to storage through the material-flow chain. Arrival tops the face back up.
- A **stockout** line (empty face) still gets picked, but costs a 45 s walk to reserve stock.
- KPIs: **stockout %** of lines, **overstock returns** (units bounced), **average face stock %**.

**What the numbers show** (MRO preset, seed 42): pull ≈ 0.6% stockouts, 0 overstock; push ≈ 10% stockouts + ~140 bounced units — the forecast noise hurts in both directions while consumption-driven pull follows real demand. **Simplifications:** no replenishment labour is charged, faces are demand-sized (a generous assumption that favours both modes), lead times are counted in orders rather than minutes, and push's review period is fixed. The point is the classic service-level-vs-inventory trade-off, measured with the same seeded simulation, not a claim about any real operation.

## 5b. Material-flow chains (P3)

The logical chain is **dock-in → staging → put-away → storage → replenish → pick → pack → dock-out**. On the floor:

- Elements **connect when their footprints touch** (share an edge or corner on the 1 m grid). Material passes **through** connector elements (conveyor, staging, push/pull stations, pack station); storage systems and dock doors are chain **endpoints**.
- The canvas draws **flow arrows** along connected edges, pointing toward shipping where a path exists (and away from receiving on inbound-only legs). A toolbar badge summarises chain health.
- **Broken chains warn:** an outbound dock with no connected pick feed, a conveyor dead-ending (connected at one end or not at all), an orphan push/pull station, and a chain that reaches shipping without a pack step. The advisor repeats these with severities.
- **Sim effect of a connected chain:** pick lines from chain-covered storage save 2 s handling each, and when *all* of a tour's walking stops are covered the tour **drops its return leg** — the goods ride the conveyor to pack/ship while the picker starts the next tour nearby. A chained receiving side shortens the pull replenishment lead time (5 → 3 orders). **Broken chains force full manual travel.**
- **Simplifications:** conveyor speed/capacity, accumulation, merges and congestion are not modelled; the chain is a *logical* graph, not a routed conveyor network; the return-leg rule is a deliberate, visible abstraction of "pick-to-belt" operation.

---

## 6. Aisle-width guidance (informed by DIN 15185)

**DIN 15185-1** covers the safety of storage installations and the design of **working aisles**. Different trucks need different aisle widths:

| Truck type | Typical working aisle |
|------------|-----------------------|
| Counterbalance | ~3.5–4.0 m |
| Reach truck | ~2.7–3.0 m |
| VNA (man-up turret, guided) | ~1.5–1.8 m |

WarehouseTwin uses a **single configurable minimum working-aisle gap** between facing racking rows (default **2.9 m**, a reach-truck aisle; presets for VNA and counterbalance are provided). When two storage rows face each other with a positive gap **smaller** than the minimum, the app flags it (a dashed red link + an "aisle too narrow" badge).

This is a **design aid to keep layouts sane — it is not a compliance check or certification.** The Pass 2 standards panel (ASR A1.8, DIN 15185, EN 15512, EPAL/DIN EN 13698, VDI 2510, VDI 3564, DIN EN 619, DGUV) stays "informed by / aligned to", never "certified".

---

## 7. Simulation parameters (assumptions)

All synthetic, all documented in `simulation.js`:

| Parameter | Value | Basis |
|-----------|-------|-------|
| Picker walking speed | 1.2 m/s | Brisk walking pace (rule of thumb). |
| Base handling time per pick line | 12 s | Grab/scan/place assumption; storage systems add/subtract their delta (§3). |
| SKU popularity skew | Zipf exponent 1.0 (config `demandSkew`) | Classic heavy-tail demand; MRO preset: 1.15. |
| Pallets per SKU (mean) | 1.8 | Inventory-per-SKU assumption. |
| Pickers | 1 | Single-picker default. |
| Stockout penalty | 45 s/line | Walk to reserve stock (§5). |
| Push review period / forecast noise | 25 orders / ±35% | Periodic-review assumption (§5). |
| Pull lead time | 5 orders (3 chained) | Reorder-point assumption (§5, §5b). |
| Chain handling bonus | 2 s/line | Pick-to-belt abstraction (§5b). |
| Zone/batch/wave overheads | 15 s / 18 s / +90 s per wave | §4 table. |

**Method.** The I/O point is the centroid of the outbound docks (fallbacks: inbound docks, then floor centre). SKUs are slotted per the chosen strategy, then for each synthetic order a **nearest-neighbour picking tour** runs I/O → locations → I/O (per zone for zone picking; shared across the group for batch/wave; the return leg is dropped when the whole tour is chain-covered, see §5b). Per-line handling = 12 s base + the storage system's delta; goods-to-person lines cost their machine cycle instead of walking. KPIs: **throughput** = orders ÷ total picker time × 3600; **avg pick travel** = total tour distance ÷ orders; **storage fill %** = positions used ÷ positions available; plus the P3 inventory KPIs of §5. Randomness is split into four independent seeded sub-streams (SKUs, slotting, orders, flow noise), so the whole thing stays a pure function of *(layout, seed, config)* — identical inputs give identical KPIs, byte for byte.

---

## 8. The MRO-distributor preset (P3)

The one-click preset "**Industrial MRO distributor (illustrative)**" loads a 40 × 24 m floor with three selective rack rows, drive-in, push-back, pallet-flow and double-deep deep-lane blocks, an AS/RS crane aisle and shuttle system, carton-flow and mezzanine small-parts picking, a conveyor spine with feeders, push/pull stations, staging at both ends, a pack station and paired inbound/outbound docks — with 240 SKUs at demand skew 1.15 (a hard 80/20), pull replenishment and ABC slotting.

It is **independent and illustrative**, assembled from publicly known patterns of the industrial-MRO distribution segment (very high SKU count, strong Pareto skew, small-parts fast-pick faces, AS/RS + conveyor spine). It is **not affiliated with, endorsed by, or a depiction of Würth** or any real company; no real layout, data or branding is used.
