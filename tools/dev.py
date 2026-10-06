#!/usr/bin/env python3
"""
Run the whole Fish Party website on your own machine, the way it runs online:

    /          the showcase site            (site/)
    /party/    our party tank, read-only    (TANK_MODE=showcase, demo/party)
    /tank/     the shared tank              (TANK_MODE=public,  data/commons)

    ADMIN_PASSWORD=pick-one python3 tools/dev.py [--port 8810]

Then open http://127.0.0.1:8810/ . The owner pages of the shared tank
(/tank/review, /tank/settings) ask for user "admin" + that password.

This is a development helper: online, Caddy (or nginx) does this routing,
see docs/DEPLOY.md. Python stdlib only.
"""
import argparse
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SITE = os.path.join(ROOT, "site")
SERVE = os.path.join(ROOT, "tank", "serve.py")
TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "application/javascript",
         ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
         ".svg": "image/svg+xml", ".pdf": "application/pdf", ".ico": "image/x-icon",
         ".mp4": "video/mp4", ".webm": "video/webm"}


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def start_tank(mode, data, port):
    env = dict(os.environ, TANK_MODE=mode, FISH_DATA=data)
    return subprocess.Popen([sys.executable, SERVE, "--port", str(port)], env=env)


class Proxy(BaseHTTPRequestHandler):
    routes = {}   # prefix -> port

    def log_message(self, *a):
        pass

    def _forward(self):
        for prefix, port in self.routes.items():
            if self.path == prefix.rstrip("/"):
                self.send_response(308)
                self.send_header("Location", prefix)
                self.end_headers()
                return True
            if self.path.startswith(prefix):
                n = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(n) if n else None
                req = urllib.request.Request(
                    "http://127.0.0.1:%d/%s" % (port, self.path[len(prefix):]),
                    data=body, method=self.command)
                for h in ("Content-Type", "Authorization", "Range", "X-Name", "X-Species"):
                    if self.headers.get(h):
                        req.add_header(h, self.headers[h])
                req.add_header("X-Forwarded-For", self.client_address[0])
                try:
                    r = urllib.request.urlopen(req, timeout=60)
                except urllib.error.HTTPError as e:
                    r = e
                data = r.read()
                self.send_response(r.status if hasattr(r, "status") else r.code)
                for k, v in r.headers.items():
                    if k.lower() not in ("transfer-encoding", "connection", "content-length", "date", "server"):
                        self.send_header(k, v)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return True
        return False

    def do_POST(self):
        if not self._forward():
            self.send_error(404)

    def do_GET(self):
        if self._forward():
            return
        path = self.path.split("?", 1)[0]
        if path.endswith("/"):
            path += "index.html"
        fs = os.path.realpath(os.path.join(SITE, path.lstrip("/")))
        if not (fs.startswith(SITE) or fs.startswith(ROOT)) or not os.path.isfile(fs):
            page = os.path.join(SITE, "404.html")   # the site's own "lost at sea" page, as Caddy serves it
            if not os.path.isfile(page):
                return self.send_error(404)
            with open(page, "rb") as f:
                data = f.read()
            self.send_response(404)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        with open(fs, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", TYPES.get(os.path.splitext(fs)[1], "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8810)
    ap.add_argument("--host", default="127.0.0.1", help="address to listen on (default: this machine only)")
    ap.add_argument("--site", default="site", help="folder of the showcase site, relative to the repo (default: site)")
    args = ap.parse_args()
    global SITE
    SITE = os.path.join(ROOT, args.site)

    # the party tank runs on a COPY of the demo, so nothing writes into the repo
    party = os.path.join(ROOT, "data", "party")
    if not os.path.isdir(party):
        shutil.copytree(os.path.join(ROOT, "demo", "party"), party)
    commons = os.path.join(ROOT, "data", "commons")
    os.makedirs(commons, exist_ok=True)

    p1, p2 = free_port(), free_port()
    procs = [start_tank("showcase", party, p1), start_tank("public", commons, p2)]
    Proxy.routes = {"/party/": p1, "/tank/": p2}
    time.sleep(0.5)
    srv = ThreadingHTTPServer((args.host, args.port), Proxy)
    print("Fish Party: http://%s:%d/" % (args.host, args.port))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        for p in procs:
            p.terminate()


if __name__ == "__main__":
    main()
