/* =====================================================================
 * Logistics Flow Studio - LSP Planner (P5)
 * lsp/lsp.js - the interactive shell: network map editor, levels,
 *              scoring UI, advisor, A/B compare, persistence, PWA glue.
 * ---------------------------------------------------------------------
 * Vanilla JS, no framework, no build step - the same architecture as
 * the WarehouseTwin shell (../app.js). All evaluation maths lives in
 * lsp-engine.js (pure + deterministic); this file only draws, wires
 * and persists. Pointer events give unified mouse + touch.
 * ===================================================================== */
(function () {
  "use strict";
  const WT = window.WT;
  const E = window.LSP.engine;
  const SITE_TYPES = E.SITE_TYPES;
  const MODES = E.MODES;
  const GRID_W = E.PARAMS.gridW;
  const GRID_H = E.PARAMS.gridH;
  const CELL_KM = E.PARAMS.cellKm;

  // ---------------- Mutable state ----------------
  const state = {
    levelId: "L1",
    design: null, // engine design object (sites + lanes)
    selected: null, // {kind:"site"|"lane", id}
    tool: null, // null (select) | "lane" | a site type
    laneFrom: null, // first site of a lane being drawn
    drag: null, // {id, dx, dy, moved}
    lastEval: null, // engine evaluation of the CURRENT design (or null)
    snapshotA: null, // {design, eval} frozen by "Save as A"
  };

  // ---------------- DOM refs ----------------
  const $ = (id) => document.getElementById(id);
  const canvas = $("map");
  const ctx = canvas.getContext("2d");
  const canvasWrap = $("canvasWrap");

  function level() {
    return E.levelById(state.levelId);
  }

  // ================================================================
  // THEME COLOURS (canvas can't read CSS vars directly)
  // ================================================================
  function themeColors() {
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    return dark
      ? { bg: "#0e1626", grid: "#1c2942", gridStrong: "#2b3d5c", text: "#e2e8f0", dim: "#94a3b8",
          sel: "#38bdf8", laneFtl: "#94a3b8", laneParcel: "#7dd3fc", flowLabel: "#e2e8f0",
          ok: "#4ade80", warn: "#fbbf24", bad: "#f87171" }
      : { bg: "#ffffff", grid: "#e8edf3", gridStrong: "#cbd5e1", text: "#0f172a", dim: "#64748b",
          sel: "#0284c7", laneFtl: "#64748b", laneParcel: "#0284c7", flowLabel: "#0f172a",
          ok: "#16a34a", warn: "#d97706", bad: "#dc2626" };
  }
  let COLORS = themeColors();

  // Visual footprints (cells) per site type - drawing + hit test only;
  // distances always run centre-to-centre in the engine.
  const DRAW = {
    factory: { w: 4, d: 3 },
    "central-dc": { w: 3, d: 3 },
    "regional-dc": { w: 2.4, d: 2.4 },
    crossdock: { w: 3, d: 2 },
    zone: { r: 1.5 },
  };

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  // ================================================================
  // CANVAS RENDERING
  // ================================================================
  let cellPx = 16;

  function resizeCanvas() {
    const cssW = Math.max(320, canvasWrap.clientWidth);
    cellPx = cssW / GRID_W;
    const cssH = cellPx * GRID_H;
    const dpr = window.devicePixelRatio || 1;
    canvas.style.height = cssH + "px";
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    render();
  }

  function px(cx) { return cx * cellPx; }

  function render() {
    if (!state.design) return;
    const cssW = GRID_W * cellPx, cssH = GRID_H * cellPx;
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, cssW, cssH);

    // region grid (a clean abstract map - deliberately NOT a real country)
    ctx.lineWidth = 1;
    for (let x = 0; x <= GRID_W; x += 2) {
      ctx.strokeStyle = x % 10 === 0 ? COLORS.gridStrong : COLORS.grid;
      ctx.beginPath(); ctx.moveTo(Math.round(px(x)) + 0.5, 0); ctx.lineTo(Math.round(px(x)) + 0.5, cssH); ctx.stroke();
    }
    for (let y = 0; y <= GRID_H; y += 2) {
      ctx.strokeStyle = y % 10 === 0 ? COLORS.gridStrong : COLORS.grid;
      ctx.beginPath(); ctx.moveTo(0, Math.round(px(y)) + 0.5); ctx.lineTo(cssW, Math.round(px(y)) + 0.5); ctx.stroke();
    }
    ctx.fillStyle = COLORS.dim;
    ctx.font = `500 ${Math.max(9, cellPx * 0.7)}px system-ui, sans-serif`;
    ctx.textBaseline = "bottom";
    ctx.fillText("Abstract region - 1 cell = " + CELL_KM + " km (synthetic, seeded)", 8, cssH - 6);

    drawLanes();
    drawLaneFromMarker();
    for (const s of state.design.sites) drawSite(s);
  }

  function laneInfo(laneId) {
    if (!state.lastEval) return null;
    return state.lastEval.lanes.find((l) => l.id === laneId) || null;
  }

  function drawLanes() {
    for (const lane of state.design.lanes) {
      const a = E.siteById(state.design, lane.a);
      const b = E.siteById(state.design, lane.b);
      if (!a || !b) continue;
      const info = laneInfo(lane.id);
      const selectedLane = state.selected && state.selected.kind === "lane" && state.selected.id === lane.id;
      const flow = info ? info.flowTWk : 0;
      ctx.save();
      ctx.lineWidth = selectedLane ? 4 : 2 + Math.min(4, flow / 15);
      ctx.strokeStyle = selectedLane ? COLORS.sel : lane.mode === "ftl" ? COLORS.laneFtl : COLORS.laneParcel;
      ctx.setLineDash(lane.mode === "parcel" ? [7, 5] : []);
      ctx.globalAlpha = info && flow === 0 ? 0.45 : 0.9;
      ctx.beginPath();
      ctx.moveTo(px(a.x), px(a.y));
      ctx.lineTo(px(b.x), px(b.y));
      ctx.stroke();
      ctx.setLineDash([]);

      // flow-direction arrow after an evaluation
      if (info && flow > 0 && info.dir) {
        const from = info.dir === "ab" ? a : b;
        const to = info.dir === "ab" ? b : a;
        const t = 0.56;
        const mx = px(from.x + (to.x - from.x) * t);
        const my = px(from.y + (to.y - from.y) * t);
        const ang = Math.atan2(to.y - from.y, to.x - from.x);
        const sz = Math.max(6, cellPx * 0.55);
        ctx.fillStyle = ctx.strokeStyle;
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.moveTo(mx + Math.cos(ang) * sz, my + Math.sin(ang) * sz);
        ctx.lineTo(mx + Math.cos(ang + 2.5) * sz, my + Math.sin(ang + 2.5) * sz);
        ctx.lineTo(mx + Math.cos(ang - 2.5) * sz, my + Math.sin(ang - 2.5) * sz);
        ctx.closePath();
        ctx.fill();
      }

      // label on the selected lane
      if (selectedLane) {
        const mx = px((a.x + b.x) / 2), my = px((a.y + b.y) / 2);
        const km = Math.round(E.distKm(a, b));
        let label = MODES[lane.mode].label.replace(/ \(.*/, "") + " · " + km + " km";
        if (info) {
          label += " · " + info.flowTWk + " t/wk" + (lane.mode === "ftl" && info.trucksWk ? " · " + info.trucksWk + " trk" : "");
        }
        ctx.font = `600 ${Math.max(10, cellPx * 0.75)}px system-ui, sans-serif`;
        const w = ctx.measureText(label).width + 10;
        ctx.fillStyle = COLORS.bg;
        ctx.globalAlpha = 0.9;
        ctx.fillRect(mx - w / 2, my - 18, w, 16);
        ctx.globalAlpha = 1;
        ctx.fillStyle = COLORS.flowLabel;
        ctx.textBaseline = "middle";
        ctx.textAlign = "center";
        ctx.fillText(label, mx, my - 10);
        ctx.textAlign = "left";
      }
      ctx.restore();
    }
  }

  function drawLaneFromMarker() {
    if (!state.laneFrom) return;
    const s = E.siteById(state.design, state.laneFrom);
    if (!s) return;
    ctx.save();
    ctx.strokeStyle = COLORS.sel;
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.arc(px(s.x), px(s.y), cellPx * 2.2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function zoneEval(siteId) {
    if (!state.lastEval) return null;
    return state.lastEval.zones.find((z) => z.id === siteId) || null;
  }

  function drawSite(s) {
    const def = SITE_TYPES[s.type];
    const d = DRAW[s.type];
    const cx = px(s.x), cy = px(s.y);
    const isSel = state.selected && state.selected.kind === "site" && state.selected.id === s.id;
    ctx.save();

    if (s.type === "zone") {
      const r = d.r * cellPx;
      const ze = zoneEval(s.id);
      let ring = def.color;
      if (ze) ring = !ze.served ? COLORS.bad : ze.service >= 0.9 ? COLORS.ok : ze.service >= 0.7 ? COLORS.warn : COLORS.bad;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = hexA(def.color, 0.18);
      ctx.fill();
      ctx.lineWidth = isSel ? 3 : 2;
      ctx.strokeStyle = isSel ? COLORS.sel : ring;
      ctx.stroke();
      // demand dots (abstract "customers")
      ctx.fillStyle = hexA(def.color, 0.75);
      const dr = r * 0.42;
      for (let i = 0; i < 3; i++) {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / 3;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * dr, cy + Math.sin(a) * dr, Math.max(1.5, r * 0.16), 0, Math.PI * 2);
        ctx.fill();
      }
      label(s.label || "Zone", cx, cy + r + 3);
      sub((s.demandMean || 0) + " t/wk · CV " + (s.demandCv || 0), cx, cy + r + 3 + Math.max(10, cellPx * 0.8));
    } else {
      const w = d.w * cellPx, h = d.d * cellPx;
      const x0 = cx - w / 2, y0 = cy - h / 2;
      roundRect(x0, y0, w, h, 5);
      ctx.fillStyle = hexA(def.color, 0.22);
      ctx.fill();
      ctx.lineWidth = isSel ? 3 : 2;
      ctx.strokeStyle = isSel ? COLORS.sel : def.color;
      ctx.stroke();
      ctx.strokeStyle = hexA(def.color, 0.85);
      ctx.fillStyle = hexA(def.color, 0.85);
      ctx.lineWidth = Math.max(1.2, cellPx * 0.1);
      if (s.type === "factory") {
        // sawtooth roof + chimney
        ctx.beginPath();
        ctx.moveTo(x0 + w * 0.08, y0 + h * 0.36);
        ctx.lineTo(x0 + w * 0.28, y0 + h * 0.12);
        ctx.lineTo(x0 + w * 0.28, y0 + h * 0.36);
        ctx.lineTo(x0 + w * 0.48, y0 + h * 0.12);
        ctx.lineTo(x0 + w * 0.48, y0 + h * 0.36);
        ctx.lineTo(x0 + w * 0.68, y0 + h * 0.12);
        ctx.lineTo(x0 + w * 0.68, y0 + h * 0.36);
        ctx.stroke();
        ctx.fillRect(x0 + w * 0.78, y0 + h * 0.1, w * 0.08, h * 0.3);
        ctx.strokeRect(x0 + w * 0.15, y0 + h * 0.52, w * 0.7, h * 0.32);
      } else if (s.type === "central-dc" || s.type === "regional-dc") {
        // shelf bars = stocked DC
        const bars = s.type === "central-dc" ? 3 : 2;
        for (let i = 0; i < bars; i++) {
          const yy = y0 + h * (0.24 + (i * 0.52) / Math.max(1, bars - 1));
          ctx.beginPath();
          ctx.moveTo(x0 + w * 0.18, yy);
          ctx.lineTo(x0 + w * 0.82, yy);
          ctx.stroke();
        }
      } else if (s.type === "crossdock") {
        // arrows straight through: in one side, out the other, no shelves
        const yy = cy;
        const ah = Math.max(3, cellPx * 0.28);
        ctx.beginPath();
        ctx.moveTo(x0 + w * 0.06, yy - h * 0.18);
        ctx.lineTo(x0 + w * 0.6, yy - h * 0.18);
        ctx.moveTo(x0 + w * 0.4, yy + h * 0.18);
        ctx.lineTo(x0 + w * 0.94, yy + h * 0.18);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x0 + w * 0.6 + ah, yy - h * 0.18);
        ctx.lineTo(x0 + w * 0.6 - ah * 0.2, yy - h * 0.18 - ah * 0.8);
        ctx.lineTo(x0 + w * 0.6 - ah * 0.2, yy - h * 0.18 + ah * 0.8);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(x0 + w * 0.94 + ah * 0.2, yy + h * 0.18);
        ctx.lineTo(x0 + w * 0.94 - ah, yy + h * 0.18 - ah * 0.8);
        ctx.lineTo(x0 + w * 0.94 - ah, yy + h * 0.18 + ah * 0.8);
        ctx.closePath();
        ctx.fill();
      }
      label(def.label + (SITE_TYPES[s.type].stocking ? " (" + (s.mode === "push" ? "push" : "pull") + ")" : ""), cx, y0 + h + 3);
    }
    ctx.restore();

    function label(text, lx, ly) {
      ctx.fillStyle = COLORS.text;
      ctx.font = `600 ${Math.max(10, cellPx * 0.85)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(text, lx, ly);
      ctx.textAlign = "left";
    }
    function sub(text, lx, ly) {
      ctx.fillStyle = COLORS.dim;
      ctx.font = `500 ${Math.max(9, cellPx * 0.72)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(text, lx, ly);
      ctx.textAlign = "left";
    }
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

  // ================================================================
  // HIT TESTING + POINTER EVENTS
  // ================================================================
  function pointerCell(e) {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * GRID_W, y: ((e.clientY - r.top) / r.height) * GRID_H };
  }

  function hitSite(cx, cy) {
    for (let i = state.design.sites.length - 1; i >= 0; i--) {
      const s = state.design.sites[i];
      const d = DRAW[s.type];
      if (s.type === "zone") {
        if (Math.hypot(cx - s.x, cy - s.y) <= d.r + 0.4) return s;
      } else if (Math.abs(cx - s.x) <= d.w / 2 + 0.3 && Math.abs(cy - s.y) <= d.d / 2 + 0.3) {
        return s;
      }
    }
    return null;
  }

  function hitLane(cx, cy) {
    let best = null, bestD = 0.55;
    for (const lane of state.design.lanes) {
      const a = E.siteById(state.design, lane.a);
      const b = E.siteById(state.design, lane.b);
      if (!a || !b) continue;
      const d = pointSegDist(cx, cy, a.x, a.y, b.x, b.y);
      if (d < bestD) { bestD = d; best = lane; }
    }
    return best;
  }

  function pointSegDist(pxx, pyy, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((pxx - ax) * dx + (pyy - ay) * dy) / len2)) : 0;
    return Math.hypot(pxx - (ax + t * dx), pyy - (ay + t * dy));
  }

  function siteFits(x, y, exceptId) {
    if (x < 2 || y < 2 || x > GRID_W - 2 || y > GRID_H - 2) return false;
    return !state.design.sites.some((s) => s.id !== exceptId && Math.hypot(s.x - x, s.y - y) < 4);
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (!state.design) return;
    canvas.setPointerCapture(e.pointerId);
    const c = pointerCell(e);

    // --- placing a site ---
    if (state.tool && state.tool !== "lane") {
      const x = Math.round(c.x), y = Math.round(c.y);
      if (!siteFits(x, y, null)) {
        toast("Too close to another site or the border.", "warn");
        return;
      }
      const site = E.addSite(state.design, state.tool, x, y);
      selectSite(site.id);
      afterMutate();
      status(`Placed ${SITE_TYPES[site.type].label}. ` + (SITE_TYPES[site.type].stocking ? "Set push/pull in its properties." : "Now connect it with lanes."));
      return;
    }

    // --- drawing a lane ---
    if (state.tool === "lane") {
      const s = hitSite(c.x, c.y);
      if (!s) {
        if (state.laneFrom) { state.laneFrom = null; render(); status("Lane cancelled."); }
        return;
      }
      if (!state.laneFrom) {
        state.laneFrom = s.id;
        render();
        status("Lane from " + siteName(s) + " - now click the second site.");
      } else if (state.laneFrom !== s.id) {
        const lane = E.addLane(state.design, state.laneFrom, s.id, "ftl");
        state.laneFrom = null;
        if (lane) {
          state.selected = { kind: "lane", id: lane.id };
          afterMutate();
          status("Lane created (FTL). Switch it to Parcel/LTL in its properties if the flow is thin.");
        }
      }
      return;
    }

    // --- select / drag ---
    const s = hitSite(c.x, c.y);
    if (s) {
      selectSite(s.id);
      if (!s.fixed) state.drag = { id: s.id, dx: c.x - s.x, dy: c.y - s.y, moved: false };
      render();
      return;
    }
    const lane = hitLane(c.x, c.y);
    if (lane) {
      state.selected = { kind: "lane", id: lane.id };
      renderProps();
      render();
      return;
    }
    state.selected = null;
    renderProps();
    render();
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!state.drag) return;
    const c = pointerCell(e);
    const s = E.siteById(state.design, state.drag.id);
    if (!s) return;
    const nx = Math.round(c.x - state.drag.dx);
    const ny = Math.round(c.y - state.drag.dy);
    if ((nx !== s.x || ny !== s.y) && siteFits(nx, ny, s.id)) {
      s.x = nx; s.y = ny;
      state.drag.moved = true;
      invalidateEval();
      render();
      renderProps();
    }
  });

  canvas.addEventListener("pointerup", () => {
    if (state.drag && state.drag.moved) { scheduleSave(); updateBadges(); }
    state.drag = null;
  });

  window.addEventListener("keydown", (e) => {
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA")) return;
    if (e.key === "Escape") {
      setTool(null);
      state.laneFrom = null;
      render();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      deleteSelected();
    }
  });

  function siteName(s) {
    return s.type === "zone" ? (s.label || "zone") : SITE_TYPES[s.type].label;
  }

  function selectSite(id) {
    state.selected = { kind: "site", id };
    renderProps();
  }

  function deleteSelected() {
    if (!state.selected) return;
    if (state.selected.kind === "lane") {
      E.removeLane(state.design, state.selected.id);
      state.selected = null;
      afterMutate();
      status("Lane deleted.");
    } else {
      const s = E.siteById(state.design, state.selected.id);
      if (!s) return;
      if (s.fixed) { toast("This site is fixed by the level.", "warn"); return; }
      E.removeSite(state.design, s.id);
      state.selected = null;
      afterMutate();
      status("Site deleted (its lanes went with it).");
    }
  }

  // Any design change invalidates the current evaluation (the score
  // panel keeps showing until re-run, but the badge says it is stale).
  function invalidateEval() {
    if (state.lastEval) {
      state.lastEval = null;
      $("evalBadge").textContent = "Changed - re-evaluate";
      $("evalBadge").className = "badge warn";
    }
  }

  function afterMutate() {
    invalidateEval();
    scheduleSave();
    renderProps();
    render();
    updateBadges();
  }

  function updateBadges() {
    $("levelBadge").textContent = "Level: " + state.levelId + " · " + level().name;
    $("netBadge").textContent = state.design.sites.length + " sites · " + state.design.lanes.length + " lanes";
    if (!state.lastEval) {
      $("evalBadge").textContent = "Not evaluated";
      $("evalBadge").className = "badge muted";
    } else {
      const s = state.lastEval.score;
      $("evalBadge").textContent = "Score " + s.total + "/100" + (s.pass ? " · passed" : "");
      $("evalBadge").className = "badge " + (s.pass ? "ok" : "warn");
    }
  }

  // ================================================================
  // PALETTE (site types + the lane tool)
  // ================================================================
  const PALETTE_ORDER = ["central-dc", "regional-dc", "crossdock", "factory", "zone"];

  function buildPalette() {
    const wrap = $("palette");
    wrap.innerHTML = "";
    const lv = level();

    const head1 = document.createElement("div");
    head1.className = "pal-head";
    head1.textContent = "Sites";
    wrap.appendChild(head1);

    for (const type of PALETTE_ORDER) {
      const def = SITE_TYPES[type];
      const btn = document.createElement("button");
      btn.className = "pal-item";
      btn.type = "button";
      btn.dataset.type = type;
      const levelFixed = (type === "factory" || type === "zone") && !lv.freePlay;
      btn.innerHTML =
        `<span class="pal-swatch" style="background:${def.color}"></span>` +
        `<span>${def.label}</span>` +
        `<span class="pal-cat">${levelFixed ? "fixed" : "site"}</span>`;
      if (levelFixed) {
        btn.classList.add("disabled");
        btn.setAttribute("aria-disabled", "true");
        btn.addEventListener("click", () =>
          toast("The " + def.label.toLowerCase() + (type === "zone" ? "s are" : " is") + " fixed by this level - free play (L5) opens the full palette.", "warn"));
        attachTooltip(btn, def.desc + " (Fixed by this level; place your own in free play.)");
      } else {
        btn.addEventListener("click", () => setTool(state.tool === type ? null : type));
        attachTooltip(btn, def.desc);
      }
      wrap.appendChild(btn);
    }

    const head2 = document.createElement("div");
    head2.className = "pal-head";
    head2.textContent = "Connections";
    wrap.appendChild(head2);

    const laneBtn = document.createElement("button");
    laneBtn.className = "pal-item";
    laneBtn.type = "button";
    laneBtn.dataset.type = "lane";
    laneBtn.innerHTML =
      '<span class="pal-swatch" style="background:linear-gradient(90deg,#64748b,#0ea5e9)"></span>' +
      "<span>Draw lane</span><span class=\"pal-cat\">A &rarr; B</span>";
    laneBtn.addEventListener("click", () => setTool(state.tool === "lane" ? null : "lane"));
    attachTooltip(laneBtn, "Click site A, then site B. New lanes start as Full truckload; each lane's mode (FTL vs Parcel/LTL) is edited in its properties. Flow and direction appear after an evaluation.");
    wrap.appendChild(laneBtn);
  }

  function setTool(type) {
    state.tool = type;
    state.laneFrom = null;
    document.querySelectorAll(".pal-item").forEach((b) => {
      b.classList.toggle("active", b.dataset.type === type);
    });
    $("modeBadge").textContent =
      type === "lane" ? "Mode: Draw lane" : type ? "Mode: Placing " + SITE_TYPES[type].label : "Mode: Select";
    canvas.style.cursor = type ? "copy" : "crosshair";
    if (type === "lane") status("Click the first site of the lane.");
    else if (type) status(`Click the map to place a ${SITE_TYPES[type].label}. Esc to stop.`);
    render();
  }

  // ================================================================
  // PROPERTIES PANEL
  // ================================================================
  function renderProps() {
    const panel = $("propPanel");
    if (!state.selected) {
      panel.innerHTML = '<p class="empty">Select a site or a lane to edit it.</p>';
      return;
    }
    if (state.selected.kind === "site") {
      const s = E.siteById(state.design, state.selected.id);
      if (!s) { state.selected = null; renderProps(); return; }
      const def = SITE_TYPES[s.type];
      const rows = [];
      rows.push(row("Type", def.label));
      rows.push(row("Position", `${s.x * CELL_KM}, ${s.y * CELL_KM} km`));
      if (def.fixedCostWk) rows.push(row("Fixed cost", def.fixedCostWk.toLocaleString("en-US") + " EUR/wk (est.)"));
      if (def.handlingEurPerT) rows.push(row("Handling", def.handlingEurPerT + " EUR/t (est.)"));
      if (s.type === "zone") {
        rows.push(row("Demand", (s.demandMean || 0) + " t/wk mean"));
        rows.push(row("Variability", "CV " + (s.demandCv || 0) + " (seeded)"));
        const ze = zoneEval(s.id);
        if (ze) {
          rows.push(row("Served by", ze.served ? (ze.servedBy === "factory-direct" ? "factory (make-to-order)" : dcName(ze.servedBy)) : "NOT CONNECTED"));
          if (ze.served) {
            rows.push(row("Lead time", ze.leadDays.toFixed(2) + " days (target " + level().leadTargetDays + ")"));
            rows.push(row("Service", (ze.service * 100).toFixed(1) + "%"));
          }
        }
      }
      if (s.fixed) rows.push(row("Placement", "Fixed by the level"));

      let modeCtl = "";
      if (def.stocking) {
        modeCtl =
          '<div class="field" style="margin-top:10px"><label for="dcMode">Replenishment (push vs pull)</label>' +
          '<select id="dcMode">' +
          `<option value="pull"${s.mode !== "push" ? " selected" : ""}>Pull - reorder point, consumption-driven</option>` +
          `<option value="push"${s.mode === "push" ? " selected" : ""}>Push - forecast allocation, pre-positioned</option>` +
          "</select></div>" +
          '<p class="hint">Pull follows real demand (robust when volatile). Push pre-positions stock on a forecast - a touch better fill when demand is stable, overstocks when it swings. Both are heuristic models; see the docs.</p>';
        const de = state.lastEval && state.lastEval.dcs.find((x) => x.id === s.id);
        if (de && de.zonesServed > 0) {
          rows.push(row("Zones served", String(de.zonesServed)));
          rows.push(row("Safety stock", de.safetyStockT + " t (z·√LT·σ pooled)"));
          rows.push(row("Cycle stock", de.cycleStockT + " t"));
          rows.push(row("Holding", de.holdingCostWk.toLocaleString("en-US") + " EUR/wk (est.)"));
          rows.push(row("Fill rate", (de.fill * 100).toFixed(1) + "%"));
        }
      }

      panel.innerHTML =
        rows.join("") +
        `<p class="prop-desc">${def.desc}</p>` +
        modeCtl +
        '<div class="prop-actions">' +
        (s.fixed
          ? '<button class="btn" type="button" disabled title="Fixed by the level">Fixed</button>'
          : '<button id="deleteBtn" class="btn danger" type="button">Delete</button>') +
        "</div>";
      if (def.stocking) {
        $("dcMode").addEventListener("change", (e) => {
          s.mode = e.target.value === "push" ? "push" : "pull";
          afterMutate();
          status(def.label + " switched to " + s.mode.toUpperCase() + " - re-evaluate to see the effect.");
        });
      }
      if (!s.fixed) $("deleteBtn").addEventListener("click", deleteSelected);
    } else {
      const lane = state.design.lanes.find((l) => l.id === state.selected.id);
      if (!lane) { state.selected = null; renderProps(); return; }
      const a = E.siteById(state.design, lane.a);
      const b = E.siteById(state.design, lane.b);
      const info = laneInfo(lane.id);
      const m = MODES[lane.mode];
      const rows = [];
      rows.push(row("Lane", esc(siteName(a)) + " &harr; " + esc(siteName(b))));
      rows.push(row("Distance", Math.round(E.distKm(a, b)) + " km"));
      if (info) {
        rows.push(row("Flow", info.flowTWk + " t/wk"));
        if (lane.mode === "ftl") {
          rows.push(row("Trucks", info.trucksWk + " /wk · " + Math.round(info.utilization * 100) + "% full"));
        }
        rows.push(row("Cost", info.costWk.toLocaleString("en-US") + " EUR/wk (est.)"));
        rows.push(row("CO2", info.co2Kg.toLocaleString("en-US") + " kg/wk (estimate)"));
      } else {
        rows.push(row("Flow", "evaluate to see"));
      }
      panel.innerHTML =
        rows.join("") +
        '<div class="field" style="margin-top:10px"><label for="laneMode">Transport mode</label>' +
        '<select id="laneMode">' +
        `<option value="ftl"${lane.mode === "ftl" ? " selected" : ""}>${MODES.ftl.label}</option>` +
        `<option value="parcel"${lane.mode === "parcel" ? " selected" : ""}>${MODES.parcel.label}</option>` +
        "</select></div>" +
        `<p class="prop-desc">${m.desc}</p>` +
        '<div class="prop-actions"><button id="deleteBtn" class="btn danger" type="button">Delete lane</button></div>';
      $("laneMode").addEventListener("change", (e) => {
        lane.mode = MODES[e.target.value] ? e.target.value : "ftl";
        afterMutate();
        status("Lane switched to " + MODES[lane.mode].label + " - re-evaluate to see the cost shift.");
      });
      $("deleteBtn").addEventListener("click", deleteSelected);
    }
  }

  function row(k, v) {
    return `<div class="prop-row"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  }

  function dcName(id) {
    const s = E.siteById(state.design, id);
    return s ? SITE_TYPES[s.type].label + " (" + (s.mode === "push" ? "push" : "pull") + ")" : id;
  }

  function esc(str) {
    return String(str).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  // ================================================================
  // EVALUATION + SCORE PANEL
  // ================================================================
  function runEvaluate() {
    state.lastEval = E.evaluate(state.design);
    renderScore(state.lastEval);
    renderProps();
    render();
    updateBadges();
    recordBest(state.lastEval);
    const t = state.lastEval.totals;
    status(
      "Evaluated (seed " + state.lastEval.seed + "): " + t.totalCostWk.toLocaleString("en-US") +
      " EUR/wk, service " + (t.serviceLevel * 100).toFixed(1) + "%, CO2 est. " +
      t.co2KgWk.toLocaleString("en-US") + " kg/wk. Same design -> same numbers."
    );
  }

  function starSVG(on) {
    return (
      `<svg class="star-glyph${on ? "" : " off"}" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">` +
      '<path d="M12 2.6 l2.8 5.9 6.4 0.8 -4.7 4.4 1.2 6.3 -5.7 -3.1 -5.7 3.1 1.2 -6.3 -4.7 -4.4 6.4 -0.8 z" fill="currentColor"/></svg>'
    );
  }

  function renderScore(res) {
    const s = res.score, t = res.totals, lv = level();
    let stars = "";
    for (let i = 0; i < 5; i++) stars += starSVG(i < s.stars);
    const wb = (cls, name, weight, val) =>
      `<div class="wbar ${cls}"><span class="wk"><b>${name}</b> · weight ${Math.round(weight * 100)}%</span>` +
      `<span class="track"><span class="fillbar" style="width:${Math.max(2, val)}%"></span></span>` +
      `<span class="wv">${val}</span></div>`;
    const checks = s.checks
      .map((c) =>
        `<div class="chk ${c.ok ? "ok" : "fail"}"><span class="c-mark">${c.ok ? "&#10003;" : "&#10007;"}</span>` +
        `<span class="c-label">${c.label}</span>` +
        `<span class="c-num">${c.actual.toLocaleString("en-US")} ${c.cmp === "<=" ? "&le;" : "&ge;"} ${c.limit.toLocaleString("en-US")} ${c.unit}</span></div>`)
      .join("");
    const kpis = [
      kcard("Total cost", t.totalCostWk.toLocaleString("en-US"), "EUR/wk (est.)"),
      kcard("Service level", (t.serviceLevel * 100).toFixed(1), "% of demand"),
      kcard("Transport", t.transportCostWk.toLocaleString("en-US"), "EUR/wk"),
      kcard("Facilities", (t.facilityFixedWk + t.handlingCostWk).toLocaleString("en-US"), "EUR/wk fixed+handling"),
      kcard("Holding", t.holdingCostWk.toLocaleString("en-US"), "EUR/wk (safety+cycle)"),
      kcard("CO2 estimate", t.co2KgWk.toLocaleString("en-US"), "kg/wk"),
    ].join("");
    $("scoreOut").innerHTML =
      '<div class="score-head">' +
      `<div><div class="score-big">${s.total}<span class="of"> /100</span></div><div class="score-stars">${stars}</div></div>` +
      `<span class="score-pass ${s.pass ? "ok" : "fail"}">${s.pass ? "Level passed" : "Not passed yet"}</span>` +
      "</div>" +
      `<div class="wbars">${wb("cost", "Cost", s.weights.cost, s.cost)}${wb("svc", "Service", s.weights.service, s.service)}${wb("co2", "CO2", s.weights.co2, s.co2)}</div>` +
      `<div class="chk-list">${checks}</div>` +
      `<div class="kpi">${kpis}` +
      `<p class="kpi-note">Level ${lv.id} seed ${res.seed} · lead-time target ${lv.leadTargetDays} days. ${esc(res.assumptions)}</p>` +
      "</div>";
  }

  function kcard(label, value, unit) {
    return (
      '<div class="kpi-card">' +
      `<div class="kpi-label">${label}</div>` +
      `<div class="kpi-value">${value} <span class="kpi-unit">${unit}</span></div>` +
      "</div>"
    );
  }

  // best score per level (localStorage; shown in the level list)
  function bestKey(id) { return "lsp.best.v1." + id; }
  function recordBest(res) {
    try {
      const prev = JSON.parse(localStorage.getItem(bestKey(state.levelId)) || "null");
      if (!prev || res.score.total > prev.score || (res.score.pass && !prev.pass)) {
        localStorage.setItem(bestKey(state.levelId), JSON.stringify({ score: res.score.total, stars: res.score.stars, pass: res.score.pass }));
        buildLevels();
        if (!prev || res.score.total > prev.score) toast("New best for " + state.levelId + ": " + res.score.total + "/100");
      }
    } catch (_) {}
  }

  // ================================================================
  // LEVELS
  // ================================================================
  function buildLevels() {
    const caps = WT.tiers.caps();
    const wrap = $("levelList");
    wrap.innerHTML = "";
    for (const lv of E.LEVELS) {
      const allowed = caps.lspLevelAllowed(lv.id);
      const btn = document.createElement("button");
      btn.className = "lvl-item" + (lv.id === state.levelId ? " active" : "") + (allowed ? "" : " locked");
      btn.type = "button";
      let best = null;
      try { best = JSON.parse(localStorage.getItem(bestKey(lv.id)) || "null"); } catch (_) {}
      const bestTxt = best
        ? `<span class="lvl-best${best.pass ? " passed" : ""}">${best.pass ? "&#10003; " : ""}${best.score}</span>`
        : "";
      btn.innerHTML =
        `<span class="lvl-id">${lv.id}</span><span class="lvl-name">${lv.name}</span>` +
        (allowed ? bestTxt : WT.tiers.padlockSVG());
      if (allowed) {
        btn.addEventListener("click", () => setLevel(lv.id));
        attachTooltip(btn, lv.goal);
      } else {
        btn.setAttribute("aria-disabled", "true");
        btn.addEventListener("click", () => toast(caps.lockHint("Level " + lv.id + " (" + lv.name + ")"), "warn"));
        attachTooltip(btn, "Full version: " + lv.goal);
      }
      wrap.appendChild(btn);
    }
    renderLevelGoal();
  }

  function renderLevelGoal() {
    const lv = level();
    $("levelGoal").innerHTML =
      `<p class="lvl-goal-text"><strong>${lv.id} · ${lv.name}.</strong> ${lv.goal}</p>` +
      '<div class="lvl-thresholds">' +
      `<span class="lvl-th">cost &le; ${lv.budgetCostWk.toLocaleString("en-US")} EUR/wk</span>` +
      `<span class="lvl-th">service &ge; ${Math.round(lv.minService * 100)}%</span>` +
      `<span class="lvl-th">CO2 &le; ${lv.budgetCo2KgWk.toLocaleString("en-US")} kg/wk</span>` +
      `<span class="lvl-th">lead &le; ${lv.leadTargetDays} d</span>` +
      "</div>" +
      `<p class="lvl-lesson">${lv.lesson}</p>`;
  }

  function setLevel(id, opts) {
    const caps = WT.tiers.caps();
    if (!caps.lspLevelAllowed(id)) {
      toast(caps.lockHint("Level " + id), "warn");
      return;
    }
    if (state.design) saveNow(true);
    state.levelId = id;
    state.selected = null;
    state.laneFrom = null;
    state.tool = null;
    state.lastEval = null;
    state.snapshotA = null;
    $("abOut").innerHTML = '<p class="empty">Save a design as A first, then compare.</p>';
    $("advisorOut").innerHTML = '<p class="empty">Run an analysis to see the top ranked hints.</p>';
    $("scoreOut").innerHTML = '<p class="empty">Evaluate to see your score, the pass checks and the cost breakdown.</p>';
    if (!(opts && opts.keepDesign) && !loadSaved(true)) {
      state.design = E.newDesign(id);
    }
    try { localStorage.setItem("lsp.level.v1", id); } catch (_) {}
    buildLevels();
    buildPalette();
    setTool(null);
    renderProps();
    render();
    updateBadges();
    status("Level " + id + " - " + level().goal);
  }

  // ================================================================
  // ADVISOR
  // ================================================================
  function runAdvisor() {
    const caps = WT.tiers.caps();
    const hints = E.advise(state.design);
    const out = $("advisorOut");
    if (!hints.length) {
      out.innerHTML = '<p class="empty">No findings - place sites and lanes first.</p>';
      return;
    }
    const shown = hints.slice(0, caps.advisorLimit === Infinity ? hints.length : caps.advisorLimit);
    let html = shown
      .map((h) =>
        `<div class="adv-item ${h.severity}">` +
        `<div class="adv-head"><span class="adv-dot"></span><span class="adv-finding">${esc(h.finding)}</span></div>` +
        `<div class="adv-line"><span class="adv-k">Principle</span>${esc(h.principle)}</div>` +
        `<div class="adv-line"><span class="adv-k">Impact</span>${esc(h.impact)}</div>` +
        "</div>")
      .join("");
    if (hints.length > shown.length) {
      html +=
        '<div class="adv-locked">' + WT.tiers.padlockSVG() + " " +
        (hints.length - shown.length) + " more hint" + (hints.length - shown.length > 1 ? "s are" : " is") +
        " part of the full version.</div>";
    }
    out.innerHTML = html;
    status("Advisor ran " + hints.length + " heuristic rules (each names its principle; impacts measured with the same deterministic evaluation).");
  }

  // ================================================================
  // A/B COMPARE
  // ================================================================
  function snapshotA() {
    state.snapshotA = {
      design: JSON.parse(JSON.stringify(state.design)),
      eval: E.evaluate(state.design),
    };
    $("abOut").innerHTML = '<p class="empty">Design A frozen (score ' + state.snapshotA.eval.score.total + '). Edit the network, then Compare.</p>';
    toast("Saved the current design as A.");
  }

  function runCompare() {
    if (!state.snapshotA) { toast("Save a design as A first.", "warn"); return; }
    const A = state.snapshotA.eval;
    const B = E.evaluate(state.design);
    state.lastEval = B;
    renderScore(B);
    render();
    updateBadges();
    const rows = [
      ["Total cost (EUR/wk)", A.totals.totalCostWk, B.totals.totalCostWk, true],
      ["Service level (%)", Math.round(A.totals.serviceLevel * 1000) / 10, Math.round(B.totals.serviceLevel * 1000) / 10, false],
      ["CO2 estimate (kg/wk)", A.totals.co2KgWk, B.totals.co2KgWk, true],
      ["Score (/100)", A.score.total, B.score.total, false],
    ];
    const tr = rows
      .map(([k, a, b, lowerBetter]) => {
        const aWin = lowerBetter ? a < b : a > b;
        const bWin = lowerBetter ? b < a : b > a;
        return `<tr><td class="ab-k">${k}</td><td class="${aWin ? "win" : ""}">${a.toLocaleString("en-US")}</td><td class="${bWin ? "win" : ""}">${b.toLocaleString("en-US")}</td></tr>`;
      })
      .join("");
    let verdict;
    const d = B.score.total - A.score.total;
    if (d > 0) verdict = "B (current) wins by " + d + " point" + (d > 1 ? "s" : "") + ".";
    else if (d < 0) verdict = "A (saved) wins by " + -d + " point" + (d < -1 ? "s" : "") + " - consider reverting your changes.";
    else verdict = "Dead heat - same score at the same seed.";
    const drivers = [
      ["cost", (B.score.cost - A.score.cost) * B.score.weights.cost],
      ["service", (B.score.service - A.score.service) * B.score.weights.service],
      ["CO2", (B.score.co2 - A.score.co2) * B.score.weights.co2],
    ].sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]));
    if (Math.abs(drivers[0][1]) >= 0.5) {
      verdict += " Biggest driver: " + drivers[0][0] + " (" + (drivers[0][1] > 0 ? "+" : "") + drivers[0][1].toFixed(1) + " weighted points).";
    }
    $("abOut").innerHTML =
      '<table class="ab-table"><thead><tr><th></th><th>A (saved)</th><th>B (current)</th></tr></thead>' +
      `<tbody>${tr}</tbody></table>` +
      `<div class="ab-rec">${verdict} Deterministic: both ran at seed ${B.seed}.</div>`;
  }

  // ================================================================
  // PERSISTENCE (per-level localStorage + JSON export/import)
  // ================================================================
  function lsKey(id) { return "lsp.design.v1." + id; }
  let saveTimer = null;

  function serialize() {
    return {
      version: "lsp-1",
      app: "lsp-planner",
      levelId: state.levelId,
      idCounter: state.design.idCounter,
      sites: state.design.sites.map((s) => Object.assign({}, s)),
      lanes: state.design.lanes.map((l) => Object.assign({}, l)),
      savedAt: new Date().toISOString(),
    };
  }

  // Rebuild a trustworthy design from imported/saved JSON: level-fixed
  // sites always come fresh from the level definition (seeded demand
  // can't be tampered into a better score), user sites/lanes are
  // validated and clamped.
  function sanitizeDesign(obj) {
    if (!obj || obj.version !== "lsp-1" || !E.levelById(obj.levelId)) throw new Error("Not an LSP Planner design");
    const fresh = E.newDesign(obj.levelId);
    const freshFixedIds = new Set(fresh.sites.map((s) => s.id));
    const ids = new Set(freshFixedIds);
    let maxId = fresh.idCounter;
    const sitesIn = Array.isArray(obj.sites) ? obj.sites : [];
    for (const raw of sitesIn) {
      if (!raw || !SITE_TYPES[raw.type] || typeof raw.id !== "string") continue;
      if (freshFixedIds.has(raw.id)) {
        // level-fixed site: only its DC mode may carry over (it can't -
        // fixed sites are factory/zones - but stay defensive)
        const f = fresh.sites.find((s) => s.id === raw.id);
        if (f && SITE_TYPES[f.type].stocking) f.mode = raw.mode === "push" ? "push" : "pull";
        continue;
      }
      if (ids.has(raw.id)) continue;
      const site = {
        id: raw.id,
        type: raw.type,
        x: clampInt(raw.x, 2, GRID_W - 2, 10),
        y: clampInt(raw.y, 2, GRID_H - 2, 10),
      };
      if (SITE_TYPES[raw.type].stocking) site.mode = raw.mode === "push" ? "push" : "pull";
      if (raw.type === "zone") {
        site.demandMean = clampInt(raw.demandMean, 1, 500, 20);
        site.demandCv = Math.max(0, Math.min(2, Number(raw.demandCv) || 0.3));
        site.label = typeof raw.label === "string" ? raw.label.slice(0, 24) : "Zone";
      }
      fresh.sites.push(site);
      ids.add(site.id);
      const n = parseInt(String(site.id).replace(/\D/g, ""), 10);
      if (!isNaN(n)) maxId = Math.max(maxId, n);
    }
    const lanesIn = Array.isArray(obj.lanes) ? obj.lanes : [];
    for (const raw of lanesIn) {
      if (!raw || typeof raw.a !== "string" || typeof raw.b !== "string") continue;
      if (!ids.has(raw.a) || !ids.has(raw.b) || raw.a === raw.b) continue;
      const lane = E.addLane(fresh, raw.a, raw.b, MODES[raw.mode] ? raw.mode : "ftl");
      if (lane) lane.mode = MODES[raw.mode] ? raw.mode : "ftl";
      const n = parseInt(String(raw.id || "").replace(/\D/g, ""), 10);
      if (!isNaN(n)) maxId = Math.max(maxId, n);
    }
    fresh.idCounter = Math.max(fresh.idCounter, maxId);
    return fresh;
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(lsKey(state.levelId), JSON.stringify(serialize())); } catch (_) {}
    }, 350);
  }

  function saveNow(silent) {
    try {
      localStorage.setItem(lsKey(state.levelId), JSON.stringify(serialize()));
      if (!silent) toast("Design saved to this browser.");
    } catch (_) {
      if (!silent) toast("Could not save (storage blocked).", "err");
    }
  }

  function loadSaved(silent) {
    try {
      const raw = localStorage.getItem(lsKey(state.levelId));
      if (!raw) { if (!silent) toast("No saved design for this level.", "warn"); return false; }
      state.design = sanitizeDesign(JSON.parse(raw));
      state.selected = null;
      invalidateEval();
      renderProps();
      render();
      updateBadges();
      if (!silent) status("Loaded the saved design for " + state.levelId + ".");
      return true;
    } catch (_) {
      if (!silent) toast("Saved design was unreadable.", "err");
      return false;
    }
  }

  function exportJSON() {
    const blob = new Blob([JSON.stringify(serialize(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "lsp-planner-" + state.levelId.toLowerCase() + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("Exported " + a.download);
  }

  function importJSON(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const obj = JSON.parse(String(reader.result));
        const caps = WT.tiers.caps();
        if (!E.levelById(obj.levelId)) throw new Error("unknown level");
        if (!caps.lspLevelAllowed(obj.levelId)) {
          toast(caps.lockHint("Level " + obj.levelId), "warn");
          return;
        }
        const design = sanitizeDesign(obj);
        state.design = design;
        if (obj.levelId !== state.levelId) {
          state.levelId = obj.levelId;
          setLevel(obj.levelId, { keepDesign: true });
        } else {
          state.selected = null;
          invalidateEval();
          renderProps();
          render();
          updateBadges();
        }
        scheduleSave();
        toast("Imported " + file.name);
      } catch (err) {
        toast("Import failed: " + err.message, "err");
      }
    };
    reader.onerror = () => toast("Could not read the file.", "err");
    reader.readAsText(file);
  }

  function clearDesign() {
    state.design = E.newDesign(state.levelId); // level sites stay, additions go
    state.selected = null;
    afterMutate();
    status("Cleared - the level's factory and zones are back to the seeded baseline.");
  }

  function loadStarter() {
    state.design = E.referenceDesign(state.levelId);
    state.selected = null;
    afterMutate();
    status("Loaded the starter network - a sensible (not optimal) design. Evaluate it, then beat it.");
  }

  // ================================================================
  // ONBOARDING, TOOLTIPS, TOAST, STATUS
  // ================================================================
  const OB_KEY = "lsp.onboarded.v1";
  function maybeShowOnboard() {
    try { if (localStorage.getItem(OB_KEY) === "1") return; } catch (_) {}
    $("onboard").hidden = false;
  }
  function closeOnboard() {
    if ($("onboardDont").checked) {
      try { localStorage.setItem(OB_KEY, "1"); } catch (_) {}
    }
    $("onboard").hidden = true;
  }

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
  // TIER GATE UI (shared ../tiers.js - see its honesty note)
  // ================================================================
  function updateTierUI() {
    const caps = WT.tiers.caps();
    const badge = $("tierBadge");
    const btn = $("tierBtn");
    badge.textContent = caps.label + " version";
    badge.className = "badge tier-badge" + (caps.isDemo ? "" : " full");
    btn.textContent = caps.isDemo ? "Unlock full version" : "Switch to demo";
  }

  function applyTier() {
    const caps = WT.tiers.caps();
    if (!caps.lspLevelAllowed(state.levelId)) {
      toast("Level " + state.levelId + " is a full-version level - back to L1.", "warn");
      setLevel("L1");
    }
    buildLevels();
    updateTierUI();
  }

  function toggleTier() {
    const next = WT.tiers.current() === "demo" ? "full" : "demo";
    WT.tiers.setTier(next);
    applyTier();
    toast(
      next === "full"
        ? "Full version unlocked - all five levels. (Local showcase switch; see README.)"
        : "Switched to the demo tier - levels L3+ show a padlock."
    );
  }

  // ================================================================
  // PWA glue (same service worker + cache as the main app)
  // ================================================================
  function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    if (location.protocol !== "http:" && location.protocol !== "https:") return; // no SW over file://
    navigator.serviceWorker.register("../sw.js").catch(() => {});
  }

  // ================================================================
  // WIRE-UP + BOOT
  // ================================================================
  function wireButtons() {
    $("saveBtn").addEventListener("click", () => saveNow(false));
    $("loadBtn").addEventListener("click", () => loadSaved(false));
    $("exportBtn").addEventListener("click", exportJSON);
    $("importBtn").addEventListener("click", () => $("importInput").click());
    $("importInput").addEventListener("change", (e) => { if (e.target.files[0]) importJSON(e.target.files[0]); e.target.value = ""; });
    $("clearBtn").addEventListener("click", clearDesign);
    $("refBtn").addEventListener("click", loadStarter);
    $("evalBtn").addEventListener("click", runEvaluate);
    $("adviseBtn").addEventListener("click", runAdvisor);
    $("snapBtn").addEventListener("click", snapshotA);
    $("compareBtn").addEventListener("click", runCompare);
    $("tierBtn").addEventListener("click", toggleTier);
    $("helpBtn").addEventListener("click", () => { $("onboard").hidden = false; });
    $("onboardClose").addEventListener("click", closeOnboard);
    attachTooltip($("refBtn"), "Loads the reference network the level budget was calibrated against - sensible, not optimal. Beat its score.");
  }

  function boot() {
    // restore the last level (tier-checked), then its saved design
    let last = "L1";
    try { last = localStorage.getItem("lsp.level.v1") || "L1"; } catch (_) {}
    if (!E.levelById(last) || !WT.tiers.caps().lspLevelAllowed(last)) last = "L1";
    state.levelId = last;
    if (!loadSaved(true)) state.design = E.newDesign(state.levelId);

    buildLevels();
    buildPalette();
    wireButtons();
    updateTierUI();
    resizeCanvas();
    renderProps();
    updateBadges();
    maybeShowOnboard();
    registerSW();
    status("Level " + state.levelId + " - " + level().goal);

    window.addEventListener("resize", resizeCanvas);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    (mq.addEventListener ? mq.addEventListener.bind(mq, "change") : mq.addListener.bind(mq))(() => {
      COLORS = themeColors();
      render();
    });
  }

  function clampInt(v, lo, hi, dflt) {
    let n = Math.round(Number(v));
    if (isNaN(n)) n = dflt !== undefined ? dflt : lo;
    return Math.max(lo, Math.min(hi, n));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
