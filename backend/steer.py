"""Is real steering available? Two gates: the gateway bundle carries the
claude-cli steer patch (deploy/gateway-patches/claude-cli-steer.py), and the
session runs on claude-cli. Everything else keeps the client-side queue, so a
message can never be swallowed by a gateway-initiated follow-up run that the
bridge is not relaying."""
from __future__ import annotations

import glob
import os
import time

DEFAULT_DIST = "/usr/lib/node_modules/openclaw/dist"
MARKER = "/*CLI_STEER*/"
NEEDLE = "async function runClaudeLiveSessionTurn"
STEER_ENDPOINT_IDS = {"claude-cli"}
_CACHE_TTL_S = 60.0
_cache: dict[str, tuple[float, bool]] = {}


def reset_cache() -> None:
    _cache.clear()


def _dist_dir(dist_dir: str | None) -> str:
    return dist_dir or os.environ.get("OPENCLAW_DIST_DIR") or DEFAULT_DIST


def _scan(dist_dir: str) -> bool:
    for path in sorted(glob.glob(os.path.join(dist_dir, "*.js"))):
        try:
            with open(path, encoding="utf-8") as f:
                s = f.read()
        except OSError:
            continue
        if NEEDLE in s:
            return MARKER in s
    return False


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
            "hint": "see deploy/gateway-patches/README.md (claude-cli-steer.py)"}


def session_can_steer(rec: dict | None) -> bool:
    return bool(rec) and (rec.get("endpoint_id") or "") in STEER_ENDPOINT_IDS
