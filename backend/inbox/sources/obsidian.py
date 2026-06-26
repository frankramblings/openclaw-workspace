"""Meeting-note follow-ups from the Obsidian meetings folder.

Port of triage-dashboard api/obsidian.js: scan recent .md files, pull action
lines (unchecked todos, "Action:"/"Follow-up:" lines, bullets inside an
"Action items"/"Next steps" section), score them, emit inbox items. The old
granola LLM-extraction cache is intentionally not ported — only the dashboard
refreshed it; the regex patterns below still catch explicit action sections.
"""
from __future__ import annotations

import hashlib
import os
import re
import time
import urllib.parse
from pathlib import Path

from .. import settings as _inbox_settings

# VAULT and WINDOW_DAYS resolved via inbox.settings at call time (env still wins).
VAULT = Path(os.environ.get(
    "INBOX_MEETINGS_DIR", str(Path.home() / ".openclaw/workspace/Meetings"))).expanduser()
WINDOW_DAYS = int(os.environ.get("OBSIDIAN_WINDOW_DAYS", "120"))

_FILENAME_DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})")
_SECTION_HEADER_RE = re.compile(r"^\s*#{2,4}\s+(.+?)\s*$")
_ACTION_SECTIONS = re.compile(
    r"^(action items?|next steps?|todos?|to[-\s]?dos?|follow[-\s]?ups?)$", re.I)
_ASSIGNEE_RE = re.compile(
    r"^\s*[-*]\s+([A-Z][a-z]+(?:\s+(?:&|\+|and)\s+[A-Z][a-z]+)?(?:\s+[A-Z]\.?)?)"
    r"\s*[:\-—]\s+(.+)$")
_BULLET_RE = re.compile(r"^\s*[-*]\s+(.+)$")
_ACTION_PATTERNS = [
    (re.compile(r"^\s*[-*]\s*\[\s\]\s+(.+)$", re.I), "unchecked-todo"),
    (re.compile(r"^\s*[-*]?\s*action(?:\s+item)?[:\-]\s*(.+)$", re.I), "action"),
    (re.compile(r"^\s*[-*]?\s*follow[-\s]?up[:\-]\s*(.+)$", re.I), "follow-up"),
    (re.compile(r"^\s*[-*]?\s*(?:todo|to[-\s]?do)[:\-]\s*(.+)$", re.I), "todo"),
]
_KIND_SCORE = {"unchecked-todo": 2, "action": 3, "action-mine": 4,
               "action-other": 1, "follow-up": 2, "todo": 0}


def _real_action(text: str) -> bool:
    stripped = re.sub(r"\[\[[^\]]+\]\]", "", text)
    stripped = re.sub(r"[#*_`>]", "", stripped).strip()
    if len(stripped) < 6:
        return False
    return not re.fullmatch(r"[\s,;:|—-]*", stripped)


def extract_actions(raw: str) -> list[dict]:
    out, in_section = [], False
    for i, line in enumerate(raw.splitlines()):
        header = _SECTION_HEADER_RE.match(line)
        if header:
            in_section = bool(_ACTION_SECTIONS.match(header.group(1).strip()))
            continue
        if not line.strip():  # Blank lines do not end a section (only the next header does)
            continue
        if in_section:
            # Check for unchecked checkbox first
            checkbox_m = _ACTION_PATTERNS[0][0].match(line)
            if checkbox_m:
                text = checkbox_m.group(1).strip()
                if _real_action(text):
                    out.append({"kind": "unchecked-todo", "text": text, "line": i + 1})
                continue
            am = _ASSIGNEE_RE.match(line)
            if am:
                assignee, text = am.group(1).strip(), am.group(2).strip()
                if _real_action(text):
                    owner = _inbox_settings.obsidian_owner_name()
                    mine = bool(re.search(r"\bteam\b", assignee, re.I)) or (
                        bool(owner) and bool(
                            re.match(rf"^{re.escape(owner)}\b", assignee, re.I)))
                    out.append({"kind": "action-mine" if mine else "action-other",
                                "text": text, "line": i + 1, "assignee": assignee})
                continue
            bullet = _BULLET_RE.match(line)
            if bullet:
                text = bullet.group(1).strip()
                if _real_action(text):
                    out.append({"kind": "action", "text": text, "line": i + 1})
                continue
        for pattern, kind in _ACTION_PATTERNS:
            m = pattern.match(line)
            if not m:
                continue
            text = (m.group(1) or "").strip()
            if text and _real_action(text):
                out.append({"kind": kind, "text": text, "line": i + 1})
            break
    return out


def map_items(name: str, file_path: str, actions: list[dict], file_ts: float,
              now_ms: int) -> list[dict]:
    items, seen = [], set()
    for a in actions:
        dedup = re.sub(r"\s+", " ", a["text"].lower())[:80]
        if dedup in seen:
            continue
        seen.add(dedup)
        item_id = hashlib.sha1(
            f"{file_path}:{a['line']}:{a['text']}".encode()).hexdigest()[:12]
        age_h = (now_ms - file_ts) / 3600_000
        score = 1 + _KIND_SCORE.get(a["kind"], 0)
        if age_h < 24:
            score += 2
        elif age_h < 24 * 7:
            score += 1
        items.append({
            "id": item_id, "source": "obsidian",
            "title": a["text"][:140],
            "subtitle": re.sub(r"\.md$", "", name),
            "snippet": a["kind"], "ts": int(file_ts),  # epoch ms — the cross-source item contract is ts(ms)
            "ageHours": age_h,
            "score": score,
            "meta": {"file": name, "line": a["line"], "kind": a["kind"],
                     "fullText": a["text"], "assignee": a.get("assignee"),
                     "url": "obsidian://open?path="
                            + urllib.parse.quote(file_path, safe="")},
            "actions": ["add_asana", "reviewed", "dismiss", "snooze"],
        })
    return items


async def fetch() -> list[dict]:
    """All recent meeting-note actions, score-sorted. Sync FS work is fast
    (one folder, ~120-day window) — fine on the event loop."""
    now_ms = int(time.time() * 1000)
    vault = _inbox_settings.obsidian_vault()
    window_days = _inbox_settings.obsidian_window_days()
    cutoff = now_ms - window_days * 24 * 3600_000
    items: list[dict] = []
    if not vault.is_dir():
        return items
    for p in sorted(vault.iterdir()):
        if not (p.is_file() and p.name.endswith(".md")):
            continue
        try:
            m = _FILENAME_DATE_RE.match(p.name)
            file_ts = (time.mktime(time.strptime(m.group(0), "%Y-%m-%d")) * 1000
                       if m else p.stat().st_mtime * 1000)
            if file_ts < cutoff:
                continue
            actions = extract_actions(p.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError):
            continue
        if actions:
            items.extend(map_items(p.name, str(p), actions, file_ts, now_ms))
    items.sort(key=lambda i: (-i["score"], i["ageHours"]))
    return items
