# Email Tab Triage — Focused Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Supersedes** Tasks 4–15 of `docs/superpowers/plans/2026-06-15-email-tab-triage-redesign.md`. See the "Correction (2026-06-16)" block in the spec for why. Tasks 1 (file promotion) is already done. Task 2 (pure-logic block in `emailInbox.js`) is relocated by Task F1 below.

**Goal:** Make the live Email modal (`emailLibrary.js` → `#email-lib-modal`) fast to triage: low-friction multi-select, a richer bulk bar (archive / move / hand-to-agent, not just read/unread/delete), one-tap per-row quick actions, and move-to-folder — without changing the existing inline-expand reader.

**Architecture:** All frontend edits land in `frontend-overrides/js/emailLibrary.js` (already promoted; the durable copy the sync mirrors over `frontend/`). Pure selection/bulk logic moves to a small importable `frontend-overrides/js/emailLibrary/triageLogic.js`, node-tested directly. The backend gains one extension: `/api/items/spinoff` accepts a list of emails → one seeded session. Bulk = client fan-out over existing per-uid endpoints.

**Tech Stack:** Vanilla ES-module frontend (no bundler), FastAPI backend, pytest, Node for pure-logic tests.

---

## Reference facts (verified 2026-06-16 against the live modal)

**Live surface:** `emailLibrary.js`. Entry `openEmailLibrary()` (`:545`) builds `#email-lib-modal` + card grid `#email-lib-grid`. Sidebar "Email" click → `openEmailLibrary()` (`emailInbox.js:217`).

**Card:** built by `_createCard()` (`:1626`). Checkbox rendered only in select mode (`:1637`). Collapsed-row three-dot menu `.memory-item-actions` (`:1814`); long-press (500ms) opens menu (`:1837`). Row click → `_toggleCardPreview(card, em)` (`:1855`→`:1916`) = inline accordion reader. Done-check always visible (`:1704`).

**Per-row menu:** `_showCardMenu()` (`:4399`) — items Open (`:4419`), Open in tab (`:4426`), Remind (`:4433`), Mark Done (`:4443`), Archive (`:4471`), Select (`:4499`), Delete (`:4510`). Archive POSTs `/api/email/archive/{uid}`; Delete DELETEs `/api/email/delete/{uid}`.

**Bulk:** "Select" toggle `#email-lib-select-btn` (`:633`) flips `state._selectMode` (`:998`). Bulk bar HTML `#email-lib-bulk` (`:657`) with select-all `#email-lib-select-all`, count `#email-lib-selected-count`, actions menu `#email-lib-bulk-actions` (`_showBulkActionsMenu` `:4565` → Mark Read/Unread), delete `#email-lib-bulk-delete`, cancel `#email-lib-bulk-cancel`. `_bulkAction(action)` (`:4631`) handles `archive|delete|read|unread` (read/unread are local-only today, `:4649`). `_updateBulkBar()` (`:4611`). Select-all adds all visible (`:1005`).

**Folders:** dropdown `#email-lib-folder` (`:613`), `_loadFolders()` (`:1229`), `folderDisplayName()` imported from emailInbox.js. Move endpoint exists: `POST /api/email/move/{uid}?folder=<src>&dest=<dst>`.

**Sanitizer:** `_sanitizeHtml` imported (`:15`). **State:** `state._selectMode`, `state._selectedUids: Set` (`emailLibrary/state.js`).

**Spinoff:** `POST /api/items/spinoff` (`backend/inbox/__init__.py:269`) takes `{item:{title,subtitle,snippet,source,meta:{uid}}, intent?}`; one item only (Task F5 adds bulk).

**Decisions:** Bulk uses client fan-out (concurrency 5). Undo offered for reversible verbs (archive→move back, move→reverse, read/unread→opposite); delete keeps its existing confirm and no undo. Long-press on a card (mobile) is repurposed from "open menu" to "select" (the three-dot still opens the menu).

**Git hygiene:** unrelated modified PNG/favicon files sit in the working tree — never stage them; `git add` only the exact paths each task lists.

---

## Task F1: Relocate pure logic into a shared, tested module

Replace the `EMAIL-TRIAGE-MATH` block (currently in `emailInbox.js`, on the dead path) with an importable module holding only the helpers the focused scope uses, node-tested directly.

**Files:**
- Create: `frontend-overrides/js/emailLibrary/triageLogic.js`
- Modify: `scripts/test-email-triage-math.mjs` (import the module instead of regex-extracting)
- Modify: `frontend-overrides/js/emailInbox.js` (remove the now-unused marked block)

- [ ] **Step 1: Rewrite the test to import the module (RED).** Replace the entire contents of `scripts/test-email-triage-math.mjs` with:

```js
// Pure triage logic for the email modal. Run: node scripts/test-email-triage-math.mjs
import { toggleInSet, allSelected, chunk, summarizeBulk }
  from '../frontend-overrides/js/emailLibrary/triageLogic.js';

let failures = 0;
const assert = (cond, msg) => { if (!cond) { console.error('FAIL: ' + msg); failures++; } };
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`);

{
  const s0 = new Set(['a']);
  const s1 = toggleInSet(s0, 'b');
  assert(s1 !== s0, 'toggleInSet returns a new set (no mutation)');
  eq([...s1].sort(), ['a', 'b'], 'toggleInSet adds missing uid');
  eq([...toggleInSet(s1, 'a')].sort(), ['b'], 'toggleInSet removes present uid');
}

assert(allSelected(['a', 'b'], new Set(['a', 'b'])) === true, 'allSelected true');
assert(allSelected(['a', 'b'], new Set(['a'])) === false, 'allSelected partial -> false');
assert(allSelected([], new Set()) === false, 'allSelected empty -> false');

eq(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]], 'chunk by size');
eq(chunk([], 3), [], 'chunk empty -> []');

{
  const r = summarizeBulk([
    { uid: 'a', ok: true }, { uid: 'b', ok: false, error: 'x' }, { uid: 'c', ok: true },
  ]);
  eq(r, { ok: 2, failed: 1, failedUids: ['b'] }, 'summarizeBulk tallies');
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('email-triage-logic: all assertions passed');
```

- [ ] **Step 2: Run it — expect FAIL** (module does not exist yet). `node scripts/test-email-triage-math.mjs` → error resolving the import.

- [ ] **Step 3: Create `frontend-overrides/js/emailLibrary/triageLogic.js`:**

```js
// Pure, DOM-free helpers for email-modal triage (multi-select + bulk fan-out).
// Node-tested by scripts/test-email-triage-math.mjs. No imports — keep it pure.

// Return a NEW Set with `uid` toggled — never mutate the input, so callers can
// swap state._selectedUids to the result and renders see a fresh reference.
export function toggleInSet(set, uid) {
  const next = new Set(set);
  if (next.has(uid)) next.delete(uid); else next.add(uid);
  return next;
}

export function allSelected(visibleUids, selectedSet) {
  return visibleUids.length > 0 && visibleUids.every((u) => selectedSet.has(u));
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Aggregate per-item results ({uid, ok, error?}) into a tally.
export function summarizeBulk(results) {
  const failedUids = results.filter((r) => !r.ok).map((r) => r.uid);
  return { ok: results.length - failedUids.length, failed: failedUids.length, failedUids };
}
```

- [ ] **Step 4: Run it — expect PASS.** `node scripts/test-email-triage-math.mjs` → `email-triage-logic: all assertions passed`.

- [ ] **Step 5: Remove the dead marked block from `emailInbox.js`.** Delete the entire `/* EMAIL-TRIAGE-MATH-BEGIN ... EMAIL-TRIAGE-MATH-END */` block (currently lines ~24–62, between the `_deleteIcon` const and `const _replySeparator`). Then `node --check frontend-overrides/js/emailInbox.js && echo OK` → `OK`.

- [ ] **Step 6: Commit.**
```bash
git add frontend-overrides/js/emailLibrary/triageLogic.js scripts/test-email-triage-math.mjs frontend-overrides/js/emailInbox.js
git commit -m "refactor(email): move triage logic into shared tested module; drop dead emailInbox block"
```

---

## Task F2: Hover / long-press multi-select (kill the toggle requirement)

Make selection enterable without the "Select" mode button: a checkbox shows on card hover (desktop) and long-press selects (mobile). Selecting ≥1 card reveals the existing bulk bar.

**Files:**
- Modify: `frontend-overrides/js/emailLibrary.js`
- Modify: `frontend-overrides/workspace.css`

- [ ] **Step 1: Always render the card checkbox (hidden by CSS unless hover/selected/select-mode).** In `_createCard()` (`:1626`), the checkbox is currently rendered only when `state._selectMode`. Change it to ALWAYS render the checkbox element, adding a `email-card-check` class so CSS can control visibility. Keep its `.checked` bound to `state._selectedUids.has(em.uid)`. Do not otherwise change card markup.

- [ ] **Step 2: Import the shared helpers** at the top of `emailLibrary.js` (next to the existing imports, e.g. after the `_sanitizeHtml` import at `:15`):
```js
import { toggleInSet, allSelected, chunk, summarizeBulk } from './emailLibrary/triageLogic.js';
```

- [ ] **Step 3: Checkbox click enters selection.** Wire the always-present checkbox so clicking it (independent of `_selectMode`): toggles membership via `state._selectedUids = toggleInSet(state._selectedUids, em.uid)`, sets `state._selectMode = true` if the set is now non-empty, toggles the card's `.selected` class, calls `_updateBulkBar()`, and stops propagation (so it doesn't also expand the card). When the set becomes empty, set `state._selectMode = false` and `_updateBulkBar()` hides the bar.

- [ ] **Step 4: Long-press selects (mobile).** The long-press handler at `:1837` currently opens `_showCardMenu`. Change it so long-press toggles selection of that card (same logic as Step 3) instead of opening the menu. The three-dot button still opens the menu, so the menu stays reachable. Keep the 500ms threshold.

- [ ] **Step 5: Make `_updateBulkBar` use the shared select-all check.** In `_updateBulkBar()` (`:4611`), where it computes the select-all checkbox state, use `allSelected(state._libEmails.map(e => e.uid), state._selectedUids)`.

- [ ] **Step 6: CSS — show checkbox on hover / when selected / in select mode.** Append to `frontend-overrides/workspace.css`:
```css
/* Email modal: low-friction multi-select ---------------------------------- */
#email-lib-grid .doclib-card .email-card-check { opacity: 0; transition: opacity .12s ease; }
#email-lib-grid .doclib-card:hover .email-card-check,
#email-lib-grid .doclib-card.selected .email-card-check,
#email-lib-modal.select-mode .doclib-card .email-card-check { opacity: 1; }
@media (pointer: coarse) { #email-lib-grid .doclib-card:hover .email-card-check { opacity: 0; } }
```
And ensure `#email-lib-modal` gets a `select-mode` class toggled with `state._selectMode` (add a one-line toggle wherever `_selectMode` is set, or inside `_updateBulkBar`): `document.getElementById('email-lib-modal')?.classList.toggle('select-mode', state._selectMode)`.

- [ ] **Step 7: Verify + commit.** `node --check frontend-overrides/js/emailLibrary.js && echo OK`, then:
```bash
git add frontend-overrides/js/emailLibrary.js frontend-overrides/workspace.css
git commit -m "feat(email): hover/long-press multi-select in the email modal"
```

---

## Task F3: Per-row hover quick actions (Archive + Delete)

**Files:** Modify `frontend-overrides/js/emailLibrary.js`, `frontend-overrides/workspace.css`.

- [ ] **Step 1: Add two quick-action buttons to the collapsed row.** In `_createCard()`, in the actions area near the three-dot menu (`.memory-item-actions`, `:1814`), add before the three-dot button:
```js
`<button class="email-quick-act" data-quick="archive" title="Archive">${_archiveIcon}</button>` +
`<button class="email-quick-act" data-quick="delete" title="Delete">${_deleteIcon}</button>`
```
(`_archiveIcon`/`_deleteIcon` are exported from emailInbox.js; if not already imported into emailLibrary.js, inline the same two SVG strings used by `_showCardMenu`'s Archive/Delete items rather than adding a cross-module import.)

- [ ] **Step 2: Wire them to the existing archive/delete logic.** After the card's other handlers are bound in `_createCard()`, add listeners for `.email-quick-act` that `stopPropagation()` and call the SAME functions the per-row menu's Archive (`:4471`) and Delete (`:4510`) items call. If that logic is inline in `_showCardMenu`, extract it into small helpers `_archiveCard(em, card)` / `_deleteCard(em, card)` and call those from both the menu and the quick buttons (DRY). Delete keeps its existing confirm.

- [ ] **Step 2b: Run the relocated/extracted helpers’ smoke.** `node --check frontend-overrides/js/emailLibrary.js && echo OK`.

- [ ] **Step 3: CSS — quick actions on hover only, hidden during select mode.** Append:
```css
#email-lib-grid .doclib-card .email-quick-act { display: none; background: none; border: 0; color: var(--fg); opacity: 0.6; cursor: pointer; padding: 2px 4px; }
#email-lib-grid .doclib-card:hover .email-quick-act { display: inline-flex; }
#email-lib-grid .doclib-card .email-quick-act:hover { opacity: 1; }
#email-lib-modal.select-mode .email-quick-act { display: none; }
@media (pointer: coarse) { #email-lib-grid .doclib-card:hover .email-quick-act { display: none; } }
```

- [ ] **Step 4: Commit.**
```bash
git add frontend-overrides/js/emailLibrary.js frontend-overrides/workspace.css
git commit -m "feat(email): per-row hover quick actions (archive/delete)"
```

---

## Task F4: Move-to-folder (per-row menu)

**Files:** Modify `frontend-overrides/js/emailLibrary.js`.

- [ ] **Step 1: Add a `_emailMove(uids, dest)` helper** using the existing endpoint:
```js
async function _emailMove(uids, dest) {
  const src = encodeURIComponent(state._libFolder || 'INBOX');
  const results = await Promise.all(uids.map(async (uid) => {
    try {
      const r = await fetch(`${API_BASE}/api/email/move/${uid}?folder=${src}&dest=${encodeURIComponent(dest)}${_acct()}`,
        { method: 'POST', credentials: 'same-origin' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return { uid, ok: true };
    } catch (e) { return { uid, ok: false, error: String(e.message || e) }; }
  }));
  return results;
}
```
(Use the same `API_BASE`/`_acct()` access the file already uses for `/api/email/*` calls — match an existing fetch in this file, e.g. the archive call.)

- [ ] **Step 2: Add a "Move to…" item to the per-row menu.** In `_showCardMenu()` (`:4399`), add an item after Archive (`:4471`) that opens a submenu of folders. Build the folder list from the `#email-lib-folder` dropdown options (excluding the current `state._libFolder` and virtual `__scheduled__`). On pick: call `_emailMove([em.uid], dest)`, then remove the card from the grid + `state._libEmails` and re-render (mirror how the Archive item removes the card). Show a toast with an Undo that calls `_emailMove([em.uid], state._libFolder)` (reverse) — reuse whatever toast the file already uses (`import('./ui.js')` `showToast`, as used elsewhere in emailLibrary.js).

- [ ] **Step 3: Verify + commit.** `node --check frontend-overrides/js/emailLibrary.js && echo OK`, then:
```bash
git add frontend-overrides/js/emailLibrary.js
git commit -m "feat(email): per-row move-to-folder"
```

---

## Task F5: Backend — bulk hand-to-agent (one session for many emails)

Identical to the original plan's Task 14.

**Files:** Modify `backend/inbox/__init__.py`; Test `backend/tests/test_inbox_email_spinoff.py`.

- [ ] **Step 1: Write the failing test.** Create `backend/tests/test_inbox_email_spinoff.py`. First open an existing test in `backend/tests/` (e.g. `test_inbox_router.py`) and copy its TestClient/app fixture so the import is correct, then:
```python
def test_spinoff_bulk_emails_one_session(client):
    items = [
        {"source": "gmail", "title": "Invoice 1", "subtitle": "a@x.com", "meta": {"uid": "1", "folder": "INBOX"}},
        {"source": "gmail", "title": "Invoice 2", "subtitle": "b@x.com", "meta": {"uid": "2", "folder": "INBOX"}},
    ]
    r = client.post("/api/items/spinoff", json={"items": items})
    assert r.status_code == 200
    body = r.json()
    assert body.get("session_id")
    assert body.get("count") == 2

def test_spinoff_single_email_still_works(client):
    r = client.post("/api/items/spinoff", json={
        "intent": "reply",
        "item": {"source": "gmail", "title": "Q3 plan", "subtitle": "t@x.com", "meta": {"uid": "123", "folder": "INBOX"}},
    })
    assert r.status_code == 200
    assert r.json().get("session_id")
```
(Adapt the `client` fixture to match the sibling tests — they may use a module-level `TestClient(app)` instead of a fixture.)

- [ ] **Step 2: Run — expect the bulk test to FAIL.** `.venv/bin/python -m pytest backend/tests/test_inbox_email_spinoff.py -v`.

- [ ] **Step 3: Implement the bulk branch** at the top of `async def spinoff(payload, request=None)` (`:270`), before `item = payload.get("item") or {}`:
```python
    items = payload.get("items")
    if isinstance(items, list) and items:
        titles = [(it.get("title") or "").strip() for it in items if (it.get("title") or "").strip()]
        if not titles:
            return _bad("items require titles")
        lines = "\n".join(f"- {it.get('title','(no subject)')} — {it.get('subtitle','')}" for it in items)
        seed = ("Context — a batch of emails I handed you from my inbox. Help me work "
                "through them (summaries, drafts, or actions as I ask):\n\n"
                f"{lines}\n\nReply with one short sentence confirming you have the list; "
                "I'll say what to do next.")
        sess_name = f"Emails: {len(items)} items — {titles[0][:32]}"
        # Mirror EXACTLY the single-item path's create+seed calls (see the tail of
        # this function, ~:300-322). Replace the two lines below with those calls.
        sess = sessions_store.create_session(name=sess_name)
        await _seed_session(sess["id"], seed)
        _log_spinoff(request, {"id": "bulk", "title": sess_name}, sess["id"], deduped=False)
        return {"session_id": sess["id"], "count": len(items)}
```
Open the single-item tail (~`:300`–`:322`) and substitute the real session-create + awaited-seed calls it uses; do not invent helpers.

- [ ] **Step 4: Run — expect PASS.** `.venv/bin/python -m pytest backend/tests/test_inbox_email_spinoff.py -v`.

- [ ] **Step 5: Regression run.** `.venv/bin/python -m pytest backend/tests/test_inbox_router.py backend/tests/test_inbox_email_spinoff.py -v`.

- [ ] **Step 6: Commit.**
```bash
git add backend/inbox/__init__.py backend/tests/test_inbox_email_spinoff.py
git commit -m "feat(inbox): spinoff accepts a bulk email list -> one seeded session"
```

---

## Task F6: Hand-to-agent (per-row menu + single spinoff)

**Files:** Modify `frontend-overrides/js/emailLibrary.js`.

- [ ] **Step 1: Add `_handEmailsToAgent(emails)`** (single uses `intent:'reply'`, bulk uses `items`):
```js
async function _handEmailsToAgent(emails) {
  try {
    const body = emails.length === 1
      ? { intent: 'reply', item: { source: 'gmail', title: emails[0].subject || '(no subject)',
            subtitle: emails[0].from_name || emails[0].from_address || '',
            meta: { uid: String(emails[0].uid), folder: state._libFolder } } }
      : { items: emails.map((em) => ({ source: 'gmail', title: em.subject || '(no subject)',
            subtitle: em.from_name || em.from_address || '',
            meta: { uid: String(em.uid), folder: state._libFolder } })) };
    const r = await fetch(`${API_BASE}/api/items/spinoff`, { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok || !d.session_id) throw new Error(d.detail || 'no session');
    window.location.hash = '#' + d.session_id;
    window.location.reload();
  } catch (err) {
    import('./ui.js').then((m) => m.showToast && m.showToast('Hand-to-agent failed: ' + String(err.message || err))).catch(() => {});
  }
}
```

- [ ] **Step 2: Add a "Hand to __AGENT_NAME__" item to the per-row menu** in `_showCardMenu()`, calling `_handEmailsToAgent([em])`. (The `__AGENT_NAME__` token is baked at sync time — use it literally in the label string.)

- [ ] **Step 3: Verify + commit.** `node --check frontend-overrides/js/emailLibrary.js && echo OK`, then:
```bash
git add frontend-overrides/js/emailLibrary.js
git commit -m "feat(email): per-row hand-to-agent (spinoff)"
```

---

## Task F7: Enrich the bulk bar (Archive + Move + Hand-to-agent)

Bring the new verbs into bulk, using the fan-out helpers and the F4/F6 functions.

**Files:** Modify `frontend-overrides/js/emailLibrary.js`.

- [ ] **Step 1: Add a fan-out runner** (concurrency-capped, uses `chunk` from F1):
```js
async function _runBulkEmail(uids, perUid) {
  const out = [];
  for (const batch of chunk(uids, 5)) out.push(...await Promise.all(batch.map(perUid)));
  return out;   // summarize via summarizeBulk(out)
}
```

- [ ] **Step 2: Expose Archive in the bulk bar.** `_bulkAction('archive')` already exists (`:4631`). Add an **Archive** button to the bulk bar (`#email-lib-bulk`, `:657`) next to Delete, wired to `_bulkAction('archive')`. (Confirm `_bulkAction`'s archive branch removes cards + clears selection; if it currently fans out serially, leave it — just ensure it reports failures.)

- [ ] **Step 3: Add Move ▾ and Hand-to-agent to the bulk bar.**
  - **Move ▾:** opens the same folder submenu as F4 (factor F4's folder-submenu builder into a helper `_folderSubmenu(onPick)` and reuse it). On pick: `const res = await _runBulkEmail(uids, (uid) => _emailMove([uid], dest).then(a => a[0]))`, then `summarizeBulk(res)`, remove succeeded cards, clear selection, toast `Moved N (M failed)` with reverse-undo.
  - **Hand to __AGENT_NAME__:** `_handEmailsToAgent(state._libEmails.filter(e => state._selectedUids.has(e.uid)))`.
  - Read `uids` as `Array.from(state._selectedUids)`.

- [ ] **Step 4: Make bulk read/unread hit the backend** (today they're local-only, `:4649`). In `_bulkAction` for `read`/`unread`, fan out over `/api/email/mark-read/{uid}` / `/api/email/mark-unread/{uid}` via `_runBulkEmail`, then update local state. (Small, in-scope correctness fix since we're touching the bar.)

- [ ] **Step 5: Verify + commit.** `node --check frontend-overrides/js/emailLibrary.js && echo OK`, then:
```bash
git add frontend-overrides/js/emailLibrary.js frontend-overrides/workspace.css
git commit -m "feat(email): bulk bar gains archive, move, hand-to-agent; bulk read/unread hit backend"
```

---

## Task F8: Integration verification + deploy note

**Files:** none modified — verification only.

- [ ] **Step 1: Full sync into a scratch build + parse-check.**
```bash
cd /Users/admin/openclaw-workspace
WORKSPACE_BUILD_DEST=/tmp/fe-smoke ODYSSEUS_STATIC=frontend-vendor bash scripts/sync-frontend.sh
node --check /tmp/fe-smoke/js/emailLibrary.js && node --check /tmp/fe-smoke/js/emailInbox.js && echo BUILD_PARSE_OK
grep -c "__AGENT_NAME__" /tmp/fe-smoke/js/emailLibrary.js   # expect 0 (baked)
rm -rf /tmp/fe-smoke
```
Expected `BUILD_PARSE_OK` and `0`.

- [ ] **Step 2: All tests.**
```bash
node scripts/test-swipe-math.mjs && node scripts/test-email-triage-math.mjs
.venv/bin/python -m pytest backend/tests/test_inbox_email_spinoff.py backend/tests/test_email_himalaya.py -v
```
Expected: all pass.

- [ ] **Step 3: Deploy note (user-gated — do NOT restart).** The change is live only after the user runs `bash scripts/sync-frontend.sh` + a workspace restart (fragile 2014 Mac mini, 4–5 min cold boot). After deploy, user eyeballs on the `:8443` origin (no headless Chrome): hover-select + bulk archive/move/hand-to-agent, per-row hover quick actions, per-row move + hand-to-agent, long-press select on mobile.

---

## Self-Review

**Spec coverage (focused scope):** hover/long-press select → F2; richer bulk verbs (archive/move/agent) → F7; per-row quick actions → F3; move-to-folder → F4 (row) + F7 (bulk); hand-to-agent → F5 (backend) + F6 (row) + F7 (bulk); reading model unchanged (per correction). Pure logic relocated + tested → F1.

**Dropped from original (per correction):** reading-pane/quick-look rework, retire-Library — both removed (single live surface; inline reader kept).

**Placeholder scan:** the "match the existing pattern" instructions (toast access in F4, session create+seed in F5, archive/delete extraction in F3) are explicit discovery-and-mirror steps against named line anchors, not vague deferrals.

**Name consistency:** `toggleInSet/allSelected/chunk/summarizeBulk` defined in F1, imported and used in F2/F7. `_emailMove` (F4) reused in F7. `_handEmailsToAgent` (F6) reused in F7. `_runBulkEmail` defined F7. `_folderSubmenu` factored in F4, reused F7. `state._selectedUids`/`state._selectMode`/`state._libFolder`/`state._libEmails` are the existing shared-state names.
