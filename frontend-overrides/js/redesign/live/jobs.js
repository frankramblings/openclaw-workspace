// Live Jobs overlay — Layer 3 of the Live Jobs design.
// docs/superpowers/specs/2026-06-30-workspace-live-jobs-design.md
//
// A self-contained progress overlay: it injects its own CSS + container onto
// <body>, opens /api/jobs/stream (SSE), keeps a jobs map, and renders live
// progress bars imperatively. It is deliberately DECOUPLED from the SPA's
// render() cycle so a chat re-render can never destroy or duplicate it.
//
// UX:
//   * A stack of slim bars, bottom-right, above the composer. Visible only when
//     >=1 job exists; auto-collapses ~4s after the last job finishes.
//   * A header badge "N running" toggles the stack collapsed/expanded.
//   * Bars for the currently-open chat thread get an accent rail; jobs from
//     other threads are dimmed but still listed (so Frank always sees every
//     process, which was the whole point).
//   * done -> green check, failed -> red + error, stalled -> amber "no update".
//
// Fail-soft: SSE errors reconnect with backoff; a bad payload is ignored; if the
// endpoint is missing the overlay simply stays empty and invisible.

import { runtime } from './runtime.js';

const STREAM = '/api/jobs/stream';
const FALLBACK_POLL = '/api/jobs';
const FADE_AFTER_MS = 4000;      // collapse the panel this long after it empties

let els = null;                  // { root, badge, list }
let jobs = [];                   // latest record list from the stream
let es = null;
let backoff = 1000;
let emptySince = 0;
let pollTimer = null;

// ---- formatting -----------------------------------------------------------

function fmtBytes(n) {
  if (n == null) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

function fmtRate(bps) {
  if (!bps || bps <= 0) return '';
  return `${fmtBytes(bps)}/s`;
}

function fmtEta(s) {
  if (s == null || s < 0) return '';
  s = Math.round(s);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), ss = s % 60;
  if (m < 60) return `${m}m ${String(ss).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function kindIcon(kind) {
  switch (kind) {
    case 'download': return '⬇';
    case 'upload': return '⬆';
    case 'verify': return '✓';
    case 'render': return '🎬';
    case 'build': return '🔧';
    default: return '⏳';
  }
}

// ---- DOM setup ------------------------------------------------------------

const CSS = `
#live-jobs{position:fixed;right:16px;bottom:84px;z-index:6000;width:340px;max-width:calc(100vw - 32px);
  display:none;flex-direction:column;gap:6px;font:13px/1.35 var(--font,system-ui,sans-serif);pointer-events:none}
#live-jobs.show{display:flex}
#live-jobs .lj-badge{align-self:flex-end;pointer-events:auto;cursor:pointer;user-select:none;
  display:inline-flex;align-items:center;gap:7px;padding:5px 11px;border-radius:999px;
  background:var(--panel,rgba(30,30,34,.92));border:1px solid var(--border,rgba(127,127,127,.28));
  color:var(--text,#e8e8ea);box-shadow:0 4px 16px rgba(0,0,0,.28);backdrop-filter:blur(8px)}
#live-jobs .lj-badge .lj-dot{width:7px;height:7px;border-radius:50%;background:var(--accent,#5b9dff);
  box-shadow:0 0 0 0 var(--accent,#5b9dff);animation:lj-pulse 1.6s infinite}
#live-jobs .lj-badge.idle .lj-dot{background:var(--muted,#8a8a90);animation:none}
@keyframes lj-pulse{0%{box-shadow:0 0 0 0 rgba(91,157,255,.5)}70%{box-shadow:0 0 0 6px rgba(91,157,255,0)}100%{box-shadow:0 0 0 0 rgba(91,157,255,0)}}
#live-jobs .lj-list{pointer-events:auto;display:flex;flex-direction:column;gap:6px}
#live-jobs.collapsed .lj-list{display:none}
#live-jobs .lj-job{background:var(--panel,rgba(30,30,34,.94));border:1px solid var(--border,rgba(127,127,127,.24));
  border-left:2px solid var(--border,rgba(127,127,127,.24));border-radius:10px;padding:9px 11px;
  box-shadow:0 4px 16px rgba(0,0,0,.26);backdrop-filter:blur(8px);color:var(--text,#e8e8ea);
  transition:opacity .5s ease}
#live-jobs .lj-job.mine{border-left-color:var(--accent,#5b9dff)}
#live-jobs .lj-job.done{border-left-color:#3fbf6f}
#live-jobs .lj-job.failed{border-left-color:#e5534b}
#live-jobs .lj-job.stalled{border-left-color:#d8a24a}
#live-jobs .lj-job.fading{opacity:0}
#live-jobs .lj-top{display:flex;align-items:baseline;gap:6px;margin-bottom:5px}
#live-jobs .lj-icon{flex:none;opacity:.8}
#live-jobs .lj-label{flex:1;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#live-jobs .lj-pct{flex:none;font-variant-numeric:tabular-nums;color:var(--muted,#a2a2a8);font-size:12px}
#live-jobs .lj-track{height:5px;border-radius:3px;background:var(--border,rgba(127,127,127,.22));overflow:hidden}
#live-jobs .lj-fill{height:100%;width:0;border-radius:3px;background:var(--accent,#5b9dff);transition:width .4s ease}
#live-jobs .lj-job.done .lj-fill{background:#3fbf6f}
#live-jobs .lj-job.failed .lj-fill{background:#e5534b}
#live-jobs .lj-track.indet .lj-fill{width:35%;animation:lj-indet 1.3s ease-in-out infinite}
@keyframes lj-indet{0%{margin-left:-35%}100%{margin-left:100%}}
#live-jobs .lj-meta{display:flex;gap:8px;margin-top:5px;color:var(--muted,#9a9aa0);font-size:11.5px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#live-jobs .lj-meta .lj-detail{flex:1;overflow:hidden;text-overflow:ellipsis}
#live-jobs .lj-err{color:#e5847e;font-size:11.5px;margin-top:4px;white-space:normal}
@media (max-width:720px){#live-jobs{right:10px;left:10px;width:auto;bottom:96px}}
`;

function ensureDom() {
  if (els) return els;
  const style = document.createElement('style');
  style.id = 'live-jobs-css';
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'live-jobs';
  root.innerHTML = `<div class="lj-badge idle"><span class="lj-dot"></span><span class="lj-badge-text">Jobs</span></div><div class="lj-list"></div>`;
  document.body.appendChild(root);

  const badge = root.querySelector('.lj-badge');
  badge.addEventListener('click', () => {
    root.classList.toggle('collapsed');
  });

  els = { root, badge, list: root.querySelector('.lj-list') };
  return els;
}

// ---- render ---------------------------------------------------------------

function currentThread() {
  try { return runtime?.state?.live?.chat?.activeId || null; } catch (_) { return null; }
}

function jobHtml(j, mine) {
  const cls = ['lj-job'];
  if (j.status === 'done') cls.push('done');
  else if (j.status === 'failed') cls.push('failed');
  else if (j.stalled) cls.push('stalled');
  if (mine) cls.push('mine');

  const indet = j.status === 'running' && (j.pct == null);
  const pct = j.status === 'done' ? 100 : (j.pct != null ? j.pct : 0);
  const pctLabel = j.status === 'done' ? '✓'
    : j.status === 'failed' ? '✕'
    : (j.pct != null ? `${Math.round(j.pct)}%` : '');

  const bytes = (j.bytesDone != null && j.bytesTotal)
    ? `${fmtBytes(j.bytesDone)} / ${fmtBytes(j.bytesTotal)}`
    : (j.bytesDone != null ? fmtBytes(j.bytesDone) : '');
  const metaBits = [];
  if (j.status === 'running') {
    if (bytes) metaBits.push(bytes);
    const r = fmtRate(j.rate); if (r) metaBits.push(r);
    const e = fmtEta(j.eta); if (e) metaBits.push('ETA ' + e);
    if (j.stalled) metaBits.length = 0, metaBits.push(`no update in ${j.stalled}s`);
  }

  const meta = (metaBits.length || j.detail)
    ? `<div class="lj-meta">${metaBits.map(esc).join(' · ')}${
        j.detail ? `<span class="lj-detail" title="${esc(j.detail)}">${metaBits.length ? ' · ' : ''}${esc(j.detail)}</span>` : ''}</div>`
    : '';
  const err = j.status === 'failed' && j.error ? `<div class="lj-err">${esc(j.error)}</div>` : '';

  return `<div class="${cls.join(' ')}" data-id="${esc(j.id)}">
    <div class="lj-top">
      <span class="lj-icon">${kindIcon(j.kind)}</span>
      <span class="lj-label" title="${esc(j.label)}">${esc(j.label)}</span>
      <span class="lj-pct">${pctLabel}</span>
    </div>
    <div class="lj-track${indet ? ' indet' : ''}"><div class="lj-fill" style="width:${pct}%"></div></div>
    ${meta}${err}
  </div>`;
}

function render() {
  const { root, badge, list } = ensureDom();
  const running = jobs.filter((j) => j.status === 'running');
  const has = jobs.length > 0;

  if (has) {
    emptySince = 0;
    root.classList.add('show');
    root.classList.remove('fade-hide');
  } else if (root.classList.contains('show')) {
    // schedule a hide once truly empty for a moment
    if (!emptySince) emptySince = Date.now();
    if (Date.now() - emptySince >= FADE_AFTER_MS) root.classList.remove('show');
  }

  const n = running.length;
  badge.classList.toggle('idle', n === 0);
  const txt = badge.querySelector('.lj-badge-text');
  txt.textContent = n > 0 ? `${n} running` : (has ? 'Jobs done' : 'Jobs');

  const cur = currentThread();
  list.innerHTML = jobs.map((j) => jobHtml(j, j.thread && cur && j.thread === cur)).join('');
}

// ---- stream ---------------------------------------------------------------

function apply(payload) {
  if (!payload || !Array.isArray(payload.jobs)) return;
  jobs = payload.jobs;
  render();
}

function connect() {
  try {
    es = new EventSource(STREAM, { withCredentials: true });
  } catch (_) { scheduleReconnect(); return; }

  es.onmessage = (e) => {
    backoff = 1000;
    try { apply(JSON.parse(e.data)); } catch (_) { /* keepalive or garbage */ }
  };
  es.onerror = () => {
    try { es.close(); } catch (_) {}
    es = null;
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  // Fallback: one plain GET so a broken SSE still shows current state.
  fetch(FALLBACK_POLL, { credentials: 'same-origin' })
    .then((r) => r.ok ? r.json() : null).then((d) => d && apply(d)).catch(() => {});
  const wait = Math.min(backoff, 15000);
  backoff = Math.min(backoff * 2, 15000);
  setTimeout(connect, wait);
}

// Re-render on SPA navigation so "mine" highlighting tracks the open thread.
function watchThread() {
  let last = currentThread();
  pollTimer = setInterval(() => {
    const c = currentThread();
    if (c !== last) { last = c; if (jobs.length) render(); }
  }, 800);
}

export function initJobs() {
  if (els) return;                 // idempotent
  ensureDom();
  connect();
  watchThread();
}

// Self-boot on import (app.js just needs to import this module once).
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initJobs, { once: true });
  } else {
    initJobs();
  }
}
