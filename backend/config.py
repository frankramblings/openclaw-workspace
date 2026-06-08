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
    return (os.environ.get("OPENCLAW_GATEWAY_WS")
            or load_connection().get("gateway_ws")
            or f"ws://127.0.0.1:{gateway_port()}")


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


def agent_id() -> str:
    """The OpenClaw agent id the workspace talks to. Env > connection.json >
    OpenClaw config (agents.list[0].id) > 'main'. v1 hardcoded 'main'; other
    installs differ."""
    env = os.environ.get("OPENCLAW_AGENT_ID")
    if env:
        return env
    conn = load_connection().get("agent_id")
    if conn:
        return conn
    try:
        return _openclaw_json()["agents"]["list"][0]["id"]
    except (KeyError, IndexError, TypeError):
        return "main"


def session_key() -> str:
    return os.environ.get("OPENCLAW_SESSION_KEY") or f"agent:{agent_id()}:main"


def web_session_key() -> str:
    return os.environ.get("OPENCLAW_WEB_SESSION_KEY") or f"agent:{agent_id()}:web"


def web_session_prefix() -> str:
    return os.environ.get("OPENCLAW_WEB_SESSION_PREFIX") or f"agent:{agent_id()}:web"


def inbox_triage_session_key() -> str:
    return (os.environ.get("OPENCLAW_INBOX_TRIAGE_SESSION_KEY")
            or f"agent:{agent_id()}:inbox-triage")


# Where the workspace persists its own lightweight session METADATA (id↔gateway
# sessionKey, name, model, flags). Message CONTENT is never stored here — it
# lives in the brain and is read back via chat.history. Gitignored.
DATA_DIR = Path(os.environ.get("WORKSPACE_DATA_DIR", REPO_ROOT / ".data"))

# How long to wait on a single chat turn before giving up.
TURN_TIMEOUT_S = float(os.environ.get("WORKSPACE_TURN_TIMEOUT_S", "180"))


# --- Branding (the agent's name + theme accent) ------------------------------
# The agent name is WORKSPACE branding, not OpenClaw config: OpenClaw's
# agents.list[0] has no `name`. One source of truth, in priority order:
#   1. env WORKSPACE_AGENT_NAME
#   2. .data/branding.json  {"agent_name": "..."}   (written by scripts/setup.sh)
#   3. the default below
# .data/ is gitignored, so a user's chosen name never lands in the public repo.
DEFAULT_AGENT_NAME = "Claw"
DEFAULT_ACCENT = "#4fe3d1"  # the maskable-icon / theme cyan the UI ships with
BRANDING_PATH = DATA_DIR / "branding.json"


def load_branding() -> dict:
    """Read .data/branding.json (best-effort). Never raises."""
    try:
        return json.loads(BRANDING_PATH.read_text())
    except (FileNotFoundError, ValueError):
        return {}


def save_branding(**fields) -> dict:
    """Merge `fields` into branding.json and write it atomically. Returns the
    merged dict. Used by the setup wizard; safe to call repeatedly."""
    current = load_branding()
    current.update({k: v for k, v in fields.items() if v is not None})
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = BRANDING_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(current, indent=2) + "\n")
    tmp.replace(BRANDING_PATH)
    return current


def agent_name() -> str:
    """The agent's display name (e.g. 'Gary'). Env > branding.json > default."""
    return (
        os.environ.get("WORKSPACE_AGENT_NAME")
        or load_branding().get("agent_name")
        or DEFAULT_AGENT_NAME
    ).strip() or DEFAULT_AGENT_NAME


def accent_color() -> str:
    """Theme accent hex (e.g. '#4fe3d1'). Env > branding.json > default."""
    return (
        os.environ.get("WORKSPACE_ACCENT")
        or load_branding().get("accent")
        or DEFAULT_ACCENT
    )


# --- Connection (non-secret gateway address / agent id for remote installs) --
# Allows a user whose OpenClaw runs on another machine to set gateway_ws and
# agent_id without modifying ~/.openclaw/openclaw.json. The password MUST NOT
# be stored here — a copied .data/ must not leak a credential.
CONNECTION_PATH = DATA_DIR / "connection.json"

# Only these NON-SECRET fields may be persisted to connection.json. An allowlist
# (not a password denylist) so a future caller can't accidentally write a token/
# secret to disk. Passwords stay in env / openclaw.json, never here.
CONNECTION_FIELDS = frozenset({"gateway_ws", "agent_id", "integrations"})


def load_connection() -> dict:
    """Read .data/connection.json (non-secret connection info). Never raises."""
    try:
        return json.loads(CONNECTION_PATH.read_text())
    except (FileNotFoundError, ValueError):
        return {}


def save_connection(**fields) -> dict:
    """Merge non-secret connection fields into connection.json, atomically.
    Only CONNECTION_FIELDS are persisted — secrets never land here."""
    current = load_connection()
    current.update({k: v for k, v in fields.items()
                    if v is not None and k in CONNECTION_FIELDS})
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = CONNECTION_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(current, indent=2) + "\n")
    tmp.replace(CONNECTION_PATH)
    return current
