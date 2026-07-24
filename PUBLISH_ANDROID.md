# Publishing to Android — the honest path

**Status: Pass 1 installs as a PWA today. The Google Play package is a Pass 4 (P4) task.** This file is the plan, not a finished pipeline. The steps below are actions **you** (the developer/owner) run on your own machine and accounts.

## Today (works now, no store needed)

WarehouseTwin is already an installable PWA:

1. Host the folder over HTTPS (any static host), or serve locally with `python -m http.server`.
2. Open it in Chrome on Android.
3. Tap **Install app** (header button) or browser menu → **Install app / Add to Home screen**.

You get a standalone, offline app with its own icon. No store account, no fee. For many uses this is enough.

## Pass 4: getting it into the Google Play Store (TWA)

Play Store apps must be Android packages, so the PWA gets wrapped in a **Trusted Web Activity (TWA)** — a thin Android shell that renders the PWA full-screen. The standard tool is **Bubblewrap** (by the Google Chrome team, open source).

### Prerequisites you install

- **Node.js** (for the Bubblewrap CLI).
- **JDK** (Java Development Kit, 17+).
- **Android SDK / command-line tools** (Bubblewrap can fetch these).
- A **Google Play Developer account** — a **one-time US$25** registration fee.
- The PWA hosted at a stable **HTTPS** URL (the TWA points at it).

### Outline of the steps

```bash
# 1. Install Bubblewrap
npm install -g @bubblewrap/cli

# 2. Initialise from the live manifest
bubblewrap init --manifest https://YOUR-HOST/manifest.webmanifest

#    You'll be asked for: app name, package id (e.g. dev.dimikissimov.warehousetwin),
#    icon, colors — most are read from the manifest.

# 3. Build a signed Android App Bundle (.aab)
bubblewrap build
#    First run creates a signing keystore — BACK IT UP; you need the same
#    key for every future update.
```

### Digital Asset Links (removes the browser address bar)

The TWA must prove it owns the web content. Bubblewrap prints an `assetlinks.json`; publish it at:

```
https://YOUR-HOST/.well-known/assetlinks.json
```

with the SHA-256 fingerprint of your signing key. Without it, the app shows a URL bar.

### Submit

1. In the **Google Play Console**, create the app, upload the signed **.aab**.
2. Fill in listing (title, description, screenshots), content rating, data-safety form (WarehouseTwin collects nothing and makes no network calls — declare that honestly), and a privacy policy.
3. Roll out to internal testing first, then production.

### Honesty reminders for the listing

- All data is synthetic/seeded; the app makes no network calls and collects no personal data — say exactly that in the data-safety section.
- Don't claim certification or compliance. The standards features are "informed by / aligned to" references, not certified.
- Ship only original/open assets (this repo already does — see `CREDITS.md`).

That's the whole path. Pass 4 will script and verify it; Pass 1 just makes sure the PWA it wraps is clean, offline, and installable.
