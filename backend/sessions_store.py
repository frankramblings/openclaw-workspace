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
import os
import threading
import time
import uuid

from . import config

_LOCK = threading.Lock()
_STORE_FILE = config.DATA_DIR / "sessions.json"


def _now_ms() -> int:
    return int(time.time() * 1000)


def _load() -> dict:
    try:
        return json.loads(_STORE_FILE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {"sessions": []}


def _save(data: dict) -> None:
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
    return rec["sessionKey"] if rec else config.WEB_SESSION_KEY


def create(name: str | None = None, model: str | None = None,
           endpoint_url: str | None = None, endpoint_id: str | None = None) -> dict:
    sid = uuid.uuid4().hex[:12]
    rec = {
        "id": sid,
        "name": name or "New chat",
        "model": model or "openclaw",
        "sessionKey": f"{config.WEB_SESSION_PREFIX}-{sid}",
        "endpoint_url": endpoint_url or config.gateway_ws_url(),
        "endpoint_id": endpoint_id or "openclaw",
        "folder": None,
        "archived": False,
        "important": False,
        "created": _now_ms(),
        "updated": _now_ms(),
    }
    with _LOCK:
        data = _load()
        data.setdefault("sessions", []).append(rec)
        _save(data)
    return rec


def update(session_id: str, **fields) -> dict | None:
    """Patch allowed fields on a record. Unknown keys are ignored so a stray
    form field from the SPA can't inject arbitrary data."""
    allowed = {"name", "model", "folder", "archived", "important",
               "endpoint_url", "endpoint_id"}
    with _LOCK:
        data = _load()
        for s in data.get("sessions", []):
            if s.get("id") == session_id:
                for k, v in fields.items():
                    if k in allowed:
                        s[k] = v
                s["updated"] = _now_ms()
                _save(data)
                return s
    return None


def delete(session_id: str) -> bool:
    with _LOCK:
        data = _load()
        before = len(data.get("sessions", []))
        data["sessions"] = [s for s in data.get("sessions", []) if s.get("id") != session_id]
        if len(data["sessions"]) != before:
            _save(data)
            return True
    return False
