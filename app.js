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
  const GRID_W = 40; // cells across (metres)
  const GRID_H = 24; // cells down (metres)

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
    },
    lastResult: null,
    drag: null, // {id, offsetX, offsetY, moved}
    preview: null, // optimizer proposal: [{id,type,x,y,w,d}] shown as ghosts
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
      ? { bg: "#0e1626", grid: "#1c2942", gridStrong: "#2b3d5c", text: "#e2e8f0", dim: "#94a3b8", sel: "#38bdf8", violation: "#f87171", io: "#facc15" }
      : { bg: "#ffffff", grid: "#e8edf3", gridStrong: "#cbd5e1", text: "#0f172a", dim: "#64748b", sel: "#0284c7", violation: "#dc2626", io: "#ca8a04" };
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
    // Topmost (last drawn) element containing the cell.
    for (let i = state.elements.length - 1; i >= 0; i--) {
      const e = state.elements[i];
      if (cellX >= e.x && cellX < e.x + e.w && cellY >= e.y && cellY < e.y + e.d) return e;
    }
    return null;
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
    const cssW = Math.max(280, canvasWrap.clientWidth);
    cellPx = cssW / GRID_W;
    const cssH = cellPx * GRID_H;
    const dpr = window.devicePixelRatio || 1;
    canvas.style.height = cssH + "px";
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
    const cssW = GRID_W * cellPx;
    const cssH = GRID_H * cellPx;
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, cssW, cssH);

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

    // elements
    for (const e of state.elements) {
      const def = ELEMENTS[e.type];
      const px = e.x * cellPx, py = e.y * cellPx, pw = e.w * cellPx, ph = e.d * cellPx;
      ctx.save();
      roundRect(px + 2, py + 2, pw - 4, ph - 4, 6);
      ctx.fillStyle = hexA(def.color, 0.22);
      ctx.fill();
      ctx.lineWidth = e.id === state.selectedId ? 3 : 1.5;
      ctx.strokeStyle = e.id === state.selectedId ? COLORS.sel : def.color;
      ctx.stroke();

      // label
      const fontSize = Math.max(9, Math.min(13, cellPx * 0.62));
      ctx.fillStyle = COLORS.text;
      ctx.font = `600 ${fontSize}px system-ui, sans-serif`;
      ctx.textBaseline = "top";
      const label = shortLabel(e.type);
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

    // I/O marker
    const io = ioPoint();
    const ix = io.x * cellPx, iy = io.y * cellPx;
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

    updateBadges(viol);
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
      "dock-in": "Dock IN",
      "dock-out": "Dock OUT",
      "staging": "Staging",
      "conveyor": "Conveyor",
      "push-station": "Push",
      "pull-station": "Pull",
    })[type] || type;
  }

  function updateBadges(viol) {
    $("capBadge").textContent = "Positions: " + totalPositions();
    const ab = $("aisleBadge");
    if (viol && viol.length) {
      ab.textContent = "Aisle: " + viol.length + " too narrow";
      ab.className = "badge warn";
    } else {
      ab.textContent = "Aisle OK";
      ab.className = "badge ok";
    }
    updateStandardsLive();
  }

  // ================================================================
  // POINTER INTERACTION (place / select / drag)
  // ================================================================
  function pointerCell(e) {
    const rect = canvas.getBoundingClientRect();
    const cx = ((e.clientX - rect.left) / rect.width) * GRID_W;
    const cy = ((e.clientY - rect.top) / rect.height) * GRID_H;
    return { cx, cy };
  }

  canvas.addEventListener("pointerdown", (e) => {
    const { cx, cy } = pointerCell(e);
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

  window.addEventListener("keydown", (e) => {
    if (e.target && /input|select|textarea/i.test(e.target.tagName)) return;
    if (e.key === "Escape") { setTool(null); return; }
    if ((e.key === "Delete" || e.key === "Backspace") && state.selectedId) {
      e.preventDefault();
      deleteSelected();
    }
  });

  // ================================================================
  // PALETTE
  // ================================================================
  function buildPalette() {
    const wrap = $("palette");
    wrap.innerHTML = "";
    for (const type of D.paletteOrder) {
      const def = ELEMENTS[type];
      const btn = document.createElement("button");
      btn.className = "pal-item";
      btn.type = "button";
      btn.dataset.type = type;
      btn.innerHTML =
        `<span class="pal-swatch" style="background:${def.color}"></span>` +
        `<span>${def.label}</span>` +
        `<span class="pal-cat">${def.category}</span>`;
      btn.addEventListener("click", () => setTool(state.activeTool === type ? null : type));
      attachTooltip(btn, def.desc);
      wrap.appendChild(btn);
    }
  }

  function setTool(type) {
    state.activeTool = type;
    document.querySelectorAll(".pal-item").forEach((b) => {
      b.classList.toggle("active", b.dataset.type === type);
    });
    $("modeBadge").textContent = type ? "Mode: Placing " + shortLabel(type) : "Mode: Select";
    canvas.style.cursor = type ? "copy" : "crosshair";
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
      rows.push(row("Pallet positions", String(D.elementCapacity(el))));
      rows.push(row("Levels", String(def.levels)));
      rows.push(row("Selectivity", (def.selectivity * 100).toFixed(0) + "%"));
      rows.push(row("Rotation", def.rotation));
      rows.push(row("Cost index", "×" + def.costIndex));
    }
    if (def.io) rows.push(row("I/O role", def.io));
    if (def.flow) rows.push(row("Flow control", def.flow.toUpperCase()));

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
      (def.resizable ? '<button id="rotateBtn" class="btn" type="button">Rotate</button>' : "") +
      '<button id="deleteBtn" class="btn danger" type="button">Delete</button>' +
      "</div>";

    if (def.resizable) {
      $("pW").addEventListener("change", () => applySize());
      $("pD").addEventListener("change", () => applySize());
      $("rotateBtn").addEventListener("click", () => rotateSelected());
    }
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
  function runSimulation() {
    readConfigFromUI();
    const layout = { elements: state.elements, gridW: GRID_W, gridH: GRID_H, cell: CELL_M };
    const res = WT.sim.run(layout, state.config);
    state.lastResult = res;
    renderKPIs(res);
    if (!res.ok) {
      status("Add at least one storage element (racking or block stack) to run a meaningful sim.");
    } else {
      status(`Ran ${res.ordersServed} orders with ${res.strategy.toUpperCase()} slotting (seed ${res.seed}). I/O = ${res.ioSource}.`);
    }
  }

  function renderKPIs(res) {
    const kpi = $("kpi");
    const cards = [
      kcard("Throughput", res.throughputOrdersPerHour.toFixed(1), "orders / hr"),
      kcard("Avg pick travel", res.avgPickTravelM.toFixed(1), "m / order"),
      kcard("Storage fill", res.storageFillPct.toFixed(1), "%"),
      kcard("Positions used", res.palletPositionsUsed + " / " + res.palletPositionsTotal, "pallet pos."),
    ];
    const note =
      `<p class="kpi-note">Synthetic, seeded run — ${res.params.orders} orders, ${res.params.skuCount} SKUs, ` +
      `${res.params.pickers} picker @ ${res.params.pickerSpeedMps} m/s, ${res.params.handlingSecPerLine}s/line. ` +
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

  // ---- Advisor -----------------------------------------------------
  function runAdvisor() {
    readConfigFromUI();
    const list = WT.advisor.analyze(currentLayout(), state.config);
    const out = $("advisorOut");
    if (!list.length) {
      out.innerHTML = '<p class="empty">Place some elements, then analyze.</p>';
      return;
    }
    out.innerHTML = list
      .map(
        (sug) =>
          `<div class="adv-item ${sug.severity}">` +
          `<div class="adv-head"><span class="adv-dot"></span><span class="adv-finding">${esc(sug.finding)}</span></div>` +
          `<div class="adv-line"><span class="adv-k">Principle</span> ${esc(sug.principle)}</div>` +
          `<div class="adv-line"><span class="adv-k">Est. impact</span> ${esc(sug.impact)}</div>` +
          "</div>"
      )
      .join("");
    const high = list.filter((x) => x.severity === "high").length;
    status(`Advisor: ${list.length} suggestion(s)${high ? ", " + high + " high-priority" : ""}.`);
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
    const opt = WT.optimizer.optimize(currentLayout(), state.config);
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
    runSimulation();
    $("optOut").innerHTML = '<p class="opt-none">Applied. KPIs updated above.</p>';
    toast("Optimized layout applied.");
  }

  function discardOptimize() {
    state.preview = null;
    render();
    $("optOut").innerHTML = '<p class="empty">Discarded — layout unchanged.</p>';
  }

  // ---- A/B comparative predictor -----------------------------------
  function buildAbControls() {
    for (const id of ["abStratA", "abStratB"]) {
      const selEl = $(id);
      selEl.innerHTML = "";
      Object.values(D.STRATEGIES).forEach((st) => {
        const o = document.createElement("option");
        o.value = st.id;
        o.textContent = st.label;
        selEl.appendChild(o);
      });
    }
    $("abStratA").value = "random";
    $("abStratB").value = "abc";
  }

  function abLayout(kind) {
    if (kind === "optimized") {
      const opt = WT.optimizer.optimize(currentLayout(), state.config);
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
    const cfgA = Object.assign({}, state.config, { strategy: $("abStratA").value });
    const cfgB = Object.assign({}, state.config, { strategy: $("abStratB").value });
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
    const rec = pct < 0.5
      ? `<strong>${esc(nameA)}</strong> and <strong>${esc(nameB)}</strong> are effectively tied on pick travel at seed ${state.config.seed}.`
      : `<strong>${esc(better.n)}</strong> is the better choice — about ${pct.toFixed(0)}% less pick travel and higher throughput than ${esc(better.on)} (seed ${state.config.seed}).`;
    out.innerHTML = table + `<p class="ab-rec">${rec}</p>`;
    status("Compared A vs B (deterministic, same seed).");
  }

  // ---- German-standards panel --------------------------------------
  const STANDARDS = [
    { code: "ASR A1.8", gov: "Technical Rules for Workplaces — traffic routes and walkways.", app: "Aisle-width guidance keeps truck and pedestrian routes workable." },
    { code: "DIN 15185", gov: "Safety of storage installations; working-aisle design for industrial trucks.", app: "The live minimum-aisle check flags rack rows placed too close (status below)." },
    { code: "EN 15512", gov: "Steel static storage systems — adjustable pallet racking; structural design principles.", app: "Models racking capacity and levels. It does NOT perform structural/load design." },
    { code: "EPAL / DIN EN 13698", gov: "Production specification for the flat wooden Euro (EUR) pallet.", app: "EUR1–EUR6 real dimensions are built into the domain model." },
    { code: "VDI 2510 / VDI 3564", gov: "VDI 2510: automated guided vehicle (AGV) systems. VDI 3564: fire-protection design for high-bay / automated warehouses.", app: "Referenced for the AGV/AS-RS material-flow modelling planned in P3/P5." },
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
  // CONFIG CONTROLS
  // ================================================================
  function buildConfigControls() {
    const sel = $("strategySelect");
    sel.innerHTML = "";
    Object.values(D.STRATEGIES).forEach((s) => {
      const o = document.createElement("option");
      o.value = s.id;
      o.textContent = s.label;
      sel.appendChild(o);
    });
    sel.value = state.config.strategy;
    updateStrategyDesc();
    sel.addEventListener("change", () => { state.config.strategy = sel.value; updateStrategyDesc(); });

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

    $("seedInput").addEventListener("change", readConfigFromUI);
    $("ordersInput").addEventListener("change", readConfigFromUI);
    $("skuInput").addEventListener("change", readConfigFromUI);
  }

  function updateStrategyDesc() {
    $("strategyDesc").textContent = (D.STRATEGIES[state.config.strategy] || {}).desc || "";
  }

  function readConfigFromUI() {
    state.config.seed = Math.max(0, Math.round(Number($("seedInput").value) || 0));
    state.config.orders = Math.max(1, Math.round(Number($("ordersInput").value) || 1));
    state.config.skuCount = Math.max(1, Math.round(Number($("skuInput").value) || 1));
    state.config.strategy = $("strategySelect").value;
    state.config.minAisleMetres = Number($("aisleInput").value) || D.AISLE.defaultMinMetres;
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
        strategy: D.STRATEGIES[obj.config.strategy] ? obj.config.strategy : state.config.strategy,
        orders: numOr(obj.config.orders, state.config.orders),
        skuCount: numOr(obj.config.skuCount, state.config.skuCount),
        minAisleMetres: numOr(obj.config.minAisleMetres, state.config.minAisleMetres),
      });
    }
    pushConfigToUI();
    renderProps();
    render();
    if (source) status("Loaded layout from " + source + ".");
  }

  function clampInt(v, lo, hi, dflt) {
    let n = Math.round(Number(v));
    if (isNaN(n)) n = dflt !== undefined ? dflt : lo;
    return Math.max(lo, Math.min(hi, n));
  }
  function numOr(v, d) { const n = Number(v); return isNaN(n) ? d : n; }

  function scheduleSave() {
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
  // DEMO LAYOUT (first-run starter so the sim works immediately)
  // ================================================================
  function demoLayout() {
    state.idCounter = 0;
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
    renderProps();
    render();
    scheduleSave();
    status("Loaded the starter demo layout. Try Run simulation, then switch strategy and compare.");
  }

  // ================================================================
  // ONBOARDING
  // ================================================================
  const OB_KEY = "wt.onboarded.v1";
  function maybeShowOnboard() {
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
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
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
    $("installBtn").hidden = false;
  });
  $("installBtn").addEventListener("click", async () => {
    if (!deferredPrompt) { toast("Use your browser menu → Install app.", "warn"); return; }
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
  // WIRE-UP + BOOT
  // ================================================================
  function wireButtons() {
    $("saveBtn").addEventListener("click", saveNow);
    $("loadBtn").addEventListener("click", () => loadSaved(false));
    $("exportBtn").addEventListener("click", exportJSON);
    $("importBtn").addEventListener("click", () => $("importInput").click());
    $("importInput").addEventListener("change", (e) => { if (e.target.files[0]) importJSON(e.target.files[0]); e.target.value = ""; });
    $("clearBtn").addEventListener("click", () => {
      if (!state.elements.length) return;
      state.elements = [];
      state.selectedId = null;
      renderProps();
      render();
      scheduleSave();
      status("Cleared the floor.");
    });
    $("demoBtn").addEventListener("click", demoLayout);
    $("runBtn").addEventListener("click", runSimulation);
    $("adviseBtn").addEventListener("click", runAdvisor);
    $("optimizeBtn").addEventListener("click", runOptimize);
    $("compareBtn").addEventListener("click", runCompare);
    $("helpBtn").addEventListener("click", () => { $("onboard").hidden = false; });
    $("onboardClose").addEventListener("click", closeOnboard);
  }

  function boot() {
    buildPalette();
    buildConfigControls();
    buildAbControls();
    buildStandards();
    wireButtons();
    pushConfigToUI();
    resizeCanvas();
    // load saved or seed demo
    if (!loadSaved(true)) demoLayout();
    maybeShowOnboard();
    registerSW();

    // responsive + theme
    window.addEventListener("resize", resizeCanvas);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    (mq.addEventListener ? mq.addEventListener.bind(mq, "change") : mq.addListener.bind(mq))(() => {
      COLORS = themeColors();
      render();
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
   * P3 - Domain depth:     new ELEMENTS entries in domain.js appear in
   *                       the palette, sim, advisor & optimizer with no
   *                       further UI change; add material-flow chains.
   * P4 - Android/TWA:      packaging only (Bubblewrap) - see
   *                       PUBLISH_ANDROID.md. No app code change needed.
   * P5 - LSP Planner:      a higher-level network/planning layer that
   *                       consumes exported layouts (serialize()).
   * ================================================================== */
})();
