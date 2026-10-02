#!/usr/bin/env python3
"""
run_batch.py -- run the closed-set recognizer over every fish in <data>/fish/
and emit the two deliverables:

  <data>/labels.json        MACHINE-readable: {fish_id: {species, confidence, status}}
  <data>/report/recognition_report.md HUMAN-readable table + summary for the owner.

It also drops small thumbnails under <data>/report/thumbs/ so the markdown report can show
each fish next to its verdict.

Usage:
    run_batch.py [--queue DIR] [--ref-dir references] [--out-dir out]
                 [--threshold 0.42]
"""
import argparse
import glob
import json
import os
import sys
from collections import Counter

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import matcher  # noqa: E402
from recognize import recognize, ACCEPT_THRESHOLD  # noqa: E402
from species import display_name, ROSTER  # noqa: E402

# same data directory as tank/serve.py and ingest.py (FISH_DATA, default <repo>/data)
DATA_DIR = os.path.abspath(os.environ.get(
    "FISH_DATA", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")))


def make_thumb(rgba, out_path, size=120):
    """White-matted square thumbnail so transparent PNGs are visible in the report."""
    h, w = rgba.shape[:2]
    scale = size / max(h, w)
    small = cv2.resize(rgba, (max(1, int(w * scale)), max(1, int(h * scale))))
    canvas = np.full((size, size, 3), 255, np.uint8)
    sh, sw = small.shape[:2]
    y0 = (size - sh) // 2
    x0 = (size - sw) // 2
    if small.shape[2] == 4:
        alpha = small[:, :, 3:4].astype(np.float32) / 255.0
        rgb = small[:, :, :3].astype(np.float32)
        bg = canvas[y0:y0 + sh, x0:x0 + sw].astype(np.float32)
        blended = rgb * alpha + bg * (1 - alpha)
        canvas[y0:y0 + sh, x0:x0 + sw] = blended.astype(np.uint8)
    else:
        canvas[y0:y0 + sh, x0:x0 + sw] = small[:, :, :3]
    cv2.imwrite(out_path, canvas)


def run(data_dir, ref_dir, threshold):
    """Recognise every scanned fish in <data>/fish/, bake canonical poses into
    <data>/normalized/, MERGE the verdicts into <data>/labels.json (names and
    painted fish are kept as they are) and write a report under <data>/report/."""
    queue_dir = os.path.join(data_dir, "fish")
    out_dir = os.path.join(data_dir, "report")
    labels_path = os.path.join(data_dir, "labels.json")
    os.makedirs(out_dir, exist_ok=True)
    thumb_dir = os.path.join(out_dir, "thumbs")
    os.makedirs(thumb_dir, exist_ok=True)
    norm_dir = os.path.join(data_dir, "normalized")
    os.makedirs(norm_dir, exist_ok=True)
    try:
        labels = json.load(open(labels_path))
    except Exception:
        labels = {}

    ref_models = matcher.load_reference_models(ref_dir)
    canon_masks = matcher.load_canonical_masks(ref_dir)
    if len(ref_models) != 12:
        print(f"WARNING: loaded {len(ref_models)} references, expected 12",
              file=sys.stderr)
    # clear stale normalized copies so a re-run never serves an old pose
    for old in glob.glob(os.path.join(norm_dir, "*.png")):
        os.remove(old)

    pngs = sorted(glob.glob(os.path.join(queue_dir, "*.png")))
    results = []
    for path in pngs:
        fish_id = os.path.splitext(os.path.basename(path))[0]
        prev = labels.get(fish_id) if isinstance(labels.get(fish_id), dict) else {}
        if prev.get("source") == "draw":
            continue   # painted in-app: species was chosen, nothing to recognise
        rgba = cv2.imread(path, cv2.IMREAD_UNCHANGED)
        res = recognize(rgba, ref_models, threshold=threshold)

        # canonical pose: rotate/flip each accepted drawing into its species'
        # "facing right, level" rest pose (swim fish) or upright (floor/vertical
        # creatures), so the tank renders them correctly. The raw scan is never
        # touched — the canonical copy goes to normalized/ and the tank prefers
        # it. See matcher.canonicalize.
        rotation = 0
        if res["status"] == "ok":
            out, cmeta = matcher.canonicalize(rgba, res["species"], canon_masks)
            rotation = cmeta["rotation"]
            cv2.imwrite(os.path.join(norm_dir, f"{fish_id}.png"),
                        np.ascontiguousarray(out))
        res["rotation"] = rotation

        thumb_rel = os.path.join("thumbs", f"{fish_id}.png")
        make_thumb(rgba, os.path.join(out_dir, thumb_rel))

        results.append((fish_id, res, thumb_rel))
        labels[fish_id] = {
            **prev,                              # keep name, source, ...
            "species": res["species"],           # None when needs_review
            "confidence": res["confidence"],
            "status": res["status"],
            "rotation": rotation,                # deg CCW applied in normalized/
        }

    # ---- machine-readable ----
    tmp = labels_path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(labels, f, indent=2)
        f.write("\n")
    os.replace(tmp, labels_path)

    # ---- human-readable ----
    write_report(results, out_dir, threshold)
    return results


def write_report(results, out_dir, threshold):
    n = len(results)
    accepted = [r for r in results if r[1]["status"] == "ok"]
    review = [r for r in results if r[1]["status"] != "ok"]

    # distribution over accepted species
    dist = Counter(r[1]["species"] for r in accepted)
    # what the review pile *looks* like (best guess) -- diagnostics only
    review_guess = Counter(r[1]["best_guess"] for r in review)

    lines = []
    lines.append("# Fish recognition report\n")
    lines.append("_Closed-set template matching over the 12 printed coloring "
                 "outlines. Every guest colored inside one of these 12 shapes, so "
                 "recognition is \"which of the 12 known outlines is this\", not "
                 "open-ended guessing._\n")
    lines.append(f"- Fish processed: **{n}**")
    lines.append(f"- Confidently recognized (accepted): **{len(accepted)}**")
    lines.append(f"- Sent to review (below confidence gate): **{len(review)}**")
    lines.append(f"- Accept threshold: **{threshold}** "
                 "(below this a fish is never labeled — it goes to the review "
                 "tray so a human decides).\n")

    lines.append("## Species distribution (accepted fish)\n")
    if dist:
        lines.append("| Species | Count |")
        lines.append("|---|---|")
        for sid in ROSTER:
            if dist.get(sid):
                lines.append(f"| {display_name(sid)} | {dist[sid]} |")
    else:
        lines.append("_none_")
    lines.append("")

    if review:
        lines.append("## Review pile — closest guess (NOT applied)\n")
        lines.append("These fish scored below the gate. The 'closest guess' is "
                     "only a hint for the person triaging the tray; it is not "
                     "written as the species.\n")
        lines.append("| Closest guess | Count |")
        lines.append("|---|---|")
        for sid, c in review_guess.most_common():
            lines.append(f"| {display_name(sid)} | {c} |")
        lines.append("")

    n_rot = sum(1 for r in results if r[1].get("rotation"))
    if n_rot:
        lines.append(f"**Orientation fixes: {n_rot}** — these scans arrived "
                     "rotated (e.g. paper fed upside down); a corrected copy "
                     "is baked into `<data>/normalized/` and served to the tank. "
                     "Originals untouched.\n")

    lines.append("## Every fish\n")
    lines.append("| # | Fish | ID | Verdict | Species | Confidence | Top-3 (score) |")
    lines.append("|---|---|---|---|---|---|---|")
    for i, (fish_id, res, thumb_rel) in enumerate(results, 1):
        verdict = "✅ accept" if res["status"] == "ok" else "🔎 needs review"
        if res.get("rotation"):
            verdict += f" ↻{res['rotation']}°"
        species = res["display"] if res["species"] else \
            f"— (guess: {res['best_guess_display']})"
        top3 = ", ".join(f"{display_name(r['species'])} {r['score']:.2f}"
                         for r in res["ranking"])
        img = f"![{fish_id}]({thumb_rel})"
        lines.append(f"| {i} | {img} | `{fish_id}` | {verdict} | {species} "
                     f"| {res['confidence']:.2f} | {top3} |")
    lines.append("")

    lines.append("## How to read this\n")
    lines.append("- **accept**: the recognizer is confident enough to label the "
                 "fish; the species feeds straight into the tank.")
    lines.append("- **needs review**: not confident enough. Rather than risk a "
                 "wrong label, it's parked for a human to confirm or discard. "
                 "The 'guess' is just a starting hint.")
    lines.append("- **Confidence** blends silhouette-shape similarity with "
                 "internal line-art feature matching, adjusted by how clearly the "
                 "winner beat the runner-up.\n")

    with open(os.path.join(out_dir, "recognition_report.md"), "w") as f:
        f.write("\n".join(lines))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=DATA_DIR)
    ap.add_argument("--ref-dir",
                    default=os.path.join(os.path.dirname(__file__), "references"))
    ap.add_argument("--threshold", type=float, default=ACCEPT_THRESHOLD)
    args = ap.parse_args()
    results = run(args.data, args.ref_dir, args.threshold)
    n_ok = sum(1 for r in results if r[1]["status"] == "ok")
    print(f"processed {len(results)} fish: {n_ok} accepted, "
          f"{len(results) - n_ok} needs_review")
    print(f"-> {os.path.join(args.data, 'report', 'recognition_report.md')}")
    print(f"-> {os.path.join(args.data, 'labels.json')}")


if __name__ == "__main__":
    main()
