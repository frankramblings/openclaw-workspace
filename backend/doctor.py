"""Connection doctor: diagnose this workspace's link to the user's OpenClaw.
Read-only — never sends a chat turn or mutates gateway state. Used by both
GET /api/doctor and scripts/doctor.sh."""
from __future__ import annotations

import asyncio

import websockets.exceptions

from . import bridge, config

# Connection-layer failures that mean "couldn't reach/complete the WS" (vs a
# RuntimeError, which the bridge raises for a rejected handshake or method error).
_CONNECT_ERRORS = (OSError, asyncio.TimeoutError, websockets.exceptions.WebSocketException)

# The gateway methods the workspace depends on (the compatibility contract).
REQUIRED_METHODS = [
    "chat.send", "chat.abort", "chat.history",
    "sessions.create", "sessions.delete", "sessions.patch", "sessions.json",
    "models.list", "models.authStatus",
    "cron.list", "cron.run", "cron.runs", "cron.update",
    "skills.status", "skills.update",
]
# Only read-only methods that succeed with NO params are safe to probe — a method
# that needs args (e.g. sessions.json needs a sessionKey) would error and be
# misread as "missing". The rest of REQUIRED_METHODS are documented, not probed.
PROBE_METHODS = ["models.list", "skills.status", "cron.list"]


def _ok(cid, detail="", hint=""):
    return {"id": cid, "ok": True, "detail": detail, "hint": hint}


def _fail(cid, detail="", hint=""):
    return {"id": cid, "ok": False, "detail": detail, "hint": hint}


async def _check_reachable() -> tuple[dict, dict | None]:
    """Returns (check, hello_or_None). hello is None when unreachable/rejected."""
    try:
        hello = await bridge.gateway_hello(timeout=8)
        return _ok("gateway_reachable", config.gateway_ws_url()), hello
    except RuntimeError as e:  # handshake/auth rejected
        return _fail("gateway_reachable", str(e),
                     "gateway rejected auth — check the gateway password "
                     "(OPENCLAW_GATEWAY_PASSWORD or openclaw.json)"), None
    except _CONNECT_ERRORS as e:  # connect refused/timeout/DNS/bad-URL
        return _fail("gateway_reachable", f"{type(e).__name__}: {e}",
                     f"gateway unreachable at {config.gateway_ws_url()} — "
                     "check it's running and OPENCLAW_GATEWAY_WS (must be a ws:// URL)"), None


async def _check_methods() -> dict:
    missing = []
    for m in PROBE_METHODS:
        try:
            await bridge.gateway_call(m, timeout=8)
        except RuntimeError as e:
            if "connect failed" in str(e):
                return _fail("methods", "gateway down during probe",
                             "fix gateway_reachable first")
            missing.append(m)  # "<m> failed: ..." → method missing/incompatible
        except _CONNECT_ERRORS:
            return _fail("methods", "gateway down during probe",
                         "fix gateway_reachable first")
    if missing:
        return _fail("methods", "missing: " + ", ".join(missing),
                     "your OpenClaw is missing methods the workspace needs — "
                     "update OpenClaw")
    return _ok("methods", f"probed {len(PROBE_METHODS)} read-only methods")


def _from_openclaw() -> bool:
    try:
        config._openclaw_json()["agents"]["list"][0]["id"]
        return True
    except (KeyError, IndexError, TypeError):
        return False


def _check_agent_id() -> dict:
    import os
    src = ("env" if os.environ.get("OPENCLAW_AGENT_ID")
           else "connection.json" if config.load_connection().get("agent_id")
           else "openclaw.json" if _from_openclaw() else "default-guess")
    aid = config.agent_id()
    if src == "default-guess":
        return _fail("agent_id", f"{aid} (guessed)",
                     "could not read agents.list[0].id — set OPENCLAW_AGENT_ID "
                     "if your agent isn't named 'main'")
    return _ok("agent_id", f"{aid} (from {src})")


def _check_version(hello: dict | None) -> dict:
    if not hello:
        return _fail("openclaw_version", "unknown (gateway unreachable)", "")
    ver = hello.get("version") or hello.get("build") or hello.get("protocol")
    return _ok("openclaw_version", f"{ver}" if ver else "unknown (not reported)")


async def run_checks() -> list[dict]:
    reachable, hello = await _check_reachable()
    checks = [reachable, _check_agent_id(), _check_version(hello)]
    if reachable["ok"]:
        checks.append(await _check_methods())
    else:
        checks.append(_fail("methods", "skipped (gateway unreachable)", ""))
    return checks


def summarize(checks: list[dict]) -> dict:
    return {"ok": all(c["ok"] for c in checks), "checks": checks}
