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

from . import bridge, config
from .inbox import router as inbox_router

app = FastAPI(title="OpenClaw Workspace")
app.include_router(inbox_router)


@app.get("/api/health")
async def health():
    return {
        "ok": True,
        "gateway": config.gateway_ws_url(),
        "session": config.SESSION_KEY,
        "has_password": bool(config.gateway_password()),
    }


# --- The one real, load-bearing endpoint: chat ------------------------------

@app.post("/api/chat_stream")
async def chat_stream(message: str = Form(...), session: str = Form(default="")):
    """Stream a turn from OpenClaw's brain as Odysseus-shaped SSE.

    Routes to the dedicated web session (config.WEB_SESSION_KEY) so the UI never
    contends with Signal on agent:main:main. The posted `session` is the SPA's
    local session id (used for its own history grouping), not a gateway key.
    """
    generator = bridge.stream_turn(message, session_key=config.WEB_SESSION_KEY)
    return StreamingResponse(generator, media_type="text/event-stream")


# --- Minimal stubs so the SPA mounts cleanly (flesh out in v2) --------------

@app.get("/api/sessions")
async def sessions():
    return []


@app.post("/api/session")
async def create_session():
    return {"id": "main", "name": "Workspace", "model": "openclaw"}


@app.get("/api/chat/resume/{session_id}")
async def resume(session_id: str):
    return {"id": session_id, "messages": []}


@app.get("/api/chat/stream_status/{session_id}")
async def stream_status(session_id: str):
    return {"active": False}


@app.get("/api/models")
async def models():
    # The SPA's models.js reads `data.items` (NOT a bare array). Returning a
    # list leaves the model-picker cache empty → blank picker → "no session".
    # category must be "api" (not "agent"): models.js buckets anything that
    # isn't "local" into the api group, but the category order list only renders
    # known keys. url is the WS endpoint, echoed into the session, never routed.
    return {"items": [
        {"endpoint_id": "openclaw", "endpoint_name": "OpenClaw",
         "url": config.gateway_ws_url(), "category": "api",
         "models": ["openclaw"], "models_display": ["OpenClaw"],
         "models_extra": [], "models_extra_display": [], "offline": False},
    ]}


@app.get("/api/default-chat")
async def default_chat():
    # endpoint_url is REQUIRED: chat.js auto-creates the session only when both
    # endpoint_url and model are truthy. It's stored + echoed back to /api/session
    # but never used to route — every turn goes through the bridge regardless.
    return {"endpoint_id": "openclaw", "endpoint_url": config.gateway_ws_url(),
            "model": "openclaw"}


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
