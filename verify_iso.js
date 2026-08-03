/* =====================================================================
 * verify_iso.js - 2.5D ISOMETRIC presentation projection verification.
 *
 * Runs the REAL iso module (iso.js) in Node with the same window shim the
 * other harnesses use and asserts the PURE parts directly. The browser
 * canvas cannot be exercised in the sandbox, so drawScene (the only
 * DOM/canvas-touching helper) is verified LIVE in the browser; but the
 * math every iso draw call routes through - project(), elementHeight(),
 * the HEIGHTS table and the painter's depth sort - is pure and fully
 * testable here. domain.js is loaded too so we can prove the heights are
 * grounded in the SAME `heightM` the IFC export uses (single source of
 * truth), not invented twice.
 *
 * Checks (all deterministic):
 *   - project() is deterministic (byte-identical on repeat)
 *   - a known cell projects to the EXPECTED iso offset (2:1 dimetric)
 *   - +x maps screen right AND down; +y maps screen left AND down
 *   - +z RAISES the point on screen (screen-y decreases), x unchanged
 *   - the projection is LINEAR (no translation; additive) so collinear
 *     world points stay collinear on screen
 *   - the KX:KY ratio is exactly 2:1 (the documented "2:1" isometric)
 *   - elementHeight returns a POSITIVE FINITE height for EVERY domain
 *     element type, and matches domain.heightM where it exists
 *   - the HEIGHTS fallback table covers every domain element type
 *   - an unknown type still yields a positive finite (default) height
 *   - the painter's depth sort orders a known set BACK-TO-FRONT and is
 *     deterministic + stable, and does NOT mutate its input
 *   - the iso pure pipeline (project/elementHeight/sort) never mutates
 *     the layout: toggling the view mode is a no-op on elements/config
 *   - the honesty labels (illustrative / not a BIM model) are present
 *
 * Usage:  node verify_iso.js
 * ASCII-only output. Exit 0 = all checks pass.
 * ===================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");

global.window = global; // domain.js + iso.js attach themselves to window.WT
// eslint-disable-next-line no-eval
(0, eval)(fs.readFileSync(path.join(__dirname, "domain.js"), "utf8"));
// eslint-disable-next-line no-eval
(0, eval)(fs.readFileSync(path.join(__dirname, "iso.js"), "utf8"));
const I = global.WT.iso;
const D = global.WT.domain;
const ISO_SRC = fs.readFileSync(path.join(__dirname, "iso.js"), "utf8");

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? "[PASS] " : "[FAIL] ") + name + (detail ? " - " + detail : ""));
  if (!ok) failures++;
}
function approx(a, b, eps) { return Math.abs(a - b) <= (eps == null ? 1e-9 : eps); }

console.log("2.5D isometric presentation projection verification");
console.log("");

/* ---- 1. Deterministic + pure ------------------------------------- */
(() => {
  const a = I.project(3.5, 7.25, 4);
  const b = I.project(3.5, 7.25, 4);
  const c = I.project(3.5, 7.25, 4);
  check("project() is deterministic (byte-identical on repeat)",
    JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(b) === JSON.stringify(c),
    "=" + JSON.stringify(a));
})();

/* ---- 2. Known cell projects to the expected offset --------------- */
(() => {
  // 2:1 dimetric with KX=0.5, KY=0.25: (2,0,0) -> (1.0, 0.5); origin -> 0.
  const o = I.project(0, 0, 0);
  const p = I.project(2, 0, 0);
  const q = I.project(4, 4, 0);
  check("a known cell projects to the expected iso offset",
    approx(o.x, 0) && approx(o.y, 0) &&
    approx(p.x, 1.0) && approx(p.y, 0.5) &&
    approx(q.x, 0) && approx(q.y, 2.0),
    "(2,0)->(" + p.x + "," + p.y + ") (4,4)->(" + q.x + "," + q.y + ")");
})();

/* ---- 3. +x maps screen RIGHT and DOWN ---------------------------- */
(() => {
  const o = I.project(0, 0, 0);
  const px = I.project(1, 0, 0);
  check("+x maps to screen right AND down",
    px.x > o.x && px.y > o.y, "dx=" + (px.x - o.x) + " dy=" + (px.y - o.y));
})();

/* ---- 4. +y maps screen LEFT and DOWN ----------------------------- */
(() => {
  const o = I.project(0, 0, 0);
  const py = I.project(0, 1, 0);
  check("+y maps to screen left AND down",
    py.x < o.x && py.y > o.y, "dx=" + (py.x - o.x) + " dy=" + (py.y - o.y));
})();

/* ---- 5. +z RAISES the point (screen-y decreases), x unchanged ---- */
(() => {
  const g = I.project(3, 5, 0);
  const up = I.project(3, 5, 6);
  check("+z raises the point on screen (screen-y decreases), x unchanged",
    up.y < g.y && approx(up.x, g.x), "dy=" + (up.y - g.y).toFixed(3) + " (must be < 0)");
})();

/* ---- 6. Linear (no translation, additive) ------------------------ */
(() => {
  // A linear map has project(0)=0 and project(a+b)=project(a)+project(b).
  const zero = I.project(0, 0, 0);
  const a = I.project(1, 2, 0.5);
  const b = I.project(2, 3, 4);
  const sum = I.project(3, 5, 4.5);
  const ok = approx(zero.x, 0) && approx(zero.y, 0) &&
    approx(sum.x, a.x + b.x) && approx(sum.y, a.y + b.y);
  check("projection is linear (origin fixed, additive)", ok,
    "sum=(" + sum.x + "," + sum.y + ") a+b=(" + (a.x + b.x) + "," + (a.y + b.y) + ")");
})();

/* ---- 7. Collinear world points stay collinear on screen ---------- */
(() => {
  // Two independent world lines (one on the ground, one rising in z).
  function cross(p0, p1, p2) {
    return (p1.x - p0.x) * (p2.y - p0.y) - (p1.y - p0.y) * (p2.x - p0.x);
  }
  const ground = [I.project(0, 0, 0), I.project(3, 1, 0), I.project(6, 2, 0)];
  const rising = [I.project(0, 0, 0), I.project(1, 2, 3), I.project(2, 4, 6)];
  check("collinear world points stay collinear on screen",
    approx(cross(ground[0], ground[1], ground[2]), 0) &&
    approx(cross(rising[0], rising[1], rising[2]), 0),
    "ground x-prod=" + cross(ground[0], ground[1], ground[2]).toExponential(1) +
    " rising x-prod=" + cross(rising[0], rising[1], rising[2]).toExponential(1));
})();

/* ---- 8. The KX:KY ratio is exactly 2:1 --------------------------- */
(() => {
  check("the ground projection is 2:1 dimetric (KX = 2 * KY)",
    approx(I.ISO.KX, 2 * I.ISO.KY) && I.ISO.KZ > 0,
    "KX=" + I.ISO.KX + " KY=" + I.ISO.KY + " KZ=" + I.ISO.KZ);
})();

/* ---- 9. elementHeight positive+finite for EVERY domain type ------ */
(() => {
  const types = Object.keys(D.ELEMENTS);
  let bad = null;
  for (const t of types) {
    const h = I.elementHeight(t);
    if (!(isFinite(h) && h > 0)) { bad = t + "=" + h; break; }
  }
  check("elementHeight is positive & finite for all " + types.length + " element types",
    bad === null, bad ? "offender " + bad : "all > 0");
})();

/* ---- 10. elementHeight matches domain.heightM (one source) ------- */
(() => {
  const types = Object.keys(D.ELEMENTS);
  let mismatch = null;
  for (const t of types) {
    const dom = D.ELEMENTS[t].heightM;
    if (isFinite(dom) && dom > 0 && I.elementHeight(t) !== dom) {
      mismatch = t + " iso=" + I.elementHeight(t) + " domain=" + dom; break;
    }
  }
  check("elementHeight reuses domain.heightM (single source of truth)",
    mismatch === null, mismatch || "all match domain heightM");
})();

/* ---- 11. HEIGHTS fallback table covers every domain type --------- */
(() => {
  const types = Object.keys(D.ELEMENTS);
  const missing = types.filter((t) => !(isFinite(I.HEIGHTS[t]) && I.HEIGHTS[t] > 0));
  check("HEIGHTS fallback table covers every domain element type",
    missing.length === 0, missing.length ? "missing " + missing.join(",") : types.length + " types covered");
})();

/* ---- 12. Unknown type still yields a positive finite default ----- */
(() => {
  const h = I.elementHeight("no-such-type");
  check("an unknown type yields a positive finite (default) height",
    isFinite(h) && h > 0, "default=" + h);
})();

/* ---- 13. Painter's depth sort: back-to-front, stable, no mutation  */
(() => {
  // Three boxes marching toward the viewer along the depth axis: (0,0) is
  // farthest BACK (drawn first), (10,10) is nearest the camera (drawn
  // last). Feed them out of order and assert the correct back-to-front.
  const input = [
    { id: "front", x: 10, y: 10, w: 2, d: 2 },
    { id: "back", x: 0, y: 0, w: 2, d: 2 },
    { id: "mid", x: 5, y: 5, w: 2, d: 2 },
  ];
  const snapshot = JSON.stringify(input);
  const out1 = I.sortByDepth(input).map((e) => e.id).join(">");
  const out2 = I.sortByDepth(input).map((e) => e.id).join(">");
  const correct = out1 === "back>mid>front";
  const deterministic = out1 === out2;
  const noMutate = JSON.stringify(input) === snapshot && input[0].id === "front";
  // Stability: two boxes with an EXACT tie on the front-corner depth key
  // keep their input order (the tie-break falls through to the index).
  const tie = [
    { id: "a", x: 0, y: 4, w: 2, d: 2 }, // front corner (0+2)+(4+2) = 8
    { id: "b", x: 4, y: 0, w: 2, d: 2 }, // front corner (4+2)+(0+2) = 8
  ];
  const tieOrder = I.sortByDepth(tie).map((e) => e.id).join(">");
  check("painter's depth sort: back-to-front, deterministic, stable, non-mutating",
    correct && deterministic && noMutate && tieOrder === "a>b",
    "order=" + out1 + " tie=" + tieOrder + " noMutate=" + noMutate);
})();

/* ---- 14. depthKey grows toward the viewer ------------------------ */
(() => {
  const back = I.depthKey({ x: 0, y: 0, w: 2, d: 2 });
  const front = I.depthKey({ x: 10, y: 10, w: 2, d: 2 });
  check("depthKey increases toward the viewer (front > back)",
    front > back, "back=" + back + " front=" + front);
})();

/* ---- 15. Iso pipeline never mutates the layout (view toggle no-op) */
(() => {
  // The whole honesty claim: switching to iso only changes RENDERING, not
  // state. Run the pure iso pipeline over a real preset layout and assert
  // the elements + config are byte-identical afterwards.
  const preset = D.PRESETS["mro-distributor"];
  const layout = { config: JSON.parse(JSON.stringify(preset.config)),
                   elements: preset.elements.map((e, i) => Object.assign({ id: "e" + i }, e)) };
  const before = JSON.stringify(layout);
  // Exercise every pure entry point the iso renderer uses.
  const sorted = I.sortByDepth(layout.elements);
  for (const e of sorted) {
    I.elementHeight(e.type);
    I.project(e.x, e.y, I.elementHeight(e.type));
    I.project(e.x + e.w, e.y + e.d, 0);
  }
  const after = JSON.stringify(layout);
  check("iso pure pipeline never mutates the layout (view-mode toggle is a no-op on state)",
    before === after && sorted.length === layout.elements.length,
    "elements=" + layout.elements.length + " unchanged=" + (before === after));
})();

/* ---- 16. Honesty labels present in the module -------------------- */
(() => {
  const hasIllustrative = /ILLUSTRATIVE/i.test(ISO_SRC);
  const notBim = /NOT a BIM model/i.test(ISO_SRC);
  const illDefaults = /illustrative defaults/i.test(ISO_SRC);
  check("honesty labels present (illustrative / NOT a BIM model / illustrative defaults)",
    hasIllustrative && notBim && illDefaults,
    "illustrative=" + hasIllustrative + " not-bim=" + notBim + " defaults=" + illDefaults);
})();

console.log("");
console.log(failures === 0
  ? "ALL ISO CHECKS PASSED (16 checks)"
  : failures + " ISO CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
