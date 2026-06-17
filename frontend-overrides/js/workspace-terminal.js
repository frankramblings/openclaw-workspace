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

  // Inline Lucide/Feather-style icons (stroke=currentColor, 24 viewBox) to match
  // the rest of the Hermes UI (chat.js/cron.js/emailInbox.js use the same style)
  // instead of emoji. Each reads as the action it performs.
  const _svg = (body, sz) => '<svg viewBox="0 0 24 24" width="' + (sz || 14) + '" height="' + (sz || 14) +
    '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + body + '</svg>';
  const IC = {
    pin: _svg('<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>'),
    // Match Odysseus's "Nobody" control: eye-open = saving (recorded),
    // eye-blinded (eye with an X) = incognito = not saved. Same paths as
    // #incognito-btn .eye-open / .eye-blinded in index.html.
    eyeOpen: _svg('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'),
    eyeBlinded: _svg('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><line x1="8" y1="16" x2="16" y2="8"/><line x1="8" y1="8" x2="16" y2="16"/>'),
    collapse: _svg('<path d="m6 17 5-5-5-5"/><path d="m13 17 5-5-5-5"/>'),
    kill: _svg('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>'),
    x: _svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>', 13),
  };

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
    if (document.querySelector('link[data-wt-css="' + href + '"]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = href; l.setAttribute('data-wt-css', href);
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
    injectCss(VENDOR + 'wt-fonts.css');
    if (!window.Terminal) await injectScript(VENDOR + 'xterm.js');
    if (!window.FitAddon) await injectScript(VENDOR + 'addon-fit.js');
    if (!window.WebglAddon) await injectScript(VENDOR + 'addon-webgl.js');
    if (!window.SearchAddon) await injectScript(VENDOR + 'addon-search.js');
    if (!window.WebLinksAddon) await injectScript(VENDOR + 'addon-web-links.js');
    if (!window.Unicode11Addon) await injectScript(VENDOR + 'addon-unicode11.js');
    if (!window.WTTermConfig) await injectScript('/static/js/workspace-terminal-config.js');
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
        '<button class="wt-btn wt-gary" title="__AGENT_NAME__ terminal control">__AGENT_NAME__: …</button>' +
        '<button class="wt-btn wt-pin" title="Pin — keep this terminal on screen everywhere">' + IC.pin + '</button>' +
        '<button class="wt-btn wt-persist" title="Saved history">' + IC.eyeOpen + '</button>' +
        '<button class="wt-btn wt-close" title="Collapse panel (keeps the shell running)">' + IC.collapse + '</button>' +
        '<button class="wt-btn wt-kill" title="End shell + erase saved history">' + IC.kill + '</button>' +
      '</header>' +
      '<div class="wt-screen"></div>' +
      '<div class="wt-find" hidden><input class="wt-find-input" type="text" placeholder="find" aria-label="Search terminal"><span class="wt-find-hint">↵ next · ⇧↵ prev · esc</span><button class="wt-find-close" title="Close search (Esc)" aria-label="Close search">' + IC.x + '</button></div>' +
      '<div class="wt-status" hidden></div>';
    document.body.appendChild(el);
    const p = {
      id, el,
      screen: el.querySelector('.wt-screen'),
      findBar: el.querySelector('.wt-find'),
      findInput: el.querySelector('.wt-find-input'),
      statusEl: el.querySelector('.wt-status'),
      cwdEl: el.querySelector('.wt-cwd'),
      garyBtn: el.querySelector('.wt-gary'),
      pinBtn: el.querySelector('.wt-pin'),
      persistBtn: el.querySelector('.wt-persist'),
      persistEnabled: null,
      term: null, fit: null, ws: null,
      garyEffective: null,
      width: loadWidth(id),
      pinned: pinOrder.includes(id),
      open: false,
    };
    el.style.width = p.width + 'px';
    el.querySelector('.wt-close').addEventListener('click', () => closePanel(p));
    el.querySelector('.wt-kill').addEventListener('click', () => killPanel(p));
    p.pinBtn.addEventListener('click', () => togglePin(p));
    p.persistBtn.addEventListener('click', () => togglePersist(p));
    refreshPersist(p);
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
      const opts = window.WTTermConfig.buildTermOptions(function (name) {
        return getComputedStyle(document.documentElement).getPropertyValue(name);
      });
      p.term = new window.Terminal(opts);

      p.fit = new window.FitAddon.FitAddon();
      p.term.loadAddon(p.fit);

      // Correct emoji/CJK cell width (requires allowProposedApi:true).
      p.term.loadAddon(new window.Unicode11Addon.Unicode11Addon());
      p.term.unicode.activeVersion = '11';

      // Clickable URLs + in-scrollback search (search box wired in Task 5).
      p.term.loadAddon(new window.WebLinksAddon.WebLinksAddon());
      p.search = new window.SearchAddon.SearchAddon();
      p.term.loadAddon(p.search);

      p.term.open(p.screen);

      p.term.attachCustomKeyEventHandler(function (ev) {
        if (ev.type === 'keydown' && (ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'f') {
          ev.preventDefault();
          p.findBar.hidden = false;
          p.findInput.focus();
          p.findInput.select();
          return false; // don't pass Ctrl/Cmd+F to the shell
        }
        return true;
      });
      p.findInput.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          const q = p.findInput.value;
          if (q) { ev.shiftKey ? p.search.findPrevious(q) : p.search.findNext(q); }
        } else if (ev.key === 'Escape') {
          p.findBar.hidden = true;
          p.term.focus();
        }
      });
      p.findBar.querySelector('.wt-find-close').addEventListener('click', function () {
        p.findBar.hidden = true;
        p.term.focus();
      });

      // GPU renderer — must load AFTER open(). Dispose on context loss so the
      // terminal silently falls back to the canvas/DOM renderer instead of dying.
      try {
        const webgl = new window.WebglAddon.WebglAddon();
        webgl.onContextLoss(function () { webgl.dispose(); });
        p.term.loadAddon(webgl);
      } catch (e) { /* webgl unavailable -> default renderer */ }

      p.term.onData((d) => sendTo(p, { type: 'input', data: d }));
      wireImageDrop(p);
    }
    setCwd(p);
  }

  // --- image drop / paste (per panel) ---------------------------------------
  // Drop or paste an image onto a terminal: upload it (same store as chat
  // attachments, inside the agent's vault), register a [name.ext] token for THIS
  // chat's terminal, and type the token at the cursor. The image auto-rides the
  // user's next chat turn; an in-terminal CLI resolves the token with `garyimg`.
  // (Ported from the concurrent image-drop feature onto the per-panel manager.)
  function isImageFile(f) {
    return (f.type && f.type.indexOf('image/') === 0)
      || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.name || '');
  }
  function imagesFrom(fileList) {
    return Array.prototype.slice.call(fileList || []).filter(isImageFile);
  }
  function uploadImage(file) {
    const fd = new FormData();
    fd.append('files', file, file.name || 'pasted-image.png');
    return fetch('/api/upload', { method: 'POST', body: fd })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('upload http ' + r.status))))
      .then((d) => (d.files && d.files[0]) || Promise.reject(new Error('no file')));
  }
  function attachToken(p, file, up) {
    return fetch('/api/terminal/' + encodeURIComponent(p.id) + '/attach', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: up.id, name: up.name || file.name || '', mime: file.type || '' }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('attach http ' + r.status))))
      .then((d) => d.token);
  }
  async function processImages(p, imgs) {
    if (!p.ws || p.ws.readyState !== 1) { statusOf(p, 'terminal not connected'); return; }
    for (const f of imgs) {
      statusOf(p, 'uploading image…');
      try {
        const up = await uploadImage(f);
        const token = await attachToken(p, f, up);
        sendTo(p, { type: 'input', data: token + ' ' });
        statusOf(p, '');
      } catch (e) { statusOf(p, 'image upload failed'); }
    }
  }
  function wireImageDrop(p) {
    const el = p.screen;
    if (!el || el.__wtImageWired) return;
    el.__wtImageWired = true;
    el.addEventListener('dragover', (e) => {
      const dt = e.dataTransfer;
      if (dt && Array.prototype.some.call(dt.items || [], (i) => i.kind === 'file')) e.preventDefault();
    });
    el.addEventListener('drop', (e) => {
      const imgs = imagesFrom(e.dataTransfer && e.dataTransfer.files);
      if (imgs.length) { e.preventDefault(); processImages(p, imgs); }
    });
    el.addEventListener('paste', (e) => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      const files = [];
      for (const it of items) { if (it.kind === 'file') { const f = it.getAsFile(); if (f) files.push(f); } }
      const imgs = files.filter(isImageFile);
      if (imgs.length) { e.preventDefault(); processImages(p, imgs); }
    });
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
        + (m.code != null ? ' (' + m.code + ')' : '') + '] — close and reopen this terminal to start a new shell\x1b[0m\r\n');
    };
    p.ws.onclose = () => statusOf(p, 'disconnected — reopen to reconnect');
    p.ws.onerror = () => statusOf(p, 'terminal backend unavailable');
  }

  // ---- Gary toggle (per panel) ----
  function renderGary(p) {
    const b = p.garyBtn; if (!b) return;
    if (p.garyEffective === null) { b.textContent = '__AGENT_NAME__: …'; b.classList.remove('active'); b.style.color = ''; return; }
    b.textContent = '__AGENT_NAME__: ' + (p.garyEffective ? 'on' : 'off');
    b.classList.toggle('active', !!p.garyEffective);
    b.style.color = p.garyEffective ? '#7ee787' : '';
    b.title = p.garyEffective ? '__AGENT_NAME__ can run commands here — click to turn off for this chat'
                              : '__AGENT_NAME__ cannot run commands here — click to turn on for this chat';
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
      .catch(() => statusOf(p, 'could not change __AGENT_NAME__ terminal control'));
  }
  function renderPersist(p) {
    const b = p.persistBtn; if (!b) return;
    if (p.persistEnabled === null) { b.innerHTML = IC.eyeOpen; b.classList.remove('active', 'wt-incognito'); b.title = 'Saved history'; return; }
    b.innerHTML = p.persistEnabled ? IC.eyeOpen : IC.eyeBlinded;
    b.classList.toggle('active', !!p.persistEnabled);
    b.classList.toggle('wt-incognito', !p.persistEnabled);
    b.title = p.persistEnabled
      ? 'Saved history ON — contents persist across reboots. Click to go incognito (stop saving + wipe).'
      : 'Incognito — this terminal is NOT being saved. Click to start saving.';
  }
  function refreshPersist(p) {
    fetch('/api/terminal/' + encodeURIComponent(p.id) + '/persist')
      .then((r) => r.json())
      .then((d) => { p.persistEnabled = !!d.enabled; renderPersist(p); })
      .catch(() => {});
  }
  function togglePersist(p) {
    const next = !p.persistEnabled;
    fetch('/api/terminal/' + encodeURIComponent(p.id) + '/persist', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    }).then((r) => r.json())
      .then((d) => { p.persistEnabled = !!d.enabled; renderPersist(p); })
      .catch(() => {});
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
    if (!confirm('End this terminal and erase its saved history?')) return;
    fetch('/api/terminal/' + encodeURIComponent(p.id) + '/clear-history', { method: 'POST' }).catch(() => {});
    fetch('/api/terminal/' + encodeURIComponent(p.id) + '/close', { method: 'POST' }).catch(() => {});
    disconnectPanel(p);
    if (p.term) { try { p.term.dispose(); } catch (e) {} }
    p.el.remove();
    p.term = null; p.fit = null;
    panels.delete(p.id);
    p.pinned = false; pinOrder = pinOrder.filter((x) => x !== p.id); savePins();
    render();
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
    buildLaunchers();  // idempotent — ensures the top-bar buttons exist if the bar rendered late
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

  // ---- launchers: in-flow buttons in the chat top-bar (NOT floating pills, which
  // covered the UI). Present in every chat → switch chats, click Terminal to open
  // THAT chat's terminal; Files toggles the workspace explorer.
  const TERM_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/>'
    + '<line x1="12" y1="19" x2="20" y2="19"/></svg>';
  const FILES_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
  function buildLaunchers() {
    const bar = document.querySelector('.chat-top-bar');
    if (!bar || document.getElementById('wt-launchers')) return;
    const wrap = document.createElement('span');
    wrap.id = 'wt-launchers'; wrap.className = 'wt-launchers';
    const t = document.createElement('button');
    t.id = 'wt-launch'; t.type = 'button'; t.className = 'wt-toolbar-btn';
    t.title = "Terminal — open this chat's terminal"; t.innerHTML = TERM_SVG;
    t.addEventListener('click', togglePill);
    const f = document.createElement('button');
    f.id = 'wt-files'; f.type = 'button'; f.className = 'wt-toolbar-btn';
    f.title = 'Files — toggle the workspace file explorer'; f.innerHTML = FILES_SVG;
    f.addEventListener('click', toggleFiles);
    wrap.appendChild(t); wrap.appendChild(f);
    bar.appendChild(wrap);
  }
  function toggleFiles() {
    // Drive the explorer via its own controls (no explorer code change): reopen
    // if collapsed, collapse if shown.
    const ex = document.getElementById('workspace-explorer');
    const reopen = document.getElementById('we-reopen');
    const collapse = document.getElementById('we-collapse');
    if (!ex || ex.hidden) { if (reopen) reopen.click(); }
    else if (collapse) { collapse.click(); }
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
    buildLaunchers();
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
