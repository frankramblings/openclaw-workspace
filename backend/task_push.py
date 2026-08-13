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
import threading
import time

from . import push

log = logging.getLogger(__name__)

_TERMINAL = ("done", "failed", "interrupted")
# key -> the STATE that was pushed (or suppressed) for it. Not a bare set: the
# first terminal state to arrive used to claim the key and permanently silence
# the authoritative one. Within ONE ingest_loop iteration, scan_once can read a
# still-running file, the process then writes `done` and exits, sweep_once
# confirms the pid dead and upserts `interrupted` (pushing "Lost track"), and
# 0.5s later the terminal-file exemption applies `done` — which then returned
# False. One push, wrong content, for a job that succeeded. Task 3b fixed that
# shape for followup rows by retiring the pid; file-backed producers have no
# equivalent, so it is fixed here instead.
_PUSHED: dict[str, str] = {}
# Guards the check-and-add on _PUSHED. upsert() is reachable from multiple
# threads (file-backed producers via task_ingest's loop, the liveness
# sweeper), so two concurrent terminal upserts of the SAME id could otherwise
# both observe "not yet pushed" and both enqueue — "exactly one notification"
# is the whole product claim here, so the check-then-add must be atomic.
_PUSHED_LOCK = threading.Lock()
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

# A finished-job banner fires on the user's phone. The complaint that started
# this project was "I would much prefer no ping and an honest, reliable
# progress bar", so a task that succeeded in under half a minute is noise: the
# user either watched it happen or never noticed it was running.
#
# The gate is DELIBERATELY ASYMMETRIC and applies to SUCCESS ONLY. `failed` and
# `interrupted` always notify however short the run was — a problem is worth
# knowing about immediately, a fast success is not. An unknown duration (a
# record missing `created` or `updated`) is never treated as fast: the same
# no-guessing rule that governs `interrupted` applies to this decision too.
MIN_SUCCESS_S = 30.0


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
    """Matches the shape followup.py already sends (backend/followup.py:258).
    `badge` is the REAL unseen count (same pattern as chat_turn.py:670), not
    a hardcoded 0 — the service worker (sw.js) runs setAppBadge/clearAppBadge
    off this field on every push, so a hardcoded 0 would wipe the user's
    unseen-followup badge every time an unrelated task finished."""
    sid = rec.get("session_id") or rec.get("session_key") or ""
    return {"title": _title(rec), "body": _body(rec), "kind": "task",
            "session_id": sid, "tag": f"task-{rec.get('id')}",
            "badge": push.unseen_count()}


def _pushed_key(tid: str, rec: dict) -> str:
    """Key `_PUSHED` on the task's identity AND its run, not the id alone.
    Some producers (bin/task --id) issue stable, timestamp-free ids that
    recur on every re-run (e.g. pm-upload-ldwm) — keying on id alone would
    silently and permanently suppress every notification after the task's
    first-ever run. The registry stamps `created` when a record is first
    inserted, so a genuine re-run (after the earlier record aged out of the
    registry) gets a fresh key while repeated upserts within one run do not.
    A missing/None `created` (a producer that doesn't set it, or a caller
    that omits the field) falls back to the bare id rather than stringifying
    `None` into the key — the same id-only dedup this module started with,
    not a new collision surface."""
    created = rec.get("created")
    return f"{tid}:{created}" if created is not None else tid


def _supersedes(pushed_state: str, new_state: str) -> bool:
    """Exactly ONE upgrade is allowed per key: `interrupted` -> a real exit
    status. "We lost track of it" is the weakest claim this module can make, so
    an observed `done`/`failed` that lands afterwards is strictly better
    information and must be allowed to correct the banner already sent. The
    reverse is never allowed (a confirmed outcome is not downgraded to "lost
    track"), `interrupted` never supersedes itself, and once the key holds a
    real exit status nothing further can re-push — this is not a door to
    unlimited re-notification."""
    return pushed_state == "interrupted" and new_state in ("done", "failed")


def _too_fast_to_notify(rec: dict) -> bool:
    """See MIN_SUCCESS_S. Success only; unknown duration is never 'fast'."""
    if rec.get("state") != "done":
        return False
    created, updated = rec.get("created"), rec.get("updated")
    if created is None or updated is None:
        return False
    return (updated - created) / 1000.0 < MIN_SUCCESS_S


def on_terminal(rec: dict) -> bool:
    """Queue one push for a task that reached a terminal state. Sync,
    idempotent per (task id, run) apart from the single interrupted -> real
    exit status upgrade. Returns True when a push was queued."""
    state = rec.get("state")
    if state not in _TERMINAL:
        return False
    tid = rec.get("id") or ""
    if not tid:
        return False
    key = _pushed_key(tid, rec)
    warm = time.monotonic() - _STARTED >= WARMUP_S
    # Build the payload BEFORE claiming the dedup key. If _payload raises (a
    # malformed rec, a push.unseen_count() read failure), the key must not
    # already be in _PUSHED — that would silently and PERMANENTLY silence
    # this task id/run, which is worse than the one failed attempt. A
    # duplicate call that loses the race just below simply discards its
    # speculatively-built payload.
    payload = _payload(rec) if warm else None
    with _PUSHED_LOCK:
        prior = _PUSHED.get(key)
        upgrade = prior is not None and _supersedes(prior, state)
        if prior is not None and not upgrade:
            return False
        _PUSHED[key] = state
    if not warm:
        # Boot warmup: mark it pushed so it never notifies later either. A row
        # the boot sweep interrupted is old news by definition.
        return False
    # The duration gate never blocks an UPGRADE: leaving the user parked on a
    # false "Lost track" banner because the correction happened to be quick is
    # the same dishonesty this wave exists to remove. The key is already
    # claimed above, so a suppressed fast success still never notifies later.
    if not upgrade and _too_fast_to_notify(rec):
        return False
    _PENDING.append(payload)
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
