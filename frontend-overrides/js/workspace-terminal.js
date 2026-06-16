// HERMES: attached terminal panel — a right-side resizable pane (mirrors the
// workspace-explorer pane) holding a real interactive PTY for the ACTIVE chat
// session, streamed over a loopback + Serve-guarded WebSocket. cwd = workspace
// root. Self-contained overlay: injects its own rail button + panel DOM and
// lazily loads vendored xterm.js. Tolerant of a backend without /api/terminal
// (the WS fails to open; the pane shows a notice). PR1 = human-interactive only.
// Spec: docs/superpowers/specs/2026-06-16-attached-terminal-design.md
(function () {
  const LS_WIDTH = 'hermes-terminal-width';
  const VENDOR = '/static/js/vendor/xterm/';
  let term = null, fit = null, ws = null, sessionKey = null, followTimer = null;

  function curSession() {
    try {
      return (window.sessionModule && window.sessionModule.getCurrentSessionId)
        ? window.sessionModule.getCurrentSessionId() : null;
    } catch (e) { return null; }
  }

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

  function buildDom() {
    if (document.getElementById('workspace-terminal')) return;
    const rail = document.getElementById('icon-rail');
    if (rail && !document.getElementById('rail-terminal')) {
      const b = document.createElement('button');
      b.className = 'icon-rail-btn'; b.id = 'rail-terminal'; b.title = 'Terminal';
      b.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" '
        + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" '
        + 'stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/>'
        + '<line x1="12" y1="19" x2="20" y2="19"/></svg>';
      b.addEventListener('click', toggle);
      rail.appendChild(b);
    }
    const aside = document.createElement('aside');
    aside.id = 'workspace-terminal'; aside.hidden = true;
    aside.setAttribute('aria-label', 'Attached terminal');
    aside.innerHTML =
      '<div class="wt-resize" id="wt-resize"></div>' +
      '<header class="wt-head">' +
        '<span class="wt-title">Terminal</span>' +
        '<span class="wt-cwd" id="wt-cwd"></span>' +
        '<span class="wt-spacer"></span>' +
        '<button class="wt-btn" id="wt-restart" title="Restart shell">↻</button>' +
        '<button class="wt-btn" id="wt-close" title="Close panel">✕</button>' +
      '</header>' +
      '<div class="wt-screen" id="wt-screen"></div>' +
      '<div class="wt-status" id="wt-status" hidden></div>';
    document.body.appendChild(aside);
    const w = parseInt(localStorage.getItem(LS_WIDTH) || '', 10);
    if (w > 360 && w < 1100) aside.style.width = w + 'px';
    document.getElementById('wt-close').addEventListener('click', hide);
    document.getElementById('wt-restart').addEventListener('click', restart);
    wireResize(aside);
  }

  function wsUrl(key) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return proto + '://' + location.host + '/api/terminal/' + encodeURIComponent(key) + '/stream';
  }
  function status(msg) {
    const s = document.getElementById('wt-status');
    if (!s) return;
    s.textContent = msg || ''; s.hidden = !msg;
  }
  function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

  function disconnect() {
    if (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} ws = null; }
  }
  function connect(key) {
    disconnect();
    sessionKey = key;
    status('');
    try { ws = new WebSocket(wsUrl(key)); } catch (e) { status('terminal unavailable'); return; }
    ws.onopen = () => { status(''); fitAndResize(); };
    ws.onmessage = (ev) => {
      if (!term) return;  // defense in depth: never write before the terminal is built
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === 'output') term.write(m.data);
      else if (m.type === 'exit') {
        term.write('\r\n\x1b[2m[process exited'
          + (m.code != null ? ' (' + m.code + ')' : '') + '] — press ↻ to restart\x1b[0m\r\n');
      }
    };
    ws.onclose = () => { if (sessionKey === key) status('disconnected — reopen to reconnect'); };
    ws.onerror = () => status('terminal backend unavailable');
  }

  function fitAndResize() {
    if (!fit || !term) return;
    try { fit.fit(); } catch (e) {}
    send({ type: 'resize', cols: term.cols, rows: term.rows });
  }

  async function open() {
    buildDom();
    try { await ensureXterm(); } catch (e) { status('failed to load terminal assets'); show(); return; }
    if (!term) {
      term = new window.Terminal({
        cursorBlink: true, fontSize: 13,
        fontFamily: 'ui-monospace, Menlo, Monaco, monospace',
        theme: { background: '#0b0e14' },
      });
      fit = new window.FitAddon.FitAddon();
      term.loadAddon(fit);
      term.open(document.getElementById('wt-screen'));
      term.onData((d) => send({ type: 'input', data: d }));
    }
    if (!window.__workspaceRoot) {
      fetch('/api/config').then((r) => r.json()).then((c) => {
        window.__workspaceRoot = c.workspace_root;
        const el = document.getElementById('wt-cwd');
        if (el) el.textContent = c.workspace_root || '';
      }).catch(() => {});
    } else {
      const el = document.getElementById('wt-cwd');
      if (el) el.textContent = window.__workspaceRoot;
    }
    show();
    connect(curSession() || 'global');
    setTimeout(fitAndResize, 40);
    startFollow();
  }

  function show() {
    const a = document.getElementById('workspace-terminal');
    if (a) a.hidden = false;
    document.getElementById('rail-terminal')?.classList.add('active');
  }
  function hide() {
    const a = document.getElementById('workspace-terminal');
    if (a) a.hidden = true;
    document.getElementById('rail-terminal')?.classList.remove('active');
    stopFollow();
    disconnect();
  }
  function toggle() {
    const a = document.getElementById('workspace-terminal');
    if (!a || a.hidden) open(); else hide();
  }
  function restart() {
    if (!sessionKey) return;
    const key = sessionKey;
    fetch('/api/terminal/' + encodeURIComponent(key) + '/close', { method: 'POST' })
      .catch(() => {})
      .finally(() => { if (term) term.reset(); connect(key); setTimeout(fitAndResize, 40); });
  }

  // Follow the active chat: while the panel is open, reconnect if the user
  // switches chats (cheap 1.2s poll, only while visible).
  function startFollow() {
    stopFollow();
    followTimer = setInterval(() => {
      const a = document.getElementById('workspace-terminal');
      if (!a || a.hidden) return;
      const key = curSession() || 'global';
      if (key !== sessionKey) { if (term) term.reset(); connect(key); setTimeout(fitAndResize, 40); }
    }, 1200);
  }
  function stopFollow() { if (followTimer) { clearInterval(followTimer); followTimer = null; } }

  function wireResize(aside) {
    const h = aside.querySelector('#wt-resize');
    if (!h) return;
    let startX = 0, startW = 0, dragging = false;
    h.addEventListener('mousedown', (e) => {
      dragging = true; startX = e.clientX;
      startW = aside.getBoundingClientRect().width;
      e.preventDefault(); document.body.style.userSelect = 'none';
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      let w = startW + (startX - e.clientX);
      w = Math.max(360, Math.min(1100, w));
      aside.style.width = w + 'px';
      if (fit) { try { fit.fit(); } catch (_) {} }
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false; document.body.style.userSelect = '';
      try { localStorage.setItem(LS_WIDTH, String(Math.round(aside.getBoundingClientRect().width))); } catch (_) {}
      fitAndResize();
    });
  }

  window.workspaceTerminal = { open, hide, toggle };
  // Inject the rail button early so the user can launch the panel without it
  // having been opened first.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildDom, { once: true });
  else buildDom();
})();
