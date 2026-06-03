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
    """Stream a turn from OpenClaw's brain as Odysseus-shaped SSE."""
    generator = bridge.stream_turn(message)
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
    return [{"endpoint_id": "openclaw", "endpoint_name": "OpenClaw (subscription)",
             "url": config.gateway_ws_url(), "models": ["openclaw"],
             "models_display": ["OpenClaw"], "category": "agent"}]


@app.get("/api/default-chat")
async def default_chat():
    return {"endpoint_id": "openclaw", "model": "openclaw"}


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
