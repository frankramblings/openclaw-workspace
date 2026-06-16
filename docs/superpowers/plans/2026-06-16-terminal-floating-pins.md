# Floating Pinnable Terminals — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. TDD the pure layout module; `node --check` + manual smoke for the DOM manager. Checkbox steps.

**Goal:** Turn the single chat-following terminal overlay into a multi-panel manager: floating panels stacked on the right, chat reflows around them, each pinnable to persist across chats/tabs, launched from a floating pill above Files.

**Architecture:** A tiny pure module (`workspace-terminal-layout.js`, `window.WTLayout`) owns the stack ordering + offset math (unit-tested with `node --test`). `workspace-terminal.js` is rewritten from singletons into a panel registry keyed by chat id; each panel owns its xterm/WS/DOM; visibility + positions come from `WTLayout`; the chat reflows via `#chat-container { margin-right }`. Backend untouched.

**Tech stack:** plain-JS IIFE overlays (no module imports), vendored xterm; `node --test` for the pure module.

**Spec:** `docs/superpowers/specs/2026-06-16-terminal-floating-pins-design.md`

**Key facts (grounding):**
- Current `frontend-overrides/js/workspace-terminal.js` is a single-panel IIFE (singletons `term/fit/ws/sessionKey`, injects `#rail-terminal` + one `#workspace-terminal` aside, 1.2s follow poll, `#wt-gary` toggle).
- Explorer is a flex sibling (`hermes.css:300`, width 22%) → already reflows chat; Files pill `#we-reopen` (`hermes.css:351`, `fixed; right:10px; top:40px`); chat area `<main id="chat-container">` (`index.html:1089`); active chat id = `window.sessionModule.getCurrentSessionId()` (SPA id, = the PTY/WS key).
- Terminal CSS lives in `workspace.css:741+` (`#workspace-terminal { position:fixed; right:0 }`).
- ≤1100px: `hermes.css:309` hides explorer + Files pill (mobile).

**Test command (node is SLOW on this box — run as its own command, never chained before a git commit):**
`node --test frontend-overrides/js/__tests__/` and `node --check <file>`.
Git: work in worktree `frank/terminal-floating-pins`; if `index.lock` exists and no git proc runs, `rm -f` the lock.

## File structure
- **Create** `frontend-overrides/js/workspace-terminal-layout.js` — pure stack math (`computeStack`, `orderVisible`), UMD dual-export (`window.WTLayout` + `module.exports`).
- **Create** `frontend-overrides/js/__tests__/workspace-terminal-layout.test.js` — `node --test`.
- **Rewrite** `frontend-overrides/js/workspace-terminal.js` — the panel manager.
- **Modify** `frontend-overrides/workspace.css` — `.wt-panel`/pill/pin/kill styles, chat-margin, `#we-reopen` nudge; remove the old fixed `#workspace-terminal` block.
- **Modify** `frontend-overrides/index.html` — add the layout-module `<script>` before `workspace-terminal.js`.

---

### Task 1: Pure layout module (`WTLayout`) + tests

**Files:** Create `frontend-overrides/js/workspace-terminal-layout.js`, `frontend-overrides/js/__tests__/workspace-terminal-layout.test.js`.

- [ ] **Step 1 — write the failing test** `frontend-overrides/js/__tests__/workspace-terminal-layout.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const { computeStack, orderVisible } = require('../workspace-terminal-layout.js');

test('computeStack right-anchors with base offset and sums widths', () => {
  // ordered right->left: A (rightmost) then B then C (leftmost)
  const { positions, totalWidth } = computeStack(
    [{ id: 'A', width: 100 }, { id: 'B', width: 200 }, { id: 'C', width: 300 }], 50);
  assert.equal(positions.A, 50);          // base offset
  assert.equal(positions.B, 150);         // 50 + 100
  assert.equal(positions.C, 350);         // 50 + 100 + 200
  assert.equal(totalWidth, 600);          // excludes base offset
});

test('computeStack with no base offset', () => {
  const { positions, totalWidth } = computeStack([{ id: 'X', width: 400 }], 0);
  assert.equal(positions.X, 0);
  assert.equal(totalWidth, 400);
});

test('computeStack empty', () => {
  const { positions, totalWidth } = computeStack([], 0);
  assert.deepEqual(positions, {});
  assert.equal(totalWidth, 0);
});

test('orderVisible: pins right->left then active unpinned leftmost', () => {
  // pinnedRightToLeft index 0 = rightmost (oldest pin); active unpinned is leftmost
  assert.deepEqual(orderVisible(['A', 'B'], 'Z'), ['A', 'B', 'Z']);
  assert.deepEqual(orderVisible(['A'], null), ['A']);
  assert.deepEqual(orderVisible([], 'Z'), ['Z']);
  assert.deepEqual(orderVisible([], null), []);
});
```

- [ ] **Step 2 — run, expect fail:** `node --test frontend-overrides/js/__tests__/` → FAIL (cannot find module).

- [ ] **Step 3 — implement** `frontend-overrides/js/workspace-terminal-layout.js`:
```js
// HERMES: pure stack-layout math for the terminal manager. No DOM. Dual-export:
// window.WTLayout (browser <script>) + module.exports (node --test).
(function (factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.WTLayout = api;
})(function () {
  // orderedRightToLeft: [{id, width}] with index 0 = rightmost. baseOffset px
  // reserves space on the right (e.g. an open Files explorer). Returns each id's
  // CSS `right` px and the total terminal width (for the chat margin; excludes base).
  function computeStack(orderedRightToLeft, baseOffset) {
    const positions = {};
    let cum = baseOffset || 0;
    for (const p of orderedRightToLeft) {
      positions[p.id] = cum;
      cum += p.width;
    }
    return { positions, totalWidth: cum - (baseOffset || 0) };
  }

  // pinnedRightToLeft: id[] with index 0 = rightmost (oldest pin), end = leftmost
  // (newest pin). activeUnpinnedId (or null) sits leftmost of everything. Returns
  // the visible ids ordered right -> left.
  function orderVisible(pinnedRightToLeft, activeUnpinnedId) {
    const order = (pinnedRightToLeft || []).slice();
    if (activeUnpinnedId) order.push(activeUnpinnedId);
    return order;
  }

  return { computeStack, orderVisible };
});
```

- [ ] **Step 4 — run, expect pass:** `node --test frontend-overrides/js/__tests__/` → `# pass 5` (or all green).

- [ ] **Step 5 — commit:**
```bash
git add frontend-overrides/js/workspace-terminal-layout.js frontend-overrides/js/__tests__/workspace-terminal-layout.test.js
git commit -m "feat(terminal): pure WTLayout stack math + node tests"
```

---

### Task 2: Rewrite `workspace-terminal.js` into the panel manager

**Files:** Rewrite `frontend-overrides/js/workspace-terminal.js` (entire file).

- [ ] **Step 1 — replace the whole file** with:
```js
// HERMES: attached terminal MANAGER — floating, pinnable, chat-reflowing terminals.
// Each chat gets its own panel (xterm + PTY WS). Panels are position:fixed, stacked
// on the right edge; the chat reflows via #chat-container margin-right. Pinned panels
// persist across chats/tabs (hug right, stack rightward); the active chat's unpinned
// panel shows only while you're in that chat. Pure stack math = window.WTLayout
// (workspace-terminal-layout.js). Backend untouched.
// Spec: docs/superpowers/specs/2026-06-16-terminal-floating-pins-design.md
(function () {
  const VENDOR = '/static/js/vendor/xterm/';
  const LS_PINS = 'hermes-terminal-pins';
  const widthKey = (id) => 'hermes-terminal-width:' + id;
  const DEFAULT_W = 560, MIN_W = 360, MAX_W = 1100, NARROW = 1100;

  const panels = new Map();      // id -> Panel
  let pinOrder = loadPins();     // id[]; index 0 = rightmost (oldest pin), end = leftmost
  let followTimer = null;

  // ---- persistence ----
  function loadPins() {
    try { const a = JSON.parse(localStorage.getItem(LS_PINS) || '[]'); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function savePins() { try { localStorage.setItem(LS_PINS, JSON.stringify(pinOrder)); } catch (e) {} }
  function loadWidth(id) {
    const w = parseInt(localStorage.getItem(widthKey(id)) || '', 10);
    return (w >= MIN_W && w <= MAX_W) ? w : DEFAULT_W;
  }
  function saveWidth(id, w) { try { localStorage.setItem(widthKey(id), String(Math.round(w))); } catch (e) {} }

  // ---- helpers ----
  function curSession() {
    try {
      return (window.sessionModule && window.sessionModule.getCurrentSessionId)
        ? window.sessionModule.getCurrentSessionId() : null;
    } catch (e) { return null; }
  }
  function isNarrow() { return window.innerWidth <= NARROW; }
  function wsUrl(key) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return proto + '://' + location.host + '/api/terminal/' + encodeURIComponent(key) + '/stream';
  }
  function explorerWidth() {
    const ex = document.getElementById('workspace-explorer');
    if (!ex || ex.hidden) return 0;
    return ex.getBoundingClientRect().width || 0;
  }

  // ---- xterm vendor loading ----
  function injectCss(href) {
    if (document.querySelector('link[data-wt-css]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = href; l.setAttribute('data-wt-css', '1');
    document.head.appendChild(l);
  }
  function injectScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('load ' + src));
      document.head.appendChild(s);
    });
  }
  async function ensureXterm() {
    injectCss(VENDOR + 'xterm.css');
    if (!window.Terminal) await injectScript(VENDOR + 'xterm.js');
    if (!window.FitAddon) await injectScript(VENDOR + 'addon-fit.js');
  }

  // ---- Panel ----
  function createPanel(id) {
    const el = document.createElement('aside');
    el.className = 'wt-panel'; el.hidden = true;
    el.setAttribute('data-term-id', id);
    el.setAttribute('aria-label', 'Attached terminal');
    el.innerHTML =
      '<div class="wt-resize"></div>' +
      '<header class="wt-head">' +
        '<span class="wt-title">Terminal</span>' +
        '<span class="wt-cwd"></span>' +
        '<span class="wt-spacer"></span>' +
        '<button class="wt-btn wt-gary" title="Gary terminal control">Gary: …</button>' +
        '<button class="wt-btn wt-pin" title="Pin — keep this terminal on screen everywhere">📌</button>' +
        '<button class="wt-btn wt-restart" title="Restart shell">↻</button>' +
        '<button class="wt-btn wt-close" title="Close panel (keeps the shell running)">✕</button>' +
        '<button class="wt-btn wt-kill" title="End shell — terminate this terminal">🗑</button>' +
      '</header>' +
      '<div class="wt-screen"></div>' +
      '<div class="wt-status" hidden></div>';
    document.body.appendChild(el);
    const p = {
      id, el,
      screen: el.querySelector('.wt-screen'),
      statusEl: el.querySelector('.wt-status'),
      cwdEl: el.querySelector('.wt-cwd'),
      garyBtn: el.querySelector('.wt-gary'),
      pinBtn: el.querySelector('.wt-pin'),
      term: null, fit: null, ws: null,
      garyEffective: null,
      width: loadWidth(id),
      pinned: pinOrder.includes(id),
      open: false,
    };
    el.style.width = p.width + 'px';
    el.querySelector('.wt-close').addEventListener('click', () => closePanel(p));
    el.querySelector('.wt-kill').addEventListener('click', () => killPanel(p));
    el.querySelector('.wt-restart').addEventListener('click', () => restartPanel(p));
    p.pinBtn.addEventListener('click', () => togglePin(p));
    p.garyBtn.addEventListener('click', () => toggleGary(p));
    wireResize(p);
    panels.set(id, p);
    return p;
  }

  function statusOf(p, msg) { if (p.statusEl) { p.statusEl.textContent = msg || ''; p.statusEl.hidden = !msg; } }
  function sendTo(p, obj) { if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(obj)); }
  function fitPanel(p) {
    if (!p.fit || !p.term) return;
    try { p.fit.fit(); } catch (e) {}
    sendTo(p, { type: 'resize', cols: p.term.cols, rows: p.term.rows });
  }
  function setCwd(p) {
    if (window.__workspaceRoot) { p.cwdEl.textContent = window.__workspaceRoot; return; }
    fetch('/api/config').then((r) => r.json()).then((c) => {
      window.__workspaceRoot = c.workspace_root; p.cwdEl.textContent = c.workspace_root || '';
    }).catch(() => {});
  }
  async function ensureTermBuilt(p) {
    await ensureXterm();
    if (!p.term) {
      p.term = new window.Terminal({ cursorBlink: true, fontSize: 13,
        fontFamily: 'ui-monospace, Menlo, Monaco, monospace', theme: { background: '#0b0e14' } });
      p.fit = new window.FitAddon.FitAddon();
      p.term.loadAddon(p.fit);
      p.term.open(p.screen);
      p.term.onData((d) => sendTo(p, { type: 'input', data: d }));
    }
    setCwd(p);
  }

  function disconnectPanel(p) { if (p.ws) { try { p.ws.onclose = null; p.ws.close(); } catch (e) {} p.ws = null; } }
  function connectPanel(p) {
    disconnectPanel(p);
    statusOf(p, '');
    refreshGary(p);
    try { p.ws = new WebSocket(wsUrl(p.id)); } catch (e) { statusOf(p, 'terminal unavailable'); return; }
    p.ws.onopen = () => { statusOf(p, ''); fitPanel(p); };
    p.ws.onmessage = (ev) => {
      if (!p.term) return;
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === 'output') p.term.write(m.data);
      else if (m.type === 'exit') p.term.write('\r\n\x1b[2m[process exited'
        + (m.code != null ? ' (' + m.code + ')' : '') + '] — press ↻ to restart\x1b[0m\r\n');
    };
    p.ws.onclose = () => statusOf(p, 'disconnected — reopen to reconnect');
    p.ws.onerror = () => statusOf(p, 'terminal backend unavailable');
  }

  // ---- Gary toggle (per panel) ----
  function renderGary(p) {
    const b = p.garyBtn; if (!b) return;
    if (p.garyEffective === null) { b.textContent = 'Gary: …'; b.classList.remove('active'); b.style.color = ''; return; }
    b.textContent = 'Gary: ' + (p.garyEffective ? 'on' : 'off');
    b.classList.toggle('active', !!p.garyEffective);
    b.style.color = p.garyEffective ? '#7ee787' : '';
    b.title = p.garyEffective ? 'Gary can run commands here — click to turn off for this chat'
                              : 'Gary cannot run commands here — click to turn on for this chat';
  }
  function refreshGary(p) {
    p.garyEffective = null; renderGary(p);
    fetch('/api/terminal/gary-mode?session_key=' + encodeURIComponent(p.id))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('http ' + r.status))))
      .then((d) => { p.garyEffective = !!d.effective; renderGary(p); })
      .catch(() => {});
  }
  function toggleGary(p) {
    const next = !p.garyEffective;
    fetch('/api/terminal/gary-mode', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'session', session_key: p.id, enabled: next }) })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('http ' + r.status))))
      .then((d) => { p.garyEffective = !!d.effective; renderGary(p); })
      .catch(() => statusOf(p, 'could not change Gary terminal control'));
  }
  function renderPin(p) { p.pinBtn.classList.toggle('active', p.pinned); p.pinBtn.style.opacity = p.pinned ? '1' : '0.5'; }

  // ---- actions ----
  async function openActive() {
    const id = curSession() || 'global';
    let p = panels.get(id) || createPanel(id);
    p.open = true;
    await ensureTermBuilt(p);
    render();
  }
  function closePanel(p) {           // hide, KEEP shell alive
    p.open = false;
    if (p.pinned) { p.pinned = false; pinOrder = pinOrder.filter((x) => x !== p.id); savePins(); }
    disconnectPanel(p);
    render();
  }
  function killPanel(p) {            // terminate the PTY
    fetch('/api/terminal/' + encodeURIComponent(p.id) + '/close', { method: 'POST' }).catch(() => {});
    disconnectPanel(p);
    if (p.term) { try { p.term.dispose(); } catch (e) {} }
    p.el.remove();
    panels.delete(p.id);
    p.pinned = false; pinOrder = pinOrder.filter((x) => x !== p.id); savePins();
    render();
  }
  function restartPanel(p) {
    fetch('/api/terminal/' + encodeURIComponent(p.id) + '/close', { method: 'POST' })
      .catch(() => {})
      .finally(() => { if (p.term) p.term.reset(); connectPanel(p); setTimeout(() => fitPanel(p), 40); });
  }
  function togglePin(p) {
    p.pinned = !p.pinned;
    pinOrder = pinOrder.filter((x) => x !== p.id);
    if (p.pinned) pinOrder.push(p.id);   // newest pin -> leftmost of the pins
    savePins();
    render();
  }

  // ---- layout / render ----
  function visibleOrder(activeId) {
    const pins = pinOrder.filter((id) => panels.has(id));
    const a = panels.get(activeId);
    const activeUnpinned = (a && a.open && !a.pinned) ? activeId : null;
    return window.WTLayout.orderVisible(pins, activeUnpinned);
  }
  function render() {
    const activeId = curSession();
    const orderIds = isNarrow()
      ? (() => { const a = panels.get(activeId); return (a && (a.open || a.pinned)) ? [activeId] : []; })()
      : visibleOrder(activeId);
    const visible = new Set(orderIds);
    const base = isNarrow() ? 0 : explorerWidth();
    const items = orderIds.map((id) => ({ id, width: isNarrow() ? window.innerWidth : panels.get(id).width }));
    const { positions, totalWidth } = window.WTLayout.computeStack(items, base);
    for (const [id, p] of panels) {
      const vis = visible.has(id);
      p.el.hidden = !vis;
      if (vis) {
        p.el.classList.toggle('wt-narrow', isNarrow());
        p.el.style.right = (positions[id] || 0) + 'px';
        p.el.style.width = isNarrow() ? '100vw' : (p.width + 'px');
        if (!p.ws) connectPanel(p);
        setTimeout(() => fitPanel(p), 30);
      } else if (p.ws) {
        disconnectPanel(p);
      }
      renderPin(p);
    }
    const chat = document.getElementById('chat-container');
    if (chat) chat.style.marginRight = (!isNarrow() && totalWidth) ? totalWidth + 'px' : '';
    updatePill(visible, activeId);
  }

  // ---- launcher pill ----
  function buildPill() {
    if (document.getElementById('wt-launch')) return;
    const b = document.createElement('button');
    b.id = 'wt-launch'; b.title = 'Terminal';
    b.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
      + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/>'
      + '<line x1="12" y1="19" x2="20" y2="19"/></svg><span>Terminal</span>';
    b.addEventListener('click', togglePill);
    document.body.appendChild(b);
  }
  function updatePill(visible, activeId) {
    const b = document.getElementById('wt-launch'); if (!b) return;
    const a = panels.get(activeId);
    b.classList.toggle('active', !!(a && a.open && visible.has(activeId)));
  }
  function togglePill() {
    const id = curSession() || 'global';
    const p = panels.get(id);
    if (p && p.open) closePanel(p); else openActive();
  }

  // ---- resize (per panel) ----
  function wireResize(p) {
    const h = p.el.querySelector('.wt-resize');
    if (!h) return;
    let startX = 0, startW = 0, dragging = false;
    h.addEventListener('mousedown', (e) => {
      dragging = true; startX = e.clientX; startW = p.el.getBoundingClientRect().width;
      e.preventDefault(); document.body.style.userSelect = 'none';
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      p.width = Math.max(MIN_W, Math.min(MAX_W, startW + (startX - e.clientX)));
      render();
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false; document.body.style.userSelect = '';
      saveWidth(p.id, p.width); fitPanel(p);
    });
  }

  // ---- follow active chat (re-render on chat switch; pinned stay) ----
  let lastActive = null;
  function startFollow() {
    if (followTimer) return;
    followTimer = setInterval(() => {
      const id = curSession();
      if (id !== lastActive) { lastActive = id; render(); }
    }, 800);
  }

  // ---- boot ----
  function boot() {
    buildPill();
    // recreate pinned panels so they persist across reloads
    for (const id of pinOrder.slice()) {
      const p = createPanel(id);
      ensureTermBuilt(p);
    }
    render();
    startFollow();
  }

  window.workspaceTerminal = { openActive, togglePill };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
```

- [ ] **Step 2 — syntax check (own command):** `node --check frontend-overrides/js/workspace-terminal.js` → `SYNTAX OK` style (exit 0, no output).

- [ ] **Step 3 — self-review the transcription:** confirm ids/classes match the CSS task (`wt-panel`, `wt-resize`, `wt-head`, `wt-screen`, `wt-status`, `wt-cwd`, `wt-gary`, `wt-pin`, `wt-restart`, `wt-close`, `wt-kill`, `#wt-launch`), `WTLayout.computeStack/orderVisible` calls match Task 1, no leftover `#rail-terminal`/`#workspace-terminal` singletons.

- [ ] **Step 4 — commit:**
```bash
git add frontend-overrides/js/workspace-terminal.js
git commit -m "feat(terminal): rewrite into floating multi-panel manager (pin/stack/reflow)"
```

---

### Task 3: CSS — panels, pill, pin/kill, chat reflow

**Files:** Modify `frontend-overrides/workspace.css`.

- [ ] **Step 1 — replace the old fixed terminal block.** Find the block starting with `/* Attached terminal panel — right-side resizable pane (mirrors #workspace-explorer). */` and its `#workspace-terminal { ... }` rules (workspace.css:741+, through the `@media (max-width: 720px)` for it) and REPLACE the whole thing with:
```css
/* Attached terminal panels — floating, stacked, chat-reflowing (multi-panel manager). */
.wt-panel {
  position: fixed; top: 0; height: 100vh; width: 560px;
  display: flex; flex-direction: column;
  background: #0b0e14; color: #cdd6f4;
  border-left: 1px solid var(--border, #2a2f3a);
  z-index: 55; box-shadow: -8px 0 24px rgba(0, 0, 0, 0.35);
}
.wt-panel[hidden] { display: none; }
.wt-panel.wt-narrow { right: 0 !important; width: 100vw !important; }
.wt-panel .wt-resize {
  position: absolute; left: 0; top: 0; width: 6px; height: 100%; cursor: col-resize; z-index: 2;
}
.wt-panel .wt-head {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; font-size: 12px; border-bottom: 1px solid #2a2f3a;
}
.wt-panel .wt-title { font-weight: 600; }
.wt-panel .wt-cwd {
  opacity: 0.6; font-family: ui-monospace, Menlo, monospace;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px;
}
.wt-panel .wt-spacer { flex: 1; }
.wt-panel .wt-btn {
  background: none; border: none; color: inherit; cursor: pointer;
  font-size: 13px; padding: 2px 6px; border-radius: 4px;
}
.wt-panel .wt-btn:hover { background: rgba(255, 255, 255, 0.08); }
.wt-panel .wt-pin.active { color: #7ee787; }
.wt-panel .wt-kill:hover { background: rgba(243, 139, 168, 0.18); }
.wt-panel .wt-screen { flex: 1; min-height: 0; padding: 4px 6px; }
.wt-panel .wt-status { padding: 4px 10px; font-size: 12px; color: #f38ba8; }

/* Floating launcher pill — stacked just above the Files pill (#we-reopen). */
#wt-launch {
  position: fixed; right: 10px; top: 40px; z-index: 50;
  border: 1px solid var(--border); border-radius: var(--hermes-pill, 999px);
  background: var(--panel); color: var(--fg);
  font-size: 11px; padding: 4px 10px; cursor: pointer;
  display: inline-flex; align-items: center; gap: 5px;
}
#wt-launch.active { border-color: #7ee787; color: #7ee787; }
#wt-launch svg { display: block; }
@media (max-width: 1100px) { #wt-launch { display: none; } }
```

- [ ] **Step 2 — nudge the Files pill below the Terminal pill.** Append:
```css
/* Stack the Files pill (#we-reopen, hermes.css top:40px) below the Terminal pill. */
#we-reopen { top: 74px; }
```

- [ ] **Step 3 — verify (grep):**
```bash
grep -c "#workspace-terminal" frontend-overrides/workspace.css   # expect 0 (old block gone)
grep -c ".wt-panel" frontend-overrides/workspace.css             # > 0
grep -c "#wt-launch" frontend-overrides/workspace.css            # > 0
```

- [ ] **Step 4 — commit:**
```bash
git add frontend-overrides/workspace.css
git commit -m "feat(terminal): styles for floating panels, launcher pill, pin/kill"
```

---

### Task 4: Wire the layout module into the page

**Files:** Modify `frontend-overrides/index.html`.

- [ ] **Step 1 — add the layout `<script>` BEFORE the manager.** Find:
```html
  <script src="/static/js/workspace-terminal.js" defer></script>
```
Insert immediately BEFORE it (so `window.WTLayout` exists when the manager boots):
```html
  <script src="/static/js/workspace-terminal-layout.js" defer></script>
```
(Both are `defer`, so load order follows document order — layout first.)

- [ ] **Step 2 — verify:**
```bash
grep -n "workspace-terminal-layout.js\|workspace-terminal.js" frontend-overrides/index.html
```
Expected: `workspace-terminal-layout.js` appears on the line immediately before `workspace-terminal.js`.

- [ ] **Step 3 — commit:**
```bash
git add frontend-overrides/index.html
git commit -m "feat(terminal): include WTLayout module before the manager"
```

---

### Task 5: Manual smoke + deploy (user-gated)

> No headless Chrome on this box. Verification = `node --check`/`node --test` (done) + the user eyeballing on 8443.

- [ ] **Step 1 — sanity (own commands):** `node --test frontend-overrides/js/__tests__/` (green) and `node --check frontend-overrides/js/workspace-terminal.js` (exit 0).
- [ ] **Step 2 — deploy:** ff-merge `frank/terminal-floating-pins` → live branch; `bash scripts/sync-frontend.sh`; one workspace restart (`launchctl kickstart -k gui/501/ai.openclaw.workspace`); confirm `/api/health` 200. (User-gated restart.)
- [ ] **Step 3 — user eyeball on 8443 (hard-reload for new SW cache):**
  - The **Terminal pill** sits above the **Files** pill (top-right); click opens the active chat's terminal.
  - Resizing the terminal **reflows the chat** (chat shrinks/grows; no overlap).
  - **Pin** a terminal (📌) → switch chats → pinned stays hugging the right; open the new chat's terminal → it mounts to the **left** of the pinned one.
  - Open **Email/Inbox** → the pinned terminal **floats over** the right edge; return to a chat → unpinned active terminal reappears.
  - **✕ Close** hides a panel but the shell survives (reopen that chat → scrollback replays); **🗑 End shell** kills it; **unpin** returns a terminal to showing only in its own chat.
  - With Files explorer open, terminals sit to its left (no overlap).

---

## Self-review

- **Spec coverage:** §A launcher pill → Task 2 `buildPill`/`updatePill`/`togglePill` + Task 3 `#wt-launch` + `#we-reopen` nudge. §B panel manager + 3-action controls (pin/close-keep-alive/kill) → Task 2 `createPanel`/`closePanel`/`killPanel`/`togglePin`. §C fixed-stack + chat margin + explorer base offset → Task 1 `computeStack` + Task 2 `render`/`explorerWidth`. §D lifecycle (switch hides unpinned, pinned persist, narrow fallback) → Task 2 `render`/`visibleOrder`/`isNarrow`. Per-chat binding → panel keyed by `curSession()` id (= PTY key). Resize reflow → `wireResize`→`render`. Persisted pins/widths → `LS_PINS`/`widthKey`.
- **Placeholders:** none — full code for every code step; `node --test`/`node --check` commands with expected output.
- **Type/name consistency:** ids/classes (`wt-panel`, `wt-resize`, `wt-head`, `wt-screen`, `wt-status`, `wt-cwd`, `wt-gary`, `wt-pin`, `wt-restart`, `wt-close`, `wt-kill`, `#wt-launch`) match across Tasks 2–3; `WTLayout.computeStack(orderedRightToLeft, baseOffset)` and `orderVisible(pinnedRightToLeft, activeUnpinnedId)` signatures identical in Tasks 1 and 2; localStorage keys (`hermes-terminal-pins`, `hermes-terminal-width:<id>`) consistent.
