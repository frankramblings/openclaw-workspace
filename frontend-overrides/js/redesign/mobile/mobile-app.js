// Mobile shell: assembles the active surface + bottom tab bar + sheets, owns
// the mobile action handlers, and wires real touch gestures (swipe-to-archive,
// pull-to-refresh). Reuses desktop surface renderers for the long-tail screens
// behind "More" (research/library/notes/settings) via a single-column wrapper.

import { icon } from '../icons.js';
import { renderCenter } from '../surfaces.js';
import { renderTabBar, mChat, mInbox, mEmailList, mEmailReader, mCalendar, mMore } from './mobile-surfaces.js';
import { renderCompanionSheet, renderCaptureSheet, renderComposeSheet, renderConvSheet, renderConvDrawer, renderModelSheet } from './mobile-sheets.js';
import { runtime } from '../live/runtime.js';
import { apiJson } from '../live/api.js';
import { cardActions, isInvite, swipeIntent } from '../live/inbox-logic.js';

const PUSHED_SURFACES = new Set(['research', 'library', 'notes', 'settings']);

function pushedSurface(s, sub) {
  const back = icon('<path d="m15 18-6-6 6-6"/>', { size: 20, sw: 2.2 });
  return `
  <div class="m-head" style="display:flex;align-items:center;gap:6px;padding-top:calc(env(safe-area-inset-top,0px) + 14px);padding-bottom:10px">
    <button class="m-back" data-act="mBackToHub">${back}<span>More</span></button>
  </div>
  <div class="m-pushed">${renderCenter({ ...s, surface: sub })}</div>`;
}

export function renderMobile(s) {
  const reader = s.mTab === 'email' && s.mReader;
  const composing = s.mTab === 'chat' && s.keyboard;
  // The tab bar is always rendered (except in the email reader) and hidden via
  // the `.kb-up` class while composing — so toggling the keyboard never rebuilds
  // the composer DOM (see setMobileKb in app.js).
  const showTabBar = !reader;

  let body;
  if (reader) body = mEmailReader(s);
  else if (s.mTab === 'chat') body = mChat(s);
  else if (s.mTab === 'inbox') body = mInbox(s);
  else if (s.mTab === 'email') body = mEmailList(s);
  else { // more
    if (s.mSub === 'calendar') body = mCalendar(s);
    else if (s.mSub && PUSHED_SURFACES.has(s.mSub)) body = pushedSurface(s, s.mSub);
    else body = mMore(s);
  }

  const sheets =
    (s.companionSheetOpen ? renderCompanionSheet(s) : '') +
    (s.quickCaptureOpen ? renderCaptureSheet(s) : '') +
    (s.composeOpen ? renderComposeSheet(s) : '') +
    (s.mConvSheetOpen ? renderConvSheet(s) : '') +
    (s.mModelSheetOpen ? renderModelSheet(s) : '');

  // The conversation drawer is ALWAYS in the DOM (off-screen when closed) so the
  // edge-swipe gesture can finger-track it without rebuilding innerHTML mid-touch.
  return `<div class="m-app${composing ? ' kb-up' : ''}">${body}${showTabBar ? renderTabBar(s) : ''}${sheets}${renderConvDrawer(s)}</div>`;
}

// ---- mobile action handlers (merged into the shared action map) -----------
export function mobileActions(state) {
  const closeSheets = () => { state.companionSheetOpen = false; state.quickCaptureOpen = false; state.mConvSheetOpen = false; state.mModelSheetOpen = false; state.mDrawerOpen = false; };
  return {
    mGo: (tab) => { state.mTab = tab; state.mSub = null; state.mReader = false; state.keyboard = false; closeSheets(); },
    // Center "+" tap → start a fresh thread on the Chat tab (the expected mental
    // model for a centered "+"). Long-press routes to openCapture instead — see
    // wireMobileGestures. Capture is the secondary branch, not a co-equal button.
    mNewChat: () => {
      state.mTab = 'chat'; state.mSub = null; state.mReader = false; state.keyboard = false; closeSheets();
      if (runtime.actions && runtime.actions.newChat) runtime.actions.newChat();
    },
    mOpenSub: (id) => {
      state.mTab = 'more';
      if (id === 'scheduled') { state.mSub = 'settings'; state.setSection = 'scheduled'; }
      else state.mSub = id;
    },
    mBackToHub: () => { state.mSub = null; },
    mOpenReader: (i) => { state.selEmail = Number(i); state.mReader = true; state.mEmailOpened = true; },
    mCloseReader: () => { state.mReader = false; },
    openCompanion: () => { state.companionSheetOpen = true; },
    closeCompanion: () => { state.companionSheetOpen = false; },
    companionTab: (t) => { state.companionTab = t; },
    openCapture: () => { state.quickCaptureOpen = true; state.captureType = state.captureType || 'remind'; },
    closeCapture: () => { state.quickCaptureOpen = false; },
    // Opening the conversations list is exactly when you're looking for a thread
    // you just started — pull a fresh list so a newly-created (or out-of-band)
    // thread is always there, regardless of send-timing. Fire-and-forget: the
    // drawer opens instantly and re-renders when the list lands.
    openConvSheet: () => { closeSheets(); state.mDrawerOpen = true; if (runtime.actions && runtime.actions.reloadSessions) runtime.actions.reloadSessions(); },
    closeConvSheet: () => { state.mConvSheetOpen = false; },
    // Edge-swipe conversation drawer (the finger-tracked open/close lives in
    // wireMobileGestures; these handle the tap affordances / scrim dismiss).
    openConvDrawer: (side) => { closeSheets(); state.mDrawerSide = (side === 'right' ? 'right' : 'left'); state.mDrawerOpen = true; if (runtime.actions && runtime.actions.reloadSessions) runtime.actions.reloadSessions(); },
    closeDrawer: () => { state.mDrawerOpen = false; },
    mSelectSession: (id) => { state.mConvSheetOpen = false; state.mDrawerOpen = false; if (runtime.actions && runtime.actions.selectSession) runtime.actions.selectSession(id); },
    openModelSheet: async () => {
      closeSheets();
      state.mModelSheetOpen = true;
      if (runtime.actions && runtime.actions.loadModelOptions) await runtime.actions.loadModelOptions();
    },
    closeModelSheet: () => { state.mModelSheetOpen = false; },
    mSetModel: (id) => { state.mModelSheetOpen = false; if (runtime.actions && runtime.actions.setModel) runtime.actions.setModel(id); },
    mSetDefaultModel: (id) => { if (runtime.actions && runtime.actions.setDefaultModel) runtime.actions.setDefaultModel(id); },
    setCaptureType: (t) => { state.captureType = t; },
    // Quick-capture submit: persist the draft as a note (kind = remind/note/task),
    // optimistically close, restore on failure so the capture is never lost.
    sendCapture: async () => {
      const text = (state.captureDraft || '').trim();
      if (!text) { state.quickCaptureOpen = false; return; }
      const kind = state.captureType || 'remind';
      const title = text.split('\n')[0].slice(0, 80);
      state.quickCaptureOpen = false;
      state.captureDraft = '';
      try { runtime.render(); } catch (_) {}
      try {
        await apiJson('/api/notes', { title, body: text, kind });
      } catch (_) {
        // restore so the user doesn't lose what they typed
        state.captureDraft = text;
        state.quickCaptureOpen = true;
        try { runtime.render(); } catch (_) {}
      }
    },
  };
}

// ---- touch gestures -------------------------------------------------------
// Direct-DOM during drag (no re-render thrash); commit on release.
export function wireMobileGestures({ root, state, commitArchive, refresh, render }) {
  // Swipe thresholds: right >+84 = primary, left <-84 = dismiss, left <-140 = snooze.
  // SWIPE_COMMIT retained as the minimum magnitude that triggers any action.
  const SWIPE_COMMIT = -84;   // (left) minimum commit threshold — any left intent
  const SWIPE_MAX = -160;     // max visual travel on left; right travel capped below

  // --- horizontal swipe-to-archive (pointer events) ------------------------
  // touch-action:pan-y lets the browser own vertical scroll, so HORIZONTAL
  // drags are ours to preventDefault — pointer events work cleanly here.
  let drag = null; // { mode:'swipe'|'pending', card, id, startX, startY }

  root.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const card = e.target.closest('[data-swipe-card]');
    if (card) drag = { mode: 'pending', card, id: card.getAttribute('data-swipe-card'), startX: e.clientX, startY: e.clientY };
  });

  root.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (drag.mode === 'pending') {
      if (Math.abs(dx) > Math.abs(dy) * 1.5 && Math.abs(dx) > 10) { drag.mode = 'swipe'; drag.card.classList.add('swiping'); drag.card.classList.remove('snap'); }
      else if (Math.abs(dy) > 8) drag = null; // vertical → let the pull/scroll handlers have it
      return;
    }
    if (drag.mode === 'swipe') {
      // Allow both directions: left up to SWIPE_MAX, right up to +100px visual travel.
      const t = Math.max(SWIPE_MAX, Math.min(100, dx));
      drag.card.style.transform = `translateX(${t}px)`;
      drag.dx = t;
      e.preventDefault();
    }
  }, { passive: false });

  const endSwipe = () => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.mode !== 'swipe') return;
    const cardWidth = d.card.offsetWidth || 360;
    const intent = swipeIntent(d.dx, cardWidth);
    if (intent) {
      const id = String(d.id);
      if (intent === 'primary') {
        // Find the primary action for this item and call it.
        const items = state.live && state.live.inbox && state.live.inbox.items;
        const item = Array.isArray(items) ? items.find((m) => String(m.id) === id) : null;
        // Calendar invites: never auto-RSVP on a swipe — sending "Yes" emails
        // the organizer, far too easy to fire by accident. Require a button tap.
        if (item && isInvite(item)) {
          d.card.classList.remove('swiping');
          d.card.classList.add('snap');
          d.card.style.transform = 'translateX(0)';
          render();
          return;
        }
        const actions = item ? cardActions(item) : [];
        const primary = actions.find((a) => a.role === 'primary');
        if (primary && runtime.actions && runtime.actions[primary.action]) {
          runtime.actions[primary.action](id);
        } else {
          // No primary action — fall back to dismiss.
          if (runtime.actions && runtime.actions.dismiss) runtime.actions.dismiss(id);
          else commitArchive(id);
        }
      } else if (intent === 'snooze') {
        // Open the snooze menu (simpler/safer than committing a preset directly).
        if (runtime.actions && runtime.actions.snooze) runtime.actions.snooze(id);
      } else if (intent === 'dismiss') {
        if (runtime.actions && runtime.actions.dismiss) runtime.actions.dismiss(id);
        else commitArchive(id);
      }
      render();
    } else {
      // Below commit threshold — snap back.
      d.card.classList.remove('swiping');
      d.card.classList.add('snap');
      d.card.style.transform = 'translateX(0)';
    }
  };
  root.addEventListener('pointerup', endSwipe);
  root.addEventListener('pointercancel', endSwipe);

  // --- pull-to-refresh (touch events) --------------------------------------
  // Pointer events lose this fight: under touch-action:pan-y iOS treats a
  // vertical drag as a scroll and fires pointercancel before we can classify
  // it, so the pull never starts. A non-passive touchmove with preventDefault
  // DOES win over native scroll — that's the reliable way to build PTR. We only
  // preventDefault while at the very top and pulling DOWN, so normal scrolling
  // (and horizontal swipe) are untouched.
  const PULL_TRIGGER = 60;    // px of indicator height that fires refresh
  const PULL_MAX = 90;
  const RESIST = 0.55;        // finger travel → indicator height (rubber-band feel)
  let ptr = null; // { feed, el, startX, startY, active, h }

  const ARM = 24; // px of deliberate downward travel before a pull is even armed

  root.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || state.refreshing) { ptr = null; return; } // never stack a pull on an in-flight refresh
    let feed = e.target.closest('[data-ptr]');
    let fromChrome = false;
    if (!feed) {
      // Classic parity: the top chrome (header / pull handle) isn't a scroll
      // ancestor of the message list, so a downward pull there must refresh
      // regardless of how far the thread is scrolled. Anchor to the screen's
      // own feed (chrome + feed are siblings inside .m-app).
      const chrome = e.target.closest('.m-head, .m-comp-handle');
      if (chrome) { feed = chrome.parentElement.querySelector('[data-ptr]'); fromChrome = true; }
    }
    if (!feed || (!fromChrome && feed.scrollTop > 0)) { ptr = null; return; }
    const t = e.touches[0];
    ptr = { feed, el: feed.querySelector('.m-ptr'), startX: t.clientX, startY: t.clientY, active: false, h: 0, fromChrome };
  }, { passive: true });

  root.addEventListener('touchmove', (e) => {
    if (!ptr) return;
    const t = e.touches[0];
    const dx = t.clientX - ptr.startX;
    const dy = t.clientY - ptr.startY;
    // bail (let native scroll / sideways swipe win) if not yet committed to a pull.
    // A chrome-anchored pull ignores the feed's scroll position (the header isn't
    // its scroll ancestor), matching classic.
    const scrolled = !ptr.fromChrome && ptr.feed.scrollTop > 0;
    if (!ptr.active && (scrolled || dy < ARM || Math.abs(dx) > dy)) {
      if (dy < 0 || scrolled || Math.abs(dx) > dy) ptr = null; // clearly not a pull — release it
      return; // otherwise keep waiting for a deliberate downward pull
    }
    ptr.active = true;
    ptr.h = Math.max(0, Math.min((dy - ARM) * RESIST, PULL_MAX));
    if (ptr.el) ptr.el.style.height = ptr.h + 'px';
    e.preventDefault(); // beat native scroll/rubber-band — only once a real pull is armed
  }, { passive: false });

  const endPull = () => {
    if (!ptr) return;
    const p = ptr; ptr = null;
    if (p.active && p.h >= PULL_TRIGGER) refresh();
    else if (p.el) p.el.style.height = '0px';
  };
  root.addEventListener('touchend', endPull);
  root.addEventListener('touchcancel', endPull);

  // --- pull-up from bottom edge → quick capture ----------------------------
  // Arm only when the touch starts within 60px of the viewport bottom and
  // the target is not an interactive element (button, input, textarea).
  const CAPTURE_TRIGGER = 50; // px upward travel that fires the sheet
  const BOTTOM_ZONE = 60;
  let pup = null; // { startY }

  root.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { pup = null; return; }
    if (state.quickCaptureOpen || state.companionSheetOpen) { pup = null; return; }
    const t = e.touches[0];
    if (window.innerHeight - t.clientY > BOTTOM_ZONE) { pup = null; return; }
    const tag = (e.target && e.target.tagName || '').toLowerCase();
    if (tag === 'button' || tag === 'input' || tag === 'textarea' || tag === 'a') { pup = null; return; }
    pup = { startY: t.clientY };
  }, { passive: true });

  root.addEventListener('touchend', (e) => {
    if (!pup) return;
    const t = e.changedTouches[0];
    const dy = pup.startY - t.clientY; // positive = upward
    pup = null;
    if (dy >= CAPTURE_TRIGGER) {
      state.quickCaptureOpen = true;
      state.captureType = state.captureType || 'remind';
      render();
    }
  });
  root.addEventListener('touchcancel', () => { pup = null; });

  // --- long-press the center "+" → quick capture ---------------------------
  // Tap fires mNewChat (new thread); holding ~450ms opens the capture sheet
  // instead, and we swallow the click that follows so a new thread isn't ALSO
  // created. Movement past a small threshold cancels (it was a scroll/swipe).
  const LP_MS = 450;
  let lp = null; // { sx, sy, timer }
  const clearLp = () => { if (lp) { clearTimeout(lp.timer); lp = null; } };
  const fireCaptureLongPress = () => {
    lp = null;
    state.quickCaptureOpen = true;
    state.captureType = state.captureType || 'remind';
    try { if (navigator.vibrate) navigator.vibrate(8); } catch (_) { /* no haptics */ }
    // Eat the click that the browser dispatches on release so mNewChat is skipped.
    const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); root.removeEventListener('click', swallow, true); };
    root.addEventListener('click', swallow, true);
    setTimeout(() => root.removeEventListener('click', swallow, true), 700);
    render();
  };
  root.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('.m-add-btn');
    if (!btn) return;
    lp = { sx: e.clientX, sy: e.clientY, timer: setTimeout(fireCaptureLongPress, LP_MS) };
  });
  root.addEventListener('pointermove', (e) => {
    if (lp && (Math.abs(e.clientX - lp.sx) > 8 || Math.abs(e.clientY - lp.sy) > 8)) clearLp();
  });
  root.addEventListener('pointerup', clearLp);
  root.addEventListener('pointercancel', clearLp);

  // --- edge-swipe → conversation drawer ------------------------------------
  // Swipe inward from the very left OR right screen edge to pull out the thread
  // list; swipe it back toward its edge (or tap the scrim) to dismiss. The drawer
  // markup is always in the DOM (renderConvDrawer), so we finger-track it by
  // mutating transform directly — no innerHTML rebuild mid-gesture.
  const EDGE = 26;              // px from a screen edge that arms an open-swipe
  const DRAWER_W = () => Math.min(340, Math.round(window.innerWidth * 0.86));
  const OPEN_AT = 0.32;         // fraction of drawer width that commits open/stays-open
  const FLICK_V = 0.45;         // px/ms toward-open at release that commits regardless of distance
  let edg = null;              // { side, startX, startY, active, closing, shown, lastX, lastT, vx }

  const drawerEl = () => root.querySelector('[data-conv-drawer]');
  const scrimEl = () => root.querySelector('.m-drawer-scrim');

  const primeDrawer = (side) => {
    const el = drawerEl(); const sc = scrimEl();
    if (el) { el.classList.remove('left', 'right'); el.classList.add(side, 'dragging'); }
    if (sc) sc.classList.add('dragging');
  };
  const applyDrawer = (side, shown, w) => {
    const el = drawerEl(); const sc = scrimEl();
    if (el) {
      const off = side === 'left' ? shown - w : w - shown; // shown=0 → fully hidden
      el.style.transform = `translateX(${off}px)`;
    }
    if (sc) { sc.style.opacity = String(Math.max(0, Math.min(1, shown / w))); sc.style.pointerEvents = shown > 4 ? 'auto' : 'none'; }
  };
  const finishDrawer = (side, open) => {
    const el = drawerEl(); const sc = scrimEl();
    state.mDrawerSide = side;
    state.mDrawerOpen = open;
    if (el) { el.classList.remove('dragging'); el.style.transform = ''; el.classList.toggle('open', open); }
    if (sc) { sc.classList.remove('dragging'); sc.style.opacity = ''; sc.style.pointerEvents = ''; sc.classList.toggle('open', open); }
    // Swipe-open commits here too (bypasses openConvDrawer) — refresh on open so
    // a just-started thread is always in the list.
    if (open && runtime.actions && runtime.actions.reloadSessions) runtime.actions.reloadSessions();
  };

  root.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { edg = null; return; }
    const t = e.touches[0];
    if (state.mDrawerOpen) {
      // Drawer is open — arm a drag-to-close only if the touch lands on the panel.
      if (t.target && t.target.closest && t.target.closest('[data-conv-drawer]')) {
        edg = { side: state.mDrawerSide === 'right' ? 'right' : 'left', startX: t.clientX, startY: t.clientY, active: false, closing: true, shown: DRAWER_W() };
      } else { edg = null; }
      return;
    }
    // Block opening while another surface owns the gesture layer.
    if (state.quickCaptureOpen || state.companionSheetOpen || state.mConvSheetOpen || state.mModelSheetOpen || state.keyboard) { edg = null; return; }
    const x = t.clientX;
    if (x <= EDGE) edg = { side: 'left', startX: x, startY: t.clientY, active: false, closing: false, shown: 0 };
    else if (x >= window.innerWidth - EDGE) edg = { side: 'right', startX: x, startY: t.clientY, active: false, closing: false, shown: 0 };
    else edg = null;
  }, { passive: true });

  root.addEventListener('touchmove', (e) => {
    if (!edg) return;
    const t = e.touches[0];
    const dx = t.clientX - edg.startX;
    const dy = t.clientY - edg.startY;
    const w = DRAWER_W();
    if (!edg.active) {
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) { edg = null; return; } // vertical → let scroll win
      // Opening drags inward; closing drags back toward the drawer's own edge.
      const progress = edg.closing
        ? (edg.side === 'left' ? -dx : dx)
        : (edg.side === 'left' ? dx : -dx);
      if (progress > 10) { edg.active = true; edg.lastX = t.clientX; edg.lastT = performance.now(); edg.vx = 0; primeDrawer(edg.side); }
      else if (Math.abs(dx) > 10) { edg = null; return; } // wrong direction
      else return;
    }
    // Track toward-open velocity (px/ms) for a flick-to-open on release.
    const now = performance.now();
    const dt = now - (edg.lastT || now);
    if (dt > 0) {
      const stepToward = edg.side === 'left' ? (t.clientX - edg.lastX) : (edg.lastX - t.clientX);
      edg.vx = stepToward / dt;
      edg.lastX = t.clientX; edg.lastT = now;
    }
    const base = edg.closing ? w : 0;
    let shown = edg.side === 'left' ? base + dx : base - dx;
    shown = Math.max(0, Math.min(w, shown));
    edg.shown = shown;
    applyDrawer(edg.side, shown, w);
    e.preventDefault(); // beat native scroll / iOS edge-back once a real drag is armed
  }, { passive: false });

  const endEdge = () => {
    if (!edg) return;
    const ed = edg; edg = null;
    if (!ed.active) return;
    const w = DRAWER_W();
    // Commit open on either enough travel OR a decisive inward flick.
    const open = ed.shown >= w * OPEN_AT || (ed.vx || 0) >= FLICK_V;
    finishDrawer(ed.side, open);
  };
  root.addEventListener('touchend', endEdge);
  root.addEventListener('touchcancel', endEdge);
}
