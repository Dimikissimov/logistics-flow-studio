# QA / production release checklist — WarehouseTwin

A real, honest checklist a maintainer runs **before shipping a release**. It is
a **maintainer aid**, not a certification and not an automated gate — some
items are one-liners you run, others are eyes-on confirmations in a real
browser. Pair it with [`PRODUCTION.md`](PRODUCTION.md) (how the self-test,
error boundary and CSP work) and the Node harness suite.

Convention below: `[ ]` to tick, **command** lines are copy-pasteable.

---

## 0. Prerequisites

- [ ] Clean working tree on the release commit (`git status` empty).
- [ ] Node available for the harnesses (no other runtime deps — nothing to
      install; the app itself has **zero** build step and **zero** deps).

## 1. Automated harnesses (pure logic + wiring)

- [ ] **All Node harnesses green:**
      **`node test/run-all.mjs`** → ends with `ALL 29 HARNESSES PASSED`.
- [ ] **Offline guard clean** (no external asset references anywhere): it is
      the last harness in the run above (`tools/offline-guard.mjs`).
- [ ] **Syntax clean** on any changed script: **`node --check <file>.js`**.
- [ ] **Determinism intact** — the logic/sim harnesses (heatmap, flowsim,
      orderpool, storage, report, compare, …) still pass byte-for-byte. A
      rendering/a11y change must never move a simulation number.

## 2. In-browser self-test (real DOM, real handlers)

- [ ] Serve over http(s)/localhost (not `file://`):
      **`python -m http.server 8971 --bind 127.0.0.1`**
- [ ] **Self-test passes** — open `http://127.0.0.1:8971/index.html?selftest=1`
      and read the `#wt-selftest` line / console: expect **`WT-SELFTEST: PASS n/n`**
      (currently `45/45`).
- [ ] **Headless one-liner** (exit criterion = the scraped PASS line):
      ```
      msedge --headless=new --disable-gpu --virtual-time-budget=12000 --dump-dom \
        "http://127.0.0.1:8971/index.html?selftest=1" | grep -o 'WT-SELFTEST:[^<]*'
      ```
      (`chrome` is identical — same engine.)
- [ ] **No console errors/warnings** on a normal load (`?selftest=1` removed):
      the error boundary keeps `window.__WT_ERRORS__` empty on a clean boot.

## 3. Offline & PWA

- [ ] **Works fully offline** — load once, then go offline (DevTools →
      Network → Offline, or airplane mode) and reload: the app still boots and
      is usable (service worker serves the precached shell).
- [ ] **Installs as a PWA** — the install affordance appears (or via the
      browser menu); installed, it launches standalone and offline.
- [ ] **Service-worker cache bumped** — `sw.js` `CACHE_VERSION` is incremented
      for this release (e.g. `wt-v34 → wt-v35`) so clients pick up new assets,
      and every shipped file is listed in `APP_SHELL`.
- [ ] **No network calls at runtime** — DevTools → Network shows only
      same-origin requests served from the cache; nothing leaves the device.

## 4. Security hardening

- [ ] **CSP present** — the strict offline `Content-Security-Policy` `<meta>`
      is in `index.html` (no `unsafe-eval`, no `unsafe-inline` in `script-src`).
      Confirm no CSP violations in the console.
- [ ] **Error boundary works** — `errors.js` loads first; a forced throw is
      recorded into `window.__WT_ERRORS__` and shows the one honest banner
      (it does **not** swallow — the console still reports it).

## 5. Accessibility (real, but **not** a WCAG certification)

- [ ] **Landmarks** — main regions carry `aria-label`s (building tools / floor
      / simulation).
- [ ] **Canvas has a text alternative** — `#floor` has an `aria-label` and an
      `aria-describedby` offscreen summary that updates with the layout
      (element count / floor size / view mode / sim status).
- [ ] **Toolbar controls named** — zoom −/+, Fit, 100%, Pan, 2.5D, Guided
      demo, Play/Pause all expose an accessible name.
- [ ] **Keyboard** — Tab reaches the primary controls; Enter/Space activate
      them (including the custom card-header toggles); a visible
      `:focus-visible` outline is shown; Escape/Delete/arrows behave in the
      editor.
- [ ] **Reduced motion honoured** — with OS "reduce motion" on, the
      material-flow animation does **not** auto-run (static/stepped frame) and
      the app stays fully usable.

## 6. Performance (bounded effort, **not** a guarantee for arbitrary size)

- [ ] **Large-layout sanity** — build a large floor (e.g. 120×80) with many
      elements, play the flow, and confirm it stays responsive: the render
      culls off-screen elements (`WT.view.cullToView`) and the shapes LOD icon
      kicks in when zoomed out. No per-frame allocation growth / leak over a
      minute of playback.

## 7. Data & honesty

- [ ] **Data stays on-device** — imported CSVs / layouts / scenarios live in
      `localStorage` and are never uploaded; share links carry the layout in
      the URL fragment only.
- [ ] **Honesty labels present** — SYNTHETIC-unless-imported, "not a
      certification", "illustrative / not a BIM/CAD model", "not a real DES
      engine / not a measurement" appear where relevant (About panel, reports,
      overlays).

## 8. Licensing

- [ ] **Proprietary license intact** — `LICENSE` is the "all rights reserved,
      review-only" text (Copyright Dimitres Kisimov). **No MIT / permissive
      license anywhere**, and no stray MIT headers in touched files.

---

### Sign-off

- [ ] Version bumped in `README.md` + `CHANGELOG.md`.
- [ ] All boxes above ticked (or the exceptions explicitly noted in the
      release notes).

*This checklist is a maintainer aid. It reflects best-practice hardening for
an offline app; it is not a security, accessibility, or performance
certification.*
