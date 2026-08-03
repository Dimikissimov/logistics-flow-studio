# Production hardening — running the in-browser self-test

WarehouseTwin's 28 Node harnesses (`node test/run-all.mjs`) cover the **pure
logic**. The **DOM/UI** is covered by a **real in-browser end-to-end self-test**
that drives the live app through the same handlers the UI uses. This document
describes how to run it, and the two other hardening pieces shipped alongside it
(the global error boundary and the Content-Security-Policy).

Everything here is **best-practice hardening for an offline app, not a security
certification**. The self-test verifies **wiring and a no-uncaught-error boot**,
not visual/pixel correctness — that is what the human eye and the pure-draw
harnesses cover.

---

## 1. Run the self-test

The self-test is **inert** unless the URL carries `?selftest=1`; a normal load
never runs it.

Serve the app over `http(s)`/localhost (the normal PWA deployment — the strict
CSP resolves `'self'` correctly there and the service worker can register), then
open the app with the flag:

```
index.html?selftest=1
```

### Locally

```
# from the repo root
python -m http.server 8971 --bind 127.0.0.1
# then open:  http://127.0.0.1:8971/index.html?selftest=1
```

### Read the result

After the app boots, the suite runs ~40 checks against the live app and writes a
single **machine-readable** line into the `#wt-selftest` element (and
`console.log`s it, with per-check detail). Two exact formats:

```
WT-SELFTEST: PASS 40/40
WT-SELFTEST: FAIL 38/40 :: iso-toggle-layout-unchanged, report-build-sections
```

The `#wt-selftest` element also carries `data-pass`, `data-total` and
`data-ok` ("1"/"0") attributes, and the full structured result is available as
`window.__WT_SELFTEST_RESULT__` for a programmatic driver.

### Headless (e.g. headless Edge / Chrome)

```
python -m http.server 8971 --bind 127.0.0.1 &
msedge --headless=new --disable-gpu --virtual-time-budget=12000 --dump-dom \
  "http://127.0.0.1:8971/index.html?selftest=1" | grep -o 'WT-SELFTEST:[^<]*'
```

(`chrome` works identically — same engine.) Exit criterion: the scraped line is
`WT-SELFTEST: PASS 40/40`.

### What it checks

- Every expected `WT.*` module global is present and of the right shape
  (`domain, view, compliance, advisor, generate, examples, wms, flowsim,
  kpicharts, wmsdata, storage, kb, automation, report, compare, scenarios,
  orderpool, iso, shapes, cards, demo, tiers`).
- `window.__WT_ERRORS__` is empty after boot (a clean, error-free load).
- The key panels/cards and their buttons exist in the DOM.
- The `#floor` canvas exists and has a non-zero drawing buffer.
- Loading a real example places elements on state and redraws without error.
- Running WMS ops populates its panel.
- The flow steps (advancing the flowsim tick) and plays then stops, no error.
- Toggling 2.5D view then back is a **pure no-op** on the layout.
- Building the report returns the expected sections and round-trips to JSON.
- Opening the About and knowledge-base panels does not throw.
- The zoom controls run.
- After driving the app, `window.__WT_ERRORS__` is **still** empty.

The suite drives these through the **same functions the UI uses** (exposed as
`window.__WT_TEST_API__` **only** under `?selftest=1`), so it exercises the real
handlers, not a parallel copy. Each check is isolated in `try/catch` (a thrown
check is one FAIL, never a dead page), and the suite restores the app to a
normal, usable state at the end.

---

## 2. Global error boundary (`errors.js`)

Loaded **first**, before any other script, so it is installed before app code
runs. It:

- records every uncaught error + unhandled promise rejection into
  `window.__WT_ERRORS__`, and
- surfaces **one honest, non-blocking banner** — *"Something went wrong —
  details in console."* — instead of leaving a silently dead UI.

It never **swallows** an error: `window.onerror` returns `false` and the
rejection handler does not `preventDefault()`, so the browser's own console
reporting stays intact. It is tiny, dependency-free, and built with CSSOM (no
inline `<style>`, no `eval`) so it is safe under the strict CSP.

---

## 3. Content-Security-Policy

`index.html` ships a strict CSP `<meta>` appropriate for a **fully offline** app:

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self';
connect-src 'self';
worker-src 'self';
manifest-src 'self';
object-src 'none';
base-uri 'self';
form-action 'none';
frame-src 'none'
```

Notes:

- **No external hosts, no `unsafe-eval`, no inline scripts.** Every script is a
  local `'self'` file. A static scan (in `verify_hardening.js`) confirms there is
  no `eval(` / `new Function(` in any app script and no inline `on*=` handler in
  `index.html`, so the policy breaks nothing.
- **Inline `style` is allowed** (`'unsafe-inline'` on `style-src` only) because
  the UI uses a handful of `style=""` attributes and JS-driven element styles.
  Scripts are **not** granted `'unsafe-inline'`.
- `img-src` includes `data:` and `blob:` for the underlay image (loaded via
  `FileReader` as a data URL) and blob-backed previews.
- The service worker and web manifest are same-origin (`worker-src`/
  `manifest-src 'self'`).
- **Serve over `http(s)`/localhost.** `'self'` and the service worker both
  assume a real origin; a bare `file://` open is not the intended deployment.

This is best-practice hardening for an offline app, **not** a security
certification.
