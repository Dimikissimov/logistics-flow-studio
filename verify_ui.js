/* =====================================================================
 * verify_ui.js - Collapsible side-panel cards verification (v1.0).
 *
 * Runs the REAL cards.js module (WT.cards) in Node under the same window
 * shim the other harnesses use and asserts the PURE collapse-state helper
 * behind the UI affordance - so the usability feature is proven headlessly
 * even though the DOM wiring itself is not:
 *
 *   1.  API surface: WT.cards exposes slug, create, lsStore, memStore, LS_KEY.
 *   2.  slug() is pure + deterministic: same title -> same key across calls,
 *       lowercased/hyphenated, never empty.
 *   3.  DEFAULT = ALL EXPANDED: a fresh collapse-set has an empty collapsed
 *       list and isCollapsed(anything) is false (nothing ships collapsed).
 *   4.  toggle() flips a card collapsed then expanded again and returns the
 *       new state.
 *   5.  set(id, true/false) collapses / expands explicitly and updates the
 *       collapsed list.
 *   6.  PERSIST: a toggle written through a store is seen by a NEW collapse-
 *       set reading the SAME store (a collapse survives a "reload").
 *   7.  clear() expands everything again.
 *   8.  localStorage GUARD: lsStore() in Node (no localStorage) is a safe
 *       no-op - read() -> {}, write() -> false - and a store-less create()
 *       still toggles in memory without throwing (default stays expanded).
 *   9.  Store isolation: only `true` values persist; garbage is ignored, so
 *       the collapsed-set can never be corrupted into a "collapsed" default.
 *
 * Plus light INTEGRATION guards on the shipped source (default-expanded
 * guarantee + generic wiring), since the DOM affordance is added at runtime
 * by app.js and is not itself headless-testable:
 *
 *  10.  index.html loads cards.js before app.js, and ships NO card with the
 *       `card--collapsed` class (static HTML = every card expanded).
 *  11.  sw.js precaches ./cards.js (offline shell complete).
 *  12.  app.js wires the cards GENERICALLY (WT.cards + a section.card query),
 *       not hand-wired per card.
 *
 * Everything is deterministic (no wall-clock, no Math.random). Usage:
 *   node verify_ui.js
 * ASCII-only output. Exit 0 = all checks pass.
 * ===================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");

global.window = global; // cards.js attaches itself to window.WT
// eslint-disable-next-line no-eval
(0, eval)(fs.readFileSync(path.join(__dirname, "cards.js"), "utf8"));
const WT = global.WT;
const C = WT.cards;

let failures = 0;
let checks = 0;
function check(name, ok, detail) {
  checks++;
  console.log((ok ? "[PASS] " : "[FAIL] ") + name + (detail ? " - " + detail : ""));
  if (!ok) failures++;
}

console.log("Collapsible side-panel cards verification (deterministic)");
console.log("");

// ---- 1. API surface -------------------------------------------------
check(
  "API surface: WT.cards exposes slug/create/lsStore/memStore/LS_KEY",
  C &&
    typeof C.slug === "function" &&
    typeof C.create === "function" &&
    typeof C.lsStore === "function" &&
    typeof C.memStore === "function" &&
    typeof C.LS_KEY === "string" && C.LS_KEY.length > 0
);

// ---- 2. slug() pure + deterministic --------------------------------
const s1 = C.slug("WMS Operations");
const s2 = C.slug("WMS Operations");
check(
  "slug() is pure + deterministic (same title -> same lowercased/hyphenated key)",
  s1 === s2 && s1 === "wms-operations" && C.slug("") === "card" && C.slug("A / B!!") === "a-b",
  s1
);

// ---- 3. default = all expanded -------------------------------------
const empty = C.create({ store: C.memStore() });
check(
  "DEFAULT = all expanded (empty collapsed list, isCollapsed() false)",
  empty.collapsedIds().length === 0 && empty.isCollapsed("genCard") === false,
  "collapsedIds=[" + empty.collapsedIds().join(",") + "]"
);

// ---- 4. toggle() flips and returns state ---------------------------
const t = C.create({ store: C.memStore() });
const on = t.toggle("wmsCard");
const off = t.toggle("wmsCard");
check(
  "toggle() collapses then expands again (returns the new state)",
  on === true && off === false && t.isCollapsed("wmsCard") === false,
  "toggle -> " + on + " -> " + off
);

// ---- 5. set() explicit collapse / expand ---------------------------
const st = C.create({ store: C.memStore() });
st.set("autoCard", true);
st.set("flowCard", true);
const listAfterSet = st.collapsedIds();
st.set("autoCard", false);
check(
  "set(id,true/false) collapses/expands explicitly and updates the list",
  listAfterSet.length === 2 &&
    listAfterSet.indexOf("autoCard") !== -1 &&
    listAfterSet.indexOf("flowCard") !== -1 &&
    st.collapsedIds().length === 1 &&
    st.isCollapsed("flowCard") === true &&
    st.isCollapsed("autoCard") === false,
  "after set: [" + listAfterSet.join(",") + "] -> [" + st.collapsedIds().join(",") + "]"
);

// ---- 6. PERSIST across a shared store (survives a "reload") ---------
const shared = C.memStore();
const before = C.create({ store: shared });
before.toggle("complCard");
const afterReload = C.create({ store: shared }); // a fresh set reading the same store
check(
  "PERSIST: a collapse written to a store is restored by a new set reading it",
  afterReload.isCollapsed("complCard") === true &&
    afterReload.collapsedIds().length === 1,
  "restored [" + afterReload.collapsedIds().join(",") + "]"
);

// ---- 7. clear() expands everything ---------------------------------
const cl = C.create({ store: C.memStore() });
cl.set("a", true);
cl.set("b", true);
cl.clear();
check(
  "clear() expands everything again",
  cl.collapsedIds().length === 0 && cl.isCollapsed("a") === false
);

// ---- 8. localStorage GUARD (no-op in Node) -------------------------
const ls = C.lsStore();
const guardOk =
  JSON.stringify(ls.read()) === "{}" && // no storage -> empty (expanded)
  ls.write({ x: true }) === false; // write no-ops (returns false)
let noThrow = true;
try {
  const real = C.create(); // default store = guarded real localStorage
  real.set("z", true); // must not throw even though persistence no-ops
  noThrow = real.isCollapsed("z") === true && real.collapsedIds().length === 1;
} catch (e) {
  noThrow = false;
}
check(
  "localStorage GUARD: lsStore() no-ops in Node, store-less create() still toggles in memory",
  guardOk && noThrow,
  "read={} write=false, in-memory toggle ok"
);

// ---- 9. only `true` values persist (no corrupt default) ------------
const dirty = C.memStore({ good: true, bad: false, junk: 1, nope: "yes" });
const clean = C.create({ store: dirty });
check(
  "store isolation: only `true` ids are treated as collapsed (no corrupt default)",
  clean.collapsedIds().length === 1 && clean.isCollapsed("good") === true,
  "kept [" + clean.collapsedIds().join(",") + "]"
);

// ---- 10-12. integration guards on the shipped source ---------------
const indexHtml = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const swJs = fs.readFileSync(path.join(__dirname, "sw.js"), "utf8");
const appJs = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");

const cardsIdx = indexHtml.indexOf('src="cards.js"');
const appIdx = indexHtml.indexOf('src="app.js"');
check(
  "index.html loads cards.js before app.js and ships NO collapsed card (default expanded)",
  cardsIdx !== -1 && appIdx !== -1 && cardsIdx < appIdx &&
    indexHtml.indexOf("card--collapsed") === -1,
  "cards.js@" + cardsIdx + " < app.js@" + appIdx + ", no card--collapsed in static HTML"
);

check(
  "sw.js precaches ./cards.js (offline shell complete)",
  swJs.indexOf('"./cards.js"') !== -1
);

check(
  "app.js wires the cards GENERICALLY (WT.cards + a section.card query, not hand-wired)",
  appJs.indexOf("WT.cards") !== -1 &&
    appJs.indexOf("section.card") !== -1 &&
    appJs.indexOf("card--collapsed") !== -1,
  "generic initCollapsibleCards present"
);

console.log("");
console.log("-".repeat(60));
console.log(
  failures === 0
    ? "ALL " + checks + " CHECKS PASSED"
    : failures + " OF " + checks + " CHECKS FAILED"
);
process.exit(failures === 0 ? 0 : 1);
