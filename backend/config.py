"""Runtime config for the OpenClaw Workspace bridge.

Secrets (the gateway password) are read from ~/.openclaw/openclaw.json at runtime
so they never live in this repo. Everything is overridable via environment vars.
"""
from __future__ import annotations

import json
import logging
import os
from functools import lru_cache
from pathlib import Path

from . import fsutil

log = logging.getLogger(__name__)


# --- Numeric env vars: parse defensively, never crash -------------------------
# Most numeric env vars here (and in research.py / inbox/sources/*) are cast
# as plain module-level assignments, i.e. AT IMPORT TIME. A bare
# float(os.environ...) there means a finger-slip like WORKSPACE_STALL_CAP=24o
# kills the whole process with a raw ValueError during `import backend.app`,
# before any startup check can run. These helpers make a bad value degrade to
# the call site's default with a logged warning instead. config_check reuses
# parse_env_number as its single source of truth, so the same bad var is ALSO
# reported as a startup problem string (visible in the boot log) — degrade
# here, report there, one parse implementation.

def parse_env_number(name: str, caster):
    """Parse env var `name` with `caster` (int/float). Returns
    (value, problem): value is the parsed number or None (unset OR invalid);
    problem is a human-readable string only when the var is SET but does not
    parse. Never raises."""
    raw = os.environ.get(name)
    if raw is None:
        return None, None
    try:
        return caster(raw), None
    except (TypeError, ValueError):
        kind = "integer" if caster is int else "number"
        return None, f"env {name}={raw!r} is not a valid {kind}"


def _env_number(name: str, caster, default):
    value, problem = parse_env_number(name, caster)
    if problem is not None:
        log.warning("invalid %s=%r, using default %r",
                    name, os.environ.get(name), default)
    return default if value is None else value


def _env_int(name: str, default: int) -> int:
    return _env_number(name, int, default)


def _env_float(name: str, default: float) -> float:
    return _env_number(name, float, default)


OPENCLAW_HOME = Path(os.environ.get("OPENCLAW_HOME", Path.home() / ".openclaw"))
OPENCLAW_CONFIG = OPENCLAW_HOME / "openclaw.json"

# Repo layout
BACKEND_DIR = Path(__file__).resolve().parent
REPO_ROOT = BACKEND_DIR.parent
FRONTEND_DIR = Path(os.environ.get("WORKSPACE_FRONTEND_DIR", REPO_ROOT / "frontend"))

# Optional base path for hosting the app under a subpath (e.g. behind a reverse
# proxy that mounts it at "/marissa"). Empty (default) = served at the origin
# root. The proxy MUST strip this prefix before forwarding (Tailscale funnel
# `--set-path` does), so backend routes stay at root; only the browser-facing
# URLs in the served HTML are rewritten to include the prefix. See _spa_html().
BASE_PATH = os.environ.get("WORKSPACE_BASE_PATH", "").rstrip("/")


@lru_cache(maxsize=1)
def _openclaw_json() -> dict:
    try:
        return json.loads(OPENCLAW_CONFIG.read_text())
    except FileNotFoundError:
        return {}


def gateway_port() -> int:
    fallback = _openclaw_json().get("gateway", {}).get("port", 18789)
    try:
        fallback = int(fallback)
    except (TypeError, ValueError):
        log.warning("invalid gateway.port %r in %s, using default 18789",
                    fallback, OPENCLAW_CONFIG)
        fallback = 18789
    return _env_int("OPENCLAW_GATEWAY_PORT", fallback)


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

    Read from openclaw.json `agents.list[0].model`. That field is either a
    "provider/model" string (e.g. "openai/gpt-5.5") or a dict of the form
    {"primary": "provider/model", "fallbacks": [...]} — newer configs use the
    dict. Either way we resolve to the primary "provider/model" string. This is
    the model a fresh web chat lands on. Falls back to the known codex primary
    if the config can't be read.
    """
    raw = os.environ.get("OPENCLAW_DEFAULT_MODEL")
    if not raw:
        agents = _openclaw_json().get("agents", {})
        lst = agents.get("list") or []
        if lst and isinstance(lst[0], dict) and lst[0].get("model"):
            raw = lst[0]["model"]
        else:
            # Minimal configs (e.g. a fresh single-tenant install) carry no
            # agents.list and set the active model under agents.defaults.model.
            raw = agents.get("defaults", {}).get("model") or "openai/gpt-5.5"
    if isinstance(raw, dict):  # {"primary": "...", "fallbacks": [...]}
        raw = raw.get("primary") or "openai/gpt-5.5"
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


def inbox_triage_model() -> str:
    """Model for the inbox triage pass. Triage is fast JSON tagging over the
    whole feed — the heavy shared `main` model stalls/throttles on the full
    prompt, so pin a cheap fast model (like auto-titles do). Overridable."""
    return (os.environ.get("OPENCLAW_INBOX_TRIAGE_MODEL")
            or "openai/gpt-5.4-mini")


# Where the workspace persists its own lightweight session METADATA (id↔gateway
# sessionKey, name, model, flags). Message CONTENT is never stored here — it
# lives in the brain and is read back via chat.history. Gitignored.
DATA_DIR = Path(os.environ.get("WORKSPACE_DATA_DIR", REPO_ROOT / ".data"))

# How long to wait on a single chat turn before giving up.
TURN_TIMEOUT_S = _env_float("WORKSPACE_TURN_TIMEOUT_S", 180.0)

# Stall watchdog (workspace chat): run-silence thresholds for the bridge's
# WS relay. Notice → SSE "stall" frames; cap → abort + retry-once.
STALL_NOTICE_S = _env_float("WORKSPACE_STALL_NOTICE", 45.0)
STALL_CAP_S = _env_float("WORKSPACE_STALL_CAP", 240.0)
# Chat auto-titles run on a cheap model so they never race the user's real
# turn through codex on the big one.
TITLE_MODEL = os.environ.get("WORKSPACE_TITLE_MODEL", "openai/gpt-5.4-mini")
# Composer ghost-text suggestions run on a cheap model, same rationale as
# titles. NOT openai/*: those return empty through this gateway.
SUGGEST_MODEL = os.environ.get("WORKSPACE_SUGGEST_MODEL",
                               "anthropic/claude-sonnet-4-6")


# --- Branding (the agent's name + theme accent) ------------------------------
# The agent name is WORKSPACE branding, not OpenClaw config: OpenClaw's
# agents.list[0] has no `name`. One source of truth, in priority order:
#   1. env WORKSPACE_AGENT_NAME
#   2. .data/branding.json  {"agent_name": "..."}   (written by scripts/setup.sh)
#   3. the default below
# .data/ is gitignored, so a user's chosen name never lands in the public repo.
DEFAULT_AGENT_NAME = "Claw"
DEFAULT_ACCENT = "#4fe3d1"  # the maskable-icon / theme cyan the UI ships with
# AGPL-3.0 §13: the UI shows a "Source" link offering this running version's
# source. A fork that modifies the app MUST set WORKSPACE_SOURCE_URL to its own
# repository so network users get the *corresponding* (modified) source.
DEFAULT_SOURCE_URL = "https://github.com/frankramblings/openclaw-workspace"
BRANDING_PATH = DATA_DIR / "branding.json"


def load_branding() -> dict:
    """Read .data/branding.json (best-effort). Never raises. A corrupt file
    is quarantined aside rather than silently treated as absent — see
    fsutil.load_json_guarded."""
    return fsutil.load_json_guarded(BRANDING_PATH, {}, logger=log)


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


def source_url() -> str:
    """Public URL to the source of THIS running version (AGPL-3.0 §13).
    Forks that modify the app should point this at their own repository.
    Env > branding.json > default."""
    return (
        os.environ.get("WORKSPACE_SOURCE_URL")
        or load_branding().get("source_url")
        or DEFAULT_SOURCE_URL
    ).strip() or DEFAULT_SOURCE_URL


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
    """Read .data/connection.json (non-secret connection info). Never raises.
    A corrupt file is quarantined aside rather than silently treated as
    absent — see fsutil.load_json_guarded."""
    return fsutil.load_json_guarded(CONNECTION_PATH, {}, logger=log)


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


# --- Optional auth gate -------------------------------------------------------
# WORKSPACE_AUTH_TOKEN gates every non-allowlisted request when set. Unset
# (the default) means zero behavior change — the auth gate is not loaded at all.
# Single source of truth: call auth_token() everywhere (reads env at call time
# so tests can monkeypatch between cases).

def auth_token() -> str | None:
    """Return the configured auth token, or None when unset (auth gate off)."""
    return os.environ.get("WORKSPACE_AUTH_TOKEN") or None


def auth_session_secret() -> bytes | None:
    """HMAC key for validating a browser session cookie minted by an external
    password/passkey login on the SAME origin (e.g. the media-share wall). When
    set, the auth gate also accepts a valid signed session cookie — so a public
    deploy can sit behind a Face-ID/password wall instead of a bare token URL.
    Falls back to SHARE_SECRET so it can share one login with that wall."""
    val = os.environ.get("WORKSPACE_AUTH_SECRET") or os.environ.get("SHARE_SECRET")
    return val.encode() if val else None


def auth_session_cookie() -> str:
    """Name of the shared session cookie to honor (default matches the media
    share so one login covers both)."""
    return os.environ.get("WORKSPACE_AUTH_SESSION_COOKIE") or "share_session"


def auth_session_max_age() -> int:
    return _env_int("SHARE_SESSION_DAYS", 30) * 86400


def auth_login_url() -> str | None:
    """If set, unauthenticated HTML navigations are 302-redirected here (with a
    ?next= back-link) instead of getting a bare 401 — routes browsers to the
    login wall. API/JSON and WebSocket requests still get 401 / handshake-close."""
    return os.environ.get("WORKSPACE_AUTH_LOGIN_URL") or None


def auth_active() -> bool:
    """The gate engages when either a token OR a session secret is configured."""
    return bool(auth_token() or auth_session_secret())


def followup_token() -> str | None:
    """Token bin/followup must present to register/complete promises. Falls
    back to the workspace auth token so a token-gated deploy is closed by
    default; unset both → open (local single-user default)."""
    return os.environ.get("FOLLOWUP_TOKEN") or auth_token()


# --- Workspace user (human, not the agent) ------------------------------------
# Used by /api/auth/status.  Env > "admin" (the default neutral value).
# Set WORKSPACE_USER to your chosen display name (e.g. "alex") if you wish.

def workspace_user() -> str:
    """The human user's display name for /api/auth/status."""
    return os.environ.get("WORKSPACE_USER") or "admin"
