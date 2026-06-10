# Hermes UI Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adopt the Hermes WebUI visual style across openclaw-workspace: 4 Hermes theme presets (Charcoal default), sans-UI/mono-code typography, component skin, full Hermes sidebar (icon strip, date-grouped history, footer model block), a new read-only right-hand WORKSPACE file explorer, and a chat fidelity pass.

**Architecture:** All frontend work in `frontend-overrides/` (the only durable frontend source), baked by `scripts/sync-frontend.sh`. One new backend module (`backend/workspace_files.py`, read-only GET routes). Hermes values are copied into our own files — no runtime dependency on hermes-webui.

**Tech Stack:** Vanilla ES6 modules + CSS custom properties (frontend), FastAPI + pytest (backend). Spec: `docs/superpowers/specs/2026-06-10-hermes-ui-adoption-design.md`. Reference: github.com/nesquena/hermes-webui @ `e8d71a2` (MIT) — clone to `/tmp/hermes-webui` if visual cross-checks are needed.

**Ground rules (apply to every task):**
- Never edit `frontend/` directly — it is gitignored build output. Edit `frontend-overrides/`, then build with `scripts/sync-frontend.sh`.
- `bash scripts/sync-frontend.sh` writes to the live-served `frontend/` (static files are read per request — frontend changes go live WITHOUT a backend restart). To build without touching the live UI: `WORKSPACE_BUILD_DEST=/tmp/hermes-build bash scripts/sync-frontend.sh`.
- Do NOT restart the LaunchAgent/uvicorn during this project. The single restart that activates the Phase 3 backend happens once, at the very end, user-approved (2014 Mac mini: cold restarts take minutes; see Task 16).
- Mark every new/changed block in shared override files with a `/* HERMES: ... */` or `// HERMES: ...` comment so future upstream re-merges can find them.
- Visible user-facing text in overrides must use the `__AGENT_NAME__` token, never a literal name.
- Commit after each task. Run `python3 -m pytest backend/tests -q` before each commit that touches `backend/` (suite must stay green; ~195 tests).

---

## Phase 1 — Tokens, themes, typography

### Task 1: Add the four Hermes theme presets and flip defaults

**Files:**
- Modify: `frontend-overrides/js/theme.js` (THEMES map ~line 10–31, `DEFAULT_THEME` line 33, `DEFAULT_FONT` line 42)

- [ ] **Step 1: Add the presets to `THEMES`**

In `frontend-overrides/js/theme.js`, after the `cute:` entry (last entry, ~line 31), add inside the `THEMES` object:

```js
  // HERMES: Hermes WebUI colorways (spec 2026-06-10-hermes-ui-adoption-design.md)
  hermesCharcoal: { bg:'#1e1f22', fg:'#d7dae0', panel:'#17181b', border:'#33353a', red:'#e8c268',
                advanced: { sidebarBg:'#17181b', inputBg:'#26282c', inputBorder:'#3a3d42',
                            userBubbleBg:'#26282c', aiBubbleBg:'#1a1b1e', bubbleBorder:'#2e3035',
                            codeBg:'#141518', codeFg:'#d7dae0',
                            sendBtnBg:'#e8c268', sendBtnHover:'#d4af50',
                            accentPrimary:'#4dd0e1', accentError:'#ef5350',
                            sectionAccent:'#e8c268', toggleActive:'#e8c268' } },
  hermesLight: { bg:'#fefcf7', fg:'#1a1610', panel:'#faf7f0', border:'#e0d8c8', red:'#b8860b',
                advanced: { sidebarBg:'#faf7f0', inputBg:'#ffffff', inputBorder:'#e0d8c8',
                            userBubbleBg:'#f3eee3', aiBubbleBg:'#fefcf7', bubbleBorder:'#e0d8c8',
                            codeBg:'#f5f0e5', codeFg:'#1a1610',
                            sendBtnBg:'#b8860b', sendBtnHover:'#996f08',
                            accentPrimary:'#0288a8', accentError:'#c62828' } },
  hermesSolarizedDark: { bg:'#0a252e', fg:'#9cc7c2', panel:'#08303a', border:'#1b4651', red:'#6fd3a6',
                advanced: { sidebarBg:'#08303a', inputBg:'#0e323d', inputBorder:'#1b4651',
                            userBubbleBg:'#0e323d', aiBubbleBg:'#0a2a34', bubbleBorder:'#16404c',
                            codeBg:'#07212a', codeFg:'#9cc7c2',
                            sendBtnBg:'#6fd3a6', sendBtnHover:'#57bd90',
                            accentPrimary:'#4dd0e1', accentError:'#ef5350' } },
  hermesNavy: { bg:'#10141f', fg:'#e8eaf2', panel:'#141a2a', border:'#27304a', red:'#ffd700',
                advanced: { sidebarBg:'#141a2a', inputBg:'#1a2133', inputBorder:'#27304a',
                            userBubbleBg:'#1a2133', aiBubbleBg:'#121726', bubbleBorder:'#222b42',
                            codeBg:'#0c101a', codeFg:'#e8eaf2',
                            sendBtnBg:'#ffd700', sendBtnHover:'#e6c200',
                            accentPrimary:'#4dd0e1', accentError:'#ef5350' } },
```

Notes: keys must match `ADV_KEYS`/`advMap` (`sidebarBg`, `inputBg`, `inputBorder`, `userBubbleBg`, `aiBubbleBg`, `bubbleBorder`, `codeBg`, `codeFg`, `sendBtnBg`, `sendBtnHover`, `accentPrimary`, `accentError`, `sectionAccent`, `toggleActive`, `toggleBg`, `brandColor`). Syntax (`--hl-*`) colors are auto-derived by `deriveSyntaxColors()` — do not set them. The new presets deliberately have no entry in `THEME_DEFAULT_PATTERN` / `THEME_DEFAULT_EFFECT_COLOR` (no background effects).

- [ ] **Step 2: Flip the defaults**

```js
const DEFAULT_THEME = 'hermesCharcoal';   // HERMES: was 'dark'
```
```js
const DEFAULT_FONT = 'sans';              // HERMES: was 'mono'
```

- [ ] **Step 3: Verify no syntax errors**

Run: `node --check frontend-overrides/js/theme.js`
Expected: silence (exit 0). (`node --check` parses ES modules fine here; if it complains about `import`, use `node --input-type=module --check < frontend-overrides/js/theme.js`.)

- [ ] **Step 4: Commit**

```bash
git add frontend-overrides/js/theme.js
git commit -m "feat(hermes): add 4 Hermes theme presets, default to Charcoal + sans"
```

### Task 2: Create hermes.css and wire it in (both places)

**Files:**
- Create: `frontend-overrides/hermes.css`
- Modify: `frontend-overrides/index.html` (head, next to the existing `workspace.css` link)
- Modify: `scripts/sync-frontend.sh` (new injection block after the workspace.css one, ~line 78)

- [ ] **Step 1: Create `frontend-overrides/hermes.css`** with the token layer and first-paint defaults:

```css
/* ============================================================
   HERMES: Hermes WebUI structural skin for openclaw-workspace.
   Loaded AFTER style.css and workspace.css. Written 100% against
   theme variables so every theme (legacy included) gets the
   Hermes component structure. Spec:
   docs/superpowers/specs/2026-06-10-hermes-ui-adoption-design.md
   Palette values adapted from github.com/nesquena/hermes-webui
   @ e8d71a2 (MIT) — see frontend-vendor/THIRD-PARTY.md.
   ============================================================ */

/* ── Fresh-install first paint = Hermes Charcoal ──
   Saved themes win automatically: the index.html boot script and
   theme.js applyColors() set these vars as INLINE styles on <html>,
   which beat any stylesheet. This block only paints first-run. */
:root {
  --bg: #1e1f22;
  --fg: #d7dae0;
  --panel: #17181b;
  --border: #33353a;
  --red: #e8c268;
  --font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
}

/* ── Shared knobs ── */
:root {
  --hermes-radius: 10px;
  --hermes-pill: 999px;
  --hermes-mono: 'Fira Code', ui-monospace, SFMono-Regular, Menlo, monospace;
  --hermes-muted: color-mix(in srgb, var(--fg) 55%, transparent);
  --hermes-faint: color-mix(in srgb, var(--fg) 35%, transparent);
}

/* ── Typography split: UI sans, code/paths mono ── */
pre, code, .hljs,
.agent-thread-cmd, .agent-tool-output pre,
.hermes-mono {
  font-family: var(--hermes-mono) !important;
}
```

- [ ] **Step 2: Add the `<link>` in `frontend-overrides/index.html`**

Find the head section (the override file carries its own links; `grep -n "workspace.css" frontend-overrides/index.html`). Immediately after the workspace.css `<link>` (or before `</head>` if absent), add:

```html
  <link rel="stylesheet" href="/static/hermes.css">
```

- [ ] **Step 3: Add the idempotent injector to `scripts/sync-frontend.sh`**

After the existing workspace.css injection block (ends ~line 90, message "injected workspace.css <link> into index.html"), add a sibling block (both-places rule — injector-only tags were once silently lost, and index.html-only tags die if the override is ever retired):

```bash
  # Inject the Hermes skin stylesheet once, just before </head> (idempotent).
  LINK_HERMES='<link rel="stylesheet" href="/static/hermes.css">'
  if [[ -f "$INDEX" ]] && [[ -f "$OVERRIDES/hermes.css" ]] \
     && ! grep -qF "hermes.css" "$INDEX"; then
    awk -v link="  $LINK_HERMES" '
      !done && /<\/head>/ { print link; done=1 }
      { print }
    ' "$INDEX" > "$INDEX.tmp" && mv "$INDEX.tmp" "$INDEX"
    echo "injected hermes.css <link> into index.html"
  fi
```

- [ ] **Step 4: Build to a scratch dest and verify wiring**

Run: `WORKSPACE_BUILD_DEST=/tmp/hermes-build bash scripts/sync-frontend.sh && grep -c "hermes.css" /tmp/hermes-build/index.html && test -f /tmp/hermes-build/hermes.css && echo OK`
Expected: a count ≥ 1 and `OK`.

- [ ] **Step 5: Commit**

```bash
git add frontend-overrides/hermes.css frontend-overrides/index.html scripts/sync-frontend.sh
git commit -m "feat(hermes): hermes.css skin file + dual wiring (index.html link + sync injector)"
```

### Task 3: Component skin (pills, capsule input, modals, scrollbars)

**Files:**
- Modify: `frontend-overrides/hermes.css` (append)

- [ ] **Step 1: Append the component skin to `hermes.css`**

```css
/* ── Pane dividers: minimalist 1px ── */
.sidebar { border-right: 1px solid var(--border); }

/* ── Scrollbars: thin + neutral (replaces accent-red thumbs) ── */
@supports selector(::-webkit-scrollbar) {
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background-color: color-mix(in srgb, var(--fg) 22%, transparent);
    border-radius: 3px; border: none;
  }
  ::-webkit-scrollbar-thumb:hover {
    background-color: color-mix(in srgb, var(--fg) 38%, transparent);
  }
}

/* ── Message input: floating capsule bar ── */
.chat-input-bar {
  border: 1px solid var(--input-border, var(--border));
  background: var(--input-bg, var(--panel));
  border-radius: 22px;
  margin: 0 14px 14px;
  padding: 8px 12px;
  box-shadow: 0 4px 18px color-mix(in srgb, var(--bg) 55%, transparent);
}
.chat-input-bar textarea#message {
  background: transparent;
  border: none;
}
/* Circular accent send button */
.send-btn {
  border-radius: 50% !important;
  width: 34px; height: 34px;
  background: var(--send-btn-bg, var(--red));
  color: var(--bg);
  display: inline-flex; align-items: center; justify-content: center;
}
.send-btn:hover { background: var(--send-btn-hover, var(--red)); }
.send-btn .send-btn-label { display: none; } /* icon-only, Hermes style */
/* Model picker as a dropdown chip */
.model-picker-btn {
  border: 1px solid var(--border);
  border-radius: var(--hermes-pill);
  padding: 3px 10px;
  background: transparent;
  font-size: 12px;
}

/* ── Modals: Hermes settings-dialog conventions ── */
.modal label, .modal .admin-toggle-label, .color-row label {
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 11px;
  color: var(--hermes-muted);
}
.modal input[type="text"], .modal input[type="password"],
.modal input[type="number"], .modal select, .modal textarea {
  border: 1.5px solid var(--border);
  border-radius: 8px;
  background: var(--input-bg, var(--panel));
}
/* Square accent-filled checkboxes */
.modal input[type="checkbox"] {
  appearance: none; -webkit-appearance: none;
  width: 16px; height: 16px; border-radius: 4px;
  border: 1.5px solid var(--border);
  background: transparent; cursor: pointer;
  position: relative; vertical-align: -3px;
}
.modal input[type="checkbox"]:checked {
  background: var(--red); border-color: var(--red);
}
.modal input[type="checkbox"]:checked::after {
  content: ""; position: absolute; left: 4.5px; top: 1.5px;
  width: 4px; height: 8px;
  border: solid var(--bg); border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}

/* ── Status dots (sidebar notif + streaming) ── */
.sidebar-notif-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--green, #50fa7b);
}
```

Caveat for the implementer: these selectors were verified against the current `frontend-vendor/style.css` / `frontend-overrides/index.html` (`.chat-input-bar` index.html:1010, `.send-btn` index.html:1128, `.model-picker-btn` index.html:1016). If a rule has no visible effect, inspect in devtools and tighten specificity — do NOT add `!important` beyond what's shown.

- [ ] **Step 2: Build live and eyeball**

Run: `bash scripts/sync-frontend.sh`
Then open `http://bespin.bicolor-triceratops.ts.net:8800/` and verify, in BOTH a fresh-profile/incognito window (→ Charcoal + sans + capsule input) and your normal window (saved theme intact, new component shapes): capsule input bar, circular send button, thin scrollbars, modal checkbox styling (open Settings), code blocks still mono.
Also click through 3 legacy themes (dark, light, gpt) in the theme picker — no broken/unreadable surfaces.

- [ ] **Step 3: Commit**

```bash
git add frontend-overrides/hermes.css
git commit -m "feat(hermes): component skin — capsule input, pills, modals, scrollbars, status dots"
```

---

## Phase 2 — Sidebar restructure

### Task 4: Relocate the icon rail into the sidebar as a horizontal strip

**Files:**
- Modify: `frontend-overrides/index.html` (move the `#icon-rail` element, ~line 659, into `#sidebar`, ~line 686)
- Modify: `frontend-overrides/hermes.css` (append strip CSS + fallback)

Approach: move the **whole `#icon-rail` element** (with all children) inside `<nav id="sidebar">`, as its first child. Every `getElementById('rail-*')` reference and every overlay that appends buttons to `#icon-rail` (cron.js injects `#rail-cron`, etc.) keeps working because the element itself survives. The escape hatch is a `hermes-rail-fallback` class on `<body>` that re-pins the rail to the left edge as a vertical column, CSS-only.

- [ ] **Step 1: Move the element in `frontend-overrides/index.html`**

Cut the entire `<div class="icon-rail" id="icon-rail"> ... </div>` block (starts ~line 659; find its closing tag by matching indentation) and paste it as the FIRST child of `<nav class="sidebar" id="sidebar" ...>` (~line 686), before `.sidebar-resize-handle`. Add a marker comment above it: `<!-- HERMES: rail relocated into sidebar; horizontal strip via hermes.css; body.hermes-rail-fallback restores vertical -->`.

- [ ] **Step 2: Append the strip CSS to `hermes.css`**

```css
/* ── HERMES icon strip: the rail, horizontal, inside the sidebar ── */
body:not(.hermes-rail-fallback) #sidebar .icon-rail {
  position: static;
  width: 100% !important;       /* beats sidebar-layout.js inline width */
  flex-direction: row;
  flex-wrap: wrap;
  justify-content: flex-start;
  align-items: center;
  padding: 8px 8px 6px;
  gap: 2px;
  border-right: none;
  border-bottom: 1px solid var(--border);
  background: var(--sidebar-bg, var(--panel));
}
body:not(.hermes-rail-fallback) #sidebar .icon-rail .rail-resize-handle { display: none; }
body:not(.hermes-rail-fallback) #sidebar .icon-rail .icon-rail-divider {
  width: 1px; height: 18px; margin: 0 4px;
}
/* Strip must show inside the mobile drawer too (style.css hides .icon-rail <768px) */
@media (max-width: 768px) {
  body:not(.hermes-rail-fallback) #sidebar .icon-rail { display: flex !important; }
}

/* ── Fallback: restore a vertical left rail without moving DOM back ── */
body.hermes-rail-fallback #sidebar .icon-rail {
  position: fixed; left: 0; top: 0; bottom: 0;
  width: 48px; flex-direction: column;
  border-right: 1px solid var(--border); border-bottom: none;
}
body.hermes-rail-fallback #sidebar { margin-left: 48px; }
```

- [ ] **Step 3: Build live and verify**

Run: `bash scripts/sync-frontend.sh`, reload the app. Verify: icons render as a wrapping horizontal strip at the sidebar top; every former rail destination still opens (chats, documents, calendar, email, inbox, notes, cron — the cron button is overlay-injected, confirm it appears in the strip); notification dots/badges still visible; sidebar hide/show (hamburger) still works; mobile-width window shows the strip inside the drawer. Then in devtools run `document.body.classList.add('hermes-rail-fallback')` and confirm the vertical rail comes back; remove the class.

- [ ] **Step 4: Commit**

```bash
git add frontend-overrides/index.html frontend-overrides/hermes.css
git commit -m "feat(hermes): icon rail relocated into sidebar as horizontal strip (+ CSS fallback)"
```

### Task 5: New-conversation pill + inline filter input

**Files:**
- Modify: `frontend-overrides/index.html` (sidebar items `#sidebar-new-chat-btn` ~line 695, `#sidebar-search-btn` ~line 699)
- Modify: `frontend-overrides/js/sessions.js` (inline filter state + hook)
- Modify: `frontend-overrides/hermes.css` (append)

- [ ] **Step 1: Restyle the new-chat item into a pill and add the filter input**

In `index.html`, replace the inner content of `#sidebar-new-chat-btn` (keep the element, id, and title — its click handler is bound by id) so it reads:

```html
      <div class="list-item hermes-new-pill" id="sidebar-new-chat-btn" title="New chat">
        <span class="hermes-new-pill-label">+ New conversation</span>
      </div>
```

Directly below `#sidebar-search-btn` (keep that item — it opens the search modal and owns the real Ctrl+K binding), add:

```html
      <!-- HERMES: inline list filter; Ctrl+K hint points at full search -->
      <div class="hermes-filter-row">
        <input type="text" id="hermes-session-filter" placeholder="Filter conversations..." autocomplete="off">
        <span class="hermes-hotkey" title="Full search">Ctrl+K</span>
      </div>
```

(Deviation from Hermes, on purpose: their `Cmd+K` ghost sits on the New-conversation pill, but in this app Ctrl+K opens search — the hint goes where it's true.)

- [ ] **Step 2: Wire the filter in `sessions.js`**

Near the top with the other module state (`let _sortMode = ...`, line 24), add:

```js
let _hermesFilter = ''; // HERMES: inline sidebar filter (lowercased substring)
```

In `_renderSessionListImpl()`, immediately after `orderedSessions` is first computed (the `sessions.filter(...)` line ~line 721), add:

```js
  // HERMES: inline filter narrows the list in place
  if (_hermesFilter) {
    orderedSessions = orderedSessions.filter(s =>
      (s.name || '').toLowerCase().includes(_hermesFilter));
  }
```

At module bottom (near the other DOM bindings, e.g. where `session-sort-dropdown` is wired ~line 1213 — any once-on-load location works), add:

```js
// HERMES: inline sidebar filter input
const _hermesFilterEl = document.getElementById('hermes-session-filter');
if (_hermesFilterEl) {
  _hermesFilterEl.addEventListener('input', () => {
    _hermesFilter = _hermesFilterEl.value.trim().toLowerCase();
    renderSessionList();
  });
}
```

- [ ] **Step 3: Append pill/filter CSS to `hermes.css`**

```css
/* ── New-conversation pill + filter row ── */
.hermes-new-pill {
  border: 1px solid var(--border);
  border-radius: var(--hermes-pill);
  background: var(--accent-bg, color-mix(in srgb, var(--red) 10%, transparent));
  color: var(--red);
  justify-content: center;
  font-weight: 600;
  margin: 8px 8px 4px;
  padding: 7px 12px;
}
.hermes-new-pill:hover { background: color-mix(in srgb, var(--red) 18%, transparent); }
.hermes-filter-row {
  display: flex; align-items: center; gap: 6px; margin: 2px 8px 6px;
}
.hermes-filter-row input {
  flex: 1; min-width: 0;
  background: var(--input-bg, var(--panel));
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--fg);
  font-size: 12px; padding: 6px 9px;
}
.hermes-hotkey {
  font-size: 10px; color: var(--hermes-faint);
  border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px;
  font-family: var(--hermes-mono);
}
```

- [ ] **Step 4: Verify**

`node --input-type=module --check < frontend-overrides/js/sessions.js` → exit 0.
`bash scripts/sync-frontend.sh`, reload: pill renders and creates a chat; typing in the filter narrows the session list live; clearing it restores; Ctrl+K still opens search.

- [ ] **Step 5: Commit**

```bash
git add frontend-overrides/index.html frontend-overrides/js/sessions.js frontend-overrides/hermes.css
git commit -m "feat(hermes): new-conversation pill + inline session filter"
```

### Task 6: Date-grouped session history

**Files:**
- Modify: `frontend-overrides/js/sessions.js` (new `'date'` sort mode, default; bucket renderer)
- Modify: `frontend-overrides/index.html` (sort dropdown `#session-sort-dropdown` ~line 729)
- Modify: `frontend-overrides/hermes.css` (group headers, active row, status dot)

- [ ] **Step 1: Make `'date'` the default sort mode**

Line 24 of `sessions.js`:

```js
let _sortMode = Storage.get('odysseus-session-sort') || 'date'; // HERMES: date-grouped default (was 'active')
```

- [ ] **Step 2: Add the bucket helper** (module scope, near `createSessionItem`):

```js
// HERMES: bucket sessions for the date-grouped sidebar. Pinned (is_important)
// first, then by recency using the same timestamp the 'active' sort uses.
function _hermesDateBuckets(list) {
  const buckets = [
    ['★ PINNED', []], ['TODAY', []], ['YESTERDAY', []],
    ['THIS WEEK', []], ['LAST WEEK', []], ['EARLIER', []],
  ];
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const yestStart = todayStart - dayMs;
  // Week starts Monday, local time.
  const dow = (now.getDay() + 6) % 7;
  const weekStart = todayStart - dow * dayMs;
  const lastWeekStart = weekStart - 7 * dayMs;
  const ts = (s) => {
    const v = s.last_message_at || s.updated_at || s.created_at || '';
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : 0;
  };
  const sorted = [...list].sort((a, b) => ts(b) - ts(a));
  for (const s of sorted) {
    if (s.is_important) { buckets[0][1].push(s); continue; }
    const t = ts(s);
    if (t >= todayStart) buckets[1][1].push(s);
    else if (t >= yestStart) buckets[2][1].push(s);
    else if (t >= weekStart) buckets[3][1].push(s);
    else if (t >= lastWeekStart) buckets[4][1].push(s);
    else buckets[5][1].push(s);
  }
  return buckets;
}
```

Edge case to preserve: when `weekStart === todayStart` (Monday), TODAY/YESTERDAY still win because they're checked first; THIS WEEK may be empty — empty buckets are skipped at render.

- [ ] **Step 3: Render the buckets**

In `_renderSessionListImpl()`, right BEFORE the existing `if (_sortMode && _sortMode !== 'group') {` branch (~line 750), add:

```js
  // HERMES: date-grouped mode
  if (_sortMode === 'date') {
    for (const [label, arr] of _hermesDateBuckets(orderedSessions)) {
      if (!arr.length) continue;
      const h = document.createElement('div');
      h.className = 'hermes-group-header';
      h.textContent = label;
      _frag.appendChild(h);
      arr.forEach(s => _frag.appendChild(createSessionItem(s)));
    }
    list.innerHTML = '';
    list.appendChild(_frag);
    _postRenderSessionList(list);
    return;
  }
```

(No `SIDEBAR_MAX_VISIBLE` cap in date mode — the groups themselves keep the list scannable, matching Hermes.)

- [ ] **Step 4: Add the dropdown option**

In `index.html`'s `#session-sort-dropdown` (~line 729), add as the FIRST item:

```html
              <div class="dropdown-item sort-option sort-dropdown-item" data-sort="date">Date Grouped</div>
```

- [ ] **Step 5: Group header + row CSS** (append to `hermes.css`):

```css
/* ── Date-group headers + Hermes row states ── */
.hermes-group-header {
  font-size: 10px; font-weight: 700;
  letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--hermes-faint);
  padding: 12px 12px 4px;
  user-select: none;
}
#session-list .list-item.active {
  background: color-mix(in srgb, var(--red) 12%, transparent);
  border-left: 2px solid var(--red);
}
```

(Check the active-row class in devtools: `createSessionItem` rows get a selected-state class when current — if it's not `.active`, adjust the selector to the real one, e.g. `.selected`.)

- [ ] **Step 6: Verify**

`node --input-type=module --check < frontend-overrides/js/sessions.js` → exit 0. Build live, reload with cleared `odysseus-session-sort` (devtools: `localStorage.removeItem('odysseus-session-sort')`): list shows ★ PINNED (star a chat to confirm), TODAY, etc.; empty groups absent; switching to “Newest First” and back via the sort dropdown works; filter from Task 5 composes with grouping.

- [ ] **Step 7: Commit**

```bash
git add frontend-overrides/js/sessions.js frontend-overrides/index.html frontend-overrides/hermes.css
git commit -m "feat(hermes): date-grouped session history (PINNED/TODAY/.../EARLIER), new default sort"
```

### Task 7: Sidebar footer block (model + workspace path)

**Files:**
- Create: `frontend-overrides/js/hermes-footer.js`
- Modify: `frontend-overrides/index.html` (footer markup at the end of `#sidebar`, + script tag)
- Modify: `scripts/sync-frontend.sh` (injector block for the script, same pattern as cron.js)
- Modify: `frontend-overrides/hermes.css` (append)

- [ ] **Step 1: Footer markup** — in `index.html`, add as the LAST child inside `<nav id="sidebar">`:

```html
      <!-- HERMES: footer console — model mirror + workspace path -->
      <div id="hermes-footer">
        <div class="hermes-footer-label">MODEL</div>
        <button type="button" id="hermes-footer-model" title="Switch model">
          <span id="hermes-footer-model-label">…</span>
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <div id="hermes-footer-path" class="hermes-mono" hidden></div>
      </div>
```

- [ ] **Step 2: Create `frontend-overrides/js/hermes-footer.js`**

```js
// HERMES: sidebar footer console. Mirrors the input-bar model picker label
// (the picker itself stays in the chat input bar — clicking the footer button
// opens it there) and shows the agent workspace path once the Phase-3
// /api/workspace/tree endpoint exists (hidden gracefully until then).
(function () {
  function init() {
    const label = document.getElementById('hermes-footer-model-label');
    const btn = document.getElementById('hermes-footer-model');
    const path = document.getElementById('hermes-footer-path');
    const src = document.getElementById('model-picker-label');
    if (!label || !btn) return;

    const sync = () => { label.textContent = (src && src.textContent.trim()) || 'Select model'; };
    sync();
    if (src) new MutationObserver(sync).observe(src, { childList: true, characterData: true, subtree: true });

    btn.addEventListener('click', () => {
      const real = document.getElementById('model-picker-btn');
      if (real) { real.click(); real.scrollIntoView({ block: 'nearest' }); }
    });

    // Agent initial for chat avatars (Phase 4 CSS reads this var).
    fetch('/api/config').then(r => r.ok ? r.json() : null).then(cfg => {
      const name = (cfg && (cfg.agent_name || cfg.name)) || '';
      if (name) document.documentElement.style.setProperty('--hermes-agent-initial', JSON.stringify(name[0].toUpperCase()));
    }).catch(() => {});

    if (path) {
      fetch('/api/workspace/tree').then(r => r.ok ? r.json() : null).then(d => {
        if (d && d.root) { path.textContent = d.root; path.title = d.root; path.hidden = false; }
      }).catch(() => {});
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
```

- [ ] **Step 3: Wire the script (both places)** — in `index.html` before `</body>`:

```html
  <script src="/static/js/hermes-footer.js" defer></script>
```

…and in `scripts/sync-frontend.sh`, after the gateway-status injector block, a sibling block (copy the cron.js awk pattern exactly, substituting):

```bash
  SCRIPT_HFOOT='<script src="/static/js/hermes-footer.js" defer></script>'
  if [[ -f "$INDEX" ]] && [[ -f "$OVERRIDES/js/hermes-footer.js" ]] \
     && ! grep -qF "js/hermes-footer.js" "$INDEX"; then
    awk -v s="  $SCRIPT_HFOOT" '
      { lines[NR] = $0 }
      END {
        for (i = 1; i <= NR; i++) {
          if (!done && lines[i] ~ /<\/body>/) { print s; done = 1 }
          print lines[i]
        }
      }
    ' "$INDEX" > "$INDEX.tmp" && mv "$INDEX.tmp" "$INDEX"
    echo "injected hermes-footer.js <script> into index.html"
  fi
```

- [ ] **Step 4: Footer CSS** (append to `hermes.css`):

```css
/* ── Sidebar footer console ── */
#hermes-footer {
  margin-top: auto;
  padding: 10px 12px;
  border-top: 1px solid var(--border);
  display: flex; flex-direction: column; gap: 5px;
}
.hermes-footer-label {
  font-size: 9px; font-weight: 700; letter-spacing: 0.1em;
  color: var(--hermes-faint);
}
#hermes-footer-model {
  display: flex; align-items: center; justify-content: space-between; gap: 6px;
  background: var(--input-bg, var(--panel));
  border: 1px solid var(--border); border-radius: 8px;
  color: var(--fg); font-size: 12px; padding: 6px 9px; cursor: pointer;
  text-align: left;
}
#hermes-footer-model:hover { border-color: var(--red); }
#hermes-footer-path {
  font-size: 10px; color: var(--hermes-faint);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
```

Note: `#sidebar` must be a flex column for `margin-top:auto` to pin the footer — check `.sidebar` in `frontend-vendor/style.css:369`; if it isn't `display:flex; flex-direction:column`, add `#sidebar { display:flex; flex-direction:column; }` to this block and re-verify the session list still scrolls (`.sidebar-inner` should get `flex:1; min-height:0; overflow-y:auto`).

Spec note: the `↑ Transcript / </> JSON / ↑ Import` action row is OMITTED — no existing sidebar export/import functions to map (spec's "omit if absent" rule).

- [ ] **Step 5: Verify + commit**

Build live, reload: footer shows current model name; changing model in the input-bar picker updates the footer label; clicking the footer button opens the picker; path line stays hidden (endpoint doesn't exist until Phase 3) with no console errors.

```bash
git add frontend-overrides/js/hermes-footer.js frontend-overrides/index.html scripts/sync-frontend.sh frontend-overrides/hermes.css
git commit -m "feat(hermes): sidebar footer console (model mirror + workspace path slot)"
```

---

## Phase 3 — WORKSPACE explorer

### Task 8: Backend — failing tests first

**Files:**
- Create: `backend/tests/test_workspace_files.py`

- [ ] **Step 1: Write the tests**

```python
"""Pure-function tests for the workspace explorer backend (Hermes UI)."""
import os
from pathlib import Path

import pytest

from backend import workspace_files as wf


@pytest.fixture()
def ws(tmp_path: Path) -> Path:
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "note.md").write_text("hello")
    (tmp_path / "screenshots").mkdir()
    (tmp_path / "screenshots" / "ui.png").write_bytes(b"\x89PNG fake")
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "HEAD").write_text("ref: refs/heads/main")
    (tmp_path / "MEMORY.md").write_text("x" * 2100)
    return tmp_path


def _find(nodes, name):
    return next((n for n in nodes if n["name"] == name), None)


def test_tree_basic_shape_and_sizes(ws):
    tree, truncated = wf.build_tree(ws)
    assert truncated is False
    docs = _find(tree, "docs")
    assert docs["type"] == "dir"
    note = _find(docs["children"], "note.md")
    assert note == {"name": "note.md", "path": "docs/note.md", "type": "file", "size": 5}
    mem = _find(tree, "MEMORY.md")
    assert mem["size"] == 2100


def test_tree_dirs_sort_before_files(ws):
    tree, _ = wf.build_tree(ws)
    names = [n["name"] for n in tree]
    assert names.index("docs") < names.index("MEMORY.md")


def test_git_dir_listed_but_not_walked(ws):
    tree, _ = wf.build_tree(ws)
    git = _find(tree, ".git")
    assert git["type"] == "dir"
    assert git["children"] == []


def test_entry_cap_sets_truncated(ws):
    for i in range(50):
        (ws / f"f{i:03}.txt").write_text("x")
    tree, truncated = wf.build_tree(ws, max_entries=10)
    assert truncated is True


def test_depth_cap(ws):
    d = ws / "a" / "b" / "c"
    d.mkdir(parents=True)
    (d / "deep.txt").write_text("x")
    tree, truncated = wf.build_tree(ws, max_depth=2)
    a = _find(tree, "a")
    b = _find(a["children"], "b")
    assert b["children"] == []          # cut at depth cap
    assert truncated is True


def test_symlinked_dir_not_walked(ws, tmp_path_factory):
    outside = tmp_path_factory.mktemp("outside")
    (outside / "secret.txt").write_text("s")
    os.symlink(outside, ws / "link")
    tree, _ = wf.build_tree(ws)
    link = _find(tree, "link")
    assert link is None or link.get("children") in ([], None)


def test_resolve_safe_accepts_normal(ws):
    assert wf.resolve_safe(ws, "docs/note.md") == (ws / "docs" / "note.md").resolve()


@pytest.mark.parametrize("bad", ["../etc/passwd", "docs/../../etc", "/etc/passwd"])
def test_resolve_safe_rejects_escapes(ws, bad):
    with pytest.raises(ValueError):
        wf.resolve_safe(ws, bad)


def test_resolve_safe_rejects_symlink_out(ws, tmp_path_factory):
    outside = tmp_path_factory.mktemp("outside2")
    (outside / "secret.txt").write_text("s")
    os.symlink(outside / "secret.txt", ws / "alias.txt")
    with pytest.raises(ValueError):
        wf.resolve_safe(ws, "alias.txt")


def test_git_branch_none_outside_repo(tmp_path):
    assert wf.git_branch(tmp_path) is None
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest backend/tests/test_workspace_files.py -q`
Expected: collection error — `ModuleNotFoundError`/`ImportError: cannot import name 'workspace_files'`.

- [ ] **Step 3: Commit the red tests**

```bash
git add backend/tests/test_workspace_files.py
git commit -m "test(hermes): workspace explorer backend — tree/guard tests (red)"
```

### Task 9: Backend — implement `workspace_files.py` and register

**Files:**
- Create: `backend/workspace_files.py`
- Modify: `backend/app.py` (import + `include_router`, with the other routers ~lines 51–62)

- [ ] **Step 1: Create `backend/workspace_files.py`**

```python
"""Read-only WORKSPACE explorer endpoints (Hermes UI right pane).

Serves a size-annotated tree of the OpenClaw agent workspace (the same root
the Notes/Documents vault adapters use: ``vault_store.WORKSPACE``) and
individual file contents. Read-only by construction — GET routes only,
path-traversal guarded (symlink-aware).
"""
from __future__ import annotations

import mimetypes
import subprocess
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse

from . import vault_store as vs

router = APIRouter()

MAX_DEPTH = 6
MAX_ENTRIES = 2000
PREVIEW_CAP = 512 * 1024  # bytes of text served inline
CACHE_TTL = 10.0          # seconds; the 2014-mini disk hates re-walks
SKIP_CONTENTS = {".git", "node_modules", "__pycache__", ".venv", ".versions"}
TEXT_EXTS = {
    ".md", ".txt", ".json", ".py", ".js", ".mjs", ".ts", ".css", ".html",
    ".sh", ".yaml", ".yml", ".toml", ".ini", ".csv", ".log", ".skill",
}

_cache: dict = {"t": 0.0, "data": None}


def workspace_root() -> Path:
    return vs.WORKSPACE


def git_branch(root: Path) -> str | None:
    """Current branch name, or None for non-repos/any failure."""
    try:
        out = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True, timeout=5,
        )
    except Exception:
        return None
    if out.returncode != 0:
        return None
    return out.stdout.strip() or None


def build_tree(root: Path, max_depth: int = MAX_DEPTH,
               max_entries: int = MAX_ENTRIES) -> tuple[list[dict], bool]:
    """Nested {name,path,type,size,children} nodes + truncated flag.

    Dirs sort before files (case-insensitive). Entries in SKIP_CONTENTS are
    listed but never walked. Symlinks are never walked (a symlinked dir shows
    as a childless dir). Depth/entry caps set truncated=True when they bite.
    """
    state = {"count": 0, "truncated": False}

    def walk(d: Path, depth: int) -> list[dict]:
        nodes: list[dict] = []
        try:
            entries = sorted(d.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
        except OSError:
            return nodes
        for p in entries:
            if state["count"] >= max_entries:
                state["truncated"] = True
                break
            state["count"] += 1
            rel = p.relative_to(root).as_posix()
            is_link = p.is_symlink()
            if p.is_dir():
                node = {"name": p.name, "path": rel, "type": "dir", "children": []}
                if not is_link and p.name not in SKIP_CONTENTS:
                    if depth >= max_depth:
                        state["truncated"] = True
                    else:
                        node["children"] = walk(p, depth + 1)
                nodes.append(node)
            elif p.is_file():
                try:
                    size = p.stat().st_size
                except OSError:
                    size = 0
                nodes.append({"name": p.name, "path": rel, "type": "file", "size": size})
        return nodes

    if not root.is_dir():
        return [], False
    return walk(root, 1), state["truncated"]


def resolve_safe(root: Path, rel: str) -> Path:
    """Resolve ``rel`` strictly inside ``root`` (symlink-aware) or raise ValueError."""
    if not rel or rel.startswith(("/", "\\")) or "\x00" in rel:
        raise ValueError("invalid path")
    target = (root / rel).resolve()
    rootr = root.resolve()
    if target != rootr and rootr not in target.parents:
        raise ValueError("path escapes workspace root")
    return target


@router.get("/api/workspace/tree")
def workspace_tree(fresh: int = 0):
    now = time.time()
    if not fresh and _cache["data"] is not None and now - _cache["t"] < CACHE_TTL:
        return _cache["data"]
    root = workspace_root()
    if not root.is_dir():
        data = {"root": str(root), "branch": None, "tree": [],
                "truncated": False, "missing": True}
    else:
        tree, truncated = build_tree(root)
        data = {"root": str(root), "branch": git_branch(root), "tree": tree,
                "truncated": truncated, "missing": False}
    _cache.update(t=now, data=data)
    return data


@router.get("/api/workspace/file")
def workspace_file(path: str):
    root = workspace_root()
    try:
        target = resolve_safe(root, path)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid path")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="not a file")
    mime = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    if mime.startswith("image/"):
        return FileResponse(target, media_type=mime)
    if target.suffix.lower() in TEXT_EXTS or mime.startswith("text/"):
        data = target.read_bytes()
        headers = {"X-Truncated": "1"} if len(data) > PREVIEW_CAP else {}
        return PlainTextResponse(
            data[:PREVIEW_CAP].decode("utf-8", "replace"), headers=headers)
    return FileResponse(target, media_type=mime, filename=target.name)
```

- [ ] **Step 2: Run the tests**

Run: `python3 -m pytest backend/tests/test_workspace_files.py -q`
Expected: all pass. If `test_symlinked_dir_not_walked` fails because the symlink shows children: `p.is_dir()` follows links — the `is_link` guard above must run before walking (it does; debug from there).

- [ ] **Step 3: Register the router** — in `backend/app.py`, with the other imports of routers, add `from .workspace_files import router as workspace_files_router`, and with the `include_router` block (lines 51–62), BEFORE any catch-all route registration:

```python
app.include_router(workspace_files_router)
```

- [ ] **Step 4: Full suite + import check**

Run: `python3 -m pytest backend/tests -q`  → all green (195 + 11 new).
Run: `python3 -c "from backend.app import app; print('import ok')"` → `import ok`.

- [ ] **Step 5: Commit**

```bash
git add backend/workspace_files.py backend/app.py
git commit -m "feat(hermes): read-only /api/workspace tree+file endpoints (traversal-guarded, cached)"
```

### Task 10: Frontend — explorer pane

**Files:**
- Create: `frontend-overrides/js/workspace-explorer.js`
- Modify: `frontend-overrides/index.html` (aside after `</main>`, + script tag)
- Modify: `scripts/sync-frontend.sh` (injector block, same pattern)
- Modify: `frontend-overrides/hermes.css` (append)

- [ ] **Step 1: Markup** — in `index.html`, find the closing `</main>` of `#chat-container` (`grep -n "</main>" frontend-overrides/index.html`) and insert immediately after it:

```html
  <!-- HERMES: right-hand WORKSPACE explorer (read-only; Phase 3) -->
  <aside id="workspace-explorer" hidden aria-label="Workspace files">
    <div class="we-header">
      <span class="we-title">WORKSPACE</span>
      <span id="we-branch" class="we-branch" hidden></span>
      <button type="button" id="we-refresh" title="Refresh">&#x27F3;</button>
      <button type="button" id="we-collapse" title="Hide panel">&#x2715;</button>
    </div>
    <div id="we-tree" class="we-tree"></div>
  </aside>
  <button type="button" id="we-reopen" title="Workspace files" hidden>Files</button>
```

- [ ] **Step 2: Create `frontend-overrides/js/workspace-explorer.js`**

```js
// HERMES: WORKSPACE explorer pane — read-only tree of the agent workspace.
// Self-contained overlay (no module imports), tolerant of a backend that
// doesn't have /api/workspace yet (pane simply stays hidden).
(function () {
  const LS_KEY = 'hermes-explorer-collapsed';
  const fmt = (n) => {
    if (n == null) return '';
    if (n < 1024) return n + 'b';
    const k = n / 1024;
    return (k >= 100 ? Math.round(k) : k.toFixed(1)) + 'k';
  };
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);

  function renderNodes(nodes, depth) {
    return nodes.map((n) => {
      if (n.type === 'dir') {
        const kids = n.children && n.children.length
          ? renderNodes(n.children, depth + 1) : '';
        return `<details class="we-dir" ${depth < 1 ? 'open' : ''}>` +
          `<summary style="--we-depth:${depth}">${esc(n.name)}</summary>${kids}</details>`;
      }
      return `<div class="we-file" style="--we-depth:${depth}" data-path="${esc(n.path)}">` +
        `<span class="we-name">${esc(n.name)}</span>` +
        `<span class="we-size">${fmt(n.size)}</span></div>`;
    }).join('');
  }

  async function load(fresh) {
    let data = null;
    try {
      const r = await fetch('/api/workspace/tree' + (fresh ? '?fresh=1' : ''));
      if (r.ok) data = await r.json();
    } catch (e) { /* backend not restarted yet — stay hidden */ }
    const pane = document.getElementById('workspace-explorer');
    if (!pane) return;
    if (!data || !Array.isArray(data.tree)) { pane.hidden = true; return; }
    const branch = document.getElementById('we-branch');
    if (branch) { branch.textContent = data.branch || ''; branch.hidden = !data.branch; }
    const tree = document.getElementById('we-tree');
    tree.innerHTML = data.missing
      ? '<div class="we-empty">workspace directory not found</div>'
      : (renderNodes(data.tree, 0) +
         (data.truncated ? '<div class="we-empty">… listing truncated</div>' : ''));
    applyCollapsed();
  }

  function applyCollapsed() {
    const collapsed = localStorage.getItem(LS_KEY) === '1';
    const pane = document.getElementById('workspace-explorer');
    const reopen = document.getElementById('we-reopen');
    if (pane) pane.hidden = collapsed;
    if (reopen) reopen.hidden = !collapsed;
  }

  function preview(path) {
    const url = '/api/workspace/file?path=' + encodeURIComponent(path);
    const lower = path.toLowerCase();
    const isImg = /\.(png|jpe?g|gif|webp|svg)$/.test(lower);
    const overlay = document.createElement('div');
    overlay.id = 'we-preview-overlay';
    overlay.innerHTML =
      `<div id="we-preview"><div class="we-preview-head">` +
      `<span class="hermes-mono">${esc(path)}</span>` +
      `<a href="${url}" download>Download</a>` +
      `<button type="button" id="we-preview-close">&#x2715;</button></div>` +
      `<div class="we-preview-body">${isImg ? `<img src="${url}" alt="">` : '<pre></pre>'}</div></div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.id === 'we-preview-close') overlay.remove();
    });
    if (!isImg) {
      fetch(url).then((r) => r.ok ? r.text() : Promise.reject(r.status))
        .then((t) => { overlay.querySelector('pre').textContent = t; })
        .catch(() => { overlay.querySelector('pre').textContent = '(binary file — use Download)'; });
    }
  }

  function init() {
    const pane = document.getElementById('workspace-explorer');
    if (!pane) return;
    document.getElementById('we-refresh').addEventListener('click', () => load(true));
    document.getElementById('we-collapse').addEventListener('click', () => {
      localStorage.setItem(LS_KEY, '1'); applyCollapsed();
    });
    document.getElementById('we-reopen').addEventListener('click', () => {
      localStorage.setItem(LS_KEY, '0'); applyCollapsed();
    });
    pane.addEventListener('click', (e) => {
      const f = e.target.closest('.we-file');
      if (f) preview(f.dataset.path);
    });
    load(false);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
```

- [ ] **Step 3: Wire the script (both places)** — `<script src="/static/js/workspace-explorer.js" defer></script>` before `</body>` in `index.html`, plus a `sync-frontend.sh` injector block copying the cron.js awk pattern with `SCRIPT_WE='<script src="/static/js/workspace-explorer.js" defer></script>'` and the `js/workspace-explorer.js` grep guard.

- [ ] **Step 4: Pane CSS** (append to `hermes.css`):

```css
/* ── WORKSPACE explorer pane ── */
#workspace-explorer {
  width: 22%; min-width: 220px; max-width: 360px;
  flex-shrink: 0;
  border-left: 1px solid var(--border);
  background: var(--sidebar-bg, var(--panel));
  display: flex; flex-direction: column;
  overflow: hidden;
}
@media (max-width: 1100px) { #workspace-explorer, #we-reopen { display: none !important; } }
.we-header {
  display: flex; align-items: center; gap: 6px;
  padding: 10px 10px 8px;
  border-bottom: 1px solid var(--border);
}
.we-title { font-size: 10px; font-weight: 700; letter-spacing: 0.1em; color: var(--hermes-muted); }
.we-branch {
  font-size: 9px; font-family: var(--hermes-mono);
  text-transform: uppercase;
  border: 1px solid var(--border); border-radius: 4px;
  padding: 1px 5px; color: var(--red);
}
.we-header button {
  background: none; border: none; color: var(--hermes-muted);
  cursor: pointer; font-size: 12px; padding: 2px 4px;
}
.we-header #we-refresh { margin-left: auto; }
.we-tree { overflow-y: auto; flex: 1; padding: 6px 4px; font-size: 12px; }
.we-tree summary {
  cursor: pointer; padding: 2px 6px 2px calc(10px + var(--we-depth, 0) * 14px);
  color: var(--fg); list-style: none;
}
.we-tree summary::before { content: '▸ '; color: var(--hermes-faint); }
.we-tree details[open] > summary::before { content: '▾ '; }
.we-file {
  display: flex; align-items: baseline; gap: 4px;
  padding: 2px 8px 2px calc(24px + var(--we-depth, 0) * 14px);
  cursor: pointer; font-family: var(--hermes-mono);
}
.we-file:hover { background: color-mix(in srgb, var(--fg) 7%, transparent); }
.we-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.we-file::after { content: ''; flex: 1; border-bottom: 1px dotted var(--hermes-faint); }
.we-size { color: var(--hermes-faint); font-size: 10px; }
.we-empty { color: var(--hermes-faint); padding: 12px; font-size: 11px; }
#we-reopen {
  position: fixed; right: 10px; top: 10px; z-index: 50;
  border: 1px solid var(--border); border-radius: var(--hermes-pill);
  background: var(--panel); color: var(--fg);
  font-size: 11px; padding: 4px 10px; cursor: pointer;
}
/* Preview overlay */
#we-preview-overlay {
  position: fixed; inset: 0; z-index: 300;
  background: color-mix(in srgb, var(--bg) 60%, transparent);
  display: flex; align-items: center; justify-content: center;
}
#we-preview {
  width: min(760px, 92vw); max-height: 84vh;
  background: var(--panel); border: 1px solid var(--border);
  border-radius: var(--hermes-radius);
  display: flex; flex-direction: column; overflow: hidden;
}
.we-preview-head {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 12px; border-bottom: 1px solid var(--border); font-size: 12px;
}
.we-preview-head a { margin-left: auto; color: var(--red); }
.we-preview-body { overflow: auto; padding: 12px; }
.we-preview-body pre { white-space: pre-wrap; word-break: break-word; margin: 0; }
.we-preview-body img { max-width: 100%; }
```

- [ ] **Step 5: Verify (frontend only — backend not restarted yet)**

`bash scripts/sync-frontend.sh`, reload: NO explorer pane appears (endpoint 404s → pane stays hidden), no console errors, chat layout unchanged. That graceful absence is this task's pass condition. Full visual verification happens in Task 16 after the restart. To preview earlier without touching the live service: `WORKSPACE_BUILD_DEST=/tmp/hermes-build bash scripts/sync-frontend.sh && cd /Users/admin/openclaw-workspace && python3 -m uvicorn backend.app:app --port 8801` (Ctrl-C when done) and check `http://localhost:8801/` — the new backend code serves there, tree renders, preview/download/collapse work.

- [ ] **Step 6: Commit**

```bash
git add frontend-overrides/js/workspace-explorer.js frontend-overrides/index.html scripts/sync-frontend.sh frontend-overrides/hermes.css
git commit -m "feat(hermes): WORKSPACE explorer pane (tree, branch badge, preview, collapse)"
```

---

## Phase 4 — Chat fidelity + wrap-up

### Task 11: Avatars, tool accordion pills, attachment line

**Files:**
- Modify: `frontend-overrides/hermes.css` (append)

- [ ] **Step 1: Confirm the message classes**

Run: `grep -n "msg-user\|msg msg-ai" frontend-overrides/js/chat.js | head -5`
Expected: `.msg.msg-ai` confirmed (chat.js:807); note the user-bubble class the same way (`grep -n "className = 'msg" frontend-overrides/js/chat.js`). If the user class isn't `msg-user`, substitute the real one below.

- [ ] **Step 2: Append the chat skin**

```css
/* ── Chat avatars: colored initial discs ── */
.msg { position: relative; }
.msg.msg-ai::before, .msg.msg-user::before {
  position: absolute; left: -34px; top: 2px;
  width: 24px; height: 24px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700;
}
.msg.msg-ai::before {
  content: var(--hermes-agent-initial, "A");
  background: var(--red); color: var(--bg);
}
.msg.msg-user::before {
  content: "Y";
  background: var(--accent-primary, #4dd0e1); color: var(--bg);
}
/* Make room for the discs */
#chat-box .msg { margin-left: 38px; }

/* ── Tool accordion pills (existing .agent-thread-node, presentation only) ── */
.agent-thread-node {
  border: 1px solid var(--border);
  border-radius: var(--hermes-radius);
  background: var(--panel);
  padding: 4px 10px;
  margin: 4px 0;
}
.agent-thread-node .agent-thread-header { font-size: 12px; }
.agent-thread-node .agent-thread-tool { font-family: var(--hermes-mono); }
.agent-thread-cmd {
  color: var(--hermes-muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  max-width: 100%;
}
.agent-tool-output summary { font-size: 11px; color: var(--hermes-muted); cursor: pointer; }

/* ── Attachment log line ── */
.msg .attach-note, .msg .attached-files {
  font-size: 11px; color: var(--hermes-faint); font-family: var(--hermes-mono);
}
```

Verify the avatar offset in devtools — if `#chat-box` isn't the chat scroller id, find it (`grep -n 'id="chat-box"' frontend-overrides/index.html`) and adjust; if bubbles already have left margin ≥ 38px, drop the margin rule.

- [ ] **Step 3: Verify + commit**

Build live; send a test message in a throwaway chat (one short turn): user disc "Y", agent disc with the agent's initial (set via `--hermes-agent-initial` from Task 7), tool cards render as bordered pills and still expand/collapse, streaming + stop button unaffected.

```bash
git add frontend-overrides/hermes.css
git commit -m "feat(hermes): chat avatars, tool accordion pills, attachment line styling"
```

### Task 12: Token-usage line — probe, then build or drop

**Files:**
- Possibly modify: `frontend-overrides/js/chat.js`, `backend/bridge.py`

- [ ] **Step 1: Probe whether usage data exists in the pipeline**

Run: `grep -n "usage\|tokens\|input_tokens\|output_tokens" backend/bridge.py | head -20`
Decision rule (spec): the feature ships ONLY if the gateway events the bridge already forwards carry token counts. If the grep shows no usage fields being mapped into SSE frames → **drop the feature**: add a line to the spec's v2-candidates section ("usage line: no data source in gateway events as of 2026-06; revisit if gateway adds usage") and commit that note. Do NOT add new gateway plumbing.

- [ ] **Step 2 (only if usage exists): render it**

In `chat.js`, where the final/done SSE frame for a turn is handled (search `state:"final"` / the handler that clears `streaming`), append after the AI bubble:

```js
// HERMES: token usage footer (only when the gateway reported it)
if (json.usage && (json.usage.input != null || json.usage.output != null)) {
  const u = document.createElement('div');
  u.className = 'msg-usage hermes-mono';
  const fmtK = (n) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  u.textContent = `${fmtK(json.usage.input || 0)} in • ${fmtK(json.usage.output || 0)} out`;
  roundHolder.appendChild(u);
}
```

…with CSS in `hermes.css`: `.msg-usage { font-size: 10px; color: var(--hermes-faint); margin-top: 4px; }` — and adapt the field names to what the bridge actually emits (read the bridge mapping found in Step 1; do not guess).

- [ ] **Step 3: Commit** (either the feature or the documented drop)

```bash
git add -A && git commit -m "feat(hermes): token-usage line (or: docs note — no usage source, dropped per spec)"
```

### Task 13: Attribution + docs

**Files:**
- Modify: `frontend-vendor/THIRD-PARTY.md`
- Modify: `README.md` (one line in the features/UI section)

- [ ] **Step 1: Add to `frontend-vendor/THIRD-PARTY.md`**

```markdown
## hermes-webui (design reference)

The "Hermes" visual style (theme palettes, component shapes, workspace
explorer layout) is adapted from
[nesquena/hermes-webui](https://github.com/nesquena/hermes-webui)
(MIT License), commit `e8d71a2`. No source files are copied or imported at
runtime — palette values and layout conventions were adapted into
`frontend-overrides/hermes.css` and `frontend-overrides/js/theme.js`.
```

- [ ] **Step 2: README** — in the UI/features section, add a line: `- Hermes-style UI: 4 theme colorways, date-grouped sidebar, read-only workspace file explorer (adapted from nesquena/hermes-webui, MIT).`

- [ ] **Step 3: Commit**

```bash
git add frontend-vendor/THIRD-PARTY.md README.md
git commit -m "docs(hermes): attribution + README note"
```

### Task 14: Final verification + live activation (user-gated)

- [ ] **Step 1: Full backend suite**

Run: `python3 -m pytest backend/tests -q` → all green.

- [ ] **Step 2: Public-repo hygiene**

Run: `bash scripts/prepare-public.sh` ONLY IF the user asks to publish; otherwise just run its private-identifier scan portion if separable, or: `grep -rn "bicolor-triceratops\|wistia\|Gary" frontend-overrides/ backend/workspace_files.py | grep -v __AGENT_NAME__` → expected: no hits in the new/changed files.

- [ ] **Step 3: Fresh-clone smoke (CI parity)**

Run: `bash smoke.sh` (or the repo's documented smoke entry) → passes.

- [ ] **Step 4: STOP — ask the user before the one restart**

The Phase-3 backend (workspace endpoints) and any backend changes are NOT live until the LaunchAgent restarts. Ask the user to approve:

```bash
launchctl kickstart -k gui/$(id -u)/ai.openclaw.workspace
```

Budget 2–5 minutes of cold start (2014 mini; don't retry-restart, don't restart the gateway). Then verify live at `http://bespin.bicolor-triceratops.ts.net:8800/`:
- explorer pane appears with the real workspace tree + branch badge; ⟳, preview, download, collapse/reopen work; footer path line now shows
- one short chat turn end-to-end (stream, tool pill, stop button)
- iOS Safari: drawer + strip OK, explorer hidden
- theme picker: 4 Hermes swatches + 3 legacy themes sane

- [ ] **Step 5: Final commit/tag if anything was touched in verification**

```bash
git add -A && git commit -m "chore(hermes): post-activation fixes from live smoke" || true
```

---

## Self-review notes (already applied)

- Spec coverage: Phase 1 → Tasks 1–3; Phase 2 → Tasks 4–7; Phase 3 → Tasks 8–10; Phase 4 → Tasks 11–12; attribution/rollout → Tasks 13–14. Footer action row consciously omitted per spec's omit-if-absent rule (documented in Task 7).
- The spec's "hide the rail via CSS" became "move `#icon-rail` into the sidebar + CSS fallback class" — refined during planning because overlay scripts (cron.js etc.) append buttons to `#icon-rail` at runtime; moving the element keeps them working. Spec intent (escape hatch + no rewrite) preserved.
- Conditional features (usage line, active-row class name, `#chat-box` id) carry explicit probe commands + decision rules, not placeholders.
