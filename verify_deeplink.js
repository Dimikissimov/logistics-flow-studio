/* =====================================================================
 * verify_deeplink.js - scenario deep-link parser verification (v1.7).
 *
 * Runs the REAL parser (deeplink.js) in Node under the same window shim
 * the other harnesses use, plus the REAL example library (domain.js ->
 * generate.js -> compliance.js -> examples.js) so a genuine library id is
 * cross-checked. Proves the PURE, DOM-free WT.deeplink.parse(search):
 *
 *   1. ?scenario=<id>            -> returns that id + skipOnboarding true.
 *   2. ?example=<id>             -> alias: same id + skipOnboarding true.
 *   3. ?onboarding=0 (alone)     -> scenario null, skipOnboarding true;
 *      ?onboarding=1 keeps it     -> skipOnboarding false (modal shows).
 *   4. empty/"?"/no query        -> no-op { null, false }.
 *   5. ?selftest=1               -> NOT hijacked: { null, false }.
 *   6. unknown scenario id       -> returned RAW/verbatim (app validates
 *      it against the library, not the parser).
 *   7. purity + determinism      -> no DOM touched, input string never
 *      mutated, same input -> deep-equal output twice.
 *   8. composition               -> ignores unrelated params and is
 *      order-independent (?selftest=1&scenario=..&foo=bar, either order).
 *   9. a scenario ALWAYS implies onboarding suppression (even unknown id).
 *  10. a REAL WT.examples.library id round-trips through parse().
 *  11. tolerant: leading "?", trailing #fragment, "+"-as-space, bare keys,
 *      and a malformed %xx escape never throw.
 *
 * Deterministic. Usage:  node verify_deeplink.js
 * ASCII-only output. Exit 0 = all checks pass.
 * ===================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");

// The parser needs only `window`; load the example library too so a real
// id is exercised end-to-end (examples.js reuses domain/generate/compliance).
global.window = global; // app modules attach themselves to window.WT
for (const f of ["domain.js", "generate.js", "compliance.js", "examples.js", "deeplink.js"]) {
  // eslint-disable-next-line no-eval
  (0, eval)(fs.readFileSync(path.join(__dirname, f), "utf8"));
}
const WT = global.WT;
const DL = WT.deeplink;

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? "[PASS] " : "[FAIL] ") + name + (detail ? " - " + detail : ""));
  if (!ok) failures++;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("Scenario deep-link parser verification (deterministic)");
console.log("");

// ---- shape ----------------------------------------------------------
check("WT.deeplink.parse exists", DL && typeof DL.parse === "function",
  DL ? "typeof parse=" + typeof DL.parse : "MISSING");

// ---- 1 + 2: ?scenario= and ?example= both yield the id + skip --------
(function () {
  const a = DL.parse("?scenario=coldchain-frozen-dc");
  check("?scenario=<id> returns the id + skipOnboarding true",
    a.scenario === "coldchain-frozen-dc" && a.skipOnboarding === true, JSON.stringify(a));
  const b = DL.parse("?example=coldchain-frozen-dc");
  check("?example=<id> is an alias: same id + skipOnboarding true",
    b.scenario === "coldchain-frozen-dc" && b.skipOnboarding === true, JSON.stringify(b));
})();

// ---- 3: ?onboarding= governs the modal on its own -------------------
(function () {
  const off = DL.parse("?onboarding=0");
  check("?onboarding=0 alone -> no scenario, skipOnboarding true",
    off.scenario === null && off.skipOnboarding === true, JSON.stringify(off));
  const on = DL.parse("?onboarding=1");
  check("?onboarding=1 -> skipOnboarding false (modal still shows)",
    on.scenario === null && on.skipOnboarding === false, JSON.stringify(on));
  const words = ["false", "off", "no"].every((v) => DL.parse("?onboarding=" + v).skipOnboarding === true);
  check("?onboarding=false/off/no also suppress", words);
})();

// ---- 4: empty / "?" / no query are a clean no-op --------------------
(function () {
  const want = { scenario: null, skipOnboarding: false };
  const cases = ["", "?", "?#frag", "   ", null, undefined, 42];
  const allNoop = cases.every((c) => eq(DL.parse(c), want));
  check("empty / '?' / non-string queries are a no-op { null, false }", allNoop,
    "cases=" + cases.map((c) => JSON.stringify(c)).join(","));
})();

// ---- 5: ?selftest=1 is NOT hijacked ---------------------------------
(function () {
  const s = DL.parse("?selftest=1");
  check("?selftest=1 is not hijacked (no scenario, no skip)",
    s.scenario === null && s.skipOnboarding === false, JSON.stringify(s));
})();

// ---- 6: unknown id is returned RAW (parser never validates) ---------
(function () {
  const u = DL.parse("?scenario=does-not-exist-xyz");
  const known = WT.examples.library.some((e) => e.id === "does-not-exist-xyz");
  check("unknown scenario id returned verbatim; parser does NOT validate",
    u.scenario === "does-not-exist-xyz" && known === false, JSON.stringify(u) + " known=" + known);
})();

// ---- 7: purity + determinism (no DOM, no input mutation) ------------
(function () {
  // A poisoned document proves parse() reads no DOM.
  const savedDoc = global.document;
  global.document = { get location() { throw new Error("parse touched the DOM"); } };
  let threw = false, r1, r2;
  try {
    const input = "?scenario=pharma-gdp-warehouse&onboarding=0";
    const frozen = String(input);
    r1 = DL.parse(input);
    r2 = DL.parse(input);
    check("input string is not mutated", input === frozen, input);
  } catch (e) {
    threw = true;
    check("parse() does not touch the DOM", false, e.message);
  } finally {
    global.document = savedDoc;
  }
  if (!threw) {
    check("parse() reads no DOM (poisoned document untouched)", true);
    check("deterministic: same input -> deep-equal output twice", eq(r1, r2), JSON.stringify(r1));
  }
})();

// ---- 8: composition + order independence ----------------------------
(function () {
  const a = DL.parse("?selftest=1&scenario=coldchain-frozen-dc&foo=bar");
  const b = DL.parse("?scenario=coldchain-frozen-dc&selftest=1&foo=bar");
  const ok = a.scenario === "coldchain-frozen-dc" && a.skipOnboarding === true && eq(a, b);
  check("composes with unrelated params, order-independent", ok,
    "a=" + JSON.stringify(a) + " b=" + JSON.stringify(b));
})();

// ---- 9: a scenario ALWAYS implies onboarding suppression ------------
(function () {
  const known = DL.parse("?scenario=coldchain-frozen-dc");
  const unknown = DL.parse("?scenario=nope");
  check("any ?scenario= implies skipOnboarding (even an unknown id)",
    known.skipOnboarding === true && unknown.skipOnboarding === true,
    "known=" + known.skipOnboarding + " unknown=" + unknown.skipOnboarding);
})();

// ---- 10: a REAL library id round-trips through parse() --------------
(function () {
  const realId = WT.examples.library[0].id;
  const r = DL.parse("?scenario=" + realId);
  const inLibrary = WT.examples.library.some((e) => e.id === r.scenario);
  check("a real WT.examples.library id round-trips through parse()",
    r.scenario === realId && inLibrary, realId + " inLibrary=" + inLibrary);
})();

// ---- 11: tolerant of encoding / shape quirks ------------------------
(function () {
  let ok = true, detail = "";
  try {
    const frag = DL.parse("?scenario=coldchain-frozen-dc#section");
    if (frag.scenario !== "coldchain-frozen-dc") { ok = false; detail = "fragment leaked"; }
    const spaces = DL.parse("?scenario=a+b");
    if (spaces.scenario !== "a b") { ok = false; detail = "+ not decoded"; }
    const bad = DL.parse("?scenario=%zz");   // malformed escape -> kept literal
    if (bad.scenario !== "%zz") { ok = false; detail = "bad escape not tolerated: " + JSON.stringify(bad); }
    const bare = DL.parse("?onboarding");    // bare key, no value -> not a skip
    if (bare.skipOnboarding !== false) { ok = false; detail = "bare key mis-parsed"; }
  } catch (e) {
    ok = false; detail = "threw: " + e.message;
  }
  check("tolerant: trailing #fragment, +-space, malformed %xx, bare key (never throws)", ok, detail || "ok");
})();

console.log("");
console.log(failures === 0 ? "ALL DEEP-LINK CHECKS PASSED" : failures + " DEEP-LINK CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
