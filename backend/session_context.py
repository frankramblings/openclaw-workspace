"""Live per-session context-window occupancy, captured from the gateway's
`sessions.changed` broadcast (the SAME source OpenClaw's Control UI uses for its
"N% context used" indicator).

The persistent monitor (monitor.py) subscribes to session events and feeds every
`sessions.changed` snapshot here. The footer-usage endpoint reads the latest
fresh snapshot per gateway session key.

Why this and not the `sessions.usage` RPC: that RPC is a cost-accounting
aggregate (it reported ~4k for a session whose real context occupancy was ~138k).
The live row carries the true `totalTokens` (transcript-measured occupancy) and
`contextTokens` (the real model window, e.g. 1,048,576 for the Opus-1M variant,
272,000 for gpt-5.x) — verified empirically 2026-06-19: only `phase:"end"`
events carry a fresh, non-null `totalTokens` (start/null snapshots are null), so
we only overwrite occupancy when `totalTokensFresh` is true.

In-memory + process-local: a fresh monitor connection starts empty and fills as
sessions take turns — exactly like the Control UI on a cold load.
"""
from __future__ import annotations

import threading
import time

_LOCK = threading.Lock()
_CACHE: dict[str, dict] = {}


def update_from_event(payload: dict) -> None:
    """Fold one `sessions.changed` payload into the per-session cache. Only a
    fresh, non-null `totalTokens` overwrites occupancy, so a `phase:"start"`
    snapshot (null tokens) never clobbers the last good value."""
    if not isinstance(payload, dict):
        return
    key = payload.get("sessionKey")
    if not key or not isinstance(key, str):
        return

    tot = payload.get("totalTokens")
    ctx = payload.get("contextTokens")
    fresh = payload.get("totalTokensFresh") is True

    with _LOCK:
        cur = dict(_CACHE.get(key) or {})
        if isinstance(tot, (int, float)) and tot >= 0 and fresh:
            cur["totalTokens"] = int(tot)
            cur["totalTokensFresh"] = True
            cur["totalTokensAt"] = int(time.time() * 1000)
        if isinstance(ctx, (int, float)) and ctx > 0:
            cur["contextTokens"] = int(ctx)
        # Carry the latest non-null descriptive fields (model can flip if the
        # session's picker changed; cost/io land on the end snapshot).
        for field in ("model", "modelProvider", "inputTokens", "outputTokens",
                      "estimatedCostUsd"):
            val = payload.get(field)
            if val is not None:
                cur[field] = val
        cur["updatedAt"] = int(time.time() * 1000)
        _CACHE[key] = cur


def bump_tool_calls(session_key: str, n: int = 1) -> None:
    """Increment the live tool-call tally for a session. The gateway's
    `sessions.usage` does NOT count tool calls for bridge/web sessions (their
    transcript is sparse — verified 2026-06-19: a tool-heavy session reports
    toolCalls:0), so the bridge counts the tool cards it relays and we surface
    the larger of the two. Process-local, so it counts turns seen since the last
    monitor (re)connect — same liveness contract as the occupancy cache."""
    if not session_key or n <= 0:
        return
    with _LOCK:
        cur = dict(_CACHE.get(session_key) or {})
        cur["liveToolCalls"] = int(cur.get("liveToolCalls") or 0) + int(n)
        cur["updatedAt"] = int(time.time() * 1000)
        _CACHE[session_key] = cur


def get(session_key: str) -> dict | None:
    """The latest cached snapshot for a gateway session key, or None."""
    if not session_key:
        return None
    with _LOCK:
        v = _CACHE.get(session_key)
        return dict(v) if v else None


def clear() -> None:
    """Drop all cached snapshots (used on monitor reconnect / tests)."""
    with _LOCK:
        _CACHE.clear()
