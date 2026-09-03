"""Lightweight session-metadata store for the OpenClaw Workspace.

Persists ONLY metadata — the mapping from the SPA's session id to a gateway
session key, plus name/model/flags. Message CONTENT is never stored here; it
lives in the brain (codex) and is read back on demand via chat.history. That
keeps the brain the single source of truth and this store tiny.

Single-user app → a JSON file guarded by a process lock is plenty. Writes are
atomic (temp file + os.replace) so a crash mid-write can't corrupt the store.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid

from . import config, fsutil

log = logging.getLogger(__name__)

_LOCK = threading.Lock()
_STORE_FILE = config.DATA_DIR / "sessions.json"

# Bumped whenever the on-disk shape of sessions.json changes in a way older
# code can't read. A file with no "schema_version" is legacy (pre-Task-15)
# and loads normally -- absence just means "version 1 or earlier." A file
# whose version is HIGHER than this is a downgrade (a newer app version wrote
# it, this process is older): still loaded as best-effort, but logged so a
# rollback that silently drops fields doesn't go unnoticed.
SCHEMA_VERSION = 2
# v2 (2026-09-01): every record carries opened (OPEN-shelf stamp) and parent_id (fork parent); missing keys read as None.


def _now_ms() -> int:
    return int(time.time() * 1000)


_V2_DEFAULTS = {"opened": None, "parent_id": None}


def _migrate(data: dict) -> dict:
    """Fill fields older files lack. In-memory only; the next _save writes the
    current SCHEMA_VERSION. Idempotent."""
    for s in data.get("sessions", []):
        if isinstance(s, dict):
            for k, v in _V2_DEFAULTS.items():
                s.setdefault(k, v)
    return data


def _load() -> dict:
    data = fsutil.load_json_guarded(_STORE_FILE, {"sessions": []}, logger=log)
    version = data.get("schema_version")
    if isinstance(version, int) and version > SCHEMA_VERSION:
        log.warning(
            "sessions.json schema_version %s is newer than this app knows how to "
            "read (%s) -- an older app version, or a downgrade; some fields may "
            "be ignored", version, SCHEMA_VERSION)
    return _migrate(data)


def _save(data: dict) -> None:
    data["schema_version"] = SCHEMA_VERSION
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = _STORE_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2))
    os.replace(tmp, _STORE_FILE)  # atomic on POSIX


def list_sessions() -> list[dict]:
    """Newest first — matches how the Library expects to render the list."""
    with _LOCK:
        sessions = _load().get("sessions", [])
    return sorted(sessions, key=lambda s: s.get("created", 0), reverse=True)


def get(session_id: str) -> dict | None:
    with _LOCK:
        for s in _load().get("sessions", []):
            if s.get("id") == session_id:
                return s
    return None


def session_key_for(session_id: str) -> str:
    """Resolve a SPA session id to its gateway sessionKey, falling back to the
    shared web key for ids we don't have a record for (e.g. the bootstrap chat
    before its first message materializes a record)."""
    rec = get(session_id)
    return rec["sessionKey"] if rec else config.web_session_key()


def create(name: str | None = None, model: str | None = None,
           endpoint_url: str | None = None, endpoint_id: str | None = None,
           origin: str | None = None, speed: str | None = None) -> dict:
    sid = uuid.uuid4().hex[:12]
    prefix = config.web_session_prefix()
    # Local (Kamino/MLX) models: small ones (Qwen3-14B) can't hold Gary's
    # bootstrap + tool schemas → route to the lightweight `qwen` agent (tools
    # off, tiny workspace). Bigger local models (Qwen3-30B MoE, 256k context)
    # can ride the full `main` agent instead — user chose this on purpose.
    m_norm = (model or "").rsplit("/", 1)[-1]
    LIGHT_LOCAL_MODELS = {"Qwen3-14B-4bit", "GLM-4-9B-0414-4bit"}
    local_chat = (model or "").startswith("local/") or (endpoint_id or "") == "local"
    light_local = local_chat and m_norm in LIGHT_LOCAL_MODELS
    if light_local:
        prefix = "agent:qwen:web"
    rec = {
        "id": sid,
        "name": name or "New chat",
        "model": model or "openclaw",
        # thinking depth: fast|normal|deep (web toggle); a pending-chat toggle
        # click arrives here at materialization so it isn't silently dropped.
        "speed": speed if speed in ("fast", "normal", "deep") else "normal",
        "sessionKey": f"{prefix}-{sid}",
        "endpoint_url": endpoint_url or config.gateway_ws_url(),
        "endpoint_id": endpoint_id or "openclaw",
        "folder": None,
        "archived": False,
        "important": False,
        # OPEN shelf (spec 4.1): epoch ms of the last user send, cleared by
        # POST /api/session/{id}/close. None = not on the shelf.
        "opened": None,
        # Fork parent (POST /api/session/branch). None = not a fork.
        "parent_id": None,
        "created": _now_ms(),
        "updated": _now_ms(),
        # Who spawned this session: None = the user, "inbox" = a triage
        # handoff. The sidebar hides non-user origins unless engaged.
        "origin": origin,
        # Per-session Gary-terminal override: None = inherit the global
        # default; True/False = explicit on/off for this chat. Light local
        # chats (tools-off qwen agent) force it OFF: the terminal-control
        # preamble derails the small local model, which parrots a fake
        # `{"output":...}` instead of answering. The bigger local model runs
        # as full Gary, so it inherits the global default like everything else.
        "gary_terminal": False if light_local else None,
    }
    with _LOCK:
        data = _load()
        data.setdefault("sessions", []).append(rec)
        _save(data)
    return rec


def update(session_id: str, *, touch: bool = True, **fields) -> dict | None:
    """Patch allowed fields on a record. Unknown keys are ignored so a stray
    form field from the SPA can't inject arbitrary data. `touch=False` skips
    bumping `updated` -- used by close_opened so taking a thread off the OPEN
    shelf isn't activity that moves it to the top of RECENT or bumps its
    project's latest roll-up."""
    allowed = {"name", "model", "folder", "archived", "important",
               "endpoint_url", "endpoint_id", "speed", "gary_terminal",
               "opened", "parent_id"}
    with _LOCK:
        data = _load()
        for s in data.get("sessions", []):
            if s.get("id") == session_id:
                for k, v in fields.items():
                    if k in allowed:
                        s[k] = v
                if touch:
                    s["updated"] = _now_ms()
                _save(data)
                return s
    return None


def gary_terminal_override(session_key: str):
    """Return the per-session gary-terminal flag (bool) or None (inherit).

    Matches by the record's stored gateway sessionKey OR by its SPA id: the
    terminal panel keys its WebSocket (and therefore the gary-mode calls) on the
    SPA session id from getCurrentSessionId(), while the MCP-side token is minted
    against the gateway sessionKey. Accepting either keeps the toggle the panel
    sets and the gate the MCP run path reads pointed at the same record."""
    with _LOCK:
        for s in _load().get("sessions", []):
            if s.get("sessionKey") == session_key or s.get("id") == session_key:
                return s.get("gary_terminal")
    return None


def id_for_session_key(session_key: str) -> str | None:
    """Resolve a panel/gateway key to a record id, matching by gateway
    sessionKey OR by SPA id (see gary_terminal_override for why both)."""
    with _LOCK:
        for s in _load().get("sessions", []):
            if s.get("sessionKey") == session_key or s.get("id") == session_key:
                return s.get("id")
    return None


def set_gary_terminal(session_id: str, enabled):  # enabled: bool | None
    return update(session_id, gary_terminal=enabled)


def mark_opened(session_id: str):
    """Stamp the session onto the OPEN shelf (called on every user send)."""
    return update(session_id, opened=_now_ms())


def close_opened(session_id: str):
    """Take the session off the OPEN shelf (the row's close action). Does not
    touch `updated` -- closing a shelf row is not activity (see update's
    `touch` kwarg)."""
    return update(session_id, opened=None, touch=False)


def unfile_project(project_id: str) -> int:
    """Clear `folder` on every session filed under `project_id` (project
    delete, spec 4.2). Returns how many records changed."""
    if not project_id:
        return 0
    n = 0
    with _LOCK:
        data = _load()
        for s in data.get("sessions", []):
            if s.get("folder") == project_id:
                s["folder"] = None
                s["updated"] = _now_ms()
                n += 1
        if n:
            _save(data)
    return n


def delete(session_id: str) -> bool:
    with _LOCK:
        data = _load()
        before = len(data.get("sessions", []))
        data["sessions"] = [s for s in data.get("sessions", []) if s.get("id") != session_id]
        if len(data["sessions"]) != before:
            _save(data)
            return True
    return False
