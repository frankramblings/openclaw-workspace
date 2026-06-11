// HERMES: panel mode — strip-launched tools behave like Hermes panels:
// maximized into the main pane, one at a time, active tab lit on the strip.
// Pure overlay over modalManager; the tools are untouched. Escape hatch:
// localStorage['hermes-floating-windows']='1' restores classic floating
// windows wholesale (body.hermes-floating scopes every rule off).
// Spec: docs/superpowers/specs/2026-06-10-hermes-panel-mode-design.md
(function () {
  const FLOATING_KEY = 'hermes-floating-windows';

  // windowId -> treatment. mode 'full' | 'column'; width only for columns;
  // content = selector (within the window) that gets the centered column;
  // rail = strip button(s) to light when this panel is visible;
  // nativeFs = class the tool itself uses for fullscreen (preferred over
  // generic geometry when present).
  const PANEL_SPECS = {
    'email-lib-modal': { mode: 'full', rail: ['rail-email'], nativeFs: 'email-lib-fullscreen' },
    'calendar-modal':  { mode: 'full', rail: ['rail-calendar'] },
    'doc-panel':       { mode: 'full', rail: ['rail-documents', 'rail-archive'] },
    'inbox-panel':     { mode: 'column', width: 720, content: null, rail: ['rail-inbox'] },
    'notes-panel':     { mode: 'column', width: 960, content: null, rail: ['rail-notes'] },
    'memory-modal':    { mode: 'column', width: 960, content: '.modal-content', rail: ['rail-memory'] },
    'cron-modal':      { mode: 'column', width: 800, content: '.cron-modal-card', rail: ['rail-cron', 'rail-tasks'] },
  };
  // content:null = the window element itself is the column.

  const floating = () => {
    try { return localStorage.getItem(FLOATING_KEY) === '1'; } catch (e) { return false; }
  };

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  }

  function setActive(visibleId) {
    // Mutate ONLY on actual state change: classList.add/remove of an
    // unchanged class fires no mutation records, so the body observer goes
    // quiet in steady state. The naive remove-all-then-re-add version kept a
    // permanent one-sync-per-frame rAF heartbeat alive.
    const want = new Set(visibleId ? PANEL_SPECS[visibleId].rail : ['rail-chat-home']);
    document.querySelectorAll('.icon-rail-btn').forEach((b) => {
      const has = b.classList.contains('hermes-active');
      const should = want.has(b.id);
      if (should && !has) b.classList.add('hermes-active');
      else if (!should && has) b.classList.remove('hermes-active');
    });
  }

  // Close every classified window except `exceptId`. Registered ones via
  // modalManager (runs closeFn cleanup); cron's custom overlay via its own
  // close control; stragglers via generic close button / .hidden.
  function closeAll(exceptId) {
    return import('/static/js/modalManager.js').then((MM) => {
      Object.keys(PANEL_SPECS).forEach((id) => {
        if (id === exceptId) return;
        const el = document.getElementById(id);
        if (!el || !isVisible(el)) return;
        if (MM.isRegistered(id)) { if (!MM.isMinimized(id)) MM.close(id); return; }
        const x = el.querySelector('.close-btn, .modal-close, [data-act="close"], button[title="Close"]');
        if (x) x.click(); else el.classList.add('hidden');
      });
      // Also sweep any visible unclassified .modal that ISN'T whitelisted-
      // floating chrome — same net the Chat button used (dialogs like theme/
      // settings are left alone by checking a small floating allowlist).
      const FLOAT_OK = /^(theme-|confirm|settings|model-|preset|group)/;
      document.querySelectorAll('.modal').forEach((m) => {
        if (!m.id || PANEL_SPECS[m.id] || FLOAT_OK.test(m.id)) return;
        if (!isVisible(m)) return;
        if (MM.isRegistered(m.id)) { if (!MM.isMinimized(m.id)) MM.close(m.id); return; }
        const x = m.querySelector('.close-btn, .modal-close, button[title="Close"]');
        if (x) x.click(); else m.classList.add('hidden');
      });
    }).catch(() => {});
  }

  function applyGeometry(id, el) {
    const spec = PANEL_SPECS[id];
    if (spec.nativeFs) { el.classList.add(spec.nativeFs); return; }
    el.classList.add('hermes-panel');
    if (spec.mode === 'column') {
      el.classList.add('hermes-panel-column');
      el.style.setProperty('--hermes-panel-w', spec.width + 'px');
      const target = spec.content ? el.querySelector(spec.content) : el;
      if (target && target !== el) target.classList.add('hermes-panel-content');
      else el.classList.add('hermes-panel-content-self');
    }
  }

  let _lastVisible = null;
  function sync() {
    if (floating()) return;
    let visibleId = null;
    for (const id of Object.keys(PANEL_SPECS)) {
      const el = document.getElementById(id);
      if (el && isVisible(el)) { visibleId = id; applyGeometry(id, el); }
    }
    if (visibleId && visibleId !== _lastVisible) closeAll(visibleId);
    _lastVisible = visibleId;
    setActive(visibleId);
  }

  function init() {
    if (floating()) { document.body.classList.add('hermes-floating'); return; }
    // State-based observer: class/style flips on known windows + body
    // childList for dynamically-created ones (calendar, cron). Debounced to
    // one sync per frame.
    let raf = null;
    const kick = () => { if (!raf) raf = requestAnimationFrame(() => { raf = null; sync(); }); };
    new MutationObserver(kick).observe(document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['class', 'style'],
    });
    sync();
    window.hermesPanels = { closeAll, sync };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
