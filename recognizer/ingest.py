#!/usr/bin/env python3
"""
ingest.py -- v2 photo -> fish cutout + recognition, as a LIBRARY.

v1's ingest was a directory-watching daemon fed by an email poller (both
retired). v2 keeps only the proven computer-vision core (ported from
src/ingest.py) and exposes ONE function the upload endpoint calls directly:

    result = ingest_photo(image_bytes)

Pipeline: decode -> find the drawing's closed outline -> cut it out with a
transparent background -> recognize species (closed-set, recognize.py) ->
estimate scan orientation and bake an upright copy when needed -> write
<data>/fish/<id>.png (+ .json meta) and update labels.json.

The accept/review gate is recognize.py's: low confidence -> needs_review,
never a guess. The review tray (serve.py /review) resolves those.

Thread-safety: labels.json updates go through update_labels(), which
holds a process-wide lock and writes atomically (tmp + rename).
"""
import json
import os
import re
import sys
import threading
from datetime import datetime
from hashlib import md5

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import matcher  # noqa: E402
from recognize import recognize, ACCEPT_THRESHOLD  # noqa: E402
from species import display_name  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, ".."))
# same data directory as tank/serve.py (FISH_DATA, default <repo>/data)
DATA_DIR = os.path.abspath(os.environ.get("FISH_DATA", os.path.join(REPO_ROOT, "data")))
QUEUE_DIR = os.path.join(DATA_DIR, "fish")
NORM_DIR = os.path.join(DATA_DIR, "normalized")
LABELS_JSON = os.path.join(DATA_DIR, "labels.json")
REF_DIR = os.path.join(HERE, "references")

# ---- cutout tunables (identical values to the proven v1 ingest) ----
MAX_DIM = 1500              # working size for contour detection
OUTPUT_MAX_DIM = 520        # texture long side (tankful must not OOM the TV)
MIN_FISH_AREA_RATIO = 0.04  # reject specks
MAX_FISH_AREA_RATIO = 0.92  # reject "the whole photo is one contour"

_labels_lock = threading.Lock()
_ref_models = None
_canon_masks = None
_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def _refs():
    """Reference models, loaded once per process."""
    global _ref_models
    if _ref_models is None:
        _ref_models = matcher.load_reference_models(REF_DIR)
    return _ref_models


def _canon():
    """Canonical template silhouettes, loaded once per process."""
    global _canon_masks
    if _canon_masks is None:
        _canon_masks = matcher.load_canonical_masks(REF_DIR)
    return _canon_masks


# --------------------------------------------------------------------------- #
# cutout (ported from v1 src/ingest.py -- the party-proven path)
# --------------------------------------------------------------------------- #
def _resize_max(img, max_dim):
    h, w = img.shape[:2]
    scale = max_dim / max(h, w)
    if scale < 1.0:
        return cv2.resize(img, (int(w * scale), int(h * scale)),
                          interpolation=cv2.INTER_AREA)
    return img


def _find_fish_contour(img_bgr):
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    bin_img = cv2.adaptiveThreshold(blurred, 255,
                                    cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                    cv2.THRESH_BINARY_INV,
                                    blockSize=35, C=8)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    bin_img = cv2.morphologyEx(bin_img, cv2.MORPH_CLOSE, kernel, iterations=2)
    contours, _ = cv2.findContours(bin_img, cv2.RETR_EXTERNAL,
                                   cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    H, W = img_bgr.shape[:2]
    img_area = float(H * W)

    def touches_border(c, margin=4):
        x, y, w, h = cv2.boundingRect(c)
        return (x <= margin or y <= margin
                or (x + w) >= W - margin or (y + h) >= H - margin)

    candidates = []
    for c in contours:
        ratio = float(cv2.contourArea(c)) / img_area
        if ratio < MIN_FISH_AREA_RATIO or ratio > MAX_FISH_AREA_RATIO:
            continue
        if touches_border(c):
            continue
        candidates.append((cv2.contourArea(c), c))
    if not candidates:
        return None
    candidates.sort(key=lambda t: t[0], reverse=True)
    return candidates[0][1]


def _extract_fish_rgba(img_bgr, contour):
    H, W = img_bgr.shape[:2]
    mask = np.zeros((H, W), dtype=np.uint8)
    cv2.drawContours(mask, [contour], -1, 255, thickness=cv2.FILLED)
    mask = cv2.GaussianBlur(mask, (3, 3), 0)
    bgra = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2BGRA)
    bgra[..., 3] = mask
    x, y, w, h = cv2.boundingRect(contour)
    pad = max(6, int(0.02 * max(w, h)))
    x0, y0 = max(0, x - pad), max(0, y - pad)
    x1, y1 = min(W, x + w + pad), min(H, y + h + pad)
    return bgra[y0:y1, x0:x1]


def cutout_from_photo(img_bgr):
    """Photo of a colored sheet -> RGBA cutout of the drawing, or None."""
    img = _resize_max(img_bgr, MAX_DIM)
    contour = _find_fish_contour(img)
    if contour is None:
        return None
    fish = _extract_fish_rgba(img, contour)
    return _resize_max(fish, OUTPUT_MAX_DIM)


# --------------------------------------------------------------------------- #
# labels store (shared with run_batch's output)
# --------------------------------------------------------------------------- #
def load_labels():
    try:
        with open(LABELS_JSON) as f:
            return json.load(f)
    except Exception:
        return {}


def update_labels(fish_id, entry):
    """Set/replace one fish's label entry, atomically, under a lock."""
    if not _ID_RE.match(fish_id):
        raise ValueError("bad fish id")
    with _labels_lock:
        labels = load_labels()
        labels[fish_id] = entry
        tmp = LABELS_JSON + ".tmp"
        with open(tmp, "w") as f:
            json.dump(labels, f, indent=2)
            f.write("\n")
        os.replace(tmp, LABELS_JSON)
    return entry


# Optional guest-given name for a fish ("Léa", "Papa"…). Untrusted free text:
# trimmed, whitespace-collapsed and length-capped here; STORED as a plain string
# and escaped at every render site (never injected as HTML).
NAME_MAX = 40


def clean_name(name):
    """Normalise an untrusted name to a safe stored string (may be empty)."""
    s = " ".join(str(name or "").split())   # trim + collapse internal whitespace
    return s[:NAME_MAX].strip()


def set_fish_name(fish_id, name):
    """Set/clear one existing fish's name (owner edit from the settings page).

    Returns {ok, id, name} or {ok: False, error}. Never raises on bad input.
    """
    if not _ID_RE.match(fish_id):
        return {"ok": False, "error": "bad fish id"}
    clean = clean_name(name)
    with _labels_lock:
        labels = load_labels()
        if fish_id not in labels or not isinstance(labels[fish_id], dict):
            return {"ok": False, "error": "unknown fish"}
        labels[fish_id]["name"] = clean
        tmp = LABELS_JSON + ".tmp"
        with open(tmp, "w") as f:
            json.dump(labels, f, indent=2)
            f.write("\n")
        os.replace(tmp, LABELS_JSON)
    return {"ok": True, "id": fish_id, "name": clean}


# --------------------------------------------------------------------------- #
# the one entry point
# --------------------------------------------------------------------------- #
def ingest_photo(image_bytes, name="", hold=False):
    """Full path: photo bytes -> queued fish + recognition verdict.

    `name` is the optional guest-given name (cleaned + capped, may be empty).
    `hold=True` (a public tank) parks even a confident match in the review tray
    as "needs_review", keeping the recognizer's answer as the suggested species.
    Returns a dict for the upload page:
      {ok, id, species, display, confidence, status, rotation, name}  on success
      {ok: False, error: "..."}                                       on failure
    Never raises on bad input -- uploads are untrusted data.
    """
    name = clean_name(name)
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        return {"ok": False, "error": "could not decode image"}

    fish = cutout_from_photo(img)
    if fish is None:
        return {"ok": False,
                "error": "no drawing found — need the closed black outline "
                         "fully inside the photo, on a light background"}

    res = recognize(fish, _refs(), threshold=ACCEPT_THRESHOLD)

    # canonical pose: bake a "facing right, level" (or upright) copy the tank
    # serves instead of the raw scan. See matcher.canonicalize.
    rotation = 0
    fish_id = (datetime.now().strftime("%Y%m%d-%H%M%S-")
               + md5(image_bytes).hexdigest()[:6])
    os.makedirs(QUEUE_DIR, exist_ok=True)
    os.makedirs(NORM_DIR, exist_ok=True)
    cv2.imwrite(os.path.join(QUEUE_DIR, fish_id + ".png"), fish)
    if res["status"] == "ok":
        out, cmeta = matcher.canonicalize(fish, res["species"], _canon())
        rotation = cmeta["rotation"]
        cv2.imwrite(os.path.join(NORM_DIR, fish_id + ".png"),
                    np.ascontiguousarray(out))
    meta = {
        "id": fish_id,
        "received_at": datetime.now().isoformat(timespec="seconds"),
        "source": "upload",
        "species": res["species"],
        "confidence": res["confidence"],
        "status": "needs_review" if hold else res["status"],
        "name": name,
    }
    with open(os.path.join(QUEUE_DIR, fish_id + ".json"), "w") as f:
        json.dump(meta, f, indent=2)

    status = "needs_review" if hold else res["status"]
    update_labels(fish_id, {
        "species": res["species"],
        "guess": res["species"] or res.get("best_guess"),
        "confidence": res["confidence"],
        "status": status,
        "rotation": rotation,
        "source": "upload",
        "name": name,
    })

    return {
        "ok": True,
        "id": fish_id,
        "species": res["species"],
        "display": res["display"],
        "best_guess": res.get("best_guess"),
        "best_guess_display": res.get("best_guess_display"),
        "confidence": res["confidence"],
        "status": status,
        "rotation": rotation,
        "name": name,
    }


# --------------------------------------------------------------------------- #
# the OTHER entry point: a fish painted in-app (no paper, no camera, no CV)
# --------------------------------------------------------------------------- #
LINEART_DIR = os.path.join(REPO_ROOT, "tank", "static", "lineart")
_silhouettes = {}
_silhouette_lock = threading.Lock()


def _silhouette_mask(species_id):
    """Filled body mask for a template, derived from its line-art overlay.

    The draw page ships us a rectangular canvas; the tank needs a fish-shaped
    texture. The outline itself defines the shape, so: take the line-art alpha
    as ink, flood-fill the paper inward from the border, and everything the
    flood could NOT reach is the creature's interior. mask = interior | ink.

    Cached per species (12 small images, computed once per process).
    """
    with _silhouette_lock:
        if species_id in _silhouettes:
            return _silhouettes[species_id]
        path = os.path.join(LINEART_DIR, species_id + ".png")
        art = cv2.imread(path, cv2.IMREAD_UNCHANGED)
        if art is None or art.ndim != 3 or art.shape[2] != 4:
            _silhouettes[species_id] = None
            return None
        ink = (art[..., 3] > 60).astype(np.uint8) * 255
        # close hairline gaps in the outline, or the flood leaks into the body
        ink = cv2.morphologyEx(
            ink, cv2.MORPH_CLOSE,
            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)), iterations=2)
        h, w = ink.shape
        # 1px border of paper guarantees the flood has somewhere to start even
        # when the outline touches the crop edge
        padded = cv2.copyMakeBorder(ink, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=0)
        ff_mask = np.zeros((h + 4, w + 4), np.uint8)
        cv2.floodFill(padded, ff_mask, (0, 0), 128)
        outside = (padded[1:h + 1, 1:w + 1] == 128)
        mask = np.where(outside, 0, 255).astype(np.uint8)   # interior + ink
        mask = cv2.GaussianBlur(mask, (5, 5), 0)            # soften the edge
        _silhouettes[species_id] = mask
        return mask


def ingest_drawing(png_bytes, species_id, name="", hold=False):
    """In-app painted fish -> queued fish that swims immediately.

    Unlike ingest_photo() there is NO recognition: the guest PICKED the
    template, so the species is known and the fish is written with status "ok"
    straight away -- unless `hold=True` (a public tank), where it waits in the
    review tray as "needs_review". Provenance is recorded as source "draw".
    `name` is the optional guest-given name (free text, cleaned + capped).

    Returns {ok, id, species, display, status, name} or {ok: False, error}.
    Never raises on bad input -- anyone who can reach the tank can POST here.
    """
    status = "needs_review" if hold else "ok"
    from species import ROSTER
    if species_id not in ROSTER:
        return {"ok": False, "error": "unknown species"}
    name = clean_name(name)
    if not png_bytes:
        return {"ok": False, "error": "empty body"}

    arr = np.frombuffer(png_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)
    if img is None:
        return {"ok": False, "error": "could not decode image"}
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGRA)
    elif img.shape[2] == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)

    # Flatten onto WHITE paper. The draw page shows a white sheet and the photo
    # path cuts real (white) paper out of a photo, so an area the guest left
    # uncoloured must come back white -- not see-through. Without this a lightly
    # scribbled fish arrives almost fully transparent and vanishes on the wall.
    a = img[..., 3:4].astype(np.float32) / 255.0
    img[..., :3] = (img[..., :3] * a + 255 * (1 - a)).astype(np.uint8)
    img[..., 3] = 255

    # cut the painted rectangle down to the creature's silhouette so the tank
    # gets a fish-shaped sprite, not a floating rectangle of paint.
    mask = _silhouette_mask(species_id)
    if mask is not None:
        h, w = img.shape[:2]
        m = cv2.resize(mask, (w, h), interpolation=cv2.INTER_AREA)
        img[..., 3] = (img[..., 3].astype(np.float32) * (m / 255.0)).astype(np.uint8)

    # crop away fully-transparent margin, then match the photo path's texture size
    ys, xs = np.where(img[..., 3] > 8)
    if len(xs):
        img = img[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    fish = _resize_max(img, OUTPUT_MAX_DIM)

    fish_id = (datetime.now().strftime("%Y%m%d-%H%M%S-")
               + md5(png_bytes).hexdigest()[:6])
    os.makedirs(QUEUE_DIR, exist_ok=True)
    cv2.imwrite(os.path.join(QUEUE_DIR, fish_id + ".png"), fish)

    meta = {
        "id": fish_id,
        "received_at": datetime.now().isoformat(timespec="seconds"),
        "source": "draw",           # <- distinguishes painted from photographed
        "species": species_id,
        "confidence": 1.0,          # the guest chose it; nothing was guessed
        "status": status,
        "name": name,
    }
    with open(os.path.join(QUEUE_DIR, fish_id + ".json"), "w") as f:
        json.dump(meta, f, indent=2)

    # The drawing is already in the template's canonical pose (the guest painted
    # inside the outline), so there is nothing to re-orient: rotation 0 and no
    # normalized copy -- serve.py falls back to the raw <data>/fish PNG.
    update_labels(fish_id, {
        "species": species_id,
        "confidence": 1.0,
        "status": status,
        "rotation": 0,
        "source": "draw",
        "name": name,
    })

    return {"ok": True, "id": fish_id, "species": species_id,
            "display": display_name(species_id), "status": status, "name": name}


def review_decide(fish_id, species=None, discard=False):
    """Resolve a review-tray fish: assign a species or discard it.

    Also works on an accepted fish (owner overrides a wrong label).
    """
    from species import ROSTER
    if not _ID_RE.match(fish_id):
        return {"ok": False, "error": "bad fish id"}
    labels = load_labels()
    if fish_id not in labels:
        return {"ok": False, "error": "unknown fish"}
    if discard:
        entry = dict(labels[fish_id])
        entry.update(status="discarded", species=None, reviewed=True)
    else:
        if species not in ROSTER:
            return {"ok": False, "error": "unknown species"}
        entry = dict(labels[fish_id])
        entry.update(status="ok", species=species, confidence=1.0,
                     reviewed=True)
        # a review-accepted fish never went through the accept-path canonical
        # pose fix — do it now that we KNOW its template.
        raw = cv2.imread(os.path.join(QUEUE_DIR, fish_id + ".png"),
                         cv2.IMREAD_UNCHANGED)
        # a painted fish was drawn inside the template: already in rest pose
        if entry.get("source") == "draw" and species == labels[fish_id].get("species"):
            raw = None
        if raw is not None and species in _refs():
            out, cmeta = matcher.canonicalize(raw, species, _canon())
            entry["rotation"] = cmeta["rotation"]
            os.makedirs(NORM_DIR, exist_ok=True)
            cv2.imwrite(os.path.join(NORM_DIR, fish_id + ".png"),
                        np.ascontiguousarray(out))
    update_labels(fish_id, entry)
    return {"ok": True, "id": fish_id, "status": entry["status"],
            "species": entry["species"],
            "display": display_name(entry["species"]) if entry["species"] else None}
