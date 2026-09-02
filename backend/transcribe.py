"""Speech-to-text transcription — local-first (kamino Whisper), OpenAI fallback."""
from __future__ import annotations

import logging
import os
from typing import Optional

import httpx

from . import config

_log = logging.getLogger(__name__)

# Local Whisper (MLX on kamino, Metal). Set GARY_STT_BASE="" to disable and force
# the OpenAI path. Contract: POST /asr multipart audio_file -> {"text": ...}.
_KAMINO_STT = os.environ.get("GARY_STT_BASE", "http://100.97.60.15:9000")


def _local_base() -> str:
    return (_KAMINO_STT or "").rstrip("/")


async def _transcribe_local(filename: str, content_type: str, data: bytes) -> str:
    """Transcribe via the local kamino Whisper service. Raises on any failure."""
    base = _local_base()
    if not base:
        raise TranscribeError("local STT disabled")
    url = f"{base}/asr?task=transcribe&language=en&output=json&encode=true"
    async with httpx.AsyncClient(timeout=60.0) as client:
        r = await client.post(url, files={"audio_file": (filename or "clip", data, content_type)})
    if r.status_code != 200:
        raise TranscribeError(f"local STT error: {r.status_code}")
    return (r.json().get("text") or "").strip()


class TranscribeError(Exception):
    """Raised when the transcription request fails upstream."""
    pass


def _read_key() -> Optional[str]:
    """Read the OpenAI Whisper API key at request time.

    config._openclaw_json() is @lru_cache(maxsize=1): once anything in the
    process has called it, the parsed openclaw.json is pinned for the
    process lifetime. Without busting that cache here, a key added or
    rotated after the backend started would silently never be picked up —
    contradicting the "key changes must not need restart" requirement.
    Cache-busting on every read is cheap (a single small JSON file) and this
    endpoint is low-frequency (a manual tap-to-record), so the tradeoff is
    fine.
    """
    config._openclaw_json.cache_clear()
    cfg = config._openclaw_json()
    return cfg.get("skills", {}).get("entries", {}).get("openai-whisper-api", {}).get("apiKey")


def supported() -> bool:
    """Supported if a local Whisper base is configured OR an OpenAI key exists."""
    return bool(_local_base()) or bool(_read_key())


async def transcribe(filename: str, content_type: str, data: bytes) -> str:
    """Transcribe audio data using OpenAI Whisper API.

    Args:
        filename: original filename (used for multipart boundary)
        content_type: MIME type of the audio (e.g. 'audio/mp4', 'audio/webm')
        data: audio file bytes

    Returns:
        Transcribed text

    Raises:
        TranscribeError: if the request fails upstream or key is missing
    """
    # Local-first: try kamino Whisper (Metal, private, zero cloud egress).
    if _local_base():
        try:
            text = await _transcribe_local(filename, content_type, data)
            if text:
                return text
            _log.info("local STT returned empty; falling back")
        except Exception as e:  # noqa: BLE001 - fall through to OpenAI if configured
            _log.info("local STT failed (%s); falling back to OpenAI", type(e).__name__)

    key = _read_key()
    if not key:
        raise TranscribeError("transcription not supported (no local STT or OpenAI key)")

    # Map content-type to file extension for the multipart field
    ext_map = {
        "audio/mp4": "m4a",
        "audio/mpeg": "mp3",
        "audio/webm": "webm",
        "audio/wav": "wav",
        "audio/flac": "flac",
    }
    ext = ext_map.get(content_type, "webm")
    multipart_filename = f"clip.{ext}"

    async with httpx.AsyncClient(timeout=60.0) as client:
        # Try the primary model first, then fallback to whisper-1
        for model in ("gpt-4o-mini-transcribe", "whisper-1"):
            # Only the network call itself is wrapped here. Note this never
            # interpolates the raw exception `e` (only its class name) into
            # the message: `e` can carry request internals from httpx/httpcore
            # (e.g. malformed-header errors echo the offending header value),
            # and this message is logged verbatim by transcribe_routes.py —
            # the Authorization header carries the API key, so it must never
            # reach a message that gets logged.
            try:
                response = await client.post(
                    "https://api.openai.com/v1/audio/transcriptions",
                    headers={"Authorization": f"Bearer {key}"},
                    files={
                        "file": (multipart_filename, data, content_type),
                        "model": (None, model),
                    },
                )
            except (httpx.TimeoutException, httpx.HTTPError) as e:
                raise TranscribeError(f"transcription request failed: {type(e).__name__}") from e
            except Exception as e:
                raise TranscribeError(f"transcription request failed: {type(e).__name__}") from e

            # Deliberately outside the try above: these are raised, not
            # caught, from an httpx exception, so they must not fall into
            # the `except Exception` above and get double-wrapped into a
            # confusing "transcription request failed: <TranscribeError ...>".
            if response.status_code == 404 and model == "gpt-4o-mini-transcribe":
                # Model not found, try the next one
                _log.debug("model %s not found, retrying with fallback", model)
                continue

            if response.status_code >= 500:
                raise TranscribeError(f"upstream error: {response.status_code}")

            if response.status_code >= 400:
                raise TranscribeError(f"transcription failed: {response.status_code}")

            try:
                result = response.json()
                text = result.get("text", "").strip()
            except Exception as e:
                raise TranscribeError(f"transcription response parse failed: {type(e).__name__}") from e
            return text

        # If we get here, both models failed
        raise TranscribeError("transcription service unavailable")
