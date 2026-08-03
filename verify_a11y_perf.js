/* =====================================================================
 * verify_a11y_perf.js - Accessibility + large-layout performance (v1.6).
 *
 * Production hardening pass 2. The LIVE DOM/pixels are covered by the
 * in-browser self-test (selftest.js, ?selftest=1, run headlessly by the
 * maintainer); this harness verifies the WIRING + the pure perf helper
 * headlessly in Node, so the whole pass is gated by `node test/run-all.mjs`:
 *
 *   A11Y (index.html / styles.css):
 *     1. The #floor <canvas> carries a non-empty aria-label AND an
 *        aria-describedby pointing at an offscreen (#floorDesc) summary that
 *        actually exists in the markup.
 *     2. Named toolbar controls (zoom -/+, Fit, 100%, Pan, 2.5D, Guided demo,
 *        Play/Pause) each expose an accessible name (aria-label OR title OR
 *        non-empty text between the tags).
 *     3. The main regions are landmarked with aria-labels (main + the three
 *        columns).
 *     4. A `@media (prefers-reduced-motion: reduce)` rule exists in styles.css.
 *     5. app.js reads a reduced-motion flag in the flow playback path
 *        (prefers-reduced-motion matcher + prefersReducedMotion() used by
 *        flowPlay / flowFrame) - so the animation never auto-runs under it.
 *     6. A visible :focus-visible outline rule exists in styles.css, and an
 *        .sr-only visually-hidden helper class exists.
 *
 *   PERF (view.js - pure, so fully testable here):
 *     7. WT.view.cullToView EXCLUDES elements fully outside the view bounds,
 *        KEEPS ones inside/overlapping, respects the pad, does NOT mutate its
 *        input, preserves order, and is DETERMINISTIC (same output twice).
 *     8. WT.view.viewBounds inverts the transform correctly (a known
 *        pan/scale/viewport -> the expected world rectangle).
 *
 *   DOCS / SELF-TEST / LICENSE:
 *     9. docs/QA_CHECKLIST.md exists with the key sections.
 *    10. selftest.js carries the new a11y/perf checks (bumped total).
 *    11. LICENSE is proprietary (all rights reserved) - NO MIT anywhere in the
 *        files this pass touched.
 *
 * Everything is deterministic. Usage:  node verify_a11y_perf.js
 * ASCII-only output. Exit 0 = all checks pass.
 * ===================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");

let failures = 0;
let checks = 0;
function check(name, ok, detail) {
  checks++;
  console.log((ok ? "[PASS] " : "[FAIL] ") + name + (detail ? " - " + detail : ""));
  if (!ok) failures++;
}
const read = (f) => fs.readFileSync(path.join(__dirname, f), "utf8");

const indexHtml = read("index.html");
const stylesCss = read("styles.css");
const appJs = read("app.js");
const selftestSrc = read("selftest.js");
const licenseTxt = read("LICENSE");

console.log("Accessibility + performance verification (deterministic)");
console.log("");

/* ------------------------------------------------------------------
 * Tiny helpers to read attributes off a specific element in index.html.
 * ------------------------------------------------------------------ */
function tagById(html, id) {
  // Grab the opening tag that carries id="<id>" (single element).
  const re = new RegExp('<([a-zA-Z]+)([^>]*\\bid=["\']' + id + '["\'][^>]*)>', "i");
  const m = html.match(re);
  return m ? { tag: m[1], attrs: m[2], whole: m[0] } : null;
}
function attr(openTag, name) {
  if (!openTag) return null;
  const m = openTag.attrs.match(new RegExp('\\b' + name + '=["\']([^"\']*)["\']', "i"));
  return m ? m[1] : null;
}
// Accessible name of a <button id=...>: aria-label, else title, else the
// text between the opening tag and </button>.
function buttonAccessibleName(html, id) {
  const t = tagById(html, id);
  if (!t) return null;
  const al = attr(t, "aria-label");
  if (al && al.trim()) return al.trim();
  const ti = attr(t, "title");
  if (ti && ti.trim()) return ti.trim();
  const idx = html.indexOf(t.whole);
  const rest = html.slice(idx + t.whole.length);
  const end = rest.indexOf("</button>");
  const inner = end === -1 ? "" : rest.slice(0, end).replace(/<[^>]*>/g, "").replace(/&[a-z]+;/gi, "").trim();
  return inner || null;
}

// ---- 1. canvas aria-label + describedby -> #floorDesc -------------------
(function () {
  const c = tagById(indexHtml, "floor");
  const label = attr(c, "aria-label");
  const describedby = attr(c, "aria-describedby");
  const descEl = describedby ? tagById(indexHtml, describedby) : null;
  const ok = !!c && c.tag.toLowerCase() === "canvas" && !!label && label.trim().length > 0 &&
    !!describedby && !!descEl;
  check("#floor canvas has aria-label + aria-describedby -> offscreen summary element", ok,
    c ? ('aria-label="' + label + '" describedby=' + describedby + " target=" + (descEl ? "present" : "MISSING")) : "no #floor");
})();

// ---- 2. named toolbar controls have accessible names --------------------
(function () {
  const ids = ["zoomOutBtn", "zoomInBtn", "zoomFitBtn", "zoom100Btn", "panBtn",
    "isoBtn", "guidedDemoBtn", "flowPlayBtn", "flowPauseBtn"];
  const missing = ids.filter((id) => {
    const n = buttonAccessibleName(indexHtml, id);
    return !n || !n.length;
  });
  check("named toolbar buttons all expose an accessible name (aria-label/title/text)",
    missing.length === 0,
    missing.length ? "no name: " + missing.join(",") : ids.length + " named");
})();

// The specific controls the brief calls out MUST have an explicit aria-label
// or title (icon / short-text controls), not rely on a bare glyph.
(function () {
  const need = ["zoomOutBtn", "zoomInBtn", "zoomFitBtn", "zoom100Btn", "panBtn", "isoBtn"];
  const bad = need.filter((id) => {
    const t = tagById(indexHtml, id);
    const al = attr(t, "aria-label");
    const ti = attr(t, "title");
    return !((al && al.trim()) || (ti && ti.trim()));
  });
  check("zoom/pan/2.5D controls carry an explicit aria-label or title", bad.length === 0,
    bad.length ? "missing: " + bad.join(",") : "all present");
})();

// ---- 3. main regions landmarked with aria-labels ------------------------
(function () {
  const mainOk = /<main\b[^>]*\baria-label=["'][^"']+["']/i.test(indexHtml);
  const leftOk = /<aside\b[^>]*class=["'][^"']*\bcol\b[^"']*\bleft\b[^"']*["'][^>]*\baria-label=/i.test(indexHtml) ||
    /class=["'][^"']*\bcol left\b[^"']*["'][^>]*aria-label=/i.test(indexHtml);
  const centerOk = /<section\b[^>]*class=["'][^"']*\bcol\b[^"']*\bcenter\b[^"']*["'][^>]*\baria-label=/i.test(indexHtml);
  const rightOk = /<aside\b[^>]*class=["'][^"']*\bcol\b[^"']*\bright\b[^"']*["'][^>]*\baria-label=/i.test(indexHtml);
  check("main regions landmarked (main + left/center/right columns carry aria-label)",
    mainOk && leftOk && centerOk && rightOk,
    "main=" + mainOk + " left=" + leftOk + " center=" + centerOk + " right=" + rightOk);
})();

// ---- 4. prefers-reduced-motion rule in styles.css -----------------------
check("styles.css has a @media (prefers-reduced-motion: reduce) rule",
  /@media[^{]*prefers-reduced-motion:\s*reduce/i.test(stylesCss),
  "reduced-motion media query present");

// ---- 5. app.js flow loop reads a reduced-motion flag --------------------
(function () {
  const hasMatcher = /matchMedia\(\s*["']\(prefers-reduced-motion:\s*reduce\)["']\s*\)/.test(appJs);
  const hasFn = /function prefersReducedMotion\s*\(/.test(appJs);
  // used inside the flow playback path (flowPlay and/or flowFrame)
  const usedInFlow = /prefersReducedMotion\(\)/.test(appJs) &&
    /function flowPlay\s*\(\)\s*\{[\s\S]*?prefersReducedMotion\(\)[\s\S]*?\}/.test(appJs);
  check("app.js reads a prefers-reduced-motion flag in the flow playback path",
    hasMatcher && hasFn && usedInFlow,
    "matcher=" + hasMatcher + " fn=" + hasFn + " usedInFlowPlay=" + usedInFlow);
})();

// ---- 6. :focus-visible + .sr-only in styles.css -------------------------
check("styles.css defines a visible :focus-visible outline for interactive controls",
  /:focus-visible\s*[,{]/.test(stylesCss) && /\.btn:focus-visible/.test(stylesCss),
  "focus-visible rule present");
check("styles.css defines an .sr-only visually-hidden helper (offscreen canvas summary)",
  /\.sr-only\s*\{/.test(stylesCss),
  ".sr-only class present");

/* ------------------------------------------------------------------
 * Load the REAL view.js in Node (same window-shim + indirect-eval trick
 * the other pure harnesses use) and exercise cullToView / viewBounds.
 * ------------------------------------------------------------------ */
const savedWindow = global.window;
global.window = global; // view.js attaches to window.WT
// eslint-disable-next-line no-eval
(0, eval)(read("view.js"));
const V = global.window.WT.view;
global.window = savedWindow;

// ---- 7. cullToView pure + correct + deterministic -----------------------
(function () {
  let ok = false, detail = "";
  try {
    const bounds = { minX: 10, minY: 10, maxX: 30, maxY: 20 };
    const inside = { id: "in", type: "shelf", x: 12, y: 12, w: 4, d: 3 };      // fully inside
    const overlap = { id: "edge", type: "shelf", x: 28, y: 18, w: 6, d: 6 };   // straddles the right/bottom edge
    const leftOut = { id: "L", type: "shelf", x: 0, y: 12, w: 3, d: 3 };       // fully left of minX (3 < 10)
    const rightOut = { id: "R", type: "shelf", x: 40, y: 12, w: 2, d: 2 };     // fully right of maxX
    const belowOut = { id: "B", type: "shelf", x: 12, y: 40, w: 2, d: 2 };     // fully below maxY
    const els = [inside, overlap, leftOut, rightOut, belowOut];
    const snapshot = JSON.stringify(els);

    const kept = V.cullToView(els, bounds, 0);
    const keptIds = kept.map((e) => e.id);
    const keepsInside = keptIds.indexOf("in") !== -1;
    const keepsOverlap = keptIds.indexOf("edge") !== -1;
    const dropsOutside = keptIds.indexOf("L") === -1 && keptIds.indexOf("R") === -1 && keptIds.indexOf("B") === -1;
    // order preserved among the kept ones
    const orderOk = keptIds.join(",") === "in,edge";
    // pure: input array + items untouched, and a NEW array returned
    const noMutate = JSON.stringify(els) === snapshot && kept !== els;
    // deterministic: identical result on a second call
    const determ = JSON.stringify(V.cullToView(els, bounds, 0)) === JSON.stringify(kept);
    // pad grows the box: a just-outside element becomes kept with enough pad
    const near = { id: "near", type: "shelf", x: 6, y: 12, w: 2, d: 2 };       // x2=8, minX=10 -> outside by 2
    const noPad = V.cullToView([near], bounds, 0).length === 0;
    const withPad = V.cullToView([near], bounds, 3).length === 1;              // pad 3 pulls it in
    // degenerate bounds -> shallow copy of everything (never hide content)
    const degen = V.cullToView(els, null, 0);
    const degenOk = degen.length === els.length && degen !== els;

    ok = keepsInside && keepsOverlap && dropsOutside && orderOk && noMutate && determ && noPad && withPad && degenOk;
    detail = "kept=[" + keptIds.join(",") + "] noMutate=" + noMutate + " determ=" + determ +
      " pad(off->off=" + noPad + ",on=" + withPad + ") degenCopy=" + degenOk;
  } catch (e) {
    ok = false;
    detail = "threw: " + (e && e.message ? e.message : String(e));
  }
  check("WT.view.cullToView is pure, correct (drops fully-off-screen, keeps inside/overlap) + deterministic", ok, detail);
})();

// ---- 8. viewBounds inverts the transform --------------------------------
(function () {
  let ok = false, detail = "";
  try {
    // cellPx 20, scale 2 -> 40 px per world cell. pan (0,0), viewport 400x200.
    const view = { cellPx: 20, scale: 2, panX: 0, panY: 0 };
    const b = V.viewBounds(view, 400, 200);
    // world width = 400/40 = 10 cells; height = 200/40 = 5 cells.
    const okZeroPan = b.minX === 0 && b.minY === 0 && Math.abs(b.maxX - 10) < 1e-9 && Math.abs(b.maxY - 5) < 1e-9;
    // pan the content right+down by 40px (one world cell) -> minX/minY shift to -1.
    const view2 = { cellPx: 20, scale: 2, panX: 40, panY: 40 };
    const b2 = V.viewBounds(view2, 400, 200);
    const okPan = Math.abs(b2.minX - (-1)) < 1e-9 && Math.abs(b2.minY - (-1)) < 1e-9 && Math.abs(b2.maxX - 9) < 1e-9;
    ok = okZeroPan && okPan;
    detail = "zeroPan(minX=" + b.minX + ",maxX=" + b.maxX + ",maxY=" + b.maxY + ") panned(minX=" + b2.minX + ")";
  } catch (e) {
    ok = false;
    detail = "threw: " + (e && e.message ? e.message : String(e));
  }
  check("WT.view.viewBounds inverts pan/scale to the correct world rectangle", ok, detail);
})();

// ---- 9. QA_CHECKLIST.md exists with the key sections ---------------------
(function () {
  let qa = "";
  try { qa = read(path.join("docs", "QA_CHECKLIST.md")); } catch (_) { qa = ""; }
  const need = ["Offline", "PWA", "self-test", "CSP", "error boundary", "Accessibility", "Reduced motion",
    "Performance", "on-device", "Honesty", "Proprietary"];
  const missing = need.filter((s) => qa.toLowerCase().indexOf(s.toLowerCase()) === -1);
  check("docs/QA_CHECKLIST.md exists with the key release sections",
    qa.length > 0 && missing.length === 0,
    qa.length ? (missing.length ? "missing: " + missing.join(",") : need.length + " sections") : "file missing");
})();

// ---- 10. selftest.js carries the new a11y/perf checks -------------------
(function () {
  const names = ["a11y-canvas-has-aria-label", "a11y-canvas-described-by-summary",
    "a11y-toolbar-accessible-names", "a11y-reduced-motion-flag", "perf-cullToView-culls-offscreen"];
  const missing = names.filter((n) => selftestSrc.indexOf('"' + n + '"') === -1);
  check("selftest.js adds the v1.6 a11y/perf checks (extends the live suite)",
    missing.length === 0,
    missing.length ? "missing: " + missing.join(",") : names.length + " new checks");
})();

// ---- 11. proprietary license, no MIT in touched files -------------------
(function () {
  const propOk = /All rights reserved/i.test(licenseTxt) && !/MIT License/i.test(licenseTxt);
  const touched = ["view.js", "app.js", "styles.css", "selftest.js", "index.html",
    "verify_hardening.js", "sw.js", path.join("docs", "QA_CHECKLIST.md"), path.join("docs", "PRODUCTION.md")];
  const mitOffenders = touched.filter((f) => {
    let src = "";
    try { src = read(f); } catch (_) { return false; }
    return /\bMIT License\b/i.test(src) || /SPDX-License-Identifier:\s*MIT/i.test(src);
  });
  check("LICENSE is proprietary (all rights reserved) and NO MIT in any touched file",
    propOk && mitOffenders.length === 0,
    "proprietary=" + propOk + (mitOffenders.length ? " MIT-in:" + mitOffenders.join(",") : " no MIT"));
})();

console.log("");
console.log("-".repeat(60));
console.log(
  failures === 0
    ? "ALL " + checks + " CHECKS PASSED"
    : failures + " OF " + checks + " CHECKS FAILED"
);
process.exit(failures === 0 ? 0 : 1);
