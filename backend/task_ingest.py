"""Mirror the two file-based task registries into task_registry.

Sources (both written by out-of-repo producers; we only read):
  * tmp/jobs/<id>.json          — bin/job records      → registry id job:<id>
  * share/tasks/<id>/progress.json — bin/task records  → registry id taskfile:<id>

One asyncio loop (started from app._lifespan) replaces the per-connection
0.4s directory poll that used to live inside /api/jobs/stream — the poll now
happens once per process, and every consumer rides the registry's pub/sub.

Reconciliation contract:
  running file → upsert running (stalled if quiet > STALL_S)
  terminal file → upsert done/failed
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


def _jobs_dir():
    return JOBS_DIR


def _taskfiles_dir():
    return workspace_root() / "share" / "tasks"


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
    task_registry.upsert(
        task_id, kind="job", source=task_id.split(":", 1)[0],
        label=str(native.get("label") or native.get("id") or ""),
        session_key=session_key,
        state=_state_for(native, updated_epoch, now),
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
            tid = f"job:{native['id']}"
            seen.add(tid)
            _upsert_native(tid, native, float(native.get("_updatedEpoch") or 0),
                           now, session_key=None)

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
        else:
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
