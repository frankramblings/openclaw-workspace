"""Recommended-action layers for the unified Inbox (spec §3-4).

Pure functions; precedence ai > history > heuristic. The AI layer's cache is
filled by /api/items/triage (Task 7); history counters by the router's action
logging; heuristics are static rules. At most ONE rec per item (the chip)."""
from __future__ import annotations

import re

# Actions the chip may execute, per source (also constrains the triage LLM).
ALLOWED = {
    "gmail": {"archive", "delete", "reply", "gary", "none"},
    "slack": {"mark_read", "gary", "none"},
    "asana": {"complete", "gary", "none"},
    "obsidian": {"reviewed", "gary", "none"},
    "documents": {"gary", "none"},
}

_NEWSLETTER_RE = re.compile(
    r"(no-?reply|donotreply|notifications?@|newsletter|mailer-daemon"
    r"|@e\.|@email\.|@mail\.)", re.I)
HISTORY_MIN_TOTAL = 3
HISTORY_MIN_SHARE = 0.8
SLACK_STALE_HOURS = 7 * 24


def counter_key(item: dict) -> str | None:
    meta = item.get("meta") or {}
    if item["source"] == "gmail" and meta.get("from"):
        return f"gmail:{meta['from'].lower()}"
    if item["source"] == "slack" and meta.get("channel"):
        return f"slack:{meta['channel']}"
    return None


def heuristic_rec(item: dict) -> dict | None:
    src = item["source"]
    meta = item.get("meta") or {}
    if src == "gmail" and _NEWSLETTER_RE.search(meta.get("from") or ""):
        return {"action": "archive", "by": "heuristic",
                "reason": "newsletter/notification sender"}
    if (src == "slack" and meta.get("kind") == "unread"
            and item.get("ageHours", 0) > SLACK_STALE_HOURS):
        return {"action": "mark_read", "by": "heuristic",
                "reason": "stale channel chatter"}
    return None


def history_rec(item: dict, stats: dict) -> dict | None:
    key = counter_key(item)
    entry = stats.get(key) if key else None
    if not entry:
        return None
    total = sum(entry.values())
    action, count = max(entry.items(), key=lambda kv: kv[1])
    if total < HISTORY_MIN_TOTAL or count / total < HISTORY_MIN_SHARE:
        return None
    if action not in ALLOWED.get(item["source"], set()):
        return None
    noun = "this sender" if item["source"] == "gmail" else "this channel"
    return {"action": action, "by": "history",
            "reason": f"you did this {count}/{total} times for {noun}"}


def pick(item: dict, stats: dict, ai_recs: dict) -> dict | None:
    """One rec per item: ai > history > heuristic. AI entries with disallowed
    actions or action == 'none' yield no rec (and don't fall through — 'none'
    is the model explicitly saying leave it alone)."""
    ai = ai_recs.get(f"{item['source']}:{item['id']}")
    if ai:
        if ai["action"] != "none" and ai["action"] in ALLOWED.get(item["source"], set()):
            return {"action": ai["action"], "by": "ai",
                    "reason": ai.get("reason") or "",
                    "confidence": ai.get("confidence") or "med"}
        return None
    return history_rec(item, stats) or heuristic_rec(item)
