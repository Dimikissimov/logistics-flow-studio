/* =====================================================================
 * Logistics Flow Studio - WarehouseTwin
 * wmsdata.js - the real-data layer: SKU master + order pool (direction A)
 * ---------------------------------------------------------------------
 * A FIRST-CLASS, PURE, DETERMINISTIC data model that the material-flow
 * simulation and the WMS operations layer consume. It gives the app two
 * things a real WMS has and the synthetic demo never did as data:
 *
 *   - a SKU MASTER  : [{ sku, description, abcClass, velocity, weightKg,
 *                        storageType }]
 *   - an ORDER POOL : [{ orderId, lines:[{ sku, qty }] }]
 *
 * Both are generatable (seeded, deterministic) AND CSV-importable, so the
 * user can run the sim on their OWN numbers (or a Siemens Plant Simulation
 * WMS export) instead of the built-in synthetic catalogue. Everything is
 * an O(n) plain-array build that stays fast on a laptop at large scale
 * (tens of thousands of SKUs); the panel shows STATS + a small SAMPLE,
 * never all rows, and the sim/flowsim consume AGGREGATE order shape (a
 * count + avg lines) rather than iterating the pool per animation frame.
 *
 * SIEMENS PARITY: generate() mirrors the classic Plant Simulation
 * generateOrders() idea - for each order, draw 1..maxLines lines, and for
 * each line pick a SKU weighted by its velocity (frequency), with a small
 * quantity. Same params + seed -> byte-identical pool.
 *
 * HONESTY (load-bearing, mirrored in the UI + README):
 *   - GENERATED data is SYNTHETIC and labelled as such. No real brands.
 *   - The velocity / ABC model is a TRANSPARENT HEURISTIC: a Zipf-shaped
 *     (Pareto / 80-20) popularity curve ranked by SKU, NOT a measurement
 *     of any real operation. A-class is a small share of SKUs but a large
 *     share of demand - that skew is asserted in verify_wmsdata.js.
 *   - IMPORTED data is the USER'S OWN and stays ON-DEVICE. Parsing runs in
 *     the browser (the app makes zero network requests); nothing is
 *     uploaded, because there is no server to upload to.
 *
 * REUSE: the CSV reader is shared with data.js (WT.data.parseCsv) when
 * present, falling back to a local copy so this module also loads and
 * tests standalone. toDataset() emits exactly the { skus, orders } shape
 * simulation.js already consumes (cfg.dataset), so the sim needs no change
 * to run on this data - and when nothing is loaded, every consumer is
 * byte-identical to before (the synthetic default from state.config).
 *
 * Classic script attaching to the global `WT` namespace (works from
 * file:// too). No frameworks, no build step, fully offline, no deps.
 * ===================================================================== */
(function () {
  "use strict";
  const WT = (window.WT = window.WT || {});

  /* ------------------------------------------------------------------
   * Transparent teaching parameters. All synthetic; documented above.
   * ------------------------------------------------------------------ */
  const PARAMS = {
    defaultSeed: 42,
    defaultSku: 80, // matches the Simulation panel default (state.config.skuCount)
    defaultOrders: 300,
    maxLines: 6, // an order has 1..maxLines lines (avg (1+max)/2 = 3.5)
    maxQtyPerLine: 5, // synthetic per-line quantity: 1..maxQtyPerLine
    velocityTop: 5000, // Zipf numerator: the rank-1 SKU gets ~this many weekly picks
    velocityFloor: 1, // even the slowest movers get >= 1 pick/week (long tail)
    demandSkew: 1.0, // default Zipf exponent (from state.config.demandSkew); >1 = sharper Pareto
    abcAShare: 0.2, // top 20% of ranked SKUs = A  (matches data.js / domain ABC 80/20)
    abcBShare: 0.3, // next 30% = B; the remaining 50% = C
    weightMinKg: 0.1,
    weightMaxKg: 40,
    hardMaxSku: 200000, // generation guard (well above the ~26,500 SKU target)
    hardMaxOrders: 200000,
    sampleRows: 50, // the panel renders at most this many rows (performance)
    topSkus: 10, // stats() reports this many top-velocity SKUs
    storageTypes: ["carton-flow", "pallet-rack", "shelving", "bulk-floor", "asrs"],
  };

  const SYNTHETIC_LABEL =
    "SYNTHETIC SKU master + order pool - a transparent teaching data model, " +
    "NOT a measurement of any real operation and NOT a certification. Velocity " +
    "and ABC come from a Zipf-shaped (Pareto / 80-20) heuristic ranked by SKU, " +
    "not measured demand. IMPORTED data is your own and stays on this device - " +
    "nothing is uploaded (the app makes no network requests).";

  // Documented CSV headers (canonical). Import is tolerant of aliases.
  const HEADERS = {
    skus: "sku,description,abc_class,velocity,weight_kg,storage_type",
    orders: "order_id,sku,qty",
  };

  /* ---- Seeded PRNG: mulberry32 (same family as the rest of the app) --
   * Deterministic and fast. No Date, no Math.random anywhere here.      */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function clampInt(v, lo, hi, dflt) {
    let n = Math.round(Number(v));
    if (!isFinite(n)) n = dflt != null ? dflt : lo;
    return Math.max(lo, Math.min(hi, n));
  }
  function round2(x) {
    return Math.round(x * 100) / 100;
  }

  // Weighted pick of one index from cumulative weights (binary search).
  function pickWeighted(rng, cum, total) {
    const r = rng() * total;
    let lo = 0,
      hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /* ------------------------------------------------------------------
   * ABC split by rank share: top abcAShare = A, next abcBShare = B, rest
   * = C. Identical policy to data.js computeABC (20/30/50), just applied
   * to the generator's velocity RANK (index 0 = most popular).
   * ------------------------------------------------------------------ */
  function abcBounds(n) {
    let nA = Math.max(1, Math.round(PARAMS.abcAShare * n));
    let nB = Math.max(1, Math.round(PARAMS.abcBShare * n));
    if (nA + nB >= n) nB = Math.max(0, n - nA - 1); // tiny catalogs: keep >= 1 C when possible
    return { nA, nB };
  }
  function classForRank(rankIdx, nA, nB) {
    return rankIdx < nA ? "A" : rankIdx < nA + nB ? "B" : "C";
  }

  // Plausible storage medium from class + weight (deterministic; the rng
  // form is used while generating, the fixed form while importing).
  function storageFor(abcClass, weightKg, r) {
    if (weightKg >= 25) return r < 0.6 ? "pallet-rack" : "bulk-floor";
    if (abcClass === "A") return r < 0.55 ? "carton-flow" : "asrs";
    if (abcClass === "B") return r < 0.6 ? "pallet-rack" : "shelving";
    return r < 0.7 ? "shelving" : "pallet-rack";
  }
  function storageForFixed(abcClass, weightKg) {
    // No rng available (import path with a missing storage_type column):
    // pick the majority medium for the class/weight, deterministically.
    if (weightKg >= 25) return "pallet-rack";
    if (abcClass === "A") return "carton-flow";
    if (abcClass === "B") return "pallet-rack";
    return "shelving";
  }

  // Generic, brand-free descriptors (no real company or product names).
  const DESC_ADJ = [
    "Standard", "Heavy-duty", "Compact", "Industrial", "Precision",
    "Universal", "Reinforced", "Lightweight", "Modular", "Premium",
  ];
  const DESC_NOUN = [
    "fastener set", "bracket", "housing", "cable assembly", "filter",
    "seal kit", "bearing", "valve", "panel", "connector", "gasket",
    "fitting", "clamp", "spacer", "bushing", "coupling", "adapter",
    "mount", "washer pack", "hose",
  ];
  function descFor(rng) {
    const a = DESC_ADJ[Math.floor(rng() * DESC_ADJ.length)];
    const n = DESC_NOUN[Math.floor(rng() * DESC_NOUN.length)];
    return a + " " + n;
  }

  /* ------------------------------------------------------------------
   * generateSkuMaster({ nSku|skuCount, seed, demandSkew }) -> [sku...]
   *
   * PURE and O(n). Ranks SKUs 1..N; velocity follows a Zipf curve
   *   velocity(rank) = max(floor, round(velocityTop / rank^skew))
   * so the head carries most of the demand (Pareto). ABC is assigned by
   * rank share (A = top 20%, B = next 30%, C = rest). Weight, storage
   * medium and a brand-free description are seeded per SKU.
   * ------------------------------------------------------------------ */
  function generateSkuMaster(opts) {
    const o = opts || {};
    const nSku = clampInt(o.nSku != null ? o.nSku : o.skuCount, 1, PARAMS.hardMaxSku, PARAMS.defaultSku);
    const seed = (o.seed != null ? o.seed : PARAMS.defaultSeed) >>> 0;
    let skew = Number(o.demandSkew != null ? o.demandSkew : PARAMS.demandSkew);
    if (!isFinite(skew) || skew <= 0) skew = PARAMS.demandSkew;
    const rng = mulberry32((seed ^ 0x5a17c0de) >>> 0); // "SKU" sub-stream
    const { nA, nB } = abcBounds(nSku);
    const pad = Math.max(5, String(nSku).length);
    const minW = PARAMS.weightMinKg,
      maxW = PARAMS.weightMaxKg;
    const skus = new Array(nSku);
    for (let i = 0; i < nSku; i++) {
      const rank = i + 1;
      const velocity = Math.max(PARAMS.velocityFloor, Math.round(PARAMS.velocityTop / Math.pow(rank, skew)));
      const abcClass = classForRank(i, nA, nB);
      const weightKg = round2(minW + (maxW - minW) * rng());
      const storageType = storageFor(abcClass, weightKg, rng());
      const description = descFor(rng);
      skus[i] = {
        sku: "SKU-" + String(rank).padStart(pad, "0"),
        description: description,
        abcClass: abcClass,
        velocity: velocity,
        weightKg: weightKg,
        storageType: storageType,
      };
    }
    return skus;
  }

  /* ------------------------------------------------------------------
   * generateOrders({ skuMaster | nSku, nOrders, maxLines, seed, ... })
   *   -> [{ orderId, lines:[{ sku, qty }] }]
   *
   * PURE. Mirrors Siemens generateOrders: for each order draw 1..maxLines
   * lines; each line is a SKU picked weighted by velocity (frequency) with
   * a quantity 1..maxQtyPerLine. Every line references an EXISTING SKU
   * from the master (asserted in the harness). O(nOrders * avgLines).
   * ------------------------------------------------------------------ */
  function generateOrders(opts) {
    const o = opts || {};
    const skus = o.skuMaster && o.skuMaster.length
      ? o.skuMaster
      : generateSkuMaster({ nSku: o.nSku, skuCount: o.skuCount, seed: o.seed, demandSkew: o.demandSkew });
    const nSku = skus.length;
    const nOrders = clampInt(o.nOrders != null ? o.nOrders : (o.orders != null ? o.orders : PARAMS.defaultOrders), 1, PARAMS.hardMaxOrders, PARAMS.defaultOrders);
    const maxLines = clampInt(o.maxLines != null ? o.maxLines : PARAMS.maxLines, 1, 64, PARAMS.maxLines);
    const maxQty = clampInt(o.maxQtyPerLine != null ? o.maxQtyPerLine : PARAMS.maxQtyPerLine, 1, 1000, PARAMS.maxQtyPerLine);
    const seed = (o.seed != null ? o.seed : PARAMS.defaultSeed) >>> 0;
    const rng = mulberry32((seed ^ 0x0de40d33) >>> 0); // "ORDER" sub-stream (independent of the SKU stream)

    // Cumulative velocity weights for the weighted SKU draw.
    const cum = new Float64Array(nSku);
    let acc = 0;
    for (let i = 0; i < nSku; i++) {
      acc += Math.max(0, Number(skus[i].velocity) || 0);
      cum[i] = acc;
    }
    const total = acc > 0 ? acc : nSku; // all-zero velocity -> uniform (defensive)

    const padO = Math.max(5, String(nOrders).length);
    const orders = new Array(nOrders);
    for (let ord = 0; ord < nOrders; ord++) {
      const nLines = 1 + Math.floor(rng() * maxLines);
      const lines = new Array(nLines);
      for (let l = 0; l < nLines; l++) {
        const idx = pickWeighted(rng, cum, total);
        const qty = 1 + Math.floor(rng() * maxQty);
        lines[l] = { sku: skus[idx].sku, qty: qty };
      }
      orders[ord] = { orderId: "ORD-" + String(ord + 1).padStart(padO, "0"), lines: lines };
    }
    return orders;
  }

  /* ------------------------------------------------------------------
   * generate(opts) -> a full bundle { skuMaster, orderPool, source,
   * classSource, params }. PURE (no side effects, no Date). Tie the opts
   * to state.config: { skuCount, orders, seed, demandSkew, maxLines }.
   * ------------------------------------------------------------------ */
  function generate(opts) {
    const o = opts || {};
    const skuMaster = generateSkuMaster(o);
    const orderPool = generateOrders(Object.assign({}, o, { skuMaster: skuMaster }));
    return {
      skuMaster: skuMaster,
      orderPool: orderPool,
      source: "synthetic",
      classSource: "computed", // ABC is the 80/20 velocity rank (transparent heuristic)
      params: {
        nSku: skuMaster.length,
        nOrders: orderPool.length,
        seed: (o.seed != null ? o.seed : PARAMS.defaultSeed) >>> 0,
        demandSkew: Number(o.demandSkew != null ? o.demandSkew : PARAMS.demandSkew),
        maxLines: clampInt(o.maxLines != null ? o.maxLines : PARAMS.maxLines, 1, 64, PARAMS.maxLines),
      },
    };
  }

  /* ==================================================================
   * CSV: a tolerant reader (shared with data.js when present), tolerant
   * column mapping on import, deterministic bytes on export.
   * ================================================================== */

  // Minimal CSV reader: comma-separated, double-quote quoting with ""
  // escapes, tolerant of \r\n and a UTF-8 BOM. Local fallback identical
  // in spirit to data.js parseCsv; we REUSE WT.data.parseCsv when loaded.
  function localParseCsv(text) {
    let src = String(text || "");
    if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
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
  function parseCsv(text) {
    return WT.data && typeof WT.data.parseCsv === "function" ? WT.data.parseCsv(text) : localParseCsv(text);
  }

  function err(row, msg) { return { row: row, msg: msg }; }

  // Tolerant header lookup: return the index of the first column whose
  // (lower-cased, non-alphanumeric-stripped) name matches any alias.
  function normHead(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
  function findCol(header, aliases) {
    const norm = header.map(normHead);
    for (const a of aliases) {
      const idx = norm.indexOf(a);
      if (idx !== -1) return idx;
    }
    return -1;
  }

  const ALIAS = {
    sku: ["sku", "article", "articleno", "articlenumber", "item", "itemid", "material", "materialno", "partno", "id"],
    description: ["description", "desc", "name", "text", "articletext"],
    abcClass: ["abcclass", "abc", "class", "abccode"],
    velocity: ["velocity", "weeklypicks", "picks", "frequency", "freq", "demand", "popularity", "pickfrequency"],
    weightKg: ["weightkg", "weight", "mass", "kg"],
    storageType: ["storagetype", "storage", "zone", "storagezone", "medium"],
    orderId: ["orderid", "order", "orderno", "ordernumber", "ordernr", "ordno"],
    qty: ["qty", "quantity", "amount", "count", "pieces", "units"],
  };

  /* ------------------------------------------------------------------
   * importSkusCsv(text) -> { ok, errors:[{row,msg}], skus, classSource }
   * REQUIRED columns: sku, velocity. OPTIONAL: description, abc_class,
   * weight_kg, storage_type (derived deterministically when absent). Row
   * numbers are 1-based file lines (header = row 1). Nothing is returned
   * on error so a bad file never disturbs the loaded data.
   * ------------------------------------------------------------------ */
  function importSkusCsv(text) {
    const rows = parseCsv(text);
    if (!rows.length) return { ok: false, errors: [err(1, "the SKU CSV is empty")], skus: [], classSource: "computed" };
    const header = rows[0];
    const iSku = findCol(header, ALIAS.sku);
    const iVel = findCol(header, ALIAS.velocity);
    const iDesc = findCol(header, ALIAS.description);
    const iAbc = findCol(header, ALIAS.abcClass);
    const iW = findCol(header, ALIAS.weightKg);
    const iStore = findCol(header, ALIAS.storageType);
    const missing = [];
    if (iSku < 0) missing.push("sku");
    if (iVel < 0) missing.push("velocity/weekly_picks");
    if (missing.length) {
      return {
        ok: false,
        errors: [err(1, "missing column(s): " + missing.join(", ") + " (documented header " + HEADERS.skus + "; velocity/weekly_picks/frequency all accepted)")],
        skus: [],
        classSource: "computed",
      };
    }
    if (rows.length - 1 > PARAMS.hardMaxSku) {
      return { ok: false, errors: [err(1, "too many SKUs: " + (rows.length - 1) + " rows (cap " + PARAMS.hardMaxSku + ")")], skus: [], classSource: "computed" };
    }
    const errors = [];
    const skus = [];
    const seen = {};
    let anyAbc = false;
    for (let r = 1; r < rows.length; r++) {
      const line = r + 1;
      const cells = rows[r];
      const sku = (cells[iSku] || "").trim();
      if (!sku) { errors.push(err(line, "empty sku")); continue; }
      const key = sku.toUpperCase();
      if (seen[key]) { errors.push(err(line, 'duplicate sku "' + sku + '" (first seen on row ' + seen[key] + ")")); continue; }
      const rawVel = (cells[iVel] || "").trim();
      const vel = Number(rawVel);
      if (rawVel === "" || !isFinite(vel)) { errors.push(err(line, 'velocity is not a number (got "' + rawVel + '")')); continue; }
      if (vel < 0) { errors.push(err(line, "velocity cannot be negative (got " + vel + ")")); continue; }
      let abcClass = null;
      if (iAbc >= 0) {
        const c = (cells[iAbc] || "").trim().toUpperCase();
        if (c) {
          if (c !== "A" && c !== "B" && c !== "C") {
            errors.push(err(line, 'abc_class must be A, B or C (got "' + (cells[iAbc] || "") + '") - or drop the column to have it computed 80/20 from velocity'));
            continue;
          }
          abcClass = c;
          anyAbc = true;
        }
      }
      let weightKg = null;
      if (iW >= 0) {
        const rawW = (cells[iW] || "").trim();
        if (rawW !== "") {
          const w = Number(rawW);
          if (!isFinite(w) || w < 0) { errors.push(err(line, 'weight_kg must be a non-negative number (got "' + rawW + '")')); continue; }
          weightKg = round2(w);
        }
      }
      const storageType = iStore >= 0 ? (cells[iStore] || "").trim() : "";
      seen[key] = line;
      skus.push({
        sku: sku,
        description: iDesc >= 0 ? (cells[iDesc] || "").trim() : "",
        _abc: abcClass, // may be null -> computed below
        velocity: vel,
        _weight: weightKg, // may be null -> defaulted below
        _storage: storageType, // may be "" -> derived below
      });
    }
    if (!errors.length && !skus.length) errors.push(err(1, "the SKU CSV has a header but no data rows"));
    if (!errors.length && skus.every((s) => s.velocity === 0)) {
      errors.push(err(1, "every velocity is 0 - the order generator needs at least one SKU that actually moves"));
    }
    if (errors.length) return { ok: false, errors: errors, skus: [], classSource: "computed" };

    // Fill ABC where absent: 80/20 by velocity rank (deterministic ties by sku).
    const classSource = anyAbc ? "csv" : "computed";
    if (!anyAbc) {
      const ranked = skus.slice().sort((a, b) => (b.velocity - a.velocity) || (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
      const { nA, nB } = abcBounds(ranked.length);
      const cls = {};
      ranked.forEach((s, i) => { cls[s.sku] = classForRank(i, nA, nB); });
      skus.forEach((s) => { s._abc = cls[s.sku]; });
    } else {
      skus.forEach((s) => { if (!s._abc) s._abc = "C"; }); // partial abc column -> unlabelled rows default C
    }

    const out = skus.map((s) => {
      const abcClass = s._abc;
      const weightKg = s._weight != null ? s._weight : 1;
      const storageType = s._storage || storageForFixed(abcClass, weightKg);
      return {
        sku: s.sku,
        description: s.description,
        abcClass: abcClass,
        velocity: s.velocity,
        weightKg: weightKg,
        storageType: storageType,
      };
    });
    return { ok: true, errors: [], skus: out, classSource: classSource };
  }

  /* ------------------------------------------------------------------
   * importOrdersCsv(text, skuMaster) -> { ok, errors, orders }
   * REQUIRED columns: order_id, sku, qty (qty defaults to 1 when blank).
   * Lines are grouped by order_id in first-appearance order; every sku
   * must exist in the SKU master (unknown sku is a row-numbered error).
   * ------------------------------------------------------------------ */
  function importOrdersCsv(text, skuMaster) {
    const master = skuMaster && skuMaster.length ? skuMaster : active.skuMaster;
    const rows = parseCsv(text);
    if (!rows.length) return { ok: false, errors: [err(1, "the order CSV is empty")], orders: [] };
    const header = rows[0];
    const iOrd = findCol(header, ALIAS.orderId);
    const iSku = findCol(header, ALIAS.sku);
    const iQty = findCol(header, ALIAS.qty);
    const missing = [];
    if (iOrd < 0) missing.push("order_id");
    if (iSku < 0) missing.push("sku");
    if (iQty < 0) missing.push("qty");
    if (missing.length) {
      return { ok: false, errors: [err(1, "missing column(s): " + missing.join(", ") + " (documented header " + HEADERS.orders + ")")], orders: [] };
    }
    if (rows.length - 1 > PARAMS.hardMaxOrders * 8) {
      return { ok: false, errors: [err(1, "too many order lines: " + (rows.length - 1) + " rows")], orders: [] };
    }
    const known = {};
    (master || []).forEach((s) => { known[String(s.sku).toUpperCase()] = s.sku; });
    if (!master || !master.length) {
      return { ok: false, errors: [err(1, "load or import a SKU master first - orders must reference existing SKUs")], orders: [] };
    }
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
      if (!sku) { errors.push(err(line, 'unknown sku "' + skuRaw + '" (not in the SKU master)')); continue; }
      const rawQty = (cells[iQty] || "").trim();
      let qty = 1;
      if (rawQty !== "") {
        qty = Number(rawQty);
        if (!isFinite(qty)) { errors.push(err(line, 'qty is not a number (got "' + rawQty + '")')); continue; }
        if (qty <= 0) { errors.push(err(line, "qty must be positive (got " + qty + ")")); continue; }
        qty = Math.round(qty);
      }
      if (!byId[oid]) { byId[oid] = { orderId: oid, lines: [] }; order.push(oid); }
      byId[oid].lines.push({ sku: sku, qty: qty });
    }
    if (!errors.length && !order.length) errors.push(err(1, "the order CSV has a header but no data rows"));
    if (errors.length) return { ok: false, errors: errors, orders: [] };
    return { ok: true, errors: [], orders: order.map((oid) => byId[oid]) };
  }

  // CSV field escaping: quote anything with a comma, quote or newline.
  function csvEscape(v) {
    const s = v == null ? "" : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /* ------------------------------------------------------------------
   * exportSkusCsv(skus) / exportOrdersCsv(orders) -> deterministic,
   * Excel-openable CSV text (CRLF line endings, quoted where needed).
   * parse(export(x)) preserves the rows (round-trip, verified).
   * ------------------------------------------------------------------ */
  function exportSkusCsv(skus) {
    const rows = skus || active.skuMaster;
    const out = [HEADERS.skus];
    for (const s of rows) {
      out.push([
        csvEscape(s.sku),
        csvEscape(s.description),
        csvEscape(s.abcClass),
        csvEscape(s.velocity),
        csvEscape(s.weightKg),
        csvEscape(s.storageType),
      ].join(","));
    }
    return out.join("\r\n") + "\r\n";
  }
  function exportOrdersCsv(orders) {
    const rows = orders || active.orderPool;
    const out = [HEADERS.orders];
    for (const o of rows) {
      for (const l of o.lines) {
        out.push([csvEscape(o.orderId), csvEscape(l.sku), csvEscape(l.qty)].join(","));
      }
    }
    return out.join("\r\n") + "\r\n";
  }

  /* ------------------------------------------------------------------
   * stats(skus, orders) -> summary for the panel (counts, ABC split with
   * SKU-share vs DEMAND-share, avg lines/order, top-velocity SKUs). Uses
   * the loaded store when args are omitted. Linear top-k (no full sort).
   * ------------------------------------------------------------------ */
  function stats(skus, orders) {
    const S = skus || active.skuMaster;
    const O = orders !== undefined ? orders : active.orderPool;
    const skuCount = S.length;
    let totalVel = 0;
    const cls = { A: { skus: 0, demand: 0 }, B: { skus: 0, demand: 0 }, C: { skus: 0, demand: 0 } };
    const K = PARAMS.topSkus;
    const top = []; // kept sorted desc by velocity, length <= K
    for (const s of S) {
      const v = Math.max(0, Number(s.velocity) || 0);
      totalVel += v;
      const c = cls[s.abcClass] || (cls[s.abcClass] = { skus: 0, demand: 0 });
      c.skus++;
      c.demand += v;
      // linear top-k insertion
      if (top.length < K || v > top[top.length - 1].velocity) {
        let pos = top.length;
        while (pos > 0 && top[pos - 1].velocity < v) pos--;
        top.splice(pos, 0, { sku: s.sku, velocity: v, abcClass: s.abcClass, description: s.description });
        if (top.length > K) top.length = K;
      }
    }
    let orderCount = 0,
      lineCount = 0;
    if (O && O.length) {
      orderCount = O.length;
      for (const o of O) lineCount += o.lines.length;
    }
    const abc = {};
    for (const k of ["A", "B", "C"]) {
      const c = cls[k] || { skus: 0, demand: 0 };
      abc[k] = {
        skus: c.skus,
        skuPct: skuCount ? (c.skus / skuCount) * 100 : 0,
        demand: c.demand,
        demandPct: totalVel ? (c.demand / totalVel) * 100 : 0,
      };
    }
    return {
      skuCount: skuCount,
      orderCount: orderCount,
      lineCount: lineCount,
      avgLinesPerOrder: orderCount ? lineCount / orderCount : 0,
      totalVelocity: totalVel,
      abc: abc,
      topSkus: top,
      source: active.source,
      classSource: active.classSource,
    };
  }

  /* ------------------------------------------------------------------
   * orderStreamShape(orders) -> { orders, lineCount, avgLinesPerOrder,
   * linesPerOrderMax } - the AGGREGATE the sim/flowsim/wms consume so they
   * never iterate the pool per frame. linesPerOrderMax inverts the
   * avg = (1+max)/2 relation those modules assume.
   * ------------------------------------------------------------------ */
  function orderStreamShape(orders) {
    const O = orders !== undefined ? orders : active.orderPool;
    if (!O || !O.length) return null;
    let lines = 0;
    for (const o of O) lines += o.lines.length;
    const avg = lines / O.length;
    return {
      orders: O.length,
      lineCount: lines,
      avgLinesPerOrder: avg,
      linesPerOrderMax: Math.max(1, Math.round(2 * avg - 1)),
    };
  }

  /* ------------------------------------------------------------------
   * toDataset(bundle) -> exactly the { skus, orders, classSource, stats }
   * shape simulation.js already consumes via cfg.dataset. SKUs are sorted
   * by velocity desc (index 0 = most popular, as the slotting code
   * expects); order lines map to that index. This is the seam through
   * which the sim consumes the SKU master + order pool WITHOUT any change
   * to simulation.js - and with nothing loaded, the sim never sees a
   * dataset, so it is byte-identical to the synthetic default.
   * ------------------------------------------------------------------ */
  function toDataset(bundle) {
    const src = bundle || active;
    const master = (src.skuMaster || []).slice().sort((a, b) => (b.velocity - a.velocity) || (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
    const skus = master.map((s) => ({ id: s.sku, picks: Math.max(0, Number(s.velocity) || 0), cls: s.abcClass, description: s.description }));
    const idx = {};
    skus.forEach((s, i) => { idx[s.id] = i; });
    const pool = src.orderPool || [];
    let dsOrders = null;
    let lineCount = 0;
    if (pool.length) {
      dsOrders = pool.map((o) => ({
        orderId: o.orderId,
        id: o.orderId,
        lines: o.lines
          .map((l) => { const skuIndex = idx[l.sku]; if (skuIndex == null) return null; lineCount++; return { skuIndex: skuIndex, qty: l.qty }; })
          .filter((l) => l !== null),
      }));
    }
    return {
      skus: skus,
      orders: dsOrders,
      classSource: src.classSource || active.classSource || "computed",
      source: src.source || active.source || "synthetic",
      stats: {
        skuCount: skus.length,
        orderCount: dsOrders ? dsOrders.length : 0,
        lineCount: lineCount,
        totalWeeklyPicks: skus.reduce((a, s) => a + s.picks, 0),
      },
    };
  }

  // Render a row-numbered error list as short text lines (UI + tests).
  function formatErrors(errors, maxListed) {
    const cap = maxListed || 25;
    const shown = errors.slice(0, cap);
    const out = shown.map((e) => "row " + e.row + ": " + e.msg);
    if (errors.length > shown.length) out.push("(+" + (errors.length - shown.length) + " more)");
    return out;
  }

  /* ------------------------------------------------------------------
   * The ACTIVE store: the currently-loaded SKU master + order pool that
   * the app and the sim read. generate()/import*() are PURE and do NOT
   * touch it; the app calls load()/clear() explicitly. Exposed live via
   * the skuMaster / orderPool getters so callers always see the current
   * data.
   * ------------------------------------------------------------------ */
  const active = { skuMaster: [], orderPool: [], source: "none", classSource: "computed" };

  function load(bundle) {
    if (!bundle) return;
    active.skuMaster = bundle.skuMaster || [];
    active.orderPool = bundle.orderPool || [];
    active.source = bundle.source || "synthetic";
    active.classSource = bundle.classSource || "computed";
    return active;
  }
  function clear() {
    active.skuMaster = [];
    active.orderPool = [];
    active.source = "none";
    active.classSource = "computed";
  }
  function isLoaded() { return active.skuMaster.length > 0; }

  WT.wmsdata = {
    // live view of the loaded data (getters so they never go stale)
    get skuMaster() { return active.skuMaster; },
    get orderPool() { return active.orderPool; },
    // generation (pure, deterministic)
    generate: generate,
    generateSkuMaster: generateSkuMaster,
    generateOrders: generateOrders,
    // CSV (import tolerant, export deterministic)
    importSkusCsv: importSkusCsv,
    importOrdersCsv: importOrdersCsv,
    exportSkusCsv: exportSkusCsv,
    exportOrdersCsv: exportOrdersCsv,
    // summaries + sim adapters
    stats: stats,
    orderStreamShape: orderStreamShape,
    toDataset: toDataset,
    formatErrors: formatErrors,
    // active-store management (used by the app)
    load: load,
    clear: clear,
    isLoaded: isLoaded,
    // constants / honesty
    PARAMS: PARAMS,
    HEADERS: HEADERS,
    SYNTHETIC_LABEL: SYNTHETIC_LABEL,
  };
})();
