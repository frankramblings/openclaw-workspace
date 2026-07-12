// Live wiring for the DEEP RESEARCH surface. Drives the past-runs list, the
// running-panel progress label, and the 'done' report summary from the real
// research backend, with mock fallback so the UI never breaks.
//
// Render seams (already in surfaces.js):
//   state.live.research.past    → [{ q, m, rid }]  (PAST RESEARCH rows)
//   state.live.research.summary → HTML/text string (the 'done' card summary)
//   state.live.research.lastRid → set the instant /start returns, so the
//                                  done/error card's Report/Discuss buttons
//                                  always have a working rid — even if the run
//                                  finishes via the SSE 'error' path or the
//                                  poll fallback below, not just the normal
//                                  SSE-done path.
//   state.researchProgress.label → running-panel title
//   state.research               → 'idle' | 'running' | 'done' | 'error'
//   state.researchError          → error-card message (set whenever
//                                   research === 'error')
//
// Endpoints:
//   GET  /api/research/library?limit=20
//        → { research:[{id, query, status, started_at, duration, source_count, rounds}] }
//   POST /api/research/start {query, max_rounds}        → { session_id:rid }
//   GET  /api/research/stream/{rid}  (SSE via openSSE)
//        → events {status, phase, round, queries, total_sources, total_findings, title, final, error}
//   GET  /api/research/status/{rid}                     → { status, progress }
//   POST /api/research/result-peek/{rid}                → { result:markdown, sources:[...] }
//   POST /api/research/cancel/{rid}
//
// Fail soft: every action below is wrapped; on error we keep the mock and
// never throw out of an action. The one exception is load() (the past-runs
// list loader) — it deliberately DOES throw on failure so live/index.js's
// loadSurface() can record/surface it (see the load() banner below).

import { runtime } from './runtime.js';
import { apiGet, apiJson, openSSE } from './api.js';

// ---- module-scoped run handle ---------------------------------------------
let activeRid = null;
let activeES = null;
let pollTimer = null;
let pollStartedAt = 0;

function closeES() {
  if (activeES) {
    try { activeES.close(); } catch (_) {}
    activeES = null;
  }
}

// ---- poll-decision helper (pure, testable) ---------------------------------
// The SSE stream can die mid-run without any client-visible signal (browsers
// silently retry; openSSE's onerror is a no-op — see api.js) while the
// backend job keeps going, e.g. across a service restart. Rather than try to
// detect "the stream died", we run a redundant poll of
// GET /api/research/status/{rid} every POLL_INTERVAL_MS for the whole
// 'running' duration and let it independently notice a finished/failed job.
// pollDecision is the pure part — given how long we've been waiting and the
// freshest known status, decide what the poll loop should do next — so the
// give-up/keep-going logic is unit-testable without fake timers.
export const POLL_INTERVAL_MS = 20000;        // fallback poll cadence
export const POLL_TIMEOUT_MS = 20 * 60 * 1000; // give up honestly after ~20 min

/**
 * @param {{elapsedMs:number, status?:string, timeoutMs?:number}} args
 * @returns {'continue'|'done'|'error'|'timeout'}
 */
export function pollDecision({ elapsedMs, status, timeoutMs = POLL_TIMEOUT_MS }) {
  if (status === 'done') return 'done';
  if (status === 'error' || status === 'cancelled') return 'error';
  if (elapsedMs >= timeoutMs) return 'timeout';
  return 'continue';
}

function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function startPoll(rid) {
  stopPoll();
  pollStartedAt = Date.now();
  pollTimer = setInterval(() => { pollTick(rid).catch(() => {}); }, POLL_INTERVAL_MS);
  if (pollTimer && typeof pollTimer.unref === 'function') pollTimer.unref(); // node tests
}

async function pollTick(rid) {
  if (activeRid !== rid) { stopPoll(); return; }
  const state = runtime.state;
  if (!state || state.research !== 'running') { stopPoll(); return; }

  let status;
  try {
    const res = await apiGet(`/api/research/status/${rid}`);
    status = res?.status;
  } catch (_) {
    // Transient fetch failure — keep polling; POLL_TIMEOUT_MS still bounds
    // the wait even if every poll fails.
  }

  // Re-check after the await: a concurrent SSE event or a reset may have
  // already resolved this run.
  if (activeRid !== rid || !runtime.state || runtime.state.research !== 'running') {
    stopPoll();
    return;
  }

  const decision = pollDecision({ elapsedMs: Date.now() - pollStartedAt, status });
  if (decision === 'continue') return;

  stopPoll();
  if (decision === 'done') {
    finish(rid).catch(() => {});
  } else if (decision === 'error') {
    failResearch(rid, 'The research run failed.');
  } else if (decision === 'timeout') {
    failResearch(rid, "This is taking longer than expected and we've lost track of the run. Try again.");
  }
}

/** Terminal failure path shared by the SSE 'error' event and the poll fallback. */
function failResearch(rid, message) {
  const state = runtime.state;
  closeES();
  stopPoll();
  if (activeRid === rid) activeRid = null;
  if (!state) return;
  state.research = 'error';
  state.researchError = message || 'The research run failed.';
  state.researchProgress = null;
  runtime.render();
}

// ---- formatting helpers ----------------------------------------------------

/**
 * Render a duration as mm:ss. Accepts a number of seconds, or a string such as
 * "283s" / "283" / "2:14". Returns '0:00' for unparseable input.
 */
function fmtDur(d) {
  if (d == null) return '0:00';
  if (typeof d === 'string' && d.includes(':')) return d; // already mm:ss
  const secs = Math.max(0, Math.round(parseFloat(String(d)) || 0));
  const mm = Math.floor(secs / 60);
  const ss = secs % 60;
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

/** Capitalize the first letter of a phase label. */
function cap(s) {
  const str = String(s || '');
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
}

/** 'Auto' → 2; otherwise clamp parseInt to 1..3. */
function roundsOf(v) {
  if (v == null || v === 'Auto') return 2;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return 2;
  return Math.min(3, Math.max(1, n));
}

/** Minimal HTML escape for text injected into the summary. */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Take the first non-empty paragraph of a markdown report, strip the most
 * common inline markdown, escape it, and cap the length so the 'done' card
 * stays compact.
 */
function firstParagraphHtml(md) {
  const text = String(md || '').trim();
  if (!text) return '';
  // First block separated by a blank line; skip leading headings/blank lines.
  const blocks = text.split(/\n\s*\n/);
  let para = '';
  for (const b of blocks) {
    const cleaned = b.replace(/^#{1,6}\s*/gm, '').trim();
    if (cleaned) { para = cleaned; break; }
  }
  if (!para) para = text;
  // Collapse newlines, strip simple markdown link syntax + emphasis markers.
  para = para
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [text](url) → text
    .replace(/[*_`]/g, '')
    .trim();
  if (para.length > 320) para = para.slice(0, 317).replace(/\s+\S*$/, '') + '…';
  return esc(para);
}

// ---- load (past runs) ------------------------------------------------------
// Fix round 1, finding 1 (task-w2a-report.md): this used to swallow every
// fetch failure ("fail soft: keep whatever's there"), which meant
// state.loadError.research was unreachable in production — live/index.js's
// loadSurface() only ever sets it from a load() that actually throws, so the
// desktop/mobile error-partial branches for research were dead code. load()
// now lets a genuine fetch failure propagate; live/index.js's catch takes it
// from there (loadError, or — per the populated-surface policy — a toast
// that keeps the existing past-runs list up). This does NOT change the
// fail-soft contract of the rest of the module (actions.*, the poll
// machinery below) — those still swallow internally by design, since a
// failed action shouldn't abort a running research job.
// Fetch cap — exported so surfaces.js can render an honest "showing first N
// — refine to see more" footer when the list comes back exactly at the cap
// (task 6.2 — disclosure only, no pagination).
export const CAP = 20;

export async function load(state) {
  const data = await apiGet(`/api/research/library?limit=${CAP}`);
  const research = Array.isArray(data?.research) ? data.research : [];
  const past = research.map((r) => ({
    q: r.query,
    m: `${fmtDur(r.duration)} · ${r.source_count || 0} sources`,
    rid: r.id,
  }));
  state.live = state.live || {};
  state.live.research = { ...(state.live.research || {}), past };
}

// ---- actions ---------------------------------------------------------------

export const actions = {
  startResearch: async () => {
    const state = runtime.state;
    if (!state) return;
    const q = (state.researchQuery || '').trim();
    if (!q) return;
    try {
      const res = await apiJson('/api/research/start', {
        query: q,
        max_rounds: roundsOf(state.resCfg?.rounds),
      });
      const rid = res?.session_id;
      if (!rid) return; // soft-fail: leave UI as-is

      activeRid = rid;
      state.research = 'running';
      state.researchError = null;
      state.researchProgress = { label: 'Researching…' };
      // Set the instant we have a rid — not just on the normal SSE-done path —
      // so the done/error card's Report/Discuss buttons work no matter which
      // path (SSE done, SSE error, poll fallback, poll timeout) ends the run.
      state.live = state.live || {};
      state.live.research = { ...(state.live.research || {}), lastRid: rid };
      runtime.render();

      closeES();
      startPoll(rid);
      activeES = openSSE(`/api/research/stream/${rid}`, (ev) => {
        if (!ev) return;
        // Ignore stray events from a stale stream.
        if (activeRid !== rid) return;

        const phase = ev.phase;
        if (phase === 'done' || ev.final || ev.status === 'done') {
          finish(rid).catch(() => {});
          return;
        }
        if (ev.error) {
          failResearch(rid, typeof ev.error === 'string' && ev.error ? ev.error : 'The research run failed.');
          return;
        }
        state.researchProgress = {
          label: `${cap(phase)}… round ${ev.round || 1} · ${ev.total_sources || 0} sources`,
        };
        runtime.render();
      });
    } catch (_) {
      // Soft-fail: revert to idle if we never got rolling.
      if (state.research === 'running' && !activeES) {
        state.research = 'idle';
        state.researchProgress = null;
        runtime.render();
      }
    }
  },

  resetResearch: async () => {
    const state = runtime.state;
    if (!state) return;
    const wasRunning = state.research === 'running';
    const rid = activeRid;
    closeES();
    stopPoll();
    activeRid = null;
    state.research = 'idle';
    state.researchError = null;
    state.researchProgress = null;
    runtime.render();
    if (wasRunning && rid) {
      try { await apiJson(`/api/research/cancel/${rid}`, {}); } catch (_) {}
    }
  },

  // Past-run chip: spin a research run off into a chat session and open it.
  resDiscuss: async (rid) => {
    const state = runtime.state;
    if (!state || !rid) return;
    try {
      const res = await apiJson(`/api/research/spinoff/${rid}`, {});
      const sid = res?.session_id || res?.id || res?.session;
      state.surface = 'chat';
      state.resOpenCtl = null;
      runtime.render();
      // selectSession (live/chat.js) loads the new session's thread itself.
      if (sid && runtime.actions && typeof runtime.actions.selectSession === 'function') {
        await runtime.actions.selectSession(sid);
      } else if (runtime.actions && typeof runtime.actions.go === 'function') {
        runtime.actions.go('chat');
      }
    } catch (_) { /* soft-fail: stay put */ }
  },

  // Past-run chip: open the visual report for that run in a new tab.
  resReport: (rid) => {
    if (!rid) return;
    try { window.open(`/api/research/report/${rid}`, '_blank', 'noopener'); } catch (_) {}
  },
};

/** On stream completion: close ES, mark done, peek the result, reload library. */
async function finish(rid) {
  const state = runtime.state;
  closeES();
  stopPoll();
  if (activeRid === rid) activeRid = null;
  if (!state) return;
  state.research = 'done';
  state.researchError = null;
  runtime.render();

  try {
    const peek = await apiJson(`/api/research/result-peek/${rid}`, {});
    const summary = firstParagraphHtml(peek?.result);
    if (summary) {
      state.live = state.live || {};
      state.live.research = { ...(state.live.research || {}), summary };
      runtime.render();
    }
  } catch (_) { /* keep mock summary */ }

  // Refresh the past-runs list so the just-finished run appears.
  try { await load(state); } catch (_) {}
  // Remember the finished run id so the done-card actions (report/discuss) work.
  state.live = state.live || {};
  state.live.research = { ...(state.live.research || {}), lastRid: rid };
  runtime.render();
}
