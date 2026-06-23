// Library document editor — Toast UI Editor (vendored) mounted in a persistent
// full-screen overlay appended to <body>, OUTSIDE #oc-root, so app.js's
// innerHTML re-render never destroys it. Shown/hidden by onRender() (hooked into
// runtime.afterRender). Wired to the real document API:
//   POST   /api/document            {title, language, content}  -> {id, ...}
//   GET    /api/document/{id}        -> { current_content, title, ... }
//   PUT    /api/document/{id}        {content, title}            -> saved doc
//
// Content key on the backend is `current_content` (see backend/documents.py).

import { runtime } from './runtime.js';
import { apiGet, apiJson } from './api.js';
import { reload } from './index.js';

const CSS = '/static/js/vendor/toastui/toastui-editor.min.css';
const CSS_DARK = '/static/js/vendor/toastui/toastui-editor-dark.min.css';
const JS = '/static/js/vendor/toastui/toastui-editor-all.min.js';

let editor = null;     // Toast UI instance
let overlay = null;    // fixed overlay container
let titleEl = null;    // title <input>
let statusEl = null;   // "Saved"/"Saving…" hint
let loadingJs = null;  // in-flight script promise

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
  if (!st.docEditor) st.docEditor = { open: false, id: null, title: '', status: '' };
  return st.docEditor;
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
  overlay.style.cssText = 'position:fixed;inset:0;z-index:70;display:none;flex-direction:column;background:var(--bg,#15161a)';

  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--border,#2a2d33);flex:none';
  titleEl = document.createElement('input');
  titleEl.placeholder = 'Untitled document';
  titleEl.style.cssText = 'flex:1;min-width:0;background:transparent;border:none;outline:none;color:var(--fg,#e8eaed);font-size:16px;font-weight:600;font-family:var(--sans,sans-serif)';
  titleEl.addEventListener('input', () => { const d = docState(); if (d) d.title = titleEl.value; markDirty(); });
  statusEl = document.createElement('span');
  statusEl.style.cssText = 'font-size:12px;color:var(--faint,#8a8f98)';
  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save';
  saveBtn.style.cssText = 'height:30px;padding:0 14px;border-radius:8px;border:1px solid var(--border,#2a2d33);background:var(--teal,#4fe3d1);color:#06231f;font-weight:600;cursor:pointer';
  saveBtn.onclick = () => { if (runtime.actions && runtime.actions.saveDoc) runtime.actions.saveDoc(); };
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.title = 'Close (saves first)';
  closeBtn.style.cssText = 'height:30px;width:32px;border-radius:8px;border:1px solid var(--border,#2a2d33);background:transparent;color:var(--faint,#8a8f98);cursor:pointer';
  closeBtn.onclick = () => { if (runtime.actions && runtime.actions.closeDoc) runtime.actions.closeDoc(); };
  head.append(titleEl, statusEl, saveBtn, closeBtn);

  const host = document.createElement('div');
  host.style.cssText = 'flex:1;min-height:0';

  overlay.append(head, host);
  document.body.appendChild(overlay);

  editor = new window.toastui.Editor({
    el: host,
    height: '100%',
    initialEditType: 'markdown',
    previewStyle: 'vertical',
    usageStatistics: false,
    theme: 'dark',
  });
  editor.on('change', markDirty);
  return editor;
}

let dirtyTO = null;
function markDirty() {
  const d = docState();
  if (d) d.status = 'Unsaved';
  if (statusEl) statusEl.textContent = 'Unsaved';
  // debounced autosave
  clearTimeout(dirtyTO);
  dirtyTO = setTimeout(() => { if (runtime.actions && runtime.actions.saveDoc) runtime.actions.saveDoc(); }, 2500);
}

function onRender() {
  if (!overlay) return;
  const d = docState();
  overlay.style.display = (d && d.open) ? 'flex' : 'none';
}

export function initDocEditor() {
  const prev = runtime.afterRender;
  runtime.afterRender = () => { if (prev) prev(); onRender(); };
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
      try { editor.setMarkdown(content, false); } catch (_) {}
      runtime.render();
    } catch (_) { try { window.alert('Could not open the editor.'); } catch (e) {} }
  },

  // Save the current doc (also used by autosave + close).
  saveDoc: async () => {
    const d = docState();
    if (!d || !d.id || !editor) return;
    const content = (() => { try { return editor.getMarkdown(); } catch (_) { return ''; } })();
    const title = (titleEl && titleEl.value) || d.title || 'Untitled document';
    if (statusEl) statusEl.textContent = 'Saving…';
    try {
      await apiJson(`/api/document/${d.id}`, { content, title }, 'PUT');
      d.status = 'Saved';
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
    if (d.id && editor) { try { await actions.saveDoc(); } catch (_) {} }
    d.open = false;
    runtime.render();
    try { reload('library'); } catch (_) {} // refresh the list so new/renamed docs show
  },
};
