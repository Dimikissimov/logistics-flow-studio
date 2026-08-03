/* =====================================================================
 * Logistics Flow Studio - WarehouseTwin
 * shapes.js - the SINGLE per-type shape registry (2D glyph + 3D form).
 * ---------------------------------------------------------------------
 * One source of truth for how every warehouse object type LOOKS, reused
 * by BOTH renderers:
 *   - the TOP-DOWN editor (app.js) calls draw2D() for each element's
 *     distinct schematic glyph inside its footprint;
 *   - the 2.5D ISOMETRIC view (iso.js) calls draw3D() for each element's
 *     distinct extruded form, using the SAME per-type height the IFC
 *     export and the iso projection already agree on (domain.heightM via
 *     iso.elementHeight - never invented a third time here).
 *
 * HONESTY (read this):
 *   - These are ILLUSTRATIVE, recognizable SCHEMATIC glyphs and forms -
 *     NOT CAD, NOT BIM, NOT a survey and NOT measured geometry. Heights
 *     are the domain model's ASSUMED, order-of-magnitude teaching values.
 *     The real BIM/geometry path is the separate IFC export (ifc.js).
 *   - No real brands, logos or trademarked shapes; every motif is a
 *     generic material-handling schematic.
 *
 * PURE + SELF-CONTAINED: every function here takes a canvas ctx plus
 * plain geometry/colour arguments and draws - it reads NO app state, keeps
 * NO module state between calls, MUTATES none of its inputs, and pulls in
 * no external asset (offline by construction). The math is finite for any
 * finite input, so the draw paths are exercised headlessly against a mock
 * 2D context (verify_shapes.js) even though the pixels themselves are only
 * verifiable live in the browser.
 *
 * No frameworks, no build step. Attaches to the global `WT` namespace so
 * it works from file:// as a classic script (not an ES module).
 * ===================================================================== */
(function () {
  "use strict";
  const WT = (window.WT = window.WT || {});

  const TAU = Math.PI * 2;

  /* ==================================================================
   * COLOUR HELPERS (self-contained; no dependency on app.js/iso.js).
   * ================================================================== */
  function hx(hex) {
    let h = String(hex == null ? "#888888" : hex).replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    let r = parseInt(h.slice(0, 2), 16);
    let g = parseInt(h.slice(2, 4), 16);
    let b = parseInt(h.slice(4, 6), 16);
    if (!isFinite(r)) r = 136;
    if (!isFinite(g)) g = 136;
    if (!isFinite(b)) b = 136;
    return [r, g, b];
  }
  const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));
  function rgba(hex, a) {
    const c = hx(hex);
    return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")";
  }
  // Multiply toward black (f<1 darkens, f>1 brightens then clamps).
  function shade(hex, f) {
    const c = hx(hex);
    return "rgb(" + clamp255(c[0] * f) + "," + clamp255(c[1] * f) + "," + clamp255(c[2] * f) + ")";
  }
  // Blend toward white by fraction f (0..1).
  function lighten(hex, f) {
    const c = hx(hex);
    const m = (v) => clamp255(v + (255 - v) * f);
    return "rgb(" + m(c[0]) + "," + m(c[1]) + "," + m(c[2]) + ")";
  }

  // Theme-aware pen/brush for the 2D glyph strokes so they read on both
  // the light and dark tinted footprint the editor already fills.
  function glyphColors(color, theme) {
    if (theme === "dark") {
      return { stroke: rgba(lighten(color, 0.32), 0.92), fill: rgba(lighten(color, 0.26), 0.5) };
    }
    return { stroke: rgba(color, 0.78), fill: rgba(color, 0.46) };
  }

  // Face-shade multipliers for the 3D forms (top brightest, then right,
  // then left) - a consistent single light direction, no lighting model.
  const FACE = { top: 1.14, right: 0.82, left: 0.6 };
  function beamColor(color, theme) {
    return theme === "dark" ? lighten(color, 0.28) : shade(color, 0.72);
  }

  /* ==================================================================
   * 2D PRIMITIVES (footprint px space). Module-level (no per-call
   * closure allocation in the hot path).
   * ================================================================== */
  function seg(ctx, x1, y1, x2, y2) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  function ring(ctx, x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0.5, r), 0, TAU);
    ctx.stroke();
  }
  function disc(ctx, x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0.5, r), 0, TAU);
    ctx.fill();
  }
  // A chevron (open "V") of half-size s pointing dir ("up"|"down"|"left"|"right").
  function chev(ctx, cx, cy, s, dir) {
    ctx.beginPath();
    if (dir === "down") { ctx.moveTo(cx - s, cy - s); ctx.lineTo(cx, cy); ctx.lineTo(cx + s, cy - s); }
    else if (dir === "up") { ctx.moveTo(cx - s, cy + s); ctx.lineTo(cx, cy); ctx.lineTo(cx + s, cy + s); }
    else if (dir === "right") { ctx.moveTo(cx - s, cy - s); ctx.lineTo(cx, cy); ctx.lineTo(cx - s, cy + s); }
    else { ctx.moveTo(cx + s, cy - s); ctx.lineTo(cx, cy); ctx.lineTo(cx + s, cy + s); }
    ctx.stroke();
  }
  // A line with an arrowhead at (x2,y2).
  function arr(ctx, x1, y1, x2, y2, hs) {
    seg(ctx, x1, y1, x2, y2);
    const a = Math.atan2(y2 - y1, x2 - x1);
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - hs * Math.cos(a - 0.42), y2 - hs * Math.sin(a - 0.42));
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - hs * Math.cos(a + 0.42), y2 - hs * Math.sin(a + 0.42));
    ctx.stroke();
  }
  const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /* ==================================================================
   * PER-TYPE 2D GLYPHS. Signature: (ctx, x, y, w, d, cell, gc, color).
   * `cell` = px per grid cell (feature density); `gc` = {stroke,fill}.
   * Each keeps the type's colour and draws only inside [x,y,w,d].
   * ================================================================== */
  function pen(ctx, gc, cell) {
    ctx.strokeStyle = gc.stroke;
    ctx.fillStyle = gc.fill;
    ctx.lineWidth = clampN(cell * 0.05, 1, 2.2);
  }

  // Open shelf-bay grid: uprights + horizontal beams (single-deep).
  function d2Selective(ctx, x, y, w, d, cell, gc) {
    pen(ctx, gc, cell);
    const m = clampN(Math.min(w, d) * 0.16, 2, 7);
    const ix = x + m, iy = y + m, iw = w - 2 * m, ih = d - 2 * m;
    const bays = clampN(Math.round(iw / cell), 2, 14);
    for (let i = 0; i <= bays; i++) { const gx = ix + (iw * i) / bays; seg(ctx, gx, iy, gx, iy + ih); }
    const lv = clampN(Math.round(ih / (cell * 0.55)), 1, 3);
    for (let j = 0; j <= lv; j++) { const gy = iy + (ih * j) / lv; seg(ctx, ix, gy, ix + iw, gy); }
  }

  // Stacked-square pattern (floor block stacking, honeycomb read).
  function d2Block(ctx, x, y, w, d, cell, gc) {
    pen(ctx, gc, cell);
    const cols = clampN(Math.round(w / cell), 2, 8);
    const rows = clampN(Math.round(d / cell), 2, 8);
    const gap = clampN(cell * 0.12, 1.5, 5);
    const cw = (w - gap) / cols, ch = (d - gap) / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const bx = x + gap + c * cw, by = y + gap + r * ch;
        ctx.fillRect(bx, by, cw - gap, ch - gap);
        ctx.strokeRect(bx, by, cw - gap, ch - gap);
        // stacked-offset ghost square (upper-right) for the "stacked" read.
        const o = Math.min(cw, ch) * 0.16;
        ctx.strokeRect(bx + o, by - o * 0.5, cw - gap, ch - gap);
      }
    }
  }

  // Deep lanes with an entry arrow into the depth (truck drives in).
  function d2DriveIn(ctx, x, y, w, d, cell, gc) {
    pen(ctx, gc, cell);
    const m = clampN(Math.min(w, d) * 0.14, 2, 6);
    const ix = x + m, iy = y + m, iw = w - 2 * m, ih = d - 2 * m;
    const lanes = clampN(Math.round(iw / cell), 2, 8);
    for (let i = 0; i <= lanes; i++) { const gx = ix + (iw * i) / lanes; seg(ctx, gx, iy, gx, iy + ih); }
    // nested depth arrows down each lane (entry direction).
    for (let i = 0; i < lanes; i++) {
      const gx = ix + iw * (i + 0.5) / lanes;
      arr(ctx, gx, iy + ih * 0.15, gx, iy + ih * 0.85, clampN(cell * 0.3, 3, 7));
    }
  }

  // Two pallets deep: a front and back bay pair with a depth divider.
  function d2DoubleDeep(ctx, x, y, w, d, cell, gc) {
    pen(ctx, gc, cell);
    const m = clampN(Math.min(w, d) * 0.14, 2, 6);
    const ix = x + m, iy = y + m, iw = w - 2 * m, ih = d - 2 * m;
    const midY = iy + ih / 2;
    const bays = clampN(Math.round(iw / cell), 2, 12);
    for (let i = 0; i <= bays; i++) { const gx = ix + (iw * i) / bays; seg(ctx, gx, iy, gx, iy + ih); }
    seg(ctx, ix, iy, ix + iw, iy);
    seg(ctx, ix, iy + ih, ix + iw, iy + ih);
    // bold central depth divider (the two-deep split).
    ctx.lineWidth = clampN(cell * 0.09, 1.5, 3);
    seg(ctx, ix, midY, ix + iw, midY);
  }

  // Nested chevrons toward the aisle face (nested carts on inclined rails).
  function d2PushBack(ctx, x, y, w, d, cell, gc) {
    pen(ctx, gc, cell);
    const m = clampN(Math.min(w, d) * 0.16, 2, 6);
    const ix = x + m, iy = y + m, iw = w - 2 * m, ih = d - 2 * m;
    const n = 3, s = clampN(Math.min(iw, ih) * 0.16, 3, 9);
    for (let i = 0; i < n; i++) {
      const cy = iy + ih * (0.72 - 0.22 * i);
      chev(ctx, ix + iw / 2, cy, s, "down");
    }
  }

  // Gravity flow lanes: roller dots + flow-direction chevrons (FIFO).
  function d2PalletFlow(ctx, x, y, w, d, cell, gc) {
    pen(ctx, gc, cell);
    const m = clampN(Math.min(w, d) * 0.14, 2, 6);
    const ix = x + m, iy = y + m, iw = w - 2 * m, ih = d - 2 * m;
    const lanes = clampN(Math.round(iw / cell), 2, 8);
    for (let i = 0; i < lanes; i++) {
      const gx = ix + iw * (i + 0.5) / lanes;
      // roller dots down the lane
      const dots = clampN(Math.round(ih / (cell * 0.5)), 2, 6);
      for (let j = 0; j < dots; j++) disc(ctx, gx, iy + ih * (j + 0.5) / dots, clampN(cell * 0.06, 1.2, 2.4));
      // flow chevrons (load back -> pick front = downward)
      chev(ctx, gx, iy + ih * 0.85, clampN(cell * 0.16, 2.5, 6), "down");
    }
  }

  // Fine inclined carton pick-face shelves with small chevrons.
  function d2CartonFlow(ctx, x, y, w, d, cell, gc) {
    pen(ctx, gc, cell);
    const m = clampN(Math.min(w, d) * 0.16, 2, 5);
    const ix = x + m, iy = y + m, iw = w - 2 * m, ih = d - 2 * m;
    const shelves = clampN(Math.round(ih / (cell * 0.34)), 2, 5);
    const s = clampN(iw * 0.04, 2, 5);
    for (let j = 0; j < shelves; j++) {
      const gy = iy + ih * (j + 0.5) / shelves;
      seg(ctx, ix, gy + s * 0.5, ix + iw, gy - s * 0.5); // slight incline
      chev(ctx, ix + iw * 0.85, gy - s * 0.5, s, "right");
    }
  }

  // Mobile bases on one shared aisle: base rail + wheels + bay uprights.
  function d2Mobile(ctx, x, y, w, d, cell, gc) {
    pen(ctx, gc, cell);
    const m = clampN(Math.min(w, d) * 0.14, 2, 6);
    const ix = x + m, iy = y + m, iw = w - 2 * m, ih = d - 2 * m;
    const bays = clampN(Math.round(iw / cell), 2, 12);
    for (let i = 0; i <= bays; i++) { const gx = ix + (iw * i) / bays; seg(ctx, gx, iy, gx, iy + ih * 0.82); }
    const railY = iy + ih * 0.9;
    seg(ctx, ix, railY, ix + iw, railY);
    const wheels = clampN(Math.round(iw / cell), 2, 8);
    for (let i = 0; i < wheels; i++) ring(ctx, ix + iw * (i + 0.5) / wheels, railY, clampN(cell * 0.09, 1.5, 3));
  }

  // Arms on a column, no front uprights (long goods).
  function d2Cantilever(ctx, x, y, w, d, cell, gc) {
    pen(ctx, gc, cell);
    const m = clampN(Math.min(w, d) * 0.16, 2, 6);
    const ix = x + m, iy = y + m, iw = w - 2 * m, ih = d - 2 * m;
    const colX = ix + iw * 0.12;
    ctx.lineWidth = clampN(cell * 0.08, 1.5, 3);
    seg(ctx, colX, iy, colX, iy + ih); // the column
    ctx.lineWidth = clampN(cell * 0.05, 1, 2);
    const arms = clampN(Math.round(ih / (cell * 0.5)), 2, 4);
    for (let j = 0; j <= arms; j++) {
      const gy = iy + (ih * j) / arms;
      seg(ctx, colX, gy, ix + iw, gy); // arm reaching out
    }
  }

  // Tall double-sided high bay: rack hatch each side + a crane aisle.
  function d2Asrs(ctx, x, y, w, d, cell, gc) {
    pen(ctx, gc, cell);
    const m = clampN(Math.min(w, d) * 0.12, 2, 6);
    const ix = x + m, iy = y + m, iw = w - 2 * m, ih = d - 2 * m;
    const aisle = clampN(ih * 0.3, 4, 14);
    const topH = (ih - aisle) / 2, botY = iy + topH + aisle;
    // hatched rack band top and bottom
    const hs = clampN(cell * 0.5, 5, 12);
    for (let hx2 = ix; hx2 < ix + iw; hx2 += hs) {
      seg(ctx, hx2, iy, Math.min(ix + iw, hx2 + hs * 0.6), iy + topH);
      seg(ctx, hx2, botY, Math.min(ix + iw, hx2 + hs * 0.6), botY + topH);
    }
    ctx.strokeRect(ix, iy, iw, topH);
    ctx.strokeRect(ix, botY, iw, topH);
    // crane aisle centre line + trolley
    const midY = iy + topH + aisle / 2;
    seg(ctx, ix, midY, ix + iw, midY);
    ctx.fillRect(ix + iw * 0.44, midY - clampN(aisle * 0.18, 2, 5), clampN(iw * 0.12, 6, 20), clampN(aisle * 0.36, 4, 10));
  }

  // Deep channels served by shuttle carts + a lift at the head.
  function d2Shuttle(ctx, x, y, w, d, cell, gc) {
    pen(ctx, gc, cell);
    const m = clampN(Math.min(w, d) * 0.14, 2, 6);
    const ix = x + m, iy = y + m, iw = w - 2 * m, ih = d - 2 * m;
    const chans = clampN(Math.round(ih / (cell * 0.5)), 2, 6);
    for (let j = 0; j <= chans; j++) { const gy = iy + (ih * j) / chans; seg(ctx, ix, gy, ix + iw, gy); }
    // a couple of shuttle carts on the channels
    const cw = clampN(cell * 0.5, 6, 14), chh = clampN(ih / chans * 0.5, 3, 8);
    ctx.fillRect(ix + iw * 0.55, iy + ih * 0.18, cw, chh);
    ctx.fillRect(ix + iw * 0.28, iy + ih * 0.6, cw, chh);
    // lift shaft at the head
    ctx.strokeRect(ix, iy, clampN(cell * 0.4, 4, 10), ih);
  }

  // Raised platform outline + corner posts (a second pick level).
  function d2Mezzanine(ctx, x, y, w, d, cell, gc) {
    pen(ctx, gc, cell);
    const m = clampN(Math.min(w, d) * 0.16, 3, 8);
    const ix = x + m, iy = y + m, iw = w - 2 * m, ih = d - 2 * m;
    ctx.save();
    ctx.setLineDash([clampN(cell * 0.22, 3, 6), clampN(cell * 0.16, 2, 4)]);
    ctx.strokeRect(ix, iy, iw, ih);
    ctx.restore();
    const pr = clampN(cell * 0.1, 1.6, 3.4);
    disc(ctx, ix, iy, pr); disc(ctx, ix + iw, iy, pr);
    disc(ctx, ix, iy + ih, pr); disc(ctx, ix + iw, iy + ih, pr);
    // stair ticks along one edge
    const steps = clampN(Math.round(iw / cell), 2, 6);
    for (let i = 1; i < steps; i++) seg(ctx, ix + iw * i / steps, iy + ih, ix + iw * i / steps, iy + ih - clampN(cell * 0.2, 2, 5));
  }

  // Dock door: a door notch in the wall edge + an in/out arrow.
  function d2Dock(ctx, x, y, w, d, cell, gc, dir) {
    pen(ctx, gc, cell);
    const m = clampN(Math.min(w, d) * 0.16, 2, 5);
    const ix = x + m, iy = y + m, iw = w - 2 * m, ih = d - 2 * m;
    // wall with a centred door opening (a notch)
    const dw = clampN(iw * 0.5, 6, 40);
    const dx = ix + (iw - dw) / 2;
    seg(ctx, ix, iy, dx, iy);
    seg(ctx, dx + dw, iy, ix + iw, iy);
    ctx.strokeRect(dx, iy, dw, clampN(ih * 0.28, 3, 10)); // door leaf
    // in/out arrow (in = into the floor/down; out = away/up)
    const cx = ix + iw / 2;
    if (dir === "in") arr(ctx, cx, iy + ih * 0.35, cx, iy + ih * 0.9, clampN(cell * 0.32, 3, 8));
    else arr(ctx, cx, iy + ih * 0.9, cx, iy + ih * 0.35, clampN(cell * 0.32, 3, 8));
  }
  function d2DockIn(ctx, x, y, w, d, cell, gc) { d2Dock(ctx, x, y, w, d, cell, gc, "in"); }
  function d2DockOut(ctx, x, y, w, d, cell, gc) { d2Dock(ctx, x, y, w, d, cell, gc, "out"); }

  // Marshalling / staging buffer: a dashed holding area with corner ticks.
  function d2Staging(ctx, x, y, w, d, cell, gc) {
    pen(ctx, gc, cell);
    const m = clampN(Math.min(w, d) * 0.16, 3, 8);
    const ix = x + m, iy = y + m, iw = w - 2 * m, ih = d - 2 * m;
    ctx.save();
    ctx.setLineDash([clampN(cell * 0.28, 4, 8), clampN(cell * 0.2, 3, 6)]);
    ctx.strokeRect(ix, iy, iw, ih);
    // an inner divided holding lane
    seg(ctx, ix, iy + ih / 2, ix + iw, iy + ih / 2);
    ctx.restore();
  }

  // Powered conveyor: belt side lines + rollers + a direction arrow.
  function d2Conveyor(ctx, x, y, w, d, cell, gc) {
    pen(ctx, gc, cell);
    const m = clampN(Math.min(w, d) * 0.18, 2, 5);
    const ix = x + m, iy = y + m, iw = w - 2 * m, ih = d - 2 * m;
    const horiz = w >= d;
    if (horiz) {
      seg(ctx, ix, iy, ix + iw, iy);
      seg(ctx, ix, iy + ih, ix + iw, iy + ih);
      const n = clampN(Math.round(iw / (cell * 0.5)), 2, 24);
      for (let i = 1; i < n; i++) { const gx = ix + iw * i / n; seg(ctx, gx, iy, gx, iy + ih); }
      arr(ctx, ix + iw * 0.28, iy + ih / 2, ix + iw * 0.72, iy + ih / 2, clampN(cell * 0.3, 3, 7));
    } else {
      seg(ctx, ix, iy, ix, iy + ih);
      seg(ctx, ix + iw, iy, ix + iw, iy + ih);
      const n = clampN(Math.round(ih / (cell * 0.5)), 2, 24);
      for (let i = 1; i < n; i++) { const gy = iy + ih * i / n; seg(ctx, ix, gy, ix + iw, gy); }
      arr(ctx, ix + iw / 2, iy + ih * 0.28, ix + iw / 2, iy + ih * 0.72, clampN(cell * 0.3, 3, 7));
    }
  }

  // A control-station workbench with a flow arrow (dir "push"/"pull").
  function d2Station(ctx, x, y, w, d, cell, gc, kind) {
    pen(ctx, gc, cell);
    const m = clampN(Math.min(w, d) * 0.2, 2, 6);
    const ix = x + m, iy = y + m, iw = w - 2 * m, ih = d - 2 * m;
    // bench top
    const bh = clampN(ih * 0.42, 4, 16);
    ctx.fillRect(ix, iy + (ih - bh) / 2, iw, bh);
    ctx.strokeRect(ix, iy + (ih - bh) / 2, iw, bh);
    const cy = iy + ih / 2;
    const hs = clampN(cell * 0.3, 3, 8);
    if (kind === "push") arr(ctx, ix + iw * 0.2, cy, ix + iw * 0.9, cy, hs);       // release outward
    else if (kind === "pull") arr(ctx, ix + iw * 0.8, cy, ix + iw * 0.1, cy, hs);  // demand inward
    else { // pack: a box on the bench with a tape line
      const s = clampN(Math.min(iw, ih) * 0.3, 5, 16);
      ctx.strokeRect(ix + iw / 2 - s / 2, cy - s / 2, s, s);
      seg(ctx, ix + iw / 2, cy - s / 2, ix + iw / 2, cy + s / 2);
    }
  }
  function d2Push(ctx, x, y, w, d, cell, gc) { d2Station(ctx, x, y, w, d, cell, gc, "push"); }
  function d2Pull(ctx, x, y, w, d, cell, gc) { d2Station(ctx, x, y, w, d, cell, gc, "pull"); }
  function d2Pack(ctx, x, y, w, d, cell, gc) { d2Station(ctx, x, y, w, d, cell, gc, "pack"); }

  // Rail-guided vehicle: twin rails + a cart body + direction.
  function d2Rgv(ctx, x, y, w, d, cell, gc) {
    pen(ctx, gc, cell);
    const m = clampN(Math.min(w, d) * 0.2, 2, 5);
    const ix = x + m, iy = y + m, iw = w - 2 * m, ih = d - 2 * m;
    const horiz = w >= d;
    if (horiz) {
      seg(ctx, ix, iy + ih * 0.3, ix + iw, iy + ih * 0.3);
      seg(ctx, ix, iy + ih * 0.7, ix + iw, iy + ih * 0.7);
      const cw = clampN(iw * 0.24, 8, 30);
      ctx.fillRect(ix + iw * 0.12, iy + ih * 0.24, cw, ih * 0.52);
      ctx.strokeRect(ix + iw * 0.12, iy + ih * 0.24, cw, ih * 0.52);
      arr(ctx, ix + iw * 0.55, iy + ih / 2, ix + iw * 0.9, iy + ih / 2, clampN(cell * 0.28, 3, 7));
    } else {
      seg(ctx, ix + iw * 0.3, iy, ix + iw * 0.3, iy + ih);
      seg(ctx, ix + iw * 0.7, iy, ix + iw * 0.7, iy + ih);
      const chh = clampN(ih * 0.24, 8, 30);
      ctx.fillRect(ix + iw * 0.24, iy + ih * 0.12, iw * 0.52, chh);
      ctx.strokeRect(ix + iw * 0.24, iy + ih * 0.12, iw * 0.52, chh);
      arr(ctx, ix + iw / 2, iy + ih * 0.55, ix + iw / 2, iy + ih * 0.9, clampN(cell * 0.28, 3, 7));
    }
  }

  // Free-roaming AGV/AMR: a dashed guide path + a rounded robot body.
  function d2Agv(ctx, x, y, w, d, cell, gc) {
    pen(ctx, gc, cell);
    const m = clampN(Math.min(w, d) * 0.2, 2, 5);
    const ix = x + m, iy = y + m, iw = w - 2 * m, ih = d - 2 * m;
    const horiz = w >= d;
    ctx.save();
    ctx.setLineDash([clampN(cell * 0.22, 3, 6), clampN(cell * 0.18, 2, 5)]);
    if (horiz) seg(ctx, ix, iy + ih / 2, ix + iw, iy + ih / 2);
    else seg(ctx, ix + iw / 2, iy, ix + iw / 2, iy + ih);
    ctx.restore();
    // robot body (rounded footprint) with a heading dot
    const bx = horiz ? ix + iw * 0.34 : ix + iw / 2;
    const by = horiz ? iy + ih / 2 : iy + ih * 0.34;
    const br = clampN(Math.min(iw, ih) * 0.26, 4, 12);
    ctx.beginPath(); ctx.arc(bx, by, br, 0, TAU); ctx.fill(); ctx.stroke();
    disc(ctx, horiz ? bx + br * 0.55 : bx, horiz ? by : by + br * 0.55, clampN(br * 0.25, 1.2, 3));
  }

  /* ==================================================================
   * TINY LOD ICONS. Drawn centred at (cx,cy) with radius r when a
   * footprint is too small on-screen for the full glyph. Cheap (a few
   * strokes) and legible at any zoom.
   * ================================================================== */
  function icGrid(ctx, cx, cy, r) {
    ctx.strokeRect(cx - r, cy - r, r * 2, r * 2);
    seg(ctx, cx, cy - r, cx, cy + r);
    seg(ctx, cx - r, cy, cx + r, cy);
  }
  function icChevron(ctx, cx, cy, r) { chev(ctx, cx, cy + r * 0.4, r * 0.8, "down"); chev(ctx, cx, cy - r * 0.2, r * 0.8, "down"); }
  function icTower(ctx, cx, cy, r) { ctx.strokeRect(cx - r * 0.6, cy - r, r * 1.2, r * 2); seg(ctx, cx, cy - r, cx, cy + r); }
  function icPlatform(ctx, cx, cy, r) { seg(ctx, cx - r, cy - r * 0.3, cx + r, cy - r * 0.3); seg(ctx, cx - r * 0.7, cy - r * 0.3, cx - r * 0.7, cy + r); seg(ctx, cx + r * 0.7, cy - r * 0.3, cx + r * 0.7, cy + r); }
  function icBelt(ctx, cx, cy, r) { arr(ctx, cx - r, cy, cx + r, cy, r * 0.6); }
  function icBench(ctx, cx, cy, r) { ctx.strokeRect(cx - r, cy - r * 0.4, r * 2, r * 0.8); }
  function icCart(ctx, cx, cy, r) { ctx.fillRect(cx - r * 0.7, cy - r * 0.5, r * 1.4, r); seg(ctx, cx - r, cy + r * 0.7, cx + r, cy + r * 0.7); }
  function icRobot(ctx, cx, cy, r) { ctx.beginPath(); ctx.arc(cx, cy, r * 0.8, 0, TAU); ctx.stroke(); }
  function icStack(ctx, cx, cy, r) { ctx.strokeRect(cx - r, cy - r, r, r); ctx.strokeRect(cx, cy, r, r); ctx.strokeRect(cx - r * 0.5, cy - r * 0.5, r, r); }
  function icDoor(ctx, cx, cy, r) { ctx.strokeRect(cx - r * 0.6, cy - r, r * 1.2, r * 2); arr(ctx, cx, cy + r * 0.6, cx, cy - r * 0.6, r * 0.5); }
  function icDash(ctx, cx, cy, r) { ctx.save(); ctx.setLineDash([r * 0.5, r * 0.4]); ctx.strokeRect(cx - r, cy - r * 0.7, r * 2, r * 1.4); ctx.restore(); }
  function icArm(ctx, cx, cy, r) { seg(ctx, cx - r * 0.7, cy - r, cx - r * 0.7, cy + r); seg(ctx, cx - r * 0.7, cy - r * 0.5, cx + r, cy - r * 0.5); seg(ctx, cx - r * 0.7, cy + r * 0.3, cx + r, cy + r * 0.3); }

  /* ==================================================================
   * 3D PRIMITIVES (world cells -> px via the caller-supplied P). All
   * heights are the domain heightM in metres; z rises the point.
   * ================================================================== */
  function quad(ctx, A, B, C, D, fill, stroke, lw) {
    ctx.beginPath();
    ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.lineTo(C.x, C.y); ctx.lineTo(D.x, D.y); ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1; ctx.stroke(); }
  }
  function edge(ctx, P, x1, y1, z1, x2, y2, z2, stroke, lw) {
    const A = P(x1, y1, z1), B = P(x2, y2, z2);
    ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y);
    ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1; ctx.stroke();
  }
  // A solid extruded box (left, right, top faces). Consistent light dir.
  function box3d(ctx, P, x, y, w, d, h, color) {
    const B = P(x + w, y, 0), C = P(x + w, y + d, 0), Dp = P(x, y + d, 0);
    const At = P(x, y, h), Bt = P(x + w, y, h), Ct = P(x + w, y + d, h), Dt = P(x, y + d, h);
    ctx.lineJoin = "round";
    quad(ctx, Dp, C, Ct, Dt, shade(color, FACE.left), shade(color, FACE.left * 0.7));
    quad(ctx, B, C, Ct, Bt, shade(color, FACE.right), shade(color, FACE.right * 0.7));
    quad(ctx, At, Bt, Ct, Dt, shade(color, FACE.top), shade(color, 0.85));
  }
  // A thin solid column (post/leg) centred on (cx,cy), footprint t x t.
  function colBox(ctx, P, cx, cy, t, h, color) { box3d(ctx, P, cx - t / 2, cy - t / 2, t, t, h, color); }
  // A FLOATING slab between heights z0..z1 (raised deck): two side faces +
  // the top face, leaving the space beneath it open.
  function slab3d(ctx, P, x, y, w, d, z0, z1, color) {
    quad(ctx, P(x, y + d, z0), P(x + w, y + d, z0), P(x + w, y + d, z1), P(x, y + d, z1), shade(color, FACE.left), shade(color, FACE.left * 0.7));
    quad(ctx, P(x + w, y, z0), P(x + w, y + d, z0), P(x + w, y + d, z1), P(x + w, y, z1), shade(color, FACE.right), shade(color, FACE.right * 0.7));
    quad(ctx, P(x, y, z1), P(x + w, y, z1), P(x + w, y + d, z1), P(x, y + d, z1), shade(color, FACE.top), shade(color, 0.85));
  }

  // An open rack FRAME (see-through shelving): solid corner posts + beam
  // outlines per level + intermediate bay uprights. `opt`: {levels, bays,
  // front (draw the front face), sides}.
  function frame3d(ctx, P, x, y, w, d, h, color, theme, opt) {
    opt = opt || {};
    const t = clampN(Math.min(w, d) * 0.22, 0.08, 0.22);
    const bm = beamColor(color, theme);
    const front = opt.front !== false;
    // solid corner posts for weight
    colBox(ctx, P, x + t / 2, y + t / 2, t, h, color);
    colBox(ctx, P, x + w - t / 2, y + t / 2, t, h, color);
    if (front) { colBox(ctx, P, x + t / 2, y + d - t / 2, t, h, color); colBox(ctx, P, x + w - t / 2, y + d - t / 2, t, h, color); }
    const levels = clampN(opt.levels || 3, 2, 8);
    for (let i = 0; i <= levels; i++) {
      const z = (h * i) / levels;
      edge(ctx, P, x, y, z, x + w, y, z, bm);                 // back beam
      edge(ctx, P, x, y, z, x, y + d, z, bm);                 // left rail
      edge(ctx, P, x + w, y, z, x + w, y + d, z, bm);         // right rail
      if (front) edge(ctx, P, x, y + d, z, x + w, y + d, z, bm); // front beam
    }
    const bays = clampN(opt.bays || Math.round(w / 1.5), 1, 8);
    for (let b = 1; b < bays; b++) {
      const gx = x + (w * b) / bays;
      edge(ctx, P, gx, y, 0, gx, y, h, bm);
      if (front) edge(ctx, P, gx, y + d, 0, gx, y + d, h, bm);
    }
  }
  function selOutline(ctx, P, x, y, w, d, h, col) {
    edge(ctx, P, x, y, h, x + w, y, h, col, 2.4);
    edge(ctx, P, x + w, y, h, x + w, y + d, h, col, 2.4);
    edge(ctx, P, x + w, y + d, h, x, y + d, h, col, 2.4);
    edge(ctx, P, x, y + d, h, x, y, h, col, 2.4);
  }

  /* ==================================================================
   * PER-TYPE 3D FORMS. Signature: (ctx, P, x, y, w, d, h, color, theme).
   * ================================================================== */
  function d3Selective(ctx, P, x, y, w, d, h, color, theme) { frame3d(ctx, P, x, y, w, d, h, color, theme, { levels: 3, bays: Math.round(w / 1.5) }); }

  function d3Block(ctx, P, x, y, w, d, h, color) {
    const cols = clampN(Math.round(w / 1.4), 2, 4), rows = clampN(Math.round(d / 1.4), 2, 4);
    const g = 0.12;
    const cw = (w - g) / cols, ch = (d - g) / rows;
    // back-to-front so nearer stacks overdraw farther ones
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const bx = x + g + c * cw, by = y + g + r * ch;
        box3d(ctx, P, bx, by, cw - g, ch - g, h, color);
        // layer ticks on the visible right face for the "stacked" read
        const bm = shade(color, 0.55);
        for (let k = 1; k < 3; k++) edge(ctx, P, bx + cw - g, by, (h * k) / 3, bx + cw - g, by + ch - g, (h * k) / 3, bm);
      }
    }
  }

  function d3DriveIn(ctx, P, x, y, w, d, h, color, theme) {
    frame3d(ctx, P, x, y, w, d, h, color, theme, { levels: 3, bays: Math.round(w / 1.5), front: false });
    // floor lane rails into the depth (the truck drives in)
    const bm = beamColor(color, theme);
    const lanes = clampN(Math.round(w / 1.2), 2, 6);
    for (let i = 0; i <= lanes; i++) { const gx = x + (w * i) / lanes; edge(ctx, P, gx, y, 0, gx, y + d, 0, bm); }
  }

  function d3DoubleDeep(ctx, P, x, y, w, d, h, color, theme) {
    frame3d(ctx, P, x, y, w, d, h, color, theme, { levels: 3, bays: Math.round(w / 1.5) });
    // the two-deep divider row at mid depth
    const bm = beamColor(color, theme);
    for (let i = 0; i <= 3; i++) { const z = (h * i) / 3; edge(ctx, P, x, y + d / 2, z, x + w, y + d / 2, z, bm); }
  }

  function d3PushBack(ctx, P, x, y, w, d, h, color, theme) {
    frame3d(ctx, P, x, y, w, d, h, color, theme, { levels: 3, bays: Math.round(w / 1.5) });
    // inclined rails on the left face (nested carts run back-and-up)
    const bm = beamColor(color, theme);
    for (let i = 0; i < 3; i++) { const z = (h * (i + 0.4)) / 3; edge(ctx, P, x, y + d, z - h * 0.12, x, y, z, bm); }
  }

  function d3PalletFlow(ctx, P, x, y, w, d, h, color, theme) {
    frame3d(ctx, P, x, y, w, d, h, color, theme, { levels: 3, bays: Math.round(w / 1.5) });
    // a clearly inclined gravity lane on top: front-low -> back-high
    const bm = beamColor(color, theme);
    const lanes = clampN(Math.round(w / 1.5), 2, 5);
    for (let i = 0; i < lanes; i++) {
      const gx = x + w * (i + 0.5) / lanes;
      edge(ctx, P, gx, y + d, h * 0.7, gx, y, h, bm);
    }
  }

  function d3CartonFlow(ctx, P, x, y, w, d, h, color, theme) {
    frame3d(ctx, P, x, y, w, d, h, color, theme, { levels: 4, bays: Math.max(1, Math.round(w / 1.5)) });
  }

  function d3Mobile(ctx, P, x, y, w, d, h, color, theme) {
    const base = clampN(h * 0.08, 0.25, 0.6);
    box3d(ctx, P, x, y, w, d, base, shade(color, 0.7)); // the powered mobile base
    frame3d(ctx, P, x, y, w, d, h, color, theme, { levels: 4, bays: Math.round(w / 1.5) });
  }

  function d3Cantilever(ctx, P, x, y, w, d, h, color, theme) {
    const bm = beamColor(color, theme);
    const t = clampN(Math.min(w, d) * 0.14, 0.1, 0.25);
    const cols = clampN(Math.round(w / 2), 2, 5);
    for (let i = 0; i <= cols; i++) {
      const cx = x + t / 2 + (w - t) * i / cols;
      colBox(ctx, P, cx, y + t / 2, t, h, color); // back column
      // horizontal arms reaching to the front at each level
      for (let k = 1; k <= 3; k++) {
        const z = (h * k) / 3.2;
        edge(ctx, P, cx, y, z, cx, y + d, z, bm, 1.4);
      }
    }
  }

  function d3Asrs(ctx, P, x, y, w, d, h, color, theme) {
    // double-sided high bay: a rack block each side of a central crane aisle
    const side = w * 0.4, aisle = w - 2 * side;
    frame3d(ctx, P, x, y, side, d, h, color, theme, { levels: 6, bays: Math.max(2, Math.round(side / 1.2)) });
    frame3d(ctx, P, x + side + aisle, y, side, d, h, color, theme, { levels: 6, bays: Math.max(2, Math.round(side / 1.2)) });
    // the stacker-crane mast in the aisle + a trolley box
    const mcx = x + w / 2;
    colBox(ctx, P, mcx, y + d / 2, clampN(aisle * 0.4, 0.2, 0.6), h * 1.02, shade(color, 0.85));
    box3d(ctx, P, mcx - aisle * 0.25, y + d * 0.3, aisle * 0.5, d * 0.4, h * 0.5 + 0.6, color);
  }

  function d3Shuttle(ctx, P, x, y, w, d, h, color, theme) {
    frame3d(ctx, P, x, y, w, d, h, color, theme, { levels: 6, bays: Math.round(w / 1.4) });
    // the lift shaft at the head (a tall thin solid tower)
    const lw = clampN(w * 0.14, 0.4, 1.2);
    box3d(ctx, P, x, y, lw, d, h, shade(color, 0.82));
  }

  function d3Mezzanine(ctx, P, x, y, w, d, h, color, theme) {
    const deckZ = h * 0.5, deckT = clampN(h * 0.06, 0.15, 0.4);
    const t = clampN(Math.min(w, d) * 0.1, 0.1, 0.3);
    // corner legs up to the deck - the space beneath stays OPEN
    colBox(ctx, P, x + t, y + t, t, deckZ, color);
    colBox(ctx, P, x + w - t, y + t, t, deckZ, color);
    colBox(ctx, P, x + t, y + d - t, t, deckZ, color);
    colBox(ctx, P, x + w - t, y + d - t, t, deckZ, color);
    // the raised platform slab, floating at the deck height
    slab3d(ctx, P, x, y, w, d, deckZ, deckZ + deckT, color);
    // guard-rail top edges above the deck
    const bm = beamColor(color, theme);
    const railZ = deckZ + deckT + h * 0.14;
    edge(ctx, P, x, y, railZ, x + w, y, railZ, bm);
    edge(ctx, P, x, y + d, railZ, x + w, y + d, railZ, bm);
    edge(ctx, P, x, y, deckZ + deckT, x, y, railZ, bm);
    edge(ctx, P, x + w, y, deckZ + deckT, x + w, y, railZ, bm);
  }

  function d3Conveyor(ctx, P, x, y, w, d, h, color, theme) {
    box3d(ctx, P, x, y, w, d, h, color); // the low belt bed
    const bm = beamColor(color, theme);
    const horiz = w >= d;
    const n = clampN(Math.round((horiz ? w : d) / 0.6), 2, 30);
    for (let i = 1; i < n; i++) {
      const t = i / n;
      if (horiz) edge(ctx, P, x + w * t, y, h, x + w * t, y + d, h, bm); // rollers across the belt
      else edge(ctx, P, x, y + d * t, h, x + w, y + d * t, h, bm);
    }
  }

  function d3Station(ctx, P, x, y, w, d, h, color, theme, kind) {
    const topZ = h * 0.72, topT = clampN(h * 0.16, 0.08, 0.3);
    const t = clampN(Math.min(w, d) * 0.12, 0.08, 0.25);
    // legs
    colBox(ctx, P, x + t, y + t, t, topZ, color);
    colBox(ctx, P, x + w - t, y + t, t, topZ, color);
    colBox(ctx, P, x + t, y + d - t, t, topZ, color);
    colBox(ctx, P, x + w - t, y + d - t, t, topZ, color);
    // bench top slab
    box3d(ctx, P, x, y, w, d, topZ + topT, color);
    const bm = beamColor(color, theme);
    const z = topZ + topT;
    if (kind === "pack") { // a parcel on the bench
      box3d(ctx, P, x + w * 0.32, y + d * 0.28, w * 0.36, d * 0.44, z + h * 0.4, lighten(color, 0.12));
    } else { // a flow arrow etched on the bench top
      const cy = y + d / 2;
      if (kind === "push") edge(ctx, P, x + w * 0.2, cy, z, x + w * 0.85, cy, z, bm, 1.6);
      else edge(ctx, P, x + w * 0.8, cy, z, x + w * 0.15, cy, z, bm, 1.6);
    }
  }
  function d3Push(ctx, P, x, y, w, d, h, color, theme) { d3Station(ctx, P, x, y, w, d, h, color, theme, "push"); }
  function d3Pull(ctx, P, x, y, w, d, h, color, theme) { d3Station(ctx, P, x, y, w, d, h, color, theme, "pull"); }
  function d3Pack(ctx, P, x, y, w, d, h, color, theme) { d3Station(ctx, P, x, y, w, d, h, color, theme, "pack"); }

  function d3Dock(ctx, P, x, y, w, d, h, color, theme) {
    box3d(ctx, P, x, y, w, d, h, color); // the dock wall
    // a recessed door opening on the front (y+d) face
    const dw = w * 0.5, dx = x + (w - dw) / 2, dh = h * 0.72;
    quad(ctx, P(dx, y + d, 0), P(dx + dw, y + d, 0), P(dx + dw, y + d, dh), P(dx, y + d, dh), shade(color, 0.45), shade(color, 0.35), 1);
  }

  function d3Staging(ctx, P, x, y, w, d, h, color, theme) {
    box3d(ctx, P, x, y, w, d, h, color); // a low outlined holding pad
    const bm = beamColor(color, theme);
    // a dashed-look divider across the pad top
    edge(ctx, P, x, y + d / 2, h, x + w, y + d / 2, h, bm);
  }

  function d3Rgv(ctx, P, x, y, w, d, h, color, theme) {
    const bm = beamColor(color, theme);
    const horiz = w >= d;
    if (horiz) {
      edge(ctx, P, x, y + d * 0.3, 0, x + w, y + d * 0.3, 0, bm, 1.4); // twin floor rails
      edge(ctx, P, x, y + d * 0.7, 0, x + w, y + d * 0.7, 0, bm, 1.4);
    } else {
      edge(ctx, P, x + w * 0.3, y, 0, x + w * 0.3, y + d, 0, bm, 1.4);
      edge(ctx, P, x + w * 0.7, y, 0, x + w * 0.7, y + d, 0, bm, 1.4);
    }
    // the cart body riding the rail
    const cw = horiz ? w * 0.3 : w * 0.6, cd = horiz ? d * 0.6 : d * 0.3;
    box3d(ctx, P, x + (w - cw) / 2, y + (d - cd) / 2, cw, cd, h, color);
  }

  function d3Agv(ctx, P, x, y, w, d, h, color, theme) {
    const bm = beamColor(color, theme);
    const horiz = w >= d;
    // a dashed guide path on the floor
    const segs = 5;
    for (let i = 0; i < segs; i += 1) {
      if (i % 2) continue;
      if (horiz) edge(ctx, P, x + w * i / segs, y + d / 2, 0, x + w * (i + 1) / segs, y + d / 2, 0, bm, 1.2);
      else edge(ctx, P, x + w / 2, y + d * i / segs, 0, x + w / 2, y + d * (i + 1) / segs, 0, bm, 1.2);
    }
    // a small robot body
    const cw = clampN(w * 0.4, 0.6, 3), cd = clampN(d * 0.4, 0.6, 3);
    box3d(ctx, P, x + (w - cw) / 2, y + (d - cd) / 2, cw, cd, h, color);
  }

  /* ==================================================================
   * THE REGISTRY. Exactly the domain.ELEMENTS types (no orphans). Each
   * entry has a 2D glyph (d2), a 3D form (d3) and an LOD icon (icon).
   * ================================================================== */
  const REG = {
    "selective-racking": { d2: d2Selective, d3: d3Selective, icon: icGrid, g2: "shelf-bay grid (uprights + beams)", f3: "open see-through rack frame (3 levels)" },
    "block-stack": { d2: d2Block, d3: d3Block, icon: icStack, g2: "stacked-square honeycomb pattern", f3: "grid of stacked unit stacks" },
    "drive-in": { d2: d2DriveIn, d3: d3DriveIn, icon: icChevron, g2: "deep lanes + entry depth arrows", f3: "open-front deep-lane frame + floor rails" },
    "double-deep": { d2: d2DoubleDeep, d3: d3DoubleDeep, icon: icGrid, g2: "paired bays + two-deep divider", f3: "rack frame + mid-depth divider row" },
    "push-back": { d2: d2PushBack, d3: d3PushBack, icon: icChevron, g2: "nested chevrons toward the face", f3: "rack frame + inclined cart rails" },
    "pallet-flow": { d2: d2PalletFlow, d3: d3PalletFlow, icon: icChevron, g2: "roller dots + FIFO flow chevrons", f3: "rack frame + inclined gravity lanes" },
    "carton-flow": { d2: d2CartonFlow, d3: d3CartonFlow, icon: icChevron, g2: "inclined carton pick-face shelves", f3: "low multi-shelf pick-face frame" },
    "mobile-racking": { d2: d2Mobile, d3: d3Mobile, icon: icGrid, g2: "base rail + wheels + bay uprights", f3: "rack frame on a powered mobile base" },
    "cantilever": { d2: d2Cantilever, d3: d3Cantilever, icon: icArm, g2: "column with projecting arm ticks", f3: "back columns + projecting arms" },
    "asrs": { d2: d2Asrs, d3: d3Asrs, icon: icTower, g2: "tall-rack hatch + crane aisle + trolley", f3: "double-sided high bay + crane mast tower" },
    "shuttle": { d2: d2Shuttle, d3: d3Shuttle, icon: icTower, g2: "shuttle channels + carts + lift", f3: "deep-channel frame + lift shaft tower" },
    "mezzanine": { d2: d2Mezzanine, d3: d3Mezzanine, icon: icPlatform, g2: "dashed platform outline + posts + stairs", f3: "raised deck on legs (open underneath)" },
    "dock-in": { d2: d2DockIn, d3: d3Dock, icon: icDoor, g2: "door notch + inbound arrow", f3: "low wall with a recessed door opening" },
    "dock-out": { d2: d2DockOut, d3: d3Dock, icon: icDoor, g2: "door notch + outbound arrow", f3: "low wall with a recessed door opening" },
    "staging": { d2: d2Staging, d3: d3Staging, icon: icDash, g2: "dashed holding-area outline + lane", f3: "low outlined holding pad" },
    "conveyor": { d2: d2Conveyor, d3: d3Conveyor, icon: icBelt, g2: "belt side lines + rollers + direction", f3: "low belt bed with roller ticks" },
    "push-station": { d2: d2Push, d3: d3Push, icon: icBench, g2: "workbench + outward push arrow", f3: "bench on legs + push arrow" },
    "pull-station": { d2: d2Pull, d3: d3Pull, icon: icBench, g2: "workbench + inward pull arrow", f3: "bench on legs + pull arrow" },
    "pack-station": { d2: d2Pack, d3: d3Pack, icon: icBench, g2: "workbench + parcel with tape", f3: "bench on legs + a parcel on top" },
    "rgv": { d2: d2Rgv, d3: d3Rgv, icon: icCart, g2: "twin rails + cart body + heading", f3: "floor rails + a cart body" },
    "agv": { d2: d2Agv, d3: d3Agv, icon: icRobot, g2: "dashed guide path + robot body", f3: "dashed guide path + a robot body" },
  };

  /* ==================================================================
   * PUBLIC API.
   * ================================================================== */
  // On-screen size thresholds (px) below which the LOD icon replaces the
  // full glyph so it stays fast and legible when zoomed out.
  const LOD_MIN_W = 34;
  const LOD_MIN_H = 22;

  function has(type) {
    const r = REG[type];
    return !!(r && typeof r.d2 === "function" && typeof r.d3 === "function");
  }
  function types() { return Object.keys(REG); }

  // Top-down glyph. g = {x, y, w, d, cellPx, color, theme, lod}.
  //   x,y,w,d : footprint in the current draw units (base px)
  //   cellPx  : px per cell in the SAME units (feature density)
  //   lod     : effective ON-SCREEN px per cell (cellPx * zoom) - only
  //             used to pick the detail tier (full glyph vs LOD icon)
  function draw2D(ctx, type, g) {
    const r = REG[type];
    if (!r || typeof r.d2 !== "function" || !g) return false;
    const x = g.x, y = g.y, w = g.w, d = g.d;
    if (!(isFinite(x) && isFinite(y) && w > 0 && d > 0)) return false;
    const cell = g.cellPx > 0 ? g.cellPx : 20;
    const color = g.color || "#8b5cf6";
    const theme = g.theme === "dark" ? "dark" : "light";
    const eff = isFinite(g.lod) && g.lod > 0 ? g.lod : cell;
    const scale = eff / cell;
    const gc = glyphColors(color, theme);
    ctx.save();
    ctx.lineJoin = "round";
    ctx.strokeStyle = gc.stroke;
    ctx.fillStyle = gc.fill;
    ctx.lineWidth = clampN(cell * 0.05, 1, 2.2);
    if (w * scale < LOD_MIN_W || d * scale < LOD_MIN_H) {
      // LOD path: a single tiny centred icon (the tinted footprint is
      // already drawn by the caller), so it stays cheap + legible.
      const rr = clampN(Math.min(w, d) * 0.3, 3, Math.min(w, d) * 0.5);
      r.icon(ctx, x + w / 2, y + d / 2, rr);
    } else {
      r.d2(ctx, x, y, w, d, cell, gc, color, theme);
    }
    ctx.restore();
    return true;
  }

  // Isometric form. P(cx,cy,cz)->{x,y} px; o = {cx, cy, w, d, heightM,
  // color, theme, selected?, selColor?}. cx,cy = the footprint's min
  // (back) corner in world cells; heightM = domain.heightM (metres).
  function draw3D(ctx, type, P, o) {
    const r = REG[type];
    if (!r || typeof r.d3 !== "function" || typeof P !== "function" || !o) return false;
    const x = o.cx, y = o.cy, w = o.w, d = o.d;
    if (!(isFinite(x) && isFinite(y) && w > 0 && d > 0)) return false;
    const h = isFinite(o.heightM) && o.heightM > 0 ? o.heightM : 1;
    const color = o.color || "#8b5cf6";
    const theme = o.theme === "dark" ? "dark" : "light";
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineWidth = 1;
    r.d3(ctx, P, x, y, w, d, h, color, theme);
    if (o.selected) selOutline(ctx, P, x, y, w, d, h, o.selColor || "#38bdf8");
    ctx.restore();
    return true;
  }

  // Per-type schematic descriptions (also proves 2D+3D coverage for the
  // catalogue / tests). Keyed identically to REG (no orphans).
  const meta = {};
  const ICONS = {};
  for (const k of Object.keys(REG)) {
    meta[k] = { type: k, glyph2d: REG[k].g2, form3d: REG[k].f3 };
    ICONS[k] = REG[k].icon;
  }

  WT.shapes = {
    has,
    types,
    draw2D,
    draw3D,
    ICONS,
    meta,
    // Exposed for reuse/tests; illustrative schematic drawing only.
    colors: { rgba, shade, lighten },
  };
})();
