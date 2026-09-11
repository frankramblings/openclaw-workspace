"""Answering AskUserQuestion cards, plus the per-session sidecar recording which
ones were answered so /api/history can replay them locked with the chosen
answer (the sidecar mirrors the chat-attachment one in attachments.py).

The answer itself does NOT ride in as a new chat turn. Claude's native
AskUserQuestion is routed by OpenClaw into its own structured question flow
(docs/gateway/cli-backends.md), which parks the turn on a real Gateway question
awaiting `question.resolve`. Posting the answer as an ordinary message leaves
that question pending: the session sits in `state=processing
reason=blocked_tool_call` for the tool's whole 900s timeout, and the message
itself bounces off app.py's one-turn-per-session guard. So resolve_pending
answers the question through the Gateway instead."""
import asyncio
import json
import logging
import re
from pathlib import Path

from . import bridge
from .uploads import ATTACH_DIR

log = logging.getLogger(__name__)

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


def _pending_for(questions: list, session_key: str) -> dict | None:
    for q in questions:
        if not isinstance(q, dict):
            continue
        if q.get("sessionKey") != session_key:
            continue
        if q.get("status") not in (None, "pending"):
            continue
        return q
    return None


async def resolve_pending(session_key: str, selections: list) -> str:
    """Answer this session's pending Gateway question with `selections` (one
    list of chosen labels per card question, in card order).

    Returns "resolved", "no_pending" (nothing was waiting — the card is a stale
    replay, so the caller should fall back to sending a normal message), or
    "failed" (the question existed but the Gateway refused//errored).
    """
    if not session_key:
        return "no_pending"
    try:
        listing = await bridge.gateway_call("question.list", {})
    except Exception:  # noqa: BLE001 - gateway down/slow must not eat the answer
        log.warning("question.list failed for %s", session_key, exc_info=True)
        return "failed"
    pending = _pending_for(listing.get("questions") or [], session_key)
    if not pending:
        return "no_pending"

    # Zip by position: the card renders the question list in the order the tool
    # submitted it, which is the order the Gateway record preserves. Anything
    # the user left unanswered resolves as an empty list (the Gateway's own
    # "skip"), so a short/ragged selections array can never shift answers onto
    # the wrong question.
    answers = {}
    for i, q in enumerate(pending.get("questions") or []):
        qid = (q or {}).get("questionId")
        if not qid:
            continue
        sel = selections[i] if i < len(selections) else []
        if isinstance(sel, str):
            sel = [sel]
        answers[qid] = [str(s) for s in (sel or []) if str(s).strip()]

    try:
        await bridge.gateway_call("question.resolve", {
            "id": pending.get("id"),
            "answers": {"answers": answers},
            "resolvedBy": "workspace-card",
        })
    except Exception:  # noqa: BLE001
        log.warning("question.resolve failed for %s", pending.get("id"), exc_info=True)
        return "failed"
    return "resolved"


def resolve_pending_sync(session_key: str, selections: list) -> str:
    """Blocking wrapper, for callers outside an event loop (tests, scripts)."""
    return asyncio.run(resolve_pending(session_key, selections))
