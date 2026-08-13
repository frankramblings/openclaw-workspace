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

# key -> {"first": float, "row_id": str|None, "terminal_key": str,
#         "session_key": str|None, "subtree": set[int], "label": str,
#         "cmdline": str, "shell": int}
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
        if not (env["start"] <= first and last <= env["end"] + 1.0):
            continue
        contained = [k for k, s in chain_lives.items()
                     if env["start"] <= s["first"] and s["last"] <= env["end"] + 1.0]
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
                    "label": "",
                }
            state["last"] = now
            state["subtree"] = set(subtree)
            if state["row_id"] is not None:
                continue
            if now - state["first"] < config.OBSERVE_THRESHOLD_S:
                continue
            # The human typed a command; prefer their words to a cmdline that
            # may be a wrapper ("python3 .../bin/task run --id x").
            state["label"] = (_open_envelope_text(envelopes, state["first"])
                              or state["cmdline"])[:160]
            state["row_id"] = f"observed:{key}"
            task_registry.upsert(
                state["row_id"], kind="observed", source="observed",
                label=state["label"], session_key=state["session_key"],
                state="running", detail="",
                extra={"pid": root_pid, "subtree": sorted(subtree),
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
        envelopes = _envelopes_for(state["terminal_key"])
        siblings = {k: s for k, s in lives.items()
                    if s["terminal_key"] == state["terminal_key"]}
        outcome = _outcome_for(state, envelopes, siblings)
        detail = ("" if outcome in ("done", "failed")
                  else "stopped; outcome unknown")
        task_registry.upsert(state["row_id"], kind="observed", source="observed",
                             state=outcome, detail=detail)
        changed += 1
    return changed
