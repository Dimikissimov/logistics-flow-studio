/* =====================================================================
 * Logistics Flow Studio - WarehouseTwin
 * iso.js - the 2.5D ISOMETRIC PRESENTATION projection + renderer helper.
 * ---------------------------------------------------------------------
 * A "3D-ish" presentation view: the same top-down warehouse floor, but
 * every rack / dock / conveyor / station is drawn as an EXTRUDED iso
 * block with HEIGHT (top face + two shaded side faces), depth-sorted
 * back-to-front. It is a VIEW MODE only - the top-down editor stays the
 * accurate, editable source of truth.
 *
 * HONESTY (read this):
 *   - This is an ILLUSTRATIVE visualization: NOT a survey, NOT a BIM model.
 *     The real BIM/IFC export is the separate ifc.js feature (ifc.js).
 *   - Element heights are ILLUSTRATIVE DEFAULTS. Where the domain model
 *     carries an assumed `heightM` (domain.js, also used by the IFC
 *     export) we reuse THAT single value so the two features never drift;
 *     the HEIGHTS table here is an independent fallback with the same
 *     order-of-magnitude teaching numbers. None of these are measured.
 *
 * PROJECTION (documented, deterministic, pure):
 *   Classic 2:1 dimetric "isometric" (the pixel-art game convention).
 *   For a world point (cx, cy, cz) - cx/cy in grid CELLS (= metres,
 *   domain METRES_PER_CELL = 1) and cz a HEIGHT in metres - the 2D iso
 *   screen offset, in CELL UNITS, is:
 *
 *       sx = (cx - cy) * KX
 *       sy = (cx + cy) * KY - cz * KZ
 *
 *   with KX : KY = 2 : 1 (that is the "2:1"). Consequences (the tested
 *   invariants):
 *     - +x  -> screen right AND down   (dsx=+KX, dsy=+KY)
 *     - +y  -> screen left  AND down   (dsx=-KX, dsy=+KY)
 *     - +z  -> screen UP               (dsy=-KZ), sx unchanged
 *     - the map is LINEAR, so collinear world points stay collinear.
 *   `project` returns CELL-unit offsets; the renderer multiplies by the
 *   viewport's px-per-cell so the iso scene COMPOSES with WT.view's
 *   zoom/pan exactly like every other world-space draw call (it lives
 *   inside the same ctx.translate(pan)/scale(zoom) block in app.js).
 *
 * The pure parts (project, elementHeight, HEIGHTS, ISO, depthKey,
 * sortByDepth) are DOM-free and unit-tested headlessly by verify_iso.js.
 * `drawScene` is the only canvas-touching helper (verified live in the
 * browser, not in the headless harness).
 *
 * No frameworks, no build step. Attaches to the global `WT` namespace so
 * it works from file:// as a classic script (not an ES module).
 * ===================================================================== */
(function () {
  "use strict";
  const WT = (window.WT = window.WT || {});

  /* ------------------------------------------------------------------
   * Projection constants (in CELL units). KX:KY = 2:1 is the classic
   * 2:1 dimetric ratio. KZ is how much one METRE of height rises the
   * point on screen - an ILLUSTRATIVE presentation constant (tuned so a
   * 20 m AS/RS high-bay reads as a tower without leaving the viewport),
   * NOT a measured scale.
   * ------------------------------------------------------------------ */
  const ISO = {
    KX: 0.5, // screen-x per cell along each ground axis (half tile width)
    KY: 0.25, // screen-y per cell along each ground axis (half tile height)
    KZ: 0.28, // screen-y RISE per metre of height (illustrative)
  };

  // Pure, deterministic 2:1 dimetric projection. cz defaults to 0 (floor).
  // Returns the iso screen offset in CELL units (multiply by px-per-cell).
  function project(cx, cy, cz) {
    const z = cz || 0;
    return {
      x: (cx - cy) * ISO.KX,
      y: (cx + cy) * ISO.KY - z * ISO.KZ,
    };
  }

  /* ------------------------------------------------------------------
   * ILLUSTRATIVE per-element-type heights, in METRES. These mirror the
   * domain model's assumed `heightM` (domain.js / ifc.js) so the 2.5D
   * view and the IFC export agree. Grounded honestly by system class:
   * racking tall, block-stack medium, docks/staging/conveyor low,
   * mezzanine/AS-RS/shuttle tall. NOT surveyed, NOT measured.
   * ------------------------------------------------------------------ */
  const HEIGHTS = {
    "selective-racking": 6.0,
    "block-stack": 4.5,
    "drive-in": 6.0,
    "double-deep": 6.0,
    "push-back": 6.0,
    "pallet-flow": 6.0,
    "carton-flow": 2.5,
    "mobile-racking": 8.0,
    "cantilever": 5.0,
    "asrs": 20.0,
    "shuttle": 12.0,
    "mezzanine": 5.0,
    "dock-in": 4.5,
    "dock-out": 4.5,
    "staging": 1.5,
    "conveyor": 0.9,
    "push-station": 1.2,
    "pull-station": 1.2,
    "pack-station": 1.1,
    "rgv": 1.2,
    "agv": 0.8,
  };

  // Fallback used when a type is unknown to BOTH the domain model and the
  // HEIGHTS table (keeps the extrusion positive & finite - a low block).
  const DEFAULT_HEIGHT = 1.0;

  /* ------------------------------------------------------------------
   * The height (metres) used to extrude a given element TYPE. Prefers
   * the domain model's assumed `heightM` (the SINGLE source of truth,
   * shared with the IFC export) when available; otherwise the local
   * HEIGHTS fallback; otherwise DEFAULT_HEIGHT. Always a positive,
   * finite number.
   * ------------------------------------------------------------------ */
  function elementHeight(type) {
    const dom = WT.domain && WT.domain.ELEMENTS && WT.domain.ELEMENTS[type];
    if (dom && isFinite(dom.heightM) && dom.heightM > 0) return dom.heightM;
    const h = HEIGHTS[type];
    if (isFinite(h) && h > 0) return h;
    return DEFAULT_HEIGHT;
  }

  /* ------------------------------------------------------------------
   * Painter's-algorithm depth key for a footprint {x, y, w, d}. Larger
   * key = nearer the viewer (further down-screen) = drawn LATER (on
   * top). We key on the element's FRONT-bottom corner (x+w)+(y+d): the
   * corner closest to the camera. Back-to-front order is therefore the
   * ASCENDING key. This footprint-based sort is an illustrative choice
   * (exact per-pixel occlusion between interpenetrating blocks is not
   * modelled - honest, and fine for a presentation view).
   * ------------------------------------------------------------------ */
  function depthKey(el) {
    const w = el.w || 0, d = el.d || 0;
    return (el.x + w) + (el.y + d);
  }

  // Return a NEW array of the items sorted BACK-TO-FRONT (painter's
  // order): ascending front-corner depth, then ascending back-corner
  // (x+y), then original index - fully deterministic and stable.
  function sortByDepth(items) {
    return items
      .map((el, i) => ({ el, i }))
      .sort((a, b) => {
        const dk = depthKey(a.el) - depthKey(b.el);
        if (dk !== 0) return dk;
        const bk = (a.el.x + a.el.y) - (b.el.x + b.el.y);
        if (bk !== 0) return bk;
        return a.i - b.i;
      })
      .map((r) => r.el);
  }

  /* ------------------------------------------------------------------
   * Colour helper: multiply a #rrggbb hex by `f` (f>1 brightens, f<1
   * darkens) and clamp - used to shade the top / right / left faces so
   * the extrusion reads as a solid without any lighting model.
   * ------------------------------------------------------------------ */
  function shade(hex, f) {
    const h = String(hex || "#888888").replace("#", "");
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const c = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
    return "rgb(" + c(r) + "," + c(g) + "," + c(b) + ")";
  }

  // Face shade multipliers (top brightest, then right, then left).
  const FACE = { top: 1.14, right: 0.82, left: 0.6 };

  /* ==================================================================
   * RENDERER HELPERS (canvas). Only called from the app's render loop;
   * NOT exercised by the headless harness (no DOM in the sandbox).
   * ================================================================== */

  // Draw one extruded iso block for a world footprint {x,y,w,d} of height
  // `h` metres, coloured from `baseColor`. `P(cx,cy,cz)` maps a world
  // point to CANVAS base-px (the caller supplies it so the block lands in
  // the same world transform as everything else). Draws the two viewer-
  // facing side faces first, then the top face on top (painter's order
  // WITHIN the block).
  function drawBox(ctx, P, x, y, w, d, h, baseColor, opts) {
    const o = opts || {};
    // Footprint corners: A back, B right, C front, D left.
    const Ab = P(x, y, 0), Bb = P(x + w, y, 0), Cb = P(x + w, y + d, 0), Db = P(x, y + d, 0);
    const At = P(x, y, h), Bt = P(x + w, y, h), Ct = P(x + w, y + d, h), Dt = P(x, y + d, h);

    ctx.lineJoin = "round";
    ctx.lineWidth = 1;

    // Left face (y = y+d): D-C edge, going up. Darkest.
    ctx.beginPath();
    ctx.moveTo(Db.x, Db.y); ctx.lineTo(Cb.x, Cb.y); ctx.lineTo(Ct.x, Ct.y); ctx.lineTo(Dt.x, Dt.y); ctx.closePath();
    ctx.fillStyle = shade(baseColor, FACE.left);
    ctx.fill();
    ctx.strokeStyle = shade(baseColor, FACE.left * 0.7);
    ctx.stroke();

    // Right face (x = x+w): B-C edge, going up. Medium.
    ctx.beginPath();
    ctx.moveTo(Bb.x, Bb.y); ctx.lineTo(Cb.x, Cb.y); ctx.lineTo(Ct.x, Ct.y); ctx.lineTo(Bt.x, Bt.y); ctx.closePath();
    ctx.fillStyle = shade(baseColor, FACE.right);
    ctx.fill();
    ctx.strokeStyle = shade(baseColor, FACE.right * 0.7);
    ctx.stroke();

    // Top face: A-B-C-D at height h. Brightest.
    ctx.beginPath();
    ctx.moveTo(At.x, At.y); ctx.lineTo(Bt.x, Bt.y); ctx.lineTo(Ct.x, Ct.y); ctx.lineTo(Dt.x, Dt.y); ctx.closePath();
    ctx.fillStyle = shade(baseColor, FACE.top);
    ctx.fill();
    ctx.strokeStyle = o.selected ? (o.selColor || "#38bdf8") : shade(baseColor, 0.9);
    ctx.lineWidth = o.selected ? 2.4 : 1;
    ctx.stroke();
  }

  /* ------------------------------------------------------------------
   * Draw the whole iso scene: the floor plane (a diamond with a light
   * grid) and every element as a depth-sorted extruded block. Everything
   * is in CANVAS base-px via the caller-supplied origin so it composes
   * with WT.view zoom/pan/Fit.
   *
   * opts = {
   *   elements, gridW, gridH, cellPx, originX, originY,
   *   colors,        // themeColors() from app.js
   *   elementDefs,   // WT.domain.ELEMENTS (for per-type colour)
   *   selectedId,    // highlighted (for parity with top-down selection)
   *   shortLabel,    // optional (type)->string for on-top labels
   * }
   * ------------------------------------------------------------------ */
  function drawScene(ctx, opts) {
    const o = opts || {};
    const gridW = o.gridW, gridH = o.gridH, cellPx = o.cellPx;
    const ox = o.originX || 0, oy = o.originY || 0;
    const colors = o.colors || {};
    const defs = o.elementDefs || {};

    // World (cell/metre) -> canvas base-px, through the iso projection.
    const P = (cx, cy, cz) => {
      const p = project(cx, cy, cz);
      return { x: ox + p.x * cellPx, y: oy + p.y * cellPx };
    };

    // ---- Floor plane (the warehouse footprint as an iso diamond) -----
    const c0 = P(0, 0, 0), c1 = P(gridW, 0, 0), c2 = P(gridW, gridH, 0), c3 = P(0, gridH, 0);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(c0.x, c0.y); ctx.lineTo(c1.x, c1.y); ctx.lineTo(c2.x, c2.y); ctx.lineTo(c3.x, c3.y); ctx.closePath();
    ctx.fillStyle = colors.bg || "#ffffff";
    ctx.fill();

    // Iso grid lines every 5 cells (strong) with lighter lines between.
    const grid = colors.grid || "#e8edf3";
    const gridStrong = colors.gridStrong || "#cbd5e1";
    ctx.lineWidth = 1;
    for (let x = 0; x <= gridW; x++) {
      const a = P(x, 0, 0), b = P(x, gridH, 0);
      ctx.strokeStyle = x % 5 === 0 ? gridStrong : grid;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    for (let y = 0; y <= gridH; y++) {
      const a = P(0, y, 0), b = P(gridW, y, 0);
      ctx.strokeStyle = y % 5 === 0 ? gridStrong : grid;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    // Floor outline.
    ctx.beginPath();
    ctx.moveTo(c0.x, c0.y); ctx.lineTo(c1.x, c1.y); ctx.lineTo(c2.x, c2.y); ctx.lineTo(c3.x, c3.y); ctx.closePath();
    ctx.strokeStyle = gridStrong;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    // ---- Elements: extruded blocks, back-to-front ---------------------
    const ordered = sortByDepth(o.elements || []);
    const labelFn = typeof o.shortLabel === "function" ? o.shortLabel : null;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const e of ordered) {
      const def = defs[e.type] || {};
      const h = elementHeight(e.type);
      drawBox(ctx, P, e.x, e.y, e.w, e.d, h, def.color || "#8b5cf6", {
        selected: e.id === o.selectedId,
        selColor: colors.sel,
      });
      // Optional short label on the top face for bigger footprints.
      if (labelFn && e.w >= 3 && e.d >= 1) {
        const mid = P(e.x + e.w / 2, e.y + e.d / 2, h);
        const fs = Math.max(8, Math.min(13, cellPx * 0.5));
        ctx.font = "600 " + fs + "px system-ui, sans-serif";
        ctx.fillStyle = colors.text || "#0f172a";
        const label = labelFn(e.type);
        // Only when it comfortably fits the projected top face.
        if (ctx.measureText(label).width < e.w * cellPx * ISO.KX * 1.6) {
          ctx.fillText(label, mid.x, mid.y);
        }
      }
    }
    ctx.restore();

    return { originX: ox, originY: oy };
  }

  WT.iso = {
    ISO,
    HEIGHTS,
    DEFAULT_HEIGHT,
    project,
    elementHeight,
    depthKey,
    sortByDepth,
    shade,
    drawBox,
    drawScene,
  };
})();
