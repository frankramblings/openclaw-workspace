"""Composer ghost-text prompt suggestions (Claude-Code-style).

POST /api/chat/suggest  {session_key, mode: followup|midturn, context}
  -> {"text": "<one short suggested message>"}   ("" = show nothing)

The CLIENT supplies the conversation context: mid-turn the gateway transcript
doesn't yet contain the in-flight reply (it commits late — see
chat_turn._late_reply), while the SPA already holds everything rendered on
screen. Single-user deployment, so client-supplied context is trusted (still
tail-truncated here).

One cheap-model utility turn per request, on a dedicated session key so chat
transcripts stay clean — the same pattern as chat_turn's AI titles. Every
failure path returns {"text": ""} with HTTP 200: a ghost suggestion is never
worth an error state in the composer.
"""
from __future__ import annotations

import asyncio
import logging

from fastapi import Body
from fastapi.routing import APIRouter

from . import bridge, config

log = logging.getLogger("workspace.suggest")

router = APIRouter()

_TIMEOUT_S = 10.0
_MAX_CONTEXT = 4000       # chars of conversation context embedded in the prompt
_MAX_SUGGESTION = 120     # longer output than this = model rambled, reject
_SESSION_KEY = f"{config.web_session_prefix()}-suggester"

_RULES = ("Imperative mood, specific, under 80 characters, no surrounding "
          "quotes, no trailing punctuation. Output ONLY the message text.")

_PROMPTS = {
    "followup": (
        "You suggest the user's next message in a chat with their AI "
        "assistant.\n\nConversation (most recent last):\n{context}\n\n"
        "Output ONE short message the user might plausibly send next — a "
        "refinement, a next step, or a closely related task. " + _RULES),
    "midturn": (
        "You suggest the user's next message in a chat with their AI "
        "assistant. The assistant is STILL WORKING on the user's last "
        "request.\n\nConversation and live activity (most recent last):\n"
        "{context}\n\nSuggest ONE useful message the user could send now for "
        "work INDEPENDENT of what the assistant is already doing (it will "
        "queue and run after). Start with 'While you wait, '. " + _RULES),
}


def _sanitize(raw: str) -> str:
    """First line, shorn of wrapping quotes/backticks; oversized → ''."""
    text = (raw or "").strip()
    if not text:
        return ""
    line = text.splitlines()[0].strip().strip('"“”\'`').strip()
    if not line or len(line) > _MAX_SUGGESTION:
        return ""
    return line


@router.post("/api/chat/suggest")
async def chat_suggest(body: dict = Body(...)):
    mode = body.get("mode")
    if mode not in _PROMPTS:
        mode = "followup"
    context = str(body.get("context") or "")[-_MAX_CONTEXT:]
    if not context.strip():
        return {"text": ""}
    prompt = _PROMPTS[mode].format(context=context)
    try:
        raw = await asyncio.wait_for(
            bridge.run_text(prompt, _SESSION_KEY,
                            model_ref=config.SUGGEST_MODEL),
            timeout=_TIMEOUT_S)
    except Exception:  # noqa: BLE001 — any failure means "no suggestion"
        log.warning("suggest turn failed (mode=%s session=%s)",
                    mode, body.get("session_key", ""), exc_info=True)
        return {"text": ""}
    return {"text": _sanitize(raw)}
