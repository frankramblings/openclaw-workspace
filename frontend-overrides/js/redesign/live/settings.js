// Live wiring for the SETTINGS surface.
//
// The static PANELS render (../surfaces.js settingsSurface) stays intact; this
// module only adds `load` (hydrate state.accent / state.ui from real values)
// and `actions` (override the mock setAccent / toggleUi so they drive the REAL
// theme + persist server-side). Every persistence call is best-effort: an
// action never throws and a failed write only loses durability, never the
// visible flip.
//
// Persistence stores (see live/README.md + theme.js):
//   - PUT  /api/prefs/{key} {value}     -> .data/memory_prefs.json   (theme/ui prefs)
//   - POST /api/auth/settings {merge}   -> .data/settings.json       (feature/search/reminder keys)
//   - GET  /api/config                  -> {agent_name, accent, workspace_root}
//   - GET  /api/auth/settings           -> the settings bag
//
// The redesign accent only sets CSS var `--accent`; the REAL theme accent var
// is `--red` (theme.js applyColors). So setAccent must set BOTH so the swatch
// visibly drives the app.

import { runtime } from './runtime.js';
import { apiGet, apiJson, ApiError } from './api.js';
import { updateTermTheme } from './terminal.js';

const ACCENT_KEY = 'oc-accent';

// state.ui toggle key -> real /api/auth/settings key. Only keys we're confident
// map to a real backend setting persist server-side; everything else stays
// local (still flips visually).
const SETTINGS_TOGGLE_MAP = {
  visionEnabled: 'vision_enabled',
  teacherEnabled: 'teacher_enabled',
  reminderLlm: 'reminder_llm_synthesis',
};

function setAccentVars(hex) {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return;
  const s = document.documentElement.style;
  s.setProperty('--accent', hex);
  s.setProperty('--red', hex); // REAL theme accent var — makes the swatch drive the classic gateway
  // Redesign uses --teal / --teal2 / --tealtint throughout; derive all three.
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const toHex = (n) => Math.round(n).toString(16).padStart(2, '0');
  s.setProperty('--teal', hex);
  s.setProperty('--teal2', `#${toHex(r * 0.58)}${toHex(g * 0.58)}${toHex(b * 0.58)}`);
  s.setProperty('--tealtint', `rgba(${r},${g},${b},.10)`);
}

// Best-effort persistence helpers — swallow every error.
async function persistAccent(hex) {
  // Persist to both stores: prefs (theme/ui) and the settings bag.
  await Promise.allSettled([
    apiJson('/api/prefs/accent', { value: hex }, 'PUT'),
    apiJson('/api/auth/settings', { accent: hex }, 'POST'),
  ]);
}

async function persistSetting(realKey, value) {
  try {
    await apiJson('/api/auth/settings', { [realKey]: value }, 'POST');
  } catch (_) { /* fail soft */ }
}

// Pull a human-readable message out of an ApiError's parsed body (the common
// FastAPI shape is {detail: "..."}), falling back to `fallback` for anything
// else (network failure, a 502 gateway blip with no JSON body, etc.) so the
// user sees the server's actual reason when there is one.
function apiErrorMessage(e, fallback) {
  if (e instanceof ApiError && e.body && typeof e.body === 'object' && typeof e.body.detail === 'string' && e.body.detail) {
    return e.body.detail;
  }
  return fallback;
}

export async function load(state) {
  // Fill the read-only Model Endpoints / Default Chat Model cards (they render
  // from state.live.modelGroups / defaultModel). Fire-and-forget; the chat
  // module's loader guards against refetching and re-renders when it lands.
  try { if (runtime.actions && runtime.actions.loadModelOptions) runtime.actions.loadModelOptions(); } catch (_) {}

  // Apply cached accent immediately (synchronous — no flash on reload).
  let hasCached = false;
  try {
    const cached = localStorage.getItem(ACCENT_KEY);
    if (cached) { state.accent = cached; setAccentVars(cached); hasCached = true; }
  } catch (_) {}

  // 1) Accent from /api/config — only seeds localStorage on first visit to this
  // device (hasCached = false). Never overwrites a locally-stored choice.
  try {
    const cfg = await apiGet('/api/config');
    if (cfg && typeof cfg.accent === 'string' && cfg.accent && !hasCached) {
      state.accent = cfg.accent;
      setAccentVars(cfg.accent);
      try { localStorage.setItem(ACCENT_KEY, cfg.accent); } catch (_) {}
    }
  } catch (_) { /* keep current accent */ }

  // 2) Hydrate any directly-mappable toggles from the settings bag (best-effort).
  try {
    const bag = await apiGet('/api/auth/settings');
    if (bag && typeof bag === 'object') {
      const next = { ...state.ui };
      let changed = false;
      for (const [uiKey, realKey] of Object.entries(SETTINGS_TOGGLE_MAP)) {
        if (Object.prototype.hasOwnProperty.call(bag, realKey)) {
          next[uiKey] = !!bag[realKey];
          changed = true;
        }
      }
      if (changed) state.ui = next;
      // Search config (the only writable model/search settings — provider + result count).
      if (typeof bag.search_provider === 'string') state.searchProvider = bag.search_provider;
      if (bag.search_result_count != null) state.searchResultCount = Number(bag.search_result_count);
    }
  } catch (_) { /* keep default ui */ }

  // 3) Settings → Usage: token/cost summary from the gateway usage ledger.
  loadUsage(state).catch(() => {});

  // 4) Settings → Changes: watched roots, prune list, cache size.
  loadChangesSettings(state).catch(() => {});

  // 5) Settings → Projects list for the Projects card (also loaded by chat;
  // whichever surface opens first wins, the other overwrites with the same
  // data). Best-effort: a failed fetch keeps whatever list is already there
  // instead of clobbering it with an empty one.
  try {
    const projects = await apiGet('/api/projects');
    state.live.projects = Array.isArray(projects) ? projects : (state.live.projects || []);
  } catch (_) { if (!Array.isArray(state.live.projects)) state.live.projects = []; }

  // 6) Suggested projects (discovery proposals) for the Projects card.
  try {
    const pp = await apiGet('/api/projects/proposals');
    state.live.projectProposals = { proposals: pp?.proposals || [], error: pp?.error || null, running: !!pp?.running, busy: false };
  } catch (_) { state.live.projectProposals = state.live.projectProposals || { proposals: [], error: null, running: false, busy: false }; }
}

// Settings → Usage: GET /api/usage/summary?days=7|30 into state.live.usage.
// Fire-and-forget from load(); also called directly by the usageDays /
// usageRetry actions below.
export async function loadUsage(state, days) {
  state.live = state.live || {};
  const cur = state.live.usage || { days: 7, data: null, error: null };
  const n = days || cur.days || 7;
  state.live.usage = { days: n, data: cur.data, error: null };
  try {
    const data = await apiGet(`/api/usage/summary?days=${n}`);
    state.live.usage = {
      days: n,
      data,
      fresh: !(data && data.fresh === false),
      error: data && data.ok ? null : ((data && data.reason) || 'unknown'),
    };
  } catch (e) {
    // Prefer the backend's own reason (apiGet attaches the parsed error body)
    // over the bare HTTP status, so a gateway failure reads as gateway_error.
    const reason = e && e.body && typeof e.body === 'object' && e.body.reason;
    const status = e && e.status;
    state.live.usage = {
      days: n,
      data: null,
      error: reason || (status ? `http ${status}` : 'network'),
    };
  }
  runtime.render();
}

// Settings → Changes: watched roots / prune list / cache stats from the
// change-review backend into state.live.changesSettings. Fire-and-forget
// from load(); also re-called after every write below so the panel reflects
// what the backend actually saved rather than an optimistic guess.
export async function loadChangesSettings(state) {
  state.live = state.live || {};
  const cur = state.live.changesSettings || { config: null, stats: null, saving: false, error: null, rebuild: { running: false } };
  try {
    const [c, s] = await Promise.all([apiGet('/api/changes/config'), apiGet('/api/changes/stats')]);
    state.live.changesSettings = { ...cur, config: c.config, stats: s, rebuild: s.rebuild || { running: false }, error: null };
  } catch (e) {
    state.live.changesSettings = { ...cur, error: 'Could not load change-review settings.' };
  }
  runtime.render();
}

export const actions = {
  // Drive the REAL theme accent (--accent AND --red), re-render, persist.
  setAccent: (hex) => {
    if (!hex) return;
    runtime.state && (runtime.state.accent = hex);
    setAccentVars(hex);
    updateTermTheme();
    try { localStorage.setItem(ACCENT_KEY, hex); } catch (_) {}
    runtime.render();
    persistAccent(hex); // best-effort, fire-and-forget
  },

  // Flip a UI toggle locally; persist the ones that map to a real setting.
  toggleUi: (key) => {
    const st = runtime.state;
    if (!st) return;
    st.ui = { ...st.ui, [key]: !st.ui[key] };
    runtime.render();
    const realKey = SETTINGS_TOGGLE_MAP[key];
    if (realKey) persistSetting(realKey, st.ui[key]); // best-effort
  },

  // Account → Logout. POST /api/auth/logout then return to the entry page.
  logout: async () => {
    try { await apiJson('/api/auth/logout', {}, 'POST'); } catch (_) {}
    try { window.location.assign('/'); } catch (_) { try { location.reload(); } catch (_) {} }
  },

  // Account → Change Password. Fields bound via data-model (pwCurrent/pwNew/pwConfirm).
  changePassword: async () => {
    const st = runtime.state;
    if (!st) return;
    const cur = (st.pwCurrent || '').trim();
    const nw = (st.pwNew || '').trim();
    const cf = (st.pwConfirm || '').trim();
    if (nw.length < 8) { runtime.state.inboxToast = { msg: 'New password must be at least 8 characters.', undoTs: null }; runtime.render(); return; }
    if (nw !== cf) { runtime.state.inboxToast = { msg: 'New password and confirmation do not match.', undoTs: null }; runtime.render(); return; }
    try {
      await apiJson('/api/auth/change-password', { current_password: cur, new_password: nw }, 'POST');
      st.pwCurrent = ''; st.pwNew = ''; st.pwConfirm = '';
      runtime.render();
      runtime.state.inboxToast = { msg: 'Password updated. Restart the OpenClaw gateway when convenient — chat routing keeps the old credential until then.', undoTs: null };
      runtime.render();
    } catch (e) {
      const msg = apiErrorMessage(e, 'Could not change password — check the current password.');
      runtime.state.inboxToast = { msg, undoTs: null };
      runtime.render();
    }
  },

  // Data Backup → Export: GET /api/export (a real zip — see export_route.py),
  // download the blob. res.ok-checked: a 502/error page must not be handed
  // to the browser disguised as a .zip download.
  exportData: async () => {
    try {
      const res = await fetch(`${location.origin}/api/export`, { credentials: 'same-origin' });
      if (!res.ok) { runtime.state.inboxToast = { msg: 'Export failed — the server returned an error.', undoTs: null }; runtime.render(); return; }
      const blob = await res.blob();
      const cd = res.headers.get('content-disposition') || '';
      const m = cd.match(/filename=([^;]+)/);
      const name = m ? m[1].trim().replace(/['"]/g, '') : 'openclaw-backup.zip';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 1000);
    } catch (_) { runtime.state.inboxToast = { msg: 'Export failed.', undoTs: null }; runtime.render(); }
  },

  // Search → provider selector. Persists search_provider (the writable search
  // setting; result-count is read-only display). Stores the normalized id.
  setSearchProvider: (name) => {
    const s = runtime.state;
    if (!s || !name) return;
    const id = String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
    s.searchProvider = id;
    runtime.render();
    apiJson('/api/auth/settings', { search_provider: id }, 'POST').catch(() => {});
  },

  // Search → "Test": one-shot probe of the configured provider (POST /api/search/test).
  searchTest: async () => {
    try {
      const r = await apiJson('/api/search/test', { query: 'OpenClaw connectivity test' });
      if (r && r.ok) { runtime.state.inboxToast = { msg: `Search OK — ${r.count} results via ${r.provider || 'provider'}.`, undoTs: null }; runtime.render(); }
      else { runtime.state.inboxToast = { msg: `Search test failed: ${(r && r.error) || 'unknown error'}`, undoTs: null }; runtime.render(); }
    } catch (_) { runtime.state.inboxToast = { msg: 'Search test request failed.', undoTs: null }; runtime.render(); }
  },

  // Brain → "Open Brain": load memories + skills into state.live.brain.
  openBrain: async () => {
    const s = runtime.state;
    if (!s) return;
    s.live = s.live || {};
    const brain = {};
    try { const m = await apiGet('/api/memory'); brain.memory = (m && m.memory) || []; } catch (_) { brain.memory = []; }
    try { const k = await apiGet('/api/skills'); brain.skills = (k && k.skills) || []; } catch (_) { brain.skills = []; }
    s.live.brain = brain;
    runtime.render();
  },

  // Scheduled → "Open Scheduled jobs": load the cron list into state.live.cron.
  openScheduled: async () => {
    const s = runtime.state;
    if (!s) return;
    try {
      const data = await apiGet('/api/cron');
      s.live = s.live || {};
      s.live.cron = data && Array.isArray(data.jobs) ? data : { jobs: [], error: true };
    } catch (_) { s.live = s.live || {}; s.live.cron = { jobs: [], error: true }; }
    runtime.render();
  },
  cronRun: async (id) => {
    if (!id) return;
    try {
      await apiJson(`/api/cron/${id}/run`, {});
      runtime.state.inboxToast = { msg: 'Job triggered.', undoTs: null };
      runtime.render();
    } catch (_) {
      runtime.state.inboxToast = { msg: 'Could not trigger the job — try again.', undoTs: null };
      runtime.render();
    }
  },
  cronToggle: async (id) => {
    const s = runtime.state;
    if (!s || !id) return;
    const jobs = (s.live && s.live.cron && s.live.cron.jobs) || [];
    const job = jobs.find((j) => String(j.id) === String(id));
    const action = job && job.enabled ? 'disable' : 'enable';
    try { await apiJson(`/api/cron/${id}/${action}`, {}); } catch (_) {}
    try {
      const data = await apiGet('/api/cron');
      if (data && Array.isArray(data.jobs)) s.live.cron = data;
    } catch (_) {}
    runtime.render();
  },

  // Notifications → enable push subscriptions (request permission + subscribe)
  enablePush: async () => {
    if (!('serviceWorker' in navigator && 'PushManager' in window)) return;
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        runtime.state.inboxToast = { msg: 'Notification permission was denied. Enable in your browser settings.', undoTs: null };
        runtime.render();
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const status = await fetch('/api/push/status').then(r => r.json());
      if (!status.publicKey) {
        runtime.state.inboxToast = { msg: 'Server does not support push notifications.', undoTs: null };
        runtime.render();
        return;
      }
      // Convert b64url public key to Uint8Array
      const base64String = status.publicKey;
      const padding = '='.repeat((4 - base64String.length % 4) % 4);
      const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
      const rawData = atob(base64);
      const applicationServerKey = new Uint8Array([...rawData].map(c => c.charCodeAt(0)));
      const sub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey
      });
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub.toJSON())
      });
      runtime.state.inboxToast = { msg: 'Notifications enabled!', undoTs: null };
      runtime.render(); // re-render to show updated status
    } catch (e) {
      const msg = apiErrorMessage(e, 'Could not enable notifications.');
      runtime.state.inboxToast = { msg, undoTs: null };
      runtime.render();
    }
  },

  // Notifications → disable push subscriptions
  disablePush: async () => {
    if (!('serviceWorker' in navigator)) return;
    try {
      const registration = await navigator.serviceWorker.ready;
      const sub = await registration.pushManager.getSubscription();
      if (!sub) return;
      const data = sub.toJSON();
      await sub.unsubscribe();
      if (data.endpoint) {
        await fetch('/api/push/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: data.endpoint })
        });
      }
      runtime.state.inboxToast = { msg: 'Notifications disabled.', undoTs: null };
      runtime.render();
    } catch (e) {
      const msg = apiErrorMessage(e, 'Could not disable notifications.');
      runtime.state.inboxToast = { msg, undoTs: null };
      runtime.render();
    }
  },

  // Settings → Usage: day-range toggle and error-state retry.
  usageDays: (n) => { loadUsage(runtime.state, Number(n) === 30 ? 30 : 7); },
  usageRetry: () => { loadUsage(runtime.state); },

  // Settings → Changes: add/remove watched roots, save the prune list, and
  // trigger a rebuild. Every write re-fetches config+stats (loadChangesSettings)
  // instead of trusting an optimistic guess, so the panel always shows what
  // the backend actually saved.
  changesAddRoot: async () => {
    const state = runtime.state; const cs = state.live.changesSettings; if (!cs || !cs.config) return;
    const p = String(state.changesRootDraft || '').trim(); if (!p) return;
    cs.saving = true; runtime.render();
    try { await apiJson('/api/changes/config', { roots: [...cs.config.roots, p] }, 'PUT'); state.changesRootDraft = ''; }
    catch (e) { cs.error = /400/.test(String(e && e.message)) ? 'Root must be an absolute path.' : 'Save failed.'; }
    cs.saving = false; await loadChangesSettings(state);
  },
  changesRemoveRoot: async (path) => {
    const state = runtime.state; const cs = state.live.changesSettings; if (!cs || !cs.config) return;
    try { await apiJson('/api/changes/config', { roots: cs.config.roots.filter((r) => r !== path) }, 'PUT'); } catch (_) { cs.error = 'Save failed.'; }
    await loadChangesSettings(state);
  },
  changesSavePrune: async () => {
    const state = runtime.state; const cs = state.live.changesSettings; if (!cs) return;
    // The generic data-model input handler only ever sets state.changesPruneDraft
    // when the user actually types in the textarea — clicking "Save prune list"
    // on an untouched field leaves it undefined. String(undefined || '') used to
    // silently coerce that into '', sending {prune_dirs: []} and wiping the
    // saved list even though the textarea displayed the right value. Mirror the
    // render-side fallback (changes-settings.js's `m.pruneDraft != null ? … :
    // cfg.prune_dirs`) here: only parse and send when the draft is a real
    // string; otherwise no-op rather than guess.
    if (typeof state.changesPruneDraft !== 'string') return;
    const list = state.changesPruneDraft.split('\n').map((s) => s.trim()).filter(Boolean);
    try { await apiJson('/api/changes/config', { prune_dirs: list }, 'PUT'); } catch (_) { cs.error = 'Save failed.'; }
    await loadChangesSettings(state);
  },
  changesRebuild: async () => {
    const state = runtime.state; const cs = state.live.changesSettings; if (!cs) return;
    cs.rebuild = { running: true, root: 'all roots' }; runtime.render();
    try { await apiJson('/api/changes/rebuild', {}); } catch (_) { cs.error = 'Rebuild failed or already running.'; }
    await loadChangesSettings(state);
  },

  // Settings → Projects: accept/dismiss a suggested project, or kick off a
  // fresh discovery pass. `pp.busy` blocks a double-click while accept is
  // in flight; a failed accept or dismiss sets `pp.error` (the renderer
  // shows a line for it) rather than a toast, matching the Changes actions'
  // pattern. Both clear any stale `pp.error` at the start of their own
  // attempt so a fixed error state does not linger after the next action.
  projectsAccept: async (pid) => {
    const state = runtime.state; const pp = state.live.projectProposals; if (!pp || pp.busy) return;
    pp.busy = true; pp.error = null; runtime.render();
    try {
      const rec = await apiJson(`/api/projects/proposals/${encodeURIComponent(pid)}/accept`, {}, 'POST');
      pp.proposals = pp.proposals.filter((p) => p.id !== pid);
      if (rec && rec.id) state.live.projects = [...(state.live.projects || []), rec];
    } catch (e) {
      if (e?.status === 409 || e?.status === 404) pp.proposals = pp.proposals.filter((p) => p.id !== pid);
      else pp.error = 'accept_failed';
    } finally { pp.busy = false; runtime.render(); }
  },
  // Optimistic removal, same as accept's optimistic list update: the row
  // disappears immediately. If the request fails, the removal never
  // happened server-side, so the proposal goes back into the list (append,
  // exact position does not matter) and pp.error reports it instead of
  // silently leaving the UI showing a dismiss the server never recorded.
  projectsDismiss: async (pid) => {
    const state = runtime.state; const pp = state.live.projectProposals; if (!pp || pp.busy) return;
    const removed = pp.proposals.find((p) => p.id === pid);
    pp.proposals = pp.proposals.filter((p) => p.id !== pid); pp.error = null; runtime.render();
    try { await apiJson(`/api/projects/proposals/${encodeURIComponent(pid)}/dismiss`, {}, 'POST'); }
    catch (_) {
      if (removed) pp.proposals = [...pp.proposals, removed];
      pp.error = 'dismiss_failed';
      runtime.render();
    }
  },
  projectsDiscover: async () => {
    const state = runtime.state;
    const pp = state.live.projectProposals || (state.live.projectProposals = { proposals: [], error: null, running: false, busy: false });
    if (pp.running || pp.busy) return;
    pp.running = true; pp.error = null; runtime.render();
    try { await apiJson('/api/projects/discover', {}, 'POST'); } catch (_) {}
    // Poll until the proposal file lands (discover is a background task).
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const res = await apiGet('/api/projects/proposals');
        if (res && !res.running) { pp.proposals = res.proposals || []; pp.error = res.error || null; pp.running = false; runtime.render(); return; }
      } catch (_) {}
    }
    pp.running = false; runtime.render();
  },
};
