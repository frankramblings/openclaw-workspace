"""Detect promise-language in a turn's final reply (Phase 3).

"I'll let you know when it's done" + nothing registered = the silent broken
promise this project exists to kill. Heuristic BY DESIGN: a false positive
costs one quiet amber card; a false negative costs nothing beyond the status
quo. The registration check counts ANY kind (including auto — tracked is
tracked); the sniffer's own grace check is the one that excludes auto.
"""
from __future__ import annotations

import logging
import re

from . import task_registry, turn_state

log = logging.getLogger(__name__)

_PROMISE_RES = (
    re.compile(r"\bI(?:['’‘`]?ll| will) let you know\b", re.I),
    re.compile(r"\bI(?:['’‘`]?ll| will) ping you\b", re.I),
    re.compile(r"\bI(?:['’‘`]?ll| will) (?:report|post|check|circle) back\b", re.I),
    re.compile(r"\bI(?:['’‘`]?ll| will) (?:notify|update) you\b", re.I),
    re.compile(r"\bI(?:['’‘`]?ll| will) post (?:the |a )?\w+ when\b", re.I),
    re.compile(r"\bI(?:['’‘`]?ll| will) follow up\b", re.I),
    re.compile(r"\b(?:I(?:['’‘`]?ll| will) )?keep you posted\b", re.I),
    re.compile(r"\b(?:when|once) it(?:['’‘`]?s| is) (?:done|finished|complete)[^.?!]{0,40}\bI(?:['’‘`]?ll| will)\b", re.I),
    re.compile(r"\bI(?:['’‘`]?ll| will)\b[^.?!]{0,40}\b(?:when|once) it(?:['’‘`]?s| is) (?:done|finished|complete)\b", re.I),
)


def detect_promise(text: str | None) -> str | None:
    """The matched promise phrase, or None. Pure."""
    if not text or not isinstance(text, str):
        return None
    for pattern in _PROMISE_RES:
        m = pattern.search(text)
        if m:
            return m.group(0)
    return None


def check_turn(session_key: str, final_text: str) -> str | None:
    """Phrase iff the reply promises a follow-up AND nothing at all was
    registered for this session since the turn started. Never raises."""
    try:
        phrase = detect_promise(final_text)
        if not phrase:
            return None
        # Late import: avoids any import-order question at module load time.
        # launch_sniffer does not import promise_guard, so there's no cycle —
        # this could be a top-level import too, but keeping it local keeps
        # the two modules' load order independent of each other.
        from . import launch_sniffer
        if launch_sniffer.grace_pending(session_key):
            return None   # a sniffed launch will register (or a real one already did)
        info = turn_state.inflight_for(session_key)
        since_ms = (info or {}).get("started", 0)
        if task_registry.has_session_registration_since(session_key, since_ms,
                                                        exclude_kinds=()):
            return None
        return phrase
    except Exception:  # noqa: BLE001 - the guard must never break the turn
        log.warning("promise_guard.check_turn failed", exc_info=True)
        return None


# --- persisted warnings (the amber card must survive a reload) ---------------
import threading  # noqa: E402
import time  # noqa: E402

from fastapi import APIRouter  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402

from . import config, fsutil  # noqa: E402

SCHEMA_VERSION = 1
WARNINGS_CAP = 20
_STORE_LOCK = threading.Lock()

router = APIRouter()


def _store_file():
    return config.DATA_DIR / "promise_warnings.json"


def record_warning(session_key: str, turn_id, phrase: str) -> None:
    """Persist an emitted warning so a reloaded thread can re-render its card.
    Guarded: recording can never break the turn that emitted the frame."""
    try:
        with _STORE_LOCK:
            data = fsutil.load_json_guarded(_store_file(), {}, logger=log)
            if not isinstance(data, dict):
                data = {}
            sessions = data.setdefault("sessions", {})
            entries = sessions.setdefault(session_key, [])
            entries.append({"turn_id": turn_id, "phrase": phrase,
                            "ts": int(time.time() * 1000)})
            sessions[session_key] = entries[-WARNINGS_CAP:]
            data["schema_version"] = SCHEMA_VERSION
            config.DATA_DIR.mkdir(parents=True, exist_ok=True)
            fsutil.atomic_write_json(_store_file(), data)
    except Exception:  # noqa: BLE001
        log.warning("promise_guard.record_warning failed", exc_info=True)


@router.get("/api/promise/warnings")
async def promise_warnings(session: str = ""):
    from .pending_tokens import _resolve_session_key
    sk = _resolve_session_key(session.strip()) if session.strip() else None
    if sk is None:
        return JSONResponse({"warnings": []})
    with _STORE_LOCK:
        data = fsutil.load_json_guarded(_store_file(), {}, logger=log)
    entries = (data.get("sessions", {}) if isinstance(data, dict) else {}).get(sk, [])
    return JSONResponse({"warnings": entries})
