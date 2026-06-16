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
  let resizing = false;          // true during a width-drag — suppresses the per-render fit storm

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
  function activeKey() { return curSession() || 'global'; }
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
    if (p.term) p.term.reset();
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
    p.term = null; p.fit = null;
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
    const activeId = activeKey();
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
        if (!resizing) setTimeout(() => fitPanel(p), 30);
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
      dragging = true; resizing = true; startX = e.clientX; startW = p.el.getBoundingClientRect().width;
      e.preventDefault(); document.body.style.userSelect = 'none';
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      p.width = Math.max(MIN_W, Math.min(MAX_W, startW + (startX - e.clientX)));
      render();
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false; resizing = false; document.body.style.userSelect = '';
      saveWidth(p.id, p.width); fitPanel(p);
    });
  }

  // ---- follow active chat (re-render on chat switch; pinned stay) ----
  let lastActive = null;
  function startFollow() {
    if (followTimer) return;
    followTimer = setInterval(() => {
      const id = activeKey();
      if (id !== lastActive) { lastActive = id; render(); }
    }, 800);
  }

  // ---- boot ----
  async function boot() {
    buildPill();
    // Recreate pinned panels so they persist across reloads. Await term build
    // BEFORE render()/connect, or the replayed scrollback arrives before the
    // term exists and is dropped.
    await Promise.all(pinOrder.slice().map(async (id) => {
      const p = createPanel(id);
      await ensureTermBuilt(p);
    }));
    render();
    startFollow();
  }

  window.workspaceTerminal = { openActive, togglePill };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
