"""Render the compaction mark at several sizes for review.

Paths are read from tools/client-app.js so the preview cannot drift from what the
browser draws. Only absolute M/H/V/L commands are supported, which is what the
component uses — and the reason it does: a relative `m` inside a joined `d`
continues from the previous subpath's endpoint, which once pushed the arrowheads
outside the viewBox. Rendering those same numbers by hand looked fine, so this
script must fail loudly on anything it does not understand rather than guess.

Run: python assets/render-icon.py
"""
from pathlib import Path
import re

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "tools" / "client-app.js"
STROKE = 1.6                      # logical units, matches strokeWidth in the component
INK_LIGHT = (31, 32, 35)
INK_DARK = (232, 233, 236)
BG_LIGHT = "#f7f7f8"
BG_DARK = "#1b1c1f"


def read_paths():
    """Pull the `strokes` array out of the component and parse it to polylines."""
    text = SOURCE.read_text(encoding="utf-8")
    block = re.search(r"const strokes = \[([\s\S]*?)\];", text)
    if block is None:
        raise SystemExit("could not find the strokes array in tools/client-app.js")
    raw = re.findall(r'"([^"]+)"', block.group(1))
    return [parse(d) for d in raw]


def parse(d):
    """Turn one subpath into a list of points. Absolute commands only."""
    tokens = re.findall(r"[A-Za-z]|-?\d+(?:\.\d+)?", d)
    points, i = [], 0
    while i < len(tokens):
        cmd = tokens[i]
        i += 1
        if cmd.islower():
            raise SystemExit(
                f"relative command {cmd!r} in {d!r}: the component must use absolute "
                "commands, or the subpath starts wherever the previous one ended"
            )
        if cmd in ("M", "L"):
            x, y = float(tokens[i]), float(tokens[i + 1])
            i += 2
            points.append((x, y))
        elif cmd == "H":
            x = float(tokens[i])
            i += 1
            points.append((x, points[-1][1] if points else 0.0))
        elif cmd == "V":
            y = float(tokens[i])
            i += 1
            points.append((points[-1][0] if points else 0.0, y))
        else:
            raise SystemExit(f"unsupported command {cmd!r} in {d!r}")
    for x, y in points:
        if not (0 <= x <= 24 and 0 <= y <= 24):
            raise SystemExit(f"point ({x}, {y}) of {d!r} is outside the 24x24 viewBox")
    return points


def render(size, paths, bg, ink):
    ss = 8                                    # supersample so round caps come out clean
    px = size * ss
    k = px / 24.0
    img = Image.new("RGB", (px, px), bg)
    draw = ImageDraw.Draw(img)
    width = max(1, round(STROKE * k))
    radius = width / 2.0
    for points in paths:
        scaled = [(x * k, y * k) for (x, y) in points]
        draw.line(scaled, fill=ink, width=width, joint="curve")
        for (cx, cy) in scaled:               # round caps: one disc per vertex
            draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill=ink)
    return img.resize((size, size), Image.LANCZOS)


def sheet(paths, dark):
    sizes = [16, 18, 24, 32, 96, 240]
    bg = BG_DARK if dark else BG_LIGHT
    ink = INK_DARK if dark else INK_LIGHT
    label = (150, 150, 155) if dark else (120, 120, 120)
    pad = 30
    width = sum(sizes) + pad * (len(sizes) + 1)
    height = 280
    canvas = Image.new("RGB", (width, height), bg)
    draw = ImageDraw.Draw(canvas)
    x = pad
    for size in sizes:
        canvas.paste(render(size, paths, bg, ink), (x, pad))
        draw.text((x, pad + max(size, 18) + 12), f"{size}px", fill=label)
        x += size + pad
    return canvas


if __name__ == "__main__":
    paths = read_paths()
    print(f"parsed {len(paths)} subpaths, {sum(len(p) for p in paths)} points")
    for name, dark in (("icon-preview-light.png", False), ("icon-preview-dark.png", True)):
        out = ROOT / "assets" / name
        sheet(paths, dark).save(out)
        print("wrote", out.relative_to(ROOT))
