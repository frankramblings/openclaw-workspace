"""Persisted in-flight turn state + monotonic turn ids.

Why this exists: event_store is deliberately in-memory, so a backend restart
used to leave clients frozen on "Working…" with no way to tell that the turn
died with the process. This module is the tiny durable complement: which
sessions have a turn recording RIGHT NOW, plus the id generator those turns
are labelled with. On boot (`sweep_boot`, called from app._lifespan before
any new turn can start), anything still marked in-flight is provably dead —
the recorder task died with the interpreter — and is moved to `interrupted`
so /api/chat/turn can report an honest post-mortem instead of silence.

Store shape (.data/turns_inflight.json):
    {"schema_version": 1, "next_turn_id": 7,
     "inflight":    {"<session_key>": {"turn_id": 6, "started": <ms>}},
     "interrupted": {"<session_key>": {"turn_id": 5, "started": <ms>,
                                       "detected": <ms>}}}

The interrupted marker for a session is cleared the moment its next turn
starts — it describes only the most recent gap, not history.
"""
from __future__ import annotations

import logging
import threading
import time

from . import config, fsutil

log = logging.getLogger(__name__)

# See sessions_store.SCHEMA_VERSION for the contract.
SCHEMA_VERSION = 1
_LOCK = threading.Lock()


def _store_file():
    return config.DATA_DIR / "turns_inflight.json"


def _now_ms() -> int:
    return int(time.time() * 1000)


def _load() -> dict:
    data = fsutil.load_json_guarded(_store_file(), {}, logger=log)
    if not isinstance(data, dict):
        data = {}
    return {
        "next_turn_id": int(data.get("next_turn_id") or 1),
        "inflight": dict(data.get("inflight") or {}),
        "interrupted": dict(data.get("interrupted") or {}),
    }


def _save(data: dict) -> None:
    data["schema_version"] = SCHEMA_VERSION
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    fsutil.atomic_write_json(_store_file(), data)


def turn_started(session_key: str) -> int:
    """Allocate the next turn id and mark `session_key` in-flight. Clears any
    interrupted marker for the session (it has moved on)."""
    with _LOCK:
        data = _load()
        tid = data["next_turn_id"]
        data["next_turn_id"] = tid + 1
        data["inflight"][session_key] = {"turn_id": tid, "started": _now_ms()}
        data["interrupted"].pop(session_key, None)
        _save(data)
    return tid


def turn_ended(session_key: str) -> None:
    with _LOCK:
        data = _load()
        if session_key in data["inflight"]:
            data["inflight"].pop(session_key)
            _save(data)


def inflight_for(session_key: str) -> dict | None:
    with _LOCK:
        return _load()["inflight"].get(session_key)


def interrupted_for(session_key: str) -> dict | None:
    with _LOCK:
        return _load()["interrupted"].get(session_key)


def sweep_boot() -> dict:
    """Move every in-flight record to `interrupted`. Call once at startup,
    before any new turn can begin. Returns the moved map (for logging)."""
    with _LOCK:
        data = _load()
        moved = data["inflight"]
        if not moved:
            return {}
        for key, rec in moved.items():
            data["interrupted"][key] = {**rec, "detected": _now_ms()}
        data["inflight"] = {}
        _save(data)
        return moved
