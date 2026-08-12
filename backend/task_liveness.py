"""Confirm-or-stall: the liveness half of the honest-progress invariant.

A row may not claim its work is alive without confirmation. The mirror of that
rule is what makes this module small and strict: a row may not claim its work
is DEAD without confirmation either. Elapsed silence is evidence of nothing —
a producer that reports every ten minutes is not a corpse — so a quiet record
with no pid to check goes to `stalled` and says how long it has been quiet.
Only a pid we can positively observe to be gone yields `interrupted`.

`interrupted` means "lost track of this, outcome unknown". It never means
"failed"; we did not see an exit status and will not invent one.

`os.kill(pid, 0)` succeeding is not, by itself, confirmation of anything: pids
get recycled, so a pid that exists might belong to a completely different,
later process than the one this record started. `pid_matches_record` closes
that gap with a stateless identity check against `/proc/<pid>/stat`'s real
process-start time; `sweep_once` only treats a pid as confirmed-alive when
BOTH `pid_alive` and `pid_matches_record` agree. A pid that exists but fails
the identity check is a recycled pid — not confirmed alive (that would be the
exact false claim this check exists to prevent) and not confirmed dead either
(the original process may still be alive somewhere we never observed) — so it
collapses to unknown, the same no-confirmation path as everything else this
module cannot verify.
"""
from __future__ import annotations

import logging
import os
import time

from . import task_registry

log = logging.getLogger(__name__)

SWEEP_S = 5.0
STALE_S = 30.0

# Slack absorbing ordering skew between a producer spawning its child and
# writing the task record: the child's real start time may land a hair
# before the record's `created` stamp even when it IS the right process.
PID_RECYCLE_SLACK_S = 120.0

_LIVE = ("running", "stalled")


def pid_alive(pid: int) -> bool | None:
    """True/False, or None when the answer is unknowable (pid not ours to
    signal). Unknowable is NOT death — it routes to the no-confirmation path."""
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True          # exists, owned by someone else
    except (OSError, TypeError, ValueError):
        return None


def _parse_starttime_ticks(stat_text: str) -> int | None:
    """Field 22 (starttime, in clock ticks since boot) of a `/proc/<pid>/stat`
    line, or None if the line can't be parsed. Field 2 (comm) is the process
    name in parentheses and MAY CONTAIN SPACES AND PARENTHESES itself (e.g. a
    process literally named "weird (name) proc") — so this splits on the
    LAST ')' in the line rather than field-splitting naively, which would
    misalign every field after comm for such a process."""
    idx = stat_text.rfind(")")
    if idx == -1:
        return None
    # Everything after the closing paren starts at field 3 (state); field 22
    # is therefore index 19 into this remainder (22 - 3 = 19).
    fields = stat_text[idx + 1:].split()
    if len(fields) < 20:
        return None
    try:
        return int(fields[19])
    except (ValueError, IndexError):
        return None


def _read_proc_stat_text(pid: int) -> str | None:
    try:
        with open(f"/proc/{pid}/stat") as f:
            return f.read()
    except OSError:
        return None


def _boot_time_epoch() -> int | None:
    try:
        with open("/proc/stat") as f:
            for line in f:
                if line.startswith("btime "):
                    return int(line.split()[1])
    except (OSError, ValueError, IndexError):
        return None
    return None


def _proc_start_epoch(pid: int) -> float | None:
    """A pid's real start time as a wall-clock epoch, or None if unreadable
    (no /proc, permission denied, malformed content — any of it)."""
    text = _read_proc_stat_text(pid)
    if text is None:
        return None
    ticks = _parse_starttime_ticks(text)
    if ticks is None:
        return None
    btime = _boot_time_epoch()
    if btime is None:
        return None
    try:
        clk_tck = os.sysconf("SC_CLK_TCK")
        if not clk_tck:
            return None
        return btime + ticks / clk_tck
    except (OSError, ValueError):
        return None


def pid_matches_record(pid: int, created_ms: int,
                        slack_s: float = PID_RECYCLE_SLACK_S) -> bool | None:
    """Whether `pid`'s real start time is consistent with it being the same
    process that was running when this record's `created` (epoch ms) was
    stamped. True: consistent — this pid's owner started at or before
    `created` (plus slack). False: this pid's owner started materially AFTER
    `created` — it cannot be the original process, i.e. the pid was recycled.
    None: unknowable (anything unreadable), which is never a mismatch."""
    start_epoch = _proc_start_epoch(pid)
    if start_epoch is None:
        return None
    created_epoch = (created_ms or 0) / 1000.0
    return start_epoch <= created_epoch + slack_s


def _confirm_alive(pid, created_ms) -> bool | None:
    """The tri-state signal sweep_once needs, folding the identity check
    into the existence check. A pid that exists but fails
    `pid_matches_record` is a recycled pid: it is not confirmed alive (the
    false claim this whole check exists to prevent) and not confirmed dead
    (the original process could still be alive under a pid we never
    observed) — so it collapses to unknown, same as any other
    no-confirmation case."""
    if not pid:
        return None
    exists = pid_alive(int(pid))
    if exists is not True:
        return exists  # False (confirmed dead) or None (unknown) pass through
    return True if pid_matches_record(int(pid), created_ms) else None


def next_state(rec: dict, now_ms: int, alive: bool | None) -> str | None:
    """The state this record should move to, or None to leave it alone."""
    if rec.get("state") not in _LIVE:
        return None
    if alive is False:
        return "interrupted"
    quiet_s = (now_ms - int(rec.get("updated") or 0)) / 1000.0
    if quiet_s > STALE_S:
        return "stalled" if rec["state"] != "stalled" else None
    if alive is True and rec["state"] == "stalled":
        return "running"
    return None


def _quiet_detail(rec: dict, now_ms: int) -> str:
    mins = max(0, int((now_ms - int(rec.get("updated") or 0)) / 60_000))
    if mins < 60:
        return f"no update in {mins}m"
    return f"no update in {mins // 60}h{mins % 60:02d}m"


def sweep_once(now_ms: int | None = None) -> int:
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    changed = 0
    for rec in task_registry.list_tasks():
        pid = (rec.get("extra") or {}).get("pid")
        alive = _confirm_alive(pid, rec.get("created") or 0)
        state = next_state(rec, now_ms, alive)
        if not state:
            continue
        detail = ("lost track of this process; outcome unknown"
                  if state == "interrupted" else
                  _quiet_detail(rec, now_ms) if state == "stalled" else
                  rec.get("detail") or "")
        task_registry.upsert(rec["id"], kind=rec["kind"], source=rec["source"],
                             state=state, detail=detail)
        changed += 1
    return changed
