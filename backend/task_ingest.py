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
  lingering file, record already interrupted (liveness sweeper confirmed
    death by pid) → SKIPPED as long as the file hasn't been written since
    that verdict, so the next 0.5s scan can't undo it by re-reading the same
    stale "running" content. A file that DOES advance past the verdict's
    timestamp is genuine new evidence and is allowed to resurrect the row —
    sticky, but only against stale evidence (see `_upsert_native`). One
    exemption from that skip: a file reporting a TERMINAL status is never
    suppressed even if it predates the verdict (the producer's final word
    outranks our inference that it vanished before writing one). A file
    with NO timestamp at all (`updated_epoch == 0`) is unknown age, not
    proof of anything new, so it stays subject to the skip like any other
    non-advancing file — "unknown" here must resolve conservatively (stay
    `interrupted`), the same direction it resolves everywhere else in this
    codebase's honesty rules, never toward reasserting a life we already
    disproved.
Malformed/partial files are skipped, never fatal (bin/job writes are atomic
tmp+rename, but we can race a partial writer on other filesystems).

Each upsert into the registry also stamps `extra["producer_ms"]` — this
file's own timestamp (job `_updatedEpoch` / taskfile mtime), converted to
epoch ms — distinct from `extra["updated_epoch"]` (kept in seconds; other
code reads it) and from the registry's own `updated` (which every upsert
touches, including the liveness sweeper's). `producer_ms` is the quiet
clock task_liveness.next_state actually reads; only a real file write moves
it, so the sweeper's own writes can't feed the clock it's deciding against.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time

from . import task_liveness, task_push
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


# Producers are written by different hands and spell success differently.
# The registry only understands done/failed, and an unrecognised word used to
# fall through to "running" FOREVER: _state_for's stall check and scan_once's
# RUNNING_MAX_AGE_S drop were both gated on the literal "running", so a record
# saying "completed" was ingested as a live job with no upper bound. Normalise
# once, here, and let every gate ask this function instead of comparing strings.
_TERMINAL_ALIASES = {
    "done": "done", "complete": "done", "completed": "done",
    "success": "done", "succeeded": "done", "ok": "done", "finished": "done",
    "failed": "failed", "fail": "failed", "error": "failed", "errored": "failed",
}


def normalize_terminal(raw) -> str | None:
    """Map a producer's status word to a registry terminal state, or None if
    it is not terminal. Unknown words are NOT terminal — and, per _state_for,
    also not indefinitely running."""
    return _TERMINAL_ALIASES.get(str(raw or "").strip().lower())


def _stale_terminal(native: dict, updated_epoch: float, now: float) -> bool:
    """True when a terminal file is older than the registry's retention window.
    Such files are never ingested: without this, a terminal record pruned by
    list_tasks would be re-created as "new" by the very next scan."""
    return (normalize_terminal(native.get("status")) is not None
            and now - updated_epoch > task_registry.RETAIN_TERMINAL_S)


def _state_for(native: dict, updated_epoch: float, now: float) -> str:
    terminal = normalize_terminal(native.get("status"))
    if terminal:
        return terminal
    # Anything non-terminal is a live claim, and a live claim goes stale on
    # the same clock regardless of which word the producer used.
    if updated_epoch and now - updated_epoch > STALL_S:
        return "stalled"
    return "running"


def _upsert_native(task_id: str, native: dict, updated_epoch: float,
                   now: float, session_key: str | None) -> None:
    state = _state_for(native, updated_epoch, now)
    cur = task_registry.get(task_id)
    # Sticky-but-reversible death: once the liveness sweeper has confirmed a
    # pid gone and recorded `interrupted`, a lingering file that still says
    # "running" must NOT resurrect it on the very next 0.5s scan just
    # because its content differs from `state` — that's the same stale file
    # the sweeper already contradicted. Only skip while the file predates
    # the verdict; a file written AFTER it is real new evidence and falls
    # through to the normal upsert below, which recomputes `state` fresh and
    # is free to revive the row.
    #
    # One exemption from that skip, required so the guard can never outrank
    # a producer's own final word:
    #   - A file that now reports a TERMINAL status (done/failed) is never
    #     suppressed, even if it predates the verdict. The concrete failure
    #     this closes: a job writes its terminal status and exits: normal
    #     shutdown IS "write terminal file, then exit"; the sweeper's own
    #     death check can land microseconds later, mtime-before-verdict, and
    #     without this exemption the row would report "lost track of this
    #     process; outcome unknown" for RETAIN_TERMINAL_S and then vanish —
    #     a real `done` job never shown to the user, worse than the silence
    #     bug this whole module exists to fix. A terminal file is the
    #     producer's final word; it outranks our inference that the process
    #     vanished before writing one.
    #
    # `updated_epoch` of 0 (no `_updatedEpoch` in the file at all) is
    # deliberately NOT exempted from the skip above, even though it is
    # unknown age rather than confirmed-stale age. Round-2 tried exempting
    # it ("unknown, so let it through") and that was itself a bug: everywhere
    # ELSE in this module and in task_liveness, "unknown" routes to the
    # CONSERVATIVE outcome — it means we do NOT claim death. But bypassing
    # THIS guard means the opposite: `_state_for` also short-circuits on a
    # falsy updated_epoch and returns "running", so letting it through made
    # the row assert the process is ALIVE with zero confirmation, directly
    # contradicting a death we already confirmed by pid — the sweeper would
    # then re-kill it 5s later, the next scan would revive it, forever. An
    # undateable file is not NEW evidence, so it must not overturn the
    # verdict; it stays `interrupted` ("outcome unknown"), same as any other
    # stale file. Only a file we can positively date AFTER the verdict, or
    # one carrying a terminal status regardless of date, may override it.
    if (cur is not None and cur["state"] == "interrupted"
            and normalize_terminal(native.get("status")) is None
            and updated_epoch * 1000 <= cur["updated"]):
        return
    # Compare-before-upsert: a file that hasn't changed since the last scan
    # must NOT fire an upsert — every upsert fans out an SSE frame to every
    # subscriber and refreshes `updated` (which would keep terminal records
    # with a lingering file alive in list_tasks forever). The state check is
    # separate from the content check because running→stalled flips with
    # UNCHANGED file content as quiet time crosses STALL_S.
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
        extra={"native": native, "updated_epoch": updated_epoch,
               "producer_ms": int(updated_epoch * 1000),
               **({"pid": int(native["pid"])} if str(native.get("pid") or "").isdigit() else {})},
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
            if (normalize_terminal(native.get("status")) is None
                    and now - mtime > RUNNING_MAX_AGE_S):
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
    """Run scan_once forever, sweeping liveness every SWEEP_S. Failures are
    logged, never fatal — a bad pass self-heals on the next one. The sweep runs
    AFTER the scan so a file that just went terminal is already reconciled and
    the sweeper sees the same truth the feed does."""
    last_sweep = 0.0
    while True:
        try:
            scan_once()
        except Exception:  # noqa: BLE001
            log.warning("task_ingest: scan failed", exc_info=True)
        now = time.monotonic()
        if now - last_sweep >= task_liveness.SWEEP_S:
            last_sweep = now
            try:
                task_liveness.sweep_once()
            except Exception:  # noqa: BLE001
                log.warning("task_ingest: liveness sweep failed", exc_info=True)
        try:
            await task_push.drain()
        except Exception:  # noqa: BLE001
            log.warning("task_ingest: push drain failed", exc_info=True)
        await asyncio.sleep(POLL_S)
