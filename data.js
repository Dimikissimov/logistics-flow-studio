/* =====================================================================
 * Logistics Flow Studio - WarehouseTwin
 * data.js - "bring your own data": CSV import for articles + orders (W3)
 * ---------------------------------------------------------------------
 * Parses and validates the user's own warehouse data ENTIRELY in the
 * browser (the app.js panel feeds it FileReader text - nothing is ever
 * uploaded anywhere; there is no server to upload to). The pattern
 * mirrors the sibling analysis engine (logistics-digital-twin
 * logitwin/importer.py): row-numbered errors, honest assumptions, the
 * same 80/20 ABC split as the synthetic generator.
 *
 * FORMATS
 *   Article CSV (required):  sku,description,weekly_picks[,class]
 *     - weekly_picks: the SKU's picks per week (>= 0, numeric). These
 *       become the sim's demand weights - REAL velocities, not Zipf.
 *     - class: optional A/B/C. If the column is present it is used
 *       as-is; otherwise classes are recomputed 80/20 from the picks
 *       (top 20% of SKUs by picks = A, next 30% = B, rest = C - the
 *       same split the synthetic ABC model uses).
 *   Order CSV (optional):    order_id,sku,qty
 *     - groups lines by order_id (first-appearance order). Every sku
 *       must exist in the article CSV. qty defaults to 1 when blank.
 *
 * CAPS (documented in the UI + README): 2000 articles, 20000 order
 * lines, 2 MB per file. Big enough for a real mid-size operation,
 * small enough that parsing + simulation stay instant in the browser.
 *
 * All functions are pure and deterministic - the Node test harness
 * (verify_data.js) loads this file with the same window shim as the
 * other harnesses and exercises the REAL parser, not a copy.
 * ===================================================================== */
(function () {
  "use strict";
  const WT = (window.WT = window.WT || {});

  const LIMITS = {
    maxArticles: 2000, // article rows
    maxOrderLines: 20000, // order CSV data rows
    maxFileBytes: 2 * 1024 * 1024, // 2 MB per file (checked by the panel)
    maxErrorsListed: 25, // row errors shown before "+N more"
  };

  /* ------------------------------------------------------------------
   * Minimal CSV reader: comma-separated, double-quote quoting with ""
   * escapes, tolerant of \r\n and a UTF-8 BOM. Returns array of rows
   * (arrays of trimmed strings). Blank lines are skipped.
   * ------------------------------------------------------------------ */
  function parseCsv(text) {
    let src = String(text || "");
    if (src.charCodeAt(0) === 0xfeff) src = src.slice(1); // strip a UTF-8 BOM
    const rows = [];
    let field = "";
    let row = [];
    let inQuotes = false;
    let sawAny = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (inQuotes) {
        if (c === '"') {
          if (src[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(field.trim()); field = ""; sawAny = true;
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && src[i + 1] === "\n") i++;
        if (sawAny || field.trim() !== "") { row.push(field.trim()); rows.push(row); }
        field = ""; row = []; sawAny = false;
      } else field += c;
    }
    if (sawAny || field.trim() !== "") { row.push(field.trim()); rows.push(row); }
    return rows;
  }

  // Header lookup: case-insensitive column name -> index, or -1.
  function colIndex(header, name) {
    for (let i = 0; i < header.length; i++) {
      if (header[i].toLowerCase() === name) return i;
    }
    return -1;
  }

  function err(row, msg) { return { row, msg }; }

  /* ------------------------------------------------------------------
   * parseArticles(text) -> { ok, errors:[{row,msg}], articles }
   *   articles: [{ sku, description, weeklyPicks, cls|null }]
   * Row numbers are 1-based FILE lines (header = row 1, first data
   * row = row 2) so the user can jump straight to the line in Excel.
   * ------------------------------------------------------------------ */
  function parseArticles(text) {
    const rows = parseCsv(text);
    if (!rows.length) return { ok: false, errors: [err(1, "the article CSV is empty")], articles: [] };
    const header = rows[0];
    const iSku = colIndex(header, "sku");
    const iDesc = colIndex(header, "description");
    const iPicks = colIndex(header, "weekly_picks");
    const iCls = colIndex(header, "class");
    const missing = [];
    if (iSku < 0) missing.push("sku");
    if (iDesc < 0) missing.push("description");
    if (iPicks < 0) missing.push("weekly_picks");
    if (missing.length) {
      return {
        ok: false,
        errors: [err(1, "missing column(s): " + missing.join(", ") + " (expected header sku,description,weekly_picks[,class])")],
        articles: [],
      };
    }
    if (rows.length - 1 > LIMITS.maxArticles) {
      return {
        ok: false,
        errors: [err(1, "too many articles: " + (rows.length - 1) + " rows (cap is " + LIMITS.maxArticles + ")")],
        articles: [],
      };
    }
    const errors = [];
    const articles = [];
    const seen = {};
    for (let r = 1; r < rows.length; r++) {
      const line = r + 1; // file line number
      const cells = rows[r];
      const sku = (cells[iSku] || "").trim();
      if (!sku) { errors.push(err(line, "empty sku")); continue; }
      const key = sku.toUpperCase();
      if (seen[key]) { errors.push(err(line, "duplicate sku \"" + sku + "\" (first seen on row " + seen[key] + ")")); continue; }
      const rawPicks = (cells[iPicks] || "").trim();
      const picks = Number(rawPicks);
      if (rawPicks === "" || !isFinite(picks)) { errors.push(err(line, "weekly_picks is not a number (got \"" + rawPicks + "\")")); continue; }
      if (picks < 0) { errors.push(err(line, "weekly_picks cannot be negative (got " + picks + ")")); continue; }
      let cls = null;
      if (iCls >= 0) {
        cls = (cells[iCls] || "").trim().toUpperCase();
        if (cls !== "A" && cls !== "B" && cls !== "C") {
          errors.push(err(line, "class must be A, B or C (got \"" + (cells[iCls] || "") + "\") - or drop the class column to have it computed 80/20 from picks"));
          continue;
        }
      }
      seen[key] = line;
      articles.push({ sku, description: (cells[iDesc] || "").trim(), weeklyPicks: picks, cls });
    }
    if (!errors.length && !articles.length) errors.push(err(1, "the article CSV has a header but no data rows"));
    if (!errors.length && articles.every((a) => a.weeklyPicks === 0)) {
      errors.push(err(1, "every weekly_picks value is 0 - the sim needs at least one SKU that is actually picked"));
    }
    return { ok: errors.length === 0, errors, articles: errors.length ? [] : articles };
  }

  /* ------------------------------------------------------------------
   * parseOrders(text, articles) -> { ok, errors, orders }
   *   orders: [{ id, lines:[{ sku, qty }] }]  grouped by order_id in
   *   first-appearance order. Unknown SKUs are row-numbered ERRORS
   *   (not silently ignored): an order stream that references articles
   *   you did not import is almost always the wrong file pair.
   * ------------------------------------------------------------------ */
  function parseOrders(text, articles) {
    const rows = parseCsv(text);
    if (!rows.length) return { ok: false, errors: [err(1, "the order CSV is empty")], orders: [] };
    const header = rows[0];
    const iOrd = colIndex(header, "order_id");
    const iSku = colIndex(header, "sku");
    const iQty = colIndex(header, "qty");
    const missing = [];
    if (iOrd < 0) missing.push("order_id");
    if (iSku < 0) missing.push("sku");
    if (iQty < 0) missing.push("qty");
    if (missing.length) {
      return { ok: false, errors: [err(1, "missing column(s): " + missing.join(", ") + " (expected header order_id,sku,qty)")], orders: [] };
    }
    if (rows.length - 1 > LIMITS.maxOrderLines) {
      return { ok: false, errors: [err(1, "too many order lines: " + (rows.length - 1) + " rows (cap is " + LIMITS.maxOrderLines + ")")], orders: [] };
    }
    const known = {};
    (articles || []).forEach((a) => { known[a.sku.toUpperCase()] = a.sku; });
    const errors = [];
    const byId = {};
    const order = [];
    for (let r = 1; r < rows.length; r++) {
      const line = r + 1;
      const cells = rows[r];
      const oid = (cells[iOrd] || "").trim();
      if (!oid) { errors.push(err(line, "empty order_id")); continue; }
      const skuRaw = (cells[iSku] || "").trim();
      const sku = known[skuRaw.toUpperCase()];
      if (!sku) { errors.push(err(line, "unknown sku \"" + skuRaw + "\" (not in the article CSV)")); continue; }
      const rawQty = (cells[iQty] || "").trim();
      let qty = 1;
      if (rawQty !== "") {
        qty = Number(rawQty);
        if (!isFinite(qty)) { errors.push(err(line, "qty is not a number (got \"" + rawQty + "\")")); continue; }
        if (qty <= 0) { errors.push(err(line, "qty must be positive (got " + qty + ")")); continue; }
      }
      if (!byId[oid]) { byId[oid] = { id: oid, lines: [] }; order.push(oid); }
      byId[oid].lines.push({ sku, qty });
    }
    if (!errors.length && !order.length) errors.push(err(1, "the order CSV has a header but no data rows"));
    const orders = errors.length ? [] : order.map((oid) => byId[oid]);
    return { ok: errors.length === 0, errors, orders };
  }

  /* ------------------------------------------------------------------
   * computeABC(articles) -> { sku -> "A"|"B"|"C" }
   * The same 80/20 split the synthetic model uses: rank by weekly
   * picks (desc; ties break by sku so the result is deterministic),
   * top 20% of SKUs = A, next 30% = B, rest = C.
   * ------------------------------------------------------------------ */
  function computeABC(articles) {
    const ranked = articles.slice().sort((a, b) => (b.weeklyPicks - a.weeklyPicks) || (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
    const n = ranked.length;
    let nA = Math.max(1, Math.round(0.2 * n));
    let nB = Math.max(1, Math.round(0.3 * n));
    if (nA + nB >= n) nB = Math.max(0, n - nA - 1); // tiny catalogs: keep >=1 C when possible
    const out = {};
    ranked.forEach((a, i) => { out[a.sku] = i < nA ? "A" : i < nA + nB ? "B" : "C"; });
    return out;
  }

  /* ------------------------------------------------------------------
   * buildDataset(articles, orders|null) -> the sim-ready dataset:
   *   {
   *     skus: [{ id, picks, cls, description }]  sorted by picks desc
   *           (index 0 = most-picked; the slotting code slots by rank),
   *     orders: [{ id, lines:[{ skuIndex, qty }] }] | null,
   *     classSource: "csv" | "computed",
   *     stats: { skuCount, orderCount, lineCount, totalWeeklyPicks }
   *   }
   * Deterministic: same CSVs -> byte-identical dataset.
   * ------------------------------------------------------------------ */
  function buildDataset(articles, orders) {
    const anyCls = articles.some((a) => a.cls);
    const abc = anyCls ? null : computeABC(articles);
    const sorted = articles.slice().sort((a, b) => (b.weeklyPicks - a.weeklyPicks) || (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
    const skus = sorted.map((a) => ({
      id: a.sku,
      picks: a.weeklyPicks,
      cls: anyCls ? (a.cls || "C") : abc[a.sku],
      description: a.description,
    }));
    const idx = {};
    skus.forEach((s, i) => { idx[s.id] = i; });
    let dsOrders = null;
    let lineCount = 0;
    if (orders && orders.length) {
      dsOrders = orders.map((o) => ({
        id: o.id,
        lines: o.lines.map((l) => { lineCount++; return { skuIndex: idx[l.sku], qty: l.qty }; }),
      }));
    }
    return {
      skus,
      orders: dsOrders,
      classSource: anyCls ? "csv" : "computed",
      stats: {
        skuCount: skus.length,
        orderCount: dsOrders ? dsOrders.length : 0,
        lineCount,
        totalWeeklyPicks: skus.reduce((s, x) => s + x.picks, 0),
      },
    };
  }

  // Render a row-numbered error list as short text lines (UI + tests).
  function formatErrors(errors) {
    const shown = errors.slice(0, LIMITS.maxErrorsListed);
    const out = shown.map((e) => "row " + e.row + ": " + e.msg);
    if (errors.length > shown.length) out.push("(+" + (errors.length - shown.length) + " more)");
    return out;
  }

  WT.data = { LIMITS, parseCsv, parseArticles, parseOrders, computeABC, buildDataset, formatErrors };
})();
