// frontend-overrides/js/capabilities.js
// Hide/disable rail tabs the backend reports as unavailable on this install
// (account-specific tabs without their config). Same injected-<script> pattern
// as cron.js/inbox.js; survives upstream updates as long as #icon-rail exists.
(function () {
  // capability key -> rail button id. Only the account-specific tabs that
  // /api/capabilities actually gates appear here; core tabs (and research,
  // which is always available) are never touched.
  var RAIL = {
    email: 'rail-email',
    calendar: 'rail-calendar',
    inbox: 'rail-inbox',       // injected by inbox.js
  };
  function apply(caps) {
    Object.keys(RAIL).forEach(function (key) {
      var cap = caps[key];
      if (!cap) return;
      var btn = document.getElementById(RAIL[key]);
      if (!btn) return;
      if (cap.available) { btn.hidden = false; return; }
      btn.hidden = true;                       // hide unavailable tab
      btn.title = (cap.hint || cap.reason || 'unavailable');
    });
  }
  function load() {
    fetch('/api/capabilities').then(function (r) { return r.json(); })
      .then(apply).catch(function () { /* leave tabs as-is on error */ });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load, { once: true });
  } else { load(); }
})();
