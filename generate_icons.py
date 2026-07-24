"""Generate the PWA raster icons for WarehouseTwin from original geometry.

Everything drawn here is hand-composed primitives (rounded rectangles +
a flow arrow) - no third-party images, fonts, logos or trademarks. The
design mirrors icons/icon.svg: a 2x2 grid of storage units with one
highlighted unit and a flow arrow.

Run:  python generate_icons.py
Outputs: icons/icon-192.png, icons/icon-512.png, icons/maskable-512.png,
         icons/favicon-32.png
"""

import sys

# Windows console safety.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # pragma: no cover - older interpreters
    pass

from PIL import Image, ImageDraw

BG = (15, 23, 42, 255)  # slate-900
BOX = (56, 189, 248, 255)  # sky-400
BOX_HI = (45, 212, 191, 255)  # teal-400
ARROW = (248, 250, 252, 218)  # near-white, slightly transparent


def draw_arrow(d: "ImageDraw.ImageDraw", size: int) -> None:
    """A gentle flow arc with an arrowhead, scaled to the icon size."""
    s = size / 512.0
    width = max(2, int(16 * s))
    d.line(
        [(150 * s, 338 * s), (210 * s, 312 * s), (300 * s, 312 * s), (356 * s, 340 * s)],
        fill=ARROW,
        width=width,
        joint="curve",
    )
    # arrowhead
    d.line([(356 * s, 340 * s), (326 * s, 334 * s)], fill=ARROW, width=width)
    d.line([(356 * s, 340 * s), (348 * s, 310 * s)], fill=ARROW, width=width)


def make(size: int, maskable: bool) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    corner = 0 if maskable else int(size * 0.18)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=corner, fill=BG)

    # 2x2 grid within the maskable-safe zone (inner ~60%).
    margin = size * (0.24 if maskable else 0.20)
    inner = size - 2 * margin
    gap = inner * 0.10
    cell = (inner - gap) / 2
    rad = max(2, int(cell * 0.18))
    x0, y0 = margin, margin
    coords = [
        (x0, y0),
        (x0 + cell + gap, y0),
        (x0, y0 + cell + gap),
        (x0 + cell + gap, y0 + cell + gap),
    ]
    for i, (cx, cy) in enumerate(coords):
        col = BOX_HI if i == 1 else BOX
        d.rounded_rectangle([cx, cy, cx + cell, cy + cell], radius=rad, fill=col)

    if not maskable:
        draw_arrow(d, size)
    return img


def main() -> None:
    outputs = [
        ("icons/icon-192.png", 192, False),
        ("icons/icon-512.png", 512, False),
        ("icons/maskable-512.png", 512, True),
        ("icons/favicon-32.png", 32, False),
    ]
    for path, size, maskable in outputs:
        img = make(size, maskable)
        img.save(path, "PNG")
        print("wrote", path, f"({size}x{size})")


if __name__ == "__main__":
    main()
