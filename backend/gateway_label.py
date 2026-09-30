"""Mirror workspace thread titles into the gateway session `label`.

The workspace names threads in its own sessions.json, but the gateway never
heard about it, so every OpenClaw client (Control UI, iOS app, TUI picker)
fell back to the raw session key: `agent:main:web-1f8e5758…`. sessions.patch
{key, label} is the documented fix; the gateway then shows the label instead.

Constraints verified against the live gateway (2026-09-30):
- labels are UNIQUE per agent store: a second session with the same text is
  rejected `label already in use: …`, so collisions get a " (2)" suffix;
- patching a key the gateway hasn't created yet fails (first message of a
  brand-new chat), which is fine: the AI title lands after the turn and
  labels it then.

Best-effort throughout. A label is cosmetic; it must never break a turn.
"""
from __future__ import annotations

import logging

from . import bridge

_log = logging.getLogger(__name__)

MAX_LEN = 80
_MAX_SUFFIX = 9


def _clean(name: str) -> str:
    return " ".join((name or "").split())[:MAX_LEN].strip()


async def sync(session_key: str, name: str) -> str | None:
    """Set the gateway label for `session_key` to `name`. Returns the label
    actually applied (may carry a " (n)" suffix), or None if nothing stuck."""
    base = _clean(name)
    if not session_key or not base:
        return None
    for n in range(1, _MAX_SUFFIX + 1):
        label = base if n == 1 else f"{base[:MAX_LEN - 5].rstrip()} ({n})"
        try:
            await bridge.gateway_call("sessions.patch",
                                      {"key": session_key, "label": label},
                                      timeout=15)
            return label
        except Exception as exc:  # noqa: BLE001 - cosmetic, never fatal
            if "label already in use" in str(exc):
                continue
            _log.debug("label sync skipped for %s: %s", session_key, exc)
            return None
    return None
