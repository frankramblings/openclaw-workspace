"""One push per task, fired on an OBSERVED terminal state.

This replaces the promise-driven ping. The old path fired when a promise
resolved, which required the promise to exist and its watcher to survive —
precisely the conditions that were failing. This fires off the registry, so it
inherits the liveness rules instead of duplicating them.

`interrupted` pushes too, with copy that says outcome unknown. Silently
dropping the "I lost track of this" case would reintroduce the original
complaint in a new place.
"""
from __future__ import annotations

import logging
import time

from . import push

log = logging.getLogger(__name__)

_TERMINAL = ("done", "failed", "interrupted")
_PUSHED: set[str] = set()
# `push.send` is async; `task_registry.upsert` is sync and holds a lock when it
# calls us. The queue is the seam: on_terminal only appends (safe anywhere),
# and the ingest loop awaits drain().
_PENDING: list[dict] = []

# task_registry.sweep_boot() marks EVERY orphaned task `interrupted` at startup.
# Without this guard, one service restart would fire one notification per
# orphaned row — precisely the notification spam this whole wave exists to
# remove. Terminal events in the first WARMUP_S after import are recorded as
# already-pushed (so they never notify) but still flow through the feed.
WARMUP_S = 30.0
_STARTED = time.monotonic()


def reset_for_tests(warm: bool = True) -> None:
    """warm=True (default) puts the module past its boot warmup so tests
    exercise the normal path; pass warm=False to test the warmup guard."""
    global _STARTED
    _PUSHED.clear()
    _PENDING.clear()
    _STARTED = time.monotonic() - (WARMUP_S + 1 if warm else 0)


def pending_for_tests() -> list[dict]:
    return list(_PENDING)


def _title(rec: dict) -> str:
    return {"done": "Finished", "failed": "Failed",
            "interrupted": "Lost track"}[rec["state"]]


def _body(rec: dict) -> str:
    label = rec.get("label") or rec.get("id") or "background task"
    if rec["state"] == "done":
        return f"{label} finished."
    if rec["state"] == "failed":
        return f"{label} did not complete: {rec.get('error') or 'no error text'}"
    # Deliberately not "failed" — we never saw an exit status and will not
    # invent one. Same discipline as the row's own copy.
    return f"{label} stopped; outcome unknown."


def _payload(rec: dict) -> dict:
    """Matches the shape followup.py already sends (backend/followup.py:258)."""
    sid = rec.get("session_id") or rec.get("session_key") or ""
    return {"title": _title(rec), "body": _body(rec), "kind": "task",
            "session_id": sid, "tag": f"task-{rec.get('id')}",
            "badge": 0}


def on_terminal(rec: dict) -> bool:
    """Queue one push for a task that reached a terminal state. Sync, lock-free,
    idempotent per task id. Returns True when a push was queued."""
    if rec.get("state") not in _TERMINAL:
        return False
    tid = rec.get("id") or ""
    if not tid or tid in _PUSHED:
        return False
    _PUSHED.add(tid)
    if time.monotonic() - _STARTED < WARMUP_S:
        # Boot warmup: mark it pushed so it never notifies later either. A row
        # the boot sweep interrupted is old news by definition.
        return False
    _PENDING.append(_payload(rec))
    return True


async def drain() -> int:
    """Send every queued push. Returns the number sent. A send that fails is
    dropped rather than retried — a notification is worth one attempt, and an
    unbounded retry queue is its own failure mode."""
    sent = 0
    while _PENDING:
        payload = _PENDING.pop(0)
        try:
            await push.send(payload)
            sent += 1
        except Exception:  # noqa: BLE001 - a push failure never breaks the feed
            log.warning("task_push: send failed for %s", payload.get("tag"),
                        exc_info=True)
    return sent
