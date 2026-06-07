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


async def stream_turn(message: str, session_key: str | None = None,
                      model_ref: str | None = None):
    """Async generator yielding SSE strings for one user turn.

    Connects, authenticates (shared-password / allowInsecureAuth — no device
    signature needed), optionally pins this session's model, sends chat.send,
    then translates gateway events to SSE until the turn's lifecycle ends.

    `model_ref` (e.g. "openai/gpt-5.5") sets THIS session's modelOverride via
    sessions.create before the turn — so the web picker actually switches the
    model for this chat only. Agent `main`'s default (shared with Signal) is
    never touched; the runtime reads sessionEntry.modelOverride || configDefault.
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

            # 1b. Pin this session's model (best-effort; never block the turn).
            # sessions.create upserts the entry's modelOverride for this key only.
            if model_ref:
                try:
                    await _request(ws, "sessions.create",
                                   {"key": session_key, "model": model_ref})
                except Exception:  # noqa: BLE001 - fall back to the default model
                    pass

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


async def run_text(prompt: str, session_key: str) -> str:
    """One brain turn → just the assistant text (no SSE plumbing).

    Shared helper for backend features that need a single utility turn
    (memory extraction, titles, email drafting). Runs on whatever session_key
    the caller picks — use a dedicated key for utility work so it doesn't
    pollute a visible chat thread's history."""
    chunks: list[str] = []
    async for sse in stream_turn(prompt, session_key=session_key):
        if not sse.startswith("data:"):
            continue
        body = sse[5:].strip()
        if not body or body == "[DONE]":
            continue
        try:
            obj = json.loads(body)
        except Exception:  # noqa: BLE001
            continue
        if isinstance(obj, dict) and obj.get("delta"):
            chunks.append(obj["delta"])
    return "".join(chunks).strip()


async def fetch_history(session_key: str, limit: int = 200) -> dict:
    """Read a session's transcript from the brain via chat.history and map it to
    the SPA's history shape: {"history": [{role, content}], "model": str|None}.

    The brain stores rich messages — user (content is a plain string), assistant
    (content is a block list: text OR toolCall), and toolResult. The Library's
    history view renders conversation TEXT only, so we keep user strings and
    assistant text blocks and drop toolCall/toolResult messages (live tool cards
    are a streaming concern, not part of the saved transcript view).
    """
    url = config.gateway_ws_url()
    async with websockets.connect(url, max_size=None, open_timeout=30,
                                  ping_interval=None) as ws:
        await _wait_for_challenge(ws)
        connect_id = uuid.uuid4().hex
        await ws.send(json.dumps({"type": "req", "id": connect_id,
                                  "method": "connect", "params": _connect_params()}))
        hello = await _await_response(ws, connect_id)
        if not hello.get("ok"):
            return {"history": [], "model": None}
        hist_id = uuid.uuid4().hex
        await ws.send(json.dumps({"type": "req", "id": hist_id, "method": "chat.history",
                                  "params": {"sessionKey": session_key, "limit": limit}}))
        res = await _await_response(ws, hist_id)
    if not res.get("ok"):
        return {"history": [], "model": None}
    payload = res.get("payload") or {}
    return _map_history(payload.get("messages") or [])


def _map_history(messages: list) -> dict:
    history = []
    model = None
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")
        # The brain stamps every message with an epoch-ms `timestamp`. The SPA
        # renders it via msg.metadata.timestamp and falls back to now() when it's
        # absent — which made every loaded message show the page-reload time.
        meta = {"timestamp": msg.get("timestamp")}
        if role == "user":
            text = _content_text(msg.get("content"))
            if text.strip():
                history.append({"role": "user", "content": text, "metadata": meta})
        elif role == "assistant":
            if msg.get("model"):
                model = msg["model"]  # last assistant model wins → picker label
            text = _content_text(msg.get("content"))  # text blocks only
            if text.strip():
                history.append({"role": "assistant", "content": text, "metadata": meta})
        # toolResult and toolCall-only assistant turns are intentionally skipped.
    return {"history": history, "model": model}


def _content_text(content) -> str:
    """Pull plain text out of a message content field (string or block list).
    Only `text` blocks contribute — toolCall/toolResult blocks are ignored."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [b.get("text", "") for b in content
                 if isinstance(b, dict) and b.get("type") == "text"]
        return "".join(parts)
    return ""


async def _request(ws, method: str, params: dict | None = None) -> dict:
    """Send one req on an already-connected/authed ws and return its response frame."""
    req_id = uuid.uuid4().hex
    await ws.send(json.dumps({"type": "req", "id": req_id,
                              "method": method, "params": params or {}}))
    return await _await_response(ws, req_id)


async def gateway_call(method: str, params: dict | None = None) -> dict:
    """One-shot gateway request on a fresh authed WS: connect, auth, call,
    return the response payload (raises RuntimeError on failure). The shared
    helper for every non-streaming adapter — cron, skills, monitor, session
    hygiene, abort."""
    url = config.gateway_ws_url()
    async with websockets.connect(url, max_size=None, open_timeout=30,
                                  ping_interval=None) as ws:
        await _wait_for_challenge(ws)
        hello = await _request(ws, "connect", _connect_params())
        if not hello.get("ok"):
            raise RuntimeError(f"gateway connect failed: {hello}")
        res = await _request(ws, method, params or {})
    if not res.get("ok"):
        raise RuntimeError(f"{method} failed: {res}")
    return res.get("payload") or {}


# --- Model catalog: real gateway model list, mapped to the SPA's picker shape -

_PROVIDER_META = {
    "openai": {"endpoint_id": "openai", "endpoint_name": "Codex"},
    "anthropic": {"endpoint_id": "anthropic", "endpoint_name": "Claude"},
}
# An auth provider counts as usable in these states (expiring still works).
_OK_AUTH = {"ok", "expiring", "active", "valid"}
# model.provider -> substrings to look for among authStatus provider names.
_AUTH_ROOTS = {"openai": ("openai",), "anthropic": ("claude", "anthropic")}


def _pretty_model(model_id: str) -> str:
    """A human label for a model id (gpt-5.4-mini -> 'GPT-5.4 Mini')."""
    s = model_id
    if s.startswith("gpt-"):
        return "GPT-" + s[4:].replace("-mini", " Mini").replace("-Mini", " Mini")
    if s.startswith("claude-"):
        parts = s.split("-")  # claude-opus-4-7 -> [claude, opus, 4, 7]
        fam = parts[1].capitalize() if len(parts) > 1 else "Claude"
        ver = ".".join(parts[2:]) if len(parts) > 2 else ""
        return f"Claude {fam} {ver}".strip()
    return model_id


def _provider_online(model_provider: str, auth_status: dict[str, str]) -> bool:
    roots = _AUTH_ROOTS.get(model_provider, (model_provider,))
    for name, status in auth_status.items():
        if any(r in name.lower() for r in roots):
            return status in _OK_AUTH
    return True  # no auth info for this provider → don't hide it


def _build_model_items(models_payload: dict, auth_payload: dict) -> dict:
    """Map models.list + models.authStatus onto the SPA's {items:[...]} shape."""
    auth_status = {p.get("provider", ""): p.get("status", "")
                   for p in (auth_payload.get("providers") or [])}

    # Group model ids by provider, preserving gateway order.
    by_provider: dict[str, list[str]] = {}
    for m in models_payload.get("models") or []:
        by_provider.setdefault(m.get("provider", "other"), []).append(m.get("id"))

    # Default provider (the configured primary agent's) sorts first.
    default_provider, _default_model = config.default_model()
    order = sorted(by_provider, key=lambda p: (p != default_provider, p))

    items = []
    for provider in order:
        ids = [i for i in by_provider[provider] if i]
        if not ids:
            continue
        meta = _PROVIDER_META.get(
            provider, {"endpoint_id": provider, "endpoint_name": provider.title()})
        items.append({
            "endpoint_id": meta["endpoint_id"],
            "endpoint_name": meta["endpoint_name"],
            "url": config.gateway_ws_url(),
            "category": "api",
            "model_type": "llm",
            "offline": not _provider_online(provider, auth_status),
            "models": ids,
            "models_display": [_pretty_model(i) for i in ids],
            "models_extra": [],
            "models_extra_display": [],
        })
    return {"items": items}


async def fetch_models() -> dict:
    """Real model catalog from the gateway, in the SPA picker's {items:[...]} shape."""
    url = config.gateway_ws_url()
    async with websockets.connect(url, max_size=None, open_timeout=30,
                                  ping_interval=None) as ws:
        await _wait_for_challenge(ws)
        hello = await _request(ws, "connect", _connect_params())
        if not hello.get("ok"):
            raise RuntimeError(f"gateway connect failed: {hello}")
        models_res = await _request(ws, "models.list")
        try:
            auth_res = await _request(ws, "models.authStatus")
            auth_payload = auth_res.get("payload") or {}
        except Exception:  # noqa: BLE001 - auth status is best-effort
            auth_payload = {}
    if not models_res.get("ok"):
        raise RuntimeError(f"models.list failed: {models_res}")
    return _build_model_items(models_res.get("payload") or {}, auth_payload)


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
