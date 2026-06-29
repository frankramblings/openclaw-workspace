// AGPL-3.0 §13 compliance: a persistent, visible offer of THIS running
// version's source code to anyone using the app over the network.
//
// The URL comes from /api/config (`source_url`, settable by operators via
// WORKSPACE_SOURCE_URL — a fork that modifies the app must point this at its
// own repo so users get the *corresponding* source). Falls back to the
// upstream repo if /api/config is unreachable.
//
// Mounts inside the sidebar footer (#hermes-footer, classic UI) when present;
// otherwise drops a small, muted, fixed link in the corner (redesign UI).
(function () {
  var FALLBACK = 'https://github.com/frankramblings/openclaw-workspace';
  var ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>';

  function injectStyle() {
    if (document.getElementById('source-link-style')) return;
    var s = document.createElement('style');
    s.id = 'source-link-style';
    s.textContent = [
      '#source-link{display:inline-flex;align-items:center;gap:5px;',
      'color:var(--muted,#8a93a0);text-decoration:none;font-size:11px;',
      'opacity:.7;transition:opacity .15s ease,color .15s ease;}',
      '#source-link:hover{opacity:1;color:var(--accent,#4fe3d1);}',
      '#source-link svg{flex:0 0 auto;}',
      '.hermes-source-link{padding:4px 6px 6px;}',
      '.source-link-float{position:fixed;left:10px;bottom:10px;z-index:40;',
      'padding:4px 8px;border:1px solid var(--border,#2b3038);border-radius:999px;',
      'background:color-mix(in srgb,var(--panel,#161a1f) 88%,transparent);',
      'backdrop-filter:blur(4px);}',
      // Don't fight the mobile tab bar; the offer still stands via repo/README.
      '@media (max-width:720px){.source-link-float{display:none;}}'
    ].join('');
    document.head.appendChild(s);
  }

  function mount(url) {
    if (document.getElementById('source-link')) return;
    var a = document.createElement('a');
    a.id = 'source-link';
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = 'AGPL-3.0 — view the source code of this running version';
    a.innerHTML = ICON + '<span>Source</span>';
    var foot = document.getElementById('hermes-footer');
    if (foot) {
      a.className = 'hermes-source-link';
      foot.appendChild(a);
    } else {
      a.className = 'source-link-float';
      document.body.appendChild(a);
    }
  }

  function init() {
    injectStyle();
    fetch('/api/config')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (c) { mount((c && c.source_url) || FALLBACK); })
      .catch(function () { mount(FALLBACK); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
