// Drag-to-resize for the redesign's sidebar panels.
// wireResizableSidebars() is called after every render (root.innerHTML rebuild).
// Window-level pointermove/pointerup are registered ONCE at module load to avoid
// the accumulating-listener bug that occurs when wiring inside a render loop.
// Pointer events (not mouse events) so a finger or Apple Pencil on iPadOS drags
// the handle too; on coarse pointers the handle is wider and straddles the edge.
//
// The conversation list ('chat-list') also collapses: drag it past `min` by
// COLLAPSE_SLACK px, or double-tap/double-click the handle, and it dispatches
// `oc-sidebar-collapse` (app.js owns the collapsed state).

const KEY = (id) => `oc-sidebar-width:${id}`;
const load = (id, def) => { try { const v = parseInt(localStorage.getItem(KEY(id))); return isNaN(v) ? def : v; } catch (_) { return def; } };
const save = (id, w) => { try { localStorage.setItem(KEY(id), w); } catch (_) {} };

// left-side panels: handle on the RIGHT edge; dragging right = grow.
// right-side panels: handle on the LEFT edge; dragging left = grow.
const SIDEBARS = [
  { sel: '.oc-rail:not(.collapsed)', id: 'rail',      edge: 'right', min: 160, max: 320, def: 208 },
  { sel: '.chat-list',               id: 'chat-list', edge: 'right', min: 200, max: 420, def: 280, collapses: true },
  { sel: '.companion',               id: 'companion', edge: 'left',  min: 280, max: 560, def: 372 },
  { sel: '.set-nav',                 id: 'set-nav',   edge: 'right', min: 160, max: 340, def: 220 },
  { sel: '.notes-list',              id: 'notes-list',edge: 'right', min: 200, max: 440, def: 300 },
];

const COLLAPSE_SLACK = 50;
const DBL_MS = 350;
const coarse = () => { try { return window.matchMedia('(pointer:coarse)').matches; } catch (_) { return false; } };
const collapseList = (id) => window.dispatchEvent(new CustomEvent('oc-sidebar-collapse', { detail: { id } }));

// Module-level drag state — one global handler pair on window, wired once.
let activeDrag = null; // { el, sb, startX, startW }

let lastTap = { id: null, t: 0 };

window.addEventListener('pointermove', (e) => {
  if (!activeDrag || e.pointerId !== activeDrag.pointerId) return;
  const { el, sb, startX, startW } = activeDrag;
  const delta = sb.edge === 'right' ? e.clientX - startX : startX - e.clientX;
  activeDrag.raw = startW + delta;
  activeDrag.moved = activeDrag.moved || Math.abs(e.clientX - startX) > 4;
  const nw = Math.max(sb.min, Math.min(sb.max, activeDrag.raw));
  el.style.width = nw + 'px';
});

function endDrag(e, cancelled) {
  if (!activeDrag || e.pointerId !== activeDrag.pointerId) return;
  const { el, sb, handle, raw, moved } = activeDrag;
  activeDrag = null;
  handle.classList.remove('dragging');
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
  el.style.transition = '';               // restore the CSS-declared transition (only .oc-rail has one)
  if (cancelled) return;
  if (sb.collapses && moved && raw < sb.min - COLLAPSE_SLACK) { collapseList(sb.id); return; }
  if (sb.collapses && !moved) {           // double-tap / double-click the handle
    const now = Date.now();
    if (lastTap.id === sb.id && now - lastTap.t < DBL_MS) { lastTap = { id: null, t: 0 }; collapseList(sb.id); return; }
    lastTap = { id: sb.id, t: now };
  }
  save(sb.id, parseInt(el.style.width));
}
window.addEventListener('pointerup', (e) => endDrag(e, false));
window.addEventListener('pointercancel', (e) => endDrag(e, true));

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
    // Coarse pointers (iPad): 24px, half of it outside the panel, so a finger can
    // land on it without covering the rows' right-edge controls.
    const w = coarse() ? 24 : 8;
    const off = coarse() ? -12 : 0;
    handle.style.cssText = `position:absolute;${sb.edge === 'right' ? 'right' : 'left'}:${off}px;top:0;bottom:0;width:${w}px;cursor:col-resize;z-index:10;touch-action:none`;

    // Replace mousedown each render so the closure always captures the live el.
    // Clone-replace is the cleanest way to drop all previous listeners on the node.
    const fresh = handle.cloneNode(true);
    handle.replaceWith(fresh);
    fresh.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      try { fresh.setPointerCapture(e.pointerId); } catch (_) {}
      fresh.classList.add('dragging');
      activeDrag = { el, sb, handle: fresh, pointerId: e.pointerId, startX: e.clientX, startW: el.getBoundingClientRect().width, raw: 0, moved: false };
      el.style.transition = 'none';       // let width track the cursor 1:1 during the drag
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
    });
  }
}
