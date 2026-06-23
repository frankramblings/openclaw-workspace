// Live wiring for the companion **Files** pane (desktop split mini-IDE) and the
// mobile companion sheet. Both render `fsRows(state)` which reads
// `state.live.companion.tree` with a fallback to the `FS` mock in ../data.js.
//
// This wires the Files pane. The Terminal pane is wired separately by
// ./terminal.js (a persistent xterm overlay that survives the full-rerender
// model); we boot it here since the companion loads alongside chat.
//
// Endpoint: GET /api/workspace/tree?hidden=0
//   → { root, branch, dirty, tree: [{ name, path, type:'file'|'dir', size, children? }] }
//
// Target (mock) shape consumed by the render:
//   state.live.companion = { tree: [ {n, t:'dir'|<ext>, meta?, children?} ] }
//   dir:  { n: name, t: 'dir', meta: String(childCount)|undefined, children:[...] }
//   file: { n: name, t: extOf(name) }   // ext like 'md','json','db','env','txt'
// The render colors md/json/db/env via EXT_COLOR and falls back to muted.

import { apiGet, apiJson } from './api.js';
import { runtime } from './runtime.js';
import { initTerminal } from './terminal.js';

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
  initTerminal(); // boot the persistent xterm overlay (idempotent)
  const data = await apiGet('/api/workspace/tree?hidden=0');
  if (!data || !Array.isArray(data.tree)) {
    throw new Error('workspace tree: missing tree array');
  }
  state.live = state.live || {};
  state.live.companion = { tree: transform(data.tree) };
}

// Workspace file-management toolbar actions. All paths are relative to the
// workspace root; created/uploaded items appear after the tree reload.
export const actions = {
  wsNewFile: async () => {
    const state = runtime.state;
    if (!state) return;
    let name = null;
    try { name = window.prompt('New file (path relative to workspace root):', 'untitled.md'); } catch (_) { name = null; }
    if (name == null) return;
    name = name.trim();
    if (!name) return;
    try { await apiJson('/api/workspace/create', { path: name }); } catch (_) {}
    try { await load(state); } catch (_) {}
    runtime.render();
  },
  wsNewFolder: async () => {
    const state = runtime.state;
    if (!state) return;
    let name = null;
    try { name = window.prompt('New folder (path relative to workspace root):', 'new-folder'); } catch (_) { name = null; }
    if (name == null) return;
    name = name.trim();
    if (!name) return;
    try { await apiJson('/api/workspace/mkdir', { path: name }); } catch (_) {}
    try { await load(state); } catch (_) {}
    runtime.render();
  },
  wsUpload: async (files) => {
    const state = runtime.state;
    if (!state || !files || !files.length) return;
    const fd = new FormData();
    for (const f of files) fd.append('files', f, f.name || 'upload');
    fd.append('dir', '');
    try {
      await fetch(`${location.origin}/api/workspace/upload`, { method: 'POST', credentials: 'same-origin', body: fd });
    } catch (_) {}
    try { await load(state); } catch (_) {}
    runtime.render();
  },
  wsRefresh: async () => {
    const state = runtime.state;
    if (!state) return;
    try { await load(state); } catch (_) {}
    runtime.render();
  },
};
