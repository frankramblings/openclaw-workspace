// Per-turn change review: fetches records for the active chat, attaches them
// to assistant messages (live via afterTurn, history via attachHistory), and
// drives the companion "Changes" tab + revert. Rendering is in changes-view.js.
import { apiGet, apiJson } from './api.js';
import { runtime } from './runtime.js';
import { attachChangesToThread } from '../changes-view.js';

function ensure(state, sessionId) {
  state.live = state.live || {};
  const c = state.live.changes;
  if (!c || (sessionId && c.sessionId !== sessionId)) {
    state.live.changes = { sessionId: sessionId || (c && c.sessionId) || null, turns: [], records: {}, expanded: new Set(), open: null, loading: false, error: null };
  }
  return state.live.changes;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRecord(sessionId, turnId) {
  const r = await apiGet(`/api/changes/turn?session=${encodeURIComponent(sessionId)}&turn=${encodeURIComponent(turnId)}`);
  return r && r.ok ? r.record : null;
}

// After `done`: the server closes the window ~1.5 s later, so poll a few times.
// Fix round 1, finding 1: this runs 2.5-7.5 s after `done`, which is plenty of
// time for the user to have switched to another thread. `msg` is the SAME
// object that's already in whatever thread array holds it (or none, if the
// user navigated away entirely), so setting msg.changes is always safe, but
// state.live.changes belongs to whichever session is ACTIVE right now, and
// must never be clobbered with a stale, no-longer-active session's turn.
export async function afterTurn(sessionId, turnId, msg, opts = {}) {
  if (!sessionId || turnId == null || !msg) return;
  const delays = opts.delays || [2500, 2000, 3000];
  for (const d of delays) {
    if (d) await sleep(d);
    let rec = null;
    try { rec = await fetchRecord(sessionId, turnId); } catch (_) { rec = null; }
    if (rec) {
      // Most turns change nothing. A zero-file record renders no card, and
      // attachHistory filters files > 0, so inserting one here would fill the
      // companion list with "Turn N, 0 files" rows until the next refresh.
      if (!rec.files || !rec.files.length) return;
      msg.changes = rec;
      const state = runtime.state;
      const activeId = state && state.live && state.live.chat && state.live.chat.activeId;
      if (activeId === sessionId) {
        const c = ensure(state, sessionId);
        c.records[rec.turn_id] = rec;
        if (!c.turns.some((t) => t.turn_id === rec.turn_id)) c.turns.unshift({ turn_id: rec.turn_id, started_ms: rec.started_ms, ended_ms: rec.ended_ms, files: rec.files.length, added: rec.files.reduce((a, f) => a + (f.added || 0), 0), removed: rec.files.reduce((a, f) => a + (f.removed || 0), 0), shared: rec.files.some((f) => f.shared) });
        runtime.render();
      }
      return;
    }
  }
}

// Fix round 1, finding 4: fetch every missing record concurrently (was one
// await per turn, serially). This runs on every thread open, selectSession,
// and manual refresh.
export async function attachHistory(state, sessionId, thread) {
  if (!sessionId || !Array.isArray(thread)) return;
  const c = ensure(state, sessionId);
  let turns = [];
  try { const r = await apiGet(`/api/changes/session?session=${encodeURIComponent(sessionId)}`); turns = (r && r.turns) || []; c.error = null; } catch (e) { c.error = 'network'; return; }
  c.turns = turns.filter((t) => t.files > 0);
  const map = attachChangesToThread(thread, c.turns);
  await Promise.all(Array.from(map.entries()).map(async ([msgId, t]) => {
    let rec = c.records[t.turn_id];
    if (!rec) {
      try { rec = await fetchRecord(sessionId, t.turn_id); } catch (_) { rec = null; }
      if (rec) c.records[t.turn_id] = rec;
    }
    if (!rec) return;
    const m = thread.find((x) => x.id === msgId);
    if (m) m.changes = rec;
  }));
  runtime.render();
}

export async function load(state) {
  const sid = state.live && state.live.chat && state.live.chat.activeId;
  ensure(state, sid);
}

async function openPath(turnId, path) {
  const state = runtime.state;
  const sid = state.live.chat.activeId;
  const c = ensure(state, sid);
  let rec = c.records[turnId];
  if (!rec) {
    // Fix round 1, finding 3: changesOpen/changesTurn dispatch this
    // fire-and-forget (data-act handlers aren't awaited), an unguarded
    // throw here became an unhandled rejection with no visible error state.
    try {
      rec = await fetchRecord(sid, turnId);
      if (rec) c.records[turnId] = rec;
    } catch (e) {
      c.error = (e && e.status) || 'network';
      runtime.render();
      return;
    }
  }
  c.error = null;
  c.open = { turn: Number(turnId), record: rec, path: path || null, diff: null };
  state.compTab = 'changes'; state.compSplit = false; state.compHidden = false;
  // Read the shell class app.js latches at boot, not a media query of our own:
  // a 1024 px query disagrees with the app's 768 px latch, so between 769 and
  // 1024 px the desktop path was also opening the mobile sheet. Same pattern
  // as live/email.js.
  try {
    if (globalThis.document && document.documentElement.classList.contains('shell-mobile')) {
      state.companionTab = 'changes'; state.companionSheetOpen = true; state.companionSheetClosing = false;
    }
  } catch (_) { /* no document in the test environment */ }
  if (path) {
    try { c.open.diff = await apiGet(`/api/changes/diff?session=${encodeURIComponent(sid)}&turn=${encodeURIComponent(turnId)}&path=${encodeURIComponent(path)}`); }
    catch (_) { c.open.diff = { diffable: false, text: '' }; }
  }
  runtime.render();
}

export const actions = {
  changesToggle: (turnId) => {
    const c = ensure(runtime.state);
    const id = Number(turnId);
    if (c.expanded.has(id)) c.expanded.delete(id); else c.expanded.add(id);
  },
  changesOpen: async (arg) => {
    const i = String(arg).indexOf(':');
    const turn = Number(String(arg).slice(0, i)); const path = String(arg).slice(i + 1);
    await openPath(turn, path);
  },
  changesTurn: async (turnId) => { await openPath(Number(turnId), null); },
  changesRefresh: async () => {
    const state = runtime.state; const sid = state.live.chat.activeId;
    const c = ensure(state, sid); c.loading = true; runtime.render();
    try { await attachHistory(state, sid, state.live.chat.thread || []); } finally { c.loading = false; runtime.render(); }
  },
  changesCopy: async () => {
    const c = ensure(runtime.state);
    const text = c.open && c.open.diff && c.open.diff.text;
    if (text && globalThis.navigator && navigator.clipboard) { try { await navigator.clipboard.writeText(text); } catch (_) {} }
  },
  changesRevert: async (arg) => {
    const i = String(arg).indexOf(':');
    const turn = Number(String(arg).slice(0, i)); const path = String(arg).slice(i + 1);
    // Capture the session BEFORE the confirm dialog: the revert must target
    // the thread the user was looking at when they clicked.
    const state = runtime.state; const sid = state.live.chat.activeId;
    if (typeof globalThis.confirm === 'function' && !globalThis.confirm(`Revert ${path} to how it was before this turn?`)) return;
    // Fix round 1, finding 2: only the actual revert POST belongs in this
    // try: a refresh fetch failing AFTER a successful revert must never
    // read back as "Revert failed."
    try {
      await apiJson('/api/changes/revert', { session: sid, turn, path });
    } catch (e) {
      // apiJson throws ApiError, which carries the HTTP status; match on that
      // rather than regexing the message text.
      const msg = (e && e.status) === 409 ? 'The file changed since this turn. Nothing was reverted.' : 'Revert failed.';
      if (runtime.actions && runtime.actions.toast) runtime.actions.toast(msg); else console.warn(msg);
      return;
    }
    if (runtime.actions && runtime.actions.toast) runtime.actions.toast(`Reverted ${path}`);
    // Best-effort refresh: openPath already refetches this exact record (and
    // now handles its own fetch failures, finding 3), so reuse it instead of
    // a second full attachHistory pass (finding 4). Propagate the refreshed
    // record onto the matching c.turns row and the thread bubble that
    // already carries this turn's card, so both pick up e.g. "reverted".
    // The confirm dialog can sit open long enough for a thread switch, and
    // openPath reads the CURRENT activeId. Same guard afterTurn uses.
    if (state.live.chat.activeId !== sid) return;
    try {
      const c = ensure(state, sid);
      delete c.records[turn];
      await openPath(turn, path);
      const rec = c.records[turn];
      if (rec) {
        const ti = c.turns.findIndex((t) => t.turn_id === turn);
        if (ti !== -1) {
          c.turns[ti] = {
            ...c.turns[ti],
            files: rec.files.length,
            added: rec.files.reduce((a, f) => a + (f.added || 0), 0),
            removed: rec.files.reduce((a, f) => a + (f.removed || 0), 0),
            shared: rec.files.some((f) => f.shared),
          };
        }
        const thread = state.live.chat.thread || [];
        const tm = thread.find((x) => x.changes && x.changes.turn_id === turn);
        if (tm) tm.changes = rec;
        runtime.render();
      }
    } catch (_) { /* refresh is best-effort */ }
  },
};
