// Drag-to-resize for the redesign's sidebar panels.
// wireResizableSidebars() is called after every render (root.innerHTML rebuild).
// Window-level mousemove/mouseup are registered ONCE at module load to avoid
// the accumulating-listener bug that occurs when wiring inside a render loop.

const KEY = (id) => `oc-sidebar-width:${id}`;
const load = (id, def) => { try { const v = parseInt(localStorage.getItem(KEY(id))); return isNaN(v) ? def : v; } catch (_) { return def; } };
const save = (id, w) => { try { localStorage.setItem(KEY(id), w); } catch (_) {} };

// left-side panels: handle on the RIGHT edge; dragging right = grow.
// right-side panels: handle on the LEFT edge; dragging left = grow.
const SIDEBARS = [
  { sel: '.oc-rail:not(.collapsed)', id: 'rail',      edge: 'right', min: 160, max: 320, def: 208 },
  { sel: '.chat-list',               id: 'chat-list', edge: 'right', min: 200, max: 420, def: 280 },
  { sel: '.companion',               id: 'companion', edge: 'left',  min: 280, max: 560, def: 372 },
  { sel: '.set-nav',                 id: 'set-nav',   edge: 'right', min: 160, max: 340, def: 220 },
  { sel: '.notes-list',              id: 'notes-list',edge: 'right', min: 200, max: 440, def: 300 },
];

// Module-level drag state — one global handler pair on window, wired once.
let activeDrag = null; // { el, sb, startX, startW }

window.addEventListener('mousemove', (e) => {
  if (!activeDrag) return;
  const { el, sb, startX, startW } = activeDrag;
  const delta = sb.edge === 'right' ? e.clientX - startX : startX - e.clientX;
  const nw = Math.max(sb.min, Math.min(sb.max, startW + delta));
  el.style.width = nw + 'px';
});

window.addEventListener('mouseup', () => {
  if (!activeDrag) return;
  const { el, sb } = activeDrag;
  activeDrag = null;
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
  save(sb.id, parseInt(el.style.width));
});

export function wireResizableSidebars(root) {
  for (const sb of SIDEBARS) {
    const el = root.querySelector(sb.sel);
    if (!el) continue;

    // Apply saved width
    el.style.width = load(sb.id, sb.def) + 'px';
    el.style.position = 'relative';
    // Companion is the rightmost panel — give it a stacking context so its
    // absolutely-positioned handle renders above the adjacent center column.
    if (sb.id === 'companion') el.style.zIndex = '1';

    // Find or create the drag handle
    let handle = el.querySelector('.oc-resize-handle');
    if (!handle) {
      handle = document.createElement('div');
      handle.className = 'oc-resize-handle';
      handle.setAttribute('aria-hidden', 'true');
      el.appendChild(handle);
    }

    // Position on the correct edge — 8px wide for a comfortable grab target.
    // Inset to 0 so we never extend outside the element (avoids z-index fights
    // with siblings); the visual ::after indicator is centred on this hit area.
    if (sb.edge === 'right') {
      handle.style.cssText = 'position:absolute;right:0;top:0;bottom:0;width:8px;cursor:col-resize;z-index:10';
    } else {
      handle.style.cssText = 'position:absolute;left:0;top:0;bottom:0;width:8px;cursor:col-resize;z-index:10';
    }

    // Replace mousedown each render so the closure always captures the live el.
    // Clone-replace is the cleanest way to drop all previous listeners on the node.
    const fresh = handle.cloneNode(true);
    handle.replaceWith(fresh);
    fresh.addEventListener('mousedown', (e) => {
      e.preventDefault();
      activeDrag = { el, sb, startX: e.clientX, startW: el.getBoundingClientRect().width };
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
    });
  }
}
