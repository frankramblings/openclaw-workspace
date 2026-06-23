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

// ---- state ---------------------------------------------------------------
const state = {
  surface: 'chat',
  railExpanded: true,
  // chat
  draft: '', forceSlash: false, chatMode: 'agent',
  // companion
  compTab: null, compSplit: false, compHidden: false,
  fsOpen: { data: true, 'data/skills': false, documents: true, notes: false, research: false },
  // research
  researchQuery: '', research: 'idle', resOpenCtl: null,
  resCfg: { rounds: 'Auto', engine: 'Default', endpoint: 'Claude-Cli', model: 'opus-4' },
  // library / notes / email / inbox / calendar
  libFilter: 'all', selDoc: 0, selEmail: 0, dismissed: [], quick: '',
  // settings
  setSection: 'services', accent: '#4fe3d1',
  ui: { ...DEFAULT_UI },
};

let researchTimer = null;
const root = document.getElementById('oc-root');

// ---- crumb ----------------------------------------------------------------
const CRUMB = {
  chat: 'workspace / chat', email: 'workspace / email', inbox: 'workspace / inbox',
  calendar: 'workspace / calendar', research: 'workspace / research',
  library: 'workspace / library', notes: 'workspace / notes', settings: 'workspace / settings',
};

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

// ---- shell assembly -------------------------------------------------------
function render() {
  // capture focus + caret before rebuild
  const act = document.activeElement;
  const focusKey = act && act.getAttribute ? act.getAttribute('data-focus') : null;
  const selStart = focusKey ? act.selectionStart : null;
  const selEnd = focusKey ? act.selectionEnd : null;

  const s = state;
  const showCompanion = s.surface !== 'settings' && !s.compHidden;
  const showReveal = s.surface !== 'settings' && s.compHidden;

  root.innerHTML = `
  <div class="oc-app">
    <div class="oc-chrome">
      <div class="oc-lights"><span class="oc-light-r"></span><span class="oc-light-y"></span><span class="oc-light-g"></span></div>
      <div class="oc-spacer"></div>
      <span class="oc-crumb">${esc(CRUMB[s.surface])}</span>
    </div>
    <div class="oc-body">
      ${renderRail()}
      ${when(s.surface === 'chat', renderChatList(s))}
      <div class="oc-center">${renderCenter(s)}</div>
      ${when(showCompanion, renderCompanion(s))}
      ${when(showReveal, renderReveal(s))}
    </div>
  </div>`;

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
};

// ---- event delegation -----------------------------------------------------
root.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const name = t.getAttribute('data-act');
  const fn = actions[name];
  if (!fn) return;
  fn(t.getAttribute('data-arg'), e);
  render();
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

// ---- boot -----------------------------------------------------------------
// Deep-link the initial surface from the hash (e.g. #calendar), and keep the
// hash in sync as the user navigates so views are shareable / reloadable.
const SURFACES = ['chat', 'inbox', 'email', 'calendar', 'research', 'library', 'notes', 'settings'];
const fromHash = (location.hash || '').replace('#', '');
if (SURFACES.includes(fromHash)) state.surface = fromHash;

const _go = actions.go;
actions.go = (surface) => { _go(surface); if (location.hash !== '#' + surface) history.replaceState(null, '', '#' + surface); };

window.addEventListener('hashchange', () => {
  const h = (location.hash || '').replace('#', '');
  if (SURFACES.includes(h) && h !== state.surface) { state.surface = h; render(); }
});

render();
