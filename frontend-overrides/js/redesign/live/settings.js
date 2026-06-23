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
import { apiGet, apiJson } from './api.js';

// state.ui toggle key -> real /api/auth/settings key. Only keys we're confident
// map to a real backend setting persist server-side; everything else stays
// local (still flips visually).
const SETTINGS_TOGGLE_MAP = {
  visionEnabled: 'vision_enabled',
  teacherEnabled: 'teacher_enabled',
  reminderLlm: 'reminder_llm_synthesis',
};

function setAccentVars(hex) {
  const s = document.documentElement.style;
  s.setProperty('--accent', hex);
  s.setProperty('--red', hex); // REAL theme accent var — makes the swatch drive the app
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
};
