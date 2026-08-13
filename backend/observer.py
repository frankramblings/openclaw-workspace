"""Observer: rows that exist because a process was SEEN.

Two sources of truth, deliberately unequal:

  * The process tree owns EXISTENCE and STATE. A chain of processes descending
    from a PTY shell either is there or is not, and nothing a producer writes
    can contradict that.
  * The shell hook owns the COMMAND ENVELOPE — text, start, end, exit code —
    and is the only way to learn a real exit status for foreground work.

One job is one row. The tree is collapsed into chains (proc_tree.chains), so
`bin/task run -- ffmpeg` is a single row keyed on the shell's direct child even
though three processes are alive; the whole subtree rides along in
`extra["subtree"]` so a producer publishing any pid in the chain can be matched
to it later (see task_merge).

Attribution of an exit code is strict, because the alternative is guessing:
a closed envelope is attributed to a chain only when the chain's entire life
sits inside the envelope's window AND exactly one chain lived inside it. A
foreground shell runs commands serially, so one chain inside one envelope is
strong evidence; two overlapping chains is a coin flip. An envelope that
backgrounded something (`outcome_known` False) never attributes an outcome at
all — the spike's shape B closed in 1.1 ms with exit 0 for an 18-second job.
Everything unattributed closes as `interrupted`: "we watched it stop and never
saw a status", which is exactly what happened.
"""
from __future__ import annotations

import logging
import time

from . import config, proc_tree, shell_hook, task_registry

log = logging.getLogger(__name__)

# Slack on the envelope's `end` boundary, shared by both containment checks in
# _outcome_for: the chain's own life and the "how many chains lived inside
# this envelope" count must agree on the same boundary, or "exactly one
# contained chain" stops meaning what its comment says.
_ENVELOPE_SLACK_S = 1.0

# key -> {"first": float, "row_id": str|None, "terminal_key": str,
#         "session_key": str|None, "subtree": set[int], "label": str,
#         "cmdline": str, "shell": int, "written_subtree": list[int]|None}
_SEEN: dict[str, dict] = {}
_OFFSETS: dict[str, int] = {}          # terminal key -> hook-log byte offset
_TEXT: dict[str, str] = {}             # terminal key -> recent hook-log text


def reset_for_tests() -> None:
    _SEEN.clear()
    _OFFSETS.clear()
    _TEXT.clear()


def _live_shells() -> dict[str, int]:
    from . import terminals
    return terminals.live_shells()


def _session_key_for(terminal_key: str) -> str | None:
    """The CHAT session a terminal belongs to, so the row lands in the right
    conversation. Unknown keys ("global", a terminal with no chat) still get a
    row — it shows in the global feed rather than nowhere."""
    try:
        from . import sessions_store
        rec = sessions_store.get(terminal_key)
        return (rec or {}).get("sessionKey")
    except Exception:  # noqa: BLE001 - attribution is a nicety, never fatal
        return None


def _envelopes_for(terminal_key: str) -> list[dict]:
    """Every command the shell has recently reported.

    The log is tailed incrementally but PARSED WHOLE, against a bounded text
    buffer. Parsing each chunk on its own would lose exactly the pairing this
    module depends on: a long command's `start` line arrives in one poll and
    its `end` line minutes later, and a chunk holding only the `end` line
    parses to nothing. 64 KB at 1 Hz is free, and a buffer cut mid-line just
    drops that line."""
    path = shell_hook.log_path(terminal_key)
    prev = _OFFSETS.get(terminal_key, 0)
    text, offset = shell_hook.read_new(path, prev)
    if offset < prev:
        _TEXT.pop(terminal_key, None)         # log was replaced: new shell
    _OFFSETS[terminal_key] = offset
    if text:
        _TEXT[terminal_key] = (_TEXT.get(terminal_key, "") + text)[-65536:]
    return shell_hook.parse(_TEXT.get(terminal_key, ""))


def _outcome_for(state: dict, envelopes: list[dict], chain_lives: dict) -> str:
    """`done`/`failed` when one closed envelope unambiguously owns this chain's
    whole life, else `interrupted`. See the module docstring for why the bar is
    this high."""
    first, last = state["first"], state["last"]
    for env in envelopes:
        if not env.get("outcome_known") or env.get("end") is None:
            continue
        if not (env["start"] <= first and last <= env["end"] + _ENVELOPE_SLACK_S):
            continue
        contained = [k for k, s in chain_lives.items()
                     if env["start"] <= s["first"]
                     and s["last"] <= env["end"] + _ENVELOPE_SLACK_S]
        if len(contained) != 1:
            continue                          # ambiguous: do not guess
        return "done" if env.get("exit_code") == 0 else "failed"
    return "interrupted"


def _open_envelope_text(envelopes: list[dict], at: float) -> str:
    for env in reversed(envelopes):
        if env.get("end") is None and env["start"] <= at:
            return env["text"]
    return ""


def observe_once(now: float | None = None) -> int:
    """One poll: surface chains past the threshold, close chains that vanished.
    Returns the number of registry writes made (0 on a quiet pass — an idle
    observer must not fan out an SSE frame per second)."""
    now = time.time() if now is None else now
    procs = proc_tree.snapshot()
    shells = _live_shells()
    changed = 0
    alive_keys: set[str] = set()

    for terminal_key, shell_pid in shells.items():
        envelopes = _envelopes_for(terminal_key)
        chains = proc_tree.chains(procs, shell_pid)
        for root_pid, subtree in chains.items():
            key = proc_tree.key_for(root_pid, procs)
            alive_keys.add(key)
            state = _SEEN.get(key)
            if state is None:
                state = _SEEN[key] = {
                    "first": now, "last": now, "row_id": None,
                    "terminal_key": terminal_key,
                    "session_key": _session_key_for(terminal_key),
                    "subtree": set(subtree), "shell": shell_pid,
                    "cmdline": (procs.get(root_pid) or {}).get("cmdline", ""),
                    "label": "", "written_subtree": None,
                }
            state["last"] = now
            state["subtree"] = set(subtree)
            if state["row_id"] is not None:
                # A chain can grow after it's surfaced (a worker forked
                # later). Re-upsert only when the sorted subtree actually
                # differs from what the REGISTRY last got — comparing against
                # the process tree's own `state["subtree"]` would re-write on
                # every poll; comparing against nothing would leave the row's
                # extra["subtree"] frozen at second 6 forever, and Task 5's
                # merge matches a producer's pid against exactly that field.
                sorted_subtree = sorted(subtree)
                if sorted_subtree != state["written_subtree"]:
                    state["written_subtree"] = sorted_subtree
                    # `state` and `detail` are the two fields task_registry
                    # .upsert applies UNCONDITIONALLY on every call (unlike
                    # label/pct/eta, which empty args never clobber) —
                    # producers own both, per the plan's "producers own
                    # detail; observers own existence and state". Hardcoding
                    # them here would wipe a producer's live status text on
                    # every child fork/reap, and would resurrect a row a
                    # producer already finished (its process can still be
                    # alive for a moment after `bin/task` writes `done`).
                    # Read the current record and pass its own state/detail
                    # straight through, so this write touches
                    # extra["subtree"] and nothing else. If the record is
                    # gone, skip the write rather than recreating it.
                    existing = task_registry.get(state["row_id"])
                    if existing is not None:
                        task_registry.upsert(
                            state["row_id"], kind="observed", source="observed",
                            state=existing["state"], detail=existing["detail"],
                            extra={"subtree": sorted_subtree})
                        changed += 1
                continue
            if now - state["first"] < config.OBSERVE_THRESHOLD_S:
                continue
            # The human typed a command; prefer their words to a cmdline that
            # may be a wrapper ("python3 .../bin/task run --id x").
            state["label"] = (_open_envelope_text(envelopes, state["first"])
                              or state["cmdline"])[:160]
            state["row_id"] = f"observed:{key}"
            state["written_subtree"] = sorted(subtree)
            task_registry.upsert(
                state["row_id"], kind="observed", source="observed",
                label=state["label"], session_key=state["session_key"],
                state="running", detail="",
                extra={"pid": root_pid, "subtree": state["written_subtree"],
                       "observed": True})
            changed += 1

    # Anything we were watching that is no longer in any live shell's tree has
    # stopped — including every chain of a shell that itself exited.
    #
    # The snapshot is taken BEFORE the loop pops anything. Two chains that die
    # in the same pass are each other's evidence of ambiguity: pop the first
    # one and the second would look like the only chain in its envelope and
    # wrongly inherit that envelope's exit code.
    closing = [k for k in _SEEN if k not in alive_keys]
    lives = dict(_SEEN)
    for key in closing:
        state = _SEEN.pop(key)
        if state["row_id"] is None:
            continue                          # never surfaced, nothing to close
        # Read the record BEFORE writing, exactly as the growth write above
        # does, and for the same reason: `state` and `detail` always apply on
        # an upsert, so an unconditional write here can replace a CONFIRMED
        # outcome with a weaker one. A pid-attached producer marks the row
        # `done` before its own process exits (`bin/task` writes the terminal
        # file, then returns), so the chain vanishing a beat later would
        # overwrite that with `interrupted` and an empty detail. On the
        # ordinary path the next scan re-corrects it two SSE frames later; it
        # does NOT re-correct when the producer's file has aged past
        # RETAIN_TERMINAL_S, when `bin/task rm` removed the file, or for a
        # `bin/job` producer (whose branch does not merge at all) — and a row
        # that says "stopped; outcome unknown" about a job that succeeded is
        # the lie in the other direction. A record we no longer hold is not
        # recreated either, same as the growth write.
        existing = task_registry.get(state["row_id"])
        if existing is None or existing["state"] in ("done", "failed"):
            continue
        envelopes = _envelopes_for(state["terminal_key"])
        siblings = {k: s for k, s in lives.items()
                    if s["terminal_key"] == state["terminal_key"]}
        outcome = _outcome_for(state, envelopes, siblings)
        # Carry the producer's last detail line through a confirmed ending
        # rather than blanking it: the outcome is ours to state, the context
        # is the producer's and is still true. `interrupted` is the one case
        # that replaces it — "stopped; outcome unknown" is a statement about
        # the row that the stale progress text would otherwise contradict.
        detail = (existing["detail"] if outcome in ("done", "failed")
                  else "stopped; outcome unknown")
        task_registry.upsert(state["row_id"], kind="observed", source="observed",
                             state=outcome, detail=detail)
        changed += 1

    # Drop hook-log cursors for terminals with no live shell this poll. Must
    # run AFTER the closing loop above, which deliberately re-reads a
    # just-exited shell's log one last time to pick up its final `end` line —
    # pruning first would make that read start from an empty buffer. Left
    # unpruned, _OFFSETS/_TEXT would hold an int and up to 64 KB of text per
    # terminal key ever seen, for the life of the process.
    live_terminal_keys = set(shells)
    stale = (set(_OFFSETS) | set(_TEXT)) - live_terminal_keys
    for k in stale:
        _OFFSETS.pop(k, None)
        _TEXT.pop(k, None)
    return changed
