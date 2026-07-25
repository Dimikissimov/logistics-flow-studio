# Publishing WarehouseTwin to Android — the complete honest path

**Status (P4): the app is done and installable today as a PWA. The Play-Store
wrap is scaffolded in [`android/`](android/) — config and guide only.** No AAB
is checked in and none was built by an automated pass, because building one
requires a signing identity and accounts that belong to **you**, the app owner.
Every step below that is inherently yours is marked **[YOU]**.

---

## A. Today: install as a PWA (zero cost, works offline)

No store, no account, no fee — this works right now:

1. Serve the repo folder over HTTP(S). Locally: `python -m http.server 8000`,
   or host it anywhere static (GitHub Pages, see below).
2. Open the URL in **Chrome on Android**.
3. Tap the **Install app** button in the app header, or Chrome menu →
   **Install app** (older Chrome: *Add to Home screen*).

You get a standalone app with its own icon and splash screen that runs fully
offline (the service worker precaches everything, and the app makes zero
runtime network calls). For a showcase or personal use this is the whole story.

---

## B. The Google Play Store path (TWA wrap)

Play Store apps must be Android packages, so the PWA is wrapped in a
**Trusted Web Activity (TWA)** — a thin Android shell that shows the PWA
full-screen. The standard tool is **Bubblewrap** (open source, Google Chrome
team). The [`android/`](android/) folder pre-fills its configuration.

### B.1 Host the PWA on an HTTPS origin — [YOU]

The TWA points at a live URL, so the PWA must be hosted first. **GitHub Pages
works** and is free:

- Repo → Settings → Pages → deploy from the main branch (root).
- The site then appears at `https://<your-github-username>.github.io/logistics-flow-studio/`
  — that URL is the value to substitute for the host placeholder in
  `android/twa-manifest.json`. (This repo's Pages URL is not written here
  because Pages has not been enabled yet; note it once you enable it.)

Any other static HTTPS host works identically.

### B.2 Install the build tools — [YOU, one-time]

- **Node.js LTS** — already on this machine (checked 2026-07-25:
  node v24.14.1, npx 11.11.0).
- **JDK 17** — Bubblewrap offers to download one on first run, or install
  Temurin/OpenJDK 17 yourself.
- **Android SDK build tools** — Bubblewrap offers to fetch these too; a full
  Android Studio install is not required.
- Bubblewrap CLI:
  ```bash
  npm i -g @bubblewrap/cli
  ```

### B.3 Initialise the Android project

```bash
bubblewrap init --manifest https://<your-host>/logistics-flow-studio/manifest.webmanifest
```

This reads the live web manifest and asks a short series of questions —
`android/twa-manifest.json` in this repo pre-answers them (package id
`de.kisimov.warehousetwin` is a **placeholder; change it** to a reversed
domain you control, then keep it forever — Play identifies the app by it).

### B.4 Build the signed AAB — [YOU: the signing key is your identity]

```bash
bubblewrap build
```

- On first run it offers to **generate a signing keystore** (path/alias
  placeholders are in `android/twa-manifest.json`). Answer the prompts; pick
  real passwords.
- **BACK UP THE KEYSTORE AND ITS PASSWORDS.** Every future update of the app
  must be signed with the same key. A lost keystore means you can never
  update the app again (Play App Signing softens this — enroll in it during
  the first upload — but the upload key is still yours to keep safe).
- **Never commit the keystore** to the repo.
- Output: `app-release-bundle.aab` (the Play upload artifact) and a test APK
  you can sideload to check the wrap.

No AAB is included in this repo — it can only honestly come from this step.

### B.5 Host the Digital Asset Links file — [YOU]

Without this, the app shows a browser address bar on top. Take
[`android/assetlinks-template.json`](android/assetlinks-template.json), insert
the SHA-256 fingerprint of your signing certificate
(`keytool -list -v -keystore android.keystore -alias warehousetwin`, or the
certificate shown in Play Console → App signing if Play re-signs), and host it
at exactly:

```
https://<your-PWA-origin>/.well-known/assetlinks.json
```

on the same origin that serves the PWA.

### B.6 Google Play developer account — [YOU: account, payment, identity]

- Register at the Play Console: **one-time US$25 fee**, and Google runs an
  **identity verification** (ID document, address; for personal accounts the
  developer address is shown publicly on listings).
- This account — and everything submitted from it — is yours; no part of it
  can or should be automated.

### B.7 Create the app and submit — [YOU: the final submit is yours]

1. Play Console → **Create app** → name "WarehouseTwin", app type App, free.
2. **Upload the AAB** (internal testing track first is good practice).
3. **Store listing**: description in your words; screenshots you take of the
   running app — **original screenshots only**, and if a screenshot shows the
   MRO preset, keep its "illustrative, not affiliated" framing. No third-party
   logos or brand names in listing assets.
4. **Data safety form**: WarehouseTwin collects nothing, stores everything
   locally, makes zero network calls — declare exactly that. You still need a
   privacy-policy URL (a one-paragraph "this app collects no data" page you
   host is fine and true).
5. Content rating questionnaire, target audience, then **submit for review**.
   Review typically takes a few days; policy outcomes are between you and
   Google.

### Honesty reminders for the listing

- All data in the app is synthetic and seeded — say so; don't imply it plans
  real warehouses.
- The standards features are "informed by / aligned to" DIN/VDI/EN references —
  never claim certification or compliance checking.
- All assets are original (see `CREDITS.md`); keep the listing the same way.

---

## C. Demo vs full tier — how the gate works and what a real one would do

The app ships with a **demo/full tier switch** (`tiers.js` + the
"Unlock full version" button in the header). Honestly stated:

- **What it is:** a client-side showcase gate. The demo tier limits the
  palette to the starter six elements, slotting to Random + ABC, locks the
  MRO preset, and caps the advisor at 2 suggestions. Locked items stay
  visible with an original padlock glyph — nothing is hidden. "Unlock full
  version" flips a `localStorage` flag; the whole app is delivered to the
  client either way.
- **What it is NOT:** DRM, security, or copy protection. Anyone can flip the
  flag in DevTools. That is fine — its purpose is to demonstrate cleanly
  engineered tier gating (one capability-flag module, no scattered ifs).
- **What a real deployment would replace it with:** the body of
  `tiers.setTier()` / `tiers.current()` would call a real entitlement check —
  for a Play app, typically **Play Billing**: the app requests a purchase,
  receives a purchase token, and a small backend verifies that token against
  the **Google Play Developer API** before granting the "full" entitlement
  (or a signed license key validated server-side for direct sales). The rest
  of the app would not change at all: it already reads capability flags from
  one place, which is the point of the exercise.

---

*Everything in sections B.1–B.7 runs on your machine and your accounts; this
repo only prepares the configuration and documents the path.*
