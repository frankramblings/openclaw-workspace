// HERMES: WORKSPACE explorer pane — read-only tree of the agent workspace.
// Self-contained overlay (no module imports), tolerant of a backend that
// doesn't have /api/workspace yet (pane simply stays hidden).
(function () {
  const LS_KEY = 'hermes-explorer-collapsed';
  const fmt = (n) => {
    if (n == null) return '';
    if (n < 1024) return n + 'b';
    const k = n / 1024;
    return (k >= 100 ? Math.round(k) : k.toFixed(1)) + 'k';
  };
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);

  function renderNodes(nodes, depth) {
    return nodes.map((n) => {
      if (n.type === 'dir') {
        const kids = n.children && n.children.length
          ? renderNodes(n.children, depth + 1) : '';
        return `<details class="we-dir" ${depth < 1 ? 'open' : ''}>` +
          `<summary style="--we-depth:${depth}">${esc(n.name)}</summary>${kids}</details>`;
      }
      return `<div class="we-file" style="--we-depth:${depth}" data-path="${esc(n.path)}">` +
        `<span class="we-name">${esc(n.name)}</span>` +
        `<span class="we-size">${fmt(n.size)}</span></div>`;
    }).join('');
  }

  async function load(fresh) {
    let data = null;
    try {
      const r = await fetch('/api/workspace/tree' + (fresh ? '?fresh=1' : ''));
      if (r.ok) data = await r.json();
    } catch (e) { /* backend not restarted yet — stay hidden */ }
    const pane = document.getElementById('workspace-explorer');
    if (!pane) return;
    if (!data || !Array.isArray(data.tree)) {
      pane.hidden = true;
      const reopen = document.getElementById('we-reopen');
      if (reopen) reopen.hidden = true;
      return;
    }
    const branch = document.getElementById('we-branch');
    if (branch) { branch.textContent = data.branch || ''; branch.hidden = !data.branch; }
    const tree = document.getElementById('we-tree');
    tree.innerHTML = data.missing
      ? '<div class="we-empty">workspace directory not found</div>'
      : (renderNodes(data.tree, 0) +
         (data.truncated ? '<div class="we-empty">… listing truncated</div>' : ''));
    _available = true;
    applyCollapsed();
  }

  let _available = false;

  function applyCollapsed() {
    if (!_available) return;
    const collapsed = localStorage.getItem(LS_KEY) === '1';
    const pane = document.getElementById('workspace-explorer');
    const reopen = document.getElementById('we-reopen');
    if (pane) pane.hidden = collapsed;
    if (reopen) reopen.hidden = !collapsed;
  }

  function preview(path) {
    const url = '/api/workspace/file?path=' + encodeURIComponent(path);
    const lower = path.toLowerCase();
    const isImg = /\.(png|jpe?g|gif|webp|svg)$/.test(lower);
    const overlay = document.createElement('div');
    overlay.id = 'we-preview-overlay';
    overlay.innerHTML =
      `<div id="we-preview"><div class="we-preview-head">` +
      `<span class="hermes-mono">${esc(path)}</span>` +
      `<a href="${url}" download>Download</a>` +
      `<button type="button" id="we-preview-close">&#x2715;</button></div>` +
      `<div class="we-preview-body">${isImg ? `<img src="${url}" alt="">` : '<pre></pre>'}</div></div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.id === 'we-preview-close') overlay.remove();
    });
    if (!isImg) {
      fetch(url).then((r) => r.ok ? r.text() : Promise.reject(r.status))
        .then((t) => { overlay.querySelector('pre').textContent = t; })
        .catch(() => { overlay.querySelector('pre').textContent = '(binary file — use Download)'; });
    }
  }

  function init() {
    const pane = document.getElementById('workspace-explorer');
    if (!pane) return;
    document.getElementById('we-refresh').addEventListener('click', () => load(true));
    document.getElementById('we-collapse').addEventListener('click', () => {
      localStorage.setItem(LS_KEY, '1'); applyCollapsed();
    });
    document.getElementById('we-reopen').addEventListener('click', () => {
      localStorage.setItem(LS_KEY, '0'); applyCollapsed();
    });
    pane.addEventListener('click', (e) => {
      const f = e.target.closest('.we-file');
      if (f) preview(f.dataset.path);
    });
    load(false);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
