"""
End-to-end checks of the three tank modes, against a real serve.py process.

    python3 -m unittest discover -s tests

Each mode gets its own throwaway data directory seeded with one demo fish, so
nothing here touches a real tank. The drawing path needs the recognizer stack
(OpenCV + numpy); without it those tests are skipped, not failed.
"""
import base64
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DEMO = os.path.join(ROOT, "demo", "party")
SERVE = os.path.join(ROOT, "tank", "serve.py")
LINEART = os.path.join(ROOT, "tank", "static", "lineart", "shark.png")

try:
    import cv2  # noqa: F401
    HAVE_CV = True
except Exception:
    HAVE_CV = False


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


class Tank:
    """A serve.py process in one mode, on a fresh data dir with one demo fish."""

    def __init__(self, mode, password="", extra_env=None):
        self.data = tempfile.mkdtemp(prefix="fishparty-test-")
        os.makedirs(os.path.join(self.data, "fish"))
        with open(os.path.join(DEMO, "labels.json")) as f:
            labels = json.load(f)
        fid = sorted(labels)[0]
        shutil.copy(os.path.join(DEMO, "fish", fid + ".png"),
                    os.path.join(self.data, "fish", fid + ".png"))
        with open(os.path.join(self.data, "labels.json"), "w") as f:
            json.dump({fid: labels[fid]}, f)
        self.demo_id = fid
        self.port = free_port()
        env = dict(os.environ, FISH_DATA=self.data, TANK_MODE=mode,
                   ADMIN_PASSWORD=password, SUBMIT_MAX="3",
                   MEMPOOL_API="http://127.0.0.1:9")   # unreachable on purpose
        env.update(extra_env or {})
        self.proc = subprocess.Popen([sys.executable, SERVE, "--port", str(self.port)],
                                     env=env, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL)
        for _ in range(50):
            try:
                socket.create_connection(("127.0.0.1", self.port), 0.2).close()
                break
            except OSError:
                time.sleep(0.1)
        self.password = password

    def req(self, path, data=None, auth=False, method=None):
        r = urllib.request.Request("http://127.0.0.1:%d%s" % (self.port, path),
                                   data=data, method=method)
        if auth:
            tok = base64.b64encode(("admin:" + self.password).encode()).decode()
            r.add_header("Authorization", "Basic " + tok)
        try:
            with urllib.request.urlopen(r, timeout=20) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def json(self, path, **kw):
        code, body = self.req(path, **kw)
        return code, json.loads(body)

    def draw(self, auth=False):
        with open(LINEART, "rb") as f:
            png = f.read()
        return self.json("/api/draw?species=shark&name=Nemo", data=png, auth=auth)

    def close(self):
        self.proc.terminate()
        self.proc.wait(5)
        shutil.rmtree(self.data, ignore_errors=True)


class HomeMode(unittest.TestCase):
    def setUp(self):
        self.t = Tank("home")

    def tearDown(self):
        self.t.close()

    def test_owner_pages_open(self):
        self.assertEqual(self.t.req("/settings")[0], 200)
        self.assertEqual(self.t.req("/review")[0], 200)

    def test_mode_is_injected(self):
        body = self.t.req("/")[1]
        self.assertIn(b'window.TANK_MODE = "home"', body)

    @unittest.skipUnless(HAVE_CV, "recognizer stack not installed")
    def test_drawing_swims_at_once(self):
        code, j = self.t.draw()
        self.assertEqual((code, j["status"]), (200, "ok"))
        ids = [f["id"] for f in self.t.json("/api/fish/manifest")[1]]
        self.assertIn(j["id"], ids)


class BrokenRecognizer(unittest.TestCase):
    """The recognizer crashes (here: OpenCV missing): the visitor gets a plain
    sentence, never the Python error, which can name files and modules."""
    def setUp(self):
        self.fake = tempfile.mkdtemp(prefix="fishparty-nocv-")
        with open(os.path.join(self.fake, "cv2.py"), "w") as f:
            f.write("raise ImportError(\"No module named 'cv2'\")\n")
        self.t = Tank("public", password="s3cret", extra_env={"PYTHONPATH": self.fake})

    def tearDown(self):
        self.t.close()
        shutil.rmtree(self.fake, ignore_errors=True)

    def test_plain_message(self):
        code, j = self.t.draw()
        self.assertFalse(j["ok"])
        self.assertIn("can't take new fish right now", j["error"])
        self.assertNotIn("cv2", j["error"])


class PublicMode(unittest.TestCase):
    def setUp(self):
        self.t = Tank("public", password="s3cret")

    def tearDown(self):
        self.t.close()

    def test_visitor_keeps_the_add_fish_link(self):
        self.assertIn(b'href="draw"', self.t.req("/")[1])

    def test_owner_pages_need_password(self):
        for p in ("/settings", "/review", "/api/review/pending", "/api/fish/catalog"):
            code, _ = self.t.req(p)
            self.assertEqual(code, 401, p)
            self.assertEqual(self.t.req(p, auth=True)[0], 200, p)

    def test_wrong_password_refused(self):
        self.t.password = "nope"
        self.assertEqual(self.t.req("/review", auth=True)[0], 401)

    def test_visitor_cannot_change_settings(self):
        code, _ = self.t.req("/api/settings", data=b'{"fishSize":"xl"}')
        self.assertEqual(code, 401)
        self.assertEqual(self.t.json("/api/settings")[1]["fishSize"], "m")

    def test_visitor_cannot_rename_or_decide(self):
        fid = self.t.demo_id
        self.assertEqual(self.t.req("/api/fish/%s/name" % fid, data=b'{"name":"x"}')[0], 401)
        self.assertEqual(self.t.req("/api/review/decide",
                                    data=json.dumps({"id": fid, "discard": True}).encode())[0], 401)

    def test_demo_fish_visible(self):
        manifest = self.t.json("/api/fish/manifest")[1]
        self.assertEqual([f["id"] for f in manifest], [self.t.demo_id])
        self.assertEqual(self.t.req("/fish/%s.png" % self.t.demo_id)[0], 200)

    @unittest.skipUnless(HAVE_CV, "recognizer stack not installed")
    def test_drawing_waits_for_the_owner(self):
        code, j = self.t.draw()
        self.assertEqual((code, j["status"]), (200, "needs_review"))
        fid = j["id"]
        # not swimming, and its picture is not public yet
        self.assertNotIn(fid, [f["id"] for f in self.t.json("/api/fish/manifest")[1]])
        self.assertEqual(self.t.req("/fish/%s.png" % fid)[0], 404)
        self.assertEqual(self.t.req("/fish/%s.png" % fid, auth=True)[0], 200)
        pending = self.t.json("/api/review/pending", auth=True)[1]
        self.assertEqual([(p["id"], p["species"], p["name"]) for p in pending],
                         [(fid, "shark", "Nemo")])
        # the owner accepts -> it swims
        code, r = self.t.json("/api/review/decide", auth=True,
                              data=json.dumps({"id": fid, "species": "shark"}).encode())
        self.assertEqual((code, r["status"]), (200, "ok"))
        self.assertIn(fid, [f["id"] for f in self.t.json("/api/fish/manifest")[1]])
        self.assertEqual(self.t.req("/fish/%s.png" % fid)[0], 200)

    @unittest.skipUnless(HAVE_CV, "recognizer stack not installed")
    def test_rate_limit(self):
        codes = [self.t.draw()[0] for _ in range(4)]   # SUBMIT_MAX=3 in the test env
        self.assertEqual(codes, [200, 200, 200, 429])

    def test_no_password_means_no_owner(self):
        t = Tank("public", password="")
        try:
            self.assertEqual(t.req("/review", auth=True)[0], 404)
        finally:
            t.close()


class ShowcaseMode(unittest.TestCase):
    def setUp(self):
        self.t = Tank("showcase", password="s3cret")

    def tearDown(self):
        self.t.close()

    def test_read_only(self):
        self.assertEqual(self.t.req("/api/draw?species=shark", data=b"x")[0], 403)
        self.assertEqual(self.t.req("/api/settings", data=b"{}", auth=True)[0], 403)
        for p in ("/draw", "/upload", "/review", "/settings"):
            self.assertEqual(self.t.req(p, auth=True)[0], 404, p)

    def test_no_link_to_pages_it_does_not_have(self):
        body = self.t.req("/")[1]
        self.assertNotIn(b'href="draw"', body)
        self.assertNotIn(b'href="settings"', body)

    def test_fish_swim(self):
        self.assertEqual(len(self.t.json("/api/fish/manifest")[1]), 1)
        self.assertEqual(self.t.req("/")[0], 200)


if __name__ == "__main__":
    unittest.main()
