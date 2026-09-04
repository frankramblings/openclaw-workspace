"""Agent workspace files (SOUL.md, AGENTS.md, ...) through agents.files.*.

The gateway's set is a full replace with no previous-version copy, so this
backend snapshots the current content into agent_config_store before every
write and offers the backups back (list + restore). sha256 of the content is
the optimistic-concurrency token: a client sends the sha it loaded as
base_sha256 and gets 409 stale if the file moved underneath it (Gary writes
MEMORY.md during turns)."""
from __future__ import annotations

from fastapi import APIRouter, Body, Request
from fastapi.responses import JSONResponse

from . import agent_config_store as store
from . import gateway_admin as gw

router = APIRouter()

ALLOWED_FILES = ("AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md", "USER.md",
                 "HEARTBEAT.md", "BOOTSTRAP.md", "MEMORY.md")
AGENT_FILE_MAX_BYTES = 512 * 1024


def _bad_name(name: str):
    if name not in ALLOWED_FILES:
        return gw.fail(400, "bad_name", f"file must be one of {', '.join(ALLOWED_FILES)}")
    return None


def _guard():
    if not store.writes_enabled():
        return gw.fail(503, "writes_disabled", "WORKSPACE_AGENT_CONFIG_WRITES=0")
    return None


async def _agent(agent: str | None) -> str:
    return agent if agent else await gw.default_agent_id()


def _file_view(f: dict) -> dict:
    content = f.get("content") if isinstance(f.get("content"), str) else ""
    return {"name": f.get("name"), "path": f.get("path"), "missing": bool(f.get("missing")),
            "size": f.get("size"), "updated_at_ms": f.get("updatedAtMs"),
            "content": content, "sha256": store.sha256_text(content)}


@router.get("/api/agent/files")
async def list_files(agent: str | None = None):
    try:
        agent_id = await _agent(agent)
        payload = await gw.agent_files_list(agent_id)
    except Exception as exc:  # noqa: BLE001
        return gw.error_response(exc)
    files = [{"name": f.get("name"), "path": f.get("path"), "missing": bool(f.get("missing")),
              "size": f.get("size"), "updated_at_ms": f.get("updatedAtMs")}
             for f in (payload.get("files") or []) if isinstance(f, dict)]
    return {"ok": True, "agent_id": agent_id, "workspace": payload.get("workspace"), "files": files}


@router.get("/api/agent/files/{name}")
async def get_file(name: str, agent: str | None = None):
    if (bad := _bad_name(name)) is not None:
        return bad
    try:
        agent_id = await _agent(agent)
        payload = await gw.agent_files_get(agent_id, name)
    except Exception as exc:  # noqa: BLE001
        return gw.error_response(exc)
    return {"ok": True, "agent_id": agent_id, "file": _file_view(payload.get("file") or {"name": name, "missing": True})}


def _parse_put(body) -> tuple[str, str | None, bool]:
    if not isinstance(body, dict) or not isinstance(body.get("content"), str):
        raise ValueError("body must be {\"content\": str, \"base_sha256\"?: str, \"force\"?: bool}")
    content = body["content"]
    if "\x00" in content:
        raise ValueError("content must not contain NUL bytes")
    base = body.get("base_sha256")
    if base is not None and not isinstance(base, str):
        raise ValueError("base_sha256 must be a string")
    return content, base, bool(body.get("force"))


async def _write(agent_id: str, name: str, content: str, base_sha: str | None, force: bool, action: str):
    """Shared by PUT and restore. Returns a response dict or a JSONResponse."""
    if len(content.encode("utf-8")) > AGENT_FILE_MAX_BYTES:
        return gw.fail(413, "too_large", f"content exceeds {AGENT_FILE_MAX_BYTES} bytes")
    try:
        current = _file_view((await gw.agent_files_get(agent_id, name)).get("file") or {"name": name, "missing": True})
    except Exception as exc:  # noqa: BLE001
        return gw.error_response(exc)
    if base_sha is not None and base_sha != current["sha256"] and not force:
        return _stale(current["sha256"])
    if not current["missing"] and content == current["content"]:
        return {"ok": True, "agent_id": agent_id, "unchanged": True, "file": current}
    key = f"{agent_id}/{name}"
    backup_id = None
    if not current["missing"]:
        try:
            backup_id = store.backup("agent-file", key, current["content"], {"action": action})["id"]
        except OSError as exc:
            store.audit(f"agent_file.{action}", key, False, detail=f"backup failed: {exc}")
            return gw.fail(500, "backup_failed", f"cannot back up {key}: {exc}")
    try:
        payload = await gw.agent_files_set(agent_id, name, content)
    except Exception as exc:  # noqa: BLE001
        store.audit(f"agent_file.{action}", key, False, detail=str(exc), backup_id=backup_id)
        return gw.error_response(exc)
    view = _file_view(payload.get("file") or {"name": name, "content": content})
    store.audit(f"agent_file.{action}", key, True, bytes=len(content.encode("utf-8")), backup_id=backup_id,
                sha256=view["sha256"])
    return {"ok": True, "agent_id": agent_id, "file": view, "backup_id": backup_id}


def _stale(current_sha: str) -> JSONResponse:
    return JSONResponse(status_code=409, content={"ok": False, "error": "stale",
                                                  "detail": "file changed since it was loaded",
                                                  "current_sha256": current_sha})


@router.put("/api/agent/files/{name}")
async def put_file(name: str, agent: str | None = None, body: dict = Body(default=None)):
    if (denied := _guard()) is not None:
        return denied
    if (bad := _bad_name(name)) is not None:
        return bad
    try:
        content, base_sha, force = _parse_put(body)
    except ValueError as exc:
        return gw.fail(400, "bad_content", str(exc))
    if len(content.encode("utf-8")) > AGENT_FILE_MAX_BYTES:
        return gw.fail(413, "too_large", f"content exceeds {AGENT_FILE_MAX_BYTES} bytes")
    try:
        agent_id = await _agent(agent)
    except Exception as exc:  # noqa: BLE001
        return gw.error_response(exc)
    return await _write(agent_id, name, content, base_sha, force, "set")


@router.get("/api/agent/files/{name}/backups")
async def list_file_backups(name: str, agent: str | None = None):
    if (bad := _bad_name(name)) is not None:
        return bad
    try:
        agent_id = await _agent(agent)
    except Exception as exc:  # noqa: BLE001
        return gw.error_response(exc)
    return {"ok": True, "agent_id": agent_id, "backups": store.list_backups("agent-file", f"{agent_id}/{name}")}


@router.post("/api/agent/files/{name}/restore")
async def restore_file(name: str, agent: str | None = None, body: dict = Body(default=None)):
    if (denied := _guard()) is not None:
        return denied
    if (bad := _bad_name(name)) is not None:
        return bad
    backup_id = (body or {}).get("backup_id") if isinstance(body, dict) else None
    if not isinstance(backup_id, str) or not backup_id:
        return gw.fail(400, "bad_request", "body must be {\"backup_id\": str}")
    try:
        agent_id = await _agent(agent)
    except Exception as exc:  # noqa: BLE001
        return gw.error_response(exc)
    try:
        content = store.read_backup("agent-file", f"{agent_id}/{name}", backup_id)
    except FileNotFoundError:
        return gw.fail(404, "backup_not_found", f"no backup {backup_id!r} for {name}")
    return await _write(agent_id, name, content, None, True, "restore")


@router.api_route("/api/agent/files/{name:path}", methods=["GET", "PUT", "POST", "DELETE"])
async def bad_name_fallback(name: str, request: Request):
    """Catches every name/method combination none of the specific routes
    above handle. Two distinct cases reach here: (1) a name that embeds a "/"
    (e.g. a decoded ../ traversal) or is otherwise outside the allowlist, on
    any method -- the specific routes only match a single path segment (or
    one with a literal /backups or /restore suffix), so such a name never
    matches any of them regardless of method, and without this it would fall
    through to app.py's generic 404 (GET) or Starlette's bare 405
    (PUT/POST/DELETE) instead of the allowlist's 400 bad_name envelope; (2) a
    valid, unslashed, allowlisted name on a method none of the specific
    routes support (e.g. DELETE SOUL.md) -- that is a real 405, not a bad
    name, so it gets the envelope's 405 method_not_allowed instead. Registered
    LAST so every well-formed name on a supported method is routed to its
    specific handler first."""
    if (bad := _bad_name(name)) is not None:
        return bad
    return gw.fail(405, "method_not_allowed", f"{request.method} not supported for {name!r}")
