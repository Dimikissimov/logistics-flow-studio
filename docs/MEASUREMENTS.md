# Pinned measurements

Every headline number quoted for WarehouseTwin should be reproducible from the code in this
repo. This file pins the measurements behind the headline claims — the exact configuration, the
exact numbers, and the script that reproduces them. All data is **synthetic and seeded**; these
are demonstrations of method, not claims about any real warehouse.

## One-click layout optimizer — pick travel on the starter demo layout

**Pinned result (current code): −48.6% average pick travel.**

| | avg pick travel (m/order) |
|---|---|
| Demo layout as drawn | 36.70 |
| After the optimizer's proposal | 18.85 |
| **Delta** | **−48.6%** (5 storage elements moved) |

**Configuration** (the app's first-run defaults, `app.js`): starter demo layout from
`demoLayout()`, seed **42**, **ABC 80/20** slotting, **200** orders, **80** SKUs, pull
replenishment, DIN 15185-informed minimum aisle 2.9 m, EUR1 pallets. The optimizer
(`optimizer.js`) measures before/after with the real simulation (`simulation.js`) at the same
seed, so the delta isolates the spatial change. Deterministic: the same code always produces
the same numbers.

**Reproduce it:**

```bash
node measure_optimizer.js
```

The script runs the real app modules headlessly (no browser needed), rebuilds the demo layout
exactly as `app.js` does, and prints the table above. Or in the app itself: load the demo
layout, keep the default settings, and press **Optimize layout** — the preview panel shows the
same before/after KPIs.

### Measurement history

- **−49.8%** — measured on the Pass 2 build (commit `89c7667`, 2026-07-24), the figure quoted
  in early write-ups.
- **−48.6%** — current code. Pass 3 (2026-07-25) deepened the simulation physics
  (material-flow chains, push/pull pick-face inventory, per-system handling), which shifted
  the baseline slightly. The current figure is the one to cite; anything citing −49.8% is
  referring to the P2 build.

## A/B strategy comparison — ABC 80/20 vs random slotting

**Pinned result (current code): ABC 80/20 beats random slotting by ~21% average pick travel**
on the starter demo layout (46.71 → 36.70 m/order), same seed, same layout, same reproduction
script and configuration as above. This is the measurement behind the advisor's
"switch to ABC 80/20" suggestion (`advisor.js` runs this exact comparison live).

*History: the Pass 2 build measured ~26% for the same comparison; the Pass 3 simulation
physics shifted it to ~21%. Cite ~21% for the current code.*

## Pick-travel heatmap — conservation invariant (Round 2)

**Pinned invariant (current code): the heatmap's total walked metres equals the charged
travel (avg pick travel × orders served) to floating-point precision, for every picking
strategy** — random, ABC, zone, batch and wave — on the starter demo layout at the default
configuration. The heatmap is built from the exact tour legs the travel KPI charges (sampled
in ~0.5 m steps onto the 1 m grid), so it cannot show more or less walking than the KPI.
It is deterministic like everything else: same seed → byte-identical cells.

**Reproduce it:**

```bash
node verify_heatmap.js
```

The script also re-asserts the KPI baselines above (ABC 36.70 / random 46.71 m per order) so
a heatmap change can never silently move the simulation numbers.
