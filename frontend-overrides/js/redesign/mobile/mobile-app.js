// Mobile shell: assembles the active surface + bottom tab bar + sheets, owns
// the mobile action handlers, and wires real touch gestures (swipe-to-archive,
// pull-to-refresh). Reuses desktop surface renderers for the long-tail screens
// behind "More" (research/library/notes/settings) via a single-column wrapper.

import { icon } from '../icons.js';
import { renderCenter } from '../surfaces.js';
import { renderTabBar, mChat, mInbox, mEmailList, mEmailReader, mCalendar, mMore } from './mobile-surfaces.js';
import { renderCompanionSheet, renderCaptureSheet, renderComposeSheet, renderConvSheet, renderModelSheet } from './mobile-sheets.js';
import { runtime } from '../live/runtime.js';
import { apiJson } from '../live/api.js';

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

  return `<div class="m-app${composing ? ' kb-up' : ''}">${body}${showTabBar ? renderTabBar(s) : ''}${sheets}</div>`;
}

// ---- mobile action handlers (merged into the shared action map) -----------
export function mobileActions(state) {
  const closeSheets = () => { state.companionSheetOpen = false; state.quickCaptureOpen = false; state.mConvSheetOpen = false; state.mModelSheetOpen = false; };
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
    openConvSheet: () => { closeSheets(); state.mConvSheetOpen = true; },
    closeConvSheet: () => { state.mConvSheetOpen = false; },
    mSelectSession: (id) => { state.mConvSheetOpen = false; if (runtime.actions && runtime.actions.selectSession) runtime.actions.selectSession(id); },
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
  const SWIPE_COMMIT = -84;   // px past which a left-swipe archives
  const SWIPE_MAX = -132;

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
      const t = Math.max(SWIPE_MAX, Math.min(0, dx));
      drag.card.style.transform = `translateX(${t}px)`;
      drag.dx = t;
      e.preventDefault();
    }
  }, { passive: false });

  const endSwipe = () => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.mode === 'swipe') {
      if (d.dx <= SWIPE_COMMIT) { commitArchive(String(d.id)); render(); }
      else { d.card.classList.remove('swiping'); d.card.classList.add('snap'); d.card.style.transform = 'translateX(0)'; }
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
    const feed = e.target.closest('[data-ptr]');
    if (!feed || feed.scrollTop > 0) { ptr = null; return; }
    const t = e.touches[0];
    ptr = { feed, el: feed.querySelector('.m-ptr'), startX: t.clientX, startY: t.clientY, active: false, h: 0 };
  }, { passive: true });

  root.addEventListener('touchmove', (e) => {
    if (!ptr) return;
    const t = e.touches[0];
    const dx = t.clientX - ptr.startX;
    const dy = t.clientY - ptr.startY;
    // bail (let native scroll / sideways swipe win) if not yet committed to a pull
    if (!ptr.active && (ptr.feed.scrollTop > 0 || dy < ARM || Math.abs(dx) > dy)) {
      if (dy < 0 || ptr.feed.scrollTop > 0 || Math.abs(dx) > dy) ptr = null; // clearly not a pull — release it
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
}
