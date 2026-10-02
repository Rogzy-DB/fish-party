#!/usr/bin/env python3
"""
matcher.py -- closed-set template matcher for the fish-projection v2 Recognizer.

The problem is NOT "guess the animal" (open-ended, hard). Every guest coloured
inside one of 12 fixed printed outlines, so a drawing is literally one of 12 known
line-art shapes with colour added + arbitrary rotation/scale/mirror + scan noise.
So we score an input against all 12 references and pick the best -> species +
confidence.

Two complementary signals, because neither alone is enough:

  1. SILHOUETTE shape  (cv2.matchShapes on the outer contour, Hu-moment based).
     Rotation / scale / reflection invariant -> robust to how the drawing was
     photographed. Great for distinctive silhouettes (jellyfish vs shark), weaker
     between look-alikes (jellyfish vs octopus body, squid vs whale).

  2. LINE-ART structure (ORB keypoints + a RANSAC homography inlier count).
     Matches the *internal* strokes of the outline (tentacle splits, fins, the
     urchin's spikes) which the guest coloured over but did not erase. This
     disambiguates similar silhouettes. Tried at 0 and 180 deg and mirrored,
     since drawings arrive in any orientation.

Both are turned into a per-reference [0..1] score; the combined score is a
weighted blend. Confidence = combined score of the winner, adjusted by its
*margin* over the runner-up (a clear winner is more trustworthy than a photo
finish). The caller applies the accept/needs_review threshold -- this module
only scores.

Nothing here uses colour: guests colour-filled the interior, so we work purely
from the silhouette and the dark line-art edges.
"""
import math
import os

import cv2
import numpy as np

# ---- tunables (kept explicit so they're easy to retune on this closed set) ----
WORK_SIZE = 512          # normalise every shape to this bounding-box long side
ORB_FEATURES = 1500
LOWE_RATIO = 0.78        # ratio test for ORB matches
MIN_ORB_MATCHES = 8      # need at least this many good matches to try homography
SHAPE_WEIGHT = 0.55      # blend weight for the silhouette score
ORB_WEIGHT = 0.45        # blend weight for the line-art score
# score = SHAPE_WEIGHT*shape_score + ORB_WEIGHT*orb_score


# --------------------------------------------------------------------------- #
# Silhouette / mask helpers
# --------------------------------------------------------------------------- #
def mask_from_rgba(rgba):
    """Binary creature mask from an RGBA cutout's alpha channel (0/255)."""
    if rgba.shape[2] == 4:
        alpha = rgba[:, :, 3]
        _, m = cv2.threshold(alpha, 16, 255, cv2.THRESH_BINARY)
    else:
        gray = cv2.cvtColor(rgba, cv2.COLOR_BGR2GRAY)
        _, m = cv2.threshold(gray, 250, 255, cv2.THRESH_BINARY_INV)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    return m


def mask_from_reference(gray):
    """Filled silhouette mask for a reference line-art (fill the outline)."""
    _, ink = cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY_INV)
    ink = cv2.morphologyEx(ink, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    # fill the largest outer contour so we get a solid silhouette to match the
    # solid alpha mask of an input drawing.
    cnts, _ = cv2.findContours(ink, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    mask = np.zeros_like(ink)
    if cnts:
        c = max(cnts, key=cv2.contourArea)
        cv2.drawContours(mask, [c], -1, 255, thickness=cv2.FILLED)
    return mask


def largest_contour(mask):
    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return None
    return max(cnts, key=cv2.contourArea)


def crop_normalise(img, mask):
    """Crop img+mask to the mask bbox and scale so the long side == WORK_SIZE."""
    ys, xs = np.where(mask > 0)
    if len(xs) == 0:
        return img, mask
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    img = img[y0:y1 + 1, x0:x1 + 1]
    mask = mask[y0:y1 + 1, x0:x1 + 1]
    h, w = mask.shape
    scale = WORK_SIZE / max(h, w)
    img = cv2.resize(img, (max(1, int(w * scale)), max(1, int(h * scale))),
                     interpolation=cv2.INTER_AREA)
    mask = cv2.resize(mask, (img.shape[1], img.shape[0]),
                      interpolation=cv2.INTER_NEAREST)
    return img, mask


# --------------------------------------------------------------------------- #
# Line-art (edge) helpers for ORB
# --------------------------------------------------------------------------- #
def lineart_from_input(rgba, mask):
    """Dark line-art / strong edges of a coloured input, inside the mask.

    The guest's black outline is the darkest ink; we also add Canny edges to pick
    up strong internal strokes. Colour fills are largely suppressed.
    """
    bgr = rgba[:, :, :3] if rgba.shape[2] == 4 else rgba
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    # dark ink
    dark = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C,
                                 cv2.THRESH_BINARY_INV, 25, 15)
    edges = cv2.Canny(gray, 60, 160)
    la = cv2.bitwise_or(dark, edges)
    la = cv2.bitwise_and(la, mask)
    return la


def lineart_from_reference(gray):
    """Line-art edges of a reference (the black outline itself)."""
    _, ink = cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY_INV)
    return ink


# --------------------------------------------------------------------------- #
# Feature building
# --------------------------------------------------------------------------- #
_orb = cv2.ORB_create(nfeatures=ORB_FEATURES)


class ShapeModel:
    """Precomputed match features for one image (reference or input)."""

    def __init__(self, contour, lineart):
        self.contour = contour
        self.lineart = lineart
        self.kp, self.des = _orb.detectAndCompute(lineart, None)


def build_reference_model(gray):
    mask = mask_from_reference(gray)
    contour = largest_contour(mask)
    la = lineart_from_reference(gray)
    la, mask2 = crop_normalise(la, mask)
    # recompute contour on the normalised mask so shape scale matches ORB scale
    contour = largest_contour(mask2)
    return ShapeModel(contour, la)


def build_input_model(rgba):
    mask = mask_from_rgba(rgba)
    la = lineart_from_input(rgba, mask)
    la, mask2 = crop_normalise(la, mask)
    contour = largest_contour(mask2)
    return ShapeModel(contour, la)


# --------------------------------------------------------------------------- #
# Scoring
# --------------------------------------------------------------------------- #
def _shape_score(a, b):
    """cv2.matchShapes distance -> [0..1] score (1 = identical silhouette)."""
    if a is None or b is None:
        return 0.0
    d = cv2.matchShapes(a, b, cv2.CONTOURS_MATCH_I1, 0.0)
    # matchShapes distance is ~0 for identical, grows unboundedly. Map with an
    # exponential falloff; ~0.25 distance -> ~0.6 score (tuned on this set).
    return float(np.exp(-3.5 * d))


def _orb_score(inp, ref):
    """Line-art ORB match -> [0..1] score via RANSAC homography inliers.

    Tries the reference as-is and mirrored (drawings can be flipped). ORB is
    rotation invariant, so we don't need explicit rotations.
    """
    if inp.des is None or ref.des is None:
        return 0.0
    best = 0.0
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
    for ref_kp, ref_des in _ref_variants(ref):
        if ref_des is None or len(ref_des) < 2:
            continue
        knn = matcher.knnMatch(inp.des, ref_des, k=2)
        good = []
        for m_n in knn:
            if len(m_n) < 2:
                continue
            m, n = m_n
            if m.distance < LOWE_RATIO * n.distance:
                good.append(m)
        if len(good) < MIN_ORB_MATCHES:
            score = len(good) / max(1, MIN_ORB_MATCHES) * 0.25
            best = max(best, min(score, 0.25))
            continue
        src = np.float32([inp.kp[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
        dst = np.float32([ref_kp[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
        H, inliers = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
        if inliers is None:
            continue
        n_in = int(inliers.sum())
        # normalise inlier count: ~30 inliers -> saturates near 1.0
        score = min(1.0, n_in / 30.0)
        best = max(best, score)
    return best


def _ref_variants(ref):
    """Yield (kp, des) for the reference line-art and its mirror."""
    yield ref.kp, ref.des
    mirrored = cv2.flip(ref.lineart, 1)
    kp, des = _orb.detectAndCompute(mirrored, None)
    yield kp, des


# minimum RANSAC inliers before we trust an orientation estimate. Stricter than
# MIN_ORB_MATCHES: a wrong rotation VISIBLY breaks the fish in the tank, so on
# a weak match we prefer "leave as scanned".
MIN_ROT_INLIERS = 12


def estimate_orientation(input_model, ref_model):
    """Continuous rotation of a drawing vs its template.

    Returns {angle, mirror, inliers} where `angle` is the input->template
    rotation in degrees (a similarity/RANSAC fit over ORB line-art, tried both
    upright and mirrored), or None when the match is too weak to trust.
    """
    if input_model.des is None or ref_model.des is None:
        return None
    bf = cv2.BFMatcher(cv2.NORM_HAMMING)
    best = None
    for vi, (kp, des) in enumerate(_ref_variants(ref_model)):
        if des is None or len(des) < 2:
            continue
        knn = bf.knnMatch(input_model.des, des, k=2)
        good = []
        for m_n in knn:
            if len(m_n) < 2:
                continue
            m, n = m_n
            if m.distance < LOWE_RATIO * n.distance:
                good.append(m)
        if len(good) < MIN_ORB_MATCHES:
            continue
        src = np.float32([input_model.kp[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
        dst = np.float32([kp[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
        A, inliers = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC,
                                                 ransacReprojThreshold=5.0)
        if A is None or inliers is None:
            continue
        n_in = int(inliers.sum())
        if n_in < MIN_ROT_INLIERS:
            continue
        angle = math.degrees(math.atan2(A[1, 0], A[0, 0]))
        if best is None or n_in > best["inliers"]:
            best = {"angle": angle, "mirror": (vi == 1), "inliers": n_in}
    return best


def rotate_rgba(img, deg, border=None):
    """Rotate an image by `deg` (CCW), expanding the canvas.

    Default border: transparent for RGBA, white for BGR/gray. Pass `border` (a
    scalar or tuple) to override — e.g. 0 for a binary mask.
    """
    deg = deg % 360
    if deg == 0:
        return img
    h, w = img.shape[:2]
    cx, cy = w / 2.0, h / 2.0
    M = cv2.getRotationMatrix2D((cx, cy), deg, 1.0)
    cos, sin = abs(M[0, 0]), abs(M[0, 1])
    nw, nh = int(h * sin + w * cos), int(h * cos + w * sin)
    M[0, 2] += nw / 2.0 - cx
    M[1, 2] += nh / 2.0 - cy
    if border is None:
        has_alpha = img.ndim == 3 and img.shape[2] == 4
        border = (0, 0, 0, 0) if has_alpha else (255, 255, 255)
    return cv2.warpAffine(img, M, (nw, nh), flags=cv2.INTER_NEAREST if img.ndim == 2
                          else cv2.INTER_LINEAR,
                          borderMode=cv2.BORDER_CONSTANT, borderValue=border)


CANON_MASK_SIZE = 96          # binary masks normalised to this square for IoU
CANON_ROT_STEP = 6            # degrees between candidate rotations in the search


def _norm_mask(mask, size=CANON_MASK_SIZE):
    """Crop a binary silhouette to its bbox and fit it, aspect-preserved, into a
    centred size x size square. Makes IoU scale/position invariant."""
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return np.zeros((size, size), np.uint8)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    crop = mask[y0:y1 + 1, x0:x1 + 1]
    h, w = crop.shape
    s = (size - 4) / max(h, w)
    rw, rh = max(1, int(w * s)), max(1, int(h * s))
    small = cv2.resize(crop, (rw, rh), interpolation=cv2.INTER_NEAREST)
    out = np.zeros((size, size), np.uint8)
    oy, ox = (size - rh) // 2, (size - rw) // 2
    out[oy:oy + rh, ox:ox + rw] = small
    return (out > 0).astype(np.uint8)


def _iou(a, b):
    inter = int(np.logical_and(a, b).sum())
    union = int(np.logical_or(a, b).sum())
    return inter / union if union else 0.0


def load_canonical_masks(ref_dir):
    """Canonical silhouette per species = the template filled + rotated to its
    rest pose (CANON_OFFSET), normalised for IoU. This is the ground-truth shape
    every drawing is aligned to."""
    masks = {}
    for sid, off in CANON_OFFSET.items():
        path = os.path.join(ref_dir, f"{sid}.png")
        if not os.path.exists(path):
            continue
        gray = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
        m = mask_from_reference(gray)                 # filled silhouette
        if off % 360:
            m = rotate_rgba(m, off, border=0)
        if sid in CANON_FLIP:                         # template faces left -> mirror
            m = cv2.flip(m, 1)
        masks[sid] = _norm_mask(m)
    return masks


def canonicalize(rgba, species, canon_masks):
    """Rotate/flip a drawing into its species' canonical rest pose by maximising
    silhouette OVERLAP with the canonical template.

    Guests colour INSIDE the printed outline, so a drawing's filled silhouette is
    a reliable copy of the template's shape at some rotation + maybe a mirror.
    We search rotations (every CANON_ROT_STEP degrees) x {no-flip, mirror},
    normalise each candidate mask, and keep the pose with the best IoU against
    the canonical template silhouette. Pure shape -> robust to how it was
    coloured, and it fixes head-up/down, facing-left/right and belly-up all at
    once (a 180 rotation + mirror covers every flip).

    Returns (out_rgba, meta={rotation, flip, iou, mode}).
    """
    tmask = canon_masks.get(species)
    dmask = mask_from_rgba(rgba)
    if tmask is None or dmask is None or dmask.sum() == 0:
        return rgba, {"rotation": 0, "flip": False, "iou": 0.0, "mode": "skip"}

    best = (-1.0, 0, False)   # (iou, deg, flip)
    for deg in range(0, 360, CANON_ROT_STEP):
        rot = rotate_rgba(dmask, deg, border=0) if deg else dmask
        for flip in (False, True):
            m = cv2.flip(rot, 1) if flip else rot
            score = _iou(_norm_mask(m), tmask)
            if score > best[0]:
                best = (score, deg, flip)
    iou, deg, flip = best
    out = rotate_rgba(rgba, deg) if deg else rgba
    if flip:
        out = cv2.flip(out, 1)
    return out, {"rotation": deg, "flip": bool(flip),
                 "iou": round(iou, 3), "mode": "iou"}


def score_against(input_model, ref_models):
    """Score an input model against every reference.

    ref_models: dict species_id -> ShapeModel.
    Returns list of dicts sorted best-first:
        {species, shape, orb, score}
    """
    rows = []
    for species_id, ref in ref_models.items():
        s = _shape_score(input_model.contour, ref.contour)
        o = _orb_score(input_model, ref)
        combined = SHAPE_WEIGHT * s + ORB_WEIGHT * o
        rows.append({"species": species_id, "shape": round(s, 4),
                     "orb": round(o, 4), "score": round(combined, 4)})
    rows.sort(key=lambda r: r["score"], reverse=True)
    return rows


def confidence_from_ranking(rows):
    """Turn the ranked scores into a single [0..1] confidence for the winner.

    A high winning score is good; a *clear margin* over the runner-up matters
    too (a near-tie means the two are hard to tell apart). We fold both in.
    """
    if not rows:
        return 0.0
    top = rows[0]["score"]
    second = rows[1]["score"] if len(rows) > 1 else 0.0
    margin = top - second
    # confidence = winning score gently boosted by a decisive margin.
    conf = top * (0.75 + 0.25 * min(1.0, margin / 0.15))
    return float(min(1.0, conf))


# --------------------------------------------------------------------------- #
# Reference loading
# --------------------------------------------------------------------------- #
def load_reference_models(ref_dir):
    """Load references/<species>.png -> {species_id: ShapeModel}."""
    from species import ROSTER
    models = {}
    for species_id in ROSTER:
        path = os.path.join(ref_dir, f"{species_id}.png")
        if not os.path.exists(path):
            continue
        gray = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
        models[species_id] = build_reference_model(gray)
    return models
