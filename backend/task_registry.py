"""Canonical background-task registry — one map every progress surface reads.

Phase 2 of the progress-UX design (docs/superpowers/specs/2026-07-09-…).
Four producers feed it: followup promises, the bin/job file registry (via
task_ingest), research jobs, and pending tokens. Consumers: /api/tasks[,
/stream] plus the legacy compat routes (/api/jobs*, /api/tasks/active).

The registry itself is IN-MEMORY (rebuilt from each source's own durable
store on boot; job/task files are re-ingested, followup/pending producers
re-upsert on their next state change). Persisting every record would rewrite
a JSON file on every sub-second progress tick and duplicate four stores that
are already durable — see the plan's "design refinement" note.

The exception is VOLATILE sources (research; Phase 3's auto tasks): their
engine state dies with the process, so `upsert(..., volatile=True)` also
records {id, kind, label, session_key, created} in .data/tasks_volatile.json.
On boot, sweep_boot() turns leftovers into honest `interrupted` records —
same pattern as turn_state.sweep_boot for turns.

Threading: producers call upsert from the event loop and (rarely) worker
threads; a threading.Lock guards the maps and subscriber wakes never raise
into the caller (same defensive contract as event_store.append).
"""
from __future__ import annotations

import asyncio
import logging
import threading
import time

from . import config, fsutil

log = logging.getLogger(__name__)

SCHEMA_VERSION = 1
RETAIN_TERMINAL_S = 300           # terminal tasks age out of list_tasks()
_TERMINAL = ("done", "failed", "interrupted")

_LOCK = threading.Lock()
_TASKS: dict[str, dict] = {}
_SUBSCRIBERS: set = set()

# Guards the ledger's read-modify-write cycle (load → decide → save) so
# concurrent upserts can't interleave and resurrect a cleared terminal entry.
# Lock ordering is deadlock-free by construction: _LOCK and _LEDGER_LOCK are
# NEVER held at the same time — upsert releases _LOCK before the volatile
# block, and sweep_boot releases _LEDGER_LOCK before its upsert loop.
_LEDGER_LOCK = threading.Lock()


def _copy(rec: dict) -> dict:
    """Outbound copy of a record. `dict(rec)` alone would share the nested
    `extra` dict — a caller mutating it would corrupt registry internals
    bypassing the lock."""
    out = dict(rec)
    out["extra"] = dict(rec.get("extra") or {})
    return out


def _ledger_file():
    return config.DATA_DIR / "tasks_volatile.json"


def _now_ms() -> int:
    return int(time.time() * 1000)


def _ledger_load() -> dict:
    data = fsutil.load_json_guarded(_ledger_file(), {}, logger=log)
    if not isinstance(data, dict):
        data = {}
    return {"entries": dict(data.get("entries") or {})}


def _ledger_save(data: dict) -> None:
    data["schema_version"] = SCHEMA_VERSION
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    fsutil.atomic_write_json(_ledger_file(), data)


def _fanout(rec: dict) -> None:
    for q in list(_SUBSCRIBERS):
        try:
            q.put_nowait(_copy(rec))
        except Exception:  # noqa: BLE001 - a dead subscriber can't break producers
            log.warning("task_registry: failed to wake a subscriber", exc_info=True)


def upsert(task_id: str, *, kind: str, source: str, label: str = "",
           session_key: str | None = None, turn_id: int | None = None,
           state: str = "running", pct: float | None = None,
           eta: float | None = None, detail: str = "", error: str = "",
           tail: str = "", extra: dict | None = None,
           volatile: bool = False) -> dict:
    """Merge-by-id upsert. Empty/None args never clobber a known value,
    EXCEPT `state` and `detail`, which always apply (they are the two fields
    producers re-send on every tick). Returns the merged record."""
    now = _now_ms()
    with _LOCK:
        rec = _TASKS.get(task_id)
        if rec is None:
            rec = {"id": task_id, "kind": kind, "source": source, "label": label,
                   "session_key": session_key, "turn_id": turn_id, "state": state,
                   "pct": pct, "eta": eta, "detail": detail, "error": error,
                   "tail": tail, "created": now, "updated": now,
                   "extra": dict(extra or {})}
            _TASKS[task_id] = rec
        else:
            if label:
                rec["label"] = label
            if session_key:
                rec["session_key"] = session_key
            if turn_id is not None:
                rec["turn_id"] = turn_id
            rec["state"] = state
            rec["detail"] = detail
            if pct is not None:
                rec["pct"] = pct
            if eta is not None:
                rec["eta"] = eta
            if error:
                rec["error"] = error
            if tail:
                rec["tail"] = tail
            if extra:
                rec["extra"].update(extra)
            rec["updated"] = now
        out = _copy(rec)

    # `volatile` marks the SOURCE as volatile — producers pass it on EVERY
    # upsert for such tasks (running and terminal), and the registry decides
    # write vs clear by state. Compare-before-save keeps the running path to
    # ONE disk write per task, not one per progress tick. The entry is built
    # from the MERGED record, never the raw call parameters: producers pass
    # session_key only on the first upsert, and recomputing from a later
    # tick's None would both rewrite the ledger every tick and strand the
    # task session-less after a crash. _LEDGER_LOCK serializes the whole
    # read-modify-write so a concurrent terminal clear can't be undone by an
    # interleaved running-tick save.
    if volatile:
        with _LEDGER_LOCK:
            data = _ledger_load()
            if state in _TERMINAL:
                if task_id in data["entries"]:
                    data["entries"].pop(task_id)
                    _ledger_save(data)
            else:
                entry = {"kind": out["kind"], "label": out["label"],
                         "session_key": out["session_key"], "created": out["created"]}
                if data["entries"].get(task_id) != entry:
                    data["entries"][task_id] = entry
                    _ledger_save(data)

    _fanout(out)
    return out


def get(task_id: str) -> dict | None:
    with _LOCK:
        rec = _TASKS.get(task_id)
        return _copy(rec) if rec else None


def list_tasks(session_key: str | None = None,
               source: str | None = None) -> list[dict]:
    """Current tasks, running first then newest-updated first. Terminal
    records past RETAIN_TERMINAL_S are pruned from the map as a side effect
    (the registry is in-memory; this is its only garbage collection)."""
    cutoff = _now_ms() - RETAIN_TERMINAL_S * 1000
    out: list[dict] = []
    with _LOCK:
        for tid in list(_TASKS):
            rec = _TASKS[tid]
            if rec["state"] in _TERMINAL and rec["updated"] < cutoff:
                _TASKS.pop(tid)
                continue
            if session_key and rec.get("session_key") != session_key:
                continue
            if source and rec.get("source") != source:
                continue
            out.append(_copy(rec))
    out.sort(key=lambda r: (0 if r["state"] == "running" else 1, -r["updated"]))
    return out


def remove(task_id: str) -> None:
    """Drop a record without an event — ingest reconciliation for a task
    whose backing file vanished after it already went terminal."""
    with _LOCK:
        _TASKS.pop(task_id, None)


def subscribe() -> "asyncio.Queue":
    q: asyncio.Queue = asyncio.Queue()
    with _LOCK:
        _SUBSCRIBERS.add(q)
    return q


def unsubscribe(q: "asyncio.Queue") -> None:
    with _LOCK:
        _SUBSCRIBERS.discard(q)


def sweep_boot() -> list[dict]:
    """Volatile-ledger leftovers = tasks whose engine died with the previous
    process. Surface each as an in-memory `interrupted` record (fanned out so
    an already-connected stream sees it) and clear the ledger.

    Deadlock-freedom: _LEDGER_LOCK is held only around the initial load and
    the final clear, NOT across the upsert loop — and the loop's upserts pass
    volatile=False (state is terminal `interrupted`, and the sweep clears the
    whole ledger itself), so upsert never re-enters _LEDGER_LOCK from here.
    The two locks are therefore never held simultaneously on any path.
    Boot-only caveat: a volatile upsert landing between the load and the
    final clear would be wiped with the rest; sweep_boot runs once at
    startup, before producers start."""
    with _LEDGER_LOCK:
        data = _ledger_load()
    entries = data["entries"]
    if not entries:
        return []
    moved: list[dict] = []
    for tid, meta in entries.items():
        rec = upsert(tid, kind=meta.get("kind", "auto"), source=tid.split(":", 1)[0],
                     label=meta.get("label", ""), session_key=meta.get("session_key"),
                     state="interrupted",
                     detail="interrupted by a backend restart",
                     volatile=False)
        moved.append(rec)
    with _LEDGER_LOCK:
        _ledger_save({"entries": {}})
    return moved


def reset_for_tests() -> None:
    """Clear process-global state. Tests only."""
    with _LOCK:
        _TASKS.clear()
        _SUBSCRIBERS.clear()
