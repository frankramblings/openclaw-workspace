"""Voice playback route — proxies the PWA speak button to a resident XTTS
synthesis server (bin/xtts-server.py; same locked Gary voice config on both hosts).

Two backends, tried in order:
  1. kamino (100.97.60.15:8123) — launchd ai.kamino.xtts-gary, ~1.5x faster synth.
  2. naboo  (127.0.0.1:8123)    — systemd xtts-tts.service, the reliable fallback.

Each synth server holds the XTTS model + Gary voice latents resident and owns the
locked voice config (temp/pitch/etc.) plus its own content-hash cache, so this
layer stays a thin, dumb proxy: forward {text}, stream back audio/wav. Override
the primary/fallback order or endpoints with the GARY_TTS_BASES env var
(comma-separated base URLs).

Routes:
  GET  /api/voice/status        -> {"supported": bool, "ready": bool}
  POST /api/voice/speak {text}  -> audio/wav  (or JSON error)
"""
from __future__ import annotations

import logging
import os

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

_log = logging.getLogger(__name__)
router = APIRouter()

# Order: Chatterbox-MLX on kamino (fastest, Metal) -> kamino XTTS -> naboo XTTS
# (always-on). Env override wins (GARY_TTS_BASES, comma-separated base URLs).
_DEFAULT_BASES = "http://100.97.60.15:8124,http://100.97.60.15:8123,http://127.0.0.1:8123"
XTTS_BASES = [b.strip() for b in os.environ.get("GARY_TTS_BASES", _DEFAULT_BASES).split(",") if b.strip()]
MAX_CHARS = 4000


@router.get("/api/voice/status")
async def voice_status():
    """Report whether any TTS backend is up with its model loaded."""
    for base in XTTS_BASES:
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                r = await client.get(f"{base}/health")
            if r.status_code == 200 and r.json().get("ready"):
                return {"supported": True, "ready": True}
        except Exception:
            continue
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

    # Try each backend in order; only fall through on a backend-level failure
    # (offline, timeout, 5xx). A 200 wins immediately.
    last_err = ("voice server offline", 503)
    for base in XTTS_BASES:
        try:
            # CPU synth is ~3.5x realtime; a long message can take a while.
            async with httpx.AsyncClient(timeout=180.0) as client:
                r = await client.post(f"{base}/synth", json={"text": text})
        except httpx.ConnectError:
            last_err = ("voice server offline", 503)
            continue
        except httpx.TimeoutException:
            last_err = ("synth timed out", 504)
            continue
        except Exception as e:  # pragma: no cover - defensive
            _log.exception("voice speak proxy failed (%s)", base)
            last_err = (str(e), 502)
            continue

        if r.status_code == 200:
            return Response(
                content=r.content,
                media_type="audio/wav",
                headers={"Cache-Control": "no-store", "X-TTS-Backend": base},
            )
        if r.status_code == 503:
            last_err = ("voice model still loading", 503)
            continue
        try:
            err = r.json().get("error", "synth failed")
        except Exception:
            err = "synth failed"
        last_err = (err, 502)
        continue

    return JSONResponse({"error": last_err[0]}, status_code=last_err[1])
