"""garyimg helper: deterministic no-network guard paths (usage / missing env)."""
import os
import shutil
import subprocess
from pathlib import Path

import pytest

HELPER = Path(__file__).resolve().parents[2] / "scripts" / "garyimg"

# Resolve node's real location portably (works with nvm, Homebrew, CI, etc.).
# If node isn't available at all, skip the whole module rather than fail.
_node_bin = shutil.which("node")
if _node_bin is None:
    pytest.skip("node not found — skipping garyimg tests", allow_module_level=True)

# Build a minimal hermetic PATH: node's directory + standard system dirs.
# This strips OPENCLAW_SESSION_KEY and other ambient variables from the env.
_NODE_PATH = os.path.dirname(_node_bin) + ":/usr/bin:/bin"


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
