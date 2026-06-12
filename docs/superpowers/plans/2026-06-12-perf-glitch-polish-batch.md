# Perf / Glitch / Polish Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the 8 verified fixes from `docs/superpowers/specs/2026-06-12-perf-glitch-polish-batch.md` — 4 perf (streaming render coalescing, ticker visibility guards, vault-scan thread offload, calendar HTTP client reuse), 2 glitches (elapsed-clock survival, stall-caption dedup), 2 polish (session-delete confirm, honest import results).

**Architecture:** Backend fixes are mechanical async hygiene (move sync disk scans to `asyncio.to_thread`, share one `httpx.AsyncClient`) with shapes pinned by tests. Frontend fixes are surgical edits to `frontend-overrides/js/chat.js` and `js/sessions.js` (full-file overrides — the durable source). Frontend has no test harness: verification is `node --check` + sync + served-bytes curl.

**Tech Stack:** Python 3.14 / FastAPI / pytest; vanilla ES modules; `scripts/sync-frontend.sh` deploy (auto-stamps sw.js CACHE_NAME).

**House rules:** Do NOT touch the uncommitted UI-size work (`frontend-overrides/index.html`, `js/theme.js`, `hermes.css`, `backend/tests/test_inbox_router.py`) — another session's work; commit only files this plan modifies, never `git add -A`. No headless Chrome. At most ONE backend restart, at the very end.

---

### Task 1: Offload documents vault scans to a thread (P3, documents.py)

**Files:**
- Modify: `backend/documents.py:148-205`
- Test: `backend/tests/test_vault_scan_offload.py` (create)

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_vault_scan_offload.py`:

```python
"""The vault list endpoints must do their disk scans off the event loop.

Pins (a) the _scan_docs/_load_all helpers exist and load entries, and
(b) the routes still return the same shapes after the to_thread refactor.
"""
import asyncio

from backend import documents, notes
from backend import vault_store as vs


def _write_doc(dirpath, doc_id, title, session_id="", archived=False):
    entry = {"id": doc_id, "title": title, "language": "markdown",
             "session_id": session_id, "archived": archived,
             "is_active": True, "version_count": 1,
             "created": vs.now_iso(), "updated_at": vs.now_iso(),
             "current_content": f"body of {title}"}
    vs.save_entry(dirpath / f"{doc_id}.md", entry, content_key="current_content")


def test_scan_docs_loads_entries(tmp_path, monkeypatch):
    monkeypatch.setattr(documents, "DOCS_DIR", tmp_path)
    _write_doc(tmp_path, "d1", "Alpha")
    _write_doc(tmp_path, "d2", "Beta", session_id="s9")
    got = documents._scan_docs()
    assert {d["id"] for d in got} == {"d1", "d2"}


def test_library_shape_unchanged(tmp_path, monkeypatch):
    monkeypatch.setattr(documents, "DOCS_DIR", tmp_path)
    _write_doc(tmp_path, "d1", "Alpha")
    _write_doc(tmp_path, "d2", "Zulu", archived=True)
    resp = asyncio.run(documents.library())
    assert resp["total"] == 1
    assert resp["documents"][0]["title"] == "Alpha"
    assert "preview" in resp["documents"][0]


def test_list_session_docs_filters(tmp_path, monkeypatch):
    monkeypatch.setattr(documents, "DOCS_DIR", tmp_path)
    _write_doc(tmp_path, "d1", "Alpha", session_id="s9")
    _write_doc(tmp_path, "d2", "Beta", session_id="other")
    got = asyncio.run(documents.list_session_docs("s9"))
    assert [d["id"] for d in got] == ["d1"]


def test_list_notes_shape(tmp_path, monkeypatch):
    monkeypatch.setattr(notes, "NOTES_DIR", tmp_path)
    vs.save_entry(tmp_path / "n1.md",
                  {"id": "n1", "text": "hello", "pinned": False,
                   "created": vs.now_iso(), "updated": vs.now_iso()})
    resp = asyncio.run(notes.list_notes())
    assert isinstance(resp, (list, dict))
```

NOTE: before finalizing the test, read `backend/vault_store.py` for the real `save_entry` signature and `backend/notes.py:55-70` for `list_notes`'s actual return shape/entry fields, and adjust the helper + asserts to match reality. The asserts above encode the EXPECTED shapes from reading library()/list_session_docs(); fix any mismatch in the test, not the route.

- [ ] **Step 2: Run it — `_scan_docs` doesn't exist yet**

Run: `cd /Users/admin/openclaw-workspace && python -m pytest backend/tests/test_vault_scan_offload.py -x -q`
Expected: FAIL — `AttributeError: module 'backend.documents' has no attribute '_scan_docs'`

- [ ] **Step 3: Implement `_scan_docs` + to_thread in both document routes**

In `backend/documents.py`, add above `library()` (after the NOTE comment at ~line 145):

```python
def _scan_docs() -> list[dict]:
    """Read every doc entry from disk. Sync — callers run it via to_thread
    so the scan's file I/O never blocks the event loop (slow disk on this
    host; a big library scan used to stall every in-flight request)."""
    docs = []
    if DOCS_DIR.exists():
        for p in DOCS_DIR.glob("*.md"):
            try:
                docs.append(vs.load_entry(p, content_key="current_content"))
            except Exception:
                continue
    return docs
```

In `library()`, replace the inline scan (the `docs = []` / `if DOCS_DIR.exists():` loop) with:

```python
    docs = await asyncio.to_thread(_scan_docs)
```

In `list_session_docs()`, replace its scan loop with:

```python
    all_docs = await asyncio.to_thread(_scan_docs)
    docs = [d for d in all_docs
            if d.get("session_id") == session_id and d.get("is_active", True)
            and not d.get("archived")]
```

(`import asyncio` already present at documents.py:25.)

- [ ] **Step 4: Run the new tests + full suite**

Run: `python -m pytest backend/tests/test_vault_scan_offload.py -q` → the 3 documents tests PASS (notes test still fails — Task 2).
Then: `python -m pytest backend/tests/ -q` → only the notes test failing.

- [ ] **Step 5: Commit**

```bash
git add backend/documents.py backend/tests/test_vault_scan_offload.py
git commit -m "perf(documents): scan the docs vault off the event loop"
```

---

### Task 2: Offload notes scan (P3, notes.py)

**Files:**
- Modify: `backend/notes.py:62-67`
- Test: `backend/tests/test_vault_scan_offload.py` (from Task 1)

- [ ] **Step 1: Implement**

`notes.py` already has the sync helper `_load_all()` (notes.py:35). Add `import asyncio` to the imports, then in `list_notes()` change the `_load_all()` call to:

```python
    notes = await asyncio.to_thread(_load_all)
```

(match the actual local variable name used in the route — read notes.py:62-67 first).

- [ ] **Step 2: Run tests**

Run: `python -m pytest backend/tests/test_vault_scan_offload.py -q`
Expected: 4/4 PASS

- [ ] **Step 3: Commit**

```bash
git add backend/notes.py
git commit -m "perf(notes): load notes off the event loop"
```

---

### Task 3: Shared HTTP client + threaded auth for Google Calendar (P4, calendar_google.py)

**Files:**
- Modify: `backend/calendar_google.py:28-47`
- Test: `backend/tests/test_calendar_google.py` (append)

- [ ] **Step 1: Write the failing test** (append to `backend/tests/test_calendar_google.py`)

```python
def test_http_client_is_shared_and_recreated_when_closed():
    import asyncio
    from backend import calendar_google as cg

    async def main():
        c1 = cg._http()
        c2 = cg._http()
        assert c1 is c2          # one client, reused across calls
        await c1.aclose()
        c3 = cg._http()
        assert c3 is not c1      # closed → lazily recreated
        await c3.aclose()

    asyncio.run(main())
```

- [ ] **Step 2: Run it**

Run: `python -m pytest backend/tests/test_calendar_google.py -q`
Expected: FAIL — `AttributeError: ... no attribute '_http'`

- [ ] **Step 3: Implement**

In `backend/calendar_google.py`, after `_auth()` (~line 30):

```python
# One shared client: each request used to pay a fresh TCP+TLS handshake, and
# the events view fans out to every visible calendar (~8 calls per view).
_client: httpx.AsyncClient | None = None


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(timeout=30)
    return _client
```

Replace `_get`/`_post` bodies (token refresh is a sync httpx POST inside `access_token()` — keep it off the loop):

```python
async def _get(path: str, params: dict | None = None) -> dict:
    headers = await asyncio.to_thread(_auth)
    r = await _http().get(f"{_API}{path}", headers=headers, params=params or {})
    r.raise_for_status()
    return r.json()


async def _post(path: str, body: dict) -> dict:
    headers = await asyncio.to_thread(_auth)
    r = await _http().post(f"{_API}{path}", json=body, headers=headers)
    r.raise_for_status()
    return r.json()
```

Check for other `async with httpx.AsyncClient` uses in this file (`grep -n "AsyncClient" backend/calendar_google.py`) — convert any others (e.g. PATCH/DELETE helpers) the same way.

- [ ] **Step 4: Run tests**

Run: `python -m pytest backend/tests/test_calendar_google.py -q` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/calendar_google.py backend/tests/test_calendar_google.py
git commit -m "perf(calendar): one shared HTTP client; token refresh off the loop"
```

---

### Task 4: Coalesce streaming renders to one per frame (P1, chat.js)

**Files:**
- Modify: `frontend-overrides/js/chat.js:1242` (add helper), `:1649` (hot-path call)

- [ ] **Step 1: Add the queue helper**

Immediately after the `_renderStream = () => { ... };` assignment closes (chat.js:1242), insert:

```js
      // Per-delta renders are O(full message) — markdown re-parse, offscreen
      // height measure (forced reflow), innerHTML swap, hljs. Coalesce bursts
      // to one render per animation frame; structural call sites (tool_start,
      // agent_step, think-close, stream-end) still call _renderStream()
      // directly because they need the DOM current before their next line.
      let _renderQueued = false;
      const _queueRenderStream = () => {
        if (_renderQueued) return;
        _renderQueued = true;
        requestAnimationFrame(() => {
          _renderQueued = false;
          // A queued render firing after the round finalized / the stream
          // completed / agent_step reset the round would stomp newer DOM.
          if (roundFinalized || _streamSawDone || !roundText) return;
          _renderStream();
        });
      };
```

- [ ] **Step 2: Switch the hot path**

In the "Normal streaming" branch (chat.js:1646-1653), change ONLY line 1649 `_renderStream();` → `_queueRenderStream();`. Leave the `spinner.destroy()` above it and `_scheduleThinkingSpinner()` below it unchanged. Do NOT touch the other `_renderStream()` call sites (1597, 1645, 1962, 2218, 2331).

- [ ] **Step 3: Syntax check**

Run: `node --check frontend-overrides/js/chat.js`
Expected: no output (exit 0)

- [ ] **Step 4: Commit**

```bash
git add frontend-overrides/js/chat.js
git commit -m "perf(chat): coalesce streaming re-renders to one per animation frame"
```

---

### Task 5: Visibility-guard the tool tickers (P2, chat.js)

**Files:**
- Modify: `frontend-overrides/js/chat.js:2032-2056`

- [ ] **Step 1: Guard both intervals**

Wave interval (chat.js:2032): first line of the callback becomes a hidden-tab skip —

```js
                  node._waveInterval = setInterval(() => {
                    if (document.hidden) return;   // no animation work in a hidden tab
                    waveIdx = (waveIdx + 1) % waveFrames.length;
                    waveEl.textContent = waveFrames[waveIdx];
                  }, 250);
```

Elapsed ticker (chat.js:2041): same first line —

```js
                node._elapsedTicker = setInterval(() => {
                  if (document.hidden) return;     // catches up instantly on return
                  const hdr2 = node.querySelector('.agent-thread-header');
                  ...rest unchanged...
                }, 250);
```

(Elapsed text is computed from `node._startTime`, so it shows the true elapsed the moment the tab is visible again — no drift.)

- [ ] **Step 2: Syntax check + commit**

Run: `node --check frontend-overrides/js/chat.js`

```bash
git add frontend-overrides/js/chat.js
git commit -m "perf(chat): tool wave/elapsed tickers idle while the tab is hidden"
```

---

### Task 6: Turn clock survives spinner swaps (G1, chat.js)

**Files:**
- Modify: `frontend-overrides/js/chat.js:525` (hoist), `:854-873` (ticker), `:2768-2769` (teardown)

- [ ] **Step 1: Hoist the ticker handle to function scope**

After `let spinner = null;` (chat.js:525) add:

```js
    let _turnTicker = null;   // turn-clock interval — cleared in the finally
```

- [ ] **Step 2: Make the ticker self-healing**

Replace chat.js:854-873 (comment + `const _turnTicker = setInterval(...)` block) with:

```js
      // Turn clock: elapsed mm:ss beside the spinner, and the base for the
      // stall captions below. Spinners are destroyed/recreated across agent
      // rounds (agent_step), so the ticker re-attaches the span to whichever
      // spinner is current and idles while text is streaming (no spinner).
      // Torn down in the finally.
      const _turnStart = Date.now();
      const _fmtElapsed = (ms) => {
        const s = Math.floor(ms / 1000);
        return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
      };
      const _elapsedSpan = document.createElement('span');
      _elapsedSpan.className = 'turn-elapsed';
      _elapsedSpan.style.cssText = 'opacity:.55;margin-left:6px;font-size:.85em';
      if (spinner.element) spinner.element.appendChild(_elapsedSpan);
      _turnTicker = setInterval(() => {
        if (!spinner || !spinner.element || !spinner.element.isConnected) return;
        if (_elapsedSpan.parentElement !== spinner.element) spinner.element.appendChild(_elapsedSpan);
        _elapsedSpan.textContent = _fmtElapsed(Date.now() - _turnStart);
      }, 1000);
```

(`const` → assignment to the hoisted `let`; guard `return`s instead of clearing; re-append when the current spinner doesn't hold the span.)

- [ ] **Step 3: Teardown in the finally**

In the turn's `finally` (chat.js:2768), right after `clearProcessingProbe();`:

```js
      if (_turnTicker) { clearInterval(_turnTicker); _turnTicker = null; }
```

- [ ] **Step 4: Syntax check + commit**

Run: `node --check frontend-overrides/js/chat.js`

```bash
git add frontend-overrides/js/chat.js
git commit -m "fix(chat): turn clock survives agent-round spinner swaps; torn down at turn end"
```

---

### Task 7: Stall caption stops duplicating the clock (G2, chat.js)

**Files:**
- Modify: `frontend-overrides/js/chat.js:1929-1931`

- [ ] **Step 1: Drop the embedded total**

Replace:

```js
                const _stallLabel = 'Still waiting — no activity for ' +
                  (json.silent_for || 0) + 's (' +
                  _fmtElapsed(Date.now() - _turnStart) + ' total)';
```

with:

```js
                // Total elapsed lives in the turn-clock span beside the
                // spinner — repeating it here doubled the m:ss display.
                const _stallLabel = 'Still waiting — no activity for ' +
                  (json.silent_for || 0) + 's';
```

- [ ] **Step 2: Syntax check + commit**

Run: `node --check frontend-overrides/js/chat.js`

```bash
git add frontend-overrides/js/chat.js
git commit -m "fix(chat): stall caption no longer duplicates the turn clock"
```

---

### Task 8: Confirm before single-session delete (X1, sessions.js)

**Files:**
- Modify: `frontend-overrides/js/sessions.js:650-656`

- [ ] **Step 1: Add the confirm**

In the `deleteItem.addEventListener('click', ...)` handler, after the `is_important` guard's closing `}` and the existing `dropdown.style.display = 'none';`, insert (so the menu is closed before the dialog opens):

```js
    if (!await uiModule.styledConfirm(`Delete "${s.name || 'this session'}"? This cannot be undone.`, { confirmText: 'Delete', danger: true })) return;
```

Note the handler currently sets `dropdown.style.display = 'none'` ONLY after the is_important branch — verify the final order is: is_important guard → hide dropdown → styledConfirm → optimistic removal. (Bulk delete at sessions.js:1367 is the house pattern.)

- [ ] **Step 2: Syntax check + commit**

Run: `node --check frontend-overrides/js/sessions.js`

```bash
git add frontend-overrides/js/sessions.js
git commit -m "polish(sessions): confirm before deleting a session — only unguarded destructive path"
```

---

### Task 9: Honest import results (X2, chat.js)

**Files:**
- Modify: `frontend-overrides/js/chat.js:679-695`

- [ ] **Step 1: Count failures, check res.ok**

Replace the import loop + banner text (chat.js:680-694) with:

```js
          let imported = 0;
          let failed = 0;
          for (const { info, file } of _importableFiles) {
            try {
              const content = await file.text();
              const dotIdx = info.name.lastIndexOf('.');
              const title = dotIdx > 0 ? info.name.slice(0, dotIdx) : info.name;
              const ext = dotIdx >= 0 ? info.name.slice(dotIdx).toLowerCase() : '';
              const res = await fetch(`${API_BASE}/api/document`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title, language: EXT_LANG[ext] || '', content }),
              });
              if (!res.ok) throw new Error('HTTP ' + res.status);
              imported++;
            } catch (e) { failed++; console.error('Import failed:', info.name, e); }
          }
          const total = _importableFiles.length;
          banner.textContent = failed
            ? `Imported ${imported} of ${total} file${total !== 1 ? 's' : ''} (${failed} failed)`
            : `Imported ${imported} file${imported !== 1 ? 's' : ''}`;
          setTimeout(() => banner.remove(), failed ? 4000 : 2000);
```

- [ ] **Step 2: Syntax check + commit**

Run: `node --check frontend-overrides/js/chat.js`

```bash
git add frontend-overrides/js/chat.js
git commit -m "polish(chat): import banner reports failures; non-OK responses no longer count as imported"
```

---

### Task 10: Verify, deploy frontend, ship

- [ ] **Step 1: Full backend suite**

Run: `cd /Users/admin/openclaw-workspace && python -m pytest backend/tests/ -q`
Expected: all green (257+).

- [ ] **Step 2: Syntax-check all touched JS once more**

Run: `node --check frontend-overrides/js/chat.js && node --check frontend-overrides/js/sessions.js`

- [ ] **Step 3: Confirm no stray changes**

Run: `git status --short` — only the planned files committed; the UI-size working-tree files (index.html, theme.js, hermes.css, test_inbox_router.py) still uncommitted and untouched.

- [ ] **Step 4: Sync frontend**

Run: `./scripts/sync-frontend.sh`
Expected: overlay copy + injections + `stamped sw.js CACHE_NAME = gary-<hash>` (new hash).
Then verify served bytes: `curl -s http://127.0.0.1:8800/js/chat.js | grep -c _queueRenderStream` → ≥1.

- [ ] **Step 5: Commit docs (spec + this plan)**

```bash
git add docs/superpowers/specs/2026-06-12-perf-glitch-polish-batch.md docs/superpowers/plans/2026-06-12-perf-glitch-polish-batch.md
git commit -m "docs: perf/glitch/polish batch spec + plan (2026-06-12 review)"
```

- [ ] **Step 6: Backend restart decision**

Frontend fixes are live after Step 4 (next page load). Backend fixes (Tasks 1-3) need ONE `launchctl kickstart -k gui/$(id -u)/ai.openclaw.workspace`. Check load first (`uptime`); if the box is busy or the user mid-chat, report "restart pending" instead of bouncing it.
