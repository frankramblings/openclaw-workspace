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


def default_model() -> tuple[str, str]:
    """The primary agent's configured model as (provider, model_id).

    Read from openclaw.json `agents.list[0].model`, formatted "provider/model"
    (e.g. "openai/gpt-5.5"). This is the model a fresh web chat lands on. Falls
    back to the known codex primary if the config can't be read.
    """
    raw = os.environ.get("OPENCLAW_DEFAULT_MODEL")
    if not raw:
        try:
            raw = _openclaw_json()["agents"]["list"][0]["model"]
        except (KeyError, IndexError, TypeError):
            raw = "openai/gpt-5.5"
    provider, _, model = raw.partition("/")
    if not model:  # no provider prefix
        provider, model = "openai", provider
    return provider, model


# Canonical agent session. agent:main:main is ALSO Signal's session — a session
# runs one turn at a time, so sharing it makes the web UI and Signal contend (a
# long turn in one surfaces as "Something went wrong… use /new" in the other).
SESSION_KEY = os.environ.get("OPENCLAW_SESSION_KEY", "agent:main:main")

# The web UI gets its OWN session key so it never contends with Signal. Same
# agent → same brain/memory/tools, just an isolated conversation thread.
# Verified live: agent:main:web connects + runs turns fine (2026-06-03).
WEB_SESSION_KEY = os.environ.get("OPENCLAW_WEB_SESSION_KEY", "agent:main:web")

# Each Library "chat" mints its own gateway thread under this prefix:
# agent:main:web-<id>. Same agent ("main") → same brain/memory, isolated thread.
WEB_SESSION_PREFIX = os.environ.get("OPENCLAW_WEB_SESSION_PREFIX", "agent:main:web")

# Where the workspace persists its own lightweight session METADATA (id↔gateway
# sessionKey, name, model, flags). Message CONTENT is never stored here — it
# lives in the brain and is read back via chat.history. Gitignored.
DATA_DIR = Path(os.environ.get("WORKSPACE_DATA_DIR", REPO_ROOT / ".data"))

# Existing triage-dashboard (unified inbox feed). Proxied for the Inbox tab.
TRIAGE_URL = os.environ.get("TRIAGE_URL", "http://127.0.0.1:3456")

# How long to wait on a single chat turn before giving up.
TURN_TIMEOUT_S = float(os.environ.get("WORKSPACE_TURN_TIMEOUT_S", "180"))
