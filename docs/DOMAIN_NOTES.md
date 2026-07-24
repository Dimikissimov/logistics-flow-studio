# Domain notes (Pass 1)

The reference behind WarehouseTwin's Pass 1 model. Everything here is a **simplified, synthetic teaching model**. Dimensions of standardised objects (pallets) are drawn from public standards; the operational figures (densities, selectivity, costs, picker speed) are **illustrative order-of-magnitude values**, not vendor specifications and not a certification of anything. Where a number is an assumption, it says so.

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

## 2. Carton / box types

Synthetic but plausible EU carton sizes (mm), used for case-level detail in later passes and to seed "cartons per pallet" intuition in Pass 1.

| ID | Label | L × W × H (mm) | Mass (kg) |
|----|-------|----------------|-----------|
| C10 | Small carton | 200 × 150 × 120 | 2 |
| C20 | Medium carton | 400 × 300 × 250 | 8 |
| C30 | Large carton | 600 × 400 × 300 | 15 |
| EURO-CASE | Euro case | 400 × 300 × 200 | 6 |

The 400 × 300 and 600 × 400 modules are common Euro-case footprints (they tile onto the 1200 × 800 pallet). Masses are assumptions.

---

## 3. Storage & flow elements (Pass 1 palette)

Two are **storage** systems (they contribute pallet positions to the simulation); the rest are **flow** elements.

### Storage systems

| System | Density (pos./m² of footprint) | Selectivity | Rotation | Cost index | Character |
|--------|-------------------------------|-------------|----------|-----------|-----------|
| Selective racking (single-deep) | 2.4 | 100% | FIFO/LIFO | ×3 | Every pallet directly accessible. Needs a working aisle in front. The default, flexible choice. |
| Block-stack zone (floor) | 3.2 | ~35% | LIFO | ×1 | No racking: highest floor density and lowest cost, but LIFO and "honeycombing" losses hurt selectivity. |

**How to read these:** *Density* is pallet positions per square metre of the **element's own footprint** (roughly accounting for beam levels and pallet gaps) — the working aisle a system needs is placed **separately** on the floor, so it isn't baked into this number. *Selectivity* is the share of stored pallets you can reach without moving another pallet. *Cost index* is relative capital cost per position (1 = cheapest). These are teaching values consistent with general materials-handling literature (e.g. the classic selectivity-vs-density trade-off between selective racking and block/drive-in storage); they are **not** quotations from any manufacturer.

`WT.domain.elementCapacity(el)` = `round(footprint_area_m² × density)`.

### Flow elements

- **Dock door (inbound / receiving):** where goods enter the flow.
- **Dock door (outbound / shipping):** where picked orders leave. It is the **default I/O point** for pick-travel measurement (the simulation starts and ends picking tours here; it falls back to inbound docks, then the floor centre).
- **Staging area:** marshalling buffer for put-away or order consolidation — a buffer, not long-term storage.
- **Conveyor segment:** powered internal transport between zones.
- **Push station / Pull station:** the two classic control philosophies (see §5).

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

SKU popularity in the simulation follows a **Zipf-like distribution** (rank *r* popularity ∝ 1/*r*), which is what makes ABC slotting pay off.

---

## 5. Push vs. pull

- **Push:** material is released into storage on a **forecast or schedule** (make-to-stock). It can build a buffer ahead of demand — good for smoothing, at the cost of holding inventory.
- **Pull:** material moves only when a **downstream order or kanban signal** asks for it (make-to-order). It holds less inventory and is demand-paced, but is more sensitive to demand spikes.

Pass 1 places these as control points on the floor; Pass 3 will model their inventory dynamics in the flow chain.

---

## 6. Aisle-width guidance (informed by DIN 15185)

**DIN 15185-1** covers the safety of storage installations and the design of **working aisles**. Different trucks need different aisle widths:

| Truck type | Typical working aisle |
|------------|-----------------------|
| Counterbalance | ~3.5–4.0 m |
| Reach truck | ~2.7–3.0 m |
| VNA (man-up turret, guided) | ~1.5–1.8 m |

WarehouseTwin uses a **single configurable minimum working-aisle gap** between facing racking rows (default **2.9 m**, a reach-truck aisle; presets for VNA and counterbalance are provided). When two storage rows face each other with a positive gap **smaller** than the minimum, the app flags it (a dashed red link + an "aisle too narrow" badge).

This is a **design aid to keep layouts sane — it is not a compliance check or certification.** A full standards panel (with load and clearance notes) is planned for Pass 2, and will remain "informed by / aligned to", never "certified".

---

## 7. Simulation parameters (assumptions)

All synthetic, all documented in `simulation.js`:

| Parameter | Value | Basis |
|-----------|-------|-------|
| Picker walking speed | 1.2 m/s | Brisk walking pace (rule of thumb). |
| Handling time per pick line | 12 s | Grab/scan/place assumption. |
| SKU popularity skew | Zipf exponent 1.0 | Classic heavy-tail demand. |
| Pallets per SKU (mean) | 1.5 | Inventory-per-SKU assumption. |
| Pickers | 1 | Single-picker default. |

**Method.** The I/O point is the centroid of the outbound docks (fallbacks: inbound docks, then floor centre). SKUs are slotted per the chosen strategy, then for each synthetic order a **nearest-neighbour picking tour** runs I/O → locations → I/O. KPIs: **throughput** = orders ÷ total picker time × 3600; **avg pick travel** = total tour distance ÷ orders; **storage fill %** = positions used ÷ positions available; **positions used/total**. The whole thing is a pure function of *(layout, seed, config)* — identical inputs give identical KPIs.
