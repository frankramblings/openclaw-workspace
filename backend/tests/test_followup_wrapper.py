"""bin/followup end-to-end against a stub HTTP server: registers, runs the
command, pings complete with the real exit code + output tail, passes the
exit code through, and never blocks the work when the backend is down."""
import json
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs

WRAPPER = str(Path(__file__).resolve().parents[2] / "bin" / "followup")


class _Stub(BaseHTTPRequestHandler):
    calls: list = []

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        form = {k: v[0] for k, v in parse_qs(body.decode()).items()}
        _Stub.calls.append((self.path, form, self.headers.get("X-Workspace-Token")))
        payload = {"id": "p123"} if self.path.endswith("register") else {"ok": True}
        out = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):  # silence test output
        pass


def _serve():
    srv = HTTPServer(("127.0.0.1", 0), _Stub)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def test_wrapper_registers_runs_and_completes():
    _Stub.calls = []
    srv = _serve()
    url = f"http://127.0.0.1:{srv.server_port}"
    r = subprocess.run(
        [sys.executable, WRAPPER, "run", "--url", url, "--token", "tok",
         "--session", "abc123def456", "--label", "render 566",
         "--deadline", "2h", "--",
         sys.executable, "-c", "print('rendered fine'); raise SystemExit(3)"],
        capture_output=True, text=True, timeout=30)
    srv.shutdown()
    assert r.returncode == 3                       # exit code passes through
    assert "rendered fine" in r.stdout             # output still streams
    paths = [c[0] for c in _Stub.calls]
    assert paths == ["/api/followup/register", "/api/followup/complete"]
    reg, comp = _Stub.calls[0][1], _Stub.calls[1][1]
    assert reg == {"session": "abc123def456", "label": "render 566",
                   "deadline_s": "7200"}
    assert comp["id"] == "p123" and comp["exit_code"] == "3"
    assert "rendered fine" in comp["tail"]
    assert _Stub.calls[0][2] == "tok"              # token header sent


def test_wrapper_runs_command_even_when_backend_down():
    r = subprocess.run(
        [sys.executable, WRAPPER, "run", "--url", "http://127.0.0.1:1",
         "--session", "x", "--label", "t", "--",
         sys.executable, "-c", "print('work happened')"],
        capture_output=True, text=True, timeout=60)
    assert r.returncode == 0
    assert "work happened" in r.stdout
    assert "could not register" in r.stderr.lower()
