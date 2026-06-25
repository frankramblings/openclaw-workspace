// Drag-to-resize for the redesign's sidebar panels.
// Called from runtime.afterRender — re-wires on every render since root.innerHTML
// is rebuilt wholesale. Widths are persisted to localStorage.

const KEY = (id) => `oc-sidebar-width:${id}`;
const load = (id, def) => { try { const v = parseInt(localStorage.getItem(KEY(id))); return isNaN(v) ? def : v; } catch (_) { return def; } };
const save = (id, w) => { try { localStorage.setItem(KEY(id), w); } catch (_) {} };

const SIDEBARS = [
  { sel: '.oc-rail:not(.collapsed)', id: 'rail', side: 'right', min: 160, max: 320, def: 208 },
  { sel: '.chat-list', id: 'chat-list', side: 'right', min: 200, max: 420, def: 280 },
  { sel: '.companion', id: 'companion', side: 'left', min: 280, max: 560, def: 372 },
  { sel: '.set-nav', id: 'set-nav', side: 'right', min: 160, max: 340, def: 220 },
  { sel: '.notes-list', id: 'notes-list', side: 'right', min: 200, max: 440, def: 300 },
];

export function wireResizableSidebars(root) {
  for (const sb of SIDEBARS) {
    const el = root.querySelector(sb.sel);
    if (!el) continue;

    // Apply saved width
    const w = load(sb.id, sb.def);
    el.style.width = w + 'px';

    // Re-use .grab if already present (companion), otherwise inject one
    let handle = el.querySelector('.oc-resize-handle');
    if (!handle) {
      handle = document.createElement('div');
      handle.className = 'oc-resize-handle';
      handle.setAttribute('aria-hidden', 'true');
      el.appendChild(handle);
    }

    // Position the handle on the correct edge
    handle.style.cssText = sb.side === 'right'
      ? 'position:absolute;right:-3px;top:0;bottom:0;width:6px;cursor:col-resize;z-index:30'
      : 'position:absolute;left:-3px;top:0;bottom:0;width:6px;cursor:col-resize;z-index:30';
    el.style.position = 'relative';

    let startX = 0, startW = 0, dragging = false;

    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      startX = e.clientX;
      startW = el.getBoundingClientRect().width;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
      e.preventDefault();
    });

    const onMove = (e) => {
      if (!dragging) return;
      const delta = sb.side === 'right' ? e.clientX - startX : startX - e.clientX;
      const nw = Math.max(sb.min, Math.min(sb.max, startW + delta));
      el.style.width = nw + 'px';
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      save(sb.id, parseInt(el.style.width));
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }
}

// Apply saved widths without re-wiring events (for SSR-style fast path)
export function applySavedWidths(root) {
  for (const sb of SIDEBARS) {
    const el = root.querySelector(sb.sel);
    if (!el) continue;
    const w = load(sb.id, sb.def);
    el.style.width = w + 'px';
  }
}
