"""Build deliverables/warehousetwin_onepager.pdf - a one-page executive summary.

Everything printed here is the repo's own pinned, reproducible measurement
record (docs/MEASUREMENTS.md, node test/run-all.mjs). No new claims are made:
numbers are teaching-scale, synthetic and seeded; the advisor is a heuristic;
standards alignment is guidance, not certification.

Usage:  python tools/make_onepager.py
Requires: matplotlib (pip install matplotlib). ASCII-only stdout.
"""

from __future__ import annotations

import os
import textwrap

import matplotlib

matplotlib.use("Agg")
import matplotlib.image as mpimg
import matplotlib.pyplot as plt
from matplotlib.backends.backend_pdf import PdfPages

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "deliverables")
OUT_PDF = os.path.join(OUT_DIR, "warehousetwin_onepager.pdf")

INK = "#1a2433"
MUTED = "#5a6678"
ACCENT = "#0f6a4e"
RULE = "#c8cfd9"

PAGE_W, PAGE_H = 8.27, 11.69  # A4 portrait, inches
MARGIN = 0.07  # in axes fraction


def wrap(text: str, width: int) -> str:
    return "\n".join(textwrap.wrap(text, width))


class Column:
    """A simple top-down text flow in figure coordinates."""

    def __init__(self, fig, x: float, y: float, width_chars: int):
        self.fig = fig
        self.x = x
        self.y = y
        self.width_chars = width_chars

    def add(self, text: str, size=8.5, weight="normal", color=INK, gap=0.010, leading=0.0138):
        wrapped = wrap(text, self.width_chars)
        n_lines = wrapped.count("\n") + 1
        self.fig.text(self.x, self.y, wrapped, ha="left", va="top", fontsize=size,
                      fontweight=weight, color=color, linespacing=1.35)
        self.y -= n_lines * leading * (size / 8.5) + gap

    def heading(self, text: str):
        self.add(text.upper(), size=8.0, weight="bold", color=ACCENT, gap=0.004)

    def bullet(self, text: str, gap=0.006):
        self.add("-  " + text, size=8.2, gap=gap)

    def space(self, dy: float):
        self.y -= dy


def build_page(fig) -> None:
    # ----- header --------------------------------------------------------
    fig.text(MARGIN, 0.965, "Logistics Flow Studio", fontsize=19, fontweight="bold", color=INK)
    fig.text(MARGIN, 0.945, "WarehouseTwin + LSP Planner  |  offline warehouse and network "
             "planning twins, in the browser", fontsize=9.5, color=MUTED)
    fig.text(1 - MARGIN, 0.965, "one-pager", ha="right", fontsize=8, color=MUTED)
    fig.lines.append(plt.Line2D([MARGIN, 1 - MARGIN], [0.936, 0.936], transform=fig.transFigure,
                                color=RULE, linewidth=0.8))

    # ----- screenshots ---------------------------------------------------
    shots = [
        (os.path.join(ROOT, "docs", "img", "warehousetwin.png"),
         "WarehouseTwin - floor plan, seeded simulation, KPIs"),
        (os.path.join(ROOT, "docs", "img", "lsp-planner.png"),
         "LSP Planner - network map, five scored levels"),
    ]
    x0 = MARGIN
    for path, caption in shots:
        ax = fig.add_axes([x0, 0.745, 0.425, 0.175])
        ax.axis("off")
        if os.path.exists(path):
            ax.imshow(mpimg.imread(path))
            print("embedded screenshot: " + os.path.relpath(path, ROOT).replace("\\", "/"))
        else:
            ax.text(0.5, 0.5, "screenshot not found", ha="center", va="center", fontsize=8)
        fig.text(x0, 0.738, caption, fontsize=7.2, color=MUTED)
        x0 += 0.425 + 0.02

    # ----- left column: what it is --------------------------------------
    left = Column(fig, MARGIN, 0.715, 52)
    left.heading("What this is")
    left.add("Two small, honest planning games in one repo - a single-page PWA with no "
             "build step, no framework, no server and zero runtime network calls. It "
             "installs from the browser and runs fully offline.")
    left.bullet("WarehouseTwin: draw a warehouse floor (12 storage systems, docks, staging, "
                "conveyors), pick slotting and picking strategies, and run a seeded, "
                "deterministic simulation with live KPIs, a one-click golden-zone layout "
                "optimizer, a pick-travel heatmap and an A/B comparator.")
    left.bullet("LSP Planner: place factories, DCs, cross-docks and customer zones; draw FTL "
                "or parcel/LTL lanes; toggle push/pull per DC. A pure evaluation engine "
                "scores weekly cost, service, a CO2 estimate and five levels, each built "
                "around one network-design lesson.")
    left.space(0.006)
    left.heading("Heuristic advisor - labelled as such")
    left.add("Both apps include an advisor: a transparent rule engine informed by "
             "operations-research practice, NOT a trained or black-box model. Every "
             "suggestion names its finding, its principle, and an impact measured with the "
             "same deterministic simulation.")
    left.space(0.006)
    left.heading("Standards: aligned-to, not certified")
    left.add("Aisle checks are informed by DIN 15185, pallets follow EPAL/EN references, and "
             "a reference panel covers ASR A1.8, EN 15512, VDI 2510/3564 and others - as "
             "design guidance only. The apps perform no compliance certification of any "
             "kind.")
    left.space(0.006)
    left.heading("Use cases")
    left.bullet("Training: learn slotting, flow design and network economics by playing.")
    left.bullet("Pre-study before a WMS or consulting engagement: show which levers matter "
                "before commissioning real data work.")
    left.bullet("Candidate skill demonstration: domain depth plus engineering discipline "
                "(pinned measurements, verification harnesses, CI).")

    # ----- right column: measured numbers --------------------------------
    right = Column(fig, 0.535, 0.715, 50)
    right.heading("Measured results (synthetic, seeded, teaching-scale)")
    right.add("Starter demo layout, seed 42, 200 orders, 80 SKUs. Pinned in "
              "docs/MEASUREMENTS.md; reproduced headlessly by node test/run-all.mjs.",
              size=7.6, color=MUTED)
    right.bullet("ABC 80/20 vs random slotting: 46.71 -> 36.70 m/order pick travel "
                 "(about -21%).")
    right.bullet("One-click layout optimizer: 36.70 -> 18.85 m/order (-48.6%), 5 elements "
                 "moved, every aisle still valid.")
    right.bullet("Heatmap conservation: per-cell walked metres sum exactly to the travel "
                 "KPI for all five picking strategies.")
    right.space(0.004)
    right.add("LSP Planner reference networks (node lsp/verify.js proves each lesson on "
              "every run):", size=7.6, color=MUTED)
    right.bullet("Pull beats push under volatile demand: service 95.0% vs 87.1%, holding "
                 "919 vs 1,452 EUR/wk.")
    right.bullet("A cross-dock pays off on thin flows: 14,755 vs 16,496 EUR/wk (-10.6%), "
                 "CO2 estimate 3,804 vs 5,367 kg/wk.")
    right.bullet("Risk pooling vs proximity: a single central DC tops out at 88.4% service "
                 "and fails the level; adding a regional DC reaches 92.6%.")
    right.space(0.006)
    right.heading("Engineering discipline")
    right.bullet("Deterministic by construction: same seed, same numbers, byte-identical.")
    right.bullet("Verification harnesses run in CI: optimizer measurement, heatmap "
                 "conservation invariant, LSP engine gates, offline guard.")
    right.bullet("100% offline: CI greps every app file for external assets and fails on "
                 "any hit.")
    right.space(0.006)
    right.heading("Deliverables")
    right.bullet("The installable offline PWA itself (WarehouseTwin at /, LSP Planner at "
                 "/lsp/).")
    right.bullet("This one-pager (rebuilt by python tools/make_onepager.py).")
    right.bullet("docs/BUSINESS_CASE.md, docs/MEASUREMENTS.md and docs/DOMAIN_NOTES.md - "
                 "the claims, the numbers, and every model simplification in writing.")

    # ----- footer --------------------------------------------------------
    fig.lines.append(plt.Line2D([MARGIN, 1 - MARGIN], [0.062, 0.062], transform=fig.transFigure,
                                color=RULE, linewidth=0.8))
    fig.text(MARGIN, 0.050, wrap(
        "Honesty note: all data is synthetic and seeded - no real inventory, orders or "
        "telemetry. Figures demonstrate the direction and rough magnitude of well-known "
        "levers at teaching scale; they are not forecasts for any real operation. "
        "(c) 2026 Dimitres Kisimov - published for portfolio review.", 150),
        fontsize=7.0, color=MUTED, va="top", linespacing=1.4)


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    with PdfPages(OUT_PDF) as pdf:
        fig = plt.figure(figsize=(PAGE_W, PAGE_H))
        build_page(fig)
        pdf.savefig(fig)
        plt.close(fig)
        meta = pdf.infodict()
        meta["Title"] = "Logistics Flow Studio - WarehouseTwin + LSP Planner (one-pager)"
        meta["Author"] = "Dimitres Kisimov"
        meta["Subject"] = "Offline warehouse and network planning twins - measured, honest"
    size = os.path.getsize(OUT_PDF)
    print("wrote " + os.path.relpath(OUT_PDF, ROOT).replace("\\", "/") +
          " (" + str(size) + " bytes)")
    if size <= 10240:
        raise SystemExit("PDF is suspiciously small (<= 10 KB)")


if __name__ == "__main__":
    main()
