// Mobile shell: assembles the active surface + bottom tab bar + sheets, owns
// the mobile action handlers, and wires real touch gestures (swipe-to-archive,
// pull-to-refresh). Reuses desktop surface renderers for the long-tail screens
// behind "More" (research/library/notes/settings) via a single-column wrapper.

import { icon } from '../icons.js';
import { renderCenter } from '../surfaces.js';
import { renderTabBar, mChat, mInbox, mEmailList, mEmailReader, mCalendar, mMore } from './mobile-surfaces.js';
import { renderCompanionSheet, renderCaptureSheet } from './mobile-sheets.js';

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
    (s.quickCaptureOpen ? renderCaptureSheet(s) : '');

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
    mOpenReader: (i) => { state.selEmail = Number(i); state.mReader = true; },
    mCloseReader: () => { state.mReader = false; },
    openCompanion: () => { state.companionSheetOpen = true; },
    closeCompanion: () => { state.companionSheetOpen = false; },
    companionTab: (t) => { state.companionTab = t; },
    openCapture: () => { state.quickCaptureOpen = true; state.captureType = state.captureType || 'remind'; },
    closeCapture: () => { state.quickCaptureOpen = false; },
    setCaptureType: (t) => { state.captureType = t; },
  };
}

// ---- touch gestures -------------------------------------------------------
// Direct-DOM during drag (no re-render thrash); commit on release.
export function wireMobileGestures({ root, state, commitArchive, refresh, render }) {
  const SWIPE_COMMIT = -84;   // px past which a left-swipe archives
  const SWIPE_MAX = -132;
  const PULL_TRIGGER = 64;    // px pull-down to fire refresh

  let drag = null; // { mode:'swipe'|'pull'|'pending', card, id, startX, startY, scroller }

  root.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const card = e.target.closest('[data-swipe-card]');
    const feed = e.target.closest('[data-ptr]');
    if (card) {
      drag = { mode: 'pending', card, id: card.getAttribute('data-swipe-card'), startX: e.clientX, startY: e.clientY };
    } else if (feed && feed.scrollTop <= 0) {
      drag = { mode: 'pending-pull', scroller: feed, startY: e.clientY, ptr: feed.querySelector('.m-ptr') };
    }
  });

  root.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;

    if (drag.mode === 'pending') {
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 6) { drag.mode = 'swipe'; drag.card.classList.add('swiping'); drag.card.classList.remove('snap'); }
      else if (Math.abs(dy) > 8) drag = null; // vertical scroll wins
      return;
    }
    if (drag.mode === 'pending-pull') {
      if (dy > 8 && drag.scroller.scrollTop <= 0) drag.mode = 'pull';
      else if (Math.abs(dy) > 8) drag = null;
      return;
    }
    if (drag.mode === 'swipe') {
      const t = Math.max(SWIPE_MAX, Math.min(0, dx));
      drag.card.style.transform = `translateX(${t}px)`;
      drag.dx = t;
      e.preventDefault();
    } else if (drag.mode === 'pull') {
      const pull = Math.max(0, Math.min(90, dy));
      if (drag.ptr) drag.ptr.style.height = pull + 'px';
      drag.pull = pull;
      e.preventDefault();
    }
  }, { passive: false });

  const end = () => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.mode === 'swipe') {
      if (d.dx <= SWIPE_COMMIT) { commitArchive(Number(d.id)); render(); }
      else { d.card.classList.remove('swiping'); d.card.classList.add('snap'); d.card.style.transform = 'translateX(0)'; }
    } else if (d.mode === 'pull') {
      if (d.pull >= PULL_TRIGGER) refresh();
      else if (d.ptr) d.ptr.style.height = '0px';
    }
  };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);
}
