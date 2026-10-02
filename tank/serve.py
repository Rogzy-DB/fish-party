#!/usr/bin/env python3
"""
Fish Party — the tank server. Python stdlib only (the recognizer adds OpenCV).

Serves the tank page, the guests' fish, the phone pages (draw / upload /
settings / review) and, so the browser never hits a CORS wall, proxies the two
mempool endpoints the bubbles need:
    GET /api/mempool/recent      -> <MEMPOOL_API>/api/v1/mempool/recent
    GET /api/mempool/tip-height  -> <MEMPOOL_API>/api/v1/blocks/tip/height
If the mempool API is unreachable the renderer falls back to mock bubbles.

Three modes (TANK_MODE), one codebase:
  home      the party at home: anyone on your network draws and the fish swims
            at once; settings and review are open. The default.
  public    a tank on the internet: every new fish waits in the review tray
            until the owner accepts it; settings, review and the full catalog
            need ADMIN_PASSWORD (HTTP Basic, user "admin"); submissions are
            rate-limited per visitor.
  showcase  read-only: the fish swim, nobody adds or changes anything.

Configuration (environment):
  FISH_DATA       data directory (fish/, normalized/, labels.json,
                  settings.json). Default: <repo>/data
  TANK_MODE       home | public | showcase  (default home)
  ADMIN_PASSWORD  required for the owner pages in public mode
  MEMPOOL_API     default https://mempool.space
  TRUST_PROXY=1   take the visitor IP from X-Forwarded-For (behind Caddy/nginx)

Usage:
    python3 serve.py [--port 8785] [--host 127.0.0.1] [--mempool URL]
"""
import argparse
import base64
import hmac
import json
import os
import re
import sys
import threading
import time
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, ".."))
DEFAULT_MEMPOOL = os.environ.get("MEMPOOL_API", "https://mempool.space")

MODE = os.environ.get("TANK_MODE", "home")
if MODE not in ("home", "public", "showcase"):
    sys.exit("TANK_MODE must be home, public or showcase (got %r)" % MODE)
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
TRUST_PROXY = os.environ.get("TRUST_PROXY") == "1"

# All mutable state lives in ONE data directory, so a fork is "copy the repo,
# point FISH_DATA somewhere, run":
#   fish/<id>.png + <id>.json   the cut-out coloured drawing (transparent bg)
#   normalized/<id>.png         orientation-corrected copy (preferred if present)
#   labels.json                 {id: {species, confidence, status, name, ...}}
#   settings.json               the phone-as-remote store
DATA_DIR = os.path.abspath(os.environ.get("FISH_DATA", os.path.join(REPO_ROOT, "data")))
FISH_DIR = os.path.join(DATA_DIR, "fish")
NORM_DIR = os.path.join(DATA_DIR, "normalized")
LABELS_JSON = os.path.join(DATA_DIR, "labels.json")
RECOGNIZER_DIR = os.path.join(REPO_ROOT, "recognizer")


def fish_png_path(fid):
    """Disk path for a fish drawing: normalized copy first, else raw scan."""
    for d in (NORM_DIR, FISH_DIR):
        p = os.path.join(d, fid + ".png")
        if os.path.isfile(p):
            return p
    return None
# status values that mean "recognized, ready to swim" (exclude needs_review)
ACCEPTED_STATUS = {"ok", "accepted"}
_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")  # fish ids are timestamp-hash slugs


# ---------------- server-side settings (the phone-as-remote store) ----------
# The wall tank is chrome-free; a phone at /settings edits these and the
# projector reads them every poll cycle. Small MUTABLE runtime state — same tier
# as the fish and their labels — so it's gitignored and SEEDED here in code, i.e.
# a fresh checkout gets working defaults with no settings.json on disk.
SETTINGS_JSON = os.path.join(DATA_DIR, "settings.json")
# fishSize is a PRESET enum, never a free float. Each preset -> a GLOBAL body-size
# multiplier applied on top of the existing mobile/desktop fish scale. "m" = 1.0 =
# the current default projector look (pixel-identical at defaults).
FISH_SIZE_PRESETS = {"xs": 0.5, "s": 0.75, "m": 1.0, "l": 1.4, "xl": 2.0}
DEFAULT_SETTINGS = {"fishSize": "m", "soundOn": False, "volume": 0.6, "hidden": []}
_settings_lock = threading.Lock()

# lazy species-name lookup (needs the recognizer dir on sys.path; imported on
# first use so the tank still serves if that venv is broken)
_species_mod = None


def _display_name(sid):
    global _species_mod
    if _species_mod is None:
        try:
            sys.path.insert(0, RECOGNIZER_DIR)
            import species as _sp
            _species_mod = _sp
        except Exception:
            _species_mod = False
    if _species_mod:
        try:
            return _species_mod.display_name(sid)
        except Exception:
            pass
    return sid or "unknown"


def _load_labels():
    try:
        labels = json.load(open(LABELS_JSON))
    except Exception:
        return {}
    return labels if isinstance(labels, dict) else {}


def _known_fish_ids():
    """Every fish id in the labels DB (any status) — the validation universe for
    hidden-ids and the source set for the catalog."""
    try:
        labels = json.load(open(LABELS_JSON))
    except Exception:
        return set()
    return {fid for fid, m in labels.items()
            if isinstance(m, dict) and _ID_RE.match(fid)}


def _sanitize_settings(raw):
    """Coerce a possibly-partial/hand-edited dict onto the defaults. NEVER raises
    — used when READING the store, so a dirty file can't crash the tank."""
    s = dict(DEFAULT_SETTINGS)
    if isinstance(raw, dict):
        if raw.get("fishSize") in FISH_SIZE_PRESETS:
            s["fishSize"] = raw["fishSize"]
        s["soundOn"] = bool(raw.get("soundOn", s["soundOn"]))
        try:
            s["volume"] = max(0.0, min(1.0, float(raw.get("volume", s["volume"]))))
        except (TypeError, ValueError):
            pass
        h = raw.get("hidden")
        if isinstance(h, list):
            s["hidden"] = sorted({str(x) for x in h if _ID_RE.match(str(x))})
    return s


def _write_settings(s):
    tmp = SETTINGS_JSON + ".tmp"
    with open(tmp, "w") as f:
        json.dump(s, f, indent=2)
    os.replace(tmp, SETTINGS_JSON)


def _read_settings_nolock():
    try:
        raw = json.load(open(SETTINGS_JSON))
    except Exception:
        raw = None
    s = _sanitize_settings(raw)
    if raw is None:
        _write_settings(s)   # seed the file on first read
    return s


def load_settings():
    with _settings_lock:
        return _read_settings_nolock()


def settings_view(s):
    """The wire shape both GET and POST /api/settings return: the stored fields
    plus the DERIVED body-size multiplier and the preset table, so the renderer
    needs no hardcoded copy and the phone UI can build the size buttons."""
    return {
        "fishSize": s["fishSize"],
        "fishSizeMultiplier": FISH_SIZE_PRESETS[s["fishSize"]],
        "soundOn": s["soundOn"],
        "volume": s["volume"],
        "hidden": s["hidden"],
        "presets": FISH_SIZE_PRESETS,
    }


def build_manifest():
    """Join <data>/fish/ with labels.json -> [{id, species, texture_url}].

    Only accepted fish with a real PNG on disk and a species in the 12-set are
    included. Texture URLs are RELATIVE so the page works behind a reverse
    proxy that strips a path prefix (e.g. /tank/).
    """
    try:
        labels = json.load(open(LABELS_JSON))
    except Exception:
        return []
    hidden = set(load_settings()["hidden"])   # phone-deselected fish stop swimming
    out = []
    for fid, meta in labels.items():
        if not isinstance(meta, dict):
            continue
        if fid in hidden:
            continue
        if meta.get("status") not in ACCEPTED_STATUS:
            continue
        species = meta.get("species")
        if not species:
            continue
        if not _ID_RE.match(fid):
            continue
        if fish_png_path(fid) is None:
            continue
        out.append({
            "id": fid,
            "species": species,
            "confidence": meta.get("confidence"),
            "name": meta.get("name") or "",
            "texture_url": "fish/" + fid + ".png",
        })
    out.sort(key=lambda f: f["id"])
    return out

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".css": "text/css; charset=utf-8",
    ".map": "application/json",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".wav": "audio/wav",
}

# Upload/review need the recognizer stack (cv2 + numpy). Imported LAZILY on
# first use so the tank still serves if the recognizer venv is broken.
_ingest = None


def get_ingest():
    global _ingest
    if _ingest is None:
        sys.path.insert(0, RECOGNIZER_DIR)
        import ingest as _mod
        _ingest = _mod
    return _ingest


MAX_UPLOAD_BYTES = 16 * 1024 * 1024  # phone photos are ~3-8 MB

# --------------------------- public-mode guards ------------------------------
# Owner-only routes. In home mode they are open (it's your own party); in
# public mode they need ADMIN_PASSWORD; in showcase mode they don't exist.
ADMIN_PAGES = {"/review", "/review.html", "/settings", "/settings.html"}
ADMIN_GET_API = {"/api/review/pending", "/api/fish/catalog"}
GUEST_PAGES = {"/draw", "/draw.html", "/upload", "/upload.html"}

# A stranger may add SUBMIT_MAX fish per SUBMIT_WINDOW seconds, and the review
# tray never holds more than PENDING_MAX fish: past that, new ones are refused
# until the owner catches up. Keeps one bored visitor from flooding the tray.
SUBMIT_MAX = int(os.environ.get("SUBMIT_MAX", "6"))
SUBMIT_WINDOW = 3600
PENDING_MAX = int(os.environ.get("PENDING_MAX", "300"))
_submits = {}
_submits_lock = threading.Lock()


def submit_allowed(ip, now=None):
    """Sliding-window rate limit per visitor IP. Records the hit when allowed."""
    now = time.time() if now is None else now
    with _submits_lock:
        hits = [t for t in _submits.get(ip, []) if now - t < SUBMIT_WINDOW]
        if len(hits) >= SUBMIT_MAX:
            _submits[ip] = hits
            return False
        hits.append(now)
        _submits[ip] = hits
        if len(_submits) > 10000:          # forget idle visitors, bound memory
            for k in [k for k, v in _submits.items() if not v or now - v[-1] > SUBMIT_WINDOW]:
                del _submits[k]
        return True


def pending_count():
    try:
        labels = json.load(open(LABELS_JSON))
    except Exception:
        return 0
    return sum(1 for m in labels.values()
               if isinstance(m, dict) and m.get("status") == "needs_review")


# Every open tank polls the mempool every few seconds; with many visitors the
# server would hammer the upstream. One shared answer per CACHE_TTL is plenty.
CACHE_TTL = 3.0
_cache = {}
_cache_lock = threading.Lock()


def cached_fetch(url):
    """(status, bytes) for url, shared across visitors for CACHE_TTL seconds."""
    now = time.time()
    with _cache_lock:
        hit = _cache.get(url)
        if hit and now - hit[0] < CACHE_TTL:
            return hit[1], hit[2]
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "fish-party"})
        with urllib.request.urlopen(req, timeout=4) as r:
            res = (200, r.read())
    except Exception as e:
        res = (503, json.dumps({"error": str(e)}).encode())
    with _cache_lock:
        _cache[url] = (now, res[0], res[1])
    return res


class Handler(BaseHTTPRequestHandler):
    mempool_api = DEFAULT_MEMPOOL

    def log_message(self, *a):
        pass  # quiet

    def _send(self, code, body, ctype, extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _proxy(self, upstream, ctype):
        code, body = cached_fetch(upstream)
        # 503 -> renderer treats as disconnected and mocks
        self._send(code, body, ctype if code == 200 else "application/json")

    def _json(self, code, obj):
        return self._send(code, json.dumps(obj), "application/json")

    def _client_ip(self):
        if TRUST_PROXY:
            fwd = self.headers.get("X-Forwarded-For", "")
            if fwd:
                return fwd.split(",")[0].strip()
        return self.client_address[0]

    def _is_admin(self):
        """Owner check. home: everyone is the owner. public: HTTP Basic with
        ADMIN_PASSWORD (no password set = nobody). showcase: nobody."""
        if MODE == "home":
            return True
        if MODE == "showcase" or not ADMIN_PASSWORD:
            return False
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Basic "):
            return False
        try:
            user, _, pw = base64.b64decode(auth[6:]).decode("utf-8").partition(":")
        except Exception:
            return False
        return user == "admin" and hmac.compare_digest(pw.encode(), ADMIN_PASSWORD.encode())

    def _deny_admin(self):
        """401 that makes the browser show its login box (public mode only)."""
        if MODE == "public" and ADMIN_PASSWORD:
            return self._send(401, "owner only", "text/plain",
                              extra={"WWW-Authenticate": 'Basic realm="fish-party owner"'})
        return self._send(404, "not found", "text/plain")

    def do_GET(self):
        path = self.path.split("?", 1)[0]

        if (path in ADMIN_PAGES or path in ADMIN_GET_API) and not self._is_admin():
            return self._deny_admin()
        if MODE == "showcase" and path in GUEST_PAGES:
            return self._send(404, "not found", "text/plain")

        # --- mempool proxy ---
        if path == "/api/mempool/recent":
            return self._proxy(self.mempool_api + "/api/v1/mempool/recent", "application/json")
        if path == "/api/mempool/tip-height":
            return self._proxy(self.mempool_api + "/api/v1/blocks/tip/height", "text/plain")

        # --- health: {rev, summary}; rev = block height, summary = a short line
        # for a dashboard tile or an uptime check ---
        if path == "/status.json":
            n = len(build_manifest())
            rev = 0
            code, body = cached_fetch(self.mempool_api + "/api/v1/blocks/tip/height")
            if code == 200:
                try:
                    rev = int(body.decode().strip())
                except ValueError:
                    pass
            summary = "%d fish" % n + (" · block %s" % format(rev, ",") if rev else "")
            return self._send(200, json.dumps({"rev": rev, "summary": summary}),
                              "application/json")

        # --- real fish manifest (the actual guest drawings + their species) ---
        if path == "/api/fish/manifest":
            return self._send(200, json.dumps(build_manifest()), "application/json")

        # --- settings: the phone-as-remote store the projector reads ---
        if path == "/api/settings":
            return self._send(200, json.dumps(settings_view(load_settings())),
                              "application/json")

        # --- full fish DATABASE for the management UI: every fish regardless of
        # status (distinct from /api/fish/manifest = only the swimming subset). ---
        if path == "/api/fish/catalog":
            try:
                labels = json.load(open(LABELS_JSON))
            except Exception:
                labels = {}
            hidden = set(load_settings()["hidden"])
            out = []
            for fid, meta in labels.items():
                if not isinstance(meta, dict) or not _ID_RE.match(fid):
                    continue
                if fish_png_path(fid) is None:
                    continue
                species = meta.get("species")
                status = meta.get("status")
                eligible = status in ACCEPTED_STATUS   # can this fish ever swim?
                out.append({
                    "id": fid,
                    "species": species,
                    "display": _display_name(species),
                    "name": meta.get("name") or "",
                    "source": meta.get("source") or "upload",
                    "status": status,
                    "thumb": "fish/" + fid + ".png",
                    "eligible": eligible,
                    "hidden": fid in hidden,
                    "swimming": eligible and fid not in hidden,
                })
            out.sort(key=lambda f: f["id"])
            return self._send(200, json.dumps(out), "application/json")

        # --- review tray: fish below the confidence gate, awaiting a human ---
        if path == "/api/review/pending":
            try:
                labels = json.load(open(LABELS_JSON))
            except Exception:
                labels = {}
            pending = []
            for fid, meta in labels.items():
                if not isinstance(meta, dict) or not _ID_RE.match(fid):
                    continue
                if meta.get("status") != "needs_review":
                    continue
                if fish_png_path(fid) is None:
                    continue
                pending.append({"id": fid,
                                "confidence": meta.get("confidence"),
                                "species": meta.get("species") or meta.get("guess"),
                                "name": meta.get("name") or "",
                                "source": meta.get("source") or "upload",
                                "image_url": "fish/" + fid + ".png"})
            pending.sort(key=lambda f: f["id"])
            return self._send(200, json.dumps(pending), "application/json")

        # pretty routes for the two operator pages
        if path == "/upload":
            path = "/upload.html"
        elif path == "/review":
            path = "/review.html"
        elif path == "/draw":
            path = "/draw.html"
        elif path == "/settings":
            path = "/settings.html"

        # --- real fish textures, served read-only straight from <data>/fish/ ---
        if path.startswith("/fish/"):
            fid = path[len("/fish/"):]
            if fid.endswith(".png"):
                fid = fid[:-4]
            if not _ID_RE.match(fid):
                return self._send(404, "not found", "text/plain")
            fp = fish_png_path(fid)
            if fp is None:
                return self._send(404, "not found", "text/plain")
            # outside home mode a visitor only ever sees ACCEPTED fish: a drawing
            # waiting in the review tray is the owner's to look at first.
            if MODE != "home" and not self._is_admin():
                meta = _load_labels().get(fid)
                if not isinstance(meta, dict) or meta.get("status") not in ACCEPTED_STATUS:
                    return self._send(404, "not found", "text/plain")
            with open(fp, "rb") as f:
                return self._send(200, f.read(), "image/png")

        # --- blank colouring templates (the 12 outlines guests print+colour),
        # served straight from the recognizer's reference set ---
        if path.startswith("/templates/"):
            tid = path[len("/templates/"):]
            if tid.endswith(".png"):
                tid = tid[:-4]
            if not _ID_RE.match(tid):
                return self._send(404, "not found", "text/plain")
            tp = os.path.join(RECOGNIZER_DIR, "references", tid + ".png")
            if not os.path.isfile(tp):
                return self._send(404, "not found", "text/plain")
            # served inline so it doubles as the thumbnail; the page's <a download>
            # forces the save when the user actually wants the file.
            with open(tp, "rb") as f:
                return self._send(200, f.read(), "image/png")

        # --- static ---
        if path == "/":
            path = "/index.html"
        fs = os.path.normpath(os.path.join(HERE, path.lstrip("/")))
        if not fs.startswith(HERE) or not os.path.isfile(fs):
            return self._send(404, "not found", "text/plain")

        ext = os.path.splitext(fs)[1]
        ctype = MIME.get(ext, "application/octet-stream")

        # Range request (audio/video streaming): honour a single byte range so
        # media elements can stream/seek instead of buffering the whole file.
        rng = self.headers.get("Range")
        fsize = os.path.getsize(fs)
        if rng and rng.startswith("bytes="):
            try:
                s_txt, e_txt = rng[6:].split("-", 1)
                start = int(s_txt) if s_txt else 0
                end = int(e_txt) if e_txt else fsize - 1
                end = min(end, fsize - 1)
                if start > end or start >= fsize:
                    raise ValueError
            except ValueError:
                self.send_response(416)
                self.send_header("Content-Range", "bytes */%d" % fsize)
                self.end_headers()
                return
            with open(fs, "rb") as f:
                f.seek(start)
                chunk = f.read(end - start + 1)
            self.send_response(206)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, fsize))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(len(chunk)))
            self.end_headers()
            self.wfile.write(chunk)
            return

        with open(fs, "rb") as f:
            data = f.read()
        # inject this server's origin as the mempool base so the JS uses the proxy
        if fs.endswith("index.html"):
            origin = ""  # same-origin: JS builds full paths off this
            data = data.replace(b"MEMPOOL_API_PLACEHOLDER", origin.encode())
        if fs.endswith(".html"):
            data = data.replace(b"TANK_MODE_PLACEHOLDER", MODE.encode())
        self._send(200, data, ctype, extra={"Accept-Ranges": "bytes"})

    def _read_body(self):
        try:
            n = int(self.headers.get("Content-Length", 0))
        except ValueError:
            return None
        if n <= 0 or n > MAX_UPLOAD_BYTES:
            return None
        return self.rfile.read(n)

    def _name_param(self):
        """Optional fish name for /api/draw and /api/upload — the image bytes are
        the body, so the name rides in the query string (?name=) or X-Name header.
        Returned raw; ingest.clean_name() trims/caps/normalises it."""
        from urllib.parse import parse_qs, unquote
        q = self.path.split("?", 1)
        name = ""
        if len(q) == 2:
            name = (parse_qs(q[1]).get("name") or [""])[0]
        hdr = self.headers.get("X-Name")
        if hdr:
            name = unquote(hdr)
        return name

    def do_POST(self):
        path = self.path.split("?", 1)[0]

        if MODE == "showcase":
            return self._json(403, {"ok": False, "error": "this tank is read-only"})
        if path in ("/api/upload", "/api/draw"):
            if MODE == "public":
                if not submit_allowed(self._client_ip()):
                    return self._json(429, {"ok": False, "error":
                        "That's a lot of fish! Try again in a little while."})
                if pending_count() >= PENDING_MAX:
                    return self._json(503, {"ok": False, "error":
                        "The review tray is full. Come back tomorrow."})
        elif not self._is_admin():
            return self._deny_admin()
        # public: a new fish waits for the owner; home: it swims at once
        hold = MODE == "public"

        # --- add-a-fish: raw image bytes in the body (page JS sends the file
        # directly, no multipart parsing needed) ---
        if path == "/api/upload":
            body = self._read_body()
            if body is None:
                return self._send(400, '{"ok":false,"error":"missing or oversized body"}',
                                  "application/json")
            name = self._name_param()
            try:
                res = get_ingest().ingest_photo(body, name, hold=hold)
            except Exception as e:
                res = {"ok": False, "error": "ingest failed: %s" % e}
            return self._send(200 if res.get("ok") else 422,
                              json.dumps(res), "application/json")

        # --- painted-in-app fish: the phone colorer (draw.html) posts the
        # flattened canvas PNG. Species is CHOSEN, not recognized, so in home
        # mode it skips CV + the review tray and swims immediately (public mode
        # holds it for the owner). Body cap is the same 16MB as /api/upload; the
        # species id is validated against the roster in ingest_drawing.
        if path == "/api/draw":
            species = ""
            q = self.path.split("?", 1)
            if len(q) == 2:
                from urllib.parse import parse_qs
                species = (parse_qs(q[1]).get("species") or [""])[0]
            species = self.headers.get("X-Species") or species
            name = self._name_param()
            body = self._read_body()
            if body is None:
                return self._send(400, '{"ok":false,"error":"missing or oversized body"}',
                                  "application/json")
            try:
                res = get_ingest().ingest_drawing(body, species, name, hold=hold)
            except Exception as e:
                res = {"ok": False, "error": "draw ingest failed: %s" % e}
            return self._send(200 if res.get("ok") else 422,
                              json.dumps(res), "application/json")

        # --- rename a fish (owner edit from the settings catalog) ---
        # POST /api/fish/<id>/name  body {"name": "..."}  (name may be empty=clear)
        m = re.match(r"^/api/fish/([A-Za-z0-9_-]+)/name$", path)
        if m:
            fid = m.group(1)
            body = self._read_body()
            try:
                req = json.loads(body or b"{}")
                res = get_ingest().set_fish_name(fid, req.get("name", ""))
            except Exception as e:
                res = {"ok": False, "error": str(e)}
            return self._send(200 if res.get("ok") else 422,
                              json.dumps(res), "application/json")

        # --- settings patch (the phone edits, projector reads next poll) ---
        # Strict validation (422 on bad input) — distinct from the lenient read
        # path. Accepts a partial patch of {fishSize, soundOn, volume, hidden}.
        if path == "/api/settings":
            body = self._read_body()
            try:
                patch = json.loads(body or b"{}")
                if not isinstance(patch, dict):
                    raise ValueError("body must be a JSON object")
            except Exception as e:
                return self._send(400, json.dumps({"ok": False, "error": str(e)}),
                                  "application/json")
            updates = {}
            if "fishSize" in patch:
                if patch["fishSize"] not in FISH_SIZE_PRESETS:
                    return self._send(422, json.dumps(
                        {"ok": False, "error": "unknown fishSize preset: %r" % patch["fishSize"]}),
                        "application/json")
                updates["fishSize"] = patch["fishSize"]
            if "soundOn" in patch:
                updates["soundOn"] = bool(patch["soundOn"])
            if "volume" in patch:
                try:
                    v = float(patch["volume"])
                except (TypeError, ValueError):
                    return self._send(422, json.dumps(
                        {"ok": False, "error": "volume must be a number"}), "application/json")
                updates["volume"] = max(0.0, min(1.0, v))   # clamp 0..1
            if "hidden" in patch:
                h = patch["hidden"]
                if not isinstance(h, list):
                    return self._send(422, json.dumps(
                        {"ok": False, "error": "hidden must be a list of fish ids"}),
                        "application/json")
                known = _known_fish_ids()
                ids = []
                for x in h:
                    x = str(x)
                    if not _ID_RE.match(x) or x not in known:
                        return self._send(422, json.dumps(
                            {"ok": False, "error": "unknown fish id: %s" % x}), "application/json")
                    ids.append(x)
                updates["hidden"] = sorted(set(ids))
            with _settings_lock:
                s = _read_settings_nolock()
                s.update(updates)
                _write_settings(s)
                view = settings_view(s)
            return self._send(200, json.dumps({"ok": True, **view}), "application/json")

        # --- review decision: {"id": ..., "species": ...} or {"id":..., "discard": true} ---
        if path == "/api/review/decide":
            body = self._read_body()
            try:
                req = json.loads(body or b"{}")
                fid = str(req.get("id", ""))
                res = get_ingest().review_decide(
                    fid, species=req.get("species"),
                    discard=bool(req.get("discard")))
            except Exception as e:
                res = {"ok": False, "error": str(e)}
            return self._send(200 if res.get("ok") else 422,
                              json.dumps(res), "application/json")

        self._send(404, "not found", "text/plain")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8785)
    ap.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    ap.add_argument("--mempool", default=DEFAULT_MEMPOOL)
    args = ap.parse_args()
    if MODE == "public" and not ADMIN_PASSWORD:
        print("!! public mode without ADMIN_PASSWORD: fish will queue for review "
              "but nobody can accept them", file=sys.stderr)
    os.makedirs(FISH_DIR, exist_ok=True)
    Handler.mempool_api = args.mempool.rstrip("/")
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Fish Party tank ({MODE}): http://{args.host}:{args.port}/  "
          f"data={DATA_DIR}  mempool={args.mempool}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
