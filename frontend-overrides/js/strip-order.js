// HERMES: drag-to-reorder for the sidebar icon strip.
// Native HTML5 DnD on .icon-rail-btn inside #icon-rail; the order persists in
// localStorage (same pattern as upstream hermes-webui's tab-order) and is
// re-applied on load and whenever an overlay injects a button late (cron.js,
// inbox.js, gateway-status.js). Desktop-only — touch browsers don't fire
// native DnD, and the mobile drawer is too cramped to drag in anyway.
(function () {
  const KEY = 'hermes-strip-order';

  function readOrder() {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || '[]');
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }

  function buttons(strip) {
    return Array.from(strip.querySelectorAll(':scope > .icon-rail-btn')).filter(b => b.id);
  }

  function applyOrder(strip) {
    const order = readOrder();
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
    try { localStorage.setItem(KEY, JSON.stringify(buttons(strip).map(b => b.id))); } catch (e) {}
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
    applyOrder(strip);

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
