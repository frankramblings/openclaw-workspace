// sw-register.js — Register the shared service worker (/sw.js, scope "/")
// so this redesign shell is installable and works offline. Script is at the
// root, so its default scope "/" controls this /static/ page too.
if ('serviceWorker' in navigator) {
  // Auto-reload into a freshly-deployed bundle. The SW skipWaiting()s +
  // clients.claim()s, so a new deploy CONTROLS this page immediately — but
  // the already-imported ES modules (chat.js etc.) stay in memory until the
  // document actually re-navigates. Without this, an open tab/PWA keeps
  // running stale JS until a manual hard reload, so shipped fixes silently
  // never load. controllerchange fires when a new SW takes control; reload
  // once so the new modules are actually imported.
  var __hadController = !!navigator.serviceWorker.controller;
  var __swRefreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    // Skip the first-install claim (no prior controller) — only reload when
    // an EXISTING controller was replaced by a new deploy. Guard the flag so
    // we never loop.
    if (!__hadController || __swRefreshing) return;
    __swRefreshing = true;
    window.location.reload();
  });
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  });
}
