/* =====================================================================
 * Logistics Flow Studio - WarehouseTwin
 * errors.js - the GLOBAL ERROR BOUNDARY.
 * ---------------------------------------------------------------------
 * Loaded FIRST (in <head>, before every other script) so it is installed
 * before any application code runs. It:
 *   1. records every uncaught error + unhandled promise rejection into the
 *      global array `window.__WT_ERRORS__` (used by the in-browser self-test
 *      to assert a clean boot), and
 *   2. surfaces ONE honest, NON-BLOCKING banner - "Something went wrong -
 *      details in console." - instead of leaving a silently dead UI.
 *
 * It never SWALLOWS an error: the handlers do not return true and do not
 * preventDefault(), so the browser's own console reporting is left fully
 * intact - the boundary only *adds* a record + a visible hint.
 *
 * Tiny and dependency-free. Uses only window.onerror / window.onunhandled-
 * rejection and CSSOM styling (no inline <style>, no eval), so it is safe
 * under a strict Content-Security-Policy (script-src 'self').
 * ===================================================================== */
(function () {
  "use strict";

  // Idempotent: never re-install (double <script> include, HMR, etc.).
  if (window.__WT_ERRORS__) return;
  var errors = (window.__WT_ERRORS__ = []);
  var MAX = 100; // bound the buffer so a runaway error loop can't grow it forever
  var banner = null;

  function record(entry) {
    entry.ts = Date.now();
    if (errors.length < MAX) errors.push(entry);
    surface();
  }

  // A small fixed, dismissible bar. Built lazily (only once an error fires)
  // with CSSOM so it needs no stylesheet and works even if styles.css failed
  // to load. Wrapped in try/catch so the boundary can never itself throw.
  function surface() {
    try {
      if (!document.body) {
        // Too early - the DOM has no <body> yet; retry once it exists.
        window.addEventListener("DOMContentLoaded", surface, { once: true });
        return;
      }
      if (!banner) {
        banner = document.createElement("div");
        banner.id = "wt-error-banner";
        banner.setAttribute("role", "alert");
        banner.setAttribute("aria-live", "assertive");
        var s = banner.style;
        s.position = "fixed";
        s.left = "12px";
        s.right = "12px";
        s.bottom = "12px";
        s.margin = "0 auto";
        s.maxWidth = "560px";
        s.zIndex = "2147483647";
        s.padding = "10px 14px";
        s.borderRadius = "10px";
        s.background = "#7f1d1d";
        s.color = "#ffffff";
        s.font = "13px/1.45 system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
        s.boxShadow = "0 6px 24px rgba(0,0,0,.35)";
        s.display = "flex";
        s.alignItems = "center";
        s.gap = "10px";

        var msg = document.createElement("span");
        msg.className = "wt-error-banner-msg";
        msg.style.flex = "1";
        msg.textContent = "Something went wrong - details in console.";

        var close = document.createElement("button");
        close.type = "button";
        close.textContent = "Dismiss";
        close.setAttribute("aria-label", "Dismiss error notice");
        var cs = close.style;
        cs.background = "rgba(255,255,255,.18)";
        cs.color = "#ffffff";
        cs.border = "0";
        cs.borderRadius = "6px";
        cs.padding = "5px 10px";
        cs.cursor = "pointer";
        cs.font = "inherit";
        close.addEventListener("click", function () {
          if (banner) banner.hidden = true;
        });

        banner.appendChild(msg);
        banner.appendChild(close);
        document.body.appendChild(banner);
      }
      banner.hidden = false;
      var extra = errors.length > 1 ? " (" + errors.length + " errors)" : "";
      var m = banner.firstChild;
      if (m) m.textContent = "Something went wrong - details in console." + extra;
    } catch (_) {
      /* the error boundary must never itself throw */
    }
  }

  // Uncaught runtime errors. `message` is absent for cross-origin script
  // errors and for pure resource-load failures - we only record real script
  // errors so a missing optional asset stays quiet.
  window.onerror = function (message, source, lineno, colno, error) {
    if (message != null && String(message).length) {
      record({
        type: "error",
        message: String(message),
        source: source || "",
        lineno: lineno || 0,
        colno: colno || 0,
        stack: error && error.stack ? String(error.stack) : "",
      });
    }
    return false; // do NOT swallow - let the browser log it to the console too
  };

  // Unhandled promise rejections.
  window.onunhandledrejection = function (event) {
    var reason = event && "reason" in event ? event.reason : event;
    var message = reason && reason.message ? reason.message : reason;
    record({
      type: "unhandledrejection",
      message: String(message == null ? "unhandled rejection" : message),
      source: "",
      lineno: 0,
      colno: 0,
      stack: reason && reason.stack ? String(reason.stack) : "",
    });
    // do NOT preventDefault() - the console still reports the rejection
  };
})();
