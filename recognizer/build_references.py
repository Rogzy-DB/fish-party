#!/usr/bin/env python3
"""
build_references.py -- turn the 12 template PDFs into recognizer reference images.

Each template is a black line-art outline of one sea creature on a white A4 sheet.
We rasterise it (poppler `pdftoppm`), find the ink, crop tightly to the creature's
bounding box, and save a normalised grayscale line-art PNG under `references/`.

These reference PNGs are what an input drawing is matched against (see
`matcher.py`). We crop to the creature because the guest drawings in
`<data>/fish/` are the creature *cut out of the sheet* (transparent background),
not a full A4 page -- so we must compare like-with-like.

Usage:
    build_references.py [--templates-dir DIR] [--out-dir references] [--dpi 150]
"""
import argparse
import glob
import os
import subprocess
import sys
import tempfile

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from species import TEMPLATE_SPECIES  # noqa: E402

DEFAULT_TEMPLATES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "templates")


def rasterize_pdf(pdf_path, dpi=150):
    """Rasterise the first page of a PDF to a BGR image via pdftoppm."""
    with tempfile.TemporaryDirectory() as td:
        prefix = os.path.join(td, "page")
        subprocess.run(
            ["pdftoppm", "-png", "-r", str(dpi), "-singlefile", pdf_path, prefix],
            check=True, capture_output=True,
        )
        png = prefix + ".png"
        img = cv2.imread(png)
        if img is None:
            raise RuntimeError(f"failed to rasterise {pdf_path}")
        return img


def crop_to_lineart(bgr, pad_frac=0.02):
    """Crop a white-background line-art page to the ink bounding box.

    Returns a grayscale image (0=ink..255=paper) tightly cropped to the creature
    plus a small padding. Robust to a bit of scan noise via a light open.
    """
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    # ink is dark; make a binary ink mask
    _, ink = cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY_INV)
    ink = cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    ys, xs = np.where(ink > 0)
    if len(xs) == 0:
        return gray
    x0, x1 = xs.min(), xs.max()
    y0, y1 = ys.min(), ys.max()
    w, h = x1 - x0, y1 - y0
    pad = int(pad_frac * max(w, h))
    x0 = max(0, x0 - pad); y0 = max(0, y0 - pad)
    x1 = min(gray.shape[1], x1 + pad); y1 = min(gray.shape[0], y1 + pad)
    return gray[y0:y1, x0:x1]


def build(templates_dir, out_dir, dpi):
    os.makedirs(out_dir, exist_ok=True)
    built = []
    for base, (species_id, name) in TEMPLATE_SPECIES.items():
        pdf = os.path.join(templates_dir, base + ".pdf")
        if not os.path.exists(pdf):
            print(f"  ! missing {pdf}", file=sys.stderr)
            continue
        bgr = rasterize_pdf(pdf, dpi=dpi)
        cropped = crop_to_lineart(bgr)
        out_png = os.path.join(out_dir, f"{species_id}.png")
        cv2.imwrite(out_png, cropped)
        built.append((species_id, name, cropped.shape))
        print(f"  {species_id:11s} <- {base}.pdf  {cropped.shape[1]}x{cropped.shape[0]}")
    return built


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--templates-dir", default=DEFAULT_TEMPLATES)
    ap.add_argument("--out-dir",
                    default=os.path.join(os.path.dirname(__file__), "references"))
    ap.add_argument("--dpi", type=int, default=150)
    args = ap.parse_args()
    built = build(args.templates_dir, args.out_dir, args.dpi)
    print(f"\nbuilt {len(built)} reference images -> {args.out_dir}")


if __name__ == "__main__":
    main()
