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

A producer with NO usable pid keeps its own row. The spec's amendment 3 called
for a sessionKey fallback here; the final whole-branch review measured the real
workload instead of the spike and the controller disabled it (see the comment
at `target_for`'s pidless return). `sessionKey` names a chat, not a job.

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

A pid found in the row's subtree is proof — nothing else in this chat could BE
that subtree — and it is now the ONLY evidence that binds anything, so an
attach always carries full authority (label, error, terminal word).
`attach_method` still reports which evidence is in effect, both because
`_upsert_attached` asks before writing a producer's claims onto a row and
because wave 2b will add a second, weaker kind (the systemd follower).
"""
from __future__ import annotations

from . import task_registry
from .task_ingest import normalize_terminal

_LIVE = ("running", "stalled")
# producer task id -> observed row id it is bound to. The binding is always
# pid-proven; see target_for.
_BOUND: dict[str, str] = {}


def reset_for_tests() -> None:
    _BOUND.clear()


def _live_observed() -> list[dict]:
    return [r for r in task_registry.list_tasks(source="observed")
            if r["state"] in _LIVE]


def target_for(native: dict, session_key: str | None) -> str | None:
    """The observed row this producer record belongs to, or None to keep its
    own row. `session_key` no longer decides anything (the fallback that read
    it is disabled below); it stays in the signature because it is the key
    wave 2b's systemd follower will correlate on once it has a real pid to
    correlate WITH."""
    pid_raw = native.get("pid")
    tid = str(native.get("id") or "")
    row_id = _BOUND.get(tid)
    if row_id is not None:
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
    if not str(pid_raw or "").isdigit():
        # No usable pid: keep your own row. There WAS a sessionKey fallback
        # here ("attach when the chat has exactly one live observed row"),
        # per the spec's amendment 3. The final whole-branch review checked
        # the real workload rather than the spike: every flagship producer on
        # this box (pm-upload-*, bwg-*, bin/podmigrate/progress_emit.py)
        # writes sessionKey with NO pid and runs under `systemd-run --user`,
        # so it is never inside a PTY shell's process tree and can never be
        # the observed row. For exactly those jobs the fallback could
        # therefore only ever bind to an UNRELATED command — stamping a
        # multi-hour upload's percentage onto another row under another
        # label, and (now that a merge retracts the row it drops) making its
        # own row vanish and reappear as that command comes and goes.
        # "Exactly one candidate" is the absence of a second guess, not
        # evidence of identity; sessionKey identifies a chat, not a job.
        # Correlating these producers is wave 2b's systemd follower's job —
        # it can read ExecMainPID and feed this same pid-and-ancestry rule —
        # not a heuristic's. Two rows is what main does today, so keeping our
        # own row is an un-improvement, never a lie.
        return None
    pid = int(pid_raw)
    for row in _live_observed():
        if pid in ((row.get("extra") or {}).get("subtree") or []):
            _BOUND[tid] = row["id"]
            return row["id"]
    return None


def attach_method(native: dict, row_id: str) -> str | None:
    """"pid" — the producer's own pid was found inside row_id's subtree, the
    only evidence that binds anything and full authority over the row — or
    None if this producer is not (currently) bound to row_id at all."""
    return "pid" if _BOUND.get(str(native.get("id") or "")) == row_id else None


def state_for(native: dict, row_id: str) -> str | None:
    """The state an attached producer is allowed to impose: its own terminal
    word, or None meaning "leave the observer's state alone". A producer may
    say "I finished"; it may not say "I am alive" — that claim belongs to
    whoever can see the process. Only a pid-proven attach may declare the
    row's outcome; a producer that is not bound to this row imposes
    nothing."""
    if attach_method(native, row_id) != "pid":
        return None
    return normalize_terminal(native.get("status"))
