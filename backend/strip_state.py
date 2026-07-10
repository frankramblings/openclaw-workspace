"""Per-session chat-strip task persistence.

Stores the live chat-strip task list server-side so PWA reloads can restore
in-flight TaskCreate items without losing state.

Storage shape:
  {"sessions": {"<session_key>": {"tasks": [...], "updated_at": "<iso>"}}}

API: get(session_key), set(session_key, tasks), clear(session_key).
HTTP: GET /api/strip/state?session=<key>  → {"tasks": [...]}
      POST /api/strip/state  form: session, tasks_json → {"ok": true}
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from threading import RLock

from fastapi import Form, Request
from fastapi.responses import JSONResponse
from fastapi.routing import APIRouter

from backend import config, fsutil

log = logging.getLogger(__name__)

_LOCK = RLock()


def _path():
    return config.DATA_DIR / "strip_state.json"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _load() -> dict:
    return fsutil.load_json_guarded(_path(), {"sessions": {}}, logger=log)


def _save(data: dict) -> None:
    p = _path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(p)


def get(session_key: str) -> list:
    data = _load()
    rec = data.get("sessions", {}).get(session_key)
    if rec is None:
        return []
    return list(rec.get("tasks", []))


def set(session_key: str, tasks: list) -> None:  # noqa: A001
    with _LOCK:
        data = _load()
        data.setdefault("sessions", {})[session_key] = {
            "tasks": tasks,
            "updated_at": _now_iso(),
        }
        _save(data)


def clear(session_key: str) -> None:
    with _LOCK:
        data = _load()
        data.setdefault("sessions", {}).pop(session_key, None)
        _save(data)


# ---------------------------------------------------------------------------
# HTTP surface
# ---------------------------------------------------------------------------

router = APIRouter()


@router.get("/api/strip/state")
async def http_get(session: str = ""):
    sk = session.strip()
    if not sk:
        return JSONResponse(status_code=400, content={"error": "session required"})
    return {"tasks": get(sk)}


@router.post("/api/strip/state")
async def http_set(
    request: Request,
    session: str = Form(...),
    tasks_json: str = Form(...),
):
    sk = session.strip()
    if not sk:
        return JSONResponse(status_code=400, content={"error": "session required"})
    try:
        tasks = json.loads(tasks_json)
        if not isinstance(tasks, list):
            raise ValueError("tasks must be a list")
    except (json.JSONDecodeError, ValueError) as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    set(sk, tasks)
    return {"ok": True}


@router.delete("/api/strip/state")
async def http_clear(session: str = ""):
    sk = session.strip()
    if not sk:
        return JSONResponse(status_code=400, content={"error": "session required"})
    clear(sk)
    return {"ok": True}
