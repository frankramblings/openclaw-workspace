// pull-to-refresh.js — workspace add-on (additive override; injected via a
// <script defer> tag in the index.html override, like cron.js).
//
// iOS-PWA pull-to-refresh: standalone/installed mode has no native reload
// gesture, so pulling down from the top of any pane reloads the app. Gated to
// standalone + touch so desktop and in-browser Safari (which may have native
// behaviors) are untouched. The indicator reuses the fortress-crystals loader
// (fl-* classes; animation CSS already in workspace.css).
(function () {
  'use strict';

  var standalone = window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  if (!standalone || !('ontouchstart' in window)) return;

  var THRESHOLD = 72;   // px of (resisted) pull that triggers a refresh
  var MAX = 110;        // indicator travel cap
  var RESIST = 0.45;    // finger px -> indicator px
  var ARM_SLOP = 8;     // px downward before we claim the gesture

  // Same namespaced fortress markup as index.html/spinner.js (see README).
  var FORTRESS =
    '<svg class="fl-svg" viewBox="0 0 48 48" width="30" height="30" aria-hidden="true">' +
    '<ellipse cx="24" cy="38.5" rx="15" ry="3.5" fill="currentColor" opacity=".14"/>' +
    '<g stroke-linejoin="round">' +
    '<path class="fl-crystal fl-c1" d="M23.6 38 L20.8 16 L24 6 L27.2 16 L24.4 38 Z" fill="currentColor" fill-opacity=".82" stroke="currentColor" stroke-opacity="1" stroke-width=".9"/>' +
    '<path class="fl-crystal fl-c2" d="M17.5 38 L15.2 23 L18.4 12 L21.1 26 L20 38 Z" fill="currentColor" fill-opacity=".62" stroke="currentColor" stroke-opacity=".9" stroke-width=".8"/>' +
    '<path class="fl-crystal fl-c3" d="M29 38 L27.4 25 L31.5 10 L34.4 24 L32.4 38 Z" fill="currentColor" fill-opacity=".62" stroke="currentColor" stroke-opacity=".9" stroke-width=".8"/>' +
    '<path class="fl-crystal fl-c6" d="M20.3 39 L19.3 28 L22.1 19 L24.2 30 L23.2 39 Z" fill="currentColor" fill-opacity=".7" stroke="currentColor" stroke-opacity=".82" stroke-width=".65"/>' +
    '<path class="fl-crystal fl-c7" d="M26.5 39 L25.8 29 L28.3 18 L30.7 30 L29.5 39 Z" fill="currentColor" fill-opacity=".7" stroke="currentColor" stroke-opacity=".82" stroke-width=".65"/>' +
    '</g></svg>';

  var bar = document.createElement('div');
  bar.className = 'ptr-indicator';
  bar.innerHTML = FORTRESS;
  // defer script => DOM is parsed; append directly.
  document.body.appendChild(bar);

  var armed = false, pulling = false, refreshing = false;
  var startY = 0, dist = 0;

  function update(px) {
    bar.style.setProperty('--ptr', px + 'px');
    bar.classList.toggle('ptr-visible', px > 4);
    bar.classList.toggle('ptr-ready', px >= THRESHOLD && !refreshing);
  }

  // The gesture only arms when EVERY scrollable ancestor under the finger is
  // already at its top (the app scrolls in inner panes, not the body).
  function atTop(el) {
    while (el && el !== document.body && el !== document.documentElement) {
      if (el.scrollHeight > el.clientHeight + 1 && el.scrollTop > 0) {
        var oy = getComputedStyle(el).overflowY;
        if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') return false;
      }
      el = el.parentElement;
    }
    return (window.scrollY || document.documentElement.scrollTop || 0) <= 0;
  }

  // Layered surfaces (sheets, modals, editors, lightboxes) own their own
  // gestures — a pull inside one must never reload the app out from under it
  // (the reload also nukes the layer's state). PTR is a BASE-surface gesture:
  // chat history, sidebar, nothing stacked above.
  var LAYERS = '.modal, .cron-modal-overlay, .notes-pane, .doc-editor-pane, ' +
               '.vision-editor-overlay, .attach-lightbox';

  document.addEventListener('touchstart', function (e) {
    if (refreshing || e.touches.length !== 1) { armed = false; return; }
    var t = e.target;
    if (t && t.closest && t.closest(LAYERS)) { armed = false; return; }
    armed = atTop(t);
    startY = e.touches[0].clientY;
    pulling = false;
    dist = 0;
  }, { passive: true });

  document.addEventListener('touchmove', function (e) {
    if (!armed || refreshing) return;
    var dy = e.touches[0].clientY - startY;
    if (!pulling) {
      if (dy > ARM_SLOP) pulling = true;       // it's a pull — claim it
      else if (dy < -4) { armed = false; return; }  // scrolling up — let go
      else return;
    }
    if (dy <= 0) { pulling = false; update(0); return; }
    e.preventDefault(); // suppress rubber-banding while we own the gesture
    dist = Math.min(dy * RESIST, MAX);
    update(dist);
  }, { passive: false });

  function end() {
    if (!pulling) { armed = false; return; }
    pulling = false;
    armed = false;
    if (dist >= THRESHOLD) {
      refreshing = true;
      bar.classList.add('ptr-refreshing');
      update(THRESHOLD);
      // brief beat so the user sees the "locked in" state before reload
      setTimeout(function () { location.reload(); }, 200);
    } else {
      update(0);
    }
    dist = 0;
  }
  document.addEventListener('touchend', end, { passive: true });
  document.addEventListener('touchcancel', end, { passive: true });
})();
