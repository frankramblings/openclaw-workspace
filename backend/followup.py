"""Follow-up promises: background-task completion drives a real agent turn.

Gary starts background work through `bin/followup`, which registers a promise
here and pings completion when the command exits. We then seed a real turn on
the SAME web session through app's detached recorder, so the existing live
tail / active_sessions notifier / history all deliver it — no new transport.

The store is a tiny JSON file (sessions_store pattern: atomic replace under a
process lock). The file path resolves config.DATA_DIR at CALL time so tests'
DATA_DIR monkeypatch isolates it.

Promise states: pending → completed | overdue | failed.
  completed — command pinged back; follow-up turn fired
  overdue   — no ping by the deadline; "went silent" turn fired
  failed    — session gone / gateway never acked / busy too long
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid

from . import config, fsutil, task_registry, turn_state

_log = logging.getLogger(__name__)

_MARKER = "[[followup]]"
_TAIL_CAP = 4096
_LOCK = threading.Lock()

# See sessions_store.SCHEMA_VERSION for the contract: absent = legacy (ok, no
# warning), higher-than-known = a downgrade (an older app version, or a
# rollback), logged so fields silently dropped on the next save don't go
# unnoticed.
SCHEMA_VERSION = 1

# Once-per-process gate for the newer-schema warning below, same idiom as
# inbox.state.SCHEMA_VERSION's contract: _load() reloads from disk on every
# call (unlike inbox.state's permanent _mem cache), so without this flag the
# warning would re-fire on every load instead of once per process.
_warned_schema_version = False


def _store_file():
    return config.DATA_DIR / "followups.json"


def _now_ms() -> int:
    return int(time.time() * 1000)


def _load() -> dict:
    global _warned_schema_version
    data = fsutil.load_json_guarded(_store_file(), {"promises": []}, logger=_log)
    version = data.get("schema_version")
    if isinstance(version, int) and version > SCHEMA_VERSION and not _warned_schema_version:
        _warned_schema_version = True
        _log.warning(
            "followups.json schema_version %s is newer than this app knows "
            "how to read (%s) -- an older app version, or a downgrade; some "
            "fields may be ignored", version, SCHEMA_VERSION)
    return data


def _save(data: dict) -> None:
    data["schema_version"] = SCHEMA_VERSION
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = _store_file().with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2))
    os.replace(tmp, _store_file())  # atomic on POSIX


def create_promise(session_id: str, session_key: str, label: str,
                   deadline_s: int, *, origin: str = "followup",
                   turn_id: int | None = None) -> dict:
    rec = {
        "id": uuid.uuid4().hex[:12],
        "session_id": session_id,
        "session_key": session_key,
        "label": (label or "background task").strip()[:200],
        "state": "pending",
        "created": _now_ms(),
        # 0 disables the deadline backstop (caller opted out).
        "deadline_ms": _now_ms() + deadline_s * 1000 if deadline_s > 0 else 0,
        # Completion payload — set once by record_completion.
        "pinged": 0, "exit_code": None, "duration_s": None, "tail": "",
        "fired": 0, "error": "",
        "origin": origin, "turn_id": turn_id,
    }
    with _LOCK:
        data = _load()
        data.setdefault("promises", []).append(rec)
        _save(data)
        # task_registry uses its own lock and never calls back into followup —
        # no lock-ordering cycle, so mirroring inside _LOCK is safe. Guarded:
        # followup is the flagship producer and a registry hiccup (mirror is
        # in-memory only, but upsert also touches the volatile ledger file
        # for some sources) must never take the promise store down with it.
        try:
            task_registry.upsert(f"followup:{rec['id']}",
                                 kind=("auto" if origin == "auto" else "followup"),
                                 source="followup", label=rec["label"],
                                 session_key=session_key, turn_id=turn_id,
                                 state="running",
                                 detail="waiting for completion ping")
        except Exception:  # noqa: BLE001
            _log.warning("task_registry mirror failed for promise %s", rec["id"],
                        exc_info=True)
    return rec


def get_promise(pid: str) -> dict | None:
    with _LOCK:
        for p in _load().get("promises", []):
            if p.get("id") == pid:
                return p
    return None


def list_promises() -> list[dict]:
    with _LOCK:
        return sorted(_load().get("promises", []),
                      key=lambda p: p.get("created", 0), reverse=True)


def record_completion(pid: str, *, exit_code: int, duration_s: float,
                      tail: str) -> bool:
    """Store the wrapper's completion ping. First ping wins; a duplicate or a
    ping for an already-resolved promise returns False (idempotent no-op)."""
    with _LOCK:
        data = _load()
        for p in data.get("promises", []):
            if p.get("id") == pid:
                if p.get("pinged") or p.get("state") != "pending":
                    return False
                p["pinged"] = _now_ms()
                p["exit_code"] = int(exit_code)
                p["duration_s"] = round(float(duration_s), 1)
                p["tail"] = (tail or "")[-_TAIL_CAP:]
                _save(data)
                try:
                    task_registry.upsert(f"followup:{pid}", kind="followup",
                                         source="followup", state="running",
                                         detail=f"finished (exit {int(exit_code)}) — "
                                                "follow-up turn pending")
                except Exception:  # noqa: BLE001
                    _log.warning("task_registry mirror failed for promise %s", pid,
                                exc_info=True)
                return True
    return False


STALL_SURFACE_S = 24 * 3600


def _busy_cap_reached(pid: str, overdue: bool = False) -> bool:
    """The busy-wait cap was hit while trying to fire `pid`'s turn. If the
    promise still has runway (deadline unset or in the future), leave it
    PENDING — due_promises() re-selects it on the next 30s sweep, so a busy
    session defers the follow-up instead of eating it. Past a real deadline,
    fail honestly. Returns True if the caller should stop trying."""
    p = get_promise(pid)
    if p is None:
        return True
    deadline = int(p.get("deadline_ms") or 0)
    if deadline and _now_ms() >= deadline:
        error = ("task never reported back; session stayed busy past the deadline"
                 if overdue else "session busy past deadline")
        mark(pid, "failed", error=error)
        return True
    _log.info("followup %s deferred: session busy; sweeper will retry", pid)
    return True


def mark(pid: str, state: str, **fields) -> dict | None:
    """Transition a PENDING promise to a terminal state (+ extra fields).
    Returns the updated record, or None if the promise is missing or already
    resolved — terminal states stick, so double-fires are harmless."""
    with _LOCK:
        data = _load()
        for p in data.get("promises", []):
            if p.get("id") == pid:
                if p.get("state") != "pending":
                    return None
                p["state"] = state
                p["fired"] = _now_ms()
                for k, v in fields.items():
                    p[k] = v
                _save(data)
                reg_state = "failed" if state == "failed" else "done"
                detail = ("deadline passed — honest no-report turn fired"
                          if state == "overdue" else "")
                try:
                    task_registry.upsert(f"followup:{pid}", kind="followup",
                                         source="followup", state=reg_state,
                                         detail=detail,
                                         error=str(fields.get("error") or ""))
                except Exception:  # noqa: BLE001
                    _log.warning("task_registry mirror failed for promise %s", pid,
                                exc_info=True)
                return p
    return None


def due_promises(now_ms: int) -> list[tuple[str, bool]]:
    """Pending promises whose follow-up turn should fire NOW:
      (pid, False) — completion ping recorded but turn not fired (endpoint
                     crash / restart recovery),
      (pid, True)  — no ping and the deadline passed → overdue turn.
    Pure function of the store + clock so the sweep interval is testable."""
    out: list[tuple[str, bool]] = []
    with _LOCK:
        for p in _load().get("promises", []):
            if p.get("state") != "pending":
                continue
            if p.get("pinged"):
                out.append((p["id"], False))
            elif p.get("deadline_ms") and now_ms >= p["deadline_ms"]:
                out.append((p["id"], True))
    return out


def reseed_registry() -> int:
    """Re-mirror still-pending promises after a boot (the registry is
    in-memory; promises are the flagship producer and must be visible
    immediately, not on their next state change)."""
    n = 0
    for p in list_promises():
        if p.get("state") != "pending":
            continue
        try:
            task_registry.upsert(f"followup:{p['id']}",
                                 kind=("auto" if p.get("origin") == "auto" else "followup"),
                                 source="followup", label=p.get("label", ""),
                                 session_key=p.get("session_key"),
                                 turn_id=p.get("turn_id"), state="running",
                                 detail="waiting for completion ping")
        except Exception:  # noqa: BLE001
            _log.warning("followup registry reseed failed for %s", p.get("id"),
                        exc_info=True)
        n += 1
    return n


def _fmt_duration(seconds) -> str:
    s = int(seconds or 0)
    if s >= 3600:
        return f"{s // 3600}h{(s % 3600) // 60:02d}m"
    if s >= 60:
        return f"{s // 60}m{s % 60:02d}s"
    return f"{s}s"


def seed_text(label: str, *, exit_code=None, duration_s=None, tail: str = "",
              overdue: bool = False) -> str:
    """The user-role message that seeds the follow-up turn. Line format is a
    CONTRACT with history_card() below — first three lines are marker, Task,
    Result."""
    tail = tail or ""
    if overdue:
        result = "no completion signal by the deadline — the task never reported back"
    else:
        result = f"exit {exit_code} after {_fmt_duration(duration_s)}"
    lines = [
        _MARKER,
        f"Task: {label}",
        f"Result: {result}",
    ]
    if tail.strip():
        lines += ["Output tail:", "```", tail.strip()[-_TAIL_CAP:], "```"]
    lines += [
        "",
        "You promised to follow up on this background task in this chat when "
        "it finished. Inspect the actual result now (files, logs, artifacts — "
        "don't trust the exit code alone), then report back to Frank: lead "
        "with the outcome, include the link and the real numbers if it "
        "succeeded, and be honest about what went wrong if it failed or went "
        "silent.",
    ]
    return "\n".join(lines)


def history_card(content) -> str | None:
    """Rewrite a stored seed message into the compact line the transcript
    shows (`⚙️ Background task · <label> — <result>`). None for anything that
    isn't a followup seed."""
    if not isinstance(content, str) or not content.startswith(_MARKER):
        return None
    label, result = "background task", ""
    for line in content.splitlines()[1:4]:
        if line.startswith("Task: "):
            label = line[6:].strip()
        elif line.startswith("Result: "):
            result = line[8:].strip()
    return f"⚙️ Background task · {label}" + (f" — {result}" if result else "")


# --- internal turn driver ------------------------------------------------------
import asyncio  # noqa: E402 - intentionally scoped to this section (house style)

from . import bridge, sessions_store  # noqa: E402 - intentionally scoped to this section (house style)

# Wait-for-free-session poll interval / cap, and no-ack retry backoff.
_BUSY_POLL_S = 2.0
_BUSY_CAP_S = 1800.0
_RETRY_DELAYS_S = (30.0, 60.0)


async def _turn_source(seed: str, session_key: str, rec: dict, run_info: dict,
                       card_cmd: str, card_out: str):
    """SSE source for ONE follow-up turn, drained by app._record_turn (which
    owns begin/end_turn, event_store writes, and the terminal [DONE]). Mirrors
    the essential parts of chat_stream's _drive_turn: gateway relay + the
    late-reply salvage for message-tool deliveries that land post-lifecycle."""
    from . import app as app_module  # deferred: app imports this module

    yield bridge._sse({"type": "tool_start", "tool": "followup",
                       "tool_id": "followup", "command": card_cmd, "round": 1})
    yield bridge._sse({"type": "tool_output", "tool": "followup",
                       "tool_id": "followup", "exit_code": 0, "output": card_out})
    text_seen = False
    try:
        async for chunk in bridge.stream_turn(seed, session_key=session_key,
                                              model_ref=app_module._model_ref(rec),
                                              run_info=run_info):
            if "[DONE]" in chunk:
                continue  # recorder lands the terminal DONE after late-reply
            frame = app_module._sse_frame(chunk)
            if isinstance(frame, dict) and frame.get("delta") \
                    and not frame.get("thinking"):
                text_seen = True
            yield chunk
        if not text_seen:
            late = await app_module._late_reply(session_key, seed)
            if late:
                yield bridge._sse({"type": "agent_step"})  # fresh bubble
                yield bridge._sse({"delta": late})
    except Exception as exc:  # noqa: BLE001 - never leave the recorder hanging
        yield bridge._sse({"type": "tool_output", "tool": "followup",
                           "tool_id": "followup",
                           "output": f"follow-up turn error: {exc!r}",
                           "exit_code": 1})


async def fire_followup(pid: str, *, overdue: bool = False,
                        _sleep=asyncio.sleep) -> bool:
    """Drive the follow-up turn for promise `pid` through app's detached
    recorder. Waits out a user turn in progress, retries when the gateway
    never acks, and resolves the promise state. Never raises."""
    from . import app as app_module  # deferred: app imports this module

    p = get_promise(pid)
    if not p or p.get("state") != "pending":
        return False
    rec = sessions_store.get(p["session_id"])
    if not rec or rec.get("archived"):
        mark(pid, "failed", error="session missing or archived")
        return False
    session_key = rec["sessionKey"]
    seed = seed_text(p["label"], exit_code=p.get("exit_code"),
                     duration_s=p.get("duration_s"), tail=p.get("tail") or "",
                     overdue=overdue)
    if overdue:
        card_out = "no completion signal by the deadline — asking Gary to investigate"
    else:
        card_out = (f"exit {p.get('exit_code')} after "
                    f"{_fmt_duration(p.get('duration_s'))} — asking Gary to report")
    card_cmd = f"background task finished · {p['label']}"

    for attempt_delay in (0.0,) + _RETRY_DELAYS_S:
        if attempt_delay:
            await _sleep(attempt_delay)
        # Wait for the session to be free. _start_turn_recorder would silently
        # attach us to an in-flight USER turn otherwise (its guard returns the
        # existing task without calling our source factory). The cap is
        # measured on the wall clock (not accumulated per-iteration) so a
        # zero-delay test `_sleep` can't spin through 30 nominal minutes in a
        # handful of real milliseconds.
        wait_start = time.monotonic()
        while True:
            prev = app_module._TURN_TASKS.get(session_key)
            if prev is None or prev.done():
                break
            if time.monotonic() - wait_start >= _BUSY_CAP_S:
                _busy_cap_reached(pid, overdue=overdue)
                return
            await _sleep(_BUSY_POLL_S)
        # A competing fire (endpoint spawn vs. sweeper, or a prior retry loop
        # elsewhere) may have resolved this promise while we waited.
        if (get_promise(pid) or {}).get("state") != "pending":
            return False
        run_info: dict = {}
        task = app_module._start_turn_recorder(
            session_key,
            lambda: _turn_source(seed, session_key, rec, run_info,
                                 card_cmd, card_out))
        try:
            await task
        except Exception:  # noqa: BLE001 - recorder failures land as retries
            pass
        if run_info.get("timing", {}).get("t_ack"):
            mark(pid, "overdue" if overdue else "completed")
            return True
        # No ack: gateway down, or our start raced a user turn and the guard
        # attached us to THEIRS (run_info untouched either way) → retry.
        _log.warning("followup %s: turn not acked (attempt), retrying", pid)
    mark(pid, "failed", error="gateway never acked after retries")
    return False


# --- HTTP surface ------------------------------------------------------------
import hmac  # noqa: E402 - intentionally scoped to this section (house style)

from fastapi import APIRouter, Form, Request  # noqa: E402 - intentionally scoped to this section (house style)
from fastapi.responses import JSONResponse  # noqa: E402 - intentionally scoped to this section (house style)

router = APIRouter()


def _authorized(request: Request) -> bool:
    tok = config.followup_token()
    if not tok:
        return True
    provided = (request.headers.get("x-workspace-token") or "").strip()
    if not provided:
        auth = request.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            provided = auth[7:].strip()
    return bool(provided) and hmac.compare_digest(provided.encode(), tok.encode())


def _resolve_session(session: str) -> dict | None:
    """Accept the SPA 12-hex id OR the gateway sessionKey."""
    rec = sessions_store.get(session)
    if rec:
        return rec
    sid = sessions_store.id_for_session_key(session)
    return sessions_store.get(sid) if sid else None


@router.post("/api/followup/register")
async def register(request: Request, session: str = Form(...),
                   label: str = Form(...),
                   deadline_s: int = Form(default=14400)):
    if not _authorized(request):
        return JSONResponse(status_code=401, content={"error": "bad followup token"})
    rec = _resolve_session(session.strip())
    if not rec:
        return JSONResponse(status_code=404, content={"error": "no such session"})
    turn_id = None
    try:
        info = turn_state.inflight_for(rec["sessionKey"])
        if info:
            turn_id = info.get("turn_id")
    except Exception:  # noqa: BLE001 - enrichment must never break registration
        _log.warning("turn_id enrichment failed for followup register", exc_info=True)
    p = create_promise(rec["id"], rec["sessionKey"], label, deadline_s, turn_id=turn_id)
    return {"id": p["id"]}


@router.post("/api/followup/complete")
async def complete(request: Request, id: str = Form(...),
                   exit_code: int = Form(...),
                   duration_s: float = Form(default=0.0),
                   tail: str = Form(default="")):
    if not _authorized(request):
        return JSONResponse(status_code=401, content={"error": "bad followup token"})
    if get_promise(id) is None:
        return JSONResponse(status_code=404, content={"error": "no such promise"})
    if not record_completion(id, exit_code=exit_code, duration_s=duration_s, tail=tail):
        return {"ok": True, "ignored": True}
    # Fire-and-forget: the sweeper (see sweeper()) is the crash backstop —
    # a recorded-but-unfired completion is re-fired on the next sweep.
    # _spawn_fire is the shared chokepoint with the sweeper, so a sweep that
    # already claimed this pid (or a duplicate complete ping) can't double-fire.
    _spawn_fire(id)
    return {"ok": True}


@router.get("/api/followup/list")
async def list_all():
    return {"promises": list_promises()}


# --- sweeper (deadline + crash backstop) --------------------------------------
_SWEEP_INTERVAL_S = 30.0
# Promise ids with a fire_followup in flight THIS process — stops the sweeper
# double-firing what the complete endpoint already spawned. The promise state
# machine (mark() only transitions from pending) makes a lost race harmless.
_INFLIGHT: set[str] = set()


def _spawn_fire(pid: str, *, overdue: bool = False) -> bool:
    """Single chokepoint for launching fire_followup: skips pids already in
    flight THIS process (endpoint spawn racing an overdue sweep) and holds
    the in-flight marker until the fire resolves. Returns True if spawned."""
    if pid in _INFLIGHT:
        return False
    _INFLIGHT.add(pid)

    async def _run():
        try:
            await fire_followup(pid, overdue=overdue)
        finally:
            _INFLIGHT.discard(pid)

    from . import app as app_module  # deferred: app imports this module
    app_module._spawn(_run())
    return True


def surface_stalled() -> int:
    """Deadline-0 promises that have been pending past STALL_SURFACE_S get
    their registry mirror flipped to `stalled` — visible instead of
    invisible-forever. Store state stays `pending` (the wrapper may still
    ping someday). Idempotent: skips mirrors already stalled."""
    n = 0
    now = _now_ms()
    for p in list_promises():
        if p.get("state") != "pending" or int(p.get("deadline_ms") or 0) != 0:
            continue
        if now - int(p.get("created") or 0) < STALL_SURFACE_S * 1000:
            continue
        try:
            cur = task_registry.get(f"followup:{p['id']}")
            if cur is not None and cur.get("state") == "stalled":
                continue
            task_registry.upsert(
                f"followup:{p['id']}",
                kind=("auto" if p.get("origin") == "auto" else "followup"),
                source="followup", label=p.get("label", ""),
                session_key=p.get("session_key"), state="stalled",
                detail="no deadline and no completion ping for 24h")
            n += 1
        except Exception:  # noqa: BLE001 - mirror never breaks the sweeper
            _log.warning("surface_stalled failed for %s", p.get("id"),
                         exc_info=True)
    return n


def _sweep_once() -> list[str]:
    """Spawn fire_followup for every due promise not already in flight.
    Returns the pids spawned (tests key off this)."""
    spawned: list[str] = []
    for pid, overdue in due_promises(_now_ms()):
        if _spawn_fire(pid, overdue=overdue):
            spawned.append(pid)
    return spawned


async def sweeper(_sleep=asyncio.sleep) -> None:
    """30s loop. First pass runs shortly after boot so promises left pending
    across a restart (recorded-but-unfired, or already past deadline) fire
    without waiting for new traffic."""
    await _sleep(10.0)  # let the gateway monitor/warm socket settle first
    try:
        reseed_registry()  # in-memory registry forgot these across the restart
    except Exception:  # noqa: BLE001 - the backstop must never die
        _log.warning("followup registry reseed failed at boot", exc_info=True)
    while True:
        try:
            _sweep_once()
        except Exception:  # noqa: BLE001 - the backstop must never die
            _log.warning("followup sweep failed", exc_info=True)
        try:
            surface_stalled()
        except Exception:  # noqa: BLE001 - the backstop must never die
            _log.warning("followup stall surfacing failed", exc_info=True)
        await _sleep(_SWEEP_INTERVAL_S)
