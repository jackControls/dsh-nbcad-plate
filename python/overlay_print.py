#!/usr/bin/env python3
"""Draw the holes of a STEP file (or of a cached hole list) onto the plan view of a plate print.

  overlay_print.py [--json] <print.pdf> <part.step|holes.json> <out.png> --length L --width W
                   [--region x0,y0,x1,y1] [--dpi N] [--page P]

The plate outline is found on the page (the two strongest long vertical lines L mm apart in
the print's own scale, and the pair of long horizontal lines W mm apart); its four corners are
refined separately, so a slightly rotated scan maps correctly. Plate millimetres (origin at the
lower-left corner of the plan view, y up) are then drawn on the render: red = hole, blue =
counterbore, green = the calibrated outline. With --region the output is a high-resolution crop
of that millimetre window (default 400 dpi), which is the form to read hole by hole.
"""
import json
import math
import os
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

CAL_DPI = 150


def parse_args(argv):
    opts = {"json": False, "region": None, "dpi": 400, "page": 1, "length": None, "width": None}
    positional = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--json":
            opts["json"] = True
        elif a in ("--region", "--dpi", "--page", "--length", "--width"):
            opts[a[2:]] = argv[i + 1]
            i += 1
        else:
            positional.append(a)
        i += 1
    if len(positional) != 3 or opts["length"] is None or opts["width"] is None:
        raise SystemExit(__doc__)
    opts["length"], opts["width"], opts["dpi"], opts["page"] = float(opts["length"]), float(opts["width"]), int(opts["dpi"]), int(opts["page"])
    if opts["region"]:
        opts["region"] = [float(v) for v in opts["region"].split(",")]
    return positional, opts


def render_ppm(pdf, dpi, page, crop=None):
    tmp = tempfile.mkdtemp()
    cmd = ["pdftoppm", "-r", str(dpi), "-f", str(page), "-l", str(page)]
    if crop:
        x, y, w, h = crop
        cmd += ["-x", str(x), "-y", str(y), "-W", str(w), "-H", str(h)]
    subprocess.run(cmd + ["-singlefile", pdf, os.path.join(tmp, "page")], check=True, capture_output=True)
    data = open(os.path.join(tmp, "page.ppm"), "rb").read()
    parts = data.split(b"\n", 3)
    width, height = map(int, parts[1].split())
    return width, height, bytearray(parts[3][: width * height * 3])


def dark_counts(width, height, pixels, x_lo=0, x_hi=None, y_lo=0, y_hi=None, threshold=110):
    x_hi = width if x_hi is None else x_hi
    y_hi = height if y_hi is None else y_hi
    stride = width * 3
    rows, cols = {}, {}
    for y in range(y_lo, y_hi):
        row = pixels[y * stride + x_lo * 3: y * stride + x_hi * 3: 3]
        dark = [i + x_lo for i, v in enumerate(row) if v < threshold]
        rows[y] = len(dark)
        for i in dark:
            cols[i] = cols.get(i, 0) + 1
    return rows, cols


def calibrate(pdf, page, L, W):
    width, height, pixels = render_ppm(pdf, CAL_DPI, page)
    rows, cols = dark_counts(width, height, pixels)
    mx, my = int(width * 0.05), int(height * 0.05)

    def peaks(counts, lo, hi, n, gap):
        order = sorted(range(lo, hi), key=lambda i: -counts.get(i, 0))
        chosen = []
        for i in order:
            if all(abs(i - c) > gap for c in chosen):
                chosen.append(i)
            if len(chosen) == n:
                break
        return sorted(chosen)

    xc = peaks(cols, mx, width - mx, 8, 12)
    yc = peaks(rows, my, height - my, 10, 8)
    best = None
    # the plate: a vertical pair and a horizontal pair whose spans have the ratio L : W
    for i in range(len(xc)):
        for j in range(i + 1, len(xc)):
            span_x = xc[j] - xc[i]
            if span_x < width * 0.25:
                continue
            for k in range(len(yc)):
                for l in range(k + 1, len(yc)):
                    span_y = yc[l] - yc[k]
                    err = abs(span_y / span_x - W / L) / (W / L)
                    if err < 0.03:
                        score = cols.get(xc[i], 0) + cols.get(xc[j], 0) + rows.get(yc[k], 0) + rows.get(yc[l], 0)
                        if best is None or score > best[0]:
                            best = (score, xc[i], xc[j], yc[k], yc[l])
    if best is None:
        raise RuntimeError("plate outline not found on the page; check length/width")
    _, x0, x1, yt, yb = best
    scale = (x1 - x0) / L

    def refine_row(y_guess, x_lo, x_hi):
        r, _ = dark_counts(width, height, pixels, x_lo, x_hi, max(0, y_guess - 12), min(height, y_guess + 13))
        return max(r, key=lambda y: r[y])

    def refine_col(x_guess, y_lo, y_hi):
        _, c = dark_counts(width, height, pixels, max(0, x_guess - 12), min(width, x_guess + 13), y_lo, y_hi)
        return max(c, key=lambda x: c[x])

    band = max(40, int(min(L, W) * 0.25 * scale))
    tl = (refine_col(x0, yt + 30, yt + 30 + band), refine_row(yt, x0 + 30, x0 + 30 + band))
    tr = (refine_col(x1, yt + 30, yt + 30 + band), refine_row(yt, x1 - 30 - band, x1 - 30))
    bl = (refine_col(x0, yb - 30 - band, yb - 30), refine_row(yb, x0 + 30, x0 + 30 + band))
    br = (refine_col(x1, yb - 30 - band, yb - 30), refine_row(yb, x1 - 30 - band, x1 - 30))
    skew = math.degrees(math.atan2(br[1] - bl[1], br[0] - bl[0]))
    return {"dpi": CAL_DPI, "tl": tl, "tr": tr, "bl": bl, "br": br, "px_per_mm": round(scale, 4), "skew_deg": round(skew, 3)}


def mapper(cal, L, W, dpi, offset=(0, 0)):
    k = dpi / cal["dpi"]
    tl, tr, bl, br = (tuple(v * k for v in cal[key]) for key in ("tl", "tr", "bl", "br"))

    def f(x, y):
        u, v = x / L, y / W
        px = bl[0] + u * (br[0] - bl[0]) + v * (tl[0] - bl[0]) + u * v * (tr[0] - tl[0] - br[0] + bl[0])
        py = bl[1] + u * (br[1] - bl[1]) + v * (tl[1] - bl[1]) + u * v * (tr[1] - tl[1] - br[1] + bl[1])
        return px - offset[0], py - offset[1]
    return f


def write_png(path, width, height, pixels):
    raw = b"".join(b"\x00" + bytes(pixels[y * width * 3:(y + 1) * width * 3]) for y in range(height))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def load_holes(source):
    if source.endswith(".json"):
        return json.load(open(source))["holes"]["holes"]
    result = subprocess.run([sys.executable, str(Path(__file__).with_name("inspect_step.py")), "--json", source], capture_output=True, text=True)
    value = json.loads(result.stdout.strip().splitlines()[-1])
    if not value.get("ok"):
        raise RuntimeError(value.get("error", "inspect failed"))
    return value["holes"]["holes"]


def main():
    (pdf, source, out_png), opts = parse_args(sys.argv[1:])
    L, W = opts["length"], opts["width"]
    cal = calibrate(pdf, opts["page"], L, W)
    holes = load_holes(source)
    if opts["region"]:
        rx0, ry0, rx1, ry1 = opts["region"]
        m = mapper(cal, L, W, opts["dpi"])
        xs, ys = zip(m(rx0, ry0), m(rx1, ry0), m(rx0, ry1), m(rx1, ry1))
        cx0, cy0 = int(min(xs)), int(min(ys))
        width, height, pixels = render_ppm(pdf, opts["dpi"], opts["page"], (cx0, cy0, int(max(xs)) - cx0, int(max(ys)) - cy0))
        to_px = mapper(cal, L, W, opts["dpi"], (cx0, cy0))
        scale = cal["px_per_mm"] * opts["dpi"] / cal["dpi"]
    else:
        width, height, pixels = render_ppm(pdf, CAL_DPI, opts["page"])
        to_px = mapper(cal, L, W, CAL_DPI)
        scale = cal["px_per_mm"]
    stride = width * 3

    def put(x, y, rgb):
        x, y = int(x), int(y)
        if 0 <= x < width and 0 <= y < height:
            pixels[y * stride + x * 3: y * stride + x * 3 + 3] = bytes(rgb)

    def circle(cx, cy, r, rgb, thick):
        steps = max(24, int(2 * math.pi * r))
        for k in range(steps):
            a = 2 * math.pi * k / steps
            for t in range(thick):
                put(round(cx + (r + t) * math.cos(a)), round(cy + (r + t) * math.sin(a)), rgb)

    thick = max(2, int(scale))
    drawn = 0
    for h in holes:
        px, py = to_px(h["x"], h["y"])
        circle(px, py, max(3, h["diameter"] / 2 * scale), (230, 0, 0), thick)
        s = int(6 * max(1, scale / 2))
        for d in range(-s, s + 1):
            put(px + d, py, (230, 0, 0)); put(px, py + d, (230, 0, 0))
        if h.get("counterbore"):
            circle(px, py, h["counterbore"] / 2 * scale, (0, 0, 230), thick)
        drawn += 1
    for t in range(0, 2001):
        for (xa, ya, xb, yb) in ((0, 0, L, 0), (L, 0, L, W), (L, W, 0, W), (0, W, 0, 0)):
            px, py = to_px(xa + (xb - xa) * t / 2000, ya + (yb - ya) * t / 2000)
            put(px, py, (0, 160, 0))
    write_png(out_png, width, height, pixels)
    result = {"ok": True, "png": str(Path(out_png).resolve()), "size": [width, height], "holes_drawn": drawn, "calibration": cal,
              "region_mm": opts["region"], "dpi": opts["dpi"] if opts["region"] else CAL_DPI,
              "legend": "red = model hole (diameter), blue = counterbore, green = calibrated plate outline"}
    print(json.dumps(result) if opts["json"] else json.dumps(result, indent=1))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(error)[:2000]}))
        sys.exit(1)
