// HERMES: WORKSPACE explorer pane — workspace tree with Hermes-parity
// controls: upload (button + OS drag-drop), new file/folder, rename / move /
// delete via context menu (right-click; ~500ms long-press on touch), hidden
// files toggle, git dirty badge, Files/Artifacts tabs, resizable panel.
// Self-contained overlay (no module imports), tolerant of a backend that
// doesn't have /api/workspace yet (pane stays hidden; ops toast HTTP errors).
// Blocks marked "lifted from hermes-webui" are MIT (nesquena/hermes-webui).
(function () {
  const LS_COLLAPSED = 'hermes-explorer-collapsed';
  const LS_EXPANDED = 'hermes-explorer-expanded';
  const LS_HIDDEN = 'hermes-workspace-show-hidden';
  const LS_WIDTH = 'hermes-explorer-width';

  const state = {
    showHidden: localStorage.getItem(LS_HIDDEN) === '1',
    expanded: null,          // Set<dirPath> | null = no saved state (depth<1 open)
    root: '',                // absolute workspace root from the tree response
    knownFiles: new Set(),   // rel paths of files in the loaded tree
    knownDirs: new Set(),
    artifacts: [],           // [{path}] newest first; session-scoped
    pending: new Set(),      // harvested tokens not (yet) matching the tree
    tab: 'files',
  };
  let _available = false;
  let _suppressClick = false; // swallow the synthetic click after a long-press
  let _refreshTimer = null;

  try {
    const saved = JSON.parse(localStorage.getItem(LS_EXPANDED) || 'null');
    if (Array.isArray(saved)) state.expanded = new Set(saved);
  } catch (_e) { /* corrupted state — fall back to default-open */ }

  const fmt = (n) => {
    if (n == null) return '';
    if (n < 1024) return n + 'b';
    const k = n / 1024;
    return (k >= 100 ? Math.round(k) : k.toFixed(1)) + 'k';
  };
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
  const baseName = (p) => p.split('/').pop();
  const parentDir = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const joinPath = (base, rel) => {
    const r = (rel || '').replace(/^\/+|\/+$/g, '');
    if (!r) return base || '';
    return base ? base + '/' + r : r;
  };

  // ---------- toast + dialogs ----------
  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'we-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2500);
  }

  function dialog(opts) {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'we-dialog-overlay';
      ov.innerHTML = '<div class="we-dialog"><div class="we-dialog-msg"></div>' +
        (opts.input ? '<input type="text">' : '') +
        '<div class="we-dialog-btns"><button type="button" class="we-cancel">Cancel</button>' +
        '<button type="button" class="we-ok' + (opts.danger ? ' danger' : '') + '"></button></div></div>';
      ov.querySelector('.we-dialog-msg').textContent = opts.message;
      ov.querySelector('.we-ok').textContent = opts.confirmLabel || 'OK';
      const input = ov.querySelector('input');
      if (input) {
        input.value = opts.value || '';
        if (opts.placeholder) input.placeholder = opts.placeholder;
      }
      const done = (val) => {
        ov.remove();
        document.removeEventListener('keydown', onKey, true);
        resolve(val);
      };
      const ok = () => done(input ? input.value.trim() : true);
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); done(null); }
        else if (e.key === 'Enter' && input) { e.stopPropagation(); ok(); }
      };
      document.addEventListener('keydown', onKey, true);
      ov.querySelector('.we-cancel').addEventListener('click', () => done(null));
      ov.querySelector('.we-ok').addEventListener('click', ok);
      ov.addEventListener('click', (e) => { if (e.target === ov) done(null); });
      document.body.appendChild(ov);
      setTimeout(() => {
        if (!input) { ov.querySelector(opts.danger ? '.we-cancel' : '.we-ok').focus(); return; }
        input.focus();
        // Finder-style stem selection — lifted from hermes-webui (MIT):
        // select the basename before the LAST '.', so retyping keeps the
        // extension; dotfiles ('.gitignore') and no-dot names full-select.
        const v = input.value || '';
        if (opts.selectStem && v) {
          const dot = v.lastIndexOf('.');
          if (dot > 0) input.setSelectionRange(0, dot);
          else input.select();
        } else if (opts.selectAll && v) input.select();
      }, 0);
    });
  }
  const showPrompt = (o) => dialog(Object.assign({}, o, { input: true }));
  const showConfirm = (o) => dialog(Object.assign({}, o, { input: false })).then((v) => v === true);

  // ---------- api ----------
  async function post(url, body) {
    const r = await fetch(url, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      let d = '';
      try { d = (await r.json()).detail || ''; } catch (_e) { /* non-JSON error */ }
      throw new Error(d || 'HTTP ' + r.status);
    }
    return r.json();
  }

  // ---------- tree ----------
  function renderNodes(nodes, depth) {
    return nodes.map((n) => {
      if (!state.showHidden && n.name.startsWith('.')) return '';
      if (n.type === 'dir') {
        const kids = n.children && n.children.length
          ? renderNodes(n.children, depth + 1) : '';
        const open = state.expanded ? state.expanded.has(n.path) : depth < 1;
        return `<details class="we-dir" data-path="${esc(n.path)}" ${open ? 'open' : ''}>` +
          `<summary style="--we-depth:${depth}" data-path="${esc(n.path)}" data-type="dir" draggable="true">${esc(n.name)}</summary>${kids}</details>`;
      }
      return `<div class="we-file" style="--we-depth:${depth}" data-path="${esc(n.path)}" data-type="file" draggable="true">` +
        `<span class="we-name">${esc(n.name)}</span>` +
        `<span class="we-size">${fmt(n.size)}</span></div>`;
    }).join('');
  }

  function indexTree(nodes) {
    for (const n of nodes) {
      if (n.type === 'dir') {
        state.knownDirs.add(n.path);
        if (n.children) indexTree(n.children);
      } else state.knownFiles.add(n.path);
    }
  }

  function saveExpanded() {
    if (state.expanded) localStorage.setItem(LS_EXPANDED, JSON.stringify([...state.expanded]));
  }

  async function load(fresh) {
    let data = null;
    try {
      const url = '/api/workspace/tree?hidden=' + (state.showHidden ? '1' : '0') +
        (fresh ? '&fresh=1' : '');
      const r = await fetch(url, { credentials: 'same-origin' });
      if (r.ok) data = await r.json();
    } catch (_e) { /* backend not restarted yet — stay hidden */ }
    const pane = document.getElementById('workspace-explorer');
    if (!pane) return;
    if (!data || !Array.isArray(data.tree)) {
      pane.hidden = true;
      const reopen = document.getElementById('we-reopen');
      if (reopen) reopen.hidden = true;
      return;
    }
    state.root = (data.root || '').replace(/\/+$/, '');
    const branch = document.getElementById('we-branch');
    if (branch) {
      branch.textContent = (data.branch || '') + (data.branch && data.dirty ? ' ●' : '');
      branch.title = data.dirty ? 'Uncommitted changes' : '';
      branch.hidden = !data.branch;
    }
    const ind = document.getElementById('we-hidden-ind');
    if (ind) ind.hidden = !state.showHidden;
    state.knownFiles = new Set();
    state.knownDirs = new Set();
    indexTree(data.tree);
    const tree = document.getElementById('we-tree');
    tree.innerHTML = data.missing
      ? '<div class="we-empty">workspace directory not found</div>'
      : (renderNodes(data.tree, 0) +
         (data.truncated ? '<div class="we-empty">… listing truncated</div>' : ''));
    _available = true;
    matchPending();
    applyCollapsed();
  }

  function applyCollapsed() {
    if (!_available) return;
    const collapsed = localStorage.getItem(LS_COLLAPSED) === '1';
    const pane = document.getElementById('workspace-explorer');
    const reopen = document.getElementById('we-reopen');
    if (pane) pane.hidden = collapsed;
    if (reopen) reopen.hidden = !collapsed;
  }

  // ---------- open / preview (unchanged from v1) ----------
  async function openInEditor(path) {
    let data = null;
    try {
      const r = await fetch('/api/vault/open?path=' + encodeURIComponent(path),
        { credentials: 'same-origin' });
      if (!r.ok) return false;
      data = await r.json();
    } catch (_e) { return false; }
    const dm = window.documentModule;
    if (!dm || !dm.injectFreshDoc || !data || !data.id) return false;
    dm.injectFreshDoc(data);
    return true;
  }

  function openFile(path) {
    if (/\.(png|jpe?g|gif|webp|svg)$/.test(path.toLowerCase())) { preview(path); return; }
    openInEditor(path).then((ok) => { if (!ok) preview(path); });
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

  // ---------- file ops ----------
  async function doCreate(dir, isFolder) {
    const name = await showPrompt({
      message: (isFolder ? 'New folder in ' : 'New file in ') + (dir || 'workspace root'),
      placeholder: isFolder ? 'folder-name' : 'filename.md',
      confirmLabel: 'Create',
    });
    if (!name) return;
    const rel = dir ? dir + '/' + name : name;
    try {
      await post(isFolder ? '/api/workspace/mkdir' : '/api/workspace/create', { path: rel });
      toast('Created ' + name);
      if (dir && state.expanded) { state.expanded.add(dir); saveExpanded(); }
      await load(true);
      if (!isFolder) openFile(rel);
    } catch (e) { toast('Create failed: ' + e.message); }
  }

  async function doRename(item) {
    const name = await showPrompt({
      message: 'Rename ' + item.name, value: item.name, confirmLabel: 'Rename',
      selectStem: item.type !== 'dir', selectAll: item.type === 'dir',
    });
    if (!name || name === item.name) return;
    try {
      await post('/api/workspace/rename', { path: item.path, new_name: name });
      toast('Renamed to ' + name);
      load(true);
    } catch (e) { toast('Rename failed: ' + e.message); }
  }

  async function doMove(item) {
    const dest = await showPrompt({
      message: 'Move ' + item.name + ' to folder (empty = workspace root)',
      value: parentDir(item.path), confirmLabel: 'Move',
    });
    if (dest === null) return;
    try {
      await post('/api/workspace/move', { path: item.path, dest_dir: dest });
      toast('Moved ' + item.name);
      load(true);
    } catch (e) { toast('Move failed: ' + e.message); }
  }

  async function doDelete(item) {
    const ok = await showConfirm({
      message: item.type === 'dir'
        ? 'Delete folder "' + item.name + '" and everything inside it? This cannot be undone.'
        : 'Delete "' + item.name + '"? This cannot be undone.',
      confirmLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    try {
      await post('/api/workspace/delete', { path: item.path });
      toast('Deleted ' + item.name);
      load(true);
    } catch (e) { toast('Delete failed: ' + e.message); }
  }

  function copyPath(item) {
    const abs = state.root ? state.root + '/' + item.path : item.path;
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = abs;
      ta.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_e) { /* denied */ }
      ta.remove();
      toast(ok ? 'Path copied' : 'Copy failed');
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(abs).then(() => toast('Path copied'), fallback);
    } else fallback();
  }

  function downloadItem(item) {
    const url = item.type === 'dir'
      ? '/api/workspace/archive?path=' + encodeURIComponent(item.path)
      : '/api/workspace/file?path=' + encodeURIComponent(item.path);
    const a = document.createElement('a');
    a.href = url;
    a.download = item.name + (item.type === 'dir' ? '.zip' : '');
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ---------- context menu ----------
  function closeMenu() {
    document.querySelectorAll('.we-menu').forEach((m) => m.remove());
  }

  function itemFromRow(row) {
    const path = row.dataset.path;
    return { path, type: row.dataset.type === 'dir' ? 'dir' : 'file', name: baseName(path) };
  }

  function menuShell() {
    closeMenu();
    const menu = document.createElement('div');
    menu.className = 'we-menu';
    const dismiss = (e) => {
      if (!menu.contains(e.target)) {
        closeMenu();
        document.removeEventListener('click', dismiss);
      }
    };
    setTimeout(() => document.addEventListener('click', dismiss), 0);
    return menu;
  }

  function placeMenu(menu, x, y) {
    document.body.appendChild(menu);
    menu.style.left = Math.max(4, Math.min(x, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, window.innerHeight - menu.offsetHeight - 8)) + 'px';
  }

  function showMenu(item, x, y) {
    const menu = menuShell();
    const add = (label, fn, cls) => {
      const it = document.createElement('div');
      it.className = 'we-menu-item' + (cls ? ' ' + cls : '');
      it.textContent = label;
      it.addEventListener('click', () => { closeMenu(); fn(); });
      menu.appendChild(it);
    };
    if (item.type === 'dir') {
      add('New file here', () => doCreate(item.path, false));
      add('New folder here', () => doCreate(item.path, true));
      add('Rename', () => doRename(item));
      add('Move to…', () => doMove(item));
      add('Download zip', () => downloadItem(item));
    } else {
      add('Open', () => openFile(item.path));
      add('Rename', () => doRename(item));
      add('Move to…', () => doMove(item));
      add('Copy path', () => copyPath(item));
      add('Download', () => downloadItem(item));
    }
    menu.appendChild(document.createElement('hr'));
    add('Delete', () => doDelete(item), 'danger');
    placeMenu(menu, x, y);
  }

  function showPrefs(anchor) {
    const menu = menuShell();
    const it = document.createElement('div');
    it.className = 'we-menu-item';
    it.innerHTML = '<label style="display:flex;gap:8px;align-items:center;cursor:pointer">' +
      '<input type="checkbox"' + (state.showHidden ? ' checked' : '') + '> Show hidden files</label>';
    it.querySelector('input').addEventListener('change', (e) => {
      state.showHidden = e.target.checked;
      localStorage.setItem(LS_HIDDEN, state.showHidden ? '1' : '0');
      load(true);
    });
    menu.appendChild(it);
    const r = anchor.getBoundingClientRect();
    placeMenu(menu, r.left, r.bottom + 4);
  }

  function bindLongPress(tree) {
    let timer = null, sx = 0, sy = 0;
    tree.addEventListener('touchstart', (e) => {
      const row = e.target.closest('.we-file, summary[data-type="dir"]');
      if (!row) return;
      const t = e.touches[0];
      sx = t.clientX; sy = t.clientY;
      timer = setTimeout(() => {
        timer = null;
        // iOS fires a synthetic click after touchend (and sometimes none at
        // all after long holds) — suppress the next click briefly so the
        // menu isn't instantly dismissed or the file opened.
        _suppressClick = true;
        setTimeout(() => { _suppressClick = false; }, 700);
        showMenu(itemFromRow(row), sx, sy);
      }, 500);
    }, { passive: true });
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    tree.addEventListener('touchmove', (e) => {
      if (!timer) return;
      const t = e.touches[0];
      if (Math.abs(t.clientX - sx) > 10 || Math.abs(t.clientY - sy) > 10) cancel();
    }, { passive: true });
    tree.addEventListener('touchend', cancel, { passive: true });
    tree.addEventListener('touchcancel', cancel, { passive: true });
  }

  // ---------- upload ----------
  async function uploadFiles(files, dir) {
    if (!files || !files.length) return;
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    fd.append('dir', dir || '');
    try {
      const r = await fetch('/api/workspace/upload',
        { method: 'POST', credentials: 'same-origin', body: fd });
      if (!r.ok) {
        let d = '';
        try { d = (await r.json()).detail || ''; } catch (_e) { /* non-JSON */ }
        throw new Error(d || 'HTTP ' + r.status);
      }
      toast('Uploaded ' + files.length + (files.length > 1 ? ' files' : ' file'));
      load(true);
    } catch (e) { toast('Upload failed: ' + e.message); }
  }

  // ---- OS drag-drop upload helpers — lifted from hermes-webui (MIT) ----
  function isOsFilesDrag(e) {
    return !!(e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files'));
  }
  function isMoveDrag(e) {
    return !!(e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('application/ws-path'));
  }
  async function readAllDirectoryEntries(reader) {
    const entries = [];
    while (true) {
      const batch = await new Promise((resolve, reject) => {
        reader.readEntries(resolve, reject);
      });
      if (!batch.length) break;
      entries.push(...batch);
    }
    return entries;
  }
  async function collectFilesFromEntry(entry, relPrefix) {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => { entry.file(resolve, reject); });
      return [{ file, relDir: relPrefix || '' }];
    }
    if (!entry.isDirectory) return [];
    const reader = entry.createReader();
    const children = await readAllDirectoryEntries(reader);
    const dirPrefix = `${relPrefix || ''}${entry.name}/`;
    let out = [];
    for (const child of children) {
      out = out.concat(await collectFilesFromEntry(child, dirPrefix));
    }
    return out;
  }
  async function collectOsDropUploads(dataTransfer) {
    const out = [];
    const items = dataTransfer.items ? [...dataTransfer.items] : [];
    if (items.length && typeof items[0].webkitGetAsEntry === 'function') {
      for (const item of items) {
        if (item.kind !== 'file') continue;
        const entry = item.webkitGetAsEntry();
        if (!entry) continue;
        out.push(...await collectFilesFromEntry(entry, ''));
      }
      if (out.length) return out;
    }
    for (const file of dataTransfer.files) out.push({ file, relDir: '' });
    return out;
  }
  // ---- end lifted block ----

  async function uploadOsDrop(dataTransfer, destDir) {
    const uploads = await collectOsDropUploads(dataTransfer);
    const groups = new Map();
    for (const u of uploads) {
      const d = u.relDir ? joinPath(destDir, u.relDir.replace(/\/+$/, '')) : (destDir || '');
      if (!groups.has(d)) groups.set(d, []);
      groups.get(d).push(u.file);
    }
    for (const [d, fs] of groups) await uploadFiles(fs, d);
  }

  // ---------- drag-to-move + OS drop targets ----------
  function clearDragOver() {
    document.querySelectorAll('.we-tree .drag-over').forEach((el) => el.classList.remove('drag-over'));
  }

  function bindDnD(tree) {
    tree.addEventListener('dragstart', (e) => {
      const row = e.target.closest('.we-file, summary[data-type="dir"]');
      if (!row) return;
      e.dataTransfer.setData('application/ws-path', row.dataset.path);
      e.dataTransfer.setData('application/ws-type', row.dataset.type);
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    tree.addEventListener('dragend', (e) => {
      const row = e.target.closest('.we-file, summary[data-type="dir"]');
      if (row) row.classList.remove('dragging');
      clearDragOver();
    });
    const destOf = (e) => {
      const sum = e.target.closest('summary[data-type="dir"]');
      return sum ? { el: sum, dir: sum.dataset.path } : { el: tree, dir: '' };
    };
    tree.addEventListener('dragover', (e) => {
      if (!isMoveDrag(e) && !isOsFilesDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = isOsFilesDrag(e) ? 'copy' : 'move';
      clearDragOver();
      const { el } = destOf(e);
      if (el !== tree) el.classList.add('drag-over');
    });
    tree.addEventListener('dragleave', (e) => {
      if (!tree.contains(e.relatedTarget)) clearDragOver();
    });
    tree.addEventListener('drop', async (e) => {
      const os = isOsFilesDrag(e), mv = isMoveDrag(e);
      if (!os && !mv) return;
      e.preventDefault();
      clearDragOver();
      const { dir } = destOf(e);
      if (os) { await uploadOsDrop(e.dataTransfer, dir); return; }
      const src = e.dataTransfer.getData('application/ws-path');
      if (!src || src === dir || parentDir(src) === dir) return;
      try {
        await post('/api/workspace/move', { path: src, dest_dir: dir });
        toast('Moved ' + baseName(src));
        load(true);
      } catch (err) { toast('Move failed: ' + err.message); }
    });
  }

  // ---------- artifacts ----------
  function harvest(frame) {
    const text = [frame.tool, frame.command, frame.output]
      .filter((s) => typeof s === 'string').join(' ');
    if (!text) return;
    const tokens = text.match(/[\w][\w.\-\/]{2,}/g) || [];
    for (let t of tokens) {
      t = t.replace(/^\.\//, '').replace(/[.,;:)\]]+$/, '');
      if (state.root && t.startsWith(state.root + '/')) t = t.slice(state.root.length + 1);
      if (!t || t.length > 300) continue;
      state.pending.add(t);
    }
    if (state.pending.size > 500) {
      // bound memory: Sets iterate in insertion order, drop the oldest
      const it = state.pending.values();
      while (state.pending.size > 300) state.pending.delete(it.next().value);
    }
    matchPending();
    if (frame.type === 'tool_output' &&
        /write|edit|patch|save|mkdir|touch|tee|create|apply|mv |cp /i.test(text)) {
      scheduleRefresh();
    }
  }

  function matchPending() {
    let added = false;
    for (const t of state.pending) {
      if (!state.knownFiles.has(t)) continue;
      state.pending.delete(t);
      if (!state.artifacts.some((a) => a.path === t)) {
        state.artifacts.unshift({ path: t });
        added = true;
      }
    }
    if (added) renderArtifacts();
  }

  function renderArtifacts() {
    const list = document.getElementById('we-artifacts');
    const count = document.getElementById('we-art-count');
    if (count) count.textContent = String(state.artifacts.length);
    if (!list) return;
    list.innerHTML = state.artifacts.length
      ? state.artifacts.map((a) =>
          `<div class="we-artifact" data-path="${esc(a.path)}">` +
          `<span class="we-name">${esc(baseName(a.path))}</span>` +
          `<span class="we-art-dir">${esc(parentDir(a.path) || '/')}</span></div>`).join('')
      : '<div class="we-empty">No files touched this session yet</div>';
  }

  function setTab(tab) {
    state.tab = tab;
    document.getElementById('we-tab-files').classList.toggle('active', tab === 'files');
    document.getElementById('we-tab-artifacts').classList.toggle('active', tab === 'artifacts');
    document.getElementById('we-tree').hidden = tab !== 'files';
    document.getElementById('we-artifacts').hidden = tab !== 'artifacts';
  }

  function scheduleRefresh() {
    clearTimeout(_refreshTimer);
    _refreshTimer = setTimeout(() => load(true), 4000);
  }

  // ---------- panel resize ----------
  function initResize(pane) {
    const saved = parseInt(localStorage.getItem(LS_WIDTH) || '', 10);
    if (saved >= 200 && saved <= 600) pane.style.width = saved + 'px';
    const handle = document.getElementById('we-resize');
    if (!handle) return;
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX, startW = pane.offsetWidth;
      const move = (ev) => {
        const w = Math.min(600, Math.max(200, startW + (startX - ev.clientX)));
        pane.style.width = w + 'px';
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        localStorage.setItem(LS_WIDTH, String(pane.offsetWidth));
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up, { once: true });
    });
  }

  // ---------- init ----------
  function init() {
    const pane = document.getElementById('workspace-explorer');
    if (!pane) return;
    const tree = document.getElementById('we-tree');
    document.getElementById('we-refresh').addEventListener('click', () => load(true));
    document.getElementById('we-collapse').addEventListener('click', () => {
      localStorage.setItem(LS_COLLAPSED, '1'); applyCollapsed();
    });
    document.getElementById('we-reopen').addEventListener('click', () => {
      localStorage.setItem(LS_COLLAPSED, '0'); applyCollapsed();
    });
    const uploadInput = document.getElementById('we-upload-input');
    document.getElementById('we-upload').addEventListener('click', () => uploadInput.click());
    uploadInput.addEventListener('change', () => {
      uploadFiles([...uploadInput.files], '');
      uploadInput.value = '';
    });
    document.getElementById('we-new-file').addEventListener('click', () => doCreate('', false));
    document.getElementById('we-new-folder').addEventListener('click', () => doCreate('', true));
    document.getElementById('we-prefs').addEventListener('click', (e) => {
      e.stopPropagation();
      showPrefs(e.currentTarget);
    });
    document.getElementById('we-tab-files').addEventListener('click', () => setTab('files'));
    document.getElementById('we-tab-artifacts').addEventListener('click', () => setTab('artifacts'));
    document.getElementById('we-artifacts').addEventListener('click', (e) => {
      const a = e.target.closest('.we-artifact');
      if (a) openFile(a.dataset.path);
    });

    tree.addEventListener('click', (e) => {
      if (_suppressClick) {
        _suppressClick = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const f = e.target.closest('.we-file');
      if (f) openFile(f.dataset.path);
    });
    // 'toggle' doesn't bubble, but capture sees it on the container.
    tree.addEventListener('toggle', (e) => {
      const d = e.target;
      if (!d || d.tagName !== 'DETAILS' || !d.dataset.path) return;
      if (!state.expanded) {
        // First explicit toggle: materialize saved state from the current DOM.
        state.expanded = new Set([...tree.querySelectorAll('details[open]')]
          .map((x) => x.dataset.path).filter(Boolean));
      }
      if (d.open) state.expanded.add(d.dataset.path);
      else state.expanded.delete(d.dataset.path);
      saveExpanded();
    }, true);
    tree.addEventListener('contextmenu', (e) => {
      const row = e.target.closest('.we-file, summary[data-type="dir"]');
      if (!row) return;
      e.preventDefault();
      showMenu(itemFromRow(row), e.clientX, e.clientY);
    });
    bindLongPress(tree);
    bindDnD(tree);
    initResize(pane);
    window.addEventListener('workspace:toolframe', (e) => harvest(e.detail || {}));
    window.addEventListener('workspace:session-switch', () => {
      state.artifacts = [];
      state.pending.clear();
      renderArtifacts();
      setTab('files');
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
    renderArtifacts();
    load(false);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
