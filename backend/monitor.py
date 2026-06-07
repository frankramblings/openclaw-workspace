"""Persistent gateway monitor: one long-lived, read-only WS that hears the
gateway's broadcast events (shutdown, update-available) the moment they fire,
and caches last-known state for the UI's status dot.

Separate from the per-turn bridge on purpose: the bridge opens a fresh WS per
chat turn, so while idle NOTHING is connected to hear a restart — on this host
(gateway cold-boots take 4-5 min) that made restarts indistinguishable from
disk-thrash stalls. This task never blocks or crashes the app: every failure
just degrades the reported state until reconnect.

Health decoration (agents, session count) is fetched lazily on its own
short-lived WS — the listen loop owns this socket's recv, and two concurrent
readers on one websockets connection raise — and cached for 60s.

Unlike the per-turn bridge (which disables pings because codex turns stall
>20 s without frames on purpose), this socket carries no turns — pings here
are pure liveness.  A missed pong correctly degrades state to down.
"""
from __future__ import annotations

import asyncio
import json
import time

import websockets

from . import config
from .bridge import _connect_params, _request, _wait_for_challenge, gateway_call

# state: ok | restarting | down. "restarting" means we saw a shutdown event
# (the gateway is coming back); it converts to ok on reconnect. An unannounced
# drop is "down". Initial state is down until the first successful connect.
_state: dict = {"state": "down", "since": time.time(),
                "updateAvailable": None, "shutdownReason": None}
_health_cache: dict = {"at": 0.0, "agents": None, "sessionCount": None}
_HEALTH_TTL_S = 60.0
_BACKOFF_MAX_S = 30.0


def current_state() -> str:
    return _state["state"]


def _set_state(new: str) -> None:
    if _state["state"] != new:
        _state["state"] = new
        _state["since"] = time.time()


def handle_event(event: str, payload: dict) -> None:
    """Apply one gateway broadcast event to the state machine (no IO)."""
    if event == "shutdown":
        # {reason, restartExpectedMs?} — broadcast just before the gateway
        # closes (src/gateway/server-close.ts:161).
        _state["shutdownReason"] = (payload or {}).get("reason")
        _set_state("restarting")
    elif event == "update-available":
        # {version, ...} when a newer release exists; null/empty when clear.
        _state["updateAvailable"] = payload or None


def handle_disconnect() -> None:
    """The monitor WS dropped. A restart we were told about stays
    'restarting'; anything else is 'down'."""
    if _state["state"] != "restarting":
        _set_state("down")


def handle_connected() -> None:
    _state["shutdownReason"] = None
    _set_state("ok")


async def run() -> None:
    """The monitor task: connect, listen forever, reconnect with capped
    backoff. Started from the app's lifespan; cancelled on shutdown."""
    backoff = 1.0
    while True:
        try:
            async with websockets.connect(config.gateway_ws_url(), max_size=None,
                                          open_timeout=30,
                                          ping_interval=20, ping_timeout=20) as ws:
                await _wait_for_challenge(ws)
                hello = await _request(ws, "connect", _connect_params())
                if not hello.get("ok"):
                    raise RuntimeError(f"monitor connect failed: {hello}")
                handle_connected()
                backoff = 1.0
                while True:
                    frame = json.loads(await ws.recv())
                    if frame.get("type") == "event":
                        handle_event(frame.get("event") or "",
                                     frame.get("payload") or {})
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - any failure → reconnect loop
            pass
        handle_disconnect()
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, _BACKOFF_MAX_S)


async def status() -> dict:
    """The /api/gateway/status payload: cached state + (when up) lazy health."""
    out = {"state": _state["state"], "since": _state["since"],
           "shutdownReason": _state["shutdownReason"],
           "updateAvailable": _state["updateAvailable"],
           "agents": None, "sessionCount": None}
    if _state["state"] == "ok":
        out.update(await _health())
    return out


async def _health() -> dict:
    now = time.monotonic()
    if now - _health_cache["at"] < _HEALTH_TTL_S:
        return {"agents": _health_cache["agents"],
                "sessionCount": _health_cache["sessionCount"]}
    try:
        payload = await gateway_call("health", timeout=5.0)
        agents = [{"agentId": a.get("agentId"), "name": a.get("name")}
                  for a in (payload.get("agents") or [])]
        count = (payload.get("sessions") or {}).get("count")
    except Exception:  # noqa: BLE001 - health is best-effort decoration
        agents, count = None, None
    _health_cache.update(at=now, agents=agents, sessionCount=count)
    return {"agents": agents, "sessionCount": count}
