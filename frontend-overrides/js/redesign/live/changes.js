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
export async function afterTurn(sessionId, turnId, msg, opts = {}) {
  if (!sessionId || turnId == null || !msg) return;
  const delays = opts.delays || [2500, 2000, 3000];
  for (const d of delays) {
    if (d) await sleep(d);
    let rec = null;
    try { rec = await fetchRecord(sessionId, turnId); } catch (_) { rec = null; }
    if (rec) {
      const state = runtime.state;
      const c = ensure(state, sessionId);
      c.records[rec.turn_id] = rec;
      if (rec.files && rec.files.length) msg.changes = rec;
      if (!c.turns.some((t) => t.turn_id === rec.turn_id)) c.turns.unshift({ turn_id: rec.turn_id, started_ms: rec.started_ms, ended_ms: rec.ended_ms, files: rec.files.length, added: rec.files.reduce((a, f) => a + (f.added || 0), 0), removed: rec.files.reduce((a, f) => a + (f.removed || 0), 0), shared: rec.files.some((f) => f.shared) });
      runtime.render();
      return;
    }
  }
}

export async function attachHistory(state, sessionId, thread) {
  if (!sessionId || !Array.isArray(thread)) return;
  const c = ensure(state, sessionId);
  let turns = [];
  try { const r = await apiGet(`/api/changes/session?session=${encodeURIComponent(sessionId)}`); turns = (r && r.turns) || []; c.error = null; } catch (e) { c.error = 'network'; return; }
  c.turns = turns.filter((t) => t.files > 0);
  const map = attachChangesToThread(thread, c.turns);
  for (const [msgId, t] of map) {
    const m = thread.find((x) => x.id === msgId);
    if (!m) continue;
    let rec = c.records[t.turn_id];
    if (!rec) { try { rec = await fetchRecord(sessionId, t.turn_id); } catch (_) { rec = null; } }
    if (rec) { c.records[t.turn_id] = rec; m.changes = rec; }
  }
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
  if (!rec) { rec = await fetchRecord(sid, turnId); if (rec) c.records[turnId] = rec; }
  c.open = { turn: Number(turnId), record: rec, path: path || null, diff: null };
  state.compTab = 'changes'; state.compSplit = false; state.compHidden = false;
  try {
    if (globalThis.matchMedia && matchMedia('(max-width: 1024px)').matches) {
      state.companionTab = 'changes'; state.companionSheetOpen = true; state.companionSheetClosing = false;
    }
  } catch (_) { /* no matchMedia in the test environment */ }
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
    if (typeof globalThis.confirm === 'function' && !globalThis.confirm(`Revert ${path} to how it was before this turn?`)) return;
    const state = runtime.state; const sid = state.live.chat.activeId;
    try {
      await apiJson('/api/changes/revert', { session: sid, turn, path });
      const c = ensure(state, sid);
      delete c.records[turn];
      await openPath(turn, path);
      await attachHistory(state, sid, state.live.chat.thread || []);
    } catch (e) {
      const msg = /409/.test(String(e && e.message)) ? 'The file changed since this turn. Nothing was reverted.' : 'Revert failed.';
      if (runtime.actions && runtime.actions.toast) runtime.actions.toast(msg); else console.warn(msg);
    }
  },
};
