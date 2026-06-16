"""garyimg helper: deterministic no-network guard paths (usage / missing env)."""
import subprocess
from pathlib import Path

HELPER = Path(__file__).resolve().parents[2] / "scripts" / "garyimg"

# Minimal PATH that includes node (at /usr/local/bin on this host) but strips
# any OPENCLAW_SESSION_KEY or other ambient variables — keeps tests hermetic.
_NODE_PATH = "/usr/local/bin:/usr/bin:/bin"


def _run(args, env):
    return subprocess.run(["node", str(HELPER), *args], env=env,
                          capture_output=True, text=True)


def test_missing_env_exits_2():
    r = _run(["gary.png"], env={"PATH": _NODE_PATH})
    assert r.returncode == 2
    assert "OPENCLAW_SESSION_KEY" in r.stderr


def test_missing_arg_exits_2():
    r = _run([], env={"PATH": _NODE_PATH, "OPENCLAW_SESSION_KEY": "k"})
    assert r.returncode == 2
    assert "usage" in r.stderr.lower()
