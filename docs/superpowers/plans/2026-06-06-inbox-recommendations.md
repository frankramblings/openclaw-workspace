# Inbox v2.1 (Delete, Undo, ✨ Recommendations) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a gmail Delete button, a full undo system (toast + 🕒 history drawer), and layered ✨ recommended-action chips (history counters → heuristics → on-demand LLM triage with reply/gary intents) to the native unified Inbox.

**Architecture:** `state.py` grows a history log (undo records) + per-sender stat counters + an AI-recs cache; a new pure module `backend/inbox/recommend.py` computes one rec per item with precedence ai > history > heuristic; the router logs every action, exposes `/api/items/history|undo|triage`, and attaches `rec` to items; `bridge.run_text` on a dedicated session key powers the one-turn triage pass; all UI lands in the existing `frontend-overrides/js/inbox.js` overlay (no new script files → no index.html changes). Spec: `docs/superpowers/specs/2026-06-06-inbox-recommendations-design.md`.

**Tech Stack:** FastAPI, himalaya CLI (gmail moves + subject/from search — header search is NOT supported by himalaya's query language, verified live), Asana REST, `bridge.run_text` (one-shot gateway turn), vanilla-JS overlay.

**Conventions for every task:**
- Run tests with `.venv/bin/python -m pytest backend/tests/ -q` from `~/openclaw-workspace`. Do NOT assert absolute full-suite totals (concurrent sessions add tests); assert per-file counts and "no failures".
- CONCURRENT SESSIONS work in this repo. Before editing any file, `git status --short <file>` — if it's already dirty, STOP and report BLOCKED. Stage explicit paths only; never `git add -A`/`.`.
- Live app: launchd job `ai.openclaw.workspace` (`launchctl kickstart -k gui/501/ai.openclaw.workspace`, logs `/tmp/openclaw-workspace.launchd.err.log`). `frontend/` is gitignored + rsync-clobbered: canonical UI files live in `frontend-overrides/`, mirrored by `cp` in the UI tasks.
- Item shape: `{id, source, title, subtitle, snippet, ts(ms), ageHours, score, meta{...}, actions[...]}`; SOURCES now includes a fifth source `documents` (actions `["dismiss","snooze"]` only).
- Verified-live himalaya facts this plan relies on: `ARCHIVE_FOLDER = "[Gmail]/All Mail"`, `TRASH_FOLDER = "[Gmail]/Trash"` (constants in `email_himalaya.py`); query syntax `'subject "X" and from "Y"'` works; envelope-list subjects may end in a literal `…` (truncated by himalaya) so search strings must strip it.

---

### Task 1: State store — history log, stat counters, recs cache

**Files:**
- Modify: `backend/inbox/state.py`
- Test: `backend/tests/test_inbox_state_v21.py` (new file; existing `test_inbox_state.py` stays untouched)

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_inbox_state_v21.py`:

```python
"""Unit tests for Inbox v2.1 state: history log, stat counters, recs cache."""
from backend.inbox import state


def _fresh(tmp_path, monkeypatch):
    monkeypatch.setattr(state, "STATE_FILE", tmp_path / "inbox-state.json")
    monkeypatch.setattr(state, "_mem", None)
    return state


def test_log_action_prepends_and_caps(tmp_path, monkeypatch):
    s = _fresh(tmp_path, monkeypatch)
    ts1 = s.log_action("gmail", "1", "Mail one", "archive",
                       undo={"folder": "[Gmail]/All Mail", "from": "a@b.c"},
                       stat_key="gmail:a@b.c")
    ts2 = s.log_action("gmail", "2", "Mail two", "delete", undo=None,
                       stat_key=None)
    hist = s.history()
    assert [e["id"] for e in hist] == ["2", "1"]      # newest first
    assert ts2 != ts1                                  # ts is the unique undo key
    assert hist[1]["undo"]["folder"] == "[Gmail]/All Mail"
    assert hist[0]["undo"] is None
    for i in range(150):                               # cap at 100
        s.log_action("slack", str(i), "t", "mark_read", undo=None, stat_key=None)
    assert len(s.history(limit=200)) == 100


def test_pop_history_removes_and_returns(tmp_path, monkeypatch):
    s = _fresh(tmp_path, monkeypatch)
    ts = s.log_action("asana", "g1", "Task", "complete",
                      undo={"asana_gid": "g1"}, stat_key=None)
    entry = s.pop_history(ts)
    assert entry["action"] == "complete"
    assert s.pop_history(ts) is None                   # gone
    assert s.history() == []


def test_stats_bump_and_drop(tmp_path, monkeypatch):
    s = _fresh(tmp_path, monkeypatch)
    for _ in range(3):
        s.bump_stat("gmail:news@x.com", "archive")
    s.bump_stat("gmail:news@x.com", "delete")
    assert s.stats()["gmail:news@x.com"] == {"archive": 3, "delete": 1}
    s.drop_stat("gmail:news@x.com", "delete")
    assert s.stats()["gmail:news@x.com"] == {"archive": 3}   # zero entries pruned
    s.drop_stat("gmail:nobody@x.com", "archive")             # no-op, no crash


def test_undismiss_restores_card(tmp_path, monkeypatch):
    s = _fresh(tmp_path, monkeypatch)
    s.dismiss("gmail", "9", "archived")
    s.snooze("gmail", "9", until_ms=10**15)
    assert s.hidden("gmail", "9", now_ms=0)
    s.undismiss("gmail", "9")
    assert not s.hidden("gmail", "9", now_ms=0)


def test_recs_cache_set_get_prune(tmp_path, monkeypatch):
    s = _fresh(tmp_path, monkeypatch)
    old = {"action": "archive", "confidence": "high", "reason": "old", "ts": 1}
    new = {"action": "gary", "confidence": "med", "reason": "new", "ts": 10**15}
    s.set_recs({"gmail:1": old, "gmail:2": new}, live_keys={"gmail:2"},
               now_ms=10**15)
    # gmail:1 is >7d old AND absent from the live feed -> pruned
    assert set(s.recs()) == {"gmail:2"}
    # an old rec still present in the feed survives
    s.set_recs({"gmail:3": dict(old)}, live_keys={"gmail:3"}, now_ms=10**15)
    assert "gmail:3" in s.recs()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest backend/tests/test_inbox_state_v21.py -q`
Expected: FAIL — `AttributeError: module ... has no attribute 'log_action'`.

- [ ] **Step 3: Implement the additions in `backend/inbox/state.py`**

Append after `hidden()` (and extend `_load()`'s setdefaults):

In `_load()`, after the existing two `setdefault` lines, add:

```python
    _mem.setdefault("history", [])
    _mem.setdefault("stats", {})
    _mem.setdefault("recs", {})
```

Append at end of file:

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest backend/tests/test_inbox_state_v21.py backend/tests/test_inbox_state.py -q`
Expected: 10 passed (5 new + 5 existing — the old file must still pass).

- [ ] **Step 5: Commit**

```bash
git add backend/inbox/state.py backend/tests/test_inbox_state_v21.py
git commit -m "feat(inbox): state v2.1 — action history, stat counters, recs cache"
```

---

### Task 2: Email helpers — raising move + subject/from search; asana uncomplete

**Files:**
- Modify: `backend/email_himalaya.py` (add two functions near `_move`, ~line 250)
- Modify: `backend/inbox/sources/asana.py` (add `uncomplete` after `complete`)
- Test: `backend/tests/test_email_undo_helpers.py`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_email_undo_helpers.py`:

```python
"""Unit tests for the undo helpers: search-query building + uid resolution."""
import pytest

from backend import email_himalaya


def test_search_query_sanitizes_subject():
    # himalaya list-output subjects may be pre-truncated with a literal …;
    # quotes break the query grammar. Both must be stripped; prefix-substring
    # match is what IMAP SEARCH does anyway.
    q = email_himalaya.search_query('💬 New "comment" on: [SOCIAL] Mochi R…',
                                    "no-reply@asana.com")
    assert q == ('subject "💬 New comment on: [SOCIAL] Mochi R" '
                 'and from "no-reply@asana.com"')


def test_search_query_without_from():
    assert email_himalaya.search_query("Hello world", "") == 'subject "Hello world"'


@pytest.mark.anyio
async def test_find_uid_returns_first_match(monkeypatch):
    async def fake_run_json(args):
        assert args[:4] == ["envelope", "list", "-f", "[Gmail]/Trash"]
        assert args[-1] == 'subject "Weekly digest"'
        return [{"id": "777", "subject": "Weekly digest"}]
    monkeypatch.setattr(email_himalaya.himalaya_cli, "run_json", fake_run_json)
    uid = await email_himalaya.find_uid("[Gmail]/Trash", "Weekly digest", "")
    assert uid == "777"


@pytest.mark.anyio
async def test_find_uid_none_when_no_match(monkeypatch):
    async def fake_run_json(args):
        return []
    monkeypatch.setattr(email_himalaya.himalaya_cli, "run_json", fake_run_json)
    assert await email_himalaya.find_uid("[Gmail]/Trash", "X y z", "") is None


@pytest.fixture
def anyio_backend():
    return "asyncio"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest backend/tests/test_email_undo_helpers.py -q`
Expected: FAIL — `AttributeError: ... has no attribute 'search_query'`.

- [ ] **Step 3: Implement the helpers**

In `backend/email_himalaya.py`, directly after the `_move` function (keep the
existing `_move`/`archive`/`delete` endpoints untouched), add:

```python
async def move_message(uid: str, src: str, dest: str) -> None:
    """Like _move but RAISES HimalayaError instead of returning a JSONResponse.
    For callers (the inbox router) that need failures to propagate — the
    endpoint-shaped _move swallows errors into a 502 response object, which a
    plain `await` silently ignores."""
    await himalaya_cli.run_raw(["message", "move", dest, uid, "-f", src])


def search_query(subject: str, from_addr: str) -> str:
    """Build a himalaya envelope-list query. The query grammar supports only
    from/to/subject/body/date/flag (NO header search — verified v1.2.0), and
    list-output subjects may carry a trailing truncation ellipsis. Strip
    quotes + ellipsis; IMAP SEARCH is substring-based so a prefix matches."""
    subj = subject.replace('"', "").rstrip().rstrip("…").strip()[:80]
    q = f'subject "{subj}"'
    if from_addr:
        q += f' and from "{from_addr.replace(chr(34), "")}"'
    return q


async def find_uid(folder: str, subject: str, from_addr: str) -> str | None:
    """Resolve a message's uid IN `folder` (IMAP uids are per-folder, so the
    pre-move uid is useless after archive/delete). Returns the newest match."""
    data = await himalaya_cli.run_json(
        ["envelope", "list", "-f", folder, "-s", "10",
         search_query(subject, from_addr)])
    envs = data if isinstance(data, list) else (data.get("envelopes") or [])
    return str(envs[0]["id"]) if envs else None
```

In `backend/inbox/sources/asana.py`, after `complete()`, add:

```python
async def uncomplete(gid: str) -> None:
    await _api("PUT", f"/tasks/{gid}", {"data": {"completed": False}})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest backend/tests/test_email_undo_helpers.py -q`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/email_himalaya.py backend/inbox/sources/asana.py backend/tests/test_email_undo_helpers.py
git commit -m "feat(inbox): undo plumbing — raising move, subject/from uid search, asana uncomplete"
```

---

### Task 3: Router — delete action, history logging, /history + /undo

**Files:**
- Modify: `backend/inbox/__init__.py` (the `action()` handler + two new endpoints)
- Modify: `backend/inbox/sources/gmail.py` (one line: actions array)
- Test: `backend/tests/test_inbox_undo_router.py`

- [ ] **Step 1: Add `delete` to gmail's actions**

In `backend/inbox/sources/gmail.py` `map_items`, change

```python
            "actions": ["archive", "dismiss", "snooze"],
```

to

```python
            "actions": ["archive", "delete", "dismiss", "snooze"],
```

Then in `backend/tests/test_inbox_gmail.py`, update the one assertion that pins
the actions list:

```python
    assert it["actions"] == ["archive", "delete", "dismiss", "snooze"]
```

Run: `.venv/bin/python -m pytest backend/tests/test_inbox_gmail.py -q` → 4 passed.

- [ ] **Step 2: Write the failing router tests**

Create `backend/tests/test_inbox_undo_router.py`:

```python
"""Router tests for v2.1: delete action, history logging, undo endpoints."""
import pytest
from httpx import ASGITransport, AsyncClient

import backend.inbox as inbox
from backend.inbox import state


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(state, "STATE_FILE", tmp_path / "state.json")
    monkeypatch.setattr(state, "_mem", None)
    inbox._cache.clear()

    async def fake_gmail():
        return [{"id": "g1", "source": "gmail", "title": "Weekly digest",
                 "subtitle": "News", "snippet": "", "ts": 2, "ageHours": 1.0,
                 "score": 5, "meta": {"from": "news@x.com", "uid": "g1"},
                 "actions": ["archive", "delete", "dismiss", "snooze"]}]

    for name in list(inbox.SOURCES):
        monkeypatch.setitem(inbox.SOURCES, name, fake_gmail)

    from backend.app import app
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://t")


@pytest.fixture
def fake_mail(monkeypatch):
    calls = []

    async def fake_move(uid, src, dest):
        calls.append(("move", uid, src, dest))

    async def fake_find(folder, subject, from_addr):
        calls.append(("find", folder, subject, from_addr))
        return "999"

    monkeypatch.setattr(inbox.email_himalaya, "move_message", fake_move)
    monkeypatch.setattr(inbox.email_himalaya, "find_uid", fake_find)
    return calls


@pytest.mark.anyio
async def test_delete_action_moves_to_trash_and_logs(client, fake_mail):
    async with client as c:
        r = await c.post("/api/items/action",
                         json={"source": "gmail", "id": "g1", "action": "delete",
                               "title": "Weekly digest",
                               "meta": {"from": "news@x.com"}})
        body = r.json()
        assert body["ok"] is True and isinstance(body["undoTs"], int)
        h = (await c.get("/api/items/history")).json()["entries"]
    assert fake_mail[0] == ("move", "g1", "INBOX", inbox.email_himalaya.TRASH_FOLDER)
    assert h[0]["action"] == "delete" and h[0]["undoable"] is True
    assert state.stats()["gmail:news@x.com"] == {"delete": 1}


@pytest.mark.anyio
async def test_undo_delete_moves_back_and_restores(client, fake_mail):
    async with client as c:
        r = await c.post("/api/items/action",
                         json={"source": "gmail", "id": "g1", "action": "delete",
                               "title": "Weekly digest",
                               "meta": {"from": "news@x.com"}})
        ts = r.json()["undoTs"]
        r2 = await c.post("/api/items/undo", json={"ts": ts})
        assert r2.json()["ok"] is True
        feed = (await c.get("/api/items?sources=gmail")).json()
    # find in Trash by subject+from, then move 999 back to INBOX
    assert ("find", inbox.email_himalaya.TRASH_FOLDER,
            "Weekly digest", "news@x.com") in fake_mail
    assert ("move", "999", inbox.email_himalaya.TRASH_FOLDER, "INBOX") in fake_mail
    assert [i["id"] for i in feed["items"]] == ["g1"]        # card is back
    assert state.stats() == {}                                # counter dropped
    assert state.history() == []                              # entry consumed


@pytest.mark.anyio
async def test_undo_local_dismiss(client):
    async with client as c:
        r = await c.post("/api/items/action",
                         json={"source": "gmail", "id": "g1",
                               "action": "dismiss", "title": "Weekly digest"})
        ts = r.json()["undoTs"]
        await c.post("/api/items/undo", json={"ts": ts})
        feed = (await c.get("/api/items?sources=gmail")).json()
    assert [i["id"] for i in feed["items"]] == ["g1"]


@pytest.mark.anyio
async def test_undo_unknown_ts_404(client):
    async with client as c:
        r = await c.post("/api/items/undo", json={"ts": 123456})
    assert r.status_code == 404


@pytest.mark.anyio
async def test_archive_failure_does_not_dismiss(client, monkeypatch):
    async def boom(uid, src, dest):
        raise RuntimeError("imap down")
    monkeypatch.setattr(inbox.email_himalaya, "move_message", boom)
    async with client as c:
        r = await c.post("/api/items/action",
                         json={"source": "gmail", "id": "g1",
                               "action": "archive", "title": "Weekly digest"})
        feed = (await c.get("/api/items?sources=gmail")).json()
    assert r.status_code == 502
    assert [i["id"] for i in feed["items"]] == ["g1"]   # NOT hidden — bug fixed
    assert state.history() == []                         # nothing logged
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest backend/tests/test_inbox_undo_router.py -q`
Expected: FAIL — `undoTs` missing / 404 routes / old archive path used.

- [ ] **Step 4: Rewrite `action()` and add the endpoints in `backend/inbox/__init__.py`**

Replace the whole `action()` function with:

```python
def _stat_key(source: str, meta: dict) -> str | None:
    """Counter key for the history-recommendation layer. Only gmail senders
    and slack channels have a stable 'sender' notion (spec §2)."""
    if source == "gmail" and meta.get("from"):
        return f"gmail:{meta['from'].lower()}"
    if source == "slack" and meta.get("channel"):
        return f"slack:{meta['channel']}"
    return None


@router.post("/api/items/action")
async def action(payload: dict):
    source = payload.get("source")
    item_id = str(payload.get("id") or "")
    act = payload.get("action")
    meta = payload.get("meta") or {}
    title = (payload.get("title") or "")[:140]
    if source not in SOURCES or not item_id:
        return _bad("source and id are required")
    undo: dict | None = {"local": True}   # default: undo just restores the card
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
            await email_himalaya.move_message(
                item_id, "INBOX", email_himalaya.ARCHIVE_FOLDER)
            state.dismiss(source, item_id, "archived")
            undo = {"folder": email_himalaya.ARCHIVE_FOLDER,
                    "from": meta.get("from") or ""}
        elif act == "delete" and source == "gmail":
            await email_himalaya.move_message(
                item_id, "INBOX", email_himalaya.TRASH_FOLDER)
            state.dismiss(source, item_id, "deleted")
            undo = {"folder": email_himalaya.TRASH_FOLDER,
                    "from": meta.get("from") or ""}
        elif act == "mark_read" and source == "slack":
            await slack.mark_read(item_id, meta.get("channel") or "")
            state.dismiss(source, item_id, "mark_read")
            undo = {"local": True, "note": "restores card only"}
        elif act == "complete" and source == "asana":
            await asana.complete(item_id)
            state.dismiss(source, item_id, "completed")
            undo = {"asana_gid": item_id}
        else:
            return _bad(f"unknown action '{act}' for source '{source}'")
    except Exception as exc:  # noqa: BLE001 - surface to the card toast
        return JSONResponse(status_code=502,
                            content={"ok": False, "error": str(exc)})
    skey = _stat_key(source, meta)
    if skey:
        state.bump_stat(skey, act)
    undo_ts = state.log_action(source, item_id, title, act, undo, skey)
    _cache.pop(source, None)
    return {"ok": True, "undoTs": undo_ts}


@router.get("/api/items/history")
async def items_history(limit: int = 20):
    entries = []
    for e in state.history(limit=max(1, min(100, limit))):
        entries.append({**e, "undoable": e["undo"] is not None,
                        "note": (e["undo"] or {}).get("note")})
    return {"entries": entries}


@router.post("/api/items/undo")
async def items_undo(payload: dict):
    ts = payload.get("ts")
    entry = state.pop_history(ts) if isinstance(ts, int) else None
    if entry is None:
        return JSONResponse(status_code=404,
                            content={"ok": False, "error": "no such history entry"})
    undo = entry["undo"]
    if undo is None:
        return _bad("this action is not undoable")
    try:
        if "folder" in undo:                       # gmail archive/delete
            uid = await email_himalaya.find_uid(
                undo["folder"], entry["title"], undo.get("from") or "")
            if not uid:
                raise RuntimeError(
                    f"message not found in {undo['folder']} anymore")
            await email_himalaya.move_message(uid, undo["folder"], "INBOX")
        elif "asana_gid" in undo:                  # asana complete
            await asana.uncomplete(undo["asana_gid"])
        # 'local' undo (dismiss/snooze/reviewed/mark_read): nothing remote.
    except Exception as exc:  # noqa: BLE001
        # restore the history entry so the user can retry
        state.log_action(entry["source"], entry["id"], entry["title"],
                         entry["action"], undo, entry.get("statKey"))
        return JSONResponse(status_code=502,
                            content={"ok": False, "error": str(exc)})
    state.undismiss(entry["source"], entry["id"])
    if entry.get("statKey"):
        state.drop_stat(entry["statKey"], entry["action"])
    _cache.pop(entry["source"], None)
    return {"ok": True}
```

(Note: `_stat_key` + the two endpoints go right after `_bad()`; the old
`action()` body is fully replaced. `email_himalaya.archive` is no longer
called by the router — `move_message` raises on failure, fixing the silent
dismiss-on-IMAP-error bug.)

- [ ] **Step 5: Run the suite**

Run: `.venv/bin/python -m pytest backend/tests/test_inbox_undo_router.py backend/tests/test_inbox_router.py backend/tests/test_inbox_gmail.py -q`
Expected: 13 passed (5 new + 4 + 4). Then the full suite: no failures.

- [ ] **Step 6: Commit**

```bash
git add backend/inbox/__init__.py backend/inbox/sources/gmail.py backend/tests/test_inbox_undo_router.py backend/tests/test_inbox_gmail.py
git commit -m "feat(inbox): gmail delete + action history + /history + /undo endpoints"
```

---

### Task 4: UI — actions-driven buttons, 🗑, undo toast, 🕒 drawer

**Files:**
- Modify: `frontend-overrides/js/inbox.js`
- Modify: `frontend-overrides/workspace.css` (append)
- Mirror: `cp` both into `frontend/` (gitignored)

- [ ] **Step 1: `git status --short frontend-overrides/ scripts/` — STOP (BLOCKED) if inbox.js or workspace.css is already dirty.**

- [ ] **Step 2: Edit `frontend-overrides/js/inbox.js`**

(a) In `buildModal()`, add two header buttons — replace the refresh-button line:

```javascript
      '    <button class="inbox-refresh" id="inbox-refresh" title="Refresh">&#x21bb;</button>' +
```

with:

```javascript
      '    <button class="inbox-refresh" id="inbox-history-btn" title="History">&#x1F552;</button>' +
      '    <button class="inbox-refresh" id="inbox-refresh" title="Refresh">&#x21bb;</button>' +
```

and after the `$('#inbox-refresh', overlay)...` line add:

```javascript
    $('#inbox-history-btn', overlay).addEventListener('click', toggleHistory);
```

(b) Add a `_view` state flag. Change the state declaration line to:

```javascript
  let _modal = null, _items = [], _errors = {}, _counts = {}, _filter = null,
      _view = 'feed', _toastTimer = null;
```

(c) In `render()`, first line of the function body, add:

```javascript
    if (_view === 'history') return renderHistory();
```

(d) In `cardHtml()`, replace the actions row (the block from
`` `  <div class="inbox-item-actions">` `` through its closing `` `  </div>` ``)
with an actions-array-driven version:

```javascript
      `  <div class="inbox-item-actions">` +
      `    <button data-act="${act}" class="inbox-btn inbox-btn-primary">${label}</button>` +
      ((it.actions || []).includes('delete')
        ? `    <button data-act="delete" class="inbox-btn" title="Delete">🗑</button>` : '') +
      `    <button data-act="snooze" class="inbox-btn" title="Snooze">⏰</button>` +
      `    <button data-act="open" class="inbox-btn" title="Open">↗</button>` +
      `    <button data-act="gary" class="inbox-btn" title="Hand to Gary">🤖</button>` +
      `    <button data-act="dismiss" class="inbox-btn" title="Dismiss">✕</button>` +
      `  </div>` +
```

(e) In `doAction()`: include the title in the payload and show the undo toast.
Replace the `body: JSON.stringify(...)` line with:

```javascript
        body: JSON.stringify({ source: it.source, id: it.id, action: act,
                               until, title: it.title, meta: it.meta || {} }),
```

and after the `renderChips();` line (success path) add:

```javascript
      showToast(`${act === 'snooze' ? 'Snoozed' : act.replace('_', ' ')} — "${(it.title || '').slice(0, 40)}"`,
                data.undoTs);
```

(f) Add the toast + history functions before `// --- rail button`:

```javascript
  // --- undo toast + history drawer ----------------------------------------
  function showToast(msg, undoTs) {
    const card = $('.inbox-card', _modal);
    if (!card) return;
    const old = $('#inbox-toast', card);
    if (old) old.remove();
    clearTimeout(_toastTimer);
    const t = document.createElement('div');
    t.id = 'inbox-toast';
    t.innerHTML = `<span>${esc(msg)}</span>`;
    if (undoTs) {
      const b = document.createElement('button');
      b.className = 'inbox-btn inbox-toast-undo';
      b.textContent = 'Undo';
      b.addEventListener('click', async () => { await doUndo(undoTs); t.remove(); });
      t.appendChild(b);
    }
    card.appendChild(t);
    _toastTimer = setTimeout(() => t.remove(), 8000);
  }

  async function doUndo(ts) {
    try {
      const r = await fetch(`${API}/api/items/undo`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ts }),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || `HTTP ${r.status}`);
      showToast('Undone — item restored', null);
      load(true);
    } catch (err) {
      showToast('Undo failed: ' + String(err.message || err), null);
    }
  }

  function toggleHistory() {
    _view = _view === 'history' ? 'feed' : 'history';
    if (_view === 'feed') { render(); return; }
    renderHistory();
  }

  async function renderHistory() {
    const body = $('#inbox-body');
    if (!body) return;
    body.innerHTML = '<div class="cron-empty">Loading…</div>';
    let entries = [];
    try {
      const r = await fetch(`${API}/api/items/history?limit=20`,
        { credentials: 'same-origin' });
      entries = (await r.json()).entries || [];
    } catch (e) {
      body.innerHTML = `<div class="inbox-error">${esc(String(e))}</div>`;
      return;
    }
    if (!entries.length) {
      body.innerHTML = '<div class="cron-empty">No recent actions.</div>';
      return;
    }
    body.innerHTML = entries.map((e) =>
      `<div class="inbox-item inbox-hist-row" data-ts="${e.ts}">` +
      `  <div class="inbox-item-main">` +
      `    <div class="inbox-item-title">` +
      `      <span class="email-tag email-tag-${esc(e.source)}">${esc(e.source)}</span>` +
      `      ${esc(e.action.replace('_', ' '))} · ${esc(e.title || '(untitled)')}</div>` +
      `    <div class="inbox-item-sub">${ageLabel((Date.now() - e.ts) / 3600000)} ago` +
      (e.note ? ` · ${esc(e.note)}` : '') + `</div>` +
      `  </div>` +
      `  <div class="inbox-item-actions">` +
      (e.undoable
        ? `<button class="inbox-btn inbox-hist-undo" data-ts="${e.ts}">Undo</button>`
        : `<span class="inbox-item-sub">not undoable</span>`) +
      `  </div></div>`).join('');
    body.querySelectorAll('.inbox-hist-undo').forEach((b) => {
      b.addEventListener('click', async () => {
        b.disabled = true;
        await doUndo(Number(b.dataset.ts));
        renderHistory();
      });
    });
  }
```

(g) In `load()`, force feed view on refresh — first line of the function body:

```javascript
    _view = 'feed';
```

- [ ] **Step 3: Append to `frontend-overrides/workspace.css`**

```css
/* --- Inbox v2.1: undo toast + history drawer ------------------------------ */
#inbox-toast {
  position: absolute; bottom: 14px; left: 50%; transform: translateX(-50%);
  display: flex; gap: 10px; align-items: center; z-index: 20;
  background: var(--panel, #14181f); border: 1px solid var(--border, rgba(255,255,255,0.15));
  border-radius: 8px; padding: 8px 14px; font-size: 12.5px;
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.4);
}
.inbox-toast-undo { background: rgba(122, 162, 247, 0.25); font-weight: 600; }
.inbox-hist-row .inbox-item-title { font-size: 12.5px; }
```

(The `.inbox-card` already has `position: relative` ancestry via
`.cron-modal-card`; verify the toast anchors inside the modal — if
`.cron-modal-card` lacks `position: relative`, add
`.inbox-card { position: relative; }` to this block.)

- [ ] **Step 4: Syntax check + mirror + restart + eyeball**

```bash
cd ~/openclaw-workspace
node --check frontend-overrides/js/inbox.js
cp frontend-overrides/js/inbox.js frontend/js/inbox.js
cp frontend-overrides/workspace.css frontend/workspace.css
launchctl kickstart -k gui/501/ai.openclaw.workspace && sleep 8
curl -s http://127.0.0.1:8800/static/js/inbox.js | grep -c inbox-history-btn   # expect 1
```

Browser eyeball (or headless): gmail cards show 🗑; dismissing shows the toast;
Undo restores the card; 🕒 lists the action.

- [ ] **Step 5: Commit**

```bash
git add frontend-overrides/js/inbox.js frontend-overrides/workspace.css
git commit -m "feat(inbox): UI — delete button, undo toast, history drawer"
```

---

### Task 5: `recommend.py` — heuristic + history layers, attached to /api/items

**Files:**
- Create: `backend/inbox/recommend.py`
- Modify: `backend/inbox/__init__.py` (attach recs in `items()`)
- Test: `backend/tests/test_inbox_recommend.py`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_inbox_recommend.py`:

```python
"""Unit tests for the recommendation layers (pure)."""
from backend.inbox import recommend


def _gmail(addr="ada@example.com", age_h=1.0):
    return {"id": "1", "source": "gmail", "title": "Hi", "ageHours": age_h,
            "meta": {"from": addr}, "actions": ["archive", "delete", "dismiss", "snooze"]}


def _slack(kind="unread", age_h=1.0, channel="#general"):
    return {"id": "m1", "source": "slack", "title": "msg", "ageHours": age_h,
            "snippet": kind, "meta": {"channel": channel, "kind": kind},
            "actions": ["mark_read", "dismiss", "snooze"]}


def test_heuristic_newsletter_sender_archives():
    rec = recommend.heuristic_rec(_gmail("no-reply@asana.com"))
    assert rec == {"action": "archive", "by": "heuristic",
                   "reason": "newsletter/notification sender"}
    assert recommend.heuristic_rec(_gmail("taylor@example.com")) is None


def test_heuristic_stale_slack_unread():
    assert recommend.heuristic_rec(_slack(age_h=200))["action"] == "mark_read"
    assert recommend.heuristic_rec(_slack(age_h=5)) is None
    assert recommend.heuristic_rec(_slack(kind="mention", age_h=200)) is None


def test_history_rec_threshold():
    stats = {"gmail:news@x.com": {"delete": 4, "archive": 1}}   # 80% delete
    rec = recommend.history_rec(_gmail("news@x.com"), stats)
    assert rec["action"] == "delete" and rec["by"] == "history"
    assert "4/5" in rec["reason"]
    # below 3 total -> none; below 80% share -> none
    assert recommend.history_rec(_gmail("a@b.c"), {"gmail:a@b.c": {"delete": 2}}) is None
    assert recommend.history_rec(
        _gmail("a@b.c"), {"gmail:a@b.c": {"delete": 3, "archive": 2}}) is None


def test_precedence_ai_over_history_over_heuristic():
    stats = {"gmail:no-reply@asana.com": {"delete": 5}}
    ai = {"gmail:1": {"action": "reply", "confidence": "high",
                      "reason": "asks a question", "ts": 1}}
    item = _gmail("no-reply@asana.com")
    rec = recommend.pick(item, stats, ai)
    assert rec["by"] == "ai" and rec["action"] == "reply"
    rec2 = recommend.pick(item, stats, {})
    assert rec2["by"] == "history"
    rec3 = recommend.pick(item, {}, {})
    assert rec3["by"] == "heuristic"
    assert recommend.pick(_gmail("taylor@example.com"), {}, {}) is None


def test_ai_rec_with_disallowed_action_is_ignored():
    ai = {"slack:m1": {"action": "delete", "confidence": "high",
                       "reason": "x", "ts": 1}}
    assert recommend.pick(_slack(), {}, ai) is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest backend/tests/test_inbox_recommend.py -q`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `backend/inbox/recommend.py`**

```python
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
```

- [ ] **Step 4: Attach recs in the router**

In `backend/inbox/__init__.py`:
- add `from . import recommend, state` (replace the existing `from . import state`).
- in `items()`, right before the `merged.sort(...)` line, insert:

```python
    stats_snapshot = state.stats()
    ai_recs = state.recs()
    for i in merged:
        rec = recommend.pick(i, stats_snapshot, ai_recs)
        if rec:
            i["rec"] = rec
```

- [ ] **Step 5: Run the suite**

Run: `.venv/bin/python -m pytest backend/tests/test_inbox_recommend.py backend/tests/test_inbox_router.py backend/tests/test_inbox_undo_router.py -q`
Expected: 15 passed (6 new + 4 + 5). Full suite: no failures.

- [ ] **Step 6: Commit**

```bash
git add backend/inbox/recommend.py backend/inbox/__init__.py backend/tests/test_inbox_recommend.py
git commit -m "feat(inbox): instant rec layers — history counters + heuristics, rec attached to /api/items"
```

---

### Task 6: UI — the ✨ chip

**Files:**
- Modify: `frontend-overrides/js/inbox.js`
- Modify: `frontend-overrides/workspace.css` (append)
- Mirror + restart.

- [ ] **Step 1: `git status --short frontend-overrides/` — BLOCKED if dirty.**

- [ ] **Step 2: Edit `frontend-overrides/js/inbox.js`**

(a) Add the label map after the `PRIMARY` constant:

```javascript
  const REC_LABELS = {
    archive: 'Archive', delete: 'Delete', mark_read: 'Mark read',
    complete: 'Mark complete', reviewed: 'Reviewed',
    reply: 'Draft reply', gary: 'Hand to Gary',
  };
```

(b) In `cardHtml()`, after the snippet line
(`(it.snippet ? ... : '') +`), insert:

```javascript
      (it.rec ? `    <div class="inbox-rec-chip${it.rec.confidence === 'low' ? ' inbox-rec-low' : ''}" ` +
                `role="button" tabindex="0" title="${esc(it.rec.by)} recommendation">` +
                `✨ ${esc(REC_LABELS[it.rec.action] || it.rec.action)}` +
                (it.rec.reason ? ` — ${esc(it.rec.reason)}` : '') + `</div>` : '') +
```

(c) In `bindCard()`, after the `el.querySelectorAll('.inbox-btn')...` block, add:

```javascript
    const chip = $('.inbox-rec-chip', el);
    if (chip && it.rec) {
      chip.addEventListener('click', async () => {
        chip.style.opacity = '0.5';
        if (it.rec.action === 'reply' || it.rec.action === 'gary') {
          return handToGary(it, chip, it.rec.action);
        }
        await doAction(it, it.rec.action, el, chip);
      });
    }
```

(d) Extend `handToGary` to carry an intent — change its signature and body
opening to:

```javascript
  async function handToGary(it, btn, intent) {
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = '…';
    try {
      const r = await fetch(`${API}/api/items/spinoff`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item: it, intent: intent || undefined }),
      });
```

(rest of the function unchanged — `intent` lands in the body only).

- [ ] **Step 3: Append to `frontend-overrides/workspace.css`**

```css
/* --- Inbox v2.1: ✨ recommendation chip ------------------------------------ */
.inbox-rec-chip {
  display: inline-block; margin-top: 4px; padding: 2px 9px; cursor: pointer;
  font-size: 11.5px; border-radius: 999px;
  background: rgba(187, 154, 247, 0.14); color: var(--accent, #bb9af7);
  border: 1px solid rgba(187, 154, 247, 0.3);
}
.inbox-rec-chip:hover { background: rgba(187, 154, 247, 0.28); }
.inbox-rec-low { opacity: 0.55; }
```

- [ ] **Step 4: Syntax check + mirror + restart + eyeball**

```bash
cd ~/openclaw-workspace
node --check frontend-overrides/js/inbox.js
cp frontend-overrides/js/inbox.js frontend/js/inbox.js
cp frontend-overrides/workspace.css frontend/workspace.css
launchctl kickstart -k gui/501/ai.openclaw.workspace && sleep 8
curl -s 'http://127.0.0.1:8800/api/items?limit=50' | grep -c '"rec"'   # expect >=1 (newsletters exist)
```

Browser: newsletter gmail cards show `✨ Archive — newsletter/notification
sender`; clicking the chip archives + toasts with Undo.

- [ ] **Step 5: Commit**

```bash
git add frontend-overrides/js/inbox.js frontend-overrides/workspace.css
git commit -m "feat(inbox): ✨ recommendation chip UI"
```

---

### Task 7: Triage endpoint + spinoff intents (backend)

**Files:**
- Modify: `backend/config.py` (one constant)
- Modify: `backend/inbox/recommend.py` (prompt builder + reply parser)
- Modify: `backend/inbox/__init__.py` (`/api/items/triage`, spinoff `intent`)
- Test: `backend/tests/test_inbox_triage.py`

- [ ] **Step 1: Add the session key constant**

In `backend/config.py`, directly under the `WEB_SESSION_KEY` line:

```python
# Dedicated utility session for the Inbox ✨ triage pass (never a visible chat).
INBOX_TRIAGE_SESSION_KEY = os.environ.get(
    "OPENCLAW_INBOX_TRIAGE_SESSION_KEY", "agent:main:inbox-triage")
```

- [ ] **Step 2: Write the failing tests**

Create `backend/tests/test_inbox_triage.py`:

```python
"""Tests for the ✨ triage pass: prompt build, reply parse, endpoint."""
import json

import pytest
from httpx import ASGITransport, AsyncClient

import backend.inbox as inbox
from backend.inbox import recommend, state


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _item(i="1", source="gmail", score=5):
    return {"id": i, "source": source, "title": f"Item {i}", "subtitle": "S",
            "snippet": "snip", "ts": 1, "ageHours": 2.0, "score": score,
            "meta": {}, "actions": []}


def test_build_triage_prompt_caps_and_constrains():
    items = [_item(str(n), score=n) for n in range(130)]
    prompt, included = recommend.build_triage_prompt(items, cap=120)
    assert len(included) == 120
    assert "129" in prompt                      # highest score included
    assert json.dumps("archive") in prompt or "archive" in prompt
    assert "STRICT JSON" in prompt
    # per-source constraint table is spelled out
    assert "gmail: archive|delete|reply|gary|none" in prompt


def test_parse_triage_reply_tolerates_fences_and_junk():
    valid = {"1": "gmail", "m1": "slack"}
    text = ('Here you go!\n```json\n'
            '[{"id": "1", "action": "reply", "confidence": "high", "reason": "asks a question"},\n'
            ' {"id": "m1", "action": "delete", "confidence": "high", "reason": "x"},\n'
            ' {"id": "ghost", "action": "archive", "confidence": "low", "reason": "y"},\n'
            ' {"id": "1", "action": "explode"}]\n```\nHope that helps.')
    out = recommend.parse_triage_reply(text, valid, now_ms=42)
    # only the first entry survives: m1's 'delete' is not allowed for slack,
    # 'ghost' is an unknown id, the duplicate has an unknown action
    assert out == {"gmail:1": {"action": "reply", "confidence": "high",
                               "reason": "asks a question", "ts": 42}}


def test_parse_triage_reply_garbage_returns_empty():
    assert recommend.parse_triage_reply("sorry, I had a stall", {"1": "gmail"},
                                        now_ms=1) == {}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(state, "STATE_FILE", tmp_path / "state.json")
    monkeypatch.setattr(state, "_mem", None)
    inbox._cache.clear()

    async def fake_src():
        return [{**_item("1"), "meta": {"from": "x@y.z"}}]

    for name in list(inbox.SOURCES):
        monkeypatch.setitem(inbox.SOURCES, name, fake_src)

    from backend.app import app
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://t")


@pytest.mark.anyio
async def test_triage_endpoint_caches_and_items_show_rec(client, monkeypatch):
    async def fake_run_text(prompt, session_key):
        assert session_key == inbox.config.INBOX_TRIAGE_SESSION_KEY
        return '[{"id": "1", "action": "archive", "confidence": "high", "reason": "bulk"}]'
    monkeypatch.setattr(inbox.bridge, "run_text", fake_run_text)
    async with client as c:
        r = await c.post("/api/items/triage", json={})
        body = r.json()
        assert body["scored"] == 1
        feed = (await c.get("/api/items?sources=gmail")).json()
    rec = feed["items"][0]["rec"]
    assert rec["by"] == "ai" and rec["action"] == "archive"


@pytest.mark.anyio
async def test_triage_garbled_brain_503(client, monkeypatch):
    async def fake_run_text(prompt, session_key):
        return "no json here, codex stalled"
    monkeypatch.setattr(inbox.bridge, "run_text", fake_run_text)
    async with client as c:
        r = await c.post("/api/items/triage", json={})
    assert r.status_code == 503


@pytest.mark.anyio
async def test_spinoff_reply_intent_seeds_draft(client, monkeypatch):
    seen = {}

    async def fake_turn(seed, key, model):
        seen["seed"] = seed

    async def fake_read(uid, folder="INBOX", mark_seen=True):
        assert mark_seen is False
        return {"body": "original email body", "message_id": "<m@x>"}

    monkeypatch.setattr(inbox, "_agent_turn", fake_turn)
    monkeypatch.setattr(inbox.email_himalaya, "email_read", fake_read)
    monkeypatch.setattr(inbox.email_himalaya, "_load_style", lambda: "breezy")
    async with client as c:
        r = await c.post("/api/items/spinoff", json={
            "intent": "reply",
            "item": {"source": "gmail", "title": "Q about quotas",
                     "subtitle": "Ada", "snippet": "", "meta": {"uid": "55"}}})
    assert r.json().get("session_id")
    assert "original email body" in seen["seed"]
    assert "breezy" in seen["seed"]
    assert "Draft a reply" in seen["seed"]
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest backend/tests/test_inbox_triage.py -q`
Expected: FAIL — `build_triage_prompt` missing / 404 on /triage.

- [ ] **Step 4: Add prompt builder + parser to `backend/inbox/recommend.py`**

Append:

```python
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
        "  obsidian: reviewed|gary|none",
        "  documents: gary|none",
        "(reply = I should answer this email; gary = hand to my assistant "
        "with context. Prefer archive for newsletters/notifications, delete "
        "for obvious junk, none when unsure.)",
        "",
        "Reply with STRICT JSON only — a single array, no prose, no markdown "
        "fences:",
        '[{"id": "<id>", "action": "<action>", "confidence": "high|med|low", '
        '"reason": "<max 8 words>"}]',
        "",
        "Items:",
    ]
    for it in chosen:
        lines.append(_json.dumps({
            "id": it["id"], "source": it["source"], "title": it["title"][:120],
            "from": it.get("subtitle", "")[:60], "snippet": (it.get("snippet") or "")[:120],
            "ageHours": round(it.get("ageHours", 0), 1)}, ensure_ascii=False))
    return "\n".join(lines), chosen


def parse_triage_reply(text: str, valid: dict, now_ms: int) -> dict:
    """valid: {item_id: source}. Returns {\"source:id\": rec} with everything
    invalid dropped (unknown ids, disallowed actions, malformed entries)."""
    m = re.search(r"\[[\s\S]*\]", text or "")
    if not m:
        return {}
    try:
        arr = _json.loads(m.group(0))
    except _json.JSONDecodeError:
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
    return out
```

- [ ] **Step 5: Add the endpoint + spinoff intent in `backend/inbox/__init__.py`**

(a) Extend the imports: `from .. import bridge, config, email_himalaya,
sessions_store` (bridge + config are new).

(b) After `items_undo`, add:

```python
@router.post("/api/items/triage")
async def triage(payload: dict | None = None):
    """One brain turn scores every visible un-scored item (spec §4)."""
    feed = await items(limit=500)
    cached = state.recs()
    pending = [i for i in feed["items"]
               if f"{i['source']}:{i['id']}" not in cached]
    if not pending:
        return {"scored": 0, "skipped": len(feed["items"]), "capHit": False}
    prompt, chosen = recommend.build_triage_prompt(pending)
    try:
        reply = await bridge.run_text(
            prompt, session_key=config.INBOX_TRIAGE_SESSION_KEY)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=502,
                            content={"ok": False, "error": str(exc)})
    valid = {i["id"]: i["source"] for i in chosen}
    new = recommend.parse_triage_reply(reply, valid,
                                       now_ms=int(time.time() * 1000))
    if not new:
        return JSONResponse(status_code=503, content={
            "ok": False,
            "error": "triage produced no usable JSON (codex stall/throttle?) "
                     "— nothing cached, try again"})
    live = {f"{i['source']}:{i['id']}" for i in feed["items"]}
    state.set_recs(new, live_keys=live)
    return {"scored": len(new), "skipped": len(feed["items"]) - len(pending),
            "capHit": len(pending) > len(chosen)}
```

(c) In `spinoff()`, replace the `seed = (...)` assignment with:

```python
    intent = payload.get("intent")
    meta = item.get("meta") or {}
    if intent == "reply" and item.get("source") == "gmail" and meta.get("uid"):
        body_text = ""
        try:
            msg = await email_himalaya.email_read(str(meta["uid"]),
                                                  mark_seen=False)
            body_text = (msg.get("body") or "")[:4000]
        except Exception:  # noqa: BLE001 - draft without the body if read fails
            pass
        style = email_himalaya._load_style()
        style_block = f"\n\nWrite in MY style:\n{style}" if style else ""
        seed = ("Draft a reply to this email. Show me the draft and iterate "
                "with me; I'll send it from the Email tab when happy."
                f"{style_block}\n\nFrom: {item.get('subtitle', '')}\n"
                f"Subject: {title}\n\n{body_text}")
        sess_name = f"Reply: {title[:44]}"
    else:
        seed = ("Context for this conversation — an item from my unified inbox "
                f"({item.get('source', '?')}):\n\nTitle: {title}\n"
                f"From/where: {item.get('subtitle', '')}\n"
                f"Details: {item.get('snippet', '')}\n"
                f"Link: {meta.get('url') or 'n/a'}\n\n"
                "Reply with one short sentence confirming you have the context; "
                "the user will say what they need next.")
        sess_name = f"Inbox: {title[:48]}"
```

and change the `sess = sessions_store.create(...)` line (which currently sits
ABOVE the seed) to use `sess_name` — move it to AFTER the seed block:

```python
    sess = sessions_store.create(name=sess_name)
```

(keep the existing `_agent_turn`/cleanup block unchanged below it).

- [ ] **Step 6: Run the suite**

Run: `.venv/bin/python -m pytest backend/tests/test_inbox_triage.py backend/tests/ -q`
Expected: 7 new tests pass; no failures anywhere.

- [ ] **Step 7: Commit**

```bash
git add backend/config.py backend/inbox/recommend.py backend/inbox/__init__.py backend/tests/test_inbox_triage.py
git commit -m "feat(inbox): ✨ triage pass — one-turn LLM scoring + reply/gary spinoff intents"
```

---

### Task 8: UI — ✨ Triage button

**Files:**
- Modify: `frontend-overrides/js/inbox.js`
- Mirror + restart.

- [ ] **Step 1: `git status --short frontend-overrides/` — BLOCKED if dirty.**

- [ ] **Step 2: Edit `frontend-overrides/js/inbox.js`**

(a) In `buildModal()`, before the history-button line, add:

```javascript
      '    <button class="inbox-refresh" id="inbox-triage-btn" title="✨ AI triage">&#x2728;</button>' +
```

and with the other listener bindings:

```javascript
    $('#inbox-triage-btn', overlay).addEventListener('click', runTriage);
```

(b) Add next to `doUndo`:

```javascript
  async function runTriage() {
    const btn = $('#inbox-triage-btn', _modal);
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    const orig = btn.innerHTML;
    btn.innerHTML = '…';
    try {
      const r = await fetch(`${API}/api/items/triage`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      showToast(`✨ scored ${data.scored} item${data.scored === 1 ? '' : 's'}`, null);
      await load(true);
    } catch (err) {
      showToast('Triage failed: ' + String(err.message || err), null);
    }
    btn.disabled = false;
    btn.innerHTML = orig;
  }
```

- [ ] **Step 3: Syntax check + mirror + restart**

```bash
cd ~/openclaw-workspace
node --check frontend-overrides/js/inbox.js
cp frontend-overrides/js/inbox.js frontend/js/inbox.js
launchctl kickstart -k gui/501/ai.openclaw.workspace && sleep 8
curl -s http://127.0.0.1:8800/static/js/inbox.js | grep -c inbox-triage-btn   # expect 2 (markup + binding)
```

- [ ] **Step 4: Commit**

```bash
git add frontend-overrides/js/inbox.js
git commit -m "feat(inbox): ✨ Triage button"
```

---

### Task 9: Live smoke + spec status

⚠️ Mutating live-system steps — run from the controller session, batching any
classifier-blocked mutations into ONE AskUserQuestion.

- [ ] **Step 1: Instant layers live**

```bash
curl -s 'http://127.0.0.1:8800/api/items?limit=200' | python3 -c "
import json,sys
d=json.load(sys.stdin)
recs=[i for i in d['items'] if i.get('rec')]
print(len(recs),'items with recs;',{r['rec']['by'] for r in recs})
print([(r['source'],r['rec']['action'],r['rec']['reason'][:40]) for r in recs[:5]])"
```

Expected: ≥1 heuristic rec (newsletter senders exist in this inbox).

- [ ] **Step 2: Undo round-trip on a real newsletter** (user-approved mutation):
archive a newsletter via `/api/items/action` (capture `undoTs`), confirm it
left INBOX (`himalaya envelope list -f INBOX` lacks the uid), then
`POST /api/items/undo {ts}` and confirm it is BACK in INBOX and visible in the
feed. Then check `GET /api/items/history` no longer lists the entry.

- [ ] **Step 3: ✨ triage pass live**: `curl -s -X POST
http://127.0.0.1:8800/api/items/triage -H 'Content-Type: application/json'
-d '{}'` — expect `{"scored": N>0, ...}` (codex may take ~10-60s; on stall a
503 with a clear message is also a pass for the error path — retry once).
Then `/api/items` shows `"by": "ai"` recs. Eyeball reasons for sanity.

- [ ] **Step 4: reply-intent spinoff live**: pick a real human email item id,
`POST /api/items/spinoff {"intent":"reply","item":{...real card fields...}}`,
expect a `session_id`; open it in the Library — first message should be a
draft reply in the user's style. Delete the session afterwards
(`DELETE /api/session/{id}`).

- [ ] **Step 5: Update the spec status + commit**

Append to `docs/superpowers/specs/2026-06-06-inbox-recommendations-design.md`:

```markdown
## Status

Implemented + live-smoke-tested 2026-06-06 (plan
`docs/superpowers/plans/2026-06-06-inbox-recommendations.md`). Note: undo for
gmail resolves messages by subject+from search — himalaya's query grammar has
no header (Message-ID) search; the spec's §2 Message-ID mechanism was adjusted
accordingly during implementation.
```

```bash
git add docs/superpowers/specs/2026-06-06-inbox-recommendations-design.md
git commit -m "feat(inbox): v2.1 live smoke pass — delete/undo/chips/triage verified"
```

---

## Self-review notes (run after drafting — issues found and fixed inline)

- **Spec coverage:** §1 delete ✓ (T3/T4), §2 undo toast+drawer+stats ✓ (T1/T2/T3/T4)
  — with the Message-ID mechanism replaced by subject+from search (himalaya has
  no header search; verified live, recorded in T9 status note), §3 layers+chip ✓
  (T5/T6), §4 triage+intents ✓ (T7/T8), §6 tests ✓ (per task), §7 increments ✓
  (T1-4 / T5-6 / T7-9).
- **Latent bug fixed en route:** router previously `await`ed endpoint-shaped
  `email_himalaya.archive()` which returns a JSONResponse on failure → failed
  IMAP moves still dismissed the card. T3 switches to raising `move_message`
  and pins the regression with a test.
- **Type consistency:** `undoTs` (router) = `data.undoTs` (UI); `rec {action,
  by, reason, confidence?}` consistent T5/T6/T7; `state.set_recs(new,
  live_keys, now_ms)` signature matches T1 tests and T7 caller; `ALLOWED`
  defined once in recommend.py and reused by parse + pick.
- **documents source** (added by a concurrent session after the v2 spec) is
  included: ALLOWED table row, fake-source loops in tests patch ALL of
  `inbox.SOURCES`, triage prompt names it.
```
