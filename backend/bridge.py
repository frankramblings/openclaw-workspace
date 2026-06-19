"""The bridge: drive OpenClaw's gateway over WebSocket and re-emit its events
in the Server-Sent-Events shape the Odysseus frontend already understands.

This replaces Odysseus's old `agent_loop.py` (which called the OpenAI API). The
agent loop now lives server-side in OpenClaw's codex runtime — we just relay it,
which is what keeps us on subscription pricing AND gives us live tool-call panels.

v1 opens a fresh gateway WS per chat turn. Simple and correct for a single user.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import time
import urllib.parse
import uuid

import httpx
import websockets

from . import config, session_context, sessions_store


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


# --- Warm gateway connection (Option A) -------------------------------------
# v1 opened a fresh authed WS per chat turn — simple, but every turn paid the
# TCP+WS upgrade, connect.challenge wait, connect/auth round trip, AND a model
# re-pin BEFORE the first token. We now keep ONE long-lived authed socket and
# reuse it across turns. To dodge the hard part (multiplexing many turns over
# one socket) we keep it dead simple: a single warm socket guarded by a lock —
# at most one turn uses it at a time; a turn that finds it busy or dead just
# opens a throwaway fresh socket exactly like before. So the worst case is
# identical to v1, and the common case (one user, one turn at a time) skips the
# whole handshake. See the design discussion in the session notes.
class _Warm:
    ws = None
    lock = asyncio.Lock()


_warm = _Warm()
# session_key -> model_ref we last applied. The gateway stores modelOverride
# server-side (persists across connections), so we only re-pin on change. Cleared
# whenever we (re)establish the warm socket, since a drop may follow a gateway
# restart that reset session state.
_pinned: dict[str, str] = {}


class _ChatSendRejected(Exception):
    """chat.send returned ok:false — a logical rejection, not a transport fault
    (so it must NOT trigger the fresh-socket retry)."""

    def __init__(self, ack):
        super().__init__(str(ack))
        self.ack = ack


# Watchdog tick: how often the relay wakes to check run-silence. Fixed — the
# user-tunable knobs are config.STALL_NOTICE_S / STALL_CAP_S.
_STALL_TICK_S = 20.0


class _RunStalled(Exception):
    """No run-scoped gateway activity for STALL_CAP_S — the caller should
    abort the zombie run and retry once on a fresh connection."""


def _stall_action(silent_s: float) -> str | None:
    """What the watchdog should do after `silent_s` seconds of run-silence."""
    if silent_s >= config.STALL_CAP_S:
        return "cap"
    if silent_s >= config.STALL_NOTICE_S:
        return "notice"
    return None


def _is_run_activity(payload: dict, run_id: str | None) -> bool:
    """Does this gateway event prove OUR run is alive? Own-run frames count;
    so do codex_app_server.* runtime streams (compaction etc. keep emitting
    them mid-turn). Other runs' frames (cron, heartbeat) do NOT."""
    frame_run = payload.get("runId")
    if frame_run is not None and frame_run == run_id:
        return True
    stream = payload.get("stream")
    return isinstance(stream, str) and stream.startswith("codex_app_server")


def _ws_alive(ws) -> bool:
    if ws is None:
        return False
    try:
        return ws.state.name == "OPEN"
    except Exception:  # noqa: BLE001 - unknown/legacy state shape → treat as dead
        return False


def _invalidate_warm(ws) -> None:
    """Forget the warm socket if `ws` is it (after an error / detected death), so
    the next turn reconnects and re-pins."""
    if _warm.ws is ws:
        _warm.ws = None
        _pinned.clear()


async def _connect_and_auth():
    """Open a socket and complete the connect/auth handshake; return the live ws.
    Raises on a rejected handshake (caller maps it to an SSE error)."""
    ws = await websockets.connect(config.gateway_ws_url(), max_size=None,
                                  open_timeout=30,
                                  # A slow/cold codex turn can take >20s with no
                                  # frames; default client pings would trip a
                                  # keepalive timeout and kill the WS mid-turn.
                                  ping_interval=None)
    await _wait_for_challenge(ws)
    connect_id = uuid.uuid4().hex
    await ws.send(json.dumps({"type": "req", "id": connect_id,
                              "method": "connect", "params": _connect_params()}))
    hello = await _await_response(ws, connect_id)
    if not hello.get("ok"):
        with contextlib.suppress(Exception):
            await ws.close()
        raise RuntimeError(f"gateway connect failed: {hello}")
    return ws


async def _open_turn(message, session_key, model_ref, attachments, run_info,
                     allow_warm: bool, thinking: str | None = None):
    """Acquire a connection (warm if free+alive, else fresh), pin the model only
    if it changed, send chat.send. Returns (ws, run_id, use_warm) on success — and
    when use_warm is True the CALLER owns _warm.lock and must release it. On ANY
    failure this cleans up after itself (drops a bad warm socket, releases the
    lock, closes the socket) and re-raises, so the caller's retry/handlers start
    from a clean slate."""
    ws = None
    use_warm = False
    holds_lock = False
    try:
        if allow_warm and _ws_alive(_warm.ws) and not _warm.lock.locked():
            await _warm.lock.acquire()          # immediate: lock was free
            holds_lock = True
            if _ws_alive(_warm.ws):
                ws, use_warm = _warm.ws, True
            else:                               # died between check and acquire
                _warm.lock.release()
                holds_lock = False
        if ws is None:
            ws = await _connect_and_auth()
            # Promote this fresh socket to the warm slot if nobody else holds it.
            if not _warm.lock.locked():
                await _warm.lock.acquire()
                holds_lock = use_warm = True
                _warm.ws = ws
                _pinned.clear()                 # new connection → re-pin as needed

        # Pin this session's model, but only when it actually changed (the pin is
        # server-persistent). sessions.patch is the documented mutation; a brand-
        # new chat has no entry yet, so fall back to the sessions.create upsert.
        if model_ref and _pinned.get(session_key) != model_ref:
            try:
                res = await _request(ws, "sessions.patch",
                                     {"key": session_key, "model": model_ref})
                if not res.get("ok"):
                    await _request(ws, "sessions.create",
                                   {"key": session_key, "model": model_ref})
                _pinned[session_key] = model_ref
            except Exception:  # noqa: BLE001 - fall back to the default model
                pass

        send_params = {
            "sessionKey": session_key,
            "message": message,
            "deliver": False,            # don't also push to Signal/etc.
            "idempotencyKey": uuid.uuid4().hex,
        }
        # Image uploads: the gateway accepts {type,mimeType,fileName,content}
        # base64 attachments, sniffs them, and feeds vision-capable models
        # (gpt-5.5) inline image blocks (offloading large ones to media refs).
        if attachments:
            send_params["attachments"] = attachments
        if thinking:
            # Per-turn thinking override (verified: chat.send p.thinking →
            # thinkingLevelOverride). Nothing persists gateway-side.
            send_params["thinking"] = thinking
        send_id = uuid.uuid4().hex
        if run_info is not None:
            run_info.setdefault("timing", {})["t_send"] = time.monotonic()
        await ws.send(json.dumps({"type": "req", "id": send_id,
                                  "method": "chat.send", "params": send_params}))
        ack = await _await_response(ws, send_id)
        if not ack.get("ok"):
            raise _ChatSendRejected(ack)
        if run_info is not None:
            run_info["timing"]["t_ack"] = time.monotonic()
        run_id = (ack.get("payload") or {}).get("runId")
        if run_info is not None:
            run_info["runId"] = run_id
        return ws, run_id, use_warm
    except BaseException:
        # Failed before handing the ws back: drop a bad warm socket, release our
        # lock, and close the socket so nothing leaks.
        if use_warm or _warm.ws is ws:
            _invalidate_warm(ws)
        if holds_lock:
            _warm.lock.release()
        if ws is not None:
            with contextlib.suppress(Exception):
                await ws.close()
        raise


async def stream_turn(message: str, session_key: str | None = None,
                      model_ref: str | None = None,
                      attachments: list | None = None,
                      thinking: str | None = None,
                      run_info: dict | None = None):
    """Async generator yielding SSE strings for one user turn.

    Reuses a warm authed socket when possible (see `_Warm`), otherwise opens a
    fresh one. A warm socket idle since the last turn may be half-open, so if the
    prelude (pin/send/ack) fails on it with a transport error we retry ONCE on a
    fresh connection before giving up.

    `model_ref` (e.g. "openai/gpt-5.5") sets THIS session's modelOverride — so the
    web picker actually switches the model for this chat only. Agent `main`'s
    default (shared with Signal) is never touched.
    """
    session_key = session_key or config.session_key()
    ws = None
    use_warm = False
    try:
        try:
            ws, run_id, use_warm = await _open_turn(
                message, session_key, model_ref, attachments, run_info,
                allow_warm=True, thinking=thinking)
        except (websockets.ConnectionClosed, OSError, asyncio.TimeoutError):
            # Warm socket was stale/dead (or a fresh connect raced a gateway
            # blip): retry once on a guaranteed-fresh connection.
            ws, run_id, use_warm = await _open_turn(
                message, session_key, model_ref, attachments, run_info,
                allow_warm=False, thinking=thinking)

        # Relay events for this run until lifecycle end. On a stall (no
        # run-activity for STALL_CAP_S) abort the zombie run and retry ONCE on
        # a guaranteed-fresh connection — with a fresh idempotencyKey
        # (_open_turn mints one per call; reusing the old key would trip the
        # gateway's transcript dedup and silently no-op the retry).
        stalled_attempts = 0
        while True:
            stalled = False
            try:
                async for chunk in _relay_events(ws, run_id, run_info=run_info,
                                                 session_key=session_key):
                    yield chunk
            except _RunStalled:
                stalled = True
            finally:
                # A mid-stream death (or a stall — that socket's run is now a
                # zombie) makes the warm socket unusable; drop it so the next
                # turn reconnects. Then keep the socket open ONLY if it's still
                # the live warm one; release the lock; close throwaways.
                if stalled or not _ws_alive(ws):
                    _invalidate_warm(ws)
                if use_warm:
                    _warm.lock.release()
                    use_warm = False
                if ws is not None and _warm.ws is not ws:
                    with contextlib.suppress(Exception):
                        await ws.close()
            if not stalled:
                if run_info is not None:
                    run_info.setdefault("timing", {})["t_end"] = time.monotonic()
                break
            if run_info is not None:
                run_info["stalled"] = True
            # Best-effort kill of the zombie run (the gateway itself may be
            # wedged — never let cleanup failure mask the user-facing path).
            # If the abort fails the zombie may still complete later and
            # double-write the session transcript — accepted risk (user chose
            # auto-retry; see the 2026-06-11 spec).
            with contextlib.suppress(Exception):
                await gateway_call("chat.abort",
                                   {"sessionKey": session_key, "runId": run_id},
                                   timeout=10)
            stalled_attempts += 1
            if stalled_attempts > 1:
                yield _sse({"type": "tool_output", "tool": "agent",
                            # tool_id "stall" lets app.py's failed-detection skip
                            # this card so the late-reply poll can still salvage a
                            # transcript-landed reply after an 8-min double stall.
                            "tool_id": "stall",
                            "output": ("🧠 no gateway activity for "
                                       f"{max(1, int(config.STALL_CAP_S) // 60)}m, retried "
                                       "once — codex looks stalled; try again or "
                                       "check the status dot"),
                            "exit_code": 1})
                if run_info is not None:
                    run_info.setdefault("timing", {})["t_end"] = time.monotonic()
                break
            if run_info is not None:
                run_info["retried"] = True
            yield _sse({"type": "stall_retry"})
            if run_info is not None and "t_first_text" in run_info.get("timing", {}):
                # Attempt 1 already streamed text — open a fresh bubble so the
                # retry's full reply doesn't concatenate into the partial one.
                yield _sse({"type": "agent_step"})
            if run_info is not None:
                # Attempt-1 first-frame/first-text stamps would go negative
                # against the retry's fresh t_send — drop them so all deltas
                # describe the attempt that produced the outcome.
                run_info.get("timing", {}).pop("t_first_frame", None)
                run_info.get("timing", {}).pop("t_first_text", None)
            ws, run_id, use_warm = await _open_turn(
                message, session_key, model_ref, attachments, run_info,
                allow_warm=False, thinking=thinking)
    except _ChatSendRejected as rej:
        yield _sse({"type": "tool_output", "tool": "bridge",
                    "output": f"chat.send rejected: {rej.ack}", "exit_code": 1})
    except websockets.ConnectionClosed:
        from . import monitor  # local import: monitor imports bridge helpers
        yield _sse({"type": "tool_output", "tool": "bridge",
                    "output": _disconnect_message(monitor.current_state()),
                    "exit_code": 1})
    except Exception as exc:  # noqa: BLE001 - surface any failure into the UI
        yield _sse({"type": "tool_output", "tool": "bridge",
                    "output": f"bridge error: {exc!r}", "exit_code": 1})
    yield _sse("[DONE]")


async def _warm_request(method: str, params: dict | None = None,
                        timeout: float = 30.0) -> dict:
    """One gateway request/response, preferring the warm socket (skips the
    connect+auth handshake) and falling back to a fresh authed socket when the
    warm one is busy or dead. Returns the response frame.

    This is what makes the post-turn late-reply poll cheap: it fires the same
    chat.history request up to 5× and used to open a brand-new authed socket
    each time — brutal on a swap-bound host. Now those polls ride the socket the
    turn just finished on."""
    if _ws_alive(_warm.ws) and not _warm.lock.locked():
        await _warm.lock.acquire()
        try:
            if _ws_alive(_warm.ws):
                return await asyncio.wait_for(
                    _request(_warm.ws, method, params or {}), timeout)
        except (websockets.ConnectionClosed, OSError, asyncio.TimeoutError):
            _invalidate_warm(_warm.ws)  # bad warm socket → fall through to fresh
        finally:
            _warm.lock.release()
    # Fresh fallback (also the path when the warm socket was busy with a turn).
    async with asyncio.timeout(timeout):
        async with websockets.connect(config.gateway_ws_url(), max_size=None,
                                      open_timeout=30, ping_interval=None) as ws:
            await _wait_for_challenge(ws)
            hello = await _request(ws, "connect", _connect_params())
            if not hello.get("ok"):
                raise RuntimeError(f"gateway connect failed: {hello}")
            return await _request(ws, method, params or {})


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

    Routed through the warm socket when it's free (so the late-reply poll and
    chat-open history loads stop opening a fresh socket each time).
    """
    try:
        res = await _warm_request("chat.history",
                                  {"sessionKey": session_key, "limit": limit})
    except Exception:  # noqa: BLE001 - transient WS trouble → empty history
        return {"history": [], "model": None}
    if not res.get("ok"):
        return {"history": [], "model": None}
    return _map_history((res.get("payload") or {}).get("messages") or [])


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


def _gateway_http_base() -> str:
    """HTTP origin of the gateway, derived from the configured WS url so remote
    installs (gateway_ws override) keep working: ws://→http://, wss://→https://."""
    ws = config.gateway_ws_url()
    if ws.startswith("wss://"):
        return "https://" + ws[len("wss://"):]
    if ws.startswith("ws://"):
        return "http://" + ws[len("ws://"):]
    return ws


async def fetch_history_page(session_key: str, limit: int = 200,
                             cursor: str | None = None) -> dict:
    """One page of a session transcript via the gateway HTTP history endpoint
    (`GET /sessions/:key/history?limit=&cursor=`), which supports older-than-cursor
    pagination — unlike the tail-only WS `chat.history`. `cursor` is a transcript
    seq watermark; the returned page is the window strictly OLDER than it, so
    passing back `nextCursor` walks backwards with no overlap.

    Returns the SPA history shape plus pagination state:
    {"history": [{role, content, metadata}], "model": str|None,
     "hasMore": bool, "nextCursor": str|None}."""
    base = _gateway_http_base()
    enc = urllib.parse.quote(session_key, safe="")
    params = {"limit": str(max(1, min(limit, 1000)))}
    if cursor:
        params["cursor"] = cursor
    pw = config.gateway_password()
    headers = {"Authorization": f"Bearer {pw}"} if pw else {}
    empty = {"history": [], "model": None, "hasMore": False, "nextCursor": None}
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            res = await client.get(f"{base}/sessions/{enc}/history",
                                   params=params, headers=headers)
        if res.status_code != 200:
            return empty
        body = res.json()
    except Exception:  # noqa: BLE001 - transient HTTP trouble → empty page
        return empty
    # The endpoint already display-projects (drops tool messages); _map_history
    # reuses the WS path's role/text mapping so both history loaders agree.
    mapped = _map_history(body.get("messages") or [])
    mapped["hasMore"] = bool(body.get("hasMore"))
    mapped["nextCursor"] = body.get("nextCursor")
    return mapped


async def _request(ws, method: str, params: dict | None = None) -> dict:
    """Send one req on an already-connected/authed ws and return its response frame."""
    req_id = uuid.uuid4().hex
    await ws.send(json.dumps({"type": "req", "id": req_id,
                              "method": method, "params": params or {}}))
    return await _await_response(ws, req_id)


async def gateway_call(method: str, params: dict | None = None,
                       timeout: float = 30.0) -> dict:
    """One-shot gateway request on a fresh authed WS: connect, auth, call,
    return the response payload (raises RuntimeError on failure, TimeoutError
    after `timeout`). The shared helper for every non-streaming adapter —
    cron, skills, monitor, session hygiene, abort. The deadline covers the
    WHOLE dance: a stalled-but-accepting gateway is a known failure mode on
    this host, and without it a hung recv() pins a worker forever."""
    url = config.gateway_ws_url()
    async with asyncio.timeout(timeout):
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


async def gateway_hello(timeout: float = 10.0) -> dict:
    """Connect + auth and return the gateway's connect-response payload (version,
    capabilities, …) without making a further call. Raises RuntimeError on a
    rejected handshake; lets connection errors (OSError/TimeoutError) propagate."""
    url = config.gateway_ws_url()
    async with asyncio.timeout(timeout):
        async with websockets.connect(url, max_size=None, open_timeout=30,
                                      ping_interval=None) as ws:
            await _wait_for_challenge(ws)
            hello = await _request(ws, "connect", _connect_params())
    if not hello.get("ok"):
        raise RuntimeError(f"gateway connect failed: {hello}")
    return hello.get("payload") or {}


# --- Model catalog: real gateway model list, mapped to the SPA's picker shape -

_PROVIDER_META = {
    "openai": {"endpoint_id": "openai", "endpoint_name": "ChatGPT"},
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

    # Group full model objects by provider, preserving gateway order. (Objects,
    # not bare ids — ids collide across providers, e.g. both codex and
    # perplexity-web expose "gpt-5.4", so the display name must be read from the
    # per-provider object, never a global id->name map.)
    by_provider: dict[str, list[dict]] = {}
    for m in models_payload.get("models") or []:
        by_provider.setdefault(m.get("provider", "other"), []).append(m)

    # Default provider (the configured primary agent's) sorts first.
    default_provider, default_model = config.default_model()
    order = sorted(by_provider, key=lambda p: (p != default_provider, p))

    items = []
    for provider in order:
        objs = [m for m in by_provider[provider] if m.get("id")]
        if not objs:
            continue
        # The SPA picker auto-defaults every NEW chat to models[0] (it never
        # consults /api/default-chat) — so that slot must be the configured
        # primary. The gateway catalog is sorted, and gpt-5.4's arrival put
        # it ahead of gpt-5.5: every fresh chat silently landed on 5.4.
        # Stable sort: default first, rest keep gateway order.
        if provider == default_provider:
            objs.sort(key=lambda m: m["id"] != default_model)
        ids = [m["id"] for m in objs]
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
            # Prefer the gateway's configured display name — it carries labels
            # like "(chat only)" for tool-less providers (perplexity-web). Fall
            # back to a prettified id. NOT `alias`: for some providers that's a
            # short routing key (codex → "gpt"), not a human label.
            "models_display": [(m.get("name") or "").strip() or _pretty_model(m["id"])
                               for m in objs],
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


# --- Per-session usage relay -------------------------------------------------
# The gateway's `sessions.usage` RPC already computes per-session token usage +
# (with includeContextWeight) a contextWeight carrying the system-prompt char
# breakdown. There is no token accounting to build here — only a relay + a
# projection down to the small footer contract (tmp/openclaw-usage-contract.md).

# Context-window size by model family. The gateway usage row does NOT carry the
# window, so we map it (contract: context.contextWindowSource = "map"). Matched
# against a lowercased model id; first hit wins; everything else falls back.
_CONTEXT_WINDOWS = (
    ("opus", 200000),
    ("sonnet", 200000),
    ("haiku", 200000),
    ("gpt-5", 400000),
)
_DEFAULT_CONTEXT_WINDOW = 200000


def _context_window_for(model_id: str | None) -> int:
    if not model_id:
        return _DEFAULT_CONTEXT_WINDOW
    mid = model_id.lower()
    for needle, window in _CONTEXT_WINDOWS:
        if needle in mid:
            return window
    return _DEFAULT_CONTEXT_WINDOW


def _infer_provider(model_id: str | None) -> str | None:
    """Best-effort provider from a bare model id when the row didn't carry one."""
    if not model_id:
        return None
    mid = model_id.lower()
    if any(t in mid for t in ("claude", "opus", "sonnet", "haiku")):
        return "anthropic"
    if "gpt" in mid:
        return "openai"
    return None


def _match_usage_row(sessions: list, session_key: str) -> dict | None:
    """Pick the row for our session. We request with key+limit:1, so there's
    normally one row — but prefer an exact key match, then a sessionId that's
    the suffix of the gateway key, then fall back to the only/first row."""
    if not sessions:
        return None
    for row in sessions:
        if isinstance(row, dict) and row.get("key") == session_key:
            return row
    for row in sessions:
        sid = isinstance(row, dict) and row.get("sessionId")
        if sid and isinstance(sid, str) and session_key.endswith(sid):
            return row
    return sessions[0] if isinstance(sessions[0], dict) else None


def _project_session_usage(spa_session_id: str, session_key: str,
                           payload: dict | None, live: dict | None) -> dict:
    """Project a session's usage down to the footer wire contract, preferring
    the LIVE `sessions.changed` snapshot (`live`) for context occupancy + the
    real model window, and using the `sessions.usage` RPC row (`payload`) for
    the message/tool/system-prompt breakdown. Either source alone is enough;
    with neither we report {ok: False}."""
    row = _match_usage_row((payload or {}).get("sessions") or [], session_key)
    if row is None and not live:
        return {"ok": False, "sessionId": spa_session_id,
                "reason": "no usage row for session"}
    row = row or {}
    live = live or {}

    usage = row.get("usage") or {}
    msgs = usage.get("messageCounts") or {}
    cw = row.get("contextWeight") or {}

    # Effective model/provider: live snapshot first, then a per-session override,
    # the base model, the contextWeight report, and our local record.
    rec = sessions_store.get(spa_session_id) or {}
    rec_model = rec.get("model") if rec.get("model") not in (None, "openclaw") else None
    raw_model = (live.get("model") or row.get("modelOverride") or row.get("model")
                 or cw.get("model") or rec_model)
    provider = (row.get("providerOverride") or row.get("modelProvider")
                or cw.get("provider"))
    # Normalize a "provider/model" ref into its parts (the picker stores some
    # session models provider-prefixed, e.g. "openai/gpt-5.5").
    model = raw_model
    if isinstance(raw_model, str) and "/" in raw_model:
        prov, _, name = raw_model.partition("/")
        model, provider = name, (provider or prov)
    provider = provider or _infer_provider(model)

    # Occupancy + window: trust the live gateway row (the true numbers the
    # Control UI shows). Fall back to the usage aggregate + model→window map
    # only when no live snapshot has arrived yet for this session.
    live_total = live.get("totalTokens")
    live_window = live.get("contextTokens")
    if isinstance(live_total, (int, float)):
        total_tokens = int(live_total)
    else:
        total_tokens = int(usage.get("totalTokens") or 0)
    if isinstance(live_window, (int, float)) and live_window > 0:
        window = int(live_window)
        window_source = "gateway"
    else:
        window = _context_window_for(model)
        window_source = "map"
    used_pct = round(total_tokens / window * 100, 1) if window else None

    context = {
        "usedTokens": total_tokens,
        "windowTokens": window,
        "usedPct": used_pct,
        "contextWindowSource": window_source,
        "live": bool(live),
    }
    sys_chars = (cw.get("systemPrompt") or {}).get("chars")
    if isinstance(sys_chars, (int, float)):
        context["systemPromptChars"] = int(sys_chars)
        # Same chars/4 heuristic as OpenClaw's charsToTokens — flag the estimate.
        context["systemPromptTokens"] = round(sys_chars / 4)
        context["tokenEstimate"] = True

    # Cost / input / output: usage RPC is authoritative; the live snapshot is a
    # fallback (it carries estimatedCostUsd + per-turn io on the end event).
    total_cost = usage.get("totalCost")
    if total_cost is None:
        total_cost = live.get("estimatedCostUsd")
    input_tokens = usage.get("input")
    if input_tokens is None:
        input_tokens = live.get("inputTokens")
    output_tokens = usage.get("output")
    if output_tokens is None:
        output_tokens = live.get("outputTokens")

    return {
        "ok": True,
        "sessionId": spa_session_id,
        "model": model,
        "modelProvider": provider,
        "usage": {
            "totalTokens": total_tokens,
            "totalCost": round(float(total_cost or 0), 6),
            "inputTokens": int(input_tokens or 0),
            "outputTokens": int(output_tokens or 0),
            "messages": int(msgs.get("total") or 0),
            # The gateway under-counts tool calls for bridge/web sessions (often
            # 0); prefer our own live tally when it's higher.
            "toolCalls": max(int(msgs.get("toolCalls") or 0),
                             int(live.get("liveToolCalls") or 0)),
            "errors": int(msgs.get("errors") or 0),
        },
        "context": context,
        "updatedAt": (live.get("updatedAt") or (payload or {}).get("updatedAt")
                      or row.get("updatedAt")),
    }


async def fetch_session_usage(spa_session_id: str) -> dict:
    """One chat session's context occupancy + token usage, projected to the
    footer contract. Prefers the LIVE `sessions.changed` snapshot cached by the
    monitor (real occupancy + real model window — the same source the Control UI
    uses); enriches with the `sessions.usage` RPC (messages/tools/system-prompt).
    Either source alone suffices. Never 500s the page — {ok: False} on trouble."""
    session_key = sessions_store.session_key_for(spa_session_id)
    live = session_context.get(session_key)

    payload: dict | None = None
    try:
        payload = await gateway_call("sessions.usage", {
            "key": session_key,
            "includeContextWeight": True,
            "range": "all",
            "limit": 1,
        }, timeout=20)
    except Exception:  # noqa: BLE001 - usage RPC is best-effort enrichment now
        payload = None

    if payload is None and not live:
        return {"ok": False, "sessionId": spa_session_id,
                "reason": "no live snapshot and usage RPC unavailable"}
    return _project_session_usage(spa_session_id, session_key, payload, live)


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
# (reasoning) is mapped separately into thinking deltas; `preamble` is still
# skipped — it's not a tool call.
_TOOL_ITEM_KINDS = {"command", "tool"}


async def _relay_events(ws, run_id, run_info: dict | None = None,
                        session_key: str | None = None):
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

    Streams `codex_app_server.*` are metadata-only and ignored for OUTPUT — but
    they count as run-liveness for the stall watchdog (see _is_run_activity).
    Concurrent cron / heartbeat runs carry a different runId and are filtered out.
    """
    emitted_len = 0        # fallback cumulative-text cursor
    analysis_seen: dict = {}  # itemId -> reasoning chars already emitted
    tool_since_text = False  # a tool card emitted since the last text delta?
    images_seen: set = set()  # image block urls already emitted (dedupe finals)
    timing = run_info.setdefault("timing", {}) if run_info is not None else {}
    last_activity = time.monotonic()
    last_notice = last_activity   # paces "stall" SSE frames to one per tick
    while True:
        # Stall watchdog: the gateway WS has pings disabled (a keepalive
        # timeout would kill it mid-turn), so a codex stall used to hang this
        # read — and the user's spinner — forever. The check runs EVERY
        # iteration (not just on timeout): unrelated runs' frames keep
        # arriving on this shared socket and would otherwise restart the
        # wait window forever, starving detection. websockets' recv() is
        # cancellation-safe: a timed-out read loses no frame.
        now = time.monotonic()
        silent = now - last_activity
        action = _stall_action(silent)
        if action == "cap":
            raise _RunStalled(int(silent))
        if action == "notice" and now - last_notice >= _STALL_TICK_S:
            last_notice = now
            # Doubles as an SSE keepalive for the Tailscale Serve proxy.
            yield _sse({"type": "stall", "silent_for": int(silent)})
        try:
            frame = await asyncio.wait_for(_recv_json(ws), timeout=_STALL_TICK_S)
        except TimeoutError:
            continue
        if frame.get("type") != "event":
            continue
        event = frame.get("event")
        payload = frame.get("payload") or {}
        if _is_run_activity(payload, run_id):
            now = time.monotonic()
            if "t_first_frame" not in timing:
                timing["t_first_frame"] = now
                # First proof of life: tell the SPA the model is actually
                # working so it can stop guessing with canned captions.
                yield _sse({"type": "run_alive"})
            last_activity = now
        frame_run = payload.get("runId")
        if run_id and frame_run is not None and frame_run != run_id:
            continue  # scope strictly to this turn

        if event == "chat":
            state = payload.get("state")
            if state == "aborted":
                # chat.abort landed (the Stop button) — end the turn cleanly,
                # not as an error.
                yield _sse({"type": "tool_output", "tool": "agent",
                            "tool_id": "abort", "output": "⏹ stopped by user",
                            "exit_code": 0})
                return
            if state == "error":
                yield _sse({"type": "tool_output", "tool": "agent",
                            "output": _error_text(payload.get("errorMessage")),
                            "exit_code": 1})
                continue
            # Images the AGENT shares back arrive as content blocks on the final
            # chat event (type:"image", url:/api/chat/media/outgoing/.../full —
            # served by our uploads.outgoing_image route). Emit the SSE shape the
            # SPA already renders (chat.js `if (json.image_url)` → image bubble).
            for url, alt in _image_blocks(payload):
                if url not in images_seen:
                    images_seen.add(url)
                    yield _sse({"image_url": url, "image_prompt": alt})
            delta = payload.get("deltaText")
            if not delta:
                text = _extract_text(payload)
                if text is not None and len(text) > emitted_len:
                    delta = text[emitted_len:]
                    emitted_len = len(text)
            if delta:
                timing.setdefault("t_first_text", time.monotonic())
                if tool_since_text:
                    yield _sse({"type": "agent_step"})  # open a fresh bubble
                    tool_since_text = False
                yield _sse({"delta": delta})
            continue

        if event != "agent":
            continue
        stream = payload.get("stream")
        data = payload.get("data") or {}

        if stream == "item" and data.get("kind") == "analysis":
            # Reasoning. The SPA already has a collapsed "View thinking
            # process" UI driven by {"delta": …, "thinking": true} frames
            # (chat.js wraps them in <think> tags) — reuse it, no new frame
            # types needed.
            text = _analysis_delta(data, analysis_seen)
            if text:
                if tool_since_text:
                    yield _sse({"type": "agent_step"})  # open a fresh bubble
                    tool_since_text = False
                yield _sse({"delta": text, "thinking": True})
            continue

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
                # Count this tool call ourselves — the gateway's usage RPC
                # doesn't track tool calls for these sessions. Guarded: a
                # counter must never interrupt the relay.
                if session_key:
                    try:
                        session_context.bump_tool_calls(session_key)
                    except Exception:  # noqa: BLE001
                        pass
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


def _disconnect_message(monitor_state: str) -> str:
    """A human explanation for a WS that died mid-turn, using what the
    persistent monitor knows. On this host the gateway restarts (launchctl
    kickstart, updates) and cold-boots for minutes — say so instead of a
    generic error."""
    if monitor_state == "restarting":
        return ("🧠 the gateway is restarting — this message may not have "
                "completed; retry once the status dot is green")
    return ("🧠 lost the gateway connection mid-turn — this message may not "
            "have completed")


def _analysis_delta(data: dict, seen: dict) -> str:
    """The NEW reasoning text in one `analysis` item event. Handles both an
    incremental `delta` field and cumulative `text`/`summary` snapshots — the
    per-item cursor in `seen` (itemId -> chars already emitted) diffs
    cumulative payloads down to the fresh suffix. Probed live 2026-06-07
    (scripts/probe_thinking.py, gpt-5.5, protocol v4): analysis items arrive
    as phase:start/end pairs carrying ONLY {title:"Reasoning", status} — no
    delta/text/summary field at all, so this currently returns "" and no
    thinking frames fire. The mapping is forward-compatible for when the
    gateway starts forwarding reasoning text; `title` is deliberately NOT a
    fallback (it's a static label, not reasoning content)."""
    if isinstance(data.get("delta"), str) and data["delta"]:
        return data["delta"]
    text = data.get("text") or data.get("summary") or ""
    if not isinstance(text, str) or not text:
        return ""
    item_id = data.get("itemId") or ""
    cursor = seen.get(item_id, 0)
    if len(text) <= cursor:
        return ""
    seen[item_id] = len(text)
    return text[cursor:]


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


def _image_blocks(payload: dict):
    """Yield (url, alt) for each image content block on a chat event's assistant
    message. The gateway emits these as {type:"image", url, alt, mimeType, ...}
    inside payload.message.content (text blocks contribute the reply text and are
    ignored here). `url` is a same-origin /api/chat/media/outgoing/... path the
    workspace backend serves from the gateway's on-disk managed-image record."""
    msg = payload.get("message") or {}
    content = msg.get("content")
    if not isinstance(content, list):
        return
    for block in content:
        if not isinstance(block, dict) or block.get("type") != "image":
            continue
        url = block.get("url") or block.get("openUrl")
        if isinstance(url, str) and url:
            yield url, (block.get("alt") or "")


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
