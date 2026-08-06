"""Voice playback route — proxies the PWA speak button to the resident XTTS
synthesis server (bin/xtts-server.py in ~/.openclaw/workspace, systemd unit
xtts-tts.service on 127.0.0.1:8123).

The synth server holds the XTTS model + Gary voice latents resident and owns the
locked voice config (temp/pitch/etc.) plus its own content-hash cache, so this
layer stays a thin, dumb proxy: forward {text}, stream back audio/wav.

Routes:
  GET  /api/voice/status        -> {"supported": bool, "ready": bool}
  POST /api/voice/speak {text}  -> audio/wav  (or JSON error)
"""
from __future__ import annotations

import logging

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

_log = logging.getLogger(__name__)
router = APIRouter()

XTTS_BASE = "http://127.0.0.1:8123"
MAX_CHARS = 4000


@router.get("/api/voice/status")
async def voice_status():
    """Report whether the local TTS server is up and its model is loaded."""
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            r = await client.get(f"{XTTS_BASE}/health")
        if r.status_code == 200:
            data = r.json()
            return {"supported": True, "ready": bool(data.get("ready"))}
    except Exception:
        pass
    return {"supported": False, "ready": False}


@router.post("/api/voice/speak")
async def voice_speak(request: Request):
    """Synthesize `text` in Gary's voice. Returns audio/wav on success.

    Errors:
        400: no text
        503: synth server down or model still loading
        502: synth server error
        504: synth timed out (long text on CPU)
    """
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid JSON"}, status_code=400)

    text = (payload or {}).get("text", "")
    if not isinstance(text, str) or not text.strip():
        return JSONResponse({"error": "no text provided"}, status_code=400)
    text = text.strip()[:MAX_CHARS]

    try:
        # CPU synth on naboo is ~3.5x realtime; a long message can take a while.
        async with httpx.AsyncClient(timeout=180.0) as client:
            r = await client.post(f"{XTTS_BASE}/synth", json={"text": text})
    except httpx.ConnectError:
        return JSONResponse({"error": "voice server offline"}, status_code=503)
    except httpx.TimeoutException:
        return JSONResponse({"error": "synth timed out"}, status_code=504)
    except Exception as e:  # pragma: no cover - defensive
        _log.exception("voice speak proxy failed")
        return JSONResponse({"error": str(e)}, status_code=502)

    if r.status_code == 503:
        return JSONResponse({"error": "voice model still loading"}, status_code=503)
    if r.status_code != 200:
        try:
            err = r.json().get("error", "synth failed")
        except Exception:
            err = "synth failed"
        return JSONResponse({"error": err}, status_code=502)

    return Response(
        content=r.content,
        media_type="audio/wav",
        headers={"Cache-Control": "no-store"},
    )
