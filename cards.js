/* =====================================================================
 * Logistics Flow Studio - WarehouseTwin
 * cards.js - collapsible side-panel cards: the tiny PURE collapse-state
 *            helper behind the UI affordance.
 * ---------------------------------------------------------------------
 * v1.0 consolidation (usability). This module is a PURE, DOM-free store
 * for "which side-panel cards are collapsed". app.js wires the DOM to it
 * (a click on a card header toggles that card); the state persists in
 * localStorage so a collapse survives a reload.
 *
 * DEFAULT = EVERY CARD EXPANDED. The collapsed-set starts EMPTY and only
 * ever gains an id when the user acts, so first load looks and behaves
 * EXACTLY as before this feature existed. Nothing ships collapsed.
 *
 * localStorage is GUARDED: in Node (no localStorage) or a locked-down
 * browser (private mode can throw on access) every store call is a safe
 * no-op - read() -> {}, write() -> false - so the default stays
 * all-expanded and the harness can exercise the logic headlessly.
 *
 * WT.cards = { LS_KEY, slug, create, lsStore, memStore }
 *   slug(text)      pure, deterministic key from a card's title text.
 *   lsStore(key)    guarded localStorage-backed { read, write } store.
 *   memStore(init)  in-memory { read, write } store (tests + LS-absent
 *                   session fallback).
 *   create(opts)    a collapse-set bound to a store, exposing
 *                   { isCollapsed, collapsedIds, set, toggle, clear }.
 *
 * Classic script attaching to the global `WT` namespace so it works from
 * file:// too. No dependencies at module-load time.
 * ===================================================================== */
(function () {
  "use strict";
  var WT = (window.WT = window.WT || {});

  var LS_KEY = "wt.cards.collapsed.v1";

  // A stable, DOM-independent key from a card's visible title. Lowercased,
  // non-alphanumerics collapsed to hyphens, trimmed. Deterministic - the
  // same title always yields the same key (so a persisted collapse maps
  // back to the same card across reloads).
  function slug(text) {
    var s = String(text == null ? "" : text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    return s || "card";
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

  // Normalise an arbitrary object to a plain { id: true } collapsed-set.
  function onlyTrue(obj) {
    var out = {};
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      Object.keys(obj).forEach(function (k) {
        if (obj[k] === true) out[k] = true;
      });
    }
    return out;
  }

  // A localStorage-backed store. read() -> {} and write() -> false when
  // storage is unavailable, so the default is always all-expanded.
  function lsStore(key) {
    key = key || LS_KEY;
    return {
      read: function () {
        var ls = safeLocalStorage();
        if (!ls) return {};
        try {
          var raw = ls.getItem(key);
          if (!raw) return {};
          return onlyTrue(JSON.parse(raw));
        } catch (e) {
          return {};
        }
      },
      write: function (obj) {
        var ls = safeLocalStorage();
        if (!ls) return false;
        try {
          ls.setItem(key, JSON.stringify(onlyTrue(obj)));
          return true;
        } catch (e) {
          return false;
        }
      },
    };
  }

  // An in-memory store: used by the harness and as the session fallback
  // when localStorage is absent (so toggles still work for the session,
  // they just do not persist across a reload).
  function memStore(initial) {
    var data = onlyTrue(initial);
    return {
      read: function () {
        return onlyTrue(data);
      },
      write: function (obj) {
        data = onlyTrue(obj);
        return true;
      },
    };
  }

  // The collapse-set. Backed by a store (real LS by default). The initial
  // state is whatever the store holds - EMPTY on a fresh install, so every
  // card is expanded until the user collapses one.
  function create(opts) {
    opts = opts || {};
    var store = opts.store || lsStore(opts.key || LS_KEY);
    var state = onlyTrue(store.read());

    function isCollapsed(id) {
      return state[String(id)] === true;
    }
    function collapsedIds() {
      return Object.keys(state)
        .filter(function (k) {
          return state[k] === true;
        })
        .sort();
    }
    function set(id, collapsed) {
      id = String(id);
      if (collapsed) state[id] = true;
      else delete state[id];
      store.write(state);
      return isCollapsed(id);
    }
    function toggle(id) {
      return set(id, !isCollapsed(id));
    }
    function clear() {
      state = {};
      store.write(state);
    }

    return {
      isCollapsed: isCollapsed,
      collapsedIds: collapsedIds,
      set: set,
      toggle: toggle,
      clear: clear,
      store: store,
    };
  }

  WT.cards = {
    LS_KEY: LS_KEY,
    slug: slug,
    create: create,
    lsStore: lsStore,
    memStore: memStore,
  };
})();
