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
import { apiGet, apiJson, apiDelete } from './api.js';

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

export async function load(state) {
  // 1) Accent from /api/config -> drives both --accent and --red.
  try {
    const cfg = await apiGet('/api/config');
    if (cfg && typeof cfg.accent === 'string' && cfg.accent) {
      state.accent = cfg.accent;
      setAccentVars(cfg.accent);
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
}

export const actions = {
  // Drive the REAL theme accent (--accent AND --red), re-render, persist.
  setAccent: (hex) => {
    if (!hex) return;
    runtime.state && (runtime.state.accent = hex);
    setAccentVars(hex);
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

  // Danger Zone → Wipe <kind>. Confirm first; DELETE /api/admin/wipe/{kind}.
  // kind ∈ chats|memory|skills|notes|tasks|documents|gallery|calendar.
  wipe: async (kind) => {
    if (!kind) return;
    let ok = false;
    try { ok = window.confirm(`Wipe all ${kind}? This is irreversible.`); } catch (_) { ok = false; }
    if (!ok) return;
    try { await apiDelete(`/api/admin/wipe/${kind}`); } catch (_) {}
    try { runtime.render(); } catch (_) {}
  },

  // Account → Change Password. Fields bound via data-model (pwCurrent/pwNew/pwConfirm).
  changePassword: async () => {
    const st = runtime.state;
    if (!st) return;
    const cur = (st.pwCurrent || '').trim();
    const nw = (st.pwNew || '').trim();
    const cf = (st.pwConfirm || '').trim();
    if (nw.length < 8) { try { window.alert('New password must be at least 8 characters.'); } catch (_) {} return; }
    if (nw !== cf) { try { window.alert('New password and confirmation do not match.'); } catch (_) {} return; }
    try {
      await apiJson('/api/auth/change-password', { current_password: cur, new_password: nw }, 'POST');
      st.pwCurrent = ''; st.pwNew = ''; st.pwConfirm = '';
      runtime.render();
      try { window.alert('Password updated.'); } catch (_) {}
    } catch (_) {
      try { window.alert('Could not change password — check the current password.'); } catch (_) {}
    }
  },

  // Users → Add User. Fields bound via data-model; admin from the newAdmin toggle.
  addUser: async () => {
    const st = runtime.state;
    if (!st) return;
    const username = (st.newUsername || '').trim();
    const password = (st.newPassword || '').trim();
    const is_admin = !!(st.ui && st.ui.newAdmin);
    if (!username || password.length < 8) { try { window.alert('Username and an 8-character password are required.'); } catch (_) {} return; }
    try {
      await apiJson('/api/auth/users', { username, password, is_admin }, 'POST');
      st.newUsername = ''; st.newPassword = '';
      runtime.render();
      try { window.alert('User added.'); } catch (_) {}
    } catch (_) {
      try { window.alert('Could not add user.'); } catch (_) {}
    }
  },

  // Data Backup → Export: GET /api/export, download the JSON blob.
  exportData: async () => {
    try {
      const res = await fetch(`${location.origin}/api/export`, { credentials: 'same-origin' });
      const blob = await res.blob();
      const cd = res.headers.get('content-disposition') || '';
      const m = cd.match(/filename=([^;]+)/);
      const name = m ? m[1].trim().replace(/['"]/g, '') : 'openclaw_backup.json';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 1000);
    } catch (_) { try { window.alert('Export failed.'); } catch (_) {} }
  },

  // Data Backup → Import: pick a JSON file → POST /api/import (parsed body).
  importData: () => {
    try {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.onchange = async () => {
        const f = input.files && input.files[0];
        if (!f) return;
        try {
          const data = JSON.parse(await f.text());
          await apiJson('/api/import', data);
          try { window.alert('Import complete. Reload to see your restored data.'); } catch (_) {}
        } catch (_) { try { window.alert('Import failed — not a valid backup file.'); } catch (_) {} }
      };
      input.click();
    } catch (_) {}
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
      if (r && r.ok) { try { window.alert(`Search OK — ${r.count} results via ${r.provider || 'provider'}.`); } catch (_) {} }
      else { try { window.alert(`Search test failed: ${(r && r.error) || 'unknown error'}`); } catch (_) {} }
    } catch (_) { try { window.alert('Search test request failed.'); } catch (e) {} }
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
    try { await apiJson(`/api/cron/${id}/run`, {}); } catch (_) {}
    try { window.alert('Job triggered.'); } catch (_) {}
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
};
