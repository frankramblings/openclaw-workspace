"""Observer 3: rows for work that runs as a systemd unit.

The two long-running workloads on this box are invisible to observers 1 and 2
by construction. `bin/podmigrate/run-show.sh` documents its durable launch as
`systemd-run --user --unit=podmigrate-<slug>` and a timer fires it at 05:00
with no shell involved at all; `bin/bwg` wraps every render the same way,
which is the fix that closed the pipeline's most expensive recurring failure.
A unit's parent is `systemd --user`, so it is in no shell's process tree, and
the launching command exits in milliseconds, so there is no envelope to read.

The filter is `Transient=yes`. Transient units are exactly what `systemd-run`
creates -- a job somebody launched -- while installed units (the gateway, the
backup timer, the temp reaper) are infrastructure and are never followed. No
allowlist, no configuration, and nothing to keep in sync as units come and go.

The row identity is `InvocationID`, which systemd regenerates on every start.
That matters more than it looks: `bwg` reuses DETERMINISTIC unit names on
purpose (it is how a second render reattaches instead of racing a duplicate),
so keying on the name would make a re-run inherit the previous run's retained
terminal row -- the same defect wave 2a's sticky producer binding had.

What a unit gives us that a bare process cannot is a REAL exit status. So a
unit that exits is `done` or `failed`, never `interrupted`. The single path to
`interrupted` here is a unit that disappears before its status can be read --
reachable, because `systemd-run --collect` garbage-collects a transient unit
on exit -- and that is the honest reading of it: we watched it stop and never
saw an outcome. The same honest reading applies when a unit's properties are
readable but carry no real evidence (`Result` and `ExecMainStatus` both
empty): that is not knowledge either, and must not be dressed up as one.

A unit dropping out of `list-units --state=active` is likewise NOT proof it
has stopped. `deactivating` is excluded from that list for the unit's WHOLE
shutdown window (up to `TimeoutStopSec`), and its still-held properties can
report a stale `Result=success` from before the stop even began. Only a
genuinely-stopped `ActiveState` may produce a terminal outcome; short of
that, the closing loop leaves the entry tracked for a later pass rather than
guess. A "fresh look" fetched for a closing invocation is matched by unit
NAME, not identity -- `bwg`/`podmigrate` reuse deterministic names on
purpose, so that fresh look can legitimately belong to a brand new
invocation that already replaced the one being judged. It is trusted as
evidence that THIS invocation is still alive only when its own
`InvocationID` matches; a mismatch is not evidence about this invocation at
all and falls through to the ordinary close (which reads it the same as a
unit that vanished outright).

The module is split along its one real seam: `collect()` does every
systemctl fork (list-units, the main show, and the closing loop's batched
reshow) and touches nothing else -- no `_SEEN` mutation, no
`task_registry` access. `apply()` does the entire state machine -- every
`_SEEN` mutation and every `task_registry.upsert` -- and no I/O at all.
That split exists for a threading reason, not a style one: `task_registry`'s
producer contract requires `upsert` to be called from the event-loop thread
(see its module docstring), so `collect()` is what runs off it via
`asyncio.to_thread` (see `task_ingest._maybe_follow_units`) while `apply()`
runs back on it. `follow_once()` composes the two on the SAME (calling)
thread, for this module's own test suite and any other synchronous caller.
"""
from __future__ import annotations

import logging
import time

from . import config, proc_tree, systemd_units, task_registry

log = logging.getLogger(__name__)

# InvocationID -> {"first", "row_id", "unit", "pid", "label", "written_subtree"}
_SEEN: dict[str, dict] = {}

_SYSTEMD_RUN_PREFIX = "[systemd-run] "

# ActiveState values under which a unit is CONFIRMED to have genuinely
# stopped. An ALLOWLIST, not a denylist of known-alive states: systemd's
# ActiveState vocabulary is bigger than what this box has been observed
# reporting (systemd 259 here also reports "maintenance"/"refreshing" for
# some unit types), and a value this module doesn't recognize must resolve
# toward "not yet confirmed stopped" -- the same direction "unknown" resolves
# everywhere else in this codebase's honesty rules -- rather than toward
# computing an outcome from properties that might still be mid-transition.
_CONFIRMED_STOPPED_STATES = frozenset({"inactive", "failed"})


def reset_for_tests() -> None:
    _SEEN.clear()


def _list_active() -> list[str] | None:
    return systemd_units.list_active()


def _show(names: list[str]) -> dict[str, dict] | None:
    return systemd_units.show(names)


def _int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _label_for(props: dict) -> str:
    """systemd-run sets Description to the command line and prefixes it. The
    command is what a human recognizes; the unit name is the fallback."""
    desc = (props.get("Description") or "").strip()
    if desc.startswith(_SYSTEMD_RUN_PREFIX):
        desc = desc[len(_SYSTEMD_RUN_PREFIX):].strip()
    return (desc or props.get("Id") or "")[:160]


def _still_alive(props: dict) -> bool:
    """True UNLESS ActiveState confirms a unit has genuinely stopped. The
    closing loop's ONE question before it will compute an outcome -- see the
    module docstring for why "dropped out of the active list" cannot answer
    it on its own, and why this is an allowlist of confirmed-stopped values
    rather than a denylist of known-alive ones."""
    return (props.get("ActiveState") or "").strip() not in _CONFIRMED_STOPPED_STATES


def _outcome_for(props: dict) -> tuple[str, str]:
    """(state, detail) for a unit whose ActiveState confirms it has genuinely
    stopped. A unit reports a real status, so this is knowledge rather than
    inference -- EXCEPT when Result and ExecMainStatus are both empty, which
    is no evidence at all, not evidence of failure; that case reads the same
    as a unit that vanished before we could ask."""
    result = (props.get("Result") or "").strip()
    status_raw = (props.get("ExecMainStatus") or "").strip()
    if not result and not status_raw:
        return "interrupted", "outcome unknown"
    status = _int(status_raw, 0)
    if result == "success" and status == 0:
        return "done", ""
    if result and result != "exit-code":
        # timeout / signal / oom-kill / core-dump: systemd's own word for how
        # it ended is more informative than the numeric status.
        return "failed", f"unit stopped: {result}"
    return "failed", f"exited {status}"


def _live_invocations(props_by_unit: dict[str, dict]) -> set[str]:
    """Invocation IDs this pass's properties confirm are genuinely running
    right now -- the exact filter apply()'s own per-unit loop applies to
    decide `live_ids`, replicated here (read-only) so collect() can decide,
    before doing any more I/O, which tracked invocations need a fresh look."""
    return {
        (p.get("InvocationID") or "").strip() for p in props_by_unit.values()
        if (p.get("Transient") or "").strip() == "yes"
        and (p.get("InvocationID") or "").strip()
        and (p.get("ActiveState") or "").strip() == "active"
    }


def collect() -> dict | None:
    """The blocking half of a pass: every systemctl fork this pass might
    need, and nothing else -- no `_SEEN` mutation, no task_registry access.
    This is what runs off the event-loop thread; see the module docstring
    and `task_ingest._maybe_follow_units`.

    Returns None when systemd could not be asked at all this pass (the
    list-units fork or the main show fork failed outright) -- "no
    information", not "nothing is active"/"nothing changed", the same
    contract `systemd_units.list_active`/`show` each already carry. A
    failure of only the closing loop's batched reshow is NOT collapsed into
    this: the main pass's own findings are still real information, so it is
    carried through in the returned dict's "reshow" key as None instead, for
    apply() to act on unit by unit."""
    names = _list_active()
    if names is None:
        return None
    props_by_unit = _show(names) if names else {}
    if props_by_unit is None:
        return None
    procs = proc_tree.snapshot()

    live_ids = _live_invocations(props_by_unit)
    need_reshow = sorted({
        s["unit"] for inv, s in _SEEN.items()
        if inv not in live_ids and s["row_id"] is not None and s["unit"]
        and (not s.get("last_props") or _still_alive(s["last_props"]))
    })
    reshow = _show(need_reshow) if need_reshow else {}
    return {"props_by_unit": props_by_unit, "procs": procs, "reshow": reshow}


def apply(collected: dict | None, now: float) -> int:
    """The pure half of a pass: the whole state machine, every `_SEEN`
    mutation, and every `task_registry.upsert` -- always on the event-loop
    thread, per task_registry's producer contract (see its module
    docstring: `upsert`'s SSE fan-out wakes the loop's selector in a way
    that is only safe from the thread that owns it). No I/O of any kind:
    over a handful of units this is microseconds of CPU, exactly what
    belongs on the loop rather than off it.

    `collected` is `collect()`'s return value. None means systemd could not
    be asked at all this pass -- apply() makes no writes and returns 0,
    leaving `_SEEN` exactly as it was, the same "no information" contract
    collect() itself follows. Returns the number of registry writes made --
    zero on a quiet pass, because every upsert fans out an SSE frame."""
    if collected is None:
        return 0
    props_by_unit = collected["props_by_unit"]
    procs = collected["procs"]
    fresh = collected["reshow"]
    reshow_failed = fresh is None
    if reshow_failed:
        fresh = {}
    changed = 0
    live_ids: set[str] = set()

    for props in props_by_unit.values():
        if (props.get("Transient") or "").strip() != "yes":
            continue                      # installed infrastructure, not a job
        invocation = (props.get("InvocationID") or "").strip()
        if not invocation:
            continue                      # no identity, no row
        # `list_active` already filters to active units, so in production a
        # stopped unit simply stops appearing. Do NOT rely on that: a unit can
        # be listed and already inactive (it exited between the two systemctl
        # calls), and treating "I have properties for it" as "it is alive"
        # would leave the row running forever. Aliveness is ActiveState and
        # nothing else.
        active = (props.get("ActiveState") or "").strip() == "active"
        state = _SEEN.get(invocation)
        if state is None:
            if not active:
                continue                  # first sighting already dead: not ours
            state = _SEEN[invocation] = {
                "first": now, "row_id": None, "unit": props.get("Id") or "",
                "pid": _int(props.get("ExecMainPID")),
                "label": _label_for(props), "written_subtree": None,
                "last_props": props,
            }
        state["last_props"] = props       # spares the closing loop a fork
        if not active:
            continue                      # the closing loop below owns it
        live_ids.add(invocation)
        pid = _int(props.get("ExecMainPID")) or state["pid"]
        state["pid"] = pid
        subtree = sorted({pid} | proc_tree.descendants(procs, pid)) if pid else []

        if state["row_id"] is None:
            if now - state["first"] < config.OBSERVE_THRESHOLD_S:
                continue
            state["row_id"] = f"observed:unit:{invocation}"
            state["written_subtree"] = subtree
            task_registry.upsert(
                state["row_id"], kind="observed", source="observed",
                label=state["label"], state="running", detail="",
                extra={"pid": pid, "subtree": subtree, "observed": True,
                       "unit": state["unit"]})
            changed += 1
            continue

        # Live row: the only thing worth re-writing is a subtree that actually
        # changed, so a producer spawned after the row appeared can still
        # attach by ancestry. Change-gated, or an idle poll would fan out a
        # frame per second. State and detail are echoed back untouched --
        # they belong to whoever set them.
        if subtree and subtree != state["written_subtree"]:
            existing = task_registry.get(state["row_id"])
            if existing is not None:
                state["written_subtree"] = subtree
                task_registry.upsert(
                    state["row_id"], kind="observed", source="observed",
                    state=existing["state"], detail=existing["detail"],
                    extra={"subtree": subtree})
                changed += 1

    # A unit we were following is no longer active. Prefer the properties we
    # already hold from this pass; only trust collect()'s batched reshow --
    # matched by unit NAME, so it can legitimately belong to a DIFFERENT,
    # newer invocation of the same deterministic name -- when its own
    # InvocationID confirms it is actually about US. "Dropped out of the
    # active list" is not proof of a stop either: `deactivating` is excluded
    # from it for the unit's WHOLE shutdown window, so a unit can vanish from
    # `live_ids` while still actually running. If the fresh look still shows
    # OUR invocation alive, leave the entry tracked and write nothing this
    # pass -- it closes on a later one. If the reshow itself failed, that is
    # no information, not confirmation everyone needing it is gone -- same
    # treatment. If it is gone entirely -- `systemd-run --collect`
    # garbage-collects a transient unit on exit -- or the fresh look belongs
    # to a different invocation, we never saw OUR outcome and say exactly that.
    closing = [i for i in _SEEN if i not in live_ids]
    for invocation in closing:
        state = _SEEN[invocation]
        if state["row_id"] is None:
            _SEEN.pop(invocation)
            continue                      # never surfaced, nothing to close
        props = state.get("last_props")
        needed_reshow = not props or _still_alive(props)
        if needed_reshow:
            if reshow_failed:
                continue                  # no information this pass; stays tracked
            props = fresh.get(state["unit"]) if state["unit"] else None
        if (props and (props.get("InvocationID") or "").strip() == invocation
                and _still_alive(props)):
            state["last_props"] = props   # freshest reading, for next pass
            continue                      # mid-shutdown; still tracked, try again later
        _SEEN.pop(invocation)
        if props and (props.get("InvocationID") or "").strip() == invocation:
            outcome, detail = _outcome_for(props)
        else:
            # Either genuinely gone, or `props` belongs to a DIFFERENT
            # invocation that already replaced this one under the same
            # deterministic name -- either way, not evidence about THIS
            # invocation's fate.
            outcome, detail = "interrupted", "unit is gone; outcome unknown"
        task_registry.upsert(state["row_id"], kind="observed", source="observed",
                             state=outcome, detail=detail)
        changed += 1
    return changed


def follow_once(now: float | None = None) -> int:
    """One poll: collect() then apply(), on the SAME (calling) thread. A
    convenience wrapper for this module's own test suite and any other
    synchronous/direct caller. The real production path
    (`task_ingest._maybe_follow_units`) calls collect() and apply()
    separately so apply()'s upserts land on the event-loop thread while
    collect()'s systemctl forks run off it. Returns the number of registry
    writes made -- zero on a quiet pass, because every upsert fans out an
    SSE frame."""
    if not config.UNIT_FOLLOWER_ENABLED:
        return 0
    now = time.time() if now is None else now
    return apply(collect(), now)
