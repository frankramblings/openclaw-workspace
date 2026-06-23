// Live per-chat terminal (PTY over WebSocket), wired into the redesign's
// full-rerender model via a PERSISTENT OVERLAY: one xterm instance lives in a
// position:fixed container appended to <body> (outside #oc-root, so render()'s
// innerHTML rebuild never destroys it). After each render we find the visible
// `[data-term-mount]` placeholder and move the overlay to cover its rect; if no
// terminal pane is showing, we hide it. Reuses the app's vendored xterm.
//
// Protocol (same as workspace-terminal.js): WS /api/terminal/{key}/stream,
// in: {type:'input',data} {type:'resize',cols,rows} ; out: {type:'output',data}
// {type:'exit',code}. key = active chat session id, or 'global' for unsaved.

import { runtime } from './runtime.js';

const VENDOR = '/static/js/vendor/xterm/';

let booted = false;
let loadingXterm = null;
let term = null, fit = null, overlay = null, screen = null;
let ws = null, currentKey = null;
let lastRect = null, fitTO = null;

function injectCss(href) {
  if (document.querySelector(`link[data-xt="${href}"]`)) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet'; l.href = href; l.setAttribute('data-xt', href);
  document.head.appendChild(l);
}
function injectScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[data-xt="${src}"]`)) { res(); return; }
    const s = document.createElement('script');
    s.src = src; s.setAttribute('data-xt', src);
    s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
}
async function ensureXterm() {
  if (window.Terminal && window.FitAddon) return;
  if (!loadingXterm) {
    loadingXterm = (async () => {
      injectCss(VENDOR + 'xterm.css');
      injectCss(VENDOR + 'wt-fonts.css');
      if (!window.Terminal) await injectScript(VENDOR + 'xterm.js');
      if (!window.FitAddon) await injectScript(VENDOR + 'addon-fit.js');
    })();
  }
  await loadingXterm;
}

async function buildTerm() {
  await ensureXterm();
  if (term) return;
  overlay = document.createElement('div');
  overlay.id = 'oc-term-overlay';
  // z-index 45 sits above the mobile companion sheet (41) so the terminal shows
  // inside it; on desktop nothing else occupies the companion pane region.
  overlay.style.cssText = 'position:fixed;z-index:45;display:none;overflow:hidden;background:#15161a;padding:8px 10px 6px;box-sizing:border-box';
  screen = document.createElement('div');
  screen.style.cssText = 'width:100%;height:100%';
  overlay.appendChild(screen);
  document.body.appendChild(overlay);

  term = new window.Terminal({
    allowProposedApi: true,
    cursorBlink: true,
    fontSize: 12,
    fontFamily: "'JetBrains Mono NF','JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace",
    scrollback: 5000,
    theme: {
      background: '#15161a', foreground: '#cfd3da', cursor: '#4fe3d1',
      cursorAccent: '#15161a', selectionBackground: 'rgba(79,227,209,.28)',
      black: '#15161a', red: '#f0726a', green: '#5bd97f', yellow: '#e8c268',
      blue: '#7bb6ff', magenta: '#a99bf5', cyan: '#4fe3d1', white: '#dfe2e8',
      brightBlack: '#5f636d', brightWhite: '#ffffff',
    },
  });
  fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(screen);
  term.onData((d) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data: d })); });
}

function connect(key) {
  if (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} ws = null; }
  currentKey = key;
  if (term) term.reset();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  try {
    ws = new WebSocket(`${proto}://${location.host}/api/terminal/${encodeURIComponent(key)}/stream`);
  } catch (e) { return; }
  ws.onopen = () => doFit();
  ws.onmessage = (ev) => {
    if (!term) return;
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.type === 'output') term.write(m.data);
    else if (m.type === 'exit') {
      term.write(`\r\n\x1b[2m[process exited${m.code != null ? ' (' + m.code + ')' : ''}] — reopen the terminal to start a new shell\x1b[0m\r\n`);
    }
  };
  ws.onclose = () => {};
  ws.onerror = () => {};
}

function doFit() {
  if (!fit || !term) return;
  try {
    fit.fit();
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  } catch (e) {}
}

function hide() { if (overlay) overlay.style.display = 'none'; }

// Called after every app render (and on window resize).
async function onRender() {
  const mount = document.querySelector('[data-term-mount]');
  if (!mount || mount.offsetParent === null) { hide(); return; }
  if (!term) { try { await buildTerm(); } catch (e) { return; } }

  const r = mount.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) { hide(); return; }

  overlay.style.display = 'block';
  const moved = !lastRect || r.left !== lastRect.left || r.top !== lastRect.top
    || r.width !== lastRect.width || r.height !== lastRect.height;
  overlay.style.left = r.left + 'px';
  overlay.style.top = r.top + 'px';
  overlay.style.width = r.width + 'px';
  overlay.style.height = r.height + 'px';
  lastRect = { left: r.left, top: r.top, width: r.width, height: r.height };

  const key = (runtime.state && runtime.state.live && runtime.state.live.chat && runtime.state.live.chat.activeId) || 'global';
  if (!ws || key !== currentKey) connect(key);

  if (moved) { clearTimeout(fitTO); fitTO = setTimeout(doFit, 50); }
}

export function initTerminal() {
  if (booted) return;
  booted = true;
  // hook into the render loop (app.js render() calls runtime.afterRender())
  const prev = runtime.afterRender;
  runtime.afterRender = () => { if (prev) prev(); onRender(); };
  window.addEventListener('resize', () => { if (overlay && overlay.style.display !== 'none') onRender(); });
  onRender();
}
