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
// Whether the mobile dock layout applies. Reads the JS shell latch stamped
// once at boot on <html> (see app.js's `_mobileLatched` / mobile-history.js's
// computeMobileLatch) instead of re-deriving mobile-ness from raw
// `window.innerWidth`. This used to compare live width against a 768px
// breakpoint independently of the shell's own latched decision — a
// latched-mobile iPhone rotated to landscape (>768px) would flip THIS dock
// back into desktop layout (fixed-width panel + resize grabber) while the
// rest of the shell (app.js) stayed on the mobile UI, splitting the two.
const isMobileShell = () => document.documentElement.classList.contains('shell-mobile');

let editor = null;     // Toast UI instance
let host = null;       // editor mount element
let overlay = null;    // fixed dock container
let titleEl = null;    // title <input>
let statusEl = null;   // "Saved"/"Saving…" hint
let flashEl = null;    // transient "Updated" chip
let saveBtn = null;    // Save button — disabled while the buffer failed to load
let loadingJs = null;  // in-flight script promise
let grabber = null;    // left-edge resize handle
let conflictBanner = null; // "This file changed on disk" banner
let errorBanner = null;    // "Couldn't load" / "Couldn't save on close" banner
let errorMsgEl = null;     // its message text
let errorActionsEl = null; // its action-buttons container
let watchWs = null;    // shared workspace-watch WebSocket
let watchWsReady = null; // Promise for the current connect attempt
let watchedPath = null;  // abs path currently subscribed for the open doc
let dirty = false;     // buffer has unsaved changes since last load/save
let suppressChange = false; // silence 'change' events fired by our own setMarkdown
let generation = 0;    // bumped by resetBufferIdentity — invalidates in-flight
                        // saves so their response can't mutate a since-switched-to buffer

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
    readOnly: false, loadFailed: false, saveFailed: false, attachDetached: false,
  };
  return st.docEditor;
}

// ---- pure decision helpers (exported for unit tests — no DOM/network) ------
//
// These are the single source of truth for "where does a save go" and
// "should we warn before the tab closes". Keeping them pure means the
// buffer-identity bugs this task fixes (a stale wsPath surviving into a
// Library-doc buffer, autosave running against a failed/blank load) show up
// as a wrong return value here under `node --test`, not just as a corrupted
// file discovered later.

/**
 * Decide where actions.saveDoc should write, given the current docState.
 * `wsPath` takes precedence over `id` when both are set on the same buffer —
 * but the real fix for the cross-write bug is that resetBufferIdentity()
 * clears the previous kind's fields before a new open ever sets the other,
 * so both should never legitimately be set at once (see its tests).
 */
export function saveTarget(d) {
  if (!d || !d.open) return { kind: 'none' };
  if (d.loadFailed) return { kind: 'none' };
  if (d.readOnly) return { kind: 'none' };
  if (d.wsPath) return { kind: 'ws', path: d.wsPath, mtimeNs: d.wsMtimeNs != null ? d.wsMtimeNs : null, rootKey: d.wsRootKey || 'workspace' };
  if (d.id) return { kind: 'doc', id: d.id };
  return { kind: 'none' };
}

/**
 * Clear every field that identifies "which buffer is open" and any leftover
 * per-buffer scratch state (conflict payload). openDoc and openWorkspaceFile
 * both call this FIRST, before setting their own kind's fields, so opening a
 * Library doc after a workspace file (or vice versa) can never inherit the
 * previous buffer's wsPath/id/readOnly/loadFailed.
 */
export function resetBufferIdentity(d) {
  if (!d) return d;
  generation++; // any save captured against the old generation is now stale
  d.id = null;
  d.wsPath = null; d.wsRootKey = null; d.wsMtimeNs = null; d.wsAbsPath = null;
  d.readOnly = false;
  d.loadFailed = false;
  d.attachDetached = false;
  d._incoming = null; d._incomingMtimeNs = null;
  return d;
}

/** beforeunload guard: warn while there's unsaved work that would be lost. */
export function shouldWarnBeforeUnload(d, isDirty) {
  return !!(d && d.open && (isDirty || d.saveFailed));
}

/**
 * Generation guard for an in-flight saveDoc() call: capture `makeSaveGuard(generation)`
 * before the network await(s), then after each await ask `guard.isStale(generation)`.
 * openDoc/openWorkspaceFile/closeDoc all funnel through resetBufferIdentity(), which
 * bumps the module generation counter on every buffer switch — so a stale guard means
 * the save's response no longer belongs to the buffer that's now open, and saveDoc must
 * skip every remaining state mutation (wsMtimeNs/status/dirty/hideError()/etc.) rather
 * than apply an old buffer's save result to a new one.
 */
export function makeSaveGuard(gen) {
  return { isStale: (nowGen) => nowGen !== gen };
}

// The Library document id a chat send should carry as active_doc_id, or
// null. Only a Library doc (saveTarget's 'doc' kind, never a workspace-file
// 'ws' buffer) that is open and hasn't been detached via the pill's ×.
export function libraryDocIdFor(d) {
  if (!d || d.attachDetached) return null;
  const target = saveTarget(d);
  return target.kind === 'doc' ? target.id : null;
}

// libraryDocIdFor bound to the live docState(): what chat.js calls.
export function activeLibraryDocId() {
  return libraryDocIdFor(docState());
}

// Spec 2.2: the pill's x detaches "for the next turn" only. Called once by
// chat.js's fireSend/keepaliveSend, right after they've already read
// activeLibraryDocId() for the send in progress: always leaves
// attachDetached false afterward, so the NEXT send re-attaches by default.
// Also called by Task 5's toolbar actions before they send, so a toolbar
// click always targets the open document even if the pill was detached.
export function consumeAttachDetach() {
  const d = docState();
  if (d) d.attachDetached = false;
}

// Markdown-mode selection: `sel` is Toast UI's NESTED [[startLine,startCh],
// [endLine,endCh]] pair (both 1-based) from mdEditor.editor.getSelection():
// NOT flat character offsets (see this task's "Correction from review").
// Converts by summing line lengths (+1 per newline) up to each line, then
// adding (ch - 1); a best-effort derivation against the raw markdown text,
// since Toast UI's own conversion runs through ProseMirror node structure
// internally that this does not replicate for nested block content (e.g.
// inside a list item): flag any observed drift during Task 6's manual
// verification. `selectedText`, when given (Toast UI's getSelectedText()),
// is used verbatim instead of slicing, which sidesteps that gap entirely.
export function selectionFromMarkdownEditor(markdown, sel, selectedText) {
  if (!Array.isArray(sel) || sel.length !== 2) return null;
  const [start, end] = sel;
  if (!Array.isArray(start) || !Array.isArray(end)) return null;
  const text = String(markdown || '');
  const lines = text.split('\n');
  const lineStart = []; // lineStart[i] = char offset where line i (0-based) begins
  let acc = 0;
  for (let i = 0; i < lines.length; i++) { lineStart[i] = acc; acc += lines[i].length + 1; }
  const offset = ([line, ch]) => (lineStart[Math.max(0, Math.min(line - 1, lines.length - 1))] || 0) + Math.max(0, ch - 1);
  const from = offset(start);
  const to = offset(end);
  if (from === to) return null; // collapsed selection
  const out = typeof selectedText === 'string' ? selectedText : text.slice(Math.min(from, to), Math.max(from, to));
  return out ? { text: out, from, to, mode: 'md', lines: [start[0], end[0]] } : null;
}

// Wysiwyg-mode selection: Toast UI's editor.getSelectedText() returns the
// selected plain text directly (no character-offset range in this mode).
export function selectionFromWysiwygText(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  return { text, from: null, to: null, mode: 'wysiwyg' };
}

// A doc_update SSE frame (backend/draft_mode.py's post_turn_payload shape:
// {type:'doc_update', doc_id, content, version, title, language}) applies
// only when it matches the Library doc currently open in the dock, AND
// carries a real string `content`. A malformed frame (missing/null/non-string
// content) must never reach applyExternalUpdate's editor.setMarkdown call,
// which would otherwise blank the open document.
export function shouldAcceptDocUpdate(d, frame) {
  return !!(d && d.open && d.id && !d.wsPath && frame
    && frame.type === 'doc_update' && frame.doc_id === d.id
    && typeof frame.content === 'string');
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

// Current editor selection, or null. Delegates to the pure helpers above so
// extraction is unit-tested without a real Toast UI instance; this wrapper
// only supplies live editor/editorMode module state.
export function getSelection() {
  if (!editor || editorMode === 'preview') return null;
  try {
    // Top-level Editor#getSelectedText() delegates to whichever mode editor
    // is current (confirmed in the vendored bundle) and returns the plain
    // selected string in both markdown and wysiwyg mode: preferred over
    // slicing when available, per selectionFromMarkdownEditor's contract.
    const selectedText = typeof editor.getSelectedText === 'function' ? editor.getSelectedText() : undefined;
    if (editorMode === 'wysiwyg') {
      return selectionFromWysiwygText(typeof selectedText === 'string' ? selectedText : '');
    }
    const inst = editor.mdEditor && editor.mdEditor.editor;
    if (!inst || !inst.getSelection) return null;
    return selectionFromMarkdownEditor(editor.getMarkdown(), inst.getSelection(), selectedText);
  } catch (_) { return null; }
}

// Apply an incoming doc_update frame. Mirrors handleExternalChange's
// clean/dirty split: a clean buffer silently reloads with caret preserved;
// a dirty buffer gets the same conflict banner an external disk change
// shows. Title/status mutate unconditionally so this is observable with no
// editor instance yet (e.g. in tests).
export function applyExternalUpdate(frame) {
  const d = docState();
  // shouldAcceptDocUpdate already requires frame.content to be a string, so a
  // malformed frame (missing/null/non-string content) never reaches the
  // editor at all: this is a plain no-op with no state change.
  if (!shouldAcceptDocUpdate(d, frame)) return;
  const content = frame.content;
  if (!dirty) {
    const snap = snapshotEditorCaret();
    suppressChange = true;
    try { if (editor) editor.setMarkdown(content, false); } catch (_) {}
    setTimeout(() => { suppressChange = false; }, 60);
    if (frame.title) { d.title = frame.title; if (titleEl) titleEl.value = frame.title; }
    d.status = 'Saved';
    if (statusEl) statusEl.textContent = 'Saved';
    restoreEditorCaret(snap);
    flashChip('Updated');
    runtime.render();
    return;
  }
  d._incoming = content;
  d._incomingMtimeNs = null; // Library docs use version_count, not mtime: the id match above is the guard
  showConflict();
  runtime.render();
}

// Test-only seam (matches the __set* pattern used elsewhere, e.g. chat.js's
// __setUsageRetryMs): the module-private `dirty` flag is deliberately not
// part of docState() (see markDirty and the generation-guard comments on
// makeSaveGuard above), and is normally only set true by a real editor
// 'change' event, which document-editor.test.js's DOM-less harness never
// fires. Lets __tests__/document-editor.test.js exercise
// applyExternalUpdate's dirty-buffer branch without a live Toast UI instance
// or markDirty()'s status-text/autosave-timer side effects.
export function __setDirtyForTest(value) {
  dirty = !!value;
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
  d.saveFailed = false; // the unresolved-conflict save-failure no longer applies — we just discarded local edits
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

// ---- error banner (load-failed retry / close-failed discard) ---------------

/** `buttons`: [{label, onClick, primary?}]. Rebuilds the action row each call. */
function showError(message, buttons) {
  if (!errorBanner) return;
  errorMsgEl.textContent = message;
  errorActionsEl.innerHTML = '';
  for (const { label, onClick, primary } of buttons) {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = primary
      ? 'height:26px;padding:0 10px;border-radius:6px;border:1px solid var(--border,#2a2d33);background:var(--teal,#4fe3d1);color:#06231f;font-weight:600;cursor:pointer'
      : 'height:26px;padding:0 10px;border-radius:6px;border:1px solid var(--border,#2a2d33);background:transparent;color:var(--fg,#e8eaed);cursor:pointer';
    b.onclick = onClick;
    errorActionsEl.appendChild(b);
  }
  errorBanner.style.display = 'flex';
}

function hideError() {
  if (errorBanner) errorBanner.style.display = 'none';
}

// Visually + functionally lock the buffer while a load has failed: pointer
// events off (nothing to click/type into) and the Save button disabled, on
// top of the markDirty/saveDoc guards (saveTarget returns 'none') that
// refuse to persist anything regardless of the UI state.
function setBufferLocked(locked) {
  if (host) { host.style.pointerEvents = locked ? 'none' : ''; host.style.opacity = locked ? '0.55' : ''; }
  if (saveBtn) {
    saveBtn.disabled = locked;
    saveBtn.style.opacity = locked ? '0.5' : '';
    saveBtn.style.cursor = locked ? 'not-allowed' : 'pointer';
  }
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
  // Mobile (isMobileShell()) is handled in applyDockWidth().
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

  saveBtn = document.createElement('button');
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

  // Generic error banner: "couldn't load this doc/file" (retry affordance) or
  // "couldn't save on close" (discard affordance). Reddish, distinct from the
  // amber conflict banner above. Message + buttons are (re)built per call by
  // showError() since the situation/actions differ each time it's shown.
  errorBanner = document.createElement('div');
  errorBanner.style.cssText = 'display:none;align-items:center;gap:10px;padding:8px 16px;background:rgba(240,80,60,0.14);border-bottom:1px solid rgba(240,80,60,0.4);color:var(--fg,#e8eaed);font-size:13px;flex:none';
  errorMsgEl = document.createElement('span');
  errorMsgEl.style.cssText = 'flex:1;min-width:0';
  errorActionsEl = document.createElement('span');
  errorActionsEl.style.cssText = 'display:flex;gap:8px;flex:none';
  errorBanner.append(errorMsgEl, errorActionsEl);

  host = document.createElement('div');
  host.style.cssText = 'flex:1;min-height:0;overflow:hidden';

  overlay.append(head, conflictBanner, errorBanner, host);
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
  // No valid save target (nothing open, read-only, failed-to-load — or no
  // docState at all yet, e.g. runtime not fully initialized) — never arm
  // autosave. saveTarget(null) already returns {kind:'none'}, so this one
  // check covers the null-d case too; don't gate it behind `d &&` or a null
  // docState falls through and arms a timer with nothing valid to save.
  if (saveTarget(d).kind === 'none') return;
  dirty = true;
  d.status = 'Unsaved';
  if (statusEl) statusEl.textContent = 'Unsaved';
  clearTimeout(dirtyTO);
  dirtyTO = setTimeout(() => { if (runtime.actions && runtime.actions.saveDoc) runtime.actions.saveDoc(); }, 2500);
}

// Flush a pending autosave-debounced edit on the currently open buffer, then
// cancel the debounce timer, before openDoc/openWorkspaceFile switch away
// from it. Without this, an edit younger than the ~2.5s debounce is silently
// dropped on switch, and the leftover timer fires after the switch with a
// spurious PUT against the NEW buffer.
//
// Returns true when it's safe for the caller to proceed with the switch
// (nothing dirty to flush, or the flush succeeded). Returns false when the
// flush failed or hit a conflict: the failure/conflict UI is already up
// (same contract as closeDoc's own save-before-teardown handling) and the
// caller must abort — do NOT proceed to resetBufferIdentity and blow away
// the still-unsaved buffer.
async function flushPendingEditBeforeSwitch(retrySwitch, discardAndSwitch) {
  // Cancel first, before any await below, so the leftover timer can never
  // race a second concurrent saveDoc() call while we're here flushing.
  clearTimeout(dirtyTO);
  const d = docState();
  if (!(d && d.open && dirty && editor && saveTarget(d).kind !== 'none')) return true;
  let result = 'failed';
  try { result = await actions.saveDoc(); } catch (_) { result = 'failed'; }
  if (result === 'conflict') {
    // saveDoc already put up the conflictBanner (Reload disk / Keep mine) —
    // switching now would silently discard the unresolved edit.
    runtime.render();
    return false;
  }
  if (result === 'failed') {
    showError('Could not save your changes before switching documents.', [
      { label: 'Retry save', primary: true, onClick: retrySwitch },
      { label: 'Discard & switch', onClick: discardAndSwitch },
    ]);
    runtime.render();
    return false;
  }
  return true;
}

function readSavedWidth() {
  const raw = parseInt(localStorage.getItem(LS_WIDTH) || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DOCK_DEFAULT;
}

function applyDockWidth(px) {
  if (!overlay) return;
  if (isMobileShell()) {
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
  if (isMobileShell()) return;
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
  // Warn before an accidental tab close/reload drops unsaved edits (or a
  // save that already failed once — dirty gets cleared into an autosave
  // retry loop, but the failure itself must keep blocking silent unload).
  window.addEventListener('beforeunload', (e) => {
    if (!shouldWarnBeforeUnload(docState(), dirty)) return;
    e.preventDefault();
    e.returnValue = '';
    return '';
  });
}

export const actions = {
  // Composer pill "x": stop attaching this document to the next send, without
  // closing the dock (spec 2.2: detach is for the next turn only). Consumed
  // by that one send (chat.js calls consumeAttachDetach after building it),
  // and also cleared early by resetBufferIdentity if a doc/file is opened or
  // the dock is closed before that send happens.
  detachDocPill: () => {
    const d = docState();
    if (d) d.attachDetached = true;
    runtime.render();
  },

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

      // Flush + cancel any pending autosave debounce on the buffer we're
      // about to switch away from — see flushPendingEditBeforeSwitch(). Must
      // happen before resetBufferIdentity below (and before fetching the new
      // doc): on a failed flush we abort entirely and keep the CURRENT
      // buffer open with the failed-save banner, not proceed to open `id`.
      const proceed = await flushPendingEditBeforeSwitch(
        () => actions.openDoc(id),
        () => { dirty = false; d.saveFailed = false; return actions.openDoc(id); },
      );
      if (!proceed) return;

      let doc = null;
      let loadFailed = false;
      try { doc = await apiGet(`/api/document/${id}`); } catch (_) { loadFailed = true; }

      // Reset buffer identity FIRST — before assigning the new id — so a doc
      // opened right after a workspace file can never inherit its
      // wsPath/wsAbsPath/readOnly (the cross-write bug: autosave would keep
      // checking wsPath first and silently write this doc's markdown over
      // the previous workspace file on disk).
      const prevAbsPath = d.wsAbsPath;
      resetBufferIdentity(d);
      if (prevAbsPath) unsubscribeWatch(prevAbsPath);
      hideConflict(); // a stale "file changed on disk" banner from a previous ws-file buffer must not survive
      dirty = false;
      d.saveFailed = false;
      d.open = true;
      d.id = id;
      d.loadFailed = loadFailed;
      if (titleEl) titleEl.readOnly = false; // stuck `true` from a prior workspace-file open

      if (loadFailed) {
        // A failed GET tells us nothing about the real title — "Untitled
        // document" would wrongly claim the doc genuinely has none.
        d.title = 'Document';
        d.status = 'Load failed';
        if (titleEl) titleEl.value = d.title;
        if (statusEl) statusEl.textContent = d.status;
        suppressChange = true;
        try { editor.setMarkdown('', false); } catch (_) {}
        setTimeout(() => { suppressChange = false; }, 60);
        setBufferLocked(true);
        showError("Couldn't load this document.", [
          { label: 'Retry', primary: true, onClick: () => actions.openDoc(id) },
          { label: 'Close', onClick: () => actions.closeDoc() },
        ]);
        runtime.render();
        return;
      }

      const content = (doc && (doc.current_content != null ? doc.current_content : doc.content)) || '';
      const title = (doc && doc.title) || 'Untitled document';
      d.title = title; d.status = 'Saved';
      if (titleEl) titleEl.value = title;
      if (statusEl) statusEl.textContent = 'Saved';
      setBufferLocked(false);
      hideError();
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

      // Flush + cancel any pending autosave debounce on the buffer we're
      // about to switch away from — see flushPendingEditBeforeSwitch(). Must
      // happen before resetBufferIdentity below (and before fetching the new
      // file): on a failed flush we abort entirely and keep the CURRENT
      // buffer open with the failed-save banner, not proceed to open `path`.
      const proceed = await flushPendingEditBeforeSwitch(
        () => actions.openWorkspaceFile(path, rk),
        () => { dirty = false; d.saveFailed = false; return actions.openWorkspaceFile(path, rk); },
      );
      if (!proceed) return;

      let content = '';
      let mtimeNs = null;
      let absPath = null;
      let loadFailed = false;
      try {
        const res = await fetch('/api/workspace/file?' + qs, { credentials: 'same-origin' });
        if (res.ok) {
          content = await res.text();
          const hdr = res.headers.get('X-Mtime-Ns');
          if (hdr) mtimeNs = parseInt(hdr, 10) || null;
        } else {
          loadFailed = true;
        }
      } catch (_) { loadFailed = true; }
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

      // Reset buffer identity FIRST — before assigning the new wsPath — so a
      // workspace file opened right after a Library doc can never inherit
      // its id/readOnly/loadFailed (the cross-write bug's mirror image).
      const prevAbsPath = d.wsAbsPath;
      resetBufferIdentity(d);
      if (prevAbsPath && prevAbsPath !== absPath) unsubscribeWatch(prevAbsPath);

      d.open = true; d.wsPath = path; d.wsRootKey = rk;
      // On a failed load we don't have a trustworthy mtime — force the next
      // save (once retried) to go through the normal 409-conflict path
      // rather than silently winning a race with a null if_mtime_ns.
      d.wsMtimeNs = loadFailed ? null : mtimeNs;
      d.wsAbsPath = absPath;
      d.readOnly = readOnly;
      d.loadFailed = loadFailed;
      d.title = name; d.status = loadFailed ? 'Load failed' : (readOnly ? 'Read-only' : 'Saved');
      dirty = false;
      d.saveFailed = false;
      hideConflict();
      if (titleEl) { titleEl.value = name; titleEl.readOnly = true; }
      if (statusEl) statusEl.textContent = d.status;
      suppressChange = true;
      try { editor.setMarkdown(loadFailed ? '' : content, false); } catch (_) {}
      setTimeout(() => { suppressChange = false; }, 60);
      applyMode('md');
      setBufferLocked(loadFailed);
      if (loadFailed) {
        showError("Couldn't load this file.", [
          { label: 'Retry', primary: true, onClick: () => actions.openWorkspaceFile(path, rk) },
          { label: 'Close', onClick: () => actions.closeDoc() },
        ]);
      } else {
        hideError();
        if (!readOnly && absPath) subscribeWatch(absPath);
      }
      runtime.render();
    } catch (_) { try { window.alert('Could not open the file.'); } catch (e) {} }
  },

  // Save the current doc (also used by autosave + close). Returns a status
  // code: 'ok' (saved), 'skip' (nothing to do — read-only/failed-load/
  // nothing open), 'conflict' (409 — conflictBanner is now showing),
  // 'failed' (network/HTTP error — caller should surface it, e.g. closeDoc),
  // or 'stale' (the buffer was switched away from — via resetBufferIdentity,
  // which bumps `generation` — while this save was in flight; every mutation
  // below was skipped on purpose so an old buffer's save result can't land
  // on the new buffer that's open now).
  saveDoc: async () => {
    const d = docState();
    if (!d || !editor) return 'skip';
    const target = saveTarget(d);
    if (target.kind === 'none') {
      // Read-only / failed-load / nothing-open — never round-trip through
      // the write endpoint. In particular this is what stops autosave from
      // writing near-empty content over a doc/file that never finished
      // loading in the first place.
      if (statusEl) statusEl.textContent = d.loadFailed ? 'Load failed' : (d.readOnly ? 'Read-only' : (d.status || ''));
      return 'skip';
    }
    const content = (() => { try { return editor.getMarkdown(); } catch (_) { return ''; } })();
    const title = (titleEl && titleEl.value) || d.title || 'Untitled document';
    if (statusEl) statusEl.textContent = 'Saving…';
    // Captured BEFORE the network await(s): if openDoc/openWorkspaceFile/
    // closeDoc switch buffers while this save is in flight (resetBufferIdentity
    // bumps `generation`), every mutation below is guarded so it can't land on
    // the buffer that's open by the time the response comes back.
    const guard = makeSaveGuard(generation);
    try {
      if (target.kind === 'ws') {
        const body = { path: target.path, content };
        if (target.mtimeNs != null) body.if_mtime_ns = target.mtimeNs;
        const res = await fetch('/api/workspace/file', {
          method: 'PUT', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (guard.isStale(generation)) return 'stale';
        if (res.status === 409) {
          // Someone else won the race. Fetch the winning content and let the
          // user pick (Reload disk / Keep mine).
          try {
            const qs = `path=${encodeURIComponent(target.path)}&root_key=${encodeURIComponent(target.rootKey)}`;
            const r2 = await fetch('/api/workspace/file?' + qs, { credentials: 'same-origin' });
            if (guard.isStale(generation)) return 'stale';
            if (r2.ok) {
              const text = await r2.text();
              if (guard.isStale(generation)) return 'stale';
              d._incoming = text;
              const hdr = r2.headers.get('X-Mtime-Ns');
              d._incomingMtimeNs = hdr ? parseInt(hdr, 10) : null;
            }
          } catch (_) {}
          if (guard.isStale(generation)) return 'stale';
          if (statusEl) statusEl.textContent = 'Conflict';
          d.saveFailed = true;
          showConflict();
          return 'conflict';
        }
        if (res.ok) {
          const j = await res.json().catch(() => ({}));
          if (guard.isStale(generation)) return 'stale';
          if (j && j.mtime_ns) d.wsMtimeNs = j.mtime_ns;
        } else {
          // Non-ok, non-409 (e.g. a 500/502/503 restart blip — this branch
          // uses raw fetch, which never throws on an HTTP error status).
          // Leave `dirty` set so the next autosave tick / close-doc retries
          // instead of silently losing the edit under a "Saved" label.
          if (statusEl) statusEl.textContent = 'Save failed';
          d.saveFailed = true;
          return 'failed';
        }
      } else if (target.kind === 'doc') {
        // Raw fetch, not apiJson: apiJson (api.js) deliberately resolves
        // rather than throws on 502/503 (routine restart blips get treated
        // as success by most callers), which would otherwise fall through to
        // the 'Saved' line below on a save that never actually landed.
        // Checking res.ok directly here catches that case too.
        const res = await fetch(`/api/document/${target.id}`, {
          method: 'PUT', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content, title }),
        });
        if (guard.isStale(generation)) return 'stale';
        if (!res.ok) {
          if (statusEl) statusEl.textContent = 'Save failed';
          d.saveFailed = true;
          return 'failed';
        }
      }
      d.status = 'Saved';
      dirty = false;
      d.saveFailed = false;
      if (statusEl) statusEl.textContent = 'Saved';
      // A later autosave landing successfully must clear any stale
      // "couldn't save on close" banner left over from an earlier attempt —
      // the user kept editing instead of clicking Retry/Discard, and the
      // data is fine now, so the banner shouldn't stay stuck.
      hideError();
      return 'ok';
    } catch (_) {
      if (guard.isStale(generation)) return 'stale';
      if (statusEl) statusEl.textContent = 'Save failed';
      d.saveFailed = true;
      return 'failed';
    }
  },

  // Close the editor (saving first unless discarding), then refresh the
  // Library list. `opts.discard: true` skips the save attempt entirely —
  // used only by the "Discard & close" affordance after a save already
  // failed once, so a downed backend can't wedge the close button forever.
  closeDoc: async (opts = {}) => {
    const d = docState();
    if (!d) return;
    clearTimeout(dirtyTO);
    if (!opts.discard && (d.id || d.wsPath) && !d.readOnly && !d.loadFailed && editor) {
      let result = 'failed';
      try { result = await actions.saveDoc(); } catch (_) { result = 'failed'; }
      if (result === 'conflict') {
        // conflictBanner is already showing its own Reload-disk/Keep-mine
        // actions — closing now would silently discard the unresolved edit.
        runtime.render();
        return;
      }
      if (result === 'failed') {
        showError('Could not save your changes before closing.', [
          { label: 'Retry save', primary: true, onClick: () => actions.closeDoc() },
          { label: 'Discard & close', onClick: () => actions.closeDoc({ discard: true }) },
        ]);
        runtime.render();
        return; // keep the editor open — NO teardown on a failed save
      }
    }
    hideError();
    const wasLibraryDoc = !!d.id;
    if (d.wsAbsPath) unsubscribeWatch(d.wsAbsPath);
    resetBufferIdentity(d);
    d.open = false; d.title = ''; d.status = '';
    dirty = false;
    d.saveFailed = false;
    hideConflict();
    setBufferLocked(false);
    if (titleEl) titleEl.readOnly = false;
    runtime.render();
    if (wasLibraryDoc) { try { reload('library'); } catch (_) {} }
  },
};
