/* =====================================================================
 * Logistics Flow Studio - WarehouseTwin
 * nlcommands.js - OFFLINE natural-language command parser (deterministic)
 * ---------------------------------------------------------------------
 * HARD HONESTY: this is NOT a language model. It is a DETERMINISTIC,
 * rule-based parser - a fixed set of patterns and a synonym table that
 * map typed instructions onto STRUCTURED ops for generate.js. It runs
 * fully offline in the browser: no cloud, no trained model, no network.
 * Unknown or ambiguous input is answered HONESTLY ("couldn't understand
 * / did you mean...") - it never silently guesses.
 *
 * WT.nl = { parse, apply }
 *   parse(text, ctx)          -> { ok, op, echo, message, suggestions }
 *   apply(layout, textOrOp)   -> runs generate.applyCommand and returns
 *                                { ok, layout, echo, message, ... }
 *
 * Supported phrasings (each returns a structured op + a plain-language
 * echo; see the honest "supported vs unsupported" list in the README):
 *   - "include/add N (more) RGV(s)/AGV(s)/conveyor(s)/rack(s) in the <zone>"
 *   - "leave zone <name> for manual expansion"  (reserve + mark empty)
 *   - "use the <profile> baseline"              (regenerate)
 *   - "remove the <type> in <zone>"
 *   - "widen the main aisle to X m"
 * ===================================================================== */
(function () {
  "use strict";
  const WT = (window.WT = window.WT || {});

  const ZONE_KEYS = ["receiving", "storage", "picking", "packing", "shipping"];

  // Zone synonyms (longest phrases first per key so multi-word wins).
  const ZONE_SYNONYMS = {
    receiving: ["goods in", "goods-in", "goods receiving", "receiving", "receipt", "inbound", "intake", "unloading", "receive"],
    storage: ["pallet storage", "storage", "racking", "rack area", "bulk store", "warehouse store", "store", "bulk"],
    picking: ["picking sector", "picking area", "picking zone", "pick sector", "pick area", "pick zone", "pick face", "pickface", "order picking", "picking", "picks", "pick"],
    packing: ["packing area", "pack area", "consolidation", "packaging", "packing", "packout", "pack"],
    shipping: ["goods out", "goods-out", "shipping area", "dispatch", "despatch", "outbound", "loading", "shipping", "ship"],
  };

  // Element-type synonyms (map to domain.js type ids). "rack" -> selective.
  const TYPE_SYNONYMS = {
    rgv: ["rgvs", "rgv", "rail-guided vehicles", "rail guided vehicles", "rail-guided vehicle", "rail guided vehicle"],
    agv: ["agvs", "agv", "amrs", "amr", "automated guided vehicles", "automated guided vehicle", "autonomous mobile robots", "autonomous mobile robot"],
    conveyor: ["conveyors", "conveyor", "conveyer", "conveyers", "belts", "belt"],
    "selective-racking": ["selective racking", "pallet racking", "pallet racks", "pallet rack", "racking", "racks", "rack", "shelving", "shelves", "shelf"],
    "carton-flow": ["carton-flow", "carton flow", "flow rack", "flow racks", "pick faces", "pick face"],
    "block-stack": ["block-stack", "block stack", "block stacking", "floor stack"],
    "pack-station": ["pack stations", "pack station", "packing stations", "packing station", "pack bench", "packing bench"],
    staging: ["staging areas", "staging area", "staging", "marshalling", "buffer"],
    shuttle: ["shuttle system", "shuttles", "shuttle"],
    "pallet-flow": ["pallet-flow", "pallet flow"],
    "drive-in": ["drive-in", "drive in"],
    "mobile-racking": ["mobile racking", "mobile racks", "mobile rack"],
    mezzanine: ["mezzanine"],
  };

  // Number words -> integers.
  const NUM_WORDS = {
    a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a_couple: 2, couple: 2, few: 3,
  };

  function profileKeys() {
    return (WT.generate && WT.generate.plantProfiles) ? Object.keys(WT.generate.plantProfiles) : [
      "ecommerce-fulfilment", "spare-parts-distribution", "automotive-supply", "cold-chain",
    ];
  }
  // Profile synonyms (built from the known keys + hand-written aliases).
  function profileSynonyms() {
    return {
      "ecommerce-fulfilment": ["ecommerce fulfilment", "ecommerce fulfillment", "e-commerce fulfilment", "e-commerce", "ecommerce", "fulfilment", "fulfillment", "online retail", "b2c", "parcel"],
      "spare-parts-distribution": ["spare-parts distribution", "spare parts distribution", "spare parts", "spare-parts", "spares", "aftermarket", "parts distribution", "mro"],
      "automotive-supply": ["automotive supply", "automotive", "car parts", "vehicle", "jit supply", "jis", "line-side", "tier 1", "oem supply"],
      "cold-chain": ["cold-chain", "cold chain", "temperature-controlled", "temperature controlled", "chilled", "frozen", "refrigerated", "freezer", "cold"],
    };
  }

  function norm(s) {
    return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  // Longest-synonym match: return the key whose synonym appears in text.
  function matchFromTable(text, table) {
    let best = null, bestLen = 0;
    for (const key of Object.keys(table)) {
      for (const syn of table[key]) {
        const idx = text.indexOf(syn);
        if (idx !== -1 && syn.length > bestLen) { best = key; bestLen = syn.length; }
      }
    }
    return best;
  }

  function matchZone(text) { return matchFromTable(text, ZONE_SYNONYMS); }
  function matchType(text) { return matchFromTable(text, TYPE_SYNONYMS); }
  function matchProfile(text) { return matchFromTable(text, profileSynonyms()); }

  function parseCount(text) {
    const digit = text.match(/(\d+)\s*(?:more\s+)?/);
    if (digit) return Math.max(1, parseInt(digit[1], 10));
    for (const w of Object.keys(NUM_WORDS)) {
      const re = new RegExp("\\b" + w.replace("_", " ") + "\\b");
      if (re.test(text)) return NUM_WORDS[w];
    }
    return 1;
  }

  const HELP_HINT =
    "I understand: \"include N RGVs/AGVs/conveyors/racks in the <zone>\", " +
    "\"remove the <type> in <zone>\", \"leave zone <name> for manual expansion\", " +
    "\"use the <profile> baseline\", and \"widen the main aisle to X m\". " +
    "Zones: receiving, storage, picking, packing, shipping.";

  function unknown(message, suggestions) {
    return {
      ok: false,
      op: null,
      echo: null,
      message: (message ? message + " " : "Sorry, I couldn't understand that. ") + HELP_HINT,
      suggestions: suggestions || [],
    };
  }

  /* ==================================================================
   * parse(text, ctx) -> { ok, op, echo, message, suggestions }
   * ctx (optional): { zones:[keys], profiles:[keys] } to validate against
   * the current layout - defaults to the full vocabulary.
   * ================================================================== */
  function parse(text, ctx) {
    const raw = String(text == null ? "" : text);
    const t = norm(raw);
    if (!t) return unknown("Type an instruction first.");
    ctx = ctx || {};
    const knownZones = Array.isArray(ctx.zones) && ctx.zones.length ? ctx.zones : ZONE_KEYS;

    // ---- 1. WIDEN: "widen the main aisle to X m" -------------------
    if (/\b(widen|widening|set|change|make)\b/.test(t) && /\baisle\b/.test(t)) {
      const m = t.match(/(\d+(?:\.\d+)?)\s*(?:m\b|metre|meter|meters|metres)?/);
      if (m) {
        const metres = parseFloat(m[1]);
        return {
          ok: true,
          op: { kind: "widen", metres: metres },
          echo: "Understood: widen the main working aisle to " + metres + " m.",
          message: "widen main aisle -> " + metres + " m",
          suggestions: [],
        };
      }
      return unknown("Tell me the new aisle width, e.g. \"widen the main aisle to 4 m\".");
    }

    // ---- 2. RESERVE: "leave zone <name> for manual expansion" ------
    if (/\b(leave|reserve|keep|set aside|hold)\b/.test(t) &&
        (/\b(manual|expansion|expand|empty|later|free|open|reserved?)\b/.test(t) || /\bzone\b/.test(t))) {
      const zone = matchZone(t);
      if (zone && knownZones.indexOf(zone) !== -1) {
        return {
          ok: true,
          op: { kind: "reserve", zone: zone },
          echo: "Understood: leave the " + zone + " zone empty and reserved for manual expansion.",
          message: "reserve zone -> " + zone,
          suggestions: [],
        };
      }
      return unknown("Which zone should I reserve?", knownZones);
    }

    // ---- 3. REGENERATE: "use the <profile> baseline" ---------------
    if (/\b(use|switch to|start (?:from|with)|rebuild|regenerate|reset to|base(?:line)? on|generate)\b/.test(t) &&
        (/\bbaseline\b/.test(t) || /\bprofile\b/.test(t) || /\bregenerate\b/.test(t) || /\bswitch to\b/.test(t))) {
      const pk = matchProfile(t);
      if (pk) {
        return {
          ok: true,
          op: { kind: "regenerate", profileKey: pk },
          echo: "Understood: rebuild from the " + pk + " baseline.",
          message: "regenerate -> " + pk,
          suggestions: [],
        };
      }
      return unknown("Which plant baseline?", profileKeys());
    }

    // ---- 4. REMOVE: "remove the <type> in <zone>" ------------------
    if (/\b(remove|delete|clear|take out|get rid of)\b/.test(t)) {
      const type = matchType(t);
      const zone = matchZone(t);
      if (type && zone && knownZones.indexOf(zone) !== -1) {
        return {
          ok: true,
          op: { kind: "remove", type: type, zone: zone },
          echo: "Understood: remove the " + labelOf(type) + " from the " + zone + " zone.",
          message: "remove " + type + " -> " + zone,
          suggestions: [],
        };
      }
      if (type && !zone) return unknown("Remove the " + labelOf(type) + " from which zone?", knownZones);
      return unknown("What should I remove, and from which zone?", knownZones);
    }

    // ---- 5. ADD: "include/add N (more) <type> in the <zone>" -------
    if (/\b(include|add|place|put|insert|drop|introduce|more)\b/.test(t)) {
      const type = matchType(t);
      const zone = matchZone(t);
      const count = parseCount(t);
      if (type && zone && knownZones.indexOf(zone) !== -1) {
        return {
          ok: true,
          op: { kind: "add", type: type, count: count, zone: zone },
          echo: "Understood: add " + count + " " + labelOf(type) + (count === 1 ? "" : "s") + " to the " + zone + " zone.",
          message: "add " + count + " " + type + " -> " + zone,
          suggestions: [],
        };
      }
      if (type && !zone) return unknown("Add " + count + " " + labelOf(type) + (count === 1 ? "" : "s") + " to which zone?", knownZones);
      if (!type && zone) return unknown("What should I add to the " + zone + " zone?");
      return unknown("What should I add, and to which zone?", knownZones);
    }

    return unknown();
  }

  function labelOf(type) {
    return (WT.domain && WT.domain.ELEMENTS[type] && WT.domain.ELEMENTS[type].label) || type;
  }

  /* ==================================================================
   * apply(layout, textOrOp, ctx) -> executes via generate.applyCommand.
   * Accepts a raw string (parsed here) OR an already-structured op.
   * ================================================================== */
  function apply(layout, textOrOp, ctx) {
    let op, parseEcho = null;
    if (typeof textOrOp === "string") {
      const p = parse(textOrOp, ctx);
      if (!p.ok) return { ok: false, layout: null, echo: null, message: p.message, suggestions: p.suggestions, op: null };
      op = p.op;
      parseEcho = p.echo;
    } else if (textOrOp && textOrOp.op) {
      op = textOrOp.op; parseEcho = textOrOp.echo || null;
    } else {
      op = textOrOp;
    }
    if (!WT.generate || typeof WT.generate.applyCommand !== "function") {
      return { ok: false, layout: null, echo: null, message: "The generator engine is not loaded.", op: op };
    }
    const res = WT.generate.applyCommand(layout, op);
    return {
      ok: res.ok,
      layout: res.layout,
      echo: res.echo,
      message: res.message,
      changed: res.changed,
      kind: res.kind || op.kind,
      op: op,
      parseEcho: parseEcho,
      suggestions: res.suggestions || [],
    };
  }

  WT.nl = { parse: parse, apply: apply, ZONE_KEYS: ZONE_KEYS };
})();
