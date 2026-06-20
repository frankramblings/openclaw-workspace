"""In-memory, per-`session_key` SSE event log for resumable streaming chat.

Each session gets its own append-only log of raw SSE payload strings (exactly the
strings `bridge.stream_turn` yields, e.g. `"data: {...}\n\n"`). Every event is
tagged with a **monotonic integer sequence that NEVER resets** for that session —
this is the SSE `id:` value the frontend uses as a resume cursor. We deliberately
do NOT use a list/deque index as the id: indices shift when old events are
evicted, which would corrupt any cursor a client is holding.

Two consumers:
  * `/api/chat/events/resume` — one-shot replay via `since()`.
  * `/api/chat/stream`        — live tail via `subscribe()`/`unsubscribe()`, woken
                                by `append()`.

The append side runs inside the asyncio event loop (it's called from the
StreamingResponse generator), so waking asyncio queues is straightforward. We
still guard for the "no running loop" case so a stray call from a worker thread
can never raise into the chat path. A threading.Lock protects the buffers because
the store is process-global and other threads may read it.
"""
from __future__ import annotations

import asyncio
import threading
from collections import deque

# Per-session ring buffer cap. Old events past this are evicted (their ids are
# gone forever — a resume cursor older than the retained window just replays the
# whole retained buffer, which `since()` handles).
MAX_PER_SESSION = 2000

_LOCK = threading.Lock()
# session_key -> deque[(seq:int, payload:str)]
_EVENTS: dict[str, deque] = {}
# session_key -> next seq to assign (monotonic, never resets)
_NEXT_SEQ: dict[str, int] = {}
# session_key -> set[asyncio.Queue] of live tail subscribers
_SUBSCRIBERS: dict[str, set] = {}
# session_key -> seq of the FIRST event of the current turn (turn boundary).
# Lets a reloaded client replay just the in-flight answer (not the whole
# multi-turn buffer) from its start, independent of any advancing tail cursor.
_TURN_START: dict[str, int] = {}
# session_key -> is a turn streaming right now (set by begin/end_turn).
_TURN_ACTIVE: dict[str, bool] = {}


def append(session_key: str, payload: str) -> str:
    """Assign the next seq for `session_key`, store `(seq, payload)`, evict the
    oldest beyond MAX_PER_SESSION, wake live-tail subscribers, return `str(seq)`.

    Defensive: waking subscribers never raises into the caller — a full/closed
    queue or missing event loop is swallowed (the subscriber will catch up via
    its own backlog replay or simply be dropped on its next get).
    """
    with _LOCK:
        seq = _NEXT_SEQ.get(session_key, 1)
        _NEXT_SEQ[session_key] = seq + 1
        buf = _EVENTS.get(session_key)
        if buf is None:
            buf = deque(maxlen=MAX_PER_SESSION)
            _EVENTS[session_key] = buf
        buf.append((seq, payload))
        subscribers = list(_SUBSCRIBERS.get(session_key, ()))

    id_str = str(seq)
    item = (id_str, payload)
    for q in subscribers:
        try:
            q.put_nowait(item)
        except Exception:  # noqa: BLE001 - full/closed queue must never break append
            pass
    return id_str


def since(session_key: str, last_event_id: str | None) -> list[tuple[str, str]]:
    """Return `[(id_str, payload), ...]` for all retained events with
    `seq > int(last_event_id)`. If `last_event_id` is None/empty/unparseable,
    return the full retained buffer."""
    try:
        cursor = int(last_event_id) if last_event_id not in (None, "") else None
    except (TypeError, ValueError):
        cursor = None
    with _LOCK:
        buf = _EVENTS.get(session_key)
        if not buf:
            return []
        if cursor is None:
            return [(str(seq), payload) for seq, payload in buf]
        return [(str(seq), payload) for seq, payload in buf if seq > cursor]


def latest_id(session_key: str) -> str | None:
    """The id of the most recent retained event for the session, or None."""
    with _LOCK:
        buf = _EVENTS.get(session_key)
        if not buf:
            return None
        return str(buf[-1][0])


def begin_turn(session_key: str) -> None:
    """Mark the start of a new streaming turn. Records the seq the NEXT appended
    event will carry as the turn boundary, and flags the turn active. Called
    from chat_stream just before the relay loop."""
    with _LOCK:
        _TURN_START[session_key] = _NEXT_SEQ.get(session_key, 1)
        _TURN_ACTIVE[session_key] = True


def end_turn(session_key: str) -> None:
    """Mark the current turn finished (flips the active flag; the boundary seq is
    retained so a late reload can still replay the just-finished turn until its
    events age out). Called from chat_stream's finally."""
    with _LOCK:
        _TURN_ACTIVE[session_key] = False


def current_turn(session_key: str) -> dict:
    """Snapshot of the latest turn for a reloaded client:
        {"active": bool, "turn_start_id": str|None,
         "events": [{"id","data"}, ...], "last_event_id": str|None}
    `events` are the retained events with seq >= the turn boundary (clamped to
    what's still buffered), in order — enough to rebuild the in-flight answer
    from its start. Empty if no turn has ever started for the session."""
    with _LOCK:
        active = bool(_TURN_ACTIVE.get(session_key))
        start = _TURN_START.get(session_key)
        buf = _EVENTS.get(session_key)
        if start is None or not buf:
            return {"active": active, "turn_start_id": None,
                    "events": [], "last_event_id": None}
        events = [{"id": str(seq), "data": payload}
                  for seq, payload in buf if seq >= start]
        last_id = str(buf[-1][0])
    return {"active": active, "turn_start_id": str(start),
            "events": events, "last_event_id": last_id}


def subscribe(session_key: str) -> "asyncio.Queue":
    """Register a live-tail subscriber. Returns an asyncio.Queue that `append`
    will `put_nowait((id_str, payload))` onto. Caller MUST `unsubscribe` it."""
    q: asyncio.Queue = asyncio.Queue()
    with _LOCK:
        _SUBSCRIBERS.setdefault(session_key, set()).add(q)
    return q


def unsubscribe(session_key: str, queue: "asyncio.Queue") -> None:
    """Remove a live-tail subscriber. Idempotent; cleans up empty sets so the
    subscriber map never leaks sessions."""
    with _LOCK:
        subs = _SUBSCRIBERS.get(session_key)
        if subs is not None:
            subs.discard(queue)
            if not subs:
                _SUBSCRIBERS.pop(session_key, None)
