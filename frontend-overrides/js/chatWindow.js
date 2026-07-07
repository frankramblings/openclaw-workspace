// chatWindow.js — Dual-Session Split View (Slice A + polish).
//
// Opens a chat session as a windowed, dockable surface that runs LIVE and
// INDEPENDENT of the center column. Reuses Odysseus's existing window+dock
// primitives (windowDrag.js / modalSnap.js) — the exact same chrome, snap
// hints, keybindings and mobile fallback the email/doc windows use. No new
// pane manager.
//
// EVERY code path here is gated behind the feature flag
//   localStorage.openclaw_dual_session === '1'
// With the flag off, nothing in this module runs (sidebar.js never calls in,
// and openChatWindow() short-circuits), so behavior is byte-for-byte the
// current behavior.
//
// Architecture note: chat.js's streaming/render state is a module-scoped
// singleton hard-wired to #chat-history (center surface). Rather than refactor
// that 4600-line file, each docked window is a SELF-CONTAINED mini chat surface
// with its OWN session id, OWN SSE subscription, OWN DOM root and OWN composer.
// It talks to the same backend endpoints (GET /api/history/<id>,
// POST /api/chat_stream) the center surface uses. This satisfies the plan's
// "new windowed surfaces use surface-scoped state only" while keeping chat.js's
// `currentSession` (in sessions.js) as the untouched center alias.

import { makeWindowDraggable } from './windowDrag.js';
import { applyEdgeDock } from './modalSnap.js';
import markdownModule from './markdown.js';
// Redesign-native rendering: use the same markup + tokens the center chat uses
// so docked windows are visually indistinguishable from the main surface.
import { renderMarkdown as _redesignRenderMarkdown } from './redesign/markdown.js';
import { esc as _redesignEsc } from './redesign/dom.js';
import { AVATAR as _REDESIGN_AVATAR } from './redesign/data.js';

const API_BASE = window.location.origin;
const FLAG_KEY = 'openclaw_dual_session';
const DOCKED_KEY = 'openclaw_docked_sessions';
const MOBILE_MAX = 768;

export function dualSessionEnabled() {
  try { return localStorage.getItem(FLAG_KEY) === '1'; } catch (_) { return false; }
}

// ── Persisted docked layout (per-device, localStorage) ──────────────────────
// { left: sid|null, right: sid|null }. Only the two edge docks persist; the
// center surface owns the URL and is restored by the normal app boot path.
export function loadDockedSessions() {
  try {
    const raw = JSON.parse(localStorage.getItem(DOCKED_KEY) || '{}');
    return { left: raw.left || null, right: raw.right || null };
  } catch (_) { return { left: null, right: null }; }
}
function saveDockedSessions(map) {
  try { localStorage.setItem(DOCKED_KEY, JSON.stringify({ left: map.left || null, right: map.right || null })); } catch (_) {}
}
function setDockedSession(side, sid) {
  const map = loadDockedSessions();
  map[side] = sid || null;
  saveDockedSessions(map);
}

// Track live windows by side so we can enforce the cap and swap sides.
const _windows = { left: null, right: null };  // side -> { modal, surface, sessionId }

export function dockedSides() {
  return {
    left: _windows.left ? _windows.left.sessionId : null,
    right: _windows.right ? _windows.right.sessionId : null,
  };
}

// ── Public entry: open a session as a docked chat window ────────────────────
// openChatWindow(sessionId, { startDocked: 'left'|'right'|null })
// Cap enforced: 1 left + 1 right. If the requested side is taken, the new chat
// takes the OTHER free side; if both are taken, the requested side is replaced.
export function openChatWindow(sessionId, opts = {}) {
  if (!dualSessionEnabled()) return null;
  if (!sessionId) return null;
  // Mobile short-circuit: windowDrag.js disables drag below 768px, and a split
  // makes no sense on a phone. Fall back to plain center-surface navigation.
  if (window.innerWidth <= MOBILE_MAX) {
    try { window.sessionModule?.selectSession?.(sessionId); } catch (_) {}
    return null;
  }

  let side = opts.startDocked === 'left' ? 'left' : 'right';

  // Don't double-open the same session in a window — focus the existing one.
  for (const s of ['left', 'right']) {
    if (_windows[s] && _windows[s].sessionId === sessionId) {
      _windows[s].modal?.classList.remove('hidden');
      return _windows[s];
    }
  }

  // Cap=2 enforcement. If requested side is busy but the other is free, use the
  // free side. If both busy, replace the requested side (close the old one).
  if (_windows[side]) {
    const other = side === 'left' ? 'right' : 'left';
    if (!_windows[other]) side = other;
    else closeChatWindow(side);
  }

  const built = _buildWindow(sessionId, side);
  _windows[side] = built;
  setDockedSession(side, sessionId);

  if (side) {
    // Programmatically dock so the window opens already snapped to the edge.
    // applyEdgeDock sets the matching body class + --left/right-dock-w var, so
    // the center column reflows via the existing body.{left,right}-dock-active
    // padding rules (style.css) — no new CSS needed.
    try { applyEdgeDock(built.modal, side); } catch (_) {}
    // Redesign layout uses .oc-rail + .oc-secondary (not classic #sidebar /
    // #icon-rail), so modalSnap's _leftNavRight() returns 0 and left-docked
    // windows cover the sidebar. Re-anchor left docks against the redesign
    // sidebar right edge here; right docks are unaffected.
    _anchorRedesignLeftDock(built.modal);
    // Right dock (and all subsequent dock changes) also need the reflow — the
    // classic --left/right-dock-w flow doesn't survive on the redesign shell.
    _applyRedesignReflow();
  }
  return built;
}

// Compute the right edge of the redesign left navigation (rail + secondary
// panel) and pin the modal-content there. Also updates --left-dock-w so
// .oc-center reflow padding stays correct (dock takes: sidebar-right → dock-w).
function _redesignLeftNavRight() {
  let x = 0;
  const rail = document.querySelector('.oc-rail');
  if (rail && window.getComputedStyle(rail).display !== 'none') {
    const r = rail.getBoundingClientRect();
    if (r.width) x = Math.max(x, r.right);
  }
  // The .oc-secondary panel is the conversations list; it sits to the right of
  // the rail and is visible on the chat surface. Only count it when visible.
  const sec = document.querySelector('.oc-secondary');
  if (sec && window.getComputedStyle(sec).display !== 'none') {
    const r = sec.getBoundingClientRect();
    if (r.width) x = Math.max(x, r.right);
  }
  return x;
}
function _anchorRedesignLeftDock(modal) {
  if (!modal) return;
  if (!modal.classList.contains('modal-left-docked')) return;
  const content = modal.querySelector('.modal-content');
  if (!content) return;
  const left = _redesignLeftNavRight();
  if (!left) return;
  content.style.left = left + 'px';
  // Keep the docked window from spilling past what's visible on the right.
  const w = content.getBoundingClientRect().width;
  const maxW = Math.max(280, window.innerWidth - left - 40);
  const newW = Math.min(w, maxW);
  content.style.width = newW + 'px';
  content.style.maxWidth = newW + 'px';
  document.documentElement.style.setProperty('--left-dock-w', newW + 'px');
  // Belt-and-suspenders: set the padding directly on .oc-center as an inline
  // style so it can't be lost to a stale CSS-var / observer race. Re-apply
  // whenever any left dock is active (this method covers both open + resize).
  _applyRedesignReflow();
}

// Directly write the reflow padding on .oc-center for whichever docks are open,
// so we don't depend on modalSnap's --left/right-dock-w CSS var and body-class
// flow (which was designed for the classic UI's email/doc splits).
function _applyRedesignReflow() {
  const center = document.querySelector('.oc-center');
  if (!center) return;
  const leftMod = _windows.left?.modal;
  const rightMod = _windows.right?.modal;
  const leftW = leftMod ? (leftMod.querySelector('.modal-content')?.getBoundingClientRect().width || 0) : 0;
  const rightW = rightMod ? (rightMod.querySelector('.modal-content')?.getBoundingClientRect().width || 0) : 0;
  center.style.paddingLeft = leftW ? leftW + 'px' : '';
  center.style.paddingRight = rightW ? rightW + 'px' : '';
  center.style.transition = 'padding 140ms ease';
}
// Wipe the reflow padding when a dock closes.
function _clearRedesignReflow(side) {
  const center = document.querySelector('.oc-center');
  if (!center) return;
  if (side === 'left') center.style.paddingLeft = '';
  if (side === 'right') center.style.paddingRight = '';
  // If neither remains, clear transition too.
  if (!_windows.left && !_windows.right) center.style.transition = '';
}
// Re-anchor on viewport resize so the left dock keeps following the sidebar.
if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => {
    if (_windows.left) _anchorRedesignLeftDock(_windows.left.modal);
  });
}

export function closeChatWindow(side) {
  const w = _windows[side];
  if (!w) return;
  try { w.surface.destroy(); } catch (_) {}
  try { w.modal.remove(); } catch (_) {}  // MutationObserver in modalSnap tears down the dock push
  _windows[side] = null;
  setDockedSession(side, null);
  _clearRedesignReflow(side);
}

// Swap the left and right docked windows (⌘⇧→ / ⌘⇧←). Re-docks each modal on
// the opposite edge; surfaces keep their own streams/state untouched.
export function swapDockedSides() {
  const l = _windows.left, r = _windows.right;
  if (!l && !r) return;
  _windows.left = r || null;
  _windows.right = l || null;
  if (_windows.left) { try { applyEdgeDock(_windows.left.modal, 'left'); } catch (_) {} }
  if (_windows.right) { try { applyEdgeDock(_windows.right.modal, 'right'); } catch (_) {} }
  saveDockedSessions(dockedSides());
}

// ── Window shell (mirrors the email/doc wrap pattern) ───────────────────────
function _buildWindow(sessionId, side) {
  const modal = document.createElement('div');
  modal.className = 'modal chat-window-modal';
  modal.id = 'chat-window-' + side;
  // Use the redesign UI's own semantic classes (.chat-thread / .composer-wrap /
  // .composer) so styling is inherited straight from redesign.css — the docked
  // window is visually native, not a skinned classic modal.
  modal.innerHTML = `
    <div class="modal-content chat-window-content">
      <div class="modal-header chat-window-head">
        <div class="chat-window-head-inner">
          <span class="chat-window-title">Chat</span>
        </div>
        <button class="close-btn chat-window-close" title="Close split chat" aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="chat-thread chat-window-history" role="log" aria-live="polite"></div>
      <div class="composer-wrap chat-window-composer-wrap">
        <div class="composer chat-window-form">
          <div class="chat-window-attach-row" hidden></div>
          <textarea class="chat-window-input" rows="1" placeholder="Message Gary…"></textarea>
          <div class="composer-row">
            <button type="button" class="chat-window-attach" title="Attach files (or paste an image)" aria-label="Attach">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
            </button>
            <input type="file" class="chat-window-file-input" hidden multiple accept="image/*,application/pdf,.txt,.md,.json,.csv,.log,.py,.js,.ts,.tsx,.jsx,.html,.css,.yaml,.yml,.toml">
            <div style="flex:1"></div>
            <button type="button" class="chat-window-send" title="Send" aria-label="Send">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
            </button>
          </div>
        </div>
      </div>
      <div class="chat-window-resize" aria-hidden="true" title="Drag to resize"></div>
      <div class="chat-window-dock-grip" aria-hidden="true" title="Drag to resize dock"></div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.style.display = 'block';
  // Non-blocking backdrop so the rest of the app stays interactive (same trick
  // the email/doc windows use).
  modal.style.cssText += 'pointer-events:none;background:transparent;';

  const content = modal.querySelector('.modal-content');
  if (content) {
    content.style.position = 'fixed';
    content.style.pointerEvents = 'auto';
    // Center it for the brief moment before applyEdgeDock snaps it to the edge.
    requestAnimationFrame(() => {
      if (modal.classList.contains('modal-left-docked') || modal.classList.contains('modal-right-docked')) return;
      const w = content.offsetWidth || 560;
      content.style.left = Math.max(20, (window.innerWidth - w) / 2) + 'px';
      content.style.top = Math.max(20, (window.innerHeight - window.innerHeight * 0.85) / 2) + 'px';
      content.style.transform = 'none';
    });
  }

  // Draggable + dockable using the SHARED primitive — identical behavior to the
  // email window (top-edge fullscreen + left/right edge docks).
  const header = modal.querySelector('.modal-header');
  if (content && header) {
    const fsClass = 'chat-window-fullscreen';
    makeWindowDraggable(modal, {
      content,
      header,
      fsClass,
      skipSelector: '.close-btn, button, input, select, textarea',
      enableLeftDock: true,
      onEnterFullscreen: () => {
        modal.classList.add(fsClass);
        Object.assign(content.style, {
          position: 'fixed', left: '0', top: '0', right: '0', bottom: '0',
          width: '100vw', maxWidth: '100vw', height: '100vh', maxHeight: '100vh',
          borderRadius: '0', transform: 'none',
        });
      },
      onExitFullscreen: (cx, cy) => {
        modal.classList.remove(fsClass);
        const w = Math.min(640, window.innerWidth * 0.46);
        Object.assign(content.style, {
          width: 'min(640px, 46vw)', maxWidth: '', height: '', maxHeight: '85vh',
          borderRadius: '', right: '', bottom: '',
          left: Math.max(8, cx - w / 2) + 'px', top: Math.max(8, cy - 20) + 'px',
        });
      },
      // When a drag ends docked on a side, sync our side bookkeeping so the
      // persisted layout + cap tracking follow the user's manual re-dock.
      onDragEnd: () => _resyncSidesFromDom(),
    });
  }

  // Bottom-right resize handle — SE-grip. Only active when the window is
  // free-floating (not docked to an edge, not fullscreen). Uses pointer events
  // so mouse + touch behave the same.
  const _resizeHandle = modal.querySelector('.chat-window-resize');
  if (_resizeHandle && content) {
    let start = null;
    const isFree = () =>
      !modal.classList.contains('modal-left-docked')
      && !modal.classList.contains('modal-right-docked')
      && !modal.classList.contains('chat-window-fullscreen');
    _resizeHandle.addEventListener('pointerdown', (e) => {
      if (!isFree()) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = content.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, w: rect.width, h: rect.height };
      _resizeHandle.setPointerCapture(e.pointerId);
      document.body.style.cursor = 'nwse-resize';
      document.body.style.userSelect = 'none';
    });
    _resizeHandle.addEventListener('pointermove', (e) => {
      if (!start) return;
      // Cap so the window never shrinks below usable size or exceeds viewport.
      const nw = Math.max(320, Math.min(window.innerWidth - 40, start.w + (e.clientX - start.x)));
      const nh = Math.max(240, Math.min(window.innerHeight - 40, start.h + (e.clientY - start.y)));
      content.style.width = nw + 'px';
      content.style.maxWidth = 'none';
      content.style.height = nh + 'px';
      content.style.maxHeight = 'none';
    });
    const end = (e) => {
      if (!start) return;
      start = null;
      try { _resizeHandle.releasePointerCapture(e.pointerId); } catch (_) {}
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    _resizeHandle.addEventListener('pointerup', end);
    _resizeHandle.addEventListener('pointercancel', end);
  }

  // Docked-inner-edge resize grip — a vertical bar on the inner edge of the
  // docked window (right edge if left-docked, left edge if right-docked).
  // Drag to widen/narrow the dock; updates content width + --left/right-dock-w
  // so the center column reflows in real time. Persisted per side.
  const _grip = modal.querySelector('.chat-window-dock-grip');
  if (_grip && content) {
    const KEY = 'openclaw_dock_widths';
    const _readWidths = () => {
      try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) { return {}; }
    };
    const _writeWidth = (dockSide, w) => {
      const cur = _readWidths();
      cur[dockSide] = w;
      try { localStorage.setItem(KEY, JSON.stringify(cur)); } catch (_) {}
    };
    // Restore a persisted width on next frame (after applyEdgeDock lands).
    requestAnimationFrame(() => {
      const dockedSide = modal.classList.contains('modal-left-docked') ? 'left'
        : modal.classList.contains('modal-right-docked') ? 'right' : null;
      if (!dockedSide) return;
      const saved = _readWidths()[dockedSide];
      if (!saved || saved < 280) return;
      _applyDockWidth(dockedSide, saved);
    });
    function _applyDockWidth(dockSide, w) {
      // Leave at least MIN_CENTER px of usable center-chat width so the main UI
      // can't be squeezed off the page. Also account for the OTHER docked window
      // if one is present on the opposite side.
      const MIN_CENTER = 360;
      const sidebarOffset = _redesignLeftNavRight() || 0;
      const otherSide = dockSide === 'left' ? 'right' : 'left';
      const other = _windows[otherSide];
      const otherW = other ? other.modal.querySelector('.modal-content')?.getBoundingClientRect().width || 0 : 0;
      const available = Math.max(320, window.innerWidth - sidebarOffset - MIN_CENTER - otherW);
      const clamped = Math.max(320, Math.min(available, w));
      content.style.width = clamped + 'px';
      content.style.maxWidth = clamped + 'px';
      if (dockSide === 'left') {
        // Left dock in redesign is offset by the sidebar's right edge.
        if (sidebarOffset) content.style.left = sidebarOffset + 'px';
        document.documentElement.style.setProperty('--left-dock-w', clamped + 'px');
      } else {
        document.documentElement.style.setProperty('--right-dock-w', clamped + 'px');
      }
      // Reflow the center chat by writing padding directly (survives observers).
      _applyRedesignReflow();
    }
    let start = null;
    _grip.addEventListener('pointerdown', (e) => {
      const dockedSide = modal.classList.contains('modal-left-docked') ? 'left'
        : modal.classList.contains('modal-right-docked') ? 'right' : null;
      if (!dockedSide) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = content.getBoundingClientRect();
      start = { x: e.clientX, w: rect.width, side: dockedSide };
      _grip.setPointerCapture(e.pointerId);
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
    });
    _grip.addEventListener('pointermove', (e) => {
      if (!start) return;
      // Left dock: dragging right widens; right dock: dragging left widens.
      const delta = start.side === 'left' ? (e.clientX - start.x) : (start.x - e.clientX);
      _applyDockWidth(start.side, start.w + delta);
    });
    const end = (e) => {
      if (!start) return;
      const finalW = content.getBoundingClientRect().width;
      _writeWidth(start.side, finalW);
      start = null;
      try { _grip.releasePointerCapture(e.pointerId); } catch (_) {}
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    _grip.addEventListener('pointerup', end);
    _grip.addEventListener('pointercancel', end);
  }

  // Close button.
  modal.querySelector('.chat-window-close')?.addEventListener('click', () => {
    // Find which side this modal currently owns (it may have been re-docked).
    const owned = _windows.left?.modal === modal ? 'left'
      : _windows.right?.modal === modal ? 'right' : side;
    closeChatWindow(owned);
  });

  const surface = createChatSurface(modal.querySelector('.chat-window-history'), sessionId, {
    titleEl: modal.querySelector('.chat-window-title'),
    formEl: modal.querySelector('.chat-window-form'),
    inputEl: modal.querySelector('.chat-window-input'),
    sendEl: modal.querySelector('.chat-window-send'),
    attachBtnEl: modal.querySelector('.chat-window-attach'),
    fileInputEl: modal.querySelector('.chat-window-file-input'),
    attachRowEl: modal.querySelector('.chat-window-attach-row'),
  });
  surface.load();

  return { modal, surface, sessionId };
}

// After a manual drag re-dock, rebuild _windows[side] from which modal carries
// which dock class, so close/swap/persist stay correct.
function _resyncSidesFromDom() {
  const all = [_windows.left, _windows.right].filter(Boolean);
  const next = { left: null, right: null };
  for (const w of all) {
    if (w.modal.classList.contains('modal-left-docked')) next.left = w;
    else if (w.modal.classList.contains('modal-right-docked')) next.right = w;
    else {
      // Floating (un-docked) — keep it on whichever free slot.
      if (!next.left) next.left = w; else next.right = w;
    }
  }
  _windows.left = next.left;
  _windows.right = next.right;
  saveDockedSessions(dockedSides());
}

// ── createChatSurface(rootEl, sessionId) — the per-surface factory ──────────
// Returns { load, send, destroy, sessionId }. Self-contained: owns its history
// element, its composer, its abort controller and its stream subscription.
// Routes by sessionId (it only ever talks about its own session), so two
// surfaces never cross-contaminate.
export function createChatSurface(rootEl, sessionId, els = {}) {
  let _abort = null;
  let _streaming = false;
  let _destroyed = false;

  const _scroll = () => { try { rootEl.scrollTop = rootEl.scrollHeight; } catch (_) {} };

  function _bubble(role, html) {
    // Emit the same .msg-user / .msg-asst markup the redesign uses so all the
    // typography, bubble colors, avatars, meta rows come free from redesign.css.
    if (role === 'user') {
      const wrap = document.createElement('div');
      wrap.className = 'msg-user-wrap';
      wrap.innerHTML = `<div class="msg-user"><div class="meta"><span class="you">You</span></div><div class="body"></div></div>`;
      const body = wrap.querySelector('.body');
      body.innerHTML = html || '';
      rootEl.appendChild(wrap);
      _scroll();
      return body;
    }
    const el = document.createElement('div');
    el.className = 'msg-asst';
    el.innerHTML = `
      <div class="msg-av"><img src="${_redesignEsc(_REDESIGN_AVATAR)}" alt="Gary"></div>
      <div class="msg-body">
        <div class="msg-meta"><span class="name">Gary</span></div>
        <div class="body"></div>
      </div>`;
    const body = el.querySelector('.msg-body > .body');
    body.innerHTML = html || '';
    rootEl.appendChild(el);
    _scroll();
    return body;
  }

  function _render(md) {
    // Prefer redesign's markdown renderer so bubble prose matches the center chat
    // (headings, code fences, lists, links styled identically). Fall back to the
    // classic renderer, then to raw-escape.
    try { return _redesignRenderMarkdown(md || ''); } catch (_) {}
    try { return markdownModule.renderContent(md); } catch (_) {}
    return (md || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }

  async function load() {
    if (_destroyed) return;
    try {
      const res = await fetch(`${API_BASE}/api/history/${sessionId}?limit=100`);
      const data = await res.json();
      if (_destroyed) return;
      rootEl.innerHTML = '';
      const hist = data.history || [];
      for (const m of hist) {
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        const text = typeof m.content === 'string' ? m.content : String(m.content || '');
        _bubble(m.role, _render(text));
      }
      // Surface the session name. /api/history doesn't return one, so fall back
      // to reading it out of the sidebar row that was just dragged in — the
      // redesign renders <div class="conv-row" data-arg="{sid}"><span class="conv-title">…</span>.
      let name = data.name || data.session_name;
      if (!name) {
        try {
          const row = document.querySelector(`.conv-row[data-arg="${sessionId}"] .conv-title`);
          if (row) name = row.textContent.trim();
        } catch (_) {}
      }
      if (!name) {
        try {
          const row = document.querySelector(`.list-item[data-session-id="${sessionId}"] .item-title`);
          if (row) name = row.textContent.trim();
        } catch (_) {}
      }
      if (els.titleEl && name) els.titleEl.textContent = name;
      _scroll();
    } catch (e) {
      console.error('chat-window history load failed', e);
    }
  }

  // Pending attachments (uploaded, awaiting send). Each: { id, name, url }.
  let _pending = [];

  const _IMG_EXTS = new Set(['jpg','jpeg','png','gif','webp','svg','bmp','avif','ico']);
  function _extOf(name) { return (name.split('.').pop() || '').toLowerCase(); }

  function _renderAttachRow() {
    if (!els.attachRowEl) return;
    if (!_pending.length) {
      els.attachRowEl.hidden = true;
      els.attachRowEl.innerHTML = '';
      return;
    }
    els.attachRowEl.hidden = false;
    els.attachRowEl.innerHTML = _pending.map((a) => {
      const ext = _extOf(a.name || a.id);
      if (_IMG_EXTS.has(ext)) {
        return `<div class="atch-chip atch-img" data-id="${a.id}" title="${_redesignEsc(a.name)}">`
          + `<img src="/api/upload/${_redesignEsc(a.id)}" alt="">`
          + `<button type="button" class="atch-rm" data-id="${a.id}" title="Remove">✕</button></div>`;
      }
      return `<div class="atch-chip atch-file" data-id="${a.id}">`
        + `<span class="atch-ext">${_redesignEsc(ext.slice(0,4) || 'file')}</span>`
        + `<span class="atch-name" title="${_redesignEsc(a.name)}">${_redesignEsc(a.name)}</span>`
        + `<button type="button" class="atch-rm" data-id="${a.id}" title="Remove">✕</button></div>`;
    }).join('');
    // Chip remove clicks.
    els.attachRowEl.querySelectorAll('.atch-rm').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const id = btn.getAttribute('data-id');
        _pending = _pending.filter((a) => a.id !== id);
        _renderAttachRow();
      });
    });
  }

  async function _uploadFiles(fileList) {
    if (!fileList || !fileList.length) return;
    const fd = new FormData();
    for (const f of fileList) fd.append('files', f, f.name || 'upload');
    try {
      const res = await fetch(`${API_BASE}/api/upload`, {
        method: 'POST',
        credentials: 'same-origin',
        body: fd,
      });
      if (!res.ok) return;
      const data = await res.json();
      const saved = (data && data.files) || [];
      _pending = [..._pending, ...saved.map((s) => ({ id: s.id, name: s.name, url: s.url }))];
      _renderAttachRow();
    } catch (_) { /* soft fail */ }
  }

  async function send(message) {
    if (_destroyed || _streaming) return;
    const text = (message || '').trim();
    const attachSnap = _pending.slice();
    if (!text && !attachSnap.length) return;
    // Render the user bubble with any image previews inlined so the docked
    // thread mirrors the main chat's user attachments.
    const attachHtml = attachSnap.map((a) => {
      const ext = _extOf(a.name || a.id);
      if (_IMG_EXTS.has(ext)) {
        return `<div class="msg-user-att"><img src="/api/upload/${_redesignEsc(a.id)}" alt="${_redesignEsc(a.name)}" style="max-width:100%;border-radius:8px;margin:4px 0"></div>`;
      }
      return `<div class="msg-user-att atch-chip atch-file" style="margin:4px 0"><span class="atch-ext">${_redesignEsc(ext.slice(0,4) || 'file')}</span><span class="atch-name">${_redesignEsc(a.name)}</span></div>`;
    }).join('');
    _bubble('user', attachHtml + (text ? _render(text) : ''));
    // Clear pending immediately so the composer resets even before the stream returns.
    _pending = [];
    _renderAttachRow();

    const fd = new FormData();
    fd.append('message', text);
    fd.append('session', sessionId);
    fd.append('mode', 'chat');  // docked windows default to plain chat mode
    if (attachSnap.length) {
      fd.append('attachments', JSON.stringify(attachSnap.map((a) => a.id)));
    }

    _abort = new AbortController();
    _streaming = true;
    const aiBody = _bubble('assistant', '<span class="chat-window-cursor">…</span>');
    let accumulated = '';
    let raf = null;
    const flush = () => { raf = null; aiBody.innerHTML = _render(accumulated); _scroll(); };
    const queue = () => { if (!raf) raf = requestAnimationFrame(flush); };

    try {
      const res = await fetch(`${API_BASE}/api/chat_stream`, {
        method: 'POST',
        body: fd,
        headers: { 'X-Tz-Offset': String(-new Date().getTimezoneOffset()) },
        signal: _abort.signal,
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          if (payload === '[DONE]') continue;
          let json;
          try { json = JSON.parse(payload); } catch (_) { continue; }
          // Only the plain text deltas matter for the docked surface; tool /
          // think / metrics events are center-surface polish we deliberately
          // skip here (keeps the window simple + cheap).
          if (typeof json.delta === 'string' && !json.thinking) {
            accumulated += json.delta;
            queue();
          }
        }
      }
    } catch (e) {
      if (!_abort?.signal.aborted) {
        console.error('chat-window stream failed', e);
        accumulated += (accumulated ? '\n\n' : '') + '_(stream error)_';
      }
    } finally {
      _streaming = false;
      _abort = null;
      if (raf) cancelAnimationFrame(raf);
      aiBody.innerHTML = _render(accumulated || '_(no response)_');
      _scroll();
    }
  }

  // Wire the surface's own composer. The redesign shell is a div, not a form,
  // so send is triggered by the button or Enter (Shift+Enter inserts a newline).
  if (els.inputEl) {
    const doSend = () => {
      const v = els.inputEl.value;
      els.inputEl.value = '';
      els.inputEl.style.height = 'auto';
      send(v);
    };
    if (els.sendEl) els.sendEl.addEventListener('click', doSend);
    els.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        doSend();
      }
    });
    els.inputEl.addEventListener('input', () => {
      els.inputEl.style.height = 'auto';
      els.inputEl.style.height = Math.min(140, els.inputEl.scrollHeight) + 'px';
    });
    // Paste image support: capture image blobs pasted into the textarea (Cmd/Ctrl+V
    // from a screenshot). Named as .png with a timestamp so backend sidecar sees a filename.
    els.inputEl.addEventListener('paste', (e) => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      const files = [];
      for (const it of items) {
        if (it.kind === 'file' && it.type && it.type.startsWith('image/')) {
          const f = it.getAsFile();
          if (f) {
            const ext = (f.type.split('/')[1] || 'png').split(';')[0];
            const stamped = new File([f], `pasted-${Date.now()}.${ext}`, { type: f.type });
            files.push(stamped);
          }
        }
      }
      if (files.length) {
        e.preventDefault();
        _uploadFiles(files);
      }
    });
  }
  // Attach button → open file picker.
  if (els.attachBtnEl && els.fileInputEl) {
    els.attachBtnEl.addEventListener('click', () => els.fileInputEl.click());
    els.fileInputEl.addEventListener('change', (e) => {
      const files = e.target.files;
      if (files && files.length) _uploadFiles(files);
      // Reset so the same file can be re-picked later.
      e.target.value = '';
    });
  }
  // Drag-and-drop into the whole window.
  if (rootEl && rootEl.parentElement) {
    const dropZone = rootEl.closest('.chat-window-content') || rootEl.parentElement;
    dropZone.addEventListener('dragover', (e) => {
      if (Array.from(e.dataTransfer?.types || []).includes('Files')) {
        e.preventDefault();
        dropZone.classList.add('chat-window-drop-hover');
      }
    });
    dropZone.addEventListener('dragleave', (e) => {
      if (e.target === dropZone) dropZone.classList.remove('chat-window-drop-hover');
    });
    dropZone.addEventListener('drop', (e) => {
      const files = e.dataTransfer?.files;
      if (files && files.length) {
        e.preventDefault();
        dropZone.classList.remove('chat-window-drop-hover');
        _uploadFiles(files);
      }
    });
  }

  function destroy() {
    _destroyed = true;
    try { _abort?.abort(); } catch (_) {}
  }

  return { load, send, destroy, sessionId };
}

// ── Reload restore + keyboard shortcuts (Slice C) ───────────────────────────
let _restored = false;
export function restoreDockedLayout() {
  if (_restored || !dualSessionEnabled()) return;
  if (window.innerWidth <= MOBILE_MAX) return;
  _restored = true;
  const map = loadDockedSessions();
  // Open right first then left so left ends up flush against the rail and the
  // dock vars settle in a stable order.
  if (map.right) openChatWindow(map.right, { startDocked: 'right' });
  if (map.left) openChatWindow(map.left, { startDocked: 'left' });
}

function _initKeybindings() {
  document.addEventListener('keydown', (e) => {
    if (!dualSessionEnabled()) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.shiftKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      // Only act if we actually have docked windows — otherwise let the event
      // pass through untouched (no regression to existing shortcuts).
      if (!_windows.left && !_windows.right) return;
      e.preventDefault();
      swapDockedSides();
    }
  });
}

// Expose for sidebar drag handler + console testing.
if (typeof window !== 'undefined') {
  window.chatWindowModule = {
    openChatWindow, closeChatWindow, swapDockedSides,
    dockedSides, restoreDockedLayout, dualSessionEnabled, createChatSurface,
  };
  // Console convenience for Slice A acceptance test.
  window.openChatWindow = openChatWindow;
  _initKeybindings();
  // Restore persisted layout once the app's session list is ready.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(restoreDockedLayout, 800));
  } else {
    setTimeout(restoreDockedLayout, 800);
  }
}
