"""MCP servers for the agent, read and written through the gateway's own
config: `mcp.servers` in openclaw.json via config.get / config.patch.

openclaw 2026.7.x has no mcp.* RPC; `mcp.servers` is a config path. The
previous /api/mcp routes shelled out to mcporter against a different registry
(~/.openclaw/workspace/config/mcporter.json) that the gateway never reads;
they were removed with this module (spec 2026-09-03-agent-config-design, 2).

Every write: kill switch -> validate -> config.get (hash + current servers)
-> on-disk backup of openclaw.json -> config.patch scoped to
{"mcp": {"servers": {<name>: ...}}} with baseHash -> audit. A patch under
`mcp.*` is a hot reload on the gateway (cached MCP runtimes are disposed; the
new list applies on the agent's next turn), never a restart."""
from __future__ import annotations

import logging
import re
from pathlib import Path
from urllib.parse import urlparse

from fastapi import APIRouter, Body

from . import agent_config_store as store
from . import gateway_admin as gw

_log = logging.getLogger(__name__)
router = APIRouter()

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
HTTP_TRANSPORTS = ("streamable-http", "sse")
ALLOWED_KEYS = {"name", "url", "transport", "command", "args", "env", "cwd", "enabled", "auth",
                "oauth", "headers", "toolFilter", "connectionTimeoutMs", "requestTimeoutMs"}
OAUTH_KEYS = {"scope", "redirectUrl", "clientMetadataUrl"}


class BadRequest(ValueError):
    """A request body or name the backend rejects before any gateway call."""


class BackupFailed(RuntimeError):
    """The pre-write backup of openclaw.json could not be taken; no write happens."""


# --- pure helpers --------------------------------------------------------------

def _servers_from(snapshot: dict) -> dict:
    parsed = snapshot.get("parsed") or snapshot.get("config") or {}
    mcp = parsed.get("mcp") if isinstance(parsed, dict) else None
    servers = mcp.get("servers") if isinstance(mcp, dict) else None
    return {k: v for k, v in (servers or {}).items() if isinstance(v, dict)}


def map_server(name: str, srv: dict) -> dict:
    """The list entry. Header and env VALUES never leave the backend (the
    gateway redacts them anyway); only their key names do."""
    url = srv.get("url") if isinstance(srv.get("url"), str) else None
    command = srv.get("command") if isinstance(srv.get("command"), str) else None
    transport = srv.get("transport") if isinstance(srv.get("transport"), str) else None
    if not transport:
        transport = "stdio" if command and not url else "streamable-http"
    auth = srv.get("auth") if isinstance(srv.get("auth"), str) else None
    oauth = srv.get("oauth") if isinstance(srv.get("oauth"), dict) else {}
    headers = srv.get("headers") if isinstance(srv.get("headers"), dict) else {}
    env = srv.get("env") if isinstance(srv.get("env"), dict) else {}
    timeouts = {}
    for src, dst in (("connectionTimeoutMs", "connect_ms"), ("requestTimeoutMs", "request_ms")):
        if isinstance(srv.get(src), (int, float)) and not isinstance(srv.get(src), bool):
            timeouts[dst] = srv[src]
    args = srv.get("args") if isinstance(srv.get("args"), list) else []
    return {
        "id": name, "name": name, "transport": transport, "url": url, "command": command,
        "args": [str(a) for a in args],
        "cwd": srv.get("cwd") if isinstance(srv.get("cwd"), str) else None,
        "is_enabled": srv.get("enabled") is not False,
        "auth": auth, "needs_oauth": auth == "oauth",
        "oauth_scope": oauth.get("scope") if isinstance(oauth.get("scope"), str) else None,
        "header_names": sorted(str(k) for k in headers),
        "env_names": sorted(str(k) for k in env),
        "tool_filter": srv.get("toolFilter") if isinstance(srv.get("toolFilter"), dict) else None,
        "timeouts": timeouts or None,
        "status": "configured", "tool_count": None, "enabled_tool_count": None, "error": None,
    }


def _str_map(value, field: str) -> dict:
    if not isinstance(value, dict) or not all(isinstance(k, str) and isinstance(v, str)
                                              for k, v in value.items()):
        raise BadRequest(f"{field} must be an object of string values")
    return dict(value)


def validate_name(name) -> str:
    if not isinstance(name, str) or not NAME_RE.match(name):
        raise BadRequest("name must match ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
    return name


def validate_new_server(body) -> tuple[str, dict]:
    """(name, server object exactly as it will be written). The gateway
    validates the merged config again on patch; this keeps obvious mistakes
    from ever reaching it and refuses unknown keys."""
    if not isinstance(body, dict):
        raise BadRequest("body must be a JSON object")
    unknown = sorted(set(body) - ALLOWED_KEYS)
    if unknown:
        raise BadRequest(f"unknown field(s): {', '.join(unknown)}")
    name = validate_name(body.get("name"))
    url, command = body.get("url"), body.get("command")
    if bool(url) == bool(command):
        raise BadRequest("exactly one of url or command is required")
    server: dict = {}
    if url:
        parts = urlparse(url) if isinstance(url, str) else None
        if parts is None or parts.scheme not in ("http", "https") or not parts.netloc:
            raise BadRequest("url must be an http(s) URL")
        transport = body.get("transport", "streamable-http")
        if transport not in HTTP_TRANSPORTS:
            raise BadRequest("transport must be streamable-http or sse")
        server["url"], server["transport"] = url, transport
        for k in ("args", "env", "cwd"):
            if k in body:
                raise BadRequest(f"{k} only applies to a stdio (command) server")
        if "headers" in body:
            server["headers"] = _str_map(body["headers"], "headers")
        if "auth" in body:
            if body["auth"] != "oauth":
                raise BadRequest('auth must be "oauth"')
            server["auth"] = "oauth"
        if "oauth" in body:
            oauth = body["oauth"]
            if (not isinstance(oauth, dict) or set(oauth) - OAUTH_KEYS
                    or not all(isinstance(v, str) and v for v in oauth.values())):
                raise BadRequest("oauth accepts scope, redirectUrl, clientMetadataUrl as non-empty strings")
            server["oauth"] = dict(oauth)
    else:
        if not isinstance(command, str) or not command.strip():
            raise BadRequest("command must be a non-empty string")
        if "transport" in body:
            raise BadRequest("transport does not apply to a stdio (command) server")
        for k in ("headers", "auth", "oauth"):
            if k in body:
                raise BadRequest(f"{k} only applies to an http server")
        server["command"] = command.strip()
        if "args" in body:
            if not isinstance(body["args"], list) or not all(isinstance(a, str) for a in body["args"]):
                raise BadRequest("args must be a list of strings")
            server["args"] = list(body["args"])
        if "env" in body:
            server["env"] = _str_map(body["env"], "env")
        if "cwd" in body:
            if not isinstance(body["cwd"], str) or not body["cwd"]:
                raise BadRequest("cwd must be a non-empty string")
            server["cwd"] = body["cwd"]
    if "enabled" in body:
        if not isinstance(body["enabled"], bool):
            raise BadRequest("enabled must be a boolean")
        server["enabled"] = body["enabled"]
    if "toolFilter" in body:
        tf = body["toolFilter"]
        ok = (isinstance(tf, dict) and tf and not set(tf) - {"include", "exclude"}
              and all(isinstance(v, list) and v and all(isinstance(s, str) and s.strip() for s in v)
                      for v in tf.values()))
        if not ok:
            raise BadRequest("toolFilter accepts include/exclude as non-empty lists of strings")
        server["toolFilter"] = {k: list(v) for k, v in tf.items()}
    for k in ("connectionTimeoutMs", "requestTimeoutMs"):
        if k in body:
            v = body[k]
            if isinstance(v, bool) or not isinstance(v, int) or v <= 0:
                raise BadRequest(f"{k} must be a positive integer")
            server[k] = v
    return name, server


def mcp_patch_fragment(name: str, server: dict | None) -> dict:
    """The ONLY place a config patch is built: one server under mcp.servers.
    None deletes the entry (merge-patch semantics)."""
    return {"mcp": {"servers": {name: server}}}


def _gateway_info(result: dict) -> dict:
    return {k: result.get(k) for k in ("path", "restart", "restartRequired", "reload") if k in result}


# --- the write primitive ---------------------------------------------------------

async def _write(name: str, server: dict | None, action: str, must_exist: bool):
    """config.get -> existence check -> on-disk backup -> scoped patch, with
    one retry when the gateway reports a stale base hash. Returns
    (patch result, servers before, backup id). Raises LookupError /
    FileExistsError for the existence checks, BackupFailed, gw.GatewayError."""
    last_exc: Exception | None = None
    for attempt in (1, 2):
        snap = await gw.config_get()
        servers = _servers_from(snap)
        if must_exist and name not in servers:
            raise LookupError(name)
        if not must_exist and name in servers:
            raise FileExistsError(name)
        path = snap.get("path")
        try:
            text = Path(path).read_text(encoding="utf-8")
        except (OSError, TypeError) as exc:
            raise BackupFailed(f"cannot read {path!r} for the pre-write backup: {exc}") from exc
        entry = store.backup("openclaw-json", "config", text,
                             {"action": action, "name": name, "hash": snap.get("hash")})
        try:
            result = await gw.config_patch(mcp_patch_fragment(name, server),
                                           str(snap.get("hash") or ""),
                                           note=f"workspace: mcp {action} {name}")
            return result, servers, entry["id"]
        except gw.GatewayError as exc:
            last_exc = exc
            if attempt == 1 and gw.http_error(exc)[1] == "stale_config":
                continue
            raise
    raise last_exc  # pragma: no cover (loop always returns or raises)


def _guard():
    if not store.writes_enabled():
        return gw.fail(503, "writes_disabled", "WORKSPACE_AGENT_CONFIG_WRITES=0")
    return None


# --- routes ------------------------------------------------------------------------

@router.get("/api/mcp/servers")
async def list_servers():
    try:
        snap = await gw.config_get()
    except Exception as exc:  # noqa: BLE001
        return gw.error_response(exc)
    servers = _servers_from(snap)
    return {"ok": True, "source": "gateway", "path": snap.get("path"), "hash": snap.get("hash"),
            "servers": [map_server(n, servers[n]) for n in sorted(servers)]}


@router.post("/api/mcp/servers", status_code=201)
async def add_server(body: dict = Body(default=None)):
    if (denied := _guard()) is not None:
        return denied
    try:
        name, server = validate_new_server(body)
    except BadRequest as exc:
        return gw.fail(400, "bad_request", str(exc))
    try:
        result, _, backup_id = await _write(name, server, "add", must_exist=False)
    except FileExistsError:
        return gw.fail(409, "exists", f"MCP server {name!r} already exists")
    except BackupFailed as exc:
        store.audit("mcp.add", name, False, detail=str(exc))
        return gw.fail(500, "backup_failed", str(exc))
    except Exception as exc:  # noqa: BLE001
        store.audit("mcp.add", name, False, detail=str(exc))
        return gw.error_response(exc)
    store.audit("mcp.add", name, True, backup_id=backup_id,
                transport=server.get("transport") or "stdio")
    return {"ok": True, "server": map_server(name, server), "backup_id": backup_id,
            "gateway": _gateway_info(result)}


@router.delete("/api/mcp/servers/{name}")
async def remove_server(name: str):
    if (denied := _guard()) is not None:
        return denied
    try:
        validate_name(name)
    except BadRequest as exc:
        return gw.fail(400, "bad_name", str(exc))
    try:
        result, _, backup_id = await _write(name, None, "remove", must_exist=True)
    except LookupError:
        return gw.fail(404, "not_found", f"MCP server {name!r} is not configured")
    except BackupFailed as exc:
        store.audit("mcp.remove", name, False, detail=str(exc))
        return gw.fail(500, "backup_failed", str(exc))
    except Exception as exc:  # noqa: BLE001
        store.audit("mcp.remove", name, False, detail=str(exc))
        return gw.error_response(exc)
    store.audit("mcp.remove", name, True, backup_id=backup_id)
    return {"ok": True, "removed": name, "backup_id": backup_id, "gateway": _gateway_info(result)}


@router.post("/api/mcp/servers/{name}/enabled")
async def set_server_enabled(name: str, body: dict = Body(default=None)):
    if (denied := _guard()) is not None:
        return denied
    try:
        validate_name(name)
    except BadRequest as exc:
        return gw.fail(400, "bad_name", str(exc))
    enabled = (body or {}).get("enabled") if isinstance(body, dict) else None
    if not isinstance(enabled, bool):
        return gw.fail(400, "bad_request", "body must be {\"enabled\": true|false}")
    try:
        result, before, backup_id = await _write(name, {"enabled": enabled}, "enabled", must_exist=True)
    except LookupError:
        return gw.fail(404, "not_found", f"MCP server {name!r} is not configured")
    except BackupFailed as exc:
        store.audit("mcp.enabled", name, False, detail=str(exc), enabled=enabled)
        return gw.fail(500, "backup_failed", str(exc))
    except Exception as exc:  # noqa: BLE001
        store.audit("mcp.enabled", name, False, detail=str(exc), enabled=enabled)
        return gw.error_response(exc)
    store.audit("mcp.enabled", name, True, backup_id=backup_id, enabled=enabled)
    after = {**before.get(name, {}), "enabled": enabled}
    return {"ok": True, "server": map_server(name, after), "backup_id": backup_id,
            "gateway": _gateway_info(result)}
