/* =====================================================================
 * Logistics Flow Studio - WarehouseTwin
 * deeplink.js - open a specific example scenario (and skip onboarding)
 *               straight from the URL query string.
 * ---------------------------------------------------------------------
 * A scenario becomes shareable/embeddable with a link, and a demo or
 * screenshot can open a chosen plant directly, unobstructed:
 *
 *     index.html?scenario=coldchain-frozen-dc   (load that example, no modal)
 *     index.html?example=coldchain-frozen-dc    (alias of ?scenario=)
 *     index.html?onboarding=0                    (skip the welcome modal only)
 *
 * This module is a PURE, DOM-free, deterministic PARSER only:
 *   WT.deeplink.parse(search) -> { scenario, skipOnboarding }
 * It reads nothing (no location, no DOM), mutates nothing, and does NOT
 * validate the scenario id - it returns the raw id verbatim. app.js is
 * the one that validates the id against WT.examples.library and, on a
 * match, loads it through the SAME loadExample() the UI buttons use; an
 * unknown id falls through to a normal boot. A deep-link is PER-URL, not
 * a saved preference: it never flips the "don't show onboarding again"
 * localStorage flag - it only suppresses the modal for that one load.
 *
 * Precedence (in app.js boot): an explicit #layout= share-hash wins, else
 * a ?scenario= deep-link, else the saved layout, else the demo starter.
 * ?selftest=1 is NOT hijacked (parse ignores it); a ?scenario= composes
 * freely with it and any other unrelated query params.
 *
 * Classic script on the global WT namespace (works over file://). Also
 * loads in Node under the same window shim the other harnesses use, so
 * verify_deeplink.js exercises the REAL parser, not a copy.
 * ===================================================================== */
(function () {
  "use strict";
  const WT = (window.WT = window.WT || {});

  // Query keys that name a scenario to open (first present one wins).
  const SCENARIO_KEYS = ["scenario", "example"];
  // Values of ?onboarding= that mean "skip the welcome modal".
  const OFF_VALUES = ["0", "false", "off", "no"];

  // Split a query string into a first-wins { key: value } map. Tolerates a
  // leading "?", a trailing "#fragment", bare keys, "+"-as-space and
  // percent-encoding (bad escapes fall back to the raw text, never throw).
  function toParams(search) {
    const params = {};
    if (typeof search !== "string" || search.length === 0) return params;
    let q = search;
    const hash = q.indexOf("#");
    if (hash !== -1) q = q.slice(0, hash); // a fragment is not part of the query
    if (q.charAt(0) === "?") q = q.slice(1);
    if (q.length === 0) return params;
    q.split("&").forEach(function (pair) {
      if (!pair) return;
      const eq = pair.indexOf("=");
      const rawKey = eq === -1 ? pair : pair.slice(0, eq);
      const rawVal = eq === -1 ? "" : pair.slice(eq + 1);
      const key = decode(rawKey).trim();
      if (!key || Object.prototype.hasOwnProperty.call(params, key)) return; // first wins
      params[key] = decode(rawVal);
    });
    return params;
  }

  function decode(s) {
    try {
      return decodeURIComponent(String(s).replace(/\+/g, " "));
    } catch (_) {
      return String(s); // malformed %xx: keep it literal rather than throw
    }
  }

  /**
   * Parse a location.search string into a deep-link intent.
   * PURE + DETERMINISTIC: no DOM, no globals read, input never mutated.
   * @param {string} search e.g. "?scenario=coldchain-frozen-dc&selftest=1"
   * @returns {{scenario: (string|null), skipOnboarding: boolean}}
   *   scenario        the RAW id from ?scenario= / ?example= (app validates
   *                   it against WT.examples.library), or null if absent.
   *   skipOnboarding  true when a scenario is given OR ?onboarding=0 - a
   *                   scenario deep-link implies onboarding suppression so
   *                   the plant shows immediately, unobstructed.
   */
  function parse(search) {
    const out = { scenario: null, skipOnboarding: false };
    const params = toParams(search);

    for (let i = 0; i < SCENARIO_KEYS.length; i++) {
      const v = params[SCENARIO_KEYS[i]];
      if (v != null && String(v).trim() !== "") {
        out.scenario = String(v).trim();
        break;
      }
    }

    if (out.scenario) {
      out.skipOnboarding = true; // a scenario shows immediately, unobstructed
    } else if (params.onboarding != null) {
      out.skipOnboarding = OFF_VALUES.indexOf(String(params.onboarding).trim().toLowerCase()) !== -1;
    }
    return out;
  }

  WT.deeplink = { parse: parse, SCENARIO_KEYS: SCENARIO_KEYS.slice() };
})();
