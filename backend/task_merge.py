"""One logical job, one row.

`bin/task run -- ffmpeg …` is three things at once: a shell command, a chain of
processes, and a progress.json. The observer already owns the first two. This
module decides whether a producer's file is describing that same job, so its
detail lands on the observed row instead of opening a second one.

The rule is ancestry, not equality. The 2026-08-12 spike measured what
`bin/task run` actually looks like: `python3 bin/task` (the chain root) →
`bash -c …` → `sleep`, with the producer publishing the MIDDLE pid. Comparing
the producer's pid to the row's own pid matches nothing; asking whether the
producer's pid lives anywhere in the row's subtree matches exactly.

Producers with no pid (`bin/task start`, which is how the long-running jobs on
this box are actually created) fall back to sessionKey — and only when it names
exactly one live observed row. Two candidates means we do not know, and the
producer keeps its own row rather than being attached to a guess.

Attachment is sticky: once a producer has been bound to a row, it keeps that
row even after its pid leaves the subtree (a chain collapses toward its root as
children exit, and the producer's detail is still about the same job). But
sticky is bounded, not permanent: the binding is honored only while the row is
still live, or the producer is reporting its own terminal word on this pass —
a caller-chosen id (`--id nightly`) can be reused for a brand-new run while the
finished row from the LAST run is still inside its RETAIN_TERMINAL_S retention
window, and `task_registry.get` would otherwise keep returning that finished
row for up to 15 minutes, letting a new run's detail land on an already-closed
one. A stale binding is dropped and re-derived from scratch instead.

Not every attach is equally trustworthy, either. A pid found in the row's
subtree is proof — nothing else in this chat could BE that subtree. "Exactly
one live observed row in this chat" is much weaker: it is only the absence of
a second candidate, not evidence this producer IS that row's job (the observer
surfaces a row for any long-lived command, not just `bin/task` chains). So a
session-fallback attach is SOFT: it may contribute pct/eta/detail, but it may
never relabel the row or declare its outcome — only a pid-proven attach has
that authority. `attach_method` reports which kind of attach is in effect so
callers (task_ingest's `_upsert_attached`) can tell the difference.
"""
from __future__ import annotations

from . import task_registry
from .task_ingest import normalize_terminal

_LIVE = ("running", "stalled")
# producer task id -> (observed row id, "pid" | "session")
_BOUND: dict[str, tuple[str, str]] = {}


def reset_for_tests() -> None:
    _BOUND.clear()


def _live_observed() -> list[dict]:
    return [r for r in task_registry.list_tasks(source="observed")
            if r["state"] in _LIVE]


def target_for(native: dict, session_key: str | None) -> str | None:
    """The observed row this producer record belongs to, or None to keep its
    own row."""
    pid_raw = native.get("pid")
    tid = str(native.get("id") or "")
    bound = _BOUND.get(tid)
    if bound is not None:
        row_id, _method = bound
        row = task_registry.get(row_id)
        # Honor the existing binding only while the row is still live, or the
        # producer is reporting its own terminal word THIS pass (so a
        # producer's final "completed" still lands on the row it actually
        # ran with, even a beat after that row closed). Otherwise the id may
        # have been reused for a NEW run — drop the stale entry and re-derive
        # from the currently-live rows below, same as a never-bound producer.
        if row is not None and (row["state"] in _LIVE
                                 or normalize_terminal(native.get("status")) is not None):
            return row_id
        del _BOUND[tid]
    rows = _live_observed()
    if str(pid_raw or "").isdigit():
        pid = int(pid_raw)
        for row in rows:
            if pid in ((row.get("extra") or {}).get("subtree") or []):
                _BOUND[tid] = (row["id"], "pid")
                return row["id"]
        return None
    if not session_key:
        return None
    candidates = [r for r in rows if r.get("session_key") == session_key]
    if len(candidates) != 1:
        return None               # zero: nothing to attach to. two: a guess.
    _BOUND[tid] = (candidates[0]["id"], "session")
    return candidates[0]["id"]


def attach_method(native: dict, row_id: str) -> str | None:
    """"pid" or "session" — the evidence that currently binds native's
    producer id to row_id, or None if it is not (currently) bound to row_id
    at all. "pid" means the producer's own pid was found inside the row's
    subtree (full authority). "session" means only sessionKey matched (soft
    evidence: group membership, not proof of identity)."""
    bound = _BOUND.get(str(native.get("id") or ""))
    if bound is None or bound[0] != row_id:
        return None
    return bound[1]


def state_for(native: dict, row_id: str) -> str | None:
    """The state an attached producer is allowed to impose: its own terminal
    word, or None meaning "leave the observer's state alone". A producer may
    say "I finished"; it may not say "I am alive" — that claim belongs to
    whoever can see the process. A session-fallback attach is soft evidence
    and never gets to declare the row's outcome — only a pid-proven attach
    (attach_method == "pid") may."""
    if attach_method(native, row_id) != "pid":
        return None
    return normalize_terminal(native.get("status"))
