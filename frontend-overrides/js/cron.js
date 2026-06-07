/* OpenClaw Workspace — Cron tab (overlay add-on).
 *
 * The Gary SPA has no scheduled-jobs view, so this self-contained module
 * adds one without editing the synced index.html: on load it injects a rail
 * button (#rail-cron) and a themed modal, then renders the gateway's cron jobs
 * from the backend /api/cron adapter. Loaded via a <script> the sync injects.
 *
 * Self-contained on purpose (builds its own DOM, uses the SPA's theme vars) so
 * it survives Gary updates as long as #icon-rail exists.
 */
(function () {
  'use strict';
  const API = window.location.origin;
  const $ = (sel, root) => (root || document).querySelector(sel);

  // --- clock icon for the rail button (matches the 16px stroke icons) -------
  const ICON =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';

  function fmtTime(ms) {
    if (!ms) return '';
    try {
      const d = new Date(ms);
      const today = new Date();
      const sameDay = d.toDateString() === today.toDateString();
      return sameDay
        ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (_) { return ''; }
  }
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let _modal = null;
  let _loading = false;

  function buildModal() {
    if (_modal) return _modal;
    const overlay = document.createElement('div');
    overlay.id = 'cron-modal';
    overlay.className = 'cron-modal-overlay';
    overlay.style.display = 'none';
    overlay.innerHTML =
      '<div class="cron-modal-card" role="dialog" aria-label="Scheduled jobs">' +
      '  <div class="cron-modal-head">' +
      '    <span class="cron-modal-title">Scheduled jobs</span>' +
      '    <span class="cron-modal-count" id="cron-count"></span>' +
      '    <button class="cron-modal-close" id="cron-close" title="Close">&#x2715;</button>' +
      '  </div>' +
      '  <div class="cron-modal-body" id="cron-body"></div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    $('#cron-close', overlay).addEventListener('click', close);
    _modal = overlay;
    return overlay;
  }

  function open() {
    buildModal().style.display = 'flex';
    document.addEventListener('keydown', onEsc);
    load();
  }
  function close() {
    if (_modal) _modal.style.display = 'none';
    document.removeEventListener('keydown', onEsc);
  }
  function onEsc(e) { if (e.key === 'Escape') close(); }

  function render(jobs) {
    const body = $('#cron-body');
    const count = $('#cron-count');
    if (count) count.textContent = jobs.length ? `${jobs.length} job${jobs.length === 1 ? '' : 's'}` : '';
    if (!body) return;
    if (!jobs.length) { body.innerHTML = '<div class="cron-empty">No scheduled jobs.</div>'; return; }
    body.innerHTML = jobs.map((j) => {
      const next = fmtTime(j.nextWakeAtMs);
      const last = fmtTime(j.lastRunAtMs);
      const meta = [
        next ? `next ${esc(next)}` : '',
        last ? `last ${esc(last)}${j.lastStatus ? ' · ' + esc(j.lastStatus) : ''}` : '',
        j.agentId ? esc(j.agentId) : '',
      ].filter(Boolean).join('  ·  ');
      return (
        `<div class="cron-job${j.enabled ? '' : ' cron-job-off'}" data-id="${esc(j.id)}">` +
        `  <div class="cron-job-main">` +
        `    <div class="cron-job-top">` +
        `      <span class="cron-job-name">${esc(j.name)}</span>` +
        `      <code class="cron-job-sched">${esc(j.schedule)}</code>` +
        `    </div>` +
        (j.message ? `    <div class="cron-job-msg">${esc(j.message)}</div>` : '') +
        (meta ? `    <div class="cron-job-meta">${meta}</div>` : '') +
        `    <div class="cron-job-runs" hidden></div>` +
        `  </div>` +
        `  <div class="cron-job-actions">` +
        `    <button class="cron-btn cron-history" title="Recent runs">⟲</button>` +
        `    <button class="cron-btn cron-run" title="Run now">Run</button>` +
        `    <button class="cron-toggle${j.enabled ? ' on' : ''}" title="${j.enabled ? 'Disable' : 'Enable'}" role="switch" aria-checked="${j.enabled}"><span></span></button>` +
        `  </div>` +
        `</div>`
      );
    }).join('');
    body.querySelectorAll('.cron-job').forEach((row) => {
      const id = row.dataset.id;
      row.querySelector('.cron-history').addEventListener('click', () => toggleRuns(id, row));
      row.querySelector('.cron-run').addEventListener('click', () => runJob(id, row));
      row.querySelector('.cron-toggle').addEventListener('click', () => toggleJob(id, row));
    });
  }

  async function load() {
    if (_loading) return;
    _loading = true;
    const body = $('#cron-body');
    if (body) body.innerHTML = '<div class="cron-empty">Loading…</div>';
    try {
      const res = await fetch(`${API}/api/cron`);
      const data = await res.json();
      render(data.jobs || []);
    } catch (e) {
      if (body) body.innerHTML = `<div class="cron-empty">Failed to load: ${esc(e && e.message)}</div>`;
    } finally { _loading = false; }
  }

  async function runJob(id, row) {
    const btn = row.querySelector('.cron-run');
    const prev = btn.textContent; btn.textContent = '…'; btn.disabled = true;
    try {
      const res = await fetch(`${API}/api/cron/${encodeURIComponent(id)}/run`, { method: 'POST' });
      btn.textContent = res.ok ? '✓' : 'err';
    } catch (_) { btn.textContent = 'err'; }
    setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 1400);
  }

  async function toggleJob(id, row) {
    const tog = row.querySelector('.cron-toggle');
    const turningOn = !tog.classList.contains('on');
    try {
      const res = await fetch(`${API}/api/cron/${encodeURIComponent(id)}/${turningOn ? 'enable' : 'disable'}`, { method: 'POST' });
      if (res.ok) {
        tog.classList.toggle('on', turningOn);
        tog.setAttribute('aria-checked', String(turningOn));
        row.classList.toggle('cron-job-off', !turningOn);
      }
    } catch (_) {}
  }

  function fmtDur(ms) {
    if (ms == null) return '';
    const s = ms / 1000;
    return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  }

  async function toggleRuns(id, row) {
    const panel = row.querySelector('.cron-job-runs');
    if (!panel) return;
    if (!panel.hidden) { panel.hidden = true; return; }
    panel.hidden = false;
    panel.innerHTML = '<div class="cron-empty">Loading…</div>';
    try {
      const res = await fetch(`${API}/api/cron/${encodeURIComponent(id)}/runs?limit=20`);
      const data = await res.json();
      const runs = data.runs || [];
      if (!runs.length) {
        panel.innerHTML = '<div class="cron-empty">No recorded runs.</div>';
        return;
      }
      panel.innerHTML = runs.map((r) => {
        const ok = r.status === 'ok';
        const skip = r.status === 'skipped';
        const icon = ok ? '✓' : (skip ? '–' : '✗');
        const cls = ok ? 'ok' : (skip ? 'skip' : 'err');
        const line = r.error || r.summary || '';
        return (
          `<div class="cron-run-row cron-run-${cls}">` +
          `<span class="cron-run-icon">${icon}</span>` +
          `<span class="cron-run-time">${esc(fmtTime(r.ts))}</span>` +
          `<span class="cron-run-dur">${esc(fmtDur(r.durationMs))}</span>` +
          (line ? `<span class="cron-run-line" title="${esc(line)}">${esc(line)}</span>` : '') +
          `</div>`
        );
      }).join('');
    } catch (e) {
      panel.innerHTML = `<div class="cron-empty">Failed: ${esc(e && e.message)}</div>`;
    }
  }

  function injectRailButton() {
    const rail = $('#icon-rail');
    if (!rail || $('#rail-cron')) return;
    const btn = document.createElement('button');
    btn.className = 'icon-rail-btn';
    btn.id = 'rail-cron';
    btn.title = 'Scheduled jobs';
    btn.innerHTML = ICON;
    btn.addEventListener('click', open);
    // Place among the tool launchers, just before Theme (end of the group).
    const theme = $('#rail-theme', rail);
    if (theme) rail.insertBefore(btn, theme); else rail.appendChild(btn);
  }

  function init() {
    injectRailButton();
    // The rail can be re-rendered by the SPA; re-inject if our button vanishes.
    const rail = document.getElementById('icon-rail');
    if (rail && window.MutationObserver) {
      new MutationObserver(() => { if (!document.getElementById('rail-cron')) injectRailButton(); })
        .observe(rail, { childList: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }
})();
