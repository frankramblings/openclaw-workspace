"""The unified task feed — read side of task_registry.

  GET /api/tasks          one-shot snapshot ({"tasks":[...]})
  GET /api/tasks/stream   SSE: snapshot frame, then a task.update frame per
                          registry upsert, keepalive comment on idle.

Subscribe-before-snapshot so no upsert slips between them (same reasoning as
resume_route.chat_stream_tail). Purely read-side; initiates nothing.
"""
from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter
from fastapi.responses import JSONResponse, StreamingResponse

from . import task_registry

router = APIRouter()

_KEEPALIVE_S = 15.0


def _sse(obj) -> str:
    return f"data: {json.dumps(obj, separators=(',', ':'))}\n\n"


@router.get("/api/tasks")
async def tasks_snapshot(session: str = ""):
    return JSONResponse({"tasks": task_registry.list_tasks(session_key=session or None)})


async def _stream_gen():
    queue = task_registry.subscribe()
    try:
        yield _sse({"type": "tasks.snapshot", "tasks": task_registry.list_tasks()})
        while True:
            try:
                rec = await asyncio.wait_for(queue.get(), timeout=_KEEPALIVE_S)
            except asyncio.TimeoutError:
                if not task_registry.is_subscribed(queue):
                    return          # dropped (QueueFull): end the stream; client resnapshots
                yield ": keepalive\n\n"
                continue
            yield _sse({"type": "task.update", "task": rec})
    finally:
        task_registry.unsubscribe(queue)


@router.get("/api/tasks/stream")
async def tasks_stream():
    return StreamingResponse(_stream_gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})
