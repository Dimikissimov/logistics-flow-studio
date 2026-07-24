# Credits & asset provenance

WarehouseTwin ships **only original or permissively-licensed open assets**. There are no third-party trademarks, company logos, copyrighted images, web fonts, or 3D models anywhere in this repository, and no company's intellectual property is used.

## Code

- All application code (`index.html`, `styles.css`, `app.js`, `domain.js`, `simulation.js`, `sw.js`) is **original**, written for this project, and licensed under **MIT** (see `LICENSE`).
- The seeded PRNG in `simulation.js` is **mulberry32**, a widely published public-domain one-liner (no attribution required); implemented here from scratch.

## Icons & graphics

- The app mark (`icons/icon.svg`) and all raster icons (`icons/icon-192.png`, `icons/icon-512.png`, `icons/maskable-512.png`, `icons/favicon-32.png`) are **original geometry I drew** — a 2×2 grid of storage units with a flow arrow. No third-party icon set is used.
- The PNGs are generated from original primitives by `generate_icons.py` using **Pillow**.
- All other UI icons/graphics are **inline SVG drawn by hand** in the HTML/CSS/canvas. No icon fonts, no icon libraries.

## Fonts

- **System font stack only** (`system-ui`, Segoe UI, Roboto, etc.). No web fonts are downloaded or bundled — nothing to attribute, nothing to license.

## Tooling (build-time only, not shipped in the app)

- **Python** and **Pillow** — used by `generate_icons.py` to rasterise the icons. Pillow is under the MIT-CMU / HPND-style licence. Not shipped or linked at runtime.
- **Ruff** — Python linter used in development only.

## Data

- **All data is synthetic and seeded.** No real inventory, orders, telemetry, or personal data. Pallet dimensions and the aisle rule are drawn from public standards/references (EPAL/UIC pallet sizes; DIN 15185 aisle guidance) and are cited in `docs/DOMAIN_NOTES.md`. Referencing a public standard's numbers is not a use of anyone's proprietary assets, and WarehouseTwin makes no certification claim.

## Runtime dependencies

- **None.** No CDN, no external scripts/styles/fonts, no network calls at runtime. The app is fully self-contained and works offline.
