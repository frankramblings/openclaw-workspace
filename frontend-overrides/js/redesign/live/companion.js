// Live wiring for the companion **Files** pane (desktop split mini-IDE) and the
// mobile companion sheet. Both render `fsRows(state)` which reads
// `state.live.companion.tree` with a fallback to the `FS` mock in ../data.js.
//
// We only wire the file tree here — the clean, robust win. The Terminal pane is
// intentionally left as its existing visual mock: the redesign rebuilds
// #oc-root on every state change, which would destroy a mounted xterm/WS, so a
// live terminal would break on the next re-render. See the parent's summary.
//
// Endpoint: GET /api/workspace/tree?hidden=0
//   → { root, branch, dirty, tree: [{ name, path, type:'file'|'dir', size, children? }] }
//
// Target (mock) shape consumed by the render:
//   state.live.companion = { tree: [ {n, t:'dir'|<ext>, meta?, children?} ] }
//   dir:  { n: name, t: 'dir', meta: String(childCount)|undefined, children:[...] }
//   file: { n: name, t: extOf(name) }   // ext like 'md','json','db','env','txt'
// The render colors md/json/db/env via EXT_COLOR and falls back to muted.

import { apiGet } from './api.js';

/** Lowercase file extension (no dot), or '' when the name has none. */
function extOf(name) {
  const base = String(name);
  const dot = base.lastIndexOf('.');
  // No '.', or leading-dot dotfile like ".env" (dot at index 0) → treat the
  // trailing segment as the ext so ".env" maps to t:'env'.
  if (dot < 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

/** Sort: directories first, then files; alphabetical (case-insensitive) within each. */
function order(a, b) {
  const ad = a.type === 'dir' ? 0 : 1;
  const bd = b.type === 'dir' ? 0 : 1;
  if (ad !== bd) return ad - bd;
  return String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' });
}

/** Transform one endpoint node into the mock FS shape. */
function toNode(node) {
  if (node && node.type === 'dir') {
    const kids = Array.isArray(node.children) ? node.children : [];
    const sorted = kids.slice().sort(order);
    return {
      n: node.name,
      t: 'dir',
      meta: String(sorted.length),
      children: sorted.map(toNode),
    };
  }
  return { n: node.name, t: extOf(node.name) };
}

/** Transform the endpoint tree array into the mock FS array. */
function transform(tree) {
  return tree.slice().sort(order).map(toNode);
}

// Populate state.live.companion in the mock's shape. Throwing keeps the mock.
export async function load(state) {
  const data = await apiGet('/api/workspace/tree?hidden=0');
  if (!data || !Array.isArray(data.tree)) {
    throw new Error('workspace tree: missing tree array');
  }
  state.live = state.live || {};
  state.live.companion = { tree: transform(data.tree) };
}
