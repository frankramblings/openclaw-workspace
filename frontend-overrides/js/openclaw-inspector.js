// ── openclaw-inspector.js ─────────────────────────────────────────────
// "Inspect" affordance + raw drawer for tool cards and assistant messages.
// Logic + tool-display.json sourced from OpenClaw (MIT,
// https://github.com/openclaw/openclaw):
//   ui/src/ui/tool-display.ts            (icon/title/detail resolver)
//   ui/src/ui/chat/chat-sidebar-raw.ts   ("raw" code-fence sidebar pattern)
//   apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/tool-display.json
// Ported to vanilla JS and adapted to Odysseus's .agent-thread-node markup.
// See frontend-overrides/THIRD-PARTY.md.
(function () {
  'use strict';

  // ---- tool-display resolver (port of tool-display-common.ts) -----------

  let TOOL_SPEC = null;
  let TOOL_SPEC_PROMISE = null;
  function loadToolSpec() {
    if (TOOL_SPEC) return Promise.resolve(TOOL_SPEC);
    if (TOOL_SPEC_PROMISE) return TOOL_SPEC_PROMISE;
    TOOL_SPEC_PROMISE = fetch('/static/data/openclaw-tool-display.json', { cache: 'force-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { TOOL_SPEC = data || { fallback: {}, tools: {} }; return TOOL_SPEC; })
      .catch(() => { TOOL_SPEC = { fallback: {}, tools: {} }; return TOOL_SPEC; });
    return TOOL_SPEC_PROMISE;
  }

  function normalizeToolName(raw) {
    if (!raw || typeof raw !== 'string') return '';
    return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  function parseArgs(raw) {
    if (raw == null) return {};
    if (typeof raw === 'object') return raw;
    if (typeof raw !== 'string') return {};
    try { return JSON.parse(raw); } catch { return {}; }
  }

  function pickFirstString(obj, keys) {
    if (!obj || typeof obj !== 'object' || !Array.isArray(keys)) return '';
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    }
    return '';
  }

  function truncate(text, max) {
    if (!text) return '';
    return text.length <= max ? text : text.slice(0, max - 1) + '…';
  }

  // Returns {emoji, title, detail}. Cheap, sync once spec is loaded.
  window.openclawResolveTool = function resolveTool(toolName, argsRaw) {
    const spec = TOOL_SPEC || { fallback: {}, tools: {} };
    const key = normalizeToolName(toolName);
    const fallback = spec.fallback || {};
    const entry = (spec.tools && spec.tools[key]) || fallback;
    const args = parseArgs(argsRaw);
    const detailKeys = entry.detailKeys || fallback.detailKeys || [];
    const detail = truncate(pickFirstString(args, detailKeys), 120);
    return {
      emoji: entry.emoji || fallback.emoji || '🧩',
      title: entry.title || toolName || 'Tool',
      detail,
    };
  };

  // ---- Inspector drawer -------------------------------------------------

  let drawer, backdrop, body, titleEl, tabs;
  let activeTab = 'raw';
  let activePayload = null;

  function ensureDrawer() {
    if (drawer) return;
    backdrop = document.createElement('div');
    backdrop.id = 'openclaw-inspector-backdrop';
    backdrop.addEventListener('click', closeDrawer);

    drawer = document.createElement('aside');
    drawer.id = 'openclaw-inspector-drawer';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-label', 'Inspector');
    drawer.innerHTML = `
      <header>
        <h3 class="drawer-title">Inspect</h3>
        <button type="button" class="drawer-copy" title="Copy raw JSON" aria-label="Copy">⧉</button>
        <button type="button" class="drawer-close" title="Close" aria-label="Close">×</button>
      </header>
      <nav class="drawer-tabs">
        <button type="button" class="drawer-tab active" data-tab="raw">Raw</button>
        <button type="button" class="drawer-tab" data-tab="pretty">Pretty</button>
      </nav>
      <div class="drawer-body"></div>
    `;
    document.body.appendChild(backdrop);
    document.body.appendChild(drawer);
    titleEl = drawer.querySelector('.drawer-title');
    body = drawer.querySelector('.drawer-body');
    tabs = drawer.querySelectorAll('.drawer-tab');
    drawer.querySelector('.drawer-close').addEventListener('click', closeDrawer);
    drawer.querySelector('.drawer-copy').addEventListener('click', copyCurrent);
    tabs.forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && drawer.classList.contains('open')) closeDrawer();
    });
  }

  function setTab(name) {
    activeTab = name;
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    renderBody();
  }

  function renderBody() {
    if (!activePayload) { body.innerHTML = ''; return; }
    const sections = activePayload.sections || [];
    const html = sections.map((s) => {
      const text = activeTab === 'pretty' && s.pretty ? s.pretty : (s.raw || '');
      const safe = escapeHtml(text);
      return `<div class="drawer-section-label">${escapeHtml(s.label)}</div><pre class="drawer-code">${safe}</pre>`;
    }).join('');
    body.innerHTML = html;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function openDrawer(title, payload) {
    ensureDrawer();
    titleEl.textContent = title || 'Inspect';
    activePayload = payload;
    renderBody();
    requestAnimationFrame(() => {
      backdrop.classList.add('open');
      drawer.classList.add('open');
    });
  }

  function closeDrawer() {
    if (!drawer) return;
    drawer.classList.remove('open');
    backdrop.classList.remove('open');
  }

  function copyCurrent() {
    if (!activePayload) return;
    const text = (activePayload.sections || [])
      .map((s) => `${s.label}\n${(activeTab === 'pretty' && s.pretty) ? s.pretty : (s.raw || '')}`)
      .join('\n\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
  }

  // ---- Tool-card augmentation -------------------------------------------

  function augmentToolNode(node) {
    if (!node || node.__openclawAugmented) return;
    node.__openclawAugmented = true;

    const header = node.querySelector('.agent-thread-header');
    if (header && !header.querySelector('.agent-thread-inspect')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'agent-thread-inspect';
      btn.title = 'Inspect raw';
      btn.setAttribute('aria-label', 'Inspect raw');
      btn.textContent = '⧉';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        inspectToolNode(node);
      });
      header.appendChild(btn);
    }

    // Add a detail line populated from the resolved tool spec.
    const toolEl = node.querySelector('.agent-thread-tool');
    const cmdEl = node.querySelector('.agent-thread-cmd');
    if (toolEl && !node.querySelector('.agent-thread-detail')) {
      const toolName = toolEl.textContent.trim();
      // Use the command-as-detail if we have one; otherwise resolve via spec.
      const rawCmd = cmdEl ? cmdEl.textContent.trim() : '';
      loadToolSpec().then(() => {
        const resolved = window.openclawResolveTool(toolName, rawCmd ? { command: rawCmd } : {});
        const detailText = resolved.detail || rawCmd;
        if (detailText) {
          const det = document.createElement('div');
          det.className = 'agent-thread-detail';
          det.textContent = detailText;
          // Insert after the header (but before the existing content).
          const content = node.querySelector('.agent-thread-content');
          if (content) node.insertBefore(det, content);
          else node.appendChild(det);
        }
      });
    }
  }

  function inspectToolNode(node) {
    const toolName = (node.querySelector('.agent-thread-tool') || {}).textContent || 'Tool';
    const cmd = (node.querySelector('.agent-thread-cmd') || {}).textContent || '';
    const out = node.querySelector('.agent-tool-output pre');
    const outText = out ? out.textContent : '';
    const sections = [];
    if (cmd) {
      sections.push({
        label: 'Command / Args',
        raw: cmd,
        pretty: tryPrettyJson(cmd),
      });
    }
    if (outText) {
      sections.push({
        label: 'Output',
        raw: outText,
        pretty: tryPrettyJson(outText),
      });
    }
    if (!sections.length) {
      sections.push({ label: 'Tool node', raw: node.outerHTML });
    }
    openDrawer(`Inspect: ${toolName.trim()}`, { sections });
  }

  function tryPrettyJson(text) {
    try {
      const obj = JSON.parse(text);
      return JSON.stringify(obj, null, 2);
    } catch { return null; }
  }

  // ---- Assistant message augmentation (B) -------------------------------

  function augmentAssistantMessage(msg) {
    if (!msg || msg.__openclawAugmented) return;
    if (!msg.classList || !msg.classList.contains('msg-ai')) return;
    msg.__openclawAugmented = true;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'openclaw-msg-inspect';
    btn.title = 'Inspect message (raw)';
    btn.setAttribute('aria-label', 'Inspect message');
    btn.textContent = '⧉';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      inspectAssistantMessage(msg);
    });
    msg.appendChild(btn);
  }

  function inspectAssistantMessage(msg) {
    const body = msg.querySelector('.body') || msg;
    const text = body.innerText || body.textContent || '';
    const sections = [
      { label: 'Rendered text', raw: text },
      { label: 'Markup', raw: body.innerHTML },
    ];
    // Best-effort: surface any cached session/system-prompt info if app exposes it.
    try {
      const sid = msg.dataset.sessionId || window.currentSessionId;
      if (sid && typeof window.openclawPeekSystemPrompt === 'function') {
        const sp = window.openclawPeekSystemPrompt(sid);
        if (sp) sections.unshift({ label: 'System prompt (cached)', raw: sp });
      }
    } catch { /* noop */ }
    openDrawer('Inspect: assistant message', { sections });
  }

  // ---- Wire-up via MutationObserver -------------------------------------

  function scanAll(root) {
    root.querySelectorAll('.agent-thread-node').forEach(augmentToolNode);
    root.querySelectorAll('.msg.msg-ai').forEach(augmentAssistantMessage);
  }

  function start() {
    loadToolSpec();
    const chat = document.getElementById('chat-history') || document.body;
    scanAll(chat);
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        m.addedNodes.forEach((n) => {
          if (!(n instanceof HTMLElement)) return;
          if (n.classList && n.classList.contains('agent-thread-node')) augmentToolNode(n);
          if (n.classList && n.classList.contains('msg-ai')) augmentAssistantMessage(n);
          scanAll(n);
        });
      }
    });
    mo.observe(chat, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
