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
children exit, and the producer's detail is still about the same job).
"""
from __future__ import annotations

from . import task_registry
from .task_ingest import normalize_terminal

_LIVE = ("running", "stalled")
_BOUND: dict[str, str] = {}        # producer task id -> observed row id


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
    if bound and task_registry.get(bound) is not None:
        return bound
    rows = _live_observed()
    if str(pid_raw or "").isdigit():
        pid = int(pid_raw)
        for row in rows:
            if pid in ((row.get("extra") or {}).get("subtree") or []):
                _BOUND[tid] = row["id"]
                return row["id"]
        return None
    if not session_key:
        return None
    candidates = [r for r in rows if r.get("session_key") == session_key]
    if len(candidates) != 1:
        return None               # zero: nothing to attach to. two: a guess.
    _BOUND[tid] = candidates[0]["id"]
    return candidates[0]["id"]


def state_for(native: dict, row_id: str) -> str | None:
    """The state an attached producer is allowed to impose: its own terminal
    word, or None meaning "leave the observer's state alone". A producer may
    say "I finished"; it may not say "I am alive" — that claim belongs to
    whoever can see the process."""
    return normalize_terminal(native.get("status"))
