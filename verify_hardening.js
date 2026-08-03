/* =====================================================================
 * verify_hardening.js - Production hardening verification (v1.5).
 *
 * The in-browser self-test (selftest.js) runs in a REAL browser and is
 * executed headlessly by the maintainer; this harness verifies its
 * PRESENCE + WIRING and the rest of the hardening pass, headlessly, in
 * Node - so the whole pass is gated by `node test/run-all.mjs`:
 *
 *   1.  errors.js EXISTS and, run under a window-shim, actually installs
 *       window.onerror + window.onunhandledrejection, initialises the
 *       window.__WT_ERRORS__ array, RECORDS an error/rejection, and does
 *       NOT swallow (onerror returns false).
 *   2.  index.html loads errors.js as an EARLY <head> script - before the
 *       first module (view.js) AND before app.js (the boundary installs
 *       before any app code runs).
 *   3.  A strict Content-Security-Policy <meta> is present with the expected
 *       offline directives, NO 'unsafe-eval', and NO 'unsafe-inline' in
 *       script-src (inline STYLE is allowed, by design).
 *   4.  Static scan: NO eval( / new Function( in the app files index.html
 *       loads, and NO inline on*= event handlers in index.html - i.e. the
 *       CSP would not break anything (nothing to loosen it for).
 *   5.  selftest.js is INERT without the flag: it guards on ?selftest=1
 *       (location.search) and early-returns; and it carries >= 25 checks.
 *   6.  selftest.js writes the machine-readable `WT-SELFTEST: PASS n/n`
 *       result into #wt-selftest and console.log()s it; #wt-selftest markup
 *       is present in index.html.
 *   7.  app.js exposes window.__WT_TEST_API__ ONLY under the ?selftest=1
 *       guard (never on a normal load).
 *   8.  sw.js precaches errors.js + selftest.js and the cache is bumped to
 *       wt-v34.
 *   9.  Offline guard on the two new files: no external hosts referenced.
 *
 * Everything is deterministic. Usage:  node verify_hardening.js
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
const swJs = read("sw.js");
const appJs = read("app.js");
const errorsSrc = read("errors.js");
const selftestSrc = read("selftest.js");

console.log("Production hardening verification (deterministic)");
console.log("");

// ---- 1. errors.js actually installs a working, non-swallowing boundary --
(function () {
  const savedWindow = global.window;
  const savedDocument = global.document;
  let ok = false;
  let detail = "";
  try {
    global.window = { addEventListener: function () {} };
    global.document = {
      body: null,
      addEventListener: function () {},
      createElement: function () {
        return { style: {}, setAttribute: function () {}, appendChild: function () {}, addEventListener: function () {}, hidden: false };
      },
    };
    // Indirect eval -> global scope, so bare `window`/`document` resolve to
    // the shims above (same trick the other harnesses use).
    // eslint-disable-next-line no-eval
    (0, eval)(errorsSrc);
    const w = global.window;
    const arrOk = Array.isArray(w.__WT_ERRORS__) && w.__WT_ERRORS__.length === 0;
    const handlersOk = typeof w.onerror === "function" && typeof w.onunhandledrejection === "function";
    const ret = w.onerror("boom", "errors.js", 1, 2, { stack: "st" });
    const recordedErr = w.__WT_ERRORS__.length === 1 && w.__WT_ERRORS__[0].message === "boom";
    const noSwallow = ret === false; // must NOT return true (would suppress console logging)
    w.onunhandledrejection({ reason: new Error("reject") });
    const recordedRej = w.__WT_ERRORS__.length === 2 && w.__WT_ERRORS__[1].message === "reject";
    ok = arrOk && handlersOk && recordedErr && noSwallow && recordedRej;
    detail = "arr=" + arrOk + " handlers=" + handlersOk + " recErr=" + recordedErr + " noSwallow=" + noSwallow + " recRej=" + recordedRej;
  } catch (e) {
    ok = false;
    detail = "threw: " + (e && e.message ? e.message : String(e));
  } finally {
    global.window = savedWindow;
    global.document = savedDocument;
  }
  check("errors.js installs onerror+onunhandledrejection, records into __WT_ERRORS__, does NOT swallow", ok, detail);
})();

check(
  "errors.js initialises the window.__WT_ERRORS__ global array",
  /window\.__WT_ERRORS__\s*=\s*\[\s*\]/.test(errorsSrc) || /__WT_ERRORS__\s*=\s*\[\]/.test(errorsSrc),
  "assignment present"
);

// ---- 2. errors.js loads early: before view.js AND before app.js ---------
const errIdx = indexHtml.indexOf('src="errors.js"');
const viewIdx = indexHtml.indexOf('src="view.js"');
const appIdx = indexHtml.indexOf('src="app.js"');
const selfIdx = indexHtml.indexOf('src="selftest.js"');
const headEnd = indexHtml.indexOf("</head>");
check(
  "index.html loads errors.js FIRST - in <head>, before view.js and app.js",
  errIdx !== -1 && viewIdx !== -1 && appIdx !== -1 && errIdx < viewIdx && errIdx < appIdx && headEnd !== -1 && errIdx < headEnd,
  "errors@" + errIdx + " < view@" + viewIdx + " < app@" + appIdx + ", </head>@" + headEnd
);
check(
  "index.html loads selftest.js LAST - after app.js",
  selfIdx !== -1 && appIdx !== -1 && selfIdx > appIdx,
  "selftest@" + selfIdx + " > app@" + appIdx
);

// ---- 3. strict CSP meta with the expected directives --------------------
const cspMatch = indexHtml.match(/http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/i);
const csp = cspMatch ? cspMatch[1] : "";
const needDirectives = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
];
const missingDir = needDirectives.filter((d) => csp.indexOf(d) === -1);
check(
  "CSP meta present with the expected offline directives",
  csp.length > 0 && missingDir.length === 0,
  missingDir.length ? "missing: " + missingDir.join(" | ") : "all present"
);
// script-src must be exactly self (no unsafe-inline / no unsafe-eval anywhere)
const scriptSrc = (csp.match(/script-src ([^;]*)/) || [, ""])[1];
check(
  "CSP has NO 'unsafe-eval' and script-src has NO 'unsafe-inline'",
  csp.indexOf("unsafe-eval") === -1 && scriptSrc.indexOf("unsafe-inline") === -1,
  "script-src =" + scriptSrc.trim()
);

// ---- 4. static scan: nothing the CSP would break ------------------------
// The local scripts index.html loads (same-origin .js files).
const scriptSrcs = [];
const re = /<script\s+src=["']([^"']+\.js)["']/gi;
let m;
while ((m = re.exec(indexHtml)) !== null) {
  const s = m[1];
  if (!/^https?:|^\/\//.test(s)) scriptSrcs.push(s.replace(/^\.\//, ""));
}
let evalOffenders = [];
scriptSrcs.forEach((s) => {
  let src = "";
  try { src = read(s); } catch (_) { return; }
  if (/\beval\s*\(/.test(src) || /new\s+Function\s*\(/.test(src)) evalOffenders.push(s);
});
check(
  "no eval( / new Function( in any app script index.html loads (" + scriptSrcs.length + " files)",
  evalOffenders.length === 0,
  evalOffenders.length ? "offenders: " + evalOffenders.join(",") : "clean"
);

// Inline on*= event handlers in the served HTML (CSP-hostile).
const inlineHandler = indexHtml.match(/\son[a-z]+\s*=\s*["']/i);
check(
  "no inline on*= event handlers in index.html (CSP script-src 'self' safe)",
  inlineHandler === null,
  inlineHandler ? "found: " + inlineHandler[0] : "none"
);

// ---- 5. selftest.js inert without the flag + substantial suite ----------
const guardsOnFlag =
  /selftest=1/.test(selftestSrc) &&
  /location\.search/.test(selftestSrc) &&
  /if\s*\(\s*!\s*selftestEnabled\(\)\s*\)\s*return/.test(selftestSrc);
check(
  "selftest.js is INERT without ?selftest=1 (guards on location.search + early return)",
  guardsOnFlag,
  "query-param guard + early return present"
);

const checkLiterals = (selftestSrc.match(/check\("/g) || []).length;
const moduleShapeFns = (selftestSrc.match(/function \(m\)/g) || []).length;
// Some checks are pushed directly (e.g. the async flow-play/stop check);
// count the named results.push()es too, excluding the error-path runner catch.
const manualNamed = (selftestSrc.match(/results\.push\(\{\s*name:\s*"/g) || []).length -
  (selftestSrc.match(/name:\s*"selftest-runner"/g) || []).length;
// One check() literal is the per-module template that expands to moduleShapeFns.
const behavioural = (checkLiterals - 1) + manualNamed;
const totalChecks = moduleShapeFns + behavioural;
check(
  "selftest.js carries >= 25 assertions (" + totalChecks + ": " + moduleShapeFns + " module + " + behavioural + " behavioural/DOM)",
  totalChecks >= 25,
  checkLiterals + " check() literals + " + manualNamed + " direct push, " + moduleShapeFns + " module shape fns"
);

// ---- 6. machine-readable result + #wt-selftest --------------------------
check(
  "selftest.js emits the machine-readable WT-SELFTEST result + console.log",
  /WT-SELFTEST: PASS /.test(selftestSrc) && /WT-SELFTEST: FAIL /.test(selftestSrc) &&
    /console\.log\(/.test(selftestSrc) && /wt-selftest/.test(selftestSrc),
  "PASS/FAIL format + console + #wt-selftest write"
);
check(
  "#wt-selftest markup present in index.html",
  /id=["']wt-selftest["']/.test(indexHtml),
  "static readout element present"
);

// ---- 7. app.js exposes the test API ONLY under the flag -----------------
const exposeGuardOk =
  appJs.indexOf("__WT_TEST_API__") !== -1 &&
  /selftest=1/.test(appJs) &&
  /function maybeExposeTestApi\(\)\s*\{[\s\S]*?selftest=1[\s\S]*?return;/.test(appJs);
check(
  "app.js attaches window.__WT_TEST_API__ ONLY under the ?selftest=1 guard",
  exposeGuardOk,
  "guarded maybeExposeTestApi() present"
);

// ---- 8. service worker precache + cache bump ----------------------------
check(
  "sw.js precaches ./errors.js and ./selftest.js",
  swJs.indexOf('"./errors.js"') !== -1 && swJs.indexOf('"./selftest.js"') !== -1,
  "both in APP_SHELL"
);
check(
  "sw.js cache bumped to wt-v34 (and no longer wt-v33)",
  /CACHE_VERSION\s*=\s*"wt-v34"/.test(swJs) && !/CACHE_VERSION\s*=\s*"wt-v33"/.test(swJs),
  "CACHE_VERSION = wt-v34"
);

// ---- 9. the two new files reference no external hosts -------------------
const externalRe = /https?:\/\/(?!schemas?\.|www\.w3\.org)/i; // allow XML/schema namespaces if any (there are none)
check(
  "errors.js + selftest.js reference no external hosts (offline)",
  !externalRe.test(errorsSrc) && !externalRe.test(selftestSrc),
  "no http(s) hosts"
);

console.log("");
console.log("-".repeat(60));
console.log(
  failures === 0
    ? "ALL " + checks + " CHECKS PASSED"
    : failures + " OF " + checks + " CHECKS FAILED"
);
process.exit(failures === 0 ? 0 : 1);
