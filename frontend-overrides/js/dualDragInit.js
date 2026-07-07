// dualDragInit.js — Wire drag-to-dock on the redesign sidebar.
//
// The classic UI wires this in sessions.js, but the redesign entry
// (index.html → redesign/app.js) never imports sessions.js, so drag-to-dock
// was dead on redesign. This tiny module runs on the redesign entry: it finds
// .conv-row[data-arg] rows, marks them draggable, and on drop hands off to
// openChatWindow() to spawn a docked chat.
//
// Coexists with the click-based selectSession delegation (data-act) because
// HTML5 drag suppresses the trailing click when a drag actually happens.

import { dualSessionEnabled, openChatWindow } from './chatWindow.js';

const _DUAL_MIME = 'application/x-openclaw-session';

function _ensureDropStrips() {
  if (document.querySelector('.chat-dock-drop-strip')) return;
  const mk = (side) => {
    const strip = document.createElement('div');
    strip.className = `chat-dock-drop-strip chat-dock-drop-strip-${side}`;
    strip.style.cssText = `position:fixed;top:0;${side}:0;width:60px;height:100vh;`
      + `z-index:9999;display:none;background:color-mix(in srgb, var(--accent-primary, #60a5fa) 14%, transparent);`
      + `border-${side === 'left' ? 'right' : 'left'}:2px dashed var(--accent-primary, #60a5fa);`
      + `pointer-events:auto;`;
    strip.addEventListener('dragover', (e) => {
      if (!Array.from(e.dataTransfer.types || []).includes(_DUAL_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      strip.style.background = 'color-mix(in srgb, var(--accent-primary, #60a5fa) 26%, transparent)';
    });
    strip.addEventListener('dragleave', () => {
      strip.style.background = 'color-mix(in srgb, var(--accent-primary, #60a5fa) 14%, transparent)';
    });
    strip.addEventListener('drop', (e) => {
      e.preventDefault();
      const sid = e.dataTransfer.getData(_DUAL_MIME) || e.dataTransfer.getData('text/plain');
      _hideStrips();
      if (sid) openChatWindow(sid, { startDocked: side });
    });
    document.body.appendChild(strip);
  };
  mk('left'); mk('right');
}
function _showStrips() {
  _ensureDropStrips();
  document.querySelectorAll('.chat-dock-drop-strip').forEach(s => { s.style.display = 'block'; });
}
function _hideStrips() {
  document.querySelectorAll('.chat-dock-drop-strip').forEach(s => {
    s.style.display = 'none';
    s.style.background = 'color-mix(in srgb, var(--accent-primary, #60a5fa) 14%, transparent)';
  });
}

function _wireRow(row, sessionId) {
  if (row._dualDragWired) return;
  row._dualDragWired = true;
  row.setAttribute('draggable', 'true');
  row.style.userSelect = 'none';
  row.style.webkitUserSelect = 'none';

  row.addEventListener('dragstart', (e) => {
    if (!dualSessionEnabled() || window.innerWidth <= 768) return;
    e.dataTransfer.setData(_DUAL_MIME, sessionId);
    e.dataTransfer.setData('text/plain', sessionId);
    e.dataTransfer.effectAllowed = 'copy';
    try {
      const ghost = row.cloneNode(true);
      ghost.style.cssText = 'position:absolute;top:-9999px;left:-9999px;opacity:0.7;width:'
        + row.offsetWidth + 'px;background:var(--bg);';
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 20, 16);
      setTimeout(() => ghost.remove(), 0);
    } catch (_) {}
    _showStrips();
  });
  row.addEventListener('dragend', () => _hideStrips());
}

function _rescan() {
  if (!dualSessionEnabled() || window.innerWidth <= 768) return;
  document.querySelectorAll('.conv-row[data-act="selectSession"][data-arg]').forEach(row => {
    _wireRow(row, row.getAttribute('data-arg'));
  });
}

function _install() {
  if (typeof MutationObserver === 'undefined') return;
  let pending = false;
  const kick = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; _rescan(); });
  };
  const obs = new MutationObserver((records) => {
    for (const r of records) {
      if (r.addedNodes && r.addedNodes.length) { kick(); break; }
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
  _rescan();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _install, { once: true });
} else {
  _install();
}
