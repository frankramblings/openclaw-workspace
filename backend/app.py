"""OpenClaw Workspace — FastAPI app.

Serves the (reused) Odysseus SPA and wires:
  - /api/chat_stream  → the bridge to OpenClaw's gateway brain  (REAL, v1)
  - /api/items        → the triage-dashboard unified inbox feed (proxy, v1)
  - a handful of minimal stubs so the SPA loads without console errors

Run:  uvicorn backend.app:app --reload --port 8800   (from the repo root)
"""
from __future__ import annotations

from fastapi import FastAPI, Form
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import bridge, config, sessions_store
from .calendar_google import router as calendar_router
from .cron import router as cron_router
from .email_himalaya import router as email_router
from .inbox import router as inbox_router
from .memory import router as memory_router
from .skills import router as skills_router

app = FastAPI(title="OpenClaw Workspace")
app.include_router(inbox_router)
app.include_router(memory_router)
app.include_router(skills_router)
app.include_router(cron_router)
app.include_router(email_router)
app.include_router(calendar_router)


@app.get("/api/health")
async def health():
    return {
        "ok": True,
        "gateway": config.gateway_ws_url(),
        "session": config.SESSION_KEY,
        "has_password": bool(config.gateway_password()),
    }


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


@app.post("/api/chat_stream")
async def chat_stream(message: str = Form(...), session: str = Form(default="")):
    """Stream a turn from OpenClaw's brain as Odysseus-shaped SSE.

    The posted `session` is the SPA's session id; we resolve it to that chat's
    own gateway sessionKey (agent:main:web-<id>) so each Library chat is an
    isolated thread and none contend with Signal on agent:main:main. Unknown
    ids fall back to the shared web key. The session's picked model (if any) is
    applied to that session only, so the picker actually switches the model.
    """
    rec = sessions_store.get(session) if session else None
    session_key = rec["sessionKey"] if rec else config.WEB_SESSION_KEY
    generator = bridge.stream_turn(message, session_key=session_key,
                                   model_ref=_model_ref(rec))
    return StreamingResponse(generator, media_type="text/event-stream")


# --- Session persistence: metadata here, message content from the brain ------

@app.get("/api/sessions")
async def sessions():
    return sessions_store.list_sessions()


@app.post("/api/session")
async def create_session(name: str = Form(default=""), model: str = Form(default=""),
                         endpoint_url: str = Form(default=""),
                         endpoint_id: str = Form(default="")):
    return sessions_store.create(name=name or None, model=model or None,
                                 endpoint_url=endpoint_url or None,
                                 endpoint_id=endpoint_id or None)


@app.get("/api/history/{session_id}")
async def history(session_id: str):
    """The session's saved transcript, read live from the brain via chat.history."""
    sess = sessions_store.get(session_id)
    if not sess:
        return {"history": [], "model": None}
    data = await bridge.fetch_history(sess["sessionKey"])
    # Prefer the record's chosen model label; fall back to whatever the brain used.
    data["model"] = sess.get("model") or data.get("model")
    return data


@app.patch("/api/session/{session_id}")
async def patch_session(session_id: str, name: str = Form(default=None),
                        model: str = Form(default=None), folder: str = Form(default=None),
                        endpoint_url: str = Form(default=None),
                        endpoint_id: str = Form(default=None)):
    fields = {k: v for k, v in {
        "name": name, "model": model, "folder": folder,
        "endpoint_url": endpoint_url, "endpoint_id": endpoint_id,
    }.items() if v is not None}
    return sessions_store.update(session_id, **fields) or JSONResponse(
        status_code=404, content={"detail": "no such session"})


@app.delete("/api/session/{session_id}")
async def delete_session(session_id: str):
    return {"ok": sessions_store.delete(session_id)}


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
# admin with all privileges so the SPA shows every tool and never redirects to /login.
@app.get("/api/auth/status")
async def auth_status():
    return {
        "authenticated": True, "is_admin": True, "username": "frank",
        "privileges": {
            "can_use_agent": True, "can_use_bash": True, "can_use_documents": True,
            "can_use_research": True, "can_generate_images": True,
        },
    }


@app.get("/api/auth/features")
async def auth_features():
    return {"auth_required": False, "features": {}}


@app.get("/api/auth/settings")
async def auth_settings():
    return {}


# --- Catch-all for Odysseus feature tabs v1 doesn't implement yet ------------
# calendar, email, notes, cookbook, research, prefs, memory, skills, tts… each
# polls its own backend. Returning [] is universally safe: Odysseus's consumers
# all do either `data.forEach(...)` (works on []) or `data.key || []` (→ []), so
# this quiets the 404 flood without breaking any module. Registered AFTER every
# real route, so health/items/models/chat/auth/sessions still win.
@app.get("/api/{path:path}")
async def _unimplemented_api(path: str):
    return []


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
