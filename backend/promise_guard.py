"""Detect promise-language in a turn's final reply (Phase 3).

"I'll let you know when it's done" + nothing registered = the silent broken
promise this project exists to kill. Heuristic BY DESIGN: a false positive
costs one quiet amber card; a false negative costs nothing beyond the status
quo. The registration check counts ANY kind (including auto — tracked is
tracked, regardless of who registered it).
"""
from __future__ import annotations

import logging
import re

from . import config, task_registry, turn_state

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
        # The launch sniffer's grace window used to suppress this card while a
        # sniffed launch decided whether to register. The observer registers on
        # evidence within OBSERVE_THRESHOLD_S instead, and the registration
        # check below already asks the only question that matters: did anything
        # real get registered for this chat since the turn started?
        info = turn_state.inflight_for(session_key)
        since_ms = (info or {}).get("started", 0)
        if task_registry.has_session_registration_since(session_key, since_ms,
                                                        exclude_kinds=()):
            return None
        return phrase
    except Exception:  # noqa: BLE001 - the guard must never break the turn
        log.warning("promise_guard.check_turn failed", exc_info=True)
        return None


_WAKE_MARKER = "[[promise-wake]]"


def _wake_seed(phrase: str) -> str:
    """The user-role message that seeds the self-wake turn. First line is the
    marker followup.history_card keys on to render a compact card."""
    name = config.user_name()
    return "\n".join([
        _WAKE_MARKER,
        f'Follow-through check: at the end of your last turn you told {name} '
        f'"{phrase}", but no waker was registered — so nothing was going to '
        f'bring you back and the promise would have died silently until they '
        f'spoke again.',
        "",
        "You're back now, on your own. Make good on it for the ACTUAL horizon "
        "of what you promised:",
        f"- Can finish it now? Do it and report the outcome to {name}.",
        "- Depends on a background job? (Re)start it under bin/followup so its "
        f"completion pings you, then tell {name} it's running.",
        "- Genuinely later (hours/days)? Set a cron/reminder for that time and "
        f"tell {name} the plan + ETA in one line.",
        "- Already handled or needs nothing? Say so briefly and stop.",
        "",
        "Do NOT just re-promise into the void — register a real waker "
        "(followup/cron) or complete it. This nudge is rate-limited and won't "
        "fire again for a while.",
    ])


def schedule_self_wake(session_key: str, phrase: str) -> str | None:
    """Schedule a turn that brings Gary back after a hollow promise, so the
    follow-up doesn't stall until the user speaks again. Rides the followup
    sweeper (deadline passes → fired as 'overdue'). Deduped + cooldown-bounded
    so a re-promising wake turn can't loop. Returns the promise id or None.
    Never raises — a failure here just leaves the amber card as the only signal."""
    try:
        from . import config, followup, sessions_store
        if not config.PROMISE_WAKE_ENABLED:
            return None
        session_id = sessions_store.id_for_session_key(session_key)
        if not session_id:
            return None
        now_ms = int(time.time() * 1000)
        cooldown_ms = max(0, config.PROMISE_WAKE_COOLDOWN_S) * 1000
        mine = [p for p in followup.list_promises()
                if p.get("origin") == "promise_wake"
                and p.get("session_key") == session_key]
        # One outstanding wake at a time...
        if any(p.get("state") == "pending" for p in mine):
            return None
        # ...and not another within the cooldown window (bounds re-promise loops).
        last = max((p.get("created", 0) for p in mine), default=0)
        if last and now_ms - last < cooldown_ms:
            return None
        rec = followup.create_promise(
            session_id, session_key, label="follow-up you promised",
            deadline_s=max(1, config.PROMISE_WAKE_DELAY_S),
            origin="promise_wake", seed_override=_wake_seed(phrase))
        log.info("promise_guard scheduled self-wake %s for %s (%r)",
                 rec.get("id"), session_key, phrase[:60])
        return rec.get("id")
    except Exception:  # noqa: BLE001 - scheduling must never break the turn
        log.warning("promise_guard.schedule_self_wake failed", exc_info=True)
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


def drop_session(session_key: str) -> None:
    """Forget a deleted chat's warnings — mirrors turn_state.drop_session."""
    try:
        with _STORE_LOCK:
            data = fsutil.load_json_guarded(_store_file(), {}, logger=log)
            sessions = data.get("sessions", {}) if isinstance(data, dict) else {}
            if session_key in sessions:
                sessions.pop(session_key)
                data["sessions"] = sessions
                data["schema_version"] = SCHEMA_VERSION
                fsutil.atomic_write_json(_store_file(), data)
    except Exception:  # noqa: BLE001
        log.warning("promise_guard.drop_session failed", exc_info=True)


@router.get("/api/promise/warnings")
async def promise_warnings(session: str = ""):
    from .pending_tokens import resolve_session_key
    sk = resolve_session_key(session.strip()) if session.strip() else None
    if sk is None:
        return JSONResponse({"warnings": []})
    with _STORE_LOCK:
        data = fsutil.load_json_guarded(_store_file(), {}, logger=log)
    entries = (data.get("sessions", {}) if isinstance(data, dict) else {}).get(sk, [])
    return JSONResponse({"warnings": entries})
