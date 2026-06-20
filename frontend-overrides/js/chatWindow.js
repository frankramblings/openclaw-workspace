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
  }
  return built;
}

export function closeChatWindow(side) {
  const w = _windows[side];
  if (!w) return;
  try { w.surface.destroy(); } catch (_) {}
  try { w.modal.remove(); } catch (_) {}  // MutationObserver in modalSnap tears down the dock push
  _windows[side] = null;
  setDockedSession(side, null);
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
  modal.innerHTML = `
    <div class="modal-content chat-window-content" style="width:min(640px, 46vw);max-height:85vh;background:var(--bg);display:flex;flex-direction:column;">
      <div class="modal-header">
        <h4 style="display:flex;align-items:center;gap:6px;">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          <span class="chat-window-title">Chat</span>
        </h4>
        <div style="display:flex;align-items:center;gap:8px;">
          <button class="close-btn chat-window-close" title="Close split chat">✖</button>
        </div>
      </div>
      <div class="modal-body chat-window-body" style="display:flex;flex-direction:column;gap:8px;overflow:hidden;flex:1;">
        <div class="chat-window-history" role="log" aria-live="polite" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding:4px;"></div>
        <form class="chat-window-form" style="display:flex;gap:6px;align-items:flex-end;">
          <textarea class="chat-window-input" rows="1" placeholder="Message…" style="flex:1;resize:none;max-height:140px;"></textarea>
          <button type="submit" class="send-btn chat-window-send" title="Send">➤</button>
        </form>
      </div>
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
    const div = document.createElement('div');
    div.className = 'msg msg-' + (role === 'user' ? 'user' : 'ai');
    div.style.cssText = 'max-width:100%;padding:6px 10px;border-radius:10px;'
      + (role === 'user'
        ? 'align-self:flex-end;background:var(--user-bubble-bg, var(--accent-primary, #2563eb));color:#fff;'
        : 'align-self:flex-start;background:var(--ai-bubble-bg, var(--bg-secondary, #f1f1f1));');
    const body = document.createElement('div');
    body.className = 'body';
    body.innerHTML = html || '';
    div.appendChild(body);
    rootEl.appendChild(div);
    _scroll();
    return body;
  }

  function _render(md) {
    try { return markdownModule.renderContent(md); }
    catch (_) { return (md || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
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
      // Surface the session name in the window title if the backend supplies it.
      const name = data.name || data.session_name;
      if (els.titleEl && name) els.titleEl.textContent = name;
      _scroll();
    } catch (e) {
      console.error('chat-window history load failed', e);
    }
  }

  async function send(message) {
    if (_destroyed || _streaming) return;
    const text = (message || '').trim();
    if (!text) return;
    _bubble('user', _render(text));

    const fd = new FormData();
    fd.append('message', text);
    fd.append('session', sessionId);
    fd.append('mode', 'chat');  // docked windows default to plain chat mode

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

  // Wire the surface's own composer (independent focus/scroll from center).
  if (els.formEl && els.inputEl) {
    els.formEl.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = els.inputEl.value;
      els.inputEl.value = '';
      els.inputEl.style.height = 'auto';
      send(v);
    });
    els.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        els.formEl.requestSubmit ? els.formEl.requestSubmit() : els.formEl.dispatchEvent(new Event('submit'));
      }
    });
    els.inputEl.addEventListener('input', () => {
      els.inputEl.style.height = 'auto';
      els.inputEl.style.height = Math.min(140, els.inputEl.scrollHeight) + 'px';
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
