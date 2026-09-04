// Live wiring for the CHAT surface. Populates state.live.chat in the mock's
// shape (see surfaces.js renderChatList / chatSurface). Fails soft: if the
// session list can't be fetched, load() throws and the render keeps the mock.
//
// Shape produced:
//   state.live.chat = {
//     activeId,
//     groups: [{ label:'TODAY'|'YESTERDAY'|'EARLIER', rows:[{id,title,term,active}] }],
//     title, subtitle, model, usagePct, cwd,
//     thread: [{ role:'assistant'|'user', time, model?, text }]
//   }

import { runtime } from './runtime.js';
import { apiGet, apiForm, apiJson, apiDelete, postStream } from './api.js';
import { renderMarkdown } from '../markdown.js';
import { AVATAR } from '../data.js';
import { reconcileDecision } from './reconcile-decision.js';
import { droppedTurnAction } from './dropped-turn-decision.js';
import { parseQuestionCard, composeAnswer } from './question-card.js';
import { promiseWarningText, latestAsstAtOrBefore } from './promise-warning.js';
import { setLiveTurn } from './turn-ref.js';
import { beginUploads, resolveUploads, failUploads, sendableAttach, uploadGate } from './attach-logic.js';
import { buildSuggestContext, activitySummary, suggestSurvivesReattach } from './suggest-core.js';
import { suggestGhost } from '../suggest-ghost.js';
import { busySendMode, steerFallback } from './steer-logic.js';
import {
  saveDraft, restoreDraft, dropDraft, loadDrafts, persistDrafts,
  scrollSnapshot, scrollDecision, pushMru, loadMru, persistMru,
} from './thread-switch.js';
import { chatHash } from '../routes.js';
import {
  initStripState, stripReducer, onTurnDone as stripOnTurnDone,
  onUserSend as stripOnUserSend, onSessionSwitch as stripOnSessionSwitch,
  toggleCollapsed as stripToggleCollapsed, readCollapsed as stripReadCollapsed,
  sweepAgents as stripSweepAgents, renderChatStrip,
} from '../chat-strip.js';
import { buildSwitcherSections, flatRows, clampSel } from '../switcher.js';
import { buildThreadGroups } from '../thread-groups.js';
import { afterTurn as changesAfterTurn, attachHistory as changesAttachHistory } from './changes.js';
import { parseMoveArg, MOVE_NEW, MOVE_NONE } from '../project-menu.js';
import { activeLibraryDocId, consumeAttachDetach, getSelection, applyExternalUpdate, flushBeforeSend, flushOk } from './document-editor.js';

// The throttled per-token render only patches the active message bubble in
// place — it does NOT re-render `.composer-wrap`, which is where the strip
// lives. So each reducer mutation needs its own targeted DOM patch or nothing
// visible changes until the next full render (which may never come during a
// long tool-heavy turn). This finds the existing `.chat-strip` and swaps its
// outerHTML for the freshly-rendered version; if none exists yet (idle → first
// tool event), it inserts the new one at the top of `.composer-wrap`. Empty
// strip → remove the node entirely so nothing lingers when idle.
function patchChatStrip(chat) {
  if (!chat) return;
  persistStripToServer(chat.activeId, chat.chatStrip);
  try {
    // Desktop: .composer-wrap (strip is first child, above .composer).
    // Mobile: .m-composer (strip is first child, above .bar).
    const wrap = document.querySelector('.composer-wrap') || document.querySelector('.m-composer');
    if (!wrap) return;
    const html = renderChatStrip(chat.chatStrip, { renderMarkdown });
    const existing = wrap.querySelector(':scope > .chat-strip');
    if (!html) { if (existing) existing.remove(); return; }
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const fresh = tmp.firstElementChild;
    if (!fresh) { if (existing) existing.remove(); return; }
    if (existing) existing.replaceWith(fresh);
    else wrap.insertBefore(fresh, wrap.firstChild);
  } catch (_) { /* fall back to next full render */ }
}

// ---- helpers --------------------------------------------------------------

// Which conversation to reopen after a page reload. Without this the loader
// falls back to list[0] (the most-recently-touched session), so a refresh
// silently swapped you onto a different chat — the thread you were reading
// looked like it had vanished.
const ACTIVE_KEY = 'redesign.chat.activeId';
function storeActiveId(id) {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch (_) { /* storage disabled → just lose the restore */ }
}
function readActiveId() {
  try { return localStorage.getItem(ACTIVE_KEY) || null; } catch (_) { return null; }
}

// Model identity = endpoint·model. The separator (middle dot) is absent from
// endpoint ids and model names, so a plain split round-trips cleanly.
const MODEL_SEP = '·';
// Prettify a backend endpoint name for a group header: "Claude-Cli" → "Claude
// CLI", "Perplexity-Web" → "Perplexity", "ChatGPT" → "ChatGPT".
function prettyEndpoint(name) {
  return String(name || '').replace(/-web$/i, '').replace(/-cli$/i, ' CLI').replace(/-/g, ' ').trim();
}
// Strip the endpoint suffix the API bakes into model_display so rows carry only
// the bare name: "Claude Opus 4.8 (Claude CLI)" → "Claude Opus 4.8";
// "Claude Sonnet 4.6 via Perplexity (chat only)" → "Claude Sonnet 4.6".
function bareModelName(display) {
  const s = String(display || '');
  return s.replace(/\s+via\s+.*$/i, '').replace(/\s*\([^)]*\)\s*$/, '').trim() || s;
}

// Monotonic per-message suffix. Date.now() alone collides when two messages
// are minted within the same millisecond (a queued message auto-firing right
// behind a fresh beginTurn, or two optimistic bubbles from rapid sends) — a
// silent id collision means the OLDER message stops being independently
// addressable (thread.find(id===…) style lookups, DOM patch targeting, and
// _pendingByTurnId all key off this string). Exported pure for tests.
let _msgSeq = 0;
export function uniqId(prefix) { return `${prefix}${Date.now()}-${++_msgSeq}`; }

function fmtTime(ts) {
  if (ts == null) return '';
  const d = new Date(typeof ts === 'number' ? ts : Number(ts) || Date.parse(ts));
  if (isNaN(d.getTime())) return '';
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ap}`;
}

const EXPANDED_KEY = 'oc-proj-expanded';
function _loadExpanded() {
  try { const arr = JSON.parse(localStorage.getItem(EXPANDED_KEY) || '[]'); return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []); }
  catch (_) { return new Set(); }
}
function _persistExpanded(set) {
  try { localStorage.setItem(EXPANDED_KEY, JSON.stringify([...set])); } catch (_) { /* storage unavailable */ }
}

// Rebuild the sidebar/drawer sections from the raw session list plus the live
// sets (running turns, finished-while-away, queued sends). Cheap enough to run
// on every notifier tick; the renderers read chat.groups as before.
function rebuildGroups(chat, activeId) {
  const state = runtime.state;
  // F1: overlay the local OPEN-shelf stamp (chat.openedLocal) on top of
  // whatever chat.sessions currently says, without mutating the records
  // themselves. Keeps a brand-new thread on the shelf through a sessions
  // refetch that raced the server's own mark_opened.
  const overlay = chat.openedLocal;
  const sessionsWithOverlay = (chat.sessions || []).map((s) => {
    const l = overlay && overlay.get(s.id);
    return l && l > (s.opened || 0) ? { ...s, opened: l } : s;
  });
  chat.groups = buildThreadGroups({
    sessions: sessionsWithOverlay,
    projects: (state && state.live && state.live.projects) || [],
    running: chat.activeTurns || new Set(),
    notified: chat.notified || new Set(),
    queued: new Set((chat.queuedList || []).map((q) => q.sid)),
    now: Date.now(),
    activeId: activeId === undefined ? chat.activeId : activeId,
    expanded: chat.expandedProjects || new Set(),
  });
}

function round1(n) {
  if (n == null || isNaN(n)) return null;
  return Math.round(n * 10) / 10;
}

// One pending timer per chat is enough — the next-earliest clearAt wins.
function scheduleStripSweep(chat) {
  if (!chat || !chat.chatStrip) return;
  const now = Date.now();
  let earliest = Infinity;
  for (const id in chat.chatStrip.agents) {
    const a = chat.chatStrip.agents[id];
    if (a.clearAt != null && a.clearAt < earliest) earliest = a.clearAt;
  }
  if (!Number.isFinite(earliest)) return;
  const delay = Math.max(0, earliest - now) + 50;
  if (chat._stripSweepTimer) clearTimeout(chat._stripSweepTimer);
  chat._stripSweepTimer = setTimeout(() => {
    chat._stripSweepTimer = null;
    const before = chat.chatStrip;
    chat.chatStrip = stripSweepAgents(chat.chatStrip, Date.now());
    if (chat.chatStrip !== before) runtime.render();
    scheduleStripSweep(chat);
  }, delay);
}

// Persist per-thread drafts. Called only on a thread switch, a new chat, or
// a send, never per keystroke, so a synchronous write is fine and avoids a
// module-level timer (which node:test mock.timers sessions cannot share).
function _persistDraftsNow(chat) {
  try { persistDrafts(chat.drafts, window.localStorage); } catch (_) { /* storage unavailable */ }
}

// Leaving a thread (switch or new chat): remember its scroll position and
// stash whatever is in the composer under its id so it is back when you return.
function _leaveThread(chat, state) {
  const prev = chat.activeId;
  if (!prev) return;
  try {
    const el = document.querySelector('.chat-thread, .m-thread');
    if (el) chat.scroll[prev] = scrollSnapshot(el.scrollTop, el.scrollHeight, el.clientHeight);
  } catch (_) { /* no DOM */ }
  chat.drafts = saveDraft(chat.drafts, prev, state.draft);
  _persistDraftsNow(chat);
}

function _setHash(h) {
  try { if (location.hash !== h) history.replaceState(history.state, '', h); } catch (_) { /* no history API */ }
}

// Projects (spec 6.2, 7.6): mirror the active session's filing/parentage onto
// chat so the header (project pill, "forked from" link) and the move-menu's
// current-selection check can read it synchronously, without re-deriving it
// from chat.sessions on every render.
function _mirrorSessionMeta(chat, id) {
  const rec = (chat.sessions || []).find((s) => s.id === id);
  chat.folder = rec ? (rec.folder || null) : null;
  chat.parentId = rec ? (rec.parent_id || null) : null;
}

// Shared by archiveProject/unarchiveProject: optimistic flip + PATCH, revert
// + toast on failure. Archiving hides a project's threads from the sidebar
// (thread-groups.js) without touching the threads themselves.
async function _setProjectArchived(pid, archived) {
  const state = runtime.state; if (!state || !pid) return;
  const chat = ensureChat(state);
  chat.projMenuOpen = null;
  const p = (state.live.projects || []).find((x) => x.id === pid);
  if (!p) return;
  const prev = !!p.archived;
  p.archived = archived;
  rebuildGroups(chat);
  runtime.render();
  try { await apiJson(`/api/projects/${encodeURIComponent(pid)}`, { archived }, 'PATCH'); }
  catch (_) { p.archived = prev; rebuildGroups(chat); runtime.render(); toast('Couldn’t update the project.'); }
}

function ensureChat(state) {
  if (!state.live) state.live = {};
  if (!state.live.chat) state.live.chat = {};
  if (!state.live.chat.chatStrip) {
    state.live.chat.chatStrip = initStripState();
    try { state.live.chat.chatStrip.collapsed = stripReadCollapsed(window.localStorage); } catch (_) {}
  }
  if (!state.live.chat.chatStripByKey) state.live.chat.chatStripByKey = {};
  if (!Array.isArray(state.live.chat.queuedList)) state.live.chat.queuedList = [];
  const c = state.live.chat;
  if (!c.drafts) { try { c.drafts = loadDrafts(window.localStorage); } catch (_) { c.drafts = {}; } }
  if (!Array.isArray(c.mru)) { try { c.mru = loadMru(window.localStorage); } catch (_) { c.mru = []; } }
  if (!c.scroll) c.scroll = {};
  if (!Array.isArray(c.sessions)) c.sessions = [];
  if (!(c.expandedProjects instanceof Set)) c.expandedProjects = _loadExpanded();
  // F1: optimistic OPEN-shelf overlay (session id -> epoch ms), keyed
  // independently of chat.sessions so a brand-new chat's very first send
  // survives a stale /api/sessions refetch landing before the server has
  // processed the real POST's mark_opened. See submitFromComposer,
  // rebuildGroups, _pruneOpenedLocal, and closeOpen.
  if (!(c.openedLocal instanceof Map)) c.openedLocal = new Map();
  return state.live.chat;
}

// F1: drop a session's local overlay stamp once a fresh /api/sessions fetch
// shows the server has caught up (a numeric `opened`) -- otherwise a later
// close from another device would never take effect on this tab. Called
// right after every place chat.sessions is reassigned from a fetch. Exported
// for __tests__/open-shelf.test.js.
export function _pruneOpenedLocal(chat) {
  if (!chat || !(chat.openedLocal instanceof Map) || !chat.openedLocal.size) return;
  const list = chat.sessions || [];
  for (const id of [...chat.openedLocal.keys()]) {
    const rec = list.find((s) => s.id === id);
    if (rec && rec.opened != null) chat.openedLocal.delete(id);
  }
}

// Task 0b: preserve the strip across thread switches so background TaskCreate
// items (subagents, followups, cron) stay visible when the user peeks at another
// thread and returns. Keyed by session id; new-chat strips (no id yet) don't
// persist. B-tier fix (server-side per-turn persistence) tracked separately.
function saveStripForCurrent(chat) {
  if (!chat || !chat.chatStripByKey) return;
  const key = chat.activeId;
  if (!key) return;
  if (chat.chatStrip) chat.chatStripByKey[key] = chat.chatStrip;
}
function loadStripForKey(chat, id) {
  const cached = id && chat.chatStripByKey ? chat.chatStripByKey[id] : null;
  if (cached) return cached;
  const fresh = initStripState();
  try { fresh.collapsed = stripReadCollapsed(window.localStorage); } catch (_) {}
  return fresh;
}

// Fetch + map history into a thread; returns { thread, title?, subtitle, model }.
// Rebuild the Cowork-style activity trail from a turn's saved tool_events
// (backend _map_history). Skips the agent's `message` reply-delivery tool — parity
// with the live relay, which hides its card — so reload matches the live view.
// Exported for __tests__ (rider task-w6: history/live tool_output cap parity)
// — otherwise only reachable through fetchThread()'s /api/history/:id fetch.
export function historySteps(toolEvents, msgIdx) {
  if (!Array.isArray(toolEvents)) return [];
  const steps = [];
  toolEvents.forEach((ev, i) => {
    const name = String(ev.tool || '');
    if (/^(message|mcp__openclaw__message)$/i.test(name)) return;
    if (name === 'AskUserQuestion') return; // rendered as a card, not a tool step
    const kind = toolKind(name);
    const failed = ev.exit_code != null && ev.exit_code !== 0;
    const rawLines = String(ev.output || '').split('\n').filter((l) => l.length);
    // Rider (task-w6): keep the TAIL (most recent output), same ceiling and
    // same end as the live tool_output path below — this used to head-keep
    // (slice(0, 200), oldest 200 lines) while live tail-keeps, so reloading a
    // long-running step's history flipped which lines were visible. omitted
    // is surfaced as a "…N earlier lines omitted" line by chat-activity.js's
    // codeBlock().
    const omitted = Math.max(0, rawLines.length - 200);
    const lines = rawLines.slice(-200).map((t) => ({ t, c: lineColor(t) }));
    steps.push({
      id: `h${msgIdx}-s${i}`,
      kind,
      round: ev.round || 1,
      label: PAST[kind] || 'Ran',
      file: ev.command || '',
      meta: failed ? `exit ${ev.exit_code}` : '',
      metaColor: failed ? 'var(--red)' : undefined,
      state: failed ? 'error' : 'done',
      lines,
      ...(omitted ? { omitted } : {}),
    });
  });
  return steps;
}

// Adjacent user bubbles with identical text = the "network hiccup dupe":
// server recorded the same POST twice (keepalive pagehide + buffered flush
// racing) or the client posted twice. Server-truth thread is authoritative
// but not always deduped. Collapse and warn so a real double still surfaces
// in the console for root-causing, but never as a visible duplicate bubble.
function dedupeAdjacentUserMessages(thread, source) {
  if (!Array.isArray(thread) || thread.length < 2) return thread;
  const out = [];
  let dropped = 0;
  for (const m of thread) {
    const prev = out[out.length - 1];
    if (m && prev && m.role === 'user' && prev.role === 'user'
        && (m.text || '') === (prev.text || '')
        && (m.text || '').length > 0) {
      dropped++;
      continue;
    }
    out.push(m);
  }
  if (dropped) {
    try { console.warn(`[chat] deduped ${dropped} adjacent user message(s) at ${source}`); } catch (_) {}
  }
  return out;
}

async function fetchThread(id, fallbackModel, name) {
  const hist = await apiGet(`/api/history/${id}?limit=100`);
  const list = Array.isArray(hist?.history) ? hist.history : [];
  const model = hist?.model || fallbackModel || '';
  // Answered-card lock state for this session (backend/question_cards.py
  // sidecar) — applied below when attaching msg.questionCard from tool_events.
  __setQuestionAnswers(hist && hist.question_answers);
  const thread = list.map((h, i) => {
    const meta = h?.metadata || {};
    const msg = {
      id: `h${i}`,
      role: h.role === 'user' ? 'user' : 'assistant',
      text: h.content || '',
      time: fmtTime(meta.timestamp),
      model: meta.model || model,
      usage: (meta.usage && typeof meta.usage === 'object') ? meta.usage : null,
      // Providers report usage differently (claude-cli stamps a placeholder
      // output) — the renderers need to know which one produced this message.
      provider: meta.provider || null,
      costTotal: (typeof meta.cost === 'number') ? meta.cost : null,
    };
    // Backend rewrites machinery user-messages (followup seeds, injected
    // session-continuation seeds — see backend/syschatter.py) to a compact ⚙️
    // line; render any of them as a centered system card, not a "You" bubble
    // (surfaces.js chatMsg / mobile-surfaces.js mChatMsg).
    if (msg.role === 'user' && /^⚙️ /.test(msg.text)) msg.sys = true;
    const q = (meta.tool_events || []).find((e) => e.tool === 'AskUserQuestion');
    if (q) {
      const qc = buildQuestionCardModel({ tool: 'AskUserQuestion', tool_id: q.tool_id, input: q.input });
      if (qc) {
        msg.questionCard = qc;
        if (isQuestionLocked(qc.toolId)) { qc.locked = true; qc.choice = lockedChoice(qc.toolId); }
      }
    }
    // Image attachments persisted by the backend sidecar (the gateway transcript
    // only keeps text) → rehydrate so sent images survive a refresh.
    if (Array.isArray(h.attachments) && h.attachments.length) {
      msg.attach = h.attachments.map((a) => ({ id: a.id, name: a.name || a.id, url: a.url }));
    }
    if (msg.role === 'assistant') {
      // Preserve raw epoch-ms timestamp for pending-work hydration matching.
      if (meta.timestamp != null) msg._ts = Number(meta.timestamp);
      const steps = historySteps(meta.tool_events, i);
      if (steps.length) {
        // The final answer is the LAST non-empty round (backend `content` is the
        // first); render it below the trail, like the live multi-round view.
        const rawRts = Array.isArray(meta.round_texts) ? meta.round_texts : [];
        const rts = rawRts.filter((t) => t && t.trim());
        if (rts.length) msg.text = rts[rts.length - 1];
        // Keep the full (unfiltered) round array for interleaved rendering in
        // chatMsg — indices must line up with tool_event round numbers.
        if (rawRts.length > 1) msg.round_texts = rawRts;
        msg.activity = {
          status: 'done',
          worked: `Worked · ${steps.length} step${steps.length === 1 ? '' : 's'}`,
          steps,
        };
      }
    }
    return msg;
  });
  // A question card the user never answered but then moved past (sent another
  // message anyway) is superseded — lock it with an empty choice so it renders
  // dismissed rather than still-tappable on reload.
  for (let i = 0; i < thread.length; i++) {
    const mc = thread[i].questionCard;
    if (mc && !mc.locked && thread.slice(i + 1).some((x) => x.role === 'user')) {
      mc.locked = true; mc.choice = mc.choice || '';
    }
  }
  return {
    thread,
    title: name,
    subtitle: `${list.length} messages · ${model}`,
    model,
  };
}

// One GET of a session's usage row. Returns the WHOLE payload (not just the
// context pct) so the turn-done path can reuse this exact response instead of
// firing a second identical GET a moment later — see refreshSidebarUsage.
async function fetchUsage(id) {
  try {
    const u = await apiGet(`/api/sessions/${id}/usage`);
    if (!u || !u.ok) return null;
    const chat = ensureChat(runtime.state || {});
    if (id === chat.activeId) {
      chat.sessionUsage = {
        totals: u.totals || null,
        costed: !!u.costed,
        usedPct: round1(u?.context?.usedPct),
        provider: u.modelProvider || null,
      };
    }
    return u;
  } catch (_) {
    return null;
  }
}

const usagePctOf = (u) => round1(u?.context?.usedPct);

// Right after a turn the gateway's cost cache for the transcript is often
// still refreshing, so the usage row comes back empty (backend marks it
// `pending`). Retry ONCE after this delay; the refresh is sub-second for small
// transcripts. Overridable from tests via __setUsageRetryMs.
let USAGE_RETRY_MS = 2000;
export function __setUsageRetryMs(ms) { USAGE_RETRY_MS = Number(ms) || 0; }

// Apply a session usage payload to the just-finished assistant bubble (and to
// the header pill when that session is still the one on screen). When the row
// is not ready yet, schedule exactly one delayed retry.
function applySessionUsage(u, target, forSessionId, allowRetry) {
  const chatNow = ensureChat(runtime.state || {});
  if (u && u.ok) {
    if (forSessionId === chatNow.activeId) {
      chatNow.sessionUsage = {
        totals: u.totals || null,
        costed: !!u.costed,
        usedPct: u.context && u.context.usedPct,
        provider: u.modelProvider || null,
      };
    }
    const t = u.totals;
    if (!target.usage && t && (Number(t.output) > 0 || Number(t.totalTokens) > 0)) {
      target.usage = {
        input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite,
        _session: true, _provider: u.modelProvider || null,
      };
    }
    throttledRender();
  }
  if (!allowRetry) return;
  const notReady = !u || !u.ok || u.pending || Number(u.totals?.totalTokens) === 0;
  if (!notReady) return;
  setTimeout(() => {
    const chatLater = ensureChat(runtime.state || {});
    // Only retry while this session is still on screen, and never once a NEWER
    // turn is running for it (that turn owns the usage row now).
    if (forSessionId !== chatLater.activeId) return;
    if (turn && turn.sessionId === forSessionId) return;
    apiGet(`/api/sessions/${encodeURIComponent(forSessionId)}/usage`)
      .then((u2) => applySessionUsage(u2, target, forSessionId, false))
      .catch(() => {});
  }, USAGE_RETRY_MS);
}

// Hydrate resolved update_blocks from the server into thread messages so
// generated images etc. survive a session-switch or page refresh.
//
// Calls /api/pending/hydrate for the session (no turn_ids — returns all turns
// with any stored data). For each turn's update_blocks, finds the best-matching
// assistant message by _ts proximity to spawned_at, then populates
// msg.updateBlocks so the render path shows the resolved content.
//
// Only runs for sessions with _ts on at least one assistant message (requires
// the server to have emitted metadata.timestamp for the turn). Non-fatal.
async function hydrateThread(sessionId, thread) {
  if (!sessionId || !Array.isArray(thread)) return;
  let hydration;
  try {
    hydration = await apiGet(`/api/pending/hydrate?session=${encodeURIComponent(sessionId)}`);
  } catch (_) { return; }
  if (!hydration || typeof hydration !== 'object') return;

  // Collect turns that have update_blocks to apply.
  const turns = Object.entries(hydration)
    .map(([tid, d]) => ({
      turnId: Number(tid),
      updateBlocks: Array.isArray(d.update_blocks) ? d.update_blocks : [],
      pendingTokens: Array.isArray(d.pending_tokens) ? d.pending_tokens : [],
    }))
    .filter((t) => t.updateBlocks.length > 0 || t.pendingTokens.length > 0);

  if (!turns.length) return;

  // Build a list of assistant messages with raw timestamps for matching.
  const asstMsgs = thread.filter((m) => m.role === 'assistant' && m._ts != null);
  if (!asstMsgs.length) return;

  // For each turn, pick the best-matching assistant message: the one whose
  // _ts is closest to (but ≤) the first update_block's spawned_at epoch-ms.
  // Falls back to the last assistant message if no timestamp proximity works.
  for (const t of turns) {
    if (!t.updateBlocks.length) continue;
    const spawnedIso = t.updateBlocks[0].spawned_at;
    const spawnedMs = spawnedIso ? Date.parse(spawnedIso) : NaN;
    let best = asstMsgs[asstMsgs.length - 1];
    if (!isNaN(spawnedMs)) {
      // Latest assistant message whose _ts ≤ spawned_at (the turn that owned this work).
      for (const m of asstMsgs) {
        if (m._ts <= spawnedMs) best = m;
      }
    }
    if (!best.updateBlocks || !best.updateBlocks.length) {
      best.updateBlocks = t.updateBlocks.map((b) => ({ payload: b.payload || {}, elapsed_ms: b.elapsed_ms || 0 }));
    }
  }
}

// Re-attach persisted empty-promise warnings after a reload (the live
// promise_warning frame only reaches clients attached to the stream).
async function hydrateWarnings(sessionId, thread) {
  if (!sessionId || !Array.isArray(thread)) return;
  let res;
  try {
    res = await apiGet(`/api/promise/warnings?session=${encodeURIComponent(sessionId)}`);
  } catch (_) { return; }
  const warnings = (res && Array.isArray(res.warnings)) ? res.warnings : [];
  if (!warnings.length) return;
  const asstMsgs = thread.filter((m) => m.role === 'assistant' && m._ts != null);
  for (const w of warnings) {
    const best = latestAsstAtOrBefore(asstMsgs, w.ts);
    if (best && !best.warnNotice && !best.error) {
      best.warnNotice = promiseWarningText(w.phrase || '');
    }
  }
}

// ---- load -----------------------------------------------------------------

export async function load(state) {
  const chat = ensureChat(state);
  // Rider (task-w6): snapshot chat.activeId as we enter — a selectSession()/
  // newChat() racing any of the three awaits below already owns
  // chat.activeId/chat.groups/chat.thread by the time we'd resume, and
  // continuing past it would resurrect a stale `r.active` flag on the sidebar
  // (rebuildGroups below bakes the LOCAL `activeId` into every row). Same bail
  // pattern the later per-session awaits in this function already use — just
  // extended to cover these first three.
  const enteredActiveId = chat.activeId;
  // sessions list — if this throws, loader keeps the mock.
  const sessions = await apiGet('/api/sessions');
  // Steer capability (Pillar A): cached on state so the busy-composer
  // decision is synchronous. Failure = unavailable, never a thrown load.
  // Capabilities land AFTER a reload has already re-attached a running turn,
  // and beginTurn computed chat.steerMode from the caps it had at the time
  // (none) — leaving a stale "Send"/queue composer on a thread that can in
  // fact be steered. Recompute once the real answer arrives.
  apiGet('/api/capabilities').then((caps) => {
    state.caps = caps || {};
    if (turn && chat.busySessionId && chat.busySessionId === turn.sessionId) {
      chat.steerMode = busySendMode({
        busyHere: true,
        steerAvailable: !!(state.caps.steer && state.caps.steer.available),
        endpointId: chat.endpointId,
        hasAttachments: false,
        forceQueue: false,
      }) === 'steer';
      runtime.render();
    }
  }).catch(() => { state.caps = state.caps || {}; });
  if (chat.activeId !== enteredActiveId) return;
  const list = Array.isArray(sessions) ? sessions : [];
  chat.sessions = list;
  _pruneOpenedLocal(chat);

  // Projects (spec 4.2): best-effort; an empty list just means no project
  // sections. Lives on state.live so Settings can render it too.
  try {
    const projects = await apiGet('/api/projects');
    if (chat.activeId !== enteredActiveId) return;
    state.live.projects = Array.isArray(projects) ? projects : [];
  } catch (_) { if (!Array.isArray(state.live.projects)) state.live.projects = []; }

  // Restore the session from before the reload. storeActiveId(null) is called
  // when the user explicitly leaves a chat (New Chat, delete), so a null stored
  // value correctly keeps the welcome screen after refresh in those cases.
  const stored = readActiveId();
  const storedValid = stored && list.some((s) => s.id === stored);
  // A #chat/<id> deep link (routes.js, parsed by app.js at boot) wins over
  // the remembered thread; it is consumed once so later loads fall through.
  const bootId = state.bootSessionId && list.some((s) => s.id === state.bootSessionId) ? state.bootSessionId : null;
  state.bootSessionId = null;
  const activeId = chat.activeId || bootId || (storedValid ? stored : null) || null;
  chat.activeId = activeId;
  storeActiveId(activeId);

  // Reload / deep link: bring back this thread's saved draft and let it lead RECENT.
  if (activeId) {
    if (!state.draft) state.draft = restoreDraft(chat.drafts, activeId);
    chat.mru = pushMru(chat.mru, activeId);
    try { persistMru(chat.mru, window.localStorage); } catch (_) { /* storage unavailable */ }
  }

  // fallback model + cwd (best-effort)
  let fallbackModel = '';
  let fallbackEndpointId = '';
  try {
    const dc = await apiGet('/api/default-chat');
    fallbackModel = dc?.model || '';
    fallbackEndpointId = dc?.endpoint_id || '';
  } catch (_) { /* ignore */ }
  if (chat.activeId !== activeId) return;
  try {
    const cfg = await apiGet('/api/config');
    // cwd is workspace-global (not session-scoped) — intentionally written
    // even if the active session changed during the await.
    if (cfg?.workspace_root) chat.cwd = cfg.workspace_root;
  } catch (_) { /* ignore */ }
  if (chat.activeId !== activeId) return;

  _mirrorSessionMeta(chat, activeId);
  rebuildGroups(chat, activeId);
  startNotifier();            // begin cross-session turn polling (singleton)

  const activeSession = list.find((s) => s.id === activeId);

  if (activeId) {
    try {
      const t = await fetchThread(activeId, fallbackModel, activeSession?.name);
      // A session switch (e.g. reloadSessions() racing a manual click) may
      // have moved chat.activeId on while this awaited — a stale resolve
      // must not overwrite the thread the user is now looking at.
      if (chat.activeId !== activeId) return;
      chat.thread = dedupeAdjacentUserMessages(t.thread, 'selectSession');
      chat.title = t.title || chat.title;
      chat.subtitle = t.subtitle;
      chat.model = t.model || fallbackModel;
      runtime.wantChatBottom = true;   // land on the latest message after refresh
      changesAttachHistory(state, activeId, chat.thread).catch(() => {});
    } catch (_) {
      if (chat.activeId === activeId) {
        chat.thread = chat.thread || [];
        chat.model = chat.model || fallbackModel;
      }
    }
    if (chat.activeId !== activeId) return;
    // Mobile pull-to-refresh (doRefresh → load(force)) during a HEALTHY stream
    // gets here with a live turn already running: fetchThread just replaced
    // chat.thread wholesale from server history, which doesn't yet contain the
    // in-flight reply (reconcileTurn below correctly no-ops for a healthy local
    // turn — decision 'none' — so it won't rebuild it either). Without this,
    // turn.asstMsg keeps accumulating text but is no longer IN chat.thread, so
    // every pump frame's patchMessage lookup misses and silently falls back to
    // a full innerHTML render until the turn ends. Re-append the SAME object
    // (preserves its .streaming flag) — append matches live-turn semantics,
    // since beginTurn always pushes new turns at the end of chat.thread.
    if (turn && turn.sessionId === activeId && turn.asstMsg
        && !chat.thread.some((m) => m.id === turn.asstMsg.id)) {
      chat.thread.push(turn.asstMsg);
    }
    // Endpoint half of the model identity — the session record carries it, else
    // fall back to the default-chat endpoint. Needed so the picker's active
    // check lands on the right (endpoint·model) row, not every same-named copy.
    chat.endpointId = activeSession?.endpoint_id || fallbackEndpointId || chat.endpointId || '';
    // Re-attach to an in-flight turn after a page refresh — the live answer
    // keeps streaming instead of vanishing until the turn fully finishes.
    try { await reconcileTurn(chat, state, activeId); } catch (_) { /* non-fatal */ }
    if (chat.activeId !== activeId) return;
    // Populate resolved update_blocks (generated images etc.) that the frontend
    // missed while away — survives page refresh and session switch.
    try { await hydrateThread(activeId, chat.thread); } catch (_) { /* non-fatal */ }
    if (chat.activeId !== activeId) return;
    try { await hydrateWarnings(activeId, chat.thread); } catch (_) { /* non-fatal */ }
    if (chat.activeId !== activeId) return;
    const pct = usagePctOf(await fetchUsage(activeId));
    if (pct != null && chat.activeId === activeId) chat.usagePct = pct;
  } else {
    chat.thread = [];
    chat.model = fallbackModel;
    chat.endpointId = fallbackEndpointId || '';
    chat.title = 'New chat';
    chat.subtitle = `0 messages · ${fallbackModel}`;
  }

  if (!chat.model) chat.model = fallbackModel;
}

// ---- actions --------------------------------------------------------------

let streamCtrl = null;       // active POST-stream controller (fresh send)
let liveES = null;           // active EventSource tail (resume / re-attach)
let renderTimer = null;      // throttle handle for stream deltas
let elapsedTimer = null;     // ticks the "Working… Ns" elapsed clock
let turn = null;             // per-send activity state (see send())
let _lastOnEvent = null;     // most recent turn's onEvent — test hook only (see __testOnEvent)
let _notifyResuming = null;  // session id with a notifier-driven resume in flight
const _stripPersistTimers = new Map(); // sessionId → pending persist timer

// ---- per-turn identity (epoch) ---------------------------------------------
// Every beginTurn() claims a fresh epoch; each closure it builds captures it.
// A closure whose epoch no longer matches the module `turn` slot is a STALE
// source — e.g. an aborted POST reader whose trailing AbortError is delivered
// as a microtask, or a superseded EventSource — and must no-op. Without this,
// stopLive() + beginTurn() in one synchronous frame (fireSend, attachTurn) let
// the OLD reader's queued error land on the fresh turn: a false "connection
// dropped" bubble plus a full teardown of a perfectly healthy turn, which then
// drops all its real frames.
let _turnEpoch = 0;
// Pure guard, exported for __tests__/chat-turn-epoch.test.js. Requires a real
// epoch on both sides — undefined === undefined must NOT count as current.
export function isCurrentTurn(t, epoch) { return !!(t && epoch != null && t.epoch === epoch); }

// reply_commit separator: keep the narration the user just read and end it with
// exactly one blank line so the next block (more narration, or the answer) reads
// as its own paragraph instead of running together. Empty/whitespace text and
// text already ending in a blank line are returned unchanged. Pure + exported
// for __tests__/reply-commit-separator.test.js.
export function commitSeparator(text) {
  if (!text || !text.trim()) return text || '';
  if (/\n\n$/.test(text)) return text;
  return text.replace(/\s+$/, '') + '\n\n';
}

// ---- session-keyed queued messages -----------------------------------------
// chat.queuedList = [{sid, text, attachSnap}, ...] is the truth: messages the
// user sent while a turn was streaming in their thread, in submission order,
// KEYED to the thread they were typed into (a message queued in A must never
// fire into B). chat.queued stays a derived single-slot view — the first
// entry for the ACTIVE session — because surfaces.js renders the composer
// banner (recall/cancel) straight from it. Pure helpers exported for tests.
export function queueHead(list, sid) {
  return (Array.isArray(list) ? list : []).find((q) => q && q.sid === sid) || null;
}
export function queueTake(list, sid) {
  const src = Array.isArray(list) ? list : [];
  let taken = null;
  const rest = [];
  for (const q of src) {
    if (!taken && q && q.sid === sid) { taken = q; continue; }
    rest.push(q);
  }
  return { taken, rest };
}
export function queueDropSession(list, sid) {
  return (Array.isArray(list) ? list : []).filter((q) => !(q && q.sid === sid));
}
function syncQueuedView(chat) {
  chat.queued = queueHead(chat.queuedList, chat.activeId);
}

// Debounced (500ms) write of the strip's todo items to the server so they
// survive a full PWA reload. sessionId is chat.activeId (the 12-hex session
// id). Sends an empty array when todos have been cleared — that keeps the
// server in sync without needing a separate clear call on every completion.
function persistStripToServer(sessionId, strip) {
  if (!sessionId) return;
  // Keyed per session, not one shared handle: a strip patch for session B
  // arriving within 500ms of session A's must not cancel A's pending
  // persist — they're unrelated writes to unrelated server-side records.
  const prior = _stripPersistTimers.get(sessionId);
  if (prior) clearTimeout(prior);
  const timer = setTimeout(async () => {
    _stripPersistTimers.delete(sessionId);
    const tasks = (strip && strip.todos && strip.todos.items) ? strip.todos.items : [];
    try {
      const fd = new FormData();
      fd.append('session', sessionId);
      fd.append('tasks_json', JSON.stringify(tasks));
      await fetch('/api/strip/state', { method: 'POST', credentials: 'same-origin', body: fd });
    } catch (_) { /* non-fatal */ }
  }, 500);
  _stripPersistTimers.set(sessionId, timer);
}

// Pending-work token state: maps backend turn_id (int) → message object.
// Persists across turn teardown so token.resolved frames that arrive after
// `turn = null` can still find and patch their originating message.
const _pendingByTurnId = new Map();

function _handlePendingFrame(ev, chat, liveIsMine) {
  const turnId = ev.turn_id;
  if (turnId == null) return;
  if (ev.type === 'token.added') {
    let msg = _pendingByTurnId.get(turnId);
    // Only a source that still OWNS the live turn may claim turn.asstMsg —
    // a superseded reader's token must not bind to the successor's bubble.
    if (!msg && liveIsMine && turn && turn.asstMsg) {
      // First token.added for this turn: associate with the live message.
      msg = turn.asstMsg;
      _pendingByTurnId.set(turnId, msg);
    }
    if (!msg) return;
    msg.pendingTokens = msg.pendingTokens || [];
    msg.pendingTokens.push(ev.token);
    if (!(runtime.patchMessage && runtime.patchMessage(msg.id))) runtime.render();
  } else if (ev.type === 'token.resolved') {
    const msg = _pendingByTurnId.get(turnId);
    if (!msg) return;
    msg.pendingTokens = (msg.pendingTokens || []).filter((t) => t.id !== ev.token_id);
    msg.updateBlocks = msg.updateBlocks || [];
    msg.updateBlocks.push({ payload: ev.payload || {}, elapsed_ms: ev.elapsed_ms || 0 });
    if (!msg.pendingTokens.length) _pendingByTurnId.delete(turnId);
    if (!(runtime.patchMessage && runtime.patchMessage(msg.id))) runtime.render();
  }
}

// Adaptive render cadence: each patch re-parses the WHOLE active message
// (markdown + re-highlight every code block via chatMsg), so per-render cost
// grows with the message. A fixed 60ms tick on a long reply = ~16 ever-larger
// renders/sec → O(n²) main-thread work that starves keystrokes ("type slow or
// it arrives in a burst"). So we stretch the interval as the message grows:
// short replies stay at 60ms (instant), long ones back off toward a 260ms
// ceiling, bounding total render work. No content is lost — the trailing
// flushRender() on 'done' always paints the final complete state.
function renderDelay() {
  const len = (turn && turn.asstMsg && turn.asstMsg.text ? turn.asstMsg.text.length : 0);
  if (len < 2000) return 60;
  return Math.min(260, 60 + Math.floor((len - 2000) / 100));
}

function throttledRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    // Streaming deltas patch ONLY the active message in place (see
    // runtime.patchMessage) so we don't rebuild the whole document per token —
    // that's what killed text selection, scroll, and composer typing mid-stream.
    // Fall back to a full render if the bubble isn't mounted yet.
    if (!(turn && runtime.patchMessage && runtime.patchMessage(turn.msgId))) runtime.render();
  }, renderDelay());
}

function flushRender() {
  if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
  runtime.render();
}

// ---- buttery streaming pump -----------------------------------------------
// Server chunks arrive bursty (whole sentences at a time). Appending them
// straight to the DOM feels choppy. Instead we buffer incoming text on
// `turn.pending` and drain a handful of chars per animation frame — so a
// 400-char burst plays out as a smooth typewriter over ~1s. Adaptive: if the
// buffer grows, we drain faster so we never fall behind the model.
function drainStreamBuffer() {
  if (!turn || !turn.asstMsg || !turn.pending) { if (turn) turn.pumpRAF = 0; return; }
  const q = turn.pending;
  // Chars per frame: floor 2, scale up with backlog so a big burst catches up
  // in ~30 frames (~0.5s at 60fps). Never more than half the buffer per frame,
  // so the tail still animates instead of dumping.
  const perFrame = Math.max(1, Math.min(Math.ceil(q.length / 60), Math.ceil(q.length / 2)));
  const take = q.slice(0, perFrame);
  turn.pending = q.slice(perFrame);
  turn.asstMsg.text += take;
  // Paint EVERY frame during the pump — the throttled path coalesces at 60–260ms
  // which makes 2-char-per-frame progress land as 15-char chunks. Bypass it so
  // each frame's small edit actually reaches the DOM.
  if (!(turn && runtime.patchMessage && runtime.patchMessage(turn.msgId))) runtime.render();
  if (turn.pending.length > 0) {
    turn.pumpRAF = requestAnimationFrame(drainStreamBuffer);
  } else {
    turn.pumpRAF = 0;
  }
}
function enqueueStreamText(delta) {
  if (!turn || !turn.asstMsg) return;
  turn.pending = (turn.pending || '') + delta;
  if (!turn.pumpRAF) turn.pumpRAF = requestAnimationFrame(drainStreamBuffer);
}
function flushStreamBuffer() {
  if (!turn) return;
  if (turn.pumpRAF) { cancelAnimationFrame(turn.pumpRAF); turn.pumpRAF = 0; }
  if (turn.pending && turn.asstMsg) {
    turn.asstMsg.text += turn.pending;
    turn.pending = '';
  }
}

// Close the current assistant bubble so the NEXT delta opens a fresh one
// below it — used when a message steers into a running turn (Pillar A):
// flush any buffered stream text into the bubble that's ending, mark it
// no-longer-streaming, finalize any running think/tool steps, then clear
// the turn's per-message slots and mint a fresh msgId. Shared by the
// `user_steer` replay handler (onEvent, always safe — already epoch-guarded
// upstream) and fireSteer's success path (guarded by its caller with
// `turn && turn.sessionId === sessionId`, since its `await fetch` may
// resolve after the turn has moved on).
// Index of a history-sourced user bubble (id `h<i>`, from fetchThread) with
// exactly `text` that sits AFTER the last history assistant message — i.e.
// among the thread's trailing messages, which is where a steer persisted
// mid-turn shows up on a reload. Returns -1 when there is no such bubble.
// Exported for chat-steer.test.js.
export function trailingHistorySteerIdx(thread, text) {
  const list = Array.isArray(thread) ? thread : [];
  let lastAsst = -1;
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (m && m.role === 'assistant' && /^h\d+$/.test(String(m.id || ''))) lastAsst = i;
  }
  for (let i = lastAsst + 1; i < list.length; i++) {
    const m = list[i];
    if (m && m.role === 'user' && !m.sys && /^h\d+$/.test(String(m.id || ''))
        && String(m.text || '') === String(text || '')) return i;
  }
  return -1;
}

// Idempotent per steer id: fireSteer's 200 path and the `user_steer` frame
// handler both call this within milliseconds of each other for the SAME steer,
// and a delta arriving between the two would otherwise leave a spurious empty
// assistant bubble behind. `turn.closedSteerIds` remembers which steer ids
// already closed a bubble on THIS turn (it dies with the turn, as it should).
function closeAsstBubbleForSteer(steerId) {
  if (steerId) {
    if (!turn.closedSteerIds) turn.closedSteerIds = new Set();
    if (turn.closedSteerIds.has(steerId)) return;
    turn.closedSteerIds.add(steerId);
  }
  flushStreamBuffer();
  if (turn.asstMsg) turn.asstMsg.streaming = false;
  if (turn.thinkStep) finalizeStep(turn.thinkStep);
  if (turn.activity) finalizeTools(turn.activity);
  turn.asstMsg = null; turn.activity = null; turn.thinkStep = null;
  turn.msgId = uniqId('live-');
}

export const STEER_MISSED_NOTICE =
  'Gary finished before reading this. It was saved to the thread; send it again if you still need an answer.';

// Honesty rescue (Pillar A, review finding 1/3): a steer that lands after the
// CLI's last tool boundary — or in the window between the CLI finishing its
// output and the workspace recorder closing the turn — is accepted by the
// route (the active-turn gate still passes) but never answered inside this
// turn. The tell at 'done' is that the LAST message in the thread is a steer
// bubble with nothing after it. Say so instead of leaving a bare "Steered
// into the running turn" caption, and refetch history a few seconds later in
// case the gateway did record a reply this client never saw streamed.
export function maybeSteerRescue(chat, sessionId) {
  const list = Array.isArray(chat.thread) ? chat.thread : [];
  const last = list[list.length - 1];
  if (!last || last.role !== 'user' || !last.steer || last.steerNotice) return;
  last.steerNotice = STEER_MISSED_NOTICE;
  if (!sessionId) return;
  const before = list.length;
  const handle = setTimeout(async () => {
    const state = runtime.state;
    if (!state) return;
    const c = ensureChat(state);
    // Only refetch into a view that is still this thread and still idle — a
    // new turn (or a thread switch) owns chat.thread now.
    if (c.activeId !== sessionId || turn) return;
    try {
      const t = await fetchThread(sessionId, c.model, c.title);
      if (c.activeId !== sessionId || turn) return;
      const thread = dedupeAdjacentUserMessages(t.thread, 'dropped-steer-rescue');
      if (thread.length > before) { c.thread = thread; runtime.render(); }
    } catch (_) { /* best-effort — the notice already told the truth */ }
  }, 3000);
  // Node's timers keep the process alive; the browser's don't have .unref.
  if (handle && typeof handle.unref === 'function') handle.unref();
}

// AskUserQuestion tool_start → card model, or null if not a question tool.
export function buildQuestionCardModel(ev) {
  if (!ev || String(ev.tool || '') !== 'AskUserQuestion') return null;
  const model = parseQuestionCard(ev.input);
  return model ? { model, toolId: ev.tool_id || '' } : null;
}

// Answer plumbing for tappable AskUserQuestion cards (app.js qc* actions call
// this once a card commits). Indirected through _dispatchImpl so tests can
// swap in a stub instead of driving the real POST /api/chat_stream path.
let _dispatchImpl = (text) => dispatchSend(text);
export function __setDispatchForTest(fn) { _dispatchImpl = fn; }

// Answered-card lock state (Task 5'). Populated from /api/history's
// `question_answers` sidecar (see backend/question_cards.py) so a reload
// replays a card locked with the choice already made, instead of tappable
// again.
let _qAnswers = {};
export function __setQuestionAnswers(m) { _qAnswers = m || {}; }
export function isQuestionLocked(toolId) { return !!(_qAnswers[toolId] && _qAnswers[toolId].answered); }
export function lockedChoice(toolId) { return (_qAnswers[toolId] || {}).choice || ''; }

export function recordQuestionAnswer(toolId, choice) {
  if (!toolId) return;
  _qAnswers[toolId] = { answered: true, choice };
  const chat = runtime.state && ensureChat(runtime.state);
  const sid = chat && chat.activeId;
  if (sid) fetch('/api/question-answer', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: sid, tool_id: toolId, choice }) }).catch(() => {});
}

export function answerQuestionCard(toolId, answerString) {
  try { recordQuestionAnswer(toolId, answerString); } catch (_) {}
  _dispatchImpl(answerString);
}

// ---- activity-trail mapping (live SSE → step model) -----------------------
// Map a tool name to a step kind; present/past-tense labels per state.
function toolKind(name) {
  const n = String(name || '').toLowerCase();
  if (/grep|search|find|\brg\b|glob|ripgrep/.test(n)) return 'grep';
  if (/web|fetch|browse|http|url|google/.test(n)) return 'web';
  if (/read|cat|open|view|get_file|load/.test(n)) return 'read';
  if (/edit|write|patch|str_replace|create|apply|insert|append/.test(n)) return 'edit';
  if (/bash|shell|run|exec|terminal|command|npm|sh\b/.test(n)) return 'run';
  return 'generic';
}
const PRESENT = { read: 'Reading', grep: 'Searching', edit: 'Editing', run: 'Running', web: 'Searching the web', generic: 'Working' };
const PAST = { read: 'Read', grep: 'Searched', edit: 'Edited', run: 'Ran', web: 'Searched the web', generic: 'Ran tool' };

function fmtElapsed(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;            // under a minute: "42s"
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;  // 159s → "2:39"
}

function lineColor(line) {
  const t = String(line).trim();
  if (t.startsWith('✓')) return 'var(--green)';
  if (/\b(error|fatal|failed|exception)\b/i.test(t)) return 'var(--red)';
  if (t.startsWith('#') || t.startsWith('//')) return 'var(--faint)';
  return '#cfd3da';
}

// Sticky "Gary is working…" banner visible at the top of the thread viewport,
// so users on mobile don't need to scroll to see progress.
function _ensureWorkingBanner() {
  // Guard mirrors paintGhost/fetchSuggestion's `typeof document === 'undefined'`
  // convention, extended to also cover this suite's minimal per-file test-stub
  // `document` objects (several shapes exist across __tests__/*.test.js, each
  // defining only the DOM surface that file's other assertions need — none
  // define the full getElementById/createElement/head surface this banner
  // needs). stopElapsed()/startElapsed() call into this from core turn-
  // lifecycle paths (selectSession, stopRun, the elapsed-tick interval) that
  // node:test's DOM-light chat.js tests exercise directly.
  if (typeof document === 'undefined'
      || typeof document.getElementById !== 'function'
      || typeof document.createElement !== 'function'
      || !document.head) return null;
  let el = document.getElementById('oc-working-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'oc-working-banner';
    el.style.cssText = [
      'position:sticky;top:0;z-index:50;',
      'padding:5px 12px 5px 10px;',
      'background:var(--panel,#1a1b1f);',
      'border-bottom:1px solid var(--border,rgba(255,255,255,.08));',
      'font-size:12px;color:var(--faint,#7a7e8a);',
      'align-items:center;gap:6px;',
    ].join('');
    el.style.display = 'none'; // hidden until _showWorkingBanner()
    el.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;background:var(--teal,#0dc);display:inline-block;animation:pulse var(--loop-slow) ease-in-out infinite"></span>'
      + '<span class="oc-wb-text">Gary is working…</span>'
      + '<span class="act-elapsed" style="margin-left:auto;font-family:var(--mono,monospace);font-size:11px;opacity:.65"></span>';
    // Insert at the top of the thread container
    const thread = document.querySelector('.m-thread, .chat-thread, #chat-history');
    if (thread) thread.prepend(el);
  }
  return el;
}
function _showWorkingBanner(label) {
  const el = _ensureWorkingBanner();
  if (!el) return;
  el.style.display = 'flex';
  const lbl = el.querySelector('.oc-wb-text');
  if (lbl) lbl.textContent = label || 'Gary is working…';
}
function _hideWorkingBanner() {
  if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
  const el = document.getElementById('oc-working-banner');
  if (el) el.style.display = 'none';
}

function stopElapsed() {
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  _hideWorkingBanner();
}
function startElapsed() {
  stopElapsed();
  _showWorkingBanner();
  elapsedTimer = setInterval(() => {
    if (turn && turn.activity && turn.activity.status === 'working') {
      turn.activity.elapsed = fmtElapsed(turn.activity.startMs);
      // Surgically patch ONLY the elapsed-clock text. A full runtime.render()
      // here fired every 500ms for the entire turn, rebuilding root.innerHTML —
      // which de-selected text, reset scroll, and made typing impossible. Update
      // the single text node instead; fall back to a full render only if the
      // clock isn't in the DOM yet (first tick before its initial paint).
      const els = typeof document.querySelectorAll === 'function' ? document.querySelectorAll('.act-elapsed') : [];
      if (els.length) els.forEach(e => { e.textContent = turn.activity.elapsed; });
      else runtime.render();
      // Mid-turn ghost suggestion ("While you wait, …"): once per SERVER turn
      // (chat.suggestAskedTurn is keyed by turn_id so an iOS suspend/resume
      // re-attach — which rebuilds the local turn object with a backdated
      // startMs — can't re-fire it), ≥30s in, only while the user is looking
      // at the busy thread. The stamp is only spent when a request actually
      // dispatched: a skip (hidden tab, draft in progress) retries next tick.
      if (turn.turnId != null && Date.now() - turn.activity.startMs >= MIDTURN_SUGGEST_MS) {
        const chat = ensureChat(runtime.state);
        if (chat.suggestAskedTurn !== turn.turnId && chat.activeId === turn.sessionId
            && fetchSuggestion(chat, 'midturn', turn.activity)) {
          chat.suggestAskedTurn = turn.turnId;
        }
      }
    } else stopElapsed();
  }, 500);
}

// ---- composer ghost suggestions (Claude-Code-style) ------------------------
// One cheap-model call per moment: 'midturn' ≥30s into a running turn,
// 'followup' right after a clean turn end. Fire-and-forget: every failure or
// staleness path degrades to "no ghost text", never an error state.
const MIDTURN_SUGGEST_MS = 30_000;
let suggestInFlight = false;

// Surgically insert the ghost next to the live composer textarea instead of
// runtime.render(): a suggestion can land mid-turn (or mid-text-selection),
// and a wholesale root.innerHTML rebuild wipes selection/scroll — the exact
// regression the elapsed ticker's .act-elapsed patching exists to avoid. Any
// later natural render re-derives the same ghost from chat.suggest.
function paintGhost(chat) {
  if (!chat.suggest || typeof document === 'undefined') return;
  const ta = document.querySelector('[data-focus="draft"], [data-focus="mdraft"]');
  if (!ta || (ta.value || '').trim()) return;
  const mobile = ta.getAttribute('data-focus') === 'mdraft';
  // Midturn ("while you wait…") is Gary talking to Frank, so it renders inline
  // under the last assistant message on both desktop and mobile — never in the
  // composer, where it would read like a draft to send. Followup mode stays a
  // composer overlay on both surfaces.
  if (chat.suggest.mode === 'midturn') {
    const sel = mobile ? '.m-msg-asst .m-md' : '.msg-asst .msg-body';
    const asstMds = document.querySelectorAll(sel);
    const last = asstMds[asstMds.length - 1];
    if (!last || last.querySelector('.ghost-suggest')) return;
    const opts = mobile ? { mobile: true } : { assist: true };
    last.insertAdjacentHTML('beforeend', suggestGhost(chat.suggest, ta.value, opts));
    return;
  }
  const wrap = ta.closest('.composer, .m-composer');
  if (!wrap || wrap.querySelector('.ghost-suggest')) return;
  ta.insertAdjacentHTML('beforebegin', suggestGhost(chat.suggest, ta.value, { mobile }));
}

// Guards synchronously, then fires the fetch in the background. Returns true
// only when a request was actually dispatched — the midturn one-shot stamp
// keys off this so a skipped attempt (hidden tab, draft in progress) doesn't
// burn the turn's single mid-turn suggestion.
function fetchSuggestion(chat, mode, activity) {
  if (suggestInFlight || !chat || chat.queued) return false;
  if ((runtime.state?.draft || '').trim()) return false;
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return false;
  const sessionId = chat.activeId;
  const t = turn; // staleness token — the turn slot must be unchanged on landing
  const context = buildSuggestContext(chat.thread, activitySummary(activity));
  if (!context) return false;
  suggestInFlight = true;
  (async () => {
    let text = '';
    try {
      const res = await apiJson('/api/chat/suggest',
        { session_key: sessionId || '', mode, context });
      text = res && typeof res.text === 'string' ? res.text.trim() : '';
    } catch (_) { text = ''; }
    finally { suggestInFlight = false; }
    if (!text) return;                       // server owns the length policy
    const cur = ensureChat(runtime.state);
    if (cur !== chat || cur.activeId !== sessionId) return; // switched threads
    if (turn !== t) return;                  // turn ended or a new one started
    if (chat.queued) return;                 // user queued a message meanwhile
    if ((runtime.state?.draft || '').trim()) return; // user typed meanwhile
    chat.suggest = { text, mode, sessionId };
    paintGhost(chat);
  })();
  return true;
}

function finalizeStep(st) {
  if (!st || st.state !== 'running') return;
  st.state = 'done';
  st.cursor = false;
  if (st.kind === 'think') {
    st.label = `Thought for ${Math.max(1, Math.round((Date.now() - st.startMs) / 1000))}s`;
  } else {
    st.label = PAST[st.kind] || 'Ran tool';
    if (st.kind === 'run' && !st.meta) {
      st.meta = `✓ ${((Date.now() - st.startMs) / 1000).toFixed(1)}s`;
      st.metaColor = 'var(--green)';
    }
  }
}
function finalizeTools(a) { if (a) for (const st of a.steps) if (st.kind !== 'think') finalizeStep(st); }
function finalizeAll(a) { if (a) for (const st of a.steps) finalizeStep(st); }

// after a turn completes, refresh the sidebar + usage but KEEP the optimistic
// thread (it carries the live activity trail, which history doesn't store).
async function refreshSidebarUsage(state) {
  const chat = ensureChat(state);
  const id = chat.activeId;
  try {
    const sessions = await apiGet('/api/sessions');
    const list = Array.isArray(sessions) ? sessions : [];
    chat.sessions = list;
    // I3: re-mirror onto the header (project pill, parent link) every time
    // chat.sessions is replaced here -- otherwise a filing that lands
    // between two of these refetches stays invisible until something else
    // happens to call _mirrorSessionMeta.
    _mirrorSessionMeta(chat, chat.activeId);
    _pruneOpenedLocal(chat);
    rebuildGroups(chat, id);
    const name = list.find((s) => s.id === id)?.name;
    if (name) chat.title = name;
  } catch (_) { /* keep */ }
  if (Array.isArray(chat.thread)) chat.subtitle = `${chat.thread.length} messages · ${chat.model || ''}`;
  const u = await fetchUsage(id);
  const pct = usagePctOf(u);
  // Guard: the user may have switched threads while the GET was in flight.
  if (pct != null && chat.activeId === id) chat.usagePct = pct;
  runtime.render();
  // Hand the payload back so the turn-done path can reuse it (one GET/turn).
  return { id, usage: u };
}

// I3: chat_turn.py spawns project_classify.file_session off the turn's
// critical path at the same moment the AI title lands (see the title-time
// hook, spec 6.1) -- the classifier can still be running when `done` reaches
// this client, so refreshSidebarUsage's own refetch (right on `done`) can
// miss a filing that finishes a beat later. When a turn lands a new title
// (the same signal the server uses to fire the classifier), schedule ONE
// more /api/sessions pass ~5s later so the filing lands on screen without
// waiting for an unrelated refresh. Keeps at most one pending timer on
// `chat` -- a later call clears whatever was still pending -- and unref()s
// the handle (Node) so a test process can exit without waiting on it.
function _scheduleProjectFilingRefetch(chat) {
  if (chat._filingRefetchTimer) {
    try { clearTimeout(chat._filingRefetchTimer); } catch (_) { /* not a real timer handle */ }
    chat._filingRefetchTimer = null;
  }
  const handle = setTimeout(() => {
    chat._filingRefetchTimer = null;
    apiGet('/api/sessions').then((sessions) => {
      const list = Array.isArray(sessions) ? sessions : [];
      chat.sessions = list;
      _mirrorSessionMeta(chat, chat.activeId);
      rebuildGroups(chat, chat.activeId);
      runtime.render();
    }).catch(() => { /* best-effort */ });
  }, 5000);
  if (handle && typeof handle.unref === 'function') handle.unref();
  chat._filingRefetchTimer = handle;
}

// Pure slicing step for branchFromMessage — split out so it's unit-testable
// without a DOM/fetch/localStorage environment (see
// __tests__/redesign-branch-from-message.test.js). Returns null if msgId
// isn't in the thread; otherwise the {role,text} (+id) prefix through and
// including that message, in thread order.
export function sliceBranchPrefix(thread, msgId) {
  const list = Array.isArray(thread) ? thread : [];
  const idx = list.findIndex((m) => m.id === msgId);
  if (idx < 0) return null;
  return list.slice(0, idx + 1).map((m) => ({ id: m.id, role: m.role, text: m.text }));
}

// localStorage key a branched session's carried prefix is stashed under —
// shared by branchFromMessage (write), selectSession (rehydrate on reopen),
// and clearBranchPrefixIfStarted (delete once the branch has a real message).
const branchPrefixKey = (sessionId) => `branchPrefix:${sessionId}`;

// Once a live message actually lands in a branched session's thread, the
// carried prefix bubbles (state.branchPrefix, rendered by chatSurface — see
// surfaces.js) have done their job: the backend already prepended the
// preamble to that first send. Clear both the in-memory flag and its
// localStorage backing so a reload doesn't resurrect stale carried bubbles.
export function clearBranchPrefixIfStarted(state, chat) {
  if (state.branchPrefix && Array.isArray(chat.thread) && chat.thread.length > 0) {
    state.branchPrefix = null;
    try { if (chat.activeId) localStorage.removeItem(branchPrefixKey(chat.activeId)); } catch (_) {}
  }
}

async function createSession(model, endpointId) {
  let endpoint_url = '';
  let endpoint_id = '';
  let m = model;
  try {
    const dc = await apiGet('/api/default-chat');
    endpoint_url = dc?.endpoint_url || '';
    endpoint_id = dc?.endpoint_id || '';
    if (!m) m = dc?.model || '';
  } catch (_) { /* ignore */ }
  // The picked model owns its endpoint (chat.endpointId). Using the
  // default-chat endpoint instead cross-pairs a non-default model (e.g. a
  // local/Kamino model with the claude-cli endpoint), which the /api/session
  // guard rejects with a 400 → "Couldn't start the chat". Honor the selection.
  if (endpointId) endpoint_id = endpointId;
  const res = await apiForm('/api/session', {
    name: 'New chat',
    model: m,
    endpoint_url,
    endpoint_id,
  });
  return res && res.id;
}

// ---- live turn controller (shared by send + resume) -----------------------
// Exactly one in-flight assistant turn renders at a time, tracked in module
// `turn`. The reducer is identical whether frames arrive from POST
// /api/chat_stream (a fresh send) or from replay + the EventSource tail of
// /api/chat/stream (re-attaching to a turn still running server-side after a
// reload / thread-switch — see backend event_store + resume_route).

// Stop whichever live source is attached. Safe to call anytime: aborting the
// reader no longer stops the turn (the server-side recorder owns it), so
// switching threads / closing only detaches this client.
function stopLive() {
  if (streamCtrl) { try { streamCtrl.abort(); } catch (_) {} streamCtrl = null; }
  if (liveES) { try { liveES.close(); } catch (_) {} liveES = null; }
  // Detaching mid-typewriter leaves the rAF pump scheduled against the old
  // turn — cancel it so it can't paint one more frame after the turn is
  // superseded or torn down.
  if (turn && turn.pumpRAF) {
    try { cancelAnimationFrame(turn.pumpRAF); } catch (_) { /* no rAF host */ }
    turn.pumpRAF = 0;
  }
}

// The last bubble a Stop finalized: {sessionId, msgId}. If the stop-POST
// never landed server-side (or raced the run), the notifier re-attaches
// ~4s later and attachTurn replays the turn from its start — it consults
// this record and removes the stopped bubble so the rebuilt turn doesn't
// render next to a duplicate of itself. One-shot: consumed by attachTurn,
// refreshed by the next stopRun, invalidated by a fresh turn for the session.
let lastStopped = null;

// Build a fresh per-turn reducer bound to `chat`. Returns { onEvent,
// ensureActivity }. `onEvent` is fed the same {delta|type|...} objects whether
// they came live or from replay, so a rebuilt turn looks identical to a live one.
function beginTurn(chat, modelLabel, sessionId) {
  chat.suggest = null; // any turn start invalidates the ghost suggestion
  // `sessionId` tags the turn with the thread it belongs to so the send-gate can
  // distinguish "THIS thread is busy" (queue) from "another thread is busy"
  // (send freely — that turn keeps streaming + recording server-side).
  // `epoch` is this turn's identity: closures below capture it and no-op once
  // superseded (see _turnEpoch above).
  const epoch = ++_turnEpoch;
  turn = { epoch, sessionId: sessionId || chat.activeId || null, asstMsg: null, activity: null, thinkStep: null, byTid: {}, stepN: 0, msgId: uniqId('live-'), lastFrameMs: Date.now(), got404: false, closedSteerIds: new Set() };
  // The session this running turn belongs to — steer-view.js's
  // steerComposerHints() compares this against chat.activeId to decide
  // whether the composer shows "Steer"/the queue chip for the VIEWED thread
  // (a turn busy in another thread must not paint this thread's composer).
  chat.busySessionId = turn.sessionId || chat.activeId || null;
  chat.steerMode = busySendMode({
    busyHere: true,
    steerAvailable: !!(runtime.state && runtime.state.caps && runtime.state.caps.steer && runtime.state.caps.steer.available),
    endpointId: chat.endpointId,
    hasAttachments: false,
    forceQueue: false,
  }) === 'steer';
  // A fresh turn for this session supersedes any stop-dedupe record: the
  // stopped bubble now belongs to an OLDER, finished exchange and must stay.
  // (attachTurn consumes the record BEFORE calling beginTurn, so the failed-
  // stop re-attach path is unaffected.)
  if (lastStopped && lastStopped.sessionId === turn.sessionId) lastStopped = null;

  const ensureAsst = () => {
    if (!turn.asstMsg) {
      turn.asstMsg = { id: turn.msgId, role: 'assistant', text: '', time: fmtTime(Date.now()), model: modelLabel };
      if (!Array.isArray(chat.thread)) chat.thread = [];
      chat.thread.push(turn.asstMsg);
    }
    return turn.asstMsg;
  };
  const ensureActivity = () => {
    ensureAsst();
    if (!turn.asstMsg.activity) {
      turn.asstMsg.activity = { status: 'working', steps: [], startMs: Date.now(), elapsed: '0s' };
      turn.activity = turn.asstMsg.activity;
      startElapsed();
    }
    return turn.asstMsg.activity;
  };
  const newStep = (kind, file, tid) => {
    const a = ensureActivity();
    const st = { id: `${turn.msgId}-s${turn.stepN++}`, kind, label: PRESENT[kind] || 'Working', file: file || '', state: 'running', lines: [], startMs: Date.now() };
    if (kind === 'think') st.label = 'Thinking';
    _showWorkingBanner('Gary is working — ' + st.label);
    a.steps.push(st);
    if (tid != null) turn.byTid[tid] = st;
    return st;
  };

  const onEvent = (ev) => {
    if (!ev) return;
    // Pending-work frames can arrive before, during, or AFTER the live turn
    // (image_generate resolves asynchronously). Handle them before the guard —
    // but tell the handler whether THIS source still owns the live turn, so a
    // stale source can't associate its token with a successor turn's bubble.
    if (ev.type === 'token.added' || ev.type === 'token.resolved') {
      _handlePendingFrame(ev, chat, isCurrentTurn(turn, epoch));
      return;
    }
    // doc_update: Gary edited the open document during this turn (draft
    // mode). Routed unconditionally, like token.added/resolved above: the
    // file really did change regardless of turn ownership.
    if (ev.type === 'doc_update') {
      try { applyExternalUpdate(ev); } catch (_) { /* never break the turn over a doc sync hiccup */ }
      return;
    }
    // Per-turn identity guard. Covers BOTH stray frames after teardown
    // (turn = null on 'done'/'error'/404 → the old null-deref crash) AND
    // frames from a superseded source landing after a NEW turn already exists
    // (the aborted POST reader's trailing AbortError would otherwise put a
    // false "connection dropped" bubble on the fresh turn and tear it down).
    if (!isCurrentTurn(turn, epoch)) return;

    // Every frame is proof of life — the hb-gap watchdog (reconcile) keys off
    // this timestamp, so it must update for ALL frame types, not just hb.
    turn.lastFrameMs = Date.now();
    if (ev.type === 'turn_start') {
      turn.turnId = ev.turn_id;
      setLiveTurn({ sessionId: turn.sessionId, turnId: ev.turn_id, msgId: turn.msgId });
      return;
    }
    if (ev.type === 'hb') return;
    // turn_end precedes [DONE]; remember the status so the done handler can
    // label a Stop ("aborted") differently from a normal finish.
    if (ev.type === 'turn_end') { turn.endStatus = ev.status || 'ok'; return; }

    if (ev.type === 'done') {
      flushStreamBuffer();
      if (turn.asstMsg) turn.asstMsg.streaming = false;
      if (turn.thinkStep) finalizeStep(turn.thinkStep);
      chat.chatStrip = stripOnTurnDone(chat.chatStrip);
      patchChatStrip(chat);
      const a = turn.activity;
      if (a) {
        finalizeAll(a);
        a.status = 'done';
        a.elapsed = fmtElapsed(a.startMs);
        // endStatus was stored by the turn_end frame handler above — read it
        // before any teardown reorders this block.
        a.worked = turn.endStatus === 'aborted'
          ? `Stopped after ${a.elapsed} · ${a.steps.length} steps`
          : `Worked for ${a.elapsed} · ${a.steps.length} steps`;
      }
      stopElapsed();
      // BEFORE the empty-reply notice below, which appends an assistant bubble
      // and would hide the "steer bubble is last" tell this reads.
      maybeSteerRescue(chat, turn.sessionId);
      const hadText = turn.asstMsg && String(turn.asstMsg.text || '').trim();
      const hadWork = turn.activity && (turn.activity.steps || []).some((st) => st.kind !== 'think');
      if (!hadText && !hadWork && !turn.got404) {
        const m = ensureAsst();
        m.error = true;
        m.notice = 'No response from this model — it may not be available on your plan or endpoint. Try another model from the picker.';
      }
      chat.suggest = null; // a finished turn invalidates any "While you wait" ghost
      flushRender();
      // Changes review (Pillar A, task 8): the change-tracking window around
      // this turn closes server-side a beat after `done` — poll for the
      // record and attach it to the just-finished bubble once it lands.
      if (turn.asstMsg && turn.turnId != null) changesAfterTurn(turn.sessionId, turn.turnId, turn.asstMsg).catch(() => {});
      if (turn.got404) { setLiveTurn(null); actions.reloadSessions(); chat.busySessionId = null; turn = null; return; }
      // I3: capture the title BEFORE the refetch below so a landed AI title
      // (the same moment the server spawns the classifier) can be detected
      // once it resolves -- see _scheduleProjectFilingRefetch.
      const _titleBeforeDone = chat.title;
      const _titleTrackId = chat.activeId;
      const sidebarDone = refreshSidebarUsage(runtime.state);
      sidebarDone.then((res) => {
        if (res && res.id === _titleTrackId && chat.title !== _titleBeforeDone) {
          _scheduleProjectFilingRefetch(chat);
        }
      }).catch(() => {});
      // Per-turn usage: prefer what the done frame carries; otherwise reuse the
      // session usage row refreshSidebarUsage just fetched (the gateway stamps
      // it at turn end) rather than firing an identical second GET.
      if (turn.asstMsg) {
        if (ev.usage && typeof ev.usage === 'object') {
          turn.asstMsg.usage = ev.usage;
        } else if (turn.sessionId) {
          const target = turn.asstMsg;
          const forSessionId = turn.sessionId;
          sidebarDone.then((res) => {
            if (res && res.id === forSessionId) return res.usage;
            // The sidebar refreshed a DIFFERENT session (the user switched
            // threads as the turn landed) — fetch this turn's row ourselves.
            return apiGet(`/api/sessions/${encodeURIComponent(forSessionId)}/usage`).catch(() => null);
          }).then((u) => applySessionUsage(u, target, forSessionId, true)).catch(() => {});
        }
      }
      // Follow-up ghost suggestion — only after a CLEAN finish (an explicit
      // turn_end status of 'ok' AND a real reply; endStatus is undefined when
      // the stream dropped, and hadText/hadWork are false on the empty-reply
      // error notice above — no suggestions under an error card) with nothing
      // queued (flushQueuedFor fires a queued message into a new turn, which
      // would immediately invalidate the suggestion anyway).
      const cleanFinish = turn.endStatus === 'ok' && !!(hadText || hadWork);
      // Notify push-to-talk (ptt.js) so it can auto-speak this reply in voice mode.
      if (cleanFinish && turn.asstMsg && turn.asstMsg.id && String(turn.asstMsg.text || '').trim()) {
        try {
          window.dispatchEvent(new CustomEvent('gary:reply-complete', { detail: { id: turn.asstMsg.id } }));
        } catch (_) { /* non-fatal */ }
      }
      const doneSid = turn.sessionId;
      const hadQueued = !!queueHead(chat.queuedList, doneSid);
      setLiveTurn(null);
      chat.busySessionId = null;
      turn = null;
      flushQueuedFor(chat, doneSid);
      if (cleanFinish && !hadQueued) fetchSuggestion(chat, 'followup', null);
      return;
    }
    if (ev.type === 'retrying') {
      // Transient failure (422/429/502/503) — auto-retry in progress.
      ensureActivity();
      const retryStep = turn.activity.steps.find(s => s.kind === 'retry');
      const label = `Reconnecting… (attempt ${ev.attempt} of 2)`;
      if (retryStep) { retryStep.label = label; }
      else {
        const s = newStep('retry', '', null);
        s.label = label;
        s.kind = 'retry';
      }
      throttledRender();
      return;
    }

    if (ev.type === 'error') {
      flushStreamBuffer();
      if (turn.asstMsg) turn.asstMsg.streaming = false;
      if (ev.status === 404) {
        // postStream's ONLY path that never follows up with a 'done' event is
        // exactly this one (an HTTP-level failure on the POST itself — see
        // live/api.js postStream: `!res.ok` fires this error then returns,
        // full stop; every other path — including a mid-stream error frame —
        // still lands a trailing 'done', since record_turn always appends one).
        // Waiting for a 'done' that will never arrive here dead-ended until
        // the 25s hb watchdog reconciled it. Finalize NOW via the 'done' path
        // (it already special-cases turn.got404) instead of waiting on it.
        turn.got404 = true;
        onEvent({ type: 'done' });
        return;
      }
      const m = ensureAsst();            // capture the live bubble before teardown
      chat.suggest = null;               // no ghost suggestions under an error notice
      stopElapsed();
      const errSid = turn.sessionId;     // capture before teardown
      const statusless = !ev.status;     // dropped mid-turn (vs an HTTP-level POST failure)
      setLiveTurn(null);
      chat.busySessionId = null;
      turn = null;
      // Statusless drop on the visible thread: the turn may have COMPLETED
      // server-side while our reader was dead (event_store owns the turn, not
      // the POST reader). Showing an error + recalling here is what lets a
      // "Send to retry" tap start a SECOND turn for an already-answered message
      // → the duplicate-bubble bug. Ask server truth first; only fall back to
      // error+recall when the turn did NOT finish cleanly. Never loses a message.
      if (statusless && errSid && errSid === chat.activeId) {
        recoverDroppedTurn(chat, errSid, m).then((recovered) => {
          if (!recovered) showDroppedError(chat, errSid, m, ev.status);
        }).catch(() => showDroppedError(chat, errSid, m, ev.status));
        flushRender();
        return;
      }
      showDroppedError(chat, errSid, m, ev.status);
      return;
    }

    // reply_commit → a new assistant block is starting after a real tool step:
    // genuine next-step narration/answer, NOT a re-delivery. KEEP what the user
    // just read (wiping it is the "rugpull" — text vanishing mid-read); flush
    // the buffered text and separate it from the coming block with a blank line
    // so narration and answer don't run together into one soup paragraph.
    if (ev.type === 'reply_commit') {
      flushStreamBuffer();
      if (turn.asstMsg) turn.asstMsg.text = commitSeparator(turn.asstMsg.text);
      throttledRender();
      return;
    }
    // reply_reset → the agent began a NEW message mid-turn (its real reply after
    // a message-tool delivery). Drop the text shown so far so the final reply
    // isn't doubled ("Sent…Hey 👋"). Tool/thinking steps are kept.
    if (ev.type === 'reply_reset') {
      if (turn.pumpRAF) { cancelAnimationFrame(turn.pumpRAF); turn.pumpRAF = 0; }
      turn.pending = '';
      if (turn.asstMsg) turn.asstMsg.text = '';
      throttledRender();
      return;
    }
    // Promise guard (Phase 3): the reply promised a follow-up but nothing is
    // registered — surface the amber card on this turn's bubble.
    if (ev.type === 'promise_warning') {
      const m = ensureAsst();
      m.warnNotice = promiseWarningText(ev.phrase || '');
      throttledRender();
      return;
    }
    // thinking delta → a 'think' step whose body is the reasoning
    if (typeof ev.delta === 'string' && ev.thinking === true) {
      ensureActivity();
      if (!turn.thinkStep || turn.thinkStep.state !== 'running') turn.thinkStep = newStep('think');
      turn.thinkStep.body = (turn.thinkStep.body || '') + ev.delta;
      throttledRender();
      return;
    }
    // A message steered into THIS running turn (ours or another tab's). Show
    // it once (client_id dedupes the sender's optimistic bubble) and close the
    // current assistant bubble so the continuation opens a fresh one below.
    if (ev.type === 'user_steer') {
      if (!Array.isArray(chat.thread)) chat.thread = [];
      const id = ev.client_id || uniqId('live-u-');
      const text = ev.text || '';
      if (!chat.thread.some((m) => m.id === id)) {
        // Leave-and-return / reload mid-turn: the steer was persisted the
        // moment it landed, so fetchThread ALREADY returned it as a history
        // bubble (id `h<i>`), and now attachTurn replays the same frame with
        // the live client_id — two copies of one message. client_id dedupe
        // can't see that, so also look for a same-text history user bubble
        // sitting AFTER the last history assistant message (i.e. among the
        // thread's trailing messages, where a mid-turn steer lands). Found →
        // move it to the current position and caption it, keeping its id.
        const histIdx = trailingHistorySteerIdx(chat.thread, text);
        if (histIdx >= 0) {
          const [existing] = chat.thread.splice(histIdx, 1);
          existing.steer = true;
          chat.thread.push(existing);
        } else {
          chat.thread.push({ id, role: 'user', text, time: fmtTime(ev.ts || Date.now()), attach: [], steer: true });
        }
      }
      closeAsstBubbleForSteer(id);
      runtime.wantChatBottom = true;
      throttledRender();
      return;
    }
    // prose delta → the assistant's answer (tools/thinking are done by now)
    if (typeof ev.delta === 'string') {
      if (turn.thinkStep) finalizeStep(turn.thinkStep);
      if (turn.activity) finalizeTools(turn.activity);
      ensureAsst();
      turn.asstMsg.streaming = true;
      enqueueStreamText(ev.delta);
      return;
    }
    // tool start → a running tool step (prior running tools check off)
    if (ev.type === 'tool_start') {
      const qc = buildQuestionCardModel(ev);
      if (qc) {
        if (turn.thinkStep) finalizeStep(turn.thinkStep);
        if (turn.activity) finalizeTools(turn.activity);
        const m = ensureAsst();
        m.questionCard = qc;         // rendered by surfaces.js / mobile-surfaces.js
        throttledRender();
        return;
      }
      if (turn.thinkStep) finalizeStep(turn.thinkStep);
      if (turn.activity) finalizeTools(turn.activity);
      const kind = toolKind(ev.tool);
      const st = newStep(kind, ev.command || ev.file || ev.path || ev.tool || '', ev.tool_id);
      st.cursor = true;
      chat.chatStrip = stripReducer(chat.chatStrip, ev);
      patchChatStrip(chat);
      throttledRender();
      return;
    }
    // tool output → append to the step's detail; exit_code finalizes it
    if (ev.type === 'tool_output') {
      let st = (ev.tool_id != null && turn.byTid[ev.tool_id]);
      if (!st) { for (let i = (turn.activity?.steps.length || 0) - 1; i >= 0; i--) { const c = turn.activity.steps[i]; if (c.kind !== 'think' && c.state === 'running') { st = c; break; } } }
      if (st) {
        if (typeof ev.output === 'string' && ev.output) {
          for (const line of ev.output.split('\n')) st.lines.push({ t: line, c: lineColor(line) });
          // Cap at the same 200-line ceiling the history path uses
          // (historySteps, above) — a chatty long-running tool (build log,
          // verbose test run) must not grow this step's lines/DOM/render cost
          // unbounded. Tail-keep: drop the OLDEST lines so what's visible is
          // always the most recent output, same as a scrollback buffer — and
          // track the cumulative omitted count so codeBlock() can render an
          // honest "…N earlier lines omitted" line instead of silently
          // hiding that a trim happened at all.
          if (st.lines.length > 200) {
            const trimmed = st.lines.length - 200;
            st.omitted = (st.omitted || 0) + trimmed;
            st.lines.splice(0, trimmed);
          }
        }
        if (ev.exit_code != null) {
          if (ev.exit_code !== 0) { st.meta = `exit ${ev.exit_code}`; st.metaColor = 'var(--red)'; }
          finalizeStep(st);
          if (ev.exit_code !== 0) st.state = 'error';
        }
        chat.chatStrip = stripReducer(chat.chatStrip, ev);
        patchChatStrip(chat);
        // Schedule an agent-linger sweep so the row disappears ~5s after done.
        scheduleStripSweep(chat);
        throttledRender();
      }
      return;
    }
    // agent_step / metrics / run_alive / stall: ignored
  };

  _lastOnEvent = onEvent;
  return { onEvent, ensureActivity };
}

// Test hook (Pillar A / Task 6): the current turn's onEvent, so
// chat-steer.test.js can feed a `user_steer` replay frame without a real
// SSE/postStream reader. Not used by production code.
export function __testOnEvent() { return _lastOnEvent; }

// active_doc_selection is capped server-side at 8 KB of UTF-8-encoded JSON
// (backend/draft_mode.py's SELECTION_MAX_BYTES). parse_selection there
// silently treats anything over that cap as "no selection", so an oversized
// selection would otherwise vanish from the turn entirely instead of still
// giving it a shorter hint. Trim rule: keep the whole {from,to,text} JSON
// payload under 7 KB (7168 UTF-8 bytes, one KB of margin under the server's
// hard cap, covering the small amount of JSON structure/escaping overhead
// around `text`), cutting `text` at the longest prefix that still fits once
// a trailing ellipsis is appended, never splitting a UTF-16 surrogate pair
// when choosing that cut point. `from` is kept as given; `to` is clamped to
// `from + text.length` after trimming so the shipped offsets describe the
// shipped text, not the original (pre-trim) selection.
export const SELECTION_TARGET_BYTES = 7 * 1024;
export function trimSelectionText(from, to, text) {
  const bytesOf = (t) => new TextEncoder().encode(JSON.stringify({ from, to, text: t })).length;
  if (bytesOf(text) <= SELECTION_TARGET_BYTES) return { from, to, text };
  const ELLIPSIS = '…';
  const safeCut = (n) => {
    if (n > 0 && n < text.length) {
      const code = text.charCodeAt(n - 1);
      if (code >= 0xd800 && code <= 0xdbff) return n - 1; // don't split a surrogate pair
    }
    return n;
  };
  const fits = (n) => bytesOf(text.slice(0, safeCut(n)) + ELLIPSIS) <= SELECTION_TARGET_BYTES;
  let lo = 0, hi = text.length; // fits(0) always true: the empty string plus overhead fits comfortably
  while (lo < hi) {
    const mid = lo + Math.ceil((hi - lo) / 2);
    if (fits(mid)) lo = mid; else hi = mid - 1;
  }
  const trimmedText = text.slice(0, safeCut(lo)) + ELLIPSIS;
  const trimmedTo = typeof from === 'number' ? from + trimmedText.length : to;
  return { from, to: trimmedTo, text: trimmedText };
}

// The active_doc_selection FormData field, or {} when there's nothing to
// attach (no doc, no editor selection, or an empty/whitespace selection),
// spread directly into fireSend/keepaliveSend's fields object. Shared so the
// trim rule above lives in exactly one place.
export function selectionField(docId, sel) {
  if (!docId || !sel || !sel.text) return {};
  return { active_doc_selection: JSON.stringify(trimSelectionText(sel.from, sel.to, sel.text)) };
}

// The network half of a send: detach any prior live reader, open a turn, and
// POST /api/chat_stream. Shared by the immediate path (dispatchSend) and the
// buffered composer flow (flushPending) — in both cases the optimistic bubble
// is already sitting in chat.thread by the time this runs.
function fireSend(sessionId, text, attachSnap) {
  const state = runtime.state;
  if (!state) return;
  const chat = ensureChat(state);
  const attachIds = (attachSnap || []).map((a) => a.id);
  // Sending is a user gesture — a good moment to ask for OS-notification
  // permission so a reply finishing while you're elsewhere can notify you.
  ensureNotifyPermission();

  // Detach any prior live reader. Safe now: the server-side recorder owns the
  // turn, so aborting the reader only drops THIS client's stream.
  stopLive();
  stopElapsed();

  const { onEvent, ensureActivity } = beginTurn(chat, chat.model, sessionId);
  // Immediate feedback: show the "Working…" spinner the moment we send, so the
  // model's warmup (claude-cli can take a few seconds before its first frame)
  // never looks like a dead, unresponsive turn.
  ensureActivity();
  flushRender();

  const docId = activeLibraryDocId();
  const sel = docId ? getSelection() : null;
  consumeAttachDetach();
  streamCtrl = postStream(
    '/api/chat_stream',
    {
      message: text,
      session: sessionId,
      mode: state.chatMode || 'agent',
      ...(attachIds.length ? { attachments: JSON.stringify(attachIds) } : {}),
      ...(state.incognito ? { incognito: 'true' } : {}),
      ...(docId ? { active_doc_id: docId } : {}),
      ...selectionField(docId, sel),
    },
    onEvent,
  );
}

// Steer: inject `text` into the RUNNING turn of `sessionId`. The optimistic
// bubble is already in the thread (marked steer:true). Success → nothing
// else to do here: the server appends a user_steer frame that every reader
// (this tab included, deduped by client_id) consumes, and the next delta
// opens a fresh assistant bubble. Failure → withdraw the bubble and either
// send normally (turn already ended) or queue (anything else).
async function fireSteer(sessionId, text, messageId) {
  const state = runtime.state;
  if (!state) return;
  const chat = ensureChat(state);
  let status = 0, body = null;
  try {
    const res = await fetch(`${location.origin}/api/chat/steer/${encodeURIComponent(sessionId)}`, {
      method: 'POST', credentials: 'same-origin',
      // keepalive: the whole point of a steer is that it lands in a turn that
      // is already running — if the tab is backgrounded or torn down between
      // the flush and this request, the browser must still deliver it.
      keepalive: true,
      body: (() => { const fd = new FormData(); fd.append('message', text); fd.append('client_id', messageId); return fd; })(),
    });
    status = res.status;
    try { body = await res.json(); } catch (_) { body = null; }
    if (res.ok) {
      const m = (chat.thread || []).find((x) => x.id === messageId);
      if (m && turn && turn.sessionId === sessionId) closeAsstBubbleForSteer(messageId);
      runtime.render();
      return;
    }
  } catch (_) { status = 0; body = null; }
  const idx = (chat.thread || []).findIndex((x) => x.id === messageId);
  if (idx >= 0) chat.thread.splice(idx, 1);
  if (steerFallback(status, body) === 'send') {
    // no_active_turn: the server just told us, authoritatively, that this
    // session's turn is already over — the client's local `turn` slot may
    // still look busy (its stream reader hasn't seen 'done' yet). Fire
    // immediately via the same unbuffered path flushQueuedFor uses for
    // "turn just ended, send the next one now" (dispatchSend), not another
    // 700ms-buffered submitFromComposer — the message already sat through
    // one buffer window during the steer attempt.
    await dispatchSend(text, []);
  } else {
    chat.queuedList = [...(chat.queuedList || []), { sid: sessionId, text, attachSnap: [] }];
    syncQueuedView(chat);
    toast('Could not steer the running turn. Queued to send when it finishes.');
  }
  runtime.render();
}

// Ensure a session exists for the active chat, creating one on first send.
// Returns the session id, or null if creation failed.
async function ensureSessionId(chat) {
  if (chat.activeId) return chat.activeId;
  try {
    const id = await createSession(chat.model, chat.endpointId);
    if (!id) return null;
    chat.activeId = id;
    storeActiveId(id);
    // Surface the brand-new thread in the sidebar IMMEDIATELY — don't wait for
    // the turn's `done` event (refreshSidebarUsage) to rebuild the list. Fire
    // and forget so it never delays the send; the row appears the moment you
    // send, so leaving the thread before the reply lands still lets you find
    // it in the conversations list.
    refreshSidebarUsage(runtime.state).catch(() => {});
    return id;
  } catch (_) {
    return null;
  }
}

// The unbuffered send: optimistic user bubble + immediate POST /api/chat_stream.
// Used by the queued-message auto-send (flushQueuedFor), which already had its own
// review pass in the composer before it got queued. Assumes the caller already
// cleared the draft/pendingAttach.
async function dispatchSend(text, attachSnap) {
  const state = runtime.state;
  if (!state) return;
  const chat = ensureChat(state);
  const attachIds = (attachSnap || []).map((a) => a.id);
  if (!text && !attachIds.length) return;

  if (!(await flushDocBeforeSend())) return;

  const sessionId = await ensureSessionId(chat);
  if (!sessionId) return;

  if (!Array.isArray(chat.thread)) chat.thread = [];
  chat.thread.push({ id: uniqId('live-u-'), role: 'user', text, time: fmtTime(Date.now()), attach: attachSnap || [] });
  chat.chatStrip = stripOnUserSend(chat.chatStrip);
  clearBranchPrefixIfStarted(state, chat);
  runtime.wantChatBottom = true;   // jump to your just-sent message + the reply
  runtime.render();

  fireSend(sessionId, text, attachSnap);
}

// ---- composer send-buffer (700ms edit window) ------------------------------
// Gives Frank a brief window to fix a just-sent message before it actually
// hits the gateway. The optimistic bubble renders immediately — with a
// draining countdown ring (see chatMsg's m._optimistic branch in surfaces.js)
// — while the real POST is deferred until the buffer elapses or something
// explicitly flushes it early (a second send, or Task 8's Save & Send).
const BUFFER_MS = 700;

// Fix wave, I1: a doc-bound turn makes the backend read the vault file from
// disk (draft_mode.pre_turn snapshots it as the undo, post_turn_payload
// diffs against it), and its docstring assumes the SPA saved first. So
// whenever the open Library document will ride along as active_doc_id, wait
// for its pending autosave to land before the request is built. On a failed
// or conflicted save, abort the send instead of pointing the turn at a file
// that does not hold what the user is looking at. Returns true when the
// caller may proceed. keepaliveSend deliberately does NOT call this: it runs
// from a pagehide teardown where the document may be gone before any await
// resolves, so it stays a single synchronous fire-and-forget POST.
async function flushDocBeforeSend() {
  if (!activeLibraryDocId()) return true;
  if (flushOk(await flushBeforeSend())) return true;
  toast('Could not save the document, so nothing was sent. Fix the save first.');
  return false;
}

// Buffered composer submit: append the optimistic bubble now (with
// `_optimistic`/`_deadline` so it renders the countdown ring + the Edit
// affordance), and defer the real network fire for BUFFER_MS. Returns false
// ONLY when the session couldn't be created (offline first send in a new
// chat) so the caller can restore the draft — every other early exit means
// "nothing to send" and returns true.
async function submitFromComposer(text, attachSnap, opts = {}) {
  const state = runtime.state;
  if (!state) return true;
  const chat = ensureChat(state);
  const attachIds = (attachSnap || []).map((a) => a.id);
  if (!text && !attachIds.length) return true;

  // Fix wave, I1: save the attached document before anything else, including
  // the optimistic bubble, so an aborted send leaves no bubble behind.
  if (!(await flushDocBeforeSend())) return 'flush-failed';

  // A message is already buffered → flush it now, in submission order, before
  // this new one claims its own buffer window.
  if (chat.pendingSend) flushPending(chat.pendingSend.sessionId);

  const sessionId = await ensureSessionId(chat);
  if (!sessionId) return false;

  // OPEN shelf: the server stamps `opened` on this send (app.py chat_stream);
  // mirror it now so the row moves up without waiting for the next reload.
  // F1: stamp the local overlay by id FIRST, unconditionally -- a brand-new
  // chat's very first send has no `rec` yet (ensureSessionId's own sessions
  // refetch is still in flight), so keying only off `rec` lost the stamp
  // when that refetch landed with opened:null. The overlay (see
  // rebuildGroups/_pruneOpenedLocal) survives that race regardless.
  chat.openedLocal.set(sessionId, Date.now());
  const rec = (chat.sessions || []).find((s) => s.id === sessionId);
  if (rec) { rec.opened = Date.now(); rebuildGroups(chat); }

  const messageId = uniqId('live-u-');
  const deadline = Date.now() + BUFFER_MS;
  if (!Array.isArray(chat.thread)) chat.thread = [];
  chat.thread.push({
    id: messageId, role: 'user', text, time: fmtTime(Date.now()), attach: attachSnap || [],
    _optimistic: true, _deadline: deadline, steer: !!opts.steer,
  });
  chat.pendingSend = { messageId, text, attachSnap: attachSnap || [], sessionId, deadline, timerId: 0, steer: !!opts.steer };
  chat.chatStrip = stripOnUserSend(chat.chatStrip);
  clearBranchPrefixIfStarted(state, chat);
  runtime.wantChatBottom = true;
  // The countdown ring's drain is a pure CSS animation keyed off its own
  // mount time (see .msg-pending-ring / @keyframes ring-drain in
  // redesign.css) — no rAF re-render loop needed here. This one render()
  // mounts the ring; the only other render this buffer window needs is the
  // flush below.
  runtime.render();
  chat.pendingSend.timerId = setTimeout(() => flushPending(sessionId), BUFFER_MS);
  return true;
}

// Cross-session pagehide flush (see flushPending below): fire a best-effort,
// fire-and-forget POST to /api/chat_stream so the server starts + records the
// turn, WITHOUT opening any local turn state (no beginTurn, no streamCtrl, no
// reader). This is a REQUEST-only replica of what fireSend() posts to the
// SAME endpoint — same FormData shape, same credentials — it just never reads
// the response body, because by the time it would matter the page may already
// be gone. `keepalive: true` is what lets the browser actually deliver the
// request across an unload/backgrounding instead of cancelling it with the
// document (this is also why it's a plain fetch and not postStream: opening a
// stream reader here would be pointless work the teardown can't use).
// navigator.sendBeacon was considered but rejected — chat_stream is a
// multipart POST expecting a streamed SSE response, not the small text/blob
// beacon is meant for, and sendBeacon can't carry the fields as multipart
// form data the backend already parses. Errors are swallowed: there is no
// local state left here to revert into by the time this settles.
function keepaliveSend(sessionId, text, attachSnap, state) {
  const attachIds = (attachSnap || []).map((a) => a.id);
  const docId = activeLibraryDocId();
  const sel = docId ? getSelection() : null;
  consumeAttachDetach();
  const fields = {
    message: text,
    session: sessionId,
    mode: (state && state.chatMode) || 'agent',
    ...(attachIds.length ? { attachments: JSON.stringify(attachIds) } : {}),
    ...(state && state.incognito ? { incognito: 'true' } : {}),
    ...(docId ? { active_doc_id: docId } : {}),
    ...selectionField(docId, sel),
  };
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v != null) fd.append(k, v);
  try {
    fetch('/api/chat_stream', {
      method: 'POST', credentials: 'same-origin', body: fd, keepalive: true,
    }).catch(() => { /* best-effort — nothing left to revert into */ });
  } catch (_) { /* fetch unavailable / threw synchronously — best effort only */ }
}

// Fires a buffered send early — timer expiry, a second send arriving, or (in
// Task 8) an explicit Save & Send mid-edit. Clears pendingSend + the
// optimistic flags before handing off to fireSend, so msgTools' canEdit
// predicate flips false (the Edit button disappears) the instant this runs.
// Exported (Task 3.5) so mobile edit-flow.js's Cancel can re-arm a real
// network flush via its injectable `io` hook.
export function flushPending(sessionId, opts) {
  const state = runtime.state;
  if (!state) return;
  const chat = ensureChat(state);
  const p = chat.pendingSend;
  if (!p) return;
  if (p.timerId) clearTimeout(p.timerId);
  chat.pendingSend = null;
  const sid = sessionId || p.sessionId;
  const busy = !!(turn && turn.sessionId === sid);
  const crossView = sid !== chat.activeId;
  const isPagehide = !!(opts && opts.pagehide);

  // Cross-session pagehide: the page is backgrounding/tearing down (iOS
  // Safari's pagehide-with-survival case included — see the listener below),
  // and this pendingSend belongs to a DIFFERENT session than the one on
  // screen. A regular fireSend()/beginTurn() here would bind the assistant
  // bubble into whatever thread IS currently displayed — send in A, switch to
  // B, background within the buffer window, and A's reply streams into B's
  // view on foregrounding. There's no view to fire into safely, so don't open
  // any local turn state at all: no beginTurn, and — critically — no queue
  // entry either (the in-memory queue may well survive an iOS suspend, and
  // queuing here on top of the keepalive POST below would double-send once
  // that thread is next viewed). Just get the request out the door; the
  // server records the turn, and the notifier/reconcile machinery re-attaches
  // it correctly the next time this session is actually opened.
  if (isPagehide && crossView && !busy) {
    const idx = (chat.thread || []).findIndex((m) => m.id === p.messageId);
    if (idx >= 0) chat.thread.splice(idx, 1);
    keepaliveSend(sid, p.text, p.attachSnap, state);
    return;
  }

  // Divert to the session-keyed queue instead of firing when either:
  //  - Busy gate: a turn is already live for this thread (e.g. the PREVIOUS
  //    send flushed at the top of this same buffer window). Firing a second
  //    POST now would be rejected server-side (busy_stream) — after fireSend
  //    had already aborted the live turn's reader, wrecking both turns.
  //  - View gate: the user switched threads inside the buffer window (and
  //    this ISN'T the cross-session-pagehide case handled above). fireSend →
  //    beginTurn binds the assistant bubble to the CURRENT chat view, so
  //    firing now would stream the reply into whatever thread is on screen.
  // Either way, the optimistic bubble comes out of the thread (the queued
  // banner represents it now) and the message auto-sends via flushQueuedFor
  // the next time its own thread is active and idle.
  if (busy && p.steer && !crossView) {
    // Steer path: the optimistic bubble STAYS (it is the steer message) and the
    // POST goes to /api/chat/steer instead of opening a second turn.
    const msg = (chat.thread || []).find((m) => m.id === p.messageId);
    if (msg) { delete msg._optimistic; delete msg._deadline; }
    // Render before the POST so the countdown ring disappears the instant the
    // buffer window closes, rather than a network round-trip later.
    runtime.render();
    fireSteer(sid, p.text, p.messageId).catch(() => { /* fireSteer handles its own fallbacks */ });
    return;
  }
  if (busy || (crossView && !isPagehide)) {
    const idx = (chat.thread || []).findIndex((m) => m.id === p.messageId);
    if (idx >= 0) chat.thread.splice(idx, 1);
    chat.queuedList = [...(chat.queuedList || []), { sid, text: p.text, attachSnap: p.attachSnap }];
    syncQueuedView(chat);
    runtime.render();
    return;
  }
  const msg = (chat.thread || []).find((m) => m.id === p.messageId);
  // The turn this message was going to steer ENDED inside the buffer window,
  // so it falls through to the normal send path and starts a brand-new turn.
  // Drop the steer flag with it — captioning a fresh turn's first message
  // "Steered into the running turn" would be a lie.
  if (msg) {
    msg.text = p.text;
    delete msg._optimistic; delete msg._deadline;
    delete msg.steer; delete msg.steerNotice;
  }
  runtime.render();
  fireSend(sid, p.text, p.attachSnap);
}

// A buffered send that's still sitting in its 700ms window when the tab
// closes was, until now, silently dropped: the setTimeout backing it never
// fires because the page is gone, so the "sent" optimistic bubble the user
// saw never actually hit the gateway. `pagehide` fires reliably on tab
// close/navigation (and, as a bonus, on iOS Safari backgrounding, which never
// fires 'unload'); flush synchronously so the request goes out before the
// page tears down. Guarded for non-browser test environments, where
// `window.addEventListener` doesn't exist.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', () => {
    const state = runtime.state;
    const chat = state && state.live && state.live.chat;
    if (chat && chat.pendingSend) flushPending(chat.pendingSend.sessionId, { pagehide: true });
  });
}

// When a turn ends, fire the next message the user queued FOR THAT SESSION
// while it was streaming. Session-keyed: an entry queued in thread A never
// fires into thread B — it only dispatches when its own thread is the active
// one (dispatchSend posts into chat.activeId) and no turn is live for it.
// One entry per call: if more are queued, each subsequent turn-end flushes the
// next, so they never race each other into a busy_stream rejection. Deferred
// a microtask so the current turn teardown (turn = null) settles before
// dispatchSend opens the next one.
function flushQueuedFor(chat, sid) {
  if (!chat || !sid) return;
  if (chat.activeId !== sid) return;          // only fire into its own, visible thread
  if (turn && turn.sessionId === sid) return; // a turn already owns this thread
  const { taken, rest } = queueTake(chat.queuedList, sid);
  if (!taken) return;
  chat.queuedList = rest;
  syncQueuedView(chat);
  // A queued retry that the server ALREADY recorded (network-hiccup dupe:
  // POST landed, ES died, user resent, reconcile-finalize-stale pulled the
  // server truth). Firing again would double-post + double-bubble. The last
  // user message in server truth is either this one (drop the queued retry)
  // or a different message (fire normally).
  const thread = chat.thread || [];
  for (let i = thread.length - 1; i >= 0; i--) {
    const m = thread[i];
    if (!m || m.role !== 'user') continue;
    if ((m.text || '') === (taken.text || '') && (taken.text || '').length > 0) {
      try { console.warn('[chat] dropped queued retry — server truth already has this message'); } catch (_) {}
      syncQueuedView(chat);
      return;
    }
    break; // most recent user message differs → real new send, fire it
  }
  Promise.resolve().then(() => dispatchSend(taken.text, taken.attachSnap));
}

// Route a message into the session-keyed queue from OUTSIDE the send paths —
// mobile edit-flow's cross-session Cancel (mobile/edit-flow.js, wired through
// app.js's io hooks). The user cancelled an edit after switching threads, so
// the restored message must NOT be spliced into the viewed thread; it queues
// for its own session and fires through the normal plumbing the next time
// that thread is active and idle (selectSession → flushQueuedFor). Toasts so
// the "where did my message go?" moment has an answer.
export function queueForSession(sid, text, attachSnap) {
  const state = runtime.state;
  if (!state || !sid) return;
  const chat = ensureChat(state);
  chat.queuedList = [...(chat.queuedList || []), { sid, text: text || '', attachSnap: attachSnap || [] }];
  syncQueuedView(chat);
  toast('Message will send in its original chat.');
  runtime.render();
}

// Parse one stored SSE payload (the raw string event_store kept, e.g.
// "data: {...}\n\n" or "data: [DONE]\n\n") into a reducer event, or null.
function parseStoredSSE(raw) {
  for (const line of String(raw || '').split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return { type: 'done' };
    try { return JSON.parse(payload); } catch (_) { return null; }
  }
  return null;
}

// Tear down frozen local live state truthfully. `interrupted` = the backend's
// durable ledger says the turn died with the process (restart) — annotate the
// bubble instead of pretending it finished.
function finalizeLocal(chat, interrupted) {
  stopLive();
  const sid = turn ? turn.sessionId : null;   // capture before teardown
  const a = turn && turn.activity;
  if (a) {
    finalizeAll(a);
    a.status = 'done';
    a.resync = false;
    a.elapsed = fmtElapsed(a.startMs);
    a.worked = interrupted
      ? `Interrupted after ${a.elapsed} · ${a.steps.length} steps`
      : `Worked for ${a.elapsed} · ${a.steps.length} steps`;
  }
  if (interrupted && turn && turn.asstMsg) {
    turn.asstMsg.error = true;
    turn.asstMsg.notice = 'This turn was interrupted by a backend restart — the reply may be incomplete.';
  }
  setLiveTurn(null);
  chat.busySessionId = null;
  turn = null;
  stopElapsed();
  if (chat.chatStrip) { chat.chatStrip = stripOnTurnDone(chat.chatStrip); patchChatStrip(chat); }
  flushRender();
  // Rescue a queued message on the interrupted path, mirroring the 'error'
  // handler: session state is uncertain, so recall to the composer rather
  // than auto-firing into a possibly-broken session. (The stale flavor's
  // flushQueuedFor lives in reconcileTurn, AFTER its thread refetch settles —
  // flushing here would race dispatchSend's optimistic bubbles against the
  // refetch's chat.thread reassignment and leave the auto-sent turn invisible.)
  // Keyed to the INTERRUPTED turn's session, same as the error handler: only
  // touch the draft when that session is the one on screen; otherwise its
  // entry stays queued for its own thread.
  if (interrupted && sid && sid === chat.activeId && queueHead(chat.queuedList, sid)) {
    actions.queueRecall();
  }
}

// THE single authority for "is this turn alive?". Every caller that used to
// carry its own partial logic (visibility restore, notifier tick, EventSource
// death, hb-gap watchdog, thread open) routes through here. Exactly one
// outcome per call: attach the live tail, finalize local state (stale or
// interrupted), or nothing.
// Today's dropped-connection behavior: annotate the bubble with a retry notice
// and recall the queued message to the composer so the user can resend. Factored
// out of the 'error' handler so the recovery path (recoverDroppedTurn) can fall
// back to it only when server truth says the turn did NOT finish cleanly.
function showDroppedError(chat, errSid, m, status) {
  if (m) {
    m.error = true;
    m.notice = status
      ? `Gary couldn’t connect (${status}). Your message is ready — tap Send to retry.`
      : 'The connection dropped before a response arrived. Your message is ready — tap Send to retry.';
  }
  chat.suggest = null;
  // Amendment C (Phase 2 final re-review): a send that never made it must not
  // leave a stale OPEN-shelf overlay stamp behind (chat.openedLocal), or the
  // row would otherwise sit pinned to OPEN with no server-side `opened` backing it.
  if (errSid && chat.openedLocal) chat.openedLocal.delete(errSid);
  rebuildGroups(chat);
  // Keyed to the ERRORING session, not the active view: a background thread's
  // error must never clobber the draft (or steal the queued entry) of whatever
  // thread is on screen.
  if (errSid && errSid === chat.activeId && queueHead(chat.queuedList, errSid)) {
    actions.queueRecall();
  }
  flushRender();
}

// A statusless connection drop does NOT mean the turn died — event_store owns
// the turn, not the POST reader. One snapshot fetch, then droppedTurnAction
// triages three cases (see dropped-turn-decision.js):
//   'reattach' — turn STILL running: re-attach to the live event_store tail and
//                keep streaming. Without this the partial reply the user was
//                reading is abandoned ("streaming then disappears") even though
//                the turn completes fine server-side.
//   'recover'  — turn FINISHED cleanly while our reader was dead: pull the real
//                reply from server truth and suppress the retry (no dup turn).
//   'error'    — ambiguous: resolve false so the caller shows error+recall.
// Resolves true when it re-attached OR rendered the finished reply; false = let
// the caller fall back to showDroppedError. Never starts a turn, never loses a
// message.
async function recoverDroppedTurn(chat, sid, staleMsg) {
  let snap = null;
  try {
    snap = await apiGet(`/api/chat/turn?session=${encodeURIComponent(sid)}`);
  } catch (_) { return false; /* backend unreachable → fall back to retry path */ }
  if (chat.activeId !== sid) return false;  // user switched threads mid-await
  const action = droppedTurnAction(snap);
  if (action === 'reattach') {
    // The error handler already tore the local turn down (turn = null) and left
    // its partial assistant bubble orphaned in the thread. attachTurn rebuilds
    // the turn from its start out of event_store, so drop that orphan first or
    // it renders as a duplicate. (activeId was just re-checked with no await
    // since, so attachTurn won't early-return here.)
    if (staleMsg && Array.isArray(chat.thread)) {
      const i = chat.thread.indexOf(staleMsg);
      if (i >= 0) chat.thread.splice(i, 1);
    }
    // attachTurn replays the partial the dead reader had shown then
    // EventSource-tails the rest — the same machinery reconcileTurn uses for
    // refresh / switch-away-and-back.
    try { return await attachTurn(chat, runtime.state, sid, snap); }
    catch (_) { return false; }
  }
  if (action !== 'recover') return false;
  try {
    const t = await fetchThread(sid, chat.model, chat.title);
    const thread = dedupeAdjacentUserMessages(t.thread, 'dropped-recover');
    const last = thread[thread.length - 1];
    // Require an actual assistant reply as the tail — otherwise there's nothing
    // to show and the user still needs the retry path.
    if (!last || last.role !== 'assistant' || !(last.text || '').trim()) return false;
    chat.thread = thread;
    chat.subtitle = t.subtitle || chat.subtitle;
    flushRender();
    return true;
  } catch (_) { return false; }
}

let _reconcileBusy = false;
async function reconcileTurn(chat, state, sessionId) {
  if (!sessionId || _reconcileBusy) return false;
  _reconcileBusy = true;
  try {
    let snap = null;
    try {
      snap = await apiGet(`/api/chat/turn?session=${encodeURIComponent(sessionId)}`);
    } catch (_) { return false; /* backend unreachable — next trigger retries */ }
    const decision = reconcileDecision({
      active: !!(snap && snap.active),
      lastTurnStatus: (snap && snap.last_turn && snap.last_turn.status) || null,
      hasLocalLive: !!(turn || liveES),
      localSessionMatches: !turn || turn.sessionId === sessionId,
      // Healthy = a live SOURCE is still attached (POST reader or ES tail) AND
      // frames arrived within the hb-gap window. A healthy local turn must NOT
      // be re-attached over (duplicate bubble); a dead pipe must (hb watchdog,
      // CLOSED EventSource — both null their source or age lastFrameMs out).
      localFresh: !!(turn && (streamCtrl || liveES) && turn.lastFrameMs
        && (Date.now() - turn.lastFrameMs) < HB_GAP_MS),
    });
    if (decision === 'attach') return attachTurn(chat, state, sessionId, snap);
    if (decision === 'finalize-interrupted') {
      // Keep the annotated local bubble — the partial text + restart notice IS
      // the honest record; the gateway transcript may have nothing better.
      finalizeLocal(chat, true);
    }
    // Fresh-load after an error turn: no local bubble, but event_store has the
    // partial delta frames. Replay them so the user sees what was streamed rather
    // than a blank thread. The decision tree returns 'none' here (no local live
    // state), so we handle this case explicitly after reconcileDecision.
    if (decision === 'none' && !snap.active && snap.last_turn && snap.last_turn.status === 'interrupted'
        && snap.events && snap.events.length > 0 && !(turn || liveES)) {
      const { onEvent } = beginTurn(chat, chat.model, sessionId);
      for (const e of snap.events) {
        const ev = parseStoredSSE(e.data);
        if (ev) onEvent(ev);
      }
      // finalizeLocal here only if beginTurn didn't already finalize (i.e. no
      // 'done' frame was in the events). Check via turn still being set.
      if (turn) finalizeLocal(chat, true);
      flushRender();
      return false;
    }
    if (decision === 'finalize-stale') {
      // The turn ended normally while we were detached: the real reply lives
      // server-side. Finalize, then refetch the thread so we never leave a
      // half-rendered answer (spec: "finalize with the real reply").
      finalizeLocal(chat, false);
      if (chat.activeId === sessionId) {
        try {
          const t = await fetchThread(sessionId, chat.model, chat.title);
          chat.thread = dedupeAdjacentUserMessages(t.thread, 'reconcile:finalize-stale');
          chat.subtitle = t.subtitle || chat.subtitle;
          flushRender();
        } catch (_) { /* keep the finalized local state; next trigger retries */ }
        // Auto-send the queued follow-up ('done'-handler precedent) only AFTER
        // the refetch settles (success or catch): dispatchSend pushes the
        // optimistic user bubble + beginTurn's asstMsg into chat.thread, and a
        // still-pending refetch would replace the array wholesale, leaving the
        // whole auto-sent turn invisible. Session-keyed: only entries queued
        // FOR this session fire, and flushQueuedFor re-checks activeId itself,
        // so a mid-reconcile thread switch can't fire the message into the
        // wrong thread. Not stranded on mismatch: selectSession keeps
        // chat.queuedList intact and re-flushes on return to this thread.
        flushQueuedFor(chat, sessionId);
      }
    }
    return false;
  } finally { _reconcileBusy = false; }
}

// Re-attach to a turn that's still running server-side for `sessionId` (the
// visible win: refresh / switch-away-and-back keeps streaming). Returns true if
// it attached. Called only by `reconcileTurn` once it has already fetched the
// snapshot and decided the turn is live — replays the turn's events to rebuild
// the in-flight answer, then EventSource-tails the remainder from
// last_event_id until [DONE].
async function attachTurn(chat, state, sessionId, snap) {
  // Guard against a thread-switch that raced the snapshot fetch.
  if (chat.activeId !== sessionId) return false;

  stopLive();
  stopElapsed();
  // Superseding a stale local turn for this SAME session: its partial
  // assistant bubble would sit above the replayed rebuild as a duplicate
  // (stuck with streaming:true). The replay below reconstructs the turn from
  // its start, so drop the superseded bubble — and any pending-token mappings
  // that point at it, so replayed token.added frames re-bind to the fresh one.
  if (turn && turn.sessionId === sessionId && turn.asstMsg) {
    const i = (chat.thread || []).indexOf(turn.asstMsg);
    if (i >= 0) chat.thread.splice(i, 1);
    for (const [tid, m] of _pendingByTurnId) {
      if (m === turn.asstMsg) _pendingByTurnId.delete(tid);
    }
  }
  // Stop-then-failed-POST dedupe: stopRun tears the local turn down
  // (turn = null) but leaves its finalized bubble in the thread. If the stop
  // never landed server-side, the notifier re-attaches ~4s later and the
  // replay below rebuilds the SAME turn from its start — remove the stopped
  // bubble (and its pending-token bindings) so the rebuilt one doesn't render
  // as a duplicate. One-shot: consumed here, refreshed by the next stopRun.
  if (lastStopped && lastStopped.sessionId === sessionId) {
    const i = (chat.thread || []).findIndex((m) => m && m.id === lastStopped.msgId);
    if (i >= 0) chat.thread.splice(i, 1);
    for (const [tid, m] of _pendingByTurnId) {
      if (m && m.id === lastStopped.msgId) _pendingByTurnId.delete(tid);
    }
    lastStopped = null;
  }
  // This replay rebuilds the SAME turn the mid-turn ghost came from — carry
  // it across beginTurn's clear (see suggestSurvivesReattach). A done/error
  // frame in the replayed tail re-clears it, same as it would have live.
  const keptSug = suggestSurvivesReattach(chat.suggest, sessionId) ? chat.suggest : null;
  const { onEvent, ensureActivity } = beginTurn(chat, chat.model, sessionId);
  if (keptSug) chat.suggest = keptSug;
  ensureActivity();            // immediate "Working…" while we rebuild + tail
  // Continue the "Working… Ns" clock from the turn's TRUE start (server-computed
  // elapsed) instead of restarting at 0 on re-attach. Anchored to the client
  // clock via Date.now() so there's no client/server skew.
  if (typeof snap.elapsed_ms === 'number' && turn && turn.activity) {
    turn.activity.startMs = Date.now() - snap.elapsed_ms;
    turn.activity.elapsed = fmtElapsed(turn.activity.startMs);
  }
  for (const e of (snap.events || [])) {
    const ev = parseStoredSSE(e.data);
    if (ev) onEvent(ev);
  }
  flushRender();

  const cursor = snap.last_event_id || '';
  const url = `/api/chat/stream?session=${encodeURIComponent(sessionId)}` +
    (cursor ? `&last_event_id=${encodeURIComponent(cursor)}` : '');
  const es = new EventSource(location.origin + url, { withCredentials: true });
  liveES = es;
  es.onmessage = (e) => {
    if (liveES !== es) return;                 // superseded by a newer attach
    if (e.data === '[DONE]') { onEvent({ type: 'done' }); es.close(); if (liveES === es) liveES = null; return; }
    let ev = null; try { ev = JSON.parse(e.data); } catch (_) {}
    if (ev) onEvent(ev);
  };
  es.onerror = () => {
    if (liveES !== es) return;               // superseded by a newer attach
    // CONNECTING: native auto-reconnect (with Last-Event-ID) is handling it.
    // CLOSED: the browser gave up — only a fresh snapshot can tell us whether
    // the turn is still running. Reconcile.
    if (es.readyState === EventSource.CLOSED) {
      liveES = null;
      setTimeout(() => {
        const st = runtime.state;
        const c = st && st.live && st.live.chat;
        if (c) reconcileTurn(c, st, sessionId);
      }, 1000);
    }
  };
  return true;
}

// ---- visibility / focus re-sync -------------------------------------------
// A backgrounded tab throttles rAF/timers and can silently drop the SSE tail
// (readyState stays OPEN but no bytes arrive). And even for the currently-
// visible thread, a turn that *ends* while we're away leaves local `liveES` /
// `turn` still set — so the UI shows a working state that never finalizes
// until a manual refresh. On visibility restore, snapshot-replay the active
// chat's server state: `reconcileTurn` closes a stale ES and re-tails from the
// last cursor if there's still a turn, or finalizes local state (clearing the
// chat-strip so the UI unfreezes) if not.
let _visSyncWired = false;
let _visSyncInFlight = false;
async function _syncActiveOnVisible() {
  if (_visSyncInFlight) return;
  const state = runtime.state;
  const chat = state && state.live && state.live.chat;
  if (!chat || !chat.activeId) return;
  _visSyncInFlight = true;
  try {
    await reconcileTurn(chat, state, chat.activeId);
  } catch (_) { /* non-fatal — next visibility flip retries */ }
  finally { _visSyncInFlight = false; }
}
function wireVisibilityResume() {
  if (_visSyncWired) return;
  _visSyncWired = true;
  try {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) _syncActiveOnVisible();
    });
    window.addEventListener('focus', _syncActiveOnVisible);
  } catch (_) { /* environments without document/window: harmless */ }
}
wireVisibilityResume();

// ---- heartbeat-gap watchdog -------------------------------------------------
// The backend emits an hb frame every ~10s while a turn records, and every
// frame refreshes turn.lastFrameMs. A live turn with no frame for 25s means
// the pipe is probably dead (throttled tab, dropped SSE, killed backend):
// show "Re-syncing…" and ask /api/chat/turn for the truth.
const HB_GAP_MS = 25000;
let _hbWatchTimer = null;
function startHbWatchdog() {
  if (_hbWatchTimer) return;
  _hbWatchTimer = setInterval(() => {
    if (!turn || !turn.lastFrameMs) return;   // warmup: no frame yet, no verdict
    const gap = Date.now() - turn.lastFrameMs;
    if (gap < HB_GAP_MS) {
      if (turn.activity && turn.activity.resync) { turn.activity.resync = false; throttledRender(); }
      return;
    }
    if (turn.activity && !turn.activity.resync) { turn.activity.resync = true; throttledRender(); }
    const state = runtime.state;
    const chat = state && state.live && state.live.chat;
    if (chat && turn.sessionId) reconcileTurn(chat, state, turn.sessionId);
  }, 5000);
  // Node (tests import this module without a browser event loop to keep alive)
  // returns a Timeout with .unref(); browsers return a bare number with no such
  // method. Unref so importing this module never blocks a test process on a
  // timer that's only ever meant to run in a live tab.
  if (_hbWatchTimer && typeof _hbWatchTimer.unref === 'function') _hbWatchTimer.unref();
}
startHbWatchdog();

// ---- cross-session turn notifier ------------------------------------------
// Poll which sessions have a turn in flight. When one FINISHES while you're not
// viewing it, flag it (sidebar + Chats-nav dot, plus a haptic buzz) — classic-
// interface parity for "a reply landed while I was elsewhere". Cleared when you
// open that thread. Also marks still-running sessions with a 'working' dot.
let _notifyTimer = null;
let _prevActive = new Set();
// Set when a poll fails (network blip, backend restart mid-request) — the
// NEXT successful poll just reconnected after an unknown-length gap, so the
// diff against _prevActive can't be trusted as "these sessions finished
// while you watched"; it may just mean we missed however many ticks the
// outage spanned. Guards the finished-toast heuristic below, same as the
// mass-collapse guard it sits next to.
let _feedWasDown = false;

function _isViewing(state, id) {
  return !!(state && state.surface === 'chat'
    && state.live && state.live.chat && state.live.chat.activeId === id);
}

// Rider (task-w6): whether a batch of simultaneously-finished turns should be
// treated as restart noise (suppressed) or genuine completions (toasted).
// Pure + exported so the tradeoff below is unit-testable without the poll
// timer machinery. See _notifyTick for the surrounding context.
//
// A mass-drop (many sessions finishing in the very same 4s tick) is almost
// certainly a backend restart clearing the whole active-session ledger at
// once, not that many independent legitimate completions landing together —
// the two are indistinguishable from the poll's shape alone, so a drop of
// MORE than 2 stays suppressed. Exactly 1-2 simultaneous drops, when the feed
// did NOT just reconnect (an unknown-length gap has the same untrustworthy
// shape as a restart), are now surfaced: two replies landing in the same
// poll window is an ordinary thing on a multi-thread day, and silently
// swallowing it costs more than the rare false positive of a ≤2-session
// restart getting toasted as if it were real. Tradeoff, accepted: a backend
// restart that happens to have exactly 1 or 2 turns in flight will still
// toast (indistinguishable from 1-2 genuine finishes with the information
// available here) — cheap to reason about, cheap to revisit if it's wrong.
export function shouldSuppressFinishedToasts(droppedCount, justReconnected) {
  return !!justReconnected || droppedCount > 2;
}

async function _notifyTick() {
  const state = runtime.state;
  if (!state) return;
  let data;
  try { data = await apiGet('/api/chat/active_sessions'); }
  catch (_) { _feedWasDown = true; return; }
  const now = new Set((data && data.active) || []);
  const chat = ensureChat(state);
  chat.notified = chat.notified || new Set();
  let changed = false;

  const justReconnected = _feedWasDown;
  _feedWasDown = false;
  const dropped = [..._prevActive].filter((id) => !now.has(id));
  // See shouldSuppressFinishedToasts, above, for the full tradeoff writeup.
  const suppressFinishedToasts = shouldSuppressFinishedToasts(dropped.length, justReconnected);

  // A session that WAS running and now isn't — and that you aren't looking at —
  // just finished while you were elsewhere: notify.
  if (!suppressFinishedToasts) {
    for (const id of dropped) {
      if (!_isViewing(state, id) && !chat.notified.has(id)) {
        chat.notified.add(id);
        changed = true;
        try { if (navigator.vibrate) navigator.vibrate(30); } catch (_) { /* no haptics */ }
        notifyTurnDone(chat, id);   // in-app toast + OS notification (if permitted)
      }
    }
  }
  // Re-render if the running set changed too (working dots).
  const prevWorking = chat.activeTurns || new Set();
  if (!changed && (now.size !== prevWorking.size
      || [...now].some((id) => !prevWorking.has(id)))) changed = true;

  chat.activeTurns = now;
  // A turn started server-side in the thread you're LOOKING at (a follow-up
  // promise firing) — attach the live tail so it streams in like any turn.
  // liveES/turn guards: skip when a tail is already attached or this client
  // is mid-send (its own POST is the stream). _notifyResuming closes the race
  // where reconcileTurn's initial fetch outlives the poll interval (liveES/turn
  // are only set after it) and a second tick would fire a concurrent attach.
  if (!liveES && !turn && chat.activeId && _notifyResuming !== chat.activeId
      && now.has(chat.activeId) && _isViewing(state, chat.activeId)) {
    _notifyResuming = chat.activeId;
    reconcileTurn(chat, state, chat.activeId)
      .catch(() => { /* non-fatal: next tick retries */ })
      .finally(() => { _notifyResuming = null; });
  }
  _prevActive = now;
  if (changed) { rebuildGroups(chat); runtime.render(); }
}

// Start the poller once (singleton). Called from load() at boot.
function startNotifier() {
  if (_notifyTimer) return;
  _notifyTimer = setInterval(_notifyTick, 4000);
  _notifyTick();
}

// --- notification surfacing (in-app toast + OS notification) ----------------
function _titleFor(chat, id) {
  for (const g of (chat.groups || [])) for (const r of (g.rows || [])) if (r.id === id) return r.title;
  return null;
}

// Switch to the chat surface and open a thread (toast / OS-notification click).
function openNotified(id) {
  const state = runtime.state;
  if (state) { state.surface = 'chat'; state.mTab = 'chat'; state.mSub = null; }
  actions.selectSession(id);
}

// Shared dwell time for both toast variants — was 6000 (showChatToast) vs 4500 (toast()), no functional reason for the difference
const TOAST_DWELL_MS = 5000;

// Lazily request OS-notification permission on a user gesture (called from send).
function ensureNotifyPermission() {
  try {
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  } catch (_) { /* unsupported */ }
}

// Transient in-app toast appended to <body> (outside the render() root so it
// survives re-renders); click to open the thread, auto-dismiss after
// TOAST_DWELL_MS (5s).
function showChatToast(text, id) {
  try {
    let host = document.getElementById('oc-toast-host');
    if (!host) { host = document.createElement('div'); host.id = 'oc-toast-host'; document.body.appendChild(host); }
    const el = document.createElement('div');
    el.className = 'oc-toast';
    el.innerHTML = '<span class="oc-toast-dot"></span><span class="oc-toast-msg"></span><span class="oc-toast-go">Open</span>';
    el.querySelector('.oc-toast-msg').textContent = text;
    const close = () => { el.classList.remove('in'); setTimeout(() => el.remove(), 220); };
    el.addEventListener('click', () => { openNotified(id); close(); });
    host.appendChild(el);
    requestAnimationFrame(() => el.classList.add('in'));
    setTimeout(close, TOAST_DWELL_MS);
  } catch (_) { /* DOM unavailable */ }
}

// Lightweight, non-clickable info/error toast (branch/edit failures, and now
// clip success/failure -- Task C3). Reuses the same #oc-toast-host as
// showChatToast but drops the "Open" affordance: there is no session to jump
// to for "couldn't branch" / "too late to edit" / a clip result. Exported so
// app.js and live/library.js can raise the same toast for clip outcomes
// instead of growing a second copy of this DOM dance.
export function toast(text) {
  try {
    let host = document.getElementById('oc-toast-host');
    if (!host) { host = document.createElement('div'); host.id = 'oc-toast-host'; document.body.appendChild(host); }
    const el = document.createElement('div');
    el.className = 'oc-toast';
    el.style.cursor = 'default';
    el.innerHTML = '<span class="oc-toast-dot"></span><span class="oc-toast-msg"></span>';
    el.querySelector('.oc-toast-msg').textContent = text;
    host.appendChild(el);
    requestAnimationFrame(() => el.classList.add('in'));
    setTimeout(() => { el.classList.remove('in'); setTimeout(() => el.remove(), 220); }, TOAST_DWELL_MS);
  } catch (_) { /* DOM unavailable */ }
}

// A reply finished in a thread you weren't viewing — surface it: in-app toast
// always, plus an OS notification when the user has granted permission.
function notifyTurnDone(chat, id) {
  const title = _titleFor(chat, id) || 'a chat';
  showChatToast(`__AGENT_NAME__ finished replying · ${title}`, id);
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      const n = new Notification('__AGENT_NAME__ finished replying', { body: title, tag: 'oc-turn-' + id });
      n.onclick = () => { try { window.focus(); } catch (_) {} openNotified(id); n.close(); };
    }
  } catch (_) { /* OS notifications unavailable */ }
}

// Build a self-contained, print-ready HTML document for a chat transcript.
// Reuses the same renderMarkdown() as the live thread so code blocks, lists and
// inline formatting survive into the PDF. Styling is light/print-friendly with a
// __AGENT_NAME__ brand header. The browser's own "Save as PDF" does the render,
// which keeps text selectable and crisp (no canvas rasterization).
function buildTranscriptHtml(title, thread, meta) {
  const safeTitle = String(title || 'Conversation');
  const escHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const rows = (thread || [])
    .filter((m) => String(m.text || '').trim().length > 0 || (m.attach && m.attach.length))
    .map((m) => {
      const isUser = m.role === 'user';
      const who = isUser ? 'You' : '__AGENT_NAME__';
      const time = m.time ? `<span class="t-time">${escHtml(m.time)}</span>` : '';
      const model = (!isUser && m.model) ? `<span class="t-model">${escHtml(m.model)}</span>` : '';
      const body = String(m.text || '').trim() ? renderMarkdown(m.text) : '';
      const av = isUser
        ? '<div class="t-av t-av-you">Y</div>'
        : `<div class="t-av"><img src="${escHtml(AVATAR)}" alt=""></div>`;
      return `<article class="t-msg ${isUser ? 'is-you' : 'is-asst'}">
        ${av}
        <div class="t-main">
          <div class="t-head"><span class="t-who">${escHtml(who)}</span>${model}${time}</div>
          <div class="t-body">${body}</div>
        </div>
      </article>`;
    }).join('\n');
  const count = (thread || []).filter((m) => String(m.text || '').trim().length > 0).length;
  const sub = escHtml(meta?.dateStr || '') + (count ? ` &middot; ${count} messages` : '');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>${escHtml(safeTitle)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root{ --ink:#1b1d22; --muted:#6b7280; --line:#e6e8ec; --accent:#2f6df6; --code-bg:#f5f6f8; }
  @page{ margin:16mm 14mm; }
  *{ box-sizing:border-box; }
  html,body{ margin:0; padding:0; }
  body{ font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
        color:var(--ink); background:#fff; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  .t-wrap{ max-width:720px; margin:0 auto; padding:28px 22px 40px; }
  .t-brand{ display:flex; align-items:center; gap:12px; padding-bottom:16px; margin-bottom:22px;
            border-bottom:2px solid var(--accent); }
  .t-brand .t-logo{ width:34px; height:34px; border-radius:9px; object-fit:cover;
            background:linear-gradient(135deg,#22d3ee,#2f6df6); flex:none; }
  .t-brand h1{ font-size:19px; margin:0; line-height:1.25; font-weight:650; }
  .t-brand .t-sub{ font-size:12px; color:var(--muted); margin-top:2px; }
  .t-msg{ display:flex; gap:12px; padding:14px 0; border-bottom:1px solid var(--line);
          break-inside:avoid; page-break-inside:avoid; }
  .t-msg:last-child{ border-bottom:none; }
  .t-av{ width:30px; height:30px; border-radius:8px; flex:none; overflow:hidden;
         display:flex; align-items:center; justify-content:center; background:#eef1f5; }
  .t-av img{ width:100%; height:100%; object-fit:cover; }
  .t-av-you{ background:var(--accent); color:#fff; font-weight:650; font-size:13px; }
  .t-main{ min-width:0; flex:1; }
  .t-head{ display:flex; align-items:baseline; gap:8px; margin-bottom:3px; }
  .t-who{ font-weight:650; font-size:13.5px; }
  .is-asst .t-who{ color:var(--accent); }
  .t-model{ font-size:10.5px; color:var(--muted); border:1px solid var(--line); border-radius:5px; padding:0 5px; }
  .t-time{ font-size:11px; color:var(--muted); margin-left:auto; }
  .t-body{ font-size:13.5px; }
  .t-body p{ margin:0 0 8px; }
  .t-body p:last-child{ margin-bottom:0; }
  .t-body h1,.t-body h2,.t-body h3{ font-size:14.5px; margin:12px 0 6px; }
  .t-body ul,.t-body ol{ margin:6px 0 8px; padding-left:22px; }
  .t-body li{ margin:2px 0; }
  .t-body code{ background:var(--code-bg); border-radius:4px; padding:1px 5px; font-size:12px;
                font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  .t-body pre{ background:var(--code-bg); border:1px solid var(--line); border-radius:8px;
               padding:11px 13px; overflow-x:auto; break-inside:avoid; page-break-inside:avoid; }
  .t-body pre code{ background:none; padding:0; font-size:12px; line-height:1.5; }
  .t-body blockquote{ margin:6px 0; padding:2px 12px; border-left:3px solid var(--line); color:var(--muted); }
  .t-body a{ color:var(--accent); text-decoration:none; }
  .t-foot{ margin-top:26px; padding-top:12px; border-top:1px solid var(--line);
           font-size:10.5px; color:var(--muted); text-align:center; }
</style></head>
<body>
  <div class="t-wrap">
    <header class="t-brand">
      <img class="t-logo" src="${escHtml(AVATAR)}" alt="">
      <div><h1>${escHtml(safeTitle)}</h1><div class="t-sub">${sub}</div></div>
    </header>
    ${rows || '<p style="color:#6b7280">This conversation has no messages yet.</p>'}
    <div class="t-foot">Exported from __AGENT_NAME__ &middot; ${escHtml(meta?.dateStr || '')}</div>
  </div>
</body></html>`;
}

// One debounced /api/search pipeline, keyed per caller slot so the sidebar
// filter and the ⌘K switcher never cancel each other's in-flight query.
const _convSearchSlot = { timer: null, seq: 0 };
const _switcherSearchSlot = { timer: null, seq: 0 };
function _semanticSearch(slot, q, apply) {
  if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
  const seq = ++slot.seq;
  slot.timer = setTimeout(async () => {
    let res = [];
    try { res = await apiGet(`/api/search?q=${encodeURIComponent(q)}&limit=20`); }
    catch (_) { res = []; }
    if (seq !== slot.seq) return;   // a newer keystroke superseded this one
    apply(Array.isArray(res) ? res : []);
    runtime.render();
  }, 280);
}
// GET /api/models in-flight guard for loadModelOptions: the mobile sheet
// re-fires the loader on every open (and on its tap-to-retry row), and two
// concurrent GETs would interleave their catalog rebuilds. One at a time —
// a tap while a load is in flight is a no-op; the pending load's own
// success/failure render covers it.
let _modelsInFlight = false;

// Temp ids for in-flight upload chips (task 4.2) — unique per selection so a
// second batch picked mid-flight never claims the first batch's chips.
let _uploadSeq = 0;
const mintUploadId = () => `up-${Date.now().toString(36)}-${(_uploadSeq++).toString(36)}`;

// --- Speak (read aloud in Gary's voice) ------------------------------------
// One <Audio> plays at a time. Playback state lives on chat.speakingId /
// chat.speakLoadingId (rendered by msgTools); these helpers own the element +
// object-URL lifecycle so nothing leaks between messages.
let _speakAudio = null;
let _speakUrl = null;
function _cleanupSpeakUrl() {
  if (_speakUrl) { try { URL.revokeObjectURL(_speakUrl); } catch (_) {} _speakUrl = null; }
  _speakAudio = null;
}
function _stopSpeakAudio() {
  if (_speakAudio) { try { _speakAudio.pause(); } catch (_) {} }
  _cleanupSpeakUrl();
}

export const actions = {
  // Semantic search across ALL conversations by message CONTENT (not just the
  // title substring the list filters on locally). Debounced; hits land in
  // chat.searchResults and render as a MESSAGES section under the title matches
  // (see surfaces.js convListBody). A short/empty query clears the results.
  convSearch: (query) => {
    const chat = runtime.state && runtime.state.live && runtime.state.live.chat;
    if (!chat) return;
    const q = (query || '').trim();
    chat.searchQuery = q;
    if (q.length < 2) {
      if (_convSearchSlot.timer) { clearTimeout(_convSearchSlot.timer); _convSearchSlot.timer = null; }
      _convSearchSlot.seq += 1;
      chat.searchResults = null; chat.searchLoading = false; return;
    }
    chat.searchLoading = true;
    _semanticSearch(_convSearchSlot, q, (res) => { chat.searchResults = res; chat.searchLoading = false; });
  },

  // ⌘K switcher (spec 7.3). Sections are rebuilt from state by switcher.js on
  // every render; these actions only own open/close, the query, and the
  // highlighted index.
  openSwitcher: () => {
    const state = runtime.state; if (!state) return;
    const chat = ensureChat(state);
    chat.switcherOpen = true; chat.switcherSel = 0; chat.switcherResults = null;
    state.switchQuery = '';
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => { const el = document.querySelector('[data-focus="switchQuery"]'); if (el) el.focus(); });
    }
  },
  closeSwitcher: () => {
    const state = runtime.state; if (!state) return;
    const chat = ensureChat(state);
    chat.switcherOpen = false; chat.switcherResults = null; chat.switcherSel = 0;
    state.switchQuery = '';
    _switcherSearchSlot.seq += 1;
    if (_switcherSearchSlot.timer) { clearTimeout(_switcherSearchSlot.timer); _switcherSearchSlot.timer = null; }
  },
  switcherQuery: (text) => {
    const state = runtime.state; if (!state) return;
    const chat = ensureChat(state);
    const q = String(text || '').trim();
    chat.switcherSel = 0;
    if (q.length < 2) { chat.switcherResults = null; _switcherSearchSlot.seq += 1; return; }
    _semanticSearch(_switcherSearchSlot, q, (res) => { chat.switcherResults = res; });
  },
  switcherMove: (delta) => {
    const state = runtime.state; if (!state) return;
    const chat = ensureChat(state);
    const n = flatRows(buildSwitcherSections({
      query: state.switchQuery, sessions: chat.sessions, mru: chat.mru,
      searchResults: chat.switcherResults, activeId: chat.activeId, projects: (state.live && state.live.projects) || [],
    })).length;
    chat.switcherSel = clampSel((chat.switcherSel || 0) + (Number(delta) || 0), n);
  },
  switcherPick: (id) => {
    const state = runtime.state; if (!state) return;
    const chat = ensureChat(state);
    let pick = id || null;
    if (!pick) {
      const rows = flatRows(buildSwitcherSections({
        query: state.switchQuery, sessions: chat.sessions, mru: chat.mru,
        searchResults: chat.switcherResults, activeId: chat.activeId, projects: (state.live && state.live.projects) || [],
      }));
      const r = rows[clampSel(chat.switcherSel, rows.length)];
      pick = r ? r.id : null;
    }
    actions.closeSwitcher();
    if (pick && pick !== chat.activeId) actions.selectSession(pick);
  },

  // OPEN shelf (spec 7.2)
  rebuildThreadGroups: () => { const state = runtime.state; if (!state) return; rebuildGroups(ensureChat(state)); },
  closeOpen: async (id) => {
    const state = runtime.state; if (!state || !id) return;
    const chat = ensureChat(state);
    const rec = (chat.sessions || []).find((s) => s.id === id);
    const prev = rec ? rec.opened : null;
    if (rec) rec.opened = null;
    chat.openedLocal.delete(id);   // F1: a close also clears any local overlay stamp
    rebuildGroups(chat);
    runtime.render();
    try { await apiJson(`/api/session/${encodeURIComponent(id)}/close`, {}); }
    catch (_) {
      if (rec) rec.opened = prev;
      rebuildGroups(chat);
      runtime.render();
      toast('Couldn’t update the Open list. Try again.');
    }
  },
  selectOpenSlot: (n) => {
    const state = runtime.state; if (!state) return;
    const chat = ensureChat(state);
    const open = (chat.groups || []).find((g) => g.kind === 'open');
    const row = open && open.rows.find((r) => r.slot === Number(n));
    if (row && row.id !== chat.activeId) return actions.selectSession(row.id);
  },
  cycleOpen: (delta) => {
    const state = runtime.state; if (!state) return;
    const chat = ensureChat(state);
    const open = (chat.groups || []).find((g) => g.kind === 'open');
    if (!open || !open.rows.length) return;
    const n = open.rows.length;
    const cur = open.rows.findIndex((r) => r.id === chat.activeId);
    const next = cur === -1 ? 0 : (((cur + (Number(delta) || 0)) % n) + n) % n;
    const row = open.rows[next];
    if (row && row.id !== chat.activeId) return actions.selectSession(row.id);
  },
  toggleProject: (pid) => {
    const state = runtime.state; if (!state || !pid) return;
    const chat = ensureChat(state);
    if (chat.expandedProjects.has(pid)) chat.expandedProjects.delete(pid); else chat.expandedProjects.add(pid);
    _persistExpanded(chat.expandedProjects);
    rebuildGroups(chat);
  },

  // Projects (spec 6.2, 4.2)
  toggleProjMenu: (pid) => {
    const chat = ensureChat(runtime.state);
    chat.projMenuOpen = chat.projMenuOpen === pid ? null : pid;
    chat.rowMenuOpen = null;
  },
  moveToProject: async (arg) => {
    const state = runtime.state; if (!state) return;
    const chat = ensureChat(state);
    chat.rowMenuOpen = null;
    const { id, target } = parseMoveArg(arg);
    const rec = (chat.sessions || []).find((s) => s.id === id);
    if (!rec) return;
    let pid = target;
    if (target === MOVE_NEW) {
      let name = null;
      try { name = window.prompt('New project name'); } catch (_) { name = null; }
      name = (name || '').trim();
      if (!name) { runtime.render(); return; }
      try {
        const created = await apiJson('/api/projects', { name });
        if (!created || !created.id) throw new Error('create failed');
        state.live.projects = [...(state.live.projects || []), created];
        pid = created.id;
      } catch (e) {
        toast(e && e.status === 409 ? 'A project with that name already exists.' : 'Couldn’t create the project.');
        runtime.render();
        return;
      }
    }
    const prev = rec.folder || null;
    rec.folder = pid || null;
    if (chat.activeId === id) chat.folder = rec.folder;
    rebuildGroups(chat);
    runtime.render();
    // Amendment A: unfiling (an empty target) goes through the dedicated
    // /unfile route, not a PATCH with folder:'', since FastAPI drops
    // empty-string form values, so that PATCH could never actually clear the folder.
    const revert = () => {
      rec.folder = prev;
      if (chat.activeId === id) chat.folder = prev;
      rebuildGroups(chat);
      runtime.render();
      toast('Couldn’t move that conversation. Try again.');
    };
    if (pid) {
      try { await apiForm(`/api/session/${encodeURIComponent(id)}`, { folder: pid }, { method: 'PATCH' }); }
      catch (_) { revert(); }
    } else {
      try { await apiJson(`/api/session/${encodeURIComponent(id)}/unfile`, {}); }
      catch (_) { revert(); }
    }
  },
  renameProject: async (pid) => {
    const state = runtime.state; if (!state || !pid) return;
    const chat = ensureChat(state);
    chat.projMenuOpen = null;
    const p = (state.live.projects || []).find((x) => x.id === pid);
    if (!p) return;
    let name = null;
    try { name = window.prompt('Rename project', p.name || ''); } catch (_) { name = null; }
    name = (name || '').trim();
    if (!name || name === p.name) { runtime.render(); return; }
    const prev = p.name;
    p.name = name;
    rebuildGroups(chat);
    runtime.render();
    try { await apiJson(`/api/projects/${encodeURIComponent(pid)}`, { name }, 'PATCH'); }
    catch (e) { p.name = prev; rebuildGroups(chat); runtime.render(); toast(e && e.status === 409 ? 'A project with that name already exists.' : 'Couldn’t rename the project.'); }
  },
  archiveProject: async (pid) => _setProjectArchived(pid, true),
  unarchiveProject: async (pid) => _setProjectArchived(pid, false),
  deleteProject: async (pid) => {
    const state = runtime.state; if (!state || !pid) return;
    const chat = ensureChat(state);
    chat.projMenuOpen = null;
    const p = (state.live.projects || []).find((x) => x.id === pid);
    if (!p) return;
    let ok = false;
    try { ok = window.confirm(`Delete project “${p.name}”? Its conversations stay, just unfiled.`); } catch (_) { ok = false; }
    if (!ok) { runtime.render(); return; }
    try {
      // Amendment B: DELETE via apiDelete (no body) rather than apiJson's
      // null-body DELETE.
      await apiDelete(`/api/projects/${encodeURIComponent(pid)}`);
      state.live.projects = (state.live.projects || []).filter((x) => x.id !== pid);
      for (const s of (chat.sessions || [])) if (s.folder === pid) s.folder = null;
      if (chat.folder === pid) chat.folder = null;
      rebuildGroups(chat);
    } catch (_) { toast('Couldn’t delete the project.'); }
    runtime.render();
  },
  runProjectBackfill: async () => {
    try {
      const r = await apiJson('/api/projects/backfill', {});
      toast(r && r.status === 'running' ? 'Backfill is already running.' : 'Backfill started. Conversations file in the background.');
      // I4: the route now seeds synchronously before it responds, so the
      // seeds are already there the moment this POST resolves -- refetch so
      // Settings/the sidebar show them right away instead of staying empty
      // until some unrelated refresh happens to land.
      const state = runtime.state;
      if (state) {
        try {
          const projects = await apiGet('/api/projects');
          state.live.projects = Array.isArray(projects) ? projects : [];
        } catch (_) { /* best-effort */ }
        rebuildGroups(ensureChat(state));
        runtime.render();
      }
    } catch (_) { toast('Couldn’t start the backfill.'); }
  },

  selectSession: async (id) => {
    const state = runtime.state;
    if (!state || !id) return;
    const chat = ensureChat(state);
    // Captured BEFORE the notified-dot is cleared below: a reply that landed
    // while you were away means "show me the newest", not "restore my spot".
    const finishedAway = !!(chat.notified && chat.notified.has(id));
    _leaveThread(chat, state);
    // Leaving the current thread: detach this client's live reader. The turn
    // keeps running + recording server-side, so nothing is lost — we re-attach
    // below if the thread we're opening has its own in-flight turn.
    stopLive();
    stopElapsed();
    // Detaching, not ending: the turn (if any) keeps running server-side.
    // Null busySessionId anyway — this client no longer has a live `turn`
    // to steer/queue into, and reconcileTurn (below) re-derives the truth
    // via beginTurn if this (or the destination) thread turns out to still
    // be busy, rather than trusting a stale id no one is attached to.
    turn = null;
    chat.busySessionId = null;
    // The header pill's tokens/context belong to the thread we're leaving —
    // drop them so the new thread never shows the old one's numbers while its
    // own usage row is still in flight.
    chat.sessionUsage = null;
    chat.usagePct = undefined;
    _pendingByTurnId.clear();
    chat.rowMenuOpen = null;
    chat.suggest = null;
    saveStripForCurrent(chat);
    chat.activeId = id;
    // I2: mirror from chat.sessions (already local) right away so the header
    // prefix/parent-link never show the OLD thread's project/parent for the
    // beat before the /api/sessions refetch below lands -- and still hold
    // correct data if that refetch fails outright (the catch below used to
    // skip mirroring entirely).
    _mirrorSessionMeta(chat, id);
    state.draft = restoreDraft(chat.drafts, id);
    chat.mru = pushMru(chat.mru, id);
    try { persistMru(chat.mru, window.localStorage); } catch (_) { /* storage unavailable */ }
    _setHash(chatHash(id));
    chat.chatStrip = loadStripForKey(chat, id);
    // Hydrate from server if in-memory strip has no pending tasks (covers fresh
    // PWA loads where chatStripByKey is empty). Runs async so it doesn't block
    // the rest of selectSession; only applied if the user is still on this session.
    if (!chat.chatStrip.todos || !(chat.chatStrip.todos.items || []).length) {
      (async () => {
        try {
          const res = await apiGet(`/api/strip/state?session=${encodeURIComponent(id)}`);
          const tasks = Array.isArray(res && res.tasks) ? res.tasks : [];
          if (tasks.length && chat.activeId === id) {
            chat.chatStrip = { ...chat.chatStrip, todos: { msgId: null, items: tasks, updatedAt: Date.now() } };
            patchChatStrip(chat);
            runtime.render();
          }
        } catch (_) { /* non-fatal */ }
      })();
    }
    chat.editingId = null;
    syncQueuedView(chat);       // banner now shows THIS thread's queued entry (if any)
    if (chat.notified) chat.notified.delete(id);  // opening it clears its dot
    // A stored "Mark unread" clears on open too; locally first (so the dot
    // goes out in this render) and then server-side, fire-and-forget: a failed
    // clear only means the dot comes back on the next refetch, never a stuck UI.
    const openedRec = (chat.sessions || []).find((x) => x && x.id === id);
    if (openedRec && openedRec.unread) {
      openedRec.unread = false;
      apiForm(`/api/session/${id}/unread`, { unread: 'false' }).catch(() => {});
    }
    storeActiveId(id);
    // Rehydrate a carried branch prefix (Task 8): branchFromMessage stashes it
    // in localStorage keyed by the NEW session's id before switching to it, so
    // this covers both the initial jump into a freshly-branched thread and any
    // later reopen (e.g. after a reload) before its first real message lands.
    try {
      const raw = localStorage.getItem(branchPrefixKey(id));
      state.branchPrefix = raw ? JSON.parse(raw) : null;
    } catch (_) { state.branchPrefix = null; }
    rebuildGroups(chat, id);
    runtime.render();

    let name;
    try {
      const sessions = await apiGet('/api/sessions');
      const list = Array.isArray(sessions) ? sessions : [];
      name = list.find((s) => s.id === id)?.name;
      if (chat.activeId === id) { chat.sessions = list; _mirrorSessionMeta(chat, id); }
    } catch (_) { /* ignore */ }

    try {
      const t = await fetchThread(id, chat.model, name);
      // Superseded by a NEWER selectSession/newChat while this awaited: the
      // fresher call already owns chat.thread/title — writing here would
      // silently paint THIS (now stale) session's messages back under
      // whatever the user switched to. Bail; the fresher call's own render
      // is authoritative.
      if (chat.activeId !== id) return;
      chat.thread = dedupeAdjacentUserMessages(t.thread, 'openSession');
      if (t.title) chat.title = t.title;
      chat.subtitle = t.subtitle;
      if (t.model) chat.model = t.model;
      // A reopened session that already has real history (e.g. another tab
      // already sent its first message) shouldn't still show carried bubbles.
      clearBranchPrefixIfStarted(state, chat);
      const dec = scrollDecision(chat.scroll[id], finishedAway);
      if (dec.bottom) { runtime.wantChatBottom = true; runtime.restoreScrollTop = null; }
      else { runtime.wantChatBottom = false; runtime.restoreScrollTop = dec.top; }
      changesAttachHistory(state, id, chat.thread).catch(() => {});
    } catch (_) {
      // A GENUINE failure (not a race — chat.activeId is still `id`) leaves
      // the PREVIOUS session's thread on screen under this NEW activeId, with
      // nothing else marking it wrong. Toast so it's not silent.
      if (chat.activeId === id) toast('Couldn’t load that conversation — check your connection and try again.');
    }
    if (chat.activeId !== id) return;   // superseded during the fetch above
    // Re-attach to an in-flight turn for this thread, if one is still running
    // server-side (returning to a thread you left mid-answer).
    try { await reconcileTurn(chat, state, id); } catch (_) { /* non-fatal */ }
    if (chat.activeId !== id) return;
    // A message queued for THIS thread whose turn already finished while we
    // were away (reconcile decided 'none' — no local live state to finalize)
    // would otherwise sit stranded in the banner forever. Fire it now; the
    // guards inside no-op when a turn re-attached above or nothing is queued.
    flushQueuedFor(chat, id);
    // Populate resolved update_blocks that the frontend missed while away.
    try { await hydrateThread(id, chat.thread); } catch (_) { /* non-fatal */ }
    if (chat.activeId !== id) return;
    try { await hydrateWarnings(id, chat.thread); } catch (_) { /* non-fatal */ }
    if (chat.activeId !== id) return;
    const pct = usagePctOf(await fetchUsage(id));
    if (pct != null && chat.activeId === id) chat.usagePct = pct;
    runtime.render();
    // Acknowledge unseen followups for this session (fire-and-forget)
    fetch('/api/push/ack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: id }) }).catch(() => {});
  },

  newChat: () => {
    const state = runtime.state;
    if (!state) return;
    const chat = ensureChat(state);
    _leaveThread(chat, state);
    // Detach this client's live reader from whatever thread was streaming, same
    // as selectSession(). The prior turn keeps running + recording server-side
    // (re-attached via reconcileTurn on return); clearing `turn` here means the
    // first message in this fresh thread sends immediately instead of queueing
    // behind the thread we just left.
    stopLive();
    stopElapsed();
    turn = null;
    chat.busySessionId = null; // detaching, not ending — see selectSession's comment
    chat.sessionUsage = null;  // a fresh chat has no usage of its own yet
    chat.usagePct = undefined;
    _pendingByTurnId.clear();
    const _leavingId = chat.activeId;
    saveStripForCurrent(chat);
    if (_leavingId) {
      fetch(`/api/strip/state?session=${encodeURIComponent(_leavingId)}`, {
        method: 'DELETE', credentials: 'same-origin',
      }).catch(() => {});
    }
    chat.activeId = null;
    chat.folder = null;
    chat.parentId = null;
    chat.chatStrip = stripOnSessionSwitch();
    chat.editingId = null;
    chat.suggest = null;
    // Leaving for a fresh chat drops the left-behind thread's queued messages —
    // they were "send after the reply finishes", and the user just walked away
    // from that conversation. (Other sessions' entries are untouched.)
    chat.queuedList = queueDropSession(chat.queuedList, _leavingId);
    syncQueuedView(chat);
    storeActiveId(null);
    chat.thread = [];
    chat.title = 'New chat';
    state.branchPrefix = null; // a fresh chat carries no branch context
    rebuildGroups(chat, null);
    chat.subtitle = `0 messages · ${chat.model || ''}`;
    // Canonical shape (task 3.10): this is THE newChat — app.js's pre-merge
    // stub only mirrors the visible half (chat surface + cleared draft +
    // focused composer) until this merges over it. Without the routing bits
    // here, a post-merge "New chat" fired from Inbox/Library/a deep link
    // reset the thread but stranded the user on the surface they were on.
    state.surface = 'chat';
    state.mTab = 'chat';   // mobile shell routes off mTab/mSub (unused on desktop)
    state.mSub = null;
    state.draft = '';
    _setHash('#chat');
    runtime.render();
    // Focus the composer once the render above has painted it. rAF-guarded:
    // node tests drive this action with no DOM scheduler.
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        const ta = document.querySelector('[data-focus="draft"],[data-focus="mdraft"]');
        if (ta) ta.focus();
      });
    }
    // A new chat should start on the persisted default model, not whatever the
    // last-opened conversation happened to use. Fetch it and re-render if it
    // differs (createSession() on first send then carries this model).
    apiGet('/api/default-chat').then((dc) => {
      if (dc && dc.model && dc.model !== chat.model && !chat.activeId) {
        chat.model = dc.model;
        chat.endpointId = dc.endpoint_id || '';
        chat.subtitle = `0 messages · ${chat.model || ''}`;
        runtime.render();
      }
    }).catch(() => { /* keep current model */ });
  },

  send: async () => {
    const state = runtime.state;
    if (!state) return;
    // Read-and-clear immediately, before any early return below (uploadGate,
    // empty-composer) — sendQueued sets this then calls send(); if it only got
    // cleared past those early-return points, an Alt+Enter on an empty
    // composer or mid-upload would leave it set and silently force-queue the
    // user's NEXT, unrelated send even though steering was available for it.
    const forceQueue = !!state._forceQueue;
    state._forceQueue = false;
    const text = (state.draft || '').trim();
    state.docAiAskPlaceholder = null; // Task 5's Ask action set this; any send (incl. queue/steer) consumes it
    // Uploads still in flight (or dead) gate the send — the old snapshot took
    // whatever had RESOLVED, silently sending without the file that was still
    // uploading. Block with a notice instead of guessing; the draft and chips
    // stay put, so Send after the chip settles carries everything.
    const gate = uploadGate(state.pendingAttach);
    if (gate === 'uploading') { toast('Attachment still uploading — send once the chip settles.'); return; }
    if (gate === 'failed') { toast('An attachment failed to upload — remove the red chip (✕) or attach it again.'); return; }
    const attachSnap = sendableAttach(state.pendingAttach);
    if (!text && !attachSnap.length) return;
    const chat = ensureChat(state);
    chat.suggest = null; // sending (or queueing) consumes any ghost suggestion

    // A turn is already streaming FOR THIS THREAD → either steer it into the
    // running turn (claude-cli, capability available, text-only) or queue this
    // message instead of starting a second turn against the same thread — the
    // queued banner the user can edit (recall) or cancel; when the current
    // turn ends it auto-sends (see flushQueuedFor in the turn-end paths).
    // Appended to the session-keyed list, so a second queued message never
    // overwrites the first. A turn streaming in a DIFFERENT thread must NOT
    // gate this send — that turn keeps running + recording server-side, and
    // dispatchSend() detaches our reader from it.
    const busyHere = !!(turn && turn.sessionId === chat.activeId);
    const mode = busySendMode({
      busyHere,
      steerAvailable: !!(state.caps && state.caps.steer && state.caps.steer.available),
      endpointId: chat.endpointId,
      hasAttachments: attachSnap.length > 0,
      forceQueue,
    });
    chat.steerMode = mode === 'steer';
    if (mode === 'queue') {
      chat.queuedList = [...(chat.queuedList || []), { sid: chat.activeId, text, attachSnap }];
      syncQueuedView(chat);
      state.draft = '';
      chat.drafts = dropDraft(chat.drafts, chat.activeId);
      _persistDraftsNow(chat);
      state.pendingAttach = [];
      runtime.render();
      return;
    }
    if (mode === 'steer') {
      state.draft = '';
      state.pendingAttach = [];
      const steered = await submitFromComposer(text, [], { steer: true });
      if (steered === 'flush-failed') {
        // Fix wave, I1: the document could not be saved, so nothing left the
        // browser. Put the text back exactly as it was; the toast already
        // said why.
        state.draft = text;
        runtime.render();
      }
      return;
    }

    state.draft = '';
    chat.drafts = dropDraft(chat.drafts, chat.activeId);
    _persistDraftsNow(chat);
    state.pendingAttach = []; // consumed by this turn
    const ok = await submitFromComposer(text, attachSnap);
    if (ok === 'flush-failed') {
      // Fix wave, I1: the pre-send document save failed or hit a conflict and
      // submitFromComposer already toasted. Restore what the user typed.
      state.draft = text;
      state.pendingAttach = attachSnap;
      runtime.render();
      return;
    }
    if (ok === false) {
      // Session create failed (offline first send in a new chat). The old
      // behavior silently swallowed the message — no bubble, no error, text
      // gone. Put the draft back and say why.
      state.draft = text;
      state.pendingAttach = attachSnap;
      toast('Couldn’t start the chat — check your connection and try again.');
      runtime.render();
    }
  },

  // Explicit "queue for after": Alt+Enter or the composer chip. Same as send,
  // with steering forced off for this one message.
  sendQueued: async () => {
    const state = runtime.state;
    if (!state) return;
    state._forceQueue = true;
    await actions.send();
  },

  // Pull the ACTIVE session's first queued message back into the composer to
  // edit/recall it. Later entries for the session stay queued (the banner
  // shows the next one).
  queueRecall: () => {
    const state = runtime.state;
    if (!state) return;
    const chat = ensureChat(state);
    const { taken, rest } = queueTake(chat.queuedList, chat.activeId);
    if (!taken) return;
    chat.queuedList = rest;
    syncQueuedView(chat);
    state.draft = taken.text || '';
    state.pendingAttach = taken.attachSnap ? [...taken.attachSnap] : [];
    runtime.render();
    const ta = document.querySelector('[data-focus="draft"],[data-focus="mdraft"]');
    if (ta) ta.focus();
  },

  // Drop the active session's first queued message without sending it.
  queueCancel: () => {
    const state = runtime.state;
    if (!state) return;
    const chat = ensureChat(state);
    const { taken, rest } = queueTake(chat.queuedList, chat.activeId);
    if (!taken) return;
    chat.queuedList = rest;
    syncQueuedView(chat);
    runtime.render();
  },

  stopRun: () => {
    // Detach this client's reader AND abort the run server-side. With the
    // detached recorder, aborting the reader alone no longer stops the gateway
    // run — Stop must explicitly POST /api/chat/stop/{id} (chat.abort).
    // The TURN's own session, not chat.activeId: in the send-then-switch
    // window the two differ, and the stop must land on the thread that is
    // actually running — not kill an innocent turn in the viewed thread.
    const chat = runtime.state ? ensureChat(runtime.state) : null;
    const sid = turn ? turn.sessionId : null;
    stopLive();
    stopElapsed();
    // Land any text still sitting in the typewriter buffer and stop the
    // blinking caret — without this the bubble kept `streaming` forever and
    // the tail of the reply silently vanished with `turn.pending`.
    flushStreamBuffer();
    if (turn && turn.asstMsg) turn.asstMsg.streaming = false;
    // Remember which bubble this Stop finalized, so a failed stop-POST's
    // notifier re-attach resumes INTO this record's slot (attachTurn removes
    // the stopped bubble before its replay) instead of minting a duplicate.
    lastStopped = (turn && turn.asstMsg && sid)
      ? { sessionId: sid, msgId: turn.asstMsg.id } : null;
    if (sid) {
      // Capture THIS call's record by identity so the .then() below only ever
      // clears its own slot — single-slot invariant: attachTurn consumes
      // lastStopped without a refetch in between, so it only ever runs
      // against the SAME session/view this stopRun just recorded (a second
      // stopRun for a different session would have already overwritten the
      // module slot with its own record before this one's POST settles).
      const stopRec = lastStopped;
      apiForm(`/api/chat/stop/${sid}`, {})
        .then(() => {
          // The server confirmed the abort actually landed (chat.abort
          // succeeded — see backend/app.py stop_chat) — this is a genuinely
          // finished turn, not one that might still be running. Clear the
          // record: leaving it live would let an UNRELATED later turn in this
          // same session (e.g. a follow-up promise firing) get dedupe-spliced
          // by attachTurn as if it were this stopped turn resuming, deleting
          // a perfectly legitimate finished bubble.
          if (lastStopped === stopRec) lastStopped = null;
        })
        .catch(() => {
          // The stop never reached the backend (or the gateway call itself
          // failed): the run is still going server-side and the notifier
          // will re-surface it in ~4s — keep the record so attachTurn's
          // dedupe replaces the stopped bubble instead of duplicating it.
          // Say so — an unexplained resurrection looks haunted.
          toast('Stop didn’t reach the server — the reply may still be running and could reappear.');
        });
    }
    if (turn && turn.activity) {
      const a = turn.activity;
      finalizeAll(a);
      a.status = 'done';
      a.elapsed = fmtElapsed(a.startMs);
      a.worked = `Stopped after ${a.elapsed} · ${a.steps.length} steps`;
    }
    if (chat) chat.busySessionId = null;
    turn = null;
    // Stop is a deliberate halt — don't auto-fire a queued follow-up. Hand it
    // back to the composer so the user decides whether to send it. Keyed to
    // the STOPPED turn's session: when the user is viewing another thread,
    // leave that thread's draft and queue alone (the stopped session's entry
    // stays queued for its own thread).
    if (chat && sid && sid === chat.activeId && queueHead(chat.queuedList, sid)) {
      actions.queueRecall();
    }
    runtime.render();
  },

  // re-fetch the session list and active thread (used after a 404 on send)
  reloadSessions: async () => {
    const state = runtime.state;
    if (!state) return;
    try {
      await load(state);
    } catch (_) { /* keep current */ }
    runtime.render();
  },

  // Shared model-picker loader. Desktop uses a popover; mobile uses a sheet,
  // but both need the same endpoint-grouped catalog and current default.
  // Failure is MODULE truth, not a per-surface heuristic: a failed GET sets
  // state.live.modelsFailed (the mobile sheet renders its tap-to-retry row
  // from it — mobile/mobile-sheets.js), a new attempt clears it so the sheet
  // flips back to "Loading models…", and a success — however late — sets the
  // catalog and re-renders, so every surface recovers on its own.
  loadModelOptions: async () => {
    const state = runtime.state;
    if (!state) return;
    if (!(state.live && state.live.modelGroups) && !_modelsInFlight) {
      _modelsInFlight = true;
      state.live = state.live || {};
      if (state.live.modelsFailed) { state.live.modelsFailed = false; runtime.render(); }
      try {
        const data = await apiGet('/api/models');
        const items = (data && data.items) || [];
        const groups = [];
        const flat = [];
        for (const it of items) {
          const mids = it.models || [];
          const disp = it.models_display || it.models || [];
          const epId = it.endpoint_id || '';
          const ep = prettyEndpoint(it.endpoint_name || epId);
          const models = mids.map((mid, i) => {
            // Composite identity: the SAME model id is offered by multiple
            // endpoints (e.g. claude-sonnet-4-6 via Claude CLI AND Perplexity).
            // Key selection on endpoint·model so the copies don't co-select.
            const row = { id: epId + MODEL_SEP + mid, mid, name: bareModelName(disp[i] || mid), endpointId: epId, ep };
            flat.push(row);
            return row;
          });
          const tag = disp.some((d) => /\(chat only\)/i.test(String(d))) ? 'chat only' : '';
          groups.push({ ep, endpointId: epId, hasTag: !!tag, tag, models });
        }
        state.live.modelGroups = groups;
        state.live.modelList = flat;
        state.live.modelsFailed = false;
        runtime.render();
      } catch (_) {
        state.live.modelsFailed = true;   // surfaces render a retry state
        runtime.render();
      } finally {
        _modelsInFlight = false;
      }
    }
    // Reflect the current default-for-new-chats (as a composite id) so the ★ lands
    // on exactly one row.
    try {
      const dc = await apiGet('/api/default-chat');
      state.live = state.live || {};
      state.live.defaultModel = ((dc && dc.endpoint_id) || '') + MODEL_SEP + ((dc && dc.model) || '');
      runtime.render();
    } catch (_) { /* ignore */ }
  },

  // Composer model picker: open/close the desktop popover, then lazily load
  // the shared catalog. Mobile calls loadModelOptions directly for its sheet.
  toggleModelMenu: async () => {
    const state = runtime.state;
    if (!state) return;
    const open = !state.modelMenuOpen;
    state.modelMenuOpen = open;
    runtime.render();
    if (open) await actions.loadModelOptions();
  },

  // ★ Set a model as the default for NEW chats (persists via POST /api/default-chat).
  // `id` is the composite endpoint·model id from the picker.
  setDefaultModel: async (id) => {
    const state = runtime.state;
    if (!state || !id) return;
    // Only ids that resolve in the loaded catalog: an unresolved id would
    // persist a model with a blank endpoint, and /api/default-chat would
    // back-fill a provider that may not actually serve it (cross-pair).
    const item = (state.live && state.live.modelList || []).find((m) => m.id === id);
    if (!item) return;
    state.live = state.live || {};
    state.live.defaultModel = id;
    runtime.render();
    try { await apiJson('/api/default-chat', { model: item.mid, endpoint_id: item.endpointId || '' }); } catch (_) {}
  },

  // Pick the chat model. `id` is the composite endpoint·model id. For a NEW chat,
  // createSession() uses chat.model/endpointId. For the ACTIVE session, PATCH the
  // record so the gateway applies it next turn (chat_stream reads it via _model_ref).
  setModel: (id) => {
    const state = runtime.state;
    if (!state || !id) return;
    // Only ids that resolve in the loaded catalog. The old fallback (treat an
    // unresolved id as a bare model name and KEEP the chat's endpointId) is
    // how cross-paired records like claude-cli/gpt-5.5 got written — the
    // gateway then bounces every turn with "model not allowed".
    const item = (state.live && state.live.modelList || []).find((m) => m.id === id);
    if (!item) return;
    const chat = ensureChat(state);
    chat.model = item.mid;
    chat.endpointId = item.endpointId;
    chat.subtitle = `${Array.isArray(chat.thread) ? chat.thread.length : 0} messages · ${item.name}`;
    state.modelMenuOpen = false;
    runtime.render();
    if (chat.activeId) {
      const fields = { model: item.mid };
      if (chat.endpointId) fields.endpoint_id = chat.endpointId;
      apiForm(`/api/session/${chat.activeId}`, fields, { method: 'PATCH' }).catch(() => {});
    }
  },

  // Composer attach (task 4.2): the chip appears AT SELECTION in an
  // 'uploading' state, not after the fetch resolves — before this, a slow
  // upload was invisible (nothing showed that Send was about to miss the
  // file) and a failed one vanished without a trace. Failure flips the batch
  // red (removable) + toasts; success swaps in the real server ids. send()
  // blocks with a notice while any chip is uploading/failed — see uploadGate
  // there. Called directly by the file-input change listener (app.js) with a
  // FileList. Pure lifecycle decisions live in attach-logic.js.
  uploadAttachments: async (files) => {
    const state = runtime.state;
    if (!state || !files || !files.length) return;
    const fileList = Array.from(files);
    const { list, ids } = beginUploads(
      state.pendingAttach, fileList.map((f) => f.name || 'upload'), mintUploadId);
    state.pendingAttach = list;
    runtime.render();
    const fd = new FormData();
    for (const f of fileList) fd.append('files', f, f.name || 'upload');
    try {
      const res = await fetch(`${location.origin}/api/upload`, { method: 'POST', credentials: 'same-origin', body: fd });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      const saved = ((data && data.files) || []).map((s) => ({ id: s.id, name: s.name, url: s.url }));
      state.pendingAttach = resolveUploads(state.pendingAttach, ids, saved);
      // Partial save (server accepted the POST but skipped files): the
      // unmatched chips are now red — say so, same voice as the failure path.
      if (saved.length < ids.length) toast('Some attachments didn’t upload — remove the red chips or attach them again.');
    } catch (_) {
      state.pendingAttach = failUploads(state.pendingAttach, ids);
      toast('Upload failed — remove the red chip or attach the file again.');
    }
    runtime.render();
  },

  // Remove a pending attachment chip before sending.
  removeAttach: (id) => {
    const state = runtime.state;
    if (!state || !id) return;
    state.pendingAttach = (state.pendingAttach || []).filter((a) => a.id !== id);
    runtime.render();
  },

  // Chat-header "More" menu: open/close + per-conversation actions.
  toggleChatMenu: () => {
    const state = runtime.state;
    if (!state) return;
    state.chatMenuOpen = !state.chatMenuOpen;
    runtime.render();
  },

  // Chat-strip: collapse/expand toggle (persists to localStorage).
  toggleChatStrip: () => {
    const state = runtime.state;
    if (!state) return;
    const chat = ensureChat(state);
    let storage = null;
    try { storage = window.localStorage; } catch (_) {}
    chat.chatStrip = stripToggleCollapsed(chat.chatStrip, storage);
    runtime.render();
  },

  // Chat-strip: dismiss the plan preview without waiting for the next send.
  dismissStripPlan: () => {
    const state = runtime.state;
    if (!state) return;
    const chat = ensureChat(state);
    if (!chat.chatStrip || !chat.chatStrip.plan) return;
    chat.chatStrip = { ...chat.chatStrip, plan: null };
    runtime.render();
  },
  // Rename the active conversation → PATCH /api/session/{id} (FormData name).
  renameSession: async (id) => {
    const state = runtime.state;
    if (!state) return;
    const chat = ensureChat(state);
    state.chatMenuOpen = false;
    chat.rowMenuOpen = null;
    const target = id || chat.activeId;
    if (!target) { runtime.render(); return; }
    let cur = chat.title || '';
    if (target !== chat.activeId) {
      const rows = (chat.groups || []).flatMap((g) => g.rows || []);
      cur = (rows.find((r) => r.id === target) || {}).title || '';
    }
    let name = null;
    try { name = window.prompt('Rename conversation', cur); } catch (_) { name = null; }
    if (name == null) { runtime.render(); return; }
    name = name.trim();
    if (!name) { runtime.render(); return; }
    if (target === chat.activeId) chat.title = name;
    runtime.render();
    try { await apiForm(`/api/session/${target}`, { name }, { method: 'PATCH' }); } catch (_) {}
    try { await load(state); } catch (_) {}
    runtime.render();
  },
  // Copy the transcript to the clipboard.
  copyTranscript: async (id) => {
    const state = runtime.state;
    if (!state) return;
    const chat = ensureChat(state);
    state.chatMenuOpen = false;
    chat.rowMenuOpen = null;
    let thread = chat.thread || [];
    if (id && id !== chat.activeId) {
      try {
        const hist = await apiGet(`/api/history/${id}?limit=200`);
        const list = Array.isArray(hist?.history) ? hist.history : [];
        thread = list.map((h) => ({ role: h.role === 'user' ? 'user' : 'assistant', text: h.content || '' }));
      } catch (_) { thread = []; }
    }
    const text = thread.map((m) => `${m.role === 'user' ? 'You' : '__AGENT_NAME__'}: ${m.text || ''}`).join('\n\n');
    try { await navigator.clipboard.writeText(text); } catch (_) {}
    runtime.render();
  },
  // Export the transcript as a downloaded Markdown file (client-side).
  exportChat: () => {
    const state = runtime.state;
    if (!state) return;
    state.chatMenuOpen = false;
    const chat = ensureChat(state);
    const title = chat.title || 'conversation';
    const md = `# ${title}\n\n` + (chat.thread || []).map((m) => `**${m.role === 'user' ? 'You' : '__AGENT_NAME__'}:** ${m.text || ''}`).join('\n\n');
    try {
      const blob = new Blob([md], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${title.replace(/[^\w.-]+/g, '_')}.md`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 1000);
    } catch (_) {}
    runtime.render();
  },
  // Export the transcript as a nicely-styled PDF, one-click download. Builds the
  // same print-ready HTML (reusing renderMarkdown) and POSTs it to the backend,
  // which renders it to a real PDF with headless Chrome and streams it back as a
  // file — no print dialog, selectable text, identical styling. Falls back to
  // the browser print dialog, then an .html download, if the endpoint is down.
  exportChatPDF: async () => {
    const state = runtime.state;
    if (!state) return;
    state.chatMenuOpen = false;
    const chat = ensureChat(state);
    const title = chat.title || 'Conversation';
    let thread = chat.thread || [];
    // If the open chat's live thread is empty (e.g. reopened but not yet
    // hydrated), pull the transcript from history so the export isn't blank.
    if ((!thread || !thread.length) && chat.activeId) {
      try {
        const hist = await apiGet(`/api/history/${chat.activeId}?limit=500`);
        const list = Array.isArray(hist?.history) ? hist.history : [];
        thread = list.map((h) => ({ role: h.role === 'user' ? 'user' : 'assistant', text: h.content || '', model: h.metadata?.model }));
      } catch (_) { thread = chat.thread || []; }
    }
    let dateStr = '';
    try { dateStr = new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch (_) {}
    const html = buildTranscriptHtml(title, thread, { dateStr });
    const safe = title.replace(/[^\w.-]+/g, '_') || 'conversation';

    // Trigger a browser download from a blob.
    const download = (blob, name) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 1000);
    };

    // Preferred path: server renders a real PDF → one-click file download.
    try {
      const res = await fetch(`${location.origin}/api/export/pdf`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ html, filename: `${safe}.pdf` }),
      });
      if (res.ok) {
        const blob = await res.blob();
        if (blob && blob.size) {
          download(blob, `${safe}.pdf`);
          runtime.render();
          return;
        }
      }
    } catch (_) { /* fall through to print/html fallbacks */ }

    // Fallback 1: browser print dialog via sandboxed hidden iframe.
    try {
      const frame = document.createElement('iframe');
      frame.setAttribute('aria-hidden', 'true');
      frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
      document.body.appendChild(frame);
      const doc = frame.contentWindow.document;
      doc.open(); doc.write(html); doc.close();
      const go = () => {
        try {
          frame.contentWindow.focus();
          frame.contentWindow.print();
        } catch (_) {}
        setTimeout(() => { try { frame.remove(); } catch (_) {} }, 60000);
      };
      // Give images (avatar) a beat to load so they render in the PDF.
      if (frame.contentWindow.document.readyState === 'complete') setTimeout(go, 250);
      else frame.addEventListener('load', () => setTimeout(go, 250), { once: true });
    } catch (_) {
      // Fallback 2: hand over the styled HTML.
      try { download(new Blob([html], { type: 'text/html' }), `${safe}.html`); } catch (_) {}
    }
    runtime.render();
  },

  // Session list: archive a conversation → POST /api/session/{id}/archive.
  archiveSession: async (id) => {
    const state = runtime.state;
    if (!state || !id) return;
    const chat = ensureChat(state);
    chat.rowMenuOpen = null;
    const wasActive = chat.activeId === id;
    try { await apiJson(`/api/session/${id}/archive`, {}); } catch (_) {}
    if (wasActive) { chat.activeId = null; storeActiveId(null); chat.thread = []; chat.title = 'New chat'; chat.subtitle = ''; }
    try { await load(state); } catch (_) {}
    runtime.render();
  },

  // Session list: delete a conversation (confirm-guarded) → DELETE /api/session/{id}.
  deleteSession: async (id) => {
    const state = runtime.state;
    if (!state || !id) return;
    let ok = false;
    try { ok = window.confirm('Delete this conversation? This cannot be undone.'); } catch (_) { ok = false; }
    if (!ok) return;
    const chat = ensureChat(state);
    const wasActive = chat.activeId === id;
    try { await apiDelete(`/api/session/${id}`); } catch (_) {}
    if (wasActive) { chat.activeId = null; storeActiveId(null); chat.thread = []; chat.title = 'New chat'; chat.subtitle = ''; }
    try { await load(state); } catch (_) {}
    runtime.render();
  },

  // Sidebar: open/close a single row's actions menu.
  toggleConvMenu: (id) => {
    const state = runtime.state;
    if (!state || !id) return;
    const chat = ensureChat(state);
    chat.rowMenuOpen = chat.rowMenuOpen === id ? null : id;
    state.chatMenuOpen = false;
    runtime.render();
  },

  // Sidebar: toggle a conversation's favorite flag → POST /api/session/{id}/important.
  toggleFavorite: async (id) => {
    const state = runtime.state;
    if (!state || !id) return;
    const chat = ensureChat(state);
    chat.rowMenuOpen = null;
    const rows = (chat.groups || []).flatMap((g) => g.rows || []);
    const row = rows.find((r) => r.id === id);
    const next = !(row && row.important);
    if (row) row.important = next; // optimistic
    runtime.render();
    try { await apiForm(`/api/session/${id}/important`, { important: String(next) }); } catch (_) {}
    try { await load(state); } catch (_) {}
    runtime.render();
  },

  // Sidebar / mobile sheet: flip a conversation's stored unread flag ->
  // POST /api/session/{id}/unread. Optimistic (the dot moves on tap), reverted
  // with a toast if the write fails. Marking the thread you are LOOKING AT
  // unread is allowed: rowOf() suppresses the dot on the active row, so it
  // shows up once you leave and come back, which is what "mark unread" means.
  toggleUnread: async (id) => {
    const state = runtime.state;
    if (!state || !id) return;
    const chat = ensureChat(state);
    chat.rowMenuOpen = null;
    chat.mobileConvSheetId = null;
    const rec = (chat.sessions || []).find((x) => x && x.id === id);
    if (!rec) return;
    const prev = !!rec.unread;
    // Which way the toggle goes is decided by what the row currently SHOWS,
    // not by the stored flag alone: a row lit only by the session-local
    // "finished while away" set must go dark on tap, same as a stored one.
    // The menu label is derived the same way (surfaces.js convMenu).
    const lit = prev || !!(chat.notified && chat.notified.has(id) && chat.activeId !== id);
    const next = !lit;
    rec.unread = next;                 // optimistic
    // A thread marked read should not keep the session-local flag either:
    // clearing both means the one dot has one owner.
    if (!next && chat.notified) chat.notified.delete(id);
    rebuildGroups(chat);
    runtime.render();
    try {
      await apiForm(`/api/session/${id}/unread`, { unread: String(next) });
    } catch (_) {
      rec.unread = prev;
      rebuildGroups(chat);
      runtime.render();
      toast(next ? 'Couldn’t mark this unread.' : 'Couldn’t mark this read.');
      return;
    }
    // Reconcile with the server, same as toggleFavorite: without this a
    // sessions refetch already in flight when the optimistic flip happened
    // lands afterwards and silently reverts the dot.
    try { await load(state); } catch (_) {}
    runtime.render();
  },

  // Message toolbar: copy one message's text to the clipboard.
  copyMessage: async (id) => {
    const state = runtime.state;
    if (!state || !id) return;
    const chat = ensureChat(state);
    const msg = (chat.thread || []).find((m) => m.id === id);
    if (!msg || !msg.text) return;
    try { await navigator.clipboard.writeText(msg.text); } catch (_) {}
  },

  // Message toolbar: read this assistant reply aloud in Gary's voice. Synth runs
  // locally on naboo (XTTS, ~3.5x realtime on CPU), so there's a synthesizing
  // phase (fortress spinner) before playback. Tap again (stopSpeak) to cancel.
  speakMessage: async (id) => {
    const state = runtime.state;
    if (!state || !id) return;
    const chat = ensureChat(state);
    const msg = (chat.thread || []).find((m) => m.id === id);
    if (!msg || !msg.text) return;
    _stopSpeakAudio();
    chat.speakingId = null;
    chat.speakLoadingId = id;   // spinner on this message
    runtime.render();
    let blob;
    try {
      const res = await fetch('/api/voice/speak', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: msg.text }),
      });
      if (!res.ok) {
        let err = res.status;
        try { err = (await res.json()).error || err; } catch (_) {}
        const c = ensureChat(runtime.state); if (c) c.speakLoadingId = null;
        runtime.render();
        toast(`Couldn't read that aloud: ${err}`);
        return;
      }
      blob = await res.blob();
    } catch (e) {
      const c = ensureChat(runtime.state); if (c) c.speakLoadingId = null;
      runtime.render();
      toast(`Couldn't read that aloud: ${String(e && e.message || e)}`);
      return;
    }
    // User may have hit stop (or started another) while we were synthesizing.
    const cur = ensureChat(runtime.state);
    if (!cur || cur.speakLoadingId !== id) return;
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    _speakAudio = audio;
    _speakUrl = url;
    audio.onended = () => {
      _cleanupSpeakUrl();
      const c = ensureChat(runtime.state);
      if (c && c.speakingId === id) c.speakingId = null;
      runtime.render();
    };
    audio.onerror = () => {
      _cleanupSpeakUrl();
      const c = ensureChat(runtime.state);
      if (c) { c.speakingId = null; c.speakLoadingId = null; }
      runtime.render();
    };
    cur.speakLoadingId = null;
    cur.speakingId = id;
    runtime.render();
    try { await audio.play(); } catch (_) {}
  },

  // Message toolbar: stop in-progress playback OR cancel a pending synth.
  stopSpeak: () => {
    _stopSpeakAudio();
    const chat = ensureChat(runtime.state);
    if (chat) { chat.speakingId = null; chat.speakLoadingId = null; }
    runtime.render();
  },

  // Message toolbar: branch a NEW session off the transcript up through this
  // message. The client already rendered these bubbles, so it slices its own
  // `chat.thread` rather than trusting the server to re-fetch/re-slice history
  // (see backend's /api/session/branch docstring — same reasoning). Stash the
  // echoed-back prefix in localStorage BEFORE switching sessions so
  // selectSession's rehydrate step (above) picks it up as part of the same
  // open, whether this is the initial jump or a later reopen.
  branchFromMessage: async (msgId) => {
    const state = runtime.state;
    if (!state || !msgId) return;
    const chat = ensureChat(state);
    const sourceId = chat.activeId;
    const prefixSlice = sliceBranchPrefix(chat.thread, msgId);
    if (!prefixSlice) { toast(`Couldn't find that message`); return; }
    if (!sourceId) { toast(`Couldn't branch: no active session`); return; }
    let body = {};
    try {
      const res = await fetch('/api/session/branch', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_session_id: sourceId, prefix: prefixSlice }),
      });
      try { body = await res.json(); } catch (_) { body = {}; }
      if (!res.ok) { toast(`Couldn't branch: ${body.error || res.status}`); return; }
    } catch (e) {
      toast(`Couldn't branch: ${String(e && e.message || e)}`);
      return;
    }
    const { session_id, prefix } = body;
    if (!session_id) { toast(`Couldn't branch: no session returned`); return; }
    try { await refreshSidebarUsage(state); } catch (_) { /* sidebar refresh is best-effort */ }
    try { localStorage.setItem(branchPrefixKey(session_id), JSON.stringify(prefix || prefixSlice)); } catch (_) {}
    await actions.selectSession(session_id);
  },

  // Message toolbar: open the inline editor for the still-buffered optimistic
  // bubble (msgTools' canEdit only shows the button while pendingSend.messageId
  // matches — this re-checks server-side-of-the-click in case the 700ms window
  // lapsed between render and click). Actual DOM swap happens through state:
  // chatMsg (surfaces.js) renders a textarea + Save/Cancel bar when
  // chat.editingId === m.id, since render() rebuilds root.innerHTML wholesale
  // on every action dispatch (direct DOM surgery here would be wiped the
  // instant this handler returns).
  editMessage: (msgId) => {
    const state = runtime.state;
    if (!state || !msgId) return;
    const chat = ensureChat(state);
    if (!chat.pendingSend || chat.pendingSend.messageId !== msgId) return;
    chat.editingId = msgId;
    state.editDraft = chat.pendingSend.text;
    runtime.render();
  },

  // Save & Send: commit the textarea's value into the still-buffered message
  // and flush immediately — Frank made his final call, no reason to wait out
  // the rest of the 700ms window.
  saveEdit: (msgId) => {
    const state = runtime.state;
    if (!state || !msgId) return;
    const chat = ensureChat(state);
    chat.editingId = null;
    if (!chat.pendingSend || chat.pendingSend.messageId !== msgId) {
      // The buffer already flushed (timer won the race) — too late to edit.
      toast(`Too late to edit — __AGENT_NAME__ already started`);
      state.editDraft = null;
      runtime.render();
      return;
    }
    const text = state.editDraft != null ? state.editDraft : chat.pendingSend.text;
    // Empty-text guard: if Frank cleared the textarea, treat Save & Send as
    // "drop the buffered send" — better UX than posting an empty message and
    // safer than fireSend, which no longer has its own empty guard on this path.
    if (!text.trim() && !(chat.pendingSend.attachSnap && chat.pendingSend.attachSnap.length)) {
      clearTimeout(chat.pendingSend.timerId);
      chat.pendingSend = null;
      const idx = (chat.thread || []).findIndex((m) => m.id === msgId);
      if (idx >= 0) chat.thread.splice(idx, 1);
      state.editDraft = null;
      runtime.render();
      return;
    }
    chat.pendingSend.text = text;
    const msg = (chat.thread || []).find((m) => m.id === msgId);
    if (msg) msg.text = text;
    state.editDraft = null;
    // The buffered send's OWN session, not chat.activeId: Save & Send can fire
    // after the user switched threads mid-edit, and flushPending's view gate
    // is keyed off the sid it's handed — passing the viewed thread's id here
    // would make a same-session-looking flush that is actually cross-session,
    // skipping the gate and streaming the reply into the wrong thread.
    flushPending(chat.pendingSend.sessionId);
  },

  // Cancel: close the inline editor, keep the original buffered text/deadline
  // untouched (it still fires on its own timer, or on the next explicit flush).
  cancelEdit: (msgId) => {
    const state = runtime.state;
    if (!state) return;
    const chat = ensureChat(state);
    if (chat.editingId === msgId) chat.editingId = null;
    state.editDraft = null;
    runtime.render();
  },

  // Message toolbar: open/close the per-message download flyout (MD vs PDF).
  toggleMsgMenu: (id) => {
    const state = runtime.state;
    if (!state || !id) return;
    const chat = ensureChat(state);
    chat.msgMenuOpen = chat.msgMenuOpen === id ? null : id;
    chat.rowMenuOpen = null;
    state.chatMenuOpen = false;
    runtime.render();
  },

  // Message toolbar: download one message's text as a .md file (client-side).
  downloadMessage: (id) => {
    const state = runtime.state;
    if (!state || !id) return;
    const chat = ensureChat(state);
    chat.msgMenuOpen = null;
    const msg = (chat.thread || []).find((m) => m.id === id);
    if (!msg || !msg.text) { runtime.render(); return; }
    const who = msg.role === 'user' ? 'you' : 'gary';
    const slug = (msg.text.split('\n')[0] || 'message').slice(0, 40).replace(/[^\w.-]+/g, '_');
    try {
      const blob = new Blob([msg.text], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${who}-${slug}.md`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 1000);
    } catch (_) {}
    runtime.render();
  },

  // Message toolbar: download one message as a styled PDF. Reuses the same
  // server render path as the whole-chat export, with a one-message thread.
  downloadMessagePDF: async (id) => {
    const state = runtime.state;
    if (!state || !id) return;
    const chat = ensureChat(state);
    chat.msgMenuOpen = null;
    const msg = (chat.thread || []).find((m) => m.id === id);
    if (!msg || !msg.text) { runtime.render(); return; }
    const who = msg.role === 'user' ? 'you' : 'gary';
    const slug = (msg.text.split('\n')[0] || 'message').slice(0, 40).replace(/[^\w.-]+/g, '_');
    const safe = `${who}-${slug}` || 'message';
    const title = chat.title || 'Message';
    let dateStr = '';
    try { dateStr = new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch (_) {}
    const html = buildTranscriptHtml(title, [msg], { dateStr });
    const download = (blob, name) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 1000);
    };
    runtime.render();
    // Preferred: server renders a real PDF → one-click file download.
    try {
      const res = await fetch(`${location.origin}/api/export/pdf`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ html, filename: `${safe}.pdf` }),
      });
      if (res.ok) {
        const blob = await res.blob();
        if (blob && blob.size) { download(blob, `${safe}.pdf`); return; }
      }
    } catch (_) { /* fall through to print/html fallbacks */ }
    // Fallback 1: browser print dialog via sandboxed hidden iframe.
    try {
      const frame = document.createElement('iframe');
      frame.setAttribute('aria-hidden', 'true');
      frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
      document.body.appendChild(frame);
      const doc = frame.contentWindow.document;
      doc.open(); doc.write(html); doc.close();
      const go = () => {
        try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch (_) {}
        setTimeout(() => { try { frame.remove(); } catch (_) {} }, 60000);
      };
      if (frame.contentWindow.document.readyState === 'complete') setTimeout(go, 250);
      else frame.addEventListener('load', () => setTimeout(go, 250), { once: true });
    } catch (_) {
      try { download(new Blob([html], { type: 'text/html' }), `${safe}.html`); } catch (_) {}
    }
  },

  // Swallow clicks on menu chrome so they neither select the row nor close the menu.
  noop: () => {},
};
