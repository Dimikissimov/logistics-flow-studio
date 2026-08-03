/* =====================================================================
 * Logistics Flow Studio - WarehouseTwin
 * selftest.js - a REAL in-browser end-to-end self-test.
 * ---------------------------------------------------------------------
 * INERT by default. It only runs when the URL carries `?selftest=1`
 * (e.g. index.html?selftest=1); a normal load is COMPLETELY unaffected -
 * the guard below returns immediately and nothing else executes.
 *
 * When enabled, it waits for the app to finish booting, then drives the
 * LIVE app through the SAME functions the UI uses (exposed in self-test
 * mode as window.__WT_TEST_API__ by app.js) and asserts wiring + a clean
 * boot. It writes a MACHINE-READABLE result into a #wt-selftest element
 * (created here) and console.log()s it, in one of two exact formats:
 *
 *     WT-SELFTEST: PASS 46/46
 *     WT-SELFTEST: FAIL 44/46 :: <comma-separated failed check names>
 *
 * A maintainer runs it headlessly (e.g. headless Edge) and reads the
 * #wt-selftest text / the console line.
 *
 * HONESTY: this verifies WIRING and a NO-UNCAUGHT-ERROR boot - that every
 * module is present and of the right shape, the panels/buttons exist, and
 * the real handlers run without throwing. It does NOT verify visual/pixel
 * correctness (that is what the human eye + the pure-draw harnesses cover).
 * Each check is isolated in try/catch, so one failing check is one FAIL,
 * never a dead page; the suite restores the app to a normal state at the end.
 *
 * Loaded LAST (after app.js). Dependency-free, CSP-safe (no eval, no inline).
 * ===================================================================== */
(function () {
  "use strict";

  // --- The single gate: inert unless ?selftest=1 is in the query string ---
  function selftestEnabled() {
    return /[?&]selftest=1(?:&|$)/.test(window.location.search);
  }
  if (!selftestEnabled()) return; // NORMAL load: do nothing at all.

  var results = []; // { name, ok, detail }

  function check(name, fn) {
    var ok = false;
    var detail = "";
    try {
      var r = fn();
      if (r && typeof r === "object" && "ok" in r) {
        ok = !!r.ok;
        detail = r.detail || "";
      } else {
        ok = !!r;
      }
    } catch (e) {
      ok = false;
      detail = e && e.message ? e.message : String(e);
    }
    results.push({ name: name, ok: ok, detail: detail });
    return ok;
  }

  function raf() {
    return new Promise(function (resolve) {
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(function () { resolve(); });
      } else {
        setTimeout(resolve, 16);
      }
    });
  }

  var $ = function (id) { return document.getElementById(id); };

  // ------------------------------------------------------------------
  // The check suite. Runs against the LIVE, booted app.
  // ------------------------------------------------------------------
  async function runSuite() {
    var WT = window.WT || {};
    var API = window.__WT_TEST_API__ || null;

    // ---- Error-boundary state: a clean boot has recorded NO errors -----
    check("errors-global-array", function () {
      return { ok: Array.isArray(window.__WT_ERRORS__), detail: "type=" + typeof window.__WT_ERRORS__ };
    });
    check("no-errors-during-boot", function () {
      var e = window.__WT_ERRORS__ || [];
      return { ok: e.length === 0, detail: e.length ? e.map(function (x) { return x.message; }).join(" | ") : "clean" };
    });

    // ---- Every expected WT.* module present + of the right shape -------
    var MODULES = [
      ["domain", function (m) { return m && m.ELEMENTS && typeof m.elementCapacity === "function"; }],
      ["view", function (m) { return m && typeof m.worldToScreen === "function" && typeof m.fitView === "function"; }],
      ["compliance", function (m) { return m && typeof m.check === "function"; }],
      ["advisor", function (m) { return m && typeof m.analyze === "function"; }],
      ["generate", function (m) { return m && typeof m.generateLayout === "function" && m.plantProfiles; }],
      ["examples", function (m) { return m && Array.isArray(m.library) && m.library.length >= 20 && typeof m.build === "function"; }],
      ["wms", function (m) { return m && typeof m.runOperations === "function" && typeof m.kpis === "function"; }],
      ["flowsim", function (m) { return m && typeof m.step === "function" && typeof m.state === "function"; }],
      ["kpicharts", function (m) { return m && typeof m.drawDashboard === "function" && typeof m.series === "function"; }],
      ["wmsdata", function (m) { return m && typeof m.stats === "function" && typeof m.generate === "function"; }],
      ["storage", function (m) { return m && typeof m.stats === "function" && typeof m.assign === "function"; }],
      ["kb", function (m) { return m && typeof m.get === "function" && typeof m.list === "function"; }],
      ["automation", function (m) { return m && typeof m.report === "function" && typeof m.systems === "function"; }],
      ["report", function (m) { return m && typeof m.build === "function" && typeof m.toHtml === "function" && typeof m.toJson === "function"; }],
      ["compare", function (m) { return m && typeof m.compare === "function"; }],
      ["scenarios", function (m) { return m && typeof m.save === "function" && typeof m.list === "function"; }],
      ["orderpool", function (m) { return m && typeof m.create === "function" && typeof m.step === "function"; }],
      ["iso", function (m) { return m && typeof m.project === "function" && typeof m.elementHeight === "function"; }],
      ["shapes", function (m) { return m && typeof m.has === "function" && typeof m.draw2D === "function" && typeof m.draw3D === "function"; }],
      ["cards", function (m) { return m && typeof m.create === "function" && typeof m.slug === "function"; }],
      ["demo", function (m) { return m && typeof m.run === "function" && Array.isArray(m.ACTIONS) && m.ABOUT; }],
      ["tiers", function (m) { return m && typeof m.caps === "function" && typeof m.current === "function"; }],
    ];
    MODULES.forEach(function (pair) {
      var name = pair[0];
      var shapeOk = pair[1];
      check("module:WT." + name, function () {
        var m = WT[name];
        return { ok: !!m && shapeOk(m), detail: m ? "present" : "MISSING" };
      });
    });

    // ---- The self-test hook the app exposes in self-test mode ----------
    check("test-api-exposed", function () {
      return {
        ok: !!API && typeof API.loadExample === "function" && typeof API.runWmsOps === "function" && typeof API.render === "function",
        detail: API ? "attached" : "MISSING (__WT_TEST_API__)",
      };
    });

    // ---- v1.7 DEEP-LINK: the scenario deep-link parser exists + works --
    // index.html?scenario=<id> opens that example scenario (and skips the
    // welcome modal) at boot. Assert the PURE parser is present and returns
    // a REAL library id verbatim, that ?onboarding=0 skips on its own, and
    // that ?selftest=1 is NOT hijacked (no scenario, no skip).
    check("deeplink-parser-parses-scenario", function () {
      var DL = WT.deeplink;
      if (!DL || typeof DL.parse !== "function") return { ok: false, detail: "WT.deeplink.parse MISSING" };
      var ex = WT.examples && WT.examples.library && WT.examples.library[0];
      if (!ex) return { ok: false, detail: "no example in library" };
      var r = DL.parse("?scenario=" + ex.id);
      var off = DL.parse("?onboarding=0");
      var st = DL.parse("?selftest=1");
      var ok = r.scenario === ex.id && r.skipOnboarding === true &&
        off.skipOnboarding === true && st.scenario === null && st.skipOnboarding === false;
      return { ok: ok, detail: "scenario=" + r.scenario + " skip=" + r.skipOnboarding +
        " onboarding0=" + off.skipOnboarding + " selftestSafe=" + (st.scenario === null) };
    });

    // ---- Canvas exists + has a non-zero drawing buffer -----------------
    check("canvas-present-sized", function () {
      var c = $("floor");
      return {
        ok: !!c && c.tagName === "CANVAS" && c.width > 0 && c.height > 0,
        detail: c ? c.width + "x" + c.height : "no #floor",
      };
    });

    // ---- Key panels / cards present in the DOM -------------------------
    check("panels-present", function () {
      var ids = ["genCard", "examplesCard", "scenariosCard", "compareCard", "dataCard",
        "wmsDataCard", "propCard", "wmsCard", "autoCard", "storageCard", "flowCard",
        "complCard", "kbCard"];
      var missing = ids.filter(function (id) { return !$(id); });
      return { ok: missing.length === 0, detail: missing.length ? "missing: " + missing.join(",") : ids.length + " ok" };
    });

    // ---- Key buttons / controls present in the DOM ---------------------
    check("buttons-present", function () {
      var ids = ["genBtn", "exampleLoadBtn", "wmsBtn", "flowPlayBtn", "flowPauseBtn",
        "flowResetBtn", "flowStepBtn", "reportOpenBtn", "reportJsonBtn", "compareRunBtn",
        "scenarioSaveBtn", "storageAssignBtn", "autoBtn", "complBtn", "kbAddRuleBtn",
        "guidedDemoBtn", "aboutBtn", "isoBtn", "zoomInBtn", "zoomOutBtn", "zoomFitBtn"];
      var missing = ids.filter(function (id) { return !$(id); });
      return { ok: missing.length === 0, detail: missing.length ? "missing: " + missing.join(",") : ids.length + " ok" };
    });

    // ---- Live example load places elements + redraws with no error -----
    // From here on we DRIVE the app through the exposed handlers.
    var haveApi = !!API;
    check("load-example-places-elements", function () {
      if (!haveApi) return { ok: false, detail: "no test API" };
      var before = API.state.elements.length;
      var ex = WT.examples && WT.examples.library && WT.examples.library[0];
      if (!ex) return { ok: false, detail: "no example in library" };
      API.loadExample(ex.id);
      var after = API.state.elements.length;
      return { ok: after > 0, detail: ex.id + ": " + before + " -> " + after + " elements" };
    });

    check("redraw-no-error", function () {
      if (!haveApi) return { ok: false, detail: "no test API" };
      API.render(); // reuses the same render() the whole app draws through
      return { ok: true, detail: "render() returned" };
    });

    // ---- WMS ops populates its panel -----------------------------------
    check("wms-ops-populates-panel", function () {
      if (!haveApi) return { ok: false, detail: "no test API" };
      API.runWmsOps();
      var out = $("wmsOut");
      var html = out ? out.innerHTML : "";
      var empty = html.indexOf('class="empty"') !== -1;
      return { ok: !!html && html.length > 40 && !empty, detail: "wmsOut html len=" + html.length };
    });

    // ---- Flow: stepping advances the flowsim tick, no error ------------
    check("flow-step-advances-sim", function () {
      if (!haveApi) return { ok: false, detail: "no test API" };
      API.flowReset();
      var sim0 = API.state.flow.sim;
      if (!sim0) return { ok: false, detail: "no sim after reset" };
      var tick0 = sim0.tick;
      API.flowStep();
      API.flowStep();
      var sim1 = API.state.flow.sim;
      return { ok: !!sim1 && sim1.tick > tick0, detail: "tick " + tick0 + " -> " + (sim1 ? sim1.tick : "?") };
    });

    // ---- Flow: play starts the animation, then it stops cleanly --------
    // Awaits a couple of real animation frames, then pauses (async check).
    var playOk = false;
    var playDetail = "";
    try {
      if (haveApi) {
        API.flowReset();
        API.flowPlay();
        var playing = !!API.state.flow.playing;
        await raf();
        await raf();
        API.flowPause();
        var stopped = API.state.flow.playing === false;
        playOk = playing && stopped;
        playDetail = "playing=" + playing + " -> stopped=" + stopped;
      } else {
        playDetail = "no test API";
      }
    } catch (e) {
      playOk = false;
      playDetail = e && e.message ? e.message : String(e);
    }
    results.push({ name: "flow-play-then-stop", ok: playOk, detail: playDetail });

    // ---- 2.5D toggle is a pure no-op on the layout ---------------------
    check("iso-toggle-layout-unchanged", function () {
      if (!haveApi) return { ok: false, detail: "no test API" };
      var snapshot = JSON.stringify(API.state.elements);
      API.setViewMode("iso");
      var inIso = API.state.viewMode === "iso";
      API.setViewMode("top");
      var backTop = API.state.viewMode === "top";
      var same = JSON.stringify(API.state.elements) === snapshot;
      return { ok: inIso && backTop && same, detail: "iso=" + inIso + " top=" + backTop + " layout-unchanged=" + same };
    });

    // ---- Report builds with the expected sections ----------------------
    var report = null;
    check("report-build-sections", function () {
      if (!haveApi) return { ok: false, detail: "no test API" };
      report = API.buildCurrentReport();
      var need = ["header", "layout", "compliance", "operations", "storage", "automation", "dataProfile", "standardsBasis"];
      var missing = need.filter(function (k) { return !report || report[k] == null; });
      var sectionsOk = report && Array.isArray(report.sections) && report.sections.length > 0;
      return { ok: missing.length === 0 && sectionsOk, detail: missing.length ? "missing: " + missing.join(",") : "all sections + " + (report.sections ? report.sections.length : 0) + " section refs" };
    });

    check("report-json-roundtrip", function () {
      if (!report || !WT.report) return { ok: false, detail: "no report" };
      var json = WT.report.toJson(report);
      var parsed = JSON.parse(json);
      return { ok: !!parsed && !!parsed.header && !!parsed.compliance, detail: "json len=" + json.length };
    });

    // ---- About / knowledge-base panels open without throwing -----------
    check("about-open-close", function () {
      if (!haveApi) return { ok: false, detail: "no test API" };
      API.openAbout();
      var body = $("aboutBody");
      var opened = $("about") && $("about").hidden === false && body && body.innerHTML.length > 0;
      API.closeAbout();
      var closed = $("about") && $("about").hidden === true;
      return { ok: !!opened && !!closed, detail: "opened=" + !!opened + " closed=" + !!closed };
    });

    check("knowledge-base-populated", function () {
      var list = $("kbList");
      return { ok: !!list && list.innerHTML.replace(/\s/g, "").length > 0, detail: list ? "kbList len=" + list.innerHTML.length : "no #kbList" };
    });

    // ---- Zoom controls run without throwing ----------------------------
    check("zoom-controls-run", function () {
      if (!haveApi) return { ok: false, detail: "no test API" };
      API.zoomAt(1.2);
      API.fitToFloor();
      return { ok: API.view.scale > 0, detail: "scale=" + API.view.scale.toFixed(3) };
    });

    // ---- v1.6 A11Y: the canvas exposes a text alternative --------------
    // A canvas is opaque to assistive tech; it must carry an aria-label AND
    // point at an offscreen description that reflects the current layout.
    check("a11y-canvas-has-aria-label", function () {
      var c = $("floor");
      var label = c ? (c.getAttribute("aria-label") || "") : "";
      return { ok: !!c && label.trim().length > 0, detail: c ? 'aria-label="' + label + '"' : "no #floor" };
    });
    check("a11y-canvas-described-by-summary", function () {
      var c = $("floor");
      var ref = c ? c.getAttribute("aria-describedby") : null;
      var desc = ref ? $(ref) : null;
      var text = desc ? (desc.textContent || "").trim() : "";
      // The description is kept current by the app (element count / floor
      // size / sim status); after boot + a render it must be non-trivial.
      return { ok: !!desc && text.length > 10, detail: desc ? "#" + ref + " len=" + text.length : "no describedby target" };
    });

    // ---- v1.6 A11Y: key toolbar controls have accessible names ---------
    check("a11y-toolbar-accessible-names", function () {
      var ids = ["zoomInBtn", "zoomOutBtn", "zoomFitBtn", "zoom100Btn", "panBtn",
        "isoBtn", "guidedDemoBtn", "flowPlayBtn", "flowPauseBtn"];
      var missing = ids.filter(function (id) {
        var b = $(id);
        if (!b) return true;
        var name = (b.getAttribute("aria-label") || b.textContent || b.getAttribute("title") || "").trim();
        return name.length === 0;
      });
      return { ok: missing.length === 0, detail: missing.length ? "no accessible name: " + missing.join(",") : ids.length + " named" };
    });

    // ---- v1.6 A11Y: reduced-motion preference is honoured --------------
    // The app exposes a reduced-motion flag it reads before auto-running the
    // material-flow animation; here we assert the hook exists and is boolean.
    check("a11y-reduced-motion-flag", function () {
      if (!haveApi) return { ok: false, detail: "no test API" };
      var rm = API.prefersReducedMotion;
      return { ok: typeof rm === "function" && typeof rm() === "boolean", detail: "prefersReducedMotion()=" + (typeof rm === "function" ? rm() : "MISSING") };
    });

    // ---- v1.6 PERF: cullToView is pure + correct (live wiring) ----------
    check("perf-cullToView-culls-offscreen", function () {
      if (!haveApi || typeof API.cullToView !== "function") return { ok: false, detail: "no cullToView on API" };
      var bounds = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
      var inside = { id: "in", type: "shelf", x: 2, y: 2, w: 2, d: 2 };
      var outside = { id: "out", type: "shelf", x: 100, y: 100, w: 2, d: 2 };
      var els = [inside, outside];
      var kept = API.cullToView(els, bounds, 0);
      var mutated = els.length !== 2;
      var determ = JSON.stringify(API.cullToView(els, bounds, 0)) === JSON.stringify(kept);
      var ok = kept.length === 1 && kept[0].id === "in" && !mutated && determ;
      return { ok: ok, detail: "kept=" + kept.length + " determ=" + determ + " noMutate=" + !mutated };
    });

    // ---- Restore the app to a normal, usable state ---------------------
    try {
      if (haveApi) {
        API.flowPause();
        API.setViewMode("top");
        API.fitToFloor();
        API.render();
      }
    } catch (_) { /* restoration is best-effort */ }

    // ---- Final: driving the app introduced NO uncaught errors ----------
    check("no-errors-after-drive", function () {
      var e = window.__WT_ERRORS__ || [];
      return { ok: e.length === 0, detail: e.length ? e.map(function (x) { return x.message; }).join(" | ") : "clean" };
    });

    report_result();
  }

  // ------------------------------------------------------------------
  // Emit the machine-readable result into #wt-selftest and the console.
  // ------------------------------------------------------------------
  function report_result() {
    var total = results.length;
    var passed = results.filter(function (r) { return r.ok; }).length;
    var failed = results.filter(function (r) { return !r.ok; });
    var line;
    if (failed.length === 0) {
      line = "WT-SELFTEST: PASS " + passed + "/" + total;
    } else {
      line = "WT-SELFTEST: FAIL " + passed + "/" + total + " :: " +
        failed.map(function (r) { return r.name; }).join(", ");
    }

    var el = $("wt-selftest");
    if (!el) {
      el = document.createElement("div");
      el.id = "wt-selftest";
      // Off to the corner, out of the way, but present in the DOM for a
      // headless reader to scrape. Not hidden (display:none) so it is always
      // reachable via textContent.
      el.style.position = "fixed";
      el.style.left = "-99999px";
      el.style.top = "0";
      el.style.whiteSpace = "pre";
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent = line;
    el.setAttribute("data-pass", String(passed));
    el.setAttribute("data-total", String(total));
    el.setAttribute("data-ok", failed.length === 0 ? "1" : "0");

    // Full detail for a human reading the console.
    try {
      /* eslint-disable no-console */
      console.log(line);
      results.forEach(function (r) {
        console.log((r.ok ? "  [PASS] " : "  [FAIL] ") + r.name + (r.detail ? " - " + r.detail : ""));
      });
      /* eslint-enable no-console */
    } catch (_) { /* console may be unavailable */ }

    // A convenient programmatic handle for a headless driver.
    window.__WT_SELFTEST_RESULT__ = { line: line, passed: passed, total: total, ok: failed.length === 0, results: results };
  }

  // ------------------------------------------------------------------
  // Kick off AFTER the app has booted. app.js registers its DOMContentLoaded
  // boot listener before this file runs, so a setTimeout(0) scheduled from
  // (or after) DOMContentLoaded is guaranteed to run once boot() has already
  // executed synchronously.
  // ------------------------------------------------------------------
  function kick() {
    setTimeout(function () {
      runSuite().catch(function (e) {
        results.push({ name: "selftest-runner", ok: false, detail: e && e.message ? e.message : String(e) });
        report_result();
      });
    }, 0);
  }

  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", kick);
  } else {
    kick();
  }
})();
