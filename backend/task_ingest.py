"""Mirror the two file-based task registries into task_registry.

Sources (both written by out-of-repo producers; we only read):
  * tmp/jobs/<id>.json          — bin/job records      → registry id job:<id>
  * share/tasks/<id>/progress.json — bin/task records  → registry id taskfile:<id>

One asyncio loop (started from app._lifespan) replaces the per-connection
0.4s directory poll that used to live inside /api/jobs/stream — the poll now
happens once per process, and every consumer rides the registry's pub/sub.

Reconciliation contract:
  running file → upsert running (stalled if quiet > STALL_S)
  terminal file → upsert done/failed; SKIPPED entirely once older than
    task_registry.RETAIN_TERMINAL_S (else a pruned record would resurrect)
  unchanged file (same native payload, same derived state) → no upsert at
    all, so an idle scan emits zero SSE frames and never touches `updated`
  vanished file, record was running → interrupted (honesty rule)
  vanished file, record was terminal → remove() (native sweeps clean up)
Malformed/partial files are skipped, never fatal (bin/job writes are atomic
tmp+rename, but we can race a partial writer on other filesystems).
"""
from __future__ import annotations

import asyncio
import json
import logging
import time

from . import task_registry
from .jobs import JOBS_DIR
from .workspace_files import workspace_root

log = logging.getLogger(__name__)

POLL_S = 0.5
STALL_S = 30
# Ignore taskfiles still "running" past this age — stale writers. Same
# contract the old workspace_files._TASK_MAX_AGE_SEC guard enforced (24h):
# a writer that crashed mid-run leaves its progress.json forever "running",
# and without this guard task_ingest would mirror it as a permanent,
# restart-surviving stalled/running row. Not applied to tmp/jobs — the old
# jobs.py read path never dropped stale running jobs, so that stays as-is.
RUNNING_MAX_AGE_S = 24 * 3600


def _jobs_dir():
    return JOBS_DIR


def _taskfiles_dir():
    return workspace_root() / "share" / "tasks"


def _stale_terminal(native: dict, updated_epoch: float, now: float) -> bool:
    """True when a done/failed file is older than the registry's terminal
    retention window. Such files are never ingested: without this, a terminal
    record pruned by list_tasks would be re-created as a "new" record by the
    very next scan — a done row resurrecting every RETAIN_TERMINAL_S. Same
    self-heal contract the old jobs.py _read_all had with its RETAIN_SECS
    drop; the producers' own sweeps eventually delete the files."""
    status = str(native.get("status") or "").lower()
    return (status in ("done", "failed")
            and now - updated_epoch > task_registry.RETAIN_TERMINAL_S)


def _state_for(native: dict, updated_epoch: float, now: float) -> str:
    status = str(native.get("status") or "").lower()
    if status == "done":
        return "done"
    if status == "failed":
        return "failed"
    if status == "running" and updated_epoch and now - updated_epoch > STALL_S:
        return "stalled"
    return "running"


def _upsert_native(task_id: str, native: dict, updated_epoch: float,
                   now: float, session_key: str | None) -> None:
    state = _state_for(native, updated_epoch, now)
    # Compare-before-upsert: a file that hasn't changed since the last scan
    # must NOT fire an upsert — every upsert fans out an SSE frame to every
    # subscriber and refreshes `updated` (which would keep terminal records
    # with a lingering file alive in list_tasks forever). The state check is
    # separate from the content check because running→stalled flips with
    # UNCHANGED file content as quiet time crosses STALL_S.
    cur = task_registry.get(task_id)
    if (cur is not None
            and (cur.get("extra") or {}).get("native") == native
            and cur["state"] == state):
        return
    task_registry.upsert(
        task_id, kind="job", source=task_id.split(":", 1)[0],
        label=str(native.get("label") or native.get("id") or ""),
        session_key=session_key,
        state=state,
        pct=native.get("pct"), eta=native.get("eta"),
        detail=str(native.get("detail") or ""),
        error=str(native.get("error") or ""),
        extra={"native": native, "updated_epoch": updated_epoch},
    )


def scan_once() -> None:
    now = time.time()
    seen: set[str] = set()

    jobs_dir = _jobs_dir()
    if jobs_dir.is_dir():
        for p in jobs_dir.glob("*.json"):
            try:
                native = json.loads(p.read_text())
            except Exception:  # noqa: BLE001 - partial write / garbage: skip
                continue
            if not isinstance(native, dict) or "id" not in native:
                continue
            updated_epoch = float(native.get("_updatedEpoch") or 0)
            if _stale_terminal(native, updated_epoch, now):
                continue
            tid = f"job:{native['id']}"
            seen.add(tid)
            _upsert_native(tid, native, updated_epoch, now, session_key=None)

    tf_dir = _taskfiles_dir()
    if tf_dir.is_dir():
        for entry in tf_dir.iterdir():
            pj = entry / "progress.json"
            if not entry.is_dir() or not pj.is_file():
                continue
            try:
                native = json.loads(pj.read_bytes())
                mtime = pj.stat().st_mtime
            except Exception:  # noqa: BLE001
                continue
            if not isinstance(native, dict) or "id" not in native:
                continue
            if _stale_terminal(native, mtime, now):
                continue
            status = str(native.get("status") or "").lower()
            if status == "running" and now - mtime > RUNNING_MAX_AGE_S:
                continue
            tid = f"taskfile:{native['id']}"
            seen.add(tid)
            _upsert_native(tid, native, mtime, now,
                           session_key=native.get("sessionKey") or None)

    # Vanished-file reconciliation for the two file-backed sources only.
    for rec in task_registry.list_tasks():
        if rec["source"] not in ("job", "taskfile") or rec["id"] in seen:
            continue
        if rec["state"] in ("running", "stalled"):
            task_registry.upsert(rec["id"], kind=rec["kind"], source=rec["source"],
                                 state="interrupted",
                                 detail="source file vanished")
        elif rec["state"] != "interrupted":
            # done/failed: the producer's own sweep already deleted the file,
            # nothing more to say — remove immediately. An "interrupted"
            # record is skipped here: it was JUST marked honest-terminal on
            # THIS reconciliation path (there's no producer sweep for it,
            # since the file is already gone), so removing it on the very
            # next scan would mean only already-connected clients ever saw
            # the honesty signal. Let RETAIN_TERMINAL_S age it out instead,
            # same as any other terminal record.
            task_registry.remove(rec["id"])


async def ingest_loop() -> None:
    """Run scan_once forever. Scan failures are logged, never fatal — a bad
    pass self-heals on the next one."""
    while True:
        try:
            scan_once()
        except Exception:  # noqa: BLE001
            log.warning("task_ingest: scan failed", exc_info=True)
        await asyncio.sleep(POLL_S)
