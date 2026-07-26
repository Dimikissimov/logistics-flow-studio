/* =====================================================================
 * Logistics Flow Studio - WarehouseTwin
 * share.js - shareable layout links: the URL fragment IS the data.
 * ---------------------------------------------------------------------
 * Encodes a serialized layout (the exact JSON-export schema from
 * app.js serialize()) as JSON -> UTF-8 -> base64url, and decodes it
 * back. Deliberately NO custom compression: plain base64url keeps the
 * codec trivially auditable, and measured links stay in the low
 * thousands of characters for typical layouts (verify_share.js prints
 * the exact lengths for the starter and MRO-preset layouts).
 *
 * HONESTY: nothing is uploaded anywhere. A share link carries the whole
 * design inside its #layout=... fragment. Browsers never send the
 * fragment over the network at all - and this app makes zero runtime
 * network requests anyway. Opening the link rebuilds the layout locally
 * through the SAME validation as JSON import (app.js deserialize()).
 *
 * Classic script on the global WT namespace (works over file://). Also
 * loads in Node under the same window shim the other harnesses use, so
 * verify_share.js exercises the REAL codec, not a copy.
 * ===================================================================== */
(function () {
  "use strict";
  const WT = (window.WT = window.WT || {});

  const HASH_KEY = "layout";

  // Refuse absurd payloads before touching atob/JSON.parse - a URL
  // fragment this long is garbage or abuse, not a warehouse layout.
  const MAX_PAYLOAD_CHARS = 200000;

  function utf8ToBase64Url(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function base64UrlToUtf8(payload) {
    if (typeof payload !== "string" || payload.length === 0) throw new Error("empty payload");
    if (payload.length > MAX_PAYLOAD_CHARS) throw new Error("payload too large");
    if (!/^[A-Za-z0-9_-]+$/.test(payload)) throw new Error("not base64url");
    let b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // fatal:true -> invalid UTF-8 throws instead of yielding mojibake.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }

  /** Layout object (serialize() schema) -> #layout= payload string. */
  function encodeLayout(obj) {
    return utf8ToBase64Url(JSON.stringify(obj));
  }

  /** Payload string -> parsed layout object. Throws on malformed input.
   *  Structural sanitizing (element-type whitelist, bounds clamping,
   *  tier coercion) is deserialize()'s job in app.js - the SAME rules
   *  as JSON import; this only guarantees "valid JSON object". */
  function decodeLayout(payload) {
    let text;
    try {
      text = base64UrlToUtf8(payload);
    } catch (err) {
      // Keep our own short reasons; atob/TextDecoder messages are
      // browser-internal and verbose - map them to a concise cause.
      const own = ["empty payload", "payload too large", "not base64url"];
      throw new Error(own.indexOf(err.message) !== -1 ? err.message : "corrupted encoding");
    }
    let obj;
    try {
      obj = JSON.parse(text);
    } catch (_) {
      throw new Error("corrupted layout data");
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("not a layout object");
    return obj;
  }

  /** Extract the share payload from a location.hash string, or null. */
  function payloadFromHash(hash) {
    const m = /^#?layout=(.+)$/.exec(hash || "");
    return m ? m[1] : null;
  }

  WT.share = { HASH_KEY, encodeLayout, decodeLayout, payloadFromHash };
})();
