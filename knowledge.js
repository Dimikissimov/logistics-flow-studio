/* =====================================================================
 * Logistics Flow Studio - WarehouseTwin
 * knowledge.js - the EDITABLE, versioned standards knowledge base (P5)
 * ---------------------------------------------------------------------
 * The "knowledge" the app reasons over - the standards-derived numeric
 * parameters and thresholds the Compliance Check, the Advisor, the AI
 * Environment Generator and the capacity model use - collected here as a
 * SINGLE, EDITABLE source of truth the user can view, edit, extend,
 * reset and import/export.
 *
 * Every seed value is the SAME number the code already used (pulled from
 * domain.js where it lives, so the two can never drift) plus its
 * standard / corpus source string and an honest "informed by, NOT a
 * certification" note. The consumers (compliance.js, advisor.js,
 * generate.js, domain.elementCapacity) READ from here through a
 * fallback-safe getter: when this module is absent, or the entry is
 * untouched, they fall back to the original constant, so DEFAULT
 * behaviour is byte-identical to before. Editing a value here visibly
 * changes the result the engines produce - that is the point.
 *
 * HARD HONESTY (mirrors WMS_STANDARDS_CORPUS.md): the values are
 * *informed by* published standards (ISO / DIN / EN / VDI / ASR / FEM)
 * and the project corpus. They are NOT a certification and NOT legally
 * binding. Numbers that live behind a paid standard text are recorded
 * only from official abstracts / reputable secondary sources and remain
 * the user's to verify. Any value the user edits is the user's own
 * responsibility to justify; a passing check never means "compliant".
 *
 * Each entry: { id, category, label, value, unit, source, note,
 *               editable, kind, min, max }.
 *
 * No frameworks, no build step, no network. Classic script attaching to
 * the global `WT` namespace so it works from file:// too. Loads AFTER
 * domain.js (it seeds from the domain constants), BEFORE the consumers
 * run (they read it at call time).
 * ===================================================================== */
(function () {
  "use strict";
  const WT = (window.WT = window.WT || {});
  const D = WT.domain || {};

  const KB_VERSION = "wt-kb-1";
  const STORAGE_KEY = "wt-kb-v1"; // localStorage key for user edits (optional)

  // ------------------------------------------------------------------
  // Honest, bilingual banner shared by the panel + meta. Matches the
  // tone of the compliance disclaimer and the corpus honesty rules.
  // ------------------------------------------------------------------
  const HONESTY = {
    en:
      "Informed by public standards (ISO / DIN / EN / VDI / ASR / FEM) and the project standards corpus - these values are NOT a certification and NOT legally binding. Numbers that live behind a paid standard text are recorded only from official abstracts or reputable secondary sources and remain yours to verify against the purchased full text. Any value you edit is your own responsibility to justify; a passing check never means a layout is compliant.",
    de:
      "Orientiert an oeffentlichen Normen (ISO / DIN / EN / VDI / ASR / FEM) und dem Projekt-Normenkorpus - diese Werte sind KEINE Zertifizierung und nicht rechtsverbindlich. Zahlen hinter Bezahlschranken stammen nur aus offiziellen Kurzfassungen oder serioesen Sekundaerquellen und sind vom Nutzer am gekauften Volltext zu pruefen. Jeder geaenderte Wert liegt in Ihrer Verantwortung; ein bestandener Check bedeutet nie, dass eine Anordnung konform ist.",
  };

  // Standard per-entry note.
  const NOTE_INFORMED =
    "Informed by the cited standard - NOT a certification; edits are the user's responsibility to justify.";
  // Note for values whose exact figure lives behind a paywalled clause.
  const NOTE_PAYWALL =
    "The exact clause value is behind the paid standard text (see corpus); this is a public/secondary figure - verify against the full text. Edits are the user's responsibility.";

  const CATEGORIES = [
    { key: "compliance", label: "Compliance thresholds",
      desc: "Guidance values the Compliance Check reasons over (ASR A1.8 / ASR A2.3 / DIN 15185)." },
    { key: "advisor", label: "Advisor thresholds",
      desc: "Heuristic trigger points the offline Advisor uses to raise suggestions." },
    { key: "generator", label: "Generator profile params",
      desc: "Per-plant-profile working-aisle the AI Environment Generator builds to." },
    { key: "rack", label: "Rack-type parameters",
      desc: "Per storage-system capacity/height assumptions (order-of-magnitude teaching values)." },
  ];

  // ------------------------------------------------------------------
  // SEED entries - the ONE source of truth. Numeric defaults are pulled
  // from domain.js (or a documented literal) so a seed can never drift
  // from the constant the code used before this KB existed.
  // ------------------------------------------------------------------
  const C = D.COMPLIANCE || {};
  const A = D.AISLE || {};
  const seeds = [];
  function seed(e) { seeds.push(e); }

  /* ---- compliance thresholds ---- */
  seed({
    id: "compliance.aisle.min", category: "compliance",
    label: "Min working-aisle width (default truck class)",
    value: num(A.defaultMinMetres, 2.9), unit: "m",
    source: "DIN 15185-1/-2 (warehouse systems with narrow-aisle trucks). Corpus 2.1: standard-aisle safety clearance ~500 mm/side [PS]. Reach-truck default.",
    note: NOTE_PAYWALL, editable: true, kind: "number", min: 0.5, max: 12,
  });
  seed({
    id: "compliance.aisle.warnMargin", category: "compliance",
    label: "Aisle-width WARN margin (meets value but tight)",
    value: 0.25, unit: "m",
    source: "WarehouseTwin derivation (compliance.js): clearance band above the truck-class minimum below which an aisle warns rather than passes.",
    note: NOTE_INFORMED, editable: true, kind: "number", min: 0, max: 5,
  });
  seed({
    id: "compliance.trafficRoute.min", category: "compliance",
    label: "Min main traffic-route clearance in front of a dock",
    value: num(C.mainRouteMinMetres, 2.5), unit: "m",
    source: "ASR A1.8 (Verkehrswege / traffic routes), BAuA. Corpus 2.3: vehicle-route width = vehicle/load width + safety margin each side. Assumed 1.5 m envelope + 2x0.5 m = 2.5 m.",
    note: NOTE_PAYWALL, editable: true, kind: "number", min: 0.5, max: 12,
  });
  seed({
    id: "compliance.escapeRoute.width", category: "compliance",
    label: "Min clear escape-route width",
    value: num(C.escapeWidthMinMetres, 1.2), unit: "m",
    source: "ASR A2.3 (Fluchtwege / escape routes), BAuA. Corpus 2.3: clear width for up to ~200 persons = 1.20 m [exact width-per-occupancy table is PW].",
    note: NOTE_PAYWALL, editable: true, kind: "number", min: 0.5, max: 6,
  });
  seed({
    id: "compliance.escapeRoute.travel", category: "compliance",
    label: "Max travel distance to an exit",
    value: num(C.escapeMaxTravelMetres, 35), unit: "m",
    source: "ASR A2.3, BAuA. Corpus 2.3: max escape-route length commonly cited ~35 m [PS] - verify the exact figure against the full text.",
    note: NOTE_PAYWALL, editable: true, kind: "number", min: 5, max: 200,
  });

  /* ---- advisor thresholds ---- */
  seed({
    id: "advisor.fill.highPct", category: "advisor",
    label: "Storage fill: 'almost full' warning at/above",
    value: 95, unit: "%",
    source: "Warehouse operations best-practice (corpus 4 utilization KPIs): high occupancy causes congestion / honeycombing; a common working target is ~85%.",
    note: NOTE_INFORMED, editable: true, kind: "number", min: 1, max: 100,
  });
  seed({
    id: "advisor.fill.lowPct", category: "advisor",
    label: "Storage fill: 'under-used' warning below",
    value: 40, unit: "%",
    source: "Warehouse operations best-practice (corpus 4 utilization KPIs): well below target occupancy means paid-for capacity sitting idle.",
    note: NOTE_INFORMED, editable: true, kind: "number", min: 1, max: 100,
  });
  seed({
    id: "advisor.lifoShareWarn", category: "advisor",
    label: "LIFO-position share that triggers a FIFO-rotation caution",
    value: 0.35, unit: "fraction",
    source: "Racking-type taxonomy (corpus 2.1): LIFO lanes (drive-in / push-back / block-stack) cannot guarantee FIFO; a material share warrants a rotation caution.",
    note: NOTE_INFORMED, editable: true, kind: "number", min: 0, max: 1,
  });
  seed({
    id: "advisor.smallPartsSkuThreshold", category: "advisor",
    label: "SKU count above which carton-flow pick faces are advised",
    value: 120, unit: "SKUs",
    source: "Order-picking practice (corpus 2.4, VDI 3590): high SKU counts of small parts pick fastest from carton-flow lanes.",
    note: NOTE_INFORMED, editable: true, kind: "number", min: 1, max: 100000,
  });
  seed({
    id: "advisor.optTravelDeltaPct", category: "advisor",
    label: "Min pick-travel saving to suggest relocating storage",
    value: 2, unit: "%",
    source: "WarehouseTwin heuristic (advisor.js): only surface a golden-zone move when the deterministic optimizer measures at least this saving.",
    note: NOTE_INFORMED, editable: true, kind: "number", min: 0, max: 100,
  });

  /* ---- generator profile working-aisle (mirrors generate.js PROFILES) ---- */
  const GEN_AISLE_SOURCE =
    "Plant-profile working aisle (informed by DIN 15185 truck classes: VNA ~1.8 m, reach ~2.9-3.0 m, counterbalance ~3.8 m). Synthetic best-practice teaching value.";
  seed({ id: "generator.ecommerce-fulfilment.minAisle", category: "generator",
    label: "E-commerce fulfilment centre - min working aisle", value: 2.9, unit: "m",
    source: GEN_AISLE_SOURCE, note: NOTE_INFORMED, editable: true, kind: "number", min: 0.5, max: 12 });
  seed({ id: "generator.spare-parts-distribution.minAisle", category: "generator",
    label: "Spare-parts distribution centre - min working aisle", value: 1.8, unit: "m",
    source: GEN_AISLE_SOURCE, note: NOTE_INFORMED, editable: true, kind: "number", min: 0.5, max: 12 });
  seed({ id: "generator.automotive-supply.minAisle", category: "generator",
    label: "Automotive supply / JIT centre - min working aisle", value: 3.0, unit: "m",
    source: GEN_AISLE_SOURCE, note: NOTE_INFORMED, editable: true, kind: "number", min: 0.5, max: 12 });
  seed({ id: "generator.cold-chain.minAisle", category: "generator",
    label: "Cold-chain / temperature-controlled DC - min working aisle", value: 1.8, unit: "m",
    source: GEN_AISLE_SOURCE, note: NOTE_INFORMED, editable: true, kind: "number", min: 0.5, max: 12 });

  /* ---- rack-type parameters (density + assumed height), seeded from the
   * domain ELEMENTS so they mirror the model exactly. density is actively
   * read by domain.elementCapacity(); heightM is recorded design metadata
   * (the 2.5D / IFC export default) that travels with your KB. ---- */
  const RACK_DENSITY_SOURCE =
    "domain.js teaching value, informed by the racking-type taxonomy (corpus 2.1): pallet positions per m2 of footprint. Order-of-magnitude, NOT a vendor spec.";
  const RACK_HEIGHT_SOURCE =
    "domain.js assumed overall height (2.5D / IFC export default), in line with each system's levels. Illustrative, NOT measured, NOT a vendor spec.";
  const ELS = D.ELEMENTS || {};
  const storageTypes = Object.keys(ELS).filter((t) => (ELS[t] || {}).category === "storage");
  for (const t of storageTypes) {
    const def = ELS[t];
    if (typeof def.density === "number") {
      seed({
        id: "rack." + t + ".density", category: "rack",
        label: def.label + " - pallet density", value: def.density, unit: "pos/m2",
        source: RACK_DENSITY_SOURCE, note: NOTE_INFORMED, editable: true, kind: "number", min: 0.01, max: 50,
      });
    }
    if (typeof def.heightM === "number") {
      seed({
        id: "rack." + t + ".heightM", category: "rack",
        label: def.label + " - assumed height", value: def.heightM, unit: "m",
        source: RACK_HEIGHT_SOURCE, note: NOTE_INFORMED, editable: true, kind: "number", min: 0.1, max: 60,
      });
    }
  }

  // ------------------------------------------------------------------
  // Build the store. `defaults` is a frozen id -> default-value map;
  // `store` is the live, editable id -> entry map. Custom (user) rules
  // are tracked in insertion order so export is stable + round-trips.
  // ------------------------------------------------------------------
  const seedOrder = seeds.map((e) => e.id);
  const seedIndex = {};
  seeds.forEach((e, i) => (seedIndex[e.id] = i));
  const defaults = {};
  const store = {};
  const customOrder = [];
  for (const e of seeds) {
    defaults[e.id] = e.value;
    store[e.id] = cloneEntry(e);
  }
  Object.freeze(defaults);

  // ------------------------------------------------------------------
  // Small helpers.
  // ------------------------------------------------------------------
  function num(v, dflt) { return typeof v === "number" && isFinite(v) ? v : dflt; }
  function cloneEntry(e) {
    return {
      id: e.id, category: e.category, label: e.label, value: e.value, unit: e.unit,
      source: e.source, note: e.note, editable: e.editable !== false,
      kind: e.kind || "number",
      min: typeof e.min === "number" ? e.min : undefined,
      max: typeof e.max === "number" ? e.max : undefined,
    };
  }
  function isSeed(id) { return Object.prototype.hasOwnProperty.call(seedIndex, id); }

  // ------------------------------------------------------------------
  // validate(id, raw) -> { ok, value?, error? }. Numeric entries reject
  // non-numeric and out-of-range (negative unless the entry allows it);
  // text rules accept any non-empty string.
  // ------------------------------------------------------------------
  function validate(id, raw) {
    const e = store[id];
    if (!e) return { ok: false, error: "unknown entry: " + id };
    if (e.editable === false) return { ok: false, error: "entry is read-only: " + id };
    if (e.kind === "text") {
      const s = raw == null ? "" : String(raw);
      if (!s.trim()) return { ok: false, error: "value must not be empty" };
      return { ok: true, value: s };
    }
    // numeric
    if (raw === "" || raw === null || raw === undefined || (typeof raw === "boolean")) {
      return { ok: false, error: "value must be a number" };
    }
    const v = typeof raw === "number" ? raw : Number(String(raw).trim());
    if (!isFinite(v)) return { ok: false, error: "value must be a number" };
    const lo = typeof e.min === "number" ? e.min : 0;
    if (v < lo) return { ok: false, error: "value must be >= " + lo };
    if (typeof e.max === "number" && v > e.max) return { ok: false, error: "value must be <= " + e.max };
    return { ok: true, value: v };
  }

  // ------------------------------------------------------------------
  // Public API.
  // ------------------------------------------------------------------
  function get(id) {
    const e = store[id];
    return e ? e.value : undefined;
  }
  function entry(id) {
    const e = store[id];
    return e ? cloneEntry(e) : null;
  }
  function set(id, value) {
    const r = validate(id, value);
    if (!r.ok) return false;
    store[id].value = r.value;
    persist();
    return true;
  }
  // addRule(entry) - add a user-defined fact/rule. Returns the stored id
  // (auto-namespaced under "custom." when the caller gives no id) or null.
  function addRule(input) {
    if (!input || typeof input !== "object") return null;
    let id = input.id ? String(input.id) : "custom." + slug(input.label || "rule") + "." + (customOrder.length + 1);
    // Never let a rule silently overwrite a seed entry.
    if (isSeed(id)) return null;
    if (store[id]) {
      // de-dupe id
      let n = 2;
      while (store[id + "-" + n]) n++;
      id = id + "-" + n;
    }
    const kind = input.kind === "text" ? "text" : "number";
    let value = input.value;
    if (kind === "number") {
      value = Number(value);
      if (!isFinite(value)) return null;
    } else {
      value = value == null ? "" : String(value);
      if (!value.trim()) return null;
    }
    const e = cloneEntry({
      id: id,
      category: input.category && catExists(input.category) ? input.category : "custom",
      label: input.label ? String(input.label) : id,
      value: value, unit: input.unit ? String(input.unit) : "",
      source: input.source ? String(input.source) : "User-defined rule (added in-app).",
      note: input.note ? String(input.note) : "User-defined - the user's own responsibility to justify. NOT a certification.",
      editable: true, kind: kind,
      min: typeof input.min === "number" ? input.min : (kind === "number" ? 0 : undefined),
      max: typeof input.max === "number" ? input.max : undefined,
    });
    store[id] = e;
    customOrder.push(id);
    persist();
    return id;
  }
  function catExists(key) { return CATEGORIES.some((c) => c.key === key) || key === "custom"; }
  function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || "rule";
  }

  // reset(id?) - restore one entry (or, with no id, the whole KB) to its
  // seeded default. Custom rules are removed on a full reset.
  function reset(id) {
    if (id == null) {
      for (const sid of seedOrder) store[sid] = cloneEntry(seeds[seedIndex[sid]]);
      for (const cid of customOrder.splice(0)) delete store[cid];
      persist();
      return true;
    }
    if (isSeed(id)) { store[id] = cloneEntry(seeds[seedIndex[id]]); persist(); return true; }
    // resetting a custom rule removes it
    const ci = customOrder.indexOf(id);
    if (ci !== -1) { customOrder.splice(ci, 1); delete store[id]; persist(); return true; }
    return false;
  }

  // list(category?) - the entries for the panel, in a stable order
  // (seeds in seed order, then custom rules in insertion order).
  function list(category) {
    const ids = seedOrder.concat(customOrder);
    const out = [];
    for (const id of ids) {
      const e = store[id];
      if (!e) continue;
      if (category && e.category !== category) continue;
      out.push(cloneEntry(e));
    }
    return out;
  }

  // exportJson() / importJson() - round-trip the whole KB so the user can
  // save / share / version it. Deterministic: no timestamps, stable order.
  function exportJson() {
    return JSON.stringify({ version: KB_VERSION, entries: list() }, null, 2);
  }
  function importJson(str) {
    let data;
    try { data = typeof str === "string" ? JSON.parse(str) : str; }
    catch (err) { return { ok: false, error: "not valid JSON: " + err.message, applied: 0, added: 0 }; }
    if (!data || !Array.isArray(data.entries)) {
      return { ok: false, error: "missing an 'entries' array", applied: 0, added: 0 };
    }
    reset(); // back to seed defaults, drop existing custom rules
    let applied = 0, added = 0;
    const errors = [];
    for (const e of data.entries) {
      if (!e || typeof e.id !== "string") { errors.push("skipped an entry with no id"); continue; }
      if (isSeed(e.id)) {
        if (set(e.id, e.value)) applied++;
        else errors.push("rejected value for " + e.id);
      } else {
        const id = addRule(e);
        if (id) added++;
        else errors.push("could not add rule " + e.id);
      }
    }
    return { ok: errors.length === 0, applied: applied, added: added, errors: errors };
  }

  // ------------------------------------------------------------------
  // Optional persistence (guarded). In Node harnesses window.localStorage
  // is absent, so the KB is purely in-memory there. In the browser, user
  // edits survive a reload. Never throws.
  // ------------------------------------------------------------------
  function persist() {
    try {
      const ls = window.localStorage;
      if (!ls) return;
      // Only persist a DELTA from defaults (edited seeds + custom rules).
      const changed = list().filter((e) => !isSeed(e.id) || e.value !== defaults[e.id]);
      if (!changed.length) { ls.removeItem(STORAGE_KEY); return; }
      ls.setItem(STORAGE_KEY, JSON.stringify({ version: KB_VERSION, entries: changed }));
    } catch (_) { /* storage unavailable / full - stay in-memory */ }
  }
  function loadPersisted() {
    try {
      const ls = window.localStorage;
      if (!ls) return;
      const raw = ls.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.entries)) return;
      for (const e of data.entries) {
        if (!e || typeof e.id !== "string") continue;
        if (isSeed(e.id)) set(e.id, e.value);
        else addRule(e);
      }
    } catch (_) { /* ignore corrupt persisted state */ }
  }

  const meta = {
    version: KB_VERSION,
    honesty: HONESTY,
    categories: CATEGORIES.map((c) => ({ key: c.key, label: c.label, desc: c.desc })),
    seededCount: seeds.length,
    // convenience for a panel banner
    disclaimer: HONESTY.en,
  };

  WT.kb = {
    defaults: defaults,
    meta: meta,
    get: get,
    entry: entry,
    set: set,
    validate: validate,
    addRule: addRule,
    reset: reset,
    list: list,
    exportJson: exportJson,
    importJson: importJson,
    categories: meta.categories,
    // internal helpers exposed for the panel/tests
    isSeed: isSeed,
  };

  // Restore any persisted user edits (browser only; no-op in Node).
  loadPersisted();
})();
