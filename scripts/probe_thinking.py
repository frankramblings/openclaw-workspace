#!/usr/bin/env python3
"""One-turn probe: dump the raw non-tool `agent` item events for a live turn,
to see exactly which fields carry gpt-5.5's reasoning text (incremental delta
vs cumulative text/summary). Run while the gateway is healthy; costs one cheap
codex turn on a scratch session.

    .venv/bin/python scripts/probe_thinking.py

The scratch session is swept by purge_orphan_sessions.py after 24h idle.
"""
from __future__ import annotations

import asyncio
import json
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import websockets                                      # noqa: E402
from backend import config                             # noqa: E402
from backend.bridge import (_await_response, _connect_params,  # noqa: E402
                            _request, _wait_for_challenge)

SESSION = f"{config.WEB_SESSION_PREFIX}-probe"
PROMPT = "What is 17 * 23? Think it through step by step before answering."


async def main() -> None:
    async with websockets.connect(config.gateway_ws_url(), max_size=None,
                                  open_timeout=30, ping_interval=None) as ws:
        await _wait_for_challenge(ws)
        hello = await _request(ws, "connect", _connect_params())
        assert hello.get("ok"), hello
        send_id = uuid.uuid4().hex
        await ws.send(json.dumps({
            "type": "req", "id": send_id, "method": "chat.send",
            "params": {"sessionKey": SESSION, "message": PROMPT,
                       "deliver": False, "idempotencyKey": uuid.uuid4().hex}}))
        ack = await _await_response(ws, send_id)
        assert ack.get("ok"), ack
        run_id = (ack.get("payload") or {}).get("runId")
        while True:
            frame = json.loads(await ws.recv())
            if frame.get("type") != "event":
                continue
            payload = frame.get("payload") or {}
            if run_id and payload.get("runId") not in (None, run_id):
                continue
            if frame.get("event") != "agent":
                continue
            data = payload.get("data") or {}
            if (payload.get("stream") == "item"
                    and data.get("kind") not in ("command", "tool")):
                print(json.dumps(frame, indent=2))
            if (payload.get("stream") == "lifecycle"
                    and data.get("phase") in ("end", "error")):
                return


asyncio.run(main())
