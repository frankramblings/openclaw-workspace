/* OpenClaw Workspace — gateway status dot + banner (overlay add-on).
 *
 * Polls /api/gateway/status (backed by the backend's persistent monitor WS)
 * and shows: a colored dot in the icon rail (green ok / amber restarting /
 * red down) and a dismissible banner when the brain is restarting, down, or
 * has an update available. Self-contained like cron.js: builds its own DOM,
 * survives SPA re-renders via MutationObserver, loaded by a <script> the
 * sync script injects.
 */
(function () {
  'use strict';
  const API = window.location.origin;
  const POLL_MS = 30000;
  const $ = (sel, root) => (root || document).querySelector(sel);
  let _last = null;

  function injectDot() {
    const rail = $('#icon-rail');
    if (!rail || $('#rail-gateway')) return;
    const btn = document.createElement('button');
    btn.className = 'icon-rail-btn';
    btn.id = 'rail-gateway';
    btn.title = 'Gateway status';
    btn.innerHTML = '<span class="gw-dot" id="gw-dot"></span>';
    btn.addEventListener('click', refresh);
    const theme = $('#rail-theme', rail);
    if (theme) rail.insertBefore(btn, theme); else rail.appendChild(btn);
  }

  function injectSidebarDot() {
    // Second dot next to the "Gary" brand name, for when the sidebar is
    // expanded (the rail dot is hidden/covered then). pointer-events:none in
    // CSS keeps the brand's whole-row New-chat click intact.
    const title = $('.sidebar-brand-title');
    if (!title || $('#gw-dot-sidebar')) return;
    const dot = document.createElement('span');
    dot.className = 'gw-dot gw-dot-sidebar';
    dot.id = 'gw-dot-sidebar';
    if (_last) dot.dataset.state = _last.state;  // no colorless flash on re-inject
    title.insertAdjacentElement('afterend', dot);
  }

  function ensureBanner() {
    let b = $('#gw-banner');
    if (!b) {
      b = document.createElement('div');
      b.id = 'gw-banner';
      b.innerHTML = '<span id="gw-banner-text"></span>' +
        '<button id="gw-banner-x" title="Dismiss">✕</button>';
      document.body.prepend(b);
      $('#gw-banner-x', b).addEventListener('click', () => {
        b.dataset.dismissed = '1';
        b.style.display = 'none';
      });
    }
    return b;
  }

  function render(s) {
    injectSidebarDot();  // self-healing, like the rail observer
    document.querySelectorAll('.gw-dot').forEach((dot) => {
      dot.dataset.state = s.state;
    });
    const btn = $('#rail-gateway');
    if (btn) {
      const bits = [`gateway: ${s.state}`];
      if (s.sessionCount != null) bits.push(`${s.sessionCount} sessions`);
      if (s.updateAvailable && s.updateAvailable.version) {
        bits.push(`update ${s.updateAvailable.version} available`);
      }
      btn.title = bits.join(' · ');
    }
    const banner = ensureBanner();
    const text = $('#gw-banner-text');
    let msg = '';
    if (s.state === 'restarting') {
      msg = '🧠 The brain is restarting — replies will resume shortly.';
    } else if (s.state === 'down') {
      msg = '🧠 The brain is unreachable — chat will fail until the gateway is back.';
    } else if (s.updateAvailable && s.updateAvailable.version) {
      msg = `OpenClaw update available: ${s.updateAvailable.version}`;
    }
    if (text) text.textContent = msg;
    // A state CHANGE re-arms a dismissed banner (new news beats old dismissal).
    if (_last && _last.state !== s.state) banner.dataset.dismissed = '';
    banner.style.display = (msg && banner.dataset.dismissed !== '1') ? 'flex' : 'none';
    _last = s;
  }

  async function refresh() {
    try {
      const res = await fetch(`${API}/api/gateway/status`);
      if (!res.ok) return;        // workspace hiccup — keep last known state
      render(await res.json());
    } catch (_) { /* network blip — keep last known state */ }
  }

  function init() {
    injectDot();
    injectSidebarDot();
    const rail = document.getElementById('icon-rail');
    if (rail && window.MutationObserver) {
      new MutationObserver(() => {
        if (!document.getElementById('rail-gateway')) injectDot();
      }).observe(rail, { childList: true });
    }
    refresh();
    setInterval(refresh, POLL_MS);
    window.addEventListener('focus', refresh);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }
})();
