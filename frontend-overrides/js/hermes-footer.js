// HERMES: sidebar footer console. Mirrors the input-bar model picker label
// (the picker itself stays in the chat input bar — clicking the footer button
// opens it there) and shows the agent workspace path once the Phase-3
// /api/workspace/tree endpoint exists (hidden gracefully until then).
(function () {
  function init() {
    const label = document.getElementById('hermes-footer-model-label');
    const btn = document.getElementById('hermes-footer-model');
    const path = document.getElementById('hermes-footer-path');
    const src = document.getElementById('model-picker-label');
    if (!label || !btn) return;

    const sync = () => { label.textContent = (src && src.textContent.trim()) || 'Select model'; };
    sync();
    if (src) new MutationObserver(sync).observe(src, { childList: true, characterData: true, subtree: true });

    btn.addEventListener('click', (e) => {
      // Without this, our click bubbles on to modelPicker's document-level
      // outside-click dismiss AFTER the synthetic real.click() opened the
      // menu — flash-open-then-close (e.target is the footer, not the
      // picker btn, so the dismiss fires).
      e.stopPropagation();
      const real = document.getElementById('model-picker-btn');
      if (real) { real.click(); real.scrollIntoView({ block: 'nearest' }); }
    });

    // Agent initial for chat avatars (Phase 4 CSS reads this var).
    fetch('/api/config').then(r => r.ok ? r.json() : null).then(cfg => {
      const name = (cfg && (cfg.agent_name || cfg.name)) || '';
      if (name) document.documentElement.style.setProperty('--hermes-agent-initial', JSON.stringify(name[0].toUpperCase()));
    }).catch(() => {});

    if (path) {
      fetch('/api/workspace/tree').then(r => r.ok ? r.json() : null).then(d => {
        if (d && d.root) { path.textContent = d.root; path.title = d.root; path.hidden = false; }
      }).catch(() => {});
    }

    // Mirror the unread dots of the now-hidden Inbox/Email sidebar rows onto
    // their strip icons (hermes.css draws .hermes-rail-unread::after).
    // #rail-inbox is injected late by inbox.js, hence the strip observer.
    function mirrorDot(dotId, railId) {
      const dot = document.getElementById(dotId);
      if (!dot) return;
      const sync = () => {
        const rail = document.getElementById(railId);
        if (rail) rail.classList.toggle('hermes-rail-unread', dot.style.display !== 'none');
      };
      new MutationObserver(sync).observe(dot, { attributes: true, attributeFilter: ['style'] });
      const strip = document.getElementById('icon-rail');
      if (strip) new MutationObserver(sync).observe(strip, { childList: true });
      sync();
    }
    mirrorDot('inbox-unread-dot', 'rail-inbox');
    mirrorDot('email-unread-dot', 'rail-email');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
