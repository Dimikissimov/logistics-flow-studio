/* =====================================================================
 * Logistics Flow Studio - WarehouseTwin
 * generate.js - the AI Environment Generator engine (offline, honest)
 * ---------------------------------------------------------------------
 * HARD HONESTY (mirrored in the UI + README): this is an AI-ASSISTED
 * GENERATIVE LAYOUT engine - a DETERMINISTIC rule/heuristic procedure,
 * NOT a trained black-box model and NOT a cloud service. It runs 100%
 * in the browser on a normal laptop: no network, no GPU, no new deps.
 * A generated baseline is a BEST-PRACTICE-INFORMED STARTING POINT, not
 * an engineered or certified plan. It is checked against the SAME
 * ASR/DIN guidance as the rest of the app (compliance.js) - informed by,
 * NOT a certification.
 *
 * WT.generate = { plantProfiles, generateLayout, applyCommand }
 *   plantProfiles                 4 keyed plant profiles (the vocabulary)
 *   generateLayout(key, opts)     seeded, deterministic procedural build
 *                                 -> { elements, config, meta }
 *   applyCommand(layout, op)      the structured-op executor that steers
 *                                 a layout (add / remove / reserve /
 *                                 regenerate / widen) - reused by nl.apply
 *
 * Determinism: pure functions of (profileKey, seed, gridW, gridH). No
 * Date, no Math.random - a seeded mulberry32 PRNG only. The same inputs
 * yield byte-identical JSON (verified in verify_generate.js).
 *
 * Classic script attaching to the global `WT` namespace so it works from
 * file:// too. Reuses domain.js (element vocab, overlap-free placement).
 * ===================================================================== */
(function () {
  "use strict";
  const WT = (window.WT = window.WT || {});
  const D = WT.domain;
  const ELEMENTS = D.ELEMENTS;

  const GENERATOR_VERSION = "wt-generate-1";
  const SERIALIZE_VERSION = "wt-1"; // matches app.js serialize()/share.js

  // Canonical functional zones (instructions target these by name).
  const ZONE_KEYS = ["receiving", "storage", "picking", "packing", "shipping"];
  const ZONE_LABELS = {
    receiving: "receiving",
    storage: "storage",
    picking: "picking",
    packing: "packing",
    shipping: "shipping",
  };

  /* ------------------------------------------------------------------
   * Seeded PRNG (mulberry32) + a small string hash so every profile+seed
   * pair maps to its own deterministic stream. No global RNG is touched.
   * ------------------------------------------------------------------ */
  function hashStr(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ------------------------------------------------------------------
   * PLANT PROFILES (the 4 keyed vocabularies). Keys are PINNED strings
   * the Python engine mirrors. Each profile declares its zone mix,
   * racking systems, minimum working aisle, dock counts and the typical
   * automation - all synthetic, best-practice-informed teaching values.
   * ------------------------------------------------------------------ */
  const PROFILES = {
    "ecommerce-fulfilment": {
      key: "ecommerce-fulfilment",
      label: "E-commerce fulfilment centre",
      keywords: ["e-commerce", "online retail", "B2C parcels", "fast small-item picking"],
      // Small items, huge SKU count, very high pick velocity, many ship docks.
      storageTypes: ["carton-flow", "selective-racking", "mezzanine"],
      pickTypes: ["carton-flow", "mezzanine"],
      transport: "agv", // AGV/AMR + conveyor sortation
      minAisleMetres: 2.9, // reach truck
      docksIn: 2,
      docksOut: 4,
      automation: "AGV/AMR fleet + conveyor sortation to pack",
      strategy: "batch",
      orders: 300,
      skuCount: 160,
      flowMode: "pull",
      demandSkew: 1.2,
      summary:
        "an e-commerce fulfilment centre: carton-flow pick faces and a mezzanine for small items, an AGV/AMR spine feeding a conveyor to a wide pack-and-ship wall (few receiving docks, many shipping docks), batch picking on 80/20 demand",
    },
    "spare-parts-distribution": {
      key: "spare-parts-distribution",
      label: "Spare-parts distribution centre",
      keywords: ["aftermarket spares", "very high SKU count", "small parts", "MRO"],
      storageTypes: ["selective-racking", "carton-flow", "shuttle"],
      pickTypes: ["carton-flow"],
      transport: "rgv",
      minAisleMetres: 1.8, // VNA / narrow aisle for density
      docksIn: 2,
      docksOut: 2,
      automation: "shuttle small-parts + carton-flow, VNA narrow aisles",
      strategy: "zone",
      orders: 260,
      skuCount: 240,
      flowMode: "pull",
      demandSkew: 1.15,
      summary:
        "a spare-parts distribution centre: dense narrow-aisle (VNA) selective racking with a shuttle small-parts store and carton-flow pick faces, an RGV transport lane, zone picking on a very high SKU count",
    },
    "automotive-supply": {
      key: "automotive-supply",
      label: "Automotive supply / JIT centre",
      keywords: ["automotive parts", "sequenced JIT/JIS supply", "line-side feed"],
      storageTypes: ["selective-racking", "pallet-flow", "drive-in"],
      pickTypes: ["pallet-flow", "carton-flow"],
      transport: "rgv", // RGVs are classic in automotive plants
      minAisleMetres: 3.0, // reach truck, pallet handling
      docksIn: 4,
      docksOut: 4,
      automation: "RGV transport spine + pallet-flow line-feed, many JIT docks",
      strategy: "wave",
      orders: 220,
      skuCount: 110,
      flowMode: "pull",
      demandSkew: 1.05,
      summary:
        "an automotive JIT/JIS supply centre: selective and pallet-flow racking with a drive-in bulk block, an RGV transport spine feeding line-side pick faces, wave picking and many balanced in/out docks for sequenced delivery",
    },
    "cold-chain": {
      key: "cold-chain",
      label: "Cold-chain / temperature-controlled DC",
      keywords: ["chilled/frozen goods", "dense storage", "few doors to hold temperature"],
      storageTypes: ["mobile-racking", "drive-in", "selective-racking"],
      pickTypes: ["carton-flow"],
      transport: null, // dense manual/mobile, no transport spine in the baseline
      minAisleMetres: 1.8, // mobile/VNA compact aisle to save cold volume
      docksIn: 2,
      docksOut: 2,
      automation: "mobile (compact) racking + drive-in for density, few docks",
      strategy: "abc",
      orders: 180,
      skuCount: 90,
      flowMode: "push",
      demandSkew: 1.1,
      summary:
        "a cold-chain (temperature-controlled) DC: mobile compact racking and drive-in lanes for maximum density in the cooled volume, carton-flow pick faces, few insulated docks and push replenishment",
    },
  };

  /* ------------------------------------------------------------------
   * Geometry helpers (grid cells). Overlap-free by construction; these
   * back the assertions in verify_generate.js and the applyCommand ops.
   * ------------------------------------------------------------------ */
  function rectsOverlap(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.d && b.y < a.y + a.d;
  }
  function clampInt(v, lo, hi, dflt) {
    let n = Math.round(Number(v));
    if (!isFinite(n)) n = dflt;
    return Math.max(lo, Math.min(hi, n));
  }
  // The integer working-aisle gap (in metres/cells) for a min aisle. We
  // clear the compliance WARN margin (0.25 m) so a fresh baseline PASSES
  // the aisle-width check rather than only warning - the honest "widen
  // aisles if too narrow" rule, applied up front.
  function aisleCells(minAisle) {
    return Math.max(2, Math.ceil(minAisle + 0.25 + 1e-9));
  }

  // Evenly spread `n` items of width `w` across [lo, hi), integer x's,
  // non-overlapping, deterministic (no RNG). Used for docks + pack cells.
  function spread(n, w, lo, hi) {
    const out = [];
    if (n <= 0) return out;
    const span = hi - lo;
    const slot = span / n;
    for (let i = 0; i < n; i++) {
      let x = Math.round(lo + slot * i + (slot - w) / 2);
      x = Math.max(lo, Math.min(hi - w, x));
      out.push(x);
    }
    for (let i = 1; i < out.length; i++) {
      if (out[i] < out[i - 1] + w) out[i] = out[i - 1] + w;
    }
    // final clamp so the last item stays in-bounds
    for (let i = out.length - 1; i > 0; i--) {
      if (out[i] > hi - w) out[i] = hi - w;
      if (out[i] < out[i - 1] + w) out[i - 1] = out[i] - w;
    }
    return out;
  }

  /* ==================================================================
   * generateLayout(profileKey, opts) -> { elements, config, meta }
   * DETERMINISTIC seeded procedural generation. Overlap-free. Aims to
   * PASS (or at worst honestly WARN) compliance.check for every profile.
   *
   * opts: { gridW=40, gridH=24, seed, reserve=[], minAisleOverride }
   *   reserve          zone keys to leave EMPTY + visibly reserved
   *   minAisleOverride widen/override the profile's working aisle
   * ================================================================== */
  function generateLayout(profileKey, opts) {
    opts = opts || {};
    const profile = PROFILES[profileKey];
    if (!profile) throw new Error("Unknown plant profile: " + profileKey);

    const gridW = clampInt(opts.gridW, 24, 400, 40);
    const gridH = clampInt(opts.gridH, 18, 400, 24);
    const seed = Number.isFinite(opts.seed) ? opts.seed >>> 0 : (hashStr(profileKey) & 0xffff);
    const reserve = normalizeZones(opts.reserve);
    const minAisle = Number.isFinite(opts.minAisleOverride) && opts.minAisleOverride > 0
      ? opts.minAisleOverride
      : profile.minAisleMetres;
    const aisle = aisleCells(minAisle);
    const pitch = 1 + aisle; // one rack row (d=1) + one working aisle

    const rng = mulberry32((hashStr(profileKey) ^ Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b)) >>> 0);
    const pick = (arr) => arr[Math.floor(rng() * arr.length) % arr.length];

    const marginX = 2;
    const xL = marginX;
    const rowW = gridW - 2 * marginX; // full usable width
    const isReserved = (key) => reserve.indexOf(key) !== -1;

    const els = [];
    let idc = 0;
    const add = (type, x, y, w, d, zone) => {
      // Reserved zones stay empty EXCEPT for docks (infrastructure/exits).
      if (isReserved(zone) && type !== "dock-in" && type !== "dock-out") return;
      els.push({ id: "gen-" + ++idc, type: type, x: x, y: y, w: w, d: d, zone: zone });
    };

    // ---- band budget (see the ASCII sketch in the README) ----
    // A 2-cell clear buffer is kept between every fixture row and the grid
    // wall (dock row aside) so the escape network never pinches to 1 m at
    // the perimeter - the layout reads clean against the ASR A2.3 width.
    const stagingY = 2;                 // staging (d=2 -> y2,3); y1 stays clear
    const midTop = 6;                   // 2 clear rows (y4,y5) below staging
    const shipDockY = gridH - 1;        // outbound docks on the bottom edge
    const conveyorY = gridH - 3;        // pack conveyor spine (full width); y(H-2) clear
    const packY = gridH - 5;            // pack stations (d=2 -> gridH-5,-4)
    const midBottom = gridH - 8;        // >=2 clear rows above the pack band

    // ---- RECEIVING (top edge) ----
    for (const x of spread(profile.docksIn, 2, xL, gridW - marginX)) {
      add("dock-in", x, 0, 2, 1, "receiving");
    }
    // Staging blocks hug the docks (connectors, so they never block the
    // dock's traffic route). Placed at dock x-slots, non-overlapping.
    if (!isReserved("receiving")) {
      const stW = 4;
      for (const x of spread(profile.docksIn, 2, xL, gridW - marginX)) {
        const sx = Math.max(xL, Math.min(gridW - marginX - stW, x - 1));
        add("staging", sx, stagingY, stW, 2, "receiving");
      }
    }

    // ---- the mid region: storage rows, a transport spine, picking rows ----
    const rowYs = [];
    for (let y = midTop; y <= midBottom; y += pitch) rowYs.push(y);
    const nRows = rowYs.length;

    // Row allocation: >=1 storage + >=1 picking; a transport lane sits
    // between them when the profile uses one.
    const hasTransport = !!profile.transport && nRows >= 3;
    let nPick = Math.max(1, Math.floor(nRows / 3));
    let nStore = nRows - nPick - (hasTransport ? 1 : 0);
    if (nStore < 1) { nStore = 1; nPick = Math.max(1, nRows - 1 - (hasTransport ? 1 : 0)); }

    let ri = 0;
    // STORAGE rows (full-width single racks -> only vertical facing pairs,
    // each gap == the working aisle, so the aisle-width check is clean).
    for (let k = 0; k < nStore && ri < nRows; k++, ri++) {
      add(pick(profile.storageTypes), xL, rowYs[ri], rowW, 1, "storage");
    }
    // TRANSPORT spine (rgv/agv) - full-width lane tagged to picking.
    if (hasTransport && ri < nRows) {
      add(profile.transport, xL, rowYs[ri], rowW, 1, "picking");
      ri++;
    }
    // PICKING rows (pick faces).
    for (; ri < nRows; ri++) {
      add(pick(profile.pickTypes), xL, rowYs[ri], rowW, 1, "picking");
    }

    // ---- PACKING (bottom) ----
    if (!isReserved("packing")) {
      add("conveyor", xL, conveyorY, rowW, 1, "packing");
      const nPack = Math.max(1, Math.min(profile.docksOut, Math.floor(rowW / 6)));
      for (const x of spread(nPack, 3, xL, gridW - marginX)) {
        add("pack-station", x, packY, 3, 2, "packing");
      }
    }

    // ---- SHIPPING (bottom edge) ----
    for (const x of spread(profile.docksOut, 2, xL, gridW - marginX)) {
      add("dock-out", x, shipDockY, 2, 1, "shipping");
    }

    // ---- zones (bounding boxes of their elements; picking extended down
    // into the free aisle so later "add ... in picking" has room) ----
    const zones = buildZones(els, gridW, gridH, reserve);

    // safety: assert overlap-free (never fires by construction).
    assertNoOverlap(els);

    const config = {
      seed: seed,
      strategy: profile.strategy || "abc",
      orders: profile.orders || 200,
      skuCount: profile.skuCount || 80,
      minAisleMetres: minAisle,
      flowMode: profile.flowMode === "push" ? "push" : "pull",
      demandSkew: profile.demandSkew || 1.0,
      palletType: "EUR1",
      boxType: "EURO-CASE",
      wagePerHour: 22,
      weeklyOrders: 1500,
    };

    const counts = countByZone(els);
    const meta = {
      version: SERIALIZE_VERSION,
      generator: GENERATOR_VERSION,
      profileKey: profileKey,
      profileLabel: profile.label,
      seed: seed,
      gridW: gridW,
      gridH: gridH,
      minAisleMetres: minAisle,
      aisleCells: aisle,
      automation: profile.automation,
      zones: zones,
      reserved: reserve.slice(),
      counts: counts,
      summary: plainSummary(profile, seed, gridW, gridH, minAisle, reserve, counts),
    };

    return { elements: els, config: config, meta: meta, gridW: gridW, gridH: gridH };
  }

  function plainSummary(profile, seed, gridW, gridH, minAisle, reserve, counts) {
    let s =
      "Generated " + profile.summary + " on a " + gridW + "x" + gridH + " m floor " +
      "(seed " + seed + ", " + minAisle + " m min working aisle). " +
      "Automation: " + profile.automation + ". " +
      "Elements: " + counts.total + " total (" + counts.storage + " storage, " +
      counts.picking + " picking, " + counts.receiving + " receiving, " +
      counts.packing + " packing, " + counts.shipping + " shipping).";
    if (reserve.length) {
      s += " Reserved for manual expansion: " + reserve.join(", ") + " (left empty).";
    }
    s += " AI-assisted generative layout - a best-practice-informed starting point, " +
      "checked against ASR/DIN guidance (informed by, NOT certified).";
    return s;
  }

  function countByZone(els) {
    const c = { total: els.length, receiving: 0, storage: 0, picking: 0, packing: 0, shipping: 0 };
    for (const e of els) if (c[e.zone] !== undefined) c[e.zone]++;
    return c;
  }

  // Bounding-box zone rectangles from the placed elements. Picking is
  // padded downward to the last free aisle row so command-driven adds
  // ("include 2 more RGVs in the picking sector") have room to land.
  function buildZones(els, gridW, gridH, reserve) {
    const byZone = {};
    for (const key of ZONE_KEYS) byZone[key] = [];
    for (const e of els) if (byZone[e.zone]) byZone[e.zone].push(e);
    const out = [];
    const packTop = gridH - 5;
    for (const key of ZONE_KEYS) {
      const list = byZone[key];
      let rect;
      if (list.length) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const e of list) {
          x0 = Math.min(x0, e.x); y0 = Math.min(y0, e.y);
          x1 = Math.max(x1, e.x + e.w); y1 = Math.max(y1, e.y + e.d);
        }
        rect = { x: x0, y: y0, w: x1 - x0, d: y1 - y0 };
      } else {
        // Reserved/empty zone: fall back to a sensible band so the
        // reserved overlay still has somewhere to draw.
        rect = defaultZoneRect(key, gridW, gridH);
      }
      if (key === "picking") {
        // extend into the free aisle above the pack band
        rect = { x: 2, y: rect.y, w: gridW - 4, d: Math.max(rect.d, (packTop - 1) - rect.y) };
      }
      out.push({
        key: key,
        label: ZONE_LABELS[key],
        x: rect.x, y: rect.y, w: Math.max(1, rect.w), d: Math.max(1, rect.d),
        reserved: reserve.indexOf(key) !== -1,
      });
    }
    return out;
  }

  function defaultZoneRect(key, gridW, gridH) {
    const w = gridW - 4;
    switch (key) {
      case "receiving": return { x: 2, y: 0, w: w, d: 3 };
      case "storage": return { x: 2, y: 6, w: w, d: Math.max(1, (gridH - 14)) };
      case "picking": return { x: 2, y: Math.floor(gridH / 2), w: w, d: Math.max(1, gridH - 6 - Math.floor(gridH / 2)) };
      case "packing": return { x: 2, y: gridH - 5, w: w, d: 4 };
      case "shipping": return { x: 2, y: gridH - 1, w: w, d: 1 };
      default: return { x: 2, y: 2, w: w, d: 2 };
    }
  }

  function assertNoOverlap(els) {
    for (let i = 0; i < els.length; i++) {
      for (let j = i + 1; j < els.length; j++) {
        if (rectsOverlap(els[i], els[j])) {
          throw new Error("generateLayout produced overlapping elements: " + els[i].id + " / " + els[j].id);
        }
      }
    }
  }

  /* ==================================================================
   * applyCommand(layout, op) -> { ok, layout, echo, message, changed }
   * The structured-op executor. `layout` is { elements, config, meta,
   * gridW, gridH } (as returned by generateLayout, or a shallow shape
   * carrying meta.zones). Pure: returns a NEW layout, never mutates.
   * ================================================================== */
  function applyCommand(layout, op) {
    if (!op || typeof op !== "object") return failOp("No command to apply.");
    const grid = gridOf(layout);
    const lay = ensureZones(layout, grid); // build zones on demand if absent
    switch (op.kind) {
      case "add": return opAdd(lay, op, grid);
      case "remove": return opRemove(lay, op);
      case "reserve": return opReserve(lay, op);
      case "release": return opRelease(lay, op);
      case "regenerate": return opRegenerate(lay, op, grid);
      case "widen": return opWiden(lay, op, grid);
      default: return failOp("Unsupported operation: " + op.kind);
    }
  }

  // Guarantee layout.meta.zones exists so ops work whether or not the
  // caller precomputed them (the UI does; a bare {elements} may not).
  function ensureZones(layout, grid) {
    if (layout && layout.meta && Array.isArray(layout.meta.zones)) return layout;
    const reserved = (layout && layout.meta && layout.meta.reserved) || [];
    const zones = buildZones((layout && layout.elements) || [], grid.w, grid.h, reserved);
    return Object.assign({}, layout, {
      meta: Object.assign({}, (layout && layout.meta) || {}, { zones: zones, reserved: reserved }),
    });
  }

  function gridOf(layout) {
    const m = (layout && layout.meta) || {};
    return {
      w: clampInt(layout && layout.gridW || m.gridW, 24, 400, 40),
      h: clampInt(layout && layout.gridH || m.gridH, 18, 400, 24),
    };
  }
  function failOp(message, suggestions) {
    return { ok: false, layout: null, echo: message, message: message, changed: 0, suggestions: suggestions || [] };
  }
  function zoneList(layout) {
    return (layout && layout.meta && Array.isArray(layout.meta.zones)) ? layout.meta.zones : [];
  }
  function findZone(layout, key) {
    return zoneList(layout).find((z) => z.key === key) || null;
  }
  function maxId(els) {
    let m = 0;
    for (const e of els) {
      const n = parseInt(String(e.id).replace(/\D/g, ""), 10);
      if (!isNaN(n)) m = Math.max(m, n);
    }
    return m;
  }
  function labelOfType(type) {
    return (ELEMENTS[type] || {}).label || type;
  }
  function withMeta(layout, patch) {
    return Object.assign({}, layout, { meta: Object.assign({}, layout.meta, patch) });
  }
  function withElements(layout, elements) {
    const zones = buildZones(elements, gridOf(layout).w, gridOf(layout).h,
      (layout.meta && layout.meta.reserved) || []);
    const counts = countByZone(elements);
    return Object.assign({}, layout, {
      elements: elements,
      meta: Object.assign({}, layout.meta, { zones: zones, counts: counts }),
    });
  }

  // First free, in-bounds, non-overlapping slot inside a zone rect.
  function firstFreeSpot(elements, w, d, zone, grid) {
    const x0 = Math.max(0, zone.x), y0 = Math.max(0, zone.y);
    const x1 = Math.min(grid.w, zone.x + zone.w), y1 = Math.min(grid.h, zone.y + zone.d);
    for (let y = y0; y + d <= y1; y++) {
      for (let x = x0; x + w <= x1; x++) {
        const cand = { x: x, y: y, w: w, d: d };
        let clash = false;
        for (const e of elements) { if (rectsOverlap(cand, e)) { clash = true; break; } }
        if (!clash) return { x: x, y: y };
      }
    }
    return null;
  }

  function opAdd(layout, op, grid) {
    const def = ELEMENTS[op.type];
    if (!def) return failOp("I don't know an element called \"" + op.type + "\".");
    const zone = findZone(layout, op.zone);
    if (!zone) return failOp("I couldn't find a \"" + op.zone + "\" zone.", ZONE_KEYS);
    const count = Math.max(1, Math.min(50, op.count || 1));
    const els = layout.elements.slice();
    let idc = maxId(els);
    let placed = 0;
    for (let k = 0; k < count; k++) {
      const spot = firstFreeSpot(els, def.w, def.d, zone, grid);
      if (!spot) break;
      els.push({ id: "gen-" + ++idc, type: op.type, x: spot.x, y: spot.y, w: def.w, d: def.d, zone: zone.key });
      placed++;
    }
    if (placed === 0) return failOp("No free floor left in the " + zone.label + " zone for a " + labelOfType(op.type) + ".");
    const echo =
      "Added " + placed + " " + labelOfType(op.type) + (placed === 1 ? "" : "s") +
      " to the " + zone.label + " zone" + (placed < count ? " (only " + placed + " of " + count + " fit)" : "") + ".";
    return { ok: true, layout: withElements(layout, els), echo: echo, message: echo, changed: placed, kind: "add" };
  }

  function opRemove(layout, op) {
    const zone = findZone(layout, op.zone);
    if (!zone) return failOp("I couldn't find a \"" + op.zone + "\" zone.", ZONE_KEYS);
    const before = layout.elements.length;
    const kept = layout.elements.filter((e) => !(e.type === op.type && e.zone === zone.key));
    const removed = before - kept.length;
    if (removed === 0) return failOp("There is no " + labelOfType(op.type) + " in the " + zone.label + " zone to remove.");
    const echo = "Removed " + removed + " " + labelOfType(op.type) + (removed === 1 ? "" : "s") + " from the " + zone.label + " zone.";
    return { ok: true, layout: withElements(layout, kept), echo: echo, message: echo, changed: removed, kind: "remove" };
  }

  function opReserve(layout, op) {
    const zone = findZone(layout, op.zone);
    if (!zone) return failOp("I couldn't find a \"" + op.zone + "\" zone to reserve.", ZONE_KEYS);
    // Clear the zone's non-dock elements; docks stay (exits/infrastructure).
    const kept = layout.elements.filter((e) => !(e.zone === zone.key && e.type !== "dock-in" && e.type !== "dock-out"));
    const cleared = layout.elements.length - kept.length;
    const reserved = ((layout.meta && layout.meta.reserved) || []).slice();
    if (reserved.indexOf(zone.key) === -1) reserved.push(zone.key);
    let out = withElements(layout, kept);
    out = withMeta(out, { reserved: reserved });
    out.meta.zones = out.meta.zones.map((z) => (z.key === zone.key ? Object.assign({}, z, { reserved: true }) : z));
    const echo =
      "Reserved the " + zone.label + " zone for manual expansion" +
      (cleared ? " (cleared " + cleared + " element" + (cleared === 1 ? "" : "s") + ", left empty and marked)" : " (left empty and marked)") + ".";
    return { ok: true, layout: out, echo: echo, message: echo, changed: cleared, kind: "reserve" };
  }

  function opRelease(layout, op) {
    const zone = findZone(layout, op.zone);
    if (!zone) return failOp("I couldn't find a \"" + op.zone + "\" zone.", ZONE_KEYS);
    const reserved = ((layout.meta && layout.meta.reserved) || []).filter((k) => k !== zone.key);
    let out = withMeta(layout, { reserved: reserved });
    out.meta.zones = out.meta.zones.map((z) => (z.key === zone.key ? Object.assign({}, z, { reserved: false }) : z));
    const echo = "Released the " + zone.label + " zone (no longer reserved).";
    return { ok: true, layout: out, echo: echo, message: echo, changed: 0, kind: "release" };
  }

  function opRegenerate(layout, op, grid) {
    if (!PROFILES[op.profileKey]) return failOp("I don't have a \"" + op.profileKey + "\" baseline.", Object.keys(PROFILES));
    const seed = (layout.meta && Number.isFinite(layout.meta.seed)) ? layout.meta.seed : undefined;
    const reserve = (layout.meta && layout.meta.reserved) || [];
    const gen = generateLayout(op.profileKey, { gridW: grid.w, gridH: grid.h, seed: seed, reserve: reserve });
    const echo = "Rebuilt the environment from the " + PROFILES[op.profileKey].label + " baseline (seed " + gen.meta.seed + ").";
    return { ok: true, layout: gen, echo: echo, message: echo, changed: gen.elements.length, kind: "regenerate" };
  }

  function opWiden(layout, op, grid) {
    const m = Number(op.metres);
    if (!isFinite(m) || m <= 0) return failOp("Give a positive aisle width, e.g. \"widen the main aisle to 4 m\".");
    const profileKey = (layout.meta && layout.meta.profileKey);
    if (!profileKey || !PROFILES[profileKey]) return failOp("Widen needs a generated baseline first - generate an environment, then widen its aisle.");
    const seed = (layout.meta && Number.isFinite(layout.meta.seed)) ? layout.meta.seed : undefined;
    const reserve = (layout.meta && layout.meta.reserved) || [];
    const gen = generateLayout(profileKey, { gridW: grid.w, gridH: grid.h, seed: seed, reserve: reserve, minAisleOverride: m });
    const echo = "Widened the main working aisle to " + m + " m and re-flowed the " + PROFILES[profileKey].label + " baseline.";
    return { ok: true, layout: gen, echo: echo, message: echo, changed: gen.elements.length, kind: "widen" };
  }

  /* ------------------------------------------------------------------
   * Shared normalisation used by generateLayout + nlcommands.js.
   * ------------------------------------------------------------------ */
  function normalizeZones(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const z of list) {
      if (ZONE_KEYS.indexOf(z) !== -1 && out.indexOf(z) === -1) out.push(z);
    }
    return out;
  }

  WT.generate = {
    VERSION: GENERATOR_VERSION,
    SERIALIZE_VERSION: SERIALIZE_VERSION,
    ZONE_KEYS: ZONE_KEYS,
    plantProfiles: PROFILES,
    generateLayout: generateLayout,
    applyCommand: applyCommand,
    // helpers exposed for the UI + the NL layer (and tests)
    buildZones: buildZones,
    countByZone: countByZone,
    rectsOverlap: rectsOverlap,
    aisleCells: aisleCells,
  };
})();
