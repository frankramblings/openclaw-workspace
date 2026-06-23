// Live data-layer loader registry. On surface activation, app.js calls
// loadSurface(name): it dynamically imports ./<name>.js, merges that module's
// `actions` into the shared action map, runs its `load(state)` to populate
// state.live[name], then re-renders. Everything degrades to the static mock in
// data.js if a module is missing or a fetch fails — the UI never breaks.

import { runtime } from './runtime.js';

// surface key -> live module filename (under live/). Surfaces not listed here
// simply keep their mock data. `companion` is loaded alongside chat.
const MODULES = {
  chat: 'chat',
  companion: 'companion',
  inbox: 'inbox',
  email: 'email',
  calendar: 'calendar',
  research: 'research',
  library: 'library',
  notes: 'notes',
  settings: 'settings',
};

const loaded = new Set();       // modules whose actions have been merged
const fetchedOnce = new Set();  // surfaces whose load() has run at least once

export async function loadSurface(name, { state, actions, render, force = false } = {}) {
  const file = MODULES[name];
  if (!file) return;
  let mod;
  try {
    mod = await import(`./${file}.js`);
  } catch (e) {
    // no live module yet (or import error) → stay on mock
    return;
  }
  if (!loaded.has(file) && mod.actions && actions) {
    Object.assign(actions, mod.actions);
    loaded.add(file);
  }
  if (mod.load && (force || !fetchedOnce.has(name))) {
    fetchedOnce.add(name);
    try {
      await mod.load(state, { force });
      render();
    } catch (e) {
      // leave mock in place; record for optional surfacing
      state.loadError = { ...(state.loadError || {}), [name]: String(e) };
      fetchedOnce.delete(name); // allow retry on next activation
    }
  }
  // chat also brings up the companion (terminal/files)
  if (name === 'chat') loadSurface('companion', { state, actions, render, force });
}

// expose for live modules that want to re-fetch (e.g. after a mutation)
export function reload(name) {
  if (!runtime.state) return;
  fetchedOnce.delete(name);
  loadSurface(name, { state: runtime.state, actions: runtime.actions, render: runtime.render, force: true });
}
