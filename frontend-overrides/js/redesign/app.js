// OpenClaw Workspace — Direction A redesign shell (parallel-entry prototype).
// Vanilla JS, string-template rendering with event delegation + focus
// preservation. Recreates the design reference's state model and interactions.
// Served standalone at /static/index-redesign.html — does not touch index.html.

import { I } from './icons.js';
import { esc, when } from './dom.js';
import { AVATAR } from './data.js';
import { DEFAULT_UI } from './settings-data.js';
import { renderCenter, renderChatList } from './surfaces.js';
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
  chatUI: { trail: {}, step: {} }, // activity-trail collapse state (per msg/step)
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
    ${railItem('chat', 'Chat', I.chat())}
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
function render() {
  // capture focus + caret before rebuild
  const act = document.activeElement;
  const focusKey = act && act.getAttribute ? act.getAttribute('data-focus') : null;
  const selStart = focusKey ? act.selectionStart : null;
  const selEnd = focusKey ? act.selectionEnd : null;

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
    }
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

  // chat activity trail (UI-only collapse; default trail open, steps closed)
  toggleTrail: (id) => { const t = state.chatUI.trail; t[id] = t[id] === false ? true : false; },
  toggleStep: (id) => { const st = state.chatUI.step; st[id] = !st[id]; },
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
  if (!t) return;
  const name = t.getAttribute('data-act');
  const fn = actions[name];
  if (!fn) return;
  fn(t.getAttribute('data-arg'), e);
  render();
  loadActive(); // fetch live data for any newly-activated surface (idempotent)
});

// live-bound inputs/textareas
root.addEventListener('input', (e) => {
  const t = e.target.closest('[data-model]');
  if (!t) return;
  const field = t.getAttribute('data-model');
  state[field] = t.value;
  if (field === 'draft') state.forceSlash = false; // typing manages the slash menu
  render();
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
