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
    "obsidian": {"reviewed", "add_asana", "gary", "none"},
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


# --- ✨ triage pass (LLM layer) ------------------------------------------------

import json as _json

TRIAGE_CAP = 120


def build_triage_prompt(items: list[dict], cap: int = TRIAGE_CAP):
    """One prompt for the whole feed. Returns (prompt, included_items) —
    highest-score first when over the cap."""
    chosen = sorted(items, key=lambda i: -i.get("score", 0))[:cap]
    lines = [
        "You triage my unified inbox. For each item decide the single most "
        "likely action I'd take, or \"none\" if it genuinely needs my judgment.",
        "Allowed actions per source — anything else is invalid:",
        "  gmail: archive|delete|reply|gary|none",
        "  slack: mark_read|gary|none",
        "  asana: complete|gary|none",
        "  obsidian: add_asana|reviewed|gary|none",
        "  documents: gary|none",
        "(reply = I should answer this email; gary = hand to my assistant "
        "with context. Prefer archive for newsletters/notifications, delete "
        "for obvious junk, none when unsure.)",
        "",
        "Reply with STRICT JSON only — a single array, no prose, no markdown "
        "fences:",
        '[{"id": "<id>", "action": "<action>", "confidence": "high|med|low", '
        '"reason": "<max 8 words>"}]',
        "For obsidian items prefer add_asana (capture the commitment as a task) "
        "and ALSO return \"task\" (a cleaned imperative ≤12 words) and \"due\" "
        "(YYYY-MM-DD). Honor explicit dates in the text relative to today; if none, "
        "pick a sensible near-term date (≈3 business days out). Use \"reviewed\" "
        "only for pure FYI lines, \"none\" when unsure.",
        "",
        "Items:",
    ]
    for it in chosen:
        lines.append(_json.dumps({
            "id": it["id"], "source": it["source"], "title": it["title"][:120],
            "from": it.get("subtitle", "")[:60], "snippet": (it.get("snippet") or "")[:120],
            "ageHours": round(it.get("ageHours", 0), 1)}, ensure_ascii=False))
    return "\n".join(lines), chosen


def _extract_json_array(text: str) -> list | None:
    """First parseable JSON array in `text`. raw_decode parses exactly one
    value and ignores trailing junk, so prose after the array — or `]` inside
    reason strings — can't break extraction (a bare regex chokes on both)."""
    decoder = _json.JSONDecoder()
    i = text.find("[")
    while i != -1:
        try:
            val, _ = decoder.raw_decode(text, i)
            if isinstance(val, list):
                return val
        except _json.JSONDecodeError:
            pass
        i = text.find("[", i + 1)
    return None


def parse_triage_reply(text: str, valid: dict, now_ms: int) -> dict:
    """valid: {item_id: source}. Returns {\"source:id\": rec} with everything
    invalid dropped (unknown ids, disallowed actions, malformed entries)."""
    arr = _extract_json_array(text or "")
    if arr is None:
        return {}
    out: dict = {}
    for e in arr if isinstance(arr, list) else []:
        if not isinstance(e, dict):
            continue
        iid, action = str(e.get("id") or ""), e.get("action")
        source = valid.get(iid)
        if not source or action not in ALLOWED.get(source, set()):
            continue
        conf = e.get("confidence")
        out[f"{source}:{iid}"] = {
            "action": action,
            "confidence": conf if conf in ("high", "med", "low") else "med",
            "reason": str(e.get("reason") or "")[:80], "ts": now_ms}
        if source == "obsidian":
            task = e.get("task")
            if isinstance(task, str) and task.strip():
                out[f"{source}:{iid}"]["task"] = task.strip()[:140]
            due = e.get("due")
            if isinstance(due, str) and len(due.strip()) >= 8:
                out[f"{source}:{iid}"]["due"] = due.strip()[:10]
    return out
