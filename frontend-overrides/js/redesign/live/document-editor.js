// Library document editor — Toast UI Editor (vendored) mounted in a persistent
// right-side dock appended to <body>, OUTSIDE #oc-root, so app.js's
// innerHTML re-render never destroys it. Shown/hidden by onRender() (hooked into
// runtime.afterRender). Width is user-resizable via a left-edge grabber and
// persisted in localStorage; body gets `.oc-doc-docked` so #oc-root reflows
// beside the dock. Below 640px viewport width the dock takes the full screen.
// Wired to the real document API:
//   POST   /api/document            {title, language, content}  -> {id, ...}
//   GET    /api/document/{id}        -> { current_content, title, ... }
//   PUT    /api/document/{id}        {content, title}            -> saved doc
//
// Content key on the backend is `current_content` (see backend/documents.py).

import { runtime } from './runtime.js';
import { apiGet, apiJson } from './api.js';
import { reload } from './index.js';
import { openImageOverlay } from './image-viewer.js';

const CSS = '/static/js/vendor/toastui/toastui-editor.min.css';
const CSS_DARK = '/static/js/vendor/toastui/toastui-editor-dark.min.css';
const JS = '/static/js/vendor/toastui/toastui-editor-all.min.js';

const LS_WIDTH = 'oc-doc-dock-width';
const DOCK_MIN = 360;
const DOCK_MAX_VW = 0.75; // cap width at 75vw
const DOCK_DEFAULT = 560;
const MOBILE_BP = 640;

let editor = null;     // Toast UI instance
let host = null;       // editor mount element
let overlay = null;    // fixed dock container
let titleEl = null;    // title <input>
let statusEl = null;   // "Saved"/"Saving…" hint
let flashEl = null;    // transient "Updated" chip
let loadingJs = null;  // in-flight script promise
let grabber = null;    // left-edge resize handle
let conflictBanner = null; // "This file changed on disk" banner
let watchWs = null;    // shared workspace-watch WebSocket
let watchWsReady = null; // Promise for the current connect attempt
let watchedPath = null;  // abs path currently subscribed for the open doc
let dirty = false;     // buffer has unsaved changes since last load/save
let suppressChange = false; // silence 'change' events fired by our own setMarkdown

// 'md' | 'wysiwyg' | 'preview' — tracked separately from Toast UI internals
let editorMode = 'md';
const MODE_BTNS = {}; // populated in ensureEditor

function injectCss(href) {
  if (document.querySelector(`link[data-tui="${href}"]`)) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet'; l.href = href; l.setAttribute('data-tui', href);
  document.head.appendChild(l);
}
function injectScript(src) {
  if (loadingJs) return loadingJs;
  loadingJs = new Promise((res, rej) => {
    if (document.querySelector(`script[data-tui="${src}"]`)) { res(); return; }
    const s = document.createElement('script');
    s.src = src; s.setAttribute('data-tui', src);
    s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
  return loadingJs;
}

function docState() {
  const st = runtime.state;
  if (!st) return null;
  if (!st.docEditor) st.docEditor = {
    open: false, id: null, title: '', status: '',
    wsPath: null, wsRootKey: null, wsMtimeNs: null, wsAbsPath: null,
    readOnly: false,
  };
  return st.docEditor;
}

// ---- shared workspace-watch WebSocket (silent reload on disk changes) -------

function watchWsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/api/workspace/watch`;
}

async function ensureWatchWs() {
  if (watchWs && watchWs.readyState === 1) return watchWs;
  if (watchWsReady) return watchWsReady;
  watchWsReady = new Promise((res) => {
    let ws;
    try { ws = new WebSocket(watchWsUrl()); }
    catch (_) { watchWsReady = null; res(null); return; }
    ws.onopen = () => { watchWs = ws; res(ws); };
    ws.onmessage = onWatchMessage;
    ws.onclose = () => {
      watchWs = null; watchWsReady = null;
      // If a doc is still open, reconnect after a short delay.
      const d = docState();
      if (d && d.open && d.wsAbsPath) setTimeout(() => subscribeWatch(d.wsAbsPath), 1500);
    };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  });
  return watchWsReady;
}

async function subscribeWatch(absPath) {
  if (!absPath) return;
  watchedPath = absPath;
  const ws = await ensureWatchWs();
  if (!ws || ws.readyState !== 1) return;
  try { ws.send(JSON.stringify({ action: 'subscribe', paths: [absPath] })); } catch (_) {}
}

function unsubscribeWatch(absPath) {
  if (!absPath || !watchWs || watchWs.readyState !== 1) return;
  try { watchWs.send(JSON.stringify({ action: 'unsubscribe', paths: [absPath] })); } catch (_) {}
  if (watchedPath === absPath) watchedPath = null;
}

function onWatchMessage(ev) {
  let msg = null;
  try { msg = JSON.parse(ev.data); } catch (_) { return; }
  if (!msg || msg.type !== 'file_changed') return;
  const d = docState();
  if (!d || !d.open || !d.wsAbsPath) return;
  if (msg.abs_path !== d.wsAbsPath) return;
  // Ignore echoes of our own save (mtime we already have).
  if (msg.mtime_ns && d.wsMtimeNs && msg.mtime_ns <= d.wsMtimeNs) return;
  handleExternalChange(msg.mtime_ns || 0);
}

// Capture the current caret and top-scroll so silent reload feels seamless.
function snapshotEditorCaret() {
  if (!editor) return null;
  try {
    const md = editor.getMarkdown();
    // Toast UI exposes an internal MarkdownEditor; grab caret line/ch when possible.
    const inst = editor.mdEditor && editor.mdEditor.editor;
    if (inst && inst.getSelection) {
      const sel = inst.getSelection();
      return { md, sel, mode: 'md' };
    }
    return { md, sel: null, mode: 'md' };
  } catch (_) { return null; }
}

function restoreEditorCaret(snap) {
  if (!snap || !editor) return;
  try {
    const inst = editor.mdEditor && editor.mdEditor.editor;
    if (inst && snap.sel && inst.setSelection) inst.setSelection(snap.sel.from, snap.sel.to);
  } catch (_) {}
}

async function handleExternalChange(newMtimeNs) {
  const d = docState();
  if (!d || !d.open || !d.wsPath) return;
  const qs = `path=${encodeURIComponent(d.wsPath)}&root_key=${encodeURIComponent(d.wsRootKey || 'workspace')}`;
  let text = '';
  let mtimeNs = newMtimeNs;
  try {
    const res = await fetch('/api/workspace/file?' + qs, { credentials: 'same-origin' });
    if (!res.ok) return;
    text = await res.text();
    const hdr = res.headers.get('X-Mtime-Ns');
    if (hdr) mtimeNs = parseInt(hdr, 10) || newMtimeNs;
  } catch (_) { return; }

  // Second-chance guard against duplicate inotify events for the same write.
  if (mtimeNs && d.wsMtimeNs && mtimeNs <= d.wsMtimeNs) return;

  if (!dirty) {
    // Buffer clean — silently reload with cursor preserved.
    const snap = snapshotEditorCaret();
    suppressChange = true;
    try { editor.setMarkdown(text, false); } catch (_) {}
    setTimeout(() => { suppressChange = false; }, 60);
    d.wsMtimeNs = mtimeNs;
    d.status = 'Saved';
    if (statusEl) statusEl.textContent = 'Saved';
    restoreEditorCaret(snap);
    flashChip('Updated');
    return;
  }

  // Buffer dirty — show a conflict banner and stash the incoming text so
  // the user can accept it in one click without another fetch.
  d._incoming = text;
  d._incomingMtimeNs = mtimeNs;
  showConflict();
}

// ---- transient "Updated" chip -----------------------------------------------

function flashChip(label) {
  if (!flashEl) return;
  flashEl.textContent = label;
  flashEl.style.opacity = '1';
  clearTimeout(flashChip._t);
  flashChip._t = setTimeout(() => { if (flashEl) flashEl.style.opacity = '0'; }, 1800);
}

// ---- conflict banner --------------------------------------------------------

function showConflict() {
  if (!conflictBanner) return;
  conflictBanner.style.display = 'flex';
}

function hideConflict() {
  if (conflictBanner) conflictBanner.style.display = 'none';
  const d = docState();
  if (d) { d._incoming = null; d._incomingMtimeNs = null; }
}

function acceptIncoming() {
  const d = docState();
  if (!d || d._incoming == null) { hideConflict(); return; }
  suppressChange = true;
  try { editor.setMarkdown(d._incoming, false); } catch (_) {}
  setTimeout(() => { suppressChange = false; }, 60);
  d.wsMtimeNs = d._incomingMtimeNs || d.wsMtimeNs;
  d.status = 'Saved';
  dirty = false;
  if (statusEl) statusEl.textContent = 'Saved';
  hideConflict();
  flashChip('Reloaded');
}

async function keepMineAndSave() {
  const d = docState();
  if (!d) { hideConflict(); return; }
  // Force-save: drop the if_mtime guard so we overwrite the newer disk copy.
  d.wsMtimeNs = null;
  hideConflict();
  if (runtime.actions && runtime.actions.saveDoc) runtime.actions.saveDoc();
}

function applyMode(mode) {
  editorMode = mode;
  if (!editor) return;
  if (mode === 'wysiwyg') {
    editor.changeMode('wysiwyg');
  } else {
    // switch back to markdown first if needed
    try { editor.changeMode('markdown'); } catch (_) {}
    // click the internal Write (index 0) or Preview (index 1) tab-item button
    const tabs = host ? host.querySelectorAll('.tab-item') : [];
    const idx = mode === 'preview' ? 1 : 0;
    if (tabs[idx]) tabs[idx].click();
  }
  // update button active styles
  for (const [m, btn] of Object.entries(MODE_BTNS)) {
    btn.style.background = m === mode ? 'var(--teal,#4fe3d1)' : 'transparent';
    btn.style.color = m === mode ? '#06231f' : 'var(--faint,#8a8f98)';
  }
}

// Build the overlay + Toast UI instance once (lazy).
async function ensureEditor() {
  if (editor) return editor;
  injectCss(CSS);
  injectCss(CSS_DARK);
  await injectScript(JS);
  if (!(window.toastui && window.toastui.Editor)) throw new Error('Toast UI failed to load');

  overlay = document.createElement('div');
  overlay.className = 'oc-doc-overlay';
  // Right-side dock: position:fixed on the right edge, full viewport height.
  // Width is set from localStorage (or DOCK_DEFAULT) and clamped on resize.
  // Mobile (<=MOBILE_BP) is handled in applyDockWidth().
  overlay.style.cssText = 'position:fixed;top:0;right:0;bottom:0;z-index:70;display:none;flex-direction:column;background:var(--bg,#15161a);border-left:1px solid var(--border,#2a2d33);box-shadow:-8px 0 24px rgba(0,0,0,0.35)';

  // Left-edge resize grabber (invisible strip, cursor changes on hover).
  grabber = document.createElement('div');
  grabber.className = 'oc-doc-grabber';
  grabber.style.cssText = 'position:absolute;top:0;bottom:0;left:-3px;width:6px;cursor:col-resize;z-index:1';
  grabber.addEventListener('pointerdown', onGrabberDown);
  overlay.appendChild(grabber);

  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid var(--border,#2a2d33);flex:none';

  titleEl = document.createElement('input');
  titleEl.placeholder = 'Untitled document';
  titleEl.style.cssText = 'flex:1;min-width:0;background:transparent;border:none;outline:none;color:var(--fg,#e8eaed);font-size:16px;font-weight:600;font-family:var(--sans,sans-serif)';
  titleEl.addEventListener('input', () => { const d = docState(); if (d) d.title = titleEl.value; markDirty(); });

  statusEl = document.createElement('span');
  statusEl.style.cssText = 'font-size:12px;color:var(--faint,#8a8f98);flex:none';

  // Transient "Updated" / "Reloaded" chip — fades in for ~1.8s after a silent
  // reload triggered by an external change (Gary editing the file).
  flashEl = document.createElement('span');
  flashEl.style.cssText = 'font-size:11px;font-weight:600;color:#06231f;background:var(--teal,#4fe3d1);border-radius:10px;padding:2px 8px;opacity:0;transition:opacity .18s ease;flex:none';

  // mode toggle: MD | Rich Text | Preview
  const modeSeg = document.createElement('div');
  modeSeg.style.cssText = 'display:flex;gap:2px;background:#1e2026;border-radius:8px;padding:3px;flex:none';
  for (const [m, label] of [['md','MD'],['wysiwyg','Rich Text'],['preview','Preview']]) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.style.cssText = 'height:24px;padding:0 10px;border-radius:6px;border:none;font-size:11px;font-weight:600;cursor:pointer;transition:background .1s,color .1s;background:transparent;color:var(--faint,#8a8f98)';
    btn.onclick = () => applyMode(m);
    MODE_BTNS[m] = btn;
    modeSeg.appendChild(btn);
  }

  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save';
  saveBtn.style.cssText = 'height:30px;padding:0 14px;border-radius:8px;border:1px solid var(--border,#2a2d33);background:var(--teal,#4fe3d1);color:#06231f;font-weight:600;cursor:pointer;flex:none';
  saveBtn.onclick = () => { if (runtime.actions && runtime.actions.saveDoc) runtime.actions.saveDoc(); };

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.title = 'Close (saves first)';
  closeBtn.style.cssText = 'height:30px;width:32px;border-radius:8px;border:1px solid var(--border,#2a2d33);background:transparent;color:var(--faint,#8a8f98);cursor:pointer;flex:none';
  closeBtn.onclick = () => { if (runtime.actions && runtime.actions.closeDoc) runtime.actions.closeDoc(); };

  head.append(titleEl, statusEl, flashEl, modeSeg, saveBtn, closeBtn);

  // Conflict banner: shows when the file changed on disk while we have
  // unsaved local edits. User picks: reload disk, or keep mine (force-save).
  conflictBanner = document.createElement('div');
  conflictBanner.style.cssText = 'display:none;align-items:center;gap:10px;padding:8px 16px;background:rgba(240,180,60,0.12);border-bottom:1px solid rgba(240,180,60,0.35);color:var(--fg,#e8eaed);font-size:13px;flex:none';
  const cbMsg = document.createElement('span');
  cbMsg.textContent = 'This file changed on disk while you were editing.';
  cbMsg.style.cssText = 'flex:1;min-width:0';
  const cbReload = document.createElement('button');
  cbReload.textContent = 'Reload disk';
  cbReload.style.cssText = 'height:26px;padding:0 10px;border-radius:6px;border:1px solid var(--border,#2a2d33);background:var(--teal,#4fe3d1);color:#06231f;font-weight:600;cursor:pointer';
  cbReload.onclick = acceptIncoming;
  const cbKeep = document.createElement('button');
  cbKeep.textContent = 'Keep mine';
  cbKeep.style.cssText = 'height:26px;padding:0 10px;border-radius:6px;border:1px solid var(--border,#2a2d33);background:transparent;color:var(--fg,#e8eaed);cursor:pointer';
  cbKeep.onclick = keepMineAndSave;
  conflictBanner.append(cbMsg, cbReload, cbKeep);

  host = document.createElement('div');
  host.style.cssText = 'flex:1;min-height:0;overflow:hidden';

  overlay.append(head, conflictBanner, host);
  document.body.appendChild(overlay);

  editor = new window.toastui.Editor({
    el: host,
    height: '100%',
    initialEditType: 'markdown',
    previewStyle: 'tab',
    usageStatistics: false,
    theme: 'dark',
  });
  editor.on('change', markDirty);

  // Hide the built-in Write/Preview tab-item buttons — our header seg drives mode.
  // Do it after a tick so the editor has rendered its DOM.
  setTimeout(() => {
    const tabBar = host.querySelector('.toastui-editor-tabs');
    if (tabBar) tabBar.style.display = 'none';
    applyMode('md'); // set initial active state on our buttons
  }, 0);

  return editor;
}

let dirtyTO = null;
function markDirty() {
  if (suppressChange) return; // our own reload/openDoc setMarkdown — not a user edit
  const d = docState();
  if (d && d.readOnly) return; // read-only files never autosave
  dirty = true;
  if (d) d.status = 'Unsaved';
  if (statusEl) statusEl.textContent = 'Unsaved';
  clearTimeout(dirtyTO);
  dirtyTO = setTimeout(() => { if (runtime.actions && runtime.actions.saveDoc) runtime.actions.saveDoc(); }, 2500);
}

function readSavedWidth() {
  const raw = parseInt(localStorage.getItem(LS_WIDTH) || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DOCK_DEFAULT;
}

function applyDockWidth(px) {
  if (!overlay) return;
  const isMobile = window.innerWidth <= MOBILE_BP;
  if (isMobile) {
    overlay.style.width = '100vw';
    document.documentElement.style.setProperty('--doc-dock-w', '0px');
    return;
  }
  const max = Math.max(DOCK_MIN, Math.floor(window.innerWidth * DOCK_MAX_VW));
  const clamped = Math.min(Math.max(px, DOCK_MIN), max);
  overlay.style.width = clamped + 'px';
  // Body padding uses this var — set to 0 on mobile so nothing shifts.
  document.documentElement.style.setProperty('--doc-dock-w', clamped + 'px');
  return clamped;
}

function onGrabberDown(e) {
  if (window.innerWidth <= MOBILE_BP) return;
  e.preventDefault();
  const startX = e.clientX;
  const startW = overlay.getBoundingClientRect().width;
  const onMove = (ev) => {
    // Dragging LEFT (smaller clientX) should GROW the dock.
    const next = startW + (startX - ev.clientX);
    applyDockWidth(next);
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    const w = overlay.getBoundingClientRect().width;
    try { localStorage.setItem(LS_WIDTH, String(Math.round(w))); } catch (_) {}
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function onRender() {
  if (!overlay) return;
  const d = docState();
  const isOpen = !!(d && d.open);
  overlay.style.display = isOpen ? 'flex' : 'none';
  if (isOpen) {
    applyDockWidth(readSavedWidth());
    document.body.classList.add('oc-doc-docked');
  } else {
    document.body.classList.remove('oc-doc-docked');
    document.documentElement.style.setProperty('--doc-dock-w', '0px');
  }
}

export function initDocEditor() {
  const prev = runtime.afterRender;
  runtime.afterRender = () => { if (prev) prev(); onRender(); };
  // Reclamp width + switch between docked/fullscreen when viewport crosses
  // the mobile breakpoint or the window shrinks below current dock width.
  window.addEventListener('resize', () => {
    const d = docState();
    if (d && d.open) applyDockWidth(readSavedWidth());
  });
}

export const actions = {
  // Library "+ New": create a blank doc, then open it.
  newDoc: async () => {
    try {
      const res = await apiJson('/api/document', { title: 'Untitled document', language: 'markdown', content: '' });
      const id = res && (res.id || res.doc_id);
      if (id) await actions.openDoc(id);
    } catch (_) { try { window.alert('Could not create document.'); } catch (e) {} }
  },

  // Open a document by id in the editor overlay.
  openDoc: async (id) => {
    if (!id) return;
    const d = docState();
    if (!d) return;
    try {
      await ensureEditor();
      let doc = {};
      try { doc = await apiGet(`/api/document/${id}`); } catch (_) { doc = {}; }
      const content = (doc && (doc.current_content != null ? doc.current_content : doc.content)) || '';
      const title = (doc && doc.title) || 'Untitled document';
      d.open = true; d.id = id; d.title = title; d.status = 'Saved';
      if (titleEl) titleEl.value = title;
      if (statusEl) statusEl.textContent = 'Saved';
      suppressChange = true;
      try { editor.setMarkdown(content, false); } catch (_) {}
      setTimeout(() => { suppressChange = false; }, 60);
      applyMode('md');
      runtime.render();
    } catch (_) { try { window.alert('Could not open the editor.'); } catch (e) {} }
  },

  // Open a workspace file by path (not a library doc id). rootKey selects which
  // allowlisted root (`workspace` by default). Anything outside `workspace` is
  // opened read-only — the backend refuses PUTs there and autosave is skipped.
  openWorkspaceFile: async (path, rootKey) => {
    if (!path) return;
    const rk = rootKey || 'workspace';
    // Binary files must NEVER reach the text editor: it shows garbage and
    // (before the backend guard) its autosave corrupted the file. Images open
    // in the fullscreen viewer; other binaries open in a new browser tab.
    const qs = `path=${encodeURIComponent(path)}&root_key=${encodeURIComponent(rk)}`;
    const url = '/api/workspace/file?' + qs;
    if (/\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i.test(path)) {
      openImageOverlay(url, path.split('/').pop() || path);
      return;
    }
    if (/\.(pdf|zip|gz|tar|tgz|mp3|mp4|mov|wav|m4a|webm|woff2?|ttf|otf|eot)$/i.test(path)) {
      try { window.open(url, '_blank', 'noopener'); } catch (_) {}
      return;
    }
    const d = docState();
    if (!d) return;
    try {
      await ensureEditor();
      let content = '';
      let mtimeNs = null;
      let absPath = null;
      try {
        const res = await fetch('/api/workspace/file?' + qs, { credentials: 'same-origin' });
        if (res.ok) {
          content = await res.text();
          const hdr = res.headers.get('X-Mtime-Ns');
          if (hdr) mtimeNs = parseInt(hdr, 10) || null;
        }
      } catch (_) {}
      // Absolute path — used as the WebSocket subscription key. Fetching the
      // roots list once gives us the base for `rk`; cheap and cached client-side.
      try {
        const rr = await fetch('/api/workspace/roots', { credentials: 'same-origin' });
        if (rr.ok) {
          const rd = await rr.json();
          const base = (rd.roots || []).find((r) => r.key === rk);
          if (base && base.path) absPath = base.path.replace(/\/+$/, '') + '/' + path;
        }
      } catch (_) {}
      const name = path.split('/').pop() || path;
      const readOnly = rk !== 'workspace';
      // Tear down any prior subscription before switching docs.
      if (d.wsAbsPath && d.wsAbsPath !== absPath) unsubscribeWatch(d.wsAbsPath);
      d.open = true; d.id = null; d.wsPath = path; d.wsRootKey = rk;
      d.wsMtimeNs = mtimeNs; d.wsAbsPath = absPath;
      d.readOnly = readOnly;
      d.title = name; d.status = readOnly ? 'Read-only' : 'Saved';
      dirty = false;
      hideConflict();
      if (titleEl) { titleEl.value = name; titleEl.readOnly = true; }
      if (statusEl) statusEl.textContent = d.status;
      suppressChange = true;
      try { editor.setMarkdown(content, false); } catch (_) {}
      setTimeout(() => { suppressChange = false; }, 60);
      applyMode('md');
      if (!readOnly && absPath) subscribeWatch(absPath);
      runtime.render();
    } catch (_) { try { window.alert('Could not open the file.'); } catch (e) {} }
  },

  // Save the current doc (also used by autosave + close).
  saveDoc: async () => {
    const d = docState();
    if (!d || !editor) return;
    // Read-only files (outside the workspace root) never round-trip through
    // the write endpoint — the backend would refuse it anyway.
    if (d.readOnly) { if (statusEl) statusEl.textContent = 'Read-only'; return; }
    const content = (() => { try { return editor.getMarkdown(); } catch (_) { return ''; } })();
    const title = (titleEl && titleEl.value) || d.title || 'Untitled document';
    if (statusEl) statusEl.textContent = 'Saving…';
    try {
      if (d.wsPath) {
        const body = { path: d.wsPath, content };
        if (d.wsMtimeNs != null) body.if_mtime_ns = d.wsMtimeNs;
        const res = await fetch('/api/workspace/file', {
          method: 'PUT', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.status === 409) {
          // Someone else won the race. Fetch the winning content and let the
          // user pick (Reload disk / Keep mine).
          try {
            const qs = `path=${encodeURIComponent(d.wsPath)}&root_key=${encodeURIComponent(d.wsRootKey || 'workspace')}`;
            const r2 = await fetch('/api/workspace/file?' + qs, { credentials: 'same-origin' });
            if (r2.ok) {
              d._incoming = await r2.text();
              const hdr = r2.headers.get('X-Mtime-Ns');
              d._incomingMtimeNs = hdr ? parseInt(hdr, 10) : null;
            }
          } catch (_) {}
          if (statusEl) statusEl.textContent = 'Conflict';
          showConflict();
          return;
        }
        if (res.ok) {
          const j = await res.json().catch(() => ({}));
          if (j && j.mtime_ns) d.wsMtimeNs = j.mtime_ns;
        } else {
          // Non-ok, non-409 (e.g. a 500/502/503 restart blip — this branch
          // uses raw fetch, which never throws on an HTTP error status).
          // Leave `dirty` set so the next autosave tick / close-doc retries
          // instead of silently losing the edit under a "Saved" label.
          if (statusEl) statusEl.textContent = 'Save failed';
          return;
        }
      } else if (d.id) {
        // Raw fetch, not apiJson: apiJson (api.js) deliberately resolves
        // rather than throws on 502/503 (routine restart blips get treated
        // as success by most callers), which would otherwise fall through to
        // the 'Saved' line below on a save that never actually landed.
        // Checking res.ok directly here catches that case too.
        const res = await fetch(`/api/document/${d.id}`, {
          method: 'PUT', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content, title }),
        });
        if (!res.ok) {
          if (statusEl) statusEl.textContent = 'Save failed';
          return;
        }
      } else {
        return;
      }
      d.status = 'Saved';
      dirty = false;
      if (statusEl) statusEl.textContent = 'Saved';
    } catch (_) {
      if (statusEl) statusEl.textContent = 'Save failed';
    }
  },

  // Close the editor (saving first), then refresh the Library list.
  closeDoc: async () => {
    const d = docState();
    if (!d) return;
    clearTimeout(dirtyTO);
    if ((d.id || d.wsPath) && !d.readOnly && editor) { try { await actions.saveDoc(); } catch (_) {} }
    const wasLibraryDoc = !!d.id;
    if (d.wsAbsPath) unsubscribeWatch(d.wsAbsPath);
    d.open = false; d.wsPath = null; d.wsAbsPath = null; d.wsMtimeNs = null;
    d.wsRootKey = null; d.readOnly = false;
    dirty = false;
    hideConflict();
    if (titleEl) titleEl.readOnly = false;
    runtime.render();
    if (wasLibraryDoc) { try { reload('library'); } catch (_) {} }
  },
};
