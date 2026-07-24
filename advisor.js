/* =====================================================================
 * Logistics Flow Studio - WarehouseTwin
 * advisor.js - offline heuristic advisor (P2)
 * ---------------------------------------------------------------------
 * A RULE / HEURISTIC engine - NOT a trained or black-box model. It reads
 * the current layout + demand config and returns a ranked list of
 * explained suggestions. Every suggestion states three things:
 *   finding   - what it observed
 *   principle - the operations-research / warehousing idea behind it
 *   impact    - an ESTIMATED effect, measured with the real simulation
 *               wherever a number is possible (else clearly qualitative)
 *
 * Deterministic: it only calls the pure sim (fixed seed from config) and
 * the deterministic optimizer, so the same inputs give the same advice.
 * ===================================================================== */
(function () {
  "use strict";
  const WT = (window.WT = window.WT || {});
  const D = WT.domain;

  // severity -> sort weight (lower sorts first)
  const RANK = { high: 0, medium: 1, low: 2, good: 3 };

  function s(severity, finding, principle, impact) {
    return { severity, finding, principle, impact };
  }

  function analyze(layout, config) {
    const cell = layout.cell || D.METRES_PER_CELL;
    const els = layout.elements || [];
    const storage = els.filter((e) => (D.ELEMENTS[e.type] || {}).category === "storage");
    const out = [];

    const base = WT.sim.run(
      { elements: els, gridW: layout.gridW, gridH: layout.gridH, cell },
      config
    );

    // ---- Rule 1: slotting strategy (measured random vs ABC) --------
    if (storage.length && base.ok) {
      const rnd = WT.sim.run({ elements: els, gridW: layout.gridW, gridH: layout.gridH, cell }, Object.assign({}, config, { strategy: "random" }));
      const abc = WT.sim.run({ elements: els, gridW: layout.gridW, gridH: layout.gridH, cell }, Object.assign({}, config, { strategy: "abc" }));
      const deltaPct = rnd.avgPickTravelM > 0 ? ((rnd.avgPickTravelM - abc.avgPickTravelM) / rnd.avgPickTravelM) * 100 : 0;
      if (config.strategy === "random") {
        out.push(s(
          "high",
          "Random slotting is active.",
          "ABC 80/20 (Pareto) slotting puts the ~20% of SKUs that drive ~80% of picks in the locations nearest the I/O point.",
          `Switching to ABC 80/20 is estimated to cut average pick travel by ~${deltaPct.toFixed(0)}% ` +
            `(${rnd.avgPickTravelM.toFixed(1)} → ${abc.avgPickTravelM.toFixed(1)} m/order) at seed ${config.seed}.`
        ));
      } else {
        out.push(s(
          "good",
          "ABC 80/20 slotting is active.",
          "Fast movers are slotted near the I/O point (golden-zone placement).",
          `Measured benefit vs random at this layout/seed: ~${deltaPct.toFixed(0)}% less travel ` +
            `(${abc.avgPickTravelM.toFixed(1)} vs ${rnd.avgPickTravelM.toFixed(1)} m/order).`
        ));
      }
    }

    // ---- Rule 2: golden-zone / spatial placement (uses optimizer) --
    if (storage.length && base.ok && WT.optimizer) {
      const opt = WT.optimizer.optimize(
        { elements: els, gridW: layout.gridW, gridH: layout.gridH, cell },
        config
      );
      if (opt.improved && opt.travelDeltaPct >= 2 && opt.movedCount > 0) {
        out.push(s(
          "medium",
          `Storage sits farther from the outbound dock than it needs to (${opt.movedCount} element${opt.movedCount > 1 ? "s" : ""} could move closer).`,
          "Golden-zone / I/O-centric layout: keeping high-throughput storage closest to the shipping dock shortens every picking tour.",
          `Relocating storage toward the dock is estimated to cut average pick travel ~${opt.travelDeltaPct.toFixed(0)}% ` +
            `(${opt.before.avgPickTravelM.toFixed(1)} → ${opt.after.avgPickTravelM.toFixed(1)} m/order). Use the Layout optimizer to preview it.`
        ));
      } else {
        out.push(s(
          "good",
          "Storage is already well-placed relative to the outbound dock.",
          "Golden-zone / I/O-centric layout.",
          "The optimizer found no material travel saving from moving storage closer."
        ));
      }
    }

    // ---- Rule 3: aisle width (DIN 15185-informed live check) -------
    const viol = D.aisleViolations(els, config.minAisleMetres);
    if (viol.length) {
      const narrowest = Math.min.apply(null, viol.map((v) => v.gapM));
      out.push(s(
        "high",
        `${viol.length} rack-row gap${viol.length > 1 ? "s are" : " is"} below the ${config.minAisleMetres} m minimum working aisle (narrowest ${narrowest.toFixed(1)} m).`,
        "DIN 15185-informed working-aisle guidance: trucks need a minimum clear aisle to turn and access racking safely.",
        "Widen the flagged aisles, or select a narrower-aisle truck class (e.g. VNA). Design guidance only - not a compliance certification."
      ));
    } else if (storage.length >= 2) {
      out.push(s(
        "good",
        `All rack-row aisles meet the ${config.minAisleMetres} m minimum.`,
        "DIN 15185-informed working-aisle guidance.",
        "No aisle-width issues at the current truck-class setting."
      ));
    }

    // ---- Rule 4: dock & staging placement --------------------------
    const dockOut = els.filter((e) => e.type === "dock-out");
    if (dockOut.length === 0) {
      out.push(s(
        "medium",
        "No outbound (shipping) dock placed.",
        "An I/O point anchors material flow; without it, pick travel is measured from the floor centre.",
        "Add a Dock door (outbound) so travel and throughput reflect a real shipping point."
      ));
    } else {
      const io = WT.sim.ioPointOf(els, layout.gridW, layout.gridH, cell);
      const staging = els.filter((e) => e.type === "staging");
      const nearStaging = staging.some((e) => {
        const d = Math.hypot((e.x + e.w / 2) * cell - io.x, (e.y + e.d / 2) * cell - io.y);
        return d <= 12; // within ~12 m of the dock
      });
      if (!nearStaging) {
        out.push(s(
          "low",
          "No staging/marshalling area near the outbound dock.",
          "A staging buffer by shipping speeds order consolidation and truck loading and decouples picking from dispatch.",
          "Add a Staging area within ~10 m of the outbound dock to model consolidation."
        ));
      }
    }

    // ---- Rule 5: storage utilization (fill %) ----------------------
    if (!base.ok) {
      out.push(s(
        "high",
        "No pallet positions available.",
        "You need storage capacity before demand can be slotted or picked.",
        "Place at least one selective racking or block-stack element."
      ));
    } else {
      const fill = base.storageFillPct;
      if (fill >= 95) {
        out.push(s(
          "medium",
          `Storage is ~${fill.toFixed(0)}% full — almost no working slack.`,
          "High occupancy causes congestion, blocked put-away and honeycombing; ~85% is a common practical target.",
          `Add pallet positions or reduce inventory (${base.palletPositionsUsed}/${base.palletPositionsTotal} used).`
        ));
      } else if (fill < 40) {
        out.push(s(
          "medium",
          `Storage is only ~${fill.toFixed(0)}% full — capital and floor space are under-used.`,
          "Right-size storage to demand: unused positions are paid-for capacity sitting idle.",
          `Consolidate storage or add SKUs (${base.palletPositionsUsed}/${base.palletPositionsTotal} used).`
        ));
      } else {
        out.push(s(
          "good",
          `Storage fill (~${fill.toFixed(0)}%) is in a healthy band.`,
          "Keeping occupancy near ~85% balances utilisation against working slack.",
          `${base.palletPositionsUsed}/${base.palletPositionsTotal} positions used.`
        ));
      }
    }

    // rank: high -> medium -> low -> good, stable within a tier
    out.forEach((x, i) => (x._i = i));
    out.sort((a, b) => (RANK[a.severity] - RANK[b.severity]) || (a._i - b._i));
    out.forEach((x) => delete x._i);
    return out;
  }

  WT.advisor = { analyze };

  /* ==================================================================
   * TODO (P3+): more rules as the domain grows - FIFO/LIFO vs product
   * shelf-life, cross-dock candidates, replenishment cadence, push vs
   * pull inventory sizing, congestion hotspots, energy/AGV routing.
   * The panel renders whatever analyze() returns, so new rules need no
   * UI change.
   * ================================================================== */
})();
