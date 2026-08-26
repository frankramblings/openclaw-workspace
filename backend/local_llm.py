"""Direct OpenAI-compatible completions for stateless utility work.

Titles and composer suggestions are single-shot, contextless completions. They
do NOT need the OpenClaw agent runtime (persona bootstrap, sessions, tools), and
forcing them through the gateway drags the full ~27k Gary bootstrap into every
call — wasteful on cloud, fatally slow on a local 7B (prefill > timeout). When
the configured model lives on a local OpenAI-compatible endpoint (LM Studio /
mlx_lm on kamino), this module talks to it directly.

Kept deliberately tiny: one POST, plain text out, any failure -> "" so the
caller degrades to "no title / no suggestion" exactly like a gateway miss.
"""
from __future__ import annotations

import logging

import httpx

from . import config

log = logging.getLogger(__name__)


def can_route(model_ref: str | None) -> bool:
    """True when `model_ref` names a local endpoint we can hit directly."""
    return config.direct_completion_base(model_ref) is not None


async def complete(model_ref: str, prompt: str, *, max_tokens: int = 32,
                   temperature: float = 0.3, timeout: float = 30.0) -> str:
    """POST a one-shot chat completion to the local endpoint. Returns the
    assistant text, or "" on any error (caller treats empty as 'skip')."""
    base = config.direct_completion_base(model_ref)
    if not base:
        return ""
    model = config.direct_completion_model(model_ref)
    url = base.rstrip("/") + "/chat/completions"
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": False,
    }
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.post(url, json=payload)
            r.raise_for_status()
            data = r.json()
        return (data["choices"][0]["message"]["content"] or "").strip()
    except Exception:  # noqa: BLE001 — empty means "no result", same as a miss
        log.warning("local completion failed (model=%s url=%s)", model_ref, url,
                    exc_info=True)
        return ""
