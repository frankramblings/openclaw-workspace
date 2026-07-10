// OpenClaw Workspace — Direction A redesign shell (parallel-entry prototype).
// Vanilla JS, string-template rendering with event delegation + focus
// preservation. Recreates the design reference's state model and interactions.
// Served as THE app at /static/index.html (and /) since 2026-07; the classic
// UI lives on at /static/index-classic.html until it sunsets.

import { I } from './icons.js';
import { esc, when } from './dom.js';
import { AVATAR, filterSlashCommands } from './data.js';
import { DEFAULT_UI } from './settings-data.js';
import { renderCenter, renderChatList, chatMsg, inboxToastHtml } from './surfaces.js';
import { mChatMsg } from './mobile/mobile-surfaces.js';
import { renderCompanion, renderReveal } from './companion.js';
import { renderMobile, mobileActions, wireMobileGestures } from './mobile/mobile-app.js';
import { derivedDepth, closeTopmost } from './mobile/mobile-history.js';
import { maybeShowInstallHint } from './mobile/install-hint.js';
import { maybeShowThreadsHint } from './mobile/threads-hint.js';
import { startLongPress, moveLongPress, endLongPress, resetLongPress } from './mobile/longpress.js';
import { editPendingOnMobile, cancelMobileEdit, commitMobileEditIfPending } from './mobile/edit-flow.js';
import { shouldSwipeDismiss, applyCloseSheet } from './mobile/sheet-close.js';
import { loadSurface } from './live/index.js';
import { runtime } from './live/runtime.js';
import { wireResizableSidebars } from './resize-sidebars.js';
import { openImageOverlay } from './live/image-viewer.js';
import { installErrorBoundary } from './error-boundary.js';
import { trapOrder, nextFocus, pickModal } from './focus-trap.js';
import './live/jobs.js'; // Live Jobs overlay — self-boots on import

// ---- state ---------------------------------------------------------------
const state = {
  surface: 'chat',
  railExpanded: false,
  // chat
  draft: '', forceSlash: false, chatMode: 'agent',
  // slash-command autocomplete keyboard state (Arrow/Enter/Escape — see app.js
  // keydown wiring): slashSel is the highlighted command's name; slashDismissed
  // lets Escape close the dropdown without erasing the typed "/text".
  slashSel: null, slashDismissed: false,
  chatUI: { trail: {}, step: {}, group: {} }, // activity-trail collapse (msg/step/group)
  // companion (collapsed to the reveal strip by default)
  compTab: null, compSplit: false, compHidden: true,
  fsOpen: { data: true, 'data/skills': false, documents: true, notes: false, research: false },
  // Files pane root key (workspace | home | meetings | openclaw-workspace | tmp).
  // Persisted so "up a level" survives reloads. Anything outside 'workspace' is
  // read-only in the file editor (backend refuses mutations there).
  wsRootKey: (() => { try { return localStorage.getItem('oc-ws-root') || 'workspace'; } catch (_) { return 'workspace'; } })(),
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
  mConvSheetOpen: false, mModelSheetOpen: false,
  mDrawerOpen: false, mDrawerSide: 'left',
  refreshing: false,
  // AGPL-3.0 §13: persistent offer of this running version's source. Seeded with
  // the upstream fallback; overwritten at boot from /api/config (source_url).
  sourceUrl: 'https://github.com/frankramblings/openclaw-workspace',
  // live backend data per surface (loaders populate; render falls back to mock)
  live: {},
  isOnline: navigator.onLine,
};

// ---- global error boundary -------------------------------------------------
// Installed FIRST — before the very first render() and before any other DOM
// wiring below — so an uncaught throw anywhere (most likely inside render()
// itself; see the module banner) surfaces a toast instead of leaving a silent
// half-dead UI. toast() reuses the same state.inboxToast + render() convention
// the inbox retry toasts already use (surfaces.js / mobile-surfaces.js render
// it; the auto-dismiss timer below clears it). If render() is itself what's
// broken, that call re-throws — installErrorBoundary's own try/catch around
// `toast` catches it and falls back to console.error rather than crashing the
// boundary (see error-boundary.js's safeToast).
// Known gap, accepted: the ES module imports above (including ./live/jobs.js,
// which self-boots at import) evaluate BEFORE this line runs, so an
// import-time throw anywhere in the module graph is NOT caught here — the
// boundary covers post-boot runtime errors only.
installErrorBoundary({
  toast: (msg) => { state.inboxToast = { msg, undoTs: null }; render(); },
  post: (payload) => {
    fetch('/api/client-log', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {}); // best-effort — never let a logging failure cascade
  },
});

let researchTimer = null;
let refreshTimer = null;
let toastTimer = null;
let _convFilterRenderTimer = null;  // mobile: coalesce conv-search re-renders
const root = document.getElementById('oc-root');
const mq = window.matchMedia('(max-width: 768px)');
// Hide root until the first live-data render so mock sample data never flashes.
let rootRevealed = false;
root.style.visibility = 'hidden';
const isMobile = () => mq.matches;

// Fade out the fortress boot loader (index.html #app-loader) once the shell is
// revealed. Idempotent — safe to call from every reveal path.
function hideBootLoader() {
  const l = document.getElementById('app-loader');
  if (!l || l.classList.contains('is-hiding')) return;
  l.classList.add('is-hiding');
  setTimeout(() => l.remove(), 320);
}

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
  return n > 0 ? '<span class="nav-pip"></span><span class="nav-dot"></span>' : '';
}

function renderRail() {
  const collapsed = !state.railExpanded;
  const inboxItems = state.live?.inbox?.items || [];
  const inboxVisible = inboxItems.filter((m) => !state.dismissed.includes(String(m.id))).length;
  const emailUnread = (state.live?.email?.emails || []).filter((e) => e.unread).length;
  return `
  <div class="oc-rail${collapsed ? ' collapsed' : ''}">
    <div class="oc-rail-head">
      <div class="oc-avatar oc-avatar-28" data-act="toggleRail" title="Toggle sidebar"><img src="${AVATAR}" alt="__AGENT_NAME__"></div>
      <span class="oc-rail-name">__AGENT_NAME__</span>
      <span class="oc-online${state.isOnline ? '' : ' offline'}"><span class="dot"></span>${state.isOnline ? 'online' : 'offline'}</span>
      <div class="oc-spacer"></div>
      <button class="oc-rail-collapse" data-act="toggleRail" title="Collapse sidebar"><span style="display:inline-flex;transform:rotate(${collapsed ? '180deg' : '0deg'})">${I.chevLeft()}</span></button>
    </div>
    ${railItem('chat', 'Chat', I.chat(), chatNotifyBadge())}
    ${railItem('inbox', 'Inbox', I.inbox(), inboxVisible > 0 ? `<span class="nav-pip"></span><span class="nav-badge">${inboxVisible}</span>` : '')}
    ${railItem('email', 'Email', I.email(), emailUnread > 0 ? `<span class="nav-pip"></span><span class="nav-badge">${emailUnread}</span>` : '')}
    ${railItem('calendar', 'Calendar', I.calendar())}
    ${railItem('research', 'Research', I.research())}
    ${railItem('library', 'Library', I.library())}
    ${railItem('notes', 'Notes', I.notes())}
    <div class="oc-rail-fill"></div>
    ${railItem('settings', 'Settings', I.settings())}
    <div class="oc-user"><span class="uav">F</span><span class="uname">frank</span></div>
    <a class="oc-rail-source" href="${esc(state.sourceUrl)}" target="_blank" rel="noopener noreferrer" title="AGPL-3.0 — view the source code of this running version">${I.code(14)}<span class="label">Source</span></a>
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
    ${inboxToastHtml(s)}
  </div>`;
}

// ---- shell assembly (breakpoint dispatch) ---------------------------------
// Scroll containers whose position must survive a re-render. render() rebuilds
// root.innerHTML wholesale, which would otherwise reset every scrollable region
// to the top — jumping the chat back up on every action (expanding a tool card)
// and pinning the live stream above the fold so new output never came into view.
const SCROLL_SELECTORS = ['.chat-thread', '.m-scroll', '.m-files'];

// Track chat mount/session across renders so we can jump to the newest message
// when a chat is first opened (or you switch sessions) instead of leaving it
// parked at the top — without disturbing the stick-to-bottom-while-streaming case.
let _prevChatMounted = false;
let _prevActiveId = null;

// ---- mobile Back-button integration ----------------------------------------
// One history entry per open layer (sheet / reader / sub-screen — see
// mobile-history.js). Pushed as layers open (after each render, or straight
// from the swipe-drawer commit which deliberately skips render()); consumed
// with history.go() when layers are closed by taps so Back never needs a
// double-press. ignorePops swallows the popstate that go() fires itself.
let _uiDepth = 0;
let _ignorePops = 0;
function syncMobileHistory() {
  if (!isMobile()) return;
  const want = derivedDepth(state);
  while (_uiDepth < want) {
    _uiDepth++;
    try { history.pushState({ ocUi: _uiDepth }, '', location.href); } catch (_) { _uiDepth--; break; }
  }
  if (_uiDepth > want) {
    const n = _uiDepth - want;
    _ignorePops += n;
    _uiDepth = want;
    try { history.go(-n); } catch (_) { _ignorePops -= n; }
  }
}
window.addEventListener('popstate', (e) => {
  if (_ignorePops > 0) { _ignorePops--; return; }
  if (!isMobile()) return;
  const to = (e.state && e.state.ocUi) || 0;
  let guard = 8;
  while (derivedDepth(state) > to && guard-- > 0) closeTopmost(state);
  _uiDepth = Math.min(_uiDepth, to);
  render();
});

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
  const sheetWasOpen = isMobile() && state.companionSheetOpen;
  root.innerHTML = isMobile() ? renderMobile(s) : renderDesktop(s);
  // Suppress the slide-up animation when the sheet is already open and being
  // re-rendered by a click inside it — otherwise every action replays the pop.
  if (sheetWasOpen) {
    const sheet = root.querySelector('.m-sheet.companion');
    if (sheet) sheet.style.animation = 'none';
  }

  if (!rootRevealed && Object.keys(state.live).length > 0) {
    rootRevealed = true;
    root.style.visibility = '';
    hideBootLoader();
  }

  // auto-dismiss toast after 8 s (re-arm on every render while toast is set)
  clearTimeout(toastTimer);
  if (state.inboxToast) {
    toastTimer = setTimeout(() => { state.inboxToast = null; render(); }, 8000);
  }

  // restore focus + caret
  if (focusKey) {
    const el = root.querySelector(`[data-focus="${focusKey}"]`);
    if (el) {
      // preventScroll: focusing an input otherwise scrolls its nearest scroll
      // container (the chat thread) to reveal it — which yanked the thread on
      // every keystroke-driven render. We restore scroll explicitly below.
      el.focus({ preventScroll: true });
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
  // Jump to the latest message on (re)entry. justEnteredChat catches the simple
  // case; runtime.wantChatBottom (set by the chat loader once content is in)
  // catches the open/switch sequence where an early pre-fetch render would
  // otherwise consume the "just entered" state before the thread is loaded.
  const wantBottom = justEnteredChat || runtime.wantChatBottom;
  for (const sel of SCROLL_SELECTORS) {
    const el = root.querySelector(sel);
    if (!el) continue;
    const isChat = sel === '.chat-thread' || el.classList.contains('m-thread');
    if (isChat && wantBottom) { el.scrollTop = el.scrollHeight; continue; }
    const saved = scrollState[sel];
    if (!saved) continue;
    el.scrollTop = saved.stick ? el.scrollHeight : saved.top;
  }
  if (runtime.wantChatBottom && isChatNow) runtime.wantChatBottom = false;
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

  // Keep browser history in sync with open mobile layers so hardware Back
  // closes the top sheet/reader/sub-screen instead of exiting the PWA.
  syncMobileHistory();

  // Mechanic 1: re-assert focus into a just-opened modal on every render while
  // it's pending (see focusModalOnOpen, below — handles both this render call
  // and any async follow-up one, e.g. reloadSessions()/loadModelOptions()'s
  // own render() after their fetch resolves). render() is defined above
  // _pendingModalFocus/focusModalOnOpen in the file but is only ever CALLED
  // after the whole module — including those later bindings — has finished
  // loading, so referencing them here is safe.
  if (_pendingModalFocus) focusModalOnOpen();

  // Wire drag-to-resize handles on desktop (no-op on mobile — the selectors won't match)
  if (!isMobile()) wireResizableSidebars(root);
}

// ---- actions --------------------------------------------------------------
const actions = {
  toggleRail: () => { state.railExpanded = !state.railExpanded; },
  go: (surface) => { state.surface = surface; state.resOpenCtl = null; },
  // Open an image fullscreen (inline shared images carry data-act="imgView").
  imgView: (src) => { openImageOverlay(src); },
  newChat: () => { state.surface = 'chat'; state.draft = ''; },

  // chat composer
  toggleSlash: () => { state.forceSlash = !state.forceSlash; state.slashDismissed = false; },
  pickSlash: (name) => { state.draft = name + ' '; state.forceSlash = false; state.slashDismissed = false; state.slashSel = null; },
  fillComposer: (prompt) => { state.draft = prompt || ''; state.forceSlash = false; },
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

  // mobile message action sheet (long-press on a user bubble)
  openMobileMsgSheet: (msgId) => {
    if (!state.live?.chat) return;
    state.live.chat.mobileSheetMsgId = msgId || null;
  },
  closeMobileMsgSheet: () => {
    if (!state.live?.chat) return;
    state.live.chat.mobileSheetMsgId = null;
  },
  editPendingOnMobile: (msgId) => editPendingOnMobile(state, msgId, { clearTimeout: (id) => clearTimeout(id) }),
  cancelMobileEdit: () => cancelMobileEdit(state),

  // companion
  compTab: (tab) => { state.compTab = tab; state.compSplit = false; state.compHidden = false; },
  toggleSplit: () => { state.compSplit = !state.compSplit; },
  toggleComp: () => { state.compHidden = !state.compHidden; },
  toggleFs: (path) => { state.fsOpen = { ...state.fsOpen, [path]: !state.fsOpen[path] }; },
  // Switch the Files pane's root. Persisted; triggers a companion reload
  // (handled downstream by the wsSetRoot override in live/companion.js).
  wsSetRoot: (key) => {
    if (!key) return;
    state.wsRootKey = key;
    try { localStorage.setItem('oc-ws-root', key); } catch (_) {}
    state.fsOpen = {}; // dir-open state doesn't carry across roots
  },
  wsRootMenu: () => { state.wsRootMenuOpen = !state.wsRootMenuOpen; },

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

  // calendar
  clearQuick: () => { state.quick = ''; },

  // settings
  setSection: (id) => { state.setSection = id; },
  toggleUi: (key) => { state.ui = { ...state.ui, [key]: !state.ui[key] }; },
  setAccent: (hex) => {
    if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return;
    state.accent = hex;
    // Parse RGB
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    // Derive teal2 (darker, ~58%) and tealtint (10% opacity)
    const r2 = Math.round(r * 0.58), g2 = Math.round(g * 0.58), b2 = Math.round(b * 0.58);
    const toHex = (n) => n.toString(16).padStart(2, '0');
    const teal2 = `#${toHex(r2)}${toHex(g2)}${toHex(b2)}`;
    const tealTint = `rgba(${r},${g},${b},.10)`;
    const root = document.documentElement;
    root.style.setProperty('--accent', hex);
    root.style.setProperty('--teal', hex);
    root.style.setProperty('--teal2', teal2);
    root.style.setProperty('--tealtint', tealTint);
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

// Refresh the active surface's live data (chat thread, inbox, etc.). Shared by
// the pull-to-refresh gesture AND the chat header's refresh button — chat is
// bottom-pinned, so a top-pull is awkward to reach; the button refreshes from
// anywhere without scrolling to the top of history.
function doRefresh() {
  state.refreshing = true; render();
  clearTimeout(refreshTimer);
  loadActive(true);
  refreshTimer = setTimeout(() => { state.refreshing = false; render(); }, 900);
}
actions.refreshChat = doRefresh;

// Code-block copy button. Handled at capture phase and short-circuited so
// the delegated dispatcher below doesn't trigger a render() that would wipe
// the transient "Copied" state on the button.
root.addEventListener('click', (e) => {
  const btn = e.target.closest('.md-copy-btn');
  if (!btn) return;
  e.stopPropagation();
  e.preventDefault();
  const pre = btn.closest('pre.md-code');
  const code = pre && pre.querySelector('code');
  const text = code ? code.textContent : '';
  const done = () => {
    btn.classList.add('is-copied');
    btn.setAttribute('title', 'Copied');
    setTimeout(() => { btn.classList.remove('is-copied'); btn.setAttribute('title', 'Copy'); }, 1200);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => { /* silent */ });
  } else {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (_) {}
    document.body.removeChild(ta);
  }
}, true);

// ---- modal/sheet focus management ------------------------------------------
// Bounded a11y pass (mechanic 1): focus trap + Escape-to-close + focus-return
// for the redesign's true modal/sheet surfaces — ones with a backdrop that
// blocks the rest of the page and a dedicated close action. Registered here,
// not in each surface module, because this is the one place that already owns
// the central keydown listener and the merged desktop+mobile actions map.
//
// Deliberately NOT here (no backdrop, don't block the page, already dismiss
// on outside click — see the click handler below): the docked terminal/doc-
// editor panels, the desktop companion panel, the Jobs HUD, and small anchored
// dropdowns (chat kebab menu, model popover, message download menu, inbox
// snooze/overflow menus) — those are flyouts, not modals.
const MODAL_SURFACES = [
  // Checked in priority order — first match wins. Mirrors paint/z-order: the
  // conv drawer paints over any sheet (mobile-app.js renders it last), the
  // sheets are mutually exclusive in practice (closeSheets()), and the two
  // desktop overlays live on separate screens from the mobile sheets.
  { open: (s) => isMobile() && !!s.mDrawerOpen, selector: '[data-conv-drawer]', close: 'closeDrawer' },
  { open: (s) => isMobile() && !!s.mModelSheetOpen, selector: '.m-sheet.model-sheet', close: 'closeModelSheet' },
  { open: (s) => isMobile() && !!s.quickCaptureOpen, selector: '.m-sheet.capture', close: 'closeCapture' },
  { open: (s) => isMobile() && !!s.companionSheetOpen, selector: '.m-sheet.companion', close: 'closeCompanion' },
  { open: (s) => isMobile() && !!s.composeOpen, selector: '.m-sheet.compose', close: 'closeCompose' },
  { open: (s) => isMobile() && !!s.inboxReader, selector: '.m-sheet[data-modal="reader"]', close: 'closeReader' },
  { open: (s) => !isMobile() && !!s.composeOpen, selector: '.oc-compose', close: 'closeCompose' },
  { open: (s) => !isMobile() && !!s.inboxReader, selector: '.inbox-reader-panel', close: 'closeReader' },
];
// The exists() predicate skips entries whose state flag outlived their
// container (e.g. state.inboxReader surviving a surface switch that no longer
// renders the reader) — otherwise Escape/Tab would target a dead surface.
function topmostModal() {
  return pickModal(MODAL_SURFACES, state, (sel) => !!document.querySelector(sel));
}

// Trigger actions that open one of the surfaces above, and the close actions
// that back out of them — used to capture/restore focus around a modal's
// lifetime (see MODAL_OPEN_ACTIONS/MODAL_CLOSE_ACTIONS use below). Only the
// deliberate "back out" paths restore focus; actions whose success moves you
// elsewhere on purpose (send, pick a model, pick a conversation) are left
// alone — forcing focus back to a now-irrelevant trigger would fight the
// user's next move.
const MODAL_OPEN_ACTIONS = new Set([
  'composeNew', 'composeReply', 'composeAiDraft', 'openReader',
  'openCompanion', 'openCapture', 'openModelSheet', 'openConvDrawer', 'openConvSheet',
]);
const MODAL_CLOSE_ACTIONS = new Set([
  'closeCompose', 'closeReader', 'closeCompanion', 'closeCapture', 'closeModelSheet', 'closeDrawer',
]);

// render() rebuilds root.innerHTML wholesale (see render(), above), so a raw
// reference to a modal's trigger button goes stale the instant ANYTHING
// re-renders — the browser hands back a brand-new, disconnected node. Store a
// re-locatable selector instead (the same data-act[+data-arg] the trigger was
// dispatched on, or its id) and re-query it once the closing render has run.
let _modalFocusReturn = null;
function focusLocator(el) {
  if (!el || !el.getAttribute) return null;
  const act = el.getAttribute('data-act');
  if (act) {
    const arg = el.getAttribute('data-arg');
    const argSel = arg != null && window.CSS && CSS.escape ? `[data-arg="${CSS.escape(arg)}"]` : '';
    return `[data-act="${act}"]${argSel}`;
  }
  if (el.id) return `#${el.id}`;
  return null;
}
function restoreModalFocus() {
  _pendingModalFocus = false;
  if (!_modalFocusReturn) return;
  const sel = _modalFocusReturn;
  _modalFocusReturn = null;
  let el = null;
  try { el = root.querySelector(sel); } catch (_) { el = null; }
  if (el && el.focus) el.focus({ preventScroll: true });
}
// Move focus INTO a just-opened modal (its first focusable element) instead
// of leaving it wherever the render() rebuild happened to drop it — otherwise
// the trap has nothing meaningful to land on until the user's first Tab press.
//
// Several modal-open actions (openModelSheet, openConvSheet/openConvDrawer)
// kick off an async data reload that calls render() AGAIN once it resolves
// (loadModelOptions, reloadSessions) — root.innerHTML gets rebuilt a second
// time, which silently detaches whatever we just focused. A single focus()
// call right after the dispatcher's render() isn't enough to survive that.
// So this doesn't run once — render() (below) re-asserts it on EVERY render
// while _pendingModalFocus is set, and clears the flag itself the moment
// focus is genuinely inside the modal (including right after this call
// succeeds) — so it stops re-grabbing focus the instant the user has it, and
// never fights a deliberate interaction (every one of these modals has a
// full-viewport backdrop, so there's no click path to "outside" without
// going through a close action first).
let _pendingModalFocus = false;
function focusModalOnOpen() {
  const modal = topmostModal();
  if (!modal) { _pendingModalFocus = false; return; }
  const container = root.querySelector(modal.selector) || document.querySelector(modal.selector);
  const alreadyInside = !!(container && container.contains(document.activeElement) && document.activeElement !== document.body);
  if (alreadyInside) { _pendingModalFocus = false; return; }
  const first = container ? trapOrder(container)[0] : null;
  if (first && first.focus) first.focus({ preventScroll: true });
}

// ---- event delegation -----------------------------------------------------
root.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) {
    // A click outside any actionable element dismisses open menus.
    if (state.chatMenuOpen || state.modelMenuOpen || state.live?.chat?.rowMenuOpen || state.live?.chat?.msgMenuOpen || state.wsRootMenuOpen) {
      state.chatMenuOpen = false;
      state.modelMenuOpen = false;
      state.wsRootMenuOpen = false;
      if (state.live?.chat) { state.live.chat.rowMenuOpen = null; state.live.chat.msgMenuOpen = null; }
      render();
    }
    // Clicking outside a card also closes an open ⋯ overflow / snooze menu.
    if (state.inboxSnoozeFor || state.inboxMoreFor) {
      state.inboxSnoozeFor = null;
      state.inboxMoreFor = null;
      render();
    }
    return;
  }
  // The composer Send button is driven off pointerup (below), not click, to
  // dodge the mobile focus/click race. Skip it here so it doesn't double-fire.
  if (t.closest('.m-send')) return;
  const name = t.getAttribute('data-act');
  const fn = actions[name];
  if (!fn) return;
  // Modal focus-return (mechanic 1): remember the trigger before an "open"
  // action runs (t is exactly that trigger), restore it after a "close"
  // action's render has settled. See MODAL_OPEN_ACTIONS/MODAL_CLOSE_ACTIONS.
  if (MODAL_OPEN_ACTIONS.has(name)) { _modalFocusReturn = focusLocator(t); _pendingModalFocus = true; }
  fn(t.getAttribute('data-arg'), e);
  applyCloseSheet(state, t.getAttribute('data-close-sheet'));
  render();
  if (MODAL_CLOSE_ACTIONS.has(name)) restoreModalFocus();
  loadActive(); // fetch live data for any newly-activated surface (idempotent)
});

// Keyboard activation for clickable rows that aren't native <button>/<a>/
// <input> elements (conv rows, model rows, capture-type chips — tagged with
// tabindex+role by their surface modules). Native controls already respond to
// Enter/Space on their own; skip them so this never double-fires. Dispatching
// a real click lets the existing delegated click handler above do the actual
// work — no parallel action-dispatch path to keep in sync.
root.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const t = e.target;
  if (!t || !t.matches || !t.matches('[data-act][tabindex]')) return;
  const tag = (t.tagName || '').toLowerCase();
  if (tag === 'button' || tag === 'a' || tag === 'input' || tag === 'textarea' || tag === 'select') return;
  e.preventDefault();
  t.click();
});

// Mobile: send from pointerup instead of click. Tapping any button blurs the
// focused textarea, which dismisses the soft keyboard and triggers a layout
// shift that can swallow the synthesized click — that's why a click-based send
// took two taps on mobile (first tap eaten). pointerup fires before that race;
// preventDefault stops the ghost click from double-sending. send reads
// state.draft, not the focused field, so focus changes don't matter. Works on
// desktop too (pointer events cover mouse).
root.addEventListener('pointerup', (e) => {
  const sb = e.target.closest('.m-send');
  if (!sb) return;
  e.preventDefault();
  const name = sb.getAttribute('data-act') || 'send';
  const fn = actions[name];
  if (!fn) return;
  fn(sb.getAttribute('data-arg'), e);
  if (name === 'send') {
    commitMobileEditIfPending(state);
  }
  render();
  loadActive();
});

// Long-press on a mobile user bubble → open the message action sheet.
// Uses a pure state machine (mobile/longpress.js) so behavior is unit-tested.
const lpState = { active: null };
const lpIO = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (t) => clearTimeout(t),
  dispatch: (name, arg) => {
    const fn = actions[name];
    if (fn) { fn(arg); render(); }
  },
};
root.addEventListener('pointerdown', (e) => {
  const bubble = e.target.closest('.m-msg-user');
  if (!bubble) return;
  const wrap = bubble.closest('[data-msg-id]');
  if (!wrap) return;
  const msgId = wrap.getAttribute('data-msg-id');
  startLongPress(lpState, { msgId, x: e.clientX, y: e.clientY }, lpIO);
});
root.addEventListener('pointermove', (e) => {
  moveLongPress(lpState, { x: e.clientX, y: e.clientY }, lpIO);
});
root.addEventListener('pointerup', () => endLongPress(lpState, lpIO));
root.addEventListener('pointercancel', () => resetLongPress(lpState, lpIO));
document.addEventListener('scroll', () => resetLongPress(lpState, lpIO), true);

// Swipe-down on the message action sheet dismisses it.
let sheetTouchStart = null;
root.addEventListener('touchstart', (e) => {
  const sheet = e.target.closest('.m-msg-sheet');
  if (!sheet) { sheetTouchStart = null; return; }
  const t = e.touches[0];
  sheetTouchStart = { y: t.clientY, ts: Date.now() };
}, { passive: true });
root.addEventListener('touchmove', (e) => {
  if (!sheetTouchStart) return;
  const t = e.touches[0];
  const dy = t.clientY - sheetTouchStart.y;
  const dtMs = Date.now() - sheetTouchStart.ts;
  if (shouldSwipeDismiss({ dy, dtMs })) {
    const fn = actions.closeMobileMsgSheet;
    if (fn) { fn(); render(); }
    sheetTouchStart = null;
  }
}, { passive: true });
root.addEventListener('touchend', () => { sheetTouchStart = null; }, { passive: true });

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
  // Color picker input: data-act-color fires setAccent on every change
  const cp = e.target.closest('[data-act-color]');
  if (cp && cp.type === 'color') {
    const act = cp.getAttribute('data-act-color');
    const fn = actions[act];
    if (fn) { fn(cp.value); render(); }
    return;
  }
  const t = e.target.closest('[data-model]');
  if (!t) return;
  const field = t.getAttribute('data-model');
  if (field === 'inboxEditTask' && state.inboxEditFor) { state.inboxEditFor = { ...state.inboxEditFor, task: t.value }; return; }
  state[field] = t.value;
  if (field === 'draft') {
    state.forceSlash = false; // typing manages the slash menu
    // A fresh keystroke re-opens the dropdown even if Escape just dismissed it,
    // and the old highlighted command may no longer be in the filtered list.
    state.slashDismissed = false;
    state.slashSel = null;
  }
  // The conversation filter also fires a debounced semantic search over ALL
  // chats' message content (title filtering stays instant + local below).
  if (field === 'convFilter') {
    if (actions.convSearch) actions.convSearch(t.value);
    // On mobile, do NOT render() on every keystroke — a wholesale root.innerHTML
    // rebuild mid-type on a touch keyboard drops fast characters (same reason the
    // mdraft composer skips render). The DOM already holds the typed text; state
    // is synced above. Coalesce into ONE render after a short typing pause so the
    // filtered list / MESSAGES section catch up without fighting the keyboard.
    // (The semantic fetch also re-renders when its results resolve.)
    if (isMobile()) {
      if (_convFilterRenderTimer) clearTimeout(_convFilterRenderTimer);
      _convFilterRenderTimer = setTimeout(() => { _convFilterRenderTimer = null; render(); }, 220);
      return;
    }
  }

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
  // The inline message editor (Task 8, msg-edit-ta / data-focus="msgEdit") has
  // no slash palette to drive, so there's no reason for it to pay render()'s
  // cost of re-running chatMsg→renderMarkdown for every message in the thread
  // on each keystroke — the same lag the draft/mdraft composers already skip.
  // State is synced above so saveEdit() sees the typed text; the DOM already
  // holds it, so skipping the rebuild here is safe.
  if (fk === 'msgEdit') return;
  // Typing in the desktop composer must not move the thread at all. render()
  // rebuilds the DOM and re-focuses the textarea; pin the chat scroll to exactly
  // where it was so a keystroke changes nothing in the viewport.
  if (fk === 'draft') {
    // macOS dictation (and any IME) deliver text via composition events:
    // repeated compositionupdate each carrying the full phrase-so-far, then a
    // single compositionend. render() rebuilds root.innerHTML wholesale, which
    // destroys the textarea's live composition range mid-dictation — the
    // browser then loses its marked-text anchor and re-inserts the entire
    // accumulated phrase on every update (the classic "H He Hel Hell…" pileup).
    // State is already synced above so send() sees the text; skip the
    // destructive re-render while composing. compositionend renders once after.
    if (e.isComposing) return;
    // The full render() below exists ONLY to drive the slash-command palette as
    // you type. But render() rebuilds root.innerHTML wholesale, which re-runs
    // chatMsg→renderMarkdown for EVERY message in the thread — on a long
    // conversation (or with a long reply present) that's the real cause of
    // composer typing lag: each keystroke re-parses the entire thread. The DOM
    // already holds the typed character and state is synced above, so skip the
    // rebuild unless the slash palette actually needs it — i.e. the draft is a
    // "/command", or a slash menu is currently open and must now close. (Mirrors
    // the mobile composer, which already skips render on every keystroke.)
    const slashRelevant = t.value.startsWith('/') || !!root.querySelector('.slash-menu');
    if (!slashRelevant) return;
    const before = root.querySelector('.chat-thread');
    const savedTop = before ? before.scrollTop : null;
    render();
    if (savedTop != null) {
      const after = root.querySelector('.chat-thread');
      if (after) after.scrollTop = savedTop;
    }
    return;
  }
  render();
});

// When an IME / macOS dictation composition finishes, do the single render the
// input handler deliberately skipped while e.isComposing was true (see above),
// so the slash palette and rest of the UI catch up to the dictated text.
root.addEventListener('compositionend', (e) => {
  const t = e.target.closest && e.target.closest('[data-model]');
  if (!t) return;
  const field = t.getAttribute('data-model');
  if (field !== 'draft' && field !== 'mdraft') return;
  state[field] = t.value;
  const fk = t.getAttribute('data-focus');
  if (fk === 'draft' || fk === 'mdraft') autoGrowComposer(t);
  if (fk === 'mdraft') return; // mobile never re-renders the composer (see input handler)
  const before = root.querySelector('.chat-thread');
  const savedTop = before ? before.scrollTop : null;
  render();
  if (savedTop != null) {
    const after = root.querySelector('.chat-thread');
    if (after) after.scrollTop = savedTop;
  }
});

// Inline message editor (Task 8): ⌘/Ctrl+Enter saves & sends, Esc cancels.
// Scoped to .msg-edit-ta so it never shadows the composer's own shortcuts.
root.addEventListener('keydown', (e) => {
  const ta = e.target.closest && e.target.closest('.msg-edit-ta');
  if (!ta) return;
  const wrap = ta.closest('[data-msg-id]');
  const id = wrap && wrap.getAttribute('data-msg-id');
  if (!id) return;
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    if (actions.saveEdit) { actions.saveEdit(id); render(); }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    if (actions.cancelEdit) { actions.cancelEdit(id); render(); }
  }
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
// Any file type — used for drag-and-drop (paste stays image-only since
// clipboard items are almost always screenshots, not arbitrary files).
function filesFrom(list) {
  const out = [];
  for (const f of (list || [])) {
    if (f && f.size >= 0) out.push(f.name ? f : new File([f], `upload-${Date.now()}`, { type: f.type || 'application/octet-stream' }));
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
    _dropOverlay.innerHTML = '<div class="oc-drop-card">Drop to attach</div>';
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
  const files = filesFrom(e.dataTransfer && e.dataTransfer.files);
  if (files.length && actions.uploadAttachments) actions.uploadAttachments(files);
});

// Enter-to-send in the chat composer (Shift+Enter = newline). Calls the chat
// module's `send` action once it's been merged in (no-op until then).
root.addEventListener('keydown', (e) => {
  const t = e.target;
  if (!t || !t.getAttribute) return;
  const fk = t.getAttribute('data-focus');
  if (fk !== 'draft' && fk !== 'mdraft') return;

  // Slash-command autocomplete (mechanic 4 — desktop only, fk==='draft'; the
  // mobile composer doesn't render this dropdown): ArrowUp/Down move the
  // highlight, Enter picks the highlighted command, Escape dismisses the
  // dropdown WITHOUT clearing the typed text. This must run before the plain
  // Enter-to-send handling below, or Enter would send "/rem" as a chat
  // message instead of completing the command.
  if (fk === 'draft' && root.querySelector('.slash-menu')) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const filtered = filterSlashCommands(state.draft);
      const current = filtered.find((c) => c.name === state.slashSel) || null;
      const next = nextFocus(filtered, current, e.key === 'ArrowUp');
      if (next) state.slashSel = next.name;
      render();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const filtered = filterSlashCommands(state.draft);
      const pick = filtered.find((c) => c.name === state.slashSel) || filtered[0];
      if (pick && actions.pickSlash) { actions.pickSlash(pick.name); render(); }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      state.slashDismissed = true;
      render();
      return;
    }
  }

  if (e.key !== 'Enter') return;
  // Cmd/Ctrl+Enter always sends (desktop & mobile). Plain Enter sends on desktop
  // only (Shift+Enter = newline there); on mobile (mdraft) plain Enter inserts a
  // newline — the box auto-grows and the Send button or ⌘/Ctrl+Enter sends.
  const sendCombo = (e.metaKey || e.ctrlKey) || (fk === 'draft' && !e.shiftKey);
  if (sendCombo) {
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
    // Dismiss the nearest/most-local layer first: a small anchored dropdown
    // (if one happens to be open) before a true modal/sheet underneath it.
    if (state.chatMenuOpen || state.modelMenuOpen || state.live?.chat?.rowMenuOpen) {
      state.chatMenuOpen = false;
      state.modelMenuOpen = false;
      if (state.live?.chat) state.live.chat.rowMenuOpen = null;
      render();
      return;
    }
    // Mechanic 1: Escape closes the topmost true modal/sheet via the SAME
    // close action its own Cancel/X button or backdrop-tap uses — not a
    // parallel path (see MODAL_SURFACES above).
    const modal = topmostModal();
    if (modal) {
      e.preventDefault();
      const fn = actions[modal.close];
      if (fn) { fn(); render(); restoreModalFocus(); }
      return;
    }
  }
  // Mechanic 1: trap Tab / Shift+Tab inside the topmost open modal/sheet so
  // keyboard focus can never leave it onto the page behind the backdrop.
  if (e.key === 'Tab') {
    const modal = topmostModal();
    if (modal) {
      const container = root.querySelector(modal.selector) || document.querySelector(modal.selector);
      const order = container ? trapOrder(container) : [];
      if (order.length) {
        e.preventDefault();
        const next = nextFocus(order, document.activeElement, e.shiftKey) || order[0];
        next.focus();
      }
      return; // a modal owns Tab while it's open — don't fall through below
    }
  }
  if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
    // While a modal is open it owns focus — the filter inputs this shortcut
    // targets are background elements (still in the DOM behind the compose
    // overlay etc.); focusing one would silently escape the trap.
    if (topmostModal()) return;
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
    if (topmostModal()) return; // same trap-escape hatch as ⌘K — composer is behind the backdrop
    const tag = (e.target && e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || (e.target && e.target.isContentEditable)) return;
    const ta = root.querySelector('[data-focus="draft"]');
    if (ta) { e.preventDefault(); ta.focus(); }
  }
});

// mobile keyboard: focusing the chat composer raises the keyboard (frame 9 —
// tab bar hides, composer lifts). Guarded so the focus-restore loop is a no-op.
// Toggle the composing layout via a CSS class on the existing .m-app instead of
// a full render(). Rebuilding root.innerHTML on focus destroyed the live
// textarea (so the freshly-focused field lost focus and the keyboard collapsed
// → "can't type") and replaced the Send button mid-tap (so the first tap was
// swallowed by the rebuild and a second tap was needed). A class toggle leaves
// both elements intact: focus persists and the first Send tap lands.
function setMobileKb(on) {
  state.keyboard = on;
  const app = root.querySelector('.m-app');
  if (app) app.classList.toggle('kb-up', on);
}
root.addEventListener('focusin', (e) => {
  if (isMobile() && e.target.getAttribute && e.target.getAttribute('data-focus') === 'mdraft' && !state.keyboard) {
    setMobileKb(true);
  }
});
root.addEventListener('focusout', (e) => {
  if (e.target.getAttribute && e.target.getAttribute('data-focus') === 'mdraft' && state.keyboard) {
    setMobileKb(false);
  }
});

// touch gestures (swipe-to-archive, pull-to-refresh)
wireMobileGestures({
  root, state,
  commitArchive: (id) => actions.dismiss(id),
  refresh: doRefresh,
  render,
  // The swipe path opens/closes the conversation drawer without a render();
  // sync history right there so Back still closes a swipe-opened drawer.
  onOverlayChange: syncMobileHistory,
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
  // outerHTML replacement removes the node then inserts the new one — between
  // those two steps the scroller's scrollHeight briefly drops, and the browser
  // CLAMPS scrollTop to the (temporarily-smaller) max. At ~60 patches/sec that
  // clamp yanks the user's scroll back toward the bottom on every frame, making
  // it impossible to scroll up to read the top of a streaming reply. Preserve
  // scrollTop across the swap when we're not intentionally sticking.
  const savedTop = scroller ? scroller.scrollTop : 0;
  el.outerHTML = isMobile() ? mChatMsg(m, state) : chatMsg(m, state);
  if (stick && scroller) scroller.scrollTop = scroller.scrollHeight;
  else if (scroller && scroller.scrollTop !== savedTop) scroller.scrollTop = savedTop;
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

window.addEventListener('online', () => { state.isOnline = true; render(); });
window.addEventListener('offline', () => { state.isOnline = false; render(); });

window.addEventListener('hashchange', () => {
  const h = (location.hash || '').replace('#', '');
  if (SURFACES.includes(h) && h !== state.surface) { state.surface = h; seedMobileFromHash(h); render(); }
  else if ((h === 'more' || h === 'capture')) { seedMobileFromHash(h); render(); }
  loadActive();
});

render();
loadActive(); // kick off live data for the initial surface
// First-run only: on a mobile browser (not already installed), show a small,
// easy-to-dismiss "Add to Home Screen" hint. Shares the shell's isMobile().
maybeShowInstallHint(isMobile);
// First-run only: point mobile users at the hamburger button + edge-swipe as
// the two ways to see all their threads. Waits for install-hint to clear.
maybeShowThreadsHint(isMobile);
// Safety net: if live loading fails entirely (network down, all throws), reveal
// after 3 s so the page doesn't stay permanently invisible.
setTimeout(() => { if (!rootRevealed) { rootRevealed = true; root.style.visibility = ''; hideBootLoader(); } }, 3000);
// Prime the chat loader even when booting into another surface, so the
// cross-session turn notifier (started in chat's load()) runs from the start —
// a reply finishing while you're in Inbox/Email/etc. still notifies.
if (activeSurface() !== 'chat') loadSurface('chat', { state, actions, render });
// Pre-fetch inbox and email counts so nav badges appear immediately on load,
// not only after the user navigates to those surfaces.
if (activeSurface() !== 'inbox') loadSurface('inbox', { state, actions, render });
if (activeSurface() !== 'email') loadSurface('email', { state, actions, render });
// AGPL-3.0 §13: resolve the operator-configured source URL (WORKSPACE_SOURCE_URL
// via /api/config) so the rail/More "Source" link points at the corresponding
// source of THIS running version. Falls back to the upstream repo on failure.
fetch('/api/config')
  .then((r) => (r.ok ? r.json() : null))
  .then((c) => { if (c && c.source_url) { state.sourceUrl = c.source_url; render(); } })
  .catch(() => {});
