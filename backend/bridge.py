"""The bridge: drive OpenClaw's gateway over WebSocket and re-emit its events
in the Server-Sent-Events shape the Odysseus frontend already understands.

This replaces Odysseus's old `agent_loop.py` (which called the OpenAI API). The
agent loop now lives server-side in OpenClaw's codex runtime — we just relay it,
which is what keeps us on subscription pricing AND gives us live tool-call panels.

v1 opens a fresh gateway WS per chat turn. Simple and correct for a single user.
"""
from __future__ import annotations

import json
import uuid

import websockets

from . import config


def _sse(payload: dict | str) -> str:
    """Format one SSE message. A bare string is sent as a literal marker (e.g. [DONE])."""
    if isinstance(payload, str):
        return f"data: {payload}\n\n"
    return f"data: {json.dumps(payload, separators=(',', ':'))}\n\n"


def _connect_params() -> dict:
    return {
        "minProtocol": 3,
        "maxProtocol": 3,
        "client": {
            "id": "openclaw-workspace",
            "displayName": "OpenClaw Workspace",
            "version": "0.1.0",
            "platform": "node",
            "mode": "ui",
        },
        "role": "operator",
        "auth": {"token": config.gateway_password()},
    }


async def _recv_json(ws):
    raw = await ws.recv()
    return json.loads(raw)


async def stream_turn(message: str, session_key: str | None = None):
    """Async generator yielding SSE strings for one user turn.

    Connects, authenticates (shared-password / allowInsecureAuth — no device
    signature needed), sends chat.send, then translates gateway events to SSE
    until the turn's lifecycle ends.
    """
    session_key = session_key or config.SESSION_KEY
    url = config.gateway_ws_url()

    try:
        async with websockets.connect(url, max_size=None,
                                       open_timeout=15,
                                       ping_interval=20) as ws:
            # 1. Handshake: wait for the challenge, then send connect.
            await _wait_for_challenge(ws)
            connect_id = uuid.uuid4().hex
            await ws.send(json.dumps({
                "type": "req", "id": connect_id,
                "method": "connect", "params": _connect_params(),
            }))
            hello = await _await_response(ws, connect_id)
            if not hello.get("ok"):
                yield _sse({"type": "tool_output", "tool": "bridge",
                            "output": f"gateway connect failed: {hello}", "exit_code": 1})
                yield _sse("[DONE]")
                return

            # 2. Send the user message.
            send_id = uuid.uuid4().hex
            await ws.send(json.dumps({
                "type": "req", "id": send_id, "method": "chat.send",
                "params": {
                    "sessionKey": session_key,
                    "message": message,
                    "deliver": False,            # don't also push to Signal/etc.
                    "idempotencyKey": uuid.uuid4().hex,
                },
            }))
            ack = await _await_response(ws, send_id)
            if not ack.get("ok"):
                yield _sse({"type": "tool_output", "tool": "bridge",
                            "output": f"chat.send rejected: {ack}", "exit_code": 1})
                yield _sse("[DONE]")
                return
            run_id = (ack.get("payload") or {}).get("runId")

            # 3. Relay events for this run until lifecycle end.
            async for chunk in _relay_events(ws, run_id):
                yield chunk
    except Exception as exc:  # noqa: BLE001 - surface any failure into the UI
        yield _sse({"type": "tool_output", "tool": "bridge",
                    "output": f"bridge error: {exc!r}", "exit_code": 1})
    yield _sse("[DONE]")


async def _wait_for_challenge(ws) -> None:
    while True:
        frame = await _recv_json(ws)
        if frame.get("type") == "event" and frame.get("event") == "connect.challenge":
            return


async def _await_response(ws, req_id: str) -> dict:
    """Read frames until the response matching req_id arrives (events are ignored)."""
    while True:
        frame = await _recv_json(ws)
        if frame.get("type") == "res" and frame.get("id") == req_id:
            return frame


async def _relay_events(ws, run_id):
    """Translate gateway events for `run_id` into Odysseus SSE chunks."""
    emitted_len = 0  # gateway sends cumulative text; we emit only the new suffix
    while True:
        frame = await _recv_json(ws)
        if frame.get("type") != "event":
            continue
        payload = frame.get("payload") or {}
        if run_id and payload.get("runId") not in (run_id, None):
            continue

        event = frame.get("event")

        if event == "chat":
            text = _extract_text(payload)
            if text is not None and len(text) > emitted_len:
                yield _sse({"delta": text[emitted_len:]})
                emitted_len = len(text)
            if payload.get("state") == "final":
                # final reply delivered; lifecycle end still closes the turn
                continue

        elif event == "agent":
            stream = payload.get("stream")
            data = payload.get("data") or {}
            if stream == "tool":
                if data.get("phase") == "start":
                    yield _sse({"type": "tool_start",
                                "tool": data.get("name", "tool"),
                                "command": _as_text(data.get("args")),
                                "round": 1})
                elif data.get("phase") == "end":
                    yield _sse({"type": "tool_output",
                                "tool": data.get("name", "tool"),
                                "output": _as_text(data.get("result")),
                                "exit_code": 0})
            elif stream == "lifecycle" and data.get("phase") == "end":
                return


def _extract_text(payload: dict):
    msg = payload.get("message") or {}
    content = msg.get("content")
    if isinstance(content, list) and content:
        first = content[0]
        if isinstance(first, dict) and "text" in first:
            return first["text"]
    # tolerate a flat text field if the shape ever differs
    if isinstance(payload.get("text"), str):
        return payload["text"]
    return None


def _as_text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value, separators=(",", ":"))
