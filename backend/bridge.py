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
        # Running gateway negotiates protocol 4 (newer than the v3 source tree).
        "minProtocol": 3,
        "maxProtocol": 4,
        "client": {
            # MUST be gateway-client + backend mode. That pair is the ONLY device-less,
            # password-only identity the gateway lets keep operator scopes: a direct-local
            # backend doing shared-auth control-plane coordination
            # (shouldSkipLocalBackendSelfPairing). Any other id (cli, webchat-ui, …) has
            # its self-declared scopes wiped on connect → "missing scope: operator.write".
            "id": "gateway-client",
            "displayName": "OpenClaw Workspace",
            "version": "0.1.0",
            "platform": "node",
            "mode": "backend",
        },
        # Top-level capability declaration. Without "tool-events" the gateway never
        # registers us as a tool-event recipient, so tool cards would never fire
        # even though chat text streams fine (server-methods/chat.ts onAgentRunStart).
        "caps": ["tool-events"],
        "role": "operator",
        # Operator scopes must be requested explicitly; chat.send needs operator.write.
        # This mirrors CLI_DEFAULT_OPERATOR_SCOPES.
        "scopes": [
            "operator.admin",
            "operator.read",
            "operator.write",
            "operator.approvals",
            "operator.pairing",
            "operator.talk.secrets",
        ],
        # Shared-password auth reads auth.password (auth.token is for device/bearer
        # tokens) — putting it in "token" yields AUTH_PASSWORD_MISSING.
        "auth": {"password": config.gateway_password()},
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
                                       open_timeout=30,
                                       # A slow/cold codex turn can take >20s with no
                                       # frames; default client pings would trip a
                                       # keepalive timeout and kill the WS mid-turn.
                                       ping_interval=None) as ws:
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


# Item `kind`s that represent an agent tool action worth a card. `analysis`
# (reasoning) and `preamble` are skipped — they're not tool calls.
_TOOL_ITEM_KINDS = {"command", "tool"}


async def _relay_events(ws, run_id):
    """Translate gateway events for `run_id` into Odysseus SSE chunks.

    Live v4 mapping (verified 2026-06-03 against gpt-5.5):
      - assistant text   -> event:"chat",  data.deltaText (per-token increment;
                            falls back to diffing cumulative message.content[0].text)
      - chat error        -> event:"chat",  state:"error", errorMessage
      - tool/command card -> event:"agent", stream:"item",
                             data:{itemId, phase:start|end, kind, title, name, status, meta}
      - turn end          -> event:"agent", stream:"lifecycle", data.phase:"end"|"error"

    Two Odysseus-frontend quirks handled here:
      - It only opens a NEW assistant bubble on an `agent_step` event, so text that
        arrives AFTER a tool would render into the hidden/finalized bubble. We emit
        `agent_step` before the first post-tool delta to open a fresh bubble.
      - The `message` tool is the agent's reply-DELIVERY mechanism (its real channel
        is Signal), not a user-facing action — its reply arrives as a chat delta, so
        we skip its (otherwise blank) tool card.

    Streams `codex_app_server.*` are metadata-only and ignored. Concurrent cron /
    heartbeat runs carry a different runId and are filtered out.
    """
    emitted_len = 0        # fallback cumulative-text cursor
    tool_since_text = False  # a tool card emitted since the last text delta?
    while True:
        frame = await _recv_json(ws)
        if frame.get("type") != "event":
            continue
        event = frame.get("event")
        payload = frame.get("payload") or {}
        frame_run = payload.get("runId")
        if run_id and frame_run is not None and frame_run != run_id:
            continue  # scope strictly to this turn

        if event == "chat":
            if payload.get("state") == "error":
                yield _sse({"type": "tool_output", "tool": "agent",
                            "output": _error_text(payload.get("errorMessage")),
                            "exit_code": 1})
                continue
            delta = payload.get("deltaText")
            if not delta:
                text = _extract_text(payload)
                if text is not None and len(text) > emitted_len:
                    delta = text[emitted_len:]
                    emitted_len = len(text)
            if delta:
                if tool_since_text:
                    yield _sse({"type": "agent_step"})  # open a fresh bubble
                    tool_since_text = False
                yield _sse({"delta": delta})
            continue

        if event != "agent":
            continue
        stream = payload.get("stream")
        data = payload.get("data") or {}

        if stream == "item" and data.get("kind") in _TOOL_ITEM_KINDS:
            if data.get("name") == "message":
                continue  # reply-delivery tool, not a user-facing action
            label = data.get("name") or data.get("title") or data.get("kind")
            detail = data.get("meta") or data.get("title") or ""
            # The gateway's stable per-item id. The agent runs commands
            # concurrently (start A, start B, end B, end A), so the frontend
            # MUST pair each end to its own card by this id — without it the
            # single "current tool" slot mis-pairs and the first card spins
            # forever ("never finish").
            tool_id = data.get("itemId")
            if data.get("phase") == "start":
                tool_since_text = True
                yield _sse({"type": "tool_start", "tool": label,
                            "tool_id": tool_id, "command": detail, "round": 1})
            elif data.get("phase") == "end":
                tool_since_text = True
                yield _sse({"type": "tool_output", "tool": label,
                            "tool_id": tool_id, "output": detail,
                            "exit_code": 0 if data.get("status") == "completed" else 1})

        elif stream == "lifecycle":
            phase = data.get("phase")
            if phase == "error":
                yield _sse({"type": "tool_output", "tool": "agent",
                            "output": _error_text(data.get("error")), "exit_code": 1})
                return
            if phase == "end":
                return


def _error_text(raw) -> str:
    """Pull a human message out of the gateway's JSON-encoded error string."""
    if not raw:
        return "agent run failed"
    if isinstance(raw, str):
        try:
            return json.loads(raw).get("error", {}).get("message") or raw
        except Exception:  # noqa: BLE001
            return raw
    return _as_text(raw)


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
