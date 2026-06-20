"""Resumable streaming chat — the read-side endpoints.

The live turn is driven by `POST /api/chat_stream` (in app.py), which appends
every SSE chunk it yields to `event_store` keyed by the chat's gateway
sessionKey. These two GET endpoints let a frontend recover a turn it dropped
(tab backgrounded, network blip, reload) WITHOUT re-initiating the turn:

  GET /api/chat/events/resume?session=<id>&last_event_id=<id?>
      One-shot JSON replay of everything appended after `last_event_id`.

  GET /api/chat/stream?session=<id>&last_event_id=<id?>
      EventSource-compatible live tail: replays the backlog, then streams new
      events as they're appended, with periodic keepalive comments.

`session` is the SPA session id (the same value posted to /api/chat_stream). It
is resolved to the gateway sessionKey via the SAME lookup chat_stream uses, so a
given frontend session id maps to the same event log on both paths.
"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from . import config, event_store, sessions_store

router = APIRouter()

# Idle keepalive interval (seconds). A comment line (`: keepalive`) is sent when
# no event arrives within this window so proxies don't kill the idle connection.
_KEEPALIVE_S = 15.0


def _session_key_for(session: str) -> str:
    """Resolve a SPA session id to its gateway sessionKey — IDENTICAL to the
    lookup `chat_stream` performs in app.py:
        rec = sessions_store.get(session) if session else None
        session_key = rec["sessionKey"] if rec else config.web_session_key()
    so the same frontend id maps to the same event log on both paths."""
    rec = sessions_store.get(session) if session else None
    return rec["sessionKey"] if rec else config.web_session_key()


def _cursor(request: Request, last_event_id: str) -> str | None:
    """Resolve the resume cursor, preferring the explicit query param but
    falling back to the `Last-Event-ID` header that EventSource sends
    automatically on its native (non-app-driven) reconnect."""
    return (last_event_id or request.headers.get("last-event-id") or "") or None


@router.get("/api/chat/events/resume")
async def chat_events_resume(request: Request, session: str = "", last_event_id: str = ""):
    """One-shot replay of events appended after `last_event_id`.

    Returns: {"events": [{"id": "<id>", "data": "<raw stored sse string>"}, ...],
              "last_event_id": "<latest id or null>"}.
    `data` is the raw stored payload exactly as appended (e.g. "data: {...}\n\n").
    """
    session_key = _session_key_for(session)
    cursor = _cursor(request, last_event_id)
    events = [
        {"id": eid, "data": payload}
        for eid, payload in event_store.since(session_key, cursor)
    ]
    return JSONResponse({
        "events": events,
        "last_event_id": event_store.latest_id(session_key),
    })


@router.get("/api/chat/turn")
async def chat_current_turn(request: Request, session: str = ""):
    """Snapshot of the session's latest turn, for a client that just (re)loaded.

    Returns event_store.current_turn(): {active, turn_start_id, events, last_event_id}.
    A reloaded SPA uses this to decide whether an answer is still streaming and,
    if so, to rebuild it from the turn's first event, then tail /api/chat/stream
    from last_event_id for the remainder. Purely read-side; initiates nothing.
    """
    session_key = _session_key_for(session)
    return JSONResponse(event_store.current_turn(session_key))


@router.get("/api/chat/stream")
async def chat_stream_tail(request: Request, session: str = "", last_event_id: str = ""):
    """Live tail of a session's event log (EventSource-compatible, GET).

    Subscribes BEFORE replaying the backlog so no event slips through the gap
    between replay and live. Replays `since(last_event_id)`, then streams new
    events as they're appended, emitting a keepalive comment on idle. Always
    unsubscribes on disconnect/cancel so subscribers never leak. This endpoint
    is purely additive: it does NOT initiate a turn.
    """
    session_key = _session_key_for(session)
    cursor = _cursor(request, last_event_id)

    async def gen():
        # Subscribe first — anything appended from here on is queued for us, so
        # the window between backlog replay and going live carries no gap.
        queue = event_store.subscribe(session_key)
        # Highest id we've already emitted, so the live loop never re-sends an
        # event that was also in the backlog (append races subscribe+replay).
        replayed_max = -1
        try:
            for eid, payload in event_store.since(session_key, cursor):
                yield f"id: {eid}\n{payload}"
                try:
                    replayed_max = max(replayed_max, int(eid))
                except (TypeError, ValueError):
                    pass

            while True:
                try:
                    eid, payload = await asyncio.wait_for(queue.get(), timeout=_KEEPALIVE_S)
                except asyncio.TimeoutError:
                    # Keepalive comment — ignored by EventSource, keeps proxies open.
                    yield ": keepalive\n\n"
                    continue
                try:
                    seq = int(eid)
                except (TypeError, ValueError):
                    seq = None
                if seq is not None and seq <= replayed_max:
                    continue  # already sent during backlog replay
                if seq is not None:
                    replayed_max = seq
                yield f"id: {eid}\n{payload}"
        finally:
            # Client disconnect surfaces as GeneratorExit/CancelledError; always
            # drop our subscriber so the session map can't leak.
            event_store.unsubscribe(session_key, queue)

    return StreamingResponse(gen(), media_type="text/event-stream")
