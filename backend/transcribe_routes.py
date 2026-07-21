"""Routes for speech-to-text transcription."""
from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, UploadFile
from fastapi.responses import JSONResponse

from . import transcribe

_log = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/transcribe/status")
async def transcribe_status():
    """Check if transcription is supported on this installation.

    Returns:
        {"supported": bool}
    """
    return {"supported": transcribe.supported()}


@router.post("/api/transcribe")
async def transcribe_audio(audio: UploadFile = None):
    """Transcribe audio data to text.

    Args:
        audio: multipart audio file field

    Returns:
        {"text": str} on 200
        {"error": str} with 4xx/5xx on error

    Errors:
        400: no file provided or file is empty
        413: file exceeds 25 MB limit
        503: transcription not supported (no OpenAI key)
        502: upstream transcription service failure
    """
    if not audio:
        return JSONResponse({"error": "no file provided"}, status_code=400)

    # Read file data
    data = await audio.read()
    if not data:
        return JSONResponse({"error": "file is empty"}, status_code=400)

    # Check size limit (25 MB)
    if len(data) > 25 * 1024 * 1024:
        return JSONResponse({"error": "file too large"}, status_code=413)

    # Check if transcription is supported
    if not transcribe.supported():
        return JSONResponse(
            {"error": "transcription not supported"},
            status_code=503,
        )

    # Perform transcription
    try:
        text = await transcribe.transcribe(
            filename=audio.filename or "audio",
            content_type=audio.content_type or "audio/webm",
            data=data,
        )
        return {"text": text}
    except transcribe.TranscribeError as e:
        _log.warning("transcription failed: %s", e)
        # Map error to HTTP status
        msg = str(e)
        if "not supported" in msg:
            return JSONResponse(
                {"error": "transcription not supported"},
                status_code=503,
            )
        else:
            return JSONResponse(
                {"error": "transcription failed"},
                status_code=502,
            )
