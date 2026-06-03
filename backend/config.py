"""Runtime config for the OpenClaw Workspace bridge.

Secrets (the gateway password) are read from ~/.openclaw/openclaw.json at runtime
so they never live in this repo. Everything is overridable via environment vars.
"""
from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path

OPENCLAW_HOME = Path(os.environ.get("OPENCLAW_HOME", Path.home() / ".openclaw"))
OPENCLAW_CONFIG = OPENCLAW_HOME / "openclaw.json"

# Repo layout
BACKEND_DIR = Path(__file__).resolve().parent
REPO_ROOT = BACKEND_DIR.parent
FRONTEND_DIR = Path(os.environ.get("WORKSPACE_FRONTEND_DIR", REPO_ROOT / "frontend"))


@lru_cache(maxsize=1)
def _openclaw_json() -> dict:
    try:
        return json.loads(OPENCLAW_CONFIG.read_text())
    except FileNotFoundError:
        return {}


def gateway_port() -> int:
    return int(os.environ.get("OPENCLAW_GATEWAY_PORT")
               or _openclaw_json().get("gateway", {}).get("port", 18789))


def gateway_ws_url() -> str:
    return os.environ.get("OPENCLAW_GATEWAY_WS") or f"ws://127.0.0.1:{gateway_port()}"


def gateway_password() -> str | None:
    env = os.environ.get("OPENCLAW_GATEWAY_PASSWORD")
    if env:
        return env
    return _openclaw_json().get("gateway", {}).get("auth", {}).get("password")


# Canonical agent session so chat shares memory/context with the Signal channel.
# Override if a live smoke-test shows the gateway wants the connection-scoped key.
SESSION_KEY = os.environ.get("OPENCLAW_SESSION_KEY", "agent:main:main")

# Existing triage-dashboard (unified inbox feed). Proxied for the Inbox tab.
TRIAGE_URL = os.environ.get("TRIAGE_URL", "http://127.0.0.1:3456")

# How long to wait on a single chat turn before giving up.
TURN_TIMEOUT_S = float(os.environ.get("WORKSPACE_TURN_TIMEOUT_S", "180"))
