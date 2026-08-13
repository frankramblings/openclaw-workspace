"""Process-tree primitives: who exists, and who descends from whom.

The observer's whole claim to honesty is that it reads existence from the
kernel rather than from a producer's self-report, so this module is the only
place that walks /proc for the tree shape. Identity — "is this pid still the
same process?" — deliberately lives in task_liveness and is imported, not
re-implemented: two copies of the starttime parse would be two chances to
disagree about a recycled pid, and disagreement there means a row claiming a
life it cannot see.

`chains` is the answer to the spike's shape A. One `bin/task run` job is three
simultaneously-live processes (the python wrapper, the bash it spawns, the
sleep that bash spawns). Keying a row on each surviving pid gives three rows
for one job; keying on the shell's direct child gives one, and the whole
subtree stays attached to it so a producer publishing ANY pid in the chain can
still be matched to it.
"""
from __future__ import annotations

import logging
import os

from .task_liveness import _read_proc_stat_text, _stat_fields_after_comm

log = logging.getLogger(__name__)


def read_proc(pid: int) -> dict | None:
    """A process's parent, start time and command line, or None if it is gone
    or unreadable. Never raises: a pid that exits between listdir and read is
    the normal case in a live scan."""
    text = _read_proc_stat_text(pid)
    if text is None:
        return None
    fields = _stat_fields_after_comm(text)
    # ppid is field 4 (index 1 into the post-comm remainder), starttime is
    # field 22 (index 19) — the same offsets task_liveness documents.
    if fields is None or len(fields) < 20:
        return None
    try:
        ppid = int(fields[1])
        starttime = int(fields[19])
    except (ValueError, IndexError):
        return None
    return {"ppid": ppid, "starttime": starttime, "cmdline": read_cmdline(pid)}


def read_cmdline(pid: int) -> str:
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            raw = f.read()
    except OSError:
        return ""
    return raw.replace(b"\0", b" ").decode("utf-8", "replace").strip()


def snapshot() -> dict[int, dict]:
    """Every readable process on the box. Measured at 4.5 ms over 256
    processes — 0.45% of a core at the observer's 1 Hz poll."""
    out: dict[int, dict] = {}
    try:
        names = os.listdir("/proc")
    except OSError:
        log.warning("proc_tree: /proc unreadable", exc_info=True)
        return out
    for name in names:
        if not name.isdigit():
            continue
        pid = int(name)
        info = read_proc(pid)
        if info is not None:
            out[pid] = info
    return out


def _children_index(procs: dict[int, dict]) -> dict[int, list[int]]:
    kids: dict[int, list[int]] = {}
    for pid, info in procs.items():
        kids.setdefault(info["ppid"], []).append(pid)
    return kids


def descendants(procs: dict[int, dict], root: int) -> set[int]:
    """Every process below `root`, exclusive of root itself."""
    kids = _children_index(procs)
    out: set[int] = set()
    stack = list(kids.get(root, []))
    while stack:
        pid = stack.pop()
        if pid in out:
            continue
        out.add(pid)
        stack.extend(kids.get(pid, []))
    return out


def chains(procs: dict[int, dict], shell_pid: int) -> dict[int, set[int]]:
    """One entry per direct child of the shell, mapped to that child's whole
    subtree (including itself). One job, one entry — see the module docstring."""
    kids = _children_index(procs)
    out: dict[int, set[int]] = {}
    for child in kids.get(shell_pid, []):
        out[child] = {child} | descendants(procs, child)
    return out


def key_for(pid: int, procs: dict[int, dict]) -> str:
    """A recycle-proof identity for a process: pid plus its start time. Two
    different processes can share a pid over a boot; they cannot share both."""
    info = procs.get(pid) or {}
    return f"{pid}:{info.get('starttime', 0)}"
