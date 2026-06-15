# Email Tab Triage Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the workspace Email tab fast for triage — inline multi-select + bulk actions, a reading pane (desktop) / quick-look (mobile) that replaces the heavy doc-pane open for skimming, and one-tap per-row actions — and retire the separate "Library" surface.

**Architecture:** `emailInbox.js` and `emailLibrary.js` are full-file ES-module overrides. We promote them into `frontend-overrides/js/` (the durable layer `scripts/sync-frontend.sh` mirrors over the `frontend/` build), then edit there. Pure decision logic (responsive breakpoint, selection math, prev/next nav, bulk-result aggregation) goes into a self-contained marked block in the override and is node-tested exactly like the existing `scripts/test-swipe-math.mjs`. UI wiring is verified with `node --check` plus manual smoke on the live origin (house rule: **no headless Chrome on this host**). Bulk = client-side fan-out over the existing per-uid endpoints; bulk "Hand to agent" gets one small backend extension to `/api/items/spinoff`.

**Tech Stack:** Vanilla ES-module frontend (no framework, no bundler), Python FastAPI backend (`backend/email_himalaya.py`, `backend/inbox/__init__.py`), `pytest`, Node for pure-logic tests.

---

## Reference facts (verified against the tree on 2026-06-15)

**Override mechanism:** `scripts/sync-frontend.sh` rsyncs `frontend-vendor/` → `frontend/`, then copies every file under `frontend-overrides/` over the top. `emailInbox.js`/`emailLibrary.js` are imported by the SPA's `app.js`; they need **no `<script>` injection** — being present in `frontend-overrides/js/` is enough. **Never edit `frontend/js/` directly** (regenerated output).

**Existing per-uid email endpoints (all in `backend/email_himalaya.py`):**
- `POST   /api/email/archive/{uid}?folder=` (line 314)
- `DELETE /api/email/delete/{uid}?folder=` (line 319)
- `POST   /api/email/mark-read/{uid}?folder=` (line 239) · `POST /api/email/mark-unread/{uid}?folder=` (line 244)
- `POST   /api/email/move/{uid}?folder=&dest=` (line 324)
- `GET    /api/email/list?folder=&limit=&offset=&filter=` (line 114)
- `GET    /api/email/read/{uid}?folder=&mark_seen=` (line 213)

**Spinoff endpoint:** `POST /api/items/spinoff` (`backend/inbox/__init__.py:269`) takes `{item:{title,subtitle,snippet,source,meta:{uid,...}}, intent?}`. With `intent:"reply"` + `source:"gmail"` + `meta.uid` it reads the body and seeds a reply draft. It handles **one** item; bulk needs the Task 14 extension.

**Key existing symbols:**
- `emailInbox.js`: `init` (86), `_bindEvents` (169), `loadEmails` (288), `_renderList` (411), `_createEmailItem` (456), `_openEmail` (641), `_showEmailMenu` (919), `_archiveEmail` (1074), `_deleteEmail` (1084), `_composeNew` (1152), module consts `API_BASE`, `_acct()`, `_currentFolder`, `_emails`, `_esc`, `spinnerModule`, `_senderColor`.
- `emailLibrary.js`: `openEmailLibrary` (545), bulk-bar HTML (657), select-all/cancel wiring (999–1024), `_updateBulkBar` (4611), `_libBulkDelete`-style handler near 4632.
- `emailLibrary/state.js`: shared `state` object incl. `_selectMode`, `_selectedUids: Set`.
- Sanitizer: `import('/static/js/emailLibrary/utils.js').then(m => m._sanitizeHtml)` (used by `inbox.js:635`).

**Decisions locked during planning (refine the spec's "undo restores all"):**
- **Undo** is offered for **reversible** verbs: archive (move back to source folder), move (reverse move), mark-read/unread (reverse flag). **Delete is treated as not-undoable**; instead a bulk delete of ≥1 message shows a confirm first. Single-row delete keeps the existing immediate behavior. This is honest about himalaya delete semantics rather than promising a restore we can't guarantee.
- Desktop/mobile split is chosen purely by viewport width (`< 900px` = stack/quick-look, `≥ 900px` = split/reading-pane).

---

## SLICE 0 — Scaffolding + pure-logic core (node-testable)

### Task 1: Promote the two email files into durable overrides

**Files:**
- Create: `frontend-overrides/js/emailInbox.js` (copy of `frontend/js/emailInbox.js`)
- Create: `frontend-overrides/js/emailLibrary.js` (copy of `frontend/js/emailLibrary.js`)
- Create: `frontend-overrides/js/emailLibrary/` subdir copies — `state.js`, `utils.js`, `signatureFold.js`, `replyRecipients.js`

- [ ] **Step 1: Copy the files verbatim into the overrides tree**

```bash
cd /Users/admin/openclaw-workspace
mkdir -p frontend-overrides/js/emailLibrary
cp frontend/js/emailInbox.js   frontend-overrides/js/emailInbox.js
cp frontend/js/emailLibrary.js frontend-overrides/js/emailLibrary.js
cp frontend/js/emailLibrary/state.js          frontend-overrides/js/emailLibrary/state.js
cp frontend/js/emailLibrary/utils.js          frontend-overrides/js/emailLibrary/utils.js
cp frontend/js/emailLibrary/signatureFold.js  frontend-overrides/js/emailLibrary/signatureFold.js
cp frontend/js/emailLibrary/replyRecipients.js frontend-overrides/js/emailLibrary/replyRecipients.js
```

- [ ] **Step 2: Verify they parse and match their source byte-for-byte**

Run:
```bash
cd /Users/admin/openclaw-workspace
node --check frontend-overrides/js/emailInbox.js && node --check frontend-overrides/js/emailLibrary.js && echo CHECK_OK
diff -q frontend/js/emailInbox.js frontend-overrides/js/emailInbox.js
diff -q frontend/js/emailLibrary.js frontend-overrides/js/emailLibrary.js
```
Expected: `CHECK_OK`, and `diff` prints nothing (identical).

- [ ] **Step 3: Confirm the override actually applies through sync**

Run:
```bash
cd /Users/admin/openclaw-workspace
WORKSPACE_BUILD_DEST=/tmp/fe-test ODYSSEUS_STATIC=frontend-vendor bash scripts/sync-frontend.sh >/dev/null 2>&1
diff -q frontend-overrides/js/emailInbox.js /tmp/fe-test/js/emailInbox.js && echo OVERRIDE_APPLIED
rm -rf /tmp/fe-test
```
Expected: `OVERRIDE_APPLIED` (the override is what lands in the build).

- [ ] **Step 4: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add frontend-overrides/js/emailInbox.js frontend-overrides/js/emailLibrary.js frontend-overrides/js/emailLibrary/
git commit -m "chore(email): promote email tab JS into durable frontend-overrides"
```

---

### Task 2: Add the pure-logic marked block + its node test

This mirrors the `SWIPE-MATH-BEGIN/END` precedent: a self-contained block (no imports) that `scripts/test-email-triage-math.mjs` extracts and exercises.

**Files:**
- Modify: `frontend-overrides/js/emailInbox.js` (add block near the top, after the icon consts, before `init`)
- Create: `scripts/test-email-triage-math.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-email-triage-math.mjs`:

```js
// Extract the marked pure-logic block from emailInbox.js and assert its
// behavior. No frontend test runner exists; run via:
//   node scripts/test-email-triage-math.mjs
import { readFileSync } from 'node:fs';

const src = readFileSync(
  new URL('../frontend-overrides/js/emailInbox.js', import.meta.url), 'utf8');
const m = src.match(
  /\/\* EMAIL-TRIAGE-MATH-BEGIN[\s\S]*?\*\/([\s\S]*?)\/\* EMAIL-TRIAGE-MATH-END \*\//);
if (!m) { console.error('FAIL: EMAIL-TRIAGE-MATH markers not found'); process.exit(1); }
const T = new Function(
  m[1] + '; return { triageMode, toggleInSet, allSelected, nextIndex, chunk, summarizeBulk };')();

let failures = 0;
const assert = (cond, msg) => { if (!cond) { console.error('FAIL: ' + msg); failures++; } };
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`);

// triageMode: width -> layout
assert(T.triageMode(1200) === 'split', 'wide is split');
assert(T.triageMode(900) === 'split', '900 is split (>=)');
assert(T.triageMode(899) === 'stack', '899 is stack');
assert(T.triageMode(375) === 'stack', 'phone is stack');

// toggleInSet: returns a NEW Set, adds/removes
{
  const s0 = new Set(['a']);
  const s1 = T.toggleInSet(s0, 'b');
  assert(s1 !== s0, 'returns a new set (no mutation)');
  eq([...s1].sort(), ['a', 'b'], 'adds missing uid');
  eq([...T.toggleInSet(s1, 'a')].sort(), ['b'], 'removes present uid');
}

// allSelected
assert(T.allSelected(['a', 'b'], new Set(['a', 'b'])) === true, 'all selected true');
assert(T.allSelected(['a', 'b'], new Set(['a'])) === false, 'partial -> false');
assert(T.allSelected([], new Set()) === false, 'empty list -> false');

// nextIndex: wraps both directions
assert(T.nextIndex(0, 3, 1) === 1, 'down');
assert(T.nextIndex(2, 3, 1) === 0, 'down wraps to 0');
assert(T.nextIndex(0, 3, -1) === 2, 'up wraps to last');
assert(T.nextIndex(-1, 3, 1) === 0, 'no selection + down -> first');
assert(T.nextIndex(5, 0, 1) === -1, 'empty list -> -1');

// chunk: batches for concurrency
eq(T.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]], 'chunks by size');
eq(T.chunk([], 3), [], 'empty -> []');

// summarizeBulk: tally ok/failed from settled results
{
  const r = T.summarizeBulk([
    { uid: 'a', ok: true }, { uid: 'b', ok: false, error: 'x' }, { uid: 'c', ok: true },
  ]);
  eq(r, { ok: 2, failed: 1, failedUids: ['b'] }, 'tallies results');
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('email-triage-math: all assertions passed');
```

- [ ] **Step 2: Run the test to verify it fails (markers absent)**

Run: `node scripts/test-email-triage-math.mjs`
Expected: FAIL with `EMAIL-TRIAGE-MATH markers not found`.

- [ ] **Step 3: Add the marked block to `frontend-overrides/js/emailInbox.js`**

Insert immediately **after** the `_deleteIcon` const (around line 23) and **before** `const _replySeparator` (line 29):

```js
/* EMAIL-TRIAGE-MATH-BEGIN (pure — node-tested by scripts/test-email-triage-math.mjs) */
const EMAIL_TRIAGE_SPLIT_MIN = 900;   // px — at/above this the reading pane shows

function triageMode(width) {
  return width >= EMAIL_TRIAGE_SPLIT_MIN ? 'split' : 'stack';
}

// Return a NEW Set with `uid` toggled — never mutate the input (callers swap
// state._selectedUids to the result so renders see a fresh reference).
function toggleInSet(set, uid) {
  const next = new Set(set);
  if (next.has(uid)) next.delete(uid); else next.add(uid);
  return next;
}

function allSelected(visibleUids, selectedSet) {
  return visibleUids.length > 0 && visibleUids.every((u) => selectedSet.has(u));
}

// Move the selection by `dir` (+1 next / -1 prev) with wraparound. `current`
// may be -1 (nothing selected). Empty list returns -1.
function nextIndex(current, len, dir) {
  if (len <= 0) return -1;
  if (current < 0) return dir > 0 ? 0 : len - 1;
  return (current + dir + len) % len;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Aggregate per-item results ({uid, ok, error?}) into a tally.
function summarizeBulk(results) {
  const failedUids = results.filter((r) => !r.ok).map((r) => r.uid);
  return { ok: results.length - failedUids.length, failed: failedUids.length, failedUids };
}
/* EMAIL-TRIAGE-MATH-END */
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node scripts/test-email-triage-math.mjs`
Expected: `email-triage-math: all assertions passed`.

- [ ] **Step 5: Confirm the file still parses**

Run: `node --check frontend-overrides/js/emailInbox.js && echo OK`
Expected: `OK`.

- [ ] **Step 6: Commit**

```bash
git add frontend-overrides/js/emailInbox.js scripts/test-email-triage-math.mjs
git commit -m "feat(email): pure triage-logic block (breakpoint, selection, nav, bulk tally) + node test"
```

---

### Task 3: Wire the math test into the existing test entry point

**Files:**
- Modify: `package.json` (root `frontend-overrides`? no — repo root) — find the script that runs `test-swipe-math.mjs`.

- [ ] **Step 1: Locate how swipe-math is run in CI/scripts**

Run:
```bash
cd /Users/admin/openclaw-workspace
grep -rn "test-swipe-math" package.json .github/ scripts/ 2>/dev/null
```
Expected: shows where the existing node test is invoked (a `package.json` script and/or a CI step).

- [ ] **Step 2: Add `test-email-triage-math.mjs` beside it**

In the same `package.json` script (or CI step) that runs `node scripts/test-swipe-math.mjs`, append `&& node scripts/test-email-triage-math.mjs`. If swipe-math is **not** wired anywhere (only run by hand), skip this task — the test still runs via `node scripts/test-email-triage-math.mjs` and later tasks invoke it explicitly.

- [ ] **Step 3: Run the combined command to confirm both pass**

Run the `package.json` test script (e.g. `npm test`) or, if none, `node scripts/test-swipe-math.mjs && node scripts/test-email-triage-math.mjs`.
Expected: both report all assertions passed.

- [ ] **Step 4: Commit (only if package.json/CI changed)**

```bash
git add package.json .github/ 2>/dev/null; git commit -m "test(email): run triage-math node test alongside swipe-math" || echo "nothing to commit"
```

---

## SLICE 1 — Reading model (reading pane / quick-look)

### Task 4: Locate the Email tab DOM and add the reading-pane container

**Files:**
- Inspect: `frontend-vendor/index.html` (or `frontend-overrides/index.html`) for the email section markup
- Modify: whichever of those holds `#email-list` — add a sibling `#email-reading-pane`

- [ ] **Step 1: Find the email panel markup and the parent of `#email-list`**

Run:
```bash
cd /Users/admin/openclaw-workspace
grep -rn 'id="email-list"\|email-panel\|email-section\|email-compose-btn\|email-folder-select' frontend-overrides/index.html frontend-vendor/index.html
```
Expected: the container element wrapping `#email-list` (note its id/class and which file owns it). If it lives in `frontend-vendor/index.html` and there is no `frontend-overrides/index.html` email section, add the override edit to whichever file is authoritative for that section (prefer `frontend-overrides/index.html` if the email markup is there; otherwise the pane is created at runtime in Task 5 instead — see Step 3).

- [ ] **Step 2: If the email section is in an editable override HTML, add the pane sibling**

Immediately after the `#email-list` element's closing tag, add:

```html
<div id="email-reading-pane" class="email-reading-pane" hidden></div>
```

And add the split modifier hook to the panel root (the element wrapping list+pane): give it `id="email-panel-root"` if it lacks a stable id.

- [ ] **Step 3: If the markup is NOT in an editable file, create the pane at runtime instead**

Add to `frontend-overrides/js/emailInbox.js` a helper called from `init` (wired in Task 5):

```js
function _ensureReadingPane() {
  const list = document.getElementById('email-list');
  if (!list || document.getElementById('email-reading-pane')) return;
  const root = list.parentElement;
  if (root && !root.id) root.id = 'email-panel-root';
  const pane = document.createElement('div');
  pane.id = 'email-reading-pane';
  pane.className = 'email-reading-pane';
  pane.hidden = true;
  list.insertAdjacentElement('afterend', pane);
}
```

- [ ] **Step 4: Verify parse**

Run: `node --check frontend-overrides/js/emailInbox.js && echo OK`
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add frontend-overrides/js/emailInbox.js frontend-overrides/index.html 2>/dev/null
git commit -m "feat(email): add reading-pane container (markup or runtime)"
```

---

### Task 5: Reading-pane render + responsive mode switch (desktop)

**Files:**
- Modify: `frontend-overrides/js/emailInbox.js` — add `_renderReadingPane`, `_applyTriageMode`, hook `init`/`_openEmail`
- Modify: `frontend-overrides/workspace.css` — split layout + pane styles

- [ ] **Step 1: Add the sanitizer accessor + pane renderer to `emailInbox.js`**

Add near the other module-level helpers (after `_ensureReadingPane`):

```js
let _emailSanitizePromise = null;
function _getEmailSanitizer() {
  if (!_emailSanitizePromise) {
    _emailSanitizePromise = import('/static/js/emailLibrary/utils.js').then((m) => m._sanitizeHtml);
  }
  return _emailSanitizePromise;
}

let _readingUid = null;   // uid shown in the pane (split mode), or null

// Render a fetched message into the reading pane with an action toolbar.
// Reuses the sandboxed-iframe fallback pattern from inbox.js for HTML safety.
function _renderReadingPane(em, data) {
  const pane = document.getElementById('email-reading-pane');
  if (!pane) return;
  _readingUid = String(em.uid);
  pane.hidden = false;
  pane.innerHTML = `
    <div class="email-rp-head">
      <div class="email-rp-subject">${_esc(data.subject || '(no subject)')}</div>
      <div class="email-rp-from">${_esc(data.from_name || data.from_address || '')}${data.date ? ` <span class="email-rp-date">· ${_esc(data.date)}</span>` : ''}</div>
    </div>
    <div class="email-rp-actions">
      <button class="email-rp-btn" data-rp="archive" title="Archive">Archive</button>
      <button class="email-rp-btn" data-rp="delete" title="Delete">Delete</button>
      <button class="email-rp-btn" data-rp="unread" title="Mark unread">Mark unread</button>
      <button class="email-rp-btn" data-rp="move" title="Move to folder">Move ▾</button>
      <button class="email-rp-btn" data-rp="agent" title="Hand to __AGENT_NAME__">Hand to __AGENT_NAME__</button>
      <button class="email-rp-btn" data-rp="full" title="Open full reader">Open full</button>
      <button class="email-rp-btn email-rp-reply" data-rp="reply" title="Reply">Reply</button>
    </div>
    <div class="email-rp-body html-body" id="email-rp-body"></div>`;
  const target = pane.querySelector('#email-rp-body');
  const html = data.body_html || data.body || '';
  _getEmailSanitizer().then((sanitize) => {
    if (target.isConnected) target.innerHTML = sanitize(html);
  }).catch(() => {
    if (!target.isConnected) return;
    target.classList.remove('html-body');
    const f = document.createElement('iframe');
    f.className = 'email-rp-frame';
    f.setAttribute('sandbox', '');
    f.srcdoc = html;
    target.appendChild(f);
  });
  // Toolbar actions are wired in Task 9 (single-item action dispatch).
  pane.querySelectorAll('.email-rp-btn').forEach((b) => {
    b.addEventListener('click', () => _readingPaneAction(em, b.dataset.rp));
  });
}

// Placeholder dispatch — fully implemented in Task 9. Defined here so the file
// parses and the buttons are inert-but-safe until then.
function _readingPaneAction(em, act) {
  if (act === 'full') { _openEmail(em, null); return; }
  if (act === 'reply') { _openEmail(em, null, null, 'reply'); return; }
  /* archive/delete/unread/move/agent wired in Task 9 */
}

function _applyTriageMode() {
  const root = document.getElementById('email-panel-root')
    || (document.getElementById('email-list') || {}).parentElement;
  if (!root) return;
  const mode = triageMode(window.innerWidth);
  root.classList.toggle('email-split', mode === 'split');
  const pane = document.getElementById('email-reading-pane');
  if (pane && mode === 'stack') { pane.hidden = true; _readingUid = null; }
}
```

- [ ] **Step 2: Hook mode-switch + pane creation into `init`**

In `export function init(...)` (line 86), at the end of the function body, add:

```js
  _ensureReadingPane();
  _applyTriageMode();
  window.addEventListener('resize', _applyTriageMode);
```

- [ ] **Step 3: Make row-open use the pane in split mode**

In `_createEmailItem`, change the click handler (currently `frontend-overrides/js/emailInbox.js` around the line that calls `_openEmail(em, item)` inside the `item.addEventListener('click', ...)`) to branch on mode:

```js
  item.addEventListener('click', (e) => {
    if (e.target.closest('.email-menu-wrap')) return;
    if (e.target.closest('.email-row-check')) return;   // Task 7 checkbox
    if (item.dataset.swipeBlock === '1') return;
    if (triageMode(window.innerWidth) === 'split') {
      _openInReadingPane(em, item);
    } else {
      _openEmail(em, item);   // stack mode: Task 6 swaps this for quick-look
    }
  });
```

- [ ] **Step 4: Add `_openInReadingPane` (fetch + render, mark-seen=false for skim)**

```js
async function _openInReadingPane(em, itemEl) {
  document.querySelectorAll('#email-list .email-item.email-row-active')
    .forEach((n) => n.classList.remove('email-row-active'));
  if (itemEl) itemEl.classList.add('email-row-active');
  const pane = document.getElementById('email-reading-pane');
  if (pane) { pane.hidden = false; pane.innerHTML = '<div class="email-loading">Loading…</div>'; }
  try {
    const res = await fetch(`${API_BASE}/api/email/read/${em.uid}?folder=${encodeURIComponent(_currentFolder)}&mark_seen=false${_acct()}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    _renderReadingPane(em, data);
  } catch (err) {
    if (pane) pane.innerHTML = `<div class="email-loading">${_esc(String(err.message || err))}</div>`;
  }
}
```

- [ ] **Step 5: Add CSS for the split layout**

Append to `frontend-overrides/workspace.css`:

```css
/* Email tab reading-pane (desktop split) ---------------------------------- */
#email-panel-root.email-split { display: flex; gap: 0; min-height: 0; }
#email-panel-root.email-split #email-list { flex: 0 0 38%; max-width: 420px; overflow-y: auto; border-right: 1px solid var(--border, rgba(127,127,127,0.2)); }
#email-panel-root.email-split #email-reading-pane { flex: 1 1 auto; overflow-y: auto; }
.email-reading-pane { padding: 14px 18px; }
.email-rp-head { margin-bottom: 8px; }
.email-rp-subject { font-weight: 600; font-size: 15px; }
.email-rp-from { opacity: 0.7; font-size: 12px; margin-top: 2px; }
.email-rp-date { opacity: 0.6; }
.email-rp-actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0; }
.email-rp-btn { font-size: 12px; padding: 4px 9px; border-radius: 6px; border: 1px solid var(--border, rgba(127,127,127,0.25)); background: var(--bg-elev, transparent); color: var(--fg); cursor: pointer; }
.email-rp-btn:hover { background: var(--hover, rgba(127,127,127,0.12)); }
.email-rp-reply { margin-left: auto; }
.email-rp-body { line-height: 1.45; }
.email-rp-frame { width: 100%; min-height: 400px; border: 0; }
#email-list .email-item.email-row-active { background: var(--hover, rgba(127,127,127,0.14)); }
```

- [ ] **Step 6: Verify parse + math test still green**

Run: `node --check frontend-overrides/js/emailInbox.js && node scripts/test-email-triage-math.mjs && echo OK`
Expected: `OK` then `email-triage-math: all assertions passed`.

- [ ] **Step 7: Commit**

```bash
git add frontend-overrides/js/emailInbox.js frontend-overrides/workspace.css
git commit -m "feat(email): desktop reading pane + responsive split/stack switch"
```

---

### Task 6: Mobile quick-look overlay (stack mode)

**Files:**
- Modify: `frontend-overrides/js/emailInbox.js` — add `_openQuickLook`, prev/next nav, swipe-to-close
- Modify: `frontend-overrides/workspace.css` — overlay styles

- [ ] **Step 1: Add the quick-look overlay builder + open/close**

```js
let _qlOverlay = null;
function _buildQuickLook() {
  if (_qlOverlay) return _qlOverlay;
  const ov = document.createElement('div');
  ov.id = 'email-quicklook';
  ov.className = 'email-ql-overlay';
  ov.hidden = true;
  ov.innerHTML = `
    <div class="email-ql-card" role="dialog" aria-label="Email">
      <div class="email-ql-head">
        <button class="email-ql-x" id="email-ql-close" title="Close">✕</button>
        <span class="email-ql-nav"><button id="email-ql-prev" title="Previous">◄</button>
        <button id="email-ql-next" title="Next">►</button></span>
      </div>
      <div class="email-ql-meta" id="email-ql-meta"></div>
      <div class="email-ql-actions" id="email-ql-actions"></div>
      <div class="email-ql-body html-body" id="email-ql-body"></div>
    </div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', (e) => { if (e.target === ov) _closeQuickLook(); });
  ov.querySelector('#email-ql-close').addEventListener('click', _closeQuickLook);
  ov.querySelector('#email-ql-prev').addEventListener('click', () => _quickLookStep(-1));
  ov.querySelector('#email-ql-next').addEventListener('click', () => _quickLookStep(1));
  _qlOverlay = ov;
  return ov;
}

function _closeQuickLook() { if (_qlOverlay) _qlOverlay.hidden = true; }

function _quickLookStep(dir) {
  const cur = _emails.findIndex((e) => String(e.uid) === String(_readingUid));
  const ni = nextIndex(cur, _emails.length, dir);
  if (ni >= 0) _openQuickLook(_emails[ni]);
}

async function _openQuickLook(em) {
  const ov = _buildQuickLook();
  ov.hidden = false;
  _readingUid = String(em.uid);
  const meta = ov.querySelector('#email-ql-meta');
  const bodyEl = ov.querySelector('#email-ql-body');
  const actions = ov.querySelector('#email-ql-actions');
  meta.innerHTML = '<div class="email-loading">Loading…</div>';
  bodyEl.innerHTML = '';
  actions.innerHTML = '';
  try {
    const res = await fetch(`${API_BASE}/api/email/read/${em.uid}?folder=${encodeURIComponent(_currentFolder)}&mark_seen=false${_acct()}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    meta.innerHTML = `<div class="email-rp-subject">${_esc(data.subject || '(no subject)')}</div>
      <div class="email-rp-from">${_esc(data.from_name || data.from_address || '')}</div>`;
    actions.innerHTML = `
      <button class="email-rp-btn" data-rp="archive">Archive</button>
      <button class="email-rp-btn" data-rp="delete">Delete</button>
      <button class="email-rp-btn" data-rp="unread">Unread</button>
      <button class="email-rp-btn" data-rp="move">Move ▾</button>
      <button class="email-rp-btn" data-rp="agent">Hand to __AGENT_NAME__</button>
      <button class="email-rp-btn email-rp-reply" data-rp="reply">Reply</button>`;
    actions.querySelectorAll('.email-rp-btn').forEach((b) =>
      b.addEventListener('click', () => _readingPaneAction(em, b.dataset.rp)));
    const html = data.body_html || data.body || '';
    _getEmailSanitizer().then((s) => { if (bodyEl.isConnected) bodyEl.innerHTML = s(html); })
      .catch(() => {
        const f = document.createElement('iframe');
        f.className = 'email-rp-frame'; f.setAttribute('sandbox', ''); f.srcdoc = html;
        bodyEl.appendChild(f);
      });
  } catch (err) {
    meta.innerHTML = `<div class="email-loading">${_esc(String(err.message || err))}</div>`;
  }
}
```

- [ ] **Step 2: Route stack-mode row clicks to quick-look**

In `_createEmailItem`'s click handler (edited in Task 5 Step 3), replace the `else` branch `_openEmail(em, item)` with `_openQuickLook(em)`.

- [ ] **Step 3: Add swipe left/right = next/prev, swipe-down = close**

Add inside `_buildQuickLook` before `return _qlOverlay`:

```js
  (function bindQlSwipe() {
    const card = ov.querySelector('.email-ql-card');
    let sx = 0, sy = 0, t0 = 0;
    card.addEventListener('touchstart', (e) => {
      const t = e.touches[0]; sx = t.clientX; sy = t.clientY; t0 = e.timeStamp;
    }, { passive: true });
    card.addEventListener('touchend', (e) => {
      const t = e.changedTouches[0];
      const dx = t.clientX - sx, dy = t.clientY - sy, dt = e.timeStamp - t0;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) { _quickLookStep(dx < 0 ? 1 : -1); return; }
      if (dy > 80 && Math.abs(dx) < 50 && dt < 600) _closeQuickLook();
    }, { passive: true });
  })();
```

- [ ] **Step 4: Add Esc-to-close (reuse the existing keydown handler)**

In the existing global key handler (`_onKey`, near line 1034 in the override), add at the top of the function body:

```js
  if (e.key === 'Escape' && _qlOverlay && !_qlOverlay.hidden) { _closeQuickLook(); return; }
```

- [ ] **Step 5: Add overlay CSS**

Append to `frontend-overrides/workspace.css`:

```css
/* Email quick-look (mobile) ----------------------------------------------- */
.email-ql-overlay { position: fixed; inset: 0; z-index: 60; background: rgba(0,0,0,0.4); display: flex; align-items: flex-end; }
.email-ql-card { background: var(--bg, #fff); width: 100%; max-height: 92vh; border-radius: 14px 14px 0 0; padding: 12px 16px calc(16px + env(safe-area-inset-bottom)); overflow-y: auto; }
.email-ql-head { display: flex; justify-content: space-between; align-items: center; }
.email-ql-x, .email-ql-nav button { background: none; border: 0; font-size: 16px; color: var(--fg); cursor: pointer; padding: 4px 8px; }
.email-ql-meta { margin: 6px 0; }
.email-ql-actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
.email-ql-body { line-height: 1.45; }
@media (min-width: 900px) { .email-ql-overlay { display: none; } }
```

- [ ] **Step 6: Verify parse + tests**

Run: `node --check frontend-overrides/js/emailInbox.js && node scripts/test-email-triage-math.mjs && echo OK`
Expected: `OK` + assertions passed.

- [ ] **Step 7: Commit**

```bash
git add frontend-overrides/js/emailInbox.js frontend-overrides/workspace.css
git commit -m "feat(email): mobile quick-look overlay with prev/next + swipe-close"
```

---

## SLICE 2 — Inline multi-select, bulk bar, fan-out, undo

### Task 7: Per-row checkbox (hover desktop / long-press mobile) + selection state

**Files:**
- Modify: `frontend-overrides/js/emailInbox.js` — checkbox in `_createEmailItem`, selection handlers
- Modify: `frontend-overrides/workspace.css` — checkbox visibility rules

- [ ] **Step 1: Import shared selection state into `emailInbox.js`**

At the top of `frontend-overrides/js/emailInbox.js`, beside the existing `import { buildReplyAllCc } ...` (line 11), add:

```js
import { state as _emailState } from './emailLibrary/state.js';
```

(`_emailState._selectedUids` is the same `Set` the Library used — Task 13 retires the Library but the state module stays.)

- [ ] **Step 2: Add the checkbox + avatar to the row markup**

In `_createEmailItem`, change the avatar line inside `item.innerHTML` so the checkbox sits in front of the avatar:

```js
      <span class="email-row-check" title="Select"><input type="checkbox" tabindex="-1"></span>
      <span class="email-avatar" style="background:${color}">${initial}</span>
```

- [ ] **Step 3: Wire checkbox toggle + long-press-to-select**

Add to `_createEmailItem` before `return item;`:

```js
  const cb = item.querySelector('.email-row-check input');
  if (cb) {
    cb.checked = _emailState._selectedUids.has(em.uid);
    const sync = () => {
      _emailState._selectedUids = toggleInSet(_emailState._selectedUids, em.uid);
      item.classList.toggle('email-row-selected', _emailState._selectedUids.has(em.uid));
      _updateEmailBulkBar();
    };
    item.querySelector('.email-row-check').addEventListener('click', (e) => {
      e.stopPropagation(); sync(); cb.checked = _emailState._selectedUids.has(em.uid);
    });
  }
  // Long-press on touch selects (and reveals the bulk bar).
  if ('ontouchstart' in window) {
    let lp = null;
    item.addEventListener('touchstart', () => {
      lp = setTimeout(() => {
        _emailState._selectedUids = toggleInSet(_emailState._selectedUids, em.uid);
        item.classList.toggle('email-row-selected', _emailState._selectedUids.has(em.uid));
        if (cb) cb.checked = _emailState._selectedUids.has(em.uid);
        item.dataset.swipeBlock = '1';
        _updateEmailBulkBar();
      }, 500);
    }, { passive: true });
    const cancel = () => { if (lp) { clearTimeout(lp); lp = null; }
      setTimeout(() => { delete item.dataset.swipeBlock; }, 50); };
    item.addEventListener('touchend', cancel);
    item.addEventListener('touchmove', cancel, { passive: true });
  }
```

- [ ] **Step 4: Add checkbox CSS (hidden until hover / selected)**

Append to `frontend-overrides/workspace.css`:

```css
/* Email row selection ----------------------------------------------------- */
.email-row-check { display: inline-flex; align-items: center; width: 0; overflow: hidden; transition: width .12s ease; flex-shrink: 0; }
.email-item:hover .email-row-check,
.email-item.email-row-selected .email-row-check,
body.email-has-selection .email-item .email-row-check { width: 22px; }
.email-item.email-row-selected { background: var(--accent-soft, rgba(80,140,255,0.12)); }
@media (pointer: coarse) { .email-item:hover .email-row-check { width: 0; } }
```

- [ ] **Step 5: Verify parse**

Run: `node --check frontend-overrides/js/emailInbox.js && echo OK`
Expected: `OK` (`_updateEmailBulkBar` is defined in Task 8 — if you run before Task 8, add a temporary `function _updateEmailBulkBar(){}` stub and remove it in Task 8).

- [ ] **Step 6: Commit**

```bash
git add frontend-overrides/js/emailInbox.js frontend-overrides/workspace.css
git commit -m "feat(email): inline per-row selection (hover checkbox + long-press)"
```

---

### Task 8: Bulk action bar

**Files:**
- Modify: `frontend-overrides/js/emailInbox.js` — `_ensureBulkBar`, `_updateEmailBulkBar`, select-all/clear
- Modify: `frontend-overrides/workspace.css` — bulk bar styles

- [ ] **Step 1: Add the bulk bar (created lazily above `#email-list`)**

```js
function _ensureBulkBar() {
  if (document.getElementById('email-bulk-bar')) return;
  const list = document.getElementById('email-list');
  if (!list) return;
  const bar = document.createElement('div');
  bar.id = 'email-bulk-bar';
  bar.className = 'email-bulk-bar';
  bar.hidden = true;
  bar.innerHTML = `
    <label class="email-bulk-all"><input type="checkbox" id="email-bulk-all"> All</label>
    <span id="email-bulk-count">0 selected</span>
    <span class="email-bulk-actions">
      <button class="email-rp-btn" data-bulk="archive">Archive</button>
      <button class="email-rp-btn" data-bulk="read">Mark read</button>
      <button class="email-rp-btn" data-bulk="unread">Mark unread</button>
      <button class="email-rp-btn" data-bulk="move">Move ▾</button>
      <button class="email-rp-btn" data-bulk="agent">Hand to __AGENT_NAME__</button>
      <button class="email-rp-btn" data-bulk="delete" style="color:var(--red)">Delete</button>
      <button class="email-rp-btn" data-bulk="cancel" title="Clear (Esc)">✕</button>
    </span>`;
  list.insertAdjacentElement('beforebegin', bar);
  bar.querySelector('#email-bulk-all').addEventListener('change', (e) => {
    if (e.target.checked) _emailState._selectedUids = new Set(_emails.map((m) => m.uid));
    else _emailState._selectedUids = new Set();
    _renderList(); _updateEmailBulkBar();
  });
  bar.querySelectorAll('[data-bulk]').forEach((b) =>
    b.addEventListener('click', () => _bulkAction(b.dataset.bulk)));   // Task 11
}

function _clearEmailSelection() {
  _emailState._selectedUids = new Set();
  document.querySelectorAll('#email-list .email-row-selected')
    .forEach((n) => n.classList.remove('email-row-selected'));
  document.querySelectorAll('#email-list .email-row-check input')
    .forEach((c) => { c.checked = false; });
  _updateEmailBulkBar();
}

function _updateEmailBulkBar() {
  _ensureBulkBar();
  const bar = document.getElementById('email-bulk-bar');
  if (!bar) return;
  const n = _emailState._selectedUids.size;
  bar.hidden = n === 0;
  document.body.classList.toggle('email-has-selection', n > 0);
  const count = bar.querySelector('#email-bulk-count');
  if (count) count.textContent = `${n} selected`;
  const all = bar.querySelector('#email-bulk-all');
  if (all) all.checked = allSelected(_emails.map((m) => m.uid), _emailState._selectedUids);
}
```

- [ ] **Step 2: Make `cancel` clear and call `_ensureBulkBar` on init**

In `_bulkAction` (Task 11) the `cancel` case calls `_clearEmailSelection()`. For now, add `_ensureBulkBar();` to the end of `init` (after `_applyTriageMode()`), and extend the `_onKey` Escape branch (Task 6 Step 4) to also clear selection:

```js
  if (e.key === 'Escape' && _emailState._selectedUids.size) { _clearEmailSelection(); return; }
```

- [ ] **Step 3: Remove the temporary stub if you added one in Task 7**

- [ ] **Step 4: Add bulk bar CSS**

```css
.email-bulk-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 6px 10px; border-bottom: 1px solid var(--border, rgba(127,127,127,0.2)); position: sticky; top: 0; z-index: 2; background: var(--bg, #fff); }
.email-bulk-bar .email-bulk-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-left: auto; }
.email-bulk-all { font-size: 12px; display: inline-flex; gap: 4px; align-items: center; }
#email-bulk-count { font-size: 12px; opacity: 0.75; }
```

- [ ] **Step 5: Verify parse + tests**

Run: `node --check frontend-overrides/js/emailInbox.js && node scripts/test-email-triage-math.mjs && echo OK`
Expected: `OK` + assertions passed (`_bulkAction` is defined in Task 11; add a temporary `function _bulkAction(){}` stub to parse, removed in Task 11).

- [ ] **Step 6: Commit**

```bash
git add frontend-overrides/js/emailInbox.js frontend-overrides/workspace.css
git commit -m "feat(email): bulk action bar (select-all, count, action buttons)"
```

---

### Task 9: Single-item action dispatch (reading pane + quick-look toolbars)

**Files:**
- Modify: `frontend-overrides/js/emailInbox.js` — flesh out `_readingPaneAction`, add `_emailAction` helper + undo toast

- [ ] **Step 1: Add a per-uid action helper that returns a settled result**

```js
// Call one per-uid endpoint. Returns {uid, ok, error?} — never throws, so it
// composes cleanly in the bulk fan-out (Task 10).
async function _emailUidAction(uid, act, opts = {}) {
  const f = encodeURIComponent(opts.folder || _currentFolder);
  let url, method = 'POST';
  if (act === 'archive') url = `${API_BASE}/api/email/archive/${uid}?folder=${f}${_acct()}`;
  else if (act === 'delete') { url = `${API_BASE}/api/email/delete/${uid}?folder=${f}${_acct()}`; method = 'DELETE'; }
  else if (act === 'read') url = `${API_BASE}/api/email/mark-read/${uid}?folder=${f}${_acct()}`;
  else if (act === 'unread') url = `${API_BASE}/api/email/mark-unread/${uid}?folder=${f}${_acct()}`;
  else if (act === 'move') url = `${API_BASE}/api/email/move/${uid}?folder=${f}&dest=${encodeURIComponent(opts.dest || 'INBOX')}${_acct()}`;
  else return { uid, ok: false, error: `unknown action ${act}` };
  try {
    const r = await fetch(url, { method, credentials: 'same-origin' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return { uid, ok: true };
  } catch (err) { return { uid, ok: false, error: String(err.message || err) }; }
}

function _removeRow(uid) {
  const row = document.querySelector(`#email-list .email-item[data-uid="${CSS.escape(String(uid))}"]`);
  if (row) { row.style.opacity = '0.3'; setTimeout(() => row.remove(), 180); }
  _emails = _emails.filter((m) => String(m.uid) !== String(uid));
}

function _toast(msg, undoFn) {
  import('/static/js/ui.js').then((m) => {
    if (!m.showToast) return;
    if (undoFn) m.showToast(msg, { duration: 8000, actionLabel: 'Undo', onAction: undoFn });
    else m.showToast(msg, { duration: 4000 });
  }).catch(() => {});
}
```

> **Note:** confirm `ui.js`'s `showToast` signature — if it does not support an `actionLabel`/`onAction` option, fall back to the inbox.js toast pattern (`frontend-overrides/js/inbox.js:922 showToast`) by porting a minimal toast into `emailInbox.js`. Step 2 of this task includes a `grep` to check.

- [ ] **Step 2: Check the toast API before relying on it**

Run:
```bash
cd /Users/admin/openclaw-workspace
grep -n "export function showToast\|showToast =" frontend/js/ui.js
sed -n '/showToast/,/^}/p' frontend/js/ui.js | head -40
```
Expected: shows `showToast` params. If it has no action-button support, add a local `_emailToast` modeled on `inbox.js`'s `showToast`/`doUndo` and use it instead of `_toast` throughout this slice.

- [ ] **Step 3: Implement `_readingPaneAction` fully**

Replace the placeholder `_readingPaneAction` from Task 5 with:

```js
async function _readingPaneAction(em, act) {
  if (act === 'full') { _openEmail(em, null); return; }
  if (act === 'reply') { _openEmail(em, null, null, 'reply'); return; }
  if (act === 'move') { _openMoveMenu([em.uid], em); return; }          // Task 12
  if (act === 'agent') { _handEmailsToAgent([em]); return; }            // Task 12
  if (act === 'delete') {
    const res = await _emailUidAction(em.uid, 'delete', { folder: _currentFolder });
    if (res.ok) { _removeRow(em.uid); _closeQuickLook(); _clearReadingPane(); _toast('Deleted'); }
    else _toast('Delete failed: ' + res.error);
    return;
  }
  const reverse = { archive: () => _emailUidAction(em.uid, 'move', { folder: _archiveFolderName(), dest: _currentFolder }),
                    unread: () => _emailUidAction(em.uid, 'read', { folder: _currentFolder }),
                    read: () => _emailUidAction(em.uid, 'unread', { folder: _currentFolder }) }[act];
  const res = await _emailUidAction(em.uid, act, { folder: _currentFolder });
  if (!res.ok) { _toast(`${act} failed: ` + res.error); return; }
  if (act === 'archive') { _removeRow(em.uid); _closeQuickLook(); _clearReadingPane(); }
  _toast(`${act === 'unread' ? 'Marked unread' : act === 'read' ? 'Marked read' : 'Archived'}`,
         reverse ? async () => { await reverse(); loadEmails(false); } : null);
}

function _clearReadingPane() {
  const pane = document.getElementById('email-reading-pane');
  if (pane && String(_readingUid) ) { pane.hidden = true; pane.innerHTML = ''; }
  _readingUid = null;
}

// Best-effort archive-folder name from the loaded folder list (Task 12 loads
// folders); fall back to "Archive".
function _archiveFolderName() {
  try {
    const sel = document.getElementById('email-folder-select');
    if (sel) for (const o of sel.options) if (/archive|all mail/i.test(o.value)) return o.value;
  } catch (_) {}
  return 'Archive';
}
```

- [ ] **Step 4: Verify parse + tests**

Run: `node --check frontend-overrides/js/emailInbox.js && node scripts/test-email-triage-math.mjs && echo OK`
Expected: `OK` + assertions passed (`_openMoveMenu`/`_handEmailsToAgent` land in Task 12; add temporary stubs `function _openMoveMenu(){} function _handEmailsToAgent(){}` to parse, removed in Task 12).

- [ ] **Step 5: Commit**

```bash
git add frontend-overrides/js/emailInbox.js
git commit -m "feat(email): single-item action dispatch with reversible undo toast"
```

---

### Task 10: Bulk fan-out runner

**Files:**
- Modify: `frontend-overrides/js/emailInbox.js` — `_runBulk` using `chunk` + `summarizeBulk`

- [ ] **Step 1: Add the concurrency-capped runner**

```js
// Run `perUid(uid)` over all uids, max `concurrency` in flight, collecting
// {uid, ok, error?}. Uses the pure `chunk` from the triage-math block.
async function _runBulk(uids, perUid, concurrency = 5) {
  const out = [];
  for (const batch of chunk(uids, concurrency)) {
    const settled = await Promise.all(batch.map((u) => perUid(u)));
    out.push(...settled);
  }
  return out;   // summarize with summarizeBulk(out)
}
```

- [ ] **Step 2: Verify parse**

Run: `node --check frontend-overrides/js/emailInbox.js && echo OK`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add frontend-overrides/js/emailInbox.js
git commit -m "feat(email): concurrency-capped bulk fan-out runner"
```

---

### Task 11: Bulk action dispatch (wire the bulk bar buttons)

**Files:**
- Modify: `frontend-overrides/js/emailInbox.js` — implement `_bulkAction`

- [ ] **Step 1: Implement `_bulkAction`**

Replace the Task 8 stub with:

```js
async function _bulkAction(act) {
  if (act === 'cancel') { _clearEmailSelection(); return; }
  const uids = Array.from(_emailState._selectedUids);
  if (!uids.length) return;
  if (act === 'move') { _openMoveMenu(uids, null); return; }          // Task 12
  if (act === 'agent') {
    _handEmailsToAgent(_emails.filter((m) => _emailState._selectedUids.has(m.uid)));   // Task 12
    return;
  }
  if (act === 'delete' && !confirm(`Delete ${uids.length} message(s)? This can't be undone.`)) return;

  const results = await _runBulk(uids, (u) => _emailUidAction(u, act, { folder: _currentFolder }));
  const { ok, failed, failedUids } = summarizeBulk(results);
  // Remove successful rows (archive/delete leave the folder; read/unread stay
  // but we re-render to refresh dots).
  if (act === 'archive' || act === 'delete') failedUids.length
    ? results.filter((r) => r.ok).forEach((r) => _removeRow(r.uid))
    : uids.forEach((u) => _removeRow(u));
  const reverse = (act === 'archive')
    ? async () => { await _runBulk(uids.filter((u) => !failedUids.includes(u)),
        (u) => _emailUidAction(u, 'move', { folder: _archiveFolderName(), dest: _currentFolder })); loadEmails(false); }
    : (act === 'read' || act === 'unread')
      ? async () => { await _runBulk(uids.filter((u) => !failedUids.includes(u)),
          (u) => _emailUidAction(u, act === 'read' ? 'unread' : 'read', { folder: _currentFolder })); loadEmails(false); }
      : null;
  _clearEmailSelection();
  const msg = failed ? `${act}: ${ok} done, ${failed} failed` : `${act}: ${ok} done`;
  _toast(msg, reverse);
  if (act === 'read' || act === 'unread') loadEmails(false);
}
```

- [ ] **Step 2: Verify parse + tests**

Run: `node --check frontend-overrides/js/emailInbox.js && node scripts/test-email-triage-math.mjs && echo OK`
Expected: `OK` + assertions passed.

- [ ] **Step 3: Commit**

```bash
git add frontend-overrides/js/emailInbox.js
git commit -m "feat(email): bulk archive/delete/read/unread with combined undo + partial-failure report"
```

---

## SLICE 3 — Move, Hand-to-agent, per-row quick actions

### Task 12: Move-to-folder menu + Hand-to-agent (frontend)

**Files:**
- Modify: `frontend-overrides/js/emailInbox.js` — `_openMoveMenu`, `_handEmailsToAgent`

- [ ] **Step 1: Implement the move menu (reuse the folder `<select>` options)**

```js
function _openMoveMenu(uids, anchorEm) {
  const existing = document.getElementById('email-move-menu');
  if (existing) { existing.remove(); return; }
  const sel = document.getElementById('email-folder-select');
  const folders = sel ? Array.from(sel.options).map((o) => o.value) : ['INBOX', 'Archive', 'Trash'];
  const menu = document.createElement('div');
  menu.id = 'email-move-menu';
  menu.className = 'email-move-menu';
  menu.innerHTML = folders.filter((f) => f && f !== _currentFolder)
    .map((f) => `<button class="email-rp-btn" data-dest="${_esc(f)}">${_esc(f)}</button>`).join('');
  document.body.appendChild(menu);
  menu.querySelectorAll('[data-dest]').forEach((b) => b.addEventListener('click', async () => {
    const dest = b.dataset.dest;
    menu.remove();
    const results = await _runBulk(uids, (u) => _emailUidAction(u, 'move', { folder: _currentFolder, dest }));
    const { ok, failed } = summarizeBulk(results);
    results.filter((r) => r.ok).forEach((r) => _removeRow(r.uid));
    _clearEmailSelection(); _closeQuickLook(); _clearReadingPane();
    _toast(failed ? `Moved ${ok}, ${failed} failed` : `Moved ${ok} to ${dest}`,
      async () => { await _runBulk(uids, (u) => _emailUidAction(u, 'move', { folder: dest, dest: _currentFolder })); loadEmails(false); });
  }));
  document.addEventListener('click', function close(e) {
    if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close); }
  }, { capture: true });
}
```

- [ ] **Step 2: Implement Hand-to-agent (single = reuse spinoff; bulk = Task 14 endpoint)**

```js
async function _handEmailsToAgent(emails) {
  try {
    let session_id;
    if (emails.length === 1) {
      const em = emails[0];
      const r = await fetch(`${API_BASE}/api/items/spinoff`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent: 'reply', item: {
          source: 'gmail', title: em.subject || '(no subject)',
          subtitle: em.from_name || em.from_address || '',
          meta: { uid: String(em.uid), folder: _currentFolder } } }),
      });
      const d = await r.json();
      if (!r.ok || !d.session_id) throw new Error(d.detail || 'no session');
      session_id = d.session_id;
    } else {
      const r = await fetch(`${API_BASE}/api/items/spinoff`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: emails.map((em) => ({
          source: 'gmail', title: em.subject || '(no subject)',
          subtitle: em.from_name || em.from_address || '',
          meta: { uid: String(em.uid), folder: _currentFolder } })) }),
      });
      const d = await r.json();
      if (!r.ok || !d.session_id) throw new Error(d.detail || 'no session');
      session_id = d.session_id;
    }
    window.location.hash = '#' + session_id;
    window.location.reload();
  } catch (err) { _toast('Hand-to-agent failed: ' + String(err.message || err)); }
}
```

- [ ] **Step 3: Remove the Task 9 stubs for these two functions. Add move-menu CSS:**

```css
.email-move-menu { position: fixed; right: 18px; top: 80px; z-index: 70; background: var(--bg, #fff); border: 1px solid var(--border, rgba(127,127,127,0.3)); border-radius: 8px; padding: 6px; display: flex; flex-direction: column; gap: 4px; max-height: 60vh; overflow-y: auto; box-shadow: 0 8px 24px rgba(0,0,0,0.18); }
```

- [ ] **Step 4: Verify parse + tests**

Run: `node --check frontend-overrides/js/emailInbox.js && node scripts/test-email-triage-math.mjs && echo OK`
Expected: `OK` + assertions passed.

- [ ] **Step 5: Commit**

```bash
git add frontend-overrides/js/emailInbox.js frontend-overrides/workspace.css
git commit -m "feat(email): move-to-folder menu + hand-to-agent (single + bulk)"
```

---

### Task 13: Per-row quick actions (Archive / Delete on the row)

**Files:**
- Modify: `frontend-overrides/js/emailInbox.js` — add quick-action buttons to `_createEmailItem`
- Modify: `frontend-overrides/workspace.css` — show on hover

- [ ] **Step 1: Add quick-action buttons to the row markup**

In `_createEmailItem`, change the `.email-menu-wrap` block in `item.innerHTML` to include quick actions before the hamburger:

```js
    <div class="email-menu-wrap">
      <button class="email-quick" data-quick="archive" title="Archive">${_archiveIcon}</button>
      <button class="email-quick" data-quick="delete" title="Delete">${_deleteIcon}</button>
      <button class="hamburger email-menu-btn" title="Actions">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
      </button>
    </div>
```

- [ ] **Step 2: Wire the quick buttons (reuse the single-item dispatch)**

Add to `_createEmailItem` (after the menuWrap click handler around line 570):

```js
  item.querySelectorAll('.email-quick').forEach((qb) => {
    qb.addEventListener('click', async (e) => {
      e.stopPropagation();
      const act = qb.dataset.quick;
      if (act === 'delete') {
        const res = await _emailUidAction(em.uid, 'delete', { folder: _currentFolder });
        if (res.ok) { _removeRow(em.uid); _toast('Deleted'); } else _toast('Delete failed: ' + res.error);
      } else {
        const res = await _emailUidAction(em.uid, 'archive', { folder: _currentFolder });
        if (res.ok) { _removeRow(em.uid); _toast('Archived',
          async () => { await _emailUidAction(em.uid, 'move', { folder: _archiveFolderName(), dest: _currentFolder }); loadEmails(false); }); }
        else _toast('Archive failed: ' + res.error);
      }
    });
  });
```

- [ ] **Step 3: Quick-action CSS (hover-only on desktop, hidden in select mode)**

```css
.email-quick { display: none; background: none; border: 0; color: var(--fg); opacity: 0.6; cursor: pointer; padding: 2px 4px; }
.email-item:hover .email-quick { display: inline-flex; }
.email-quick:hover { opacity: 1; }
body.email-has-selection .email-quick { display: none; }
@media (pointer: coarse) { .email-item:hover .email-quick { display: none; } }
```

- [ ] **Step 4: Verify parse + tests**

Run: `node --check frontend-overrides/js/emailInbox.js && node scripts/test-email-triage-math.mjs && echo OK`
Expected: `OK` + assertions passed.

- [ ] **Step 5: Commit**

```bash
git add frontend-overrides/js/emailInbox.js frontend-overrides/workspace.css
git commit -m "feat(email): per-row hover quick actions (archive/delete)"
```

---

### Task 14: Backend — bulk Hand-to-agent (one session for many emails)

**Files:**
- Modify: `backend/inbox/__init__.py` — extend `spinoff` to accept `payload.items` (list)
- Test: `backend/tests/test_inbox_email_spinoff.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_inbox_email_spinoff.py`:

```python
import json
from fastapi.testclient import TestClient
from backend.app import app   # adjust import if the FastAPI app lives elsewhere

client = TestClient(app)


def test_spinoff_single_email_reply():
    r = client.post("/api/items/spinoff", json={
        "intent": "reply",
        "item": {"source": "gmail", "title": "Q3 plan",
                  "subtitle": "taylor@example.com",
                  "meta": {"uid": "123", "folder": "INBOX"}},
    })
    assert r.status_code == 200
    assert r.json().get("session_id")


def test_spinoff_bulk_emails_one_session():
    items = [
        {"source": "gmail", "title": "Invoice 1", "subtitle": "a@x.com",
         "meta": {"uid": "1", "folder": "INBOX"}},
        {"source": "gmail", "title": "Invoice 2", "subtitle": "b@x.com",
         "meta": {"uid": "2", "folder": "INBOX"}},
    ]
    r = client.post("/api/items/spinoff", json={"items": items})
    assert r.status_code == 200
    body = r.json()
    assert body.get("session_id")
    assert body.get("count") == 2


def test_spinoff_requires_title_or_items():
    r = client.post("/api/items/spinoff", json={"item": {}})
    assert r.status_code == 200
    assert "error" in r.json() or r.json().get("detail")
```

- [ ] **Step 2: Run it to confirm the bulk test fails**

Run:
```bash
cd /Users/admin/openclaw-workspace
.venv/bin/python -m pytest backend/tests/test_inbox_email_spinoff.py -v
```
Expected: `test_spinoff_bulk_emails_one_session` FAILS (no `count`, bulk path not handled); the single test may pass (existing behavior).

> If `from backend.app import app` is wrong, find the app: `grep -rn "FastAPI(" backend/ | head`. Match the import to the other tests in `backend/tests/` (open one, e.g. `test_inbox_router.py`, and copy its client fixture).

- [ ] **Step 3: Implement the bulk branch in `spinoff`**

In `backend/inbox/__init__.py`, at the **top** of `async def spinoff(payload: dict, request: Request = None):` (line 270), before `item = payload.get("item") or {}`, add:

```python
    items = payload.get("items")
    if isinstance(items, list) and items:
        titles = [(it.get("title") or "").strip() for it in items if (it.get("title") or "").strip()]
        if not titles:
            return _bad("items require titles")
        lines = "\n".join(
            f"- {it.get('title','(no subject)')} — {it.get('subtitle','')}"
            for it in items
        )
        seed = (
            "Context — a batch of emails I handed you from my inbox. "
            "Help me work through them (summaries, drafts, or actions as I ask):\n\n"
            f"{lines}\n\nReply with one short sentence confirming you have the "
            "list; I'll say what to do next."
        )
        sess_name = f"Emails: {len(items)} items — {titles[0][:32]}"
        sess = sessions_store.create_session(name=sess_name)
        await _seed_session(sess["id"], seed)   # use the same seeding call the single path uses
        _log_spinoff(request, {"id": "bulk", "title": sess_name}, sess["id"], deduped=False)
        return {"session_id": sess["id"], "count": len(items)}
```

> **Wire to the real seeding primitives:** open the existing single-item tail of `spinoff` (lines ~300–322) and reuse whatever it calls to (a) create the session and (b) seed it. Replace `sessions_store.create_session(...)` and `_seed_session(...)` above with the exact calls the single path uses (the single path's `sess = ...` and its awaited-seed line). Do **not** invent new helpers — mirror the existing ones.

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
cd /Users/admin/openclaw-workspace
.venv/bin/python -m pytest backend/tests/test_inbox_email_spinoff.py -v
```
Expected: all three PASS.

- [ ] **Step 5: Run the full inbox test suite for regressions**

Run: `.venv/bin/python -m pytest backend/tests/test_inbox_router.py backend/tests/test_inbox_email_spinoff.py -v`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/inbox/__init__.py backend/tests/test_inbox_email_spinoff.py
git commit -m "feat(inbox): spinoff accepts a bulk email list -> one seeded session"
```

---

## SLICE 4 — Retire the Library surface

### Task 15: Remove the Library entry point and route it to the Email tab

**Files:**
- Inspect: find the Library trigger (button + `openEmailLibrary` callers + any `#email=` hash handling)
- Modify: `frontend-overrides/js/emailInbox.js` and/or the override that renders the trigger

- [ ] **Step 1: Find every Library entry point**

Run:
```bash
cd /Users/admin/openclaw-workspace
grep -rn "openEmailLibrary\|email-library\|Library" frontend-overrides/ frontend-vendor/index.html | grep -iv node_modules
```
Expected: the button/menu item that calls `openEmailLibrary`, plus any deep-link/hash handler (`_maybeOpenFromHash` at `emailInbox.js:202` handles `#email=`).

- [ ] **Step 2: Make the Library trigger open the Email tab instead**

For each caller of `openEmailLibrary(opts)`: replace it with a focus of the Email tab (call the same code the rail/sidebar uses to show the Email panel — find it via `grep -n "email" frontend-overrides/js/strip-order.js frontend-overrides/index.html`). If `opts` carries `{folder, uid}`, set `_currentFolder` and call `loadEmails(false)` then `_openInReadingPane`/`_openQuickLook` for that uid.

Concretely, add an exported shim to `emailInbox.js` and point callers at it:

```js
export function openEmailLibrary(opts = {}) {
  // Library is retired — its triage/bulk now lives in the main Email tab.
  if (opts.folder) _currentFolder = opts.folder;
  loadEmails(false).then(() => {
    if (opts.uid) {
      const em = _emails.find((m) => String(m.uid) === String(opts.uid));
      if (em) (triageMode(window.innerWidth) === 'split' ? _openInReadingPane : _openQuickLook)(em);
    }
  });
}
```

- [ ] **Step 3: Stop loading the Library module (optional cleanup)**

If `emailLibrary.js` is imported only for `openEmailLibrary`, redirect that import to the shim. If other exports are still used (search for `import { ... } from './emailLibrary.js'`), leave the module in place but ensure its modal can no longer be opened. Confirm with:
```bash
grep -rn "from './emailLibrary.js'\|from \"/static/js/emailLibrary.js\"\|emailLibrary.js" frontend-overrides/ frontend-vendor/
```

- [ ] **Step 4: Verify parse**

Run: `node --check frontend-overrides/js/emailInbox.js && echo OK`
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add frontend-overrides/
git commit -m "feat(email): retire Library surface — route entry points into the Email tab"
```

---

## SLICE 5 — Integration verification + ship

### Task 16: Build, byte-smoke, and document the deploy

**Files:**
- None modified — verification only

- [ ] **Step 1: Full sync into a scratch build and parse-check every changed file**

Run:
```bash
cd /Users/admin/openclaw-workspace
WORKSPACE_BUILD_DEST=/tmp/fe-smoke ODYSSEUS_STATIC=frontend-vendor bash scripts/sync-frontend.sh
node --check /tmp/fe-smoke/js/emailInbox.js && node --check /tmp/fe-smoke/js/emailLibrary.js && echo BUILD_PARSE_OK
grep -c "EMAIL-TRIAGE-MATH-BEGIN" /tmp/fe-smoke/js/emailInbox.js   # expect 1 (override applied)
grep -c "__AGENT_NAME__" /tmp/fe-smoke/js/emailInbox.js            # expect 0 (token baked)
rm -rf /tmp/fe-smoke
```
Expected: `BUILD_PARSE_OK`, `1`, `0`.

- [ ] **Step 2: Run all node + python tests once more**

Run:
```bash
cd /Users/admin/openclaw-workspace
node scripts/test-swipe-math.mjs && node scripts/test-email-triage-math.mjs
.venv/bin/python -m pytest backend/tests/test_inbox_email_spinoff.py backend/tests/test_email_himalaya.py -v
```
Expected: node tests pass; pytest passes.

- [ ] **Step 3: Write the deploy note (user-gated — do NOT restart unprompted)**

Append to the PR/branch description (and tell the user): the change is live only after a **user-gated** `bash scripts/sync-frontend.sh` + workspace restart. Per host constraints (2014 Mac mini, 4–5 min cold boot), the user runs the restart. After deploy, the **user eyeballs** on the `:8443` origin (no headless Chrome): hover-select + bulk archive, desktop reading pane, mobile quick-look prev/next, per-row quick actions, move menu, hand-to-agent (single + bulk).

- [ ] **Step 4: Final commit (if any verification tweaks were needed)**

```bash
git add -A && git commit -m "chore(email): integration verification for triage redesign" || echo "clean"
```

---

## Self-Review

**Spec coverage:**
- Surface/architecture (overrides, retire Library) → Tasks 1, 15.
- Reading pane (desktop) → Tasks 4, 5. Quick-look (mobile) + prev/next + swipe-close → Task 6.
- Hover/long-press multi-select + bulk bar → Tasks 7, 8.
- Per-row quick actions → Task 13.
- Verbs: Archive/Delete/Mark-read·unread/Move/Hand-to-agent → Tasks 9 (single), 11 (bulk), 12 (move + agent), 13 (row), 14 (bulk-agent backend).
- Client fan-out + concurrency + partial-failure surfacing → Tasks 10, 11.
- Combined undo (reversible verbs; delete = confirm) → Tasks 9, 11 (decision noted in Reference facts).
- HTML safety (sanitizer + sandbox fallback) → Tasks 5, 6.
- Reduced-motion → existing transitions are CSS; no JS animation added that ignores it (CSS transitions are short; acceptable per spec). Empty/error states reuse existing `email-loading`.
- Tests: pure-logic node test (Task 2), backend pytest (Task 14), manual smoke (Task 16).
- Rollout/risk (user-gated sync+restart, :8443 eyeball) → Task 16.

**Placeholder scan:** No "TBD"/"handle edge cases" left as code. The two places that require the engineer to inspect the live tree (toast API in Task 9; exact session-seeding calls in Task 14; email-section DOM in Task 4) are written as explicit `grep`/`sed` discovery steps with a concrete fallback, not vague hand-waves — these are genuine "follow the existing pattern" lookups, not deferred decisions.

**Type/name consistency:** `triageMode`, `toggleInSet`, `allSelected`, `nextIndex`, `chunk`, `summarizeBulk` are defined in Task 2 and referenced verbatim in Tasks 5/6/7/8/10/11/12/15. `_emailState._selectedUids` (the shared `state._selectedUids` Set) is used consistently. `_emailUidAction`/`_runBulk`/`_removeRow`/`_toast`/`_clearReadingPane`/`_archiveFolderName`/`_openMoveMenu`/`_handEmailsToAgent`/`_updateEmailBulkBar`/`_clearEmailSelection`/`_bulkAction`/`_openInReadingPane`/`_openQuickLook`/`_quickLookStep` are each defined once and called by their exact names. Stub-then-implement order is called out where a later task defines a symbol an earlier task references.
