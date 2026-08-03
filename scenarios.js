/* =====================================================================
 * Logistics Flow Studio - WarehouseTwin
 * scenarios.js - Save / load NAMED scenarios: the pure, guarded store
 *                behind the "My scenarios" control.
 * ---------------------------------------------------------------------
 * v1.1 usability. This module lets the user save the plants THEY build
 * (the current serialize() layout + configuration, and OPTIONALLY the
 * imported SKU/order data bundle riding along in the snapshot) under a
 * NAME, then reload / rename / delete them and export / import a backup
 * bundle. It is deliberately a small store, not a new app layer.
 *
 * It is DATA-ONLY and DOM-free: app.js builds the snapshot from the SAME
 * serialize() the JSON export and share link use, hands it to save(), and
 * loads it back through the SAME deserialize() loader as JSON import - so
 * a saved scenario travels through the identical, already-tested path.
 *
 * ON-DEVICE ONLY. Saved scenarios live in this browser's localStorage
 * (key `wt.scenarios.v1`). Nothing is uploaded - the app makes zero
 * network requests. These are the USER'S OWN saved work, distinct from
 * the read-only synthetic example scenarios in examples.js.
 *
 * localStorage is GUARDED: in Node (no localStorage) or a locked-down
 * browser (private mode can throw) every store call is a safe no-op -
 * the default store reads as EMPTY - so first use is unchanged and the
 * harness exercises the logic headlessly against an in-memory store.
 *
 * DETERMINISTIC: the stored body and every exported bundle are serialized
 * with sorted object keys, so identical inputs produce byte-identical
 * output and importBundle(exportBundle(x)) round-trips exactly. Names are
 * unique BY SLUG: saving under a name that matches an existing scenario
 * (case/space-insensitive) UPDATES that scenario in place.
 *
 * WT.scenarios = {
 *   KEY, slug, create, lsStore, memStore,      // building blocks + guard
 *   save, load, list, has, rename, remove, clear, exportBundle, importBundle
 * }                                             // bound to the default store
 *
 * Classic script attaching to the global `WT` namespace so it works from
 * file:// too. No dependencies at module-load time.
 * ===================================================================== */
(function () {
  "use strict";
  var WT = (window.WT = window.WT || {});

  var KEY = "wt.scenarios.v1";
  var BUNDLE_KIND = "warehousetwin-scenarios";
  var BUNDLE_VERSION = "wt-scenarios-1";

  // A stable, DOM-independent key from a scenario's display name. Lowercased,
  // non-alphanumerics collapsed to hyphens, trimmed. Deterministic - the same
  // name always yields the same key, which is how uniqueness is enforced
  // (two names that slug the same refer to the same saved scenario).
  function slug(name) {
    var s = String(name == null ? "" : name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    return s || "scenario";
  }

  // Guarded access to the real localStorage. Any failure (absent in Node,
  // throwing in private mode) yields null -> the caller no-ops.
  function safeLocalStorage() {
    try {
      var ls = typeof window !== "undefined" && window && window.localStorage
        ? window.localStorage
        : typeof localStorage !== "undefined"
        ? localStorage
        : null;
      return ls || null;
    } catch (e) {
      return null;
    }
  }

  // Deep clone of JSON-serializable data (snapshots are plain JSON).
  function clone(x) {
    if (x == null) return x;
    return JSON.parse(JSON.stringify(x));
  }

  // Canonicalize for DETERMINISTIC serialization: object keys sorted
  // (recursively); arrays keep their order. The parsed value is unchanged,
  // only the byte layout is stabilized.
  function sortValue(v) {
    if (Array.isArray(v)) {
      var arr = [];
      for (var i = 0; i < v.length; i++) arr.push(sortValue(v[i]));
      return arr;
    }
    if (v && typeof v === "object") {
      var out = {};
      var keys = Object.keys(v).sort();
      for (var k = 0; k < keys.length; k++) out[keys[k]] = sortValue(v[keys[k]]);
      return out;
    }
    return v;
  }
  function stableStringify(value) {
    return JSON.stringify(sortValue(value));
  }

  // A stored/imported entry is valid only if it carries a non-empty name
  // and an object snapshot (the layout body). Anything else is ignored.
  function isValidEntry(s) {
    return !!(
      s &&
      typeof s === "object" &&
      typeof s.name === "string" &&
      s.name.trim() !== "" &&
      s.snapshot &&
      typeof s.snapshot === "object" &&
      !Array.isArray(s.snapshot)
    );
  }

  // Normalize an arbitrary entry to the internal shape. The slug is ALWAYS
  // recomputed from the name (never trusted from the input) and the snapshot
  // is deep-cloned so callers cannot alias into the store.
  function normalizeEntry(s) {
    return {
      name: String(s.name).trim(),
      slug: slug(s.name),
      savedAt: String(s.savedAt != null ? s.savedAt : ""),
      snapshot: clone(s.snapshot),
    };
  }

  // A raw-string store backed by real localStorage. read() -> null and
  // write() -> false when storage is unavailable, so the default is empty.
  function lsStore(key) {
    key = key || KEY;
    return {
      read: function () {
        var ls = safeLocalStorage();
        if (!ls) return null;
        try {
          return ls.getItem(key);
        } catch (e) {
          return null;
        }
      },
      write: function (str) {
        var ls = safeLocalStorage();
        if (!ls) return false;
        try {
          ls.setItem(key, str);
          return true;
        } catch (e) {
          return false;
        }
      },
    };
  }

  // An in-memory raw-string store: used by the harness and as the session
  // fallback when localStorage is absent.
  function memStore(initialStr) {
    var data = typeof initialStr === "string" ? initialStr : null;
    return {
      read: function () {
        return data;
      },
      write: function (str) {
        data = str;
        return true;
      },
    };
  }

  // The scenario store, bound to a raw-string store (real LS by default).
  function create(opts) {
    opts = opts || {};
    var storeKey = opts.key || KEY;
    var store = opts.store || lsStore(storeKey);

    // Parse the persisted body into a clean { scenarios: [entry...] }. Any
    // corruption (absent, non-JSON, wrong shape) degrades to empty rather
    // than throwing, so a bad write can never brick the control.
    function readAll() {
      var raw = store.read();
      if (!raw) return { version: BUNDLE_VERSION, scenarios: [] };
      var obj;
      try {
        obj = JSON.parse(raw);
      } catch (e) {
        return { version: BUNDLE_VERSION, scenarios: [] };
      }
      if (!obj || !Array.isArray(obj.scenarios)) return { version: BUNDLE_VERSION, scenarios: [] };
      var out = [];
      for (var i = 0; i < obj.scenarios.length; i++) {
        if (isValidEntry(obj.scenarios[i])) out.push(normalizeEntry(obj.scenarios[i]));
      }
      return { version: BUNDLE_VERSION, scenarios: out };
    }

    // Persist, always in a canonical slug order + sorted keys, so the bytes
    // are deterministic and a round-trip is stable.
    function writeAll(body) {
      var entries = body.scenarios.slice().sort(bySlug);
      return store.write(stableStringify({ version: BUNDLE_VERSION, scenarios: entries }));
    }

    function bySlug(a, b) {
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    }

    function find(entries, sl) {
      for (var i = 0; i < entries.length; i++) if (entries[i].slug === sl) return i;
      return -1;
    }

    // A compact, honest summary for the list UI. Reads the layout whether it
    // is the snapshot itself or nested under snapshot.layout, so both shapes
    // summarize correctly.
    function summarize(snapshot) {
      var lay = snapshot && snapshot.layout && typeof snapshot.layout === "object" ? snapshot.layout : snapshot;
      var elements = lay && Array.isArray(lay.elements) ? lay.elements.length : 0;
      var gw = lay && isFinite(lay.gridW) ? Math.round(lay.gridW) : null;
      var gh = lay && isFinite(lay.gridH) ? Math.round(lay.gridH) : null;
      var hasData = !!(
        snapshot &&
        snapshot.wmsBundle &&
        Array.isArray(snapshot.wmsBundle.skuMaster) &&
        snapshot.wmsBundle.skuMaster.length
      );
      return {
        elements: elements,
        gridW: gw,
        gridH: gh,
        floor: gw != null && gh != null ? gw + "x" + gh : "",
        hasData: hasData,
      };
    }

    // save(name, snapshot, { savedAt }) -> { name, slug, savedAt, summary }.
    // Saving under an EXISTING name (same slug) UPDATES that scenario. The
    // savedAt is passed IN (kept out of the deterministic body); it falls
    // back to the snapshot's own savedAt, then to "".
    function save(name, snapshot, saveOpts) {
      if (typeof name !== "string" || !name.trim()) throw new Error("Scenario name is required.");
      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
        throw new Error("Scenario snapshot must be an object.");
      }
      saveOpts = saveOpts || {};
      var savedAt = saveOpts.savedAt != null
        ? String(saveOpts.savedAt)
        : snapshot.savedAt != null
        ? String(snapshot.savedAt)
        : "";
      var entry = { name: name.trim(), slug: slug(name), savedAt: savedAt, snapshot: clone(snapshot) };
      var body = readAll();
      var idx = find(body.scenarios, entry.slug);
      if (idx === -1) body.scenarios.push(entry);
      else body.scenarios[idx] = entry;
      writeAll(body);
      return { name: entry.name, slug: entry.slug, savedAt: entry.savedAt, summary: summarize(entry.snapshot) };
    }

    // list() -> [{ name, slug, savedAt, summary }], most-recent-first with a
    // slug tie-break (deterministic given the stored data).
    function list() {
      var body = readAll();
      return body.scenarios
        .map(function (s) {
          return { name: s.name, slug: s.slug, savedAt: s.savedAt, summary: summarize(s.snapshot) };
        })
        .sort(function (a, b) {
          if (a.savedAt > b.savedAt) return -1;
          if (a.savedAt < b.savedAt) return 1;
          return bySlug(a, b);
        });
    }

    function has(name) {
      return find(readAll().scenarios, slug(name)) !== -1;
    }

    // load(name) -> the stored snapshot (deep clone) or null. The returned
    // object is exactly what was saved, so deserialize() reconstructs the
    // same serialize() layout.
    function load(name) {
      var body = readAll();
      var idx = find(body.scenarios, slug(name));
      return idx === -1 ? null : clone(body.scenarios[idx].snapshot);
    }

    // rename(old, new) -> true / false (not found). Throws if the new name
    // would collide with a DIFFERENT saved scenario.
    function rename(oldName, newName) {
      if (typeof newName !== "string" || !newName.trim()) throw new Error("New name is required.");
      var body = readAll();
      var oldSlug = slug(oldName);
      var newSlug = slug(newName);
      var idx = find(body.scenarios, oldSlug);
      if (idx === -1) return false;
      var collide = find(body.scenarios, newSlug);
      if (collide !== -1 && collide !== idx) {
        throw new Error('A scenario named "' + newName.trim() + '" already exists.');
      }
      body.scenarios[idx].name = newName.trim();
      body.scenarios[idx].slug = newSlug;
      writeAll(body);
      return true;
    }

    function remove(name) {
      var body = readAll();
      var idx = find(body.scenarios, slug(name));
      if (idx === -1) return false;
      body.scenarios.splice(idx, 1);
      writeAll(body);
      return true;
    }

    function clear() {
      writeAll({ version: BUNDLE_VERSION, scenarios: [] });
    }

    // exportBundle(name?, { exportedAt }) -> a deterministic JSON STRING for
    // backup / sharing. With a name, just that scenario; otherwise all. The
    // exportedAt is metadata only (defaults to "" so the bytes are stable).
    function exportBundle(name, exportOpts) {
      exportOpts = exportOpts || {};
      var body = readAll();
      var picked = body.scenarios;
      if (typeof name === "string" && name.trim()) {
        var idx = find(body.scenarios, slug(name));
        picked = idx === -1 ? [] : [body.scenarios[idx]];
      }
      var entries = picked.slice().sort(bySlug).map(function (s) {
        return { name: s.name, slug: s.slug, savedAt: s.savedAt, snapshot: s.snapshot };
      });
      return stableStringify({
        kind: BUNDLE_KIND,
        version: BUNDLE_VERSION,
        exportedAt: exportOpts.exportedAt != null ? String(exportOpts.exportedAt) : "",
        scenarios: entries,
      });
    }

    // importBundle(json) -> { ok, imported, skipped, names } | { ok:false, error }.
    // Tolerant + validated: accepts a JSON string or object, MERGES valid
    // scenarios (replacing same-slug ones), skips invalid entries, and
    // REJECTS a malformed payload (not JSON / not a bundle) WITHOUT touching
    // the store.
    function importBundle(json) {
      var obj = json;
      if (typeof json === "string") {
        try {
          obj = JSON.parse(json);
        } catch (e) {
          return { ok: false, imported: 0, skipped: 0, error: "not valid JSON" };
        }
      }
      if (!obj || typeof obj !== "object" || !Array.isArray(obj.scenarios)) {
        return { ok: false, imported: 0, skipped: 0, error: "not a scenarios bundle" };
      }
      var body = readAll();
      var imported = 0;
      var skipped = 0;
      var names = [];
      for (var i = 0; i < obj.scenarios.length; i++) {
        var s = obj.scenarios[i];
        if (!isValidEntry(s)) {
          skipped++;
          continue;
        }
        var entry = normalizeEntry(s);
        var idx = find(body.scenarios, entry.slug);
        if (idx === -1) body.scenarios.push(entry);
        else body.scenarios[idx] = entry;
        imported++;
        names.push(entry.name);
      }
      writeAll(body);
      return { ok: true, imported: imported, skipped: skipped, names: names };
    }

    return {
      KEY: storeKey,
      store: store,
      slug: slug,
      summarize: summarize,
      save: save,
      load: load,
      list: list,
      has: has,
      rename: rename,
      remove: remove,
      clear: clear,
      exportBundle: exportBundle,
      importBundle: importBundle,
    };
  }

  // The default store, bound to the guarded real localStorage. In Node the
  // guard makes every read empty, so the default surface is inert (the
  // harness drives its own in-memory stores via create()).
  var def = create();

  WT.scenarios = {
    KEY: KEY,
    slug: slug,
    create: create,
    lsStore: lsStore,
    memStore: memStore,
    save: function (name, snapshot, saveOpts) {
      return def.save(name, snapshot, saveOpts);
    },
    load: function (name) {
      return def.load(name);
    },
    list: function () {
      return def.list();
    },
    has: function (name) {
      return def.has(name);
    },
    rename: function (oldName, newName) {
      return def.rename(oldName, newName);
    },
    remove: function (name) {
      return def.remove(name);
    },
    clear: function () {
      return def.clear();
    },
    exportBundle: function (name, exportOpts) {
      return def.exportBundle(name, exportOpts);
    },
    importBundle: function (json) {
      return def.importBundle(json);
    },
  };
})();
