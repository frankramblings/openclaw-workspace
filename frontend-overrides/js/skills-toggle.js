/* OpenClaw Workspace — skill enable/disable toggles (overlay add-on).
 *
 * skills.js renders the panel read-only and is NOT overridden (large, changes
 * upstream). This module decorates each rendered .skill-card with a toggle
 * switch wired to the backend's POST /api/skills/<name>/enabled (gateway
 * skills.update). Enabled-state comes from /api/skills' `enabled` field.
 * Self-contained like cron.js; loaded via a <script> the sync injects.
 */
(function () {
  'use strict';
  const API = window.location.origin;
  let _enabledByName = null;
  let _retrying = false;
  let _lastRetry = 0;

  async function loadStates() {
    try {
      const res = await fetch(`${API}/api/skills`);
      const data = await res.json();
      _enabledByName = {};
      (data.skills || []).forEach((s) => {
        _enabledByName[s.name] = s.enabled !== false;
      });
    } catch (_) { _enabledByName = null; }
  }

  function decorate() {
    if (!_enabledByName) {
      // First load failed (e.g. gateway cold-booting) — retry when skill
      // cards appear, at most once per 30s (a tight loop here would hammer
      // a workspace that's itself restarting).
      const now = Date.now();
      if (!_retrying && now - _lastRetry > 30000 && document.querySelector('.skill-card')) {
        _retrying = true;
        _lastRetry = now;
        loadStates().then(() => { _retrying = false; decorate(); });
      }
      return;
    }
    document.querySelectorAll('.skill-card').forEach((card) => {
      if (card.querySelector('.skill-enable-toggle')) return;
      const name = card.dataset.skillName;
      if (!name || !(name in _enabledByName)) return;
      const right = card.querySelector('.skill-card-right');
      if (!right) return;
      const on = _enabledByName[name];
      const btn = document.createElement('button');
      btn.className = 'skill-enable-toggle' + (on ? ' on' : '');
      btn.title = on ? 'Skill enabled — click to disable'
                     : 'Skill disabled — click to enable';
      btn.setAttribute('role', 'switch');
      btn.setAttribute('aria-checked', String(on));
      btn.innerHTML = '<span></span>';
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();   // don't expand/collapse the card
        toggle(name, btn);
      });
      right.prepend(btn);
    });
  }

  async function toggle(name, btn) {
    const next = !btn.classList.contains('on');
    btn.classList.toggle('on', next);  // optimistic
    btn.setAttribute('aria-checked', String(next));
    try {
      const res = await fetch(`${API}/api/skills/${encodeURIComponent(name)}/enabled`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
      _enabledByName[name] = next;
      btn.title = next ? 'Skill enabled — click to disable'
                       : 'Skill disabled — click to enable';
    } catch (e) {
      btn.classList.toggle('on', !next);  // revert
      btn.setAttribute('aria-checked', String(!next));
      btn.title = `Toggle failed: ${(e && e.message) || e}`;
    }
  }

  async function init() {
    await loadStates();
    decorate();
    // Observe the skills panel's static container (renderSkillsList only
    // swaps its children); fall back to body if the SPA layout changes.
    const root = document.getElementById('skills-list') || document.body;
    new MutationObserver(() => decorate())
      .observe(root, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }
})();
