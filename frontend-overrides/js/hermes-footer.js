// HERMES: sidebar footer console. Shows the agent workspace path once the
// Phase-3 /api/workspace/tree endpoint exists (hidden gracefully until then).
// The model picker lives solely in the chat input bar — the old footer
// model mirror was removed as a duplicate picker.
(function () {
  function init() {
    const path = document.getElementById('hermes-footer-path');

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

    // Hermes-style Chat tab. This app never had one: chat is the permanent
    // base layer and tools open as modals OVER it (#rail-chats is a
    // background-chat-done notification, not a tab). So "Chat" here means
    // "close every open tool modal" — registered ones via modalManager
    // (runs their closeFn cleanup), strays via their own close button.
    (function addChatHome() {
      const strip = document.getElementById('icon-rail');
      if (!strip || document.getElementById('rail-chat-home')) return;
      const b = document.createElement('button');
      b.className = 'icon-rail-btn';
      b.id = 'rail-chat-home';
      b.title = 'Chat';
      b.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
      b.addEventListener('click', () => {
        import('/static/js/modalManager.js').then((MM) => {
          // Net 1: every visibly-rendered .modal (computed style, not just the
          // .hidden class — dynamic modals like calendar's toggle differently).
          document.querySelectorAll('.modal').forEach((m) => {
            if (!m.id) return;
            const cs = getComputedStyle(m);
            if (cs.display === 'none' || cs.visibility === 'hidden') return;
            if (MM.isRegistered(m.id)) {
              if (!MM.isMinimized(m.id)) MM.close(m.id);
              return;
            }
            const x = m.querySelector('.close-btn, .modal-close, button[title="Close"]');
            if (x) x.click(); else m.classList.add('hidden');
          });
          // Net 2: registered tool windows that aren't .modal elements.
          // Minimized chips don't obscure the chat — leave them docked.
          ['notes-panel', 'doc-panel', 'inbox-panel'].forEach((id) => {
            try { if (MM.isRegistered(id) && !MM.isMinimized(id)) MM.close(id); } catch (e) {}
          });
        }).catch(() => {});
      });
      strip.insertBefore(b, strip.firstChild);
    })();

    // CHATS always starts open: drop any persisted collapsed flag and
    // un-collapse (section-management runs before us and may have applied
    // it). In-session collapse still works; it just never persists.
    try {
      const KEY = 'section-collapsed';
      const st = JSON.parse(localStorage.getItem(KEY) || '{}');
      if (st['sessions-section']) {
        delete st['sessions-section'];
        localStorage.setItem(KEY, JSON.stringify(st));
      }
    } catch (e) { /* corrupt state — section default is open anyway */ }
    const sess = document.getElementById('sessions-section');
    if (sess) sess.classList.remove('collapsed');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
