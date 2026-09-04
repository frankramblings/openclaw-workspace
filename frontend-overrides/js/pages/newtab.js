// Extracted from newtab.html so the page is clean under the enforced CSP
// (script-src 'self'): no inline <script>, no nonce placeholder.
(function () {
  var q = document.getElementById('q');
  // This page is only ever served same-origin with the workspace app (/home,
  // /newtab, /gary-home.html all live on this same backend — see
  // backend/app.py), so navigation targets are plain root-relative paths; no
  // absolute origin to construct or hardcode.
  //
  // Chromium only link-captures NEW-context navigations into an installed
  // PWA ("Open supported links: In app") — a same-tab location.href never
  // routes to the app window. Open a new context so capture can grab it
  // (launch_handler navigate-existing then delivers the ?action= URL to the
  // running app window). Inside the PWA itself, navigate in place; if a
  // popup blocker eats the open, fall back to same-tab.
  function go(url) {
    var standalone = false;
    try { standalone = window.matchMedia('(display-mode: standalone)').matches; } catch (e) {}
    if (standalone) { window.location.href = url; return; }
    var w = null;
    try { w = window.open(url, '_blank'); } catch (e) {}
    if (!w) { window.location.href = url; return; }
    // Tidy the launcher tab when the browser permits (new-tab pages usually do).
    try { window.close(); } catch (e) {}
  }
  function newChat() {
    var v = (q.value || '').trim();
    // With a query, land in a fresh chat AND fire it (autosend=1) so the
    // launcher feels like a single-shot ask box, not a two-tap composer.
    go('/?action=new' + (v ? '&q=' + encodeURIComponent(v) + '&autosend=1' : ''));
  }
  function search() {
    var v = (q.value || '').trim();
    go('/?action=search' + (v ? '&q=' + encodeURIComponent(v) : ''));
  }
  document.getElementById('f').addEventListener('submit', function (e) {
    e.preventDefault(); newChat();
  });
  q.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); search(); }
  });
  document.getElementById('btn-new').addEventListener('click', newChat);
  document.getElementById('btn-search').addEventListener('click', search);
  document.getElementById('btn-inbox').addEventListener('click', function () { go('/?action=inbox'); });
  document.getElementById('btn-open').addEventListener('click', function () { go('/'); });
  document.querySelectorAll('a[data-origin-href]').forEach(function (a) {
    a.href = a.getAttribute('data-origin-href');
    a.target = '_blank'; a.rel = 'noopener';
  });
})();
