/* =====================================================================
 * Logistics Flow Studio - WarehouseTwin
 * app.js - the interactive shell: canvas editor, constraints, panels,
 *          persistence, simulation wiring, onboarding, and PWA glue.
 * ---------------------------------------------------------------------
 * Vanilla JS, no framework, no build step. Uses the global `WT`
 * namespace (domain.js + simulation.js). Pointer events give unified
 * mouse + touch so it works on Android as an installed PWA.
 * ===================================================================== */
(function () {
  "use strict";
  const WT = window.WT;
  const D = WT.domain;
  const ELEMENTS = D.ELEMENTS;
  const CELL_M = D.METRES_PER_CELL;

  // ---------------- Grid / floor definition ----------------
  // Mutable so the warehouse can be resized (view.js clamps the range).
  // The classic floor is 40 x 24 m; layouts may carry their own size.
  const V = WT.view;
  let GRID_W = V.FLOOR_DEFAULT_W; // cells across (metres)
  let GRID_H = V.FLOOR_DEFAULT_H; // cells down (metres)

  // ---------------- Viewport transform (zoom + pan) ----------------
  // The one transform every draw call and every hit-test routes through
  // (see worldToScreen / screenToWorld below). `cellPx` is the base
  // pixels-per-cell at 100%; `scale` is the zoom multiplier.
  const view = { scale: 1, panX: 0, panY: 0, cellPx: 20 };
  let viewCssW = 800; // canvas viewport size in CSS px (set on resize)
  let viewCssH = 480;
  // Reference viewport shape: the classic 40 x 24 floor exactly fills the
  // canvas at 100%, so the default layout looks identical to before.
  const REF_COLS = V.FLOOR_DEFAULT_W;
  const REF_ROWS = V.FLOOR_DEFAULT_H;

  // ---------------- Accessibility: reduced motion ----------------
  // v1.6 a11y: honour the OS "reduce motion" setting. The live material-flow
  // animation is a continuous requestAnimationFrame loop; when the user has
  // asked for reduced motion we DO NOT auto-run it - Play shows a single
  // static/stepped frame instead, and the app stays fully usable (Step /
  // Reset still advance the model on demand). The matcher is cached so the
  // per-frame guard never allocates. Defensive on environments without
  // matchMedia (returns false -> normal behaviour).
  const _reducedMotionMQ =
    (typeof window.matchMedia === "function")
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;
  function prefersReducedMotion() {
    return !!(_reducedMotionMQ && _reducedMotionMQ.matches);
  }

  // ---------------- Mutable state ----------------
  const state = {
    elements: [], // {id, type, x, y, w, d}
    selectedId: null,
    activeTool: null, // palette type currently being placed
    idCounter: 0,
    config: {
      seed: 42,
      strategy: "abc",
      orders: 200,
      skuCount: 80,
      minAisleMetres: D.AISLE.defaultMinMetres,
      flowMode: "pull", // P3: push vs pull replenishment
      demandSkew: 1.0, // P3: Zipf exponent (presets may skew harder)
      palletType: "EUR1", // P3: unit-load catalog selection
      boxType: "EURO-CASE",
      wagePerHour: 22, // labour-cost KPI: fully-loaded picker wage, EUR/h
      weeklyOrders: 1500, // labour-cost KPI: assumed order volume per week
    },
    lastResult: null,
    resultStale: false, // true when layout/settings changed after a run
    // W3 "bring your own data": the imported dataset (data.js schema)
    // or null for the seeded synthetic demo. NEVER serialized into
    // layouts/share links - it lives in its own localStorage key.
    dataset: null,
    datasetMeta: null, // {fileNames, importedAt} for the honest banner
    // Real-data layer (wmsdata.js): the generated/imported SKU master +
    // order pool bundle that feeds state.dataset. `datasetKind` marks how
    // the active dataset was produced ("generated" | "imported" | null)
    // so the UI is honest (SYNTHETIC vs yours) and so generated data keeps
    // the Simulation inputs editable (they drive the next Generate).
    wmsBundle: null,
    datasetKind: null,
    // W3 floor-plan underlay: image traced under the grid. The dataURL
    // is local (FileReader) and excluded from share links.
    underlay: { img: null, dataUrl: null, opacity: 0.45, visible: true, offMx: 0, offMy: 0, mPerPx: 0.1, persisted: false },
    underlayMode: null, // null | "align" | "calibrate"
    calibPts: [], // up to 2 clicked points (image-pixel coords)
    drag: null, // {id, offsetX, offsetY, moved}
    preview: null, // optimizer proposal: [{id,type,x,y,w,d}] shown as ghosts
    complianceHighlight: null, // element ids highlighted from a Compliance Check finding
    showHeat: false, // pick-traffic heatmap overlay toggle
    // P4 storage & inventory (storage.js): the current physical slotting
    // assignment (SKUs -> storage locations). `storageAssignmentSig` is the
    // layout signature it was built for, so a stale assignment is never fed
    // to the flowsim retrieval leg after the floor changes. `showOccupancy`
    // toggles the fill-by-rack canvas overlay (drawn in the world transform).
    storageAssignment: null,
    storageAssignmentSig: null,
    storageSource: "synthetic",
    showOccupancy: false,
    // P6 automation: `showAutoUtil` toggles the automation-utilisation
    // canvas overlay; `autoUtilByEl` caches per-element utilisation % from
    // the last Analyse automation run so the overlay can colour each
    // automation element (drawn in the world transform, zoom/pan-safe).
    showAutoUtil: false,
    autoUtilByType: null,
    panMode: false, // view hand/pan mode (toolbar toggle)
    // View mode: "top" = the accurate, EDITABLE top-down floor plan (the
    // source of truth); "iso" = the ILLUSTRATIVE 2.5D isometric
    // presentation (iso.js) - viewing/animation only, no element editing.
    viewMode: "top",
    history: [], // run history rows (session-only, see pushHistory)
    historyN: 0, // monotonically increasing run number for the table
    // AI Environment Generator (generate.js + nlcommands.js).
    genMode: "auto", // "auto" | "guided" | "reserve"
    genLayout: null, // last generated { elements, config, meta } (steering context)
    genLog: [], // explainable action log entries {kind, echo, detail}
    // P3: Live material-flow animation (flowsim.js). `sim` is the current
    // flowsim state; `on` gates whether MUs are drawn; `playing` gates the
    // requestAnimationFrame loop; `sig` is the layout signature the sim was
    // built for (rebuilt when the layout/seed changes).
    // P3.1: `kpiHist` is a throttled ring buffer of {tick, completed}
    // samples feeding the Live KPI throughput chart; `kpiBase` is the
    // completed count just before the window (keeps windowed buckets
    // honest); `kpiLastDraw` throttles the cockpit redraw to a few Hz.
    // v1.3: `pool` is the live WT.orderpool state (the visible demand side);
    // `poolPrevSpawned` / `poolPrevCompleted` snapshot the flow's cumulative
    // spawn/retire so each frame's SELECTED aligns with MUs entering picking
    // and COMPLETED with MUs shipped; `poolHist` is a small rolling backlog
    // ring for the sparkline; `poolDemandFactor` sets the synthetic arrival
    // (order-generation) rate as a multiple of the modelled pick capacity so a
    // live backlog is visible (honest what-if, documented in the readout).
    flow: { on: false, playing: false, speed: 1, sim: null, raf: null, sig: null, kpiHist: [], kpiBase: 0, kpiLastDraw: 0, pool: null, poolPrevSpawned: 0, poolPrevCompleted: 0, poolHist: [], poolDemandFactor: 1.15 },
  };

  // ---------------- DOM refs ----------------
  const $ = (id) => document.getElementById(id);
  const canvas = $("floor");
  const ctx = canvas.getContext("2d");
  const canvasWrap = $("canvasWrap");

  // ================================================================
  // THEME COLOURS (canvas can't read CSS vars directly)
  // ================================================================
  function themeColors() {
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    return dark
      ? { bg: "#0e1626", void: "#080d17", grid: "#1c2942", gridStrong: "#2b3d5c", text: "#e2e8f0", dim: "#94a3b8", sel: "#38bdf8", violation: "#f87171", io: "#facc15", flow: "#2dd4bf", warnMark: "#f87171", heat: "#fb923c",
          flowStages: { receiving: "#60a5fa", storage: "#c084fc", picking: "#fbbf24", packing: "#2dd4bf", shipping: "#4ade80" },
          flowCongest: { low: "#4ade80", mid: "#fbbf24", high: "#f87171" } }
      : { bg: "#ffffff", void: "#eef2f7", grid: "#e8edf3", gridStrong: "#cbd5e1", text: "#0f172a", dim: "#64748b", sel: "#0284c7", violation: "#dc2626", io: "#ca8a04", flow: "#0d9488", warnMark: "#dc2626", heat: "#c2410c",
          flowStages: { receiving: "#2563eb", storage: "#9333ea", picking: "#d97706", packing: "#0d9488", shipping: "#16a34a" },
          flowCongest: { low: "#16a34a", mid: "#d97706", high: "#dc2626" } };
  }
  let COLORS = themeColors();

  // ================================================================
  // GEOMETRY HELPERS (grid cell coordinates)
  // ================================================================
  function rectsOverlap(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.d && b.y < a.y + a.d;
  }
  function inBounds(r) {
    return r.x >= 0 && r.y >= 0 && r.x + r.w <= GRID_W && r.y + r.d <= GRID_H;
  }
  function overlapsAny(cand, exceptId) {
    return state.elements.some((e) => e.id !== exceptId && rectsOverlap(cand, e));
  }
  function elementAt(cellX, cellY) {
    // Topmost (last drawn) element containing the cell. Delegates to the
    // shared, DOM-free hit-test so the editor and verify_view.js agree.
    return V.elementAt(state.elements, cellX, cellY);
  }

  // -------- Viewport transform helpers (the single mapping) ----------
  // Everything drawn on the canvas and every pointer hit-test goes
  // through this pair so zoom/pan can never desynchronise them.
  function worldToScreen(wx, wy) { return V.worldToScreen(view, wx, wy); }
  function screenToWorld(sx, sy) { return V.screenToWorld(view, sx, sy); }

  // ----- 2.5D isometric presentation (iso.js) --------------------------
  // Centring origin (canvas base-px) of the projected iso scene, recomputed
  // each frame in iso mode so the diamond sits inside the SAME base-px floor
  // box that Fit/100% frame - which is why zoom/pan/Fit all keep working.
  let isoOx = 0, isoOy = 0;

  // Map a WORLD cell (cx, cy) at height cz (metres) to canvas base-px. In
  // top-down this is the plain world*cellPx mapping; in iso it routes
  // through WT.iso.project + the centring origin. Used for the animated
  // flow MUs/stations so they land in whichever scene is on screen.
  function projPx(cx, cy, cz) {
    if (state.viewMode === "iso" && WT.iso) {
      const p = WT.iso.project(cx, cy, cz || 0);
      return { x: isoOx + p.x * cellPx, y: isoOy + p.y * cellPx };
    }
    return { x: cx * cellPx, y: cy * cellPx };
  }

  // Compute the iso centring origin: project the floor's ground diamond
  // (plus the tallest element's rise) and centre that extent inside the
  // [0..GRID_W] x [0..GRID_H] base-px floor box.
  function computeIsoOrigin() {
    if (!WT.iso) return { x: 0, y: 0 };
    const K = WT.iso.ISO;
    let maxH = 1;
    for (const e of state.elements) maxH = Math.max(maxH, WT.iso.elementHeight(e.type));
    const corners = [[0, 0], [GRID_W, 0], [0, GRID_H], [GRID_W, GRID_H]];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [cx, cy] of corners) {
      const p = WT.iso.project(cx, cy, 0);
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    minY -= maxH * K.KZ; // towers rise upward (negative y)
    const spanX = maxX - minX, spanY = maxY - minY;
    const ox = (GRID_W - spanX) / 2 - minX;
    const oy = (GRID_H - spanY) / 2 - minY;
    return { x: ox * cellPx, y: oy * cellPx };
  }

  // Keep the pan within reasonable bounds of the content and the scale in
  // its clamp (called after any zoom/pan/resize before rendering).
  function clampView() {
    view.scale = V.clampScale(view.scale);
    const p = V.clampPan(view, GRID_W, GRID_H, viewCssW, viewCssH, view.cellPx * 3);
    view.panX = p.panX;
    view.panY = p.panY;
  }

  // Aisle-width guard (informed by DIN 15185). Delegates to the single
  // shared definition in domain.js (also used by the advisor & optimizer).
  function aisleViolations() {
    return D.aisleViolations(state.elements, state.config.minAisleMetres);
  }

  function ioPoint() {
    // Mirrors simulation.ioPointOf for the on-canvas marker.
    let ref = state.elements.filter((e) => e.type === "dock-out");
    if (!ref.length) ref = state.elements.filter((e) => e.type === "dock-in");
    if (!ref.length) return { x: (GRID_W * CELL_M) / 2, y: (GRID_H * CELL_M) / 2 };
    let sx = 0, sy = 0;
    for (const e of ref) { sx += (e.x + e.w / 2) * CELL_M; sy += (e.y + e.d / 2) * CELL_M; }
    return { x: sx / ref.length, y: sy / ref.length };
  }

  function totalPositions() {
    return state.elements.reduce((s, e) => s + D.elementCapacity(e), 0);
  }

  // ================================================================
  // CANVAS RENDERING
  // ================================================================
  let cellPx = 20; // CSS px per cell (recomputed on resize)

  function resizeCanvas() {
    // Fixed-shape viewport (the classic 40 x 24 aspect) that fills the
    // column width. The WORLD may be larger than this box — that is what
    // zoom + pan are for. `cellPx` is the base px-per-cell at 100%: at
    // scale 1 the reference 40-wide floor spans the full width, so the
    // default layout is pixel-for-pixel what it always was.
    const vw = Math.max(280, canvasWrap.clientWidth);
    cellPx = vw / REF_COLS;
    view.cellPx = cellPx;
    const vh = REF_ROWS * cellPx;
    viewCssW = vw;
    viewCssH = vh;
    const dpr = window.devicePixelRatio || 1;
    canvas.style.height = vh + "px";
    canvas.width = Math.round(vw * dpr);
    canvas.height = Math.round(vh * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    clampView();
    render();
  }

  function roundRect(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function render() {
    const cssW = GRID_W * cellPx; // floor extent in base (scale-1) px
    const cssH = GRID_H * cellPx;

    // 1) Clear the whole viewport and paint the "void" outside the floor.
    ctx.clearRect(0, 0, viewCssW, viewCssH);
    ctx.fillStyle = COLORS.void;
    ctx.fillRect(0, 0, viewCssW, viewCssH);

    // 2) Enter WORLD space: translate by the pan then scale by the zoom.
    // Every draw below is unchanged base-px math (world * cellPx); the
    // transform turns it into screen = pan + world * cellPx * scale,
    // exactly what worldToScreen() computes for hit-testing.
    ctx.save();
    ctx.translate(view.panX, view.panY);
    ctx.scale(view.scale, view.scale);

    // 2.5D ISOMETRIC presentation mode: draw the whole scene as extruded
    // iso blocks and return early. It lives inside the SAME pan/scale
    // transform as the top-down path, so zoom/pan/Fit compose unchanged.
    // The heatmap/compliance/aisle overlays are intentionally SKIPPED in
    // iso (they are accurate top-down aids) - stated in the README.
    if (state.viewMode === "iso") {
      renderIsoWorld();
      ctx.restore();
      if (state.flow && state.flow.on) drawFlowLegend();
      updateBadges(aisleViolations(), D.analyzeChains(state.elements));
      return;
    }

    // Floor background (the warehouse footprint itself).
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, cssW, cssH);

    // W3: floor-plan underlay - drawn UNDER the grid lines and every
    // element so racks are traced over the real plan. Local dataURL
    // image (FileReader), so the canvas is never tainted.
    drawUnderlay();

    // grid
    ctx.lineWidth = 1;
    for (let x = 0; x <= GRID_W; x++) {
      ctx.strokeStyle = x % 5 === 0 ? COLORS.gridStrong : COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(Math.round(x * cellPx) + 0.5, 0);
      ctx.lineTo(Math.round(x * cellPx) + 0.5, cssH);
      ctx.stroke();
    }
    for (let y = 0; y <= GRID_H; y++) {
      ctx.strokeStyle = y % 5 === 0 ? COLORS.gridStrong : COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y * cellPx) + 0.5);
      ctx.lineTo(cssW, Math.round(y * cellPx) + 0.5);
      ctx.stroke();
    }

    // pick-traffic heatmap (under the elements — pickers walk the aisles)
    if (state.showHeat) drawHeat();

    // Theme for the per-type shape glyphs (WT.shapes is theme-aware). Read
    // once per frame (not per element) to keep the draw loop allocation-lean.
    const themeName = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

    // v1.6 performance: cull the (expensive) glyph+label draw to the elements
    // whose footprint actually overlaps the visible world rectangle. On a
    // large floor zoomed in, this keeps per-frame work proportional to what
    // is ON SCREEN, not the whole layout. Pure helper (WT.view.cullToView),
    // computed once per frame; the +2 cell pad keeps edge labels intact.
    // Fallback-safe: if the module/helper is absent, draw the full list.
    const _vb = V.viewBounds(view, viewCssW, viewCssH);
    const drawList = (V && typeof V.cullToView === "function")
      ? V.cullToView(state.elements, _vb, 2)
      : state.elements;

    // elements
    for (const e of drawList) {
      const def = ELEMENTS[e.type];
      const px = e.x * cellPx, py = e.y * cellPx, pw = e.w * cellPx, ph = e.d * cellPx;
      ctx.save();
      roundRect(px + 2, py + 2, pw - 4, ph - 4, 6);
      ctx.fillStyle = hexA(def.color, 0.22);
      ctx.fill();
      ctx.lineWidth = e.id === state.selectedId ? 3 : 1.5;
      ctx.strokeStyle = e.id === state.selectedId ? COLORS.sel : def.color;
      ctx.stroke();
      // Distinct top-down glyph from the single shape registry (WT.shapes);
      // fall back to the built-in drawGlyph if the type has no custom shape
      // or the module is absent (nothing breaks). `lod` = on-screen px/cell.
      if (WT.shapes && WT.shapes.has(e.type)) {
        WT.shapes.draw2D(ctx, e.type, {
          x: px, y: py, w: pw, d: ph,
          cellPx: cellPx, color: def.color, theme: themeName, lod: cellPx * view.scale,
        });
      } else {
        drawGlyph(e, def, px, py, pw, ph);
      }

      // label
      const fontSize = Math.max(9, Math.min(13, cellPx * 0.62));
      ctx.fillStyle = COLORS.text;
      ctx.font = `600 ${fontSize}px system-ui, sans-serif`;
      ctx.textBaseline = "top";
      let label = shortLabel(e.type);
      // Docks are the I/O anchors: never let "Dock IN/OUT" truncate to an
      // ambiguous "Doc…" — fall back to the unambiguous IN / OUT.
      if ((e.type === "dock-in" || e.type === "dock-out") && ctx.measureText(label).width > pw - 10) {
        label = e.type === "dock-in" ? "IN" : "OUT";
      }
      if (pw > 30 && ph > 14) {
        clipText(label, px + 6, py + 5, pw - 10);
        if (def.category === "storage" && ph > 30) {
          ctx.fillStyle = COLORS.dim;
          ctx.font = `500 ${Math.max(8, fontSize - 2)}px system-ui, sans-serif`;
          clipText(D.elementCapacity(e) + " pos", px + 6, py + 6 + fontSize, pw - 10);
        }
      }
      ctx.restore();
    }

    // P4: storage occupancy overlay (fill-by-rack tank gauge). Drawn on
    // top of the racks, inside the SAME world transform, so it is zoom/pan
    // safe. Toggled from the Storage & inventory panel.
    if (state.showOccupancy) drawStorageOccupancy();

    // P6: automation utilisation overlay (colours automation elements by
    // utilisation vs the flow demand). Same world transform -> zoom/pan safe.
    // Toggled from the Automation systems panel.
    if (state.showAutoUtil) drawAutomationUtil();

    // P3: material-flow chain arrows + broken-chain markers
    const chains = D.analyzeChains(state.elements);
    drawChain(chains);

    // aisle violations
    const viol = aisleViolations();
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = COLORS.violation;
    for (const v of viol) {
      const ax = (v.a.x + v.a.w / 2) * cellPx, ay = (v.a.y + v.a.d / 2) * cellPx;
      const bx = (v.b.x + v.b.w / 2) * cellPx, by = (v.b.y + v.b.d / 2) * cellPx;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }
    ctx.restore();

    // AI Environment Generator: reserved-zone overlays (manual expansion).
    drawGenZones();

    // Compliance Check highlight: a bright ring around the element(s)
    // named by a finding the user clicked in the Compliance panel.
    if (state.complianceHighlight && state.complianceHighlight.length) {
      ctx.save();
      ctx.setLineDash([]);
      ctx.lineWidth = 3;
      ctx.strokeStyle = COLORS.io;
      for (const id of state.complianceHighlight) {
        const e = state.elements.find((x) => x.id === id);
        if (!e) continue;
        roundRect(e.x * cellPx + 1, e.y * cellPx + 1, e.w * cellPx - 2, e.d * cellPx - 2, 7);
        ctx.stroke();
      }
      ctx.restore();
    }

    // optimizer preview ghosts (proposed positions)
    if (state.preview) {
      ctx.save();
      ctx.setLineDash([5, 3]);
      ctx.lineWidth = 2;
      for (const g of state.preview) {
        const def = ELEMENTS[g.type];
        if (!def || def.category !== "storage") continue;
        const gx = g.x * cellPx, gy = g.y * cellPx, gw = g.w * cellPx, gh = g.d * cellPx;
        roundRect(gx + 2, gy + 2, gw - 4, gh - 4, 6);
        ctx.strokeStyle = COLORS.sel;
        ctx.fillStyle = hexA(def.color, 0.1);
        ctx.fill();
        ctx.stroke();
        // arrow from current position to proposed
        const cur = state.elements.find((e) => e.id === g.id);
        if (cur && (cur.x !== g.x || cur.y !== g.y)) {
          const fx = (cur.x + cur.w / 2) * cellPx, fy = (cur.y + cur.d / 2) * cellPx;
          const tx = (g.x + g.w / 2) * cellPx, ty = (g.y + g.d / 2) * cellPx;
          ctx.beginPath();
          ctx.moveTo(fx, fy);
          ctx.lineTo(tx, ty);
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    // I/O marker. When the point sits inside a dock (the usual case) the
    // diamond used to cover the dock's own IN/OUT label — hop it to the
    // dock's floor-facing side so both stay readable.
    const io = ioPoint();
    const ix = io.x * cellPx;
    let iy = io.y * cellPx;
    const host = state.elements.find(
      (e) => (e.type === "dock-out" || e.type === "dock-in") &&
        io.x >= e.x * CELL_M && io.x <= (e.x + e.w) * CELL_M &&
        io.y >= e.y * CELL_M && io.y <= (e.y + e.d) * CELL_M
    );
    if (host) {
      const dockInLowerHalf = host.y + host.d / 2 > GRID_H / 2;
      iy = dockInLowerHalf ? host.y * cellPx - 9 : (host.y + host.d) * cellPx + 9;
    }
    ctx.save();
    ctx.fillStyle = COLORS.io;
    ctx.beginPath();
    ctx.moveTo(ix, iy - 7);
    ctx.lineTo(ix + 7, iy);
    ctx.lineTo(ix, iy + 7);
    ctx.lineTo(ix - 7, iy);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = COLORS.text;
    ctx.font = "600 10px system-ui, sans-serif";
    ctx.textBaseline = "bottom";
    ctx.fillText("I/O", ix + 9, iy + 4);
    ctx.restore();

    // W3: calibration markers while the user is clicking the 2 points
    // (world-anchored, so still inside the zoom/pan transform).
    drawCalibMarkers();

    // P3: live material-flow MUs (animated boxes). Drawn in WORLD space,
    // inside the same transform as every other overlay, so zoom / pan /
    // Fit all apply and the boxes stay glued to the floor.
    // P3.2: pick/put/pack station rings + queue-count badges are drawn
    // first (under the boxes) in the SAME world transform (zoom/pan-safe).
    if (state.flow && state.flow.on) { drawFlowStations(); drawFlowMUs(); }

    // 3) Leave WORLD space back to screen CSS pixels.
    ctx.restore();

    // heatmap legend: a fixed-size UI chip pinned to the viewport corner
    // (screen space, so it never scales or drifts with zoom/pan).
    if (state.showHeat) drawHeatLegend();

    // P3: live material-flow legend (screen space, pinned to the corner).
    if (state.flow && state.flow.on) drawFlowLegend();

    updateBadges(viol, chains);
  }

  /* ------------------------------------------------------------------
   * 2.5D isometric world-space drawing. Delegates the floor + extruded
   * blocks to the pure/renderer module (WT.iso.drawScene) and then draws
   * the live flow MUs + station queues projected into the same scene
   * (via projPx, which reads the origin we set here). This runs INSIDE
   * the pan/scale transform, so the whole iso scene zooms and pans.
   * Honest scope: iso is ILLUSTRATIVE (heights are illustrative defaults,
   * NOT a survey and NOT a BIM model); the top-down view stays the
   * accurate, editable source of truth.
   * ------------------------------------------------------------------ */
  function renderIsoWorld() {
    if (!WT.iso) return;
    const org = computeIsoOrigin();
    isoOx = org.x;
    isoOy = org.y;
    WT.iso.drawScene(ctx, {
      elements: state.elements,
      gridW: GRID_W,
      gridH: GRID_H,
      cellPx,
      originX: isoOx,
      originY: isoOy,
      colors: COLORS,
      elementDefs: ELEMENTS,
      selectedId: state.selectedId,
      shortLabel,
    });
    // Live material-flow overlay, projected into the iso scene. Drawn
    // AFTER the blocks so the animation stays visible (an honest,
    // illustrative overlay - not true per-pixel occlusion).
    if (state.flow && state.flow.on) { drawFlowStations(); drawFlowMUs(); }
  }

  /* ------------------------------------------------------------------
   * W3: floor-plan underlay drawing + geometry.
   * The image is anchored at (offMx, offMy) metres from the grid origin
   * and scaled by mPerPx (metres per image pixel). Calibration: the
   * user clicks two points on the image that are a known real distance
   * apart and types that distance - mPerPx follows. This beats a blind
   * "scale slider" because a photographed plan has no known pixel
   * scale; two dock doors or a rack row of known length calibrate it
   * in one gesture (documented in the README).
   * ------------------------------------------------------------------ */
  function drawUnderlay() {
    const u = state.underlay;
    if (!u.img || !u.visible) return;
    const pxPerM = cellPx / CELL_M;
    ctx.save();
    ctx.globalAlpha = Math.max(0.05, Math.min(1, u.opacity));
    ctx.drawImage(
      u.img,
      u.offMx * pxPerM,
      u.offMy * pxPerM,
      u.img.naturalWidth * u.mPerPx * pxPerM,
      u.img.naturalHeight * u.mPerPx * pxPerM
    );
    ctx.restore();
  }

  function drawCalibMarkers() {
    if (state.underlayMode !== "calibrate" || !state.calibPts.length) return;
    const u = state.underlay;
    const pxPerM = cellPx / CELL_M;
    ctx.save();
    ctx.strokeStyle = COLORS.sel;
    ctx.fillStyle = COLORS.sel;
    ctx.lineWidth = 2;
    const pts = state.calibPts.map((p) => ({
      x: (u.offMx + p.ix * u.mPerPx) * pxPerM,
      y: (u.offMy + p.iy * u.mPerPx) * pxPerM,
    }));
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    if (pts.length === 2) {
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[1].x, pts[1].y);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------------
   * Pick-traffic heatmap overlay. Data comes straight from the last
   * run (simulation.js heatmap field: metres walked per 1 m cell) and
   * describes THAT run — the legend flags it when the layout/settings
   * have changed since. One warm hue whose alpha ramps with the square
   * root of the cell's share of the peak: walking traffic is heavily
   * skewed toward the I/O point, and sqrt keeps mid-traffic aisles
   * visible without flattening the hot end.
   * ------------------------------------------------------------------ */
  function heatAlpha(share) {
    return 0.08 + 0.55 * Math.sqrt(share);
  }

  function drawHeat() {
    const res = state.lastResult;
    if (!res || !res.ok || !res.heatmap || res.heatmap.maxM <= 0) return;
    const hm = res.heatmap;
    for (let y = 0; y < hm.h && y < GRID_H; y++) {
      for (let x = 0; x < hm.w && x < GRID_W; x++) {
        const v = hm.cells[y * hm.w + x];
        if (v <= 0) continue;
        ctx.fillStyle = hexA(COLORS.heat, heatAlpha(v / hm.maxM));
        ctx.fillRect(x * cellPx, y * cellPx, cellPx, cellPx);
      }
    }
  }

  function drawHeatLegend() {
    const res = state.lastResult;
    if (!res || !res.ok || !res.heatmap || res.heatmap.maxM <= 0) return;
    const hm = res.heatmap;
    // Bottom-right corner: the top-left would sit on the inbound dock
    // in the starter and MRO layouts; bottom-right is usually floor.
    const w = 200, h = 40;
    // Pinned to the viewport's bottom-right corner (screen space).
    const x0 = viewCssW - w - 8, y0 = viewCssH - h - 8;
    ctx.save();
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = COLORS.bg;
    roundRect(x0, y0, w, h, 8);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
    ctx.strokeStyle = COLORS.gridStrong;
    roundRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1, 8);
    ctx.stroke();
    ctx.font = "600 10px system-ui, sans-serif";
    ctx.textBaseline = "top";
    ctx.fillStyle = COLORS.text;
    const title = "Pick walking (m per cell)";
    ctx.fillText(title, x0 + 8, y0 + 6);
    if (state.resultStale) {
      ctx.fillStyle = COLORS.violation;
      ctx.fillText("· stale", x0 + 12 + ctx.measureText(title).width, y0 + 6);
    }
    // gradient strip: the exact alpha ramp the cells use, plus the peak
    const gx = x0 + 8, gy = y0 + 22, gw = 110, gh = 8, steps = 24;
    for (let i = 0; i < steps; i++) {
      ctx.fillStyle = hexA(COLORS.heat, heatAlpha((i + 0.5) / steps));
      ctx.fillRect(gx + (gw / steps) * i, gy, gw / steps + 0.5, gh);
    }
    ctx.fillStyle = COLORS.dim;
    ctx.font = "500 9px system-ui, sans-serif";
    ctx.fillText("0 – " + hm.maxM.toFixed(0) + " m", gx + gw + 6, gy - 1);
    ctx.restore();
  }

  function toggleHeat() {
    state.showHeat = !state.showHeat;
    const b = $("heatBtn");
    b.classList.toggle("active", state.showHeat);
    b.setAttribute("aria-pressed", String(state.showHeat));
    render();
    if (!state.showHeat) {
      status("Heatmap off.");
      return;
    }
    const hasData = state.lastResult && state.lastResult.ok && state.lastResult.heatmap && state.lastResult.heatmap.maxM > 0;
    status(
      hasData
        ? "Heatmap on — shading is metres walked per 1 m cell in the last run. Goods-to-person picks (AS/RS, shuttle) add no walking." +
          (state.resultStale ? " Stale: layout/settings changed since — Run again." : "")
        : "Heatmap on — Run the simulation to see where the pickers walk."
    );
  }

  /* ==================================================================
   * P4: STORAGE & INVENTORY (storage.js) — physical slotting, occupancy
   * + retrieval. The pure model lives in storage.js; here we drive it and
   * render the panel + an optional fill-by-rack overlay. Data is SYNTHETIC
   * unless the SKU master was imported (then it is the user's own).
   * ================================================================== */

  // Build (or rebuild) the physical assignment for the CURRENT layout,
  // slotting the loaded SKU master (or a synthetic one derived from the sim
  // config when nothing is loaded) into storage locations by `strategy`.
  function storageBuildAssignment(strategy) {
    if (!WT.storage || !WT.wmsdata) return null;
    readConfigFromUI();
    const layout = currentLayout();
    let master, source;
    if (WT.wmsdata.isLoaded()) {
      master = WT.wmsdata.skuMaster;
      const b = state.wmsBundle || {};
      source = b.source === "synthetic" && b.orderSource !== "imported" ? "synthetic" : "yours";
    } else {
      const nSku = Math.max(1, Math.round(Number(state.config.skuCount) || 80));
      const seed = Math.max(0, Math.round(Number(state.config.seed) || 0));
      const skew = Number(state.config.demandSkew) || 1;
      master = WT.wmsdata.generateSkuMaster({ skuCount: nSku, seed: seed, demandSkew: skew });
      source = "synthetic";
    }
    const seed = Math.max(0, Math.round(Number(state.config.seed) || 0));
    const strat = strategy || state.config.strategy || "abc";
    const asg = WT.storage.build(layout, master, { strategy: strat, seed: seed, source: source });
    state.storageAssignment = asg;
    state.storageAssignmentSig = flowSignature();
    state.storageSource = source;
    return asg;
  }

  // The panel button: (re)assign with the chosen strategy, then refresh the
  // panel, the (retrieval-aware) flow sim and the canvas overlay.
  function storageAssignAction() {
    if (!WT.storage) { toast("Storage & inventory needs storage.js.", "warn"); return; }
    const sel = $("storageStrategy");
    const strat = (sel && sel.value) || state.config.strategy || "abc";
    const asg = storageBuildAssignment(strat);
    if (!asg) { toast("Could not build a slotting assignment.", "warn"); return; }
    // The retrieval leg reads state.storageAssignment: force a flow rebuild.
    state.flow.sig = null;
    renderStoragePanel();
    if (state.showOccupancy) render();
    const st = WT.storage.stats(asg);
    const srcTxt = state.storageSource === "yours" ? "your imported" : "a synthetic";
    toast("Slotted " + fmtInt(st.placedCount) + " SKUs into " + fmtInt(st.capacityTotal) + " locations (" + strat + ").");
    status(
      "Storage slotting (" + strat + ", " + srcTxt + " SKU master): fill " + st.fillPct.toFixed(0) + "%, " +
      "A-class avg " + st.placement.avgDistAClassM.toFixed(1) + " m vs floor avg " + st.placement.avgDistAllM.toFixed(1) + " m" +
      (st.overflow ? " — OVERFLOW: " + fmtInt(st.unplacedCount) + " SKUs exceed capacity (reported, not dropped)." : ". The live material-flow retrieval leg now starts from the real placement anchor.")
    );
  }

  // Clear the slotting when the underlying data resets (keeps the flowsim
  // retrieval leg from anchoring to a stale assignment).
  function storageClear() {
    state.storageAssignment = null;
    state.storageAssignmentSig = null;
    if (WT.storage) WT.storage.clear();
    state.flow.sig = null;
    renderStoragePanel();
    if (state.showOccupancy) render();
  }

  // Fill-by-rack tank-gauge overlay. For each storage element, draw a
  // translucent bar rising from the bottom to its fill %, coloured green ->
  // amber -> red as it approaches full. Drawn inside the world transform.
  function drawStorageOccupancy() {
    const asg = state.storageAssignment;
    if (!asg || !WT.storage) return;
    const occ = WT.storage.occupancy(asg);
    if (!occ) return;
    const byEl = {};
    for (const r of occ.byRack) byEl[r.elId] = r;
    for (const e of state.elements) {
      const r = byEl[e.id];
      if (!r) continue; // not a storage rack in this assignment
      const px = e.x * cellPx, py = e.y * cellPx, pw = e.w * cellPx, ph = e.d * cellPx;
      const frac = Math.max(0, Math.min(1, r.fillPct / 100));
      const col = r.fillPct >= 90 ? "#ef4444" : r.fillPct >= 70 ? "#f59e0b" : "#22c55e";
      ctx.save();
      // gauge fill (rises from the bottom edge of the rack)
      const barH = (ph - 6) * frac;
      ctx.fillStyle = hexA(col, 0.34);
      ctx.fillRect(px + 3, py + 3 + (ph - 6 - barH), pw - 6, barH);
      // outline + % label when the rack is big enough to read
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = hexA(col, 0.9);
      roundRect(px + 2.5, py + 2.5, pw - 5, ph - 5, 5);
      ctx.stroke();
      if (pw > 34 && ph > 20) {
        ctx.fillStyle = COLORS.text;
        ctx.font = "700 " + Math.max(9, Math.min(12, cellPx * 0.55)) + "px system-ui, sans-serif";
        ctx.textBaseline = "bottom";
        ctx.textAlign = "right";
        ctx.fillText(Math.round(r.fillPct) + "%", px + pw - 6, py + ph - 5);
        ctx.textAlign = "left";
      }
      ctx.restore();
    }
  }

  function toggleOccupancy() {
    if (!state.storageAssignment) storageBuildAssignment();
    state.showOccupancy = !state.showOccupancy;
    const b = $("storageOverlayBtn");
    if (b) { b.classList.toggle("active", state.showOccupancy); b.setAttribute("aria-pressed", String(state.showOccupancy)); }
    render();
    status(state.showOccupancy
      ? "Occupancy overlay on — racks shaded by fill % (green < 70, amber < 90, red = near full). Slotting is the transparent ABC/velocity heuristic."
      : "Occupancy overlay off.");
  }

  // Render the Storage & inventory panel: occupancy %, ABC placement
  // quality, fill by zone (storage type), overflow/unplaced — honest labels.
  function renderStoragePanel() {
    const box = $("storageOut");
    if (!box || !WT.storage) return;
    const asg = state.storageAssignment;
    if (!asg) {
      box.innerHTML = '<p class="empty">No slotting yet — click <strong>Assign to storage</strong> to place the SKU master into the racking’s physical locations by ABC / velocity (fast movers into the golden zone near the docks). With a SKU master imported it uses your data; otherwise a synthetic catalogue derived from the Simulation panel.</p>';
      return;
    }
    const st = WT.storage.stats(asg);
    const occ = st.occupancy;
    const src = state.storageSource === "yours" ? "yours" : "synthetic";
    const srcLine = src === "yours"
      ? "<strong>SKU master: yours</strong> (imported, on this device) · slotting = the ABC / velocity <em>heuristic</em>, not measured"
      : "<strong>SKU master: SYNTHETIC</strong> (seeded) · slotting = the ABC / velocity <em>heuristic</em>, not measured";

    const kpi = (lbl, val, cls) => '<div class="k' + (cls ? " " + cls : "") + '"><span class="lbl">' + esc(lbl) + '</span><span class="val">' + esc(val) + "</span></div>";
    const kpis =
      '<div class="wmsdata-kpis storage-kpis">' +
      kpi("Fill", occ.fillPct.toFixed(0) + "%") +
      kpi("Placed", fmtInt(occ.placed) + " / " + fmtInt(occ.capacityTotal)) +
      kpi("A-class avg", st.placement.avgDistAClassM.toFixed(1) + " m") +
      kpi("Floor avg", st.placement.avgDistAllM.toFixed(1) + " m") +
      "</div>";

    // Placement quality: the golden-zone effect, stated plainly + honestly.
    const closer = st.placement.avgDistAllM - st.placement.avgDistAClassM;
    const quality =
      '<p class="storage-quality">' +
      (st.placement.goldenEffect
        ? "Fast movers are <strong>" + closer.toFixed(1) + " m closer</strong> to the docks than the floor average, and <strong>" +
          st.placement.aClassInGoldenPct.toFixed(0) + "% of A-class</strong> SKUs sit in the golden zone (closest " +
          Math.round(st.golden.fraction * 100) + "% of locations)."
        : "This strategy does <strong>not</strong> pull fast movers toward the docks (A-class avg " +
          st.placement.avgDistAClassM.toFixed(1) + " m vs floor " + st.placement.avgDistAllM.toFixed(1) + " m) — pick ABC slotting for the golden-zone win.") +
      "</p>";

    // Overflow / stockout flags (honest — nothing is silently dropped).
    let flags = "";
    if (st.flags.overflow) {
      flags += '<p class="storage-flag warn"><strong>OVERFLOW:</strong> ' + fmtInt(st.unplacedCount) +
        " SKUs exceed the " + fmtInt(occ.capacityTotal) + " physical locations and could not be placed (the slowest movers, reported not dropped — add racking or reduce SKUs).</p>";
    }
    if (st.flags.goldenZoneOverflow) {
      flags += '<p class="storage-flag warn">A-class SKUs (' + fmtInt(st.placement.aCount) + ") exceed the golden-zone capacity (" +
        fmtInt(st.golden.count) + ") — some fast movers sit outside the closest locations.</p>";
    }
    if (!flags) flags = '<p class="storage-flag ok">All SKUs placed — no overflow.</p>';

    // Fill by zone (storage type) — a small bar per type.
    const types = Object.keys(occ.byType).sort((a, b) => occ.byType[b].placed - occ.byType[a].placed);
    const barRows = types.map((t) => {
      const z = occ.byType[t];
      const pct = Math.round(z.fillPct);
      const col = z.fillPct >= 90 ? "#ef4444" : z.fillPct >= 70 ? "#f59e0b" : "#22c55e";
      return '<div class="storage-bar-row"><span class="zl">' + esc(z.label || t) + '</span>' +
        '<span class="zbar"><span class="zfill" style="width:' + pct + "%;background:" + col + '"></span></span>' +
        '<span class="zv">' + pct + "% (" + fmtInt(z.placed) + "/" + fmtInt(z.capacity) + ")</span></div>";
    }).join("");
    const byZone = '<p class="wmsdata-cap">Fill by storage type (zone):</p><div class="storage-bars">' + barRows + "</div>";

    box.innerHTML =
      '<div class="wmsdata-src ' + (src === "yours" ? "yours" : "synthetic") + '">' + srcLine + ".</div>" +
      kpis + quality + flags + byZone;
  }

  function wireStoragePanel() {
    if (!$("storageAssignBtn")) return;
    // Populate the strategy select from the domain STRATEGIES set (reuse).
    const sel = $("storageStrategy");
    if (sel && D && D.STRATEGIES) {
      sel.innerHTML = "";
      for (const id of ["abc", "random", "zone", "batch", "wave"]) {
        if (!D.STRATEGIES[id]) continue;
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = D.STRATEGIES[id].label;
        sel.appendChild(opt);
      }
      sel.value = (state.config && state.config.strategy) || "abc";
    }
    $("storageAssignBtn").addEventListener("click", storageAssignAction);
    const ob = $("storageOverlayBtn");
    if (ob) ob.addEventListener("click", toggleOccupancy);
    renderStoragePanel();
  }

  /* ==================================================================
   * P3: LIVE MATERIAL FLOW (flowsim.js) — an animated view of boxes /
   * handling units (MUs) moving through the warehouse over time. The
   * pure, deterministic model lives in flowsim.js; here we just drive it
   * from the existing render loop and DRAW the MUs inside the same world
   * transform as every other overlay (so zoom/pan/Fit all apply).
   *
   * HONEST: this is a SYNTHETIC teaching animation — straight-segment
   * waypoint routing between zone centroids, with spawn/completion rate
   * and travel speed from the documented wms.js heuristic. It is NOT a
   * real discrete-event-simulation engine and NOT a measurement.
   * ================================================================== */
  const FLOW_BASE_DT = 1; // sim ticks advanced per animation frame at speed 1
  const FLOW_STEP_TICKS = 8; // ticks advanced by a single "Step" press

  // Congestion threshold (queue length at/above which a station is "hot").
  function flowCongestThreshold() {
    return (WT.flowsim && WT.flowsim.PARAMS && WT.flowsim.PARAMS.congestQueueThreshold) || 6;
  }

  // Draw the live MUs as small rounded boxes, colour-coded by stage. MUs
  // waiting in a CONGESTED station queue get a red congestion outline.
  // World-space math (world cell * cellPx) so the transform scales them.
  function drawFlowMUs() {
    const s = state.flow.sim;
    if (!s || !s.mus || !s.mus.length) return;
    const colors = COLORS.flowStages || {};
    const cong = COLORS.flowCongest || {};
    const thr = flowCongestThreshold();
    const size = Math.max(3.2, cellPx * 0.5); // world px (transform scales it)
    const half = size / 2;
    const r = Math.min(3, size * 0.28);
    ctx.save();
    ctx.lineWidth = 1;
    for (const mu of s.mus) {
      // World cell -> base-px. In iso mode this projects the MU (raised a
      // little off the floor) into the isometric scene; in top-down it is
      // the plain world*cellPx mapping.
      const c = projPx(mu.cx, mu.cy, 0.3);
      const px = c.x, py = c.y;
      roundRect(px - half, py - half, size, size, r);
      ctx.fillStyle = colors[mu.stage] || COLORS.flow;
      ctx.globalAlpha = mu.stage === "shipping" ? 0.98 : 0.9;
      ctx.fill();
      // A queued MU whose station is congested is outlined in the
      // congestion colour so a growing queue reads as "hot" at a glance.
      const hot = mu.status === "queued" && mu.station && mu.station.queue.length >= thr;
      if (hot) { ctx.globalAlpha = 0.85; ctx.strokeStyle = cong.high || COLORS.violation; ctx.lineWidth = 1.4; }
      else { ctx.globalAlpha = 0.45; ctx.strokeStyle = COLORS.text; ctx.lineWidth = 1; }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // Draw each pick/put/pack STATION as a ring with a live queue-count badge,
  // coloured by congestion level (queue length vs the threshold). Drawn in
  // WORLD space inside the same transform as the MUs, so it is zoom/pan-safe.
  function drawFlowStations() {
    const s = state.flow.sim;
    if (!s || !s.stations || !s.stations.length) return;
    const cong = COLORS.flowCongest || {};
    const thr = flowCongestThreshold();
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const st of s.stations) {
      const c = projPx(st.x, st.y, 0.1);
      const px = c.x, py = c.y;
      const q = st.queue.length;
      const col = q >= thr ? (cong.high || COLORS.violation)
        : q >= thr * 0.5 ? (cong.mid || COLORS.io)
        : (cong.low || COLORS.flow);
      const rad = Math.max(4, cellPx * 0.42);
      // Station marker: a rounded ring, filled brighter as it congests.
      roundRect(px - rad, py - rad, rad * 2, rad * 2, 3);
      ctx.fillStyle = hexA(col, q >= thr ? 0.28 : 0.14);
      ctx.fill();
      ctx.lineWidth = q >= thr ? 2.4 : 1.4;
      ctx.strokeStyle = col;
      ctx.stroke();
      // Kind initial (P-ut / P-ick / P-ack -> u / i / a) so the three
      // station roles stay distinguishable without relying on colour.
      const glyph = st.kind === "put" ? "U" : st.kind === "pick" ? "I" : "A";
      const gfs = Math.max(6, Math.round(rad * 0.9));
      ctx.fillStyle = col;
      ctx.font = "700 " + gfs + "px system-ui, sans-serif";
      ctx.fillText(glyph, px, py + 0.5);
      // Live queue-count badge above the station when anything is waiting.
      if (q > 0) {
        const bh = Math.max(9, cellPx * 0.34), bw = Math.max(13, ctx.measureText(String(q)).width + 8);
        const bx = px - bw / 2, by = py - rad - bh - 2;
        roundRect(bx, by, bw, bh, 3);
        ctx.fillStyle = col;
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.font = "700 " + Math.max(7, Math.round(bh * 0.7)) + "px system-ui, sans-serif";
        ctx.fillText(String(q), px, by + bh / 2 + 0.5);
      }
    }
    ctx.restore();
  }

  // A small live legend/counter pinned to the viewport corner (screen
  // space, so it never scales or drifts with zoom/pan).
  function drawFlowLegend() {
    const s = state.flow.sim;
    if (!s || !WT.flowsim) return;
    const stages = WT.flowsim.STAGES;
    const colors = COLORS.flowStages || {};
    const pad = 8, sw = 10, rowH = 15, w = 210;
    const hasStations = !!(s.stations && s.stations.length);
    const h = 22 + stages.length * rowH + 18 + (hasStations ? 13 : 0);
    const x0 = 8, y0 = viewCssH - h - 8;
    ctx.save();
    ctx.globalAlpha = 0.94;
    ctx.fillStyle = COLORS.bg;
    roundRect(x0, y0, w, h, 8);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
    ctx.strokeStyle = COLORS.gridStrong;
    roundRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1, 8);
    ctx.stroke();
    ctx.textBaseline = "top";
    ctx.font = "600 10px system-ui, sans-serif";
    ctx.fillStyle = COLORS.text;
    ctx.fillText("Live material flow (SYNTHETIC)", x0 + pad, y0 + 6);
    let y = y0 + 22;
    for (const st of stages) {
      ctx.fillStyle = colors[st] || COLORS.flow;
      roundRect(x0 + pad, y + 1, sw, sw, 2);
      ctx.fill();
      ctx.fillStyle = COLORS.text;
      ctx.font = "500 10px system-ui, sans-serif";
      ctx.textBaseline = "top";
      ctx.fillText(st.charAt(0).toUpperCase() + st.slice(1), x0 + pad + sw + 6, y);
      ctx.fillStyle = COLORS.dim;
      ctx.textAlign = "right";
      ctx.fillText(String((s.perStage && s.perStage[st]) || 0), x0 + w - pad, y);
      ctx.textAlign = "left";
      y += rowH;
    }
    ctx.fillStyle = COLORS.dim;
    ctx.font = "500 9px system-ui, sans-serif";
    ctx.fillText("in-flight " + s.inflight + " · shipped " + s.completed, x0 + pad, y + 2);
    // P3.2: queue congestion readout (max queue + congested station count).
    if (s.stations && s.stations.length) {
      const thr = flowCongestThreshold();
      const hot = (s.congestedStations || 0) > 0;
      ctx.fillStyle = hot ? (COLORS.flowCongest && COLORS.flowCongest.high) || COLORS.violation : COLORS.dim;
      ctx.fillText("max queue " + (s.maxQueue || 0) + " · congested " + (s.congestedStations || 0) + "/" + s.stations.length + " (≥" + thr + ")", x0 + pad, y + 13);
    }
    ctx.restore();
  }

  // A cheap layout signature: rebuild the flow sim when the floor, the
  // elements or the seed change so the waypoints track the current layout.
  function flowSignature() {
    let sig = GRID_W + "x" + GRID_H + "|s" + state.config.seed + "|";
    for (const e of state.elements) sig += e.type + e.x + "," + e.y + "," + e.w + "," + e.d + ";";
    return sig;
  }

  function flowBuild() {
    if (!WT.flowsim) return false;
    readConfigFromUI();
    const seed = Math.max(0, Math.round(Number(state.config.seed) || 0));
    const layout = Object.assign(currentLayout(), { config: state.config });
    // P4 retrieval: feed the animation the CURRENT physical slotting so the
    // storage->picking leg starts from the real placement anchor. Only when
    // the assignment was built for THIS layout (signature match) — a stale
    // assignment is ignored, so the fallback stays byte-identical to before.
    if (state.storageAssignment && state.storageAssignmentSig === flowSignature()) {
      layout.storageAssignment = state.storageAssignment;
    }
    const opts = { seed: seed, loop: true };
    // Real-data layer: feed the animation the loaded pool's real size + line
    // shape. With nothing loaded, opts is unchanged -> identical to before.
    const shape = activeOrderShape();
    if (shape) { opts.orders = shape.orders; opts.linesPerOrderMax = shape.linesPerOrderMax; }
    state.flow.sim = WT.flowsim.state(layout, opts);
    state.flow.sig = flowSignature();
    resetKpiHistory(); // new sim -> counters restart at 0, so does the chart
    buildOrderPool(seed, shape); // v1.3: the visible demand-side pool
    return true;
  }

  /* ------------------------------------------------------------------
   * v1.3: (re)build the live ORDER POOL alongside the flow sim. The pool
   * shares the flow's seed and its units-per-order convention so the pool's
   * SELECTED (released into picking) aligns with the flow's spawned MUs and
   * its COMPLETED with the flow's shipped MUs. Generation reuses the SKU-
   * velocity-weighted wmsdata generator when present (fallback otherwise).
   * When WT.orderpool is missing the readout simply stays inert.
   * ------------------------------------------------------------------ */
  const POOL_HIST_MAX = 120; // rolling backlog window for the sparkline
  function buildOrderPool(seed, shape) {
    state.flow.poolHist = [];
    state.flow.poolPrevSpawned = state.flow.sim ? state.flow.sim.spawned : 0;
    state.flow.poolPrevCompleted = state.flow.sim ? state.flow.sim.completed : 0;
    if (!WT.orderpool) { state.flow.pool = null; return; }
    // Units-per-order taken from the SAME convention flowsim uses, so the
    // flow's MU deltas convert cleanly to order selections/completions.
    const linesMax = (shape && shape.linesPerOrderMax) || (WT.flowsim.PARAMS && WT.flowsim.PARAMS.linesPerOrderMax) || 6;
    const avgUnits = (1 + linesMax) / 2;
    const tph = (WT.flowsim.PARAMS && WT.flowsim.PARAMS.ticksPerHour) || 60;
    state.flow.pool = WT.orderpool.create({
      seed: seed,
      ticksPerHour: tph,
      avgUnitsPerOrder: avgUnits,
      initialFill: 0.15, // a small starting backlog so the pool is visible from frame 1
      skuCount: state.config.skuCount, // velocity-weighted stream shape (wmsdata)
      demandSkew: state.config.demandSkew,
    });
  }

  // Step the order pool by the SAME dtTicks the flow advanced, driving its
  // selections/completions from the flow's realized spawn/retire deltas
  // (units -> orders) and its arrivals from a synthetic demand rate set a
  // little above the modelled pick capacity so a live backlog is visible.
  function stepOrderPool(dtTicks) {
    const sim = state.flow.sim, pool = state.flow.pool;
    if (!WT.orderpool || !sim || !pool) return;
    const dSpawn = Math.max(0, sim.spawned - state.flow.poolPrevSpawned);
    const dComp = Math.max(0, sim.completed - state.flow.poolPrevCompleted);
    state.flow.poolPrevSpawned = sim.spawned;
    state.flow.poolPrevCompleted = sim.completed;
    const dt = dtTicks > 0 ? dtTicks : 1;
    const avg = pool.avgUnitsPerOrder || 3.5;
    const tph = pool.ticksPerHour || 60;
    const selectionsPerTick = (dSpawn / dt) / avg; // aligns with MUs entering picking
    const completionsPerTick = (dComp / dt) / avg; // aligns with MUs shipped
    const lineUnitsPerHr = (sim.plan && sim.plan.lineThroughput) || 0;
    const capacityOrdersPerTick = (lineUnitsPerHr / avg) / tph;
    const arrivalsPerTick = capacityOrdersPerTick * (state.flow.poolDemandFactor || 1.15);
    WT.orderpool.step(pool, dt, {
      arrivalsPerTick: arrivalsPerTick,
      selectionsPerTick: selectionsPerTick,
      completionsPerTick: completionsPerTick,
    });
    const h = state.flow.poolHist;
    h.push(pool.inPool);
    while (h.length > POOL_HIST_MAX) h.shift();
  }

  // Ensure the sim exists and matches the current layout; rebuild if not.
  function flowEnsureFresh() {
    if (!state.flow.sim || state.flow.sig !== flowSignature()) return flowBuild();
    return true;
  }

  function flowStop() {
    state.flow.playing = false;
    if (state.flow.raf) { cancelAnimationFrame(state.flow.raf); state.flow.raf = null; }
  }

  // The requestAnimationFrame loop: advance the model, then reuse the
  // existing render() (no competing draw loop) and refresh the readout.
  function flowFrame() {
    if (!state.flow.playing) return;
    // v1.6 a11y: if "reduce motion" turned on mid-play, stop the continuous
    // loop and hold the current frame (never keep auto-animating under it).
    if (prefersReducedMotion()) { flowStop(); updateFlowButtons(); return; }
    // If the layout changed mid-play (loaded an example, generated, resized,
    // edited an element), rebuild so the boxes track the current floor.
    if (!state.flow.sim || state.flow.sig !== flowSignature()) flowBuild();
    const flowDt = Math.max(0.05, state.flow.speed) * FLOW_BASE_DT;
    if (state.flow.sim) WT.flowsim.step(state.flow.sim, flowDt);
    stepOrderPool(flowDt); // v1.3: advance the pool by the SAME ticks the flow ran
    render();
    updateFlowReadout();
    updatePoolReadout();
    // Feed the Live KPI cockpit from THIS loop (throttled to a few Hz so
    // the chart redraw never competes with the animation frame rate).
    const now = (window.performance && performance.now) ? performance.now() : Date.now();
    if (now - state.flow.kpiLastDraw >= KPI_DRAW_MS) {
      state.flow.kpiLastDraw = now;
      sampleFlowKpis();
      drawFlowKpis();
    }
    state.flow.raf = requestAnimationFrame(flowFrame);
  }

  function flowPlay() {
    if (!WT.flowsim) { toast("Live material flow needs flowsim.js.", "warn"); return; }
    if (!flowEnsureFresh()) return;
    state.flow.on = true;
    // v1.6 a11y: honour "reduce motion". Rather than auto-run the continuous
    // rAF loop, advance ONE bucket and hold a static frame; the boxes are
    // still shown and the app stays fully usable (Step / Reset advance on
    // demand). This also governs the one-click Guided demo (it calls this).
    if (prefersReducedMotion()) {
      flowStop(); // ensure no loop is running
      WT.flowsim.step(state.flow.sim, FLOW_STEP_TICKS);
      stepOrderPool(FLOW_STEP_TICKS);
      updateFlowButtons();
      render();
      updateFlowReadout();
      updatePoolReadout();
      sampleFlowKpis();
      drawFlowKpis();
      status("Reduced motion is on: showing a static material-flow frame. Use Step to advance, Reset to restart.");
      return;
    }
    if (state.flow.playing) return;
    state.flow.playing = true;
    updateFlowButtons();
    drawFlowKpis(); // immediate cockpit feedback; the rAF loop takes over
    state.flow.raf = requestAnimationFrame(flowFrame);
    status("Live material flow: playing — SYNTHETIC animation (not a real DES engine, not a measurement).");
  }

  // Pause returns to the NORMAL edit view: stop the loop and hide the MUs
  // (the sim is retained so Play resumes exactly where it left off).
  function flowPause() {
    flowStop();
    state.flow.on = false;
    updateFlowButtons();
    render();
    updateFlowReadout();
    updatePoolReadout(); // paused: the pool holds its last state
    drawFlowKpis(); // paused: redraw once so the cockpit holds the last frame
    status("Live material flow: paused — back to the normal edit view.");
  }

  function flowStep() {
    if (!WT.flowsim) return;
    flowStop();
    if (!flowEnsureFresh()) return;
    state.flow.on = true;
    WT.flowsim.step(state.flow.sim, FLOW_STEP_TICKS);
    stepOrderPool(FLOW_STEP_TICKS); // v1.3: keep the pool in lock-step
    updateFlowButtons();
    render();
    updateFlowReadout();
    updatePoolReadout();
    sampleFlowKpis();
    drawFlowKpis();
    status("Live material flow: stepped forward one bucket.");
  }

  function flowReset() {
    flowStop();
    if (!flowBuild()) return;
    state.flow.on = true;
    updateFlowButtons();
    render();
    updateFlowReadout();
    updatePoolReadout(); // reset the pool readout to its fresh state
    sampleFlowKpis();
    drawFlowKpis();
    status("Live material flow: reset to the start (tick 0). Press Play to fill the floor.");
  }

  function updateFlowButtons() {
    const play = $("flowPlayBtn"), pause = $("flowPauseBtn");
    if (play) play.classList.toggle("active", state.flow.playing);
    if (pause) pause.disabled = !state.flow.playing;
  }

  function updateFlowReadout() {
    const out = $("flowReadout");
    if (!out || !WT.flowsim) return;
    const s = state.flow.sim;
    if (!s) {
      out.innerHTML = '<p class="empty">Press Play (or Step) to animate boxes moving through the warehouse. Pause returns to the normal edit view.</p>';
      return;
    }
    const chips = WT.flowsim.STAGES.map((st) => {
      const n = (s.perStage && s.perStage[st]) || 0;
      const label = st.charAt(0).toUpperCase() + st.slice(1);
      return '<span class="flow-chip flow-' + st + '">' + label + ' <strong>' + n + "</strong></span>";
    }).join("");
    const hasStations = !!(s.stations && s.stations.length);
    const queueTxt = hasStations
      ? " · queued <strong>" + (s.queued || 0) + "</strong> · max queue <strong>" + (s.maxQueue || 0) +
        "</strong> · congested " + (s.congestedStations || 0) + "/" + s.stations.length
      : "";
    out.innerHTML =
      '<div class="flow-chips">' + chips + "</div>" +
      '<p class="flow-stats">In-flight <strong>' + s.inflight + "</strong> · Shipped <strong>" + s.completed +
      "</strong> · tick " + s.tick + " · bottleneck throughput ~" + s.plan.lineThroughput.toFixed(0) + " units/hr" +
      queueTxt + (state.flow.playing ? "" : " · paused") + "</p>";
  }

  /* ------------------------------------------------------------------
   * v1.3: Live ORDER POOL readout. Renders the WT.orderpool stats into the
   * flow card: backlog + fill bar, generated/selected/completed (+ dropped),
   * live in/out rates, in-flight, a starving/saturating flag and a backlog
   * sparkline. Fed from the SAME rAF loop as the animation; holds its last
   * state when paused. Everything synthetic + honestly labelled.
   * ------------------------------------------------------------------ */
  function updatePoolReadout() {
    const out = $("flowPoolReadout");
    if (!out) return;
    const pool = state.flow.pool;
    if (!WT.orderpool || !pool) {
      out.innerHTML = '<p class="empty">Order pool needs orderpool.js.</p>';
      return;
    }
    const st = WT.orderpool.stats(pool);
    const pct = Math.max(0, Math.min(100, st.fillPct));
    const fill = $("flowPoolFill"), fillLabel = $("flowPoolFillLabel"), flag = $("flowPoolFlag");
    if (fill) {
      fill.style.width = pct.toFixed(1) + "%";
      fill.classList.toggle("is-saturating", st.saturating);
      fill.classList.toggle("is-starving", st.starving && !st.saturating);
    }
    if (fillLabel) {
      fillLabel.innerHTML = "<span>Backlog " + st.backlog + " / " + st.cap + "</span><span>" + pct.toFixed(0) + "%</span>";
    }
    if (flag) {
      let cls = "is-healthy", txt = "Flowing";
      if (st.saturating) { cls = "is-saturating"; txt = "Saturating — pool at cap, orders dropping"; }
      else if (st.starving) { cls = "is-starving"; txt = "Starving — pool empty"; }
      flag.hidden = false;
      flag.className = "flow-pool-flag " + cls;
      flag.textContent = txt;
    }
    const dropTxt = st.dropped > 0 ? " · dropped <strong>" + st.dropped + "</strong>" : "";
    out.innerHTML =
      '<p class="flow-pool-stats">Generated <strong>' + st.generated + "</strong> · selected <strong>" + st.selected +
      "</strong> · completed <strong>" + st.completed + "</strong>" + dropTxt + "<br>" +
      "In <strong>" + st.inRatePerHr.toFixed(0) + "</strong>/hr · out <strong>" + st.outRatePerHr.toFixed(0) +
      "</strong>/hr · in-flight <strong>" + st.inFlightSelected + "</strong> · gen " +
      (st.generatorSource === "wmsdata" ? "velocity-weighted (wmsdata)" : "seeded fallback") +
      (state.flow.playing ? "" : " · paused") + "</p>";
    drawPoolSpark();
  }

  // Tiny backlog sparkline drawn directly (no external dep) from the rolling
  // pool-backlog history, scaled to [0, cap]. Theme-aware; defensive.
  function drawPoolSpark() {
    const canvas = $("flowPoolSpark");
    if (!canvas || typeof canvas.getContext !== "function") return;
    const g = canvas.getContext("2d");
    if (!g) return;
    const w = canvas.width, h = canvas.height, pad = 2;
    g.clearRect(0, 0, w, h);
    const hist = state.flow.poolHist || [];
    const pool = state.flow.pool;
    const cap = (pool && pool.cap) || 1;
    if (hist.length < 2) return;
    const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    const n = hist.length;
    g.lineWidth = 1.5;
    g.strokeStyle = dark ? "#c084fc" : "#9333ea";
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const x = pad + (w - 2 * pad) * (i / (n - 1));
      const v = Math.max(0, Math.min(cap, hist[i]));
      const y = h - pad - (h - 2 * pad) * (cap > 0 ? v / cap : 0);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  }

  /* ------------------------------------------------------------------
   * P3.1: Live KPI dashboard (kpicharts.js). A compact plant-sim cockpit
   * strip — throughput-over-time, the 7-stage load-vs-capacity bars with
   * the bottleneck flagged, and an in-flight vs shipped readout — drawn on
   * its OWN screen-space canvas (never inside the world zoom/pan). It is
   * fed from the SAME rAF loop that advances flowsim (no competing loop):
   * flowFrame() samples + redraws it, throttled to a few Hz; Step / Reset /
   * Pause force an immediate redraw so a paused view shows the last frame.
   * Everything SYNTHETIC and labelled; the pure data/geometry live in
   * kpicharts.js (verify_kpicharts.js covers them headlessly).
   * ------------------------------------------------------------------ */
  const KPI_HIST_MAX = 180; // rolling throughput window (samples)
  const KPI_DRAW_MS = 130; // cockpit redraw throttle (~7-8 Hz)

  function kpiTheme() {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function resetKpiHistory() {
    state.flow.kpiHist = [];
    state.flow.kpiBase = 0;
    state.flow.kpiLastDraw = 0;
  }

  // Record one {tick, completed} sample; drop the oldest past the window,
  // carrying its completed count into the baseline so the displayed buckets
  // stay honest (they telescope from the baseline, never a giant first bar).
  function sampleFlowKpis() {
    const s = state.flow.sim;
    if (!s) return;
    const h = state.flow.kpiHist;
    const last = h[h.length - 1];
    if (last && last.tick === s.tick && last.completed === s.completed) return;
    h.push({ tick: s.tick, completed: s.completed });
    while (h.length > KPI_HIST_MAX) {
      const dropped = h.shift();
      state.flow.kpiBase = dropped.completed;
    }
  }

  function drawFlowKpis() {
    if (!WT.kpicharts) return;
    const canvas = $("flowKpiCanvas");
    if (!canvas || typeof canvas.getContext !== "function") return;
    const data = WT.kpicharts.series(state.flow.sim, {
      history: state.flow.kpiHist,
      baselineCompleted: state.flow.kpiBase,
      playing: state.flow.playing,
    });
    try { WT.kpicharts.drawDashboard(canvas, data, { theme: kpiTheme() }); } catch (_) { /* defensive */ }
  }

  function wireFlowControls() {
    const on = (id, fn) => { const el = $(id); if (el) el.addEventListener("click", fn); };
    on("flowPlayBtn", flowPlay);
    on("flowPauseBtn", flowPause);
    on("flowStepBtn", flowStep);
    on("flowResetBtn", flowReset);
    const sp = $("flowSpeed");
    if (sp) {
      sp.addEventListener("input", () => {
        state.flow.speed = Math.max(0.25, Number(sp.value) || 1);
        const v = $("flowSpeedVal");
        if (v) v.textContent = (Number.isInteger(state.flow.speed) ? state.flow.speed.toFixed(0) : String(state.flow.speed)) + "×";
      });
    }
    updateFlowButtons();
    drawFlowKpis(); // initial paint: the cockpit shows its "press Play" prompt
  }

  /* ------------------------------------------------------------------
   * P3: distinct original glyphs per element type (all drawn inline,
   * no external assets). Subtle strokes in the element's own colour.
   * ------------------------------------------------------------------ */
  function drawGlyph(e, def, px, py, pw, ph) {
    if (pw < 26 || ph < 16) return;
    ctx.save();
    ctx.strokeStyle = hexA(def.color, 0.55);
    ctx.fillStyle = hexA(def.color, 0.4);
    ctx.lineWidth = 1;
    const x0 = px + 5, y0 = py + ph * 0.55, w = pw - 10, h = ph * 0.4 - 4;
    const line = (a, b, c, d2) => { ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c, d2); ctx.stroke(); };
    switch (e.type) {
      case "selective-racking": // upright frames
        for (let i = 0; i <= 4; i++) line(x0 + (w * i) / 4, py + 4, x0 + (w * i) / 4, py + ph - 4);
        break;
      case "block-stack": { // grid of stacked blocks
        const n = Math.max(2, Math.floor(w / 14));
        for (let i = 0; i < n; i++) ctx.strokeRect(x0 + (w / n) * i + 1, y0, w / n - 3, Math.max(4, h));
        break;
      }
      case "drive-in": // deep lanes + entry arrow
        for (let i = 0; i <= 2; i++) line(x0, y0 + (h * i) / 2, x0 + w, y0 + (h * i) / 2);
        line(x0 + w * 0.5, y0 - 5, x0 + w * 0.5, y0 + h);
        break;
      case "double-deep": // paired bars
        ctx.strokeRect(x0, y0, w, Math.max(3, h * 0.4));
        ctx.strokeRect(x0, y0 + Math.max(4, h * 0.55), w, Math.max(3, h * 0.4));
        break;
      case "push-back": // nested chevrons toward the face
        for (let i = 0; i < 3; i++) {
          const cxp = x0 + w * (0.25 + 0.25 * i);
          line(cxp, y0, cxp - 6, y0 + h / 2);
          line(cxp - 6, y0 + h / 2, cxp, y0 + h);
        }
        break;
      case "pallet-flow": { // roller dots + flow direction
        const n = Math.max(3, Math.floor(w / 12));
        for (let i = 0; i < n; i++) {
          ctx.beginPath();
          ctx.arc(x0 + (w / (n - 1 || 1)) * i, y0 + h / 2, 2, 0, Math.PI * 2);
          ctx.stroke();
        }
        line(x0, y0 - 4, x0 + w, y0 - 4);
        break;
      }
      case "carton-flow": // small inclined lanes
        for (let i = 0; i < 3; i++) line(x0, py + 5 + i * (ph - 10) / 2, x0 + w, py + 8 + i * (ph - 10) / 2);
        break;
      case "mobile-racking": // base rail + wheels
        line(x0, py + ph - 6, x0 + w, py + ph - 6);
        for (let i = 0; i < 3; i++) {
          ctx.beginPath();
          ctx.arc(x0 + w * (0.2 + 0.3 * i), py + ph - 6, 2.5, 0, Math.PI * 2);
          ctx.stroke();
        }
        break;
      case "cantilever": // column with arms
        line(x0 + 4, py + 4, x0 + 4, py + ph - 4);
        for (let i = 0; i < 3; i++) line(x0 + 4, py + 6 + i * (ph - 12) / 2, x0 + Math.min(w, 24), py + 6 + i * (ph - 12) / 2);
        break;
      case "asrs": // crane mast + trolley
        line(x0, py + ph - 5, x0 + w, py + ph - 5);
        line(x0 + w / 2, py + 4, x0 + w / 2, py + ph - 5);
        ctx.strokeRect(x0 + w / 2 - 4, y0, 8, 6);
        break;
      case "shuttle": // twin rails + shuttle cart
        line(x0, y0, x0 + w, y0);
        line(x0, y0 + 6, x0 + w, y0 + 6);
        ctx.fillRect(x0 + w * 0.6, y0 + 1, 10, 4);
        break;
      case "mezzanine": // dashed upper deck
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(px + 6, py + 6, pw - 12, ph - 12);
        ctx.setLineDash([]);
        break;
      case "conveyor": { // roller line
        const horiz = pw >= ph;
        const n = Math.max(2, Math.floor((horiz ? pw : ph) / 10));
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) / n;
          ctx.beginPath();
          if (horiz) ctx.arc(px + pw * t, py + ph / 2, 2, 0, Math.PI * 2);
          else ctx.arc(px + pw / 2, py + ph * t, 2, 0, Math.PI * 2);
          ctx.stroke();
        }
        break;
      }
      case "pack-station": // box with tape
        ctx.strokeRect(x0 + w / 2 - 8, y0 - 2, 16, Math.max(8, h));
        line(x0 + w / 2, y0 - 2, x0 + w / 2, y0 - 2 + Math.max(8, h));
        break;
      default:
        break;
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------------
   * P3: draw the material-flow chain - arrows along connected edges
   * (pointing toward shipping where a path exists, away from receiving
   * otherwise) and a warning marker on broken-chain elements.
   * ------------------------------------------------------------------ */
  function drawChain(chains) {
    ctx.save();
    ctx.strokeStyle = COLORS.flow;
    ctx.fillStyle = COLORS.flow;
    ctx.lineWidth = 1.6;
    const center = (id) => {
      const e = state.elements.find((x) => x.id === id);
      return e ? { x: (e.x + e.w / 2) * cellPx, y: (e.y + e.d / 2) * cellPx } : null;
    };
    for (const edge of chains.edges) {
      const a = center(edge.a), b = center(edge.b);
      if (!a || !b) continue;
      let from = a, to = b;
      const dsA = chains.distToShip[edge.a], dsB = chains.distToShip[edge.b];
      const drA = chains.distFromReceive[edge.a], drB = chains.distFromReceive[edge.b];
      if (dsA !== undefined && dsB !== undefined) {
        if (dsA < dsB) { from = b; to = a; } // flow toward shipping
      } else if (drA !== undefined && drB !== undefined) {
        if (drA > drB) { from = b; to = a; } // flow away from receiving
      }
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      // arrowhead at 65% of the way
      const t = 0.65;
      const mx = from.x + (to.x - from.x) * t, my = from.y + (to.y - from.y) * t;
      const ang = Math.atan2(to.y - from.y, to.x - from.x);
      ctx.beginPath();
      ctx.moveTo(mx, my);
      ctx.lineTo(mx - 7 * Math.cos(ang - 0.45), my - 7 * Math.sin(ang - 0.45));
      ctx.lineTo(mx - 7 * Math.cos(ang + 0.45), my - 7 * Math.sin(ang + 0.45));
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    // broken-chain markers
    for (const w of chains.warnings) {
      if (!w.elId) continue;
      const e = state.elements.find((x) => x.id === w.elId);
      if (!e) continue;
      const mx = (e.x + e.w) * cellPx - 7, my = e.y * cellPx + 7;
      ctx.beginPath();
      ctx.arc(mx, my, 6.5, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.warnMark;
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = "700 9px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("!", mx, my + 0.5);
      ctx.textAlign = "start";
      ctx.fillStyle = COLORS.flow;
    }
    ctx.restore();
  }

  function clipText(text, x, y, maxW) {
    let t = text;
    while (t.length > 1 && ctx.measureText(t).width > maxW) t = t.slice(0, -1);
    if (t !== text && t.length > 1) t = t.slice(0, -1) + "…";
    ctx.fillText(t, x, y);
  }

  function hexA(hex, a) {
    const h = hex.replace("#", "");
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }

  function shortLabel(type) {
    return ({
      "selective-racking": "Racking",
      "block-stack": "Block stack",
      "drive-in": "Drive-in",
      "double-deep": "Double-deep",
      "push-back": "Push-back",
      "pallet-flow": "Pallet-flow",
      "carton-flow": "Carton-flow",
      "mobile-racking": "Mobile rack",
      "cantilever": "Cantilever",
      "asrs": "AS/RS",
      "shuttle": "Shuttle",
      "mezzanine": "Mezzanine",
      "dock-in": "Dock IN",
      "dock-out": "Dock OUT",
      "staging": "Staging",
      "conveyor": "Conveyor",
      "push-station": "Push",
      "pull-station": "Pull",
      "pack-station": "Pack",
      "rgv": "RGV lane",
      "agv": "AGV route",
    })[type] || type;
  }

  function updateBadges(viol, chains) {
    $("capBadge").textContent = "Positions: " + totalPositions();
    const ab = $("aisleBadge");
    if (viol && viol.length) {
      ab.textContent = "Aisle: " + viol.length + " too narrow";
      ab.className = "badge warn";
    } else {
      ab.textContent = "Aisle OK";
      ab.className = "badge ok";
    }
    const fb = $("chainBadge");
    if (fb && chains) {
      const hasConnectors = state.elements.some((e) => D.isConnector(e));
      if (chains.warnings.length) {
        fb.textContent = "Flow: " + chains.warnings.length + " chain issue" + (chains.warnings.length > 1 ? "s" : "");
        fb.className = "badge warn";
        fb.title = chains.warnings.map((w) => w.msg).join("\n");
      } else if (chains.outboundConnected) {
        fb.textContent = "Flow chain OK";
        fb.className = "badge ok";
        fb.title = "Storage is chained to shipping - conveyor legs assist picking in the sim.";
      } else if (hasConnectors) {
        fb.textContent = "Flow: partial";
        fb.className = "badge muted";
        fb.title = "Flow elements placed but no storage is chained to shipping yet.";
      } else {
        fb.textContent = "Flow: manual";
        fb.className = "badge muted";
        fb.title = "No conveyors/stations placed - all movement is manual travel.";
      }
    }
    updateStandardsLive();
    updateCanvasDescription(); // v1.6 a11y: keep the offscreen canvas summary current
  }

  // ================================================================
  // v1.6 A11Y: offscreen canvas description.
  // A <canvas> is opaque to assistive tech, so we maintain a concise text
  // summary of WHAT IS ON THE FLOOR in a visually-hidden element that the
  // canvas points at via aria-describedby (#floorDesc). It describes STABLE
  // structure (element count, floor size, view mode, sim on/off) - not the
  // per-tick counters - so it changes rarely; we only touch the DOM when the
  // text actually changes, so it is cheap even when called every frame.
  // ================================================================
  let _canvasDescCache = "";
  function updateCanvasDescription() {
    const el = $("floorDesc");
    if (!el) return;
    const n = state.elements.length;
    const mode = state.viewMode === "iso" ? "2.5D isometric presentation" : "top-down plan";
    let sim = "not running";
    if (state.flow && state.flow.on) sim = state.flow.playing ? "playing" : "shown (paused)";
    const txt =
      "Warehouse floor plan, " + GRID_W + " by " + GRID_H + " metres, " + mode + " view. " +
      (n === 0
        ? "No elements placed yet."
        : n + " element" + (n === 1 ? "" : "s") + " placed") +
      ". Live material-flow animation " + sim + "." +
      " This is an interactive editor; the visual detail is illustrative, not a survey.";
    if (txt !== _canvasDescCache) {
      _canvasDescCache = txt;
      el.textContent = txt;
    }
  }

  // ================================================================
  // POINTER INTERACTION (place / select / drag)
  // ================================================================
  // Pointer position in canvas-local CSS px (accounts for any CSS scaling
  // of the canvas box). This is the `screen` space of the transform.
  function pointerScreen(e) {
    const rect = canvas.getBoundingClientRect();
    const kx = rect.width ? viewCssW / rect.width : 1;
    const ky = rect.height ? viewCssH / rect.height : 1;
    return { sx: (e.clientX - rect.left) * kx, sy: (e.clientY - rect.top) * ky };
  }

  // Pointer position in WORLD cells (fractional). Routed through the same
  // screenToWorld helper the tests exercise, so hit-testing stays correct
  // under any zoom/pan.
  function pointerCell(e) {
    const s = pointerScreen(e);
    return screenToWorld(s.sx, s.sy);
  }

  let uDrag = null; // underlay align-drag: {mx0, my0, offMx0, offMy0}
  let panDrag = null; // view pan-drag: {sx0, sy0, panX0, panY0}
  let spaceHeld = false; // Space = temporary hand/pan mode

  // Is this pointerdown a PAN gesture rather than an element edit? Middle
  // mouse button, held Space, or the toolbar Pan toggle. Chosen so normal
  // left-drag element moves are never hijacked.
  function isPanGesture(e) {
    // In 2.5D iso mode the floor is presentation-only: no placing, no
    // selecting, no dragging elements. Every drag is treated as a pan so
    // the scene stays navigable while editing is disabled (the element
    // hit-test is top-down-only, which keeps iso simple and honest).
    if (state.viewMode === "iso") return true;
    return e.button === 1 || spaceHeld || state.panMode;
  }

  canvas.addEventListener("pointerdown", (e) => {
    // Any direct canvas interaction clears a Compliance Check highlight.
    if (state.complianceHighlight) state.complianceHighlight = null;
    const { cx, cy } = pointerCell(e);
    // W3 underlay modes take the pointer before element editing.
    if (state.underlayMode === "calibrate" && state.underlay.img) {
      underlayCalibClick(cx * CELL_M, cy * CELL_M);
      return;
    }
    if (state.underlayMode === "align" && state.underlay.img) {
      uDrag = { mx0: cx * CELL_M, my0: cy * CELL_M, offMx0: state.underlay.offMx, offMy0: state.underlay.offMy };
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    // Pan the view (does not touch any element).
    if (isPanGesture(e)) {
      const s = pointerScreen(e);
      panDrag = { sx0: s.sx, sy0: s.sy, panX0: view.panX, panY0: view.panY };
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = "grabbing";
      e.preventDefault();
      return;
    }
    if (state.activeTool) {
      placeAt(state.activeTool, Math.floor(cx), Math.floor(cy));
      return;
    }
    const hit = elementAt(Math.floor(cx), Math.floor(cy));
    if (hit) {
      selectElement(hit.id);
      state.drag = { id: hit.id, offsetX: cx - hit.x, offsetY: cy - hit.y, moved: false };
      canvas.setPointerCapture(e.pointerId);
    } else {
      selectElement(null);
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    if (panDrag) {
      const s = pointerScreen(e);
      view.panX = panDrag.panX0 + (s.sx - panDrag.sx0);
      view.panY = panDrag.panY0 + (s.sy - panDrag.sy0);
      clampView();
      render();
      return;
    }
    if (uDrag) {
      const { cx, cy } = pointerCell(e);
      state.underlay.offMx = uDrag.offMx0 + (cx * CELL_M - uDrag.mx0);
      state.underlay.offMy = uDrag.offMy0 + (cy * CELL_M - uDrag.my0);
      render();
      return;
    }
    if (!state.drag) return;
    const { cx, cy } = pointerCell(e);
    const el = state.elements.find((x) => x.id === state.drag.id);
    if (!el) return;
    const nx = Math.round(cx - state.drag.offsetX);
    const ny = Math.round(cy - state.drag.offsetY);
    if (nx === el.x && ny === el.y) return;
    const cand = { x: nx, y: ny, w: el.w, d: el.d };
    if (inBounds(cand) && !overlapsAny(cand, el.id)) {
      el.x = nx;
      el.y = ny;
      state.drag.moved = true;
      render();
      renderProps();
    }
  });

  function endDrag(e) {
    if (panDrag) {
      panDrag = null;
      if (e && canvas.hasPointerCapture && canvas.hasPointerCapture(e.pointerId)) {
        try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      }
      canvas.style.cursor = viewCursor();
      return;
    }
    if (uDrag) {
      uDrag = null;
      if (e && canvas.hasPointerCapture && canvas.hasPointerCapture(e.pointerId)) {
        try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      }
      saveUnderlay(); // persist the new alignment (session cap rules apply)
      return;
    }
    if (state.drag) {
      if (state.drag.moved) scheduleSave();
      if (e && canvas.hasPointerCapture && canvas.hasPointerCapture(e.pointerId)) {
        try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      }
      state.drag = null;
    }
  }
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  // ================================================================
  // VIEW: ZOOM + PAN
  // ================================================================
  // The cursor to show when idle (grab when in a pan mode, else default).
  function viewCursor() {
    if (state.viewMode === "iso") return "grab"; // iso: drag pans, no editing
    if (state.activeTool) return "copy";
    if (spaceHeld || state.panMode) return "grab";
    return "crosshair";
  }

  // Zoom by `factor`, keeping the WORLD point under (sx, sy) screen px
  // pinned in place (zoom-to-cursor). Screen anchor defaults to centre.
  function zoomAt(factor, sx, sy) {
    if (sx == null) sx = viewCssW / 2;
    if (sy == null) sy = viewCssH / 2;
    const before = screenToWorld(sx, sy);
    view.scale = V.clampScale(view.scale * factor);
    const after = worldToScreen(before.cx, before.cy);
    view.panX += sx - after.x;
    view.panY += sy - after.y;
    clampView();
    render();
    updateZoomBadge();
  }

  // Fit the whole warehouse into the viewport (centred, small margin).
  function fitToFloor() {
    const f = V.fitView(cellPx, GRID_W, GRID_H, viewCssW, viewCssH, 0.04);
    view.scale = f.scale;
    view.panX = f.panX;
    view.panY = f.panY;
    clampView();
    render();
    updateZoomBadge();
  }

  // Reset to 1:1 (100%) with the floor centred in the viewport.
  function resetZoom() {
    view.scale = 1;
    const c = V.centerPan(view, GRID_W, GRID_H, viewCssW, viewCssH);
    view.panX = c.panX;
    view.panY = c.panY;
    clampView();
    render();
    updateZoomBadge();
  }

  // Nudge the pan by a screen-px delta (arrow keys when nothing selected).
  function panBy(dxPx, dyPx) {
    view.panX += dxPx;
    view.panY += dyPx;
    clampView();
    render();
  }

  function togglePanMode() {
    state.panMode = !state.panMode;
    const b = $("panBtn");
    if (b) {
      b.classList.toggle("active", state.panMode);
      b.setAttribute("aria-pressed", String(state.panMode));
    }
    canvas.style.cursor = viewCursor();
    status(state.panMode
      ? "Pan mode on — drag the floor to move it. (Also: middle-mouse drag, or hold Space.)"
      : "Pan mode off.");
  }

  function updateZoomBadge() {
    const z = $("zoomBadge");
    if (z) z.textContent = Math.round(view.scale * 100) + "%";
  }

  // ================================================================
  // VIEW MODE: top-down (editable) <-> 2.5D isometric (presentation)
  // ================================================================
  // Toggle between the accurate, EDITABLE top-down floor plan and the
  // ILLUSTRATIVE 2.5D isometric presentation. Only the RENDERING changes -
  // the underlying elements/config are never touched - so flipping back
  // and forth is a pure no-op on the layout (verified in verify_iso.js).
  function setViewMode(mode) {
    const iso = mode === "iso";
    state.viewMode = iso ? "iso" : "top";
    const b = $("isoBtn");
    if (b) {
      b.classList.toggle("active", iso);
      b.setAttribute("aria-pressed", String(iso));
      b.textContent = iso ? "2.5D on" : "2.5D view";
    }
    if (iso) {
      // Editing is disabled in the presentation view: drop any in-flight
      // edit affordances so nothing looks clickable (view-only). None of
      // this changes state.elements/state.config.
      if (state.activeTool) setTool(null);
      state.preview = null;
      state.complianceHighlight = null;
      state.panMode = false;
      const pb = $("panBtn");
      if (pb) { pb.classList.remove("active"); pb.setAttribute("aria-pressed", "false"); }
    }
    canvas.style.cursor = viewCursor();
    status(iso
      ? "2.5D isometric view — ILLUSTRATIVE presentation (heights are illustrative defaults, not surveyed). Editing is disabled here; drag to pan, zoom/Fit still work. Switch off 2.5D to edit."
      : "Top-down editable view — the accurate source of truth.");
    render();
  }
  function toggleViewMode() {
    setViewMode(state.viewMode === "iso" ? "top" : "iso");
  }

  // Mouse-wheel zoom, centred on the cursor. Non-passive so we can stop
  // the page from scrolling while zooming the floor.
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const s = pointerScreen(e);
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    zoomAt(factor, s.sx, s.sy);
  }, { passive: false });

  // ================================================================
  // CONFIGURABLE FLOOR SIZE (bigger / smaller warehouse)
  // ================================================================
  // Set the warehouse footprint (metres = cells). Existing elements are
  // kept honestly: an element off the new floor is moved back in, and one
  // too large for the new floor has its footprint clipped to fit; an
  // element that cannot fit at all is dropped. `refit` re-fits the view.
  function setFloorSize(w, h, opts) {
    const nf = V.normalizeFloor(w, h);
    GRID_W = nf.gridW;
    GRID_H = nf.gridH;
    const kept = [];
    for (const el of state.elements) {
      const nw = Math.min(el.w, GRID_W);
      const nd = Math.min(el.d, GRID_H);
      if (nw < 1 || nd < 1) continue; // cannot fit on this floor
      el.w = nw;
      el.d = nd;
      el.x = Math.max(0, Math.min(GRID_W - nw, el.x));
      el.y = Math.max(0, Math.min(GRID_H - nd, el.y));
      kept.push(el);
    }
    const dropped = state.elements.length - kept.length;
    state.elements = kept;
    if (state.selectedId && !state.elements.some((e) => e.id === state.selectedId)) {
      state.selectedId = null;
    }
    syncFloorInputs();
    if (!opts || opts.refit !== false) fitToFloor(); else { clampView(); render(); }
    renderProps();
    scheduleSave();
    return { gridW: GRID_W, gridH: GRID_H, dropped };
  }

  function syncFloorInputs() {
    if ($("floorWInput")) $("floorWInput").value = GRID_W;
    if ($("floorHInput")) $("floorHInput").value = GRID_H;
  }

  function applyFloorSizeFromInputs() {
    const w = Number($("floorWInput") && $("floorWInput").value);
    const h = Number($("floorHInput") && $("floorHInput").value);
    const before = state.elements.length;
    const res = setFloorSize(w, h);
    const msg = "Warehouse set to " + res.gridW + " × " + res.gridH + " m." +
      (res.dropped ? " " + res.dropped + " element(s) removed (no longer fit)." : "") +
      " Zoom + pan to navigate — Fit shows the whole floor.";
    status(msg);
    if (res.dropped) toast(res.dropped + " element(s) didn't fit the smaller floor and were removed.", "warn");
    else if (before) toast("Warehouse resized to " + res.gridW + " × " + res.gridH + " m.");
  }

  function placeAt(type, cx, cy) {
    const def = ELEMENTS[type];
    const cand = { x: cx, y: cy, w: def.w, d: def.d };
    // clamp into bounds
    cand.x = Math.max(0, Math.min(GRID_W - cand.w, cand.x));
    cand.y = Math.max(0, Math.min(GRID_H - cand.d, cand.y));
    if (overlapsAny(cand, null)) {
      toast("Cannot place here — it would overlap another element.", "warn");
      return;
    }
    const el = { id: "el-" + ++state.idCounter, type, x: cand.x, y: cand.y, w: def.w, d: def.d };
    state.elements.push(el);
    selectElement(el.id);
    scheduleSave();
    render();
    status(`Placed ${def.label}. Keep placing, or press Esc to select/move.`);
  }

  function selectElement(id) {
    state.selectedId = id;
    renderProps();
    render();
  }

  function deleteSelected() {
    if (!state.selectedId) return;
    state.elements = state.elements.filter((e) => e.id !== state.selectedId);
    state.selectedId = null;
    scheduleSave();
    renderProps();
    render();
  }

  // Duplicate the selected element into the nearest free spot (adjacent
  // sides first, then an outward ring scan). Real layouts are rows of
  // identical racks — duplicate + arrow-nudge beats re-placing each one.
  function duplicateSelected() {
    const el = state.elements.find((e) => e.id === state.selectedId);
    if (!el) return;
    const spot = findFreeSpotNear(el);
    if (!spot) { toast("No free space on the floor for a copy.", "warn"); return; }
    const copy = { id: "el-" + ++state.idCounter, type: el.type, x: spot.x, y: spot.y, w: el.w, d: el.d };
    state.elements.push(copy);
    selectElement(copy.id);
    scheduleSave();
    render();
    status("Duplicated " + ELEMENTS[el.type].label + " — drag it, or nudge with the arrow keys (1 m per step).");
  }

  function findFreeSpotNear(el) {
    const fits = (x, y) => {
      const cand = { x, y, w: el.w, d: el.d };
      return inBounds(cand) && !overlapsAny(cand, null) ? cand : null;
    };
    const adjacent = [
      [el.x, el.y + el.d], // below (next rack row)
      [el.x + el.w, el.y], // right
      [el.x, el.y - el.d], // above
      [el.x - el.w, el.y], // left
    ];
    for (const [x, y] of adjacent) { const c = fits(x, y); if (c) return c; }
    for (let r = 1; r <= Math.max(GRID_W, GRID_H); r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const c = fits(el.x + dx, el.y + dy);
          if (c) return c;
        }
      }
    }
    return null;
  }

  // Arrow-key nudge: move the selected element by 1 cell (= 1 m) with
  // the same bounds/overlap vetoes as dragging.
  function nudgeSelected(dx, dy) {
    const el = state.elements.find((e) => e.id === state.selectedId);
    if (!el) return;
    const cand = { x: el.x + dx, y: el.y + dy, w: el.w, d: el.d };
    if (!inBounds(cand) || overlapsAny(cand, el.id)) return; // silently veto, like drag
    el.x = cand.x;
    el.y = cand.y;
    scheduleSave();
    render();
    renderProps();
  }

  const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

  window.addEventListener("keydown", (e) => {
    if (e.target && /input|select|textarea/i.test(e.target.tagName)) return;
    // Space = temporary hand/pan mode (release to resume editing). Leave
    // Space alone when a button/link is focused so it can still activate.
    if (e.key === " " || e.code === "Space") {
      if (e.target && /button|^a$/i.test(e.target.tagName)) return;
      if (!spaceHeld) { spaceHeld = true; canvas.style.cursor = viewCursor(); }
      e.preventDefault(); // keep the page from scrolling
      return;
    }
    if (e.key === "Escape") { setTool(null); return; }
    if ((e.key === "Delete" || e.key === "Backspace") && state.selectedId) {
      e.preventDefault();
      deleteSelected();
      return;
    }
    if (ARROWS[e.key]) {
      e.preventDefault(); // keep the page from scrolling
      if (state.selectedId) {
        nudgeSelected(ARROWS[e.key][0], ARROWS[e.key][1]); // nudge the selection 1 m
      } else {
        // Nothing selected: arrow keys pan the view instead.
        const step = 48;
        panBy(-ARROWS[e.key][0] * step, -ARROWS[e.key][1] * step);
      }
      return;
    }
    // Zoom keyboard shortcuts: + / - / 0 (fit).
    if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomAt(1.2); return; }
    if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomAt(1 / 1.2); return; }
    if (e.key === "0") { e.preventDefault(); fitToFloor(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === "d" || e.key === "D") && state.selectedId) {
      e.preventDefault(); // browser bookmark shortcut
      duplicateSelected();
    }
  });

  window.addEventListener("keyup", (e) => {
    if (e.key === " " || e.code === "Space") {
      spaceHeld = false;
      if (!panDrag) canvas.style.cursor = viewCursor();
    }
  });

  // ================================================================
  // PALETTE (tier-aware: locked items stay visible with a padlock —
  // capability flags come from tiers.js, the one gate module)
  // ================================================================
  function buildPalette() {
    const caps = WT.tiers.caps();
    const wrap = $("palette");
    wrap.innerHTML = "";
    let lastCat = null;
    for (const type of D.paletteOrder) {
      const def = ELEMENTS[type];
      if (def.category !== lastCat) {
        lastCat = def.category;
        const head = document.createElement("div");
        head.className = "pal-head";
        head.textContent = def.category === "storage" ? "Storage systems" : "Flow elements";
        wrap.appendChild(head);
      }
      const btn = document.createElement("button");
      btn.className = "pal-item";
      btn.type = "button";
      btn.dataset.type = type;
      const locked = !caps.paletteAllowed(type);
      btn.innerHTML =
        `<span class="pal-swatch" style="background:${def.color}"></span>` +
        `<span>${def.label}</span>` +
        (locked ? WT.tiers.padlockSVG() : `<span class="pal-cat">${def.category}</span>`);
      if (locked) {
        btn.classList.add("locked");
        btn.setAttribute("aria-disabled", "true");
        btn.addEventListener("click", () => toast(caps.lockHint(def.label), "warn"));
        attachTooltip(btn, "Full version: " + def.desc);
      } else {
        btn.addEventListener("click", () => setTool(state.activeTool === type ? null : type));
        attachTooltip(btn, def.desc);
      }
      wrap.appendChild(btn);
    }
  }

  function setTool(type) {
    // Placing an element is an EDIT: if the user picks a palette tool while
    // in the 2.5D presentation view, auto-switch back to the editable
    // top-down view so the placement actually lands (iso is view-only).
    if (type && state.viewMode === "iso") setViewMode("top");
    state.activeTool = type;
    document.querySelectorAll(".pal-item").forEach((b) => {
      b.classList.toggle("active", b.dataset.type === type);
    });
    $("modeBadge").textContent = type ? "Mode: Placing " + shortLabel(type) : "Mode: Select";
    canvas.style.cursor = viewCursor();
    if (type) status(`Click the floor to place a ${ELEMENTS[type].label}. Esc to stop.`);
  }

  // ================================================================
  // PROPERTIES PANEL
  // ================================================================
  function renderProps() {
    const panel = $("propPanel");
    const el = state.elements.find((e) => e.id === state.selectedId);
    if (!el) {
      panel.innerHTML = '<p class="empty">Select an element to see its properties.</p>';
      return;
    }
    const def = ELEMENTS[el.type];
    const rows = [];
    rows.push(row("Type", def.label));
    rows.push(row("Category", def.category));
    rows.push(row("Position", `${(el.x * CELL_M).toFixed(0)}, ${(el.y * CELL_M).toFixed(0)} m`));
    rows.push(row("Footprint", `${(el.w * CELL_M).toFixed(1)} × ${(el.d * CELL_M).toFixed(1)} m`));
    if (def.category === "storage") {
      const cap = D.elementCapacity(el);
      rows.push(row(def.pickFace ? "Positions (pallet-eq.)" : "Pallet positions", String(cap)));
      const cpp = D.cartonsPerPallet(state.config.boxType, state.config.palletType);
      rows.push(row("Est. cartons", `≈${(cap * cpp.perPallet).toLocaleString("en-US")} (${cpp.perPallet}/${state.config.palletType} pallet)`));
      rows.push(row("Levels", String(def.levels)));
      rows.push(row("Selectivity", (def.selectivity * 100).toFixed(0) + "%"));
      rows.push(row("Rotation", def.rotation));
      rows.push(row("Cost index", "×" + def.costIndex));
      if (def.goodsToPerson) {
        rows.push(row("Pick mode", `Goods-to-person · ${def.cycleSec}s cycle/line`));
      } else if (def.handlingDeltaSec) {
        const d2 = def.handlingDeltaSec;
        rows.push(row("Handling", (d2 > 0 ? "+" : "") + d2 + " s/line vs base"));
      }
    }
    if (def.io) rows.push(row("I/O role", def.io));
    if (def.flow) rows.push(row("Flow control", def.flow.toUpperCase()));
    if (def.stage) rows.push(row("Chain stage", def.stage));

    let sizeEditor = "";
    if (def.resizable) {
      sizeEditor =
        '<div class="field-row" style="margin-top:10px">' +
        `<div class="field"><label>Width (m)</label><input id="pW" type="number" min="1" max="${GRID_W}" step="1" value="${el.w}"></div>` +
        `<div class="field"><label>Depth (m)</label><input id="pD" type="number" min="1" max="${GRID_H}" step="1" value="${el.d}"></div>` +
        "</div>";
    }

    panel.innerHTML =
      rows.join("") +
      `<p class="prop-desc">${def.desc}</p>` +
      sizeEditor +
      '<div class="prop-actions">' +
      '<button id="dupBtn" class="btn" type="button" title="Copy this element next to itself (Ctrl+D). Arrow keys nudge 1 m.">Duplicate</button>' +
      (def.resizable ? '<button id="rotateBtn" class="btn" type="button">Rotate</button>' : "") +
      '<button id="deleteBtn" class="btn danger" type="button">Delete</button>' +
      "</div>" +
      '<p class="hint" style="margin-bottom:0">Arrow keys nudge the selection 1 m; Ctrl+D duplicates.</p>';

    if (def.resizable) {
      $("pW").addEventListener("change", () => applySize());
      $("pD").addEventListener("change", () => applySize());
      $("rotateBtn").addEventListener("click", () => rotateSelected());
    }
    $("dupBtn").addEventListener("click", duplicateSelected);
    $("deleteBtn").addEventListener("click", deleteSelected);
  }

  function row(k, v) {
    return `<div class="prop-row"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  }

  function applySize() {
    const el = state.elements.find((e) => e.id === state.selectedId);
    if (!el) return;
    const w = Math.max(1, Math.min(GRID_W, Math.round(Number($("pW").value) || el.w)));
    const d = Math.max(1, Math.min(GRID_H, Math.round(Number($("pD").value) || el.d)));
    const cand = { x: el.x, y: el.y, w, d };
    if (!inBounds(cand)) { toast("New size goes off the floor.", "warn"); renderProps(); return; }
    if (overlapsAny(cand, el.id)) { toast("New size would overlap another element.", "warn"); renderProps(); return; }
    el.w = w; el.d = d;
    scheduleSave();
    render();
    renderProps();
  }

  function rotateSelected() {
    const el = state.elements.find((e) => e.id === state.selectedId);
    if (!el) return;
    const cand = { x: el.x, y: el.y, w: el.d, d: el.w };
    if (!inBounds(cand) || overlapsAny(cand, el.id)) { toast("Not enough room to rotate here.", "warn"); return; }
    el.w = cand.w; el.d = cand.d;
    scheduleSave();
    render();
    renderProps();
  }

  // ================================================================
  // SIMULATION
  // ================================================================
  function runSimulation(source) {
    readConfigFromUI();
    const layout = { elements: state.elements, gridW: GRID_W, gridH: GRID_H, cell: CELL_M };
    const res = WT.sim.run(layout, simConfig());
    state.lastResult = res;
    renderKPIs(res);
    render(); // refresh the heatmap overlay/legend for the new run
    if (!res.ok) {
      status("Add at least one storage element (racking or block stack) to run a meaningful sim.");
    } else {
      pushHistory(res, typeof source === "string" ? source : "run");
      status(`Ran ${res.ordersServed} orders with ${res.strategy.toUpperCase()} slotting (seed ${res.seed}). I/O = ${res.ioSource}.`);
    }
  }

  // ================================================================
  // RUN HISTORY (session-only experiment log)
  // ----------------------------------------------------------------
  // Every completed Run appends a row (config summary + headline KPIs)
  // so iterating on strategies/layouts does not require notes on
  // paper. Newest first; the best pick travel and best throughput so
  // far are marked like the A/B table's winners. Deliberately NOT
  // persisted: rows describe layouts that may no longer exist, so the
  // log lives and dies with the browser session.
  // ================================================================
  const HISTORY_CAP = 50; // oldest rows drop off beyond this

  function pushHistory(res, source) {
    if (!res || !res.ok) return;
    const wage = Math.max(0, Number(state.config.wagePerHour) || 0);
    state.history.push({
      n: ++state.historyN,
      source: source,
      data: res.dataSource === "user" ? "user" : null, // W3 provenance tag
      strategy: (D.STRATEGIES[res.strategy] || {}).label || res.strategy,
      flow: (res.flowMode || "pull").toUpperCase(),
      seed: res.seed,
      orders: res.params.orders,
      skus: res.params.skuCount,
      positions: res.palletPositionsTotal,
      travel: res.avgPickTravelM,
      thr: res.throughputOrdersPerHour,
      fill: res.storageFillPct,
      stockout: res.stockoutPct,
      eur: ((res.labourSecPerOrder || 0) / 3600) * wage,
    });
    if (state.history.length > HISTORY_CAP) state.history.shift();
    renderHistory();
  }

  function renderHistory() {
    const wrap = $("histWrap");
    const clearBtn = $("histClearBtn");
    if (!wrap || !clearBtn) return;
    if (!state.history.length) {
      wrap.innerHTML = '<p class="empty">Run the simulation — every run lands here as a comparable row.</p>';
      clearBtn.hidden = true;
      return;
    }
    let bestTravel = Infinity, bestThr = -Infinity;
    for (const r of state.history) {
      if (r.travel < bestTravel) bestTravel = r.travel;
      if (r.thr > bestThr) bestThr = r.thr;
    }
    const rows = state.history
      .slice()
      .reverse()
      .map((r) => {
        const setup =
          `${esc(r.strategy)} · ${esc(r.flow)} · seed ${r.seed} · ${r.orders} ord / ${r.skus} SKU · ${r.positions} pos` +
          (r.source === "optimizer" ? ' <span class="hist-tag">optimizer</span>' : "") +
          (r.data === "user" ? ' <span class="hist-tag">your data</span>' : "");
        return (
          `<tr><td class="hist-n">${r.n}</td><td class="hist-setup">${setup}</td>` +
          `<td class="${r.travel === bestTravel ? "win" : ""}">${r.travel.toFixed(1)}</td>` +
          `<td class="${r.thr === bestThr ? "win" : ""}">${r.thr.toFixed(1)}</td>` +
          `<td>${r.fill.toFixed(0)}</td><td>${r.stockout.toFixed(1)}</td><td>${r.eur.toFixed(2)}</td></tr>`
        );
      })
      .join("");
    wrap.innerHTML =
      '<table class="hist-table"><thead><tr>' +
      "<th>#</th><th>Setup</th><th>m/ord</th><th>ord/hr</th><th>fill %</th><th>stkout %</th><th>EUR/ord</th>" +
      "</tr></thead><tbody>" +
      rows +
      "</tbody></table>";
    clearBtn.hidden = false;
  }

  function clearHistory() {
    state.history = [];
    state.historyN = 0;
    renderHistory();
    status("Run history cleared.");
  }

  // Staleness cue: once a run is displayed, any layout mutation or
  // sim-relevant setting change marks the KPI panel stale (amber note +
  // dimmed numbers) instead of silently showing outdated results.
  // Cleared by the next renderKPIs (Run / Apply-optimize re-runs).
  function markKPIsStale() {
    if (!state.lastResult || state.resultStale) return;
    state.resultStale = true;
    const kpi = $("kpi");
    if (!kpi.querySelector(".stale-note")) {
      const note = document.createElement("div");
      note.className = "stale-note";
      note.textContent = "Layout or settings changed since this run — these numbers are stale. Run the simulation again.";
      kpi.prepend(note);
      kpi.classList.add("stale");
    }
    // The heatmap legend carries its own stale marker — repaint it.
    if (state.showHeat) render();
  }

  function renderKPIs(res) {
    const kpi = $("kpi");
    state.resultStale = false; // fresh numbers — drop the stale marker
    kpi.classList.remove("stale");
    const cpp = D.cartonsPerPallet(state.config.boxType, state.config.palletType);
    const estCartons = res.palletPositionsTotal * cpp.perPallet;
    const wage = Math.max(0, Number(state.config.wagePerHour) || 0);
    const weekly = Math.max(1, Math.round(Number(state.config.weeklyOrders) || 1));
    const eurPerOrder = ((res.labourSecPerOrder || 0) / 3600) * wage;
    const cards = [
      kcard("Throughput", res.throughputOrdersPerHour.toFixed(1), "orders / hr"),
      kcard("Avg pick travel", res.avgPickTravelM.toFixed(1), "m / order"),
      kcard("Storage fill", res.storageFillPct.toFixed(1), "%"),
      kcard("Positions used", res.palletPositionsUsed + " / " + res.palletPositionsTotal, "pallet pos."),
      kcard("Stockouts", res.stockoutPct.toFixed(1), "% of lines"),
      kcard("Overstock returns", String(res.overstockUnits), "units"),
      kcard("Avg face stock", res.avgFaceStockPct.toFixed(0), "% of capacity"),
      kcard("Chain-assisted", res.chainAssistedLinesPct.toFixed(0), "% of lines"),
      kcard("Labour cost", eurPerOrder.toFixed(2), "EUR / order (est.)"),
      kcard("Labour / week", Math.round(eurPerOrder * weekly).toLocaleString("en-US"), "EUR (est.)"),
    ];
    const skewTxt = res.params.demandSkew && res.params.demandSkew !== 1 ? `, demand skew ${res.params.demandSkew}` : "";
    // W3 honest data provenance: say exactly whose data ran.
    let lead;
    if (res.dataSource === "user") {
      lead = res.orderSource === "user-orders"
        ? `YOUR data — replayed your ${res.params.orders} imported orders over your ${res.params.skuCount} SKUs (velocities from your weekly_picks)`
        : `YOUR article data — ${res.params.skuCount} SKUs weighted by your real weekly_picks; the ${res.params.orders}-order stream is synthetic (seeded draws from your pick frequencies — import an order CSV to replay real orders)`;
    } else {
      lead = `Synthetic, seeded run — ${res.params.orders} orders, ${res.params.skuCount} SKUs${skewTxt}`;
    }
    const note =
      `<p class="kpi-note">${lead}, ` +
      `${res.params.pickers} picker @ ${res.params.pickerSpeedMps} m/s, ${res.params.handlingSecPerLine}s/line base handling, ` +
      `${(res.flowMode || "pull").toUpperCase()} replenishment` +
      (res.params.pullLeadOrders ? ` (lead ${res.params.pullLeadOrders} orders)` : "") +
      `. Capacity ≈ ${estCartons.toLocaleString("en-US")} cartons of type ${state.config.boxType} on ${state.config.palletType}. ` +
      `Labour cost = simulated picker time (travel + handling + waits) × ${wage} EUR/h loaded wage; ` +
      `the weekly figure assumes ${weekly.toLocaleString("en-US")} orders/wk — an estimate, not a quote. ` +
      `Same seed → identical KPIs.</p>`;
    kpi.innerHTML = cards.join("") + note;
  }

  function kcard(label, value, unit) {
    return (
      '<div class="kpi-card">' +
      `<div class="kpi-label">${label}</div>` +
      `<div class="kpi-value">${value} <span class="kpi-unit">${unit}</span></div>` +
      "</div>"
    );
  }

  // ================================================================
  // P2 FEATURES: advisor, optimizer, A/B compare, standards panel
  // (advisor.js + optimizer.js do the maths; this wires them to the UI)
  // ================================================================
  function esc(str) {
    return String(str).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
  function currentLayout() {
    return { elements: state.elements, gridW: GRID_W, gridH: GRID_H, cell: CELL_M };
  }

  // W3: the config actually handed to the sim/advisor/optimizer/A-B.
  // The imported dataset rides along OUTSIDE state.config so that
  // serialize() (layout saves + share links) can never pick it up.
  function simConfig(extra) {
    const cfg = Object.assign({}, state.config, extra || {});
    if (state.dataset) cfg.dataset = state.dataset;
    return cfg;
  }

  // Real-data layer -> the AGGREGATE order shape the flow animation and the
  // WMS ops layer consume (a count + avg lines), so they never iterate the
  // pool per frame. Returns null when no order pool is loaded, in which
  // case flowsim/wms fall back to the synthetic default from config -
  // byte-identical to before (guarded by verify_wmsdata.js).
  function activeOrderShape() {
    const ds = state.dataset;
    if (!ds || !Array.isArray(ds.orders) || !ds.orders.length) return null;
    if (WT.wmsdata && typeof WT.wmsdata.orderStreamShape === "function") {
      const s = WT.wmsdata.orderStreamShape(
        ds.orders.map((o) => ({ lines: o.lines })) // shape-only; avoids copying sku strings
      );
      if (s) return s;
    }
    let lines = 0;
    for (const o of ds.orders) lines += o.lines.length;
    const avg = lines / ds.orders.length;
    return { orders: ds.orders.length, lineCount: lines, avgLinesPerOrder: avg, linesPerOrderMax: Math.max(1, Math.round(2 * avg - 1)) };
  }

  // ---- Advisor -----------------------------------------------------
  function runAdvisor() {
    readConfigFromUI();
    const full = WT.advisor.analyze(currentLayout(), simConfig());
    const out = $("advisorOut");
    if (!full.length) {
      out.innerHTML = '<p class="empty">Place some elements, then analyze.</p>';
      return;
    }
    // Tier gate: the demo tier shows only the top suggestions; the rest
    // are counted honestly, not hidden without a trace.
    const caps = WT.tiers.caps();
    const list = full.length > caps.advisorLimit ? full.slice(0, caps.advisorLimit) : full;
    const lockedNote =
      list.length < full.length
        ? `<div class="adv-locked">${WT.tiers.padlockSVG()} Demo shows ${list.length} of ${full.length} suggestions — unlock the full version for the rest.</div>`
        : "";
    out.innerHTML = list
      .map(
        (sug) =>
          `<div class="adv-item ${sug.severity}">` +
          `<div class="adv-head"><span class="adv-dot"></span><span class="adv-finding">${esc(sug.finding)}</span></div>` +
          `<div class="adv-line"><span class="adv-k">Principle</span> ${esc(sug.principle)}</div>` +
          `<div class="adv-line"><span class="adv-k">Est. impact</span> ${esc(sug.impact)}</div>` +
          "</div>"
      )
      .join("") + lockedNote;
    const high = list.filter((x) => x.severity === "high").length;
    status(
      `Advisor: ${list.length}${list.length < full.length ? " of " + full.length : ""} suggestion(s)` +
      `${high ? ", " + high + " high-priority" : ""}${list.length < full.length ? " (demo tier)" : ""}.`
    );
  }

  // ---- Optimizer ---------------------------------------------------
  function deltaRow(label, before, after, unit, lowerIsBetter) {
    const diff = after - before;
    const pct = before !== 0 ? (diff / before) * 100 : 0;
    let cls = "neutral";
    if (lowerIsBetter === true) cls = diff < 0 ? "up" : diff > 0 ? "down" : "neutral";
    else if (lowerIsBetter === false) cls = diff > 0 ? "up" : diff < 0 ? "down" : "neutral";
    const sign = diff > 0 ? "+" : "";
    return (
      `<div class="dl-row"><span class="dl-k">${label}</span>` +
      `<span class="dl-v">${before.toFixed(1)} → ${after.toFixed(1)} <span class="dl-u">${unit}</span></span>` +
      `<span class="dl-pct ${cls}">${sign}${pct.toFixed(1)}%</span></div>`
    );
  }

  function runOptimize() {
    readConfigFromUI();
    const opt = WT.optimizer.optimize(currentLayout(), simConfig());
    const out = $("optOut");
    if (!opt.ok) {
      out.innerHTML = '<p class="empty">Add storage and an outbound dock, then optimize.</p>';
      state.preview = null;
      render();
      return;
    }
    if (opt.movedCount === 0 || !opt.improved) {
      out.innerHTML = `<p class="opt-none">Already near-optimal for the golden zone — no beneficial move found (travel ${opt.before.avgPickTravelM.toFixed(1)} m/order).</p>`;
      state.preview = null;
      render();
      return;
    }
    state.preview = opt.proposedElements;
    render();
    out.innerHTML =
      '<div class="opt-delta">' +
      deltaRow("Avg pick travel", opt.before.avgPickTravelM, opt.after.avgPickTravelM, "m/order", true) +
      deltaRow("Throughput", opt.before.throughputOrdersPerHour, opt.after.throughputOrdersPerHour, "orders/hr", false) +
      deltaRow("Storage fill", opt.before.storageFillPct, opt.after.storageFillPct, "%", null) +
      "</div>" +
      `<p class="hint">Dashed ghosts = ${opt.movedCount} storage element(s) proposed to move toward the dock (~${opt.travelDeltaPct.toFixed(0)}% less travel). Aisles kept valid.</p>` +
      '<div class="prop-actions"><button id="optApply" class="btn primary" type="button">Apply</button><button id="optDiscard" class="btn" type="button">Discard</button></div>';
    $("optApply").addEventListener("click", () => applyOptimize(opt));
    $("optDiscard").addEventListener("click", discardOptimize);
    status(`Optimizer preview: ~${opt.travelDeltaPct.toFixed(0)}% less pick travel. Apply or discard.`);
  }

  function applyOptimize(opt) {
    for (const g of opt.proposedElements) {
      const e = state.elements.find((x) => x.id === g.id);
      if (e) { e.x = g.x; e.y = g.y; }
    }
    state.preview = null;
    scheduleSave();
    render();
    renderProps();
    runSimulation("optimizer"); // tagged in the run-history table
    $("optOut").innerHTML = '<p class="opt-none">Applied. KPIs updated above.</p>';
    toast("Optimized layout applied.");
  }

  function discardOptimize() {
    state.preview = null;
    render();
    $("optOut").innerHTML = '<p class="empty">Discarded — layout unchanged.</p>';
  }

  // ---- A/B comparative predictor -----------------------------------
  // Re-callable on tier change: locked strategies render disabled with
  // a lock marker (visible, not hidden), selections are preserved when
  // still allowed.
  function buildAbControls() {
    const caps = WT.tiers.caps();
    const defaults = { abStratA: "random", abStratB: "abc" };
    for (const id of ["abStratA", "abStratB"]) {
      const selEl = $(id);
      const prev = selEl.value;
      fillStrategySelect(selEl);
      selEl.value = prev && D.STRATEGIES[prev] && caps.strategyAllowed(prev) ? prev : defaults[id];
    }
  }

  function abLayout(kind) {
    if (kind === "optimized") {
      const opt = WT.optimizer.optimize(currentLayout(), simConfig());
      return { elements: opt.proposedElements, gridW: GRID_W, gridH: GRID_H, cell: CELL_M };
    }
    return currentLayout();
  }

  function abLabel(strat, layoutKind) {
    const st = (D.STRATEGIES[strat] || {}).label || strat;
    return `${st} · ${layoutKind === "optimized" ? "optimized" : "current"} layout`;
  }

  function runCompare() {
    readConfigFromUI();
    const cfgA = simConfig({ strategy: $("abStratA").value });
    const cfgB = simConfig({ strategy: $("abStratB").value });
    const A = WT.sim.run(abLayout($("abLayoutA").value), cfgA);
    const B = WT.sim.run(abLayout($("abLayoutB").value), cfgB);
    const nameA = abLabel($("abStratA").value, $("abLayoutA").value);
    const nameB = abLabel($("abStratB").value, $("abLayoutB").value);
    const out = $("abOut");
    if (!A.ok || !B.ok) {
      out.innerHTML = '<p class="empty">Add storage first — both configs need pallet positions.</p>';
      return;
    }
    const rows = [
      ["Throughput", A.throughputOrdersPerHour, B.throughputOrdersPerHour, "orders/hr", "high"],
      ["Avg pick travel", A.avgPickTravelM, B.avgPickTravelM, "m/order", "low"],
      ["Storage fill", A.storageFillPct, B.storageFillPct, "%", "neutral"],
      ["Stockouts", A.stockoutPct, B.stockoutPct, "% lines", "low"],
    ];
    let table =
      `<table class="ab-table"><thead><tr><th></th><th>A</th><th>B</th></tr></thead><tbody>` +
      `<tr class="ab-names"><td></td><td>${esc(nameA)}</td><td>${esc(nameB)}</td></tr>`;
    for (const [label, av, bv, unit, better] of rows) {
      let aCls = "", bCls = "";
      if (better === "high") { if (av > bv) aCls = "win"; else if (bv > av) bCls = "win"; }
      else if (better === "low") { if (av < bv) aCls = "win"; else if (bv < av) bCls = "win"; }
      table += `<tr><td class="ab-k">${label} <span class="dl-u">${unit}</span></td>` +
        `<td class="${aCls}">${av.toFixed(1)}</td><td class="${bCls}">${bv.toFixed(1)}</td></tr>`;
    }
    table += "</tbody></table>";
    // Plain-language recommendation (primary criterion: lower pick travel).
    const better = A.avgPickTravelM <= B.avgPickTravelM ? { r: A, n: nameA, o: B, on: nameB } : { r: B, n: nameB, o: A, on: nameA };
    const pct = better.o.avgPickTravelM > 0 ? ((better.o.avgPickTravelM - better.r.avgPickTravelM) / better.o.avgPickTravelM) * 100 : 0;
    const thrWins = better.r.throughputOrdersPerHour >= better.o.throughputOrdersPerHour;
    const claim = thrWins
      ? `about ${pct.toFixed(0)}% less pick travel and higher throughput than ${esc(better.on)}`
      : `about ${pct.toFixed(0)}% less pick travel than ${esc(better.on)} — but ${esc(better.on)} keeps the higher throughput ` +
        `(${better.o.throughputOrdersPerHour.toFixed(1)} vs ${better.r.throughputOrdersPerHour.toFixed(1)} orders/hr): its per-order overheads outweigh the saved metres here`;
    const rec = pct < 0.5
      ? `<strong>${esc(nameA)}</strong> and <strong>${esc(nameB)}</strong> are effectively tied on pick travel at seed ${state.config.seed}.`
      : `<strong>${esc(better.n)}</strong> has ${claim} (seed ${state.config.seed}).`;
    out.innerHTML = table + `<p class="ab-rec">${rec}</p>`;
    status("Compared A vs B (deterministic, same seed).");
  }

  // ---- German-standards panel --------------------------------------
  const STANDARDS = [
    { code: "ASR A1.8", gov: "Technical Rules for Workplaces — traffic routes and walkways.", app: "Aisle-width guidance keeps truck and pedestrian routes workable." },
    { code: "DIN 15185", gov: "Safety of storage installations; working-aisle design for industrial trucks.", app: "The live minimum-aisle check flags rack rows placed too close (status below)." },
    { code: "EN 15512", gov: "Steel static storage systems — adjustable pallet racking; structural design principles.", app: "Models racking capacity and levels. It does NOT perform structural/load design." },
    { code: "EPAL / DIN EN 13698", gov: "Production specification for the flat wooden Euro (EUR) pallet.", app: "EUR1–EUR6 real dimensions are built into the domain model." },
    { code: "VDI 2510", gov: "VDI guideline for automated guided vehicle (AGV) systems.", app: "Context only: the app models NO AGV systems, so no feature is informed by VDI 2510. Listed for completeness of the standards landscape." },
    { code: "VDI 3564", gov: "VDI recommendations for high-bay and automated (AS/RS) warehouse design, including fire-protection aspects.", app: "The AS/RS crane-aisle element (density, levels, machine cycle time) is informed by VDI 3564 high-bay design guidance. No certification is performed." },
    { code: "DIN EN 619", gov: "Continuous handling equipment and systems — safety requirements for equipment for mechanical handling of unit loads (conveyors).", app: "Conveyor elements and the P3 material-flow chains are informed by EN 619 unit-load conveyor concepts. The app checks chain LOGIC only, never conveyor safety compliance." },
    { code: "DGUV rules", gov: "German statutory accident-insurance rules for workplace and warehouse safety.", app: "General safety framing; this app is a planning aid, not a safety assessment." },
  ];

  function buildStandards() {
    const wrap = $("stdList");
    if (!wrap) return;
    wrap.innerHTML = STANDARDS.map(
      (st) =>
        '<div class="std-item">' +
        `<div class="std-code">${esc(st.code)}</div>` +
        `<div class="std-gov">${esc(st.gov)}</div>` +
        `<div class="std-app"><span class="std-applabel">How this app aligns:</span> ${esc(st.app)}</div>` +
        "</div>"
    ).join("");
    updateStandardsLive();
  }

  function updateStandardsLive() {
    const el = $("stdAisleLive");
    if (!el) return;
    const v = aisleViolations();
    if (v.length) {
      const narrow = Math.min.apply(null, v.map((x) => x.gapM));
      el.textContent = `Live DIN 15185 check: ${v.length} aisle(s) below the ${state.config.minAisleMetres} m minimum (narrowest ${narrow.toFixed(1)} m).`;
      el.className = "std-live warn";
    } else {
      el.textContent = `Live DIN 15185 check: all rack-row aisles meet the ${state.config.minAisleMetres} m minimum.`;
      el.className = "std-live ok";
    }
  }

  // ================================================================
  // KNOWLEDGE BASE (P5) - the editable, versioned standards store.
  // ----------------------------------------------------------------
  // Renders WT.kb by category with each entry's value + unit + source +
  // an honest note and an edit field. Buttons: per-entry Save/Reset,
  // Add rule, Reset all, Export/Import the whole KB (JSON). Editing a
  // value changes what the compliance check / advisor / generator read
  // on the next run (the point of "integrate exactly what we want").
  // DOM-only; the pure store is verified headless by verify_kb.js.
  // ================================================================
  let kbCategoryFilter = "all";

  function buildKnowledgeBase() {
    if (!WT.kb) return;
    const banner = $("kbHonesty");
    if (banner) {
      banner.innerHTML =
        "<strong>Editable, versioned standards knowledge base.</strong> " +
        `<span class="compl-en">${esc(WT.kb.meta.honesty.en)}</span>` +
        `<span class="compl-de" lang="de">${esc(WT.kb.meta.honesty.de)}</span>`;
    }
    const sel = $("kbCategory");
    if (sel && !sel.dataset.built) {
      const opts = ['<option value="all">All categories</option>'].concat(
        WT.kb.meta.categories.map((c) => `<option value="${esc(c.key)}">${esc(c.label)}</option>`)
      );
      // custom rules live under their own category too
      opts.push('<option value="custom">Custom rules</option>');
      sel.innerHTML = opts.join("");
      sel.dataset.built = "1";
      sel.addEventListener("change", () => { kbCategoryFilter = sel.value; renderKnowledgeBase(); });
    }
    renderKnowledgeBase();
    wireKnowledgeButtons();
  }

  function renderKnowledgeBase() {
    const wrap = $("kbList");
    if (!wrap || !WT.kb) return;
    const entries = WT.kb.list(kbCategoryFilter === "all" ? undefined : kbCategoryFilter);
    if (!entries.length) {
      wrap.innerHTML = '<p class="empty">No entries in this category yet. Use <strong>Add rule</strong> to record your own.</p>';
      return;
    }
    const defs = WT.kb.defaults;
    wrap.innerHTML = entries
      .map((e, i) => {
        const isSeed = WT.kb.isSeed(e.id);
        const edited = isSeed && defs[e.id] !== e.value;
        const val = e.kind === "text" ? e.value : e.value;
        return (
          `<div class="kb-item${edited ? " edited" : ""}" id="kb-item-${i}">` +
          `<div class="kb-head"><span class="kb-label">${esc(e.label)}</span>` +
          `<span class="kb-cat">${esc(e.category)}</span>` +
          (edited ? '<span class="kb-badge">edited</span>' : "") +
          (isSeed ? "" : '<span class="kb-badge custom">custom</span>') +
          "</div>" +
          '<div class="kb-edit">' +
          `<input class="kb-input" id="kb-in-${i}" type="${e.kind === "text" ? "text" : "number"}" step="any" value="${esc(String(val))}" aria-label="${esc(e.label)} value" />` +
          `<span class="kb-unit">${esc(e.unit || "")}</span>` +
          `<button class="btn small" id="kb-save-${i}" type="button">Save</button>` +
          `<button class="btn small ghost" id="kb-reset-${i}" type="button">Reset</button>` +
          "</div>" +
          `<div class="kb-source"><span class="kb-src-label">Source:</span> ${esc(e.source)}</div>` +
          `<div class="kb-note">${esc(e.note)}</div>` +
          "</div>"
        );
      })
      .join("");
    entries.forEach((e, i) => {
      const input = $("kb-in-" + i);
      const save = $("kb-save-" + i);
      const reset = $("kb-reset-" + i);
      if (save) save.addEventListener("click", () => applyKbEdit(e.id, input));
      if (input) input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); applyKbEdit(e.id, input); } });
      if (reset) reset.addEventListener("click", () => { WT.kb.reset(e.id); afterKbChange(`Reset "${e.label}" to its sourced default.`); });
    });
  }

  function applyKbEdit(id, input) {
    if (!input) return;
    const ok = WT.kb.set(id, input.value);
    if (!ok) {
      const v = WT.kb.validate(id, input.value);
      toast("Not applied: " + (v.error || "invalid value") + ". The value is unchanged.", "warn");
      const cur = WT.kb.get(id);
      if (cur !== undefined) input.value = String(cur);
      return;
    }
    afterKbChange(`Updated "${id}" to ${WT.kb.get(id)}. The compliance check / advisor / generator will use it on the next run.`);
  }

  // After any KB change: re-render the panel, refresh the live standards
  // read-out, and mark any shown result as stale (the engines now read
  // different guidance). Deterministic, no auto-rerun.
  function afterKbChange(msg) {
    renderKnowledgeBase();
    updateStandardsLive();
    if (msg) { status(msg); toast(msg, "ok"); }
  }

  function wireKnowledgeButtons() {
    const add = $("kbAddRuleBtn");
    if (add && !add.dataset.wired) {
      add.dataset.wired = "1";
      add.addEventListener("click", addKbRule);
    }
    const resetAll = $("kbResetAllBtn");
    if (resetAll && !resetAll.dataset.wired) {
      resetAll.dataset.wired = "1";
      resetAll.addEventListener("click", () => {
        if (!window.confirm("Reset the whole knowledge base to its sourced defaults and remove your custom rules?")) return;
        WT.kb.reset();
        afterKbChange("Knowledge base reset to sourced defaults (custom rules removed).");
      });
    }
    const exp = $("kbExportBtn");
    if (exp && !exp.dataset.wired) {
      exp.dataset.wired = "1";
      exp.addEventListener("click", () => {
        downloadFile("warehousetwin-knowledge-base.json", WT.kb.exportJson(), "application/json");
        status("Exported the knowledge base as JSON (offline — nothing uploaded).");
      });
    }
    const imp = $("kbImportBtn");
    const impInput = $("kbImportInput");
    if (imp && !imp.dataset.wired) {
      imp.dataset.wired = "1";
      imp.addEventListener("click", () => impInput && impInput.click());
    }
    if (impInput && !impInput.dataset.wired) {
      impInput.dataset.wired = "1";
      impInput.addEventListener("change", async () => {
        const file = impInput.files && impInput.files[0];
        impInput.value = "";
        if (!file) return;
        try {
          const text = await readFileText(file);
          const res = WT.kb.importJson(text);
          if (!res.ok && !res.applied && !res.added) {
            toast("Import failed: " + (res.error || "unrecognised file") + ".", "warn");
            return;
          }
          afterKbChange(`Imported knowledge base: ${res.applied} value(s) applied, ${res.added} custom rule(s) added${res.errors && res.errors.length ? ", " + res.errors.length + " skipped" : ""}.`);
        } catch (err) {
          toast("Could not read that file: " + err.message, "warn");
        }
      });
    }
  }

  function addKbRule() {
    if (!WT.kb) return;
    const label = window.prompt("Rule / fact label (e.g. \"Max block-stack height (site rule)\"):", "");
    if (label == null || !label.trim()) return;
    const raw = window.prompt("Numeric value (leave blank for a text note):", "");
    if (raw == null) return;
    let entry;
    if (raw.trim() === "") {
      const txt = window.prompt("Text of the note/fact:", "");
      if (txt == null || !txt.trim()) return;
      entry = { label: label.trim(), value: txt.trim(), kind: "text", category: "custom" };
    } else {
      const num = Number(raw);
      if (!isFinite(num)) { toast("That is not a number — rule not added.", "warn"); return; }
      const unit = window.prompt("Unit (optional, e.g. m, %, SKUs):", "") || "";
      entry = { label: label.trim(), value: num, unit: unit.trim(), category: "custom" };
    }
    const src = window.prompt("Source / justification (optional but honest):", "");
    if (src != null && src.trim()) entry.source = src.trim();
    const id = WT.kb.addRule(entry);
    if (!id) { toast("Rule not added (check the value).", "warn"); return; }
    kbCategoryFilter = "all";
    const sel = $("kbCategory");
    if (sel) sel.value = "all";
    afterKbChange(`Added your rule "${label.trim()}" to the knowledge base.`);
  }

  // ---- Compliance Check (workplace-guideline-aware) ----------------
  // Wires the pure compliance.js report into a panel. The header carries
  // the prominent DE+EN "design aid, NOT a certification" disclaimer,
  // sourced from the module so there is ONE definition of the wording.
  function buildCompliance() {
    const d = $("complDisclaimer");
    if (!d || !WT.compliance) return;
    const dis = WT.compliance.DISCLAIMER;
    d.innerHTML =
      '<strong>Design aid, NOT a certification, legal-compliance guarantee, or Gefährdungsbeurteilung.</strong> ' +
      `<span class="compl-en">${esc(dis.en)}</span>` +
      `<span class="compl-de" lang="de">${esc(dis.de)}</span>`;
  }

  function runCompliance() {
    readConfigFromUI();
    const rep = WT.compliance.check(currentLayout(), simConfig());
    const out = $("complOut");
    const sum = $("complSummary");
    sum.hidden = false;
    sum.innerHTML =
      `<span class="cbadge fail">${rep.summary.fail} fail</span>` +
      `<span class="cbadge warn">${rep.summary.warn} warn</span>` +
      `<span class="cbadge pass">${rep.summary.pass} pass</span>`;
    out.innerHTML = rep.findings
      .map((f, i) => {
        const clickable = f.elements.length > 0;
        const informed = f.informedBy ? esc(f.informedBy.label.en) : "";
        const meas = f.measured
          ? `<div class="compl-line"><span class="compl-k">Measured</span> ${esc(f.measured.label.en)} <span class="compl-k">Informed by</span> ${informed}</div>`
          : (informed ? `<div class="compl-line"><span class="compl-k">Informed by</span> ${informed}</div>` : "");
        return (
          `<div class="compl-item ${f.status}" id="compl-f-${i}"` +
          (clickable ? ' role="button" tabindex="0" title="Highlight the offending element(s) on the floor"' : "") +
          ">" +
          `<div class="compl-head"><span class="cbadge ${f.status}">${f.status}</span>` +
          `<span class="compl-rule">${esc(f.guideline)} · ${esc(f.rule.en)}</span></div>` +
          meas +
          `<div class="compl-line">${esc(f.explain.en)}</div>` +
          `<div class="compl-line de" lang="de">${esc(f.explain.de)}</div>` +
          (clickable ? `<div class="compl-loc">${f.elements.length} element(s) — click to locate on the floor</div>` : "") +
          "</div>"
        );
      })
      .join("");
    rep.findings.forEach((f, i) => {
      if (!f.elements.length) return;
      const node = $("compl-f-" + i);
      if (!node) return;
      const go = () => highlightCompliance(f.elements);
      node.addEventListener("click", go);
      node.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(); }
      });
    });
    status(
      `Compliance check: ${rep.summary.fail} fail, ${rep.summary.warn} warn, ${rep.summary.pass} pass ` +
      "— informed by German workplace guidelines, a design aid and NOT a certification."
    );
  }

  function highlightCompliance(ids) {
    state.complianceHighlight = ids.slice();
    const first = state.elements.find((e) => ids.indexOf(e.id) !== -1);
    if (first) { state.selectedId = first.id; renderProps(); }
    render();
    if (canvasWrap.scrollIntoView) canvasWrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
    status(`Highlighted ${ids.length} element(s) from the compliance finding on the floor.`);
  }

  // ================================================================
  // WMS OPERATIONS (P2)
  // ----------------------------------------------------------------
  // Runs the wms.js operations model on the CURRENT layout: a
  // deterministic, seeded discrete flow of a synthetic order stream
  // through the 7 standard workflow stages. The order-picking stage
  // reuses the pick-travel sim. Renders the stage flow (per-stage
  // throughput / load / backlog), the ISO-22400-grounded KPI summary
  // and the bottleneck stage in plain language. Everything SYNTHETIC
  // and labelled as such; same layout + seed + orders -> identical.
  // ================================================================
  function runWmsOps() {
    if (!WT.wms) return;
    readConfigFromUI();
    const out = $("wmsOut");
    const hours = Math.max(1, Math.round(Number($("wmsHoursInput").value) || 8));
    let orders = Math.max(1, Math.round(Number($("wmsOrdersInput").value) || 300));
    const seed = Math.max(0, Math.round(Number(state.config.seed) || 0));
    // Carry the current sim settings (strategy / SKUs / flow) so the
    // order-picking stage matches the Simulation panel's run; orders,
    // hours and seed from this panel override.
    const cfg = Object.assign({}, state.config);
    // Real-data layer: when an order pool is loaded, the run uses its REAL
    // order count + line shape (aggregate, not per-order) instead of the
    // panel's Orders box. With nothing loaded this block is skipped and the
    // run is exactly as before.
    const shape = activeOrderShape();
    if (shape) {
      orders = shape.orders;
      cfg.linesPerOrderMax = shape.linesPerOrderMax;
      $("wmsOrdersInput").value = orders;
    }
    const layout = Object.assign(currentLayout(), { config: cfg });
    const result = WT.wms.runOperations(layout, { orders: orders, hours: hours, seed: seed });
    const kp = WT.wms.kpis(result, layout);

    if (!result.ok) {
      out.innerHTML =
        '<p class="empty">Add at least one storage element (racking or block stack) so the order-picking stage can run — then the full 7-stage flow has something to move.</p>';
      status("WMS Operations: no storage on the floor — add racking to run the flow.");
      return;
    }

    // ---- 7-stage flow (bars by capacity load; bottleneck highlighted) --
    const stageRows = result.stages
      .map((s, i) => {
        const isBottleneck = i === kp.bottleneck.index;
        const util = Math.max(0, Math.min(1, s.avgUtilisation));
        const pct = (util * 100).toFixed(0);
        const backlog =
          s.maxBacklog > 0.5
            ? `<span class="wms-badge back">peak backlog ${Math.round(s.maxBacklog).toLocaleString("en-US")}</span>`
            : `<span class="wms-badge ok">no backlog</span>`;
        return (
          `<div class="wms-stage${isBottleneck ? " bottleneck" : ""}">` +
          `<div class="wms-stage-head">` +
          `<span class="wms-stage-n">${i + 1}</span>` +
          `<span class="wms-stage-label">${esc(s.label)}</span>` +
          (isBottleneck ? '<span class="wms-badge crit">bottleneck</span>' : "") +
          `<span class="wms-stage-cap">${s.capacityUnitsPerHr.toFixed(0)} u/hr</span>` +
          `</div>` +
          `<div class="wms-bar" title="Average capacity used across the shift"><div class="wms-bar-fill${isBottleneck ? " crit" : ""}" style="width:${pct}%"></div><span class="wms-bar-txt">${pct}% load</span></div>` +
          `<div class="wms-stage-foot">${Math.round(s.processed).toLocaleString("en-US")} units processed · ${backlog}</div>` +
          `<div class="wms-stage-note">${esc(s.note)}</div>` +
          `</div>`
        );
      })
      .join("");

    // ---- KPI summary (reuse the sim KPI card styling) ------------------
    const fmt = (v, d) => (isFinite(v) ? Number(v).toFixed(d == null ? 1 : d) : "—");
    const kcards = [
      kcard("Throughput", fmt(kp.throughputUnitsPerHr, 0), "units / hr"),
      kcard("Throughput", fmt(kp.throughputOrdersPerHr, 1), "orders / hr"),
      kcard("Order cycle time", fmt(kp.orderCycleTimeMin, 1), "min (est.)"),
      kcard("Dock-to-stock", fmt(kp.dockToStockMin, 1), "min (est.)"),
      kcard("Picking productivity", fmt(kp.pickingLinesPerHr, 0), "lines / hr"),
      kcard("Storage utilisation", fmt(kp.storageUtilPct, 1), "%"),
    ].join("");

    const kpiSources = kp.kpis
      .map((k) => `<li><strong>${esc(k.label)}</strong> — ${esc(k.source)}</li>`)
      .join("");

    const shipped = Math.round(result.shippedUnits).toLocaleString("en-US");
    const totalU = Math.round(result.totalUnits).toLocaleString("en-US");
    const remain = Math.round(result.remainingWip).toLocaleString("en-US");

    out.innerHTML =
      `<div class="wms-bottleneck-note"><span class="wms-badge crit">bottleneck</span> ${esc(kp.bottleneck.plain)}</div>` +
      `<div class="wms-stages">${stageRows}</div>` +
      `<h3 class="wms-h3">Warehouse KPIs <span class="wms-synth">SYNTHETIC · grounded in ISO 22400 / standard practice</span></h3>` +
      `<div class="kpi">${kcards}</div>` +
      `<details class="wms-sources"><summary>KPI definitions &amp; sources</summary><ul>${kpiSources}</ul></details>` +
      `<p class="kpi-note">Deterministic seeded flow — seed ${result.seed}, ${orders.toLocaleString("en-US")} orders over a ${hours}-hour shift (${totalU} units in, ${shipped} shipped, ${remain} still in progress at shift end). The order-picking stage reuses the pick-travel sim (${esc((result.sim && result.sim.strategy) || "abc")} slotting). ${esc(result.dataLabel)}</p>`;

    status(
      `WMS Operations: ${fmt(kp.throughputUnitsPerHr, 0)} units/hr shipped, bottleneck = ${esc(kp.bottleneck.label)} — synthetic teaching model, not a certification. Same seed → identical result.`
    );
  }

  // ================================================================
  // P6: AUTOMATION SYSTEMS (automation.js -> WT.automation)
  // ================================================================
  // Models the AS/RS, shuttle, RGV, AGV and conveyor systems on the
  // CURRENT floor as EXPLICIT throughput contributors: per-unit cycle
  // rate (editable KB auto.*) x count -> modeled units/hr, utilisation vs
  // the WMS flow demand, and the automation constraint in plain language.
  // Reuses WT.wms's per-system throughput math (single source of truth).
  // Everything SYNTHETIC + VDI-informed; NOT measured, NOT a certification.
  // Same layout + KB -> identical report (deterministic).
  // ================================================================
  function runAutomation() {
    if (!WT.automation) { toast("Automation systems need automation.js.", "warn"); return; }
    readConfigFromUI();
    const out = $("autoOut");
    const layout = currentLayout();
    // Demand = the WMS operations flow throughput (units/hr) on this floor.
    let demand;
    try {
      const res = WT.wms.runOperations(layout, { seed: Math.max(0, Math.round(Number(state.config.seed) || 0)) });
      demand = WT.wms.kpis(res, layout).throughputUnitsPerHr;
    } catch (_) { demand = undefined; }

    const rep = WT.automation.report(layout, demand);
    state.autoUtilByType = {};
    for (const u of rep.utilisation) state.autoUtilByType[u.type] = u;

    if (!rep.hasAutomation) {
      out.innerHTML =
        '<p class="empty">No automation systems on this floor — throughput is fully manual (the WMS result is unchanged from a hand-worked flow). ' +
        'Add a <strong>conveyor</strong>, <strong>RGV</strong>, <strong>AGV</strong>, <strong>AS/RS</strong> or <strong>shuttle</strong> from the palette, then analyse again.</p>';
      if (state.showAutoUtil) { state.showAutoUtil = false; syncAutoOverlayBtn(); render(); }
      status("Automation: no automation elements on the floor — flow is fully manual (WMS unchanged).");
      return;
    }

    const dem = Math.round(rep.demandUnitsPerHr);
    // ---- per-system rows: throughput + utilisation bar ----------------
    const uByType = {};
    for (const u of rep.utilisation) uByType[u.type] = u;
    const rows = rep.systems.map((s) => {
      const u = uByType[s.type] || { utilisationPct: 0, overCapacity: false };
      const pct = isFinite(u.utilisationPct) ? u.utilisationPct : 999;
      const barPct = Math.max(0, Math.min(100, pct));
      const col = u.overCapacity ? "#ef4444" : pct >= 90 ? "#f59e0b" : "#22c55e";
      const isConstraint = rep.constraint.present && rep.constraint.type === s.type;
      return (
        `<div class="auto-sys${isConstraint ? " constraint" : ""}">` +
        `<div class="auto-sys-head">` +
        `<span class="auto-sys-label">${esc(s.count + "× " + s.label)}</span>` +
        (isConstraint ? '<span class="wms-badge crit">constraint</span>' : "") +
        `<span class="auto-sys-cap">${Math.round(s.throughputUnitsPerHr).toLocaleString("en-US")} u/hr</span>` +
        `</div>` +
        `<div class="wms-bar" title="Utilisation = flow demand ÷ modeled throughput">` +
        `<div class="wms-bar-fill" style="width:${barPct}%;background:${col}"></div>` +
        `<span class="wms-bar-txt">${pct > 999 ? "≫100" : Math.round(pct)}% used${u.overCapacity ? " · OVER CAPACITY" : ""}</span></div>` +
        `<div class="auto-sys-foot">${s.count} × ${Math.round(s.perUnitThroughputUnitsPerHr).toLocaleString("en-US")} ${esc(s.rateLabel)} · serves ${esc(s.serves.join(", ") || "—")} · <span class="auto-kb">KB <code>${esc(s.kbId)}</code></span></div>` +
        `</div>`
      );
    }).join("");

    const tp = rep.throughput;
    const kcards = [
      kcard("Automation throughput", Math.round(tp.totalUnitsPerHr).toLocaleString("en-US"), "units / hr"),
      kcard("Flow demand", dem.toLocaleString("en-US"), "units / hr"),
      kcard("Systems", String(rep.systems.length), "type" + (rep.systems.length === 1 ? "" : "s")),
    ].join("");

    out.innerHTML =
      `<div class="wms-bottleneck-note"><span class="wms-badge crit">constraint</span> ${esc(rep.constraint.plain)}</div>` +
      `<div class="auto-systems">${rows}</div>` +
      `<h3 class="wms-h3">Automation summary <span class="wms-synth">SYNTHETIC · VDI-informed heuristic</span></h3>` +
      `<div class="kpi">${kcards}</div>` +
      `<p class="kpi-note">${esc(rep.summary)}</p>` +
      `<p class="kpi-note">Per-unit cycle rates are editable in the <strong>Knowledge base</strong> panel (<code>auto.*</code>) — changing one moves both these numbers and the WMS stage capacities. ${esc(rep.dataLabel)}</p>`;

    if (state.showAutoUtil) render();
    status(
      `Automation: ${Math.round(tp.totalUnitsPerHr).toLocaleString("en-US")} u/hr modeled handling throughput vs ${dem.toLocaleString("en-US")} u/hr demand` +
      (rep.constraint.present ? `, constraint = ${esc(rep.constraint.label)}` : "") +
      " — VDI-informed heuristic, not measured, not a certification."
    );
  }

  function syncAutoOverlayBtn() {
    const b = $("autoOverlayBtn");
    if (b) { b.classList.toggle("active", state.showAutoUtil); b.setAttribute("aria-pressed", String(state.showAutoUtil)); }
  }

  // Toggle the automation-utilisation canvas overlay. Colours each
  // automation element by its utilisation % (green < 70, amber < 90, red =
  // over capacity), drawn in the SAME world transform (zoom/pan-safe).
  function toggleAutoUtil() {
    if (!state.autoUtilByType) runAutomation(); // populate from a fresh run
    state.showAutoUtil = !state.showAutoUtil;
    syncAutoOverlayBtn();
    render();
    status(state.showAutoUtil
      ? "Automation utilisation overlay on — automation elements shaded by utilisation vs the flow demand (green < 70, amber < 90, red = over capacity). Synthetic VDI-informed heuristic."
      : "Automation utilisation overlay off.");
  }

  const AUTO_OVERLAY_TYPES = { asrs: 1, shuttle: 1, rgv: 1, agv: 1, conveyor: 1 };
  function drawAutomationUtil() {
    const byType = state.autoUtilByType;
    if (!byType) return;
    for (const e of state.elements) {
      if (!AUTO_OVERLAY_TYPES[e.type]) continue;
      const u = byType[e.type];
      if (!u) continue;
      const pct = isFinite(u.utilisationPct) ? u.utilisationPct : 999;
      const col = u.overCapacity ? "#ef4444" : pct >= 90 ? "#f59e0b" : "#22c55e";
      const px = e.x * cellPx, py = e.y * cellPx, pw = e.w * cellPx, ph = e.d * cellPx;
      ctx.save();
      ctx.fillStyle = hexA(col, 0.34);
      ctx.fillRect(px + 2, py + 2, pw - 4, ph - 4);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = hexA(col, 0.95);
      roundRect(px + 2, py + 2, pw - 4, ph - 4, 5);
      ctx.stroke();
      if (pw > 30 && ph > 16) {
        ctx.fillStyle = COLORS.text;
        ctx.font = "700 " + Math.max(9, Math.min(12, cellPx * 0.5)) + "px system-ui, sans-serif";
        ctx.textBaseline = "middle";
        ctx.textAlign = "center";
        ctx.fillText((pct > 999 ? "≫100" : Math.round(pct)) + "%", px + pw / 2, py + ph / 2);
        ctx.textAlign = "left";
      }
      ctx.restore();
    }
  }

  // ================================================================
  // CONFIG CONTROLS
  // ================================================================
  // Shared, tier-aware strategy <select> filler (used by the sim panel
  // and both A/B selects). Locked strategies are visible but disabled
  // with a lock marker — capability flags come from tiers.js.
  function fillStrategySelect(sel) {
    const caps = WT.tiers.caps();
    sel.innerHTML = "";
    Object.values(D.STRATEGIES).forEach((s) => {
      const o = document.createElement("option");
      o.value = s.id;
      const locked = !caps.strategyAllowed(s.id);
      o.textContent = s.label + (locked ? " — locked (full version)" : "");
      o.disabled = locked;
      sel.appendChild(o);
    });
  }

  function buildConfigControls() {
    const sel = $("strategySelect");
    fillStrategySelect(sel);
    sel.value = state.config.strategy;
    updateStrategyDesc();
    sel.addEventListener("change", () => {
      state.config.strategy = sel.value;
      updateStrategyDesc();
      markKPIsStale();
      status("Strategy set to " + ((D.STRATEGIES[sel.value] || {}).label || sel.value) + " — applies on the next Run.");
    });

    const ap = $("aislePreset");
    ap.innerHTML = "";
    D.AISLE.presets.forEach((p) => {
      const o = document.createElement("option");
      o.value = String(p.metres);
      o.textContent = `${p.label} (${p.metres} m)`;
      ap.appendChild(o);
    });
    const custom = document.createElement("option");
    custom.value = "custom";
    custom.textContent = "Custom";
    ap.appendChild(custom);
    ap.value = "2.9";
    ap.addEventListener("change", () => {
      if (ap.value !== "custom") {
        $("aisleInput").value = ap.value;
        state.config.minAisleMetres = Number(ap.value);
        render();
      }
    });

    $("aisleInput").addEventListener("change", () => {
      const v = Number($("aisleInput").value) || D.AISLE.defaultMinMetres;
      state.config.minAisleMetres = v;
      $("aislePreset").value = D.AISLE.presets.some((p) => p.metres === v) ? String(v) : "custom";
      render();
    });

    // Sim inputs: acknowledge every edit in the status line (and mark
    // any displayed KPIs stale) so the user can see the change "took"
    // before the next Run.
    const onSimInput = () => {
      readConfigFromUI();
      markKPIsStale();
      status(
        "Sim settings: seed " + state.config.seed + ", " + state.config.orders + " orders, " +
        state.config.skuCount + " SKUs — applied on the next Run."
      );
    };
    $("seedInput").addEventListener("change", onSimInput);
    $("ordersInput").addEventListener("change", onSimInput);
    $("skuInput").addEventListener("change", onSimInput);

    // Labour-cost inputs: pure display math over the last run, so they
    // can update the two labour KPI cards live (unless the panel is
    // already stale for other reasons — then the stale note stays).
    const onLabourInput = () => {
      readConfigFromUI();
      if (state.lastResult && state.lastResult.ok && !state.resultStale) {
        renderKPIs(state.lastResult);
        status("Labour rate " + state.config.wagePerHour + " EUR/h at " + state.config.weeklyOrders + " orders/wk — labour KPIs updated.");
      } else {
        status("Labour rate " + state.config.wagePerHour + " EUR/h at " + state.config.weeklyOrders + " orders/wk — shows after the next Run.");
      }
    };
    $("wageInput").addEventListener("change", onLabourInput);
    $("weeklyOrdersInput").addEventListener("change", onLabourInput);

    // P3: push vs pull replenishment toggle
    const fm = $("flowModeSelect");
    fm.innerHTML =
      '<option value="pull">Pull — replenish on consumption (reorder point)</option>' +
      '<option value="push">Push — replenish to forecast (periodic top-up)</option>';
    fm.value = state.config.flowMode;
    fm.addEventListener("change", () => {
      state.config.flowMode = fm.value;
      markKPIsStale();
      status("Replenishment set to " + fm.value.toUpperCase() + " — applies on the next Run.");
    });

    // P3: unit-load catalog (pallet + carton/tote selects feed the
    // cartons-per-pallet math shown in properties, KPIs and the table).
    const ps = $("palletSelect");
    ps.innerHTML = "";
    D.PALLETS.forEach((p) => {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = `${p.label} (${p.length}×${p.width} mm)`;
      ps.appendChild(o);
    });
    ps.value = state.config.palletType;
    const bs = $("boxSelect");
    bs.innerHTML = "";
    D.BOXES.forEach((b) => {
      const o = document.createElement("option");
      o.value = b.id;
      o.textContent = `${b.label}${b.tote ? " [tote]" : ""}`;
      bs.appendChild(o);
    });
    bs.value = state.config.boxType;
    const onCatalog = () => {
      state.config.palletType = ps.value;
      state.config.boxType = bs.value;
      renderCatalog();
      renderProps();
      scheduleSave();
    };
    ps.addEventListener("change", onCatalog);
    bs.addEventListener("change", onCatalog);
    renderCatalog();
  }

  // P3: cartons-per-pallet table for the selected pallet type.
  function renderCatalog() {
    const out = $("catalogOut");
    if (!out) return;
    const palId = state.config.palletType;
    const pal = D.palletById(palId);
    let html =
      `<table class="cat-table"><thead><tr><th>Unit load</th><th>L×W×H mm</th><th>/layer</th><th>layers</th><th>/pallet</th></tr></thead><tbody>`;
    for (const b of D.BOXES) {
      const c = D.cartonsPerPallet(b.id, palId);
      const sel = b.id === state.config.boxType ? ' class="cat-sel"' : "";
      html +=
        `<tr${sel}><td>${esc(b.label)}${b.tote ? ' <span class="cat-tote">tote</span>' : ""}</td>` +
        `<td>${b.length}×${b.width}×${b.height}</td>` +
        `<td>${c.perLayer}</td><td>${c.layers}</td><td><strong>${c.perPallet}</strong></td></tr>`;
    }
    html += "</tbody></table>";
    html += `<p class="hint">Simple rectangular fit on the ${esc(pal.label)} (${pal.length}×${pal.width} mm) with a 1.2 m usable load height — no interlocking/overhang patterns. Storage capacity above converts pallet positions → estimated cartons with these figures.</p>`;
    out.innerHTML = html;
  }

  function updateStrategyDesc() {
    $("strategyDesc").textContent = (D.STRATEGIES[state.config.strategy] || {}).desc || "";
  }

  function readConfigFromUI() {
    state.config.seed = Math.max(0, Math.round(Number($("seedInput").value) || 0));
    state.config.orders = Math.max(1, Math.round(Number($("ordersInput").value) || 1));
    state.config.skuCount = Math.max(1, Math.round(Number($("skuInput").value) || 1));
    state.config.strategy = WT.tiers.coerceStrategy($("strategySelect").value);
    state.config.minAisleMetres = Number($("aisleInput").value) || D.AISLE.defaultMinMetres;
    state.config.flowMode = $("flowModeSelect").value === "push" ? "push" : "pull";
    state.config.palletType = $("palletSelect").value;
    state.config.boxType = $("boxSelect").value;
    state.config.wagePerHour = Math.max(0, Number($("wageInput").value) || 0);
    state.config.weeklyOrders = Math.max(1, Math.round(Number($("weeklyOrdersInput").value) || 1));
  }

  function pushConfigToUI() {
    $("seedInput").value = state.config.seed;
    $("ordersInput").value = state.config.orders;
    $("skuInput").value = state.config.skuCount;
    $("strategySelect").value = state.config.strategy;
    $("aisleInput").value = state.config.minAisleMetres;
    $("aislePreset").value = D.AISLE.presets.some((p) => p.metres === state.config.minAisleMetres)
      ? String(state.config.minAisleMetres)
      : "custom";
    $("flowModeSelect").value = state.config.flowMode;
    $("palletSelect").value = state.config.palletType;
    $("boxSelect").value = state.config.boxType;
    $("wageInput").value = state.config.wagePerHour;
    $("weeklyOrdersInput").value = state.config.weeklyOrders;
    renderCatalog();
    updateStrategyDesc();
  }

  // ================================================================
  // PERSISTENCE (localStorage + JSON import/export)
  // ================================================================
  const LS_KEY = "wt.layout.v1";
  let saveTimer = null;

  function serialize() {
    return {
      version: "wt-1",
      gridW: GRID_W,
      gridH: GRID_H,
      cell: CELL_M,
      elements: state.elements.map((e) => ({ id: e.id, type: e.type, x: e.x, y: e.y, w: e.w, d: e.d })),
      config: Object.assign({}, state.config),
      savedAt: new Date().toISOString(),
    };
  }

  function deserialize(obj, source) {
    if (!obj || !Array.isArray(obj.elements)) throw new Error("Invalid layout data");
    // Respect the layout's own warehouse size (may differ from 40 x 24);
    // clamp it into the supported range. Elements are then kept in-bounds
    // against THIS floor below.
    const nf = V.normalizeFloor(numOr(obj.gridW, GRID_W), numOr(obj.gridH, GRID_H));
    GRID_W = nf.gridW;
    GRID_H = nf.gridH;
    const cleaned = [];
    let maxId = 0;
    for (const raw of obj.elements) {
      if (!raw || !ELEMENTS[raw.type]) continue; // drop unknown types
      const def = ELEMENTS[raw.type];
      const el = {
        id: typeof raw.id === "string" ? raw.id : "el-" + Math.random().toString(36).slice(2),
        type: raw.type,
        x: clampInt(raw.x, 0, GRID_W - 1),
        y: clampInt(raw.y, 0, GRID_H - 1),
        w: clampInt(raw.w, 1, GRID_W, def.w),
        d: clampInt(raw.d, 1, GRID_H, def.d),
      };
      // keep in-bounds
      el.x = Math.min(el.x, GRID_W - el.w);
      el.y = Math.min(el.y, GRID_H - el.d);
      cleaned.push(el);
      const n = parseInt(String(el.id).replace(/\D/g, ""), 10);
      if (!isNaN(n)) maxId = Math.max(maxId, n);
    }
    state.elements = cleaned;
    state.idCounter = maxId;
    state.selectedId = null;
    if (obj.config && typeof obj.config === "object") {
      state.config = Object.assign(state.config, {
        seed: numOr(obj.config.seed, state.config.seed),
        // Tier gate: strategies outside the current tier fall back to ABC.
        strategy: WT.tiers.coerceStrategy(D.STRATEGIES[obj.config.strategy] ? obj.config.strategy : state.config.strategy),
        orders: numOr(obj.config.orders, state.config.orders),
        skuCount: numOr(obj.config.skuCount, state.config.skuCount),
        minAisleMetres: numOr(obj.config.minAisleMetres, state.config.minAisleMetres),
        flowMode: obj.config.flowMode === "push" ? "push" : "pull",
        demandSkew: numOr(obj.config.demandSkew, state.config.demandSkew),
        palletType: D.PALLETS.some((p) => p.id === obj.config.palletType) ? obj.config.palletType : state.config.palletType,
        boxType: D.BOXES.some((b) => b.id === obj.config.boxType) ? obj.config.boxType : state.config.boxType,
        wagePerHour: Math.max(0, numOr(obj.config.wagePerHour, state.config.wagePerHour)),
        weeklyOrders: Math.max(1, Math.round(numOr(obj.config.weeklyOrders, state.config.weeklyOrders))),
      });
    }
    pushConfigToUI();
    syncFloorInputs();
    renderProps();
    fitToFloor(); // show the whole (possibly resized) floor
    markKPIsStale(); // any displayed KPIs describe the previous layout
    if (source) status("Loaded layout from " + source + ".");
  }

  function clampInt(v, lo, hi, dflt) {
    let n = Math.round(Number(v));
    if (isNaN(n)) n = dflt !== undefined ? dflt : lo;
    return Math.max(lo, Math.min(hi, n));
  }
  function numOr(v, d) { const n = Number(v); return isNaN(n) ? d : n; }

  function scheduleSave() {
    // Every scheduleSave call site is a layout/config mutation, so the
    // displayed KPIs (if any) stop describing the floor — mark them
    // stale synchronously (config-only changes that skip scheduleSave
    // call markKPIsStale directly in their listeners).
    markKPIsStale();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(LS_KEY, JSON.stringify(serialize())); } catch (_) {}
    }, 350);
  }

  function saveNow() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(serialize()));
      toast("Layout saved to this browser.");
    } catch (_) {
      toast("Could not save (storage blocked).", "err");
    }
  }

  function loadSaved(silent) {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) { if (!silent) toast("No saved layout found.", "warn"); return false; }
      deserialize(JSON.parse(raw), silent ? null : "browser storage");
      return true;
    } catch (_) {
      if (!silent) toast("Saved layout was unreadable.", "err");
      return false;
    }
  }

  function exportJSON() {
    const blob = new Blob([JSON.stringify(serialize(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "warehousetwin-layout.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("Exported warehousetwin-layout.json");
  }

  // ---- W4: IFC export bridge (ifc.js writer) -----------------------
  // The layout leaves as an IFC4 (STEP) coordination model: spatial
  // tree + one IfcBuildingElementProxy solid per element. Generated
  // 100% locally by ifc.js - no library, no network. Full-tier
  // feature; the demo button stays visible with the padlock + hint.
  function exportIFC() {
    const caps = WT.tiers.caps();
    if (!caps.ifcExportAllowed) {
      toast(caps.lockHint("IFC (BIM) export"), "warn");
      return;
    }
    let step;
    try {
      step = WT.ifc.generate(serialize(), {
        name: "warehousetwin-layout",
        projectName: "WarehouseTwin layout",
        timestamp: new Date().toISOString(), // file metadata only; geometry is deterministic
      });
    } catch (err) {
      toast("IFC export failed: " + err.message, "err");
      return;
    }
    const blob = new Blob([step], { type: "application/x-step" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "warehousetwin-layout.ifc";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(
      "Exported warehousetwin-layout.ifc (IFC4, " + state.elements.length +
      " elements as proxy solids). Scoped coordination export - heights are stated assumptions, not full BIM authoring."
    );
    status("IFC export written. Open it in a free viewer (BIMvision, usBIM.viewer, Open IFC Viewer) or any BIM tool.");
  }

  // ================================================================
  // P7: CONSOLIDATED WMS REPORT (report.js -> WT.report)
  // ----------------------------------------------------------------
  // One printable/exportable report that AGGREGATES every layer built
  // so far (layout, compliance, WMS ops, storage, automation, data
  // profile, standards basis) into a single stakeholder artifact. It
  // does NOT recompute the physics - it pulls from the same modules the
  // app uses, so the numbers can never drift. Deterministic given the
  // passed-in timestamp. Offline: the printable HTML is a self-contained
  // blob (inline CSS, no external refs) the user prints to PDF.
  // ================================================================
  function reportOpts() {
    readConfigFromUI();
    const c = state.config;
    const hoursEl = $("wmsHoursInput");
    const ordersEl = $("wmsOrdersInput");
    const opts = {
      timestamp: new Date().toISOString(), // header stamp only; the body is byte-stable for a given stamp
      config: {
        seed: Math.max(0, Math.round(Number(c.seed) || 0)),
        strategy: c.strategy || "abc",
        orders: Math.max(1, Math.round(Number(ordersEl && ordersEl.value) || Number(c.orders) || 300)),
        hours: Math.max(1, Math.round(Number(hoursEl && hoursEl.value) || 8)),
        skuCount: Math.max(1, Math.round(Number(c.skuCount) || 80)),
        demandSkew: Number(c.demandSkew) || 1,
        minAisleMetres: Number(c.minAisleMetres) || D.AISLE.defaultMinMetres,
      },
    };
    // Scenario name/description when an example is selected/loaded.
    if (selectedExampleId && WT.examples) {
      const ex = WT.examples.library.find((e) => e.id === selectedExampleId);
      if (ex) opts.scenario = { id: ex.id, name: ex.name, industry: ex.industry, description: ex.description };
    }
    // Imported data (SKU master + order pool) so the storage + data-profile
    // sections reflect the user's own data, honestly labelled "yours".
    if (WT.wmsdata && WT.wmsdata.isLoaded && WT.wmsdata.isLoaded()) {
      opts.skuMaster = WT.wmsdata.skuMaster;
      opts.orderPool = WT.wmsdata.orderPool;
    }
    return opts;
  }

  function buildCurrentReport() {
    return WT.report.build(currentLayout(), reportOpts());
  }

  function openReportPrintable() {
    if (!WT.report) { toast("WMS Report needs report.js.", "warn"); return; }
    if (!state.elements.length) { toast("Add some elements first, then build the report.", "warn"); return; }
    let html;
    try {
      html = WT.report.toHtml(buildCurrentReport());
    } catch (err) { toast("Report build failed: " + err.message, "err"); return; }
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const w = window.open(url, "_blank");
    if (!w) toast("Pop-up blocked - allow pop-ups to open the printable report, or use Report JSON.", "warn");
    else toast("Opened the printable WMS Report - use your browser's Print -> Save as PDF (offline, nothing uploaded).");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    status("WMS Report built (consolidated, offline). SYNTHETIC unless you imported data - a transparent heuristic informed by ISO/DIN/EN/VDI, not a certification, not measured.");
  }

  function exportReportJson() {
    if (!WT.report) { toast("WMS Report needs report.js.", "warn"); return; }
    if (!state.elements.length) { toast("Add some elements first, then export the report.", "warn"); return; }
    try {
      downloadFile("warehousetwin-wms-report.json", WT.report.toJson(buildCurrentReport()), "application/json");
    } catch (err) { toast("Report export failed: " + err.message, "err"); return; }
    toast("Exported warehousetwin-wms-report.json (consolidated report - deterministic, offline, nothing uploaded).");
  }

  function exportReportCsv() {
    if (!WT.report) { toast("WMS Report needs report.js.", "warn"); return; }
    if (!state.elements.length) { toast("Add some elements first, then export the report.", "warn"); return; }
    try {
      downloadFile("warehousetwin-wms-report.csv", WT.report.toCsv(buildCurrentReport()), "text/csv");
    } catch (err) { toast("Report export failed: " + err.message, "err"); return; }
    toast("Exported warehousetwin-wms-report.csv (section KPI roll-up - Excel-openable, offline).");
  }

  function importJSON(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        deserialize(JSON.parse(String(reader.result)), file.name);
        scheduleSave();
        toast("Imported " + file.name);
      } catch (err) {
        toast("Import failed: " + err.message, "err");
      }
    };
    reader.onerror = () => toast("Could not read the file.", "err");
    reader.readAsText(file);
  }

  // ================================================================
  // v1.1: SAVE / LOAD NAMED SCENARIOS (scenarios.js -> WT.scenarios)
  // ----------------------------------------------------------------
  // The user's OWN saved plants, stored ON THIS DEVICE only (browser
  // localStorage via the guarded WT.scenarios store) - distinct from the
  // read-only synthetic example scenarios. A snapshot is built from the
  // SAME serialize() the JSON export + share link use (its own save
  // timestamp stripped, exactly like buildShareHash, so the stored body is
  // deterministic; the scenario's savedAt is recorded separately). When a
  // real-data bundle is loaded it rides along so the plant comes back with
  // its data. Loading applies the snapshot through the SAME deserialize()
  // loader as JSON import - no bespoke apply path.
  // ================================================================
  function scenarioSnapshot() {
    const snap = serialize();
    delete snap.savedAt; // a scenario carries its own record-level savedAt
    // Optionally capture the imported SKU/order data bundle (when loaded) so
    // the saved plant restores with its own data. Layout-only otherwise.
    if (state.wmsBundle && WT.wmsdata && WT.wmsdata.isLoaded && WT.wmsdata.isLoaded()) {
      snap.wmsBundle = state.wmsBundle;
      snap.wmsMeta = state.datasetMeta || null;
      snap.datasetKind = state.datasetKind || null;
    }
    return snap;
  }

  function refreshScenarioList(selectName) {
    if (!WT.scenarios) return;
    const sel = $("scenarioSelect");
    if (!sel) return;
    const items = WT.scenarios.list();
    sel.innerHTML = "";
    items.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s.name;
      const sm = s.summary || {};
      const bits = [(sm.elements || 0) + " element" + (sm.elements === 1 ? "" : "s")];
      if (sm.floor) bits.push(sm.floor + " m");
      if (sm.hasData) bits.push("+ data");
      opt.textContent = s.name + " — " + bits.join(", ");
      sel.appendChild(opt);
    });
    if (selectName) sel.value = selectName;
    const any = items.length > 0;
    ["scenarioLoadBtn", "scenarioRenameBtn", "scenarioDeleteBtn", "scenarioExportBtn"].forEach((id) => {
      const b = $(id);
      if (b) b.disabled = !any;
    });
    const empty = $("scenarioEmpty");
    if (empty) empty.hidden = any;
    // Keep the A/B compare pickers in sync with saved scenarios (v1.2).
    if (WT.compare && typeof refreshCompareSources === "function") refreshCompareSources();
  }

  function scenarioSaveCurrent() {
    if (!WT.scenarios) { toast("Saved scenarios need scenarios.js.", "warn"); return; }
    const input = $("scenarioName");
    const name = (input && input.value ? input.value : "").trim();
    if (!name) { toast("Type a name for this scenario first.", "warn"); if (input) input.focus(); return; }
    const snap = scenarioSnapshot();
    const existed = WT.scenarios.has(name);
    try {
      WT.scenarios.save(name, snap, { savedAt: new Date().toISOString() });
    } catch (err) { toast("Could not save scenario: " + err.message, "err"); return; }
    // The guarded store no-ops when localStorage is blocked (private mode):
    // detect it honestly rather than claim a save that did not persist.
    if (!WT.scenarios.has(name)) {
      toast("Could not save (browser storage is blocked). Try Export bundle instead.", "err");
      return;
    }
    if (input) input.value = "";
    refreshScenarioList(name);
    toast((existed ? "Updated" : "Saved") + ' scenario "' + name + '" on this device' + (snap.wmsBundle ? " (with your imported data)" : "") + ".");
    status('Saved your scenario "' + name + '" — on this device only, nothing uploaded. Loading it later reuses the same loader as JSON import.');
  }

  function scenarioLoadSelected() {
    if (!WT.scenarios) return;
    const sel = $("scenarioSelect");
    const name = sel ? sel.value : "";
    if (!name) { toast("No scenario selected.", "warn"); return; }
    const snap = WT.scenarios.load(name);
    if (!snap) { toast("That scenario could not be found.", "warn"); refreshScenarioList(); return; }
    try {
      deserialize(snap, 'saved scenario "' + name + '"'); // SAME loader as JSON import
    } catch (err) { toast("Could not load scenario: " + err.message, "err"); return; }
    // Restore the saved data bundle when the scenario carries one; otherwise
    // leave the current data untouched (honest partial restore).
    if (snap.wmsBundle && WT.wmsdata && Array.isArray(snap.wmsBundle.skuMaster) && snap.wmsBundle.skuMaster.length) {
      try { applyWmsBundle(snap.wmsBundle, snap.wmsMeta || null); } catch (_) {}
    }
    scheduleSave();
    toast('Loaded your scenario "' + name + '".' + (snap.wmsBundle ? " Your imported data was restored too." : ""));
  }

  function scenarioRenameSelected() {
    if (!WT.scenarios) return;
    const sel = $("scenarioSelect");
    const oldName = sel ? sel.value : "";
    if (!oldName) return;
    const next = window.prompt("Rename scenario", oldName);
    if (next == null) return;
    const trimmed = next.trim();
    if (!trimmed) { toast("A scenario name can't be empty.", "warn"); return; }
    try {
      if (!WT.scenarios.rename(oldName, trimmed)) { toast("Scenario not found.", "warn"); refreshScenarioList(); return; }
    } catch (err) { toast(err.message, "err"); return; }
    refreshScenarioList(trimmed);
    toast('Renamed to "' + trimmed + '".');
  }

  function scenarioDeleteSelected() {
    if (!WT.scenarios) return;
    const sel = $("scenarioSelect");
    const name = sel ? sel.value : "";
    if (!name) return;
    if (!window.confirm('Delete scenario "' + name + '" from this browser? This cannot be undone.')) return;
    WT.scenarios.remove(name);
    refreshScenarioList();
    toast('Deleted "' + name + '".');
  }

  function scenarioExportBundle() {
    if (!WT.scenarios) return;
    const items = WT.scenarios.list();
    if (!items.length) { toast("No saved scenarios to export yet.", "warn"); return; }
    const json = WT.scenarios.exportBundle(null, { exportedAt: new Date().toISOString() });
    downloadFile("warehousetwin-scenarios.json", json, "application/json");
    toast("Exported " + items.length + " scenario" + (items.length === 1 ? "" : "s") + " (warehousetwin-scenarios.json — offline, nothing uploaded).");
  }

  function scenarioImportBundle(file) {
    if (!WT.scenarios) return;
    readFileText(file)
      .then((text) => {
        const res = WT.scenarios.importBundle(text);
        if (!res.ok) { toast("Import failed: " + (res.error || "not a scenarios bundle") + ".", "err"); return; }
        refreshScenarioList();
        toast("Imported " + res.imported + " scenario" + (res.imported === 1 ? "" : "s") + (res.skipped ? " (" + res.skipped + " skipped)" : "") + " into this browser.");
      })
      .catch(() => toast("Could not read the file.", "err"));
  }

  function wireScenarios() {
    if (!$("scenarioSaveBtn")) return;
    $("scenarioSaveBtn").addEventListener("click", scenarioSaveCurrent);
    $("scenarioName").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); scenarioSaveCurrent(); } });
    $("scenarioLoadBtn").addEventListener("click", scenarioLoadSelected);
    $("scenarioRenameBtn").addEventListener("click", scenarioRenameSelected);
    $("scenarioDeleteBtn").addEventListener("click", scenarioDeleteSelected);
    $("scenarioExportBtn").addEventListener("click", scenarioExportBundle);
    $("scenarioImportBtn").addEventListener("click", () => $("scenarioImportInput").click());
    $("scenarioImportInput").addEventListener("change", (e) => { if (e.target.files[0]) scenarioImportBundle(e.target.files[0]); e.target.value = ""; });
    refreshScenarioList();
  }

  // ================================================================
  // v1.2: SCENARIO A/B COMPARE (compare.js -> WT.compare)
  // ----------------------------------------------------------------
  // Pick TWO set-ups and see their key metrics side-by-side with honest
  // deltas. Every per-side number is DERIVED FROM WT.report.build (the SAME
  // consolidated report the app shows), so the two sides can never drift
  // from the app. Sources resolve through the SAME builders the app uses
  // (currentLayout / WT.examples.build / WT.scenarios.load); metrics are
  // computed on those resolved SNAPSHOTS, never by loading them onto the
  // floor - so the user's current on-screen layout is left untouched.
  // ================================================================
  let compareSourceIndex = {}; // "kind:id" -> source descriptor

  // The current layout as a self-contained snapshot (WITH the live config),
  // so "Current layout" is compared exactly as configured on screen.
  function currentCompareSnapshot() {
    readConfigFromUI();
    return {
      version: "wt-1", gridW: GRID_W, gridH: GRID_H, cell: CELL_M,
      elements: state.elements.map((e) => ({ id: e.id, type: e.type, x: e.x, y: e.y, w: e.w, d: e.d })),
      config: Object.assign({}, state.config),
    };
  }

  function compareCtx() {
    return { current: currentCompareSnapshot(), examples: WT.examples, scenarios: WT.scenarios };
  }

  // Options handed to WT.compare (both sides get the SAME opts, so the
  // comparison is fair): a header stamp (body stays byte-stable), plus the
  // user's imported SKU/order data when loaded so both layouts run against
  // the same demand (honestly labelled "yours"). The timestamp affects only
  // the report header - never the compared metrics - so the table is stable.
  function compareOpts() {
    const opts = { timestamp: new Date().toISOString() };
    if (WT.wmsdata && WT.wmsdata.isLoaded && WT.wmsdata.isLoaded()) {
      opts.skuMaster = WT.wmsdata.skuMaster;
      opts.orderPool = WT.wmsdata.orderPool;
    }
    return opts;
  }

  function populateCompareSelect(sel, srcs, preferKind) {
    if (!sel) return;
    sel.innerHTML = "";
    const groups = {};
    const order = [];
    srcs.forEach((s) => {
      if (!groups[s.group]) { groups[s.group] = []; order.push(s.group); }
      groups[s.group].push(s);
    });
    order.forEach((g) => {
      const og = document.createElement("optgroup");
      og.label = g;
      groups[g].forEach((s) => {
        const opt = document.createElement("option");
        opt.value = s.kind + ":" + s.id;
        let text = s.name;
        if (s.kind === "example" && s.industry) text += " (" + s.industry + ")";
        if (s.kind === "saved" && s.summary && s.summary.floor) text += " — " + s.summary.floor + " m";
        opt.textContent = text;
        if (!s.available) { opt.disabled = true; opt.textContent += " (unavailable)"; }
        og.appendChild(opt);
      });
      sel.appendChild(og);
    });
    if (preferKind) {
      const match = srcs.find((s) => s.kind === preferKind && s.available);
      if (match) sel.value = match.kind + ":" + match.id;
    }
  }

  function refreshCompareSources() {
    if (!WT.compare || !$("compareA")) return;
    const srcs = WT.compare.sources(compareCtx());
    compareSourceIndex = {};
    srcs.forEach((s) => { compareSourceIndex[s.kind + ":" + s.id] = s; });
    const aPrev = $("compareA").value;
    const bPrev = $("compareB").value;
    // Default A = current layout, B = the first example scenario.
    populateCompareSelect($("compareA"), srcs, "current");
    populateCompareSelect($("compareB"), srcs, "example");
    // Preserve a still-valid prior choice.
    if (aPrev && compareSourceIndex[aPrev]) $("compareA").value = aPrev;
    if (bPrev && compareSourceIndex[bPrev]) $("compareB").value = bPrev;
  }

  function runScenarioCompare() {
    if (!WT.compare) { toast("Compare needs compare.js.", "warn"); return; }
    const aKey = $("compareA") ? $("compareA").value : "";
    const bKey = $("compareB") ? $("compareB").value : "";
    const aSrc = compareSourceIndex[aKey];
    const bSrc = compareSourceIndex[bKey];
    if (!aSrc || !bSrc) { toast("Pick a source for both A and B.", "warn"); return; }
    const ctx = compareCtx();
    const aLayout = WT.compare.resolve(aSrc, ctx);
    const bLayout = WT.compare.resolve(bSrc, ctx);
    if (!aLayout || !Array.isArray(aLayout.elements) || !aLayout.elements.length) {
      toast('Side A (' + aSrc.name + ') has no elements to compare.', "warn"); return;
    }
    if (!bLayout || !Array.isArray(bLayout.elements) || !bLayout.elements.length) {
      toast('Side B (' + bSrc.name + ') has no elements to compare.', "warn"); return;
    }
    let result;
    try {
      // Metrics are computed on these resolved snapshots ONLY - the floor
      // is never re-loaded, so the current on-screen layout is untouched.
      result = WT.compare.compare(aLayout, bLayout, compareOpts());
    } catch (err) { toast("Compare failed: " + err.message, "err"); return; }
    renderCompare(result, aSrc, bSrc);
    openCompareModal();
    status("Compared A vs B — both sides derived from the same WMS Report modules (can't drift). SYNTHETIC unless you imported data; better/worse shown only where the direction is unambiguous.");
  }

  function cmpFmt(v, unit) {
    if (v === null || v === undefined || (typeof v === "number" && !isFinite(v))) return '<span class="cmp-na">n/a</span>';
    let n = Number(v);
    const r = Math.round(n * 10) / 10;
    return esc(String(r)) + (unit ? ' <span class="cmp-unit">' + esc(unit) + "</span>" : "");
  }
  function cmpDirArrow(dir) {
    if (dir === "higher") return '<span class="cmp-dir" title="higher is better">↑ better</span>';
    if (dir === "lower") return '<span class="cmp-dir" title="lower is better">↓ better</span>';
    return '<span class="cmp-dir" title="direction is ambiguous — not scored">~ neutral</span>';
  }

  function renderCompare(result, aSrc, bSrc) {
    const body = $("compareBody");
    if (!body) return;
    const a = result.a, b = result.b;
    const secTitle = {};
    result.sections.forEach((s) => { secTitle[s.key] = s.title; });

    let html = "";
    // Which set-up each side is + its data mode.
    html += '<div class="cmp-heads">';
    html += '<div class="cmp-side"><strong>A:</strong> ' + esc(aSrc.name) + ' <span class="cmp-pill">' + esc(a.dataMode || "synthetic") + "</span></div>";
    html += '<div class="cmp-side"><strong>B:</strong> ' + esc(bSrc.name) + ' <span class="cmp-pill">' + esc(b.dataMode || "synthetic") + "</span></div>";
    html += "</div>";

    // Plain-language "what changed".
    html += '<div class="cmp-summary"><h3>' + esc(result.summary.headline) + "</h3>";
    if (result.summary.points.length) {
      html += "<ul>";
      result.summary.points.forEach((p) => { html += "<li>" + esc(p) + "</li>"; });
      html += "</ul>";
    }
    if (result.summary.notes.length) {
      html += '<ul class="cmp-notes">';
      result.summary.notes.forEach((n) => { html += "<li>" + esc(n) + "</li>"; });
      html += "</ul>";
    }
    html += "</div>";

    // The side-by-side table, grouped by section.
    html += '<div class="cmp-scroll"><table class="cmp-table">';
    html += "<thead><tr><th>Metric</th><th>A</th><th>B</th><th>Δ (B−A)</th><th>Δ %</th></tr></thead><tbody>";
    let lastSec = null;
    result.deltas.forEach((d) => {
      if (d.section !== lastSec) {
        html += '<tr class="cmp-sec"><td colspan="5">' + esc(secTitle[d.section] || d.section) + "</td></tr>";
        lastSec = d.section;
      }
      // Delta colouring: green when B is the better side, red when worse,
      // muted when neutral / tied / unavailable. NEVER colour a neutral row.
      let cls = "cmp-neu";
      if (d.better === "b") cls = "cmp-good";
      else if (d.better === "a") cls = "cmp-bad";
      const neutralPill = d.dir === "neutral" ? '<span class="cmp-pill">neutral</span>' : "";
      let absTxt, pctTxt;
      if (!d.available) { absTxt = '<span class="cmp-na">n/a</span>'; pctTxt = '<span class="cmp-na">n/a</span>'; cls = "cmp-na"; }
      else {
        const sign = d.absolute > 0 ? "+" : "";
        absTxt = sign + esc(String(d.absolute));
        pctTxt = d.pct === null ? '<span class="cmp-na">—</span>' : (d.pct > 0 ? "+" : "") + esc(String(d.pct)) + "%";
      }
      html += "<tr>";
      html += '<td class="cmp-metric">' + esc(d.label) + ' <span class="cmp-unit">' + esc(d.unit) + "</span>" + cmpDirArrow(d.dir) + neutralPill + "</td>";
      html += "<td>" + cmpFmt(d.a) + "</td>";
      html += "<td>" + cmpFmt(d.b) + "</td>";
      html += '<td class="cmp-delta ' + cls + '">' + absTxt + "</td>";
      html += '<td class="cmp-delta ' + cls + '">' + pctTxt + "</td>";
      html += "</tr>";
    });
    html += "</tbody></table></div>";

    // Honesty line.
    html += '<p class="cmp-honesty" style="margin-top:10px">' + esc(result.honesty) + "</p>";
    body.innerHTML = html;
  }

  function openCompareModal() { if ($("compareModal")) $("compareModal").hidden = false; }
  function closeCompareModal() { if ($("compareModal")) $("compareModal").hidden = true; }

  function wireCompare() {
    if (!$("compareRunBtn")) return;
    refreshCompareSources();
    $("compareRunBtn").addEventListener("click", runScenarioCompare);
    if ($("compareClose")) $("compareClose").addEventListener("click", closeCompareModal);
    if ($("compareModal")) {
      $("compareModal").addEventListener("click", (e) => { if (e.target === $("compareModal")) closeCompareModal(); });
    }
  }

  // ---- Shareable layout links (the URL fragment IS the data) -------
  // Encoding (share.js): the exact serialize() schema, minus the save
  // timestamp -> JSON -> UTF-8 -> base64url, placed in location.hash
  // as #layout=... Nothing is uploaded: browsers never send the
  // fragment over the network, and this app makes zero network
  // requests anyway. Decoding runs through deserialize() - the SAME
  // validation as JSON import (type whitelist, bounds, tier coercion).
  function buildShareHash() {
    const obj = serialize();
    delete obj.savedAt; // a share link is content, not a save event
    return "#" + WT.share.HASH_KEY + "=" + WT.share.encodeLayout(obj);
  }

  function copyText(text) {
    // navigator.clipboard needs a secure context (it is absent over
    // file://); fall back to the classic hidden-textarea copy.
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => true, () => copyTextFallback(text));
    }
    return Promise.resolve(copyTextFallback(text));
  }

  function copyTextFallback(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
    ta.remove();
    return ok;
  }

  function shareLayout() {
    readConfigFromUI(); // the link carries the settings exactly as shown
    const hash = buildShareHash();
    // Put the fragment into the address bar (keeps ?tour=off etc.).
    try { history.replaceState(null, "", hash); } catch (_) { location.hash = hash; }
    const url = location.href.split("#")[0] + hash;
    // W3 privacy note: imported data + the floor-plan image are NEVER
    // encoded into the link (privacy + URL size) - say so honestly.
    const privateBits = [];
    if (state.dataset) privateBits.push("your imported data");
    if (state.underlay.img) privateBits.push("the floor-plan image");
    const privacyNote = privateBits.length
      ? " NOTE: " + privateBits.join(" and ") + " stay(s) on this device - the link carries the layout + settings only and opens on the synthetic demo dataset."
      : "";
    copyText(url).then((ok) => {
      toast(
        (ok
          ? "Link copied (" + url.length + " chars). The design lives IN the link's #layout= fragment - nothing was uploaded, no server involved."
          : "Could not copy automatically - the link is in the address bar now, copy it from there. (The design lives in the #layout= fragment; nothing is uploaded.)") + privacyNote,
        ok && !privacyNote ? undefined : "warn"
      );
    });
    status("Share link ready - the URL fragment holds the whole design (offline, no upload)." + privacyNote);
  }

  // Boot path: a #layout= fragment loads the design carried in the URL.
  function loadFromShareHash() {
    const payload = WT.share.payloadFromHash(location.hash);
    if (payload === null) return false;
    // Clear the fragment either way so a refresh doesn't re-apply it
    // over later edits (the ?query part - e.g. ?tour=off - stays).
    try { history.replaceState(null, "", location.pathname + location.search); } catch (_) {}
    try {
      deserialize(WT.share.decodeLayout(payload), "share link");
      scheduleSave(); // same behaviour as JSON import
      toast("Layout loaded from link - nothing was uploaded; the design lives in the URL itself.");
      return true;
    } catch (err) {
      // demoLayout()/loadSaved() run right after this returns and raise
      // their own toasts - defer ours so the ERROR is what the user
      // actually sees (the honest failure beats the starter heads-up).
      const msg = "This share link is unreadable (" + err.message + ") - the app started normally instead.";
      setTimeout(() => toast(msg, "err"), 0);
      return false;
    }
  }

  // ================================================================
  // DEMO LAYOUT (first-run starter so the sim works immediately)
  // ================================================================
  function demoLayout() {
    state.idCounter = 0;
    GRID_W = V.FLOOR_DEFAULT_W; // the starter uses the classic 40 x 24 floor
    GRID_H = V.FLOOR_DEFAULT_H;
    const mk = (type, x, y, w, d) => {
      const def = ELEMENTS[type];
      return { id: "el-" + ++state.idCounter, type, x, y, w: w || def.w, d: d || def.d };
    };
    state.elements = [
      mk("dock-in", 4, 0, 2, 1),
      mk("dock-out", 20, 23, 2, 1),
      mk("staging", 18, 20, 4, 2),
      mk("selective-racking", 6, 5, 8, 1),
      mk("selective-racking", 6, 9, 8, 1),
      mk("selective-racking", 24, 5, 8, 1),
      mk("selective-racking", 24, 9, 8, 1),
      mk("block-stack", 6, 14, 6, 4),
      mk("conveyor", 24, 15, 8, 1),
      mk("push-station", 34, 5, 2, 2),
      mk("pull-station", 34, 9, 2, 2),
    ];
    state.selectedId = null;
    state.complianceHighlight = null;
    syncFloorInputs();
    renderProps();
    fitToFloor();
    scheduleSave();
    // The starter ships with its conveyor and stations deliberately
    // unconnected — say so, or the 5 chain warnings read as a bug.
    status(
      "Starter layout loaded. The conveyor and push/pull stations start DISCONNECTED on purpose — " +
      "that is what the 'Flow: 5 chain issues' badge is flagging. Drag them into a chain " +
      "(storage → conveyor → station → outbound dock) to fix it, or just Run the simulation as-is."
    );
    toast("Heads-up: the starter's 5 flow warnings are the exercise, not a bug — hover the Flow badge.", "warn");
  }

  // ================================================================
  // P3: ONE-CLICK PRESETS (domain.js PRESETS)
  // ================================================================
  function loadPreset(presetId) {
    const p = D.PRESETS[presetId];
    if (!p) return;
    state.idCounter = 0;
    const nf = V.normalizeFloor(numOr(p.gridW, V.FLOOR_DEFAULT_W), numOr(p.gridH, V.FLOOR_DEFAULT_H));
    GRID_W = nf.gridW;
    GRID_H = nf.gridH;
    state.elements = p.elements.map((e) => ({
      id: "el-" + ++state.idCounter,
      type: e.type, x: e.x, y: e.y, w: e.w, d: e.d,
    }));
    state.selectedId = null;
    state.preview = null;
    state.complianceHighlight = null;
    if (p.config) {
      state.config = Object.assign(state.config, p.config);
    }
    pushConfigToUI();
    syncFloorInputs();
    renderProps();
    fitToFloor();
    scheduleSave();
    status(`Loaded preset: ${p.label}. Independent + illustrative — not affiliated with or endorsed by any real company. Run the sim!`);
    toast("Preset loaded — see the flow arrows, then Run simulation.");
  }

  // ================================================================
  // AI ENVIRONMENT GENERATOR (generate.js + nlcommands.js)
  // ----------------------------------------------------------------
  // HONEST framing (mirrored in the panel + README): a DETERMINISTIC
  // rule/heuristic engine plus OFFLINE natural-language command parsing.
  // No cloud, no trained black-box model. A generated baseline is a
  // best-practice-informed STARTING POINT, not an engineered or certified
  // plan, and it is checked against the same ASR/DIN guidance as the rest
  // of the app (informed by, NOT a certification). Three modes: Auto (AI
  // builds all), Guided (baseline + typed edits) and Manual-reserve (build
  // but leave the picking sector empty for the user to expand).
  // ================================================================
  const GEN = WT.generate;
  const NL = WT.nl;

  function buildGeneratePanel() {
    if (!GEN || !$("genProfileSelect")) return;
    const sel = $("genProfileSelect");
    sel.innerHTML = "";
    Object.keys(GEN.plantProfiles).forEach((key) => {
      const p = GEN.plantProfiles[key];
      const o = document.createElement("option");
      o.value = key;
      o.textContent = p.label;
      sel.appendChild(o);
    });
    updateGenProfileDesc();
    sel.addEventListener("change", updateGenProfileDesc);
    $("genKeywordInput").addEventListener("input", () => {
      const k = matchGenProfile($("genKeywordInput").value);
      if (k) { sel.value = k; updateGenProfileDesc(); }
    });
    [["genModeAuto", "auto"], ["genModeGuided", "guided"], ["genModeReserve", "reserve"]].forEach(([id, mode]) => {
      $(id).addEventListener("click", () => setGenMode(mode));
    });
    $("genBtn").addEventListener("click", runGenerate);
    $("genCmdBtn").addEventListener("click", runGenCommand);
    $("genCmdInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); runGenCommand(); }
    });
    renderGenLog();
  }

  function updateGenProfileDesc() {
    const key = $("genProfileSelect").value;
    const p = GEN.plantProfiles[key];
    $("genProfileDesc").textContent = p
      ? p.label + " — " + p.keywords.join(", ") + ". Automation: " + p.automation + "."
      : "";
  }

  // Map a free-text keyword to one of the 4 profile keys (contains scan).
  function matchGenProfile(text) {
    const t = String(text || "").toLowerCase();
    if (!t.trim()) return null;
    const table = {
      "ecommerce-fulfilment": ["ecommerce", "e-commerce", "fulfil", "online", "b2c", "parcel"],
      "spare-parts-distribution": ["spare", "aftermarket", "parts", "mro"],
      "automotive-supply": ["auto", "car", "vehicle", "jit", "jis", "oem", "tier"],
      "cold-chain": ["cold", "frozen", "chill", "refriger", "freezer", "temperature"],
    };
    let best = null, len = 0;
    for (const k of Object.keys(table)) {
      for (const s of table[k]) { if (t.indexOf(s) !== -1 && s.length > len) { best = k; len = s.length; } }
    }
    return best;
  }

  function setGenMode(mode) {
    state.genMode = mode;
    [["genModeAuto", "auto"], ["genModeGuided", "guided"], ["genModeReserve", "reserve"]].forEach(([id, m]) => {
      const b = $(id);
      if (!b) return;
      b.classList.toggle("active", m === mode);
      b.setAttribute("aria-pressed", String(m === mode));
    });
  }

  function runGenerate() {
    if (!GEN) return;
    const key = $("genProfileSelect").value;
    const p = GEN.plantProfiles[key];
    if (!p) return;
    const mode = state.genMode;
    const reserve = mode === "reserve" ? ["picking"] : [];
    let gen;
    try {
      gen = GEN.generateLayout(key, {
        gridW: GRID_W, gridH: GRID_H,
        seed: Number.isFinite(Number(state.config.seed)) ? Number(state.config.seed) : undefined,
        reserve: reserve,
      });
    } catch (err) {
      toast("Generate failed: " + err.message, "err");
      return;
    }
    applyGeneratedLayout(gen, "generate");
    const modeLabel = mode === "auto"
      ? "Auto (AI builds all)"
      : mode === "guided" ? "Guided (baseline + your edits)" : "Manual-reserve (picking left empty)";
    logGen("ok", "Generated a " + p.label + " environment — " + modeLabel + ".", gen.meta.summary);
    if (mode === "guided") logGen("info", "Guided mode: refine it with a plain-language command below.", "");
    if (mode === "reserve") logGen("info", "The picking sector is reserved (empty, marked). Try: “include 2 more RGVs in the picking sector”.", "");
    status("Generated a " + p.label + " layout (seed " + gen.meta.seed + "). AI-assisted starting point — checked against ASR/DIN guidance, not certified.");
    toast("Environment generated. It's a best-practice-informed starting point, not a certified plan — steer it with a command or run the sim.");
  }

  // Adopt a generated/steered layout into the live editor state, keeping
  // the zone tags (so later NL commands can target "the picking sector").
  function applyGeneratedLayout(gen, source) {
    state.genLayout = gen;
    state.idCounter = 0;
    // Respect a generated/example layout's own floor size when it carries
    // one (generator already builds against the current floor; examples
    // ship 40 x 24). Clamped into the supported range.
    if (gen.gridW != null && gen.gridH != null) {
      const nf = V.normalizeFloor(gen.gridW, gen.gridH);
      GRID_W = nf.gridW;
      GRID_H = nf.gridH;
    }
    state.elements = gen.elements.map((e) => {
      const n = parseInt(String(e.id).replace(/\D/g, ""), 10);
      if (!isNaN(n)) state.idCounter = Math.max(state.idCounter, n);
      return { id: e.id, type: e.type, x: e.x, y: e.y, w: e.w, d: e.d, zone: e.zone };
    });
    state.selectedId = null;
    state.preview = null;
    state.complianceHighlight = null;
    if (gen.config) {
      state.config = Object.assign(state.config, {
        seed: numOr(gen.config.seed, state.config.seed),
        strategy: WT.tiers.coerceStrategy(D.STRATEGIES[gen.config.strategy] ? gen.config.strategy : state.config.strategy),
        orders: numOr(gen.config.orders, state.config.orders),
        skuCount: numOr(gen.config.skuCount, state.config.skuCount),
        minAisleMetres: numOr(gen.config.minAisleMetres, state.config.minAisleMetres),
        flowMode: gen.config.flowMode === "push" ? "push" : "pull",
        demandSkew: numOr(gen.config.demandSkew, state.config.demandSkew),
      });
    }
    pushConfigToUI();
    syncFloorInputs();
    renderProps();
    fitToFloor(); // frame the whole generated/example floor
    scheduleSave();
    markKPIsStale();
  }

  // Rebuild the command context from the CURRENT floor (so manual edits
  // are reflected), carrying the generator meta (profile/seed/reserved)
  // from the last generate/steer step.
  function currentGenLayout() {
    const meta0 = state.genLayout ? state.genLayout.meta : { reserved: [] };
    const reserved = (meta0.reserved || []).slice();
    const zones = GEN.buildZones(state.elements, GRID_W, GRID_H, reserved);
    return {
      elements: state.elements.map((e) => ({ id: e.id, type: e.type, x: e.x, y: e.y, w: e.w, d: e.d, zone: e.zone })),
      config: Object.assign({}, state.config),
      meta: Object.assign({}, meta0, {
        zones: zones, reserved: reserved, gridW: GRID_W, gridH: GRID_H,
        counts: GEN.countByZone(state.elements),
      }),
      gridW: GRID_W, gridH: GRID_H,
    };
  }

  function runGenCommand() {
    if (!NL) return;
    const inp = $("genCmdInput");
    const text = (inp.value || "").trim();
    if (!text) { toast("Type a command, e.g. “include 2 more RGVs in the picking sector”.", "warn"); return; }
    const res = NL.apply(currentGenLayout(), text);
    if (!res.ok) {
      logGen("warn", "“" + text + "”", res.message);
      status("Command not understood — the action log shows what I can do (I never silently guess).");
      return;
    }
    applyGeneratedLayout(res.layout, "command");
    logGen("ok", res.echo || res.message, res.parseEcho ? "Parsed as: " + res.parseEcho : "");
    inp.value = "";
    status(res.echo || "Command applied.");
  }

  function logGen(kind, echo, detail) {
    state.genLog.push({ kind: kind, echo: echo, detail: detail });
    if (state.genLog.length > 60) state.genLog.shift();
    renderGenLog();
  }

  function renderGenLog() {
    const wrap = $("genLog");
    if (!wrap) return;
    if (!state.genLog.length) {
      wrap.innerHTML = '<p class="empty">Pick a profile and Generate — every AI action is logged here with a plain-language explanation.</p>';
      return;
    }
    wrap.innerHTML = state.genLog
      .slice()
      .reverse()
      .map((e) =>
        '<div class="gen-log-item ' + esc(e.kind) + '">' +
        '<div class="gen-log-head"><span class="gen-log-kind">' +
        esc(e.kind === "ok" ? "applied" : e.kind === "warn" ? "not understood" : "note") +
        '</span><span class="gen-log-echo">' + esc(e.echo) + "</span></div>" +
        (e.detail ? '<div class="gen-log-detail">' + esc(e.detail) + "</div>" : "") +
        "</div>"
      )
      .join("");
  }

  // Reserved-zone overlay (dashed hatch + label) from the last generated
  // layout, so "leave zone X for manual expansion" is visible on the floor.
  function drawGenZones() {
    const gl = state.genLayout;
    if (!gl || !gl.meta || !Array.isArray(gl.meta.zones)) return;
    const reserved = gl.meta.zones.filter((z) => z.reserved);
    if (!reserved.length) return;
    ctx.save();
    for (const z of reserved) {
      const x = z.x * cellPx, y = z.y * cellPx, w = z.w * cellPx, h = z.d * cellPx;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.strokeStyle = hexA(COLORS.io, 0.3);
      ctx.lineWidth = 1;
      for (let i = -h; i < w; i += 11) {
        ctx.beginPath();
        ctx.moveTo(x + i, y);
        ctx.lineTo(x + i + h, y + h);
        ctx.stroke();
      }
      ctx.restore();
      ctx.setLineDash([7, 5]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = COLORS.io;
      ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
      ctx.setLineDash([]);
      ctx.fillStyle = COLORS.io;
      ctx.font = "700 11px system-ui, sans-serif";
      ctx.textBaseline = "top";
      ctx.fillText("RESERVED — " + z.label + " (manual expansion)", x + 6, y + 6);
    }
    ctx.restore();
  }

  // ================================================================
  // EXAMPLE SCENARIOS (examples.js) — a gallery of 20+ preselected,
  // realistic-but-illustrative SYNTHETIC set-ups spanning real industries.
  // Click one to load it onto the floor; export it as a wt-1 JSON layout
  // and an Excel-openable CSV. Fully offline (client-side Blob downloads).
  // Honest by design: every scenario is labelled SYNTHETIC (no real
  // company/brand) and its data profile is a plausible estimate, not
  // measured. Loading reuses applyGeneratedLayout (same path as generate).
  // ================================================================
  const EX = WT.examples;
  let selectedExampleId = null;

  function buildExamplesPanel() {
    if (!EX || !$("exampleList")) return;
    renderExampleList("");
    const search = $("exampleSearch");
    if (search) search.addEventListener("input", () => renderExampleList(search.value));
    $("exampleLoadBtn").addEventListener("click", () => { if (selectedExampleId) loadExample(selectedExampleId); });
    $("exampleExportJsonBtn").addEventListener("click", exportExampleJSON);
    $("exampleExportCsvBtn").addEventListener("click", exportExampleCsv);
  }

  // Top-header quick-pick: a prominent dropdown that loads any library
  // scenario straight from the header. Populated from WT.examples.library
  // at init (never a hardcoded list, so it stays in sync). On change it
  // reuses the SAME code path as the side-panel "Load onto floor" button —
  // selectExample() reflects the pick in the side panel (highlights the
  // list item + enables its Export JSON/CSV buttons) and loadExample()
  // builds and adopts the layout via applyGeneratedLayout. Resets to the
  // placeholder after each load so re-picking the same scenario reloads it.
  function buildExampleQuickPick() {
    const sel = $("exampleQuickPick");
    if (!sel || !EX) return;
    const frag = document.createDocumentFragment();
    EX.library.forEach((ex) => {
      const opt = document.createElement("option");
      opt.value = ex.id;
      opt.textContent = ex.name + " — " + ex.industry;
      frag.appendChild(opt);
    });
    sel.appendChild(frag);
    sel.addEventListener("change", () => {
      const id = sel.value;
      if (!id) return;
      selectExample(id); // reflect in the side panel (highlight + enable exports)
      loadExample(id);   // load onto the floor — same loader as the panel button
      sel.selectedIndex = 0; // back to the placeholder so re-picking reloads
    });
  }

  function renderExampleList(filter) {
    const wrap = $("exampleList");
    if (!wrap) return;
    const q = String(filter || "").trim().toLowerCase();
    const lib = EX.library.filter((ex) => !q || (ex.name + " " + ex.industry).toLowerCase().indexOf(q) !== -1);
    if (!lib.length) {
      wrap.innerHTML = '<p class="empty">No scenario matches &ldquo;' + esc(filter) + '&rdquo;.</p>';
      return;
    }
    wrap.innerHTML = lib.map((ex) =>
      '<button type="button" class="example-item' + (ex.id === selectedExampleId ? " active" : "") +
      '" data-id="' + esc(ex.id) + '" role="option" aria-selected="' + (ex.id === selectedExampleId) + '">' +
      '<span class="example-name">' + esc(ex.name) + "</span>" +
      '<span class="example-industry">' + esc(ex.industry) + "</span>" +
      "</button>"
    ).join("");
    Array.prototype.forEach.call(wrap.querySelectorAll(".example-item"), (btn) => {
      btn.addEventListener("click", () => selectExample(btn.getAttribute("data-id")));
    });
  }

  function selectExample(id) {
    const ex = EX.library.find((e) => e.id === id);
    if (!ex) return;
    selectedExampleId = id;
    Array.prototype.forEach.call($("exampleList").querySelectorAll(".example-item"), (btn) => {
      const on = btn.getAttribute("data-id") === id;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", String(on));
    });
    let b = null;
    try { b = EX.build(id); } catch (_) {}
    const dp = ex.dataProfile;
    const detail = $("exampleDetail");
    detail.hidden = false;
    detail.innerHTML =
      '<p class="example-desc">' + esc(ex.description) + "</p>" +
      '<p class="example-synth"><strong>Synthetic scenario</strong> — no real company/brand; the figures below are plausible estimates, labelled, not measured.</p>' +
      '<dl class="example-data">' +
      exDataRow("SKUs", fmtInt(dp.skuCount)) +
      exDataRow("Daily order lines", fmtInt(dp.dailyOrderLines)) +
      exDataRow("Throughput", fmtInt(dp.throughputPerHour) + " lines/hr") +
      exDataRow("Storage positions", fmtInt(dp.storagePositions)) +
      exDataRow("Docks", String(dp.dockCount)) +
      exDataRow("Staffing (est.)", dp.staffingFte + " FTE") +
      exDataRow("Peak factor", dp.peakFactor + "× avg") +
      exDataRow("Automation", esc(dp.automation)) +
      (b ? exDataRow("Built layout", b.elements.length + " elements · " + b.meta.positions + " positions · compliance " + b.meta.compliance.worst) : "") +
      "</dl>";
    $("exampleLoadBtn").disabled = false;
    $("exampleExportJsonBtn").disabled = false;
    $("exampleExportCsvBtn").disabled = false;
  }
  function exDataRow(k, v) { return "<div><dt>" + esc(k) + "</dt><dd>" + v + "</dd></div>"; }
  function fmtInt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

  function loadExample(id) {
    let b;
    try { b = EX.build(id); } catch (err) { toast("Could not build example: " + err.message, "err"); return; }
    applyGeneratedLayout(b, "example");
    const ex = EX.library.find((e) => e.id === id);
    status("Loaded example: " + (ex ? ex.name : id) + ". Realistic-but-illustrative SYNTHETIC scenario — checked against ASR/DIN guidance, not certified. Run the sim or export the data.");
    toast("Example loaded — a synthetic, illustrative scenario. Export it as JSON/CSV, or run the simulation.");
  }

  // Boot path: a ?scenario=<id> / ?example=<id> deep-link opens that library
  // scenario straight onto the floor (via the SAME loadExample() the panel
  // button + header quick-pick use), so a scenario is shareable/embeddable
  // with a link. The id is validated HERE against WT.examples.library (the
  // parser in deeplink.js stays pure and returns the raw id); a KNOWN id
  // loads and returns true, an UNKNOWN id falls through to the normal boot
  // with a gentle toast so a bad link never breaks the app. Nothing deep-
  // link-specific is persisted (see maybeShowOnboard for the modal).
  function loadScenarioDeepLink(id) {
    if (!id) return false;
    const known = EX && EX.library && EX.library.some((e) => e.id === id);
    if (!known) {
      // demoLayout()/loadSaved() run right after this returns; defer the
      // toast so the heads-up survives their own status/toast messages.
      setTimeout(() => toast('Unknown scenario "' + id + '" in the link — the app started normally instead.', "warn"), 0);
      return false;
    }
    loadExample(id);
    return true;
  }

  function downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportExampleJSON() {
    if (!selectedExampleId) return;
    const data = EX.exportData(selectedExampleId);
    downloadFile("warehousetwin-example-" + selectedExampleId + ".json", JSON.stringify(data, null, 2), "application/json");
    toast("Exported " + selectedExampleId + ".json (wt-1 layout — offline, nothing uploaded).");
  }
  function exportExampleCsv() {
    if (!selectedExampleId) return;
    const csv = EX.exportCsv(selectedExampleId);
    downloadFile("warehousetwin-example-" + selectedExampleId + ".csv", csv, "text/csv");
    toast("Exported " + selectedExampleId + ".csv (elements + KPIs + synthetic data profile).");
  }

  // ================================================================
  // ONBOARDING
  // ================================================================
  const OB_KEY = "wt.onboarded.v1";
  function maybeShowOnboard(skip) {
    // Deep-link (per-URL, NOT a saved preference): a ?scenario= load or an
    // explicit ?onboarding=0 suppresses the welcome modal for THIS load only.
    // It deliberately does NOT flip the OB_KEY "don't show again" flag.
    if (skip) return;
    // Legacy convention kept working: ?tour=off also skips the intro tour
    // (useful for demos/screenshots; reading location.search is offline-safe).
    if (location.search.indexOf("tour=off") !== -1) return;
    if (localStorage.getItem(OB_KEY) === "1") return;
    $("onboard").hidden = false;
  }
  function closeOnboard() {
    if ($("onboardDont").checked) {
      try { localStorage.setItem(OB_KEY, "1"); } catch (_) {}
    }
    $("onboard").hidden = true;
  }

  // ================================================================
  // P8: GUIDED DEMO + ABOUT / WHY THIS
  // ----------------------------------------------------------------
  // The one-click guided demo runs the whole stack end-to-end by calling
  // the SAME functions the manual controls call (loadExample, runWmsOps,
  // flowPlay, the KPI-cockpit repaint, the WMS Report button) - it never
  // re-implements a feature, it only SEQUENCES the declarative plan in
  // WT.demo (demo.js). Interruptible; leaves the app in normal use after.
  // ================================================================
  let demoRunning = false;
  let demoStopFlag = false;
  let demoTimer = null;
  let demoResolvePause = null;

  function demoFocus(id) {
    const el = $(id);
    if (el && typeof el.scrollIntoView === "function") {
      try { el.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (_) { el.scrollIntoView(); }
    }
  }

  // The action map: each name in WT.demo.ACTIONS -> the real app capability
  // (the exact function the manual control already calls). No feature logic
  // is duplicated here.
  function demoActions() {
    return {
      loadExample: (step) => { loadExample(step.exampleId); },
      runWmsOps: () => { demoFocus("wmsCard"); runWmsOps(); },
      playFlow: () => { demoFocus("flowCard"); flowPlay(); },
      showKpis: () => { demoFocus("flowKpiCanvas"); drawFlowKpis(); },
      offerReport: () => { demoFocus("reportOpenBtn"); const b = $("reportOpenBtn"); if (b) b.classList.add("demo-pulse"); },
    };
  }

  // An INTERRUPTIBLE delay: Stop resolves the pending pause immediately so
  // the WT.demo.run loop reaches its next stopped() check and unwinds.
  function demoPause(ms) {
    return new Promise((resolve) => {
      if (demoStopFlag) { resolve(); return; }
      demoResolvePause = resolve;
      demoTimer = setTimeout(() => { demoTimer = null; demoResolvePause = null; resolve(); }, Math.max(0, ms | 0));
    });
  }

  function showDemoHud(on) { const hud = $("demoHud"); if (hud) hud.hidden = !on; }

  function updateDemoHud(step, i, total) {
    const s = $("demoHudStep"), t = $("demoHudTitle"), b = $("demoHudBlurb");
    if (s) s.textContent = (i + 1) + "/" + total;
    if (t) t.textContent = step.title;
    if (b) b.textContent = step.blurb;
    status("Guided demo " + (i + 1) + "/" + total + ": " + step.title + " - " + step.blurb);
  }

  function finishDemo(wasStopped) {
    demoRunning = false;
    demoStopFlag = false;
    if (demoTimer) { clearTimeout(demoTimer); demoTimer = null; }
    demoResolvePause = null;
    showDemoHud(false);
    const rb = $("reportOpenBtn"); if (rb) rb.classList.remove("demo-pulse");
    const gb = $("guidedDemoBtn"); if (gb) gb.classList.remove("active");
    toast(wasStopped
      ? "Guided demo stopped - back to normal editing. Everything shown is a SYNTHETIC scenario (no real company)."
      : "Guided demo complete - open the WMS Report, or keep exploring. Everything shown is SYNTHETIC (no real company).");
    status(wasStopped
      ? "Guided demo stopped. Normal editing resumed."
      : "Guided demo complete. The floor holds a SYNTHETIC example scenario - export it, tweak it, or build the WMS Report.");
  }

  function startGuidedDemo() {
    if (!WT.demo) { toast("Guided demo needs demo.js.", "warn"); return; }
    if (demoRunning) return;
    // Clear any open overlay so the tour is visible.
    if ($("onboard")) $("onboard").hidden = true;
    if ($("about")) $("about").hidden = true;
    demoRunning = true;
    demoStopFlag = false;
    const gb = $("guidedDemoBtn"); if (gb) gb.classList.add("active");
    showDemoHud(true);
    status("Guided demo starting - a one-click end-to-end tour on a SYNTHETIC example scenario.");
    WT.demo.run({
      actions: demoActions(),
      pause: demoPause,
      stopped: () => demoStopFlag,
      onStep: updateDemoHud,
      onDone: () => finishDemo(false),
      onStop: () => finishDemo(true),
    });
  }

  function stopGuidedDemo() {
    if (!demoRunning) return;
    demoStopFlag = true;
    if (demoTimer) { clearTimeout(demoTimer); demoTimer = null; }
    if (demoResolvePause) { const r = demoResolvePause; demoResolvePause = null; r(); }
  }

  // Render the About / why-this panel from WT.demo.ABOUT (single source of
  // truth - the honesty copy is asserted headlessly in verify_demo.js).
  function buildAbout() {
    const body = $("aboutBody");
    if (!body || !WT.demo || !WT.demo.ABOUT) return;
    const A = WT.demo.ABOUT;
    const li = (arr) => (arr || []).map((x) => "<li>" + esc(x) + "</li>").join("");
    const chips = (A.pipeline || []).map((p) => '<span class="about-chip">' + esc(p) + "</span>").join("");
    body.innerHTML =
      '<h2 id="aboutTitle">' + esc(A.title) + "</h2>" +
      '<p class="about-tagline">' + esc(A.tagline) + "</p>" +
      (chips ? '<div class="about-pipeline">' + chips + "</div>" : "") +
      "<h3>What it does</h3><ul class=\"about-list\">" + li(A.what) + "</ul>" +
      "<h3>How it stays honest</h3><ul class=\"about-list about-honesty\">" + li(A.honesty) + "</ul>" +
      "<h3>Who it is for</h3><p class=\"about-for\">" + esc(A.forWho) + "</p>";
  }

  function openAbout() { buildAbout(); if ($("about")) $("about").hidden = false; }
  function closeAbout() { if ($("about")) $("about").hidden = true; }

  // ================================================================
  // TOOLTIPS + TOAST
  // ================================================================
  const tip = $("tooltip");
  function attachTooltip(el, text) {
    el.addEventListener("pointerenter", (e) => {
      tip.textContent = text;
      tip.hidden = false;
      moveTip(e);
    });
    el.addEventListener("pointermove", moveTip);
    el.addEventListener("pointerleave", () => { tip.hidden = true; });
  }
  function moveTip(e) {
    const pad = 14;
    let x = e.clientX + pad, y = e.clientY + pad;
    const r = tip.getBoundingClientRect();
    if (x + r.width > window.innerWidth) x = e.clientX - r.width - pad;
    if (y + r.height > window.innerHeight) y = e.clientY - r.height - pad;
    tip.style.left = x + "px";
    tip.style.top = y + "px";
  }

  let toastTimer = null;
  function toast(msg, kind) {
    const t = $("toast");
    t.textContent = msg;
    t.className = "toast" + (kind ? " " + kind : "");
    t.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    // Reading time scales with length (2.6s floor, 7s cap).
    toastTimer = setTimeout(() => { t.hidden = true; }, Math.max(2600, Math.min(7000, msg.length * 45)));
  }

  function status(msg) {
    $("statusLine").textContent = msg;
  }

  // ================================================================
  // PWA: install prompt + service worker
  // ================================================================
  let deferredPrompt = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const b = $("installBtn");
    b.hidden = false;
    b.className = "btn primary";
    b.title = "Install as an offline app";
  });
  // The install button used to stay hidden unless beforeinstallprompt
  // fired — i.e. it never appeared over file:// or in Firefox/Safari,
  // with no hint why. Now it is always visible: muted until the browser
  // offers install, and clicking it explains honestly what is missing.
  function initInstallButton() {
    if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) return; // already installed
    const b = $("installBtn");
    if (deferredPrompt) return; // beforeinstallprompt already fired
    b.hidden = false;
    b.className = "btn ghost";
    b.title = "Installing needs the app served over http(s) in a Chromium browser — click for details";
  }
  $("installBtn").addEventListener("click", async () => {
    if (!deferredPrompt) {
      if (location.protocol !== "http:" && location.protocol !== "https:") {
        toast("Install needs the app served over http(s), e.g. python -m http.server, in Edge/Chrome. Opened from file:// the browser never offers it.", "warn");
      } else {
        toast("No install prompt from this browser. Edge/Chrome: browser menu → Apps → Install. Firefox/Safari do not offer PWA install.", "warn");
      }
      return;
    }
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    $("installBtn").hidden = true;
  });
  window.addEventListener("appinstalled", () => { $("installBtn").hidden = true; toast("Installed. It now works offline."); });

  function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    if (location.protocol !== "http:" && location.protocol !== "https:") return; // no SW over file://
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  // ================================================================
  // P4: DEMO/FULL TIER GATE UI
  // ----------------------------------------------------------------
  // All capability decisions live in tiers.js (the one gate module);
  // this section only re-renders the affected controls when the tier
  // flips. Honest showcase: the "unlock" is a local switch, documented
  // as the place where a real license/purchase check would go.
  // ================================================================
  function updatePresetLock() {
    const btn = $("presetBtn");
    if (!btn) return;
    const caps = WT.tiers.caps();
    const allowed = caps.presetAllowed("mro-distributor");
    btn.classList.toggle("locked", !allowed);
    btn.setAttribute("aria-disabled", allowed ? "false" : "true");
    btn.innerHTML = (allowed ? "" : WT.tiers.padlockSVG() + " ") + "Preset: Industrial MRO distributor";
  }

  // W4: IFC export button - locked-but-visible in the demo, same
  // pattern as the preset button (padlock + explains itself on click).
  function updateIfcLock() {
    const btn = $("ifcBtn");
    if (!btn) return;
    const allowed = WT.tiers.caps().ifcExportAllowed;
    btn.classList.toggle("locked", !allowed);
    btn.setAttribute("aria-disabled", allowed ? "false" : "true");
    btn.innerHTML = (allowed ? "" : WT.tiers.padlockSVG() + " ") + "Export IFC (BIM)";
  }

  function updateTierUI() {
    const caps = WT.tiers.caps();
    const badge = $("tierBadge");
    const btn = $("tierBtn");
    if (badge) {
      badge.textContent = caps.label + " version";
      badge.className = "badge tier-badge" + (caps.isDemo ? "" : " full");
    }
    if (btn) btn.textContent = caps.isDemo ? "Unlock full version" : "Switch to demo";
  }

  // Re-render everything the tier touches. Called at boot and on flip.
  function applyTier() {
    state.config.strategy = WT.tiers.coerceStrategy(state.config.strategy);
    buildPalette();
    const sel = $("strategySelect");
    fillStrategySelect(sel);
    sel.value = state.config.strategy;
    updateStrategyDesc();
    buildAbControls();
    updatePresetLock();
    updateIfcLock();
    updateTierUI();
    updateW3Locks();
    // Drop an active placement tool that the new tier does not include.
    if (state.activeTool && !WT.tiers.caps().paletteAllowed(state.activeTool)) setTool(null);
  }

  function toggleTier() {
    const next = WT.tiers.current() === "demo" ? "full" : "demo";
    WT.tiers.setTier(next);
    applyTier();
    toast(
      next === "full"
        ? "Full version unlocked — all systems, strategies, the MRO preset and the full advisor. (Local showcase switch; see README.)"
        : "Switched to the demo tier."
    );
    status(next === "full" ? "Full version active." : "Demo tier active — locked items show a padlock.");
  }

  // ================================================================
  // W3 FEATURE 1: BRING YOUR OWN DATA (CSV import, data.js parser)
  // ----------------------------------------------------------------
  // Everything runs in the browser: FileReader -> WT.data parse ->
  // state.dataset -> simConfig() hands it to the sim/advisor/optimizer/
  // A-B unchanged. Row-numbered errors leave the state untouched.
  // Persisted in its OWN localStorage key; never serialized into
  // layouts or share links (privacy + URL size - stated in the UI).
  // ================================================================
  const DATA_KEY = "wt.userdata.v1";
  let pendingArtFile = null;
  let pendingOrdFile = null;

  function dataLocked() {
    if (WT.tiers.caps().dataImportAllowed) return false;
    toast(WT.tiers.caps().lockHint("Importing your own data"), "warn");
    return true;
  }

  function updateDataUI() {
    const badge = $("dataBadge");
    const resetBtn = $("dataResetBtn");
    const skuIn = $("skuInput");
    const ordIn = $("ordersInput");
    if (state.dataset && state.datasetKind === "generated") {
      // Real-data layer, GENERATED: honest SYNTHETIC labelling; the
      // Simulation inputs stay editable because they drive the next
      // Generate (the sim itself replays the generated pool).
      const st = state.dataset.stats;
      badge.textContent =
        "Data: synthetic layer — " + st.skuCount + " SKUs" +
        (state.dataset.orders ? ", " + st.orderCount + " orders" : "");
      badge.className = "badge muted";
      badge.title =
        "The sim runs on a GENERATED, seeded SYNTHETIC SKU master + order pool (the SKU & order data panel). " +
        "Velocity + ABC are a transparent Pareto / 80-20 heuristic, not measured demand. " +
        "Change SKUs / Orders / Seed and press Generate to rebuild it, or Reset to synthetic demo.";
      resetBtn.hidden = true; // the generated layer has its own reset in the SKU & order data panel
      skuIn.disabled = false;
      skuIn.title = "";
      ordIn.disabled = false;
      ordIn.title = "";
    } else if (state.dataset) {
      const st = state.dataset.stats;
      badge.textContent =
        "Data: yours — " + st.skuCount + " SKUs" +
        (state.dataset.orders ? ", " + st.orderCount + " orders" : ", synthetic order stream");
      badge.className = "badge ok";
      badge.title =
        "The simulation runs on YOUR imported data" +
        (state.datasetMeta && state.datasetMeta.fileNames ? " (" + state.datasetMeta.fileNames + ")" : "") + ". " +
        (state.dataset.orders
          ? "Order stream: your " + st.orderCount + " real orders (" + st.lineCount + " lines)."
          : "Order stream: synthetic seeded draws weighted by your real weekly picks - you did not import orders.") +
        " ABC classes: " + (state.dataset.classSource === "csv" ? "taken from your class column." : "recomputed 80/20 from your picks.") +
        " Nothing was uploaded - it all stays in this browser.";
      resetBtn.hidden = !(state.datasetKind === "imported" && !WT.wmsdata.isLoaded());
      skuIn.disabled = true;
      skuIn.title = "SKU count comes from your imported data (" + st.skuCount + " SKUs). Reset to demo data to edit.";
      ordIn.disabled = !!state.dataset.orders;
      ordIn.title = state.dataset.orders
        ? "Order count comes from your imported order data (" + st.orderCount + " orders). Reset to demo data to edit."
        : "How many synthetic orders to draw from your pick frequencies.";
    } else {
      badge.textContent = "Data: synthetic demo";
      badge.className = "badge muted";
      badge.title = "Which dataset the simulation runs on: the seeded synthetic demo catalogue, or your own imported CSVs (Import your data, left panel)";
      resetBtn.hidden = true;
      skuIn.disabled = false;
      skuIn.title = "";
      ordIn.disabled = false;
      ordIn.title = "";
    }
    updateDataFileLine();
  }

  function updateDataFileLine() {
    const line = $("dataFiles");
    if (pendingArtFile || pendingOrdFile) {
      line.textContent =
        "Chosen: " + (pendingArtFile ? pendingArtFile.name : "(no article CSV yet)") +
        (pendingOrdFile ? " + " + pendingOrdFile.name : "") + " — press Import data.";
    } else if (state.dataset && state.datasetMeta) {
      line.textContent = "Imported: " + state.datasetMeta.fileNames + ".";
    } else {
      line.textContent = "No files chosen.";
    }
  }

  function showDataErrors(title, errors) {
    const out = $("dataErrOut");
    const lines = WT.data.formatErrors(errors);
    out.innerHTML =
      "<strong>" + esc(title) + " — nothing was imported, the current data is unchanged:</strong>" +
      "<ul>" + lines.map((l) => "<li>" + esc(l) + "</li>").join("") + "</ul>";
    out.hidden = false;
  }

  function clearDataErrors() {
    const out = $("dataErrOut");
    out.hidden = true;
    out.innerHTML = "";
  }

  function readFileText(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error("could not read " + file.name));
      r.readAsText(file);
    });
  }

  function importUserData() {
    if (dataLocked()) return;
    clearDataErrors();
    if (!pendingArtFile) {
      toast("Choose an article CSV first (sku,description,weekly_picks[,class]).", "warn");
      return;
    }
    const tooBig = [pendingArtFile, pendingOrdFile].filter(
      (f) => f && f.size > WT.data.LIMITS.maxFileBytes
    );
    if (tooBig.length) {
      showDataErrors(
        "File too large",
        tooBig.map((f) => ({ row: 0, msg: f.name + " is " + (f.size / 1048576).toFixed(1) + " MB (cap " + (WT.data.LIMITS.maxFileBytes / 1048576) + " MB per file)" }))
      );
      return;
    }
    const artP = readFileText(pendingArtFile);
    const ordP = pendingOrdFile ? readFileText(pendingOrdFile) : Promise.resolve(null);
    Promise.all([artP, ordP])
      .then(([artText, ordText]) => {
        const art = WT.data.parseArticles(artText);
        if (!art.ok) { showDataErrors("Article CSV (" + pendingArtFile.name + ")", art.errors); return; }
        let orders = null;
        if (ordText !== null) {
          const ord = WT.data.parseOrders(ordText, art.articles);
          if (!ord.ok) { showDataErrors("Order CSV (" + pendingOrdFile.name + ")", ord.errors); return; }
          orders = ord.orders;
        }
        const ds = WT.data.buildDataset(art.articles, orders);
        const names = pendingArtFile.name + (pendingOrdFile ? " + " + pendingOrdFile.name : "");
        state.dataset = ds;
        state.datasetMeta = { fileNames: names, importedAt: new Date().toISOString() };
        state.datasetKind = "imported";
        // This legacy importer owns state.dataset directly; clear the
        // wmsdata layer so the two producers never show stale data.
        state.wmsBundle = null;
        if (WT.wmsdata) WT.wmsdata.clear();
        pendingArtFile = null;
        pendingOrdFile = null;
        saveDataset();
        updateDataUI();
        renderWmsData();
        markKPIsStale();
        const clsTxt = ds.classSource === "csv" ? "classes from your class column" : "ABC classes recomputed 80/20 from your picks";
        toast("Imported " + names + " — " + ds.stats.skuCount + " SKUs" +
          (ds.orders ? ", " + ds.stats.orderCount + " orders" : "") + ". Nothing left this device.");
        status(
          "Your data is active: " + ds.stats.skuCount + " SKUs (" + clsTxt + "), " +
          (ds.orders
            ? "sim replays your " + ds.stats.orderCount + " orders"
            : "order stream stays synthetic, weighted by your real pick frequencies") +
          ". Run the simulation."
        );
      })
      .catch((err) => toast("Import failed: " + err.message, "err"));
  }

  function resetDataset() {
    if (!state.dataset && !state.wmsBundle) return;
    state.dataset = null;
    state.datasetMeta = null;
    state.wmsBundle = null;
    state.datasetKind = null;
    if (WT.wmsdata) WT.wmsdata.clear();
    storageClear(); // the SKU master went away — drop any slotting
    pendingArtFile = null;
    pendingOrdFile = null;
    try { localStorage.removeItem(DATA_KEY); } catch (_) {}
    clearDataErrors();
    clearWmsDataErrors();
    updateDataUI();
    renderWmsData();
    markKPIsStale();
    toast("Back to the seeded synthetic demo dataset.");
    status("Reset to demo data — the sim runs on the synthetic catalogue again.");
  }

  function saveDataset() {
    try {
      // Prefer persisting the compact wmsdata BUNDLE (the generated/imported
      // SKU master + order pool) so the layer survives a reload; the legacy
      // importer persists its dataset directly. Whichever is active wins.
      const payload = state.wmsBundle
        ? { wmsBundle: state.wmsBundle, meta: state.datasetMeta, kind: state.datasetKind }
        : { dataset: state.dataset, meta: state.datasetMeta, kind: state.datasetKind };
      localStorage.setItem(DATA_KEY, JSON.stringify(payload));
    } catch (_) {
      toast("Could not persist the data layer (storage full/blocked) — it stays for this session only.", "warn");
    }
  }

  function loadDataset() {
    try {
      const raw = localStorage.getItem(DATA_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw);
      if (obj && obj.wmsBundle && Array.isArray(obj.wmsBundle.skuMaster) && obj.wmsBundle.skuMaster.length && WT.wmsdata) {
        // Real-data layer: restore the bundle into wmsdata + derive the
        // sim dataset via the same seam the panel uses.
        WT.wmsdata.load(obj.wmsBundle);
        state.wmsBundle = obj.wmsBundle;
        state.dataset = WT.wmsdata.toDataset(obj.wmsBundle);
        state.datasetMeta = obj.meta || null;
        state.datasetKind = obj.kind || (obj.wmsBundle.source === "synthetic" ? "generated" : "imported");
      } else if (obj && obj.dataset && Array.isArray(obj.dataset.skus) && obj.dataset.skus.length) {
        state.dataset = obj.dataset;
        state.datasetMeta = obj.meta || null;
        state.datasetKind = obj.kind || "imported";
      }
    } catch (_) { /* unreadable -> stay synthetic */ }
  }

  function wireDataPanel() {
    $("artCsvBtn").addEventListener("click", () => { if (!dataLocked()) $("artCsvInput").click(); });
    $("ordCsvBtn").addEventListener("click", () => { if (!dataLocked()) $("ordCsvInput").click(); });
    $("artCsvInput").addEventListener("change", (e) => {
      if (e.target.files[0]) { pendingArtFile = e.target.files[0]; clearDataErrors(); updateDataFileLine(); }
      e.target.value = "";
    });
    $("ordCsvInput").addEventListener("change", (e) => {
      if (e.target.files[0]) { pendingOrdFile = e.target.files[0]; clearDataErrors(); updateDataFileLine(); }
      e.target.value = "";
    });
    $("dataImportBtn").addEventListener("click", importUserData);
    $("dataResetBtn").addEventListener("click", resetDataset);
  }

  // ================================================================
  // REAL-DATA LAYER: SKU master + order pool (wmsdata.js / WT.wmsdata)
  // ----------------------------------------------------------------
  // A first-class, PURE, deterministic data model the sim + WMS ops
  // consume. Generate a seeded SYNTHETIC catalogue, or import your own /
  // a Siemens-exported CSV, and export both. Everything flows through
  // state.dataset (the seam simulation.js already reads), so the sim
  // needs no change; with nothing loaded, every consumer is byte-
  // identical to before (the synthetic default from state.config).
  // ================================================================
  let pendingSkuCsv = null;
  let pendingOrdCsvW = null; // (distinct from the legacy importer's pendingOrdFile)

  function showWmsDataErrors(title, errors) {
    const out = $("wmsDataErr");
    if (!out) return;
    const lines = (WT.wmsdata && WT.wmsdata.formatErrors) ? WT.wmsdata.formatErrors(errors) : errors.map((e) => "row " + e.row + ": " + e.msg);
    out.innerHTML =
      "<strong>" + esc(title) + " — nothing was imported, the current data is unchanged:</strong>" +
      "<ul>" + lines.map((l) => "<li>" + esc(l) + "</li>").join("") + "</ul>";
    out.hidden = false;
  }
  function clearWmsDataErrors() {
    const out = $("wmsDataErr");
    if (!out) return;
    out.hidden = true;
    out.innerHTML = "";
  }

  // Load a bundle { skuMaster, orderPool, source, classSource, orderSource }
  // as the active data layer: wmsdata store + state.dataset (via toDataset)
  // + honest labels, then persist and refresh every consumer.
  function applyWmsBundle(bundle, meta) {
    WT.wmsdata.load(bundle);
    state.wmsBundle = bundle;
    state.dataset = WT.wmsdata.toDataset(bundle);
    state.datasetMeta = meta || null;
    state.datasetKind = (bundle.source === "synthetic" && bundle.orderSource !== "imported") ? "generated" : "imported";
    clearWmsDataErrors();
    saveDataset();
    // The SKU master changed — invalidate any physical slotting so the panel
    // + the flowsim retrieval leg never show a stale assignment.
    storageClear();
    updateDataUI();
    renderWmsData();
    markKPIsStale();
  }

  function wmsDataGenerate() {
    if (!WT.wmsdata) { toast("The data layer needs wmsdata.js.", "warn"); return; }
    readConfigFromUI();
    const skew = Math.max(0.4, Math.min(2, Number($("wmsDataSkew").value) || 1));
    const maxLines = Math.max(1, Math.min(32, Math.round(Number($("wmsDataMaxLines").value) || 6)));
    state.config.demandSkew = skew; // keep the sim/config coherent with the generated data
    const nSku = Math.max(1, Math.round(Number(state.config.skuCount) || 80));
    const nOrders = Math.max(1, Math.round(Number(state.config.orders) || 300));
    const seed = Math.max(0, Math.round(Number(state.config.seed) || 0));
    const bundle = WT.wmsdata.generate({ skuCount: nSku, orders: nOrders, seed: seed, demandSkew: skew, maxLines: maxLines });
    bundle.orderSource = "generated";
    applyWmsBundle(bundle, { fileNames: "generated (synthetic)", importedAt: new Date().toISOString() });
    const st = state.dataset.stats;
    toast("Generated a SYNTHETIC data layer — " + st.skuCount + " SKUs, " + st.orderCount + " orders (seed " + seed + ").");
    status("SYNTHETIC SKU master + order pool active: " + st.skuCount + " SKUs (Pareto/80-20 velocity heuristic), " +
      st.orderCount + " seeded orders. The sim + WMS ops now run on it. Reset to synthetic demo to go back.");
  }

  function readCsvFile(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error("could not read " + file.name));
      r.readAsText(file);
    });
  }

  function wmsImportSkus() {
    if (dataLocked()) return; // full-tier: importing your own data
    if (!pendingSkuCsv) { toast("Choose a SKU CSV first (sku,description,abc_class,velocity,weight_kg,storage_type — aliases ok).", "warn"); return; }
    if (pendingSkuCsv.size > (WT.data ? WT.data.LIMITS.maxFileBytes : 2 * 1024 * 1024)) {
      showWmsDataErrors("File too large", [{ row: 0, msg: pendingSkuCsv.name + " exceeds the 2 MB per-file cap" }]);
      return;
    }
    const name = pendingSkuCsv.name;
    readCsvFile(pendingSkuCsv)
      .then((text) => {
        const res = WT.wmsdata.importSkusCsv(text);
        if (!res.ok) { showWmsDataErrors("SKU CSV (" + name + ")", res.errors); return; }
        pendingSkuCsv = null;
        const bundle = { skuMaster: res.skus, orderPool: [], source: "imported", classSource: res.classSource, orderSource: null };
        applyWmsBundle(bundle, { fileNames: name, importedAt: new Date().toISOString() });
        toast("Imported " + res.skus.length + " SKUs from " + name + " — stays on this device.");
        status("Your SKU master is active: " + res.skus.length + " SKUs (" +
          (res.classSource === "csv" ? "ABC from your class column" : "ABC computed 80/20 from velocity") +
          "). Import an order CSV to replay real orders, or run — the order stream is synthetic, weighted by your velocities.");
      })
      .catch((e) => toast("Import failed: " + e.message, "err"));
  }

  function wmsImportOrders() {
    if (dataLocked()) return;
    if (!WT.wmsdata.isLoaded()) { toast("Generate or import a SKU master first — orders must reference existing SKUs.", "warn"); return; }
    if (!pendingOrdCsvW) { toast("Choose an order CSV first (order_id,sku,qty).", "warn"); return; }
    if (pendingOrdCsvW.size > (WT.data ? WT.data.LIMITS.maxFileBytes : 2 * 1024 * 1024)) {
      showWmsDataErrors("File too large", [{ row: 0, msg: pendingOrdCsvW.name + " exceeds the 2 MB per-file cap" }]);
      return;
    }
    const name = pendingOrdCsvW.name;
    readCsvFile(pendingOrdCsvW)
      .then((text) => {
        const res = WT.wmsdata.importOrdersCsv(text, WT.wmsdata.skuMaster);
        if (!res.ok) { showWmsDataErrors("Order CSV (" + name + ")", res.errors); return; }
        pendingOrdCsvW = null;
        const prev = state.wmsBundle || { source: "imported", classSource: "computed" };
        const bundle = { skuMaster: WT.wmsdata.skuMaster.slice(), orderPool: res.orders, source: prev.source, classSource: prev.classSource, orderSource: "imported" };
        applyWmsBundle(bundle, { fileNames: (state.datasetMeta && state.datasetMeta.fileNames ? state.datasetMeta.fileNames + " + " : "") + name, importedAt: new Date().toISOString() });
        const st = state.dataset.stats;
        toast("Imported " + st.orderCount + " orders (" + st.lineCount + " lines) from " + name + ".");
        status("Your order pool is active: the sim replays your " + st.orderCount + " orders over " + st.skuCount + " SKUs. Nothing left this device.");
      })
      .catch((e) => toast("Import failed: " + e.message, "err"));
  }

  function wmsExportSkus() {
    if (!WT.wmsdata || !WT.wmsdata.isLoaded()) { toast("Generate or import a SKU master first, then export it.", "warn"); return; }
    downloadFile("warehousetwin-skus.csv", WT.wmsdata.exportSkusCsv(), "text/csv");
    toast("Exported the SKU master as CSV (offline — nothing uploaded).");
  }
  function wmsExportOrders() {
    if (!WT.wmsdata || !WT.wmsdata.orderPool.length) { toast("Generate or import an order pool first, then export it.", "warn"); return; }
    downloadFile("warehousetwin-orders.csv", WT.wmsdata.exportOrdersCsv(), "text/csv");
    toast("Exported the order pool as CSV (offline — nothing uploaded).");
  }

  // Render stats() + a small SAMPLE (first N rows only — never the whole
  // catalogue, so this stays instant even at tens of thousands of SKUs).
  function renderWmsData() {
    const box = $("wmsDataStats");
    if (!box || !WT.wmsdata) return;
    const loaded = WT.wmsdata.isLoaded();
    const resetBtn = $("wmsDataResetBtn");
    const impOrd = $("wmsImportOrdBtn");
    const expSku = $("wmsExportSkuBtn");
    const expOrd = $("wmsExportOrdBtn");
    if (resetBtn) resetBtn.hidden = !loaded;
    if (impOrd) impOrd.disabled = !loaded;
    if (expSku) expSku.disabled = !loaded;
    if (expOrd) expOrd.disabled = !(loaded && WT.wmsdata.orderPool.length);

    if (!loaded) {
      if (state.dataset) {
        // The legacy "Import your data" panel owns the active dataset.
        box.innerHTML =
          '<p class="wmsdata-src yours">A dataset is active via <strong>Import your data</strong> (' +
          esc(String(state.dataset.stats.skuCount)) + " SKUs). This panel manages the generate + CSV data layer; " +
          "use it to build a synthetic catalogue or import a SKU/order CSV.</p>";
      } else {
        box.innerHTML = '<p class="empty">No data layer loaded — the sim uses the seeded synthetic default. Generate or import to see stats + a sample (first ' + WT.wmsdata.PARAMS.sampleRows + " rows only, for performance).</p>";
      }
      return;
    }

    const st = WT.wmsdata.stats();
    const b = state.wmsBundle || {};
    const skuSyn = b.source === "synthetic";
    const orderSrc = b.orderSource; // "generated" | "imported" | null
    const srcClass = skuSyn && orderSrc !== "imported" ? "synthetic" : "yours";
    const skuLine = skuSyn
      ? "<strong>SKUs: SYNTHETIC</strong> (generated, seeded — velocity + ABC from a transparent Pareto/80-20 heuristic, <em>not measured</em>)"
      : "<strong>SKUs: yours</strong> (imported CSV, on this device — nothing uploaded)";
    const ordLine = orderSrc === "imported"
      ? "<strong>Orders: yours</strong> (imported CSV — the sim replays them exactly)"
      : orderSrc === "generated"
      ? "<strong>Orders: SYNTHETIC</strong> (seeded, SKUs drawn weighted by velocity — mirrors Siemens generateOrders)"
      : "<strong>Orders: none</strong> (the sim draws a synthetic stream from the SKU velocities)";

    const kpi = (lbl, val) => '<div class="k"><span class="lbl">' + esc(lbl) + '</span><span class="val">' + esc(val) + "</span></div>";
    const fmt = (n) => Number(n).toLocaleString("en-US");
    const kpis =
      '<div class="wmsdata-kpis">' +
      kpi("SKUs", fmt(st.skuCount)) +
      kpi("Orders", st.orderCount ? fmt(st.orderCount) : "—") +
      kpi("Order lines", st.lineCount ? fmt(st.lineCount) : "—") +
      kpi("Avg lines/order", st.orderCount ? st.avgLinesPerOrder.toFixed(2) : "—") +
      "</div>";

    const abcRow = (k) => {
      const c = st.abc[k];
      return "<tr><td>" + k + "</td><td>" + fmt(c.skus) + " (" + c.skuPct.toFixed(1) + "%)</td><td>" + c.demandPct.toFixed(1) + "%</td></tr>";
    };
    const abcTable =
      '<p class="wmsdata-cap">ABC split — a small share of SKUs carries most of the demand (Pareto):</p>' +
      '<table class="cat-table"><thead><tr><th>Class</th><th>SKUs (share)</th><th>Demand share</th></tr></thead><tbody>' +
      abcRow("A") + abcRow("B") + abcRow("C") + "</tbody></table>";

    const N = WT.wmsdata.PARAMS.sampleRows;
    const sample = WT.wmsdata.skuMaster.slice(0, N);
    const sampleRows = sample
      .map((s) => "<tr><td>" + esc(s.sku) + "</td><td>" + esc(s.abcClass) + "</td><td>" + fmt(s.velocity) + "</td><td>" + esc(String(s.weightKg)) + "</td><td>" + esc(s.storageType) + "</td></tr>")
      .join("");
    const sampleTable =
      '<p class="wmsdata-cap">Sample — first ' + Math.min(N, st.skuCount) + " of " + fmt(st.skuCount) + " SKUs (the rest are not rendered, for performance):</p>" +
      '<table class="cat-table sample"><thead><tr><th>SKU</th><th>ABC</th><th>Velocity</th><th>kg</th><th>Storage</th></tr></thead><tbody>' +
      sampleRows + "</tbody></table>";

    box.innerHTML =
      '<div class="wmsdata-src ' + srcClass + '">' + skuLine + ". " + ordLine + ".</div>" +
      kpis + abcTable + sampleTable;
  }

  function wireWmsDataPanel() {
    if (!$("wmsDataGenBtn")) return;
    $("wmsDataGenBtn").addEventListener("click", wmsDataGenerate);
    $("wmsImportSkuBtn").addEventListener("click", () => { if (!dataLocked()) $("wmsSkuCsvInput").click(); });
    $("wmsImportOrdBtn").addEventListener("click", () => {
      if (!WT.wmsdata.isLoaded()) { toast("Generate or import a SKU master first — orders must reference existing SKUs.", "warn"); return; }
      if (!dataLocked()) $("wmsOrdCsvInput").click();
    });
    $("wmsSkuCsvInput").addEventListener("change", (e) => {
      if (e.target.files[0]) { pendingSkuCsv = e.target.files[0]; clearWmsDataErrors(); wmsImportSkus(); }
      e.target.value = "";
    });
    $("wmsOrdCsvInput").addEventListener("change", (e) => {
      if (e.target.files[0]) { pendingOrdCsvW = e.target.files[0]; clearWmsDataErrors(); wmsImportOrders(); }
      e.target.value = "";
    });
    $("wmsExportSkuBtn").addEventListener("click", wmsExportSkus);
    $("wmsExportOrdBtn").addEventListener("click", wmsExportOrders);
    $("wmsDataResetBtn").addEventListener("click", resetDataset);
    // Keep the generated data coherent with the Simulation panel's skew.
    const skewIn = $("wmsDataSkew");
    if (skewIn) skewIn.value = state.config.demandSkew;
    // Gate the import buttons visually in the demo tier (padlock), like
    // the legacy data panel; Generate + Export stay available.
    const caps = WT.tiers.caps();
    if (!caps.dataImportAllowed) {
      const lk = $("wmsDataLock");
      if (lk) lk.innerHTML = WT.tiers.padlockSVG();
    }
  }

  // ================================================================
  // W3 FEATURE 2: FLOOR-PLAN IMAGE UNDERLAY (trace the real hall)
  // ----------------------------------------------------------------
  // FileReader -> dataURL -> Image drawn UNDER the grid (drawUnderlay).
  // Two-point calibration sets metres-per-pixel; Align mode drags the
  // image; opacity slider + hide toggle. Persisted in its own
  // localStorage key up to a size cap (bigger images stay session-only
  // with a warning). Never part of a share link.
  // ================================================================
  const UL_KEY = "wt.underlay.v1";
  const UL_FILE_MAX_BYTES = 4 * 1024 * 1024; // refuse files above 4 MB
  const UL_PERSIST_MAX_CHARS = 2500000; // ~1.9 MB binary as dataURL - localStorage cap

  function underlayLocked() {
    if (WT.tiers.caps().underlayAllowed) return false;
    toast(WT.tiers.caps().lockHint("The floor-plan underlay"), "warn");
    return true;
  }

  function setUnderlayImage(dataUrl, fileName) {
    const img = new Image();
    img.onload = () => {
      const u = state.underlay;
      u.img = img;
      u.dataUrl = dataUrl;
      u.visible = true;
      u.offMx = 0;
      u.offMy = 0;
      // Default scale: fit the image across the full floor width.
      u.mPerPx = (GRID_W * CELL_M) / Math.max(1, img.naturalWidth);
      state.underlayMode = null;
      state.calibPts = [];
      saveUnderlay();
      updateUnderlayUI();
      render();
      toast("Floor plan loaded" + (fileName ? " (" + fileName + ")" : "") + " — stays on this device. Calibrate the scale, then trace your racks over it.");
      status("Underlay: use Calibrate (click two points a known distance apart), Align to drag it, and the opacity slider. Then place elements over the plan as usual.");
    };
    img.onerror = () => toast("That file could not be decoded as an image.", "err");
    img.src = dataUrl;
  }

  function loadUnderlayFile(file) {
    if (file.size > UL_FILE_MAX_BYTES) {
      toast("Image too large: " + (file.size / 1048576).toFixed(1) + " MB (cap " + (UL_FILE_MAX_BYTES / 1048576) + " MB). Downscale/compress the plan first.", "err");
      return;
    }
    const r = new FileReader();
    r.onload = () => setUnderlayImage(String(r.result), file.name);
    r.onerror = () => toast("Could not read the image file.", "err");
    r.readAsDataURL(file);
  }

  function underlayCalibClick(mx, my) {
    const u = state.underlay;
    state.calibPts.push({ ix: (mx - u.offMx) / u.mPerPx, iy: (my - u.offMy) / u.mPerPx });
    if (state.calibPts.length < 2) {
      render();
      status("Calibrate: first point set — now click the second point (a known real distance from the first).");
      return;
    }
    const [p1, p2] = state.calibPts;
    const pxDist = Math.hypot(p2.ix - p1.ix, p2.iy - p1.iy);
    const metres = Number($("underlayDist").value);
    if (!(pxDist > 2)) {
      state.calibPts = [];
      render();
      toast("Calibration points are on top of each other — click two points further apart.", "warn");
      return;
    }
    if (!(metres > 0)) {
      state.calibPts = [];
      render();
      toast("Enter the real distance (m) between the two points first, then calibrate again.", "warn");
      return;
    }
    // Keep the FIRST clicked point fixed on the floor while rescaling
    // so the image does not jump away under the user's pointer.
    const anchorMx = u.offMx + p1.ix * u.mPerPx;
    const anchorMy = u.offMy + p1.iy * u.mPerPx;
    u.mPerPx = metres / pxDist;
    u.offMx = anchorMx - p1.ix * u.mPerPx;
    u.offMy = anchorMy - p1.iy * u.mPerPx;
    state.calibPts = [];
    state.underlayMode = null;
    saveUnderlay();
    updateUnderlayUI();
    render();
    const wM = (u.img.naturalWidth * u.mPerPx).toFixed(1);
    const hM = (u.img.naturalHeight * u.mPerPx).toFixed(1);
    toast("Scale calibrated: the plan now measures " + wM + " × " + hM + " m on the 1 m grid.");
    status("Underlay calibrated (" + (1 / u.mPerPx).toFixed(1) + " px/m). Use Align to fine-position it, then trace your racks.");
  }

  function setUnderlayMode(mode) {
    if (state.underlayMode === mode) mode = null; // toggle off
    state.underlayMode = mode;
    state.calibPts = [];
    if (mode) setTool(null); // placement and underlay modes are exclusive
    updateUnderlayUI();
    render();
    if (mode === "align") status("Align: drag the canvas to move the floor plan under the grid. Click Align again to finish.");
    else if (mode === "calibrate") status("Calibrate: click TWO points on the image that are a known real distance apart (set the distance in the panel).");
  }

  function removeUnderlay() {
    const u = state.underlay;
    u.img = null;
    u.dataUrl = null;
    u.persisted = false;
    state.underlayMode = null;
    state.calibPts = [];
    try { localStorage.removeItem(UL_KEY); } catch (_) {}
    updateUnderlayUI();
    render();
    status("Floor plan removed.");
  }

  function updateUnderlayUI() {
    const u = state.underlay;
    const hint = $("underlayHint");
    const tog = $("underlayToggleBtn");
    tog.textContent = u.visible ? "Hide" : "Show";
    tog.setAttribute("aria-pressed", String(u.visible));
    $("underlayMoveBtn").classList.toggle("active", state.underlayMode === "align");
    $("underlayMoveBtn").setAttribute("aria-pressed", String(state.underlayMode === "align"));
    $("underlayCalibBtn").classList.toggle("active", state.underlayMode === "calibrate");
    $("underlayOpacity").value = String(Math.round(u.opacity * 100));
    if (!u.img) {
      hint.textContent = "No floor plan loaded.";
      return;
    }
    const wM = (u.img.naturalWidth * u.mPerPx).toFixed(1);
    const hM = (u.img.naturalHeight * u.mPerPx).toFixed(1);
    hint.textContent =
      "Plan: " + u.img.naturalWidth + "×" + u.img.naturalHeight + " px → " + wM + " × " + hM + " m at the current scale. " +
      (u.persisted
        ? "Kept in this browser (not in share links)."
        : "Too large to keep in browser storage — it lives for THIS session only (reloading loses it).");
  }

  function saveUnderlay() {
    const u = state.underlay;
    if (!u.dataUrl) { u.persisted = false; return; }
    if (u.dataUrl.length > UL_PERSIST_MAX_CHARS) {
      if (u.persisted !== false || !u._warned) {
        toast("The plan image is bigger than the storage cap (~1.9 MB) — it will NOT survive a reload. Downscale it to keep it.", "warn");
        u._warned = true;
      }
      u.persisted = false;
      try { localStorage.removeItem(UL_KEY); } catch (_) {}
      return;
    }
    try {
      localStorage.setItem(UL_KEY, JSON.stringify({
        dataUrl: u.dataUrl, opacity: u.opacity, visible: u.visible,
        offMx: u.offMx, offMy: u.offMy, mPerPx: u.mPerPx,
      }));
      u.persisted = true;
    } catch (_) {
      u.persisted = false;
      toast("Could not persist the plan image (storage full) — it stays for this session only.", "warn");
    }
  }

  function loadUnderlay() {
    try {
      const raw = localStorage.getItem(UL_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj.dataUrl !== "string" || obj.dataUrl.indexOf("data:image/") !== 0) return;
      const u = state.underlay;
      u.opacity = Math.max(0.05, Math.min(1, Number(obj.opacity) || 0.45));
      u.visible = obj.visible !== false;
      u.offMx = Number(obj.offMx) || 0;
      u.offMy = Number(obj.offMy) || 0;
      const img = new Image();
      img.onload = () => {
        u.img = img;
        u.dataUrl = obj.dataUrl;
        u.mPerPx = Number(obj.mPerPx) > 0 ? Number(obj.mPerPx) : (GRID_W * CELL_M) / Math.max(1, img.naturalWidth);
        u.persisted = true;
        updateUnderlayUI();
        render();
      };
      img.src = obj.dataUrl;
    } catch (_) { /* unreadable -> no underlay */ }
  }

  function wireUnderlayPanel() {
    $("underlayLoadBtn").addEventListener("click", () => { if (!underlayLocked()) $("underlayInput").click(); });
    $("underlayInput").addEventListener("change", (e) => {
      if (e.target.files[0]) loadUnderlayFile(e.target.files[0]);
      e.target.value = "";
    });
    $("underlayOpacity").addEventListener("input", () => {
      state.underlay.opacity = Math.max(0.05, Math.min(1, Number($("underlayOpacity").value) / 100));
      render();
    });
    $("underlayOpacity").addEventListener("change", saveUnderlay);
    $("underlayToggleBtn").addEventListener("click", () => {
      if (!state.underlay.img) { toast("Load a floor plan first.", "warn"); return; }
      state.underlay.visible = !state.underlay.visible;
      saveUnderlay();
      updateUnderlayUI();
      render();
    });
    $("underlayMoveBtn").addEventListener("click", () => {
      if (underlayLocked()) return;
      if (!state.underlay.img) { toast("Load a floor plan first.", "warn"); return; }
      setUnderlayMode("align");
    });
    $("underlayCalibBtn").addEventListener("click", () => {
      if (underlayLocked()) return;
      if (!state.underlay.img) { toast("Load a floor plan first.", "warn"); return; }
      setUnderlayMode("calibrate");
    });
    $("underlayRemoveBtn").addEventListener("click", removeUnderlay);
  }

  // Tier lock badges on the two W3 cards (locked = visible + padlock).
  function updateW3Locks() {
    const caps = WT.tiers.caps();
    const dl = $("dataLock");
    const ul = $("underlayLock");
    if (dl) dl.innerHTML = caps.dataImportAllowed ? "" : WT.tiers.padlockSVG();
    if (ul) ul.innerHTML = caps.underlayAllowed ? "" : WT.tiers.padlockSVG();
    $("dataCard").classList.toggle("gated", !caps.dataImportAllowed);
    $("underlayCard").classList.toggle("gated", !caps.underlayAllowed);
  }

  // ================================================================
  // WIRE-UP + BOOT
  // ================================================================
  function wireButtons() {
    $("saveBtn").addEventListener("click", saveNow);
    $("loadBtn").addEventListener("click", () => loadSaved(false));
    $("exportBtn").addEventListener("click", exportJSON);
    $("ifcBtn").addEventListener("click", exportIFC); // W4: gate checked inside
    // P7: consolidated WMS Report (report.js) - print / JSON / CSV.
    $("reportOpenBtn").addEventListener("click", openReportPrintable);
    $("reportJsonBtn").addEventListener("click", exportReportJson);
    $("reportCsvBtn").addEventListener("click", exportReportCsv);
    $("shareBtn").addEventListener("click", shareLayout);
    $("importBtn").addEventListener("click", () => $("importInput").click());
    $("importInput").addEventListener("change", (e) => { if (e.target.files[0]) importJSON(e.target.files[0]); e.target.value = ""; });
    // v1.1: the user's OWN saved scenarios (scenarios.js -> WT.scenarios).
    if (WT.scenarios) wireScenarios();
    // v1.2: Scenario A/B compare (compare.js -> WT.compare).
    if (WT.compare) wireCompare();
    $("clearBtn").addEventListener("click", () => {
      if (!state.elements.length) return;
      state.elements = [];
      state.selectedId = null;
      state.complianceHighlight = null;
      renderProps();
      render();
      scheduleSave();
      status("Cleared the floor.");
    });
    $("demoBtn").addEventListener("click", demoLayout);
    // Tier gate: the MRO preset is a full-version feature. The button
    // stays visible (padlocked via updatePresetLock) and explains itself.
    $("presetBtn").addEventListener("click", () => {
      const caps = WT.tiers.caps();
      if (!caps.presetAllowed("mro-distributor")) {
        toast(caps.lockHint("The MRO-distributor preset"), "warn");
        return;
      }
      loadPreset("mro-distributor");
    });
    attachTooltip($("presetBtn"), D.PRESETS["mro-distributor"].desc);
    $("tierBtn").addEventListener("click", toggleTier);
    $("runBtn").addEventListener("click", () => runSimulation("run"));
    $("heatBtn").addEventListener("click", toggleHeat);
    $("histClearBtn").addEventListener("click", clearHistory);
    $("adviseBtn").addEventListener("click", runAdvisor);
    $("complBtn").addEventListener("click", runCompliance);
    $("wmsBtn").addEventListener("click", runWmsOps);
    if ($("autoBtn")) $("autoBtn").addEventListener("click", runAutomation);
    if ($("autoOverlayBtn")) $("autoOverlayBtn").addEventListener("click", toggleAutoUtil);
    wireFlowControls();
    $("optimizeBtn").addEventListener("click", runOptimize);
    $("compareBtn").addEventListener("click", runCompare);
    $("helpBtn").addEventListener("click", () => { $("onboard").hidden = false; });
    $("onboardClose").addEventListener("click", closeOnboard);
    // P8: guided demo + About / why this
    if ($("guidedDemoBtn")) $("guidedDemoBtn").addEventListener("click", startGuidedDemo);
    if ($("demoStopBtn")) $("demoStopBtn").addEventListener("click", stopGuidedDemo);
    if ($("aboutBtn")) $("aboutBtn").addEventListener("click", openAbout);
    if ($("aboutClose")) $("aboutClose").addEventListener("click", closeAbout);
    if ($("aboutRunDemo")) $("aboutRunDemo").addEventListener("click", () => { closeAbout(); startGuidedDemo(); });
    wireViewControls();
  }

  // Zoom / pan / floor-size controls in the canvas toolbar.
  function wireViewControls() {
    const on = (id, fn) => { const el = $(id); if (el) el.addEventListener("click", fn); };
    on("zoomInBtn", () => zoomAt(1.2));
    on("zoomOutBtn", () => zoomAt(1 / 1.2));
    on("zoomFitBtn", fitToFloor);
    on("zoom100Btn", resetZoom);
    on("panBtn", togglePanMode);
    on("isoBtn", toggleViewMode);
    on("floorApplyBtn", applyFloorSizeFromInputs);
    // Enter in a floor-size field applies immediately.
    ["floorWInput", "floorHInput"].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); applyFloorSizeFromInputs(); }
      });
    });
    syncFloorInputs();
    updateZoomBadge();
  }

  // ---- v1.0 usability: collapsible side-panel cards ------------------
  // Purely additive. Every side-panel card whose header is an
  // <h2 class="card-title"> becomes collapsible: clicking the header (or
  // pressing Enter/Space while it is focused) hides/shows that card's body.
  // The collapsed-set persists via WT.cards (localStorage, guarded, no-op
  // when storage is unavailable). DEFAULT = all expanded, so first load is
  // identical to before. Native <details>-based cards (unit-load catalog,
  // knowledge base, standards) collapse themselves and are left untouched.
  // Applied GENERICALLY - no card is hand-wired; the header is the only
  // toggle target, so buttons/inputs inside a card are never hijacked.
  function initCollapsibleCards() {
    if (!WT.cards || !document.querySelectorAll) return; // graceful: app still works
    const collapse = WT.cards.create();
    const cards = document.querySelectorAll("main.layout section.card");
    cards.forEach((card) => {
      const title = card.querySelector(":scope > .card-title");
      if (!title) return; // <details>-based cards handle their own collapsing
      // A stable key: prefer the card's id, else a slug of its title text.
      const key = card.id || "card-" + WT.cards.slug(title.textContent || "");
      title.classList.add("card-toggle");
      title.setAttribute("role", "button");
      title.setAttribute("tabindex", "0");
      // A caret affordance pinned to the far end of the header.
      const caret = document.createElement("span");
      caret.className = "card-caret";
      caret.setAttribute("aria-hidden", "true");
      caret.textContent = "▾"; // down-pointing triangle; rotates when collapsed
      title.appendChild(caret);

      const apply = () => {
        const collapsed = collapse.isCollapsed(key);
        card.classList.toggle("card--collapsed", collapsed);
        title.setAttribute("aria-expanded", collapsed ? "false" : "true");
      };
      const toggle = () => { collapse.toggle(key); apply(); };
      apply(); // restore any persisted collapse; default = expanded (no-op)

      title.addEventListener("click", toggle);
      title.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
          e.preventDefault();
          toggle();
        }
      });
    });
  }

  // In-browser self-test hook. ATTACHED ONLY under ?selftest=1 - a normal
  // load never exposes these internals. selftest.js drives the LIVE app
  // through the SAME functions the UI uses (no re-implementation), so the
  // self-test exercises the real handlers, not a parallel copy.
  function maybeExposeTestApi() {
    if (!/[?&]selftest=1(?:&|$)/.test(window.location.search)) return;
    window.__WT_TEST_API__ = {
      // state + viewport (read-only inspection by the suite)
      state: state,
      view: view,
      currentLayout: currentLayout,
      // the real UI handlers
      loadExample: loadExample,
      runWmsOps: runWmsOps,
      flowPlay: flowPlay,
      flowPause: flowPause,
      flowStep: flowStep,
      flowReset: flowReset,
      drawFlowKpis: drawFlowKpis,
      render: render,
      setViewMode: setViewMode,
      toggleViewMode: toggleViewMode,
      buildCurrentReport: buildCurrentReport,
      openAbout: openAbout,
      closeAbout: closeAbout,
      zoomAt: zoomAt,
      fitToFloor: fitToFloor,
      // v1.6 a11y/perf hooks for the self-test:
      prefersReducedMotion: prefersReducedMotion,
      cullToView: (els, bounds, pad) => V.cullToView(els, bounds, pad),
      viewBounds: () => V.viewBounds(view, viewCssW, viewCssH),
    };
  }

  function boot() {
    buildPalette();
    buildConfigControls();
    buildAbControls();
    buildStandards();
    buildCompliance();
    buildKnowledgeBase();
    buildGeneratePanel();
    buildExamplesPanel();
    buildExampleQuickPick();
    buildAbout(); // P8: render the About / why-this copy from WT.demo.ABOUT
    initCollapsibleCards(); // v1.0: make the side-panel cards collapsible (default expanded)
    wireButtons();
    wireDataPanel();
    wireWmsDataPanel();
    wireStoragePanel();
    wireUnderlayPanel();
    loadDataset(); // W3: restore imported data + floor plan (their own keys)
    loadUnderlay();
    updateDataUI();
    renderWmsData();
    updateUnderlayUI();
    pushConfigToUI();
    resizeCanvas();
    // Deep-link intent from the query string (?scenario=/?example=,
    // ?onboarding=0). Pure parse in deeplink.js; the app validates + acts.
    const deeplink = (WT.deeplink && typeof WT.deeplink.parse === "function")
      ? WT.deeplink.parse(location.search)
      : { scenario: null, skipOnboarding: false };
    // Boot precedence: an explicit #layout= share-hash wins, else a
    // ?scenario= deep-link, else the saved layout, else the demo starter.
    if (!loadFromShareHash() && !loadScenarioDeepLink(deeplink.scenario) && !loadSaved(true)) {
      demoLayout();
    }
    // P4: apply the tier gate to every gated control (palette, strategy
    // selects, preset button, tier badge). Default tier is "demo".
    applyTier();
    // A deep-link (a ?scenario= load or ?onboarding=0) suppresses the
    // welcome modal for THIS load only - it never persists the preference.
    maybeShowOnboard(deeplink.skipOnboarding);
    initInstallButton();
    registerSW();
    maybeExposeTestApi(); // ?selftest=1 only: expose the real handlers to selftest.js

    // responsive + theme
    window.addEventListener("resize", () => { resizeCanvas(); drawFlowKpis(); });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    (mq.addEventListener ? mq.addEventListener.bind(mq, "change") : mq.addListener.bind(mq))(() => {
      COLORS = themeColors();
      render();
      drawFlowKpis(); // repaint the cockpit in the new theme
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  /* ==================================================================
   * TODO HOOKS FOR LATER PASSES
   * ------------------------------------------------------------------
   * P2 - DONE: heuristic advisor (advisor.js -> runAdvisor), spatial
   *      optimizer (optimizer.js -> runOptimize/applyOptimize), A/B
   *      comparative predictor (runCompare), German-standards panel
   *      (buildStandards + live D.aisleViolations check).
   * P3 - DONE: 12 storage systems with sim-relevant characteristics,
   *      material-flow chains (D.analyzeChains -> flow arrows + badge +
   *      advisor warnings), push vs pull replenishment, zone/batch/wave
   *      picking, unit-load catalog with cartons-per-pallet math, and
   *      the illustrative MRO-distributor preset (loadPreset).
   * P4 - DONE: demo/full tier gate (tiers.js capability flags ->
   *      buildPalette / fillStrategySelect / updatePresetLock /
   *      runAdvisor limit, applyTier + toggleTier UI) and the Android
   *      TWA packaging scaffold (android/ + PUBLISH_ANDROID.md - docs
   *      and config only; building/signing/submitting is the owner's
   *      step, no AAB is fabricated here).
   * P5 - LSP Planner:      a higher-level network/planning layer that
   *                       consumes exported layouts (serialize()).
   * R2 - DONE: pick-traffic heatmap overlay (drawHeat/drawHeatLegend,
   *      fed by the simulation's per-cell walking data) and the
   *      session-only run-history table (pushHistory/renderHistory).
   * W4 - DONE: IFC export bridge (ifc.js -> exportIFC/updateIfcLock):
   *      the layout leaves as a scoped IFC4 coordination model -
   *      spatial tree + one proxy solid per element - validated by
   *      verify_ifc.js (structural) + ifcopenshell (gold standard).
   * ================================================================== */
})();
