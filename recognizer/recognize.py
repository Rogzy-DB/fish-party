#!/usr/bin/env python3
"""
recognize.py -- closed-set species recognition for one fish drawing.

Given a guest drawing (an RGBA cutout with transparent background, as produced by
the ingest pipeline and stored in <data>/fish/<id>.png), decide which of the 12
known template species it is -- or send it to the review tray.

    result = recognize(rgba_or_path, ref_models)
    -> {species, display, confidence, status, ranking}

status is one of:
    "ok"            -> confidence >= ACCEPT_THRESHOLD, species accepted
    "needs_review"  -> below threshold; a human assigns/discards. NEVER guess.

The accept/review gate is a LOCKED rule: it is always better to send to review
than to mislabel. Tune ACCEPT_THRESHOLD, never bypass the gate.

CLI:
    recognize.py <image.png> [--ref-dir references] [--threshold 0.42]
"""
import argparse
import json
import os
import sys

import cv2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import matcher  # noqa: E402
from species import display_name  # noqa: E402

# Confidence at/above which we accept the top species. Below -> needs_review.
# Tuned on the 47 real party fish (see README "Tuning").
ACCEPT_THRESHOLD = 0.42


def recognize(image, ref_models, threshold=ACCEPT_THRESHOLD):
    """Recognise one drawing. `image` is an RGBA ndarray or a path."""
    if isinstance(image, str):
        rgba = cv2.imread(image, cv2.IMREAD_UNCHANGED)
        if rgba is None:
            return {"status": "needs_review", "reason": "unreadable image",
                    "species": None, "display": None, "confidence": 0.0,
                    "ranking": []}
    else:
        rgba = image

    input_model = matcher.build_input_model(rgba)
    if input_model.contour is None:
        return {"status": "needs_review", "reason": "no silhouette",
                "species": None, "display": None, "confidence": 0.0,
                "ranking": []}

    ranking = matcher.score_against(input_model, ref_models)
    confidence = matcher.confidence_from_ranking(ranking)
    top = ranking[0]

    if confidence >= threshold:
        status, species = "ok", top["species"]
    else:
        status, species = "needs_review", None

    return {
        "status": status,
        "species": species,
        "display": display_name(species) if species else None,
        "best_guess": top["species"],           # shown in the review tray only
        "best_guess_display": display_name(top["species"]),
        "confidence": round(confidence, 4),
        "ranking": ranking[:3],                 # top-3 for transparency
    }


def _default_ref_dir():
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "references")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--ref-dir", default=_default_ref_dir())
    ap.add_argument("--threshold", type=float, default=ACCEPT_THRESHOLD)
    args = ap.parse_args()
    ref_models = matcher.load_reference_models(args.ref_dir)
    res = recognize(args.image, ref_models, threshold=args.threshold)
    print(json.dumps(res, indent=2))


if __name__ == "__main__":
    main()
