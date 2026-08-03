/* =====================================================================
 * Logistics Flow Studio - WarehouseTwin
 * view.js - the viewport transform: zoom, pan, fit + configurable floor.
 * ---------------------------------------------------------------------
 * A tiny, DOM-FREE math module. It is the SINGLE source of truth for the
 * world<->screen mapping so that every canvas draw call and every pointer
 * hit-test in app.js goes through the exact same transform. Because it
 * touches no DOM, it is unit-tested headlessly by verify_view.js.
 *
 * Coordinate systems
 *   world  : grid cells. One cell = one metre (domain METRES_PER_CELL=1),
 *            so element {x,y,w,d} are already world coordinates.
 *   screen : canvas-local CSS pixels (0,0 = top-left of the canvas box).
 *
 * The transform is an isotropic scale + translation:
 *   screen = pan + world * cellPx * scale
 * where `cellPx` is the base pixels-per-cell at 100% (scale = 1) and
 * `scale` is the user zoom multiplier (1.0 = 100%). Keeping cellPx and
 * scale separate lets "100%" mean a fixed 1:1 reference while Fit picks
 * whatever multiplier shows the whole floor.
 *
 * No frameworks, no build step. Attaches to the global `WT` namespace so
 * it works from file:// as a classic script (not an ES module).
 * ===================================================================== */
(function () {
  "use strict";
  const WT = (window.WT = window.WT || {});

  /* ------------------------------------------------------------------
   * Zoom bounds (multiplier; 1.0 = 100%). Clamped so the user can never
   * zoom into a blur or out into an invisible speck.
   * ------------------------------------------------------------------ */
  const SCALE_MIN = 0.2; // 20%
  const SCALE_MAX = 5.0; // 500%

  /* ------------------------------------------------------------------
   * Configurable floor size, in metres (= cells). The classic floor is
   * 40 x 24 m; the editor now accepts anything from FLOOR_MIN up to a
   * large hall so complex layouts have room. Bigger-than-viewport floors
   * are navigated with zoom + pan.
   * ------------------------------------------------------------------ */
  const FLOOR_MIN = 8; // fits the widest single element (AS/RS is 8 m)
  const FLOOR_MAX_W = 120;
  const FLOOR_MAX_H = 80;
  const FLOOR_DEFAULT_W = 40;
  const FLOOR_DEFAULT_H = 24;

  function clampScale(s) {
    const n = Number(s);
    if (!(n > 0) || !isFinite(n)) return 1;
    return Math.max(SCALE_MIN, Math.min(SCALE_MAX, n));
  }

  // Effective pixels-per-cell at the current zoom.
  function pxPerCell(view) {
    return view.cellPx * view.scale;
  }

  // world (cells) -> screen (canvas-local CSS px)
  function worldToScreen(view, wx, wy) {
    const k = pxPerCell(view);
    return { x: view.panX + wx * k, y: view.panY + wy * k };
  }

  // screen (canvas-local CSS px) -> world (cells)
  function screenToWorld(view, sx, sy) {
    const k = pxPerCell(view);
    return { cx: (sx - view.panX) / k, cy: (sy - view.panY) / k };
  }

  // Grid snap lives in WORLD coordinates: floor a fractional cell to the
  // integer cell that contains it. Snapping the world coordinate (never
  // the screen pixel) keeps placement stable under any zoom/pan.
  function snap(worldCoord) {
    return Math.floor(worldCoord);
  }

  /* ------------------------------------------------------------------
   * Fit a gridW x gridH cell floor into a vw x vh px viewport, centred,
   * with a fractional `pad` breathing margin (default 4%). Returns the
   * {scale, panX, panY} that shows the WHOLE floor. Scale is clamped to
   * the zoom bounds (a huge floor may bottom out at SCALE_MIN and then
   * need panning).
   * ------------------------------------------------------------------ */
  function fitView(cellPx, gridW, gridH, vw, vh, pad) {
    const p = pad == null ? 0.04 : pad;
    const usableW = vw * (1 - p);
    const usableH = vh * (1 - p);
    const worldPxW = gridW * cellPx;
    const worldPxH = gridH * cellPx;
    const scale = clampScale(Math.min(usableW / worldPxW, usableH / worldPxH));
    const panX = (vw - worldPxW * scale) / 2;
    const panY = (vh - worldPxH * scale) / 2;
    return { scale, panX, panY };
  }

  // Centre the floor in the viewport at the current scale (used by 100%).
  function centerPan(view, gridW, gridH, vw, vh) {
    const k = pxPerCell(view);
    return {
      panX: (vw - gridW * k) / 2,
      panY: (vh - gridH * k) / 2,
    };
  }

  /* ------------------------------------------------------------------
   * Keep the pan within reasonable bounds of the content so the floor
   * cannot be flung entirely off-screen. `margin` px of overscroll is
   * allowed on each side for comfort.
   *   - floor smaller than the viewport: it stays inside (can drift up to
   *     `margin` past an edge).
   *   - floor larger than the viewport: the viewport stays covered by the
   *     floor (again with `margin` slack).
   * ------------------------------------------------------------------ */
  function clampPan(view, gridW, gridH, vw, vh, margin) {
    const k = pxPerCell(view);
    return {
      panX: clampAxis(view.panX, gridW * k, vw, margin || 0),
      panY: clampAxis(view.panY, gridH * k, vh, margin || 0),
    };
  }

  function clampAxis(pan, worldPx, viewPx, m) {
    let lo, hi;
    if (worldPx <= viewPx) {
      lo = -m;
      hi = viewPx - worldPx + m;
    } else {
      lo = viewPx - worldPx - m;
      hi = m;
    }
    return Math.max(lo, Math.min(hi, pan));
  }

  /* ------------------------------------------------------------------
   * Floor-size helpers. normalizeFloor accepts a layout's own gridW/gridH
   * (which may differ from the classic 40 x 24) and clamps them into the
   * supported range, falling back to the default on garbage input.
   * ------------------------------------------------------------------ */
  function normalizeFloor(gridW, gridH) {
    return {
      gridW: clampFloor(gridW, FLOOR_MIN, FLOOR_MAX_W, FLOOR_DEFAULT_W),
      gridH: clampFloor(gridH, FLOOR_MIN, FLOOR_MAX_H, FLOOR_DEFAULT_H),
    };
  }

  function clampFloor(v, lo, hi, dflt) {
    let n = Math.round(Number(v));
    if (!isFinite(n)) n = dflt;
    return Math.max(lo, Math.min(hi, n));
  }

  // The floor's world-space bounds (always anchored at the origin).
  function floorBounds(gridW, gridH) {
    return { minX: 0, minY: 0, maxX: gridW, maxY: gridH, wCells: gridW, hCells: gridH };
  }

  // Topmost (last-drawn) element containing an integer cell. This is the
  // one hit-test both the editor and the tests use, so selection stays
  // correct after any pan/zoom (the pointer is converted to a world cell
  // first, THEN matched here).
  function elementAt(elements, cellX, cellY) {
    for (let i = elements.length - 1; i >= 0; i--) {
      const e = elements[i];
      if (cellX >= e.x && cellX < e.x + e.w && cellY >= e.y && cellY < e.y + e.d) return e;
    }
    return null;
  }

  WT.view = {
    SCALE_MIN,
    SCALE_MAX,
    FLOOR_MIN,
    FLOOR_MAX_W,
    FLOOR_MAX_H,
    FLOOR_DEFAULT_W,
    FLOOR_DEFAULT_H,
    clampScale,
    pxPerCell,
    worldToScreen,
    screenToWorld,
    snap,
    fitView,
    centerPan,
    clampPan,
    normalizeFloor,
    floorBounds,
    elementAt,
  };
})();
