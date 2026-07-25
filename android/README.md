# android/ — TWA (Trusted Web Activity) packaging scaffold

This folder contains the **configuration scaffold** for wrapping the WarehouseTwin
PWA into an Android app with [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap)
(open source, by the Google Chrome team). It contains **no built artifacts** —
no APK/AAB is checked in and none is fabricated. Building, signing and
submitting are steps **you** (the app owner) run on your own machine and
accounts; the full walkthrough is in [`../PUBLISH_ANDROID.md`](../PUBLISH_ANDROID.md).

## What is in here

### `twa-manifest.json`

A complete Bubblewrap project config, pre-filled with WarehouseTwin's values so
`bubblewrap init` / `bubblewrap build` have almost nothing left to ask:

| Field | Value | Notes |
| --- | --- | --- |
| `packageId` | `de.kisimov.warehousetwin` | **Placeholder — change freely.** Android package ids are conventionally a reversed domain you control. It must stay the same for every update of the app once published. |
| `host` | `REPLACE-WITH-YOUR-PWA-HOST.example.com` | The HTTPS origin where the PWA is hosted (e.g. `YOUR-GITHUB-USER.github.io` for GitHub Pages). Replace everywhere it appears (also inside `iconUrl`, `maskableIconUrl`, `webManifestUrl`, `fullScopeUrl`). |
| `startUrl` | `/logistics-flow-studio/index.html` | Matches `start_url: "./index.html"` from `../manifest.webmanifest`, resolved against a GitHub-Pages-style project path. Adjust the path segment if you host at a different path (use `/index.html` for a root deployment). |
| `fullScopeUrl` | `https://<host>/logistics-flow-studio/` | Matches `scope: "./"` from the web manifest. |
| `themeColor` / `backgroundColor` / navigation colors | `#0f172a` | Same values as `theme_color` / `background_color` in `../manifest.webmanifest`. |
| `name` / `launcherName` | `WarehouseTwin` | Same as the web manifest's `short_name`. |
| `iconUrl` / `maskableIconUrl` | the repo's own `icons/icon-512.png` / `icons/maskable-512.png` | Original icons already in this repo — nothing third-party. |
| `signingKey.path` / `signingKey.alias` | `./android.keystore` / `warehousetwin` | **Placeholders.** `bubblewrap build` offers to generate the keystore on first run. The keystore file itself must NEVER be committed. |
| `appVersionName` / `appVersionCode` | `1.0.0` / `1` | Bump `appVersionCode` (integer, always increasing) for every Play upload. |
| `enableNotifications` | `false` | WarehouseTwin sends nothing — honest default. |
| `fallbackType` | `customtabs` | On devices without a TWA-capable browser the app opens in a Custom Tab instead. |
| `fingerprints` | `[]` | Filled after you create your signing key (see the assetlinks section below). |

### `assetlinks-template.json`

A **Digital Asset Links** template. The TWA must prove it owns the web content,
otherwise Android shows a browser address bar on top of the app. To pass that
check, this file — with the real SHA-256 fingerprint of **your** signing key —
must be hosted at exactly:

```
https://<your-PWA-origin>/.well-known/assetlinks.json
```

on the **same origin that serves the PWA** (for GitHub Pages: put it in a
`.well-known/assetlinks.json` file in the deployed site root). Two placeholders
to replace:

- `package_name` — keep in sync with `packageId` in `twa-manifest.json`.
- `sha256_cert_fingerprints` — the SHA-256 of your signing certificate. Get it with:
  ```bash
  keytool -list -v -keystore android.keystore -alias warehousetwin
  ```
  (or from Play Console → Setup → App signing, if you let Play re-sign the app —
  in that case use **Play's** certificate fingerprint, not your upload key's.)

## Tooling on this machine (checked 2026-07-25)

`node --version` → **v24.14.1**, `npx --version` → **11.11.0** — both present,
so the Bubblewrap CLI can run here. The exact commands (run them from the repo
root once the PWA is hosted at an HTTPS URL):

```bash
npm i -g @bubblewrap/cli

# Initialise the Android project from the LIVE manifest URL.
# Interactive: it asks to download a JDK + Android SDK on first run and
# confirms each value (this scaffold pre-answers most of them).
bubblewrap init --manifest https://<your-host>/logistics-flow-studio/manifest.webmanifest

# Build the signed Android App Bundle (.aab) + a test APK.
bubblewrap build
```

`bubblewrap init` was **deliberately not run** as part of this scaffold: it is
an interactive wizard that downloads a JDK/Android SDK and generates a signing
key — the signing identity must be created and owned by you, not by an
automated pass. Nothing in this folder is a substitute for that step.

## What remains yours (cannot be automated honestly)

- Hosting the PWA on an HTTPS origin you control.
- Creating the signing keystore and **backing it up**.
- The Google Play developer account (one-time $25 fee, identity verification).
- Uploading the AAB, store listing, and pressing "submit for review".

All of these are marked step-by-step in [`../PUBLISH_ANDROID.md`](../PUBLISH_ANDROID.md).
