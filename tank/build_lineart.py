#!/usr/bin/env python3
"""
build_lineart.py -- bake the 12 colouring templates into transparent PNGs for
the in-app fish colorer (static/lineart/<species>.png).

The draw page (draw.html) composites the line art ON TOP of the guest's paint
layer, so the outlines must be:
  * black ink, fully opaque
  * paper (white) fully TRANSPARENT — otherwise the overlay would hide the paint

Source of truth is the same PDF set the printable sheets come from
(templates/*.pdf) via species.TEMPLATE_SPECIES, so a new template is
picked up by adding one row there — exactly like build_references.py.

Usage:
    ../.venv/bin/python build_lineart.py [--dpi 200]
"""
import argparse
import os
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, ".."))
RECOGNIZER = os.path.join(REPO_ROOT, "recognizer")
sys.path.insert(0, RECOGNIZER)

from build_references import crop_to_lineart, rasterize_pdf  # noqa: E402
from species import TEMPLATE_SPECIES  # noqa: E402

TEMPLATES_DIR = os.path.join(REPO_ROOT, "templates")
OUT_DIR = os.path.join(HERE, "static", "lineart")
MAX_DIM = 900  # plenty for a phone canvas; keeps the page light


def to_transparent_lineart(gray):
    """Grayscale line art (0=ink, 255=paper) -> BGRA, black ink on alpha=0 paper.

    Alpha is the inverted grey, so antialiased strokes keep soft edges instead
    of turning into a jagged 1-bit mask.
    """
    alpha = 255 - gray
    # kill the faint scanner/rasteriser haze so the paper is truly clear
    alpha[alpha < 28] = 0
    # push the real ink to fully opaque (a mid-grey outline reads as washed out
    # once it sits over a bright paint layer)
    alpha = np.clip(alpha.astype(np.int32) * 160 // 100, 0, 255).astype(np.uint8)
    h, w = gray.shape[:2]
    bgra = np.zeros((h, w, 4), dtype=np.uint8)   # BGR left at 0 = black ink
    bgra[..., 3] = alpha
    return bgra


def resize_max(img, max_dim):
    h, w = img.shape[:2]
    s = max_dim / max(h, w)
    if s < 1.0:
        return cv2.resize(img, (int(w * s), int(h * s)),
                          interpolation=cv2.INTER_AREA)
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dpi", type=int, default=200)
    ap.add_argument("--out-dir", default=OUT_DIR)
    args = ap.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    n = 0
    for base, (species_id, name) in TEMPLATE_SPECIES.items():
        pdf = os.path.join(TEMPLATES_DIR, base + ".pdf")
        if not os.path.exists(pdf):
            print("  ! missing %s" % pdf, file=sys.stderr)
            continue
        gray = crop_to_lineart(rasterize_pdf(pdf, dpi=args.dpi))
        bgra = resize_max(to_transparent_lineart(gray), MAX_DIM)
        out = os.path.join(args.out_dir, species_id + ".png")
        cv2.imwrite(out, bgra)
        print("  %-11s <- %s.pdf  %dx%d" % (species_id, base,
                                            bgra.shape[1], bgra.shape[0]))
        n += 1
    print("\nbuilt %d line-art overlays -> %s" % (n, args.out_dir))


if __name__ == "__main__":
    main()
