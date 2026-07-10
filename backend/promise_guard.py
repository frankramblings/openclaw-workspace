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
    re.compile(r"\bI[''`]?ll let you know\b", re.I),
    re.compile(r"\bI[''`]?ll ping you\b", re.I),
    re.compile(r"\bI[''`]?ll (?:report|post|check|circle) back\b", re.I),
    re.compile(r"\bI[''`]?ll (?:notify|update) you\b", re.I),
    re.compile(r"\bI[''`]?ll post (?:the |a )?\w+ when\b", re.I),
    re.compile(r"\bI[''`]?ll follow up\b", re.I),
    re.compile(r"\bkeep you posted\b", re.I),
    re.compile(r"\b(?:when|once) it(?:[''`]?s| is) (?:done|finished|complete)[^.?!]{0,40}\bI[''`]?ll\b", re.I),
    re.compile(r"\bI[''`]?ll\b[^.?!]{0,40}\b(?:when|once) it(?:[''`]?s| is) (?:done|finished|complete)\b", re.I),
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
        info = turn_state.inflight_for(session_key)
        since_ms = (info or {}).get("started", 0)
        if task_registry.has_session_registration_since(session_key, since_ms,
                                                        exclude_kinds=()):
            return None
        return phrase
    except Exception:  # noqa: BLE001 - the guard must never break the turn
        log.warning("promise_guard.check_turn failed", exc_info=True)
        return None
