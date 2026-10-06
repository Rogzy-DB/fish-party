#!/usr/bin/env python3
"""
Build the showcase site for a server where the tanks live on their OWN address.

    python3 tools/build-site.py dist --tanks https://fishtank.example.org/

Copies site-v2/ into <dist> (links resolved: templates/ and outlines/ become real
files) and points every link to the tanks at that address:

    tank/...   -> <tanks>...        (the shared tank sits at the root there)
    party/...  -> <tanks>party/...  (the read-only party tank)

Without --tanks the copy keeps the same-domain layout of tools/dev.py and
deploy/Caddyfile.example (/tank/ and /party/ next to the site).
Python stdlib only.
"""
import argparse
import os
import re
import shutil

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SITE = os.path.join(ROOT, "site-v2")


def rewrite(text, tanks):
    # href="tank/x" · href="../tank/x" · src="party/?embed" · fetch("../tank/api/...")
    text = re.sub(r'(["(])(?:\.\./)*tank/', lambda m: m.group(1) + tanks, text)
    text = re.sub(r'(["(])(?:\.\./)*party/', lambda m: m.group(1) + tanks + "party/", text)
    return text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dist")
    ap.add_argument("--tanks", help="absolute URL of the tanks, ending with /")
    a = ap.parse_args()
    if a.tanks and not (a.tanks.startswith("https://") and a.tanks.endswith("/")):
        raise SystemExit("--tanks must be an https:// URL ending with /")
    if os.path.exists(a.dist):
        shutil.rmtree(a.dist)
    shutil.copytree(SITE, a.dist, symlinks=False)
    n = 0
    for d, _, files in os.walk(a.dist):
        for f in files:
            if not f.endswith(".html"):
                continue
            p = os.path.join(d, f)
            s = open(p, encoding="utf-8").read()
            t = rewrite(s, a.tanks) if a.tanks else s
            if t != s:
                open(p, "w", encoding="utf-8").write(t)
                n += 1
    print("site -> %s (%d pages point at %s)" % (a.dist, n, a.tanks or "/tank/ and /party/"))


if __name__ == "__main__":
    main()
