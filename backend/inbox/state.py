"""Local triage state for the unified Inbox: dismissed (forever) and snoozed
(until an epoch-ms deadline), keyed "{source}:{id}". Lives in
`.data/inbox-state.json` — same atomic temp-file+replace pattern as
sessions_store, plus an in-process cache guarded by a lock (the dashboard's
dismissed.js had the same single-flight idea)."""
from __future__ import annotations

import json
import os
import threading
import time

from .. import config

STATE_FILE = config.DATA_DIR / "inbox-state.json"
_LOCK = threading.Lock()
_mem: dict | None = None


def _load() -> dict:
    global _mem
    if _mem is None:
        try:
            _mem = json.loads(STATE_FILE.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            _mem = {}
        if not isinstance(_mem, dict):
            _mem = {}
    _mem.setdefault("dismissed", {})
    _mem.setdefault("snoozed", {})
    return _mem


def _save() -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(_mem, indent=2))
    os.replace(tmp, STATE_FILE)


def dismiss(source: str, item_id: str, reason: str = "dismissed") -> None:
    with _LOCK:
        _load()["dismissed"][f"{source}:{item_id}"] = {
            "reason": reason, "ts": int(time.time() * 1000)}
        _save()


def snooze(source: str, item_id: str, until_ms: int) -> None:
    with _LOCK:
        _load()["snoozed"][f"{source}:{item_id}"] = {"until": int(until_ms)}
        _save()


def hidden(source: str, item_id: str, now_ms: int | None = None) -> bool:
    """True if the item is dismissed or currently snoozed. Expired snoozes are
    pruned on read so the file doesn't grow unbounded."""
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    key = f"{source}:{item_id}"
    with _LOCK:
        data = _load()
        if key in data["dismissed"]:
            return True
        entry = data["snoozed"].get(key)
        if entry:
            if now_ms < entry.get("until", 0):
                return True
            del data["snoozed"][key]
            _save()
    return False
