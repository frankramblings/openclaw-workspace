"""OpenClaw Workspace — FastAPI app.

Serves the (reused) Odysseus SPA and wires:
  - /api/chat_stream  → the bridge to OpenClaw's gateway brain  (REAL, v1)
  - /api/items        → native unified inbox (gmail/slack/asana/obsidian collectors)
  - a handful of minimal stubs so the SPA loads without console errors

Run:  uvicorn backend.app:app --reload --port 8800   (from the repo root)
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import mimetypes
import re
import time
from contextlib import asynccontextmanager

from fastapi import Body, FastAPI, Form
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.gzip import GZipMiddleware

from . import bridge, capabilities, config, doctor, draft_mode, monitor, sessions_store, websearch
from .memory import maybe_auto_extract
from .calendar_google import router as calendar_router
from .cron import router as cron_router
from .documents import router as documents_router
from .email_himalaya import router as email_router
from .emoji_proxy import router as emoji_router
from .inbox import router as inbox_router
from .memory import router as memory_router
from .notes import router as notes_router
from .research import router as research_router
from .settings_status import router as settings_router
from .skills import router as skills_router
from .uploads import ATTACH_DIR
from .uploads import router as uploads_router
from .workspace_files import router as workspace_files_router
from . import workspace_files

@asynccontextmanager
async def _lifespan(_app: FastAPI):
    # The persistent gateway monitor (status dot / restart awareness).
    task = asyncio.create_task(monitor.run())
    yield
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task


app = FastAPI(title="OpenClaw Workspace", lifespan=_lifespan)

# Wire bytes matter on the phone-over-Tailscale path and nothing upstream
# compresses (Tailscale Serve passes bytes through): style.css alone is 1MB
# raw / 227KB gzipped. Streaming responses (SSE) are flushed per-chunk by
# Starlette's GZipResponder, so /api/chat/stream keeps streaming.
app.add_middleware(GZipMiddleware, minimum_size=1024)

app.include_router(inbox_router)
app.include_router(memory_router)
app.include_router(skills_router)
app.include_router(cron_router)
app.include_router(email_router)
app.include_router(calendar_router)
app.include_router(settings_router)
app.include_router(notes_router)
app.include_router(documents_router)
app.include_router(uploads_router)
app.include_router(research_router)
app.include_router(emoji_router)
app.include_router(workspace_files_router)

# Active gateway runs by sessionKey, so the Stop button can chat.abort the run
# server-side. chat.js already POSTs /api/chat/stop/<sid> on explicit Stop
# (abortCurrentRequest(true)) — until now that hit the GET-only catch-all and
# only the browser-side fetch died, while the codex run kept burning.
_ACTIVE_RUNS: dict[str, dict] = {}


@app.get("/api/health")
async def health():
    return {
        "ok": True,
        "gateway": config.gateway_ws_url(),
        "session": config.session_key(),
        "has_password": bool(config.gateway_password()),
    }


@app.get("/api/doctor")
async def api_doctor():
    """Diagnose the OpenClaw connection (read-only)."""
    return doctor.summarize(await doctor.run_checks())


@app.get("/api/config")
async def workspace_config():
    """Public branding/config the SPA reads at boot so the agent name is right
    even before a frontend re-sync. Single source of truth lives in config.py."""
    return {
        "agent_name": config.agent_name(),
        "accent": config.accent_color(),
        # The footer shows this; previously it fetched the ENTIRE workspace
        # tree walk just to read .root (2026-06-12 mobile review E2).
        "workspace_root": str(workspace_files.workspace_root()),
    }


@app.get("/api/capabilities")
async def api_capabilities():
    """Which tabs are usable on this install (drives UI gating)."""
    return capabilities.snapshot()


@app.get("/api/gateway/status")
async def gateway_status():
    """Last-known gateway state from the persistent monitor, for the UI's
    status dot (polled ~30s). state: ok | restarting | down."""
    return await monitor.status()


# --- The one real, load-bearing endpoint: chat ------------------------------

def _model_ref(rec: dict | None) -> str | None:
    """Build a gateway model ref ("provider/model") from a session record, or
    None to leave the model at the agent default. Returns None for the
    "openclaw" placeholder (legacy/bootstrap) AND when the pick already equals
    the configured default — so we only set an override when it actually
    differs (no per-turn sessions.create churn for default chats)."""
    if not rec:
        return None
    model = (rec.get("model") or "").strip()
    if not model or model == "openclaw":
        return None
    provider = (rec.get("endpoint_id") or "").strip()
    def_provider, def_model = config.default_model()
    if model == def_model and (not provider or provider in (def_provider, "openclaw")):
        return None
    return f"{provider}/{model}" if provider and provider != "openclaw" else model


# --- Auto-title: name a fresh thread from its first message (AI + fallback) ---
# The SPA names new chats "{model} {time}" (a placeholder). On the first message
# we retitle the session — instantly to a first-line snippet, then upgraded to an
# AI title generated by the brain (ChatGPT-style). Backend-only: the Library list
# already reloads after a turn, so the new title just appears.

_SPEED_THINKING = {"fast": "low", "deep": "high"}


def _thinking_for_speed(speed: str | None) -> str | None:
    """Map the chat's speed setting to chat.send's per-turn thinking override.
    normal (and anything unknown) sends NO override — the default path stays
    byte-identical to pre-toggle behavior."""
    return _SPEED_THINKING.get(speed or "")


_DONE_SSE = "data: [DONE]\n\n"
_TITLE_SESSION_KEY = f"{config.web_session_prefix()}-titler"
# "{base} 1:56:53 PM" / "{base} 14:05:09" — the SPA's placeholder name.
_PLACEHOLDER_RE = re.compile(r".+\s\d{1,2}:\d{2}:\d{2}(\s?[AP]M)?$", re.I)


def _needs_title(rec: dict) -> bool:
    name = (rec.get("name") or "").strip()
    if not name or name in ("New chat", "Nobody"):
        return True
    return bool(_PLACEHOLDER_RE.match(name))


def _first_chars_title(message: str, n: int = 42) -> str:
    text = (message or "").strip()
    if not text:
        return ""
    line = text.splitlines()[0].strip()
    return line if len(line) <= n else line[:n].rstrip() + "…"


def _sanitize_title(raw: str) -> str:
    if not raw:
        return ""
    line = raw.strip().splitlines()[0].strip().strip('"\'').strip()
    line = re.sub(r"^(chat title|title)\s*[:\-]\s*", "", line, flags=re.I)
    return line.rstrip(" .!,;:")[:60].strip()


async def _collect_brain_text(prompt: str, session_key: str,
                              model_ref: str | None = None) -> str:
    chunks: list[str] = []
    async for sse in bridge.stream_turn(prompt, session_key=session_key,
                                        model_ref=model_ref):
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


async def _generate_ai_title(message: str) -> str:
    prompt = ("Generate a short, specific chat title (3-6 words, no quotes, no "
              "trailing punctuation) for the topic of a conversation that opens "
              f"with this message:\n\n{message[:600]}\n\nOutput ONLY the title.")
    return _sanitize_title(await _collect_brain_text(
        prompt, _TITLE_SESSION_KEY, model_ref=config.TITLE_MODEL))


def _wants_web(use_web: str, allow_web_search: str) -> bool:
    """The globe toggle's FIELD NAME depends on the SPA's vestigial chat/agent
    mode: `use_web` in chat mode, `allow_web_search` in agent mode (chat.js
    ~747-753). Accept both — agent mode silently lost web search before."""
    return any(v.lower() in ("true", "1", "on", "yes")
               for v in (use_web, allow_web_search))


def _sse_frame(chunk: str):
    """Parse one of the bridge's `data: {...}` SSE strings back to its dict
    (None for [DONE]/non-JSON). Used to observe what the turn relayed."""
    body = chunk[5:].strip() if chunk.startswith("data:") else ""
    if not body or body == "[DONE]":
        return None
    try:
        obj = json.loads(body)
    except ValueError:
        return None
    return obj if isinstance(obj, dict) else None


def reply_after(history: list, brain_message: str) -> str | None:
    """Assistant text following the LAST occurrence of this turn's user message
    in the transcript — i.e. THIS turn's reply, never an earlier one."""
    idx = next((i for i in range(len(history) - 1, -1, -1)
                if history[i].get("role") == "user"
                and history[i].get("content") == brain_message), None)
    if idx is None:
        return None
    text = "\n".join(str(m.get("content") or "") for m in history[idx + 1:]
                     if m.get("role") == "assistant").strip()
    return text or None


def _turn_timing_record(run_info: dict, session_key: str, model_ref: str | None,
                        *, text_seen: bool, failed: bool,
                        thinking: str | None = None) -> dict:
    """One flat JSONL record describing where this turn's wall-clock went.
    All *_ms fields are measured from chat.send write; None = never happened."""
    timing = run_info.get("timing") or {}

    def ms(a: str, b: str) -> int | None:
        return (int((timing[b] - timing[a]) * 1000)
                if a in timing and b in timing else None)

    return {
        "ts": int(time.time()),
        "session": session_key,
        "model": model_ref or "default",
        "thinking": thinking,   # the chat.send override sent (None = normal)
        "ack_ms": ms("t_send", "t_ack"),
        "first_frame_ms": ms("t_send", "t_first_frame"),
        "first_text_ms": ms("t_send", "t_first_text"),
        "late_ms": ms("t_send", "t_late"),
        "total_ms": ms("t_send", "t_end"),
        "stalled": bool(run_info.get("stalled")),
        "retried": bool(run_info.get("retried")),
        "text_seen": text_seen,
        "failed": failed,
    }


def _log_turn_timing(record: dict) -> None:
    """Append one JSONL line to .data/turn_timings.jsonl. Telemetry must never
    break a turn: every failure is swallowed. Single-generation rotation at
    2MB keeps the file bounded on this disk-starved box."""
    with contextlib.suppress(Exception):
        path = config.DATA_DIR / "turn_timings.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() and path.stat().st_size > 2_000_000:
            path.replace(path.with_name(path.name + ".old"))
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record) + "\n")


# First checks fire fast — the reply usually already sits in the transcript
# when this poll starts (it lands seconds *before* we get here on slow turns,
# milliseconds after on fast ones). Tail stays ~10s total like the old
# 5 × 2s schedule.
_LATE_REPLY_SCHEDULE = (0.3, 0.5, 1.0, 2.0, 2.0, 2.0, 2.2)


async def _late_reply(session_key: str, brain_message: str,
                      _sleep=asyncio.sleep) -> str | None:
    """Fetch the reply that the gateway commits to the transcript only AFTER
    the run's lifecycle end (message-tool delivery — see _relay_events docs).
    Polls with fast-start backoff; returns None if nothing lands (genuinely
    textless turn)."""
    for delay_s in _LATE_REPLY_SCHEDULE:
        await _sleep(delay_s)
        try:
            data = await bridge.fetch_history(session_key)
        except Exception:  # noqa: BLE001 - transient WS trouble: keep polling
            continue
        text = reply_after(data.get("history") or [], brain_message)
        if text:
            return text
    return None


def _resolve_attachments(raw: str) -> list[dict]:
    """Turn the composer's posted `attachments` (a JSON array of upload ids, each
    a filename under ATTACH_DIR) into the chat.send attachment shape the gateway
    accepts: {type, mimeType, fileName, content(base64)}. Only image/* files are
    forwarded — the gateway sniffs the bytes and drops non-images, and gpt-5.5
    takes them as inline vision blocks (large ones it offloads to media refs the
    agent resolves). Silently skips anything missing/unreadable so a bad id never
    breaks the turn."""
    if not raw:
        return []
    try:
        ids = json.loads(raw)
    except Exception:  # noqa: BLE001 - malformed field → no attachments
        return []
    out: list[dict] = []
    for fid in ids if isinstance(ids, list) else []:
        if not isinstance(fid, str):
            continue
        safe = "".join(c for c in fid if c.isalnum() or c in "-_.")  # path-traversal guard
        path = ATTACH_DIR / safe
        if not path.exists() or not path.is_file():
            continue
        mime = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        if not mime.startswith("image/"):
            continue  # gateway accepts only image/* attachments
        try:
            data = path.read_bytes()
        except Exception:  # noqa: BLE001 - unreadable file → skip it
            continue
        out.append({
            "type": "image",
            "mimeType": mime,
            "fileName": path.name,
            "content": base64.b64encode(data).decode("ascii"),
        })
    return out


@app.post("/api/chat_stream")
async def chat_stream(message: str = Form(...), session: str = Form(default=""),
                      use_web: str = Form(default=""),
                      allow_web_search: str = Form(default=""),
                      attachments: str = Form(default=""),
                      active_doc_id: str = Form(default="")):
    """Stream a turn from OpenClaw's brain as Odysseus-shaped SSE.

    The posted `session` is the SPA's session id; we resolve it to that chat's
    own gateway sessionKey (agent:main:web-<id>) so each Library chat is an
    isolated thread and none contend with Signal on agent:main:main. Unknown
    ids fall back to the shared web key. The session's picked model (if any) is
    applied to that session only, so the picker actually switches the model.

    On a fresh thread's first message we also auto-title it (see above).
    """
    rec = sessions_store.get(session) if session else None
    session_key = rec["sessionKey"] if rec else config.web_session_key()
    run_info: dict = {}  # bridge fills sessionKey/runId once chat.send acks
    chat_attachments = _resolve_attachments(attachments)  # image uploads → vision

    # Draft mode: chat.js posts active_doc_id whenever the document panel is
    # open (auto-saving the doc first). Snapshot now (the user's undo), wrap
    # the message in gen(), detect agent edits after the turn (draft_mode.py).
    draft_doc = draft_mode.pre_turn(active_doc_id) if active_doc_id else None

    title_task = None
    if rec and message.strip() and _needs_title(rec):
        snippet = _first_chars_title(message)
        if snippet:  # instant fallback so the title is never the timestamp
            sessions_store.update(rec["id"], name=snippet)
        title_task = asyncio.create_task(_generate_ai_title(message))

    async def gen():
        brain_message = message
        text_seen = False    # any non-thinking {"delta"} relayed this turn?
        tools_seen = False   # any tool card relayed (fresh bubble needed)?
        failed = False       # bridge/agent error or user abort — no reply coming
        try:
            # Web search (the composer's globe toggle — field name varies by
            # the SPA's vestigial mode, see _wants_web). Search failures
            # degrade to a visible failed tool card — never break the turn.
            if _wants_web(use_web, allow_web_search):
                s = websearch.load_settings()
                if s.get("search_provider") != "disabled":
                    yield bridge._sse({"type": "tool_start", "tool": "web_search",
                                       "tool_id": "websearch",
                                       "command": message[:120], "round": 1})
                    try:
                        results = await websearch.search(
                            message, int(s.get("search_result_count") or 5))
                        yield bridge._sse({
                            "type": "tool_output", "tool": "web_search",
                            "tool_id": "websearch", "exit_code": 0,
                            "output": "\n".join(f"[{i+1}] {r['title']} — {r['url']}"
                                                for i, r in enumerate(results))
                                      or "no results"})
                        if results:
                            brain_message = websearch.context_block(message, results)
                    except Exception as exc:  # noqa: BLE001
                        yield bridge._sse({"type": "tool_output", "tool": "web_search",
                                           "tool_id": "websearch",
                                           "output": f"web search failed: {exc}",
                                           "exit_code": 1})
            if draft_doc is not None:
                brain_message = draft_mode.wrap_message(brain_message, draft_doc)
            _ACTIVE_RUNS[session_key] = run_info
            async for chunk in bridge.stream_turn(brain_message, session_key=session_key,
                                                  model_ref=_model_ref(rec),
                                                  attachments=chat_attachments,
                                                  run_info=run_info,
                                                  thinking=_thinking_for_speed((rec or {}).get("speed"))):
                if "[DONE]" in chunk:
                    continue  # hold DONE until the title settles, then send our own
                frame = _sse_frame(chunk)
                if isinstance(frame, dict):
                    if frame.get("delta") and not frame.get("thinking"):
                        text_seen = True
                    if frame.get("type") in ("tool_start", "tool_output"):
                        tools_seen = True
                    if (frame.get("exit_code") == 1
                            and frame.get("tool") in ("bridge", "agent")
                            # stall terminal card still allows the late-reply
                            # poll to salvage a transcript-landed reply.
                            and frame.get("tool_id") != "stall") \
                            or frame.get("tool_id") == "abort":
                        failed = True
                yield chunk
            # Late delivery: the agent often replies via its `message` tool,
            # whose text lands in the transcript seconds AFTER the run's
            # lifecycle end — the live stream then carries no text at all and
            # the reply only appeared on the next refresh. Same workaround the
            # research engine needed: poll chat.history briefly and emit it.
            if not text_seen and not failed:
                late = await _late_reply(session_key, brain_message)
                if late:
                    run_info.setdefault("timing", {})["t_late"] = time.monotonic()
                    if tools_seen:
                        yield bridge._sse({"type": "agent_step"})  # fresh bubble
                    yield bridge._sse({"delta": late})
        finally:
            _ACTIVE_RUNS.pop(session_key, None)
            _log_turn_timing(_turn_timing_record(
                run_info, session_key, _model_ref(rec),
                text_seen=text_seen, failed=failed,
                thinking=_thinking_for_speed((rec or {}).get("speed"))))
            if draft_doc is not None:
                try:
                    update = draft_mode.post_turn_payload(draft_doc)
                    if update:
                        # NOTE: a yield in finally is deliberate (matches _DONE_SSE
                        # below). On client disconnect (GeneratorExit) the frame is
                        # silently discarded — the browser refetches the doc on
                        # session reopen, so no state is lost.
                        yield bridge._sse(update)
                except Exception:  # noqa: BLE001 - never break the turn close
                    pass
            if title_task is not None:
                try:
                    ai = await asyncio.wait_for(title_task, timeout=12)
                    if ai:
                        sessions_store.update(rec["id"], name=ai)
                except Exception:  # noqa: BLE001 - keep the first-chars fallback
                    title_task.cancel()
            # Auto-extract memories (gated inside: toggle pref + cooldown).
            asyncio.create_task(maybe_auto_extract(session_key))
            yield _DONE_SSE

    return StreamingResponse(gen(), media_type="text/event-stream")


# --- Session persistence: metadata here, message content from the brain ------

@app.get("/api/sessions")
async def sessions():
    return sessions_store.list_sessions()


@app.post("/api/session")
async def create_session(name: str = Form(default=""), model: str = Form(default=""),
                         endpoint_url: str = Form(default=""),
                         endpoint_id: str = Form(default=""),
                         speed: str = Form(default="")):
    return sessions_store.create(name=name or None, model=model or None,
                                 endpoint_url=endpoint_url or None,
                                 endpoint_id=endpoint_id or None,
                                 speed=speed or None)


@app.get("/api/history/{session_id}")
async def history(session_id: str):
    """The session's saved transcript, read live from the brain via chat.history."""
    sess = sessions_store.get(session_id)
    if not sess:
        return {"history": [], "model": None}
    data = await bridge.fetch_history(sess["sessionKey"])
    # use_web turns store the augmented brain message (search block + the
    # user's text) in the transcript; show only what the user typed.
    for m in data.get("history", []):
        if m.get("role") == "user":
            m["content"] = websearch.strip_context_block(m.get("content"))
    # Prefer the record's chosen model label; fall back to whatever the brain used.
    data["model"] = sess.get("model") or data.get("model")
    return data


@app.patch("/api/session/{session_id}")
async def patch_session(session_id: str, name: str = Form(default=None),
                        model: str = Form(default=None), folder: str = Form(default=None),
                        endpoint_url: str = Form(default=None),
                        endpoint_id: str = Form(default=None),
                        speed: str = Form(default=None)):
    if speed is not None and speed not in ("fast", "normal", "deep"):
        speed = None   # invalid value → ignored, like other bad fields
    fields = {k: v for k, v in {
        "name": name, "model": model, "folder": folder,
        "endpoint_url": endpoint_url, "endpoint_id": endpoint_id,
        "speed": speed,
    }.items() if v is not None}
    return sessions_store.update(session_id, **fields) or JSONResponse(
        status_code=404, content={"detail": "no such session"})


async def _delete_gateway_session(session_key: str) -> None:
    """Best-effort gateway-side delete (transcript included) so removing a
    chat here doesn't leave its thread accumulating in the brain's session
    store — real weight on this 8GB box. Verified: sessions.delete
    {key, deleteTranscript} (deleteTranscript defaults true anyway)."""
    try:
        await bridge.gateway_call("sessions.delete",
                                  {"key": session_key, "deleteTranscript": True})
    except Exception:  # noqa: BLE001 - local delete already succeeded
        pass


@app.delete("/api/session/{session_id}")
async def delete_session(session_id: str):
    rec = sessions_store.get(session_id)
    ok = sessions_store.delete(session_id)
    if ok and rec and rec.get("sessionKey"):
        asyncio.create_task(_delete_gateway_session(rec["sessionKey"]))
    return {"ok": ok}


@app.post("/api/session/{session_id}/important")
async def set_important(session_id: str, important: str = Form(default="true")):
    val = str(important).lower() not in ("false", "0", "")
    sessions_store.update(session_id, important=val)
    return {"ok": True, "important": val}


@app.post("/api/session/{session_id}/archive")
async def archive_session(session_id: str):
    sessions_store.update(session_id, archived=True)
    return {"ok": True}


@app.post("/api/session/{session_id}/unarchive")
@app.post("/api/session/{session_id}/restore")
async def unarchive_session(session_id: str):
    sessions_store.update(session_id, archived=False)
    return {"ok": True}


@app.get("/api/chat/resume/{session_id}")
async def resume(session_id: str):
    return {"id": session_id, "messages": []}


@app.get("/api/chat/stream_status/{session_id}")
async def stream_status(session_id: str):
    return {"active": False}


@app.post("/api/chat/stop/{session_id}")
async def stop_chat(session_id: str):
    """The Stop button's server half: chat.abort the active gateway run.
    Verified shape: chat.abort {sessionKey, runId?} -> {runIds}; omitting
    runId aborts every run on the key. NOTE: on an explicit Stop the browser
    kills its fetch FIRST, which tears down gen() and pops _ACTIVE_RUNS —
    so the key-wide abort is the EXPECTED path here; the runId narrowing is
    opportunistic (e.g. stop called from another tab)."""
    session_key = sessions_store.session_key_for(session_id)
    params = {"sessionKey": session_key}
    run_id = (_ACTIVE_RUNS.get(session_key) or {}).get("runId")
    if run_id:
        params["runId"] = run_id
    try:
        payload = await bridge.gateway_call("chat.abort", params, timeout=10)
        return {"ok": True, "runIds": payload.get("runIds") or []}
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=502,
                            content={"ok": False, "error": f"{exc!r}"})


@app.get("/api/models")
async def models():
    # The SPA's models.js reads `data.items` (NOT a bare array). We serve the
    # REAL gateway catalog (models.list + models.authStatus), grouped one
    # endpoint per provider (Codex / Claude), with `offline` reflecting each
    # provider's auth status. category must be "api" (models.js buckets anything
    # non-"local" there). url is the WS endpoint, echoed into the session, never
    # routed — every turn goes through the bridge regardless of picked model.
    # If the gateway is unreachable, fall back to a single honest placeholder so
    # the picker still renders (rather than going blank → "no session").
    try:
        return await bridge.fetch_models()
    except Exception:  # noqa: BLE001
        return {"items": [
            {"endpoint_id": "openclaw", "endpoint_name": "OpenClaw",
             "url": config.gateway_ws_url(), "category": "api",
             "models": ["openclaw"], "models_display": ["OpenClaw"],
             "models_extra": [], "models_extra_display": [], "offline": True},
        ]}


@app.get("/api/default-chat")
async def default_chat():
    # endpoint_url is REQUIRED: chat.js auto-creates the session only when both
    # endpoint_url and model are truthy. It's stored + echoed back to /api/session
    # but never used to route — every turn goes through the bridge regardless.
    # Land on the primary agent's configured model so the picker opens on it.
    provider, model = config.default_model()
    return {"endpoint_id": provider, "endpoint_url": config.gateway_ws_url(),
            "model": model}


# Auth stubs: single-user/no-auth deployment behind Tailscale. Return a logged-in
# admin so the SPA never redirects to /login. Privileges double as feature flags:
# False hides that feature's chrome (init.js/app.js read these), so anything
# with no backend here is flipped off rather than advertised as working.
@app.get("/api/auth/status")
async def auth_status():
    return {
        "authenticated": True, "is_admin": True, "username": "frank",
        "privileges": {
            "can_use_agent": True, "can_use_bash": True, "can_use_documents": True,
            "can_use_research": True,
            # No image-gen backend (hides #tool-image-btn; Gallery is CSS-hidden).
            "can_generate_images": False,
        },
    }


@app.get("/api/auth/features")
async def auth_features():
    return {"auth_required": False, "features": {}}


@app.get("/api/auth/settings")
async def auth_settings():
    """Settings the SPA reads (search provider/result count etc.). Persisted
    in .data/settings.json; search execution lives in websearch.py."""
    return websearch.load_settings()


@app.post("/api/auth/settings")
async def save_auth_settings(payload: dict = Body(default=None)):
    return websearch.save_settings(payload or {})


# --- Catch-all for Odysseus feature tabs v1 doesn't implement yet ------------
# cookbook, prefs, tts… each
# polls its own backend. Returning [] is universally safe: Odysseus's consumers
# all do either `data.forEach(...)` (works on []) or `data.key || []` (→ []), so
# this quiets the 404 flood without breaking any module. Registered AFTER every
# real route, so health/items/models/chat/auth/sessions still win.
@app.get("/api/{path:path}")
async def _unimplemented_api(path: str):
    return []


@app.get("/sw.js")
async def service_worker():
    """Serve the service worker from the ORIGIN ROOT.

    Registered at /static/sw.js the SW's max scope is /static/ and it can
    never control the SPA at / — the whole offline story was inert (2026-06-12
    mobile review, P0). Served at /sw.js its default scope is the origin root.
    no-cache so browsers revalidate the worker itself on each check.
    """
    sw = config.FRONTEND_DIR / "sw.js"
    if not sw.exists():
        return JSONResponse(status_code=404, content={"error": "sw.js not built"})
    return FileResponse(str(sw), media_type="application/javascript",
                        headers={"Cache-Control": "no-cache"})


# --- Serve the reused Odysseus SPA ------------------------------------------
# Mounted last so /api/* routes win. The SPA lives in frontend/ (copied from
# Odysseus static/). index.html is the entry; everything else is static assets.

if config.FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(config.FRONTEND_DIR)), name="static")

    @app.get("/")
    async def index():
        return FileResponse(str(config.FRONTEND_DIR / "index.html"))
else:
    @app.get("/")
    async def index_missing():
        return JSONResponse(
            status_code=500,
            content={"error": f"frontend not found at {config.FRONTEND_DIR}. "
                              "Run scripts/sync-frontend.sh to copy Odysseus static/."},
        )
