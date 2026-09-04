"""Thin, typed helpers over the gateway's admin surface used by Pillar D
(agent config): config.get / config.patch (MCP servers live under the
`mcp.servers` config path; there is no mcp.* RPC in openclaw 2026.7.x),
skills.proposals.*, agents.files.*, agents.list, logs.tail. One function per
RPC, no business logic. Routes translate GatewayError into the shared HTTP
envelope with error_response()."""
from __future__ import annotations

import json
import time

from fastapi.responses import JSONResponse

from . import bridge

DEFAULT_TIMEOUT_S = 20.0
AGENT_CACHE_TTL_S = 60.0
_AGENT_CACHE: dict = {"id": None, "ts": 0.0}


class GatewayError(Exception):
    """The gateway answered ok:false. `message` is its human text, which the
    HTTP mapping below keys on (the gateway uses INVALID_REQUEST for almost
    everything, so the code alone does not discriminate)."""

    def __init__(self, method: str, code: str, message: str):
        super().__init__(f"{method}: {code}: {message}")
        self.method, self.code, self.message = method, code, message


async def _call(method: str, params: dict | None = None,
                timeout: float = DEFAULT_TIMEOUT_S):
    res = await bridge.gateway_call_result(method, params or {}, timeout=timeout)
    if not res.get("ok"):
        err = res.get("error") or {}
        raise GatewayError(method, str(err.get("code") or "UNKNOWN"),
                           str(err.get("message") or ""))
    payload = res.get("payload")
    return {} if payload is None else payload


def _as_dict(payload) -> dict:
    """A malformed gateway payload (e.g. a stray list instead of an object)
    becomes an empty dict, so a route calling .get() on the result never hits
    an unhandled 500. Only used by helpers whose documented contract is a
    dict; proposals_list's bare-list contract is handled on its own."""
    return payload if isinstance(payload, dict) else {}


# --- config (MCP servers) ----------------------------------------------------

async def config_get() -> dict:
    """Redacted snapshot: keys include path, exists, hash, parsed, config, valid."""
    return _as_dict(await _call("config.get", {}))


async def config_patch(fragment: dict, base_hash: str, note: str = "") -> dict:
    """Merge-patch `fragment` (a JSON object; None deletes a key) onto the
    gateway config. `base_hash` MUST be the hash of the config.get snapshot the
    caller just read: the gateway refuses a patch without it or with a stale
    one ("config changed since last load")."""
    params = {"raw": json.dumps(fragment), "baseHash": base_hash}
    if note:
        params["note"] = note
    return await _call("config.patch", params)


# --- agents ------------------------------------------------------------------

async def agents_list() -> dict:
    return await _call("agents.list", {})


async def default_agent_id() -> str:
    """The gateway's default agent id (agents.list.defaultId), cached 60 s so
    every agent-files / proposals request does not pay a second round trip."""
    now = time.monotonic()
    if _AGENT_CACHE["id"] and now - _AGENT_CACHE["ts"] < AGENT_CACHE_TTL_S:
        return _AGENT_CACHE["id"]
    payload = await agents_list()
    agent_id = payload.get("defaultId") or payload.get("mainKey")
    if not agent_id:
        agents = payload.get("agents") or []
        first = agents[0] if agents and isinstance(agents[0], dict) else {}
        agent_id = first.get("id")
    if not agent_id:
        raise GatewayError("agents.list", "NO_AGENT", "gateway reported no agents")
    _AGENT_CACHE.update(id=str(agent_id), ts=now)
    return str(agent_id)


async def agent_files_list(agent_id: str) -> dict:
    return _as_dict(await _call("agents.files.list", {"agentId": agent_id}))


async def agent_files_get(agent_id: str, name: str) -> dict:
    return await _call("agents.files.get", {"agentId": agent_id, "name": name})


async def agent_files_set(agent_id: str, name: str, content: str) -> dict:
    return await _call("agents.files.set",
                       {"agentId": agent_id, "name": name, "content": content})


# --- skill proposals ---------------------------------------------------------

async def proposals_list(agent_id: str) -> list[dict]:
    payload = await _call("skills.proposals.list", {"agentId": agent_id})
    if isinstance(payload, list):
        return [p for p in payload if isinstance(p, dict)]
    items = payload.get("proposals") or payload.get("items") or []
    return [p for p in items if isinstance(p, dict)]


async def proposals_inspect(agent_id: str, proposal_id: str) -> dict:
    return _as_dict(await _call("skills.proposals.inspect",
                                {"agentId": agent_id, "proposalId": proposal_id}))


def _with_reason(params: dict, reason: str | None) -> dict:
    if reason:
        params["reason"] = reason
    return params


async def proposals_apply(agent_id: str, proposal_id: str, reason: str | None) -> dict:
    return await _call("skills.proposals.apply",
                       _with_reason({"agentId": agent_id, "proposalId": proposal_id}, reason),
                       timeout=60.0)


async def proposals_reject(agent_id: str, proposal_id: str, reason: str | None) -> dict:
    return await _call("skills.proposals.reject",
                       _with_reason({"agentId": agent_id, "proposalId": proposal_id}, reason))


# --- logs --------------------------------------------------------------------

async def logs_tail(cursor: int | None, limit: int, max_bytes: int) -> dict:
    params: dict = {"limit": int(limit), "maxBytes": int(max_bytes)}
    if cursor is not None:
        params = {"cursor": int(cursor), **params}
    return _as_dict(await _call("logs.tail", params, timeout=15.0))


# --- HTTP mapping ------------------------------------------------------------

def http_error(exc: Exception) -> tuple[int, str, str]:
    """(status, error code, detail) for any exception a helper can raise."""
    if isinstance(exc, GatewayError):
        m = exc.message.lower()
        if "unknown method" in m:
            return 501, "gateway_unsupported", exc.message
        if "unknown agent" in m:
            return 404, "not_found", exc.message
        if "not found" in m:
            return 404, "not_found", exc.message
        if "only pending proposals" in m:
            return 409, "not_pending", exc.message
        if "quarantined" in m:
            return 409, "quarantined", exc.message
        if "config changed since last load" in m or "config base hash" in m:
            return 409, "stale_config", exc.message
        if "unsupported file" in m or "unsafe workspace file" in m:
            return 400, "bad_name", exc.message
        return 502, "gateway_error", exc.message
    if isinstance(exc, TimeoutError):
        return 502, "gateway_unreachable", "gateway timed out"
    return 502, "gateway_unreachable", f"{type(exc).__name__}: {exc}"


def fail(status: int, code: str, detail: str) -> JSONResponse:
    return JSONResponse(status_code=status,
                        content={"ok": False, "error": code, "detail": detail})


def error_response(exc: Exception) -> JSONResponse:
    status, code, detail = http_error(exc)
    return fail(status, code, detail)
