"""Per-session sidecar recording which AskUserQuestion cards were answered, so
/api/history can replay them locked with the chosen answer. Mirrors the
chat-attachment sidecar in attachments.py."""
import json
import re
from pathlib import Path

from .uploads import ATTACH_DIR

_QCARD_DIR = ATTACH_DIR.parent / ".question-cards"
_SAFE = re.compile(r"[^A-Za-z0-9_.-]")


def _path(session_id: str) -> Path | None:
    safe = _SAFE.sub("_", session_id or "")
    return (_QCARD_DIR / f"{safe}.json") if safe else None


def answers_for(session_id: str) -> dict:
    p = _path(session_id)
    if not p or not p.exists():
        return {}
    try:
        return json.loads(p.read_text())
    except Exception:  # noqa: BLE001 - corrupt sidecar → treat as unanswered
        return {}


def record_answer(session_id: str, tool_id: str, choice) -> None:
    p = _path(session_id)
    if not p or not tool_id:
        return
    data = answers_for(session_id)
    data[tool_id] = {"answered": True, "choice": choice}
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data))
