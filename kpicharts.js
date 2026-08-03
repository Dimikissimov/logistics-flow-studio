/* =====================================================================
 * Logistics Flow Studio - WarehouseTwin
 * kpicharts.js - Live KPI dashboard (P3.1)
 * ---------------------------------------------------------------------
 * A small, dependency-free CHART layer that turns the live material-flow
 * state (WT.flowsim) + the WMS operations heuristic (WT.wms) into a
 * compact "plant-sim cockpit" strip: a throughput-over-time chart, the
 * seven-stage load-vs-capacity bars with the bottleneck flagged, and an
 * in-flight vs shipped readout. It is meant to update in real time while
 * the flow animation plays, driven from the SAME requestAnimationFrame
 * loop that advances flowsim (kpicharts adds NO loop of its own).
 *
 * Two layers, deliberately split so the honest/labelling logic is
 * headlessly testable (the DOM canvas draw is not):
 *
 *   series(state, opts)  -> PURE chart-ready data (numbers + labels +
 *                           0-based scales). Deterministic given its
 *                           inputs; no DOM, no Date, no Math.random.
 *   layout(data, dims)   -> PURE geometry model (bar/point pixel rects,
 *                           axis ticks, labels). No canvas; verifiable.
 *   drawDashboard(t,d,o) -> paints layout()'s model onto a 2D canvas.
 *
 * HONESTY (load-bearing, mirrored in the UI + README):
 *   - EVERYTHING here is SYNTHETIC and derived, not measured. The numbers
 *     come from the documented WT.wms heuristic (order-of-magnitude
 *     teaching assumptions) and the WT.flowsim animation counters.
 *   - KPIs are grounded in ISO 22400 / a heuristic model - NOT measured
 *     and NOT a certification.
 *   - The charts are drawn HONESTLY: every bar starts at ZERO (no
 *     truncated axes), scales are labelled, the categorical palette is
 *     colourblind-safe (Okabe-Ito-derived, validated) and every bar is
 *     directly labelled so identity/value never rely on colour alone.
 *     The bottleneck carries a text tag + a hatch, not just a hue.
 *   - Works in the app's LIGHT and DARK themes (token sets that mirror
 *     the app's own CSS variables), passed in per draw.
 *
 * Classic script attaching to the global `WT` namespace (works from
 * file:// too). Optional deps: WT.flowsim (state shape) and WT.wms (stage
 * ids/labels). No frameworks, no build step, fully offline.
 * ===================================================================== */
(function () {
  "use strict";
  const WT = (window.WT = window.WT || {});

  const SYNTHETIC_LABEL =
    "SYNTHETIC live KPI dashboard - derived from the WT.flowsim animation " +
    "counters and the documented WT.wms throughput heuristic (order-of-" +
    "magnitude teaching assumptions). Grounded in ISO 22400 / a heuristic " +
    "model; NOT measured from a real site and NOT a certification. Charts " +
    "are 0-based and honestly scaled.";

  /* ------------------------------------------------------------------
   * Colourblind-safe CATEGORICAL palette (Okabe-Ito-derived, validated
   * with the dataviz palette checker against the app's light/dark chart
   * surfaces: passes the lightness band, chroma floor, adjacent-pair CVD
   * separation and normal-vision floor in BOTH modes). Seven slots for
   * the seven WMS stages, stepped per mode for its surface. Identity is
   * ALSO carried by a direct text label on every bar, so a sub-3:1 light
   * hue never has to carry meaning by colour alone.
   * ------------------------------------------------------------------ */
  const PALETTE = {
    light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7"],
    dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9"],
  };

  /* ------------------------------------------------------------------
   * Theme token sets. These MIRROR the app's own CSS variables (styles.css
   * :root and the prefers-color-scheme: dark block) so the cockpit matches
   * whatever theme the page is in. The canvas cannot read CSS vars, so the
   * app passes the theme name (or an override object) into drawDashboard.
   * ------------------------------------------------------------------ */
  const THEMES = {
    light: {
      surface: "#f8fafc", // --surface-2
      surfaceAlt: "#ffffff", // --surface
      ink: "#0f172a", // --text
      sub: "#475569", // --text-dim
      muted: "#64748b", // axis/label muted
      grid: "#e2e8f0", // --border (hairline gridlines)
      axis: "#cbd5e1", // baseline / axis
      track: "#eef2f7", // unfilled bar track
      accent: "#0d9488", // throughput series (matches the flow teal)
      good: "#16a34a", // --ok
      warn: "#d97706", // --warn
      crit: "#dc2626", // --danger (bottleneck)
    },
    dark: {
      surface: "#111c31", // --surface-2
      surfaceAlt: "#0f172a", // --surface
      ink: "#e2e8f0", // --text
      sub: "#94a3b8", // --text-dim
      muted: "#94a3b8",
      grid: "#1e293b", // --border
      axis: "#2b3d5c", // baseline / axis
      track: "#0c1524", // unfilled bar track
      accent: "#2dd4bf", // throughput series
      good: "#4ade80", // --ok
      warn: "#fbbf24", // --warn
      crit: "#f87171", // --danger (bottleneck)
    },
  };

  // Resolve a theme argument (name string or override object) to a token
  // set + the matching categorical palette + mode name.
  function resolveTheme(theme) {
    let mode = "light";
    let base = THEMES.light;
    let override = null;
    if (typeof theme === "string") {
      mode = theme === "dark" ? "dark" : "light";
      base = THEMES[mode];
    } else if (theme && typeof theme === "object") {
      mode = theme.dark === true || theme.mode === "dark" ? "dark" : (theme.mode === "light" ? "light" : "light");
      base = THEMES[mode];
      override = theme.tokens || theme;
    }
    const tokens = override ? Object.assign({}, base, override) : Object.assign({}, base);
    return { mode: mode, tokens: tokens, palette: PALETTE[mode] };
  }

  /* ------------------------------------------------------------------
   * Small pure numeric helpers.
   * ------------------------------------------------------------------ */
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  function finiteOr(v, d) { return typeof v === "number" && isFinite(v) ? v : d; }

  // A "nice" ceiling for a y-axis top so ticks land on clean numbers.
  function niceCeil(v) {
    if (!(v > 0)) return 1;
    const pow = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / pow;
    const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return step * pow;
  }

  /* ==================================================================
   * series(state, opts) -> PURE chart-ready data.
   * ------------------------------------------------------------------
   * state : a WT.flowsim state (has .plan.caps/.capByStage/.lineThroughput,
   *         .tick, .spawned, .completed, .inflight, .perStage).
   * opts  :
   *   history            : optional [{tick, completed}] samples, oldest ->
   *                        newest, NOT including the current state. The app
   *                        threads its throttled ring buffer here.
   *   baselineCompleted  : completed count just before the first history
   *                        sample (default 0). Lets a windowed history keep
   *                        its per-bucket deltas honest without a giant
   *                        first bar. With the default 0 + a full history,
   *                        the buckets telescope from 0 so they SUM EXACTLY
   *                        to state.completed.
   *   playing            : optional bool, carried through for the caption.
   *
   * Determinism: pure function of (state, opts). Same inputs -> identical
   * output (verified in verify_kpicharts.js).
   * ================================================================== */
  function series(state, opts) {
    const o = opts || {};
    const ok = !!(state && state.kind === "wt-flowsim-state" && state.plan);
    const plan = ok ? state.plan : null;

    // ---- Throughput over time: completed units per interval ----------
    const hist = Array.isArray(o.history) ? o.history : [];
    const curTick = ok ? state.tick : 0;
    const curCompleted = ok ? state.completed : 0;
    // Build the sample list (history + current), then diff cumulative
    // completions into per-interval, non-negative buckets.
    const samples = [];
    for (const h of hist) {
      if (h && typeof h.completed === "number") samples.push({ tick: finiteOr(h.tick, 0), completed: Math.max(0, h.completed) });
    }
    // Append the current snapshot if it advances past the last sample.
    const last = samples[samples.length - 1];
    if (!last || curTick > last.tick || curCompleted !== last.completed) {
      samples.push({ tick: curTick, completed: curCompleted });
    }
    let prev = Math.max(0, finiteOr(o.baselineCompleted, 0));
    const buckets = [];
    let windowUnits = 0;
    for (const s of samples) {
      const units = Math.max(0, s.completed - prev); // monotonic -> >= 0
      buckets.push({ tick: s.tick, units: units });
      windowUnits += units;
      prev = s.completed;
    }
    const maxBucket = buckets.reduce((m, b) => (b.units > m ? b.units : m), 0);
    const throughput = {
      buckets: buckets,
      total: curCompleted, // cumulative completed (the whole run)
      windowUnits: windowUnits, // sum of the displayed buckets
      unit: "units / interval",
      scale: { min: 0, max: niceCeil(maxBucket) }, // 0-based, honest
    };

    // ---- Per-stage load vs capacity (the seven WMS stages) -----------
    // Source: the plan's WMS capacities (units/hr). The live line runs at
    // the bottleneck rate (plan.lineThroughput), so each stage's honest
    // "load" is the share of its capacity that rate consumes. The stage at
    // ~100% is the bottleneck (lowest capacity) - matching WT.wms.
    const lineThroughput = ok ? finiteOr(plan.lineThroughput, 0) : 0;
    let capList = [];
    if (ok && Array.isArray(plan.caps) && plan.caps.length) {
      capList = plan.caps.map((c) => ({ id: c.id, label: c.label || c.id, capacity: finiteOr(c.capacityUnitsPerHr, 0) }));
    } else if (ok && plan.capByStage) {
      const order = (WT.wms && WT.wms.STAGES) ? WT.wms.STAGES : Object.keys(plan.capByStage).map((id) => ({ id: id, label: id }));
      capList = order.map((s) => ({ id: s.id, label: s.label || s.id, capacity: finiteOr(plan.capByStage[s.id], 0) }));
    }
    // Bottleneck = lowest positive capacity (ties -> first index), the same
    // rule WT.wms uses to cap the line.
    let bnIdx = -1;
    let bnCap = Infinity;
    for (let i = 0; i < capList.length; i++) {
      const c = capList[i].capacity;
      if (c > 0 && c < bnCap - 1e-9) { bnCap = c; bnIdx = i; }
    }
    if (bnIdx < 0 && capList.length) bnIdx = 0;
    const stages = capList.map((c, i) => {
      const util = c.capacity > 0 ? clamp01(lineThroughput / c.capacity) : 0;
      return {
        id: c.id,
        label: c.label,
        capacityUnitsPerHr: c.capacity,
        util: util, // 0..1 share of capacity the live line consumes
        pct: Math.round(util * 100),
        isBottleneck: i === bnIdx,
      };
    });
    const utilisation = {
      stages: stages,
      lineThroughput: lineThroughput,
      unit: "load vs capacity",
      scale: { min: 0, max: 1 }, // 0-based, honest (share of capacity)
      bottleneck: bnIdx >= 0 && stages[bnIdx]
        ? { index: bnIdx, id: stages[bnIdx].id, label: stages[bnIdx].label, capacityUnitsPerHr: stages[bnIdx].capacityUnitsPerHr }
        : null,
    };

    // ---- In-flight vs shipped (completed) readout --------------------
    const inflight = ok ? finiteOr(state.inflight, 0) : 0;
    const completed = curCompleted;
    const spawned = ok ? finiteOr(state.spawned, 0) : 0;
    const denom = inflight + completed;
    const flow = {
      inflight: inflight,
      completed: completed,
      spawned: spawned,
      tick: curTick,
      perStage: ok && state.perStage ? Object.assign({}, state.perStage) : {},
      inflightShare: denom > 0 ? inflight / denom : 0,
      completedShare: denom > 0 ? completed / denom : 0,
    };

    return {
      kind: "wt-kpicharts-series",
      ok: ok,
      synthetic: true,
      label: SYNTHETIC_LABEL,
      playing: !!o.playing,
      throughput: throughput,
      utilisation: utilisation,
      flow: flow,
    };
  }

  /* ==================================================================
   * layout(data, dims) -> PURE geometry model (no canvas).
   * ------------------------------------------------------------------
   * dims : { width, height, theme, pad?, labelCol? }
   * Returns pixel rects/points/ticks + resolved colours so drawDashboard
   * (or a test) can render/inspect it. Crucially the geometry is HONEST:
   *   - every utilisation bar starts at the same value-0 baseline x
   *     (barX0); a util of 0 yields width 0.
   *   - the throughput baseline is the value-0 y (zeroY at the plot floor).
   * ================================================================== */
  function layout(data, dims) {
    const d = dims || {};
    const W = Math.max(200, finiteOr(d.width, 320));
    const H = Math.max(200, finiteOr(d.height, 320));
    const th = resolveTheme(d.theme);
    const tokens = th.tokens;
    const palette = th.palette;
    const p = finiteOr(d.pad, 12);
    const innerW = W - 2 * p;

    const model = {
      width: W, height: H, mode: th.mode, tokens: tokens, palette: palette,
      synthetic: true, label: (data && data.label) || SYNTHETIC_LABEL,
    };

    // ---- Header: title + three KPI tiles + a proportion bar ----------
    const flow = (data && data.flow) || { inflight: 0, completed: 0, spawned: 0, tick: 0 };
    const tp = (data && data.throughput) || { buckets: [], total: 0, scale: { min: 0, max: 1 } };
    const nowRate = tp.buckets && tp.buckets.length ? tp.buckets[tp.buckets.length - 1].units : 0;
    const tiles = [
      { label: "In-flight", value: Math.round(flow.inflight), unit: "MUs", color: tokens.accent },
      { label: "Shipped", value: Math.round(flow.completed), unit: "units", color: tokens.good },
      { label: "Throughput", value: Math.round(nowRate), unit: "/ interval", color: tokens.accent },
    ];
    const headTop = p;
    const tileY = headTop + 18;
    const tileH = 34;
    const tileGap = 8;
    const tileW = (innerW - tileGap * (tiles.length - 1)) / tiles.length;
    tiles.forEach((t, i) => { t.x = p + i * (tileW + tileGap); t.y = tileY; t.w = tileW; t.h = tileH; });
    // Proportion bar (in-flight vs shipped share) under the tiles.
    const propY = tileY + tileH + 8;
    const propH = 8;
    const inShare = clamp01(finiteOr(flow.inflightShare, 0));
    const header = {
      title: "Live KPIs",
      tag: "SYNTHETIC · ISO 22400 / heuristic · not measured",
      tickText: "tick " + Math.round(flow.tick) + (data && data.playing ? "" : " · paused"),
      tiles: tiles,
      proportion: {
        x: p, y: propY, w: innerW, h: propH,
        inflightW: innerW * inShare,
        shippedW: innerW * (1 - inShare),
        inflight: Math.round(flow.inflight), completed: Math.round(flow.completed),
      },
    };
    const headerBottom = propY + propH;

    // ---- Throughput over time (area + line, 0-based y) ---------------
    const tSecTop = headerBottom + 14;
    const tTitleH = 14;
    const tPlot = { x: p + 26, y: tSecTop + tTitleH, w: innerW - 26, h: 56 };
    const tMax = Math.max(1, finiteOr(tp.scale && tp.scale.max, 1));
    const zeroY = tPlot.y + tPlot.h; // value 0 sits on the plot FLOOR
    const buckets = (tp.buckets || []);
    const n = buckets.length;
    const points = buckets.map((b, i) => {
      const x = n <= 1 ? tPlot.x + tPlot.w : tPlot.x + (i / (n - 1)) * tPlot.w;
      const y = zeroY - clamp01(b.units / tMax) * tPlot.h;
      return { x: x, y: y, units: b.units, tick: b.tick };
    });
    const throughput = {
      title: "Throughput — completed / interval (live)",
      titleX: p, titleY: tSecTop,
      plot: tPlot, zeroY: zeroY, maxValue: tMax,
      points: points,
      yTicks: [
        { value: 0, y: zeroY, label: "0" },
        { value: tMax, y: tPlot.y, label: String(tMax) },
      ],
      endLabel: points.length ? { x: points[points.length - 1].x, y: points[points.length - 1].y, text: String(nowRate) } : null,
      windowText: n > 1 ? ("last " + n + " intervals") : "warming up",
      color: tokens.accent,
    };
    const tSecBottom = tPlot.y + tPlot.h + 12;

    // ---- Per-stage load vs capacity (7 horizontal bars, 0-based x) ---
    const util = (data && data.utilisation) || { stages: [], scale: { min: 0, max: 1 } };
    const stages = util.stages || [];
    const uSecTop = tSecBottom + 4;
    const uTitleH = 14;
    const labelCol = finiteOr(d.labelCol, 74);
    const valueCol = 40; // room for the "100%" value at the tip
    const barX0 = p + labelCol; // value-0 baseline x (ALL bars start here)
    const barMaxW = innerW - labelCol - valueCol;
    const rowsTop = uSecTop + uTitleH;
    const rowH = stages.length ? Math.max(14, Math.min(20, (H - rowsTop - 20 - p) / stages.length)) : 16;
    const barH = Math.min(12, rowH - 6);
    const bars = stages.map((s, i) => {
      const util01 = clamp01(finiteOr(s.util, 0));
      const rowY = rowsTop + i * rowH;
      const w = util01 * barMaxW; // 0 -> width 0 (honest baseline)
      return {
        id: s.id, label: s.label, util: util01, pct: finiteOr(s.pct, Math.round(util01 * 100)),
        capacityUnitsPerHr: s.capacityUnitsPerHr,
        isBottleneck: !!s.isBottleneck,
        x: barX0, y: rowY + (rowH - barH) / 2, w: w, h: barH,
        trackW: barMaxW,
        labelX: p, labelY: rowY + rowH / 2,
        valueX: barX0 + barMaxW + 6, valueText: finiteOr(s.pct, Math.round(util01 * 100)) + "%",
        color: s.isBottleneck ? tokens.crit : palette[i % palette.length],
        tag: s.isBottleneck ? "bottleneck" : null,
      };
    });
    // Vertical gridlines / x-ticks at 0 / 50 / 100 % (value-anchored).
    const xTicks = [0, 0.5, 1].map((v) => ({ value: v, x: barX0 + v * barMaxW, label: Math.round(v * 100) + "%" }));
    const utilisation = {
      title: "Stage load vs capacity — 7 stages (0-based)",
      titleX: p, titleY: uSecTop,
      barX0: barX0, barMaxW: barMaxW, rowH: rowH, barH: barH,
      scaleMin: finiteOr(util.scale && util.scale.min, 0), // 0 (honesty)
      scaleMax: finiteOr(util.scale && util.scale.max, 1),
      bars: bars,
      xTicks: xTicks,
      bottleneck: util.bottleneck || null,
    };

    model.header = header;
    model.throughput = throughput;
    model.utilisation = utilisation;
    model.contentHeight = rowsTop + bars.length * rowH + 16;
    return model;
  }

  /* ==================================================================
   * drawDashboard(target, data, opts) -> renders layout()'s model onto a
   * 2D canvas. `target` may be a <canvas>, a container element (a canvas
   * is created/reused inside it) or a 2D context. `opts.theme` is a theme
   * name ("light"/"dark") or an override object; opts.width/height force
   * the CSS size (otherwise read from the canvas box). Returns the render
   * model (so callers can inspect what was drawn). No-ops safely without a
   * DOM. This canvas draw is NOT headless-testable - the geometry it
   * executes is layout()'s, which IS tested in verify_kpicharts.js.
   * ================================================================== */
  function resolveTarget(target) {
    if (!target) return null;
    if (typeof target.getContext === "function") return { canvas: target, ctx: target.getContext("2d") };
    if (target.canvas && typeof target.fillRect === "function") return { canvas: target.canvas, ctx: target };
    if (target.tagName && typeof document !== "undefined") {
      let c = target.querySelector && target.querySelector("canvas");
      if (!c) { c = document.createElement("canvas"); target.appendChild(c); }
      return { canvas: c, ctx: c.getContext("2d") };
    }
    return null;
  }

  function drawDashboard(target, data, opts) {
    const o = opts || {};
    const t = resolveTarget(target);
    if (!t || !t.ctx) return null;
    const canvas = t.canvas, ctx = t.ctx;
    const cssW = Math.max(200, finiteOr(o.width, canvas.clientWidth || 320));
    const cssH = Math.max(200, finiteOr(o.height, canvas.clientHeight || 320));
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const m = layout(data, { width: cssW, height: cssH, theme: o.theme });
    const T = m.tokens;
    const font = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

    // Panel background.
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = T.surface;
    roundRectPath(ctx, 0.5, 0.5, cssW - 1, cssH - 1, 10);
    ctx.fill();

    const empty = !(data && data.ok);

    // ---- Header ------------------------------------------------------
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.fillStyle = T.ink;
    ctx.font = "700 12px " + font;
    ctx.fillText(m.header.title, m.header.tiles[0].x, m.header.tiles[0].y - 6);
    ctx.textAlign = "right";
    ctx.fillStyle = T.muted;
    ctx.font = "600 9px " + font;
    ctx.fillText(m.header.tickText, m.width - 12, m.header.tiles[0].y - 6);
    ctx.textAlign = "left";

    // KPI tiles.
    for (const tile of m.header.tiles) {
      ctx.fillStyle = T.surfaceAlt;
      roundRectPath(ctx, tile.x, tile.y, tile.w, tile.h, 7);
      ctx.fill();
      ctx.strokeStyle = T.grid; ctx.lineWidth = 1;
      roundRectPath(ctx, tile.x + 0.5, tile.y + 0.5, tile.w - 1, tile.h - 1, 7);
      ctx.stroke();
      // colour key dot (identity beside the text, never coloured text)
      ctx.fillStyle = tile.color;
      ctx.beginPath(); ctx.arc(tile.x + 8, tile.y + 10, 3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = T.sub;
      ctx.font = "600 8.5px " + font;
      ctx.fillText(tile.label.toUpperCase(), tile.x + 15, tile.y + 13);
      ctx.fillStyle = T.ink;
      ctx.font = "700 15px " + font;
      ctx.fillText(String(tile.value), tile.x + 8, tile.y + 29);
      const vw = ctx.measureText(String(tile.value)).width;
      ctx.fillStyle = T.muted;
      ctx.font = "500 8.5px " + font;
      ctx.fillText(tile.unit, tile.x + 8 + vw + 4, tile.y + 29);
    }

    // In-flight vs shipped proportion bar.
    const pr = m.header.proportion;
    ctx.fillStyle = T.track;
    roundRectPath(ctx, pr.x, pr.y, pr.w, pr.h, 4); ctx.fill();
    if (pr.inflightW > 0) { ctx.fillStyle = T.accent; roundRectLeft(ctx, pr.x, pr.y, Math.max(0, pr.inflightW - 1), pr.h, 4); ctx.fill(); }
    if (pr.shippedW > 0) { ctx.fillStyle = T.good; roundRectRight(ctx, pr.x + pr.inflightW + 1, pr.y, Math.max(0, pr.shippedW - 1), pr.h, 4); ctx.fill(); }

    // ---- Throughput chart -------------------------------------------
    const tp = m.throughput;
    ctx.fillStyle = T.sub; ctx.font = "600 10px " + font; ctx.textAlign = "left";
    ctx.fillText(tp.title, tp.titleX, tp.titleY + 10);
    // y grid + ticks (0 and max)
    ctx.strokeStyle = T.grid; ctx.lineWidth = 1;
    ctx.fillStyle = T.muted; ctx.font = "500 8px " + font;
    for (const yt of tp.yTicks) {
      ctx.beginPath(); ctx.moveTo(tp.plot.x, yt.y + 0.5); ctx.lineTo(tp.plot.x + tp.plot.w, yt.y + 0.5); ctx.stroke();
      ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillText(yt.label, tp.plot.x - 4, yt.y);
    }
    ctx.textBaseline = "alphabetic";
    if (!empty && tp.points.length >= 1) {
      // area wash (~12% opacity) down to the value-0 floor, then the line.
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(tp.points[0].x, tp.zeroY);
      for (const pt of tp.points) ctx.lineTo(pt.x, pt.y);
      ctx.lineTo(tp.points[tp.points.length - 1].x, tp.zeroY);
      ctx.closePath();
      ctx.globalAlpha = 0.12; ctx.fillStyle = tp.color; ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      tp.points.forEach((pt, i) => { i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y); });
      ctx.strokeStyle = tp.color; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.stroke();
      // end marker with a surface ring, and a direct value label.
      const last = tp.points[tp.points.length - 1];
      ctx.beginPath(); ctx.arc(last.x, last.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = tp.color; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = T.surface; ctx.stroke();
      ctx.restore();
      if (tp.endLabel) {
        ctx.fillStyle = T.sub; ctx.font = "700 9px " + font; ctx.textAlign = "right";
        ctx.fillText(tp.endLabel.text, last.x - 7, last.y - 5 < tp.plot.y + 8 ? last.y + 12 : last.y - 5);
      }
      ctx.fillStyle = T.muted; ctx.font = "500 8px " + font; ctx.textAlign = "left";
      ctx.fillText(tp.windowText, tp.plot.x + 2, tp.zeroY + 10);
    } else {
      ctx.fillStyle = T.muted; ctx.font = "500 10px " + font; ctx.textAlign = "left";
      ctx.fillText("Press Play to stream KPIs.", tp.plot.x + 2, tp.plot.y + tp.plot.h / 2);
    }

    // ---- Utilisation bars -------------------------------------------
    const ut = m.utilisation;
    ctx.fillStyle = T.sub; ctx.font = "600 10px " + font; ctx.textAlign = "left";
    ctx.fillText(ut.title, ut.titleX, ut.titleY + 10);
    // vertical gridlines + x tick labels (0/50/100%)
    const rowsTopY = ut.bars.length ? ut.bars[0].y - (ut.rowH - ut.barH) / 2 : ut.titleY + 14;
    const rowsBotY = ut.bars.length ? ut.bars[ut.bars.length - 1].y + ut.barH + (ut.rowH - ut.barH) / 2 : rowsTopY;
    ctx.strokeStyle = T.grid; ctx.lineWidth = 1;
    ctx.fillStyle = T.muted; ctx.font = "500 8px " + font;
    for (const xt of ut.xTicks) {
      ctx.beginPath(); ctx.moveTo(xt.x + 0.5, rowsTopY); ctx.lineTo(xt.x + 0.5, rowsBotY); ctx.stroke();
      ctx.textAlign = "center"; ctx.fillText(xt.label, xt.x, rowsBotY + 10);
    }
    for (const bar of ut.bars) {
      // stage label (muted text) at the left
      ctx.fillStyle = bar.isBottleneck ? T.crit : T.sub;
      ctx.font = (bar.isBottleneck ? "700 " : "500 ") + "9px " + font;
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(fit(bar.label, 12), bar.labelX, bar.labelY);
      // track (unfilled remainder), then the fill from the value-0 baseline
      ctx.fillStyle = T.track;
      roundRectPath(ctx, bar.x, bar.y, bar.trackW, bar.h, 3); ctx.fill();
      if (bar.w > 0.5) {
        ctx.fillStyle = bar.color;
        roundRectRight(ctx, bar.x, bar.y, bar.w, bar.h, 3); ctx.fill();
        if (bar.isBottleneck) hatch(ctx, bar.x, bar.y, bar.w, bar.h, T.surface);
      }
      // value label at the tip
      ctx.fillStyle = T.sub; ctx.font = "600 8.5px " + font;
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(bar.valueText, bar.valueX, bar.labelY);
      // bottleneck tag (secondary encoding, not colour alone)
      if (bar.tag) {
        ctx.fillStyle = T.crit; ctx.font = "700 7.5px " + font; ctx.textAlign = "right";
        ctx.fillText("◀ " + bar.tag, bar.x + bar.trackW - 3, bar.y - 4);
      }
      ctx.textBaseline = "alphabetic";
    }
    return m;
  }

  /* ------------------------------------------------------------------
   * Canvas path helpers (kept local so the module is self-contained).
   * ------------------------------------------------------------------ */
  function roundRectPath(ctx, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }
  // A fill rounded only on its RIGHT end (data-end), square at the baseline.
  function roundRectRight(ctx, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w, h / 2));
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + w - rr, y);
    ctx.arcTo(x + w, y, x + w, y + rr, rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
    ctx.lineTo(x, y + h);
    ctx.closePath();
  }
  // A fill rounded only on its LEFT end.
  function roundRectLeft(ctx, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.arcTo(x, y + h, x, y + h - rr, rr);
    ctx.lineTo(x, y + rr);
    ctx.arcTo(x, y, x + rr, y, rr);
    ctx.closePath();
  }
  // 45-degree tone-on-tone hatch (the bottleneck's texture channel).
  function hatch(ctx, x, y, w, h, color) {
    ctx.save();
    roundRectRight(ctx, x, y, w, h, 3); ctx.clip();
    ctx.globalAlpha = 0.35; ctx.strokeStyle = color; ctx.lineWidth = 1;
    for (let i = -h; i < w; i += 5) {
      ctx.beginPath(); ctx.moveTo(x + i, y + h); ctx.lineTo(x + i + h, y); ctx.stroke();
    }
    ctx.restore();
  }
  // Truncate a label to n chars with an ellipsis (pure, no ctx metrics).
  function fit(s, n) {
    s = String(s == null ? "" : s);
    return s.length <= n ? s : s.slice(0, n - 1) + "…";
  }

  WT.kpicharts = {
    SYNTHETIC_LABEL: SYNTHETIC_LABEL,
    PALETTE: PALETTE,
    THEMES: THEMES,
    series: series,
    layout: layout,
    drawDashboard: drawDashboard,
  };
})();
