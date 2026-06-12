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
  // Keys are DOM ids; `reg` is the modalManager registration id when it
  // differs (inbox registers under a virtual id). COMPANIONS are deliberately
  // absent: #doc-editor-pane (drafting mode) and #notes-pane are body-level
  // flex SIBLINGS designed to sit beside the chat — fullscreening them breaks
  // their native split layout. They keep split-pane behavior; their strip
  // buttons close any open panel first (see COMPANION_RAILS).
  const PANEL_SPECS = {
    'email-lib-modal': { mode: 'full', rail: ['rail-email'], nativeFs: 'email-lib-fullscreen' },
    'calendar-modal':  { mode: 'full', rail: ['rail-calendar'] },
    'inbox-modal':     { mode: 'column', width: 720, content: '.cron-modal-card', rail: ['rail-inbox'], reg: 'inbox-panel' },
    'memory-modal':    { mode: 'column', width: 960, content: '.modal-content', rail: ['rail-memory'] },
    'cron-modal':      { mode: 'column', width: 800, content: '.cron-modal-card', rail: ['rail-cron', 'rail-tasks'] },
  };
  // Strip buttons whose tools open BESIDE the chat (companions): opening one
  // while a panel is up left it stacked UNDER the panel (Library-behind-Brain
  // bug) — close panels first so the companion lands on the chat base layer.
  const COMPANION_RAILS = ['rail-documents', 'rail-archive', 'rail-notes'];

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
  // panelsOnly=true closes just the classified panels — used by companion
  // strip buttons, whose own window opens BEFORE this async import resolves;
  // the stray-modal net would otherwise close the freshly-opened companion
  // (the "library flashes then vanishes" bug). The Chat button and panel
  // exclusivity keep the full sweep.
  function closeAll(exceptId, panelsOnly) {
    return import('/static/js/modalManager.js').then((MM) => {
      Object.keys(PANEL_SPECS).forEach((id) => {
        if (id === exceptId) return;
        const el = document.getElementById(id);
        if (!el || !isVisible(el)) return;
        // modalManager knows some windows under a registration id that
        // differs from the DOM id (inbox-panel/#inbox-modal etc.).
        const reg = PANEL_SPECS[id].reg || id;
        if (MM.isRegistered(reg)) { if (!MM.isMinimized(reg)) MM.close(reg); return; }
        const x = el.querySelector('.close-btn, .modal-close, [data-act="close"], button[title="Close"]');
        if (x) x.click(); else el.classList.add('hidden');
      });
      if (panelsOnly) return;
      // Also sweep any visible unclassified .modal that ISN'T whitelisted-
      // floating chrome — same net the Chat button used (dialogs like theme/
      // settings are left alone by checking a small floating allowlist).
      // Token may appear mid-id (custom-preset-modal, assistant-settings-modal,
      // rename-session-modal) — anchor to a word/segment boundary, not ^.
      const FLOAT_OK = /(^|-)(theme|confirm|settings|model|preset|group|rename)/;
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
    if (spec.mode === 'full') {
      // .modal windows are overlay+content pairs: the overlay already spans
      // the viewport, so pinning IT changes nothing visible (calendar kept
      // floating). The CONTENT is what must fill the pane.
      const fill = el.querySelector('.modal-content');
      if (fill) fill.classList.add('hermes-panel-fill');
    }
    if (spec.mode === 'column') {
      el.classList.add('hermes-panel-column');
      el.style.setProperty('--hermes-panel-w', spec.width + 'px');
      const target = spec.content ? el.querySelector(spec.content) : el;
      if (target && target !== el) target.classList.add('hermes-panel-content');
      else el.classList.add('hermes-panel-content-self');
    }
  }

  let _lastVisible = null;
  let _prevVisible = new Set();
  function sync() {
    if (floating()) return;

    // The email reply flow deliberately un-fullscreens email (email-snap-left)
    // and opens doc-panel BESIDE it — a compound layout the app owns. Don't
    // re-fullscreen email or sweep the pair apart while it's active.
    const emailEl = document.getElementById('email-lib-modal');
    const emailSplit = !!(emailEl && emailEl.classList.contains('email-snap-left'));

    const visibleNow = Object.keys(PANEL_SPECS).filter((id) => {
      const el = document.getElementById(id);
      return el && isVisible(el);
    });
    visibleNow.forEach((id) => {
      if (emailSplit && id === 'email-lib-modal') return;
      applyGeometry(id, document.getElementById(id));
    });

    // Winner = the panel the user just opened (newcomer beats key order —
    // otherwise opening a panel that sorts EARLIER than the incumbent never
    // triggered the sweep and both stayed stacked). Falls back to the
    // incumbent, then to anything visible.
    const newcomers = visibleNow.filter((id) => !_prevVisible.has(id));
    const winner = newcomers.length ? newcomers[newcomers.length - 1]
      : (visibleNow.includes(_lastVisible) ? _lastVisible
        : (visibleNow[visibleNow.length - 1] || null));

    // (#doc-editor-pane is unclassified, so during the reply split the only
    // classified visible window is email itself — leave the pair alone.)
    const splitPair = emailSplit
      && visibleNow.every((id) => id === 'email-lib-modal');
    if (winner && !splitPair && (winner !== _lastVisible || visibleNow.length > 1)) {
      closeAll(winner);
    }

    // openCalendar() collapses the sidebar to maximize a FLOATING window —
    // in panel mode the panel area already excludes the sidebar, so undo it
    // (once, on open; the user can still hide the sidebar manually after).
    if (newcomers.includes('calendar-modal')) {
      document.getElementById('sidebar')?.classList.remove('hidden');
      if (window.syncRailSide) window.syncRailSide();
    }

    _prevVisible = new Set(visibleNow);
    _lastVisible = winner;
    setActive(winner);
  }

  function init() {
    if (floating()) { document.body.classList.add('hermes-floating'); return; }
    // State-based observer: class/style flips on known windows + body
    // childList for dynamically-created ones (calendar, cron). Debounced to
    // one sync per frame.
    let raf = null;
    // Streaming rewrites #chat-history every frame; panels never live there —
    // don't pay a panel-geometry sync per token (review E5).
    const kick = (muts) => {
      if (muts && muts.length && muts.every((m) => {
        const t = m.target;
        return t && t.nodeType === 1 && t.closest && t.closest('#chat-history');
      })) return;
      if (!raf) raf = requestAnimationFrame(() => { raf = null; sync(); });
    };
    new MutationObserver(kick).observe(document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['class', 'style'],
    });
    // Companion tools open beside the chat — clear any open panel first so
    // they never land underneath one (capture phase: runs before the tool's
    // own open handler).
    COMPANION_RAILS.forEach((id) => {
      document.getElementById(id)?.addEventListener('click', () => closeAll(null, true), true);
    });
    sync();
    window.hermesPanels = { closeAll, sync };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
