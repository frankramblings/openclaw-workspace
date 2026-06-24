// Mobile shell: assembles the active surface + bottom tab bar + sheets, owns
// the mobile action handlers, and wires real touch gestures (swipe-to-archive,
// pull-to-refresh). Reuses desktop surface renderers for the long-tail screens
// behind "More" (research/library/notes/settings) via a single-column wrapper.

import { icon } from '../icons.js';
import { renderCenter } from '../surfaces.js';
import { renderTabBar, mChat, mInbox, mEmailList, mEmailReader, mCalendar, mMore } from './mobile-surfaces.js';
import { renderCompanionSheet, renderCaptureSheet, renderComposeSheet } from './mobile-sheets.js';
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
  const showTabBar = !reader && !composing;

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
    (s.composeOpen ? renderComposeSheet(s) : '');

  return `<div class="m-app">${body}${showTabBar ? renderTabBar(s) : ''}${sheets}</div>`;
}

// ---- mobile action handlers (merged into the shared action map) -----------
export function mobileActions(state) {
  const closeSheets = () => { state.companionSheetOpen = false; state.quickCaptureOpen = false; };
  return {
    mGo: (tab) => { state.mTab = tab; state.mSub = null; state.mReader = false; state.keyboard = false; closeSheets(); },
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
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 6) { drag.mode = 'swipe'; drag.card.classList.add('swiping'); drag.card.classList.remove('snap'); }
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
      if (d.dx <= SWIPE_COMMIT) { commitArchive(Number(d.id)); render(); }
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
}
