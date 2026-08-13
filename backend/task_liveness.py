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

Round-1 review fixes: the quiet clock used to be `rec["updated"]`, but
`task_registry.upsert` bumps `updated` on EVERY call — including this
module's own writes. That let a live-but-silent pid's row flap forever
(mark `stalled`, which touches `updated`, which reads as fresh again next
sweep, which flips it straight back to `running`). Producers now stamp
`extra["producer_ms"]` themselves; the sweeper reads it and never writes it,
so its own upserts can no longer feed the clock that decides whether to
trust it. Records from a producer that doesn't set it fall back to
`rec["updated"]`, unchanged from before. A pid that exists but is a zombie
(exited, not yet reaped by its parent) is also not confirmation of life —
`os.kill(pid, 0)` still succeeds for one — so that reads as unknown too, the
same shape of false-alive claim recycling was raised to close.
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


def _stat_fields_after_comm(stat_text: str) -> list[str] | None:
    """Fields 3 onward of a `/proc/<pid>/stat` line, or None if unparsable.
    Field 2 (comm) is the process name in parentheses and MAY CONTAIN SPACES
    AND PARENTHESES itself (e.g. a process literally named "weird (name)
    proc") — so this splits on the LAST ')' in the line rather than
    field-splitting naively, which would misalign every field after comm for
    such a process."""
    idx = stat_text.rfind(")")
    if idx == -1:
        return None
    return stat_text[idx + 1:].split()


def _parse_starttime_ticks(stat_text: str) -> int | None:
    """Field 22 (starttime, in clock ticks since boot), or None if the line
    can't be parsed."""
    fields = _stat_fields_after_comm(stat_text)
    # Field 22 is index 19 into the post-comm remainder (22 - 3 = 19, since
    # the remainder starts at field 3).
    if fields is None or len(fields) < 20:
        return None
    try:
        return int(fields[19])
    except (ValueError, IndexError):
        return None


def _parse_state_field(stat_text: str) -> str | None:
    """Field 3 (process state — 'R' running, 'S' sleeping, 'Z' zombie, ...),
    index 0 of the same post-comm remainder `_parse_starttime_ticks` splits,
    or None if the line can't be parsed."""
    fields = _stat_fields_after_comm(stat_text)
    if not fields:
        return None
    return fields[0]


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


def _proc_is_zombie(pid: int) -> bool:
    """True only when `/proc/<pid>/stat` is readable AND says state 'Z'.
    Unreadable is NOT reported as zombie — that would be a death claim from
    an unrelated signal; it just falls through to the normal identity check,
    which has its own unreadable→unknown handling."""
    text = _read_proc_stat_text(pid)
    if text is None:
        return False
    return _parse_state_field(text) == "Z"


def _confirm_alive(pid, created_ms) -> bool | None:
    """The tri-state signal sweep_once needs, folding the identity check and
    the zombie check into the existence check.

    A pid that exists but fails `pid_matches_record` is a recycled pid: not
    confirmed alive (the false claim that check exists to prevent) and not
    confirmed dead (the original process could still be alive under a pid we
    never observed) — so it collapses to unknown, same as any other
    no-confirmation case.

    A pid that exists but is a zombie (exited, not yet reaped by its parent)
    is the same shape of false-alive claim: `os.kill(pid, 0)` still succeeds
    for it. Also collapses to unknown, not to confirmed-dead — the parent
    may be about to reap it and write a real terminal status, and we did not
    observe that either.

    A non-numeric/non-castable pid must not raise out of here: sweep_once
    iterates every row in one pass, and one bad `extra["pid"]` value must
    never abort the whole sweep and leave every OTHER row un-reconciled."""
    if not pid:
        return None
    try:
        pid_int = int(pid)
    except (TypeError, ValueError):
        return None
    exists = pid_alive(pid_int)
    if exists is not True:
        return exists  # False (confirmed dead) or None (unknown) pass through
    if _proc_is_zombie(pid_int):
        return None
    return True if pid_matches_record(pid_int, created_ms) else None


def _quiet_clock_ms(rec: dict) -> int:
    """The timestamp the quiet clock is measured against: a producer's own
    `extra["producer_ms"]` stamp when one was set, else the registry's
    `updated`. The fallback is only accurate for producers that never set
    producer_ms — those still get the pre-fix behavior (the sweeper's own
    writes can move their clock) — but every producer this module currently
    knows about (task_ingest, followup) does set it."""
    ms = (rec.get("extra") or {}).get("producer_ms")
    return int(ms) if ms is not None else int(rec.get("updated") or 0)


def next_state(rec: dict, now_ms: int, alive: bool | None) -> str | None:
    """The state this record should move to, or None to leave it alone."""
    if rec.get("state") not in _LIVE:
        return None
    if alive is False:
        return "interrupted"
    # `stalled` means "observed alive, producer quiet" — it is a statement
    # ABOUT A PRODUCER. An observer-owned row with no producer attached has
    # nobody to be quiet: its liveness is confirmed directly, every poll, by
    # the process tree. Sending it to stalled would print "no update in 4m"
    # about a job nobody ever promised to narrate.
    extra = rec.get("extra") or {}
    if extra.get("observed") and extra.get("producer_ms") is None:
        return "running" if rec["state"] == "stalled" else None
    quiet_s = (now_ms - _quiet_clock_ms(rec)) / 1000.0
    if quiet_s > STALE_S:
        return "stalled" if rec["state"] != "stalled" else None
    if alive is True and rec["state"] == "stalled":
        return "running"
    return None


def _quiet_detail(rec: dict, now_ms: int) -> str:
    mins = max(0, int((now_ms - _quiet_clock_ms(rec)) / 60_000))
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
        if state:
            detail = ("lost track of this process; outcome unknown"
                      if state == "interrupted" else
                      _quiet_detail(rec, now_ms) if state == "stalled" else
                      rec.get("detail") or "")
            task_registry.upsert(rec["id"], kind=rec["kind"], source=rec["source"],
                                 state=state, detail=detail)
            changed += 1
        elif rec.get("state") == "stalled":
            # next_state declined to change the STATE, but a stalled row's
            # "no update in Nm" text is derived from the same quiet clock and
            # must keep growing, or it freezes at whatever it said the
            # instant it first went stale (a 16h-silent row reading "no
            # update in 0m" forever). Safe to re-upsert here now that the
            # clock is producer_ms, not `updated` — this write no longer
            # feeds the very quiet-time computation it's reacting to.
            detail = _quiet_detail(rec, now_ms)
            if detail != (rec.get("detail") or ""):
                task_registry.upsert(rec["id"], kind=rec["kind"], source=rec["source"],
                                     state="stalled", detail=detail)
                changed += 1
    return changed
