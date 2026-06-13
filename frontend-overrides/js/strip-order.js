// HERMES: drag-to-reorder for the sidebar icon strip.
// Native HTML5 DnD on .icon-rail-btn inside #icon-rail. The order lives in
// TWO places: localStorage (instant, flash-free on this device) and the
// server settings store at /api/auth/settings under `hermes_strip_order`
// (single-user app → one shared order; this is how a desktop drag reaches
// the phone, where native DnD doesn't exist). Server wins when they differ.
// Re-applied on load and whenever an overlay injects a button late
// (cron.js, inbox.js, gateway-status.js).
(function () {
  const KEY = 'hermes-strip-order';
  const SERVER_KEY = 'hermes_strip_order';

  // Shipped default (maintainer-curated 2026-06-10). Hidden buttons
  // (search/new/delete/settings/gateway) ride along inertly — hermes.css
  // decides visibility, this list only decides sequence. A user drag
  // (localStorage and/or server order) always overrides this.
  const DEFAULT_ORDER = [
    'rail-chat-home',
    'rail-chats', 'rail-email', 'rail-inbox', 'rail-calendar',
    'rail-documents', 'rail-compare', 'rail-cookbook', 'rail-research',
    'rail-gallery', 'rail-archive', 'rail-notes', 'rail-memory',
    'rail-tasks', 'rail-cron', 'rail-gateway', 'rail-theme',
    'rail-search-btn', 'rail-new-session', 'rail-delete-session',
    'rail-settings',
  ];

  function readOrder() {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || '[]');
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }

  // What applyOrder uses: an explicit user order wins; otherwise the default.
  // The Chat tab postdates some saved orders — pin it to the front of any
  // order that doesn't place it (a later drag persists wherever it lands).
  function effectiveOrder() {
    const saved = readOrder();
    const order = saved.length ? saved : DEFAULT_ORDER;
    return order.includes('rail-chat-home') ? order : ['rail-chat-home', ...order];
  }

  function buttons(strip) {
    return Array.from(strip.querySelectorAll(':scope > .icon-rail-btn')).filter(b => b.id);
  }

  function applyOrder(strip) {
    const order = effectiveOrder();
    if (!order.length) return;
    const present = buttons(strip);
    const byId = new Map(present.map(b => [b.id, b]));
    // Saved ids first (in saved order); buttons the save never met (new
    // features, late injections) keep their relative DOM order at the end.
    const final = order.filter(id => byId.has(id)).map(id => byId.get(id));
    present.forEach(b => { if (!final.includes(b)) final.push(b); });
    final.forEach(b => strip.appendChild(b));
  }

  function saveOrder(strip) {
    const order = buttons(strip).map(b => b.id);
    try { localStorage.setItem(KEY, JSON.stringify(order)); } catch (e) {}
    // Fire-and-forget to the shared settings store so other devices follow.
    fetch('/api/auth/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [SERVER_KEY]: order }),
    }).catch(() => {});
  }

  function pullServerOrder(strip) {
    (window.__memoJson ? window.__memoJson('/api/auth/settings') : fetch('/api/auth/settings').then(r => r.ok ? r.json() : null)).then(s => {
      if (!s) return;
      const remote = s[SERVER_KEY];
      const local = readOrder();
      if (!Array.isArray(remote) || !remote.length) {
        // Server has no order but this device does (e.g. arranged before the
        // sync feature existed) — push local up so other devices follow.
        if (local.length) {
          fetch('/api/auth/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [SERVER_KEY]: local }),
          }).catch(() => {});
        }
        return;
      }
      if (JSON.stringify(remote) === JSON.stringify(local)) return;
      try { localStorage.setItem(KEY, JSON.stringify(remote)); } catch (e) {}
      applyOrder(strip);
    }).catch(() => {});
  }

  function init() {
    const strip = document.getElementById('icon-rail');
    if (!strip) return;
    let dragged = null;

    strip.addEventListener('dragstart', (e) => {
      const btn = e.target.closest('.icon-rail-btn');
      if (!btn) return;
      dragged = btn;
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', btn.id); } catch (err) {}
      btn.classList.add('hermes-dragging');
    });
    strip.addEventListener('dragover', (e) => {
      if (!dragged) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const over = e.target.closest('.icon-rail-btn');
      if (!over || over === dragged) return;
      const r = over.getBoundingClientRect();
      const before = e.clientX < r.left + r.width / 2;
      strip.insertBefore(dragged, before ? over : over.nextSibling);
    });
    strip.addEventListener('drop', (e) => { if (dragged) e.preventDefault(); });
    strip.addEventListener('dragend', () => {
      if (!dragged) return;
      dragged.classList.remove('hermes-dragging');
      dragged = null;
      saveOrder(strip);
    });

    const arm = () => buttons(strip).forEach(b => { b.draggable = true; });
    arm();
    applyOrder(strip);        // local cache first — no flash
    pullServerOrder(strip);   // then the shared order, if it differs

    // Re-arm/re-order ONLY when a previously unseen button id appears —
    // applyOrder's own appendChild moves would otherwise re-trigger us in a
    // loop (observer callbacks fire after the whole mutation batch).
    let known = new Set(buttons(strip).map(b => b.id));
    new MutationObserver(() => {
      const now = buttons(strip);
      const fresh = now.some(b => !known.has(b.id));
      known = new Set(now.map(b => b.id));
      if (fresh) { arm(); applyOrder(strip); }
    }).observe(strip, { childList: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
