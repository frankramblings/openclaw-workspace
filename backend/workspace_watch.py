"""Filesystem change broadcaster for the doc editor.

Watches the workspace root (recursively) with ``watchfiles`` and fans out
change events over ``/api/workspace/watch`` — a per-client WebSocket the
editor connects to while a doc is open. Sub-100ms latency for changes made
by Gary (via Edit/Write) or by any other process touching the file.

Events on the wire (JSON):
    { "type": "file_changed",
      "abs_path": "/home/frank/.openclaw/workspace/notes/foo.md",
      "path": "notes/foo.md",         # relative to workspace root, when applicable
      "mtime_ns": 1720368000123456789 }

Clients subscribe by absolute or workspace-relative path via a ``subscribe``
message; unsubscribing on close is automatic. The watcher runs a single
background task per process — it's cheap (Rust-backed inotify) and shared by
every subscriber. Only text-editable files trigger events; binary suffixes and
protected segments (.git, __pycache__, …) are filtered out.
"""
from __future__ import annotations

import asyncio
import contextlib
import os
from pathlib import Path

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from . import vault_store as vs
from .workspace_files import SKIP_CONTENTS, TEXT_EXTS, _BINARY_EXTS

router = APIRouter()

# All open subscribers. Each entry: {"ws": WebSocket, "paths": set[str]} of
# absolute paths to filter by. An empty ``paths`` set means "any change" — the
# editor doesn't use that, but it's convenient for a future all-changes feed.
_subscribers: list[dict] = []
_watch_task: asyncio.Task | None = None
_broadcast_loop: asyncio.AbstractEventLoop | None = None


def _rel_workspace(abs_path: str) -> str | None:
    root = str(vs.WORKSPACE)
    if abs_path == root:
        return ""
    if abs_path.startswith(root + os.sep):
        return abs_path[len(root) + 1 :]
    return None


def _interesting(abs_path: str) -> bool:
    p = Path(abs_path)
    if p.suffix.lower() in _BINARY_EXTS:
        return False
    # Skip protected segments anywhere in the path (.git, node_modules, …).
    for seg in p.parts:
        if seg in SKIP_CONTENTS:
            return False
    # If it has an extension we consider text, keep it; otherwise still allow
    # extension-less files (Frank edits `SKILL`, `README`, dotfiles).
    if p.suffix and p.suffix.lower() not in TEXT_EXTS:
        # Extensions we don't know about are ambiguous — allow them; the editor
        # will refuse binary payloads on its side.
        pass
    return True


async def _fan_out(abs_path: str) -> None:
    try:
        st = os.stat(abs_path)
        mtime_ns = st.st_mtime_ns
    except OSError:
        # Deleted/moved — still worth broadcasting so the editor knows.
        mtime_ns = 0
    rel = _rel_workspace(abs_path)
    payload = {
        "type": "file_changed",
        "abs_path": abs_path,
        "path": rel,
        "mtime_ns": mtime_ns,
    }
    dead: list[dict] = []
    for entry in list(_subscribers):
        paths = entry["paths"]
        if paths and abs_path not in paths:
            continue
        try:
            await entry["ws"].send_json(payload)
        except Exception:
            dead.append(entry)
    for d in dead:
        with contextlib.suppress(ValueError):
            _subscribers.remove(d)


def publish_change(abs_path: str, mtime_ns: int | None = None) -> None:
    """Direct publish from another module (e.g. PUT handler)."""
    if not _interesting(abs_path) or _broadcast_loop is None:
        return
    async def _emit():
        rel = _rel_workspace(abs_path)
        payload = {
            "type": "file_changed",
            "abs_path": abs_path,
            "path": rel,
            "mtime_ns": mtime_ns if mtime_ns is not None else 0,
        }
        dead: list[dict] = []
        for entry in list(_subscribers):
            paths = entry["paths"]
            if paths and abs_path not in paths:
                continue
            try:
                await entry["ws"].send_json(payload)
            except Exception:
                dead.append(entry)
        for d in dead:
            with contextlib.suppress(ValueError):
                _subscribers.remove(d)
    asyncio.run_coroutine_threadsafe(_emit(), _broadcast_loop)


async def _watcher() -> None:
    """Recursive workspace watcher — one task per process, forever."""
    try:
        from watchfiles import awatch
    except Exception:
        return
    root = str(vs.WORKSPACE)
    if not os.path.isdir(root):
        return
    async for changes in awatch(root, recursive=True, stop_event=None):
        seen: set[str] = set()
        for _change_kind, path in changes:
            if path in seen:
                continue
            seen.add(path)
            if not _interesting(path):
                continue
            with contextlib.suppress(Exception):
                await _fan_out(path)


def start_watcher() -> None:
    """Call once from FastAPI startup."""
    global _watch_task, _broadcast_loop
    if _watch_task is not None:
        return
    _broadcast_loop = asyncio.get_event_loop()
    _watch_task = asyncio.create_task(_watcher())


async def stop() -> None:
    """Call once from FastAPI shutdown. Cancels the watcher task and awaits it
    so it doesn't get orphaned to uvicorn's force-close window. Tolerates the
    task never having started (e.g. watchfiles absent, or startup never ran —
    the module lazy-imports watchfiles inside `_watcher()` and is fine without
    it)."""
    global _watch_task
    if _watch_task is None:
        return
    _watch_task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await _watch_task
    _watch_task = None


@router.websocket("/api/workspace/watch")
async def workspace_watch(websocket: WebSocket):
    await websocket.accept()
    entry: dict = {"ws": websocket, "paths": set()}
    _subscribers.append(entry)
    try:
        while True:
            msg = await websocket.receive_json()
            action = msg.get("action")
            if action == "subscribe":
                # Client can pass either an absolute path or a workspace-relative
                # one; normalize to absolute so the fan-out compare is trivial.
                root = str(vs.WORKSPACE)
                for p in msg.get("paths", []) or []:
                    if not p:
                        continue
                    abs_p = p if os.path.isabs(p) else os.path.join(root, p)
                    entry["paths"].add(os.path.normpath(abs_p))
            elif action == "unsubscribe":
                root = str(vs.WORKSPACE)
                for p in msg.get("paths", []) or []:
                    abs_p = p if os.path.isabs(p) else os.path.join(root, p)
                    entry["paths"].discard(os.path.normpath(abs_p))
            elif action == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        with contextlib.suppress(ValueError):
            _subscribers.remove(entry)
