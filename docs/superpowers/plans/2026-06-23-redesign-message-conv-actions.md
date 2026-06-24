# Redesign Conv-Row Menu + Message Toolbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-conversation context menu (Rename, Favorite, Copy chat, Archive, Delete) to the redesign sidebar, and a per-message hover toolbar (Copy, Download), all frontend-only.

**Architecture:** The redesign renders HTML strings from a `state` object and re-renders on change; events are delegated in `app.js` via `e.target.closest('[data-act]')` → `actions[name](dataArg, event)`. We add render output in `surfaces.js`, handlers in `live/chat.js`, icons in `icons.js`, menu-close wiring in `app.js`, and styles in `redesign.css`. All four needed endpoints already exist (`PATCH /api/session/{id}`, `POST /api/session/{id}/important`, `POST /api/session/{id}/archive`, `DELETE /api/session/{id}`); Copy/Download are client-side.

**Tech Stack:** Vanilla ES modules, Node's built-in `node:test` runner, no build step. Tests assert on HTML strings returned by pure renderers (the established pattern in `js/__tests__/chat-activity-render.test.js`).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-23-redesign-message-actions-design.md`.
- **Frontend-only.** No backend or gateway changes. Do NOT add or call `truncate`, `delete-messages`, `edit-message`, or `/api/rewrite` — they do not exist here. Message edit/delete/regenerate/rewrite/resend are explicitly **out of scope**.
- **Conv-menu items (exactly 5):** Rename, Favorite/Unfavorite, Copy chat, Archive, Delete. Do NOT add "Move to folder" or "Select".
- **Visual tokens (verbatim, from `redesign.css`):** `--elev:#262931`, `--bd:#2d2f36`, `--fg:#dfe2e8`, `--mut:#9498a2`, `--faint:#5f636d`, `--row-hover:#1d1f24`, `--red:#f0726a`, `--gold:#e8c268`, `--sans` (IBM Plex Sans). `--gold` is used ONLY for the favorite star. `--red` is used ONLY for the Delete item. No new type families, no new palette entries.
- **Copy register:** sentence case, active verbs. Item labels: `Rename`, `Favorite`/`Unfavorite`, `Copy chat`, `Archive`, `Delete`. Tooltips: `Copy message`, `Download message`, `Conversation actions`.
- **Quality floor:** all triggers are real `<button>`s with `title`/`aria-label`; toolbar reveals on `:hover` AND `:focus-within`; menus close on outside-click and Escape; `prefers-reduced-motion` removes motion.
- **Import-safety reality:** `surfaces.js` and `icons.js` import cleanly in Node (unit-testable). `live/chat.js` and `app.js` are NOT import-safe (`api.js` reads `location.origin` at module load). Per the existing codebase, runtime handlers and CSS are verified manually, not via `node:test`.
- **Run a single test file:** `cd /home/frank/openclaw-workspace && node --test frontend-overrides/js/__tests__/<file>.test.js`
- **Run all redesign tests:** `cd /home/frank/openclaw-workspace && node --test frontend-overrides/js/__tests__/`

---

### Task 1: Add icons (copy, download, star, dots)

**Files:**
- Modify: `frontend-overrides/js/redesign/icons.js` (the `export const I = { ... }` object)
- Test: `frontend-overrides/js/__tests__/redesign-icons.test.js` (create)

**Interfaces:**
- Produces: `I.copy(size?)`, `I.download(size?)`, `I.star(size?, filled?)`, `I.dots(size?)` — each returns an `<svg>` string. `I.star(s, true)` returns an svg with `fill="currentColor"`; `I.star(s)`/`I.star(s, false)` returns `fill="none"`.

- [ ] **Step 1: Write the failing test**

Create `frontend-overrides/js/__tests__/redesign-icons.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { I } from '../redesign/icons.js';

test('copy and download icons return svg strings', () => {
  assert.match(I.copy(), /<svg[\s\S]*<\/svg>/);
  assert.match(I.download(), /<svg[\s\S]*<\/svg>/);
});

test('dots icon returns an svg', () => {
  assert.match(I.dots(), /<svg[\s\S]*<\/svg>/);
});

test('star is hollow by default and filled when requested', () => {
  assert.match(I.star(13, false), /fill="none"/);
  assert.match(I.star(13, true), /fill="currentColor"/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/frank/openclaw-workspace && node --test frontend-overrides/js/__tests__/redesign-icons.test.js`
Expected: FAIL — `I.copy is not a function` (and siblings).

- [ ] **Step 3: Add the icons**

In `frontend-overrides/js/redesign/icons.js`, inside the `export const I = {` object (e.g. right after the `x:` entry), add:

```js
  copy: (s = 15) => icon('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>', { size: s, sw: 1.8 }),
  download: (s = 15) => icon('<path d="M12 3v12M7 11l5 5 5-5M4 21h16"/>', { size: s, sw: 1.8 }),
  star: (s = 13, filled = false) => icon('<path d="M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 18l-5.8 3.1 1.1-6.5L2.6 9.4l6.5-.9z"/>', { size: s, sw: 1.5, fill: filled ? 'currentColor' : 'none' }),
  dots: (s = 15) => icon('<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>', { size: s, sw: 1.6, fill: 'currentColor' }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/frank/openclaw-workspace && node --test frontend-overrides/js/__tests__/redesign-icons.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/frank/openclaw-workspace
git add frontend-overrides/js/redesign/icons.js frontend-overrides/js/__tests__/redesign-icons.test.js
git commit -m "Redesign icons: add copy, download, star, dots"
```

---

### Task 2: Conversation-row kebab + favorite star + inline menu

**Files:**
- Modify: `frontend-overrides/js/redesign/surfaces.js` — `convListBody(s)` (the `convRow` arrow) + add a module-level `convMenu(r)` helper
- Test: `frontend-overrides/js/__tests__/redesign-conv-menu.test.js` (create)

**Interfaces:**
- Consumes: `I.star`, `I.dots` (Task 1); `s.live.chat.rowMenuOpen` (the id of the row whose menu is open, or null/undefined) and `r.important` (boolean) on each row.
- Produces: rows that emit `data-act="toggleConvMenu" data-arg="{id}"` (kebab) and, when `rowMenuOpen === r.id`, a `.conv-menu` containing `data-act` items `renameSession`, `toggleFavorite`, `copyTranscript`, `archiveSession`, `deleteSession` (each with `data-arg="{id}"`). The menu wrapper carries `data-act="noop"`. Favorite item label is `Unfavorite` when `r.important` else `Favorite`. The `.conv-menu` and Delete item use classes `conv-menu` and `cm-item cm-danger`.

- [ ] **Step 1: Write the failing test**

Create `frontend-overrides/js/__tests__/redesign-conv-menu.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { renderChatList } from '../redesign/surfaces.js';

const baseState = (over = {}) => ({
  convFilter: '', convSort: 'recent',
  live: { chat: {
    cwd: '/x', rowMenuOpen: null,
    groups: [{ label: 'TODAY', rows: [
      { id: 's1', title: 'Plain chat', active: true, important: false },
      { id: 's2', title: 'Pinned chat', important: true },
    ] }],
    ...over,
  } },
});

test('each row renders a kebab that toggles its menu', () => {
  const html = renderChatList(baseState());
  assert.match(html, /class="conv-kebab"[^>]*data-act="toggleConvMenu" data-arg="s1"/);
  assert.match(html, /data-act="toggleConvMenu" data-arg="s2"/);
});

test('a favorited row shows the gold star, an unfavorited row does not', () => {
  const html = renderChatList(baseState());
  // s2 (important) has the star wrapper; s1 does not.
  assert.match(html, /class="conv-fav"/);
  assert.equal((html.match(/class="conv-fav"/g) || []).length, 1);
});

test('no menu renders until rowMenuOpen matches a row', () => {
  assert.doesNotMatch(renderChatList(baseState()), /class="conv-menu"/);
});

test('open menu renders all five items with the row id', () => {
  const html = renderChatList(baseState({ rowMenuOpen: 's1' }));
  assert.match(html, /class="conv-menu" data-act="noop"/);
  assert.match(html, /data-act="renameSession" data-arg="s1"/);
  assert.match(html, /data-act="toggleFavorite" data-arg="s1"/);
  assert.match(html, /data-act="copyTranscript" data-arg="s1"/);
  assert.match(html, /data-act="archiveSession" data-arg="s1"/);
  assert.match(html, /cm-danger" data-act="deleteSession" data-arg="s1"/);
});

test('favorite label reflects the row state', () => {
  assert.match(renderChatList(baseState({ rowMenuOpen: 's1' })), /data-act="toggleFavorite"[^>]*>Favorite</);
  assert.match(renderChatList(baseState({ rowMenuOpen: 's2' })), /data-act="toggleFavorite"[^>]*>Unfavorite</);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/frank/openclaw-workspace && node --test frontend-overrides/js/__tests__/redesign-conv-menu.test.js`
Expected: FAIL — current rows emit `conv-arch`/`conv-del`, not `conv-kebab`/`conv-menu`.

- [ ] **Step 3: Add the `convMenu` helper**

In `frontend-overrides/js/redesign/surfaces.js`, add a module-level helper just above `function convListBody(s) {`:

```js
// Per-row conversation actions menu (5 items). Rendered inline when this row's
// menu is open. The wrapper's data-act="noop" swallows clicks on menu chrome so
// they neither select the row nor close the menu.
function convMenu(r) {
  const fav = r.important ? 'Unfavorite' : 'Favorite';
  return `<div class="conv-menu" data-act="noop" role="menu">`
    + `<button class="cm-item" data-act="renameSession" data-arg="${esc(r.id)}" role="menuitem">Rename</button>`
    + `<button class="cm-item" data-act="toggleFavorite" data-arg="${esc(r.id)}" role="menuitem">${fav}</button>`
    + `<button class="cm-item" data-act="copyTranscript" data-arg="${esc(r.id)}" role="menuitem">Copy chat</button>`
    + `<button class="cm-item" data-act="archiveSession" data-arg="${esc(r.id)}" role="menuitem">Archive</button>`
    + `<button class="cm-item cm-danger" data-act="deleteSession" data-arg="${esc(r.id)}" role="menuitem">Delete</button>`
    + `</div>`;
}
```

- [ ] **Step 4: Replace the `convRow` arrow inside `convListBody`**

In `convListBody(s)`, replace the existing `const convRow = (r) => ...;` line (the one that emits `conv-arch` and `conv-del`) with:

```js
  const rowMenuOpen = s.live?.chat?.rowMenuOpen;
  const convRow = (r) => `<div class="conv-row${r.active ? ' active' : ' ocrow'}${rowMenuOpen === r.id ? ' menu-open' : ''}" data-act="selectSession" data-arg="${esc(r.id)}">`
    + `<span class="conv-badge${r.term ? ' term' : ''}">${r.term ? '∿' : 'A\\'}</span>`
    + `<span class="conv-title">${esc(r.title)}</span>`
    + (r.important ? `<span class="conv-fav" aria-hidden="true">${I.star(13, true)}</span>` : '')
    + `<button class="conv-kebab" data-act="toggleConvMenu" data-arg="${esc(r.id)}" title="Conversation actions" aria-label="Conversation actions">${I.dots(15)}</button>`
    + (rowMenuOpen === r.id ? convMenu(r) : '')
    + `</div>`;
```

Note: keep the badge fallback exactly as `'A\\'` (matches the original template — inside the literal it renders as `A\`).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /home/frank/openclaw-workspace && node --test frontend-overrides/js/__tests__/redesign-conv-menu.test.js`
Expected: PASS (5 tests).

- [ ] **Step 6: Run the full redesign test suite (no regressions)**

Run: `cd /home/frank/openclaw-workspace && node --test frontend-overrides/js/__tests__/`
Expected: PASS (all files).

- [ ] **Step 7: Commit**

```bash
cd /home/frank/openclaw-workspace
git add frontend-overrides/js/redesign/surfaces.js frontend-overrides/js/__tests__/redesign-conv-menu.test.js
git commit -m "Redesign sidebar: per-row kebab menu + favorite star"
```

---

### Task 3: Per-message hover toolbar

**Files:**
- Modify: `frontend-overrides/js/redesign/surfaces.js` — `export` `chatMsg`, add module-level `msgTools(m)`, insert the toolbar into both message branches
- Test: `frontend-overrides/js/__tests__/redesign-msg-tools.test.js` (create)

**Interfaces:**
- Consumes: `I.copy`, `I.download` (Task 1); each thread message has a stable `id`.
- Produces: `export function chatMsg(m, s)`. When the message has non-empty text (and, for assistant, no error), the output contains `<div class="msg-tools">` with buttons `data-act="copyMessage" data-arg="{m.id}"` and `data-act="downloadMessage" data-arg="{m.id}"`. Empty/error assistant turns render no `.msg-tools`.

- [ ] **Step 1: Write the failing test**

Create `frontend-overrides/js/__tests__/redesign-msg-tools.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { chatMsg } from '../redesign/surfaces.js';

const ui = { chatUI: { trail: {}, step: {}, group: {} } };

test('user message gets a copy + download toolbar bound to its id', () => {
  const html = chatMsg({ id: 'u1', role: 'user', text: 'hi there', time: '09:00' }, ui);
  assert.match(html, /class="msg-tools"/);
  assert.match(html, /data-act="copyMessage" data-arg="u1"/);
  assert.match(html, /data-act="downloadMessage" data-arg="u1"/);
});

test('assistant message with text gets the toolbar', () => {
  const html = chatMsg({ id: 'a1', role: 'assistant', text: 'sure', time: '09:01', model: 'opus' }, ui);
  assert.match(html, /data-act="copyMessage" data-arg="a1"/);
  assert.match(html, /data-act="downloadMessage" data-arg="a1"/);
});

test('empty / error assistant turn renders no toolbar', () => {
  const html = chatMsg({ id: 'a2', role: 'assistant', text: '', error: true, notice: 'No response from this model.' }, ui);
  assert.doesNotMatch(html, /class="msg-tools"/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/frank/openclaw-workspace && node --test frontend-overrides/js/__tests__/redesign-msg-tools.test.js`
Expected: FAIL — `chatMsg` is not exported (import is `undefined`).

- [ ] **Step 3: Add the `msgTools` helper**

In `frontend-overrides/js/redesign/surfaces.js`, add a module-level helper just above `function chatMsg(m, s) {`:

```js
// Per-message hover toolbar: client-side Copy + Download, bound to the message id.
function msgTools(m) {
  return `<div class="msg-tools">`
    + `<button class="msg-tool" data-act="copyMessage" data-arg="${esc(m.id)}" title="Copy message" aria-label="Copy message">${I.copy(15)}</button>`
    + `<button class="msg-tool" data-act="downloadMessage" data-arg="${esc(m.id)}" title="Download message" aria-label="Download message">${I.download(15)}</button>`
    + `</div>`;
}
```

- [ ] **Step 4: Export `chatMsg` and insert the toolbar**

Change the signature line `function chatMsg(m, s) {` to `export function chatMsg(m, s) {`.

In the **user** branch, replace its `return` with (adds the toolbar inside the wrap, after the bubble, only when there is text):

```js
  if (m.role === 'user') {
    return `<div class="msg-user-wrap"><div class="msg-user"><div class="meta"><span class="time">${esc(m.time || '')}</span><span class="you">You</span></div>${paras || '<p></p>'}</div>${hasText ? msgTools(m) : ''}</div>`;
  }
```

In the **assistant** branch, change the final `return` so the toolbar is appended inside `.msg-body` after `${notice}` (only when there is text and no error):

```js
  return `<div class="msg-asst"><div class="msg-av"><img src="${AVATAR}" alt="Gary"></div><div class="msg-body"><div class="msg-meta"><span class="name">Gary</span>${m.model ? `<span class="model">${esc(m.model)}</span>` : ''}<span class="time">${esc(m.time || '')}</span></div>${renderActivity(m, s)}${paras}${notice}${hasText && !m.error ? msgTools(m) : ''}</div></div>`;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /home/frank/openclaw-workspace && node --test frontend-overrides/js/__tests__/redesign-msg-tools.test.js`
Expected: PASS (3 tests).

- [ ] **Step 6: Run the full redesign test suite (no regressions)**

Run: `cd /home/frank/openclaw-workspace && node --test frontend-overrides/js/__tests__/`
Expected: PASS (all files).

- [ ] **Step 7: Commit**

```bash
cd /home/frank/openclaw-workspace
git add frontend-overrides/js/redesign/surfaces.js frontend-overrides/js/__tests__/redesign-msg-tools.test.js
git commit -m "Redesign chat: per-message hover toolbar (copy, download)"
```

---

### Task 4: Live handlers (favorite, menu toggle, copy/download message) + data plumbing

**Files:**
- Modify: `frontend-overrides/js/redesign/live/chat.js` — `buildGroups` (add `important`), `send` (add id to the optimistic user message), and the `actions` object (generalize `renameSession`/`copyTranscript`; add `toggleConvMenu`, `toggleFavorite`, `copyMessage`, `downloadMessage`, `noop`)

**Interfaces:**
- Consumes: rows render `data-act` names from Tasks 2–3; `apiForm(path, fields, {method})` (default POST multipart), `apiGet`, `apiDelete`, `load(state)`, `ensureChat`, `runtime.state`, `runtime.render` (all already imported/defined in this file).
- Produces: `actions.toggleConvMenu(id)`, `actions.toggleFavorite(id)`, `actions.copyMessage(id)`, `actions.downloadMessage(id)`, `actions.noop()`; `renameSession(id)` and `copyTranscript(id)` accept an optional id (fall back to the active session). `buildGroups` rows include `important: !!s.important`.

> **Verification note:** `live/chat.js` is not Node-importable (`api.js` reads `location.origin` at load). There is no unit test for this task — it is verified manually in Task 7 (after CSS lands). Write the exact code below; do not invent endpoints.

- [ ] **Step 1: Add `important` to `buildGroups` rows**

In `buildGroups`, the row object currently is roughly `{ id: s.id, title: s.name || 'New chat', term: ..., active: s.id === activeId }`. Add the `important` field:

```js
      important: !!s.important,
```

(Place it alongside the other row fields in the same object literal.)

- [ ] **Step 2: Give the optimistic user message an id**

In `send`, find `chat.thread.push({ role: 'user', text, time: fmtTime(Date.now()) });` and change it to:

```js
    chat.thread.push({ id: 'live-u-' + Date.now(), role: 'user', text, time: fmtTime(Date.now()) });
```

- [ ] **Step 3: Generalize `renameSession` to accept an id**

Replace the existing `renameSession` handler with:

```js
  renameSession: async (id) => {
    const state = runtime.state;
    if (!state) return;
    const chat = ensureChat(state);
    state.chatMenuOpen = false;
    chat.rowMenuOpen = null;
    const target = id || chat.activeId;
    if (!target) { runtime.render(); return; }
    let cur = chat.title || '';
    if (target !== chat.activeId) {
      const rows = (chat.groups || []).flatMap((g) => g.rows || []);
      cur = (rows.find((r) => r.id === target) || {}).title || '';
    }
    let name = null;
    try { name = window.prompt('Rename conversation', cur); } catch (_) { name = null; }
    if (name == null) { runtime.render(); return; }
    name = name.trim();
    if (!name) { runtime.render(); return; }
    if (target === chat.activeId) chat.title = name;
    runtime.render();
    try { await apiForm(`/api/session/${target}`, { name }, { method: 'PATCH' }); } catch (_) {}
    try { await load(state); } catch (_) {}
    runtime.render();
  },
```

- [ ] **Step 4: Generalize `copyTranscript` to accept an id**

Replace the existing `copyTranscript` handler with:

```js
  copyTranscript: async (id) => {
    const state = runtime.state;
    if (!state) return;
    const chat = ensureChat(state);
    state.chatMenuOpen = false;
    chat.rowMenuOpen = null;
    let thread = chat.thread || [];
    if (id && id !== chat.activeId) {
      try {
        const hist = await apiGet(`/api/history/${id}?limit=200`);
        const list = Array.isArray(hist?.history) ? hist.history : [];
        thread = list.map((h) => ({ role: h.role === 'user' ? 'user' : 'assistant', text: h.content || '' }));
      } catch (_) { thread = []; }
    }
    const text = thread.map((m) => `${m.role === 'user' ? 'You' : 'Gary'}: ${m.text || ''}`).join('\n\n');
    try { await navigator.clipboard.writeText(text); } catch (_) {}
    runtime.render();
  },
```

- [ ] **Step 5: Add the new handlers**

Add these entries to the `actions` object (e.g. next to `archiveSession`/`deleteSession`):

```js
  // Sidebar: open/close a single row's actions menu.
  toggleConvMenu: (id) => {
    const state = runtime.state;
    if (!state || !id) return;
    const chat = ensureChat(state);
    chat.rowMenuOpen = chat.rowMenuOpen === id ? null : id;
    state.chatMenuOpen = false;
    runtime.render();
  },

  // Sidebar: toggle a conversation's favorite flag → POST /api/session/{id}/important.
  toggleFavorite: async (id) => {
    const state = runtime.state;
    if (!state || !id) return;
    const chat = ensureChat(state);
    chat.rowMenuOpen = null;
    const rows = (chat.groups || []).flatMap((g) => g.rows || []);
    const row = rows.find((r) => r.id === id);
    const next = !(row && row.important);
    if (row) row.important = next; // optimistic
    runtime.render();
    try { await apiForm(`/api/session/${id}/important`, { important: String(next) }); } catch (_) {}
    try { await load(state); } catch (_) {}
    runtime.render();
  },

  // Message toolbar: copy one message's text to the clipboard.
  copyMessage: async (id) => {
    const state = runtime.state;
    if (!state || !id) return;
    const chat = ensureChat(state);
    const msg = (chat.thread || []).find((m) => m.id === id);
    if (!msg || !msg.text) return;
    try { await navigator.clipboard.writeText(msg.text); } catch (_) {}
  },

  // Message toolbar: download one message's text as a .md file (client-side).
  downloadMessage: (id) => {
    const state = runtime.state;
    if (!state || !id) return;
    const chat = ensureChat(state);
    const msg = (chat.thread || []).find((m) => m.id === id);
    if (!msg || !msg.text) return;
    const who = msg.role === 'user' ? 'you' : 'gary';
    const slug = (msg.text.split('\n')[0] || 'message').slice(0, 40).replace(/[^\w.-]+/g, '_');
    try {
      const blob = new Blob([msg.text], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${who}-${slug}.md`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 1000);
    } catch (_) {}
  },

  // Swallow clicks on menu chrome so they neither select the row nor close the menu.
  noop: () => {},
```

- [ ] **Step 6: Syntax-check the module**

Run: `cd /home/frank/openclaw-workspace && node --check frontend-overrides/js/redesign/live/chat.js`
Expected: no output (exit 0). (This validates syntax without executing the browser-only top level.)

- [ ] **Step 7: Commit**

```bash
cd /home/frank/openclaw-workspace
git add frontend-overrides/js/redesign/live/chat.js
git commit -m "Redesign live: favorite, row-menu toggle, copy/download message handlers"
```

---

### Task 5: Menu close — outside-click + Escape

**Files:**
- Modify: `frontend-overrides/js/redesign/app.js` — the `root.addEventListener('click', ...)` delegation, and the global `document.addEventListener('keydown', ...)` handler

**Interfaces:**
- Consumes: `state`, `render` (both in scope in `app.js`); `state.live.chat.rowMenuOpen`, `state.chatMenuOpen`, `state.modelMenuOpen`.
- Produces: clicking outside any `[data-act]` element closes all open menus; pressing Escape closes them.

> **Verification note:** `app.js` is the browser entry (not Node-importable). Verified manually in Task 7. Use `node --check` for syntax only.

- [ ] **Step 1: Close menus on outside-click**

In the click delegation handler, replace the early `if (!t) return;` guard with:

```js
  const t = e.target.closest('[data-act]');
  if (!t) {
    // A click outside any actionable element dismisses open menus.
    if (state.chatMenuOpen || state.modelMenuOpen || state.live?.chat?.rowMenuOpen) {
      state.chatMenuOpen = false;
      state.modelMenuOpen = false;
      if (state.live?.chat) state.live.chat.rowMenuOpen = null;
      render();
    }
    return;
  }
```

- [ ] **Step 2: Close menus on Escape**

In the global `document.addEventListener('keydown', (e) => {` handler, add this branch at the top of the callback (before the ⌘K branch):

```js
  if (e.key === 'Escape') {
    if (state.chatMenuOpen || state.modelMenuOpen || state.live?.chat?.rowMenuOpen) {
      state.chatMenuOpen = false;
      state.modelMenuOpen = false;
      if (state.live?.chat) state.live.chat.rowMenuOpen = null;
      render();
      return;
    }
  }
```

- [ ] **Step 3: Syntax-check the module**

Run: `cd /home/frank/openclaw-workspace && node --check frontend-overrides/js/redesign/app.js`
Expected: no output (exit 0).

- [ ] **Step 4: Commit**

```bash
cd /home/frank/openclaw-workspace
git add frontend-overrides/js/redesign/app.js
git commit -m "Redesign: dismiss menus on outside-click and Escape"
```

---

### Task 6: Styles (conv menu, kebab, favorite star, message toolbar)

**Files:**
- Modify: `frontend-overrides/redesign.css` (append a clearly-commented block)

**Interfaces:**
- Consumes: classes emitted in Tasks 2–3 (`conv-kebab`, `conv-fav`, `conv-menu`, `cm-item`, `cm-danger`, `menu-open`, `msg-tools`, `msg-tool`) and the existing tokens.

> **Verification note:** CSS is verified visually in Task 7.

- [ ] **Step 1: Append the styles**

Add to the end of `frontend-overrides/redesign.css`:

```css
/* ── conversation-row actions: kebab + favorite star + menu ───────────────── */
.conv-row{position:relative}
.conv-fav{flex:none;display:inline-flex;align-items:center;color:var(--gold)}
.conv-kebab{margin-left:auto;flex:none;width:24px;height:24px;display:flex;align-items:center;justify-content:center;padding:0;border:none;background:transparent;color:var(--faint);border-radius:7px;cursor:pointer;opacity:0;transition:opacity .12s,color .12s,background .12s}
.conv-row:hover .conv-kebab,.conv-row.active .conv-kebab,.conv-row.menu-open .conv-kebab{opacity:1}
.conv-kebab:hover{color:var(--mut);background:var(--row-hover)}
.conv-fav + .conv-kebab{margin-left:6px}
.conv-menu{position:absolute;right:8px;top:34px;z-index:40;min-width:160px;display:flex;flex-direction:column;background:var(--elev);border:1px solid var(--bd);border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.5);padding:6px}
.cm-item{display:block;width:100%;text-align:left;font:13px/1.1 var(--sans);color:var(--mut);background:transparent;border:none;padding:8px 10px;border-radius:7px;cursor:pointer}
.cm-item:hover{background:var(--row-hover);color:var(--fg)}
.cm-danger:hover{background:rgba(240,114,106,.12);color:var(--red)}

/* ── per-message hover toolbar ────────────────────────────────────────────── */
.msg-tools{display:flex;gap:2px;margin-top:6px;opacity:0;transform:translateY(2px);transition:opacity .12s,transform .12s}
.msg-asst:hover .msg-tools,.msg-asst:focus-within .msg-tools,.msg-user-wrap:hover .msg-tools,.msg-user-wrap:focus-within .msg-tools{opacity:1;transform:none}
.msg-user-wrap .msg-tools{justify-content:flex-end}
.msg-tool{width:26px;height:26px;display:flex;align-items:center;justify-content:center;padding:0;border:none;background:transparent;color:var(--faint);border-radius:7px;cursor:pointer}
.msg-tool:hover{color:var(--fg);background:var(--row-hover)}

@media (prefers-reduced-motion:reduce){
  .msg-tools{transition:none;transform:none}
  .conv-kebab{transition:none}
}
```

- [ ] **Step 2: Commit**

```bash
cd /home/frank/openclaw-workspace
git add frontend-overrides/redesign.css
git commit -m "Redesign styles: conv-row menu, favorite star, message toolbar"
```

---

### Task 7: Manual verification (full feature)

**Files:** none (verification only).

This task validates the runtime/CSS pieces that have no Node unit test, per the codebase's testing reality.

- [ ] **Step 1: Confirm all unit tests pass**

Run: `cd /home/frank/openclaw-workspace && node --test frontend-overrides/js/__tests__/`
Expected: PASS — all files including `redesign-icons`, `redesign-conv-menu`, `redesign-msg-tools`.

- [ ] **Step 2: Launch the redesign and verify the sidebar menu**

Use the project's run path (see the `run` skill / `README.md`) to serve the app, open the redesign (`/index-redesign.html` route), then with a session list present:
- Hover a conversation row → the `⋯` kebab fades in; archive/✕ icons are gone from the row.
- Click the kebab → menu opens with exactly: Rename, Favorite, Copy chat, Archive, Delete (Delete reddens on hover).
- Rename → prompt prefilled with the current title; saving updates the row.
- Favorite → menu label becomes Unfavorite, a gold star appears on the row; re-open → Unfavorite removes it. Reload the page → favorite state persists (confirms `/important` round-trip).
- Copy chat → clipboard holds the transcript (test from a non-active row too).
- Archive and Delete behave as before (Delete confirm-guarded).
- Open a menu, click elsewhere → it closes; open again, press Escape → it closes.

- [ ] **Step 3: Verify the message toolbar**

In an open conversation with at least one user and one assistant message:
- Hover a message → Copy + Download fade in (left under Gary, right under your bubble).
- Copy → message text on clipboard. Download → a `.md` file downloads with that message's text.
- Tab to the buttons with the keyboard → toolbar reveals on focus; buttons show focus outline.
- An empty/error assistant turn shows no toolbar.

- [ ] **Step 4: Confirm scope boundaries**

- No "Move to folder" or "Select" item appears.
- No message edit/delete/regenerate/rewrite/resend UI was added.

- [ ] **Step 5: Final commit (if any verification fixes were needed)**

```bash
cd /home/frank/openclaw-workspace
git add -A
git commit -m "Redesign message/conv actions: verification fixes"
```

(If no fixes were needed, skip this commit.)

---

## Self-Review

**Spec coverage:**
- Conv-row menu (5 items) → Tasks 2 (render) + 4 (handlers). Rename/Copy chat generalized, Favorite new, Archive/Delete reused. ✓
- Favorite star (`--gold`, only accent) → Tasks 2 (render) + 6 (style). ✓
- Kebab replaces always-on archive/✕ icons → Task 2 (the replaced `convRow` no longer emits `conv-arch`/`conv-del`). ✓
- Message hover toolbar (Copy, Download) → Tasks 3 (render) + 4 (handlers) + 6 (style). ✓
- Message id plumbing (so Copy/Download resolve) → Task 4 Step 2 (live user id) + reuse of existing history/live ids. ✓
- `important` on rows → Task 4 Step 1. ✓
- Outside-click + Escape close → Task 5. ✓
- Deferred message-mutation actions → enforced by Global Constraints; verified absent in Task 7 Step 4. ✓
- Accessibility (buttons, focus-within, reduced motion) → Tasks 2/3 (buttons + aria) + 6 (CSS). ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every command has expected output. ✓

**Type/name consistency:** action names match between render (`data-act="…"` in Tasks 2–3) and handlers (Task 4): `toggleConvMenu`, `toggleFavorite`, `renameSession`, `copyTranscript`, `archiveSession`, `deleteSession`, `copyMessage`, `downloadMessage`, `noop`. State key `rowMenuOpen` consistent across Tasks 2/4/5. Classes consistent across Tasks 2/3/6. ✓
