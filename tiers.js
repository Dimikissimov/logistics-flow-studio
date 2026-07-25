/* =====================================================================
 * Logistics Flow Studio - WarehouseTwin
 * tiers.js - the demo/full tier gate (P4)
 * ---------------------------------------------------------------------
 * HONESTY NOTE - read this before judging the "lock":
 * This is a SHOWCASE gate, not DRM and not security. The entire app is
 * client-side, so anyone can open DevTools and flip the tier - that is
 * expected and fine. The point is to demonstrate, in ONE clean module,
 * how a demo/full split is engineered: every gated feature reads
 * capability flags from here (caps()) instead of scattering
 * if-statements through the codebase.
 *
 * In a real commercial deployment the "Unlock full version" button
 * would not simply write localStorage: it would run a license or
 * purchase check (e.g. a Play Billing purchase token verified against
 * the Google Play Developer API on a backend, or a signed license key
 * validated server-side) and only then persist the entitlement. That
 * swap happens entirely inside setTier()/current() below - the rest of
 * the app keeps reading the same capability flags. See
 * PUBLISH_ANDROID.md section "Demo vs full tier".
 *
 * UX rule: locked items stay VISIBLE and render an original padlock
 * glyph + an unlock hint. Nothing is silently hidden - an honest
 * showcase shows what the full version has.
 * ===================================================================== */
(function () {
  "use strict";
  const WT = (window.WT = window.WT || {});

  // Where the current tier is persisted. In a real deployment this
  // would be an entitlement issued by a license/purchase check, not a
  // plain localStorage flag.
  const LS_KEY = "wt.tier.v1";

  /* ------------------------------------------------------------------
   * Tier definitions. `null` means "everything the domain offers".
   * A list means "exactly these ids"; anything else renders locked.
   * ------------------------------------------------------------------ */
  const TIERS = {
    demo: {
      id: "demo",
      label: "Demo",
      // Palette: the P1 starter set only.
      palette: [
        "selective-racking", "block-stack",
        "dock-in", "dock-out", "staging", "conveyor",
      ],
      // Strategies: the two P1 slotting strategies only.
      strategies: ["random", "abc"],
      // Presets: none - the MRO preset is a full-version feature.
      presets: [],
      // Advisor: only the top suggestions are shown.
      advisorLimit: 2,
    },
    full: {
      id: "full",
      label: "Full",
      palette: null,
      strategies: null,
      presets: null,
      advisorLimit: Infinity,
    },
  };

  function current() {
    // Real deployment: this would read a verified entitlement
    // (see the honesty note above). Default is the demo tier.
    try {
      const t = localStorage.getItem(LS_KEY);
      return TIERS[t] ? t : "demo";
    } catch (_) {
      return "demo";
    }
  }

  function setTier(id) {
    // Real deployment: replace this body with the license/purchase
    // verification; only persist after the check succeeds.
    if (!TIERS[id]) return current();
    try { localStorage.setItem(LS_KEY, id); } catch (_) {}
    return id;
  }

  /* ------------------------------------------------------------------
   * caps() - the single read surface for the rest of the app.
   * Palette, strategy selects, the preset button and the advisor all
   * call these flags; none of them know how the tier is stored.
   * ------------------------------------------------------------------ */
  function caps() {
    const id = current();
    const t = TIERS[id];
    return {
      tier: id,
      label: t.label,
      isDemo: id === "demo",
      advisorLimit: t.advisorLimit,
      paletteAllowed: (type) => !t.palette || t.palette.indexOf(type) !== -1,
      strategyAllowed: (sid) => !t.strategies || t.strategies.indexOf(sid) !== -1,
      presetAllowed: (pid) => !t.presets || t.presets.indexOf(pid) !== -1,
      lockHint: (what) =>
        what + " is part of the full version - use “Unlock full version” in the header. " +
        "(In this showcase that is a local switch; a real deployment would verify a license or purchase here.)",
    };
  }

  // If a saved/imported config carries a strategy the current tier does
  // not include, fall back to ABC (always available in both tiers).
  function coerceStrategy(sid) {
    return caps().strategyAllowed(sid) ? sid : "abc";
  }

  /* ------------------------------------------------------------------
   * Original padlock glyph (hand-written inline SVG, no external asset,
   * no third-party icon set). Rendered wherever a locked item shows.
   * ------------------------------------------------------------------ */
  function padlockSVG() {
    return (
      '<svg class="lock-glyph" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" focusable="false">' +
      '<rect x="5" y="10.5" width="14" height="9.5" rx="2.5" fill="currentColor"/>' +
      '<path d="M8 10.5 V7.5 a4 4 0 0 1 8 0 v3" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>' +
      '<circle cx="12" cy="15" r="1.6" fill="var(--surface, #fff)"/>' +
      "</svg>"
    );
  }

  WT.tiers = { TIERS, LS_KEY, current, setTier, caps, coerceStrategy, padlockSVG };
})();
