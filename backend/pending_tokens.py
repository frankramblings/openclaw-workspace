"""Per-session-per-turn pending-work token store.

A "pending token" represents deferred work spawned during an assistant turn
(image generation, subagent, background shell, …). The turn stays UI-visibly
pending until every token it registered has been resolved.

Storage is JSON on disk (same pattern as sessions_store); this module is the
single writer. Callers must never touch the file directly.

File shape:
  {
    "turns":  { "<session>:<turn_id>": [<token>, ...] },   # unresolved tokens
    "blocks": { "<session>:<turn_id>": [<update_block>, ...] }  # resolved payloads
  }
"""
from __future__ import annotations

import json
import logging
import time
import uuid
from datetime import datetime, timezone
from threading import RLock

from backend import config, fsutil

log = logging.getLogger(__name__)

_LOCK = RLock()


def _path():
    return config.DATA_DIR / "pending_tokens.json"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _now_ms() -> int:
    return int(time.time() * 1000)


def _iso_to_ms(iso: str) -> int:
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return int(dt.timestamp() * 1000)


def _load() -> dict:
    return fsutil.load_json_guarded(_path(), {"turns": {}, "blocks": {}}, logger=log)


def _save(data: dict) -> None:
    p = _path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(p)


def _key(session_key: str, turn_id: int) -> str:
    return f"{session_key}:{turn_id}"


def register(session_key: str, turn_id: int, *,
             kind: str, label: str, source_ref: str,
             deadline: str | None = None) -> dict:
    tok = {
        "id": uuid.uuid4().hex,
        "kind": kind,
        "label": label,
        "spawned_at": _now_iso(),
        "source_ref": source_ref,
        "deadline": deadline,
    }
    with _LOCK:
        data = _load()
        data.setdefault("turns", {}).setdefault(_key(session_key, turn_id), []).append(tok)
        _save(data)
    return tok


def resolve(session_key: str, turn_id: int, token_id: str,
            payload: dict) -> dict | None:
    with _LOCK:
        data = _load()
        turns = data.setdefault("turns", {})
        k = _key(session_key, turn_id)
        bucket = turns.get(k, [])
        for i, tok in enumerate(bucket):
            if tok["id"] == token_id:
                removed = bucket.pop(i)
                removed["elapsed_ms"] = _now_ms() - _iso_to_ms(removed["spawned_at"])
                if not bucket:
                    turns.pop(k, None)
                _save(data)
                return removed
        return None


def for_turn(session_key: str, turn_id: int) -> list[dict]:
    data = _load()
    return list(data.get("turns", {}).get(_key(session_key, turn_id), []))


def update_blocks_for_turn(session_key: str, turn_id: int) -> list[dict]:
    data = _load()
    return list(data.get("blocks", {}).get(_key(session_key, turn_id), []))


from backend import event_store  # noqa: E402


# --- HTTP surface ------------------------------------------------------------
import hmac  # noqa: E402

from fastapi import APIRouter, Body, Form, Request  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402

from backend import followup as _followup  # noqa: E402  - for _authorized

router = APIRouter()


def _resolve_session_key(session: str) -> str | None:
    """Accept session_key (contains ':') or session_id (12-hex); returns session_key or None."""
    if ":" in session:
        return session
    from backend import sessions_store
    rec = sessions_store.get(session)
    if rec:
        return rec["sessionKey"]
    sk = sessions_store.id_for_session_key(session)
    if sk:
        rec2 = sessions_store.get(sk)
        return rec2["sessionKey"] if rec2 else None
    return None


@router.post("/api/pending/register")
async def http_register(request: Request,
                        session: str = Form(...),
                        turn_id: int = Form(...),
                        kind: str = Form(...),
                        label: str = Form(...),
                        source_ref: str = Form(...)):
    if not _followup._authorized(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})
    sk = _resolve_session_key(session.strip())
    if sk is None:
        return JSONResponse(status_code=404, content={"error": "unknown session"})
    tok = register_and_emit(sk, turn_id, kind=kind, label=label, source_ref=source_ref)
    return {"token": tok}


@router.post("/api/pending/resolve")
async def http_resolve(request: Request, body: dict = Body(...)):
    if not _followup._authorized(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})
    session = body.get("session", "")
    sk = _resolve_session_key(session.strip())
    if sk is None:
        return JSONResponse(status_code=404, content={"error": "unknown session"})
    removed = resolve_and_emit(
        sk, int(body["turn_id"]), body["token_id"], body.get("payload") or {})
    if removed is None:
        return JSONResponse(status_code=404, content={"error": "unknown token"})
    return {"resolved": removed}


@router.get("/api/pending/hydrate")
async def http_hydrate(session: str = "", turn_ids: str = ""):
    """Return persisted pending_tokens + update_blocks for a session.

    Accepts either a full session_key or a SPA session_id.
    `turn_ids` is an optional comma-separated list of int turn ids; when
    omitted (or empty), ALL turns with any data for the session are returned.

    Response: {"<turn_id>": {"pending_tokens": [...], "update_blocks": [...]}}
    Unknown session → {} (not 404, so frontend hydration is always safe).
    """
    if not session.strip():
        return {}
    sk = _resolve_session_key(session.strip())
    # Unknown session → empty result (non-fatal for the frontend hydration path)
    if sk is None:
        return {}
    data = _load()
    all_turns = data.get("turns", {})
    all_blocks = data.get("blocks", {})

    prefix = sk + ":"

    if turn_ids.strip():
        requested = set()
        for t in turn_ids.split(","):
            t = t.strip()
            if t:
                try:
                    requested.add(int(t))
                except ValueError:
                    pass
        keys = {_key(sk, tid): tid for tid in requested}
    else:
        # All turn_ids that have any data for this session
        seen: dict[int, str] = {}
        for k in list(all_turns) + list(all_blocks):
            if k.startswith(prefix):
                try:
                    tid = int(k[len(prefix):])
                    seen[tid] = k
                except ValueError:
                    pass
        keys = {k: tid for tid, k in seen.items()}

    result = {}
    for k, tid in keys.items():
        pt = list(all_turns.get(k, []))
        ub = list(all_blocks.get(k, []))
        if pt or ub:
            result[str(tid)] = {"pending_tokens": pt, "update_blocks": ub}
    return result


@router.get("/api/pending/current-turn")
async def http_current_turn(session: str = ""):
    """Return the current turn_id (event_store turn_start_id) for a session.

    Accepts either a full session_key (contains ':') or a SPA session_id.
    Used by producers (e.g. the gateway image_generate hook) that need the
    originating turn_id at spawn time to register a pending token correctly.
    Returns {"turn_id": int|null, "active": bool}.
    """
    sk = _resolve_session_key(session.strip()) if session.strip() else None
    if sk is None:
        return JSONResponse(status_code=404, content={"error": "unknown session"})
    info = event_store.current_turn(sk)
    raw = info.get("turn_start_id")
    try:
        turn_id = int(raw) if raw is not None else None
    except (TypeError, ValueError):
        turn_id = None
    return {"turn_id": turn_id, "active": bool(info.get("active"))}


# --- end HTTP surface --------------------------------------------------------


def _emit(session_key: str, body: dict) -> None:
    frame = f"data: {json.dumps(body, separators=(',', ':'))}\n\n"
    try:
        event_store.append(session_key, frame)
    except Exception:  # noqa: BLE001
        log.warning("event_store.append failed for pending-token frame", exc_info=True)


def register_and_emit(session_key: str, turn_id: int, *,
                      kind: str, label: str, source_ref: str,
                      deadline: str | None = None) -> dict:
    tok = register(session_key, turn_id, kind=kind, label=label,
                   source_ref=source_ref, deadline=deadline)
    _emit(session_key, {"type": "token.added", "turn_id": turn_id, "token": tok})
    return tok


def resolve_and_emit(session_key: str, turn_id: int, token_id: str,
                     payload: dict) -> dict | None:
    removed = resolve(session_key, turn_id, token_id, payload)
    if removed is None:
        return None
    block = {
        "id": token_id,
        "kind": removed.get("kind", ""),
        "label": removed.get("label", ""),
        "spawned_at": removed.get("spawned_at", ""),
        "payload": payload,
        "resolved_at": _now_iso(),
        "elapsed_ms": removed["elapsed_ms"],
    }
    with _LOCK:
        data = _load()
        data.setdefault("blocks", {}).setdefault(_key(session_key, turn_id), []).append(block)
        _save(data)
    _emit(session_key, {
        "type": "token.resolved",
        "turn_id": turn_id,
        "token_id": token_id,
        "payload": payload,
        "elapsed_ms": removed["elapsed_ms"],
    })
    return removed
