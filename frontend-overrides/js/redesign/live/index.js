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
const generation = new Map();   // surface -> latest load attempt's generation
const inFlight = new Map();     // surface -> the currently in-flight load's Promise
const committedLive = new Map(); // surface -> state.live[surface] value last written by a CURRENT (non-stale) load

// Fix round 1, finding 2 (task-w2a-report.md): a surface that already has
// something displayable on screen must survive a transient refresh failure —
// losing a whole populated email reader, a library grid, or the current
// month's calendar just because a background refetch hiccuped is strictly
// worse than leaving the stale (but real) data up with a "refresh failed"
// notice. hasDisplayableData() is the per-surface "is there anything worth
// keeping" check the load orchestration below uses to decide loadError
// (nothing to show — the honest empty/error partial is correct) vs a toast
// (something to show — keep it, just flag the failure).
const HAS_DATA = {
  inbox: (state) => !!state.live?.inbox?.items?.length,
  email: (state) => !!(state.live?.email?.emails?.length || state.live?.email?.current),
  calendar: (state) => !!state.live?.calendar?.cells?.length,
  research: (state) => !!state.live?.research?.past?.length,
  library: (state) => !!state.live?.library?.items?.length,
  notes: (state) => !!state.live?.notes?.docs?.length,
};
function hasDisplayableData(name, state) {
  const fn = HAS_DATA[name];
  return !!(fn && state && fn(state));
}

export async function loadSurface(name, { state, actions, render, force = false } = {}) {
  const file = MODULES[name];
  if (!file) return;
  // Register the shared Retry action once, the first time any surface is
  // loaded — NOT per-module — so a surface's error partial can always retry
  // itself even if its own live module's import never got that far (see
  // retrySurface/loadErrorBlock in surfaces.js + mobile-surfaces.js).
  if (actions && !actions.retrySurface) {
    actions.retrySurface = (surfaceName) => reload(surfaceName);
  }
  // Finding 5: flag "retrying" the instant a (re)load is decided on — BEFORE
  // the (possibly-cached-but-still-microtask-async) module import resolves —
  // so a synchronous render() right after the triggering action (see app.js's
  // click delegate: `fn(...); render();`) already paints the Retry button's
  // disabled/spinner state on the very next frame, not one tick later. This
  // is optimistic: cleared below the moment we learn there's nothing to
  // actually load (module missing, or no mod.load export).
  const willAttempt = willAttemptLoad(name, force);
  if (willAttempt && state) {
    state.retrying = state.retrying || {};
    state.retrying[name] = true;
  }
  let mod;
  try {
    mod = await import(`./${file}.js`);
  } catch (e) {
    // no live module yet (or import error) → stay on mock
    if (willAttempt && state?.retrying) delete state.retrying[name];
    return;
  }
  if (!loaded.has(file) && mod.actions && actions) {
    Object.assign(actions, mod.actions);
    loaded.add(file);
  }
  let result;
  if (mod.load && willAttempt) {
    fetchedOnce.add(name);
    // Reentrancy guard (finding 4), same pattern as document-editor's
    // makeSaveGuard: every load attempt for a surface — the initial
    // auto-load OR a later force=true retry/reload — bumps this counter and
    // captures its own value. A new attempt deliberately PREEMPTS rather
    // than dedupes onto an already-running one (calendar's rapid ‹/› clicks
    // need the LATEST click to win; hitting Retry while a hung initial load
    // is still pending should fire a genuinely fresh request, not just wait
    // on the stuck one) — whichever attempt is still "current" when it
    // resolves wins; anything that resolves after being superseded is
    // dropped untouched, so a stale failure can never clobber a newer
    // success (or vice versa).
    const myGen = (generation.get(name) || 0) + 1;
    generation.set(name, myGen);
    const isCurrent = () => generation.get(name) === myGen;

    const runLoad = (async () => {
      try {
        await mod.load(state, { force });
        if (!isCurrent()) {
          // mod.load() writes state.live[name] directly and unconditionally
          // (it has no notion of staleness) — so by the time we learn a
          // NEWER attempt has since taken over, this call may already have
          // clobbered whatever that newer attempt had (or will) commit. Undo
          // it: restore the last value a CURRENT call actually committed
          // (not just "whatever was here before THIS call started" — an
          // even-newer attempt may have already committed its own result
          // while this one was still in flight, and that's what must win).
          if (state.live) state.live[name] = committedLive.has(name) ? committedLive.get(name) : undefined;
          return { ok: false, stale: true };
        }
        committedLive.set(name, state.live ? state.live[name] : undefined);
        // Success clears any previously-recorded failure for this surface —
        // otherwise a fixed/retried load would keep showing the error
        // partial forever (loadError only ever got SET below, never
        // cleared).
        if (state.loadError && name in state.loadError) {
          const { [name]: _drop, ...rest } = state.loadError;
          state.loadError = rest;
        }
        return { ok: true };
      } catch (e) {
        if (!isCurrent()) return { ok: false, stale: true };
        fetchedOnce.delete(name); // allow retry on next activation
        if (hasDisplayableData(name, state)) {
          // Populated surface: keep the existing data up rather than
          // nuking it with the error partial — just flag the refresh
          // failure transiently. Individual live modules (e.g. calendar's
          // shiftMonth) may replace this generic message with a more
          // specific one right after.
          state.inboxToast = { msg: 'Refresh failed — showing cached data', undoTs: null };
        } else {
          state.loadError = { ...(state.loadError || {}), [name]: String(e) };
        }
        return { ok: false, error: e };
      } finally {
        if (isCurrent()) {
          if (state.retrying) delete state.retrying[name];
          inFlight.delete(name);
          render();
        }
      }
    })();
    inFlight.set(name, runLoad);
    result = await runLoad;
  } else if (willAttempt && state?.retrying) {
    delete state.retrying[name]; // nothing to actually load (no mod.load export)
  }
  // chat also brings up the companion (terminal/files) and seeds the accent/ui
  // prefs from settings — so the stored theme color applies on every page load,
  // not just when the user navigates to the Settings surface.
  if (name === 'chat') {
    loadSurface('companion', { state, actions, render, force });
    loadSurface('settings', { state, actions, render, force });
  }
  return result;
}

// Whether a call to loadSurface(name, {force}) will attempt to (re)load —
// mirrors the `force || !fetchedOnce.has(name)` gate below, computed early
// (before the module import) so the optimistic "retrying" flag above can be
// set synchronously. Doesn't know yet whether the module even exports
// load() — that's corrected once the import resolves.
function willAttemptLoad(name, force) {
  return force || !fetchedOnce.has(name);
}

// expose for live modules that want to re-fetch (e.g. after a mutation).
// Returns loadSurface's result Promise (resolving to {ok:true}, {ok:false,
// error|stale:true}, or undefined if nothing was attempted) so a caller that
// needs to react to failure specifically — e.g. calendar's shiftMonth
// rolling back a nav offset — can. Existing fire-and-forget callers are
// unaffected: they never used the return value.
export function reload(name) {
  if (!runtime.state) return;
  fetchedOnce.delete(name);
  return loadSurface(name, { state: runtime.state, actions: runtime.actions, render: runtime.render, force: true });
}
