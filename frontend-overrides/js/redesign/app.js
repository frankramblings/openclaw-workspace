// OpenClaw Workspace — Direction A redesign shell (parallel-entry prototype).
// Vanilla JS, string-template rendering with event delegation + focus
// preservation. Recreates the design reference's state model and interactions.
// Served standalone at /static/index-redesign.html — does not touch index.html.

import { I } from './icons.js';
import { esc, when } from './dom.js';
import { AVATAR } from './data.js';
import { DEFAULT_UI } from './settings-data.js';
import { renderCenter, renderChatList, chatMsg } from './surfaces.js';
import { mChatMsg } from './mobile/mobile-surfaces.js';
import { renderCompanion, renderReveal } from './companion.js';
import { renderMobile, mobileActions, wireMobileGestures } from './mobile/mobile-app.js';
import { loadSurface } from './live/index.js';
import { runtime } from './live/runtime.js';

// ---- state ---------------------------------------------------------------
const state = {
  surface: 'chat',
  railExpanded: true,
  // chat
  draft: '', forceSlash: false, chatMode: 'agent',
  chatUI: { trail: {}, step: {}, group: {} }, // activity-trail collapse (msg/step/group)
  // companion (collapsed to the reveal strip by default)
  compTab: null, compSplit: false, compHidden: true,
  fsOpen: { data: true, 'data/skills': false, documents: true, notes: false, research: false },
  // research
  researchQuery: '', research: 'idle', resOpenCtl: null,
  resCfg: { rounds: 'Auto', engine: 'Default', endpoint: 'Claude-Cli', model: 'opus-4' },
  // library / notes / email / inbox / calendar
  libFilter: 'all', selDoc: 0, selEmail: 0, dismissed: [], quick: '',
  // settings
  setSection: 'services', accent: '#4fe3d1',
  ui: { ...DEFAULT_UI },
  // ---- mobile shell ----
  mTab: 'chat', mSub: null, mReader: false, keyboard: false,
  companionSheetOpen: false, companionTab: 'terminal',
  quickCaptureOpen: false, captureType: 'remind', captureDraft: '',
  refreshing: false,
  // live backend data per surface (loaders populate; render falls back to mock)
  live: {},
};

let researchTimer = null;
let refreshTimer = null;
const root = document.getElementById('oc-root');
const mq = window.matchMedia('(max-width: 768px)');
const isMobile = () => mq.matches;

// ---- rail -----------------------------------------------------------------
function railItem(surface, label, iconHtml, badge) {
  const active = state.surface === surface;
  return `<div class="ocnav${active ? ' active' : ''}" data-act="go" data-arg="${surface}">
    <span class="bar"></span>${iconHtml}<span class="label">${esc(label)}</span>${badge || ''}</div>`;
}

// A dot on the Chat nav item when a reply finished in a thread you weren't
// viewing (classic-interface parity). Cleared when you open that thread.
function chatNotifyBadge() {
  const n = (state.live && state.live.chat && state.live.chat.notified)
    ? state.live.chat.notified.size : 0;
  return n > 0 ? '<span class="nav-dot" title="A reply finished while you were away"></span>' : '';
}

function renderRail() {
  const collapsed = !state.railExpanded;
  const inboxVisible = 6 - state.dismissed.length; // live rail badge
  return `
  <div class="oc-rail${collapsed ? ' collapsed' : ''}">
    <div class="oc-rail-head">
      <div class="oc-avatar oc-avatar-28" data-act="toggleRail" title="Toggle sidebar"><img src="${AVATAR}" alt="Gary"></div>
      <span class="oc-rail-name">Gary</span>
      <span class="oc-online"><span class="dot"></span>online</span>
      <div class="oc-spacer"></div>
      <button class="oc-rail-collapse" data-act="toggleRail" title="Collapse sidebar"><span style="display:inline-flex;transform:rotate(${collapsed ? '180deg' : '0deg'})">${I.chevLeft()}</span></button>
    </div>
    ${railItem('chat', 'Chat', I.chat(), chatNotifyBadge())}
    ${railItem('inbox', 'Inbox', I.inbox(), `<span class="nav-badge">${inboxVisible}</span>`)}
    ${railItem('email', 'Email', I.email(), '<span class="nav-count">1</span>')}
    ${railItem('calendar', 'Calendar', I.calendar())}
    ${railItem('research', 'Research', I.research())}
    ${railItem('library', 'Library', I.library())}
    ${railItem('notes', 'Notes', I.notes())}
    <div class="oc-rail-fill"></div>
    ${railItem('settings', 'Settings', I.settings())}
    <div class="oc-user"><span class="uav">F</span><span class="uname">frank</span></div>
  </div>`;
}

// ---- desktop shell --------------------------------------------------------
function renderDesktop(s) {
  const showCompanion = s.surface !== 'settings' && !s.compHidden;
  const showReveal = s.surface !== 'settings' && s.compHidden;
  // No simulated window-chrome bar — the PWA renders in a real browser window.
  return `
  <div class="oc-app">
    <div class="oc-body">
      ${renderRail()}
      ${when(s.surface === 'chat', renderChatList(s))}
      <div class="oc-center">${renderCenter(s)}</div>
      ${when(showCompanion, renderCompanion(s))}
      ${when(showReveal, renderReveal(s))}
    </div>
  </div>`;
}

// ---- shell assembly (breakpoint dispatch) ---------------------------------
// Scroll containers whose position must survive a re-render. render() rebuilds
// root.innerHTML wholesale, which would otherwise reset every scrollable region
// to the top — jumping the chat back up on every action (expanding a tool card)
// and pinning the live stream above the fold so new output never came into view.
const SCROLL_SELECTORS = ['.chat-thread', '.m-scroll'];

// Track chat mount/session across renders so we can jump to the newest message
// when a chat is first opened (or you switch sessions) instead of leaving it
// parked at the top — without disturbing the stick-to-bottom-while-streaming case.
let _prevChatMounted = false;
let _prevActiveId = null;

function render() {
  // capture focus + caret before rebuild
  const act = document.activeElement;
  const focusKey = act && act.getAttribute ? act.getAttribute('data-focus') : null;
  const selStart = focusKey ? act.selectionStart : null;
  const selEnd = focusKey ? act.selectionEnd : null;

  // capture scroll position. If the user was at the bottom (watching the live
  // stream), STICK to the bottom as content grows; otherwise preserve the exact
  // offset so expanding a card mid-thread keeps their place.
  const scrollState = {};
  for (const sel of SCROLL_SELECTORS) {
    const el = root.querySelector(sel);
    if (el) {
      // Only the chat thread should stick to the bottom as content streams in.
      // The mobile shell reuses .m-scroll for EVERY surface (email/inbox/
      // calendar/notes); those must preserve their exact offset and never jump
      // to the bottom when live data grows the list. Also require genuine
      // overflow — a short/empty list trivially satisfies the <80 test and
      // would otherwise get yanked to scrollHeight on the next render.
      const isChat = sel === '.chat-thread' || el.classList.contains('m-thread');
      const scrollable = el.scrollHeight - el.clientHeight > 4;
      scrollState[sel] = {
        top: el.scrollTop,
        stick: isChat && scrollable && (el.scrollHeight - el.scrollTop - el.clientHeight < 80),
      };
    }
  }

  const s = state;
  root.innerHTML = isMobile() ? renderMobile(s) : renderDesktop(s);

  // restore focus + caret
  if (focusKey) {
    const el = root.querySelector(`[data-focus="${focusKey}"]`);
    if (el) {
      el.focus();
      if (selStart != null && el.setSelectionRange) {
        try { el.setSelectionRange(selStart, selEnd); } catch (_) { /* non-text input */ }
      }
      // render() rebuilds the textarea fresh (no inline height), so the height the
      // input handler grew it to is gone. Re-apply it here or the box never grows.
      if (focusKey === 'draft' || focusKey === 'mdraft') autoGrowComposer(el);
    }
  }

  // restore scroll (after focus — focusing an input can itself scroll a region).
  // On first entry into a chat (or switching sessions) jump to the newest message
  // rather than restoring/defaulting to the top.
  const chatEl = root.querySelector('.chat-thread, .m-thread');
  const isChatNow = !!chatEl;
  const curActiveId = (state.live && state.live.chat && state.live.chat.activeId) || null;
  const justEnteredChat = isChatNow && (!_prevChatMounted || curActiveId !== _prevActiveId);
  for (const sel of SCROLL_SELECTORS) {
    const el = root.querySelector(sel);
    if (!el) continue;
    const isChat = sel === '.chat-thread' || el.classList.contains('m-thread');
    if (isChat && justEnteredChat) { el.scrollTop = el.scrollHeight; continue; }
    const saved = scrollState[sel];
    if (!saved) continue;
    el.scrollTop = saved.stick ? el.scrollHeight : saved.top;
  }
  _prevChatMounted = isChatNow;
  _prevActiveId = curActiveId;

  // Keep the "jump to latest" button in sync after every rebuild — it's recreated
  // hidden each render, and the scroll listener only fires on real user scrolls.
  const jumpBtn = root.querySelector('[data-act="scrollChatBottom"]');
  if (jumpBtn && chatEl) {
    const nb = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 80;
    jumpBtn.style.display = nb ? 'none' : 'flex';
  }

  // post-render hook (the live terminal overlay repositions itself here)
  if (runtime.afterRender) runtime.afterRender();
}

// ---- actions --------------------------------------------------------------
const actions = {
  toggleRail: () => { state.railExpanded = !state.railExpanded; },
  go: (surface) => { state.surface = surface; state.resOpenCtl = null; },
  newChat: () => { state.surface = 'chat'; state.draft = ''; },

  // chat composer
  toggleSlash: () => { state.forceSlash = !state.forceSlash; },
  pickSlash: (name) => { state.draft = name + ' '; state.forceSlash = false; },
  setMode: (mode) => { state.chatMode = mode; },
  // Incognito / "Nobody" mode (ported from Odysseus): when on, send() appends
  // incognito=true so the backend doesn't persist the turn.
  toggleIncognito: () => { state.incognito = !state.incognito; },
  // Jump the chat thread to the latest message (button shown by the scroll listener).
  scrollChatBottom: () => { const el = document.querySelector('.chat-thread, .m-thread'); if (el) el.scrollTop = el.scrollHeight; },
  // Session list sort order: Recent (date groups) ⇄ A–Z (flat alphabetical).
  cycleSessionSort: () => { state.convSort = state.convSort === 'alpha' ? 'recent' : 'alpha'; },

  // chat activity trail (UI-only collapse; default trail collapsed, steps/groups closed)
  toggleTrail: (id) => { const t = state.chatUI.trail; t[id] = !t[id]; },
  toggleStep: (id) => { const st = state.chatUI.step; st[id] = !st[id]; },
  toggleGroup: (id) => { const g = state.chatUI.group; g[id] = !g[id]; },
  stopRun: () => { /* overridden by the live chat module to abort the stream */ },

  // companion
  compTab: (tab) => { state.compTab = tab; state.compSplit = false; state.compHidden = false; },
  toggleSplit: () => { state.compSplit = !state.compSplit; },
  toggleComp: () => { state.compHidden = !state.compHidden; },
  toggleFs: (path) => { state.fsOpen = { ...state.fsOpen, [path]: !state.fsOpen[path] }; },

  // research
  toggleResCtl: (key) => { state.resOpenCtl = state.resOpenCtl === key ? null : key; },
  pickResOpt: (arg) => {
    const i = arg.indexOf(':');
    const key = arg.slice(0, i), val = arg.slice(i + 1);
    state.resCfg = { ...state.resCfg, [key]: val };
    state.resOpenCtl = null;
  },
  startResearch: () => {
    state.research = 'running';
    clearTimeout(researchTimer);
    researchTimer = setTimeout(() => { state.research = 'done'; render(); }, 1800);
  },
  resetResearch: () => { clearTimeout(researchTimer); state.research = 'idle'; },

  // library / notes / email
  libFilter: (id) => { state.libFilter = id; },
  selDoc: (i) => { state.selDoc = Number(i); },
  selEmail: (i) => { state.selEmail = Number(i); },

  // inbox
  dismiss: (id) => { const n = Number(id); if (!state.dismissed.includes(n)) state.dismissed = [...state.dismissed, n]; },
  triageAll: () => {
    const ids = [3, 4, 5]; // aiArchive items
    state.dismissed = [...new Set([...state.dismissed, ...ids])];
  },

  // calendar
  clearQuick: () => { state.quick = ''; },

  // settings
  setSection: (id) => { state.setSection = id; },
  toggleUi: (key) => { state.ui = { ...state.ui, [key]: !state.ui[key] }; },
  setAccent: (hex) => {
    state.accent = hex;
    document.documentElement.style.setProperty('--accent', hex);
  },

  // mobile (merged below)
  ...mobileActions(state),
};

// ---- live data layer ------------------------------------------------------
// The currently-visible surface (desktop = surface; mobile = sub or tab).
function activeSurface() {
  if (isMobile()) return state.mSub || state.mTab;
  return state.surface;
}
function loadActive(force = false) {
  loadSurface(activeSurface(), { state, actions, render, force });
}

// ---- event delegation -----------------------------------------------------
root.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) {
    // A click outside any actionable element dismisses open menus.
    if (state.chatMenuOpen || state.modelMenuOpen || state.live?.chat?.rowMenuOpen) {
      state.chatMenuOpen = false;
      state.modelMenuOpen = false;
      if (state.live?.chat) state.live.chat.rowMenuOpen = null;
      render();
    }
    return;
  }
  const name = t.getAttribute('data-act');
  const fn = actions[name];
  if (!fn) return;
  fn(t.getAttribute('data-arg'), e);
  render();
  loadActive(); // fetch live data for any newly-activated surface (idempotent)
});

// live-bound inputs/textareas
// Grow the composer to fit its text so you never have to scroll the field to
// read what you're typing (newlines included). Caps at ~40% of the viewport so
// a giant paste can't swallow the screen — past that it scrolls.
function autoGrowComposer(t) {
  if (!t) return;
  t.style.height = 'auto';
  const cap = Math.max(160, Math.round((window.innerHeight || 800) * 0.4));
  t.style.height = Math.min(t.scrollHeight, cap) + 'px';
}

root.addEventListener('input', (e) => {
  const t = e.target.closest('[data-model]');
  if (!t) return;
  const field = t.getAttribute('data-model');
  state[field] = t.value;
  if (field === 'draft') state.forceSlash = false; // typing manages the slash menu

  const fk = t.getAttribute('data-focus');
  // Auto-grow the chat composer to fit content (nothing else sets its height).
  if (fk === 'draft' || fk === 'mdraft') autoGrowComposer(t);

  // The mobile composer must NOT re-render on every keystroke. render() rebuilds
  // root.innerHTML wholesale, and doing that mid-type on a touch keyboard drops
  // fast characters and wipes the native field state iOS relies on for
  // double-space→period and autocorrect. The DOM already holds the typed value
  // (state is synced above so send() sees it) and the Send button enables via
  // pure CSS (:placeholder-shown), so skipping render here is safe. Desktop
  // keeps its live render — it drives the slash-command palette as you type.
  if (fk === 'mdraft') return;
  render();
});

// file inputs: composer attach (data-upload) and workspace upload (data-ws-upload)
root.addEventListener('change', (e) => {
  const t = e.target;
  if (!t || t.type !== 'file') return;
  if (t.hasAttribute('data-upload')) {
    if (actions.uploadAttachments && t.files && t.files.length) actions.uploadAttachments(t.files);
    t.value = '';
  } else if (t.hasAttribute('data-ws-upload')) {
    if (actions.wsUpload && t.files && t.files.length) actions.wsUpload(t.files);
    t.value = '';
  }
});

// ---- attach images via paste + drag-and-drop (desktop & mobile) -----------
// Both route through the same uploadAttachments flow as the composer "+".
// Only fires in the chat context; text paste and other surfaces are untouched.
function chatAttachContext(target) {
  if (activeSurface() === 'chat') return true;
  const fk = target && target.getAttribute && target.getAttribute('data-focus');
  return fk === 'draft' || fk === 'mdraft';
}
function imagesFrom(list) {
  const out = [];
  for (const it of (list || [])) {
    const f = (it && typeof it.getAsFile === 'function') ? it.getAsFile() : it; // DataTransferItem (paste) vs File (drop)
    if (f && typeof f.type === 'string' && f.type.indexOf('image/') === 0) {
      // pasted screenshots are often nameless — synthesize a name so the upload keeps an extension
      out.push(f.name ? f : new File([f], `pasted-${Date.now()}.${(f.type.split('/')[1] || 'png')}`, { type: f.type }));
    }
  }
  return out;
}

root.addEventListener('paste', (e) => {
  if (!chatAttachContext(e.target)) return;
  const imgs = imagesFrom(e.clipboardData && e.clipboardData.items);
  if (!imgs.length) return;            // no image on the clipboard → let normal text paste happen
  e.preventDefault();
  if (actions.uploadAttachments) actions.uploadAttachments(imgs);
});

// Drop overlay (created once, toggled directly — outside the render cycle).
let _dropOverlay = null;
function showDrop(on) {
  if (on && !_dropOverlay) {
    _dropOverlay = document.createElement('div');
    _dropOverlay.id = 'oc-drop-overlay';
    _dropOverlay.innerHTML = '<div class="oc-drop-card">Drop image to attach</div>';
    document.body.appendChild(_dropOverlay);
  }
  if (_dropOverlay) _dropOverlay.style.display = on ? 'flex' : 'none';
}
const dragHasFiles = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') !== -1);
root.addEventListener('dragover', (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();                  // always block the browser from navigating to the dropped file
  e.dataTransfer.dropEffect = 'copy';
  if (chatAttachContext(e.target)) showDrop(true);
});
root.addEventListener('dragleave', (e) => { if (!e.relatedTarget) showDrop(false); }); // only on leaving the window
root.addEventListener('dragend', () => showDrop(false));
root.addEventListener('drop', (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  showDrop(false);
  if (!chatAttachContext(e.target)) return;
  const imgs = imagesFrom(e.dataTransfer && e.dataTransfer.files);
  if (imgs.length && actions.uploadAttachments) actions.uploadAttachments(imgs);
});

// Enter-to-send in the chat composer (Shift+Enter = newline). Calls the chat
// module's `send` action once it's been merged in (no-op until then).
root.addEventListener('keydown', (e) => {
  const t = e.target;
  if (!t || !t.getAttribute) return;
  const fk = t.getAttribute('data-focus');
  if ((fk === 'draft' || fk === 'mdraft') && e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (actions.send) { actions.send(); render(); }
  }
});

// Show the chat "jump to latest" button only when the thread is scrolled up.
// (scroll doesn't bubble → capture phase; toggles the button directly, no re-render.)
root.addEventListener('scroll', (e) => {
  const t = e.target;
  if (!t || !t.classList || !(t.classList.contains('chat-thread') || t.classList.contains('m-thread'))) return;
  const btn = root.querySelector('[data-act="scrollChatBottom"]');
  if (!btn) return;
  const nearBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 80;
  btn.style.display = nearBottom ? 'none' : 'flex';
}, true);

// Global keyboard shortcuts (the Settings → Shortcuts card advertises these):
//   ⌘K / Ctrl-K → focus the active surface's search/filter input
//   "/"         → focus the chat composer (when not already typing in a field)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (state.chatMenuOpen || state.modelMenuOpen || state.live?.chat?.rowMenuOpen) {
      state.chatMenuOpen = false;
      state.modelMenuOpen = false;
      if (state.live?.chat) state.live.chat.rowMenuOpen = null;
      render();
      return;
    }
  }
  if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
    const el = root.querySelector('[data-model="convFilter"],[data-model="notesFilter"],[data-model="libQuery"],[data-model="emailQuery"]');
    if (el) { e.preventDefault(); el.focus(); }
    return;
  }
  // ⌘⇧I / Ctrl-Shift-I → toggle incognito (Odysseus shortcut)
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'i' || e.key === 'I')) {
    e.preventDefault();
    if (actions.toggleIncognito) { actions.toggleIncognito(); render(); }
    return;
  }
  if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
    const tag = (e.target && e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || (e.target && e.target.isContentEditable)) return;
    const ta = root.querySelector('[data-focus="draft"]');
    if (ta) { e.preventDefault(); ta.focus(); }
  }
});

// mobile keyboard: focusing the chat composer raises the keyboard (frame 9 —
// tab bar hides, composer lifts). Guarded so the focus-restore loop is a no-op.
root.addEventListener('focusin', (e) => {
  if (isMobile() && e.target.getAttribute && e.target.getAttribute('data-focus') === 'mdraft' && !state.keyboard) {
    state.keyboard = true; render();
  }
});
root.addEventListener('focusout', (e) => {
  if (e.target.getAttribute && e.target.getAttribute('data-focus') === 'mdraft' && state.keyboard) {
    state.keyboard = false; render();
  }
});

// touch gestures (swipe-to-archive, pull-to-refresh)
wireMobileGestures({
  root, state,
  commitArchive: (id) => actions.dismiss(id),
  refresh: () => {
    state.refreshing = true; render();
    clearTimeout(refreshTimer);
    loadActive(true); // actually re-fetch the active surface's live data (inbox), not just spin
    refreshTimer = setTimeout(() => { state.refreshing = false; render(); }, 900);
  },
  render,
});

// re-render on breakpoint cross (desktop ⇆ mobile), then load the active surface
mq.addEventListener('change', () => { render(); loadActive(); });

// expose state/render/actions to live/* modules (async re-renders after fetch)
runtime.state = state;
runtime.render = render;
runtime.actions = actions;

// Surgically re-render ONE chat message in place — used for streaming deltas so
// we don't rebuild the whole document on every token (which wiped text selection,
// scroll, and composer typing). Returns false if the node isn't mounted yet so
// the caller can fall back to a full render.
runtime.patchMessage = (msgId) => {
  if (msgId == null) return false;
  let el;
  try { el = root.querySelector(`[data-msg-id="${CSS.escape(String(msgId))}"]`); } catch (_) { return false; }
  if (!el) return false;
  const m = (state.live && state.live.chat && state.live.chat.thread || []).find((x) => x.id === msgId);
  if (!m) return false;
  // stick to the bottom while streaming if the user is already there; otherwise
  // leave their scroll position alone (they scrolled up to read).
  const scroller = root.querySelector('.chat-thread, .m-thread');
  const stick = scroller && (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80);
  el.outerHTML = isMobile() ? mChatMsg(m, state) : chatMsg(m, state);
  if (stick && scroller) scroller.scrollTop = scroller.scrollHeight;
  return true;
};

// ---- boot -----------------------------------------------------------------
// Deep-link the initial surface from the hash (e.g. #calendar), and keep the
// hash in sync as the user navigates so views are shareable / reloadable.
const SURFACES = ['chat', 'inbox', 'email', 'calendar', 'research', 'library', 'notes', 'settings'];
const fromHash = (location.hash || '').replace('#', '');
if (SURFACES.includes(fromHash)) state.surface = fromHash;

// Seed the mobile shell from the same hash: primary tabs map directly; the
// desktop-only surfaces land under "More" (calendar opens its agenda screen).
// Special hashes #more / #capture target mobile-only destinations.
const MOBILE_PRIMARY = ['chat', 'inbox', 'email'];
function seedMobileFromHash(h) {
  if (MOBILE_PRIMARY.includes(h)) { state.mTab = h; state.mSub = null; }
  else if (h === 'more') { state.mTab = 'more'; state.mSub = null; }
  else if (h === 'capture') { state.mTab = 'chat'; state.quickCaptureOpen = true; }
  else if (['calendar', 'research', 'library', 'notes', 'settings'].includes(h)) { state.mTab = 'more'; state.mSub = h; }
}
seedMobileFromHash(fromHash);

const _go = actions.go;
actions.go = (surface) => { _go(surface); if (location.hash !== '#' + surface) history.replaceState(null, '', '#' + surface); };

window.addEventListener('hashchange', () => {
  const h = (location.hash || '').replace('#', '');
  if (SURFACES.includes(h) && h !== state.surface) { state.surface = h; seedMobileFromHash(h); render(); }
  else if ((h === 'more' || h === 'capture')) { seedMobileFromHash(h); render(); }
  loadActive();
});

render();
loadActive(); // kick off live data for the initial surface
