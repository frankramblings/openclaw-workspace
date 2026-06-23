// Live wiring for the DEEP RESEARCH surface. Drives the past-runs list, the
// running-panel progress label, and the 'done' report summary from the real
// research backend, with mock fallback so the UI never breaks.
//
// Render seams (already in surfaces.js):
//   state.live.research.past    → [{ q, m, rid }]  (PAST RESEARCH rows)
//   state.live.research.summary → HTML/text string (the 'done' card summary)
//   state.researchProgress.label → running-panel title
//   state.research              → 'idle' | 'running' | 'done'
//
// Endpoints:
//   GET  /api/research/library?limit=20
//        → { research:[{id, query, status, started_at, duration, source_count, rounds}] }
//   POST /api/research/start {query, max_rounds}        → { session_id:rid }
//   GET  /api/research/stream/{rid}  (SSE via openSSE)
//        → events {status, phase, round, queries, total_sources, total_findings, title, final, error}
//   POST /api/research/result-peek/{rid}                → { result:markdown, sources:[...] }
//   POST /api/research/cancel/{rid}
//
// Fail soft: every backend call is wrapped; on error we keep the mock and never
// throw out of an action.

import { runtime } from './runtime.js';
import { apiGet, apiJson, openSSE } from './api.js';

// ---- module-scoped run handle ---------------------------------------------
let activeRid = null;
let activeES = null;

function closeES() {
  if (activeES) {
    try { activeES.close(); } catch (_) {}
    activeES = null;
  }
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

export async function load(state) {
  try {
    const data = await apiGet('/api/research/library?limit=20');
    const research = Array.isArray(data?.research) ? data.research : [];
    const past = research.map((r) => ({
      q: r.query,
      m: `${fmtDur(r.duration)} · ${r.source_count || 0} sources`,
      rid: r.id,
    }));
    state.live = state.live || {};
    state.live.research = { ...(state.live.research || {}), past };
  } catch (_) {
    // Fail soft: keep whatever's there (mock or prior live data).
  }
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
      state.researchProgress = { label: 'Researching…' };
      runtime.render();

      closeES();
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
          // Surface the error label but stop spinning.
          closeES();
          state.research = 'done';
          state.researchProgress = null;
          runtime.render();
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
    activeRid = null;
    state.research = 'idle';
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
  if (activeRid === rid) activeRid = null;
  if (!state) return;
  state.research = 'done';
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
  try { await load(state); runtime.render(); } catch (_) {}
}
