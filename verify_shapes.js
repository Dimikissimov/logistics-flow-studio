/* =====================================================================
 * verify_shapes.js - per-type SHAPE REGISTRY (2D glyph + 3D form) checks.
 *
 * Runs the REAL shape module (shapes.js) in Node with the same window shim
 * the other harnesses use. shapes.js is a PURE drawing module: it takes a
 * canvas ctx plus plain geometry/colour and draws. The actual pixels are
 * only verifiable LIVE in the browser, but everything the draw calls route
 * through is finite math, so we exercise EVERY draw path against a mock 2D
 * context that records every coordinate and flags any non-finite value or
 * throw. domain.js is loaded too so we prove the registry covers EXACTLY
 * the domain element types and that the 3D forms use the domain heightM.
 *
 * The key quality gate (a pure-draw feature that can't be pixel-tested
 * headlessly): a mock-context SMOKE TEST that draws EVERY type in BOTH 2D
 * and 3D, in light + dark, at small AND large scale (so the Level-Of-Detail
 * path is exercised), asserting NO throw and NO non-finite coordinate.
 *
 * Checks (all deterministic):
 *   - has(type) is true for EVERY domain element type (2D AND 3D defined)
 *   - the registry covers EXACTLY the domain types (no orphans, none missing)
 *   - meta + ICONS cover exactly those types (non-empty descriptions/fns)
 *   - draw2D smoke: every type x {light,dark} x {small,large} - no throw,
 *     all-finite coords, and the LOD path is distinct (full glyph draws
 *     more than the zoomed-out icon)
 *   - draw3D smoke: every type x {light,dark} - no throw, all-finite coords
 *   - draw3D uses the height: a taller heightM raises the form on screen
 *     (top y decreases) for every type
 *   - neither draw2D nor draw3D mutates its inputs
 *   - unknown types: has() false, draw2D/draw3D return false without throwing
 *   - known types: draw2D/draw3D return true
 *   - honesty labels present (illustrative / NOT CAD / NOT BIM / no brands)
 *   - offline: no external asset reference in the module
 *
 * Usage:  node verify_shapes.js
 * ASCII-only output. Exit 0 = all checks pass.
 * ===================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");

global.window = global; // domain.js + shapes.js attach themselves to window.WT
// A matchMedia shim is not needed here (shapes.js reads no app state), but
// define a harmless one in case future edits reference it.
global.matchMedia = global.matchMedia || function () { return { matches: false }; };
// eslint-disable-next-line no-eval
(0, eval)(fs.readFileSync(path.join(__dirname, "domain.js"), "utf8"));
// eslint-disable-next-line no-eval
(0, eval)(fs.readFileSync(path.join(__dirname, "shapes.js"), "utf8"));
const S = global.WT.shapes;
const D = global.WT.domain;
const SRC = fs.readFileSync(path.join(__dirname, "shapes.js"), "utf8");

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? "[PASS] " : "[FAIL] ") + name + (detail ? " - " + detail : ""));
  if (!ok) failures++;
}

const TYPES = Object.keys(D.ELEMENTS);
const THEMES = ["light", "dark"];

/* ---- Recording mock 2D context ----------------------------------- */
function makeCtx() {
  const ctx = { _bad: [], _calls: 0, _minY: Infinity, _maxY: -Infinity };
  const num = (name, args) => {
    ctx._calls++;
    for (const n of args) if (typeof n === "number" && !isFinite(n)) ctx._bad.push(name + "=" + n);
  };
  const trackY = (y) => { if (typeof y === "number" && isFinite(y)) { if (y < ctx._minY) ctx._minY = y; if (y > ctx._maxY) ctx._maxY = y; } };
  ctx.save = () => {}; ctx.restore = () => {};
  ctx.beginPath = () => {}; ctx.closePath = () => {};
  ctx.moveTo = (x, y) => { num("moveTo", [x, y]); trackY(y); };
  ctx.lineTo = (x, y) => { num("lineTo", [x, y]); trackY(y); };
  ctx.arc = (x, y, r, a, b) => { num("arc", [x, y, r, a, b]); trackY(y); };
  ctx.arcTo = (x1, y1, x2, y2, r) => { num("arcTo", [x1, y1, x2, y2, r]); };
  ctx.rect = (x, y, w, h) => { num("rect", [x, y, w, h]); trackY(y); trackY(y + h); };
  ctx.fillRect = (x, y, w, h) => { num("fillRect", [x, y, w, h]); trackY(y); trackY(y + h); };
  ctx.strokeRect = (x, y, w, h) => { num("strokeRect", [x, y, w, h]); trackY(y); trackY(y + h); };
  ctx.fill = () => {}; ctx.stroke = () => {};
  ctx.setLineDash = (a) => { if (Array.isArray(a)) for (const n of a) { if (typeof n === "number" && !isFinite(n)) ctx._bad.push("dash=" + n); } };
  ctx.measureText = (t) => ({ width: String(t).length * 6 });
  ctx.fillText = () => {}; ctx.strokeText = () => {};
  // settable style props (plain fields; assignment must never throw)
  ctx.fillStyle = ""; ctx.strokeStyle = ""; ctx.lineWidth = 1; ctx.lineJoin = "";
  ctx.font = ""; ctx.textAlign = ""; ctx.textBaseline = ""; ctx.globalAlpha = 1;
  return ctx;
}
// A deterministic 2:1-dimetric-style projection: finite for finite input.
function makeP() {
  return (cx, cy, cz) => ({ x: 400 + (cx - cy) * 18, y: 260 + (cx + cy) * 9 - (cz || 0) * 6 });
}

console.log("Per-type shape registry (2D glyph + 3D form) verification");
console.log("");

/* ---- 1. has(type) true for EVERY domain type (2D AND 3D) --------- */
(() => {
  const missing = TYPES.filter((t) => S.has(t) !== true);
  check("has(type) is true for every domain element type (2D + 3D both defined)",
    missing.length === 0,
    missing.length ? "missing " + missing.join(",") : TYPES.length + " types covered");
})();

/* ---- 2. Registry covers EXACTLY the domain types (no orphans) ---- */
(() => {
  const dom = TYPES.slice().sort();
  const reg = S.types().slice().sort();
  const extra = reg.filter((t) => dom.indexOf(t) < 0);
  const gone = dom.filter((t) => reg.indexOf(t) < 0);
  check("the registry covers exactly the domain types (no orphans, none missing)",
    extra.length === 0 && gone.length === 0 && reg.length === dom.length,
    "reg=" + reg.length + " dom=" + dom.length + (extra.length ? " extra=" + extra.join(",") : "") + (gone.length ? " missing=" + gone.join(",") : ""));
})();

/* ---- 3. meta + ICONS cover exactly the types -------------------- */
(() => {
  const metaKeys = Object.keys(S.meta).sort();
  const iconKeys = Object.keys(S.ICONS).sort();
  const dom = TYPES.slice().sort();
  const metaOk = metaKeys.length === dom.length && metaKeys.every((k, i) => k === dom[i]);
  const iconOk = iconKeys.length === dom.length && iconKeys.every((k, i) => k === dom[i]);
  const descOk = TYPES.every((t) => S.meta[t] && String(S.meta[t].glyph2d).length > 3 && String(S.meta[t].form3d).length > 3);
  const fnOk = TYPES.every((t) => typeof S.ICONS[t] === "function");
  check("meta + ICONS cover exactly the types (non-empty 2D/3D descriptions + icon fns)",
    metaOk && iconOk && descOk && fnOk,
    "meta=" + metaKeys.length + " icons=" + iconKeys.length + " descOk=" + descOk + " fnOk=" + fnOk);
})();

/* ---- 4. draw2D SMOKE: every type, both themes, small+large scale  */
(() => {
  let bad = 0, badType = null, notFinite = null, lodFail = null, retFail = null;
  const cell = 20;
  for (const t of TYPES) {
    const def = D.ELEMENTS[t];
    const pw = def.w * cell, ph = def.d * cell;
    for (const theme of THEMES) {
      // small scale (on-screen ~3 px/cell -> LOD icon path)
      const cs = makeCtx();
      let okS = true;
      try { okS = S.draw2D(cs, t, { x: 100, y: 80, w: pw, d: ph, cellPx: cell, color: def.color, theme, lod: 3 }); }
      catch (e) { bad++; badType = t + " small/" + theme + ": " + e.message; okS = false; }
      // large scale (on-screen ~44 px/cell -> full glyph path)
      const cl = makeCtx();
      let okL = true;
      try { okL = S.draw2D(cl, t, { x: 100, y: 80, w: pw, d: ph, cellPx: cell, color: def.color, theme, lod: 44 }); }
      catch (e) { bad++; badType = t + " large/" + theme + ": " + e.message; okL = false; }
      if (okS !== true || okL !== true) retFail = t + "/" + theme + " ret=" + okS + "," + okL;
      if (cs._bad.length || cl._bad.length) notFinite = t + "/" + theme + " " + (cs._bad[0] || cl._bad[0]);
      // LOD distinct: the full glyph must draw more than the zoomed-out icon
      if (!(cl._calls > cs._calls)) lodFail = t + "/" + theme + " small=" + cs._calls + " large=" + cl._calls;
    }
  }
  check("draw2D smoke: every type x light/dark x small/large draws with no throw + all finite",
    bad === 0 && notFinite === null && retFail === null,
    bad ? "throw " + badType : (notFinite ? "non-finite " + notFinite : (retFail ? "ret " + retFail : (TYPES.length * 2 * 2) + " draws clean")));
  check("draw2D LOD path is exercised (full glyph draws more than the zoomed-out icon)",
    lodFail === null, lodFail || "full > icon for all types/themes");
})();

/* ---- 5. draw3D SMOKE: every type, both themes ------------------- */
(() => {
  let bad = 0, badType = null, notFinite = null, retFail = null;
  const P = makeP();
  for (const t of TYPES) {
    const def = D.ELEMENTS[t];
    for (const theme of THEMES) {
      const c = makeCtx();
      let ok = true;
      try {
        ok = S.draw3D(c, t, P, { cx: 4, cy: 3, w: def.w, d: def.d, heightM: def.heightM || 6, color: def.color, theme, selected: true, selColor: "#38bdf8" });
      } catch (e) { bad++; badType = t + "/" + theme + ": " + e.message; ok = false; }
      if (ok !== true) retFail = t + "/" + theme + " ret=" + ok;
      if (c._bad.length) notFinite = t + "/" + theme + " " + c._bad[0];
    }
  }
  check("draw3D smoke: every type x light/dark draws (incl. selection) with no throw + all finite",
    bad === 0 && notFinite === null && retFail === null,
    bad ? "throw " + badType : (notFinite ? "non-finite " + notFinite : (retFail ? "ret " + retFail : (TYPES.length * 2) + " forms clean")));
})();

/* ---- 6. draw3D uses the height (taller -> higher on screen) ------ */
(() => {
  const P = makeP();
  let fail = null;
  for (const t of TYPES) {
    const def = D.ELEMENTS[t];
    const cLow = makeCtx(); S.draw3D(cLow, t, P, { cx: 4, cy: 3, w: def.w, d: def.d, heightM: 2, color: def.color, theme: "light" });
    const cHigh = makeCtx(); S.draw3D(cHigh, t, P, { cx: 4, cy: 3, w: def.w, d: def.d, heightM: 25, color: def.color, theme: "light" });
    // In this projection +z decreases screen-y, so a taller form must reach
    // a SMALLER minimum y. Proves the form is extruded by heightM, not flat.
    if (!(cHigh._minY < cLow._minY - 1e-6)) fail = t + " low.minY=" + cLow._minY.toFixed(1) + " high.minY=" + cHigh._minY.toFixed(1);
  }
  check("draw3D forms use the domain heightM (a taller element rises on screen) for every type",
    fail === null, fail || "monotonic in height for all " + TYPES.length + " types");
})();

/* ---- 7. draw2D does not mutate its inputs ----------------------- */
(() => {
  const P = makeP();
  let fail = null;
  for (const t of TYPES) {
    const def = D.ELEMENTS[t];
    const g = { x: 100, y: 80, w: def.w * 20, d: def.d * 20, cellPx: 20, color: def.color, theme: "dark", lod: 44 };
    const before = JSON.stringify(g);
    S.draw2D(makeCtx(), t, g);
    if (JSON.stringify(g) !== before) fail = t;
  }
  check("draw2D does not mutate its geometry/colour input", fail === null, fail ? "mutated for " + fail : "inputs unchanged for all types");
})();

/* ---- 8. draw3D does not mutate its inputs ----------------------- */
(() => {
  const P = makeP();
  let fail = null;
  for (const t of TYPES) {
    const def = D.ELEMENTS[t];
    const o = { cx: 4, cy: 3, w: def.w, d: def.d, heightM: def.heightM || 6, color: def.color, theme: "dark", selected: true, selColor: "#38bdf8" };
    const before = JSON.stringify(o);
    S.draw3D(makeCtx(), t, P, o);
    if (JSON.stringify(o) !== before) fail = t;
  }
  check("draw3D does not mutate its geometry/colour input", fail === null, fail ? "mutated for " + fail : "inputs unchanged for all types");
})();

/* ---- 9. Unknown types are safe (false, no throw) ---------------- */
(() => {
  const P = makeP();
  let threw = null, r2 = null, r3 = null;
  try {
    const hasBogus = S.has("no-such-type");
    r2 = S.draw2D(makeCtx(), "no-such-type", { x: 0, y: 0, w: 40, d: 40, cellPx: 20, color: "#123456", theme: "light", lod: 44 });
    r3 = S.draw3D(makeCtx(), "no-such-type", P, { cx: 0, cy: 0, w: 2, d: 2, heightM: 5, color: "#123456", theme: "light" });
    check("an unknown type is safe: has() false and draw2D/draw3D return false without throwing",
      hasBogus === false && r2 === false && r3 === false,
      "has=" + hasBogus + " draw2D=" + r2 + " draw3D=" + r3);
  } catch (e) { threw = e.message; check("an unknown type is safe (no throw)", false, "threw " + threw); }
})();

/* ---- 10. Known types return true -------------------------------- */
(() => {
  const P = makeP();
  const def = D.ELEMENTS["selective-racking"];
  const r2 = S.draw2D(makeCtx(), "selective-racking", { x: 0, y: 0, w: def.w * 20, d: def.d * 20, cellPx: 20, color: def.color, theme: "light", lod: 44 });
  const r3 = S.draw3D(makeCtx(), "selective-racking", P, { cx: 0, cy: 0, w: def.w, d: def.d, heightM: def.heightM, color: def.color, theme: "light" });
  check("draw2D and draw3D return true for a known type", r2 === true && r3 === true, "draw2D=" + r2 + " draw3D=" + r3);
})();

/* ---- 11. Honesty labels present in the module ------------------- */
(() => {
  const illustrative = /ILLUSTRATIVE/i.test(SRC);
  const notCad = /NOT CAD/i.test(SRC);
  const notBim = /NOT BIM/i.test(SRC);
  const noBrands = /No real brands/i.test(SRC);
  check("honesty labels present (illustrative / NOT CAD / NOT BIM / no real brands)",
    illustrative && notCad && notBim && noBrands,
    "illustrative=" + illustrative + " notCAD=" + notCad + " notBIM=" + notBim + " noBrands=" + noBrands);
})();

/* ---- 12. Offline: no external asset reference ------------------- */
(() => {
  const ext = /(?:src|href)\s*=\s*["']https?:\/\//i.test(SRC) || /url\(\s*["']?https?:\/\//i.test(SRC) || /fetch\(\s*["'`]https?:\/\//i.test(SRC) || /https?:\/\//i.test(SRC);
  check("offline: shapes.js references no external asset (no http(s) URL)", !ext, ext ? "external ref found" : "clean");
})();

console.log("");
console.log(failures === 0
  ? "ALL SHAPES CHECKS PASSED (13 checks)"
  : failures + " SHAPES CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
