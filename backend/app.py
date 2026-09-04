"""OpenClaw Workspace — FastAPI app.

Serves the (reused) Odysseus SPA and wires:
  - /api/chat_stream  → the bridge to OpenClaw's gateway brain  (REAL, v1)
  - /api/items        → native unified inbox (gmail/slack/asana/obsidian collectors)
  - a handful of minimal stubs so the SPA loads without console errors

Run:  uvicorn backend.app:app --reload --port 8800   (from the repo root)
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import shutil
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Body, FastAPI, Form, Request, Response
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.gzip import GZipMiddleware

from . import (branch_context, bridge, capabilities, changes, chat_search, chat_turn, config,
               config_check, doctor, draft_mode, event_store, followup, history_display, mentions,
               monitor, pending_tokens, promise_guard, push, sessions_store, steer,
               syschatter, task_ingest, task_registry, terminals, turn_state, websearch)
from .auth_gate import AuthGateMiddleware
from .security_headers import SecurityHeadersMiddleware
from .memory import maybe_auto_extract
from .auth_password import router as auth_password_router
from .calendar import router as calendar_router
from .cron import router as cron_router
from .projects import router as projects_router
from .documents import router as documents_router
from .email_himalaya import router as email_router
from .emoji_proxy import router as emoji_router
from .export_route import router as export_router
from .inbox import router as inbox_router
from .jobs import router as jobs_router
from .agent_config_routes import router as agent_config_router
from .agent_files import router as agent_files_router
from .logs_route import router as logs_router
from .mcp_servers import router as mcp_servers_router
from .memory import router as memory_router
from .notes import router as notes_router
from .research import router as research_router
from .settings_status import router as settings_router
from .skill_proposals import router as skill_proposals_router
from .skills import router as skills_router
from .uploads import router as uploads_router
from .perplexity_agent import router as perplexity_agent_router
from .workspace_files import router as workspace_files_router
from .workspace_watch import router as workspace_watch_router
from . import workspace_watch
from .terminals import router as terminals_router
from .resume_route import router as resume_router
from .export_pdf import router as export_pdf_router
from .strip_state import router as strip_state_router
from .suggest import router as suggest_router
from .tasks_route import router as tasks_router
from .transcribe_routes import router as transcribe_router
from .voice import router as voice_router
from .palette_routes import router as palette_router
from .usage_route import router as usage_router
from .changes_route import router as changes_router
from . import workspace_files
# Attachment subsystem (Task 19): image/text extraction, HEIC→JPEG, persistence.
# app.py keeps the to_thread call sites (they dispatch the blocking work here off
# the event loop) and re-exposes these names so existing call sites / monkeypatch
# seams keep working (e.g. tests call app._terminal_attachments).
from .attachments import (
    _apply_msg_attachments,
    _extract_text_attachments,
    _persist_msg_attachments,
    _prepend_text_attachments,
    _resolve_attachments,
)
from .question_cards import answers_for as _qc_answers_for, record_answer as _qc_record_answer
from .secret_scrub import scrub as _scrub_secrets, system_note as _scrub_note
# Re-export the turn-engine helpers (extracted to chat_turn.py in Task 19) on the
# app module so every existing import site and monkeypatch seam keeps resolving
# them at backend.app.X: followup.py reads app._model_ref / app._sse_frame /
# app._late_reply / app._start_turn_recorder; tests do `from backend.app import
# _is_done_frame / _wants_web / reply_after / ...` and patch app._log_turn_timing.
# Plain module-level aliases (not `from ... import`) so ruff sees them as used.
_model_ref = chat_turn._model_ref
_thinking_for_speed = chat_turn._thinking_for_speed
_is_done_frame = chat_turn._is_done_frame
_DONE_SSE = chat_turn._DONE_SSE
_needs_title = chat_turn._needs_title
_first_chars_title = chat_turn._first_chars_title
_sanitize_title = chat_turn._sanitize_title
_generate_ai_title = chat_turn._generate_ai_title
_wants_web = chat_turn._wants_web
_sse_frame = chat_turn._sse_frame
reply_after = chat_turn.reply_after
_turn_timing_record = chat_turn._turn_timing_record
_log_turn_timing = chat_turn._log_turn_timing
_LATE_REPLY_SCHEDULE = chat_turn._LATE_REPLY_SCHEDULE
_late_reply = chat_turn._late_reply
# Also re-exposed for tests that call app._terminal_attachments directly
# (test_bridge_terminal_images); the route itself no longer references it — the
# engine resolves terminal-drop images via attachments._terminal_attachments.
_terminal_attachments = chat_turn._terminal_attachments

# Two seam shapes, don't conflate them: the attachments import and every
# chat_turn.X alias above are one-time DIRECT-CALL re-exports — the engine
# calls its OWN module-global, so patching app.X is a no-op (patch chat_turn.X
# / attachments.X to affect it). _spawn / maybe_auto_extract / _log_turn_timing
# (the drive_turn call below, ~:492) are PASS-THROUGH seams instead, looked up
# on `app` at call time and passed in as kwargs, so patching app.X for those
# three DOES reach the engine.

# Configure root logging ONCE, here, at import time — before the FastAPI app
# object (and anything that might log) is built. Only 3 of ~40 backend
# modules called getLogger before this task; every module's `logging.warning`/
# `.error` calls were previously going nowhere (root logger had no handler ->
# Python's "handler of last resort" prints WARNING+ to stderr with no
# formatting, INFO/DEBUG silently vanish). basicConfig installs a StreamHandler
# with a real formatter at the level WORKSPACE_LOG_LEVEL asks for (INFO by
# default).
#
# The `if not logging.getLogger().handlers` guard matters because under
# uvicorn the root logger MAY already have a handler by the time this module
# is imported (uvicorn installs its own default logging config before
# importing the ASGI app target) — calling basicConfig again in that case is a
# silent no-op per the stdlib docs, but the guard makes that explicit and
# means a bare `python -c "import backend.app"` (no uvicorn) still gets
# sensible output instead of the handler-of-last-resort fallback.
if not logging.getLogger().handlers:
    logging.basicConfig(
        level=os.environ.get("WORKSPACE_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

_log = logging.getLogger(__name__)


async def _startup_reindex() -> None:
    """Keep the semantic-search index fresh in the background. Runs the first
    build shortly after boot (delayed so the app serves requests immediately),
    then refreshes every 30 min. reindex() is incremental — sessions whose
    `updated` stamp is unchanged are skipped — so each refresh only embeds new
    or changed conversations. Failures are swallowed (log only) so a
    gateway/Voyage hiccup can never crash boot or stop the loop."""
    log = logging.getLogger("workspace.chat_search")
    await asyncio.sleep(20)
    while True:
        try:
            await chat_search.reindex()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - never let an index failure stop the loop
            log.warning("periodic reindex failed", exc_info=True)
        await asyncio.sleep(1800)  # 30 min — pick up new/updated conversations


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    # Startup config validation (Task 15): numeric env vars that fail to
    # parse, a corrupt ~/.openclaw/openclaw.json, a missing vault root, and
    # likely WORKSPACE_*/OPENCLAW_*/INBOX_* env-var typos are all logged here
    # and never stop the app from booting. An unwritable .data/ is the one
    # exception -- config_check.run() raises for that, and we let it
    # propagate: the app truly cannot function without somewhere to persist
    # sessions/state, so failing loudly at startup beats booting into a
    # silent-write-failure mode.
    for problem in config_check.run():
        _log.warning("config check: %s", problem)
    # The persistent gateway monitor (status dot / restart awareness).
    task = asyncio.create_task(monitor.run())
    # Non-blocking semantic-search index build (delayed; swallows failures).
    search_task = asyncio.create_task(_startup_reindex())
    # Boot sweep: any turn still marked in-flight from the previous process is
    # provably dead (the recorder task died with the interpreter) — move it to
    # `interrupted` so /api/chat/turn can report an honest post-mortem instead
    # of leaving the client frozen on "Working…" forever.
    interrupted = turn_state.sweep_boot()
    if interrupted:
        _log.warning("boot: %d turn(s) died with the previous process: %s",
                     len(interrupted), ", ".join(sorted(interrupted)))
    interrupted_tasks = task_registry.sweep_boot()
    if interrupted_tasks:
        _log.warning("boot: %d background task(s) died with the previous process",
                     len(interrupted_tasks))
    # Followup promises: deadline + crash-recovery backstop.
    followup_task = asyncio.create_task(followup.sweeper())
    # Web push: VAPID keys must exist before any client subscribes. Only init if
    # push is supported — degraded installs (pywebpush absent) skip this.
    if push.supported():
        try:
            push.ensure_keys()
        except Exception:  # noqa: BLE001 - push failure must never block boot
            _log.warning("push key initialization failed", exc_info=True)
    # Progress-UX mirror loop: tmp/jobs/*.json + share/tasks/*/progress.json
    # into task_registry, once per process (see task_ingest.py).
    ingest_task = asyncio.create_task(task_ingest.ingest_loop())
    # Changes review: daily sweep of the turn-diff index/blob store (expiry +
    # orphan cleanup). See backend/changes.py.
    changes_sweep_task = asyncio.create_task(changes.sweep_loop())
    # Filesystem watcher for the doc editor's live-refresh (broadcasts to
    # /api/workspace/watch subscribers). Cheap Rust-backed inotify; one task.
    workspace_watch.start_watcher()
    try:
        yield
    finally:
        # Reap every PTY shell so its `bash -i` child (and descendants) get
        # SIGHUP→SIGKILL right now. Otherwise they ignore the SIGTERM systemd sends
        # the whole cgroup, holding the unit open until TimeoutStopSec forces a
        # SIGKILL of everything — the intermittent restart hang / 502 window. We call
        # PtySession.close() directly (not close_session) so we DON'T also unlink the
        # persistent per-session image-attachment registry; scrollback/cwd are
        # already flushed by close() and restored on the next attach.
        for _sess in list(getattr(terminals, "_sessions", {}).values()):
            try:
                _sess.close()
            except Exception:  # noqa: BLE001 - best-effort teardown, never block exit
                pass
        task.cancel()
        search_task.cancel()
        followup_task.cancel()
        ingest_task.cancel()
        changes_sweep_task.cancel()
        for t in (task, search_task, followup_task, ingest_task, changes_sweep_task):
            with contextlib.suppress(asyncio.CancelledError):
                await t
        # Own every other task we've spun up over the app's life so nothing is
        # orphaned to uvicorn's 2s force-close window: the workspace-watch
        # filesystem watcher, per-turn SSE recorders (_TURN_TASKS — one per
        # in-flight chat turn, detached from any reader), and fire-and-forget
        # background work (_BG_TASKS — memory auto-extract, gateway-side
        # session delete, on-demand reindex). Snapshot to lists first: these
        # collections mutate themselves via done-callbacks/pop as tasks
        # finish, which would raise "set changed size during iteration" if we
        # iterated them live while cancelling.
        await workspace_watch.stop()
        remaining = (list(_TURN_TASKS.values()) + list(_BG_TASKS)
                     + list(chat_turn._CHANGES_TASKS))
        for t in remaining:
            t.cancel()
        if remaining:
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(
                    asyncio.gather(*remaining, return_exceptions=True), 2.0)


app = FastAPI(title="OpenClaw Workspace", lifespan=_lifespan)

# Wire bytes matter on the phone-over-Tailscale path and nothing upstream
# compresses (Tailscale Serve passes bytes through): style.css alone is 1MB
# raw / 227KB gzipped. Streaming responses (SSE) are flushed per-chunk by
# Starlette's GZipResponder, so /api/chat/stream keeps streaming.
app.add_middleware(GZipMiddleware, minimum_size=1024)

# Optional auth gate: a complete no-op when WORKSPACE_AUTH_TOKEN is unset
# (the middleware reads the token at request time and short-circuits immediately
# when it's None, so zero overhead or behavior change for the default no-token
# case). Added AFTER GZip so auth runs in the outer layer (before compression).
app.add_middleware(AuthGateMiddleware)

# Security response headers (CSP report-only by default; see
# security_headers.py). Starlette's add_middleware() inserts at position 0 of
# the user-middleware list, and the stack is built by wrapping in REVERSE of
# that list — so the LAST middleware added ends up OUTERMOST, closest to the
# client. Added AFTER AuthGateMiddleware so it wraps AuthGate's rejections
# (401/403/302) too, not just responses that reach the router/GZip layer.
app.add_middleware(SecurityHeadersMiddleware)

app.include_router(inbox_router)
app.include_router(jobs_router)
app.include_router(memory_router)
app.include_router(auth_password_router)
app.include_router(export_router)
app.include_router(skills_router)
app.include_router(cron_router)
app.include_router(projects_router)
app.include_router(email_router)
app.include_router(calendar_router)
app.include_router(settings_router)
app.include_router(mcp_servers_router)
app.include_router(skill_proposals_router)
app.include_router(agent_files_router)
app.include_router(logs_router)
app.include_router(agent_config_router)
app.include_router(notes_router)
app.include_router(documents_router)
app.include_router(followup.router)
app.include_router(pending_tokens.router)
app.include_router(promise_guard.router)
app.include_router(uploads_router)
app.include_router(research_router)
app.include_router(perplexity_agent_router)
app.include_router(emoji_router)
app.include_router(workspace_files_router)
app.include_router(workspace_watch_router)
app.include_router(terminals_router)
app.include_router(resume_router)
app.include_router(export_pdf_router)
app.include_router(strip_state_router)
app.include_router(suggest_router)
app.include_router(tasks_router)
app.include_router(transcribe_router)
app.include_router(voice_router)
app.include_router(palette_router)
app.include_router(usage_router)
app.include_router(changes_router)

# Active gateway runs by sessionKey, so the Stop button can chat.abort the run
# server-side. chat.js already POSTs /api/chat/stop/<sid> on explicit Stop
# (abortCurrentRequest(true)) — until now that hit the GET-only catch-all and
# only the browser-side fetch died, while the codex run kept burning.
_ACTIVE_RUNS: dict[str, dict] = {}

# Fire-and-forget background tasks (memory auto-extract, gateway-side session
# delete, on-demand reindex). asyncio holds only a WEAK reference to a bare
# create_task(), so a long one can be garbage-collected mid-flight; keep a
# strong ref here and drop it when it finishes.
_BG_TASKS: set[asyncio.Task] = set()


def _spawn(coro) -> asyncio.Task:
    """create_task + keep a strong reference until the task completes."""
    task = asyncio.create_task(coro)
    _BG_TASKS.add(task)
    task.add_done_callback(_BG_TASKS.discard)
    return task


# session_key -> the detached asyncio.Task that drives ONE turn's frames into
# the resumable event_store. The recorder is deliberately decoupled from any
# browser: the gateway agent keeps working (and we keep recording) even after
# the reader that started the turn refreshes, switches threads, or closes the
# tab. Every reader — the original POST, a thread-switch return, a post-reload
# resume — is just a tail of event_store, so a dropped reader can never stop a
# turn or lose the work done while away.
_TURN_TASKS: dict[str, asyncio.Task] = {}


def _start_turn_recorder(session_key: str, source_factory):
    """Thin binding to chat_turn.start_turn_recorder against THIS app's shared
    _TURN_TASKS registry — the one the lifespan reaper, the busy guard, and the
    resume/stop routes (and followup.py) all read. Kept on the app module so
    those callers and their tests keep resolving app._start_turn_recorder /
    app._TURN_TASKS unchanged after the engine moved to chat_turn.py."""
    return chat_turn.start_turn_recorder(session_key, source_factory,
                                         turn_tasks=_TURN_TASKS)


def _disk_free_gb(path) -> float | None:
    """Free space (GB, 1 decimal) on the filesystem holding `path`, or None if
    it can't be read (including a not-yet-created path — a fresh install's
    `.data` dir reads as None until first write, which is honest). Best-effort
    decoration only: /api/health's whole point is to answer 200 whenever the
    process is alive, so a disk-usage read must never itself turn into the 500
    it's supposed to help diagnose. Deliberately read-only — a liveness probe
    polled every 5 min must NOT mkdir its way past a missing dir (that would
    silently recreate intentionally-cleaned dirs, e.g. under the quota-tight
    /tmp on this host)."""
    try:
        usage = shutil.disk_usage(Path(path))
        return round(usage.free / (1024 ** 3), 1)
    except OSError:
        _log.warning("disk usage check failed for %s", path, exc_info=True)
        return None


@app.get("/api/health")
async def health():
    """Liveness probe for the doctor-alert timer (polled every 5 min — see
    deploy/systemd/bin/openclaw-doctor-alert): it only checks for HTTP 200, so
    this must never do gateway I/O or raise — every field below is either
    static config or a cached/no-IO read. Gateway *connectivity* is a separate
    concern, answered by /api/gateway/status (which this endpoint deliberately
    does not duplicate the async health-RPC of).

    `gateway` used to be the static gateway_ws_url() — always the same string,
    so it told you nothing about health. It's now monitor.current_state()
    (ok|restarting|down), the same source /api/gateway/status reads, via the
    synchronous no-IO accessor (not `monitor.status()`, which does a live RPC
    when state is "ok" — exactly the gateway I/O this endpoint must avoid).
    Key/type are unchanged (still a `str`); only the value's meaning changed,
    and nothing in this repo or the doctor-alert script reads it as a URL."""
    return {
        "ok": True,
        "gateway": monitor.current_state(),
        "session": config.session_key(),
        "has_password": bool(config.gateway_password()),
        "disk_free_gb": _disk_free_gb(config.DATA_DIR),
        "tmp_free_gb": _disk_free_gb(os.environ.get("TMPDIR") or "/tmp"),
        "schema": 1,
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
        # AGPL-3.0 §13: the SPA renders a "Source" link to this URL.
        "source_url": config.source_url(),
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


# --- Frontend global error boundary sink ------------------------------------
# error-boundary.js's window.onerror/unhandledrejection handler POSTs here,
# fire-and-forget (the client ignores the response entirely — see app.js's
# `.catch(() => {})`). This is telemetry, not a control-plane endpoint, so it
# is deliberately as forgiving as possible: garbage input never raises past
# this handler, and it's never a source of write amplification against the
# real log stream.
_client_log = logging.getLogger("client")

_CLIENT_LOG_MSG_MAX = 500
_CLIENT_LOG_SRC_MAX = 500
_CLIENT_LOG_STACK_MAX = 4000

# Process-wide (not per-client — this is a single-operator deployment), plain
# in-memory list of the unix timestamps of accepted posts in the trailing
# hour. Pruned lazily on every call so it can never grow past the cap.
_CLIENT_LOG_RATE_LIMIT = 60
_CLIENT_LOG_RATE_WINDOW_S = 3600.0
_CLIENT_LOG_TIMESTAMPS: list[float] = []


def _client_log_rate_ok() -> bool:
    """True (and records the hit) iff under 60 posts in the trailing hour."""
    now = time.time()
    cutoff = now - _CLIENT_LOG_RATE_WINDOW_S
    while _CLIENT_LOG_TIMESTAMPS and _CLIENT_LOG_TIMESTAMPS[0] < cutoff:
        _CLIENT_LOG_TIMESTAMPS.pop(0)
    if len(_CLIENT_LOG_TIMESTAMPS) >= _CLIENT_LOG_RATE_LIMIT:
        return False
    _CLIENT_LOG_TIMESTAMPS.append(now)
    return True


@app.post("/api/client-log", status_code=204)
async def client_log(request: Request):
    """Sink for the redesign's global error boundary: {msg, src, stack} for
    one uncaught client error/rejection, logged at WARNING under logger
    "client" and truncated (msg/src 500 chars, stack 4000) so one giant stack
    trace can't blow up the log file. Always 204, even when the entry is
    dropped (rate-capped or unparseable) — the frontend never reads the body
    and mustn't be given a reason to retry a telemetry POST.

    Malformed input never 500s: request.json() failures, a non-dict payload,
    and non-string fields all degrade to empty values rather than raising.
    Explicit design choice (brief left it open): malformed JSON is a SILENT
    204 DROP, not a 400 — this is fire-and-forget telemetry from a boundary
    that must never cause user-visible friction, so there is no reason to
    hand the client an error to react to.
    """
    if not _client_log_rate_ok():
        return Response(status_code=204)  # over the cap — silently drop

    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001 - garbage body -> treat as empty, never 500
        payload = None
    if not isinstance(payload, dict):
        payload = {}

    def _field(key: str, limit: int) -> str:
        val = payload.get(key)
        return str(val)[:limit] if val is not None else ""

    msg = _field("msg", _CLIENT_LOG_MSG_MAX)
    src = _field("src", _CLIENT_LOG_SRC_MAX)
    stack = _field("stack", _CLIENT_LOG_STACK_MAX)
    _client_log.warning("client error: %s (%s)%s", msg, src or "unknown", f"\n{stack}" if stack else "")
    return Response(status_code=204)


# --- The one real, load-bearing endpoint: chat ------------------------------


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

    # One turn per session at a time. The detached recorder already guards
    # against a second concurrent turn for this sessionKey, so if we proceeded
    # here the new message's drive_turn would never run — the gateway would
    # never see it and this POST would silently tail the PREVIOUS turn as if it
    # were the answer. Tell the client instead (a fresh chat and a second unsaved
    # chat both share config.web_session_key(), so this also covers double-send).
    prev_turn = _TURN_TASKS.get(session_key)
    if prev_turn is not None and not prev_turn.done():
        return StreamingResponse(chat_turn.busy_stream(),
                                 media_type="text/event-stream")

    # OPEN shelf (spec 4.1/5): a user send puts the thread on the shelf. Done
    # after the busy check so a rejected double-send does not stamp it. An
    # attachment-only send (blank message, an image/file attached) is a real
    # send too -- mirror the message-or-attachments check the client uses to
    # decide there's anything to send at all, so such a thread doesn't drop
    # off the shelf on the next refetch. Never let a store write failure
    # break the turn (same swallow convention as chat_turn.py's other
    # sessions_store.update touches).
    if rec and (message.strip() or attachments):
        try:
            sessions_store.mark_opened(rec["id"])
        except Exception:  # noqa: BLE001 - never break the turn over the shelf stamp
            _log.warning("sessions_store.update (mark_opened) failed for session %s",
                         rec["id"], exc_info=True)

    run_info: dict = {}  # bridge fills sessionKey/runId once chat.send acks
    # Off the event loop: image conversion (ffmpeg, up to a 30s timeout) and
    # office/PDF text extraction (openpyxl/pypdf/python-docx/python-pptx) are
    # blocking calls that would otherwise stall every concurrent SSE stream
    # for the duration of one file-heavy message. Same pattern as
    # notes.py/_load_all and documents.py/_scan_docs. These to_thread call
    # sites stay in the route (Task 12); the engine consumes the resolved lists.
    chat_attachments = await asyncio.to_thread(_resolve_attachments, attachments)  # image uploads → vision
    # Non-image uploads (CSV, XLSX, DOCX, PPTX, PDF, text): extract and inline
    # into the message so they reach the model (the gateway drops non-image
    # bytes). Skipped files are surfaced as a system note so the assistant can
    # tell the user which files were dropped.
    text_files, skipped_files = await asyncio.to_thread(_extract_text_attachments, attachments)
    if text_files or skipped_files:
        message = _prepend_text_attachments(message, text_files, skipped_files)
    # @mention expansion (Pillar C1): any @[Title](note|doc:id) token the
    # composer's mention picker inserted gets its note/document body prepended
    # as a citation-friendly context block. A no-op when there are no tokens.
    # Runs synchronously (single small vault-file reads, at most 8 of them,
    # matching the existing GET /api/document/{id} route's own unthreaded
    # read): never awaits, never blocks the event loop for long enough to
    # matter at this scale.
    # What the user actually typed (plus any inlined text attachments, which
    # /api/history displays unstripped): the value that must drive anything
    # user-facing, since the injected context blocks below are stripped back
    # out for display. Attachment rehydration matches on the stored text and
    # titles are cut from the first line, so both use this, not the wrapped
    # message the brain sees.
    display_text = message
    message, _ = mentions.prepend_mentions(message)
    # Scrub credential-shaped strings before persisting to disk. The model
    # still receives the original `message` for this turn so Gary can act on
    # a pasted credential; a system note is injected to suggest a better path.
    scrubbed_message, _scrubbed_kinds = _scrub_secrets(message)
    if _scrubbed_kinds:
        message = message + "\n\n" + _scrub_note(_scrubbed_kinds)

    # Persist the image refs (keyed by the SPA session id) so they survive a
    # reload — the gateway transcript only keeps the user's text.
    if session and attachments:
        _persist_msg_attachments(session, _scrub_secrets(display_text)[0], attachments)

    # Draft mode: chat.js posts active_doc_id whenever the document panel is
    # open (auto-saving the doc first). Snapshot now (the user's undo), wrap
    # the message in gen(), detect agent edits after the turn (draft_mode.py).
    draft_doc = draft_mode.pre_turn(active_doc_id) if active_doc_id else None

    title_task = None
    if rec and message.strip() and _needs_title(rec):
        snippet = _first_chars_title(display_text)
        if snippet:  # instant fallback so the title is never the timestamp
            sessions_store.update(rec["id"], name=snippet)
        title_task = asyncio.create_task(_generate_ai_title(display_text))

    # The turn's source of truth (web search → gateway relay → late reply →
    # metrics → draft doc_update → DONE) lives in chat_turn.drive_turn. Pass the
    # shared _ACTIVE_RUNS registry and the app-module hooks (_spawn,
    # maybe_auto_extract, _log_turn_timing) explicitly so nothing imports app
    # back and every monkeypatch seam on those names keeps taking effect. Look
    # them up here (route runs after any test patch) so the patched values flow.
    # session/compose carry the msg-branch-edit feature: drive_turn splices the
    # pending branch preamble in (before web-search context-building, Task 4) via
    # _compose_outgoing_for_session, kept as a passed hook like the others.
    def _source():
        return chat_turn.drive_turn(
            message=message, use_web=use_web, allow_web_search=allow_web_search,
            draft_doc=draft_doc, rec=rec, session_key=session_key,
            run_info=run_info, chat_attachments=chat_attachments,
            title_task=title_task, active_runs=_ACTIVE_RUNS, spawn=_spawn,
            auto_extract=maybe_auto_extract, log_turn_timing=_log_turn_timing,
            session=session, compose=_compose_outgoing_for_session)

    # Detach the turn from any single reader: a background recorder drains the
    # gateway relay into event_store and owns the turn boundary (begin/end_turn),
    # so a dropped POST reader (refresh / thread-switch / tab close) can never
    # stop or lose the run. The POST response then just TAILS event_store —
    # identical to GET /api/chat/stream — so the original POST, a thread-switch
    # return, and a post-reload resume are all the same replay-then-subscribe.
    cursor = event_store.latest_id(session_key)  # replay only THIS turn, not prior
    queue = event_store.subscribe(session_key)   # subscribe before start: no gap
    _start_turn_recorder(session_key, _source)

    return StreamingResponse(
        chat_turn.post_tail(session_key=session_key, cursor=cursor, queue=queue),
        media_type="text/event-stream")


# --- Session persistence: metadata here, message content from the brain ------

@app.get("/api/sessions")
async def sessions():
    return sessions_store.list_sessions()


def _catalog_owners(catalog: dict) -> tuple[dict[str, set[str]], dict[str, dict]]:
    owners: dict[str, set[str]] = {}
    endpoints: dict[str, dict] = {}
    for it in catalog.get("items") or []:
        eid = it.get("endpoint_id") or ""
        if not eid:
            continue
        endpoints[eid] = it
        for mid in (it.get("models") or []) + (it.get("models_extra") or []):
            owners.setdefault(mid, set()).add(eid)
    return owners, endpoints


def _first_online_model(catalog: dict) -> tuple[str, str] | None:
    items = [it for it in catalog.get("items") or [] if isinstance(it, dict)]
    rank = {"openai": 0, "google": 1, "perplexity-web": 2}
    items.sort(key=lambda it: rank.get((it.get("endpoint_id") or "").strip(), 99))
    model_rank = {
        "gpt-5.5": 0,
        "gpt-5.4-mini": 1,
        "gpt-5.4": 2,
        "gemini-3-flash-preview": 3,
        "perplexity-auto": 4,
    }
    for it in items:
        if it.get("offline"):
            continue
        eid = (it.get("endpoint_id") or "").strip()
        models = it.get("models") or []
        if eid and models:
            model = sorted(models, key=lambda mid: model_rank.get(mid, 99))[0]
            return eid, model
    return None


def _catalog_model_error(catalog: dict, endpoint_id: str | None,
                         model: str | None) -> str | None:
    model = (model or "").strip()
    ep = (endpoint_id or "").strip()
    if not model or not ep or "openclaw" in (model, ep):
        return None
    owners, endpoints = _catalog_owners(catalog)
    if ep in endpoints and endpoints[ep].get("offline"):
        return f"endpoint {ep!r} is offline or needs authentication"
    if ep in endpoints and model in owners and ep not in owners[model]:
        return (f"model {model!r} is not available on endpoint {ep!r} "
                f"(offered by: {', '.join(sorted(owners[model]))})")
    return None


async def _model_pair_error(endpoint_id: str | None, model: str | None) -> str | None:
    """Reject DEFINITE cross-pairs only: a model the catalog lists under a
    different endpoint than the one given (claude-cli + gpt-5.5 → the gateway
    bounces every turn with "model not allowed"). Everything uncertain fails
    open — unknown models ([1m]-style catalog drift), endpoints hidden from
    the catalog (anthropic), the openclaw placeholder, catalog outages — so
    an odd-but-working ref is never blocked by a stale or unreachable list."""
    model = (model or "").strip()
    ep = (endpoint_id or "").strip()
    if not model or not ep or "openclaw" in (model, ep):
        return None
    try:
        return _catalog_model_error(await bridge.fetch_models(), ep, model)
    except Exception:  # noqa: BLE001 - gateway down → can't judge, allow
        return None


@app.post("/api/session")
async def create_session(name: str = Form(default=""), model: str = Form(default=""),
                         endpoint_url: str = Form(default=""),
                         endpoint_id: str = Form(default=""),
                         speed: str = Form(default="")):
    if model or endpoint_id:
        err = await _model_pair_error(endpoint_id, model)
        if err:
            return JSONResponse(status_code=400, content={"detail": err})
    return sessions_store.create(name=name or None, model=model or None,
                                 endpoint_url=endpoint_url or None,
                                 endpoint_id=endpoint_id or None,
                                 speed=speed or None)


async def _compose_outgoing_for_session(session_id: str, user_text: str) -> str:
    """Consume any pending branch-context for this session and prepend its
    preamble to the outgoing text. Idempotent per session: `consume` deletes
    the pending record on read, so only the FIRST call after a branch prepends
    the preamble — every subsequent call for the same session_id returns
    user_text unchanged."""
    ctx = branch_context.consume(session_id)
    if not ctx:
        return user_text
    preamble = ctx.get("preamble") or ""
    return f"{preamble}\n\nFrank: {user_text}" if preamble else user_text


def _build_preamble(prefix: list[dict]) -> str:
    """Compact serialization of the branched-from transcript prefix, used as
    the first-send context preamble. Role + text, one per line."""
    lines = []
    for m in prefix:
        role = (m.get("role") or "user").strip()
        text = (m.get("text") or m.get("content") or "").strip()
        if not text:
            continue
        who = "Frank" if role == "user" else "Gary"
        lines.append(f"{who}: {text}")
    body = "\n".join(lines)
    return (
        "For context, this conversation was branched from an earlier thread. "
        "Here is what was said before, verbatim:\n\n"
        f"{body}\n\n"
        "Continue from here."
    )


@app.post("/api/session/branch")
async def branch_session(payload: dict = Body(default=None)):
    """Create a new session and stash a client-provided transcript prefix as
    pending context. The frontend already knows the prefix (it rendered those
    bubbles); we trust its slice verbatim and echo it back — no
    bridge.fetch_history call, no server-side re-slicing (see
    .superpowers/sdd/task-3-brief.md). The next composer submit into this
    session consumes the pending context and prepends a preamble."""
    payload = payload or {}
    source_session_id = str(payload.get("source_session_id") or "").strip()
    prefix = payload.get("prefix") or []
    if not source_session_id:
        return JSONResponse(status_code=400, content={"error": "source_session_id required"})
    if not prefix:
        return JSONResponse(status_code=400, content={"error": "prefix must not be empty"})

    src = sessions_store.get(source_session_id)
    if src is None:
        return JSONResponse(status_code=404, content={"error": "source session not found"})

    name = (payload.get("name") or "").strip() or f"↳ {src.get('name') or 'chat'}"
    new_sess = sessions_store.create(
        name=name,
        model=payload.get("model") or src.get("model"),
        endpoint_url=src.get("endpoint_url"),
        endpoint_id=src.get("endpoint_id"),
        speed=payload.get("speed") or src.get("speed"),
    )
    # Fork bookkeeping (spec 5): remember the parent, inherit its project, and
    # put the new thread on the OPEN shelf so it is where the user lands next.
    sessions_store.update(new_sess["id"], parent_id=source_session_id,
                          folder=src.get("folder"))
    sessions_store.mark_opened(new_sess["id"])
    preamble = _build_preamble(prefix)
    branch_context.write(new_sess["id"], source_session_id, prefix, preamble)
    return {"session_id": new_sess["id"], "session_key": new_sess["sessionKey"], "prefix": prefix}


@app.get("/api/history/{session_id}")
async def history(session_id: str, limit: int = 200, cursor: str | None = None):
    """The session's saved transcript, read live from the brain. Paginated:
    the no-cursor call returns the newest `limit` messages; the frontend lazy-
    loads older windows by passing the returned `nextCursor` (see bridge
    fetch_history_page). Older pages are fetched on scroll-to-top, so no single
    response has to carry the whole transcript."""
    sess = sessions_store.get(session_id)
    if not sess:
        return {"history": [], "model": None, "hasMore": False, "nextCursor": None}
    if cursor:
        # Older pages: only the gateway's HTTP history endpoint supports
        # older-than-cursor paging.
        data = await bridge.fetch_history_page(sess["sessionKey"], limit=limit,
                                               cursor=cursor)
    else:
        # First page: the gateway's HTTP history endpoint truncates some sessions
        # — a claude-cli turn can come back as a single message, dropping Gary's
        # replies on reload. The WS chat.history returns the full transcript
        # reliably for every provider, so read the newest window from it.
        # (Tail-only: a transcript longer than the window won't lazy-load older
        # pages — an acceptable trade vs. silently losing the assistant's replies.)
        # Floor at 1000 so a reload gets the full window (not a truncated tail);
        # cap at 1000 because chat.history returns EMPTY for limits above ~1000
        # (a blank thread), so limit>1000 must not pass through.
        mapped = await bridge.fetch_history(sess["sessionKey"],
                                            limit=min(max(limit, 1000), 1000))
        data = {"history": mapped.get("history", []),
                "model": mapped.get("model"),
                "hasMore": False, "nextCursor": None}
    # use_web turns store the augmented brain message (search block + the
    # user's text) in the transcript; show only what the user typed.
    for m in data.get("history", []):
        if m.get("role") == "user":
            # One shared strip chain (backend/history_display.py) covering
            # every injected wrap layer in drive_turn's real outer-to-inner
            # order; chat_search._extract_chunks calls the same helper so the
            # displayed text and the indexed text can never drift apart.
            content = history_display.history_display_text(m.get("content"))
            # A followup seed or an injected continuation seed is machinery, not
            # something Frank typed — show the compact ⚙️ card line instead
            # (frontend styles any ⚙️-prefixed user message as a system pill).
            card = followup.history_card(content) or syschatter.history_card(content)
            m["content"] = card if card is not None else content
    # The terminal-attach flow records the prompt twice (the two messages differ
    # only in the stripped terminal-control note), so after stripping they're
    # identical — collapse a user message that duplicates the one just before it.
    deduped = []
    for m in data.get("history", []):
        if (m.get("role") == "user" and deduped
                and deduped[-1].get("role") == "user"
                and deduped[-1].get("content") == m.get("content")):
            continue
        deduped.append(m)
    data["history"] = deduped
    # Rehydrate image attachments persisted at send time (transcript is text-only).
    _apply_msg_attachments(session_id, deduped)
    # Prefer the record's chosen model label; fall back to whatever the brain used.
    data["model"] = sess.get("model") or data.get("model")
    # Answered AskUserQuestion cards for this session, so the frontend can
    # replay them locked with the chosen answer (chat.js fetchThread).
    data["question_answers"] = _qc_answers_for(session_id)
    return data


@app.post("/api/question-answer")
async def question_answer(payload: dict = Body(default=None)):
    """Record which choice a tappable AskUserQuestion card was answered with,
    so reload/replay can lock it (see backend/question_cards.py)."""
    payload = payload or {}
    session_id = (payload.get("session") or "").strip()
    tool_id = (payload.get("tool_id") or "").strip()
    if not session_id or not tool_id:
        return JSONResponse(status_code=400, content={"error": "session and tool_id required"})
    _qc_record_answer(session_id, tool_id, payload.get("choice"))
    return {"ok": True}


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
    # The comprehension above keeps "" because it is not None; normalize a
    # whitespace-only folder to None here. Unfiling itself is a dedicated
    # route (POST /api/session/{id}/unfile, spec 5) -- FastAPI drops
    # empty-string form values before the handler runs, so folder="" can
    # never actually reach here as a signal to unfile.
    if folder is not None:
        fields["folder"] = folder.strip() or None
    # Guard the RESULTING (endpoint, model) pair, not just the sent fields: a
    # partial PATCH (model alone / endpoint alone) inheriting the record's
    # other half is exactly how cross-paired refs like claude-cli/gpt-5.5 got
    # written — see _model_pair_error.
    if "model" in fields or "endpoint_id" in fields:
        rec = sessions_store.get(session_id)
        if rec is None:
            return JSONResponse(status_code=404, content={"detail": "no such session"})
        err = await _model_pair_error(
            fields.get("endpoint_id", rec.get("endpoint_id")),
            fields.get("model", rec.get("model")))
        if err:
            return JSONResponse(status_code=400, content={"detail": err})
    # spec 4.2 amendment: filing is bookkeeping, not activity -- a PATCH that
    # ONLY moves the session between projects must not bump `updated` (same
    # rationale as unfile_project/close_opened). A PATCH that also touches
    # any other field keeps the normal touch=True behavior.
    touch = set(fields.keys()) != {"folder"}
    return sessions_store.update(session_id, touch=touch, **fields) or JSONResponse(
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
        event_store.drop_session(rec["sessionKey"])  # free the in-memory event log
        turn_state.drop_session(rec["sessionKey"])  # no stale interrupted/inflight residue
        promise_guard.drop_session(rec["sessionKey"])  # forget persisted warnings
        _spawn(_delete_gateway_session(rec["sessionKey"]))
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


@app.post("/api/session/{session_id}/close")
async def close_session(session_id: str):
    """Take a thread off the OPEN shelf (spec 7.2). The thread itself is
    untouched; it simply stops being in the working set until the next send."""
    rec = sessions_store.close_opened(session_id)
    if rec is None:
        return JSONResponse(status_code=404, content={"detail": "no such session"})
    return {"ok": True}


@app.post("/api/session/{session_id}/unfile")
async def unfile_session(session_id: str):
    """Clear a session's project folder (spec 5). A dedicated route because
    PATCH can't carry folder="" through as an unfile signal: FastAPI drops
    empty-string form values before the handler runs. touch=False matches
    unfile_project (bulk unfile on project delete) -- unfiling is
    bookkeeping, not activity, and must not bump `updated`."""
    rec = sessions_store.update(session_id, folder=None, touch=False)
    if rec is None:
        return JSONResponse(status_code=404, content={"detail": "no such session"})
    return rec


@app.get("/api/sessions/{session_id}/usage")
async def session_usage(session_id: str):
    """Per-session token usage + context-window weight for the footer widget.
    Thin relay over bridge.fetch_session_usage (which talks to the gateway's
    sessions.usage RPC and projects the result to the wire contract). Always
    200: on any gateway error / unknown session the body is {ok: false, reason}
    and the widget hides itself — never 500 the page."""
    return await bridge.fetch_session_usage(session_id)


# NOTE: the real resume/tail endpoints live in resume_route.py
# (/api/chat/events/resume, /api/chat/turn, /api/chat/stream). The old
# /api/chat/resume/{id} and /api/chat/stream_status/{id} stubs were dead — their
# only caller was the legacy js/sessions.js UI, which index.html no longer loads
# (the redesign app.js fully replaced it). Both stubs are removed; live run state
# is served by event_store.current_turn() via /api/chat/turn and the per-session
# working state by /api/chat/active_sessions.


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


@app.post("/api/chat/steer/{session_id}")
async def steer_chat(session_id: str, message: str = Form(...),
                     client_id: str = Form(default="")):
    """Inject a message into this chat's RUNNING turn (real steering, no
    abort). Gates, in order: a turn must be active for the session (else the
    client just sends normally), the gateway must carry the claude-cli steer
    patch and the session must run on claude-cli (else the client queues as
    before, so nothing is ever absorbed into a follow-up run the bridge is not
    relaying). On success a `user_steer` frame is appended to the event store
    so every reader of this turn (the sender, other tabs, a post-reload
    resume) shows the message at the point it was sent."""
    # NUL bytes would poison the stream-json line the gateway patch writes into
    # the CLI's stdin; strip them BEFORE the empty check so a NUL-only body is
    # rejected as empty rather than "steered".
    text = (message or "").replace("\x00", "").strip()
    if not text:
        return JSONResponse(status_code=400, content={"ok": False, "reason": "empty_message"})
    # client_id is echoed verbatim into an SSE frame every open tab parses, so
    # keep it to the shape our own uniqId() mints: at most 64 chars of
    # [A-Za-z0-9_-], anything else dropped (empty string if nothing remains).
    client_id = "".join(
        c for c in (client_id or "")
        if c.isascii() and (c.isalnum() or c in "_-")
    )[:64]
    rec = sessions_store.get(session_id)
    session_key = rec["sessionKey"] if rec else config.web_session_key()
    task = _TURN_TASKS.get(session_key)
    if task is None or task.done():
        return JSONResponse(status_code=409, content={"ok": False, "reason": "no_active_turn"})
    if not steer.session_can_steer(rec):
        return JSONResponse(status_code=409, content={
            "ok": False, "reason": "steer_unavailable",
            "detail": "steering needs a claude-cli session"})
    if not steer.patch_present():
        return JSONResponse(status_code=409, content={
            "ok": False, "reason": "steer_unavailable",
            "detail": "gateway steer patch not installed"})
    try:
        ack = await bridge.steer_turn(session_key, text)
    except Exception as exc:  # noqa: BLE001 - surface the gateway failure honestly
        return JSONResponse(status_code=502, content={
            "ok": False, "reason": "gateway_error", "detail": f"{exc!r}"})
    # OPEN shelf (spec 5): a steer is a user send too, same as chat_stream's
    # own mark_opened touch. Never let a store write failure break a steer
    # that already landed on the gateway.
    if rec:
        try:
            sessions_store.mark_opened(rec["id"])
        except Exception:  # noqa: BLE001 - never break the steer over the shelf stamp
            _log.warning("sessions_store.update (mark_opened) failed for session %s",
                         rec["id"], exc_info=True)
    event_store.append(session_key, bridge._sse({
        "type": "user_steer", "text": text, "client_id": client_id or "",
        "ts": int(time.time() * 1000)}))
    return {"ok": True, "steered": True, "runId": (ack or {}).get("runId")}


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
    # A user-set preference (POST /api/default-chat → .data/settings.json) wins;
    # otherwise we land on the primary agent's configured model from openclaw.json.
    pref = (websearch.load_settings().get("default_chat_model") or {})
    if pref.get("model"):
        provider = pref.get("endpoint_id") or config.default_model()[0]
        model = pref["model"]
    else:
        provider, model = config.default_model()
    try:
        catalog = await bridge.fetch_models()
        if _catalog_model_error(catalog, provider, model):
            fallback = _first_online_model(catalog)
            if fallback:
                provider, model = fallback
    except Exception:  # noqa: BLE001 - gateway/catalog trouble → preserve old path
        pass
    return {"endpoint_id": provider, "endpoint_url": config.gateway_ws_url(),
            "model": model}


@app.post("/api/default-chat")
async def set_default_chat(payload: dict = Body(default=None)):
    """Persist the user's preferred default model for NEW web chats. Stored in
    .data/settings.json (workspace-owned) — does NOT touch the gateway's
    openclaw.json. Per-chat overrides still go through PATCH /api/session."""
    payload = payload or {}
    model = (payload.get("model") or "").strip()
    if not model:
        return JSONResponse(status_code=400, content={"error": "model required"})
    pref = {"model": model, "endpoint_id": (payload.get("endpoint_id") or "").strip()}
    err = await _model_pair_error(pref["endpoint_id"], pref["model"])
    if err:
        return JSONResponse(status_code=400, content={"detail": err})
    websearch.save_settings({"default_chat_model": pref})
    return {"ok": True, **pref}


# --- Web push notifications (app-icon badge, push on followup completion) ----

@app.get("/api/push/status")
async def push_status():
    """Report push capability and current unseen count. Browser checks this
    before subscribing; badge UI reads the count."""
    return {
        "supported": push.supported(),
        "publicKey": push.public_key(),
        "subscriptions": push.subscription_count(),
        "unseen": push.unseen_count(),
    }


@app.post("/api/push/subscribe")
async def push_subscribe(payload: dict = Body(default=None)):
    """Store a browser PushSubscription. Body = browser's PushSubscription.toJSON()
    (must include `endpoint` and `keys`)."""
    payload = payload or {}
    if not payload.get("endpoint") or not payload.get("keys"):
        return JSONResponse(status_code=400,
                           content={"error": "endpoint and keys required"})
    push.add_subscription(payload)
    return {"ok": True}


@app.post("/api/push/unsubscribe")
async def push_unsubscribe(payload: dict = Body(default=None)):
    """Unsubscribe a browser by endpoint."""
    payload = payload or {}
    endpoint = (payload.get("endpoint") or "").strip()
    if not endpoint:
        return JSONResponse(status_code=400, content={"error": "endpoint required"})
    push.remove_subscription(endpoint)
    return {"ok": True}


@app.post("/api/push/ack")
async def push_ack(payload: dict = Body(default=None)):
    """Acknowledge unseen followups for a session (or all if all=true).
    Returns the new unseen count."""
    payload = payload or {}
    if payload.get("all"):
        unseen = push.ack_all()
    else:
        session_id = (payload.get("session_id") or "").strip()
        if not session_id:
            return JSONResponse(status_code=400, content={"error": "session_id or all required"})
        unseen = push.ack_session(session_id)
    return {"unseen": unseen}


# Auth stubs: single-user/no-auth deployment behind Tailscale. Return a logged-in
# admin so the SPA never redirects to /login. Privileges double as feature flags:
# False hides that feature's chrome (init.js/app.js read these), so anything
# with no backend here is flipped off rather than advertised as working.
@app.get("/api/auth/status")
async def auth_status():
    return {
        "authenticated": True, "is_admin": True,
        "username": config.workspace_user(),
        "privileges": {
            "can_use_agent": True, "can_use_bash": True, "can_use_documents": True,
            "can_use_research": True,
            # No image-gen backend (hides #tool-image-btn; Gallery is CSS-hidden).
            "can_generate_images": False,
        },
    }


@app.get("/api/auth/features")
async def auth_features():
    return {"auth_required": bool(config.auth_token()), "features": {}}


@app.get("/api/auth/settings")
async def auth_settings():
    """Settings the SPA reads (search provider/result count etc.). Persisted
    in .data/settings.json; search execution lives in websearch.py."""
    return websearch.load_settings()


@app.post("/api/auth/settings")
async def save_auth_settings(payload: dict = Body(default=None)):
    return websearch.save_settings(payload or {})


@app.post("/api/search/test")
async def search_test(payload: dict = Body(default=None)):
    """One-shot probe of the configured web-search provider so Settings → Search
    can show a live OK/error. Runs a real query via websearch.py."""
    query = ((payload or {}).get("query") or "OpenClaw connectivity test").strip()
    try:
        results = await websearch.search(query, count=3)
        return {"ok": True, "count": len(results or []),
                "provider": websearch.load_settings().get("search_provider")}
    except Exception as exc:  # noqa: BLE001 — surface any provider/network error
        return {"ok": False, "error": f"{exc!r}"}


# --- Semantic search over all chat content -----------------------------------
# Real embedding-based search (local kamino nomic-embed-text) over every session's
# message content. Explicit routes — registered before the /api/{path} catch-all
# below and preferred by FastAPI, so they aren't shadowed by it.
@app.get("/api/search")
async def search_chats(q: str = "", limit: int = 20):
    return await chat_search.search(q, limit)


@app.post("/api/search/reindex")
async def search_reindex(force: bool = False):
    """Kick a background reindex and return immediately (a full run makes many
    gateway + Voyage calls, so it must not block the request)."""
    _spawn(chat_search.reindex(force=force))
    return {"status": "started"}


# --- Legacy GET stubs: the last callers of the old []-catch-all ---------------
# Task 19 replaced the blanket `GET /api/{path} -> []` (which silently satisfied
# every unimplemented poll) with a real 404. A frontend GET-path inventory
# (redesign live layer + the retired classic UI at /classic) found a handful of
# GETs with no backend route that were leaning on that []-return. They are kept
# here as explicit no-op stubs — byte-identical [] response, plus a one-line
# deprecation WARNING so the dead calls are finally visible in the log — rather
# than silently 404'd, so a still-served UI can't regress (the classic archived-
# sessions fetch throws on a non-2xx; the redesign Settings→Export downloads the
# body). See the Task 19 report (.superpowers/sdd) for the full path table.
# Registered BEFORE the 404 catch-all so these specific paths still win. Remove a
# stub once its caller is gone.
#   classic (/classic only): fonts/custom, signatures, contacts/search,
#     sessions/archived, chat/stream_status/{id}, model-endpoints/probe-local,
#     document/{id}/export-pdf, document/{id}/render-pages,
# (redesign (live) /api/export — Settings → Data Backup → Export — is now a
# real route; see export_route.py.)
@app.get("/api/fonts/custom")
@app.get("/api/signatures")
@app.get("/api/contacts/search")
@app.get("/api/sessions/archived")
@app.get("/api/model-endpoints/probe-local")
@app.get("/api/chat/stream_status/{session_id}")
@app.get("/api/document/{doc_id}/export-pdf")
@app.get("/api/document/{doc_id}/render-pages")
async def _legacy_get_stub(request: Request):
    _log.warning("legacy GET %s served as [] stub (deprecated; no backend route "
                 "— caller should be removed)", request.url.path)
    return []


# --- 404 for every other unimplemented /api GET ------------------------------
# Was a blanket `-> []` (quieted a 404 flood for tabs the vendor SPA polled but
# v1 never implemented). That masked real routing bugs and every retired caller.
# The live redesign now has an explicit route for every GET it makes (verified in
# Task 19); anything still hitting this is a stale caller or a typo, so answer an
# honest 404 and log it once so it's findable.
@app.get("/api/{path:path}")
async def _unimplemented_api(path: str):
    _log.warning("unimplemented GET /api/%s -> 404 (no route)", path)
    return JSONResponse(status_code=404,
                        content={"error": "not found", "path": f"/api/{path}"})


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

def _spa_html(filename: str):
    """Serve an SPA HTML entrypoint.

    When config.BASE_PATH is set (app hosted under a stripping subpath proxy),
    rewrite browser-facing URLs so absolute /static and /api references resolve
    under the prefix: markup asset refs are rewritten, an import map remaps
    absolute dynamic imports, and a tiny network shim prefixes fetch/EventSource/
    WebSocket calls. Backend routes are untouched (the proxy strips the prefix).
    With no BASE_PATH the raw file is served byte-for-byte (default install)."""
    path = config.FRONTEND_DIR / filename
    if not path.exists():
        return JSONResponse(status_code=404, content={"error": f"{filename} not built"})
    base = config.BASE_PATH
    if not base:
        return FileResponse(str(path))
    html = path.read_text(encoding="utf-8")
    html = html.replace('="/static/', f'="{base}/static/').replace('="/api/', f'="{base}/api/')
    b = json.dumps(base)
    inject = (
        '<script type="importmap">{"imports":{"/static/":"' + base + '/static/"}}</script>'
        '<script>(function(){var B=' + b + ';'
        'window.__WS_BASE__=B;'  # asset constants (e.g. AVATAR) prefix with this
        'function fix(u){try{'
        'if(u&&typeof u==="object"&&typeof Request!=="undefined"&&u instanceof Request){return new Request(fix(u.url),u);}'
        'u=String(u);'
        'if(/^[a-z]+:\\/\\//i.test(u)){var x=new URL(u);'
        'if(x.host===location.host&&x.pathname.slice(0,B.length+1)!==B+"/"){x.pathname=B+x.pathname;}return x.toString();}'
        'if(u.slice(0,2)==="//")return u;'
        'if(u.charAt(0)==="/"&&u.slice(0,B.length+1)!==B+"/")return B+u;'
        'return u;}catch(e){return u;}}'
        'var f=window.fetch;if(f)window.fetch=function(i,n){return f(fix(i),n);};'
        'var E=window.EventSource;if(E){var NE=function(u,o){return new E(fix(u),o);};'
        'NE.prototype=E.prototype;try{NE.CONNECTING=E.CONNECTING;NE.OPEN=E.OPEN;NE.CLOSED=E.CLOSED;}catch(e){}window.EventSource=NE;}'
        'var W=window.WebSocket;if(W){var NW=function(u,p){return p===undefined?new W(fix(u)):new W(fix(u),p);};'
        'NW.prototype=W.prototype;try{NW.CONNECTING=W.CONNECTING;NW.OPEN=W.OPEN;NW.CLOSING=W.CLOSING;NW.CLOSED=W.CLOSED;}catch(e){}window.WebSocket=NW;}'
        # Attribute/property shim: img.src, link.href, a.href, source.src, iframe.src, script.src, video/audio.src assigned at runtime
        # skip fetch (already wrapped) but catch attribute sets that go straight to the network.
        'var ATTR={IMG:["src","srcset"],SOURCE:["src","srcset"],SCRIPT:["src"],LINK:["href"],A:["href"],IFRAME:["src"],VIDEO:["src","poster"],AUDIO:["src"],TRACK:["src"]};'
        'function fixSrcset(v){try{return String(v).split(",").map(function(p){var t=p.trim().split(/\\s+/);if(t[0])t[0]=fix(t[0]);return t.join(" ");}).join(", ");}catch(e){return v;}}'
        'var _setAttr=Element.prototype.setAttribute;'
        'Element.prototype.setAttribute=function(n,v){try{var tag=this.tagName,attrs=tag&&ATTR[tag];if(attrs&&attrs.indexOf(n)>=0&&typeof v==="string"){v=(n==="srcset")?fixSrcset(v):fix(v);}}catch(e){}return _setAttr.call(this,n,v);};'
        'var _setAttrNS=Element.prototype.setAttributeNS;'
        'Element.prototype.setAttributeNS=function(ns,n,v){try{var tag=this.tagName,attrs=tag&&ATTR[tag];if(attrs&&attrs.indexOf(n)>=0&&typeof v==="string"){v=(n==="srcset")?fixSrcset(v):fix(v);}}catch(e){}return _setAttrNS.call(this,ns,n,v);};'
        'function wrapProp(proto,prop,srcset){if(!proto)return;var d=Object.getOwnPropertyDescriptor(proto,prop);if(!d||!d.set)return;Object.defineProperty(proto,prop,{configurable:true,enumerable:d.enumerable,get:d.get,set:function(v){try{if(typeof v==="string")v=srcset?fixSrcset(v):fix(v);}catch(e){}d.set.call(this,v);}});}'
        'wrapProp(HTMLImageElement&&HTMLImageElement.prototype,"src",false);'
        'wrapProp(HTMLImageElement&&HTMLImageElement.prototype,"srcset",true);'
        'wrapProp(HTMLSourceElement&&HTMLSourceElement.prototype,"src",false);'
        'wrapProp(HTMLSourceElement&&HTMLSourceElement.prototype,"srcset",true);'
        'wrapProp(HTMLScriptElement&&HTMLScriptElement.prototype,"src",false);'
        'wrapProp(HTMLLinkElement&&HTMLLinkElement.prototype,"href",false);'
        'wrapProp(HTMLAnchorElement&&HTMLAnchorElement.prototype,"href",false);'
        'wrapProp(HTMLIFrameElement&&HTMLIFrameElement.prototype,"src",false);'
        'wrapProp(HTMLMediaElement&&HTMLMediaElement.prototype,"src",false);'
        'wrapProp(HTMLVideoElement&&HTMLVideoElement.prototype,"poster",false);'
        # sweep DOM for absolute /api or /static refs that landed via innerHTML/template strings
        'function sweep(root){try{if(!root||!root.querySelectorAll)return;var sel="img[src^=\\"/\\"],img[srcset],source[src^=\\"/\\"],source[srcset],script[src^=\\"/\\"],link[href^=\\"/\\"],a[href^=\\"/\\"],iframe[src^=\\"/\\"],video[src^=\\"/\\"],video[poster^=\\"/\\"],audio[src^=\\"/\\"],track[src^=\\"/\\"]";var ns=root.querySelectorAll(sel);for(var i=0;i<ns.length;i++){var el=ns[i],tag=el.tagName,attrs=ATTR[tag]||[];for(var j=0;j<attrs.length;j++){var a=attrs[j],cur=el.getAttribute(a);if(!cur)continue;var nv=(a==="srcset")?fixSrcset(cur):fix(cur);if(nv!==cur)_setAttr.call(el,a,nv);}}}catch(e){}}'
        'if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",function(){sweep(document);});}else{sweep(document);}'
        'try{var mo=new MutationObserver(function(muts){for(var i=0;i<muts.length;i++){var m=muts[i];if(m.type==="childList"){for(var j=0;j<m.addedNodes.length;j++){var n=m.addedNodes[j];if(n.nodeType===1){sweep(n);sweep(n.parentNode||document);}}}else if(m.type==="attributes"){sweep(m.target);}}});mo.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:["src","srcset","href","poster"]});}catch(e){}'
        '})();</script>'
    )
    html = html.replace("<head>", "<head>" + inject, 1)
    return HTMLResponse(html)


def _manifest_response(filename: str = "manifest.json"):
    """Serve the PWA manifest, base-path-corrected.

    Like _spa_html: when BASE_PATH is set, absolute /static icon srcs and the
    root start_url/scope must resolve under the prefix, or an installed PWA
    pulls icons from the origin root (the wrong tenant on a shared funnel) and
    launches at /. Served byte-for-byte when no BASE_PATH (default install)."""
    path = config.FRONTEND_DIR / filename
    if not path.exists():
        return JSONResponse(status_code=404, content={"error": f"{filename} not built"})
    base = config.BASE_PATH
    if not base:
        return FileResponse(str(path), media_type="application/manifest+json")
    data = json.loads(path.read_text(encoding="utf-8"))
    for icon in data.get("icons", []):
        src = icon.get("src", "")
        if isinstance(src, str) and src.startswith("/") and not src.startswith(base + "/"):
            icon["src"] = base + src
    for k in ("start_url", "scope"):
        v = data.get(k)
        if isinstance(v, str) and v.startswith("/") and not v.startswith(base + "/"):
            data[k] = base + v
    return JSONResponse(data, media_type="application/manifest+json")


if config.FRONTEND_DIR.exists():
    # Registered BEFORE the /static mount so this explicit route wins over the
    # StaticFiles handler (which would otherwise serve the raw manifest).
    @app.get("/static/manifest.json")
    async def manifest_json():
        return _manifest_response("manifest.json")

    app.mount("/static", StaticFiles(directory=str(config.FRONTEND_DIR)), name="static")

    @app.get("/")
    async def index():
        return _spa_html("index.html")

    @app.get("/home")
    async def gary_home():
        return _spa_html("newtab.html")

    @app.get("/newtab")
    async def gary_newtab():
        return _spa_html("newtab.html")

    @app.get("/gary-home.html")
    async def gary_home_alias():
        # Path-compatible alias for the :8011 media-server copy, so a new-tab
        # setting pointed at .../gary-home.html works verbatim on this origin.
        return _spa_html("newtab.html")

    @app.get("/classic")
    async def index_classic():
        # Task 18 step 1 (parity gate, instrumentation only — retirement is
        # deferred pending a week-long soak): one INFO line per hit so usage
        # can be tracked with `journalctl --user -u openclaw-workspace |
        # grep -c "classic UI served"`. No behavior change otherwise.
        _log.info("classic UI served")
        return _spa_html("index-classic.html")
else:
    @app.get("/")
    async def index_missing():
        return JSONResponse(
            status_code=500,
            content={"error": f"frontend not found at {config.FRONTEND_DIR}. "
                              "Run scripts/sync-frontend.sh to copy Odysseus static/."},
        )

# ---------------------------------------------------------------------------
# STATUS: the /next TS/Vite rewrite is ABANDONED and DELETED (decided 2026-08-03).
# It plateaued at ~80% doing parity work against the classic frontend it was meant
# to replace, and reaching for a clean stack stopped being worth it. The classic
# frontend-overrides tree stays production. Do NOT re-recommend the cutover. The
# frontend-next/ tree was removed from the repo (recoverable via git history at
# the commit before this one) — there is no /next mount anymore.
# ---------------------------------------------------------------------------
