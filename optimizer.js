/* =====================================================================
 * Logistics Flow Studio - WarehouseTwin
 * optimizer.js - spatial-layout optimizer (P2)
 * ---------------------------------------------------------------------
 * A transparent, deterministic HEURISTIC (not a trained model). It
 * implements the "golden-zone" idea: high-throughput storage should sit
 * closest to the outbound dock. It does a greedy hill-climb that steps
 * storage elements one cell at a time toward the I/O point, keeping the
 * layout legal (in bounds, no overlap, and never increasing the count of
 * DIN 15185-informed aisle violations). Flow elements (docks, staging,
 * conveyor, push/pull) stay put - they anchor the flow.
 *
 * It never mutates the caller's layout: it works on clones and returns a
 * proposal plus before/after KPIs (measured with the REAL sim) so the UI
 * can preview the change before the user accepts it.
 * ===================================================================== */
(function () {
  "use strict";
  const WT = (window.WT = window.WT || {});
  const D = WT.domain;

  function isStorage(el) {
    return (D.ELEMENTS[el.type] || {}).category === "storage";
  }

  function optimize(layout, config) {
    const cell = layout.cell || D.METRES_PER_CELL;
    const gridW = layout.gridW, gridH = layout.gridH;

    // Baseline KPIs on the original layout (real sim).
    const before = WT.sim.run(
      { elements: layout.elements, gridW, gridH, cell },
      config
    );

    // Work on clones so we never touch the caller's objects.
    const els = layout.elements.map((e) => Object.assign({}, e));
    const original = layout.elements.map((e) => ({ id: e.id, x: e.x, y: e.y }));

    const io = WT.sim.ioPointOf(els, gridW, gridH, cell);

    const inB = (r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= gridW && r.y + r.d <= gridH;
    const overlaps = (cand, exceptIdx) =>
      els.some(
        (o, k) =>
          k !== exceptIdx &&
          cand.x < o.x + o.w && o.x < cand.x + cand.w &&
          cand.y < o.y + o.d && o.y < cand.y + cand.d
      );
    const distM = (e) => Math.hypot((e.x + e.w / 2) * cell - io.x, (e.y + e.d / 2) * cell - io.y);

    const storageIdx = [];
    els.forEach((e, i) => { if (isStorage(e)) storageIdx.push(i); });

    let curViol = D.aisleViolations(els, config.minAisleMetres).length;

    // Greedy hill-climb. Each pass tries to step every storage element one
    // cell closer to the I/O point. Distance must strictly decrease, which
    // guarantees termination. Bigger-capacity storage gets first pick of
    // the golden zone (processed first each pass).
    const MAX_PASSES = 400;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      let anyMove = false;
      const order = storageIdx
        .slice()
        .sort((p, q) => D.elementCapacity(els[q]) - D.elementCapacity(els[p]));
      for (const i of order) {
        const e = els[i];
        const cxM = (e.x + e.w / 2) * cell, cyM = (e.y + e.d / 2) * cell;
        const stepX = cxM > io.x + 1e-9 ? -1 : cxM < io.x - 1e-9 ? 1 : 0;
        const stepY = cyM > io.y + 1e-9 ? -1 : cyM < io.y - 1e-9 ? 1 : 0;
        const before0 = distM(e);
        // Prefer a diagonal step, then single-axis steps.
        const tries = [];
        if (stepX && stepY) tries.push({ x: e.x + stepX, y: e.y + stepY });
        if (stepY) tries.push({ x: e.x, y: e.y + stepY });
        if (stepX) tries.push({ x: e.x + stepX, y: e.y });
        for (const t of tries) {
          const cand = { x: t.x, y: t.y, w: e.w, d: e.d };
          if (!inB(cand) || overlaps(cand, i)) continue;
          const ox = e.x, oy = e.y;
          e.x = cand.x; e.y = cand.y;
          const newViol = D.aisleViolations(els, config.minAisleMetres).length;
          if (newViol <= curViol && distM(e) < before0 - 1e-9) {
            curViol = newViol;
            anyMove = true;
            break; // accept; move to next element
          }
          e.x = ox; e.y = oy; // revert
        }
      }
      if (!anyMove) break;
    }

    // KPIs after (real sim, same config -> isolates the spatial effect).
    const after = WT.sim.run({ elements: els, gridW, gridH, cell }, config);

    // Count elements that actually moved.
    let movedCount = 0;
    const moves = [];
    for (const o of original) {
      const now = els.find((e) => e.id === o.id);
      if (now && (now.x !== o.x || now.y !== o.y)) {
        movedCount++;
        moves.push({ id: o.id, from: { x: o.x, y: o.y }, to: { x: now.x, y: now.y } });
      }
    }

    const travelBefore = before.avgPickTravelM;
    const travelAfter = after.avgPickTravelM;
    const travelDeltaPct =
      travelBefore > 0 ? ((travelBefore - travelAfter) / travelBefore) * 100 : 0;

    return {
      ok: before.ok && after.ok,
      proposedElements: els,
      before,
      after,
      movedCount,
      moves,
      travelDeltaPct,
      improved: after.avgPickTravelM < before.avgPickTravelM - 1e-6,
      aisleViolations: curViol,
    };
  }

  WT.optimizer = { optimize };

  /* ==================================================================
   * TODO (P2+/P5): richer optimisation - simulated annealing / swaps of
   * whole rack rows, multi-objective (travel + fill + aisle safety),
   * and per-SKU slot assignment once the sim exposes slot-level control.
   * ================================================================== */
})();
