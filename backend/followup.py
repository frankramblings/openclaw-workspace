"""Follow-up promises: background-task completion drives a real agent turn.

Gary starts background work through `bin/followup`, which registers a promise
here and pings completion when the command exits. We then seed a real turn on
the SAME web session through app's detached recorder, so the existing live
tail / active_sessions notifier / history all deliver it — no new transport.

The store is a tiny JSON file (sessions_store pattern: atomic replace under a
process lock). The file path resolves config.DATA_DIR at CALL time so tests'
DATA_DIR monkeypatch isolates it.

Promise states: pending → completed | overdue | failed.
  completed — command pinged back; follow-up turn fired
  overdue   — no ping by the deadline; "went silent" turn fired
  failed    — session gone / gateway never acked / busy too long
"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid

from . import config

_MARKER = "[[followup]]"
_TAIL_CAP = 4096
_LOCK = threading.Lock()


def _store_file():
    return config.DATA_DIR / "followups.json"


def _now_ms() -> int:
    return int(time.time() * 1000)


def _load() -> dict:
    try:
        return json.loads(_store_file().read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {"promises": []}


def _save(data: dict) -> None:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = _store_file().with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2))
    os.replace(tmp, _store_file())  # atomic on POSIX


def create_promise(session_id: str, session_key: str, label: str,
                   deadline_s: int) -> dict:
    rec = {
        "id": uuid.uuid4().hex[:12],
        "session_id": session_id,
        "session_key": session_key,
        "label": (label or "background task").strip()[:200],
        "state": "pending",
        "created": _now_ms(),
        # 0 disables the deadline backstop (caller opted out).
        "deadline_ms": _now_ms() + deadline_s * 1000 if deadline_s > 0 else 0,
        # Completion payload — set once by record_completion.
        "pinged": 0, "exit_code": None, "duration_s": None, "tail": "",
        "fired": 0, "error": "",
    }
    with _LOCK:
        data = _load()
        data.setdefault("promises", []).append(rec)
        _save(data)
    return rec


def get_promise(pid: str) -> dict | None:
    with _LOCK:
        for p in _load().get("promises", []):
            if p.get("id") == pid:
                return p
    return None


def list_promises() -> list[dict]:
    with _LOCK:
        return sorted(_load().get("promises", []),
                      key=lambda p: p.get("created", 0), reverse=True)


def record_completion(pid: str, *, exit_code: int, duration_s: float,
                      tail: str) -> bool:
    """Store the wrapper's completion ping. First ping wins; a duplicate or a
    ping for an already-resolved promise returns False (idempotent no-op)."""
    with _LOCK:
        data = _load()
        for p in data.get("promises", []):
            if p.get("id") == pid:
                if p.get("pinged") or p.get("state") != "pending":
                    return False
                p["pinged"] = _now_ms()
                p["exit_code"] = int(exit_code)
                p["duration_s"] = round(float(duration_s), 1)
                p["tail"] = (tail or "")[-_TAIL_CAP:]
                _save(data)
                return True
    return False


def mark(pid: str, state: str, **fields) -> dict | None:
    """Transition a PENDING promise to a terminal state (+ extra fields).
    Returns the updated record, or None if the promise is missing or already
    resolved — terminal states stick, so double-fires are harmless."""
    with _LOCK:
        data = _load()
        for p in data.get("promises", []):
            if p.get("id") == pid:
                if p.get("state") != "pending":
                    return None
                p["state"] = state
                p["fired"] = _now_ms()
                for k, v in fields.items():
                    p[k] = v
                _save(data)
                return p
    return None


def due_promises(now_ms: int) -> list[tuple[str, bool]]:
    """Pending promises whose follow-up turn should fire NOW:
      (pid, False) — completion ping recorded but turn not fired (endpoint
                     crash / restart recovery),
      (pid, True)  — no ping and the deadline passed → overdue turn.
    Pure function of the store + clock so the sweep interval is testable."""
    out: list[tuple[str, bool]] = []
    with _LOCK:
        for p in _load().get("promises", []):
            if p.get("state") != "pending":
                continue
            if p.get("pinged"):
                out.append((p["id"], False))
            elif p.get("deadline_ms") and now_ms >= p["deadline_ms"]:
                out.append((p["id"], True))
    return out


def _fmt_duration(seconds) -> str:
    s = int(seconds or 0)
    if s >= 3600:
        return f"{s // 3600}h{(s % 3600) // 60:02d}m"
    if s >= 60:
        return f"{s // 60}m{s % 60:02d}s"
    return f"{s}s"


def seed_text(label: str, *, exit_code=None, duration_s=None, tail: str = "",
              overdue: bool = False) -> str:
    """The user-role message that seeds the follow-up turn. Line format is a
    CONTRACT with history_card() below — first three lines are marker, Task,
    Result."""
    if overdue:
        result = "no completion signal by the deadline — the task never reported back"
    else:
        result = f"exit {exit_code} after {_fmt_duration(duration_s)}"
    lines = [
        _MARKER,
        f"Task: {label}",
        f"Result: {result}",
    ]
    if tail.strip():
        lines += ["Output tail:", "```", tail.strip()[-_TAIL_CAP:], "```"]
    lines += [
        "",
        "You promised to follow up on this background task in this chat when "
        "it finished. Inspect the actual result now (files, logs, artifacts — "
        "don't trust the exit code alone), then report back to Frank: lead "
        "with the outcome, include the link and the real numbers if it "
        "succeeded, and be honest about what went wrong if it failed or went "
        "silent.",
    ]
    return "\n".join(lines)


def history_card(content) -> str | None:
    """Rewrite a stored seed message into the compact line the transcript
    shows (`⚙️ Background task · <label> — <result>`). None for anything that
    isn't a followup seed."""
    if not isinstance(content, str) or not content.startswith(_MARKER):
        return None
    label, result = "background task", ""
    for line in content.splitlines()[1:4]:
        if line.startswith("Task: "):
            label = line[6:].strip()
        elif line.startswith("Result: "):
            result = line[8:].strip()
    return f"⚙️ Background task · {label}" + (f" — {result}" if result else "")
