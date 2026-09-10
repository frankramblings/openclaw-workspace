"""Is real steering available? Two gates: the gateway bundle carries a
claude-cli steer patch, and the session runs on claude-cli. Everything else
keeps the client-side queue, so a message can never be swallowed by a
gateway-initiated follow-up run that the bridge is not relaying.

Two bundle shapes count, because the 2026.9.3 gateway update moved the seam:

  v2 (2026.9.3+, deploy/gateway-patches/claude-cli-steer2.py) - claude-cli is
     an agent RUNTIME inside the embedded run. Both halves must be present:
     the CLI turn's stdin writer AND the embedded queueMessage hook that
     reaches for it. Half of it is worse than none - the gateway would ack a
     steer it then silently queues - so a partial apply reads as unavailable.

  v1 (older installs, claude-cli-steer.py) - claude-cli was a reply BACKEND
     with a `runClaudeLiveSessionTurn`; one marker in that file is the gate."""
from __future__ import annotations

import glob
import os
import time

DEFAULT_DIST = "/usr/lib/node_modules/openclaw/dist"
MARKER = "/*CLI_STEER*/"
NEEDLE = "async function runClaudeLiveSessionTurn"
# v2: (glob, needle that proves THIS edit landed). Both are required.
MARKER2 = "/*CLI_STEER2*/"
V2_EDITS = (
    ("extensions/anthropic/cli.runtime.js", "__OPENCLAW_CLI_STEER ??= new Map()"),
    ("reply-run-registry*.mjs", "__OPENCLAW_CLI_STEER?.get("),
)
STEER_ENDPOINT_IDS = {"claude-cli"}
_CACHE_TTL_S = 60.0
_cache: dict[str, tuple[float, bool]] = {}


def reset_cache() -> None:
    _cache.clear()


def _dist_dir(dist_dir: str | None) -> str:
    return dist_dir or os.environ.get("OPENCLAW_DIST_DIR") or DEFAULT_DIST


def _read(path: str) -> str | None:
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except (OSError, UnicodeDecodeError):
        return None


def _scan_v2(dist_dir: str) -> bool:
    """Every v2 edit is in place (see V2_EDITS)."""
    for pattern, needle in V2_EDITS:
        for path in sorted(glob.glob(os.path.join(dist_dir, pattern))):
            body = _read(path)
            if body and MARKER2 in body and needle in body:
                break
        else:
            return False
    return True


def _scan_v1(dist_dir: str) -> bool:
    for path in sorted(glob.glob(os.path.join(dist_dir, "*.js"))):
        body = _read(path)
        if body is None:
            continue
        if NEEDLE in body:
            return MARKER in body
    return False


def _scan(dist_dir: str) -> bool:
    return _scan_v2(dist_dir) or _scan_v1(dist_dir)


def patch_present(dist_dir: str | None = None) -> bool:
    d = _dist_dir(dist_dir)
    now = time.monotonic()
    hit = _cache.get(d)
    if hit and now - hit[0] < _CACHE_TTL_S:
        return hit[1]
    ok = _scan(d)
    _cache[d] = (now, ok)
    return ok


def capability() -> dict:
    if patch_present():
        return {"available": True, "reason": "", "hint": ""}
    return {"available": False,
            "reason": "gateway patch not installed",
            "hint": "see deploy/gateway-patches/README.md (claude-cli-steer2.py)"}


def session_can_steer(rec: dict | None) -> bool:
    return bool(rec) and (rec.get("endpoint_id") or "") in STEER_ENDPOINT_IDS
