"""Local triage state for the unified Inbox: dismissed (forever) and snoozed
(until an epoch-ms deadline), keyed "{source}:{id}". Lives in
`.data/inbox-state.json` — same atomic temp-file+replace pattern as
sessions_store, plus an in-process cache guarded by a lock (the dashboard's
dismissed.js had the same single-flight idea)."""
from __future__ import annotations

import json
import logging
import os
import threading
import time

from .. import config, fsutil

log = logging.getLogger(__name__)

STATE_FILE = config.DATA_DIR / "inbox-state.json"
_LOCK = threading.Lock()
_mem: dict | None = None


def _load() -> dict:
    global _mem
    if _mem is None:
        _mem = fsutil.load_json_guarded(STATE_FILE, {}, logger=log)
        if not isinstance(_mem, dict):
            _mem = {}
    _mem.setdefault("dismissed", {})
    _mem.setdefault("snoozed", {})
    _mem.setdefault("history", [])
    _mem.setdefault("stats", {})
    _mem.setdefault("recs", {})
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


# --- v2.1: action history (undo), stat counters, AI-recs cache ---------------

HISTORY_CAP = 100
REC_TTL_MS = 7 * 24 * 3600_000


def log_action(source: str, item_id: str, title: str, action: str,
               undo: dict | None, stat_key: str | None) -> int:
    """Append a history entry (newest first); returns its unique ts key.
    `undo` carries whatever the /undo endpoint needs (None = not undoable
    beyond restoring the card); `stat_key` is echoed so undo can decrement."""
    with _LOCK:
        data = _load()
        hist = data["history"]
        ts = int(time.time() * 1000)
        while any(e["ts"] == ts for e in hist):
            ts += 1  # ts doubles as the undo key — keep it unique
        hist.insert(0, {"source": source, "id": item_id, "title": title,
                        "action": action, "ts": ts, "undo": undo,
                        "statKey": stat_key})
        del hist[HISTORY_CAP:]
        _save()
        return ts


def history(limit: int = 20) -> list[dict]:
    with _LOCK:
        return [dict(e) for e in _load()["history"][:limit]]


def pop_history(ts: int) -> dict | None:
    with _LOCK:
        data = _load()
        for i, e in enumerate(data["history"]):
            if e["ts"] == ts:
                del data["history"][i]
                _save()
                return e
    return None


def bump_stat(key: str, action: str) -> None:
    with _LOCK:
        entry = _load()["stats"].setdefault(key, {})
        entry[action] = entry.get(action, 0) + 1
        _save()


def drop_stat(key: str, action: str) -> None:
    with _LOCK:
        data = _load()
        entry = data["stats"].get(key)
        if not entry or action not in entry:
            return
        entry[action] -= 1
        if entry[action] <= 0:
            del entry[action]
        if not entry:
            del data["stats"][key]
        _save()


def stats() -> dict:
    with _LOCK:
        return {k: dict(v) for k, v in _load()["stats"].items()}


def undismiss(source: str, item_id: str) -> None:
    """Remove dismissed AND snoozed state so the card returns."""
    key = f"{source}:{item_id}"
    with _LOCK:
        data = _load()
        data["dismissed"].pop(key, None)
        data["snoozed"].pop(key, None)
        _save()


def recs() -> dict:
    with _LOCK:
        return {k: dict(v) for k, v in _load()["recs"].items()}


def set_recs(new: dict, live_keys: set[str], now_ms: int | None = None) -> None:
    """Merge triage results into the cache; prune entries older than 7 days
    that are also absent from the current feed (spec §4 step 4)."""
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    with _LOCK:
        cache = _load()["recs"]
        cache.update(new)
        for k in [k for k, v in cache.items()
                  if k not in live_keys and now_ms - v.get("ts", 0) > REC_TTL_MS]:
            del cache[k]
        _save()
