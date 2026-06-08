# Native Unified Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the triage-dashboard proxy with native Python collectors (gmail/slack/asana/obsidian) behind `/api/items`, add triage actions + "Hand to Gary", and give the feed its first UI tab — then decommission the dashboard.

**Architecture:** `backend/inbox.py` becomes a `backend/inbox/` package: one module per source exposing a cached `fetch()` plus pure, unit-testable mappers; a router that merges concurrently with per-source error isolation; local dismiss/snooze state in `.data/inbox-state.json`. UI is a self-contained overlay tab (`frontend-overrides/js/inbox.js`), same pattern as the Cron tab.

**Tech Stack:** FastAPI + httpx (already deps), himalaya CLI (gmail), macOS keychain via `security` (slack mark-read), Asana REST (PAT), vanilla-JS overlay frontend. Spec: `docs/superpowers/specs/2026-06-05-native-inbox-design.md`.

**Conventions for every task:** run tests with `.venv/bin/python -m pytest backend/tests/ -q` from `~/openclaw-workspace`. The live app is launchd job `ai.openclaw.workspace` (restart: `launchctl kickstart -k gui/501/ai.openclaw.workspace`; logs `/tmp/openclaw-workspace.launchd.err.log`). Item shape everywhere: `{id, source, title, subtitle, snippet, ts(ms), ageHours, score, meta{...}, actions[...]}`.

---

### Task 1: Convert `backend/inbox.py` into the `backend/inbox/` package (behavior unchanged)

`backend/inbox.py` and `backend/inbox/` can't coexist; move the proxy verbatim into the package so the app keeps working while sources land.

**Files:**
- Delete: `backend/inbox.py`
- Create: `backend/inbox/__init__.py` (old file's content, unchanged)
- Create: `backend/inbox/sources/__init__.py` (empty)

- [ ] **Step 1: Move the module**

```bash
cd ~/openclaw-workspace
mkdir -p backend/inbox/sources
git mv backend/inbox.py backend/inbox/__init__.py
touch backend/inbox/sources/__init__.py
```

- [ ] **Step 2: Verify the app still imports and tests pass**

Run: `.venv/bin/python -c "from backend.app import app; print('ok')" && .venv/bin/python -m pytest backend/tests/ -q`
Expected: `ok`, all tests pass (27 as of writing). `from .inbox import router as inbox_router` in `app.py` resolves identically for a package.

- [ ] **Step 3: Commit**

```bash
git add -A backend/inbox.py backend/inbox/
git commit -m "refactor(inbox): convert inbox.py to a package (proxy unchanged)"
```

---

### Task 2: Local triage state — `backend/inbox/state.py`

Dismissed/snoozed/reviewed state, atomic JSON file, snooze expiry. Port of the dashboard's `dismissed.js` semantics, keyed `"{source}:{id}"`.

**Files:**
- Create: `backend/inbox/state.py`
- Test: `backend/tests/test_inbox_state.py`

- [ ] **Step 1: Write the failing tests**

```python
"""Unit tests for the Inbox local triage state store."""
import importlib

from backend.inbox import state


def _fresh(tmp_path, monkeypatch):
    monkeypatch.setattr(state, "STATE_FILE", tmp_path / "inbox-state.json")
    state._mem = None  # drop cache so each test starts clean
    return state


def test_dismiss_hides_forever(tmp_path, monkeypatch):
    s = _fresh(tmp_path, monkeypatch)
    assert not s.hidden("gmail", "abc", now_ms=1000)
    s.dismiss("gmail", "abc", "archived")
    assert s.hidden("gmail", "abc", now_ms=1000)
    assert s.hidden("gmail", "abc", now_ms=10**15)  # forever


def test_snooze_hides_until_expiry(tmp_path, monkeypatch):
    s = _fresh(tmp_path, monkeypatch)
    s.snooze("asana", "t1", until_ms=5000)
    assert s.hidden("asana", "t1", now_ms=4999)
    assert not s.hidden("asana", "t1", now_ms=5001)  # expired -> visible again
    # expiry is sticky: the expired entry was cleaned up
    assert "asana:t1" not in s._load().get("snoozed", {})


def test_state_persists_across_reload(tmp_path, monkeypatch):
    s = _fresh(tmp_path, monkeypatch)
    s.dismiss("slack", "m1")
    s._mem = None  # simulate process restart
    assert s.hidden("slack", "m1", now_ms=0)


def test_sources_do_not_collide(tmp_path, monkeypatch):
    s = _fresh(tmp_path, monkeypatch)
    s.dismiss("gmail", "x")
    assert not s.hidden("slack", "x", now_ms=0)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest backend/tests/test_inbox_state.py -q`
Expected: FAIL — `module 'backend.inbox.state' not found` / attribute errors.

- [ ] **Step 3: Implement `backend/inbox/state.py`**

```python
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
    _mem.setdefault("dismissed", {})
    _mem.setdefault("snoozed", {})
    return _mem


def _save() -> None:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest backend/tests/test_inbox_state.py -q`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/inbox/state.py backend/tests/test_inbox_state.py
git commit -m "feat(inbox): local dismiss/snooze state store"
```

---

### Task 3: Obsidian source — `backend/inbox/sources/obsidian.py`

Pure-filesystem source, no creds — port of `api/obsidian.js`'s regex extraction (granola LLM-cache extraction is **deliberately dropped**: its cache was only refreshed by the dashboard; the regex patterns still catch explicit action/follow-up sections in those notes).

**Files:**
- Create: `backend/inbox/sources/obsidian.py`
- Test: `backend/tests/test_inbox_obsidian.py`

- [ ] **Step 1: Write the failing tests**

```python
"""Unit tests for the obsidian meeting-notes collector (pure parts)."""
from backend.inbox.sources import obsidian

NOTE = """# 2026-06-01 Sync with Taylor

Some discussion text.

## Action items
- Frank: send the Q3 deck to legal
- Taylor - review the launch checklist
- ship the new pricing page

## Notes
- [ ] follow up on the analytics bug
- random bullet that is not in an action section
Follow-up: schedule the retro
"""


def test_extracts_actions_with_kinds():
    actions = obsidian.extract_actions(NOTE)
    by_text = {a["text"]: a["kind"] for a in actions}
    assert by_text["send the Q3 deck to legal"] == "action-frank"
    assert by_text["review the launch checklist"] == "action-other"
    assert by_text["ship the new pricing page"] == "action"
    assert by_text["follow up on the analytics bug"] == "unchecked-todo"
    assert by_text["schedule the retro"] == "follow-up"
    assert "random bullet that is not in an action section" not in by_text


def test_short_or_decorative_lines_are_skipped():
    assert obsidian.extract_actions("## Action items\n- ok\n- [[link]]\n") == []


def test_map_items_scores_and_shapes():
    actions = obsidian.extract_actions(NOTE)
    now = 10**12
    file_ts = now - 2 * 3600_000  # 2h old -> recency bonus +2
    items = obsidian.map_items("2026-06-01 Sync.md", "/v/2026-06-01 Sync.md",
                               actions, file_ts, now_ms=now)
    frank = next(i for i in items if i["meta"]["kind"] == "action-frank")
    assert frank["source"] == "obsidian"
    assert frank["score"] == 1 + 4 + 2          # base + action-frank + <24h
    assert frank["subtitle"] == "2026-06-01 Sync"
    assert frank["meta"]["url"].startswith("obsidian://open?path=")
    assert frank["actions"] == ["reviewed", "dismiss", "snooze"]
    # dedup: identical ids are stable hashes
    assert len({i["id"] for i in items}) == len(items)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest backend/tests/test_inbox_obsidian.py -q`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `backend/inbox/sources/obsidian.py`**

```python
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

VAULT = Path(os.environ.get("INBOX_MEETINGS_DIR", "/Users/admin/obsidian/Meetings"))
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
_KIND_SCORE = {"unchecked-todo": 2, "action": 3, "action-frank": 4,
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
        if not line.strip():
            continue
        if in_section:
            am = _ASSIGNEE_RE.match(line)
            if am:
                assignee, text = am.group(1).strip(), am.group(2).strip()
                if _real_action(text):
                    frank = re.match(r"^frank\b", assignee, re.I) or \
                        re.search(r"\bteam\b", assignee, re.I)
                    out.append({"kind": "action-frank" if frank else "action-other",
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
            "snippet": a["kind"], "ts": int(file_ts), "ageHours": age_h,
            "score": score,
            "meta": {"file": name, "line": a["line"], "kind": a["kind"],
                     "fullText": a["text"], "assignee": a.get("assignee"),
                     "url": "obsidian://open?path="
                            + urllib.parse.quote(file_path, safe="")},
            "actions": ["reviewed", "dismiss", "snooze"],
        })
    return items


async def fetch() -> list[dict]:
    """All recent meeting-note actions, score-sorted. Sync FS work is fast
    (one folder, ~120-day window) — fine on the event loop."""
    now_ms = int(time.time() * 1000)
    cutoff = now_ms - WINDOW_DAYS * 24 * 3600_000
    items: list[dict] = []
    if not VAULT.is_dir():
        return items
    for p in sorted(VAULT.iterdir()):
        if not (p.is_file() and p.name.endswith(".md")):
            continue
        m = _FILENAME_DATE_RE.match(p.name)
        file_ts = (time.mktime(time.strptime(m.group(0), "%Y-%m-%d")) * 1000
                   if m else p.stat().st_mtime * 1000)
        if file_ts < cutoff:
            continue
        try:
            actions = extract_actions(p.read_text(encoding="utf-8"))
        except OSError:
            continue
        if actions:
            items.extend(map_items(p.name, str(p), actions, file_ts, now_ms))
    items.sort(key=lambda i: (-i["score"], i["ageHours"]))
    return items
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest backend/tests/test_inbox_obsidian.py -q`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/inbox/sources/obsidian.py backend/tests/test_inbox_obsidian.py
git commit -m "feat(inbox): obsidian meeting-notes collector"
```

---

### Task 4: Gmail source — `backend/inbox/sources/gmail.py`

Himalaya-backed (NOT googleapis): list INBOX envelopes, keep unread + flagged, score like the old collector. Actions reuse `email_himalaya`'s existing archive/mark-read.

**Files:**
- Create: `backend/inbox/sources/gmail.py`
- Test: `backend/tests/test_inbox_gmail.py`

- [ ] **Step 1: Write the failing tests**

```python
"""Unit tests for the gmail (himalaya) collector's pure mapper."""
from backend.inbox.sources import gmail

NOW = 10**12


def _env(uid="101", subject="Hello", name="Ada", addr="ada@example.com",
         flags=(), age_h=1.0):
    return {"id": uid, "subject": subject,
            "from": {"name": name, "addr": addr},
            "flags": list(flags), "has_attachment": False,
            "date": gmail._iso_from_ms(NOW - int(age_h * 3600_000))}


def test_unread_external_recent_scores_high():
    items = gmail.map_items([_env()], now_ms=NOW)  # unread, external, 1h old
    assert len(items) == 1
    it = items[0]
    assert it["score"] == 3 + 2 + 1   # unread + <6h + external
    assert it["source"] == "gmail"
    assert it["subtitle"] == "Ada"
    assert it["meta"]["uid"] == "101"
    assert it["actions"] == ["archive", "dismiss", "snooze"]


def test_read_unflagged_mail_is_skipped():
    items = gmail.map_items([_env(flags=["Seen"])], now_ms=NOW)
    assert items == []


def test_read_but_flagged_mail_is_kept_with_important_bonus():
    items = gmail.map_items([_env(flags=["Seen", "Flagged"])], now_ms=NOW)
    assert len(items) == 1
    assert items[0]["score"] == 2 + 2 + 1  # important + <6h + external


def test_internal_sender_gets_no_external_bonus():
    items = gmail.map_items([_env(addr="taylor@example.com")], now_ms=NOW)
    assert items[0]["score"] == 3 + 2  # unread + <6h
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest backend/tests/test_inbox_gmail.py -q`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `backend/inbox/sources/gmail.py`**

```python
"""Gmail inbox items via himalaya (same CLI + account as the Email tab).

Keeps unread and flagged INBOX envelopes; scoring ports the old triage
heuristics: unread+3, important(Flagged)+2, <6h+2 / <24h+1, external sender+1.
meta.url is intentionally absent — himalaya envelopes carry no Message-ID, so
the UI lazily resolves the Gmail deep link via /api/email/read/{uid}
(mark_seen=false) on Open."""
from __future__ import annotations

import os
import time
from datetime import datetime, timezone

from ... import himalaya_cli

INTERNAL_DOMAIN = os.environ.get("INBOX_INTERNAL_DOMAIN", "example.com")
LIST_SIZE = int(os.environ.get("INBOX_GMAIL_LIST", "50"))


def _iso_from_ms(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()


def _ts_ms(date_str: str) -> int:
    try:
        return int(datetime.fromisoformat(date_str).timestamp() * 1000)
    except (ValueError, TypeError):
        return int(time.time() * 1000)


def map_items(envelopes: list[dict], now_ms: int) -> list[dict]:
    items = []
    for env in envelopes:
        flags = env.get("flags") or []
        unread = "Seen" not in flags
        important = "Flagged" in flags
        if not unread and not important:
            continue
        frm = env.get("from") or {}
        addr = frm.get("addr") or frm.get("address") or ""
        name = frm.get("name") or addr
        ts = _ts_ms(env.get("date") or "")
        age_h = max(0.0, (now_ms - ts) / 3600_000)
        score = 0
        if unread:
            score += 3
        if important:
            score += 2
        if age_h < 6:
            score += 2
        elif age_h < 24:
            score += 1
        if addr and not addr.lower().endswith(f"@{INTERNAL_DOMAIN}"):
            score += 1
        items.append({
            "id": str(env.get("id", "")), "source": "gmail",
            "title": env.get("subject") or "(no subject)",
            "subtitle": name, "snippet": "",
            "ts": ts, "ageHours": age_h, "score": score,
            "meta": {"uid": str(env.get("id", "")), "from": addr,
                     "unread": unread, "important": important},
            "actions": ["archive", "dismiss", "snooze"],
        })
    items.sort(key=lambda i: (-i["score"], i["ageHours"]))
    return items


async def fetch() -> list[dict]:
    data = await himalaya_cli.run_json(
        ["envelope", "list", "-f", "INBOX", "-s", str(LIST_SIZE)])
    envs = data if isinstance(data, list) else (data.get("envelopes") or [])
    return map_items(envs, now_ms=int(time.time() * 1000))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest backend/tests/test_inbox_gmail.py -q`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/inbox/sources/gmail.py backend/tests/test_inbox_gmail.py
git commit -m "feat(inbox): gmail collector via himalaya"
```

---

### Task 5: Slack source — `backend/inbox/sources/slack.py`

Reads the signals snapshot `ai.openclaw.slack-refresh` maintains; staleness kicks that job. `mark_read` posts `conversations.mark` with keychain xoxc/xoxd (the workspace is a GUI-session LaunchAgent, so keychain access works — the dashboard relied on the same).

**Files:**
- Create: `backend/inbox/sources/slack.py`
- Test: `backend/tests/test_inbox_slack.py`

- [ ] **Step 1: Write the failing tests**

```python
"""Unit tests for the slack collector's pure parts (CSV parse + scoring)."""
from backend.inbox.sources import slack

NOW = 10**12
ISO = "2026-06-05T10:00:00Z"
ROW = ('1780670000.123456,U0123ABCD,taylor,Taylor Corrado,#general,,'
       '"hey @frank can you look at the player bug?",' + ISO + ',0,')
DM_ROW = ('1780670001.654321,U0456EFGH,jed,Jed L,D024MDM,,'
          '"quick question about quotas",' + ISO + ',0,')


def test_parse_csv_lines_extracts_fields():
    rows = slack.parse_csv_lines(ROW)
    assert len(rows) == 1
    r = rows[0]
    assert r["msgId"] == "1780670000.123456"
    assert r["realName"] == "Taylor Corrado"
    assert r["channel"] == "#general"
    assert r["text"] == "hey @frank can you look at the player bug?"


def test_low_signal_rows_are_dropped():
    assert slack.is_low_signal({"userName": "asana", "text": "task updated"})
    assert slack.is_low_signal({"userName": "x", "text": ":tada: :tada:"})
    assert slack.is_low_signal({"userName": "x", "text": "ok"})
    assert not slack.is_low_signal({"userName": "x", "text": "can you review this?"})


def test_map_items_scores_mentions_and_dms():
    unreads = slack.parse_csv_lines(DM_ROW)
    mentions = slack.parse_csv_lines(ROW)
    for m in unreads + mentions:
        m["time"] = NOW - 3600_000  # 1h old -> +2 recency
    items = slack.map_items(unreads, mentions, handle_map={}, now_ms=NOW)
    by_id = {i["id"]: i for i in items}
    assert by_id["1780670000.123456"]["score"] == 5 + 2        # mention + <2h
    assert by_id["1780670001.654321"]["score"] == 2 + 2 + 1    # unread + <2h + DM
    assert by_id["1780670000.123456"]["actions"] == ["mark_read", "dismiss", "snooze"]


def test_channel_url_built_from_handle_map():
    mentions = slack.parse_csv_lines(ROW)
    mentions[0]["time"] = NOW
    items = slack.map_items([], mentions, handle_map={"#general": "C0GEN"}, now_ms=NOW)
    assert items[0]["meta"]["url"] == \
        "https://example.slack.com/archives/C0GEN/p1780670000123456"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest backend/tests/test_inbox_slack.py -q`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `backend/inbox/sources/slack.py`**

```python
"""Slack mentions/unreads from the slack-refresh snapshot.

The launchd job `ai.openclaw.slack-refresh` (independent of the dead triage
dashboard) writes `~/.openclaw/workspace/tmp/slack_recent_signals.json` with
CSV blobs (`unreads_raw`, `mentions_raw`). We parse those; if the snapshot is
stale we kick the refresh job (non-blocking) and still serve the stale rows.
Only `mark_read` talks to Slack directly — conversations.mark with the
browser-session tokens in the login keychain (xoxc token + xoxd cookie)."""
from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import time
from pathlib import Path

import httpx

from ... import config

SIGNALS_PATH = Path(os.environ.get(
    "INBOX_SLACK_SIGNALS",
    str(config.OPENCLAW_HOME / "workspace/tmp/slack_recent_signals.json")))
CHANNELS_CACHE = Path(os.environ.get(
    "INBOX_SLACK_CHANNELS",
    str(config.OPENCLAW_HOME / "workspace/var/slack-channels.cache.json")))
SLACK_DOMAIN = os.environ.get("SLACK_DOMAIN", "example.slack.com")
STALE_MIN = int(os.environ.get("SLACK_STALE_MIN", str(24 * 60)))
REFRESH_JOB = "ai.openclaw.slack-refresh"

# Row: TS,UserID,userName,RealName,Channel,ThreadTs,Text...,ISO time,reactions,
_ROW_RE = re.compile(
    r"(\d{10}\.\d{3,7}),(U[A-Z0-9]+),([^,]*),([^,]*),([^,]*),([^,]*),"
    r"([\s\S]*?),(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z),([^,]*),")


def parse_csv_lines(blob: str | None) -> list[dict]:
    out = []
    for m in _ROW_RE.finditer(blob or ""):
        msg_id, user_id, user, real, channel, thread_ts, raw_text, iso, _ = m.groups()
        text = raw_text
        if text.startswith('"') and text.endswith('"'):
            text = text[1:-1].replace('""', '"')
        text = re.sub(r"'\s*\+\s*\n?\s*'", "", text)
        text = text.replace("\\n", "\n").replace("\\'", "'").strip()
        out.append({"msgId": msg_id, "userId": user_id, "userName": user,
                    "realName": real, "channel": channel,
                    "threadTs": thread_ts or None, "text": text,
                    "time": int(time.mktime(
                        time.strptime(iso, "%Y-%m-%dT%H:%M:%SZ")) * 1000)})
    return out


def is_low_signal(msg: dict) -> bool:
    text = msg.get("text") or ""
    if msg.get("userName") == "asana":
        return True
    if re.fullmatch(r"(:[a-z0-9_-]+:\s*)+", text):
        return True
    if len(text) < 4:
        return True
    return bool(re.fullmatch(r"https?:\S+\s*-\s*https?:\S+", text.strip()))


def map_items(unreads: list[dict], mentions: list[dict],
              handle_map: dict, now_ms: int) -> list[dict]:
    seen: dict[str, dict] = {}
    for m in unreads:
        seen[m["msgId"]] = {**m, "kind": "unread"}
    for m in mentions:
        seen[m["msgId"]] = {**seen.get(m["msgId"], m), "kind": "mention"}
    items = []
    for m in seen.values():
        if is_low_signal(m):
            continue
        age_h = max(0.0, (now_ms - m["time"]) / 3600_000)
        score = 5 if m["kind"] == "mention" else 2
        if age_h < 2:
            score += 2
        elif age_h < 12:
            score += 1
        if m["channel"].startswith(("D", "@")):
            score += 1
        cid = handle_map.get(m["channel"])
        ts_compact = m["msgId"].replace(".", "")
        url = (f"https://{SLACK_DOMAIN}/archives/{cid}/p{ts_compact}"
               + (f"?thread_ts={m['threadTs']}&cid={cid}" if m["threadTs"] else "")
               ) if cid else None
        items.append({
            "id": m["msgId"], "source": "slack",
            "title": m["text"][:200],
            "subtitle": f"{m['realName'] or m['userName']} · {m['channel']}"
                        + (" · @mention" if m["kind"] == "mention" else ""),
            "snippet": m["kind"], "ts": m["time"], "ageHours": age_h,
            "score": score,
            "meta": {"channel": m["channel"], "channelId": cid,
                     "threadTs": m["threadTs"], "kind": m["kind"], "url": url},
            "actions": ["mark_read", "dismiss", "snooze"],
        })
    items.sort(key=lambda i: (-i["score"], i["ageHours"]))
    return items


def _handle_map() -> dict:
    try:
        chans = json.loads(CHANNELS_CACHE.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    out = {}
    for c in chans:
        n, cid = c.get("name"), c.get("id")
        if n and cid:
            out[n] = cid
            if n.startswith("@"):
                out["#" + n[1:]] = cid
            elif n.startswith("#"):
                out["@" + n[1:]] = cid
    return out


def signals_stale() -> bool:
    try:
        age_min = (time.time() - SIGNALS_PATH.stat().st_mtime) / 60
        return age_min > STALE_MIN
    except OSError:
        return True


def kick_refresh() -> None:
    """Fire-and-forget kick of the slack-refresh launchd job."""
    subprocess.Popen(
        ["launchctl", "kickstart", f"gui/{os.getuid()}/{REFRESH_JOB}"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


async def fetch() -> list[dict]:
    raw = json.loads(SIGNALS_PATH.read_text())  # OSError/JSONDecodeError -> errors{}
    unreads = parse_csv_lines(raw.get("unreads_raw"))
    mentions = parse_csv_lines(raw.get("mentions_raw"))
    if not unreads and not mentions and raw.get("unreads_raw") in (None, "null"):
        raise RuntimeError(
            "slack signals empty (refresh produced no rows — kicked "
            f"{REFRESH_JOB}; check keychain access)")
    return map_items(unreads, mentions, _handle_map(),
                     now_ms=int(time.time() * 1000))


def _keychain(service: str) -> str | None:
    try:
        out = subprocess.run(
            ["security", "find-generic-password", "-a", "frank",
             "-s", service, "-w"],
            capture_output=True, text=True, timeout=5)
        return out.stdout.strip() or None
    except (subprocess.SubprocessError, OSError):
        return None


async def mark_read(msg_id: str, channel_handle: str) -> None:
    cid = _handle_map().get(channel_handle)
    if not cid:
        raise RuntimeError(f"no channel id for {channel_handle}")
    xoxc, xoxd = await asyncio.gather(
        asyncio.to_thread(_keychain, "openclaw.slack.xoxc"),
        asyncio.to_thread(_keychain, "openclaw.slack.xoxd"))
    if not xoxc or not xoxd:
        raise RuntimeError("slack tokens unavailable (keychain)")
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(
            f"https://{SLACK_DOMAIN}/api/conversations.mark",
            headers={"Cookie": f"d={xoxd}",
                     "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) "
                                   "AppleWebKit/605.1.15"},
            data={"token": xoxc, "channel": cid, "ts": msg_id})
    data = r.json()
    if not data.get("ok"):
        raise RuntimeError(f"slack: {data.get('error') or 'unknown'}")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest backend/tests/test_inbox_slack.py -q`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/inbox/sources/slack.py backend/tests/test_inbox_slack.py
git commit -m "feat(inbox): slack collector from refresh snapshot + keychain mark-read"
```

---

### Task 6: Asana source — `backend/inbox/sources/asana.py`

Direct port of `api/asana.js`: my project's tasks in Backlog/In Progress/Review, due-date scoring, `complete` action. GIDs are the user's stable ids — keep them as env-overridable constants.

**Files:**
- Create: `backend/inbox/sources/asana.py`
- Test: `backend/tests/test_inbox_asana.py`

- [ ] **Step 1: Write the failing tests**

```python
"""Unit tests for the asana collector's pure mapper."""
from backend.inbox.sources import asana

NOW = 10**12
DAY = 24 * 3600_000


def _task(gid="11", name="Ship it", section="In Progress", due_ms=None,
          completed=False):
    return {
        "gid": gid, "name": name, "completed": completed,
        "memberships": [{"section": {"name": section, "gid": "s1"}}],
        "due_at": asana._iso_from_ms(due_ms) if due_ms else None,
        "due_on": None,
        "modified_at": asana._iso_from_ms(NOW - 3600_000),
        "permalink_url": "https://app.asana.com/0/x/11",
        "notes": "some notes",
    }


def test_overdue_in_progress_scores_highest():
    items = asana.map_items([_task(due_ms=NOW - DAY)], now_ms=NOW)
    assert items[0]["score"] == 4 + 4      # In Progress + overdue
    assert items[0]["subtitle"] == "In Progress"
    assert items[0]["actions"] == ["complete", "dismiss", "snooze"]
    assert items[0]["meta"]["url"] == "https://app.asana.com/0/x/11"


def test_backlog_no_due_scores_base():
    items = asana.map_items([_task(section="Backlog")], now_ms=NOW)
    assert items[0]["score"] == 2


def test_completed_and_inactive_sections_skipped():
    assert asana.map_items([_task(completed=True)], now_ms=NOW) == []
    assert asana.map_items([_task(section="Completed")], now_ms=NOW) == []


def test_due_soon_tiers():
    soon = asana.map_items([_task(due_ms=NOW + int(0.5 * DAY))], now_ms=NOW)
    week = asana.map_items([_task(due_ms=NOW + 5 * DAY)], now_ms=NOW)
    assert soon[0]["score"] == 4 + 3       # <1 day
    assert week[0]["score"] == 4 + 1       # <7 days
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest backend/tests/test_inbox_asana.py -q`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `backend/inbox/sources/asana.py`**

```python
"""Asana tasks (my project board) via the REST API + PAT.

Port of triage-dashboard api/asana.js. The PAT lives in
~/.openclaw/workspace/secrets/asana.env (ASANA_PAT=...); GIDs identify the
user's workspace/board and are stable — env-overridable for safety."""
from __future__ import annotations

import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

from ... import config

ENV_PATH = Path(os.environ.get(
    "INBOX_ASANA_ENV", str(config.OPENCLAW_HOME / "workspace/secrets/asana.env")))
PROJECT_GID = os.environ.get("ASANA_PROJECT_GID", "1206273954893328")
ACTIVE_SECTIONS = {"Backlog", "In Progress", "Review"}
BASE = "https://app.asana.com/api/1.0"
_FIELDS = ("name,memberships.section.name,memberships.section.gid,due_on,"
           "due_at,modified_at,created_at,permalink_url,notes,completed")

_token: str | None = None


def _iso_from_ms(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc) \
        .isoformat().replace("+00:00", "Z")


def _ms(iso: str | None) -> int | None:
    if not iso:
        return None
    try:
        return int(datetime.fromisoformat(iso.replace("Z", "+00:00"))
                   .timestamp() * 1000)
    except ValueError:
        return None


def _pat() -> str:
    global _token
    if _token:
        return _token
    m = re.search(r'ASANA_PAT="?([^"\n]+)"?', ENV_PATH.read_text())
    if not m:
        raise RuntimeError("ASANA_PAT not found in asana.env")
    _token = m.group(1).strip()
    return _token


async def _api(method: str, path: str, body: dict | None = None) -> dict:
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.request(
            method, f"{BASE}{path}", json=body,
            headers={"Authorization": f"Bearer {_pat()}",
                     "Accept": "application/json"})
    data = r.json()
    if r.status_code >= 400:
        raise RuntimeError(f"asana {r.status_code}: {data.get('errors') or data}")
    return data


def map_items(tasks: list[dict], now_ms: int) -> list[dict]:
    items = []
    for t in tasks:
        if t.get("completed"):
            continue
        membership = next((m for m in t.get("memberships") or []
                           if m.get("section")), None)
        section = (membership or {}).get("section", {}).get("name") or "Asana"
        if section not in ACTIVE_SECTIONS:
            continue
        due = _ms(t.get("due_at")) or (
            _ms(t["due_on"] + "T17:00:00Z") if t.get("due_on") else None)
        ts = _ms(t.get("modified_at")) or now_ms
        age_h = max(0.0, (now_ms - ts) / 3600_000)
        score = {"In Progress": 4, "Review": 3}.get(section, 2)
        if due is not None:
            days = (due - now_ms) / (24 * 3600_000)
            if days < 0:
                score += 4
            elif days < 1:
                score += 3
            elif days < 3:
                score += 2
            elif days < 7:
                score += 1
        items.append({
            "id": t["gid"], "source": "asana",
            "title": t.get("name") or "(no name)",
            "subtitle": section,
            "snippet": (f"due {datetime.fromtimestamp(due / 1000, tz=timezone.utc).date()}"
                        if due else (t.get("notes") or "")[:120]),
            "ts": ts, "ageHours": age_h, "score": score,
            "meta": {"url": t.get("permalink_url"), "due": due,
                     "section": section},
            "actions": ["complete", "dismiss", "snooze"],
        })
    items.sort(key=lambda i: (-i["score"], i["ageHours"]))
    return items


async def fetch() -> list[dict]:
    data = await _api("GET", f"/projects/{PROJECT_GID}/tasks"
                             f"?completed_since=now&limit=100&opt_fields={_FIELDS}")
    return map_items(data.get("data") or [], now_ms=int(time.time() * 1000))


async def complete(gid: str) -> None:
    await _api("PUT", f"/tasks/{gid}", {"data": {"completed": True}})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest backend/tests/test_inbox_asana.py -q`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/inbox/sources/asana.py backend/tests/test_inbox_asana.py
git commit -m "feat(inbox): asana collector via PAT REST"
```

---

### Task 7: Native router — merge, actions, spinoff (proxy dies here)

**Files:**
- Rewrite: `backend/inbox/__init__.py` (replace the proxy)
- Modify: `backend/config.py` (delete the `TRIAGE_URL` lines — `grep -n TRIAGE backend/config.py`)
- Modify: `backend/app.py:5` README-ish docstring mention of triage proxy (update comment only)
- Test: `backend/tests/test_inbox_router.py`

- [ ] **Step 1: Write the failing tests**

```python
"""Router-level tests: merge, error isolation, hidden filtering, actions."""
import pytest
from httpx import ASGITransport, AsyncClient

import backend.inbox as inbox
from backend.inbox import state


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(state, "STATE_FILE", tmp_path / "state.json")
    state._mem = None

    async def fake_gmail():
        return [{"id": "g1", "source": "gmail", "title": "Mail", "subtitle": "",
                 "snippet": "", "ts": 2, "ageHours": 1.0, "score": 5,
                 "meta": {}, "actions": ["archive", "dismiss", "snooze"]}]

    async def fake_slack():
        raise RuntimeError("signals stale")

    monkeypatch.setitem(inbox.SOURCES, "gmail", fake_gmail)
    monkeypatch.setitem(inbox.SOURCES, "slack", fake_slack)
    monkeypatch.setitem(inbox.SOURCES, "asana", fake_gmail)   # reuse shape
    monkeypatch.setitem(inbox.SOURCES, "obsidian", fake_gmail)

    from backend.app import app
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://t")


@pytest.mark.anyio
async def test_merge_isolates_source_errors(client):
    async with client as c:
        r = await c.get("/api/items?sources=gmail,slack")
    body = r.json()
    assert [i["id"] for i in body["items"]] == ["g1"]
    assert "slack" in body["errors"]
    assert body["sources"] == {"gmail": 1, "slack": 0}


@pytest.mark.anyio
async def test_dismissed_items_filtered_and_action_endpoint(client):
    async with client as c:
        r = await c.post("/api/items/action",
                         json={"source": "gmail", "id": "g1", "action": "dismiss"})
        assert r.json()["ok"] is True
        r2 = await c.get("/api/items?sources=gmail")
    assert r2.json()["items"] == []


@pytest.mark.anyio
async def test_snooze_requires_until(client):
    async with client as c:
        r = await c.post("/api/items/action",
                         json={"source": "gmail", "id": "g1", "action": "snooze"})
    assert r.status_code == 400


@pytest.mark.anyio
async def test_unknown_action_rejected(client):
    async with client as c:
        r = await c.post("/api/items/action",
                         json={"source": "gmail", "id": "g1", "action": "explode"})
    assert r.status_code == 400
```

Note: if `pytest.mark.anyio` isn't configured in this repo, add at the top of the test file:

```python
@pytest.fixture
def anyio_backend():
    return "asyncio"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest backend/tests/test_inbox_router.py -q`
Expected: FAIL — `inbox.SOURCES` doesn't exist yet (module still holds the proxy).

- [ ] **Step 3: Rewrite `backend/inbox/__init__.py`**

```python
"""Unified Inbox: native collectors merged behind /api/items.

Replaces the triage-dashboard proxy (the dashboard was a wedged pre-alpha;
decision + design in docs/superpowers/specs/2026-06-05-native-inbox-design.md).
Each source fetches concurrently with per-source error isolation; local
dismiss/snooze state filters the merge. Response keeps the dashboard's shape:
{items, total, sources: {name: count}, errors: {name: msg}, generatedAt}."""
from __future__ import annotations

import asyncio
import time

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from .. import email_himalaya, sessions_store
from ..research import _agent_turn
from . import state
from .sources import asana, gmail, obsidian, slack

router = APIRouter()

SOURCES = {
    "gmail": gmail.fetch,
    "slack": slack.fetch,
    "asana": asana.fetch,
    "obsidian": obsidian.fetch,
}

# Per-source 60s cache: (ts_ms, items). Cleared by actions on that source.
_cache: dict[str, tuple[float, list]] = {}
CACHE_TTL_MS = 60_000


async def _fetch_source(name: str) -> list[dict]:
    now = time.time() * 1000
    hit = _cache.get(name)
    if hit and now - hit[0] < CACHE_TTL_MS:
        return hit[1]
    items = await SOURCES[name]()
    _cache[name] = (now, items)
    return items


@router.get("/api/items")
async def items(sources: str = "", limit: int = 200):
    wanted = [s for s in (sources.split(",") if sources else list(SOURCES))
              if s in SOURCES]
    # Slack staleness guard: kick the refresh job, then serve what we have.
    if "slack" in wanted and slack.signals_stale():
        slack.kick_refresh()

    async def safe(name: str):
        try:
            return name, await _fetch_source(name), None
        except Exception as exc:  # noqa: BLE001 - per-source isolation
            return name, [], str(exc)

    results = await asyncio.gather(*(safe(n) for n in wanted))
    now_ms = int(time.time() * 1000)
    merged, errors, counts = [], {}, {}
    for name, src_items, err in results:
        if err:
            errors[name] = err
        visible = [i for i in src_items
                   if not state.hidden(i["source"], i["id"], now_ms)]
        counts[name] = len(visible)
        merged.extend(visible)
    merged.sort(key=lambda i: (-i["score"], i["ageHours"]))
    limit = max(1, min(500, limit))
    return {"items": merged[:limit], "total": len(merged),
            "sources": counts, "errors": errors, "generatedAt": now_ms}


def _bad(msg: str):
    return JSONResponse(status_code=400, content={"ok": False, "error": msg})


@router.post("/api/items/action")
async def action(payload: dict):
    source = payload.get("source")
    item_id = str(payload.get("id") or "")
    act = payload.get("action")
    meta = payload.get("meta") or {}
    if source not in SOURCES or not item_id:
        return _bad("source and id are required")
    try:
        if act == "dismiss":
            state.dismiss(source, item_id)
        elif act == "snooze":
            until = payload.get("until")
            if not isinstance(until, (int, float)) or until <= 0:
                return _bad("snooze requires until (epoch ms)")
            state.snooze(source, item_id, int(until))
        elif act == "reviewed" and source == "obsidian":
            state.dismiss(source, item_id, "reviewed")
        elif act == "archive" and source == "gmail":
            await email_himalaya.archive(item_id)        # same path as Email tab
            state.dismiss(source, item_id, "archived")
        elif act == "mark_read" and source == "slack":
            await slack.mark_read(item_id, meta.get("channel") or "")
            state.dismiss(source, item_id, "mark_read")
        elif act == "complete" and source == "asana":
            await asana.complete(item_id)
            state.dismiss(source, item_id, "completed")
        else:
            return _bad(f"unknown action '{act}' for source '{source}'")
    except Exception as exc:  # noqa: BLE001 - surface to the card toast
        return JSONResponse(status_code=502,
                            content={"ok": False, "error": str(exc)})
    _cache.pop(source, None)
    return {"ok": True}


@router.post("/api/items/spinoff")
async def spinoff(payload: dict):
    """'Hand to Gary': mint a chat session seeded with the item (the client
    sends the rendered card fields). Same awaited-seed pattern as
    research.spinoff."""
    item = payload.get("item") or {}
    title = (item.get("title") or "").strip()
    if not title:
        return _bad("item.title is required")
    sess = sessions_store.create(name=f"Inbox: {title[:48]}")
    seed = ("Context for this conversation — an item from my unified inbox "
            f"({item.get('source', '?')}):\n\nTitle: {title}\n"
            f"From/where: {item.get('subtitle', '')}\n"
            f"Details: {item.get('snippet', '')}\n"
            f"Link: {(item.get('meta') or {}).get('url') or 'n/a'}\n\n"
            "Reply with one short sentence confirming you have the context; "
            "the user will say what they need next.")
    try:
        await asyncio.wait_for(_agent_turn(seed, sess["sessionKey"], None),
                               timeout=120)
    except Exception as exc:  # noqa: BLE001
        sessions_store.delete(sess["id"])
        return JSONResponse(status_code=502,
                            content={"detail": f"could not seed the chat: {exc}"})
    return {"session_id": sess["id"]}
```

- [ ] **Step 4: Remove `TRIAGE_URL` from `backend/config.py`**

Delete these lines (find with `grep -n TRIAGE backend/config.py`):

```python
# Existing triage-dashboard (unified inbox feed). Proxied for the Inbox tab.
TRIAGE_URL = os.environ.get("TRIAGE_URL", "http://127.0.0.1:3456")
```

Also update the `app.py` module docstring line `- /api/items → the triage-dashboard unified inbox feed (proxy, v1)` to `- /api/items → native unified inbox (gmail/slack/asana/obsidian collectors)`.

- [ ] **Step 5: Run the full suite**

Run: `.venv/bin/python -m pytest backend/tests/ -q`
Expected: all pass (including the 4 new router tests). `grep -rn TRIAGE_URL backend/` returns nothing.

- [ ] **Step 6: Commit**

```bash
git add backend/inbox/__init__.py backend/config.py backend/app.py backend/tests/test_inbox_router.py
git commit -m "feat(inbox): native /api/items merge + actions + Hand-to-Gary spinoff"
```

---

### Task 8: The Inbox tab — `frontend-overrides/js/inbox.js` + styles + injection

Self-contained overlay (same contract as cron.js: build own DOM, inject `#rail-inbox` into `#icon-rail`). Remember: NEVER edit files under `frontend/` except via the override mirror — `frontend/` is rsync-clobbered.

**Files:**
- Create: `frontend-overrides/js/inbox.js`
- Modify: `frontend-overrides/workspace.css` (append the Inbox section)
- Modify: `scripts/sync-frontend.sh` (inject inbox.js after the cron.js block)
- Modify (mirror): copy `inbox.js` to `frontend/js/inbox.js` + add the script tag to `frontend/index.html` (what sync would do)

- [ ] **Step 1: Write `frontend-overrides/js/inbox.js`**

```javascript
/* OpenClaw Workspace — unified Inbox tab (overlay add-on).
 *
 * Renders /api/items (gmail/slack/asana/obsidian collectors) as a triage
 * queue: per-source primary action, dismiss, snooze presets, open deep-link,
 * and "Hand to Gary" (seeds a chat session via /api/items/spinoff).
 * Self-contained like cron.js: injects #rail-inbox + its own modal, themed
 * via the SPA's CSS vars, survives Gary updates as long as #icon-rail exists.
 */
(function () {
  'use strict';
  const API = window.location.origin;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const ICON =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M22 12h-6l-2 3h-4l-2-3H2"/>' +
    '<path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>';

  const PRIMARY = {  // per-source primary action: [action, label]
    gmail: ['archive', 'Archive'],
    slack: ['mark_read', 'Mark read'],
    asana: ['complete', 'Complete'],
    obsidian: ['reviewed', 'Reviewed'],
  };
  const SNOOZES = () => {
    const now = new Date();
    const later = new Date(now); later.setHours(now.getHours() + 4);
    const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    const nextWeek = new Date(tomorrow); nextWeek.setDate(tomorrow.getDate() + 7);
    return [['Later today', later], ['Tomorrow', tomorrow], ['Next week', nextWeek]];
  };

  let _modal = null, _items = [], _errors = {}, _counts = {}, _filter = null;

  function ageLabel(h) {
    if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
    if (h < 48) return `${Math.round(h)}h`;
    return `${Math.round(h / 24)}d`;
  }

  function buildModal() {
    if (_modal) return _modal;
    const overlay = document.createElement('div');
    overlay.id = 'inbox-modal';
    overlay.className = 'cron-modal-overlay';   // reuse modal chrome styles
    overlay.style.display = 'none';
    overlay.innerHTML =
      '<div class="cron-modal-card inbox-card" role="dialog" aria-label="Inbox">' +
      '  <div class="cron-modal-head">' +
      '    <span class="cron-modal-title">Inbox</span>' +
      '    <span class="inbox-chips" id="inbox-chips"></span>' +
      '    <button class="inbox-refresh" id="inbox-refresh" title="Refresh">&#x21bb;</button>' +
      '    <button class="cron-modal-close" id="inbox-close" title="Close">&#x2715;</button>' +
      '  </div>' +
      '  <div class="cron-modal-body" id="inbox-body"></div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    $('#inbox-close', overlay).addEventListener('click', close);
    $('#inbox-refresh', overlay).addEventListener('click', () => load(true));
    _modal = overlay;
    return overlay;
  }

  function open() {
    buildModal().style.display = 'flex';
    document.addEventListener('keydown', onEsc);
    load(false);
  }
  function close() {
    if (_modal) _modal.style.display = 'none';
    document.removeEventListener('keydown', onEsc);
  }
  function onEsc(e) { if (e.key === 'Escape') close(); }

  async function load(force) {
    const body = $('#inbox-body');
    if (body && !_items.length) body.innerHTML = '<div class="cron-empty">Loading…</div>';
    try {
      const r = await fetch(`${API}/api/items?limit=200${force ? '&_=' + Date.now() : ''}`,
        { credentials: 'same-origin' });
      const data = await r.json();
      _items = data.items || [];
      _errors = data.errors || {};
      _counts = data.sources || {};
    } catch (e) {
      _items = []; _errors = { inbox: String(e) };
    }
    render();
  }

  function render() {
    renderChips();
    const body = $('#inbox-body');
    if (!body) return;
    const items = _filter ? _items.filter(i => i.source === _filter) : _items;
    if (!items.length) {
      const errs = Object.entries(_errors)
        .map(([s, e]) => `<div class="inbox-error">${esc(s)}: ${esc(e)}</div>`).join('');
      body.innerHTML = `<div class="cron-empty">Inbox zero 🎉</div>${errs}`;
      return;
    }
    body.innerHTML = items.map(cardHtml).join('');
    items.forEach((it) => bindCard(it));
  }

  function renderChips() {
    const chips = $('#inbox-chips');
    if (!chips) return;
    chips.innerHTML = Object.keys(_counts).map((s) => {
      const err = _errors[s] ? ' inbox-chip-err' : '';
      const active = _filter === s ? ' inbox-chip-active' : '';
      const title = _errors[s] ? esc(_errors[s]) : `${_counts[s]} items`;
      return `<button class="inbox-chip email-tag-${s}${err}${active}" ` +
             `data-src="${s}" title="${title}">${s} ${_counts[s] ?? 0}` +
             `${_errors[s] ? ' ⚠' : ''}</button>`;
    }).join('');
    chips.querySelectorAll('.inbox-chip').forEach((b) => {
      b.addEventListener('click', () => {
        _filter = _filter === b.dataset.src ? null : b.dataset.src;
        render();
      });
    });
  }

  function cardHtml(it) {
    const [act, label] = PRIMARY[it.source] || ['dismiss', 'Done'];
    return (
      `<div class="inbox-item" data-id="${esc(it.id)}" data-src="${esc(it.source)}">` +
      `  <div class="inbox-item-main">` +
      `    <div class="inbox-item-title">` +
      `      <span class="email-tag email-tag-${esc(it.source)}">${esc(it.source)}</span>` +
      `      ${esc(it.title)}</div>` +
      `    <div class="inbox-item-sub">${esc(it.subtitle || '')}` +
      `      <span class="inbox-age">· ${ageLabel(it.ageHours)}</span></div>` +
      (it.snippet ? `<div class="inbox-item-snip">${esc(it.snippet)}</div>` : '') +
      `  </div>` +
      `  <div class="inbox-item-actions">` +
      `    <button data-act="${act}" class="inbox-btn inbox-btn-primary">${label}</button>` +
      `    <button data-act="snooze" class="inbox-btn" title="Snooze">⏰</button>` +
      `    <button data-act="open" class="inbox-btn" title="Open">↗</button>` +
      `    <button data-act="gary" class="inbox-btn" title="Hand to Gary">🤖</button>` +
      `    <button data-act="dismiss" class="inbox-btn" title="Dismiss">✕</button>` +
      `  </div>` +
      `</div>`);
  }

  function bindCard(it) {
    const el = $(`.inbox-item[data-id="${CSS.escape(it.id)}"][data-src="${it.source}"]`);
    if (!el) return;
    el.querySelectorAll('.inbox-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === 'open') return openItem(it, btn);
        if (act === 'gary') return handToGary(it, btn);
        if (act === 'snooze') return snoozeMenu(it, btn, el);
        await doAction(it, act, el, btn);
      });
    });
  }

  async function doAction(it, act, el, btn, until) {
    btn.disabled = true;
    try {
      const r = await fetch(`${API}/api/items/action`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: it.source, id: it.id, action: act,
                               until, meta: it.meta || {} }),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || `HTTP ${r.status}`);
      el.style.opacity = '0.3';
      setTimeout(() => { el.remove(); }, 200);
      _items = _items.filter((x) => !(x.id === it.id && x.source === it.source));
      _counts[it.source] = Math.max(0, (_counts[it.source] || 1) - 1);
      renderChips();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '⚠';
      btn.title = String(err.message || err);
    }
  }

  function snoozeMenu(it, btn, el) {
    const existing = $('.inbox-snooze-menu', el);
    if (existing) { existing.remove(); return; }
    const menu = document.createElement('div');
    menu.className = 'inbox-snooze-menu';
    SNOOZES().forEach(([label, when]) => {
      const b = document.createElement('button');
      b.className = 'inbox-btn';
      b.textContent = label;
      b.addEventListener('click', () =>
        doAction(it, 'snooze', el, btn, when.getTime()));
      menu.appendChild(b);
    });
    el.appendChild(menu);
  }

  async function openItem(it, btn) {
    let url = it.meta && it.meta.url;
    if (!url && it.source === 'gmail' && it.meta && it.meta.uid) {
      btn.disabled = true;
      try {
        const r = await fetch(
          `${API}/api/email/read/${encodeURIComponent(it.meta.uid)}?mark_seen=false`,
          { credentials: 'same-origin' });
        const data = await r.json();
        const mid = (data.message_id || '').replace(/^<|>$/g, '');
        if (mid) url = `https://mail.google.com/mail/u/0/#search/rfc822msgid:${encodeURIComponent(mid)}`;
      } catch (_) { /* fall through */ }
      btn.disabled = false;
      if (!url) url = 'https://mail.google.com/mail/u/0/#inbox';
    }
    if (url) window.open(url, '_blank');
  }

  async function handToGary(it, btn) {
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = '…';
    try {
      const r = await fetch(`${API}/api/items/spinoff`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item: it }),
      });
      const data = await r.json();
      if (!r.ok || !data.session_id) throw new Error(data.detail || 'no session');
      window.location.hash = '#' + data.session_id;
      window.location.reload();
    } catch (err) {
      btn.disabled = false; btn.textContent = orig;
      btn.title = 'Failed: ' + String(err.message || err);
    }
  }

  // --- rail button (same injection style as cron.js) ------------------------
  function injectRailButton() {
    const rail = $('#icon-rail');
    if (!rail || $('#rail-inbox')) return;
    const btn = document.createElement('button');
    btn.id = 'rail-inbox';
    btn.className = 'rail-btn';
    btn.title = 'Inbox';
    btn.innerHTML = ICON;
    btn.addEventListener('click', open);
    const cron = $('#rail-cron');
    rail.insertBefore(btn, cron || null);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectRailButton);
  } else {
    injectRailButton();
  }
})();
```

Before committing, check how cron.js actually inserts its rail button (open `frontend-overrides/js/cron.js`, find its equivalent of `injectRailButton`) and mirror its exact class names/placement so the two buttons render identically. Adjust the `rail-btn` class above if cron.js uses something else.

- [ ] **Step 2: Append Inbox styles to `frontend-overrides/workspace.css`**

```css
/* --- Inbox tab (added by frontend-overrides/js/inbox.js) ------------------ */
.inbox-card { width: min(860px, 94vw); }
.inbox-chips { display: flex; gap: 6px; margin-left: 10px; flex-wrap: wrap; }
.inbox-chip {
  border: none; border-radius: 999px; padding: 2px 10px; font-size: 11px;
  cursor: pointer; opacity: 0.75; background: rgba(255, 255, 255, 0.08);
  color: inherit;
}
.inbox-chip-active { outline: 1px solid currentColor; opacity: 1; }
.inbox-chip-err { opacity: 1; }
.inbox-refresh {
  margin-left: auto; background: none; border: none; color: inherit;
  opacity: 0.6; cursor: pointer; font-size: 15px; padding: 4px;
}
.inbox-refresh:hover { opacity: 1; }
.inbox-item {
  display: flex; align-items: flex-start; gap: 10px; position: relative;
  padding: 10px 12px; border-bottom: 1px solid var(--border, rgba(255,255,255,0.07));
}
.inbox-item-main { flex: 1; min-width: 0; }
.inbox-item-title { font-size: 13.5px; line-height: 1.4; }
.inbox-item-title .email-tag { margin-right: 6px; font-size: 10px; }
.inbox-item-sub { font-size: 12px; opacity: 0.65; margin-top: 2px; }
.inbox-item-snip { font-size: 12px; opacity: 0.5; margin-top: 2px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.inbox-age { opacity: 0.6; }
.inbox-item-actions { display: flex; gap: 4px; flex-shrink: 0; }
.inbox-btn {
  background: rgba(255, 255, 255, 0.06); border: none; border-radius: 6px;
  color: inherit; cursor: pointer; font-size: 12px; padding: 4px 8px;
}
.inbox-btn:hover { background: rgba(255, 255, 255, 0.14); }
.inbox-btn-primary { background: rgba(122, 162, 247, 0.22); }
.inbox-snooze-menu {
  position: absolute; right: 10px; top: 38px; z-index: 10; display: flex;
  flex-direction: column; gap: 4px; padding: 6px;
  background: var(--panel, #14181f); border-radius: 8px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
}
.inbox-error { color: #fbbf24; font-size: 12px; padding: 6px 12px; }
@media (max-width: 768px) {
  .inbox-item { flex-direction: column; }
  .inbox-item-actions { align-self: flex-end; }
}
```

- [ ] **Step 3: Add the sync-script injection (after the cron.js block in `scripts/sync-frontend.sh`)**

```bash
  # Inject the Inbox tab add-on once, just before </body> (idempotent).
  SCRIPT_INBOX='<script src="/static/js/inbox.js" defer></script>'
  if [[ -f "$INDEX" ]] && [[ -f "$OVERRIDES/js/inbox.js" ]] \
     && ! grep -qF "js/inbox.js" "$INDEX"; then
    awk -v s="  $SCRIPT_INBOX" '
      { lines[NR] = $0 }
      END {
        for (i = 1; i <= NR; i++) {
          if (!done && lines[i] ~ /<\/body>/) { print s; done = 1 }
          print lines[i]
        }
      }
    ' "$INDEX" > "$INDEX.tmp" && mv "$INDEX.tmp" "$INDEX"
    echo "injected inbox.js <script> into index.html"
  fi
```

- [ ] **Step 4: Mirror into the live frontend (what the sync would do)**

```bash
cd ~/openclaw-workspace
cp frontend-overrides/js/inbox.js frontend/js/inbox.js
cp frontend-overrides/workspace.css frontend/workspace.css
# add the script tag next to cron.js's (line ~2260):
python3 - <<'EOF'
from pathlib import Path
p = Path('frontend/index.html')
html = p.read_text()
if 'js/inbox.js' not in html:
    html = html.replace('<script src="/static/js/cron.js" defer></script>',
        '<script src="/static/js/cron.js" defer></script>\n'
        '  <script src="/static/js/inbox.js" defer></script>')
    p.write_text(html)
    print('injected')
EOF
```

- [ ] **Step 5: Restart + eyeball**

Run: `launchctl kickstart -k gui/501/ai.openclaw.workspace && sleep 6 && curl -s http://127.0.0.1:8800/ | grep -c inbox.js`
Expected: `1`. Then open `http://127.0.0.1:8800` in a browser: rail shows the Inbox tray icon; the modal opens, renders items (or per-source error chips), actions work.

- [ ] **Step 6: Commit**

```bash
git add frontend-overrides/js/inbox.js frontend-overrides/workspace.css scripts/sync-frontend.sh
git commit -m "feat(inbox): Inbox tab UI — cards, filters, actions, Hand to Gary"
```

(`frontend/` is gitignored — the mirror copies don't need staging.)

---

### Task 9: Live smoke test, decommission the triage-dashboard, docs

- [ ] **Step 1: Live smoke pass (all endpoints)**

```bash
# Feed: expect items from >=1 source, per-source errors for any broken ones
curl -s 'http://127.0.0.1:8800/api/items?limit=10' | python3 -m json.tool | head -40
# Snooze + dismiss round-trip on a real item id from above:
curl -s -X POST http://127.0.0.1:8800/api/items/action -H 'Content-Type: application/json' \
  -d '{"source":"obsidian","id":"<ID>","action":"snooze","until":9999999999999}'
curl -s 'http://127.0.0.1:8800/api/items' | grep -c '<ID>'   # expect 0
# Primary actions: archive a real gmail item, complete a THROWAWAY asana task,
# mark-read a slack item — verify in each native app.
# Spinoff:
curl -s -X POST http://127.0.0.1:8800/api/items/spinoff -H 'Content-Type: application/json' \
  -d '{"item":{"source":"obsidian","title":"smoke test item","subtitle":"x","snippet":"y","meta":{}}}'
# expect {"session_id": "..."} and the session visible in the Library
# Error isolation: mv ~/.openclaw/workspace/secrets/asana.env{,.bak}; fetch; expect errors.asana; restore.
```

Expected: every check passes; note results in the commit message.

- [ ] **Step 2: Decommission the triage-dashboard**

```bash
launchctl bootout gui/501/ai.openclaw.triage-dashboard
rm ~/Library/LaunchAgents/ai.openclaw.triage-dashboard.plist
curl -s -m 3 http://127.0.0.1:3456/health || echo "3456 is dark — good"
launchctl print gui/501/ai.openclaw.slack-refresh | grep state   # must still exist
```

Expected: port 3456 dark; slack-refresh untouched. Do NOT delete `~/.openclaw/workspace/triage-dashboard/` (user decides later).

- [ ] **Step 3: Update the spec's status + commit**

Append to `docs/superpowers/specs/2026-06-05-native-inbox-design.md`:

```markdown
## Status

Implemented + live-smoke-tested 2026-06-05 (see plan
`docs/superpowers/plans/2026-06-05-native-inbox.md`). Triage-dashboard launchd
job decommissioned; its directory left on disk.
```

```bash
git add docs/superpowers/specs/2026-06-05-native-inbox-design.md
git commit -m "feat(inbox): live smoke pass + decommission triage-dashboard"
```

---

## Self-review notes (run after drafting — issues found and fixed inline)

- **Spec coverage:** sources×4 ✓ (T3–T6), merge/errors/cache ✓ (T7), actions incl.
  snooze presets ✓ (T7/T8), spinoff ✓ (T7), gmail lazy deep-link ✓ (T8 `openItem`),
  slack staleness kick ✓ (T5/T7), UI tab + filters + PWA ✓ (T8), decommission ✓ (T9),
  TRIAGE_URL removal ✓ (T7).
- **Type consistency:** action names match across sources/router/UI
  (`archive|mark_read|complete|reviewed|dismiss|snooze`); item shape identical in
  all mappers; `state.hidden(source, id, now_ms)` used by router as defined in T2.
- **Known judgment calls:** granola LLM extraction dropped (documented in T3);
  obsidian `add_to_asana` action from the old dashboard not ported (YAGNI — not
  in the approved action model).
