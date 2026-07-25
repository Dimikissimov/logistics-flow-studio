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

    // ================================================================
    // P3 RULES - material-flow chains, storage-system mix, push vs pull
    // ================================================================

    // ---- Rule 6: material-flow chain integrity ----------------------
    const chains = D.analyzeChains(els);
    if (chains.warnings.length) {
      for (const w of chains.warnings) {
        out.push(s(
          w.severity,
          w.msg,
          "A complete material-flow chain (dock → staging → put-away → storage → replenish → pick → pack → ship) lets conveyors carry goods between covered legs; a broken chain forces manual travel and handling.",
          w.code === "no-pick-feed"
            ? "Connect storage to the outbound dock with conveyor segments (via a pack station). Chained legs drop the tour's return leg and save handling time in the sim."
            : "Fix the flagged link so the chain closes - the flow arrows on the floor show what is connected."
        ));
      }
    } else if (chains.outboundConnected && storage.length) {
      const covered = storage.filter((e) => chains.outboundCovered.has(e.id)).length;
      out.push(s(
        "good",
        `Material-flow chain is closed: ${covered}/${storage.length} storage element${storage.length > 1 ? "s are" : " is"} chained to shipping.`,
        "Connected chains let goods ride the conveyor - the sim drops the pick tour's return leg and saves handling on covered lines.",
        base.ok ? `~${base.chainAssistedLinesPct.toFixed(0)}% of pick lines are chain-assisted at this layout/seed.` : "Run the sim to measure the covered share."
      ));
    }

    // ---- Rule 7: LIFO share vs FIFO-critical SKUs --------------------
    if (base.ok && storage.length) {
      let lifoPos = 0, totalPos = 0;
      for (const e of storage) {
        const def = D.ELEMENTS[e.type];
        const cap = D.elementCapacity(e);
        totalPos += cap;
        if (def.rotation === "LIFO") lifoPos += cap;
      }
      const lifoShare = totalPos > 0 ? lifoPos / totalPos : 0;
      if (lifoShare >= 0.35) {
        out.push(s(
          "medium",
          `~${(lifoShare * 100).toFixed(0)}% of pallet positions are in LIFO systems (push-back / drive-in / block-stack).`,
          "LIFO lanes cannot guarantee first-in-first-out rotation. SKUs with shelf life, batch traceability or revision control are FIFO-critical.",
          "Keep FIFO-critical SKUs in pallet-flow (true FIFO), selective racking or carton-flow; reserve the LIFO lanes for stable, single-batch volume movers."
        ));
      }
    }

    // ---- Rule 8: high-velocity small parts -> carton-flow ------------
    if (base.ok && storage.length) {
      const hasPickFace = storage.some((e) => (D.ELEMENTS[e.type] || {}).pickFace);
      if (!hasPickFace && config.skuCount >= 120) {
        out.push(s(
          "medium",
          `${config.skuCount} SKUs with no carton-flow / mezzanine pick faces.`,
          "High-velocity small parts pick fastest from carton-flow lanes: goods presented at an ergonomic face, FIFO at carton level.",
          `Add carton-flow pick faces for the A-items - in this model they save ${Math.abs(D.ELEMENTS["carton-flow"].handlingDeltaSec)} s per pick line vs the base handling time.`
        ));
      }
    }

    // ---- Rule 9: push vs pull, measured with the sim -----------------
    if (base.ok) {
      const lay = { elements: els, gridW: layout.gridW, gridH: layout.gridH, cell };
      const push = WT.sim.run(lay, Object.assign({}, config, { flowMode: "push" }));
      const pull = WT.sim.run(lay, Object.assign({}, config, { flowMode: "pull" }));
      const cur = config.flowMode === "push" ? push : pull;
      const alt = config.flowMode === "push" ? pull : push;
      const altName = config.flowMode === "push" ? "PULL (replenish on consumption)" : "PUSH (replenish to forecast)";
      if (alt.stockoutPct < cur.stockoutPct - 1) {
        out.push(s(
          "medium",
          `${(config.flowMode || "pull").toUpperCase()} replenishment shows ~${cur.stockoutPct.toFixed(1)}% stockout lines at this seed.`,
          "Push (periodic, forecast-driven top-ups) can run dry between review cycles and bounces overstock back when the forecast overshoots; pull (reorder-point, consumption-driven) follows real demand.",
          `Switching to ${altName} measures ${alt.stockoutPct.toFixed(1)}% stockouts vs ${cur.stockoutPct.toFixed(1)}% ` +
            `(overstock ${alt.overstockUnits} vs ${cur.overstockUnits} units; avg face stock ${alt.avgFaceStockPct.toFixed(0)}% vs ${cur.avgFaceStockPct.toFixed(0)}%).`
        ));
      } else {
        out.push(s(
          "good",
          `${(config.flowMode || "pull").toUpperCase()} replenishment is the better fit here (~${cur.stockoutPct.toFixed(1)}% stockout lines).`,
          "Push vs pull is a service-level vs inventory trade-off; both are measured with the same seeded simulation.",
          `The alternative (${altName}) measures ${alt.stockoutPct.toFixed(1)}% stockouts and ${alt.overstockUnits} overstock units.`
        ));
      }
    }

    // ---- Rule 10: goods-to-person systems need a takeaway chain ------
    for (const e of storage) {
      const def = D.ELEMENTS[e.type];
      if (def.goodsToPerson && !chains.outboundCovered.has(e.id)) {
        out.push(s(
          "medium",
          `${def.label} at (${e.x}, ${e.y}) is not chained to shipping.`,
          "Goods-to-person systems (AS/RS crane, shuttle) normally discharge onto a takeaway conveyor toward pack/ship - informed by DIN EN 619 conveyor practice and VDI 3564 high-bay guidance (not a certification).",
          "Run conveyor segments from the system to a pack station and the outbound dock so its machine cycles feed a connected flow."
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
})();
