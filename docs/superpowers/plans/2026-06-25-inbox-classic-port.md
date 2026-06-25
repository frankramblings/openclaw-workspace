# Inbox Classic Port + Obsidian→Asana Capture — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the classic Inbox's full triage capability inside the current redesign shell, and add an "Add to Asana" action that captures surfaced Obsidian commitments as dated tasks.

**Architecture:** Frontend re-wiring against an already-live backend. A pure logic layer (`inbox-logic.js`) and an action layer (`inbox.js`) already exist and are unit-tested; the render layer (`inboxSurface`, `mInbox`) was never wired to them. We wire the render layer, add the genuinely-missing interactive pieces (reader, snooze, undo/history, real triage, Hand-to-Gary, rec chip), then add one new backend capability (create/delete an Asana task) plus its frontend action and a triage-computed due date.

**Tech Stack:** Vanilla ES modules (string-template render + `data-act` event delegation), FastAPI (Python) backend, `httpx` for Asana REST, pytest (backend), self-executing `node:assert` `.mjs` scripts (frontend logic).

## Global Constraints

- **Canonical edit dir:** `frontend-overrides/` only. Never edit generated `frontend/`. After frontend changes run `bash scripts/sync-frontend.sh` to rebuild `frontend/`.
- **Deploy:** changes go live only after `systemctl --user restart openclaw-workspace.service` (Gary runs this at the end).
- **Dismissed ids are STRINGS** everywhere. Remove the leftover numeric mock `dismiss` (`app.js`) and `Number(d.id)` gesture cast (`mobile-app.js`).
- **Keep the current aesthetic** — extend `inboxSurface`/`mInbox` markup; do not revert to the classic look.
- **Optimistic + revert** pattern for actions (see `runAction` in `live/inbox.js`): mark dismissed → render → POST → on failure unmark → render.
- **Fail soft:** `load()` throwing keeps the prior render; per-source action errors surface in a toast and restore the card.
- **Asana target:** project = `asana_project_gid()` (Frank To-Dos), section = Backlog. Backlog section gid fallback constant: `1206274018380402`.
- **No new auth.** Gmail (himalaya), Slack (keychain), Asana PAT already wired.
- **JS logic tests** run via `node scripts/test/<file>.test.mjs` (no test runner/`package.json`). **Backend tests** via `python -m pytest backend/tests/<file> -v`.
- **Commit per green task.** Branch: `inbox-classic-port` (already created).

**Build order:** Slice A (render rewire — foundation) → Slice D (Obsidian→Asana, Frank's headline) → Slice B (reader/triage/Gary/rec chip) → Slice C (snooze/undo/history/mobile gestures). D's frontend depends on A's card-action row; D's backend tasks (D1–D4) are independent and may run in parallel.

---

## SLICE A — Render rewire (make the existing logic visible)

### Task A1: Desktop card action row from `cardActions()`

**Files:**
- Modify: `frontend-overrides/js/redesign/surfaces.js` (`inboxSurface`, `needsCard`/`fyiCard`)
- Modify: `frontend-overrides/js/redesign/live/inbox-logic.js` (add `cardButtonsHtml` helper for testability)
- Test: `scripts/test/inbox-logic.test.mjs` (extend)

**Interfaces:**
- Consumes: `cardActions(item)` → ordered `[{action,label,role}]` (role ∈ `primary|ghost|icon|x`).
- Produces: `cardButtonsHtml(item, esc)` → HTML string for a card's action row, used by `inboxSurface` and (Task A3) `mInbox`.

- [ ] **Step 1: Write the failing test** — append to `scripts/test/inbox-logic.test.mjs`:

```js
// --- cardButtonsHtml: renders real per-action data-act, not hardcoded dismiss ---
import { cardButtonsHtml } from '../../frontend-overrides/js/redesign/live/inbox-logic.js';
const idEsc = (x) => String(x);
const html = cardButtonsHtml(
  { id: 'a1', source: 'gmail', actions: ['archive', 'delete', 'dismiss', 'snooze'] }, idEsc);
assert.ok(html.includes('data-act="archive"'), 'primary archive button present');
assert.ok(html.includes('data-act="delete"'), 'ghost delete button present');
assert.ok(html.includes('data-act="open"'), 'open affordance present');
assert.ok(html.includes('data-act="snooze"'), 'snooze affordance present');
assert.ok(html.includes('data-act="gary"'), 'hand-to-gary affordance present');
assert.ok(html.includes('data-act="dismiss"'), 'dismiss ✕ present');
assert.ok(html.includes('data-arg="a1"'), 'every button carries the item id');
assert.ok(!/data-act="dismiss"[^>]*>Archive/.test(html), 'Archive is not wired to dismiss');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test/inbox-logic.test.mjs`
Expected: FAIL — `cardButtonsHtml is not a function` (or import error).

- [ ] **Step 3: Implement `cardButtonsHtml`** in `inbox-logic.js` (append):

```js
// Render the ordered action row for a card. `esc` is the caller's HTML-escaper.
// primary → solid btn; ghost → ghost btn; icon → small affordance; x → the ✕.
export function cardButtonsHtml(item, esc) {
  const id = esc(String(item && item.id));
  const btns = cardActions(item).map((b) => {
    if (b.role === 'x') {
      return `<button class="inbox-x" data-act="dismiss" data-arg="${id}" title="Dismiss">✕</button>`;
    }
    if (b.role === 'icon') {
      const glyph = b.action === 'open' ? '↗' : b.action === 'snooze' ? '⏰' : '🤖';
      return `<button class="ic-btn" data-act="${esc(b.action)}" data-arg="${id}" title="${esc(b.label)}">${glyph}</button>`;
    }
    const cls = b.role === 'primary' ? 'btn-sm' : 'btn-sm ghost';
    return `<button class="${cls}" data-act="${esc(b.action)}" data-arg="${id}">${esc(b.label)}</button>`;
  });
  return `<div class="card-actions">${btns.join('')}</div>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/test/inbox-logic.test.mjs`
Expected: PASS — prints `inbox-logic: all assertions OK`.

- [ ] **Step 5: Wire `inboxSurface` to use it.** In `surfaces.js`, replace the `<div class="card-actions">…</div>` line inside `needsCard` and the one inside `fyiCard` with `${cardButtonsHtml(it, esc)}`. Add `cardButtonsHtml` to the existing import on line 7:

```js
import { cardActions, filterVisible, sourceCounts, cardButtonsHtml } from './live/inbox-logic.js';
```

Also change the visible-derivation line to share the logic helper (keeps string-id semantics):

```js
const visible = filterVisible(items, { dismissed: s.dismissed, filter: s.inboxFilter });
```

- [ ] **Step 6: Verify render in the running app**

Run: `bash scripts/sync-frontend.sh && systemctl --user restart openclaw-workspace.service`
Then load the Inbox surface and confirm each card shows real buttons (Archive/Mark read/Complete/Reviewed + ↗ ⏰ 🤖 ✕) and that clicking e.g. Archive on a gmail card removes it (network tab shows `POST /api/items/action {action:"archive"}`). Capture a screenshot via the terminal/browser.

- [ ] **Step 7: Commit**

```bash
git add frontend-overrides/js/redesign/live/inbox-logic.js frontend-overrides/js/redesign/surfaces.js scripts/test/inbox-logic.test.mjs frontend
git commit -m "Inbox: wire desktop card action row to real per-source actions"
```

### Task A2: Desktop filter chips (real filtering, backend counts, all sources, error badges)

**Files:**
- Modify: `frontend-overrides/js/redesign/surfaces.js` (`inboxSurface` head/chips)
- Modify: `frontend-overrides/js/redesign/live/inbox-logic.js` (add `chipRowHtml`)
- Test: `scripts/test/inbox-logic.test.mjs`

**Interfaces:**
- Consumes: `sourceCounts(items,opts,backendSources)`, `state.inboxFilter`, `state.live.inbox.errors`.
- Produces: `chipRowHtml(counts, {filter, errors}, esc)` → chip row HTML with `data-act="setFilter"`.

- [ ] **Step 1: Write the failing test** (append to `inbox-logic.test.mjs`):

```js
import { chipRowHtml } from '../../frontend-overrides/js/redesign/live/inbox-logic.js';
const chips = chipRowHtml(
  { all: 5, GMAIL: 3, SLACK: 2, OBSIDIAN: 1 },
  { filter: 'GMAIL', errors: { slack: 'timeout' } },
  (x) => String(x));
assert.ok(chips.includes('data-act="setFilter"'), 'chips are clickable');
assert.ok(chips.includes('data-arg="ALL"'), 'All chip present');
assert.ok(chips.includes('data-arg="OBSIDIAN"'), 'obsidian chip present');
assert.ok(/data-arg="GMAIL"[^>]*class="[^"]*active/.test(chips) ||
          /class="[^"]*active[^"]*"[^>]*data-arg="GMAIL"/.test(chips),
  'active class on the filtered chip');
assert.ok(chips.includes('⚠'), 'error badge shown for slack');
```

- [ ] **Step 2: Run to verify it fails**

Run: `node scripts/test/inbox-logic.test.mjs`
Expected: FAIL — `chipRowHtml is not a function`.

- [ ] **Step 3: Implement `chipRowHtml`** in `inbox-logic.js`:

```js
const CHIP_DOT = { GMAIL: 'var(--red)', SLACK: 'var(--green)', ASANA: 'var(--gold)',
  OBSIDIAN: 'var(--purple, #b794f6)', DOCUMENTS: 'var(--blue, #6aa6f0)' };

export function chipRowHtml(counts, opts, esc) {
  const filter = (opts && opts.filter) || null;
  const errors = (opts && opts.errors) || {};
  const errUp = {}; for (const k of Object.keys(errors)) errUp[k.toUpperCase()] = true;
  const chip = (key, label, n) => {
    const active = (key === 'ALL' && !filter) || key === filter;
    const dot = key === 'ALL' ? '' : `<span class="dot" style="background:${CHIP_DOT[key] || 'var(--muted)'}"></span>`;
    const warn = errUp[key] ? ' <span class="chip-warn" title="source error">⚠</span>' : '';
    return `<span class="src-chip${active ? ' active' : ''}" data-act="setFilter" data-arg="${key}">${dot}${esc(label)} ${n || 0}${warn}</span>`;
  };
  const order = ['GMAIL', 'SLACK', 'ASANA', 'OBSIDIAN', 'DOCUMENTS'];
  const present = order.filter((k) => k in counts || errUp[k]);
  return `<div class="src-chips">${chip('ALL', 'All', counts.all)}${present.map((k) => chip(k, k.toLowerCase(), counts[k])).join('')}</div>`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node scripts/test/inbox-logic.test.mjs`
Expected: PASS.

- [ ] **Step 5: Wire `inboxSurface`.** Import `chipRowHtml` (extend line 7 import). Replace the hardcoded `<div class="src-chips">…</div>` block with:

```js
${chipRowHtml(
  sourceCounts(items, { dismissed: s.dismissed }, s.live?.inbox?.sources),
  { filter: s.inboxFilter, errors: s.live?.inbox?.errors || {} },
  esc)}
```

- [ ] **Step 6: Verify in the running app**

Run: `bash scripts/sync-frontend.sh && systemctl --user restart openclaw-workspace.service`
Confirm: chips show all present sources incl. obsidian with backend counts; clicking a chip filters the feed and toggles off when tapped again; a source with an error shows ⚠. Screenshot.

- [ ] **Step 7: Commit**

```bash
git add frontend-overrides/js/redesign/live/inbox-logic.js frontend-overrides/js/redesign/surfaces.js scripts/test/inbox-logic.test.mjs frontend
git commit -m "Inbox: interactive desktop filter chips with backend counts + error badges"
```

### Task A3: Mobile card action row + chips parity; fix string-id desync

**Files:**
- Modify: `frontend-overrides/js/redesign/mobile/mobile-surfaces.js` (`mInbox`)
- Modify: `frontend-overrides/js/redesign/app.js` (remove numeric mock `dismiss`/`triageAll`)
- Modify: `frontend-overrides/js/redesign/mobile/mobile-app.js` (gesture `Number(d.id)` → string)

**Interfaces:**
- Consumes: `cardButtonsHtml`, `chipRowHtml`, `filterVisible`, `sourceCounts` (from A1/A2).

- [ ] **Step 1: Wire `mInbox` swipe/fyi cards.** In `mobile-surfaces.js`, import the helpers:

```js
import { cardButtonsHtml, chipRowHtml, filterVisible, sourceCounts } from '../live/inbox-logic.js';
```

Replace the `visible` line with `const visible = filterVisible(items, { dismissed: s.dismissed, filter: s.inboxFilter });`. Replace the `.actions` div inside `swipeCard` and inside `fyiCard` with `${cardButtonsHtml(it, esc)}`. Replace the hardcoded `m-chip` block with `${chipRowHtml(sourceCounts(items, { dismissed: s.dismissed }, s.live?.inbox?.sources), { filter: s.inboxFilter, errors: s.live?.inbox?.errors || {} }, esc)}`.

- [ ] **Step 2: Remove the numeric mock actions.** In `app.js`, delete the mock `dismiss:` and `triageAll:` entries in the `actions` object (the ones doing `Number(id)` / `[3,4,5]`) — the live module supplies string-id versions via `loadSurface`'s merge. Confirm by grep:

Run: `grep -n "Number(id)\|\[3, 4, 5\]\|\[3,4,5\]" frontend-overrides/js/redesign/app.js`
Expected: no matches after edit.

- [ ] **Step 3: Fix the gesture id cast.** In `mobile-app.js`, change `commitArchive(Number(d.id))` to `commitArchive(String(d.id))`, and in `app.js`'s `wireMobileGestures({... commitArchive: (id) => actions.dismiss(id) ...})` ensure no `Number()` wraps the id.

Run: `grep -n "Number(d.id)\|Number(id)" frontend-overrides/js/redesign/mobile/mobile-app.js frontend-overrides/js/redesign/app.js`
Expected: no matches.

- [ ] **Step 4: Verify on a mobile viewport**

Run: `bash scripts/sync-frontend.sh && systemctl --user restart openclaw-workspace.service`
In a ≤768px viewport, confirm mobile inbox cards show real action buttons + chips, chip filtering works, and a left-swipe still archives (now with a string id — dismiss persists across re-render). Screenshot.

- [ ] **Step 5: Commit**

```bash
git add frontend-overrides/js/redesign/mobile/mobile-surfaces.js frontend-overrides/js/redesign/app.js frontend-overrides/js/redesign/mobile/mobile-app.js frontend
git commit -m "Inbox: mobile card actions + chips parity; normalize dismissed ids to strings"
```

---

## SLICE D — Obsidian → Asana capture (backend + frontend)

### Task D1: Backend `asana.create_task` + `delete_task`

**Files:**
- Modify: `backend/inbox/sources/asana.py` (add `create_task`, `delete_task`)
- Test: `backend/tests/test_inbox_asana.py`

**Interfaces:**
- Produces: `async create_task(name: str, notes: str, due_on: str | None, section_gid: str | None) -> str` (returns new task gid); `async delete_task(gid: str) -> None`.
- Consumes: existing `_api(method, path, body)`, `settings.asana_project_gid()`.

- [ ] **Step 1: Write the failing test** — append to `backend/tests/test_inbox_asana.py`:

```python
import pytest
from backend.inbox.sources import asana

@pytest.mark.asyncio
async def test_create_task_posts_to_project(monkeypatch):
    calls = {}
    async def fake_api(method, path, body=None):
        calls["method"], calls["path"], calls["body"] = method, path, body
        return {"data": {"gid": "999"}}
    monkeypatch.setattr(asana, "_api", fake_api)
    monkeypatch.setattr(asana._inbox_settings, "asana_project_gid", lambda: "PROJ")
    gid = await asana.create_task("Follow up with Taylor", "from meeting note", "2026-07-01", "SEC")
    assert gid == "999"
    assert calls["method"] == "POST"
    assert calls["path"] == "/tasks"
    data = calls["body"]["data"]
    assert data["name"] == "Follow up with Taylor"
    assert data["notes"] == "from meeting note"
    assert data["due_on"] == "2026-07-01"
    # placed in the Backlog section of the project
    assert {"project": "PROJ", "section": "SEC"} in data["memberships"]

@pytest.mark.asyncio
async def test_create_task_without_due_or_section(monkeypatch):
    captured = {}
    async def fake_api(method, path, body=None):
        captured["body"] = body
        return {"data": {"gid": "1"}}
    monkeypatch.setattr(asana, "_api", fake_api)
    monkeypatch.setattr(asana._inbox_settings, "asana_project_gid", lambda: "PROJ")
    await asana.create_task("x", "y", None, None)
    data = captured["body"]["data"]
    assert "due_on" not in data
    assert data["projects"] == ["PROJ"]

@pytest.mark.asyncio
async def test_delete_task(monkeypatch):
    calls = {}
    async def fake_api(method, path, body=None):
        calls["method"], calls["path"] = method, path
        return {"data": {}}
    monkeypatch.setattr(asana, "_api", fake_api)
    await asana.delete_task("42")
    assert calls["method"] == "DELETE"
    assert calls["path"] == "/tasks/42"
```

- [ ] **Step 2: Run to verify it fails**

Run: `python -m pytest backend/tests/test_inbox_asana.py -k "create_task or delete_task" -v`
Expected: FAIL — `AttributeError: module … has no attribute 'create_task'`.

- [ ] **Step 3: Implement** in `backend/inbox/sources/asana.py`:

```python
async def create_task(name: str, notes: str, due_on: str | None,
                      section_gid: str | None) -> str:
    """Create a task in the Frank To-Dos project. When section_gid is given the
    task is placed in that section via memberships; otherwise it lands in the
    project's default section. Returns the new task gid."""
    project = _inbox_settings.asana_project_gid()
    data: dict = {"name": name, "notes": notes}
    if section_gid:
        data["memberships"] = [{"project": project, "section": section_gid}]
    else:
        data["projects"] = [project]
    if due_on:
        data["due_on"] = due_on
    resp = await _api("POST", "/tasks", {"data": data})
    return str(resp["data"]["gid"])


async def delete_task(gid: str) -> None:
    await _api("DELETE", f"/tasks/{gid}")
```

- [ ] **Step 4: Run to verify it passes**

Run: `python -m pytest backend/tests/test_inbox_asana.py -k "create_task or delete_task" -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/inbox/sources/asana.py backend/tests/test_inbox_asana.py
git commit -m "Asana: create_task + delete_task helpers for inbox capture"
```

### Task D2: Backend `settings.asana_section_gid()` (Backlog)

**Files:**
- Modify: `backend/inbox/settings.py`
- Test: `backend/tests/test_inbox_settings.py`

**Interfaces:**
- Produces: `asana_section_gid() -> str` — env `ASANA_SECTION_GID` > inbox.json `asana.section_gid` > default `"1206274018380402"` (Frank To-Dos → Backlog).

- [ ] **Step 1: Write the failing test** — append to `backend/tests/test_inbox_settings.py`:

```python
from backend.inbox import settings

def test_asana_section_gid_default(monkeypatch):
    monkeypatch.delenv("ASANA_SECTION_GID", raising=False)
    monkeypatch.setattr(settings, "_coll", lambda name: {})
    assert settings.asana_section_gid() == "1206274018380402"

def test_asana_section_gid_env_wins(monkeypatch):
    monkeypatch.setenv("ASANA_SECTION_GID", "ENVSEC")
    assert settings.asana_section_gid() == "ENVSEC"

def test_asana_section_gid_from_inbox_json(monkeypatch):
    monkeypatch.delenv("ASANA_SECTION_GID", raising=False)
    monkeypatch.setattr(settings, "_coll", lambda name: {"section_gid": "JSONSEC"})
    assert settings.asana_section_gid() == "JSONSEC"
```

(If `_coll` is not the helper name used by `asana_project_gid`, match that file's actual accessor — check `asana_project_gid` in `settings.py`.)

- [ ] **Step 2: Run to verify it fails**

Run: `python -m pytest backend/tests/test_inbox_settings.py -k section_gid -v`
Expected: FAIL — `AttributeError: … 'asana_section_gid'`.

- [ ] **Step 3: Implement** in `backend/inbox/settings.py` (next to `asana_project_gid`):

```python
def asana_section_gid() -> str:
    """Asana section GID for new captured tasks. Env ASANA_SECTION_GID >
    inbox.json asana.section_gid > Frank To-Dos → Backlog default."""
    return (os.environ.get("ASANA_SECTION_GID")
            or _coll("asana").get("section_gid")
            or "1206274018380402")
```

- [ ] **Step 4: Run to verify it passes**

Run: `python -m pytest backend/tests/test_inbox_settings.py -k section_gid -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/inbox/settings.py backend/tests/test_inbox_settings.py
git commit -m "inbox settings: asana_section_gid (Backlog default)"
```

### Task D3: Backend `add_asana` action + undo-by-delete

**Files:**
- Modify: `backend/inbox/__init__.py` (`action` endpoint)
- Test: `backend/tests/test_inbox_router.py`

**Interfaces:**
- Consumes: `asana.create_task`, `asana.delete_task` (D1), `settings.asana_section_gid` (D2), `state.dismiss/undismiss/log_action`.
- Produces: action `add_asana` valid for **any** source; payload may carry `task` (str) and `due` (ISO `YYYY-MM-DD` or epoch-ms). On success dismisses the item (reason `added_to_asana`) and returns `{ok, undoTs}`; `undo = {"asana_delete_gid": <gid>}`. Undo path in `items_undo` deletes the task.

- [ ] **Step 1: Write the failing test** — append to `backend/tests/test_inbox_router.py` (mirror the existing router test style/fixtures in that file):

```python
def test_add_asana_creates_and_dismisses(client, monkeypatch):
    from backend.inbox import sources
    created = {}
    async def fake_create(name, notes, due_on, section_gid):
        created.update(name=name, notes=notes, due_on=due_on, section=section_gid)
        return "TASK123"
    monkeypatch.setattr(sources.asana, "create_task", fake_create)
    r = client.post("/api/items/action", json={
        "source": "obsidian", "id": "abc", "action": "add_asana",
        "title": "Send Q3 deck to Taylor", "task": "Send Q3 deck to Taylor",
        "due": "2026-07-03", "meta": {"url": "obsidian://note"}})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True and isinstance(body["undoTs"], int)
    assert created["name"] == "Send Q3 deck to Taylor"
    assert created["due_on"] == "2026-07-03"
    assert "obsidian://note" in created["notes"]

def test_add_asana_undo_deletes_task(client, monkeypatch):
    from backend.inbox import sources
    async def fake_create(name, notes, due_on, section_gid): return "T9"
    deleted = {}
    async def fake_delete(gid): deleted["gid"] = gid
    monkeypatch.setattr(sources.asana, "create_task", fake_create)
    monkeypatch.setattr(sources.asana, "delete_task", fake_delete)
    ts = client.post("/api/items/action", json={
        "source": "obsidian", "id": "z", "action": "add_asana",
        "title": "t"}).json()["undoTs"]
    r = client.post("/api/items/undo", json={"ts": ts})
    assert r.status_code == 200 and r.json()["ok"] is True
    assert deleted["gid"] == "T9"
```

- [ ] **Step 2: Run to verify it fails**

Run: `python -m pytest backend/tests/test_inbox_router.py -k add_asana -v`
Expected: FAIL — `add_asana` returns 400 "unknown action".

- [ ] **Step 3: Implement.** In `backend/inbox/__init__.py`, add a branch in `action()` before the final `else`. Note `add_asana` is allowed for any source, so place it where it isn't gated by a source check:

```python
        elif act == "add_asana":
            from datetime import datetime, timezone
            due = payload.get("due")
            due_on = None
            if isinstance(due, str) and due.strip():
                due_on = due.strip()[:10]
            elif isinstance(due, (int, float)) and due > 0:
                due_on = datetime.fromtimestamp(due / 1000, tz=timezone.utc).date().isoformat()
            task_name = (payload.get("task") or title or "Follow-up")[:140]
            url = meta.get("url") or ""
            notes = (f"Captured from your inbox ({source}).\n\n"
                     f"{(payload.get('snippet') or title or '')[:1000]}\n\n"
                     + (f"Source: {url}" if url else "")).strip()
            gid = await asana.create_task(
                task_name, notes, due_on, settings.asana_section_gid())
            state.dismiss(source, item_id, "added_to_asana")
            undo = {"asana_delete_gid": gid}
```

Add the undo branch in `items_undo` alongside the existing `folder`/`asana_gid` handling:

```python
        elif "asana_delete_gid" in undo:            # add_asana → delete the task
            await asana.delete_task(undo["asana_delete_gid"])
```

Ensure `from . import ... settings` and `asana` are importable in this module (asana is `from .sources import asana`).

- [ ] **Step 4: Run to verify it passes**

Run: `python -m pytest backend/tests/test_inbox_router.py -k add_asana -v`
Expected: PASS (2 tests). Then full suite: `python -m pytest backend/tests/ -q` — Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/inbox/__init__.py backend/tests/test_inbox_router.py
git commit -m "inbox: add_asana action creates a task; undo deletes it"
```

### Task D4: Triage suggests `task` + `due` for Obsidian items

**Files:**
- Modify: `backend/inbox/recommend.py` (`ALLOWED`, `build_triage_prompt`, `parse_triage_reply`)
- Test: `backend/tests/test_inbox_recommend.py`

**Interfaces:**
- Produces: for `obsidian` items, the parsed rec may include `task: str` and `due: "YYYY-MM-DD"|None`; `ALLOWED["obsidian"]` gains `add_asana`.

- [ ] **Step 1: Write the failing test** — append to `backend/tests/test_inbox_recommend.py`:

```python
from backend.inbox import recommend

def test_obsidian_allows_add_asana():
    assert "add_asana" in recommend.ALLOWED["obsidian"]

def test_parse_keeps_task_and_due_for_obsidian():
    valid = {"o1": "obsidian"}
    reply = ('[{"id":"o1","action":"add_asana","confidence":"high",'
             '"reason":"commitment to Taylor","task":"Send Q3 deck",'
             '"due":"2026-07-03"}]')
    out = recommend.parse_triage_reply(reply, valid, now_ms=0)
    rec = out["obsidian:o1"]
    assert rec["action"] == "add_asana"
    assert rec["task"] == "Send Q3 deck"
    assert rec["due"] == "2026-07-03"

def test_parse_ignores_task_due_for_non_obsidian():
    valid = {"g1": "gmail"}
    reply = '[{"id":"g1","action":"archive","task":"x","due":"2026-01-01"}]'
    rec = recommend.parse_triage_reply(reply, valid, now_ms=0)["gmail:g1"]
    assert "task" not in rec and "due" not in rec
```

- [ ] **Step 2: Run to verify it fails**

Run: `python -m pytest backend/tests/test_inbox_recommend.py -k "add_asana or task_and_due or non_obsidian" -v`
Expected: FAIL — `add_asana` not in ALLOWED["obsidian"]; task/due not retained.

- [ ] **Step 3: Implement.** In `recommend.py`:

1. Add `add_asana` to the obsidian allowed set (find the `ALLOWED` dict): `"obsidian": {"reviewed", "add_asana", "gary", "none"}`.
2. In `build_triage_prompt`, change the obsidian guidance line and add the extra-field instruction:

```python
        "  obsidian: add_asana|reviewed|gary|none",
```
and after the JSON shape line, append:
```python
        "For obsidian items prefer add_asana (capture the commitment as a task) "
        "and ALSO return \"task\" (a cleaned imperative ≤12 words) and \"due\" "
        "(YYYY-MM-DD). Honor explicit dates in the text relative to today; if none, "
        "pick a sensible near-term date (≈3 business days out). Use \"reviewed\" "
        "only for pure FYI lines, \"none\" when unsure.",
```

3. In `parse_triage_reply`, after building the base `out[...]` entry, enrich obsidian:

```python
        if source == "obsidian":
            task = e.get("task")
            if isinstance(task, str) and task.strip():
                out[f"{source}:{iid}"]["task"] = task.strip()[:140]
            due = e.get("due")
            if isinstance(due, str) and len(due.strip()) >= 8:
                out[f"{source}:{iid}"]["due"] = due.strip()[:10]
```

- [ ] **Step 4: Run to verify it passes**

Run: `python -m pytest backend/tests/test_inbox_recommend.py -v`
Expected: PASS (all, including new + existing).

- [ ] **Step 5: Commit**

```bash
git add backend/inbox/recommend.py backend/tests/test_inbox_recommend.py
git commit -m "inbox triage: obsidian items suggest add_asana task + due date"
```

### Task D5: Frontend due-date chip math helper

**Files:**
- Modify: `frontend-overrides/js/redesign/live/inbox-logic.js` (add `dueChipToISO`)
- Test: `scripts/test/inbox-logic.test.mjs`

**Interfaces:**
- Produces: `dueChipToISO(chip, nowMs) -> "YYYY-MM-DD" | null` for chips `today|tomorrow|fri|nextweek|none`. Pure (takes `nowMs`).

- [ ] **Step 1: Write the failing test** (append):

```js
import { dueChipToISO } from '../../frontend-overrides/js/redesign/live/inbox-logic.js';
const MON = Date.UTC(2026, 5, 29, 12, 0, 0); // 2026-06-29 is a Monday (UTC noon)
assert.equal(dueChipToISO('today', MON), '2026-06-29');
assert.equal(dueChipToISO('tomorrow', MON), '2026-06-30');
assert.equal(dueChipToISO('fri', MON), '2026-07-03', 'next Friday from Mon');
assert.equal(dueChipToISO('nextweek', MON), '2026-07-06', 'next Monday');
assert.equal(dueChipToISO('none', MON), null);
```

- [ ] **Step 2: Run to verify it fails**

Run: `node scripts/test/inbox-logic.test.mjs`
Expected: FAIL — `dueChipToISO is not a function`.

- [ ] **Step 3: Implement** in `inbox-logic.js`:

```js
function _iso(ms) { return new Date(ms).toISOString().slice(0, 10); }
const DAY = 86400000;
export function dueChipToISO(chip, nowMs) {
  const c = String(chip || '').toLowerCase();
  const d = new Date(nowMs);
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  if (c === 'none') return null;
  if (c === 'today') return _iso(nowMs);
  if (c === 'tomorrow') return _iso(nowMs + DAY);
  if (c === 'fri') { let add = (5 - dow + 7) % 7; if (add === 0) add = 7; return _iso(nowMs + add * DAY); }
  if (c === 'nextweek') { const add = ((1 - dow + 7) % 7) || 7; return _iso(nowMs + add * DAY); }
  return null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node scripts/test/inbox-logic.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend-overrides/js/redesign/live/inbox-logic.js scripts/test/inbox-logic.test.mjs
git commit -m "inbox: dueChipToISO helper for Add-to-Asana date chips"
```

### Task D6: Frontend `addAsana` action, Obsidian primary, toast, edit sheet

**Files:**
- Modify: `frontend-overrides/js/redesign/live/inbox.js` (add `addAsana`, `addAsanaEdit`, `pickDue`, `confirmAddAsana`, `closeEdit`)
- Modify: `frontend-overrides/js/redesign/live/inbox-logic.js` (`cardActions`: obsidian primary = `add_asana`; show proposed due from rec)
- Modify: `frontend-overrides/js/redesign/surfaces.js` (`inboxSurface`: render edit sheet when `state.inboxEditFor`; show proposed-due chip on obsidian cards)
- Test: `scripts/test/inbox-logic.test.mjs` (cardActions obsidian primary)

**Interfaces:**
- Consumes: `apiJson('/api/items/action', {source,id,action:'add_asana',title,task,due,snippet,meta})`, `dueChipToISO`, `state._lastUndoTs`.
- Produces: `state.inboxEditFor = {id, task, due}` for the edit sheet; toast via `state.inboxToast` (Task C2 renders it — until then, a minimal inline toast).

- [ ] **Step 1: Write the failing test** (append to `inbox-logic.test.mjs`):

```js
// Obsidian primary becomes Add to Asana (not Reviewed) when add_asana is allowed.
const obsA = cardActions({ source: 'obsidian', actions: ['add_asana', 'reviewed', 'dismiss', 'snooze'] });
const obsPrim = obsA.find((a) => a.role === 'primary');
assert.equal(obsPrim.action, 'add_asana', 'obsidian primary = add to asana');
assert.equal(obsPrim.label, 'Add to Asana');
// reviewed remains available as a ghost (plain hide).
assert.ok(obsA.some((a) => a.action === 'reviewed' && a.role === 'ghost'));
```

- [ ] **Step 2: Run to verify it fails**

Run: `node scripts/test/inbox-logic.test.mjs`
Expected: FAIL — obsidian primary is still `reviewed`.

- [ ] **Step 3: Implement logic changes.** In `inbox-logic.js`:
- Add to `ACTION_LABEL`: `add_asana: 'Add to Asana',`.
- Add `'add_asana'` to the front of `CLEAR_VERBS` so it wins as primary for obsidian: `const CLEAR_VERBS = ['add_asana', 'archive', 'mark_read', 'complete', 'reviewed'];`.

In `inbox.js`, add the actions:

```js
  // Obsidian capture: create an Asana task from the surfaced commitment.
  addAsana: async (id) => {
    const state = runtime.state;
    const item = findItem(state, id);
    if (!item) return;
    const rec = item.rec || {};
    const payload = {
      source: item.source, id: String(id), action: 'add_asana',
      title: item.who, task: rec.task || item.who,
      due: rec.due || null, snippet: item.body, meta: item.meta || {},
    };
    markDismissed(state, id);
    runtime.render();
    try {
      const r = await apiJson('/api/items/action', payload);
      if (r && r.ok === false) throw new Error(r.error || 'add failed');
      if (r && r.undoTs) {
        state._lastUndoTs = r.undoTs;
        state.inboxToast = { msg: `Added → ${payload.due ? 'due ' + payload.due : 'no due date'}`, undoTs: r.undoTs };
      }
    } catch (e) {
      unmarkDismissed(state, id);
      state.inboxToast = { msg: "Couldn't add to Asana — retry", undoTs: null };
    }
    runtime.render();
  },

  // Open the quick edit sheet (long-press / "Edit") to adjust name + due first.
  addAsanaEdit: (id) => {
    const state = runtime.state;
    const item = findItem(state, id);
    if (!item) return;
    const rec = item.rec || {};
    state.inboxEditFor = { id: String(id), task: rec.task || item.who, due: rec.due || null };
    runtime.render();
  },
  pickDue: (chip) => {
    const state = runtime.state;
    if (!state.inboxEditFor) return;
    state.inboxEditFor = { ...state.inboxEditFor, due: dueChipToISO(chip, Date.now()) };
    runtime.render();
  },
  closeEdit: () => { runtime.state.inboxEditFor = null; runtime.render(); },
  confirmAddAsana: async () => {
    const state = runtime.state;
    const edit = state.inboxEditFor;
    if (!edit) return;
    const item = findItem(state, edit.id);
    state.inboxEditFor = null;
    if (!item) { runtime.render(); return; }
    markDismissed(state, edit.id);
    runtime.render();
    try {
      const r = await apiJson('/api/items/action', {
        source: item.source, id: edit.id, action: 'add_asana',
        title: item.who, task: edit.task, due: edit.due,
        snippet: item.body, meta: item.meta || {},
      });
      if (r && r.ok === false) throw new Error(r.error || 'add failed');
      if (r && r.undoTs) { state._lastUndoTs = r.undoTs; state.inboxToast = { msg: `Added → ${edit.due ? 'due ' + edit.due : 'no due date'}`, undoTs: r.undoTs }; }
    } catch (e) {
      unmarkDismissed(state, edit.id);
      state.inboxToast = { msg: "Couldn't add to Asana — retry", undoTs: null };
    }
    runtime.render();
  },
```

Add `dueChipToISO` to the `inbox-logic.js` import in `inbox.js`:
```js
import { srcStyle, openUrlFor, dueChipToISO } from './inbox-logic.js';
```

- [ ] **Step 4: Render the edit sheet + proposed-due chip.** In `surfaces.js` `inboxSurface`, before the closing `</div>` of `inbox-col`, append a state-driven sheet:

```js
    ${when(!!s.inboxEditFor, `
      <div class="inbox-edit-sheet">
        <div class="ies-row"><b>Add to Asana</b><span class="oc-spacer"></span><span data-act="closeEdit" style="cursor:pointer">✕</span></div>
        <input class="set-input" data-model="inboxEditTask" value="${esc((s.inboxEditFor && s.inboxEditFor.task) || '')}" />
        <div class="ies-due">Due: <b>${esc((s.inboxEditFor && s.inboxEditFor.due) || 'none')}</b></div>
        <div class="ies-chips">
          ${['today', 'tomorrow', 'fri', 'nextweek', 'none'].map((c) => `<span class="due-chip" data-act="pickDue" data-arg="${c}">${c}</span>`).join('')}
        </div>
        <div class="ies-actions"><button class="btn-sm" data-act="confirmAddAsana">Add task</button><button class="btn-sm ghost" data-act="closeEdit">Cancel</button></div>
      </div>`)}
```

Bind the edit-task input: add `inboxEditTask` handling to the input listener — simplest is a dedicated `data-model` already handled generically in `app.js` (it sets `state[field] = value`). Since the field lives in `state.inboxEditFor.task`, add a one-line special-case in `app.js`'s input handler: `if (field === 'inboxEditTask' && state.inboxEditFor) { state.inboxEditFor = { ...state.inboxEditFor, task: t.value }; return; }` placed before the generic `state[field] = t.value`.

On obsidian `needsCard`, show the proposed due (from `it.rec.due`) when present — insert after the body line:
```js
${when(it.source === 'obsidian' && it.rec && it.rec.due, `<div class="ai-pill">✦ task · due ${esc((it.rec || {}).due || '')}</div>`)}
```

- [ ] **Step 5: Run logic test + verify in app**

Run: `node scripts/test/inbox-logic.test.mjs` → PASS.
Run: `bash scripts/sync-frontend.sh && systemctl --user restart openclaw-workspace.service`
Then: run `POST /api/items/triage` from the UI (✦ button after Slice B, or `curl` the endpoint), confirm an obsidian card shows "Add to Asana" as primary + a proposed due chip; tap it → toast "Added → due …" and the card leaves; verify a real task appears in Frank To-Dos → Backlog (check Asana). Tap Undo (after C2) or `curl POST /api/items/undo {ts}` → task deleted. Long-press → edit sheet lets you change the date. Screenshot.

- [ ] **Step 6: Commit**

```bash
git add frontend-overrides/js/redesign/live/inbox.js frontend-overrides/js/redesign/live/inbox-logic.js frontend-overrides/js/redesign/surfaces.js frontend-overrides/js/redesign/app.js scripts/test/inbox-logic.test.mjs frontend
git commit -m "inbox: Add-to-Asana action, obsidian default, due chips + edit sheet"
```

---

## SLICE B — Reader, real triage, Hand-to-Gary, rec chip

### Task B1: Real triage wiring

**Files:** Modify `frontend-overrides/js/redesign/live/inbox.js` (`triageAll`); `surfaces.js` button label stays "✦ Triage with Gary".

- [ ] **Step 1:** Replace the placeholder `triageAll` body with a real call:

```js
  triageAll: async () => {
    const state = runtime.state;
    state.inboxToast = { msg: 'Triaging…', undoTs: null };
    runtime.render();
    try {
      const r = await apiJson('/api/items/triage', {});
      if (r && r.ok === false) throw new Error(r.error || 'triage failed');
      await reloadInbox(state);   // refetch so rec chips appear
      state.inboxToast = { msg: `Triaged ${r.scored ?? 0} items`, undoTs: null };
    } catch (e) {
      state.inboxToast = { msg: "Triage unavailable — try again", undoTs: null };
    }
    runtime.render();
  },
```

Add a small `reloadInbox(state)` that re-runs `load(state)` (export `load` is already in the module; call it directly).

- [ ] **Step 2: Verify in app** — click ✦ Triage with Gary; confirm `POST /api/items/triage` fires and rec chips/FYI grouping update. (No unit test — network + render effect.) Screenshot.
- [ ] **Step 3: Commit** `-m "inbox: wire real /api/items/triage (replace bulk-dismiss placeholder)"`

### Task B2: Hand-to-Gary

**Files:** Modify `live/inbox.js` (add `gary` action). The `gary` button already renders (cardActions icon).

- [ ] **Step 1:** Add:

```js
  gary: async (id) => {
    const state = runtime.state;
    const item = findItem(state, id);
    if (!item) return;
    try {
      const r = await apiJson('/api/items/spinoff', {
        item: { source: item.source, title: item.who, subtitle: item.body, snippet: item.body, meta: item.meta || {} },
      });
      const sid = r && r.session_id;
      if (sid) { location.hash = '#chat'; if (runtime.actions && runtime.actions.openSession) runtime.actions.openSession(sid); }
    } catch (_) { state.inboxToast = { msg: "Couldn't hand to Gary", undoTs: null }; runtime.render(); }
  },
```

(Confirm the chat module's open-session action name; if different from `openSession`, match it. If none exists, set `location.hash = '#chat'` and let the chat loader pick up the new session.)

- [ ] **Step 2: Verify** — 🤖 on a card creates a session and navigates to chat with the seeded context. Screenshot.
- [ ] **Step 3: Commit** `-m "inbox: Hand-to-Gary spinoff action"`

### Task B3: Tappable AI rec chip

**Files:** Modify `surfaces.js` (`fyiCard`/`needsCard` rec pill → button); `live/inbox.js` (`applyRec`).

- [ ] **Step 1:** Make the `ai-pill` a button: `<button class="ai-pill" data-act="applyRec" data-arg="${it.id}">✦ ${esc(it.suggest)}</button>`. Add:

```js
  applyRec: (id) => {
    const state = runtime.state;
    const item = findItem(state, id);
    const rec = item && item.rec;
    if (!rec || !rec.action) return;
    const fn = (rec.action === 'gary') ? actions.gary
      : (rec.action === 'add_asana') ? actions.addAsana
      : actions[rec.action];
    if (fn) fn(String(id));
  },
```

- [ ] **Step 2: Verify** — tapping a rec chip performs the recommended action. Screenshot.
- [ ] **Step 3: Commit** `-m "inbox: tappable AI rec chip applies the recommended action"`

### Task B4: Read-in-place reader

**Files:**
- Create: `frontend-overrides/js/redesign/live/inbox-detail.js`
- Modify: `live/inbox.js` (`openReader`, `closeReader`), `surfaces.js` (reader overlay + card body is tappable), `app.js` (nothing — uses data-act)
- Test: `scripts/test/inbox-detail.test.mjs` (pure shaping)

**Interfaces:**
- Produces: `detailEndpoint(item) -> {url, kind} | null` (pure) — slack→`/api/inbox/slack/thread?channel_id&thread_ts`, asana→`/api/inbox/asana/task?gid`, gmail→`/api/email/read/{uid}?mark_seen=false`. `state.inboxReader = {id, kind, data, loading, error}`.

- [ ] **Step 1: Write the failing test** — `scripts/test/inbox-detail.test.mjs`:

```js
import assert from 'node:assert/strict';
import { detailEndpoint } from '../../frontend-overrides/js/redesign/live/inbox-detail.js';
assert.equal(detailEndpoint({ source: 'asana', id: '7', meta: {} }).url, '/api/inbox/asana/task?gid=7');
assert.equal(detailEndpoint({ source: 'slack', meta: { channel: 'C1', thread_ts: '1.2' } }).url,
  '/api/inbox/slack/thread?channel_id=C1&thread_ts=1.2');
assert.equal(detailEndpoint({ source: 'gmail', meta: { uid: '9' } }).url, '/api/email/read/9?mark_seen=false');
assert.equal(detailEndpoint({ source: 'documents', meta: {} }), null);
console.log('inbox-detail: all assertions OK');
```

- [ ] **Step 2: Run to verify it fails** — `node scripts/test/inbox-detail.test.mjs` → FAIL (module missing).
- [ ] **Step 3: Implement `inbox-detail.js`:**

```js
export function detailEndpoint(item) {
  const src = String(item && item.source || '').toLowerCase();
  const m = (item && item.meta) || {};
  if (src === 'asana') return { kind: 'asana', url: `/api/inbox/asana/task?gid=${encodeURIComponent(item.id)}` };
  if (src === 'slack' && m.channel && m.thread_ts)
    return { kind: 'slack', url: `/api/inbox/slack/thread?channel_id=${encodeURIComponent(m.channel)}&thread_ts=${encodeURIComponent(m.thread_ts)}` };
  if (src === 'gmail' && m.uid) return { kind: 'gmail', url: `/api/email/read/${encodeURIComponent(m.uid)}?mark_seen=false` };
  return null;
}
```

- [ ] **Step 4: Run to verify it passes** — `node scripts/test/inbox-detail.test.mjs` → PASS.
- [ ] **Step 5: Add `openReader`/`closeReader`** in `inbox.js` (fetch `detailEndpoint(item).url` via `apiGet`, store on `state.inboxReader`), make the card `.body` carry `data-act="openReader" data-arg="${it.id}"`, and render a reader overlay in `inboxSurface` when `state.inboxReader` is set (email body sanitized via the existing email util import; slack messages list; asana notes+comments). Mobile: reuse a sheet in `mobile-surfaces.js`.
- [ ] **Step 6: Verify in app** — tap a card body for each source; the reader opens with content; close works; failure shows inline error. Screenshot each.
- [ ] **Step 7: Commit** `-m "inbox: read-in-place detail reader (gmail/slack/asana)"`

---

## SLICE C — Snooze, undo/history, mobile gestures

### Task C1: Snooze presets

**Files:** `inbox-logic.js` (add `snoozeUntilMs`), `inbox.js` (`snooze` action + menu state), `surfaces.js` (snooze menu), test in `inbox-logic.test.mjs`.

**Interfaces:** `snoozeUntilMs(preset, nowMs) -> epochMs` for `later|tomorrow|nextweek`.

- [ ] **Step 1: Failing test** (append):

```js
import { snoozeUntilMs } from '../../frontend-overrides/js/redesign/live/inbox-logic.js';
const base = Date.UTC(2026, 5, 29, 12, 0, 0);
assert.ok(snoozeUntilMs('later', base) > base, 'later today is in the future');
assert.equal(new Date(snoozeUntilMs('tomorrow', base)).getUTCDate(), 30, 'tomorrow → next day');
assert.ok(snoozeUntilMs('nextweek', base) - base >= 6 * 86400000, 'nextweek ≥ ~7 days');
```

- [ ] **Step 2:** `node scripts/test/inbox-logic.test.mjs` → FAIL.
- [ ] **Step 3: Implement** `snoozeUntilMs` (later = +4h; tomorrow = next day 09:00 local; nextweek = +7 days 09:00). Add `snooze`/`openSnooze`/`closeSnooze` actions in `inbox.js` calling `apiJson('/api/items/action', {source,id,action:'snooze',until})` with optimistic remove + revert + `_lastUndoTs`. Render a small menu when `state.inboxSnoozeFor === id`.
- [ ] **Step 4:** `node scripts/test/inbox-logic.test.mjs` → PASS; verify in app (snooze removes the card; reappears after `until`). Screenshot.
- [ ] **Step 5: Commit** `-m "inbox: snooze presets (later/tomorrow/next week)"`

### Task C2: Undo toast

**Files:** `inbox.js` (`undo` action consuming `state.inboxToast.undoTs`), `surfaces.js`/`mobile-surfaces.js` (toast host + auto-dismiss), `app.js` (a `setTimeout` to clear `state.inboxToast` after 8s, mirroring `researchTimer`).

- [ ] **Step 1:** Render a toast host fixed at the bottom when `state.inboxToast` is set, with an Undo button (`data-act="undo"`) when `undoTs` is present. Implement:

```js
  undo: async () => {
    const state = runtime.state;
    const ts = state.inboxToast && state.inboxToast.undoTs;
    if (!ts) return;
    try {
      const r = await apiJson('/api/items/undo', { ts });
      if (r && r.ok) { await reloadInbox(state); }
    } catch (_) {}
    state.inboxToast = null;
    runtime.render();
  },
  dismissToast: () => { runtime.state.inboxToast = null; runtime.render(); },
```

- [ ] **Step 2: Verify** — after archive/snooze/add-asana, the toast shows with Undo; clicking Undo restores (gmail un-archives, asana task deletes). Screenshot.
- [ ] **Step 3: Commit** `-m "inbox: undo toast wired to /api/items/undo"`

### Task C3: History drawer

**Files:** `inbox.js` (`toggleHistory`, `loadHistory`), `surfaces.js` (drawer rendering `/api/items/history` with per-row Undo via `undoTs`).

- [ ] **Step 1:** Add a header button `data-act="toggleHistory"` (⏱). On open, fetch `/api/items/history?limit=20` into `state.inboxHistory`; render rows with verb + title + per-row `data-act="undoRow" data-arg="${ts}"`. `undoRow` mirrors `undo` but takes an explicit ts.
- [ ] **Step 2: Verify** — drawer lists recent actions; per-row undo works. Screenshot.
- [ ] **Step 3: Commit** `-m "inbox: history drawer with per-row undo"`

### Task C4: Mobile gestures — right-swipe primary, left-swipe snooze|dismiss

**Files:** `frontend-overrides/js/redesign/mobile/mobile-app.js` (`wireMobileGestures`), `mobile-surfaces.js` (swipe backgrounds), `app.js` (gesture commit callbacks).

- [ ] **Step 1:** Extend the gesture engine: track sign of `dx`. Right-swipe past commit → primary action for the card's source (`actions[primaryVerb(item)]` or `addAsana` for obsidian); left-swipe → reveal Snooze | Dismiss (short = dismiss, long = snooze, matching classic). Update `app.js` `wireMobileGestures({ commitPrimary, commitSnooze, commitDismiss })`. Keep pull-to-refresh.
- [ ] **Step 2:** Add a pure helper `swipeIntent(dx, width) -> 'primary'|'snooze'|'dismiss'|null` in `inbox-logic.js` with a unit test (append to `inbox-logic.test.mjs`): right beyond +84 → primary; left beyond −140 → snooze; left −84..−140 → dismiss; else null.
- [ ] **Step 3:** `node scripts/test/inbox-logic.test.mjs` → PASS; verify on a mobile viewport that right-swipe completes the primary action and left-swipe offers snooze/dismiss. Screenshot.
- [ ] **Step 4: Commit** `-m "inbox: mobile right-swipe primary + left-swipe snooze/dismiss"`

---

## Finalization

- [ ] **F1: Full test pass.** `python -m pytest backend/tests/ -q` and `node scripts/test/inbox-logic.test.mjs && node scripts/test/inbox-detail.test.mjs` — all green.
- [ ] **F2: Build + restart.** `bash scripts/sync-frontend.sh && systemctl --user restart openclaw-workspace.service`. Confirm the service is active: `systemctl --user status openclaw-workspace.service --no-pager | head`.
- [ ] **F3: End-to-end smoke** on desktop + a mobile viewport: per-source actions, click-out, reader, snooze, undo, history, triage, Hand-to-Gary, and the Obsidian→Asana flow (create real task in Frank To-Dos → Backlog with a smart due date, undo deletes it). Capture screenshots.
- [ ] **F4: finishing-a-development-branch** — present merge options (merge to main / PR / keep / discard).

## Self-Review (against the spec)

- Spec features 1–10 + Add-to-Asana → Tasks A1–A3 (actions, filters, mobile), B1–B4 (triage, Gary, rec chip, reader), C1–C4 (snooze, undo, history, swipe), D1–D6 (Asana capture). ✅ All covered.
- Obsidian→Asana as the default action: Task D5 (`CLEAR_VERBS` order) + D3/D4 (backend) + D6 (frontend). ✅
- Smart due date computed in triage, shown on card, one-tap + edit sheet: D4 + D6. ✅
- String-id normalization: A3. ✅
- Reviewed kept as secondary (plain hide): D6 step 1 test asserts `reviewed` ghost remains. ✅
- Deploy via sync + restart, Gary runs it: F2. ✅
- No placeholders: each code step shows real code; the few "match the existing accessor/action name" notes are explicit verification instructions, not deferred work.
